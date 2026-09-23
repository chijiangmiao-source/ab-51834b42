// store.js
// 单文件 JSON 持久化存储。
// 一次“持久化事务”= 在互斥锁内完成：序号分配 + 快照更新 +
// 临时文件写入 + fsync + 原子 rename。崩溃只会留下上一版完整文件。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_FRAMES = 32;

const EMPTY = () => ({
  generation: null,          // 当前采集代号
  generationSeq: 0,          // 开代次数（仅用于内部诊断）
  channels: [],              // 当前代通道标识（顺序即展示顺序）
  totals: {},                // 通道累计值
  nextSeq: 1,                // 下一个严格递增序号
  frames: [],                // 最近 MAX_FRAMES 帧
  ops: {}                    // 操作标识 -> { seq, paramsHash } 幂等台账
});

export class IdempotencyReject extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdempotencyReject';
    this.statusCode = 409;
  }
}

export class GenerationMismatch extends Error {
  constructor(message) {
    super(message);
    this.name = 'GenerationMismatch';
    this.statusCode = 409;
  }
}

export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequest';
    this.statusCode = 400;
  }
}

export function hashParams(generation, opId, increments) {
  // 参数指纹：代际 + 操作标识 + 排序后的通道增量，便于异参重试稳定识别。
  const canon = JSON.stringify({
    generation,
    opId,
    increments: Object.keys(increments)
      .sort()
      .map((k) => [k, increments[k]])
  });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp-${process.pid}`;
    this.state = EMPTY();
    this.queue = Promise.resolve();
  }

  async init() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.#persist();
    }
    return this;
  }

  // 所有写操作串行化，保证并发追加“只落一帧”。
  #withLock(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #persist() {
    const tmp = `${this.tmpPath}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = JSON.stringify(this.state);
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync(); // 落盘
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, this.filePath); // 同目录原子替换
    const dir = await fs.open(path.dirname(this.filePath));
    try {
      await dir.sync(); // 让 rename 也落盘
    } finally {
      await dir.close();
    }
  }

  snapshot() {
    const s = this.state;
    return {
      generation: s.generation,
      channels: [...s.channels],
      totals: { ...s.totals },
      nextSeq: s.nextSeq,
      highWatermark: s.nextSeq - 1, // 已分配的最大序号
      frameCount: s.frames.length
    };
  }

  // 新开一代采集。旧代帧立即从保留窗口移除，旧 opId 台账清空。
  startGeneration(input) {
    return this.#withLock(async () => {
      const channels = validateChannels(input?.channels);
      const now = new Date().toISOString();
      const idNum = (this.state.generationSeq || 0) + 1;
      const generation =
        typeof input?.generation === 'string' && input.generation.trim()
          ? input.generation.trim()
          : `gen-${idNum}-${crypto.randomBytes(4).toString('hex')}`;
      if (this.state.ops[generation]) {
        throw new BadRequest('采集代号冲突，请换一个代号');
      }
      this.state = {
        ...EMPTY(),
        generation,
        generationSeq: idNum,
        channels,
        totals: Object.fromEntries(channels.map((c) => [c, 0])),
        nextSeq: 1,
        frames: [],
        ops: {}
      };
      await this.#persist();
      return {
        generation,
        channels: [...channels],
        totals: { ...this.state.totals },
        nextSeq: 1,
        highWatermark: 0,
        startedAt: now
      };
    });
  }

  // 幂等追加：合法 opId 分配严格递增序号并更新快照；
  // 同 opId 同参数重试返回原序号；异参复用稳定拒绝且不产生任何事件/帧。
  append({ generation, opId, increments }) {
    return this.#withLock(async () => {
      if (!this.state.generation) throw new BadRequest('尚无采集，请先新开一代');
      if (typeof generation !== 'string' || !generation) {
        throw new BadRequest('缺少采集代号 generation');
      }
      if (generation !== this.state.generation) {
        // 异代追加（含旧连接重放）稳定拒绝。
        throw new GenerationMismatch(
          `代际不符：请求 ${generation}，当前为 ${this.state.generation}`
        );
      }
      if (typeof opId !== 'string' || !opId.trim()) {
        throw new BadRequest('缺少操作标识 opId');
      }
      opId = opId.trim();
      const inc = validateIncrements(increments, this.state.channels);
      const fingerprint = hashParams(generation, opId, inc);

      const seen = this.state.ops[opId];
      if (seen) {
        if (seen.paramsHash === fingerprint) {
          // 幂等命中：返回原结果，不写帧、不产生事件。
          const frame = this.state.frames.find((f) => f.seq === seen.seq) || null;
          return {
            duplicate: true,
            seq: seen.seq,
            generation,
            increments: frame ? { ...frame.increments } : { ...inc },
            totals: frame ? { ...frame.totalsAfter } : { ...this.state.totals }
          };
        }
        throw new IdempotencyReject(
          `操作标识 ${opId} 已用于不同参数，禁止复用`
        );
      }

      const seq = this.state.nextSeq;
      const totals = { ...this.state.totals };
      for (const [ch, delta] of Object.entries(inc)) totals[ch] += delta;
      const frame = {
        seq,
        generation,
        opId,
        increments: { ...inc },
        totalsAfter: totals,
        at: new Date().toISOString()
      };
      const frames = [...this.state.frames, frame];
      if (frames.length > MAX_FRAMES) frames.splice(0, frames.length - MAX_FRAMES);

      this.state = {
        ...this.state,
        totals,
        nextSeq: seq + 1,
        frames,
        ops: { ...this.state.ops, [opId]: { seq, paramsHash: fingerprint } }
      };
      await this.#persist();
      return { duplicate: false, seq, generation, ...frame, totals: totals };
    });
  }

  // 保留窗口内的全部帧（reset 事件用）。
  recentFrames() {
    return this.state.frames.map((f) => ({ ...f }));
  }

  // 取游标之后的帧；游标比最老帧还旧时返回 null，调用方须发全量重置。
  framesAfter(cursor) {
    const frames = this.state.frames;
    if (!frames.length) {
      return cursor < this.state.nextSeq - 1 ? null : [];
    }
    const oldest = frames[0].seq;
    if (cursor < oldest - 1) return null; // 缺口无法补
    return frames.filter((f) => f.seq > cursor).map((f) => ({ ...f }));
  }
}

function validateChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new BadRequest('channels 必须是非空数组');
  }
  const seen = new Set();
  for (const c of channels) {
    if (typeof c !== 'string' || !c.trim()) {
      throw new BadRequest('通道名必须是非空字符串');
    }
    if (seen.has(c)) throw new BadRequest(`通道重复：${c}`);
    seen.add(c);
  }
  return channels.map((c) => c.trim());
}

function validateIncrements(increments, channels) {
  if (!increments || typeof increments !== 'object' || Array.isArray(increments)) {
    throw new BadRequest('increments 必须是 {通道: 增量} 对象');
  }
  const allowed = new Set(channels);
  const out = {};
  for (const [ch, raw] of Object.entries(increments)) {
    if (!allowed.has(ch)) throw new BadRequest(`未知通道：${ch}`);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new BadRequest(`通道 ${ch} 的增量必须是有限数`);
    out[ch] = n;
  }
  if (Object.keys(out).length === 0) {
    throw new BadRequest('increments 至少包含一个通道增量');
  }
  return out;
}
