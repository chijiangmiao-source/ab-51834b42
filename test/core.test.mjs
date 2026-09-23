// test/core.test.mjs — 幂等与并发：同参重试返回原序号、异参复用稳定拒绝、并发只落一帧
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, IdempotencyReject, GenerationMismatch } from '../server/store.js';

async function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-core-'));
  const store = await new Store(path.join(dir, 's.json')).init();
  return { store, dir };
}

test('严格递增序号与多通道增量累计', async () => {
  const { store, dir } = await freshStore();
  try {
    const g = await store.startGeneration({ channels: ['A', 'B', 'C'] });
    const gen = g.generation;
    const r1 = await store.append({ generation: gen, opId: 'o1', increments: { A: 1, B: 2 } });
    assert.equal(r1.seq, 1);
    assert.deepEqual(r1.totals, { A: 1, B: 2, C: 0 });
    const r2 = await store.append({ generation: gen, opId: 'o2', increments: { A: 5, C: 3 } });
    assert.equal(r2.seq, 2);
    assert.deepEqual(r2.totals, { A: 6, B: 2, C: 3 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同 opId 同参数重试：返回原序号，不产生新帧', async () => {
  const { store, dir } = await freshStore();
  try {
    const gen = (await store.startGeneration({ channels: ['A'] })).generation;
    const first = await store.append({ generation: gen, opId: 'dup', increments: { A: 3 } });
    const retry = await store.append({ generation: gen, opId: 'dup', increments: { A: 3 } });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.seq, 1);
    assert.equal(store.snapshot().nextSeq, 2);
    assert.equal(store.state.frames.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同 opId 异参数复用：稳定 409 拒绝，不分配序号、不产生帧', async () => {
  const { store, dir } = await freshStore();
  try {
    const gen = (await store.startGeneration({ channels: ['A', 'B'] })).generation;
    await store.append({ generation: gen, opId: 'x', increments: { A: 1 } });
    await assert.rejects(
      () => store.append({ generation: gen, opId: 'x', increments: { A: 2 } }),
      IdempotencyReject
    );
    await assert.rejects(
      () => store.append({ generation: gen, opId: 'x', increments: { B: 9 } }),
      IdempotencyReject
    );
    assert.equal(store.snapshot().nextSeq, 2);
    assert.equal(store.state.frames.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('并发重复追加同一 opId：只落一帧，其余全部返回同一序号', async () => {
  const { store, dir } = await freshStore();
  try {
    const gen = (await store.startGeneration({ channels: ['A'] })).generation;
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        store.append({ generation: gen, opId: 'race', increments: { A: 4 } })
      )
    );
    const winners = results.filter((r) => !r.duplicate);
    const dups = results.filter((r) => r.duplicate);
    assert.equal(winners.length, 1);
    assert.equal(dups.length, N - 1);
    assert.ok(results.every((r) => r.seq === 1));
    assert.equal(store.state.frames.length, 1);
    assert.deepEqual(store.snapshot().totals, { A: 4 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('并发不同 opId：序号严格递增无缺口，累计一致', async () => {
  const { store, dir } = await freshStore();
  try {
    const gen = (await store.startGeneration({ channels: ['A'] })).generation;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.append({ generation: gen, opId: `p${i}`, increments: { A: 1 } })
      )
    );
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(store.snapshot().totals.A, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('异代追加：稳定拒绝，旧连接重放不改写当前代', async () => {
  const { store, dir } = await freshStore();
  try {
    const g1 = (await store.startGeneration({ channels: ['A'] })).generation;
    const g2 = (await store.startGeneration({ channels: ['A'] })).generation;
    assert.notEqual(g1, g2);
    await assert.rejects(
      () => store.append({ generation: g1, opId: 'late', increments: { A: 1 } }),
      GenerationMismatch
    );
    assert.equal(store.snapshot().generation, g2);
    assert.equal(store.state.frames.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('服务只保留最近 32 帧；游标过旧 framesAfter 返回 null', async () => {
  const { store, dir } = await freshStore();
  try {
    const gen = (await store.startGeneration({ channels: ['A'] })).generation;
    for (let i = 1; i <= 40; i++) {
      await store.append({ generation: gen, opId: `f${i}`, increments: { A: 1 } });
    }
    assert.equal(store.state.frames.length, 32);
    assert.equal(store.state.frames[0].seq, 9);
    assert.equal(store.snapshot().totals.A, 40);
    assert.equal(store.framesAfter(5), null);
    const tail = store.framesAfter(35);
    assert.equal(tail.length, 5);
    assert.equal(tail[0].seq, 36);
    // 游标恰好等于最老帧前一帧：可补，不触发重置
    const fromOldest = store.framesAfter(8);
    assert.equal(fromOldest.length, 32);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
