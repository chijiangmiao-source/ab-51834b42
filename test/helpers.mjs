// test/helpers.mjs — 启动临时数据文件的服务进程 + 极简 SSE 解析
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function spawnServer(t) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  const dataFile = path.join(dir, 'store.json');
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  t.after(async () => {
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r)).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return { base, dataFile, child };
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('测试服务启动超时');
}

export async function post(base, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function appendN(base, generation, start, count, incrementsFor) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const seq = start + i;
    const increments =
      typeof incrementsFor === 'function'
        ? incrementsFor(seq, i)
        : incrementsFor || { A: 1, B: i % 2 === 0 ? 2 : 0, C: 0.5 };
    const r = await post(base, '/api/appends', {
      generation,
      opId: `op-${seq}`,
      increments
    });
    out.push(r);
  }
  return out;
}

// 打开 SSE 连接，逐条读取事件。
export async function openSSE(base, query = '') {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/stream${query ? `?${query}` : ''}`, {
    signal: ctrl.signal,
    headers: { Accept: 'text/event-stream' }
  });
  if (!res.ok) {
    ctrl.abort();
    throw new Error(`SSE HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  async function nextEvent(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 SSE 事件超时')), timeoutMs);
      const pump = async () => {
        while (true) {
          const nl = buf.indexOf('\n\n');
          if (nl >= 0) {
            const raw = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            clearTimeout(timer);
            const evt = parseBlock(raw);
            if (evt) return resolve(evt);
            continue; // 注释块（connected/ping）跳过，继续读
          }
          const { value, done } = await reader.read();
          if (done) {
            clearTimeout(timer);
            return reject(new Error('SSE 连接结束'));
          }
          buf += decoder.decode(value, { stream: true });
        }
      };
      pump().catch(reject);
    });
  }

  return {
    nextEvent,
    close() {
      ctrl.abort();
      reader.cancel().catch(() => {});
    }
  };
}

function parseBlock(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  return { event, data: JSON.parse(dataLines.join('\n')) };
}

export async function expectNoEvent(sse, ms = 600) {
  let threw = false;
  try {
    await sse.nextEvent(ms);
    threw = true;
  } catch {}
  if (threw) throw new Error('预期不应收到事件，却收到了');
}
