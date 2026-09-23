// app.js — 复核台交互
import { SurveyClient, STATUS, ApiError } from './client.js';
import { drawChart } from './chart.js';

const $ = (id) => document.getElementById(id);
const client = new SurveyClient();

const STATUS_TEXT = {
  connecting: { label: '连接中', cls: 'conn-connecting' },
  live: { label: '已连接', cls: 'conn-live' },
  reconnecting: { label: '重连中', cls: 'conn-reconnecting' },
  gap: { label: '序号缺口', cls: 'conn-gap' },
  stale: { label: '旧代已失效', cls: 'conn-stale' },
  mismatch: { label: '代际不符', cls: 'conn-stale' },
  fatal: { label: '不可恢复', cls: 'conn-fatal' }
};

client.onChange(render);

// 新开一代
$('gen-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const channels = $('channels').value.split(',').map((s) => s.trim()).filter(Boolean);
  const generation = $('gen-name').value.trim();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    await client.startGeneration({ channels, generation });
    $('gen-name').value = '';
    $('opid').value = uuid();
  } catch (err) {
    setApiStatus(`开代失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

function collectIncrements() {
  const increments = {};
  for (const row of document.querySelectorAll('.inc-row')) {
    const input = row.querySelector('input');
    const v = Number(input.value);
    if (input.value === '' || !Number.isFinite(v)) continue;
    increments[row.dataset.ch] = v;
  }
  return increments;
}

// 追加帧
$('append-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!client.generation) return;
  let opId = $('opid').value.trim() || uuid();
  $('opid').value = opId; // 保留供“同参重试”
  const increments = collectIncrements();
  try {
    const r = await client.append({ generation: client.generation, opId, increments });
    setApiStatus(
      r.duplicate ? `幂等命中：返回原序号 ${r.seq}（未产生新事件）` : `已落帧 #${r.seq}`,
      false
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      setApiStatus(`追加被稳定拒绝（409）：${err.message}`, true);
    } else {
      setApiStatus(`追加失败：${err.message}`, true);
    }
  }
});

// 同参重试：opId 与增量不变再发一次
$('retry-btn').addEventListener('click', async () => {
  if (!client.generation) return;
  const opId = $('opid').value.trim();
  if (!opId) {
    setApiStatus('请先追加一次或填写 opId', true);
    return;
  }
  const increments = collectIncrements();
  try {
    const r = await client.append({ generation: client.generation, opId, increments });
    setApiStatus(r.duplicate ? `同参重试 -> 原序号 ${r.seq}，无新事件` : `已落帧 #${r.seq}`, false);
  } catch (err) {
    setApiStatus(`重试失败：${err.message}`, true);
  }
});

// 收到新一代后重建增量输入框
function syncIncInputs() {
  if (!client.channels.length) {
    $('inc-inputs').innerHTML = '<em class="muted">尚无采集</em>';
    $('append-btn').disabled = true;
    $('retry-btn').disabled = true;
    return;
  }
  const existing = new Set([...document.querySelectorAll('.inc-row')].map((r) => r.dataset.ch));
  if (existing.size === client.channels.length && client.channels.every((c) => existing.has(c))) return;
  $('inc-inputs').innerHTML = client.channels
    .map(
      (ch) => `<div class="inc-row" data-ch="${escapeHtml(ch)}"><label>${escapeHtml(ch)}
      <input type="number" step="any" value="0" /></label></div>`
    )
    .join('');
  $('append-btn').disabled = false;
  $('retry-btn').disabled = false;
}

function render() {
  const st = STATUS_TEXT[client.status] || STATUS_TEXT.connecting;
  const conn = $('conn');
  conn.className = `conn ${st.cls}`;
  $('conn-text').textContent = `${st.label} · 已隔离旧代迟到事件 ${client.lateEventsDropped} 次`;

  $('meta-gen').textContent = client.generation ?? '—';
  const seqLo = client.frames.length ? client.frames[0].seq : 0;
  const seqHi = client.frames.length ? client.frames[client.frames.length - 1].seq : 0;
  $('meta-seq').textContent = client.frames.length ? `${seqLo}–${seqHi}` : '0';
  $('meta-hwm').textContent = client.hwm ?? '—';

  syncIncInputs();

  // 横幅：缺口 / 旧代 / 不符 / 重置提示
  const banner = $('banner');
  if (client.status === STATUS.FATAL) {
    banner.className = 'banner banner-fatal';
    banner.innerHTML = `${escapeHtml(client.statusDetail)}
      <button type="button" id="reconnect-btn" class="mini">重新连接</button>`;
    $('reconnect-btn')?.addEventListener('click', () => {
      client.failures = 0;
      client.backoff = 500;
      client.receivedAnything = false;
      client.start();
    });
  } else if (client.status === STATUS.GAP) {
    banner.className = 'banner banner-warn';
    banner.textContent = client.statusDetail;
  } else if (client.status === STATUS.STALE || client.status === STATUS.MISMATCH) {
    banner.className = 'banner banner-stale';
    banner.innerHTML = `${escapeHtml(client.statusDetail)}
      <button type="button" id="jump-btn" class="mini">切换到最新一代</button>`;
    $('jump-btn')?.addEventListener('click', () => client.jumpToLatest());
  } else if (client.banner) {
    banner.className = 'banner banner-info';
    banner.textContent = client.banner;
  } else {
    banner.className = 'banner hidden';
    banner.textContent = '';
  }

  // 各通道累计值卡片
  const totalsEl = $('totals');
  totalsEl.innerHTML = client.channels
    .map((ch) => {
      const v = client.totals[ch] ?? 0;
      return `<div class="ch-card"><span class="ch-name">${escapeHtml(ch)}</span>
        <span class="ch-val">${formatNum(v)}</span></div>`;
    })
    .join('');

  // 帧表格
  const tbody = $('frames-table').querySelector('tbody');
  tbody.innerHTML = [...client.frames]
    .reverse()
    .slice(0, 32)
    .map(
      (f) => `<tr><td>#${f.seq}</td><td title="${escapeHtml(f.opId)}">${escapeHtml(truncate(f.opId, 10))}</td>
    <td>${formatInc(f.increments)}</td><td>${formatInc(f.totals)}</td>
    <td>${f.at ? new Date(f.at).toLocaleTimeString() : '—'}</td></tr>`
    )
    .join('');

  drawChart($('chart'), client.channels, client.frames);
}

function setApiStatus(msg, bad) {
  const el = $('api-status');
  el.textContent = msg;
  el.className = bad ? 'api-status bad' : 'api-status ok';
}

function uuid() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}
function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function formatNum(v) {
  return Number.isFinite(v) ? v.toFixed(2) : '0.00';
}
function formatInc(o) {
  return Object.entries(o)
    .map(([k, v]) => `${k}:${formatNum(v)}`)
    .join(' ');
}

client.start();
