import { h, clear, card, kpi, notice, segmented, api, download, infoI } from '../ui.js';
import { barChart, lineChart } from '../charts.js';
import * as F from '../format.js';
import { HEX } from './common.js';

const METRICS = ['pv', 'house', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge'];
const PERIODS = [['day', 'Tag'], ['week', 'Woche'], ['month', 'Monat'], ['year', 'Jahr'], ['custom', 'Benutzerdefiniert']];

const GROUP = { day: 'hour', week: 'day', month: 'day', year: 'month' };

export async function render(root, app) {
  const tz = app.config.site.timezone;
  let period = 'day', ref = Date.now() / 1000;
  let custom = { start: Date.now() / 1000 - 7 * 86400, end: Date.now() / 1000, group: 'day' };
  const label = h('div', { style: { fontWeight: 650, minWidth: '180px', textAlign: 'center' } });
  const nav = h('div.actions',
    h('button.btn.sm', { type: 'button', 'aria-label': 'Vorheriger Zeitraum', onclick: () => step(-1) }, '‹'), label,
    h('button.btn.sm', { type: 'button', 'aria-label': 'Nächster Zeitraum', onclick: () => step(1) }, '›'),
    h('button.btn.sm', { type: 'button', onclick: () => { ref = Date.now() / 1000; load(); } }, 'Heute'));
  const customBox = h('div.actions.hidden',
    h('label.small.muted', 'Von ', h('input.input#h-from', { type: 'date', style: { width: 'auto' } })),
    h('label.small.muted', 'Bis ', h('input.input#h-to', { type: 'date', style: { width: 'auto' } })),
    h('select.input#h-group', { style: { width: 'auto' }, 'aria-label': 'Auflösung' }, h('option', { value: 'hour' }, 'Stunden'), h('option', { value: 'day', selected: true }, 'Tage'), h('option', { value: 'month' }, 'Monate')),
    h('button.btn.sm.primary', { type: 'button', onclick: applyCustom }, 'Anzeigen'));
  const totals = h('div.grid.kpis');
  const charts = h('div.grid');
  const ratio = h('div');
  const compare = h('div.grid.kpis');
  const power = h('div');
  const exportBox = h('div');

  root.append(
    card('Zeitraum', { right: segmented(PERIODS, period, (v) => { period = v; customBox.classList.toggle('hidden', v !== 'custom'); nav.classList.toggle('hidden', v === 'custom'); load(); }, 'Zeitraum') },
      nav, customBox),
    totals, charts,
    card('Eigenverbrauch & Autarkiegrad', { info: 'Eigenverbrauchsquote = (PV − Einspeisung) / PV × 100. Autarkiegrad = (Hausverbrauch − Netzbezug) / Hausverbrauch × 100. Nur mit zeitlich übereinstimmenden, gültigen Zählerwerten.' }, ratio),
    h('div.section-title', 'Vergleiche (laufender Zeitraum bis jetzt vs. gesamter Vorzeitraum)'),
    compare,
    card('Leistungsverlauf im Zeitraum', {}, power),
    card('CSV-Export', { info: 'Export der gespeicherten Messwerte (lokal, ohne Internet). Spalten: Zeitstempel, Messpunkt-ID, Wert, Einheit, Qualität, Quelle.' }, exportBox),
  );

  let lastB = null;
  function step(dir) {
    if (!lastB) return;
    ref = dir < 0 ? lastB.start - 3600 : lastB.end + 3600;
    load();
  }
  function applyCustom() {
    const f = document.getElementById('h-from').value, t = document.getElementById('h-to').value;
    if (!f || !t) return;
    const s = new Date(`${f}T00:00:00`).getTime() / 1000, e = new Date(`${t}T00:00:00`).getTime() / 1000 + 86400;
    if (e <= s) return;
    custom = { start: s, end: e, group: document.getElementById('h-group').value };
    load();
  }

  async function load() {
    let b, d;
    try {
      if (period === 'custom') { b = custom; d = await api(`/api/statistics?group=${b.group}&start=${b.start}&end=${Math.min(b.end, Date.now() / 1000)}`); }
      else { d = await api(`/api/statistics?group=${GROUP[period]}&period=${period}&ref=${ref}`); b = { start: d.start, end: d.end, group: GROUP[period] }; }
    } catch (e) { clear(charts).append(notice('err', e.message)); return; }
    lastB = b;
    const end = Math.min(b.end, Date.now() / 1000);
    label.textContent = period === 'day' ? F.longDate(b.start) : period === 'month' ? F.monthName(b.start) : period === 'year' ? new Intl.DateTimeFormat('de-DE', { timeZone: tz, year: 'numeric' }).format(b.start * 1000)
      : `${F.date(b.start)} – ${F.date(b.end - 1)}`;
    clear(charts).append(h('div.empty', 'Lade …'));
    if (b.start > Date.now() / 1000) { clear(charts).append(h('div.empty', 'Zeitraum liegt in der Zukunft.')); clear(totals); return; }
    try {
      const cats = d.buckets.map((x) => ({ label: b.group === 'hour' ? F.time(x.start) : b.group === 'day' ? F.dateShort(x.start) : new Intl.DateTimeFormat('de-DE', { timeZone: tz, month: 'short' }).format(x.start * 1000),
        tip: b.group === 'hour' ? `${F.time(x.start)}–${F.time(x.end)}` : b.group === 'day' ? F.weekday(x.start) : F.monthName(x.start),
        note: x.values.house?.partial ? 'Hausverbrauch = Teilmessung' : null }));
      const ser = (m) => ({ id: m, name: d.metrics[m], color: HEX[m], values: d.buckets.map((x) => x.values[m]?.kwh ?? null), partial: d.buckets.map((x) => x.values[m]?.partial) });
      const sum = (m) => { const v = d.buckets.map((x) => x.values[m]?.kwh).filter(F.isNum); return v.length ? v.reduce((a, c) => a + c, 0) : null; };
      clear(totals).append(METRICS.map((m) => {
        const t = sum(m); const n = d.buckets.filter((x) => x.values[m]).length;
        return kpi({ label: d.metrics[m], iconName: m === 'pv' ? 'sun' : m === 'house' ? 'house' : m.startsWith('grid') ? 'grid' : 'battery', accent: `var(--${{ pv: 'pv', house: 'house', grid_import: 'import', grid_export: 'export' }[m] || 'battery'})`,
          value: t !== null ? F.energy(t)[0] : null, unit: t !== null ? F.energy(t)[1] : '', status: t !== null ? 'good' : 'unavailable',
          naText: 'Keine Daten', foot: t !== null ? [h('span', `${n} von ${d.buckets.length} Intervallen mit Daten`)] : [] });
      }));
      const groups = [['Erzeugung & Verbrauch', ['pv', 'house']], ['Netz', ['grid_import', 'grid_export']], ['Speicher', ['battery_charge', 'battery_discharge']]];
      clear(charts).append(h('div.grid.cols-3', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' } }, groups.map(([title, ms]) => {
        const series = ms.map(ser).filter((s) => s.values.some((v) => v !== null));
        return card(title, {}, series.length ? barChart({ key: `hist-${ms[0]}`, categories: cats, series, unit: 'kWh', height: 220, fmt: (v) => (v === null || v === undefined ? 'keine Daten' : F.energyStr(v)) })
          : h('div.empty', ms.some((m) => m.startsWith('grid')) ? 'Kein Netzzähler konfiguriert.' : 'Keine Daten im Zeitraum.'));
      })));
      const scs = d.buckets.map((x) => x.self_consumption), aus = d.buckets.map((x) => x.autarky);
      const anyRatio = scs.some((x) => x.available) || aus.some((x) => x.available);
      clear(ratio).append(anyRatio ? barChart({ key: 'hist-ratio', categories: cats, unit: '%', height: 200,
        series: [{ id: 'sc', name: 'Eigenverbrauchsquote', color: HEX.grid_export, values: scs.map((x) => (x.available ? x.percent : null)) },
          { id: 'au', name: 'Autarkiegrad', color: HEX.house, values: aus.map((x) => (x.available ? x.percent : null)) }],
        fmt: (v) => (v === null || v === undefined ? 'nicht berechenbar' : `${F.fmtNumber(v, 0)} %`) })
        : notice('info', `Nicht berechenbar: ${[...new Set([...scs, ...aus].map((x) => x.reason).filter(Boolean))].join('; ') || 'keine Daten'}.`));
      // Leistungsverlauf
      const ids = [['pv_power', HEX.pv], ['house_power', HEX.house], ['battery_charge_power', HEX.battery_charge], ['battery_discharge_power', HEX.battery_discharge], ['grid_power', HEX.grid_import]]
        .map(([r, c]) => [app.byRole(r)[0], c]).filter(([x]) => x);
      const hist = await app.history(ids.map(([x]) => x.id), null, { start: b.start, end });
      clear(power).append(lineChart({ key: 'hist-line', start: b.start, end: b.end, gap: hist.gap_threshold_s, kind: 'power',
        series: ids.map(([x, c]) => ({ id: x.id, name: x.name, color: c, points: hist.series[x.id]?.points || [] })),
        caption: hist.bucket_s ? `Mittelwerte über ${hist.bucket_s >= 3600 ? hist.bucket_s / 3600 + ' h' : hist.bucket_s / 60 + ' min'}.` : '' }));
      exportForm(b.start, end);
    } catch (e) { clear(charts).append(notice('err', e.message)); }
  }

  async function loadCompare() {
    const res = await Promise.all(['day', 'week', 'month', 'year'].map((p) => api(`/api/statistics/compare?period=${p}`).catch(() => null)));
    const names = { day: ['Heute', 'Gestern'], week: ['Diese Woche', 'Letzte Woche'], month: ['Dieser Monat', 'Vormonat'], year: ['Dieses Jahr', 'Vorjahr'] };
    clear(compare).append(res.filter(Boolean).flatMap((r) => ['pv', 'house'].map((m) => {
      const a = r.current.values[m], b = r.previous.values[m];
      const diff = a && b && b.kwh > 0 ? (a.kwh - b.kwh) / b.kwh * 100 : null;
      return kpi({ label: `${m === 'pv' ? 'PV' : 'Verbrauch'}: ${names[r.period][0]} vs. ${names[r.period][1]}`, iconName: m === 'pv' ? 'sun' : 'house', accent: m === 'pv' ? 'var(--pv)' : 'var(--house)',
        value: a ? F.energy(a.kwh)[0] : null, unit: a ? F.energy(a.kwh)[1] : '', status: a ? 'good' : 'unavailable', naText: 'Keine Daten',
        foot: [h('span', `${names[r.period][1]}: ${b ? F.energyStr(b.kwh) : 'keine Daten'}`), diff !== null ? h('span', `${diff >= 0 ? '+' : ''}${F.fmtNumber(diff, 0)} %`) : null,
          b?.days_with_data !== undefined ? h('span', `(${b.days_with_data} Tage mit Daten)`) : null],
        tip: r.note });
    })));
  }

  function exportForm(start, end) {
    const toLocal = (ts) => new Date(ts * 1000 - new Date(ts * 1000).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const sel = h('select.input', { multiple: true, size: 8, 'aria-label': 'Messpunkte' }, app.config.datapoints.filter((d) => d.enabled && d.store && d.kind !== 'state').map((d) =>
      h('option', { value: d.id, selected: ['pv_power', 'house_power', 'battery_soc'].includes(d.role) }, `${d.name} (${d.id})`)));
    const from = h('input.input', { type: 'datetime-local', value: toLocal(start) });
    const to = h('input.input', { type: 'datetime-local', value: toLocal(end) });
    const res = h('select.input', h('option', { value: 'raw' }, 'Rohmesswerte'), h('option', { value: 'hour' }, 'Stundenwerte (Mittel/Min/Max/Energie)'));
    const sep = h('select.input', h('option', { value: ';' }, 'Semikolon (Excel DE)'), h('option', { value: ',' }, 'Komma'));
    const err = h('div.form-errors');
    clear(exportBox).append(h('div.form',
      h('div.field.wide', h('label', 'Messpunkte (Mehrfachauswahl mit Strg/⌘)'), sel),
      h('div.field', h('label', 'Von'), from), h('div.field', h('label', 'Bis'), to),
      h('div.field', h('label', 'Auflösung'), res), h('div.field', h('label', 'Trennzeichen'), sep)), err,
    h('div.actions', { style: { marginTop: '12px' } }, h('button.btn.primary', { type: 'button', onclick: () => {
      const ids = [...sel.selectedOptions].map((o) => o.value);
      const s = new Date(from.value).getTime() / 1000, e = new Date(to.value).getTime() / 1000;
      if (!ids.length || !(e > s)) { err.textContent = 'Bitte Messpunkte und einen gültigen Zeitraum wählen.'; return; }
      err.textContent = '';
      download(`/api/export/csv?${new URLSearchParams({ ids: ids.join(','), start: s, end: e, resolution: res.value, sep: sep.value })}`);
    } }, 'CSV herunterladen')));
  }

  load(); loadCompare();
  return {};
}
