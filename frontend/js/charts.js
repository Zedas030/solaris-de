// Selbst gezeichnete SVG-Diagramme (keine externen Bibliotheken).
// Datenlücken werden nie interpoliert: Linien brechen ab und Lücken werden schraffiert dargestellt.
import { h, clear, showTip, hideTip } from './ui.js';
import * as F from './format.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v); return e; };

function niceStep(range, count) {
  const raw = range / Math.max(count, 1);
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}
function yTicks(min, max, count = 5) {
  if (min === max) { max = min + 1; }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const t = [];
  for (let v = lo; v <= hi + step / 2; v += step) t.push(+v.toFixed(10));
  return { lo, hi, ticks: t };
}
const TIME_STEPS = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800];
function xTicks(start, end, px) {
  const want = Math.max(2, Math.floor(px / 90));
  const step = TIME_STEPS.find((st) => (end - start) / st <= want) || 604800;
  const out = [];
  // an lokaler Zeit ausrichten (über Offset der Zeitzone)
  const off = -new Date(start * 1000).getTimezoneOffset() * 60;
  let t = Math.ceil((start + off) / step) * step - off;
  for (; t <= end; t += step) out.push(t);
  return { ticks: out, step };
}
const tickLabel = (t, step) => (step >= 86400 ? F.dateShort(t) : F.time(t));

function unitScale(series, kind) {
  if (kind !== 'power') return { div: 1, unit: series[0]?.unit || '' };
  let m = 0;
  for (const se of series) for (const p of se.points) if (F.isNum(p[1])) m = Math.max(m, Math.abs(p[1]));
  const kw = F.state.display.power_unit === 'kW' || (F.state.display.power_unit === 'auto' && m >= F.state.display.kw_threshold_w);
  return kw ? { div: 1000, unit: 'kW' } : { div: 1, unit: 'W' };
}

function storedHidden(key) { try { return new Set(JSON.parse(localStorage.getItem(`solaris_hide_${key}`) || '[]')); } catch { return new Set(); } }
function storeHidden(key, set) { try { localStorage.setItem(`solaris_hide_${key}`, JSON.stringify([...set])); } catch { /* ignorieren */ } }

/**
 * Liniendiagramm.
 * opts = { key, series:[{id,name,color,points:[[ts,v],...],dash,area}], start, end, gap, height, kind:'power'|'percent'|..., unit }
 */
export function lineChart(opts) {
  const key = opts.key || 'chart';
  const hidden = storedHidden(key);
  const wrap = h('div.chart-block');
  const legend = h('div.legend', { role: 'group', 'aria-label': 'Datenreihen ein-/ausblenden' });
  const box = h('div.chart', { role: 'img', 'aria-label': opts.label || 'Liniendiagramm' });
  const caption = h('div.xs.faint', { style: { marginTop: '6px' } });
  for (const se of opts.series) {
    const b = h('button', { type: 'button', 'aria-pressed': String(!hidden.has(se.id)), style: { '--c': se.color } }, h('span.sw'), se.name);
    b.addEventListener('click', () => {
      hidden.has(se.id) ? hidden.delete(se.id) : hidden.add(se.id);
      b.setAttribute('aria-pressed', String(!hidden.has(se.id)));
      storeHidden(key, hidden); draw();
    });
    legend.append(b);
  }
  if (opts.series.length > 1 && !opts.noLegend) wrap.append(legend);
  wrap.append(box, caption);

  function draw() {
    const W = Math.max(box.clientWidth || 600, 280);
    const H = opts.height || 260;
    const m = { l: 52, r: 14, t: 24, b: 28 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const vis = opts.series.filter((se) => !hidden.has(se.id));
    const { div, unit } = unitScale(vis.length ? vis : opts.series, opts.kind);
    let lo = opts.yMin ?? Infinity, hi = opts.yMax ?? -Infinity;
    for (const se of vis) for (const [, v] of se.points) if (F.isNum(v)) { lo = Math.min(lo, v / div); hi = Math.max(hi, v / div); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (opts.kind === 'power' || opts.zero !== false) lo = Math.min(lo, 0);
    const yt = yTicks(lo, hi === lo ? lo + 1 : hi);
    const x = (t) => m.l + ((t - opts.start) / (opts.end - opts.start)) * iw;
    const y = (v) => m.t + ih - ((v - yt.lo) / (yt.hi - yt.lo)) * ih;

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    const defs = s('defs');
    const pat = s('pattern', { id: `gapHatch-${key}`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(s('rect', { width: 6, height: 6, fill: 'rgba(148,163,184,0.04)' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'rgba(148,163,184,0.18)', 'stroke-width': 2 }));
    defs.append(pat); svg.append(defs);
    const axis = s('g', { class: 'axis' });
    for (const v of yt.ticks) {
      axis.append(s('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
      const tx = s('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }); tx.textContent = F.fmtNumber(v, Math.abs(yt.hi - yt.lo) < 5 ? 1 : 0); axis.append(tx);
    }
    const ut = s('text', { x: m.l - 8, y: m.t - 12, 'text-anchor': 'end' }); ut.textContent = unit; axis.append(ut);
    const xt = xTicks(opts.start, opts.end, iw);
    for (const t of xt.ticks) {
      const tx = s('text', { x: x(t), y: H - 8, 'text-anchor': 'middle' }); tx.textContent = tickLabel(t, xt.step); axis.append(tx);
    }
    if (yt.lo < 0 && yt.hi > 0) axis.append(s('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: 'rgba(148,163,184,.35)' }));
    svg.append(axis);

    // Lücken (wo keine sichtbare Reihe Daten hat)
    const ts = [...new Set(vis.flatMap((se) => se.points.filter((p) => F.isNum(p[1])).map((p) => p[0])))].sort((a, b) => a - b);
    const gaps = [];
    const now = Date.now() / 1000;
    if (vis.length) {
      let prev = opts.start;
      for (const t of ts) { if (t - prev > opts.gap) gaps.push([prev, t]); prev = t; }
      const tail = Math.min(opts.end, now);
      if (tail - prev > opts.gap) gaps.push([prev, tail]);
    }
    for (const [a, b] of gaps) svg.append(s('rect', { x: x(Math.max(a, opts.start)), y: m.t, width: Math.max(1, x(b) - x(Math.max(a, opts.start))), height: ih, fill: `url(#gapHatch-${key})` }));

    for (const se of vis) {
      let d = '', area = '', run = [];
      const flush = () => {
        if (run.length) {
          d += run.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1] / div).toFixed(1)}`).join('');
          if (se.area && run.length > 1) area += `M${x(run[0][0]).toFixed(1)},${y(Math.max(yt.lo, 0)).toFixed(1)}` + run.map((p) => `L${x(p[0]).toFixed(1)},${y(p[1] / div).toFixed(1)}`).join('') + `L${x(run[run.length - 1][0]).toFixed(1)},${y(Math.max(yt.lo, 0)).toFixed(1)}Z`;
        }
        run = [];
      };
      let last = null;
      for (const p of se.points) {
        if (!F.isNum(p[1])) { flush(); last = null; continue; }
        if (last !== null && p[0] - last > opts.gap) flush();
        run.push(p); last = p[0];
      }
      flush();
      if (area) svg.append(s('path', { d: area, fill: se.color, opacity: 0.1 }));
      svg.append(s('path', { d, fill: 'none', stroke: se.color, 'stroke-width': se.width || 2, 'stroke-dasharray': se.dash || null, 'stroke-linejoin': 'round' }));
      const singles = [];
      se.points.forEach((p, i) => {
        const pr = se.points[i - 1], nx = se.points[i + 1];
        if (F.isNum(p[1]) && (!pr || p[0] - pr[0] > opts.gap) && (!nx || nx[0] - p[0] > opts.gap)) singles.push(p);
      });
      for (const p of singles) svg.append(s('circle', { cx: x(p[0]), cy: y(p[1] / div), r: 2.5, fill: se.color }));
    }

    const cross = s('line', { y1: m.t, y2: m.t + ih, stroke: 'rgba(248,250,252,.35)', 'stroke-dasharray': '3 3', visibility: 'hidden' });
    const dots = s('g');
    svg.append(cross, dots);
    const overlay = s('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
    svg.append(overlay);
    const move = (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const t = opts.start + ((px - m.l) / iw) * (opts.end - opts.start);
      while (dots.firstChild) dots.firstChild.remove();
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      const rows = [];
      for (const se of vis) {
        let best = null;
        for (const p of se.points) if (F.isNum(p[1]) && (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p;
        const ok = best && Math.abs(best[0] - t) <= Math.max(opts.gap / 2, (opts.end - opts.start) / iw * 6);
        if (ok) dots.append(s('circle', { cx: x(best[0]), cy: y(best[1] / div), r: 4, fill: se.color, stroke: '#0B1220', 'stroke-width': 2 }));
        rows.push(h('div.row', h('span', h('i.sw', { style: { '--c': se.color } }), se.name),
          h('b', ok ? (opts.kind === 'power' ? F.powerStr(best[1]) : F.valueStr(best[1], se.unit || opts.unit)) : 'keine Daten')));
      }
      showTip(e.clientX, e.clientY, h('div', h('div.t', `${F.date(t)} ${F.timeSec(t)}`), rows));
    };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerdown', move);
    overlay.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); while (dots.firstChild) dots.firstChild.remove(); hideTip(); });
    clear(box).append(svg);
    caption.textContent = gaps.length ? `Schraffierte Bereiche: keine Messdaten (Datenlücke, nicht interpoliert).${opts.caption ? ' ' + opts.caption : ''}` : (opts.caption || '');
  }
  const ro = new ResizeObserver(() => draw());
  ro.observe(box);
  requestAnimationFrame(draw);
  wrap.redraw = draw;
  return wrap;
}

/**
 * Gruppiertes Balkendiagramm.
 * opts = { key, categories:[{label, ts}], series:[{id,name,color,values:[number|null]}], unit, height, fmt }
 */
export function barChart(opts) {
  const key = opts.key || 'bars';
  const hidden = storedHidden(key);
  const wrap = h('div.chart-block');
  const legend = h('div.legend', { role: 'group', 'aria-label': 'Datenreihen ein-/ausblenden' });
  const box = h('div.chart', { role: 'img', 'aria-label': opts.label || 'Balkendiagramm' });
  for (const se of opts.series) {
    const b = h('button', { type: 'button', 'aria-pressed': String(!hidden.has(se.id)), style: { '--c': se.color } }, h('span.sw'), se.name);
    b.addEventListener('click', () => { hidden.has(se.id) ? hidden.delete(se.id) : hidden.add(se.id); b.setAttribute('aria-pressed', String(!hidden.has(se.id))); storeHidden(key, hidden); draw(); });
    legend.append(b);
  }
  if (opts.series.length > 1) wrap.append(legend);
  const scroller = h('div.chart-scroll', box);
  wrap.append(scroller);
  const fmt = opts.fmt || ((v) => (v === null || v === undefined ? 'keine Daten' : `${F.fmtNumber(v, 2)} ${opts.unit}`));

  function draw() {
    const vis = opts.series.filter((se) => !hidden.has(se.id));
    const n = opts.categories.length;
    const W = Math.max(box.clientWidth || 600, Math.min(n * Math.max(vis.length, 1) * 7 + 70, 2400), 280);
    const H = opts.height || 260;
    const m = { l: 48, r: 10, t: 24, b: 30 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    let hi = 0, lo = 0;
    for (const se of vis) for (const v of se.values) if (F.isNum(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
    const yt = yTicks(lo, hi || 1, 4);
    const y = (v) => m.t + ih - ((v - yt.lo) / (yt.hi - yt.lo)) * ih;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    const axis = s('g', { class: 'axis' });
    for (const v of yt.ticks) {
      axis.append(s('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
      const tx = s('text', { x: m.l - 7, y: y(v) + 4, 'text-anchor': 'end' }); tx.textContent = F.fmtNumber(v, hi < 5 ? 1 : 0); axis.append(tx);
    }
    const ut = s('text', { x: m.l - 7, y: m.t - 12, 'text-anchor': 'end' }); ut.textContent = opts.unit; axis.append(ut);
    svg.append(axis);
    const cw = iw / Math.max(n, 1);
    const bw = Math.max(2, Math.min(28, (cw * 0.78) / Math.max(vis.length, 1)));
    const every = Math.ceil(n / Math.max(1, Math.floor(iw / 54)));
    opts.categories.forEach((c, i) => {
      const gx = m.l + i * cw + (cw - bw * vis.length) / 2;
      const g = s('g');
      vis.forEach((se, j) => {
        const v = se.values[i];
        if (F.isNum(v)) {
          const y0 = y(Math.max(0, Math.min(v, 0))), y1 = y(Math.max(v, 0));
          g.append(s('rect', { x: gx + j * bw, y: Math.min(y0, y1), width: bw - 1, height: Math.max(1, Math.abs(y0 - y1)), rx: 2, fill: se.color, opacity: se.partial?.[i] ? 0.6 : 0.95 }));
        } else {
          g.append(s('rect', { x: gx + j * bw, y: y(0) - 3, width: bw - 1, height: 3, fill: 'rgba(148,163,184,.25)' }));
        }
      });
      const hit = s('rect', { x: m.l + i * cw, y: m.t, width: cw, height: ih, fill: 'transparent' });
      const show = (e) => showTip(e.clientX, e.clientY, h('div', h('div.t', c.tip || c.label),
        vis.map((se) => h('div.row', h('span', h('i.sw', { style: { '--c': se.color } }), se.name), h('b', fmt(se.values[i], se)))),
        c.note ? h('div.xs.faint', { style: { marginTop: '4px' } }, c.note) : null));
      hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', hideTip);
      g.append(hit);
      svg.append(g);
      if (i % every === 0) { const tx = s('text', { x: m.l + i * cw + cw / 2, y: H - 9, 'text-anchor': 'middle', class: '' }); tx.textContent = c.label; tx.setAttribute('fill', '#64748B'); tx.setAttribute('font-size', '11'); svg.append(tx); }
    });
    clear(box).append(svg);
    box.style.minWidth = `${W}px`;
  }
  const ro = new ResizeObserver(() => { box.style.minWidth = ''; draw(); });
  ro.observe(scroller);
  requestAnimationFrame(draw);
  return wrap;
}

/** Kleine Trendlinie für Kennzahlenkarten. */
export function sparkline(points, color, gap = 600) {
  const valid = points.filter((p) => F.isNum(p[1]));
  if (valid.length < 2) return h('div.spark.xs.faint', valid.length ? '' : 'Kein Verlauf verfügbar');
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  let lo = Math.min(0, ...valid.map((p) => p[1])), hi = Math.max(...valid.map((p) => p[1]));
  if (hi === lo) hi = lo + 1;
  const W = 200, H = 34;
  const x = (t) => ((t - t0) / Math.max(t1 - t0, 1)) * W;
  const y = (v) => H - 2 - ((v - lo) / (hi - lo)) * (H - 4);
  let d = '', last = null;
  for (const p of points) {
    if (!F.isNum(p[1])) { last = null; continue; }
    d += `${last === null || p[0] - last > gap ? 'M' : 'L'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`;
    last = p[0];
  }
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'spark', width: '100%', height: H, 'aria-hidden': 'true' });
  svg.append(s('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke', opacity: 0.9 }));
  return svg;
}

/** Ringdiagramm (z. B. Ladezustand). */
export function ring(pct, color, size = 150, label = '', sub = '') {
  const r = 52, c = 2 * Math.PI * r;
  const svg = s('svg', { viewBox: '0 0 128 128', width: size, height: size, role: 'img', 'aria-label': `${label} ${F.isNum(pct) ? Math.round(pct) + ' %' : 'keine Daten'}` });
  svg.append(s('circle', { cx: 64, cy: 64, r, fill: 'none', stroke: 'rgba(148,163,184,.15)', 'stroke-width': 11 }));
  if (F.isNum(pct)) {
    svg.append(s('circle', { cx: 64, cy: 64, r, fill: 'none', stroke: color, 'stroke-width': 11, 'stroke-linecap': 'round',
      'stroke-dasharray': `${(Math.max(0, Math.min(100, pct)) / 100) * c} ${c}`, transform: 'rotate(-90 64 64)' }));
  }
  const t = s('text', { x: 64, y: sub ? 66 : 72, 'text-anchor': 'middle', fill: '#F8FAFC', 'font-size': F.isNum(pct) ? 28 : 16, 'font-weight': 700 });
  t.textContent = F.isNum(pct) ? `${Math.round(pct)} %` : 'keine Daten';
  svg.append(t);
  if (sub) { const st = s('text', { x: 64, y: 86, 'text-anchor': 'middle', fill: '#94A3B8', 'font-size': 11 }); st.textContent = sub; svg.append(st); }
  return svg;
}

/** Batteriegrafik mit 10 Segmenten. */
export function batteryGraphic(pct, color, { width = 260 } = {}) {
  const svg = s('svg', { viewBox: '0 0 260 120', width, role: 'img', 'aria-label': F.isNum(pct) ? `Ladezustand ${Math.round(pct)} %` : 'Ladezustand unbekannt', style: 'max-width:100%' });
  svg.append(s('rect', { x: 4, y: 10, width: 232, height: 100, rx: 14, fill: '#0f1a2b', stroke: '#33465e', 'stroke-width': 3 }));
  svg.append(s('rect', { x: 238, y: 42, width: 14, height: 36, rx: 4, fill: '#33465e' }));
  const segs = 10;
  for (let i = 0; i < segs; i++) {
    const filled = F.isNum(pct) && pct >= (i + 0.5) * (100 / segs);
    svg.append(s('rect', { x: 14 + i * 22, y: 20, width: 18, height: 80, rx: 4, fill: filled ? color : 'rgba(148,163,184,.10)' }));
  }
  if (!F.isNum(pct)) { const t = s('text', { x: 120, y: 66, 'text-anchor': 'middle', fill: '#94A3B8', 'font-size': 16 }); t.textContent = 'Keine Daten'; svg.append(t); }
  return svg;
}
