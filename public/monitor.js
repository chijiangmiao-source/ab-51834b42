// monitor.js — 只读监看墙：网络抖动/浏览器休眠后重连，看到同一代连续累计曲线
import { SurveyClient, STATUS } from './client.js';
import { drawChart } from './chart.js';

const $ = (id) => document.getElementById(id);
const client = new SurveyClient();

const STATUS_TEXT = {
  connecting: { label: '连接中', cls: 'conn-connecting' },
  live: { label: '实时', cls: 'conn-live' },
  reconnecting: { label: '重连中（携带代号+游标）', cls: 'conn-reconnecting' },
  gap: { label: '序号缺口', cls: 'conn-gap' },
  stale: { label: '旧代已失效', cls: 'conn-stale' },
  mismatch: { label: '代际不符', cls: 'conn-stale' },
  fatal: { label: '不可恢复', cls: 'conn-fatal' }
};

client.onChange(render);
client.start();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function render() {
  const st = STATUS_TEXT[client.status] || STATUS_TEXT.connecting;
  $('conn').className = `conn ${st.cls}`;
  $('conn-text').textContent = st.label;

  $('meta-gen').textContent = client.generation ?? '—';
  const seqLo = client.frames.length ? client.frames[0].seq : 0;
  const seqHi = client.frames.length ? client.frames[client.frames.length - 1].seq : 0;
  $('meta-seq').textContent = client.frames.length ? `${seqLo}–${seqHi}` : '0';
  $('meta-hwm').textContent = client.hwm ?? '—';

  const banner = $('banner');
  if (client.status === STATUS.FATAL) {
    banner.className = 'banner banner-fatal';
    banner.textContent = client.statusDetail;
  } else if (client.status === STATUS.GAP) {
    banner.className = 'banner banner-warn';
    banner.textContent = client.statusDetail;
  } else if (client.status === STATUS.STALE || client.status === STATUS.MISMATCH) {
    banner.className = 'banner banner-stale';
    banner.textContent = client.statusDetail;
  } else if (client.banner) {
    banner.className = 'banner banner-info';
    banner.textContent = client.banner;
  } else {
    banner.className = 'banner hidden';
    banner.textContent = '';
  }

  $('totals').innerHTML = client.channels
    .map((ch) => {
      const v = client.totals[ch] ?? 0;
      return `<div class="ch-card"><span class="ch-name">${escapeHtml(ch)}</span><span class="ch-val">${
        Number.isFinite(v) ? v.toFixed(2) : '0.00'
      }</span></div>`;
    })
    .join('');

  drawChart($('chart'), client.channels, client.frames);
}
