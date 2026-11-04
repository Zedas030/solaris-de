// UI-Hilfen: DOM-Erzeugung, Icons, Tooltips, Toasts, Dialoge und API-Zugriff.
import * as F from './format.js';

/** Element erzeugen: h('div.card#id', {attrs}, ...children). Text wird immer escaped. */
export function h(tag, attrs, ...children) {
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9]+)?(.*)$/i);
  const svgTags = new Set(['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'text', 'defs', 'pattern', 'marker', 'tspan', 'linearGradient', 'stop', 'clipPath']);
  const el = svgTags.has(name) ? document.createElementNS('http://www.w3.org/2000/svg', name) : document.createElement(name);
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) {
    if (m[1] === '.') el.classList.add(m[2]); else el.id = m[2];
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) if (sv !== null && sv !== undefined) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    }
    else if (k === 'class') el.setAttribute('class', [el.getAttribute('class'), v].filter(Boolean).join(' '));
    else if (k === 'html') el.innerHTML = v; // nur für statische, vertrauenswürdige SVG-Icons
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
/** Leert ein Element; das Ergebnis bietet append(...) mit verschachtelten Arrays. */
export const clear = (el) => {
  while (el.firstChild) el.firstChild.remove();
  return { append: (...c) => { append(el, c); return el; }, el };
};

// ---------------------------------------------------------------- Icons
const P = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  panel: '<path d="M3 17l3-11h12l3 11z"/><path d="M4.6 11.5h14.8M9.5 6l-1.5 11M14.5 6l1.5 11M12 17v4M8 21h8"/>',
  house: '<path d="M3.5 11L12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
  battery: '<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10.5v3"/><path d="M6.5 10v4M9.5 10v4"/>',
  grid: '<path d="M12 2.5l-4 7h8z"/><path d="M8 9.5L5 21.5M16 9.5l3 12M6.6 15h10.8M5.8 18.5h12.4M12 2.5v19"/>',
  inverter: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 9c1-1.6 2-1.6 3 0s2 1.6 3 0"/><path d="M8 15.5h8"/>',
  chart: '<path d="M4 4v16h16"/><path d="M7 15l4-5 3 3 5-7"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>',
  devices: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  dashboard: '<rect x="3" y="3" width="7.5" height="9" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="5" rx="1.5"/><rect x="13.5" y="11" width="7.5" height="10" rx="1.5"/><rect x="3" y="15" width="7.5" height="6" rx="1.5"/>',
  bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
  warn: '<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.3"/>',
  down: '<path d="M12 4v13M6 11l6 6 6-6M5 20.5h14"/>',
  thermo: '<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 11v6"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrowL: '<path d="M15 5l-7 7 7 7"/>', arrowR: '<path d="M9 5l7 7-7 7"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
};
export function icon(name, cls = '') {
  return h('span', { class: `ic ${cls}`, 'aria-hidden': 'true', style: { display: 'inline-flex' },
    html: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>` });
}
export const iconSvg = (name) => P[name] || '';

// ---------------------------------------------------------------- Bausteine
export function card(title, opts = {}, ...body) {
  return h('section.card', { class: opts.cls, 'aria-label': typeof title === 'string' ? title : null },
    (title || opts.right) && h('div.card-h', title && h('h2', title), opts.info && infoI(opts.info), h('span.spacer'), opts.right),
    opts.sub && h('p.card-sub', opts.sub), body);
}
export const infoI = (text) => h('button.info-i', { type: 'button', 'data-tip': text, 'aria-label': text }, 'i');

export function pill(text, cls = '', tip) { return h('span.pill', { class: cls, 'data-tip': tip }, h('span.dot'), text); }
export const qualityPill = (q) => pill(F.qualityLabel(q), F.qualityClass(q));

export function notice(kind, ...content) {
  return h('div.notice', { class: kind, role: kind === 'err' ? 'alert' : null }, icon(kind === 'info' ? 'info' : 'warn'), h('div', content));
}

/** Kennzahlenkarte. value: [Zahl, Einheit] oder null; status steuert ehrliche Darstellung. */
export function kpi({ label, iconName, accent, value, unit, status, foot, tip, href, spark, naText }) {
  const known = value !== null && value !== undefined && value !== '–';
  const na = status === 'not_configured' ? 'Nicht konfiguriert' : (naText || 'Keine Daten verfügbar');
  const el = h('article.card.kpi', { style: { '--accent': accent }, class: href ? 'clickable' : '', tabindex: href ? 0 : null, role: href ? 'link' : null },
    h('div.kpi-label', iconName && icon(iconName), label, tip && infoI(tip)),
    known ? h('div.kpi-value', value, unit && h('span.unit', unit)) : h('div.kpi-value.na', na),
    spark || null,
    h('div.kpi-foot', foot));
  if (href) {
    el.addEventListener('click', (e) => { if (!e.target.closest('.info-i')) location.hash = href; });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = href; });
  }
  return el;
}

/** Kennzahl aus Overview-KPI-Objekt erzeugen. */
export function kpiFromRole(k, { label, iconName, accent, href, kind = 'power', spark, extraFoot } = {}) {
  if (!k) return kpi({ label, iconName, accent, value: null, status: 'not_configured' });
  const good = k.status === 'good' || k.status === 'simulated';
  let v = null, u = '';
  if (good && k.value !== null && k.value !== undefined) {
    if (kind === 'power') [v, u] = F.power(k.value);
    else if (kind === 'energy') [v, u] = F.energy(k.value);
    else if (kind === 'percent') [v, u] = [F.fmtNumber(k.value, 0), '%'];
    else if (kind === 'state') [v, u] = [String(k.value), ''];
    else [v, u] = [F.fmtNumber(k.value, 1), k.unit];
  }
  const foot = [];
  if (k.status !== 'not_configured') foot.push(F.QUALITY[k.status] && k.status !== 'good' ? qualityPill(k.status) : null);
  if (k.partial) foot.push(pill('Teilmessung', 'warn', 'Erfasst nur einen Teil (Summe einzelner Messstellen)'));
  if (k.estimated) foot.push(pill('Schätzwert', 'info'));
  if (k.timestamp) foot.push(h('span', F.ago(k.timestamp)));
  if (extraFoot) foot.push(extraFoot);
  return kpi({ label: label || k.label, iconName, accent, value: v, unit: u, status: k.status, foot, tip: k.explain, href, spark,
    naText: k.status === 'not_configured' ? null : (k.status === 'device_offline' ? 'Gerät offline' : k.status === 'stale' ? 'Veraltet' : null) });
}

// ---------------------------------------------------------------- Tooltip
const tipEl = () => document.getElementById('tip');
export function showTip(x, y, content) {
  const t = tipEl();
  clear(t);
  if (typeof content === 'string') t.textContent = content; else t.append(content);
  t.classList.remove('hidden');
  const r = t.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (left < 8) left = 8;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  t.style.left = `${left}px`; t.style.top = `${Math.max(8, top)}px`;
}
export const hideTip = () => tipEl().classList.add('hidden');
export function initTooltips() {
  let cur = null;
  const show = (el, x, y) => { cur = el; showTip(x, y, el.getAttribute('data-tip')); };
  document.addEventListener('pointerover', (e) => { const el = e.target.closest?.('[data-tip]'); if (el) show(el, e.clientX, e.clientY); });
  document.addEventListener('pointerout', (e) => { if (cur && !cur.contains(e.relatedTarget)) { cur = null; hideTip(); } });
  document.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-tip]'); if (el) { const r = el.getBoundingClientRect(); show(el, r.left, r.bottom); } });
  document.addEventListener('focusout', () => { if (cur) { cur = null; hideTip(); } });
  document.addEventListener('scroll', () => { if (cur) { cur = null; hideTip(); } }, true);
}

// ---------------------------------------------------------------- Toast & Dialog
export function toast(msg, err = false) {
  const t = h('div.toast', { class: err ? 'err' : '', role: err ? 'alert' : 'status' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}

export function modal(title, body, actions = []) {
  const dlg = h('dialog.modal', { 'aria-label': title },
    h('div.modal-h', h('h3', title), h('span', { style: { flex: 1 } }),
      h('button.btn.ghost.sm', { type: 'button', 'aria-label': 'Schließen', onclick: () => dlg.close() }, icon('x'))),
    h('div.modal-b', body),
    actions.length ? h('div.modal-f', actions) : null);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// ---------------------------------------------------------------- API
export const admin = {
  get token() { try { return sessionStorage.getItem('solaris_admin') || ''; } catch { return ''; } },
  set token(v) { try { v ? sessionStorage.setItem('solaris_admin', v) : sessionStorage.removeItem('solaris_admin'); } catch { /* privat */ } },
};

export async function api(path, opts = {}) {
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  if (opts.body && typeof opts.body !== 'string') { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
  if (path.startsWith('/api/admin') && admin.token) headers.Authorization = `Bearer ${admin.token}`;
  const r = await fetch(path, { ...opts, headers });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    const d = data && data.detail;
    const msg = typeof d === 'string' ? d : d?.message ? `${d.message}${d.errors ? ': ' + d.errors.join('; ') : ''}` : `HTTP ${r.status}`;
    const e = new Error(msg); e.status = r.status; e.data = data; throw e;
  }
  return data;
}

export function download(url, filename) {
  const a = h('a', { href: url, download: filename || '' });
  document.body.append(a); a.click(); a.remove();
}

export async function adminDownload(path, filename) {
  const r = await fetch(path, { headers: { Authorization: `Bearer ${admin.token}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  download(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function segmented(options, value, onChange, label) {
  const wrap = h('div.seg', { role: 'group', 'aria-label': label });
  for (const [v, text] of options) {
    wrap.append(h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => {
      wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      wrap.querySelector(`[data-v="${CSS.escape(v)}"]`).setAttribute('aria-pressed', 'true');
      onChange(v);
    }, 'data-v': v }, text));
  }
  return wrap;
}
