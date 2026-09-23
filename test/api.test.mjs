// test/api.test.mjs — HTTP/SSE 端到端：
// 健康检查、幂等 HTTP 语义、事件流先快照后增量、重连续传、
// 游标过旧全量重置、旧代迟到事件隔离、压缩后续接累计一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer, post, openSSE, expectNoEvent, appendN } from './helpers.mjs';

test('GET /health 与静态页在就绪后可访问', async () => {
  const { base } = await spawnServer(test);
  const h = await fetch(`${base}/health`);
  assert.equal(h.status, 200);
  const body = await h.json();
  assert.equal(body.status, 'ok');

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match((await home.text()), /复核台/);

  const monitor = await fetch(`${base}/monitor.html`);
  assert.equal(monitor.status, 200);
  assert.match((await monitor.text()), /监看墙/);
});

test('开代 -> 追加：201/200，多通道累计正确', async () => {
  const { base } = await spawnServer(test);
  const g = await post(base, '/api/generations', { channels: ['A', 'B'] });
  assert.equal(g.status, 201);
  const gen = g.data.generation;

  const a1 = await post(base, '/api/appends', { generation: gen, opId: 'h1', increments: { A: 1, B: 2 } });
  assert.equal(a1.status, 200);
  assert.equal(a1.data.duplicate, false);
  assert.equal(a1.data.seq, 1);
  assert.deepEqual(a1.data.totals, { A: 1, B: 2 });
});

test('HTTP 幂等：同 opId 同参重试返回原序号；异参复用 409 且不产生事件', async () => {
  const { base } = await spawnServer(test);
  const gen = (await post(base, '/api/generations', { channels: ['A'] })).data.generation;

  const sse = await openSSE(base);
  assert.equal((await sse.nextEvent()).event, 'reset');

  const first = await post(base, '/api/appends', { generation: gen, opId: 'idem', increments: { A: 7 } });
  assert.equal(first.data.seq, 1);
  const liveFrame = await sse.nextEvent();
  assert.equal(liveFrame.event, 'frame');
  assert.equal(liveFrame.data.seq, 1);

  const retry = await post(base, '/api/appends', { generation: gen, opId: 'idem', increments: { A: 7 } });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.seq, 1);

  const conflict = await post(base, '/api/appends', { generation: gen, opId: 'idem', increments: { A: 8 } });
  assert.equal(conflict.status, 409);

  await expectNoEvent(sse, 700); // 重试与拒绝都不产生事件
  sse.close();
});

test('异代追加返回 409，非法 JSON / 缺字段返回 4xx', async () => {
  const { base } = await spawnServer(test);
  const g1 = (await post(base, '/api/generations', { channels: ['A'] })).data.generation;
  const g2 = (await post(base, '/api/generations', { channels: ['A'] })).data.generation;
  const late = await post(base, '/api/appends', { generation: g1, opId: 'z', increments: { A: 1 } });
  assert.equal(late.status, 409);

  const badJson = await fetch(`${base}/api/appends`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json'
  });
  assert.equal(badJson.status, 400);

  const unknownCh = await post(base, '/api/appends', { generation: g2, opId: 'q', increments: { Z: 1 } });
  assert.equal(unknownCh.status, 400);
});

test('事件流：先收 reset（带高水位快照），再按序消费增量', async () => {
  const { base } = await spawnServer(test);
  const gen = (await post(base, '/api/generations', { channels: ['A', 'B'] })).data.generation;
  await appendN(base, gen, 1, 3, () => ({ A: 1, B: 1 }));

  const sse = await openSSE(base);
  const reset = await sse.nextEvent();
  assert.equal(reset.event, 'reset');
  assert.equal(reset.data.snapshot.generation, gen);
  assert.equal(reset.data.snapshot.highWatermark, 3);
  assert.deepEqual(reset.data.frames.map((f) => f.seq), [1, 2, 3]);

  await post(base, '/api/appends', { generation: gen, opId: 'live', increments: { A: 1 } });
  const f4 = await sse.nextEvent();
  assert.equal(f4.event, 'frame');
  assert.equal(f4.data.seq, 4);
  assert.equal(f4.data.generation, gen);
  sse.close();
});

test('重连携带代号与游标：只收到缺口增量，不漏帧不重放', async () => {
  const { base } = await spawnServer(test);
  const gen = (await post(base, '/api/generations', { channels: ['A'] })).data.generation;
  await appendN(base, gen, 1, 5, () => ({ A: 1 }));

  const sse = await openSSE(base, `generation=${encodeURIComponent(gen)}&cursor=3`);
  const snap = await sse.nextEvent();
  assert.equal(snap.event, 'snapshot');
  assert.equal(snap.data.highWatermark, 5);

  const f4 = await sse.nextEvent();
  const f5 = await sse.nextEvent();
  assert.equal(f4.data.seq, 4);
  assert.equal(f5.data.seq, 5);
  assert.deepEqual(f5.data.totals, { A: 5 });

  await expectNoEvent(sse, 500);
  sse.close();
});

test('游标过旧（超出最近 32 帧）：发送完整 reset 供原子替换', async () => {
  const { base } = await spawnServer(test);
  const gen = (await post(base, '/api/generations', { channels: ['A'] })).data.generation;
  await appendN(base, gen, 1, 40, () => ({ A: 1 }));

  const sse = await openSSE(base, `generation=${encodeURIComponent(gen)}&cursor=2`);
  const evt = await sse.nextEvent();
  assert.equal(evt.event, 'reset');
  assert.equal(evt.data.reason, 'cursor_stale');
  assert.equal(evt.data.snapshot.highWatermark, 40);
  assert.equal(evt.data.frames.length, 32);
  assert.equal(evt.data.frames[0].seq, 9);
  assert.deepEqual(evt.data.snapshot.totals, { A: 40 });
  sse.close();
});

test('请求代际与当前不符：generation_mismatch，且收不到任何数据帧', async () => {
  const { base } = await spawnServer(test);
  const g1 = (await post(base, '/api/generations', { channels: ['A'] })).data.generation;
  const g2 = (await post(base, '/api/generations', { channels: ['A'] })).data.generation;

  const sse = await openSSE(base, `generation=${encodeURIComponent(g1)}`);
  const mm = await sse.nextEvent();
  assert.equal(mm.event, 'generation_mismatch');
  assert.equal(mm.data.expected, g1);
  assert.equal(mm.data.current, g2);

  // 新代继续产生帧，旧代连接不得收到
  await post(base, '/api/appends', { generation: g2, opId: 'n', increments: { A: 1 } });
  await expectNoEvent(sse, 700);
  sse.close();
});

test('旧连接在新开采集后收到 stale_generation；新一代帧不会改写旧画面', async () => {
  const { base } = await spawnServer(test);
  const g1 = (await post(base, '/api/generations', { channels: ['A'] })).data.generation;

  const oldConn = await openSSE(base, `generation=${encodeURIComponent(g1)}`);
  assert.equal((await oldConn.nextEvent()).event, 'reset');

  // 新开一代
  const g2 = (await post(base, '/api/generations', { channels: ['A', 'B'] })).data.generation;
  const stale = await oldConn.nextEvent();
  assert.equal(stale.event, 'stale_generation');
  assert.equal(stale.data.generation, g1);
  assert.equal(stale.data.currentGeneration, g2);

  await post(base, '/api/appends', { generation: g2, opId: 'g2f1', increments: { A: 1, B: 1 } });
  await expectNoEvent(oldConn, 700); // 旧连接隔离新代帧
  oldConn.close();

  // 新代连接正常收帧：reset 已含 g2f1，再实时收到下一帧
  const newConn = await openSSE(base, `generation=${encodeURIComponent(g2)}`);
  const reset2 = await newConn.nextEvent();
  assert.equal(reset2.event, 'reset');
  assert.deepEqual(reset2.data.frames.map((f) => f.seq), [1]);

  await post(base, '/api/appends', { generation: g2, opId: 'g2f2', increments: { A: 1 } });
  const f = await newConn.nextEvent();
  assert.equal(f.event, 'frame');
  assert.equal(f.data.seq, 2);
  newConn.close();
});

test('压缩后续接：断开期间累计多帧，重连得到与服务端相同的累计值', async () => {
  const { base } = await spawnServer(test);
  const gen = (await post(base, '/api/generations', { channels: ['A', 'B', 'C'] })).data.generation;

  const first = await openSSE(base);
  assert.equal((await first.nextEvent()).event, 'reset');

  // 断开期间（模拟网络抖动/休眠）打入 10 帧
  first.close();
  await appendN(base, gen, 1, 10);

  // 用游标 0 重连：在 32 帧窗口内，快照 + 10 帧补齐
  const back = await openSSE(base, `generation=${encodeURIComponent(gen)}&cursor=0`);
  assert.equal((await back.nextEvent()).event, 'snapshot');
  const got = [];
  for (let i = 0; i < 10; i++) got.push(await back.nextEvent());
  assert.deepEqual(got.map((e) => e.data.seq), Array.from({ length: 10 }, (_, i) => i + 1));
  assert.deepEqual(got[9].data.totals, { A: 10, B: 10, C: 5 });

  // 与 REST 权威快照一致
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(state.snapshot.totals, got[9].data.totals);
  back.close();
});

test('连接先于第一代建立：开代后收到 reset，随后实时帧正常', async () => {
  const { base } = await spawnServer(test);
  const sse = await openSSE(base);
  const empty = await sse.nextEvent();
  assert.equal(empty.event, 'snapshot');
  assert.equal(empty.data.snapshot, null);

  const gen = (await post(base, '/api/generations', { channels: ['A'] })).data.generation;
  const reset = await sse.nextEvent();
  assert.equal(reset.event, 'reset');
  assert.equal(reset.data.snapshot.generation, gen);

  await post(base, '/api/appends', { generation: gen, opId: 'f1', increments: { A: 1 } });
  const f = await sse.nextEvent();
  assert.equal(f.event, 'frame');
  assert.equal(f.data.seq, 1);
  sse.close();
});

test('实时帧严格递增：并发 HTTP 追加只落一帧/序号不重复', async () => {
  const { base } = await spawnServer(test);
  const gen = (await post(base, '/api/generations', { channels: ['A'] })).data.generation;
  const sse = await openSSE(base);
  assert.equal((await sse.nextEvent()).event, 'reset');

  // 15 个客户端同时用同一 opId 追加
  const results = await Promise.all(
    Array.from({ length: 15 }, () =>
      post(base, '/api/appends', { generation: gen, opId: 'same-op', increments: { A: 2 } })
    )
  );
  const oks = results.filter((r) => r.status === 200);
  assert.equal(oks.length, 15);
  assert.equal(oks.filter((r) => r.data.duplicate === false).length, 1);
  assert.ok(oks.every((r) => r.data.seq === 1));

  const f = await sse.nextEvent();
  assert.equal(f.event, 'frame');
  assert.equal(f.data.seq, 1);
  await expectNoEvent(sse, 600); // 只有一帧事件
  sse.close();
});
