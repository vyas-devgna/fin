/* charts.js — every chart in the app, drawn by hand in SVG.
 *
 * No chart library. Recharts/Chart.js would be ~200 KB to draw six shapes, and
 * none of them would inherit the app's type, spacing or easing without a fight.
 * These are ~250 lines, ship offline, and animate with the same curves as
 * everything else on screen.
 *
 * Each function returns an SVG string. Interactive charts get a hydrate* pass
 * afterwards to bind pointer handlers.
 */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Catmull-Rom → cubic Bézier. Straight polylines look like a spreadsheet;
 * a gently smoothed curve reads as "trend" at a glance, which is the point. */
function smoothPath(pts, tension = 0.4) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension * 2;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension * 2;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension * 2;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension * 2;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

/* ── Area / line chart ────────────────────────────────────────────────────── */

export function areaChart(values, { w = 340, h = 132, pad = 10, id = 'a', color = 'var(--tint)', fill = true } = {}) {
  if (!values.length) return '';
  const min = Math.min(...values), max = Math.max(...values);
  // A flat series should sit in the middle, not collapse onto an edge.
  const span = max - min || Math.abs(max) || 1;
  const lo = max === min ? min - span / 2 : min;
  const range = max === min ? span : max - min;
  const iw = w - pad * 2, ih = h - pad * 2;
  const x = (i) => pad + (values.length === 1 ? iw / 2 : (i / (values.length - 1)) * iw);
  const y = (v) => pad + ih - ((v - lo) / range) * ih;
  const pts = values.map((v, i) => [x(i), y(v)]);
  const line = smoothPath(pts);
  const area = `${line} L${x(values.length - 1)},${h} L${x(0)},${h} Z`;
  const zeroY = lo <= 0 && lo + range >= 0 ? y(0) : null;

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="g-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".28"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${zeroY !== null ? `<line class="chart-zero" x1="0" x2="${w}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}"/>` : ''}
    ${fill ? `<path class="chart-area" d="${area}" fill="url(#g-${id})"/>` : ''}
    <path class="chart-line" d="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle class="chart-dot" cx="${x(values.length - 1)}" cy="${y(values[values.length - 1])}" r="4" fill="${color}"/>
    <g class="chart-cursor" opacity="0">
      <line class="chart-cursor-line" y1="0" y2="${h}"/>
      <circle class="chart-cursor-dot" r="5.5" fill="${color}"/>
    </g>
  </svg>`;
}

/** Binds drag-to-scrub. `onScrub(index|null)` fires as the finger moves. */
export function hydrateArea(svg, count, onScrub) {
  if (!svg || count < 2) return;
  const cursor = svg.querySelector('.chart-cursor');
  const cline = svg.querySelector('.chart-cursor-line');
  const cdot = svg.querySelector('.chart-cursor-dot');
  const line = svg.querySelector('.chart-line');
  const vb = svg.viewBox.baseVal;
  const pad = 10;

  const at = (clientX) => {
    const r = svg.getBoundingClientRect();
    const rel = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(rel * (count - 1));
  };
  const show = (i) => {
    const len = line.getTotalLength();
    // Walk the rendered path to find the exact on-curve point for this index —
    // cheaper and more accurate than re-deriving the Bézier maths here.
    const p = line.getPointAtLength((i / (count - 1)) * len);
    const x = pad + (i / (count - 1)) * (vb.width - pad * 2);
    cline.setAttribute('x1', x); cline.setAttribute('x2', x);
    cdot.setAttribute('cx', x); cdot.setAttribute('cy', p.y);
    cursor.setAttribute('opacity', '1');
    onScrub(i);
  };
  const hide = () => { cursor.setAttribute('opacity', '0'); onScrub(null); };

  let active = false;
  svg.style.touchAction = 'pan-y';
  svg.addEventListener('pointerdown', (e) => { active = true; svg.setPointerCapture(e.pointerId); show(at(e.clientX)); });
  svg.addEventListener('pointermove', (e) => { if (active) show(at(e.clientX)); });
  svg.addEventListener('pointerup', () => { active = false; hide(); });
  svg.addEventListener('pointercancel', () => { active = false; hide(); });
}

/* ── Paired bars: income against spending ────────────────────────────────── */

export function pairedBars(a, b, labels, { w = 340, h = 150, gap = 4 } = {}) {
  const max = Math.max(...a, ...b, 1);
  const n = labels.length;
  const slot = w / n;
  const bw = Math.min(13, (slot - gap * 2) / 2);
  const ih = h - 22;
  let out = '';
  for (let i = 0; i < n; i++) {
    const cx = slot * i + slot / 2;
    const ha = Math.max(2, (a[i] / max) * ih), hb = Math.max(2, (b[i] / max) * ih);
    out += `<rect class="bar bar-in"  x="${(cx - bw - gap / 2).toFixed(1)}" y="${(ih - ha).toFixed(1)}" width="${bw}" height="${ha.toFixed(1)}" rx="${(bw / 2).toFixed(1)}" style="--d:${i * 40}ms"/>
            <rect class="bar bar-out" x="${(cx + gap / 2).toFixed(1)}" y="${(ih - hb).toFixed(1)}" width="${bw}" height="${hb.toFixed(1)}" rx="${(bw / 2).toFixed(1)}" style="--d:${i * 40 + 20}ms"/>
            <text class="bar-label" x="${cx.toFixed(1)}" y="${h - 4}" text-anchor="middle">${esc(labels[i])}</text>`;
  }
  return `<svg class="chart chart-bars" viewBox="0 0 ${w} ${h}" aria-hidden="true">${out}</svg>`;
}

/* ── Progress ring ────────────────────────────────────────────────────────── */

export function ring(pct, { size = 56, stroke = 6, color = 'var(--tint)', track = 'var(--ring-track)', label = '' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, pct));
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px" role="img" aria-label="${esc(label || Math.round(clamped * 100) + '%')}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
    <circle class="ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}"
      stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - clamped)).toFixed(2)}"
      transform="rotate(-90 ${size / 2} ${size / 2})"/>
    ${pct > 1 ? `<circle class="ring-over" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--red)" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - Math.min(1, pct - 1))).toFixed(2)}"
      transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ''}
  </svg>`;
}

/* ── Donut: where money currently sits ───────────────────────────────────── */

export function donut(slices, { size = 148, stroke = 20 } = {}) {
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  if (total <= 0) {
    return `<svg class="donut" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--ring-track)" stroke-width="${stroke}"/></svg>`;
  }
  let offset = 0, out = '';
  slices.forEach((s, i) => {
    const v = Math.max(0, s.value);
    if (!v) return;
    const frac = v / total;
    const len = frac * c;
    // A 2px gap between segments reads as separation without a stroke border.
    const gap = slices.length > 1 ? Math.min(2.5, len * 0.4) : 0;
    out += `<circle class="donut-seg" data-i="${i}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
      stroke="${s.color}" stroke-width="${stroke}" stroke-linecap="butt"
      stroke-dasharray="${Math.max(0.1, len - gap).toFixed(2)} ${(c - len + gap).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 ${size / 2} ${size / 2})" style="--d:${i * 60}ms"/>`;
    offset += len;
  });
  return `<svg class="donut" viewBox="0 0 ${size} ${size}" aria-hidden="true">${out}</svg>`;
}

/* ── Stacked bar: the same data, but legible at 8px tall ─────────────────── */

export function stackBar(slices) {
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;
  return `<div class="stackbar">${slices
    .filter((s) => s.value > 0)
    .map((s, i) => `<i style="--w:${((s.value / total) * 100).toFixed(2)}%;--c:${s.color};--d:${i * 50}ms" title="${esc(s.label)}"></i>`)
    .join('')}</div>`;
}

/* ── Sparkline: trend in a table row ─────────────────────────────────────── */

export function sparkline(values, { w = 64, h = 22, color = 'currentColor' } = {}) {
  if (values.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}"></svg>`;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / range) * (h - 4)]);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${smoothPath(pts)}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
