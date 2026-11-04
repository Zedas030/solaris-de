import { h, clear, card, kpi, kpiFromRole, pill, notice, api, infoI } from '../ui.js';
import { sparkline } from '../charts.js';
import { energyFlow } from '../flow.js';
import * as F from '../format.js';
import { historyCard, HEX, statusLed, warningsList, energyBuckets } from './common.js';

export async function render(root, app) {
  const kpiGrid = h('div.grid.kpis', { 'aria-label': 'Kennzahlen' });
  const kpiGrid2 = h('div.grid.kpis', { 'aria-label': 'Tageskennzahlen' });
  const flow = energyFlow();
  const flowInfo = h('div');
  const statusStrip = h('div.card.status-strip', { role: 'status', 'aria-label': 'Anlagenstatus' });
  const warnBox = h('div');
  const summaryBox = h('div', h('div.empty', 'Lade Zusammenfassung …'));
  let sparks = {};

  root.append(
    statusStrip,
    kpiGrid,
    h('div.grid.dash-main',
      card('Energiefluss', { info: 'Jede Linie zeigt eine Messgröße. „berechnet“ = aus vollständiger Knotenbilanz abgeleitet; graue gestrichelte Linien = keine Daten oder nicht konfiguriert. Klick auf ein Symbol öffnet die Detailansicht.' }, flow.el, flowInfo),
      h('div.grid', { style: { gap: '16px' } },
        card('Tagesübersicht', { info: 'Aussagen werden ausschließlich aus gespeicherten Messwerten abgeleitet.' }, summaryBox),
        card('Aktuelle Warnungen', { right: h('a.small', { href: '#/events' }, 'Alle Ereignisse') }, warnBox))),
    h('div.section-title', 'Heute & Zeitraum'),
    kpiGrid2,
    historyCard(app, {
      title: 'Leistungsverlauf', key: 'dash-power',
      spec: [{ role: 'pv_power', name: 'PV-Leistung', color: HEX.pv, area: true }, { role: 'house_power', name: 'Hausverbrauch', color: HEX.house },
        { role: 'inverter_output_power', name: 'WR-Ausgang', color: HEX.inverter, dash: '5 4' },
        { role: 'battery_charge_power', name: 'Batterie laden', color: HEX.battery_charge },
        { role: 'battery_discharge_power', name: 'Batterie entladen', color: HEX.battery_discharge, negate: true },
        { role: 'battery_power', name: 'Batterieleistung', color: HEX.battery_charge },
        { role: 'grid_power', name: 'Netzleistung', color: HEX.grid_import },
        { role: 'grid_import_power', name: 'Netzbezug', color: HEX.grid_import }, { role: 'grid_export_power', name: 'Einspeisung', color: HEX.grid_export, negate: true }],
      info: 'Entladung und Einspeisung werden negativ dargestellt. Datenreihen über die Legende ein-/ausblenden.',
    }),
    energyBuckets(app, { title: 'Tagesverlauf (Energie je Stunde)', key: 'dash-hours', group: 'hour', range: 'today',
      metrics: ['pv', 'house', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export'],
      info: 'Stundenenergien, integriert aus den gespeicherten Leistungsmesswerten. Lücken werden nicht aufgefüllt.' }),
  );

  const loadSparks = async () => {
    const ids = ['pv_power', 'house_power', 'battery_soc', 'battery_charge_power', 'battery_discharge_power'].map((r) => app.byRole(r)[0]?.id).filter(Boolean);
    if (!ids.length) return;
    try {
      const d = await app.history(ids, null, { start: Date.now() / 1000 - 6 * 3600 });
      sparks = Object.fromEntries(Object.entries(d.series).map(([k, v]) => [k, { pts: v.points.map((p) => [p[0], p[1]]), gap: d.gap_threshold_s }]));
      if (app.overview) drawKpis(app.overview);
    } catch { /* Trends optional */ }
  };
  const loadSummary = async () => {
    try {
      const s = await api('/api/summary/today');
      const col = { pv: 'var(--pv)', battery: 'var(--battery)', house: 'var(--house)', inverter: 'var(--inverter)', kpi: 'var(--text-3)', none: 'var(--text-3)' };
      clear(summaryBox).append(h('ul.summary-list', s.lines.map((l) => h('li', h('i', { style: { '--c': col[l.topic] } }), h('span', l.text)))),
        h('p.xs.faint', { style: { marginTop: '10px' } }, `Stand ${F.time(s.generated_at)} Uhr`));
    } catch (e) { clear(summaryBox).append(notice('err', e.message)); }
  };
  const spark = (role, color) => { const id = app.byRole(role)[0]?.id; return id && sparks[id] ? sparkline(sparks[id].pts, color, sparks[id].gap) : null; };

  function drawKpis(ov) {
    const k = ov.kpis, d = ov.derived || {};
    const bp = k.battery_power, soc = k.battery_soc;
    const batVal = bp.value;
    const batFoot = [];
    if (soc.status === 'good') batFoot.push(pill(`SOC ${F.fmtNumber(soc.value, 0)} %`, ov.soc_level === 'low' || ov.soc_level === 'critical' ? 'warn' : 'ok'));
    else if (soc.status !== 'not_configured') batFoot.push(pill(`SOC: ${F.qualityLabel(soc.status)}`, F.qualityClass(soc.status)));
    if (bp.status === 'good' && F.isNum(batVal)) batFoot.push(h('span', batVal > 1 ? 'lädt' : batVal < -1 ? 'entlädt' : 'Ruhe'));
    const [bv, bu] = bp.status === 'good' ? F.power(Math.abs(batVal)) : [null, ''];
    const today = d.today, month = d.month, year = d.year;
    const tv = (b, m) => b?.values?.[m] || null;
    const energyKpi = (label, v, accent, iconName, tip, href) => {
      const foot = [];
      if (v) {
        foot.push(h('span', v.basis === 'counter' ? 'Zähler' : v.basis === 'integrated' ? 'integriert' : 'Summe Tageswerte'));
        if (v.partial) foot.push(pill('Teilmessung', 'warn'));
        if (v.coverage < 0.95) foot.push(pill(`Abdeckung ${Math.round(v.coverage * 100)} %`, 'warn', 'Anteil des Zeitraums mit Messdaten'));
        if (v.days_with_data !== undefined) foot.push(h('span', `${v.days_with_data} Tage mit Daten`));
      }
      const [n, u] = v ? F.energy(v.kwh) : [null, ''];
      return kpi({ label, iconName, accent, value: n, unit: u, status: v ? 'good' : 'unavailable', foot, tip, href, naText: 'Keine Daten verfügbar' });
    };
    const pctKpi = (label, res, accent, tip) => kpi({ label, iconName: 'chart', accent, value: res?.available ? F.fmtNumber(res.percent, 0) : null, unit: '%',
      status: res?.available ? 'good' : 'unavailable', naText: 'Nicht verfügbar', tip,
      foot: res?.available ? [h('div.bar', { style: { width: '100%', '--c': accent } }, h('i', { style: { width: `${Math.min(100, res.percent)}%` } }))] : [h('span', res?.reason || 'Keine Daten')] });

    clear(kpiGrid).append(
      kpiFromRole(k.pv_power, { label: 'PV-Leistung', iconName: 'sun', accent: 'var(--pv)', href: '#/pv', spark: spark('pv_power', HEX.pv) }),
      kpiFromRole(k.house_power, { label: 'Hausverbrauch', iconName: 'house', accent: 'var(--house)', href: '#/consumption', spark: spark('house_power', HEX.house) }),
      kpi({ label: 'Batterie', iconName: 'battery', accent: 'var(--battery)', value: bv, unit: bu, status: bp.status, foot: batFoot, href: '#/battery',
        tip: bp.explain, spark: spark('battery_soc', HEX.soc) }),
      kpiFromRole(k.grid_import_power, { label: 'Netzbezug', iconName: 'grid', accent: 'var(--import)', href: '#/grid' }),
      kpiFromRole(k.grid_export_power, { label: 'Netzeinspeisung', iconName: 'grid', accent: 'var(--export)', href: '#/grid' }),
      kpiFromRole(k.inverter_output_power, { label: 'Wechselrichter-Ausgang', iconName: 'inverter', accent: 'var(--inverter)', href: '#/inverter' }),
    );
    const gi = tv(today, 'grid_import'), ge = tv(today, 'grid_export');
    clear(kpiGrid2).append(
      energyKpi('PV-Energie heute', tv(today, 'pv'), 'var(--pv)', 'sun', 'Erzeugung des heutigen Tages. Quelle: Tageszähler des Geräts, sonst Integration der PV-Leistung.', '#/pv'),
      energyKpi('Hausverbrauch heute', tv(today, 'house'), 'var(--house)', 'house', 'Verbrauch des heutigen Tages aus Tageszähler bzw. integrierter Leistung.', '#/consumption'),
      kpi({ label: 'Netz heute (Bezug / Einspeisung)', iconName: 'grid', accent: 'var(--import)', status: gi || ge ? 'good' : (app.byRole('grid_power').length || app.byRole('grid_import_power').length ? 'unavailable' : 'not_configured'),
        value: gi || ge ? `${gi ? F.energyStr(gi.kwh) : '–'} / ${ge ? F.energyStr(ge.kwh) : '–'}` : null, href: '#/grid',
        tip: 'Netzbezug und Einspeisung des heutigen Tages (Netzzähler).' }),
      energyKpi('Energie in den Speicher', tv(today, 'battery_charge'), 'var(--battery)', 'battery', 'Heute geladene Energie (integriert aus der Ladeleistung).', '#/battery'),
      energyKpi('Energie aus dem Speicher', tv(today, 'battery_discharge'), 'var(--battery)', 'battery', 'Heute entladene Energie (integriert aus der Entladeleistung).', '#/battery'),
      pctKpi('Eigenverbrauchsquote', today?.self_consumption, 'var(--export)', 'Eigenverbrauch = PV-Erzeugung − Netzeinspeisung; Quote = Eigenverbrauch / PV-Erzeugung × 100. Benötigt einen Einspeisezähler.'),
      pctKpi('Autarkiegrad', today?.autarky, 'var(--house)', 'Autarkie = (Hausverbrauch − Netzbezug) / Hausverbrauch × 100. Enthält direkt und über den Speicher gedeckten Verbrauch; benötigt vollständigen Hausverbrauch und Netzbezugszähler.'),
      energyKpi('PV-Ertrag diesen Monat', tv(month, 'pv'), 'var(--pv)', 'sun', 'Summe der Tageswerte im laufenden Monat (aus gespeicherter Historie).', '#/history'),
      energyKpi('PV-Ertrag dieses Jahr', tv(year, 'pv'), 'var(--pv)', 'sun', 'Summe der Tageswerte im laufenden Jahr – nur Tage mit gespeicherten Daten.', '#/history'),
      kpi({ label: 'Spezifischer Ertrag (Jahr)', iconName: 'chart', accent: 'var(--pv)', value: d.specific_yield_year?.available ? F.fmtNumber(d.specific_yield_year.value, 0) : null,
        unit: 'kWh/kWp', status: d.specific_yield_year?.available ? 'good' : 'unavailable', naText: 'Nicht verfügbar',
        foot: [h('span', d.specific_yield_year?.reason || '')], tip: 'Jahresertrag / installierte Nennleistung (kWp aus Einstellungen).' }),
    );
  }

  function drawStatus(ov) {
    const st = ov.status;
    const devs = st.devices.filter((d) => d.state !== 'not_configured');
    const q = st.quality || {};
    const total = Object.values(q).reduce((a, b) => a + b, 0);
    clear(statusStrip).append(
      h('span.status-item', statusLed(app.connected ? 'connected' : 'error'), 'Backend', h('b', app.connected ? 'verbunden' : 'getrennt')),
      st.integrations.filter((i) => i.enabled).map((i) => h('span.status-item', { 'data-tip': i.status.message || '' }, statusLed(i.status.state), i.name, h('b', F.INTEGRATION_STATE[i.status.state]?.[0] || i.status.state))),
      devs.map((d) => h('span.status-item', { 'data-tip': `Letzter gültiger Messwert: ${F.dateTime(d.last_contact)}` }, statusLed(d.state), d.name, h('b', F.DEVICE_STATE[d.state]?.[0] || d.state))),
      h('span.status-item', 'Letzte Aktualisierung', h('b', st.last_update ? `${F.timeSec(st.last_update)}` : '–')),
      h('span.status-item', 'Datenqualität', h('b', `${(q.good || 0) + (q.simulated || 0)}/${total} gültig`)),
      h('span.status-item', 'Warnungen', h('b', String(st.warnings.length))),
    );
    clear(warnBox).append(warningsList(st.warnings));
  }

  function drawFlowInfo(ov) {
    const f = ov.flows;
    const parts = [];
    if (f.allocation?.available) {
      const a = f.allocation.flows_w;
      const names = { pv_house: 'PV → Haus', pv_battery: 'PV → Batterie', pv_grid: 'PV → Netz', battery_house: 'Batterie → Haus', battery_grid: 'Batterie → Netz', grid_house: 'Netz → Haus', grid_battery: 'Netz → Batterie' };
      parts.push(h('div.table-wrap', h('table.tbl', h('tbody', Object.entries(a).map(([k, v]) => h('tr', h('td', names[k]), h('td.r.num', F.powerStr(v))))))),
        h('p.xs.faint', f.allocation.note));
    } else if (f.allocation) {
      parts.push(h('p.small.muted', { style: { margin: '6px 0 0' } }, 'Aufteilung nach Quelle (PV → Haus, Batterie → Haus …) nicht bestimmbar. Es fehlt: ', f.allocation.missing.join(', '), '.',
        infoI('Für eine Zuordnung müssen PV, Speicher, vollständiger Hausverbrauch und Netzleistung gleichzeitig gemessen werden. Es wird nichts geraten.')));
    }
    for (const b of f.balance || []) {
      parts.push(h('p.small', { style: { margin: '8px 0 0' } }, pill(b.ok ? 'Bilanz plausibel' : 'Bilanz außerhalb Toleranz', b.ok ? 'ok' : 'warn'), ' ',
        `${b.name}: Abweichung ${F.powerStr(b.deviation_w)} (Toleranz ${F.powerStr(b.tolerance_w)})`, infoI(`${b.formula}. Messpunkte: ${b.sources.join(', ')}. Rohdaten werden nicht verändert.`)));
    }
    clear(flowInfo).append(parts);
  }

  loadSparks(); loadSummary();
  const t1 = setInterval(loadSparks, 60000), t2 = setInterval(loadSummary, 120000);
  return {
    update(ov) { drawKpis(ov); flow.update(ov); drawStatus(ov); drawFlowInfo(ov); },
    destroy() { clearInterval(t1); clearInterval(t2); },
  };
}
