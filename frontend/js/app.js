// SOLARIS – Einstieg: Navigation, Live-Verbindung (SSE), Kopfzeile.
import { h, clear, icon, api, initTooltips, toast } from './ui.js';
import * as F from './format.js';

const ROUTES = [
  { path: 'dashboard', title: 'Dashboard', icon: 'dashboard', mod: './views/dashboard.js' },
  { sep: 'Anlage' },
  { path: 'pv', title: 'PV-Anlage', icon: 'panel', mod: './views/pv.js' },
  { path: 'inverter', title: 'Wechselrichter', icon: 'inverter', mod: './views/inverter.js' },
  { path: 'battery', title: 'Batteriespeicher', icon: 'battery', mod: './views/battery.js' },
  { path: 'consumption', title: 'Hausverbrauch', icon: 'house', mod: './views/consumption.js' },
  { path: 'grid', title: 'Stromnetz', icon: 'grid', mod: './views/grid.js' },
  { sep: 'Auswertung' },
  { path: 'history', title: 'Historie & Statistik', icon: 'history', mod: './views/history.js' },
  { path: 'events', title: 'Ereignisse', icon: 'bell', mod: './views/events.js' },
  { sep: 'System' },
  { path: 'devices', title: 'Geräte & Messpunkte', icon: 'devices', mod: './views/devices.js' },
  { path: 'integrations', title: 'Datenquellen', icon: 'link', mod: './views/integrations.js' },
  { path: 'settings', title: 'Einstellungen', icon: 'settings', mod: './views/settings.js' },
];

export const app = {
  overview: null,
  config: null,
  connected: false,
  listeners: new Set(),
  dp(id) { return this.config?.datapoints.find((d) => d.id === id); },
  byRole(role) { return (this.config?.datapoints || []).filter((d) => d.enabled && d.role === role); },
  cur(id) { return this.overview?.current?.[id]; },
  device(id) { return this.config?.devices.find((d) => d.id === id); },
  async reloadConfig() {
    this.config = await api('/api/config');
    F.state.tz = this.config.site.timezone || 'Europe/Berlin';
    Object.assign(F.state.display, this.config.settings.display || {});
    try { const pu = localStorage.getItem('solaris_power_unit'); if (pu) F.state.display.power_unit = pu; } catch { /* */ }
  },
  history(ids, range, extra = {}) {
    const q = new URLSearchParams({ ids: ids.join(','), ...(range ? { range } : {}), ...extra });
    return api(`/api/measurements/history?${q}`);
  },
};

let current = null; // { route, view, token }
let navToken = 0;

function buildNav() {
  const nav = document.getElementById('nav');
  clear(nav);
  for (const r of ROUTES) {
    if (r.sep) { nav.append(h('div.nav-sep', r.sep)); continue; }
    nav.append(h('a', { href: `#/${r.path}`, 'data-path': r.path }, icon(r.icon), h('span', r.title),
      r.path === 'events' ? h('span.badge.hidden#nav-badge') : null));
  }
}

function setNavOpen(open) {
  document.getElementById('app').classList.toggle('nav-open', open);
  document.getElementById('menu-btn').setAttribute('aria-expanded', String(open));
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [path, ...rest] = hash.split('/');
  const r = ROUTES.find((x) => x.path === path) || ROUTES[0];
  if (!location.hash || !ROUTES.some((x) => x.path === path)) history.replaceState(null, '', `#/${r.path}`);
  const token = ++navToken;
  setNavOpen(false);
  document.querySelectorAll('#nav a').forEach((a) => {
    if (a.dataset.path === r.path) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.getElementById('page-title').textContent = r.title;
  document.title = `${r.title} · SOLARIS`;
  if (current?.view?.destroy) try { current.view.destroy(); } catch (e) { console.warn(e); }
  const root = document.getElementById('view');
  clear(root).append(h('div.empty', 'Lade …'));
  try {
    const mod = await import(r.mod);
    if (token !== navToken) return;
    clear(root);
    const view = (await mod.render(root, app, rest)) || {};
    if (token !== navToken) { view.destroy?.(); return; }
    current = { route: r, view };
    if (app.overview && view.update) view.update(app.overview);
  } catch (e) {
    console.error(e);
    clear(root).append(h('div.notice.err', `Ansicht konnte nicht geladen werden: ${e.message}`));
  }
  root.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

function updateHeader() {
  const ov = app.overview;
  const conn = document.getElementById('conn-status');
  conn.className = `pill ${app.connected ? 'ok' : 'err'}`;
  conn.lastChild.textContent = app.connected ? 'Backend verbunden' : 'Backend getrennt';
  const ds = document.getElementById('data-status');
  if (ov) {
    const q = ov.status.quality || {};
    const total = Object.values(q).reduce((a, b) => a + b, 0);
    const good = (q.good || 0) + (q.simulated || 0);
    const cls = ov.simulation ? 'sim' : good === 0 ? 'err' : good < total ? 'warn' : 'ok';
    ds.className = `pill ${cls}`;
    ds.lastChild.textContent = ov.simulation ? 'SIMULATION' : `Daten ${good}/${total} aktuell`;
    ds.dataset.tip = `Letzte gültige Aktualisierung: ${F.dateTime(ov.status.last_update)}. ${Object.entries(q).map(([k, v]) => `${F.qualityLabel(k)}: ${v}`).join(', ')}`;
    document.getElementById('sim-banner').classList.toggle('hidden', !ov.simulation);
    const warn = ov.status.warnings || [];
    const badge = document.getElementById('nav-badge');
    if (badge) {
      badge.classList.toggle('hidden', !warn.length);
      badge.textContent = warn.length;
      badge.classList.toggle('err', warn.some((w) => w.severity === 'error'));
    }
  }
}

function tickClock() {
  const now = Date.now() / 1000;
  document.getElementById('clock-time').textContent = F.timeSec(now);
  document.getElementById('clock-date').textContent = F.longDate(now);
}

function connect() {
  let es;
  let watchdog;
  const open = () => {
    es = new EventSource('/api/stream');
    es.addEventListener('overview', (ev) => {
      app.connected = true;
      app.overview = JSON.parse(ev.data);
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { app.connected = false; updateHeader(); }, 30000);
      updateHeader();
      for (const fn of app.listeners) try { fn(app.overview); } catch (e) { console.warn(e); }
      if (current?.view?.update) try { current.view.update(app.overview); } catch (e) { console.warn(e); }
    });
    es.onopen = () => { app.connected = true; updateHeader(); };
    es.onerror = () => { app.connected = false; updateHeader(); };
  };
  open();
  // Fallback, falls der Browser SSE nicht dauerhaft hält
  setInterval(async () => {
    if (app.connected) return;
    try { await api('/api/health'); if (es.readyState === 2) open(); } catch { /* offline */ }
  }, 10000);
}

async function boot() {
  initTooltips();
  buildNav();
  document.getElementById('menu-btn').addEventListener('click', () => setNavOpen(!document.getElementById('app').classList.contains('nav-open')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNavOpen(false); });
  document.getElementById('app').addEventListener('click', (e) => { if (e.target.id === 'app') setNavOpen(false); });
  tickClock(); setInterval(tickClock, 1000);
  try {
    await app.reloadConfig();
    app.overview = await api('/api/overview');
    app.connected = true;
    document.getElementById('sidebar-foot').textContent = `Nur lesender Betrieb · v${app.config.meta.version}`;
  } catch (e) {
    toast(`Backend nicht erreichbar: ${e.message}`, true);
  }
  updateHeader();
  window.addEventListener('hashchange', route);
  await route();
  connect();
}

boot();
