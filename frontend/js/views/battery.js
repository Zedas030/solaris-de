import { h, clear, card, kpi, kpiFromRole, pill, notice, api, infoI } from '../ui.js';
import { batteryGraphic } from '../charts.js';
import * as F from '../format.js';
import { historyCard, HEX, unavailableList } from './common.js';

const SOC_COL = { high: '#22C55E', medium: '#2DD4BF', low: '#F97316', critical: '#EF4444' };
const SOC_TXT = { high: 'hoch', medium: 'mittel', low: 'niedrig', critical: 'kritisch' };

export async function render(root, app) {
  const top = h('div.grid.dash-main');
  const kpis = h('div.grid.kpis');
  const modules = h('div');
  const phasesBox = h('div', h('div.empty', 'Lade …'));
  const missing = h('div');
  root.append(top, kpis,
    card('Batteriemodule', {}, modules),
    historyCard(app, { title: 'Ladezustand (SOC)', key: 'bat-soc', kind: 'percent', defRange: '7d',
      spec: [{ role: 'battery_soc', name: 'SOC gesamt', color: HEX.soc, area: true }, ...app.byRole('battery_module_soc').map((d, i) => ({ id: d.id, name: d.name, color: HEX.extra[i], dash: '4 3' }))] }),
    historyCard(app, { title: 'Lade- und Entladeleistung', key: 'bat-power', spec: [
      { role: 'battery_charge_power', name: 'Laden', color: HEX.battery_charge, area: true },
      { role: 'battery_discharge_power', name: 'Entladen', color: HEX.grid_import, negate: true, area: true },
      { role: 'battery_power', name: 'Batterieleistung', color: HEX.battery_charge }], info: 'Entladung wird negativ dargestellt.' }),
    card('Lade- und Entladephasen heute', { info: 'Zusammenhängende Zeiträume über 20 W und mindestens 10 Minuten, aus gespeicherten Messwerten.' }, phasesBox),
    card('Nicht verfügbare Kennwerte', { sub: 'Von der Schnittstelle nicht geliefert – es werden keine Ersatzwerte angezeigt.' }, missing));

  api('/api/summary/today').then((s) => {
    const row = (p, kind) => h('tr', h('td', pill(kind === 'charge' ? 'Laden' : 'Entladen', kind === 'charge' ? 'ok' : 'warn')), h('td.num', `${F.time(p.start)} – ${F.time(p.end)}`),
      h('td.num', F.duration(p.end - p.start)), h('td.r.num', `max. ${F.powerStr(p.max_w)}`));
    const rows = [...(s.facts.charge_phases || []).map((p) => [p, 'charge']), ...(s.facts.discharge_phases || []).map((p) => [p, 'discharge'])].sort((a, b) => a[0].start - b[0].start);
    clear(phasesBox).append(rows.length ? h('div.table-wrap', h('table.tbl', h('thead', h('tr', h('th', 'Phase'), h('th', 'Zeitraum'), h('th', 'Dauer'), h('th.r', 'Spitze'))), h('tbody', rows.map(([p, k]) => row(p, k)))))
      : h('div.empty', 'Heute bisher keine Lade- oder Entladephasen erkannt.'));
  }).catch((e) => clear(phasesBox).append(notice('err', e.message)));

  function update(ov) {
    const k = ov.kpis, site = app.config.site, th = app.config.settings.thresholds;
    const soc = k.battery_soc, good = soc.status === 'good' && F.isNum(soc.value);
    const color = SOC_COL[ov.soc_level] || '#2DD4BF';
    const bp = k.battery_power;
    const cap = site.battery_capacity_kwh;
    const reserve = site.battery_reserve_soc ?? 0;
    let content = null, remain = null;
    if (cap && good) content = cap * soc.value / 100;
    if (cap && good && bp.status === 'good' && F.isNum(bp.value)) {
      if (bp.value < -5) remain = { label: 'Geschätzte Restlaufzeit', s: (Math.max(soc.value - reserve, 0) / 100 * cap) / (-bp.value / 1000) * 3600,
        formula: `(SOC ${Math.round(soc.value)} % − Reserve ${reserve} %) × ${cap} kWh ÷ aktuelle Entladeleistung ${F.powerStr(-bp.value)}` };
      else if (bp.value > 5) remain = { label: 'Geschätzte Restladezeit', s: ((100 - soc.value) / 100 * cap) / (bp.value / 1000) * 3600,
        formula: `(100 % − SOC ${Math.round(soc.value)} %) × ${cap} kWh ÷ aktuelle Ladeleistung ${F.powerStr(bp.value)}` };
    }
    clear(top).append(
      card('Speicher', { info: `Farbe nach Ladezustand: ≥ ${th.soc_high} % hoch (grün), < ${th.soc_low} % niedrig (orange)${th.soc_critical !== null && th.soc_critical !== undefined ? `, ≤ ${th.soc_critical} % kritisch (rot)` : '; kein kritischer Grenzwert konfiguriert'}. Grenzwerte in den Einstellungen.` },
        h('div', { style: { display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap' } },
          batteryGraphic(good ? soc.value : null, color),
          h('div', h('div.kpi-value', { style: { fontSize: '46px' } }, good ? `${Math.round(soc.value)}` : '–', h('span.unit', '%')),
            h('div.small.muted', good ? `Ladezustand ${SOC_TXT[ov.soc_level] || ''}` : F.qualityLabel(soc.status)),
            h('div.small.muted', bp.status === 'good' && F.isNum(bp.value) ? (bp.value > 5 ? `lädt mit ${F.powerStr(bp.value)}` : bp.value < -5 ? `entlädt mit ${F.powerStr(-bp.value)}` : 'in Ruhe') : 'Leistung: keine aktuellen Daten'),
            soc.timestamp ? h('div.xs.faint', `Messung ${F.ago(soc.timestamp)}`) : null))),
      card('Kapazität & Prognose', {},
        h('dl.kv',
          h('dt', 'Nutzbare Kapazität'), h('dd', cap ? `${F.fmtNumber(cap, 2)} kWh (aus Einstellungen)` : 'nicht konfiguriert'),
          h('dt', 'Energieinhalt'), h('dd', content !== null ? `${F.energyStr(content)} (berechnet: Kapazität × SOC)` : 'nicht bestimmbar'),
          h('dt', 'Verfügbare Ladekapazität'), h('dd', cap && good ? `${F.energyStr(cap * (100 - soc.value) / 100)} (berechnet)` : 'nicht bestimmbar'),
          h('dt', 'Verfügbare Entladekapazität'), h('dd', cap && good ? `${F.energyStr(Math.max(0, cap * (soc.value - reserve) / 100))} (berechnet, Reserve ${reserve} %)` : 'nicht bestimmbar'),
          h('dt', remain?.label || 'Restlaufzeit / Restladezeit'), h('dd', remain ? [h('span', `≈ ${F.duration(remain.s)} `), pill('Schätzung', 'info'), infoI(`Formel: ${remain.formula}. Annahme: konstante Leistung, keine Verluste.`)]
            : cap ? 'nur bei aktivem Laden/Entladen' : 'Kapazität nicht konfiguriert')),
        !cap ? h('p.xs.faint', 'Die Kapazität wird nicht automatisch angenommen. Bitte den Wert aus dem Datenblatt unter Einstellungen → Anlage eintragen.') : null),
    );
    const d = ov.derived?.today?.values || {};
    const eK = (label, v, tip) => kpi({ label, iconName: 'battery', accent: 'var(--battery)', value: v ? F.energy(v.kwh)[0] : null, unit: v ? F.energy(v.kwh)[1] : '',
      status: v ? 'good' : 'unavailable', tip, foot: v ? [h('span', v.basis === 'counter' ? 'Zähler' : 'integriert aus Leistung')] : [] });
    clear(kpis).append(
      kpiFromRole(k.battery_charge_power, { label: 'Ladeleistung', iconName: 'battery', accent: 'var(--battery)' }),
      kpiFromRole(k.battery_discharge_power, { label: 'Entladeleistung', iconName: 'battery', accent: 'var(--import)' }),
      eK('Heute geladen', d.battery_charge, 'Energie in den Speicher heute.'),
      eK('Heute entladen', d.battery_discharge, 'Energie aus dem Speicher heute.'),
      kpiFromRole((() => { const dp = app.byRole('battery_count')[0]; const c = dp && app.cur(dp.id); return dp ? { label: 'Batteriemodule', value: c?.value, status: c?.quality, timestamp: c?.timestamp, explain: dp.name } : null; })(),
        { label: 'Batteriemodule', kind: 'count', iconName: 'battery', accent: 'var(--battery)' }),
    );
    const mods = [...new Set(app.byRole('battery_module_soc').concat(app.byRole('battery_temperature')).map((x) => x.index))].sort();
    clear(modules).append(mods.length ? h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' } }, mods.map((i) => {
      const s = app.byRole('battery_module_soc').find((x) => x.index === i), t = app.byRole('battery_temperature').find((x) => x.index === i);
      const sc = s && app.cur(s.id), tc = t && app.cur(t.id);
      const sv = sc?.quality === 'good' ? sc.value : null;
      return h('div.card', { style: { padding: '14px 16px' } }, h('div.card-h', { style: { marginBottom: '6px' } }, h('h3', `Modul ${i}`), h('span.spacer'), pill(F.qualityLabel(sc?.quality || 'unavailable'), F.qualityClass(sc?.quality || 'unavailable'))),
        h('div.kpi-value', { style: { fontSize: '26px' } }, sv !== null ? `${Math.round(sv)} %` : '–'),
        h('div.bar', { style: { margin: '8px 0', '--c': 'var(--battery)' } }, h('i', { style: { width: `${sv ?? 0}%` } })),
        h('dl.kv', h('dt', 'Temperatur'), h('dd', tc?.quality === 'good' ? F.valueStr(tc.value, '°C') : '–'), h('dt', 'Messung'), h('dd', sc?.timestamp ? F.ago(sc.timestamp) : '–')));
    })) : h('div.empty', 'Keine Modulwerte konfiguriert.'));
    const has = (r) => app.byRole(r).length > 0;
    clear(missing).append(unavailableList([
      !has('battery_voltage') && ['Batteriespannung', 'nicht geliefert'], !has('battery_current') && ['Batteriestrom', 'nicht geliefert'],
      !has('battery_cycles') && ['Ladezyklen', 'nicht geliefert'], ['BMS-Warnungen / Lade- & Entladebegrenzung', 'nicht geliefert – es werden keine Diagnosen abgeleitet'],
      ['Steuerung (Laden/Entladen, Modus)', 'deaktiviert: SOLARIS arbeitet ausschließlich lesend'],
    ].filter(Boolean)));
  }
  return { update };
}
