// scripts/smoke.mjs — API/HTTP 冒烟：在已运行的服务（SMOKE_BASE 或新建临时实例）上
// 走一遍 健康 -> 静态页 -> 开代 -> 并发幂等追加 -> 状态 -> SSE 首事件。
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close((e) => (e ? reject(e) : resolve(p)));
    });
  });
}

async function waitHealthy(base, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务未在超时内就绪');
}

async function startTempServer() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-smoke-'));
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_FILE: path.join(dir, 's.json') },
    stdio: 'ignore'
  });
  return { base: `http://127.0.0.1:${port}`, child, dir };
}

const checks = [];
const check = (name, cond, detail = '') => {
  checks.push([name, !!cond, detail]);
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const external = process.env.SMOKE_BASE;
let server = null;
if (external) {
  await waitHealthy(external);
} else {
  server = await startTempServer();
  await waitHealthy(server.base);
}
const base = external || server.base;

try {
  const B = base;

  const h = await fetch(`${B}/health`);
  check('GET /health 200', h.status === 200);

  for (const p of ['/', '/monitor.html', '/app.js', '/client.js', '/chart.js', '/styles.css']) {
    const r = await fetch(`${B}${p}`);
    check(`静态资源 ${p}`, r.status === 200, String(r.status));
  }

  const g = await fetch(`${B}/api/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels: ['A', 'B'] })
  });
  const genData = await g.json();
  check('POST /api/generations 201', g.status === 201, genData.generation);

  // 并发同 opId 幂等
  const raced = await Promise.all(
    Array.from({ length: 8 }, () =>
      fetch(`${B}/api/appends`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generation: genData.generation, opId: 'smoke-1', increments: { A: 3, B: 1 } })
      }).then((r) => r.json())
    )
  );
  check('并发同 opId 只落一帧', raced.every((r) => r.seq === 1), `8x -> seq ${raced[0].seq}`);

  // 同参重试
  const retry = await fetch(`${B}/api/appends`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ generation: genData.generation, opId: 'smoke-1', increments: { A: 3, B: 1 } })
  }).then((r) => r.json());
  check('同参重放幂等', retry.duplicate === true && retry.seq === 1);

  // 异参复用
  const conflict = await fetch(`${B}/api/appends`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ generation: genData.generation, opId: 'smoke-1', increments: { A: 9 } })
  });
  check('异参复用稳定 409', conflict.status === 409);

  // 再正常落两帧
  await fetch(`${B}/api/appends`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ generation: genData.generation, opId: 'smoke-2', increments: { A: 2 } })
  });
  const state = await (await fetch(`${B}/api/state`)).json();
  check(
    'GET /api/state 累计正确',
    state.snapshot.totals.A === 5 && state.snapshot.totals.B === 1,
    JSON.stringify(state.snapshot.totals)
  );

  // SSE 首事件为 reset
  const sseRes = await fetch(`${B}/api/stream`);
  const reader = sseRes.body.getReader();
  const chunk = await reader.read();
  reader.cancel().catch(() => {});
  const text = new TextDecoder().decode(chunk.value);
  check('SSE 首包含 reset 事件', text.includes('event: reset') && text.includes('highWatermark'));
} finally {
  if (server) {
    server.child.kill('SIGKILL');
    fs.rmSync(server.dir, { recursive: true, force: true });
  }
}

const failed = checks.filter(([, ok]) => !ok).length;
if (failed) {
  console.error(`\n冒烟失败：${failed}/${checks.length}`);
  process.exit(1);
}
console.log(`\n冒烟全部通过（${checks.length} 项）`);
