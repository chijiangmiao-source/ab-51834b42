// client.js — 复核台/监看墙共享客户端：状态机 + SSE 续传 + REST
// 纯原生 ES Module，无构建依赖。
//
// 状态约定：
//   connecting   首次建立事件流
//   live         实时连接
//   reconnecting 网络抖动/休眠后重连（携带代号与游标）
//   gap          检测到序号缺口
//   stale        绑定的采集代已被重开
//   mismatch     请求代际与当前代不符
//   fatal        不可恢复响应（HTTP 持续错误）
export const STATUS = {
  CONNECTING: 'connecting',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  GAP: 'gap',
  STALE: 'stale',
  MISMATCH: 'mismatch',
  FATAL: 'fatal'
};

export class SurveyClient extends EventTarget {
  constructor() {
    super();
    this.status = STATUS.CONNECTING;
    this.statusDetail = '';
    this.generation = null;
    this.channels = [];
    this.totals = {};
    this.frames = []; // 当前代、按 seq 升序（去重）
    this.hwm = null;
    this.cursor = null;
    this.banner = ''; // 一次性提示（如“游标过旧，已全量重置”）
    this.lateEventsDropped = 0; // 旧代迟到帧计数（证明隔离生效）

    this.es = null;
    this.stopped = false;
    this.backoff = 500;
    this.failures = 0;
    this.receivedAnything = false;
    this.connectGeneration = null; // 本次连接携带的代号
    this.connectCursor = null;
  }

  onChange(handler) {
    this.addEventListener('change', () => handler(this));
  }

  #emit() {
    this.dispatchEvent(new Event('change'));
  }

  #setStatus(status, detail = '') {
    this.status = status;
    this.statusDetail = detail;
    this.#emit();
  }

  #setBanner(msg) {
    this.banner = msg;
    this.#emit();
  }

  // ---- 状态应用 ----

  // 完整重置：原子替换整份画面数据。
  applyReset(payload) {
    const snap = payload?.snapshot || null;
    if (!snap || !snap.generation) {
      this.generation = null;
      this.channels = [];
      this.totals = {};
      this.frames = [];
      this.hwm = null;
      this.cursor = null;
    } else {
      this.generation = snap.generation;
      this.channels = [...snap.channels];
      this.totals = { ...snap.totals };
      this.hwm = snap.highWatermark;
      this.frames = (payload.frames || [])
        .map(normalizeFrame)
        .sort((a, b) => a.seq - b.seq);
      this.cursor = this.frames.length ? this.frames[this.frames.length - 1].seq : 0;
    }
    if (payload?.reason === 'cursor_stale') {
      this.#setBanner('游标过旧，服务端保留窗口已无法补齐，已按全量快照原子重置。');
    } else if (payload?.reason === 'generation_changed') {
      this.#setBanner('重连期间采集代发生变化，已切换到最新一代。');
    } else {
      this.banner = '';
    }
    this.#setStatus(STATUS.LIVE);
  }

  // 重连补发：先到带高水位快照，再消费增量。
  applySnapshot(msg) {
    const snap = msg?.snapshot || null;
    if (!snap || !snap.generation) {
      this.generation = null;
      this.channels = [];
      this.totals = {};
      this.frames = [];
      this.hwm = null;
      this.cursor = null;
      this.#setStatus(STATUS.LIVE);
      return;
    }
    if (snap.generation !== this.generation) {
      // 快照属于不同代：旧帧全部作废，等后续 reset/帧重建画面。
      this.generation = snap.generation;
      this.channels = [...snap.channels];
      this.frames = [];
      this.cursor = 0;
    } else {
      this.channels = [...snap.channels];
    }
    this.totals = { ...snap.totals };
    this.hwm = snap.highWatermark;
    this.#setStatus(STATUS.LIVE, '重连成功，已补发缺口帧');
  }

  applyFrame(raw) {
    const f = normalizeFrame(raw);
    if (!this.generation) return; // 快照未到，忽略
    if (f.generation !== this.generation) {
      // 旧连接上的旧代/异代迟到事件：隔离，绝不改写当前画面。
      this.lateEventsDropped += 1;
      this.#emit();
      return;
    }
    if (this.frames.some((x) => x.seq === f.seq)) return; // 重放去重
    this.frames.push(f);
    this.frames.sort((a, b) => a.seq - b.seq);
    if (this.frames.length > 32) this.frames.splice(0, this.frames.length - 32);
    this.totals = { ...f.totals }; // 以服务端累计值为准
    this.hwm = Math.max(this.hwm ?? 0, f.seq);
    this.cursor = f.seq;
    this.#checkGap();
    this.#emit();
  }

  #checkGap() {
    // 保留窗口内序号必须连续；缺口须显式呈现，补齐后自动恢复。
    const missing = [];
    for (let i = 1; i < this.frames.length; i++) {
      for (let s = this.frames[i - 1].seq + 1; s < this.frames[i].seq; s++) missing.push(s);
    }
    if (missing.length) {
      if (this.status !== STATUS.GAP) {
        this.#setStatus(STATUS.GAP, `序号缺口：缺少 ${missing.join('、')}，等待重连补发或全量重置`);
      }
    } else if (this.status === STATUS.GAP) {
      this.#setStatus(STATUS.LIVE);
    }
  }

  markStale(evt) {
    this.#setStatus(
      STATUS.STALE,
      `当前代 ${evt.generation} 已结束，最新代为 ${evt.currentGeneration}。旧代迟到事件已被隔离。`
    );
  }

  markMismatch(evt) {
    this.#setStatus(
      STATUS.MISMATCH,
      `代际不符：本页请求 ${evt.expected ?? '—'}，服务端当前为 ${evt.current ?? '—'}。`
    );
  }

  // ---- SSE 传输 ----
  start() {
    this.stopped = false;
    this.#openStream(this.generation, this.cursor, true);
  }

  // 用户新开一代 / 手动切换到最新代后调用。
  jumpToLatest() {
    this.es?.close();
    this.backoff = 500;
    this.failures = 0;
    this.#openStream(null, null, false);
  }

  stop() {
    this.stopped = true;
    this.es?.close();
  }

  #openStream(generation, cursor, isFirstAttempt) {
    if (this.stopped) return;
    this.connectGeneration = generation;
    this.connectCursor = cursor;
    if (isFirstAttempt && this.failures === 0) {
      this.#setStatus(STATUS.CONNECTING, generation ? `连接 ${generation} …` : '建立事件流…');
    } else {
      this.#setStatus(
        STATUS.RECONNECTING,
        `网络中断，第 ${this.failures + 1} 次重连（代号=${generation ?? '最新'}，游标=${cursor ?? '无'}）`
      );
    }

    const params = new URLSearchParams();
    if (generation) params.set('generation', generation);
    if (cursor !== null) params.set('cursor', String(cursor));
    const url = `/api/stream${params.size ? `?${params}` : ''}`;

    let opened = false;
    const es = new EventSource(url);
    this.es = es;

    es.addEventListener('open', () => {
      opened = true;
      this.failures = 0;
      this.backoff = 500;
    });

    es.addEventListener('reset', (e) => {
      this.receivedAnything = true;
      this.applyReset(JSON.parse(e.data));
    });
    es.addEventListener('snapshot', (e) => {
      this.receivedAnything = true;
      this.applySnapshot(JSON.parse(e.data));
    });
    es.addEventListener('frame', (e) => {
      this.receivedAnything = true;
      this.applyFrame(JSON.parse(e.data));
    });
    es.addEventListener('stale_generation', (e) => {
      this.receivedAnything = true;
      this.markStale(JSON.parse(e.data));
    });
    es.addEventListener('generation_mismatch', (e) => {
      this.receivedAnything = true;
      this.markMismatch(JSON.parse(e.data));
    });

    es.addEventListener('error', () => {
      es.close();
      if (this.stopped) return;
      this.failures += 1;

      // 一直没能建立：可能是携带的游标被服务端判为非法等不可恢复响应，
      // EventSource 读不到状态码，改用 REST 快照兜底恢复。
      if (!this.receivedAnything && this.failures >= 2) {
        this.#recoverViaHttp();
        return;
      }
      setTimeout(() => {
        // 重连携带代号与游标；若期间代际变化，服务端会下发 mismatch/reset。
        this.#openStream(this.generation, this.cursor, false);
      }, Math.min(this.backoff, 10000) + Math.random() * 200);
      this.backoff = Math.min(this.backoff * 2, 10000);
    });
  }

  async #recoverViaHttp() {
    try {
      const res = await fetch('/api/state', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.applyReset({ reason: 'initial', snapshot: data.snapshot, frames: data.frames });
      this.#setBanner('事件流不可用，已通过 REST 快照恢复，随后重新订阅事件流。');
      this.failures = 0;
      this.backoff = 500;
      setTimeout(() => this.#openStream(this.generation, this.cursor, false), 300);
    } catch (err) {
      if (this.failures >= 6) {
        this.#setStatus(
          STATUS.FATAL,
          `不可恢复：事件流与状态接口均无法访问（${err.message}）。请检查网络后手动重连。`
        );
        return;
      }
      setTimeout(() => this.#openStream(this.generation, this.cursor, false), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10000);
    }
  }

  // ---- REST 操作（复核台） ----
  async startGeneration(body) {
    const res = await fetch('/api/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
    // 本机新开一代：立即重新订阅，拿到新一代 reset。
    this.jumpToLatest();
    return data;
  }

  async append(body) {
    const res = await fetch('/api/appends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
    return data;
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeFrame(f) {
  return {
    seq: f.seq,
    generation: f.generation,
    opId: f.opId,
    increments: { ...(f.increments || {}) },
    totals: { ...(f.totals || f.totalsAfter || {}) },
    at: f.at
  };
}
