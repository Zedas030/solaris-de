// Gemeinsame Bausteine für mehrere Ansichten.
import { h, clear, card, pill, notice, icon, segmented, api, infoI } from '../ui.js';
import { lineChart, barChart } from '../charts.js';
import * as F from '../format.js';

export const COLORS = {
  pv: 'var(--pv)', house: 'var(--house)', battery: 'var(--battery)', battery_charge: 'var(--battery)', battery_discharge: '#14B8A6',
  grid_import: 'var(--import)', grid_export: 'var(--export)', inverter: 'var(--inverter)', soc: 'var(--battery)',
};
// Für SVG-Attribute (CSS-Variablen funktionieren in stroke/fill über style nicht überall gleich) – feste Werte:
export const HEX = {
  pv: '#FBBF24', house: '#60A5FA', battery_charge: '#2DD4BF', battery_discharge: '#0EA5A4', grid_import: '#F97316',
  grid_export: '#22C55E', inverter: '#A78BFA', soc: '#2DD4BF', temp: '#F472B6', extra: ['#F472B6', '#38BDF8', '#A3E635', '#FB7185', '#C084FC', '#FCD34D'],
};

export const RANGES = [['15m', '15 min'], ['1h', '1 h'], ['today', 'Heute'], ['yesterday', 'Gestern'], ['7d', '7 Tage'], ['30d', '30 Tage']];

export function rangeStore(key, def) {
  return {
    get() { try { return localStorage.getItem(`solaris_range_${key}`) || def; } catch { return def; } },
    set(v) { try { localStorage.setItem(`solaris_range_${key}`, v); } catch { /* */ } },
  };
}

/**
 * Leistungs-/Verlaufsdiagramm mit Zeitraumauswahl.
 * spec: [{role|id, name, color}] – nur konfigurierte Messpunkte werden angezeigt.
 */
export function historyCard(app, { title, key, spec, kind = 'power', info, defRange, ranges = RANGES, height = 280, sub }) {
  const rs = rangeStore(key, defRange || app.config.settings.default_chart_range || 'today');
  const body = h('div', h('div.empty', 'Lade Verlauf …'));
  const items = spec.map((sp) => ({ ...sp, dp: sp.id ? app.dp(sp.id) : app.byRole(sp.role)[0] })).filter((x) => x.dp);
  const missing = spec.filter((sp) => !(sp.id ? app.dp(sp.id) : app.byRole(sp.role)[0]));
  let range = rs.get();
  const load = async () => {
    if (!items.length) { clear(body).append(h('div.empty', 'Keine passenden Messpunkte konfiguriert.')); return; }
    try {
      const d = await app.history(items.map((x) => x.dp.id), range);
      const series = items.map((x) => ({ id: x.dp.id, name: x.name || x.dp.name, color: x.color, unit: d.series[x.dp.id]?.unit,
        points: (d.series[x.dp.id]?.points || []).map((p) => [p[0], x.negate ? -p[1] : p[1]]), area: x.area, dash: x.dash }));
      clear(body).append(lineChart({ key, series, start: d.start, end: d.end, gap: d.gap_threshold_s, height, kind,
        unit: series[0]?.unit, label: title,
        caption: d.bucket_s ? `Auflösung: Mittelwerte über ${d.bucket_s >= 3600 ? d.bucket_s / 3600 + ' h' : d.bucket_s / 60 + ' min'}.` : 'Auflösung: Rohmesswerte.' }));
    } catch (e) { clear(body).append(notice('err', `Verlauf konnte nicht geladen werden: ${e.message}`)); }
  };
  const seg = segmented(ranges, range, (v) => { range = v; rs.set(v); load(); }, 'Zeitraum');
  load();
  const c = card(title, { right: seg, info, sub }, body,
    missing.length ? h('p.xs.faint', `Nicht konfiguriert: ${missing.map((m) => m.name).join(', ')}`) : null);
  c.reload = load;
  return c;
}

export function statusLed(state) {
  const map = { connected: 'ok', online: 'ok', degraded: 'warn', partial: 'warn', stale: 'warn', offline: 'warn', connecting: 'warn',
    starting: 'warn', error: 'err', disconnected: 'err', no_data: 'err' };
  return h('span.led', { class: map[state] || '' });
}

export function warningsList(warnings, limit = 6) {
  if (!warnings?.length) return h('div.empty', { style: { padding: '12px' } }, 'Keine aktuellen Warnungen');
  return h('ul.summary-list', warnings.slice(0, limit).map((w) =>
    h('li', h('i', { style: { '--c': w.severity === 'error' ? 'var(--error)' : 'var(--warn)' } }),
      h('div', h('div', w.message), h('div.xs.faint', `seit ${F.dateTime(w.since)}`)))),
  warnings.length > limit ? h('li.small.muted', h('a', { href: '#/events' }, `+ ${warnings.length - limit} weitere`)) : null);
}

/** Tabelle von Messpunkten mit aktuellem Wert und Qualität. */
export function dpTable(app, dps, { showDevice = false, showSource = true } = {}) {
  if (!dps.length) return h('div.empty', 'Keine Messpunkte.');
  return h('div.table-wrap', h('table.tbl',
    h('thead', h('tr', h('th', 'Messpunkt'), showDevice ? h('th', 'Gerät') : null, h('th.r', 'Wert'), h('th', 'Qualität'), h('th', 'Zeitpunkt'), showSource ? h('th', 'Quelle') : null)),
    h('tbody', dps.map((dp) => {
      const c = app.cur(dp.id) || {};
      const v = dp.kind === 'state' ? c.text : c.value;
      const showV = c.quality === 'good' || c.quality === 'simulated' ? F.valueStr(v, dp.unit === 'kW' ? 'W' : app.config.meta.canonical_units[dp.kind], dp.kind) : '–';
      const last = c.quality !== 'good' && c.last_good_value !== null && c.last_good_value !== undefined
        ? h('div.xs.faint', `zuletzt ${F.valueStr(c.last_good_value, app.config.meta.canonical_units[dp.kind], dp.kind)} (${F.ago(c.last_good_ts)})`) : null;
      return h('tr', h('td', h('div', dp.name, dp.partial ? h('span.pill.warn', { style: { marginLeft: '6px' } }, 'Teilmessung') : null,
        dp.estimated ? h('span.pill.info', { style: { marginLeft: '6px' } }, 'Rechenwert') : null, dp.description ? infoI(dp.description) : null), h('div.xs.faint.mono', dp.id)),
      showDevice ? h('td', app.device(dp.device)?.name || dp.device) : null,
      h('td.r.num', showV, last),
      h('td', pill(F.qualityLabel(c.quality || 'unavailable'), F.qualityClass(c.quality || 'unavailable'), c.message || null)),
      h('td.small.muted', c.timestamp ? `${F.time(c.timestamp)} (${F.ago(c.timestamp)})` : '–'),
      showSource ? h('td.small.muted', dp.integration, h('div.xs.faint.mono', dp.source.topic ? `${dp.source.topic}${dp.source.json_path ? ' → ' + dp.source.json_path : ''}` : dp.source.entity || dp.source.signal || '')) : null);
    }))));
}

/** Liste nicht verfügbarer Kennwerte, damit „fehlend“ ehrlich sichtbar ist. */
export function unavailableList(items) {
  return h('div.table-wrap', h('table.tbl', h('tbody', items.map(([label, why]) => h('tr', h('td', label), h('td.muted.small', why))))));
}

export function energyBuckets(app, { title, key, group, range, start, end, metrics, info, period }) {
  const body = h('div', h('div.empty', 'Lade …'));
  const q = new URLSearchParams({ group, ...(period ? { period } : {}), ...(range ? { range } : {}), ...(start ? { start, end } : {}) });
  api(`/api/statistics?${q}`).then((d) => {
    const cats = d.buckets.map((b) => ({ label: group === 'hour' ? F.time(b.start) : group === 'day' ? F.dateShort(b.start) : F.monthName(b.start),
      tip: group === 'hour' ? `${F.weekday(b.start)} ${F.time(b.start)}–${F.time(b.end)}` : group === 'day' ? F.weekday(b.start) : F.monthName(b.start),
      note: Object.values(b.values).some((v) => v && v.partial) ? 'Hausverbrauch = Teilmessung' : null }));
    const series = metrics.map((m) => ({ id: m, name: d.metrics[m], color: HEX[m] || HEX.extra[0],
      values: d.buckets.map((b) => b.values[m]?.kwh ?? null), partial: d.buckets.map((b) => b.values[m]?.partial) }))
      .filter((se) => se.values.some((v) => v !== null));
    const absent = metrics.filter((m) => !series.find((s) => s.id === m)).map((m) => d.metrics[m]);
    clear(body).append(series.length ? barChart({ key, categories: cats, series, unit: 'kWh', label: title,
      fmt: (v) => (v === null || v === undefined ? 'keine Daten' : F.energyStr(v)) }) : h('div.empty', 'Keine Daten im Zeitraum.'),
    absent.length ? h('p.xs.faint', `Keine Messdaten bzw. nicht konfiguriert: ${absent.join(', ')}`) : null);
  }).catch((e) => clear(body).append(notice('err', e.message)));
  return card(title, { info }, body);
}

export { icon };
