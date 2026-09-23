// chart.js — Canvas 折线图：各通道累计值 vs 连续序号
const COLORS = ['#4f9cff', '#ff7a59', '#37c98b', '#f5c542', '#b58cff', '#ff66a3', '#5fd3e0'];

export function drawChart(canvas, channels, frames) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 56, padR = 16, padT = 28, padB = 36;
  const w = cssW - padL - padR;
  const h = cssH - padT - padB;

  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--panel') || '#121826';
  ctx.fillRect(0, 0, cssW, cssH);

  if (!frames.length || !channels.length) {
    ctx.fillStyle = '#8a93a8';
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无帧数据', cssW / 2, cssH / 2);
    return;
  }

  const seqs = frames.map((f) => f.seq);
  let minX = Math.min(...seqs);
  let maxX = Math.max(...seqs);
  if (minX === maxX) { minX -= 1; maxX += 1; }
  let minY = 0;
  let maxY = -Infinity;
  for (const f of frames) for (const c of channels) maxY = Math.max(maxY, f.totals[c] ?? 0);
  if (!isFinite(maxY)) maxY = 1;
  if (minY === maxY) maxY = minY + 1;
  const padY = (maxY - minY) * 0.08;
  maxY += padY;

  const x = (seq) => padL + ((seq - minX) / (maxX - minX)) * w;
  const y = (v) => padT + h - ((v - minY) / (maxY - minY)) * h;

  // 网格与坐标
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.fillStyle = '#8a93a8';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = minY + ((maxY - minY) * i) / 4;
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + w, yy); ctx.stroke();
    ctx.fillText(v.toFixed(1), padL - 8, yy + 4);
  }
  ctx.textAlign = 'center';
  const xStep = Math.max(1, Math.ceil((maxX - minX) / 10));
  for (let s = minX; s <= maxX; s += xStep) {
    ctx.fillText(String(s), x(s), padT + h + 18);
  }
  ctx.fillText('序号 →', padL + w / 2, cssH - 8);

  // 每通道折线（累计值）
  channels.forEach((ch, idx) => {
    const color = COLORS[idx % COLORS.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (const f of frames) {
      const v = f.totals[ch];
      if (v === undefined) continue;
      const px = x(f.seq);
      const py = y(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
    for (const f of frames) {
      const v = f.totals[ch];
      if (v === undefined) continue;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x(f.seq), y(v), 2.5, 0, Math.PI * 2); ctx.fill();
    }
  });

  // 图例
  ctx.textAlign = 'left';
  ctx.font = '12px system-ui, sans-serif';
  let lx = padL;
  channels.forEach((ch, idx) => {
    const color = COLORS[idx % COLORS.length];
    ctx.fillStyle = color;
    ctx.fillRect(lx, 8, 12, 4);
    ctx.fillText(ch, lx + 16, 14);
    lx += 16 + ctx.measureText(ch).width + 20;
  });
}
