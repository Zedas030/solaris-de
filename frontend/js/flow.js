// Interaktive Energieflussgrafik. Jede Linie entspricht einer Messgröße (oder einer vollständigen
// Knotenbilanz, dann „berechnet“). Unbekannte Richtungen werden nicht geraten.
import { h, iconSvg } from './ui.js';
import * as F from './format.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, a = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) if (v !== null && v !== undefined) e.setAttribute(k, v); return e; };

const R = 60;
const NODES = {
  pv: { x: 140, y: 100, label: 'PV-Anlage', icon: 'panel', color: 'var(--pv)', href: '#/pv' },
  grid: { x: 520, y: 100, label: 'Stromnetz', icon: 'grid', color: 'var(--import)', href: '#/grid' },
  inverter: { x: 140, y: 300, label: 'Wechselrichter', icon: 'inverter', color: 'var(--inverter)', href: '#/inverter' },
  house: { x: 520, y: 300, label: 'Haus', icon: 'house', color: 'var(--house)', href: '#/consumption' },
  battery: { x: 140, y: 500, label: 'Speicher', icon: 'battery', color: 'var(--battery)', href: '#/battery' },
};
const EDGES = {
  pv_inverter: { from: 'pv', to: 'inverter', color: 'var(--pv)', label: 'PV-Leistung' },
  inverter_battery: { from: 'inverter', to: 'battery', color: 'var(--battery)', label: 'Batterie', fwd: 'Laden', rev: 'Entladen' },
  inverter_house: { from: 'inverter', to: 'house', color: 'var(--inverter)', label: 'AC-Ausgang' },
  grid_house: { from: 'grid', to: 'house', color: 'var(--import)', revColor: 'var(--export)', label: 'Netz', fwd: 'Bezug', rev: 'Einspeisung' },
};
const STATUS_TEXT = { measured: 'gemessen', calculated: 'berechnet', unknown: 'keine Daten', not_configured: 'nicht konfiguriert', partial: 'Teilmessung' };

function geom(e) {
  const a = NODES[e.from], b = NODES[e.to];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  return { x1: a.x + ux * (R + 6), y1: a.y + uy * (R + 6), x2: b.x - ux * (R + 6), y2: b.y - uy * (R + 6) };
}

export function energyFlow(onNavigate) {
  const svg = s('svg', { viewBox: '0 0 660 600', role: 'group', 'aria-label': 'Energiefluss' });
  const desc = h('p.sr-only', { 'aria-live': 'polite' });
  const wrap = h('div.flow-wrap', h('div.flow', svg), desc);
  const els = {};

  for (const [id, e] of Object.entries(EDGES)) {
    const g = geom(e);
    const d = `M${g.x1},${g.y1} L${g.x2},${g.y2}`;
    const base = s('path', { d, class: 'line-base' });
    const flow = s('path', { d, class: 'line-flow idle', stroke: e.color });
    const mx = (g.x1 + g.x2) / 2, my = (g.y1 + g.y2) / 2;
    const vertical = Math.abs(g.x1 - g.x2) < 1;
    const lx = vertical ? (mx > 330 ? mx - 74 : mx + 74) : mx, ly = vertical ? my : my - 34;
    const lab = s('g', { class: 'edge-label' });
    const rect = s('rect', { x: lx - 64, y: ly - 22, width: 128, height: 44, rx: 9 });
    const t1 = s('text', { x: lx, y: ly - 2 });
    const t2 = s('text', { x: lx, y: ly + 14, class: 'st' });
    lab.append(rect, t1, t2);
    const arrow = s('path', { d: '', fill: e.color, opacity: 0 });
    svg.append(base, flow, arrow, lab);
    els[id] = { base, flow, t1, t2, arrow, g };
  }
  for (const [id, n] of Object.entries(NODES)) {
    const g = s('g', { class: 'node', tabindex: 0, role: 'link', 'aria-label': `${n.label} – Details öffnen` });
    const bg = s('circle', { cx: n.x, cy: n.y, r: R, class: 'node-bg', stroke: n.color });
    const ringBg = s('circle', { cx: n.x, cy: n.y, r: R + 9, fill: 'none', stroke: 'transparent', 'stroke-width': 5 });
    const ring = s('circle', { cx: n.x, cy: n.y, r: R + 9, fill: 'none', stroke: 'transparent', 'stroke-width': 5, 'stroke-linecap': 'round', transform: `rotate(-90 ${n.x} ${n.y})` });
    const ic = s('g', { transform: `translate(${n.x - 13} ${n.y - 44}) scale(1.1)`, fill: 'none', stroke: n.color, 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    ic.innerHTML = iconSvg(n.icon);
    const label = s('text', { x: n.x, y: n.y + R + 26, class: 'node-label' }); label.textContent = n.label;
    const value = s('text', { x: n.x, y: n.y + 9, class: 'node-value' });
    const sub = s('text', { x: n.x, y: n.y + 30, class: 'node-sub' });
    g.append(ringBg, ring, bg, ic, value, sub, label);
    const go = () => (onNavigate ? onNavigate(n.href) : (location.hash = n.href));
    g.addEventListener('click', go);
    g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
    svg.append(g);
    els[id] = { value, sub, ring, ringBg };
  }

  function update(ov) {
    const flows = ov?.flows;
    if (!flows) return;
    const texts = [];
    for (const e of flows.edges) {
      const cfg = EDGES[e.id], el = els[e.id];
      if (!cfg || !el) continue;
      const active = e.value_w !== null && e.direction;
      const rev = e.direction === 'b->a';
      const color = rev && cfg.revColor ? cfg.revColor : cfg.color;
      el.flow.setAttribute('stroke', color);
      el.flow.setAttribute('class', `line-flow${active ? '' : ' idle'}${rev ? ' rev' : ''}`);
      el.flow.style.setProperty('--dur', `${Math.max(0.5, Math.min(2.6, 2.8 - Math.log10(Math.max(e.value_w || 1, 1)) * 0.6))}s`);
      el.base.setAttribute('class', `line-base${e.status === 'unknown' || e.status === 'not_configured' ? ' unknown' : ''}`);
      el.flow.setAttribute('stroke-opacity', e.uncertain ? '0.5' : '1');
      // Richtungspfeil (auch ohne Animation sichtbar)
      const { x1, y1, x2, y2 } = el.g;
      if (active) {
        const [sx, sy, tx, ty] = rev ? [x2, y2, x1, y1] : [x1, y1, x2, y2];
        const len = Math.hypot(tx - sx, ty - sy), ux = (tx - sx) / len, uy = (ty - sy) / len;
        const px = sx + ux * len * 0.78, py = sy + uy * len * 0.78;
        const a = 9;
        el.arrow.setAttribute('d', `M${px + ux * a},${py + uy * a} L${px - uy * a * 0.8 - ux * a * 0.6},${py + ux * a * 0.8 - uy * a * 0.6} L${px + uy * a * 0.8 - ux * a * 0.6},${py - ux * a * 0.8 - uy * a * 0.6}Z`);
        el.arrow.setAttribute('fill', color); el.arrow.setAttribute('opacity', e.uncertain ? 0.5 : 1);
      } else el.arrow.setAttribute('opacity', 0);
      let main = '–';
      if (e.value_w !== null && e.value_w !== undefined) main = F.powerStr(e.value_w);
      const dirText = active && cfg.fwd ? (rev ? cfg.rev : cfg.fwd) : '';
      el.t1.textContent = e.status === 'not_configured' ? 'nicht konfiguriert' : main;
      el.t1.setAttribute('fill', e.status === 'not_configured' || e.value_w === null ? '#64748B' : color);
      el.t2.textContent = [dirText, e.status !== 'measured' && e.status !== 'not_configured' ? STATUS_TEXT[e.status] : '', e.uncertain ? 'unsicher' : ''].filter(Boolean).join(' · ') || cfg.label;
      el.t2.parentNode.querySelector('rect').setAttribute('stroke', e.uncertain ? 'var(--warn)' : 'var(--border)');
      const title = el.t2.parentNode.querySelector('title') || el.t2.parentNode.appendChild(s('title'));
      title.textContent = `${cfg.label}: ${el.t1.textContent}${dirText ? ' (' + dirText + ')' : ''} – ${STATUS_TEXT[e.status] || e.status}${e.note ? '. ' + e.note : ''}`;
      texts.push(title.textContent);
    }
    const n = flows.nodes, k = ov.kpis;
    const set = (id, v, sub) => { els[id].value.textContent = v; els[id].sub.textContent = sub || ''; };
    set('pv', n.pv.configured ? F.powerStr(n.pv.value_w) : '–', n.pv.configured ? (n.pv.value_w === null ? 'keine Daten' : 'Erzeugung') : 'nicht konfiguriert');
    set('inverter', F.powerStr(n.inverter.value_w), n.inverter.value_w === null ? 'keine Daten' : 'AC-Ausgang');
    const bat = n.battery.value_w;
    set('battery', bat === null ? '–' : F.powerStr(Math.abs(bat)), !n.battery.configured ? 'nicht konfiguriert' : bat === null ? 'keine Daten' : bat > 1 ? 'lädt' : bat < -1 ? 'entlädt' : 'Ruhe');
    const hs = n.house.status === 'partial' ? 'Teilmessung' : n.house.status === 'calculated' ? 'berechnet' : n.house.value_w === null ? 'keine Daten' : 'Verbrauch';
    set('house', F.powerStr(n.house.value_w), hs);
    set('grid', n.grid.configured ? F.powerStr(n.grid.value_w === null ? null : Math.abs(n.grid.value_w)) : '–',
      !n.grid.configured ? 'kein Zähler' : n.grid.value_w === null ? 'keine Daten' : n.grid.value_w > 0 ? 'Bezug' : n.grid.value_w < 0 ? 'Einspeisung' : 'ausgeglichen');
    // SOC-Ring um den Speicher
    const soc = k?.battery_soc;
    const r = R + 9, c = 2 * Math.PI * r;
    if (soc && soc.status === 'good' && F.isNum(soc.value)) {
      const col = { high: 'var(--soc-high)', medium: 'var(--soc-mid)', low: 'var(--soc-low)', critical: 'var(--soc-crit)' }[ov.soc_level] || 'var(--battery)';
      els.battery.ring.setAttribute('stroke', col);
      els.battery.ring.setAttribute('stroke-dasharray', `${(soc.value / 100) * c} ${c}`);
      els.battery.ringBg.setAttribute('stroke', 'rgba(148,163,184,.15)');
      els.battery.sub.textContent = `${els.battery.sub.textContent} · ${Math.round(soc.value)} %`;
    } else {
      els.battery.ring.setAttribute('stroke', 'transparent');
    }
    desc.textContent = texts.join('. ');
  }
  return { el: wrap, update };
}
