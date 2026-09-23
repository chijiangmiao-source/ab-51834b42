// hub.js — SSE 事件总线。
// 订阅者收到全部事件，由连接层按绑定代际过滤；代际终结事件定向通知旧代连接。
export class Hub {
  constructor() {
    this.subs = new Set();
  }

  subscribe(send) {
    const sub = { send, closed: false };
    this.subs.add(sub);
    return () => {
      sub.closed = true;
      this.subs.delete(sub);
    };
  }

  publishFrame(frame) {
    const evt = {
      type: 'frame',
      seq: frame.seq,
      generation: frame.generation,
      opId: frame.opId,
      increments: frame.increments,
      totals: frame.totalsAfter,
      at: frame.at
    };
    for (const sub of [...this.subs]) {
      if (!sub.closed) sub.send(evt);
    }
  }

  publishGenerationEnded(oldGeneration, newGeneration) {
    const evt = {
      type: 'stale_generation',
      generation: oldGeneration,
      currentGeneration: newGeneration
    };
    for (const sub of [...this.subs]) {
      if (!sub.closed) sub.send(evt);
    }
  }

  // 任何一次开代都广播（含从“尚无采集”进入第一代）。
  publishGenerationStarted(newGeneration) {
    const evt = { type: 'generation_started', generation: newGeneration };
    for (const sub of [...this.subs]) {
      if (!sub.closed) sub.send(evt);
    }
  }
}
