// Zentrale Formatierung. Die Anzeige rechnet nur um (W ↔ kW), sie erfindet keine Werte.
export const state = { tz: 'Europe/Berlin', display: { power_unit: 'auto', kw_threshold_w: 1000, energy_unit: 'kWh' } };

const nf = {};
function num(v, d) {
  const k = d;
  nf[k] ??= new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
  return nf[k].format(v);
}
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function fmtNumber(v, d = 1) { return isNum(v) ? num(v, d) : '–'; }

/** Leistung in W → [Zahl, Einheit] gemäß Anzeigepräferenz. */
export function power(w, opts = {}) {
  if (!isNum(w)) return ['–', ''];
  const mode = opts.mode ?? state.display.power_unit;
  const abs = Math.abs(w);
  if (mode === 'kW' || (mode === 'auto' && abs >= state.display.kw_threshold_w)) return [num(w / 1000, abs >= 10000 ? 1 : 2), 'kW'];
  return [num(w, abs < 10 && abs > 0 && !opts.int ? 1 : 0), 'W'];
}
export const powerStr = (w, o) => { const [a, b] = power(w, o); return b ? `${a} ${b}` : a; };

/** Energie in kWh → [Zahl, Einheit]. */
export function energy(kwh) {
  if (!isNum(kwh)) return ['–', ''];
  if (state.display.energy_unit === 'Wh' || (state.display.energy_unit === 'auto' && Math.abs(kwh) < 1)) return [num(kwh * 1000, 0), 'Wh'];
  return [num(kwh, Math.abs(kwh) >= 100 ? 1 : 2), 'kWh'];
}
export const energyStr = (k) => { const [a, b] = energy(k); return b ? `${a} ${b}` : a; };

export function valueStr(v, unit, kind) {
  if (v === null || v === undefined || v === '') return '–';
  if (typeof v === 'string') return v;
  if (kind === 'power' || unit === 'W') return powerStr(v);
  if (kind === 'energy' || kind === 'energy_total' || unit === 'kWh') return energyStr(v);
  if (unit === '%') return `${num(v, 0)} %`;
  if (unit === '°C') return `${num(v, 1)} °C`;
  if (unit === 'V') return `${num(v, 1)} V`;
  if (unit === 'A') return `${num(v, 2)} A`;
  if (unit === 'Hz') return `${num(v, 2)} Hz`;
  if (unit === 's') return duration(v);
  return unit ? `${fmtNumber(v, 2)} ${unit}` : fmtNumber(v, Number.isInteger(v) ? 0 : 2);
}

export function duration(s) {
  if (!isNum(s)) return '–';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

const dtf = {};
function f(opts) { const k = JSON.stringify(opts) + state.tz; return (dtf[k] ??= new Intl.DateTimeFormat('de-DE', { timeZone: state.tz, ...opts })); }
export const time = (ts) => ts ? f({ hour: '2-digit', minute: '2-digit' }).format(ts * 1000) : '–';
export const timeSec = (ts) => ts ? f({ hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ts * 1000) : '–';
export const date = (ts) => ts ? f({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(ts * 1000) : '–';
export const dateShort = (ts) => ts ? f({ day: '2-digit', month: '2-digit' }).format(ts * 1000) : '–';
export const weekday = (ts) => f({ weekday: 'short', day: '2-digit', month: '2-digit' }).format(ts * 1000);
export const monthName = (ts) => f({ month: 'long', year: 'numeric' }).format(ts * 1000);
export const dateTime = (ts) => ts ? f({ day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ts * 1000) : '–';
export const longDate = (ts) => f({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ts * 1000);

export function ago(ts) {
  if (!ts) return 'nie';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return `vor ${Math.round(s)} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  return `am ${date(ts)}`;
}

export const QUALITY = {
  good: ['gültig', 'ok'], stale: ['veraltet', 'warn'], unavailable: ['keine Daten', 'off'], device_offline: ['Gerät offline', 'warn'],
  out_of_range: ['unplausibel', 'err'], unit_mismatch: ['falsche Einheit', 'err'], retained: ['unbestätigt', 'warn'],
  simulated: ['Simulation', 'sim'], error: ['fehlerhaft', 'err'], not_configured: ['nicht konfiguriert', 'off'],
};
export const qualityLabel = (q) => (QUALITY[q] || [q, 'off'])[0];
export const qualityClass = (q) => (QUALITY[q] || [q, 'off'])[1];

export const INTEGRATION_STATE = {
  connected: ['verbunden', 'ok'], degraded: ['eingeschränkt', 'warn'], connecting: ['verbinde …', 'info'], starting: ['startet', 'info'],
  disconnected: ['getrennt', 'err'], error: ['Fehler', 'err'], disabled: ['deaktiviert', 'off'], not_configured: ['nicht eingerichtet', 'off'],
};
export const DEVICE_STATE = {
  online: ['online', 'ok'], partial: ['teilweise Daten', 'warn'], stale: ['veraltet', 'warn'], offline: ['offline', 'warn'],
  no_data: ['keine Daten', 'err'], not_configured: ['nicht konfiguriert', 'off'],
};
