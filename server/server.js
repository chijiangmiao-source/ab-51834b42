// server.js — 零运行时依赖 HTTP 服务：REST + SSE + 静态页
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Hub } from './hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'store.json');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const store = new Store(DATA_FILE);
const hub = new Hub();
const startedAt = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 解析失败'), { statusCode: 400 });
  }
}

function errorStatus(err) {
  return err.statusCode || 500;
}

// ---------------- SSE ----------------
function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// 建立事件流：
//  1) 先订阅总线（期间任何事件进入缓冲，绝不丢帧）；
//  2) 读快照，按代际/游标决定 reset、snapshot+补帧或 mismatch；
//  3) 一致性复检（订阅后若发生开代，重放数据已过期，则重发 reset）；
//  4) 放行缓冲，实时帧按绑定代际过滤——旧连接迟到事件进不了当前画面。
function handleStream(req, res, query) {
  const requested = query.get('generation') || null;
  const cursorRaw = query.get('cursor');
  const cursor = cursorRaw === null || cursorRaw === '' ? null : Number(cursorRaw);
  if (cursorRaw !== null && cursorRaw !== '' && (!Number.isInteger(cursor) || cursor < 0)) {
    sendJson(res, 400, { error: 'cursor 必须是非负整数' });
    return;
  }

  sseInit(res);
  let closed = false;
  let phase = 'init'; // init -> replay -> live
  const buffered = [];

  const unsubscribe = hub.subscribe((evt) => {
    if (phase === 'live') flushLive(evt);
    else buffered.push(evt);
  });

  let boundGeneration = null;

  function flushLive(evt) {
    if (closed) return;
    if (evt.type === 'frame') {
      // 绑定代际过滤：旧代连接上迟到的新一代帧不会下发；
      // 新一代连接也不会收到旧代帧。
      if (evt.generation !== boundGeneration) return;
      sseSend(res, 'frame', evt);
    } else if (evt.type === 'stale_generation') {
      // 仅通知被终结的那一代连接。
      if (evt.generation === boundGeneration) sseSend(res, 'stale_generation', evt);
    } else if (evt.type === 'generation_started') {
      // 连接建立时还没有任何采集（boundGeneration=null）：
      // 第一次开代后补发完整 reset，让空态连接无需重连即可进入新一代。
      if (boundGeneration === null) {
        const snap = store.snapshot();
        boundGeneration = snap.generation;
        sseSend(res, 'reset', { reason: 'initial', snapshot: snap, frames: store.recentFrames() });
      }
    }
  }

  function teardown() {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    unsubscribe();
  }

  const ping = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 25000);
  req.on('close', teardown);

  const snapshot = store.snapshot();
  const currentGeneration = snapshot.generation;

  if (requested && currentGeneration && requested !== currentGeneration) {
    // 代际不符：明确状态，不投递任何数据帧。
    boundGeneration = requested; // 只接收属于自己旧代的 stale 通知
    sseSend(res, 'generation_mismatch', { expected: requested, current: currentGeneration });
    phase = 'live';
    for (const evt of buffered) flushLive(evt);
    buffered.length = 0;
    return;
  }

  boundGeneration = currentGeneration;

  if (!currentGeneration) {
    sseSend(res, 'snapshot', { snapshot: null, highWatermark: null });
    phase = 'live';
    buffered.length = 0;
    return;
  }

  // 重放已覆盖到的（代际, 最大序号）；缓冲中同代且 seq 不超过它的帧是重复，丢弃。
  let replayedGeneration = null;
  let replayedMaxSeq = -1;

  const emitReplay = () => {
    const snap = store.snapshot();
    boundGeneration = snap.generation;

    if (requested && snap.generation && requested !== snap.generation) {
      sseSend(res, 'generation_mismatch', { expected: requested, current: snap.generation });
      return;
    }

    if (cursor === null) {
      // 首次连接：完整重置，客户端原子替换画面。
      sseSend(res, 'reset', {
        reason: 'initial',
        snapshot: snap,
        frames: store.recentFrames()
      });
      replayedGeneration = snap.generation;
      replayedMaxSeq = snap.highWatermark;
      return;
    }

    const missed = store.framesAfter(cursor);
    if (missed === null) {
      // 游标过旧（缺口已超出最近 32 帧窗口）：完整重置。
      sseSend(res, 'reset', {
        reason: 'cursor_stale',
        snapshot: snap,
        frames: store.recentFrames()
      });
      replayedGeneration = snap.generation;
      replayedMaxSeq = snap.highWatermark;
      return;
    }

    // 先快照（带高水位），再按序消费增量。
    sseSend(res, 'snapshot', { snapshot: snap, highWatermark: snap.highWatermark });
    for (const f of missed) {
      sseSend(res, 'frame', {
        type: 'frame',
        seq: f.seq,
        generation: f.generation,
        opId: f.opId,
        increments: f.increments,
        totals: f.totalsAfter,
        at: f.at
      });
    }
    replayedGeneration = snap.generation;
    replayedMaxSeq = snap.highWatermark;
  };

  emitReplay();

  // 一致性复检：订阅之后若发生过开代（缓冲里出现 stale_generation），
  // 重放可能跨越代际，直接以最新状态发一次 reset，由客户端原子替换。
  const staleDuringReplay = buffered.some(
    (e) => e.type === 'stale_generation' && (!requested || e.currentGeneration)
  );
  if (staleDuringReplay && store.snapshot().generation) {
    const fresh = store.snapshot();
    sseSend(res, 'reset', {
      reason: 'generation_changed',
      snapshot: fresh,
      frames: store.recentFrames()
    });
    boundGeneration = fresh.generation;
    replayedGeneration = fresh.generation;
    replayedMaxSeq = fresh.highWatermark;
  }

  phase = 'live';
  for (const evt of buffered) {
    if (
      evt.type === 'frame' &&
      evt.generation === replayedGeneration &&
      evt.seq <= replayedMaxSeq
    ) {
      continue; // 已在快照/补帧中下发，绝不重放
    }
    flushLive(evt);
  }
  buffered.length = 0;
}

// ---------------- HTTP 路由 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /health') {
      sendJson(res, 200, {
        status: 'ok',
        uptimeMs: Date.now() - startedAt,
        generation: store.snapshot().generation
      });
      return;
    }

    if (route === 'GET /api/state') {
      const snap = store.snapshot();
      sendJson(res, 200, { snapshot: snap, frames: store.recentFrames() });
      return;
    }

    if (route === 'POST /api/generations') {
      const body = await readJson(req);
      const previous = store.snapshot().generation;
      const result = await store.startGeneration(body);
      if (previous && previous !== result.generation) {
        hub.publishGenerationEnded(previous, result.generation);
      }
      hub.publishGenerationStarted(result.generation);
      sendJson(res, 201, result);
      return;
    }

    if (route === 'POST /api/appends') {
      const body = await readJson(req);
      const result = await store.append(body);
      if (!result.duplicate) {
        hub.publishFrame({
          seq: result.seq,
          generation: result.generation,
          opId: result.opId,
          increments: result.increments,
          totalsAfter: result.totals,
          at: result.at
        });
      }
      // 同 opId 同参重试：幂等命中，返回原序号（200）。
      sendJson(res, 200, {
        duplicate: result.duplicate,
        seq: result.seq,
        generation: result.generation,
        increments: result.increments,
        totals: result.totals
      });
      return;
    }

    if (route === 'GET /api/stream') {
      handleStream(req, res, url.searchParams);
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(url.pathname, res);
      return;
    }

    sendJson(res, 404, { error: '未找到' });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, errorStatus(err), { error: err.message || '服务器内部错误' });
    } else {
      res.destroy();
    }
    if (errorStatus(err) === 500) console.error(err);
  }
});

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store'
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: '未找到' });
  }
}

await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
await store.init();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`低温阵列扫描复核台监听 http://${HOST}:${PORT}`);
  });
}

export { server, store, hub };
