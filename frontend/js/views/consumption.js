import { h, clear, card, kpi, kpiFromRole, pill, notice, api } from '../ui.js';
import * as F from '../format.js';
import { historyCard, HEX, energyBuckets } from './common.js';

export async function render(root, app) {
  const house = app.byRole('house_power')[0];
  const kpis = h('div.grid.kpis');
  const stats = h('div.grid.kpis');
  const consumers = h('div');
  root.append(
    house?.partial ? notice('warn', h('b', 'Teilmessung: '), house.description || 'Der Hausverbrauch ist die Summe einzelner Messstellen. Nicht erfasste Verbraucher fehlen, daher ist er kein Gesamtverbrauch.') : null,
    kpis,
    historyCard(app, { title: 'Verbrauchsverlauf', key: 'cons-power', spec: [{ role: 'house_power', name: 'Hausverbrauch', color: HEX.house, area: true },
      { role: 'inverter_output_power', name: 'Wechselrichter-Ausgang', color: HEX.inverter, dash: '5 4' }] }),
    h('div.section-title', 'Spitzen & Durchschnitt (letzte 7 Tage)'),
    stats,
    energyBuckets(app, { title: 'Tagesverbrauch – Vergleich mit früheren Tagen', key: 'cons-days', group: 'day', range: '30d', metrics: ['house', 'pv'],
      info: 'Tageswerte aus Tageszählern. Blasse Balken: Teilmessung.' }),
    card('Einzelverbraucher', { info: 'Nur tatsächlich vorhandene Messpunkte (Smart Plugs, Unterzähler). Die Summe ist nicht der Gesamtverbrauch, wenn Verbraucher fehlen.' }, consumers),
  );

  // Spitzen und Durchschnitt aus Historie
  if (house) {
    app.history([house.id], '7d').then((d) => {
      const pts = (d.series[house.id]?.points || []).filter((p) => F.isNum(p[1]));
      if (!pts.length) { clear(stats).append(h('div.empty', 'Keine Daten.')); return; }
      const peak = pts.reduce((a, b) => (b[3] > a[3] ? b : a));
      const avg = pts.reduce((a, b) => a + b[1], 0) / pts.length;
      const min = pts.reduce((a, b) => (b[2] < a[2] ? b : a));
      clear(stats).append(
        kpi({ label: 'Verbrauchsspitze', iconName: 'bolt', accent: 'var(--import)', value: F.power(peak[3])[0], unit: F.power(peak[3])[1], foot: [h('span', `${F.weekday(peak[0])} ${F.time(peak[0])}`)],
          tip: `Höchster Wert im Zeitraum (Maximum je ${d.bucket_s / 60}-Minuten-Fenster).` }),
        kpi({ label: 'Durchschnittsleistung', iconName: 'chart', accent: 'var(--house)', value: F.power(avg)[0], unit: F.power(avg)[1], foot: [h('span', 'Mittel über Zeitfenster mit Daten')] }),
        kpi({ label: 'Grundlast (Minimum)', iconName: 'house', accent: 'var(--house)', value: F.power(min[2])[0], unit: F.power(min[2])[1], foot: [h('span', `${F.weekday(min[0])} ${F.time(min[0])}`)] }),
      );
    }).catch(() => {});
  }

  function update(ov) {
    const k = ov.kpis;
    clear(kpis).append(
      kpiFromRole(k.house_power, { label: 'Momentanverbrauch', iconName: 'house', accent: 'var(--house)' }),
      kpiFromRole(k.house_energy_today, { label: 'Tagesverbrauch', kind: 'energy', iconName: 'house', accent: 'var(--house)' }),
      kpiFromRole(roleKpi(app, 'house_energy_week', 'Wochenverbrauch'), { kind: 'energy', iconName: 'house', accent: 'var(--house)' }),
      kpiFromRole(k.house_energy_month, { label: 'Monatsverbrauch', kind: 'energy', iconName: 'house', accent: 'var(--house)' }),
      kpiFromRole(k.house_energy_year, { label: 'Jahresverbrauch', kind: 'energy', iconName: 'house', accent: 'var(--house)' }),
    );
    const plugs = app.byRole('consumer_power');
    if (!plugs.length) { clear(consumers).append(h('div.empty', 'Keine Einzelverbraucher konfiguriert.')); return; }
    const today = app.byRole('consumer_energy_today');
    const rows = plugs.map((p) => {
      const c = app.cur(p.id) || {};
      const t = today.find((x) => x.group === p.group);
      const tc = t && app.cur(t.id);
      return { p, c, w: c.quality === 'good' ? c.value : null, kwh: tc?.quality === 'good' ? tc.value : null };
    }).sort((a, b) => (b.w ?? -1) - (a.w ?? -1));
    const sum = rows.reduce((a, r) => a + (r.w ?? 0), 0);
    const max = Math.max(1, ...rows.map((r) => r.w ?? 0));
    const tot = k.house_power?.status === 'good' ? k.house_power.value : null;
    clear(consumers).append(h('div.table-wrap', h('table.tbl',
      h('thead', h('tr', h('th', 'Verbraucher'), h('th.r', 'Leistung'), h('th', { style: { width: '30%' } }, 'Anteil'), h('th.r', 'Heute'), h('th', 'Status'))),
      h('tbody', rows.map((r) => h('tr', h('td', r.p.name), h('td.r.num', r.w !== null ? F.powerStr(r.w) : '–'),
        h('td', h('div.bar', { style: { '--c': 'var(--house)' } }, h('i', { style: { width: `${((r.w ?? 0) / max) * 100}%` } })), h('div.xs.faint', r.w !== null && sum > 0 ? `${F.fmtNumber(r.w / sum * 100, 0)} % der erfassten Summe` : '')),
        h('td.r.num', r.kwh !== null ? F.energyStr(r.kwh) : '–'), h('td', pill(F.qualityLabel(r.c.quality || 'unavailable'), F.qualityClass(r.c.quality || 'unavailable'))))))),
    h('p.small.muted', `Summe der ${rows.filter((r) => r.w !== null).length} aktuell gemessenen Verbraucher: ${F.powerStr(sum)}`,
      tot !== null ? ` · Messpunkt „${app.byRole('house_power')[0].name}“: ${F.powerStr(tot)}` : '',
      '. Die Summe einzelner Verbraucher wird nicht als Gesamtverbrauch ausgegeben.'));
  }
  return { update };
}

function roleKpi(app, role, label) {
  const dp = app.byRole(role)[0];
  if (!dp) return { label, status: 'not_configured' };
  const c = app.cur(dp.id) || {};
  return { label, value: c.value, unit: dp.unit, status: c.quality || 'unavailable', timestamp: c.timestamp, partial: dp.partial, explain: dp.description || dp.name };
}
