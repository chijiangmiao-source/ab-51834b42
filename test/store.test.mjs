// test/store.test.mjs — 持久化、快照与输入校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, BadRequest } from '../server/store.js';

async function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-store-'));
  const file = path.join(dir, 's.json');
  const store = await new Store(file).init();
  return { store, dir };
}

test('新开采集：序号从 1 开始，通道累计初始为 0，持久化文件生成', async () => {
  const { store, dir } = await freshStore();
  try {
    const g = await store.startGeneration({ channels: ['A', 'B'] });
    assert.equal(g.generation.length > 0, true);
    assert.deepEqual(g.totals, { A: 0, B: 0 });
    assert.equal(g.nextSeq, 1);
    assert.ok(fs.existsSync(path.join(dir, 's.json')));
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8'));
    assert.equal(disk.nextSeq, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('新开一代即清空旧帧与旧 opId 台账', async () => {
  const { store, dir } = await freshStore();
  try {
    const g1 = (await store.startGeneration({ channels: ['A'] })).generation;
    await store.append({ generation: g1, opId: 'k', increments: { A: 1 } });
    const g2 = await store.startGeneration({ channels: ['A'] });
    assert.notEqual(g1, g2.generation);
    assert.equal(store.state.frames.length, 0);
    assert.deepEqual(store.state.ops, {});
    assert.equal(store.snapshot().nextSeq, 1);
    // 旧 opId 在新代可自由使用
    const r = await store.append({ generation: g2.generation, opId: 'k', increments: { A: 9 } });
    assert.equal(r.duplicate, false);
    assert.equal(r.seq, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化：重建 Store 后快照、累计与幂等台账保持', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-persist-'));
  const file = path.join(dir, 's.json');
  try {
    let s = await new Store(file).init();
    const gen = (await s.startGeneration({ channels: ['A', 'B'] })).generation;
    await s.append({ generation: gen, opId: 'a', increments: { A: 2, B: 3 } });
    await s.append({ generation: gen, opId: 'b', increments: { A: 5 } });

    const s2 = await new Store(file).init();
    assert.equal(s2.snapshot().generation, gen);
    assert.deepEqual(s2.snapshot().totals, { A: 7, B: 3 });
    assert.equal(s2.snapshot().nextSeq, 3);
    assert.equal(s2.snapshot().highWatermark, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('输入校验：空通道、重复通道、未知通道、非法增量均 400', async () => {
  const { store, dir } = await freshStore();
  try {
    await assert.rejects(() => store.startGeneration({ channels: [] }), BadRequest);
    await assert.rejects(() => store.startGeneration({ channels: ['A', 'A'] }), BadRequest);
    const gen = (await store.startGeneration({ channels: ['A'] })).generation;
    await assert.rejects(
      () => store.append({ generation: gen, opId: 'x', increments: { Z: 1 } }),
      BadRequest
    );
    await assert.rejects(
      () => store.append({ generation: gen, opId: 'x', increments: { A: NaN } }),
      BadRequest
    );
    await assert.rejects(
      () => store.append({ generation: gen, opId: 'x', increments: {} }),
      BadRequest
    );
    assert.equal(store.state.frames.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
