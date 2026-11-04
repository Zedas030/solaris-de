import { h, clear, card, kpi, kpiFromRole, pill, notice, infoI } from '../ui.js';
import * as F from '../format.js';
import { historyCard, HEX, energyBuckets, unavailableList } from './common.js';

export async function render(root, app) {
  const kpis = h('div.grid.kpis');
  const strings = h('div');
  const missing = h('div');
  root.append(
    kpis,
    card('PV-Strings / MPPT-Eingänge', { info: 'Werte je PV-Eingang, sofern die Hardware sie liefert. Bei dieser Anlage stammen sie aus der Growatt-Cloud (HA growatt_server).' }, strings),
    historyCard(app, { title: 'PV-Leistung', key: 'pv-power', spec: [
      { role: 'pv_power', name: 'PV-Leistung (DC/Eingang)', color: HEX.pv, area: true },
      { role: 'inverter_output_power', name: 'AC-Ausgang', color: HEX.inverter },
      ...[1, 2, 3, 4].map((i) => ({ id: `cloud_pv${i}_power`, name: `Eingang ${i}`, color: HEX.extra[i - 1], dash: '4 3' }))] }),
    energyBuckets(app, { title: 'Tageserträge der letzten 30 Tage', key: 'pv-days', group: 'day', range: '30d', metrics: ['pv'],
      info: 'Tageswerte aus dem Tageszähler des Geräts (letzter Wert des Tages); fehlende Tage = keine Daten.' }),
    energyBuckets(app, { title: 'Monatserträge', key: 'pv-months', group: 'month', period: 'year', metrics: ['pv'],
      info: 'Summe der gespeicherten Tageswerte je Monat. Monate ohne gespeicherte Historie fehlen.' }),
    card('Nicht verfügbare Kennwerte', { sub: 'Diese Werte liefert die angebundene Hardware/Schnittstelle derzeit nicht. Sie werden nicht geschätzt.' }, missing),
  );

  function update(ov) {
    const k = ov.kpis, d = ov.derived || {};
    const v = (b) => b?.values?.pv;
    const eKpi = (label, x, tip) => kpi({ label, iconName: 'sun', accent: 'var(--pv)', value: x ? F.energy(x.kwh)[0] : null, unit: x ? F.energy(x.kwh)[1] : '',
      status: x ? 'good' : 'unavailable', tip, foot: x ? [h('span', x.days_with_data !== undefined ? `${x.days_with_data} Tage mit Daten` : x.basis === 'counter' ? 'Tageszähler' : 'integriert')] : [] });
    const kwp = app.config.site.pv_peak_kwp;
    const eff = d.efficiency;
    clear(kpis).append(
      kpiFromRole(k.pv_power, { label: 'DC-/Eingangsleistung', iconName: 'sun', accent: 'var(--pv)' }),
      kpiFromRole(k.inverter_output_power, { label: 'AC-Leistung', iconName: 'inverter', accent: 'var(--inverter)' }),
      eKpi('Tagesertrag', v(d.today), 'Tageszähler des Geräts.'),
      eKpi('Monatsertrag', v(d.month), 'Summe der gespeicherten Tageswerte.'),
      eKpi('Jahresertrag', v(d.year), 'Summe der gespeicherten Tageswerte – nur Tage mit Daten.'),
      kpiFromRole(k.pv_energy_total, { label: 'Gesamtertrag (Zählerstand)', iconName: 'sun', accent: 'var(--pv)', kind: 'energy' }),
      kpi({ label: 'Installierte Leistung', iconName: 'panel', accent: 'var(--pv)', value: kwp ? F.fmtNumber(kwp, 2) : null, unit: 'kWp',
        status: kwp ? 'good' : 'unavailable', naText: 'Nicht konfiguriert', foot: [h('span', kwp ? 'aus Einstellungen' : 'In Einstellungen → Anlage eintragen')] }),
      kpi({ label: 'Spezifischer Ertrag (Jahr)', iconName: 'chart', accent: 'var(--pv)', value: d.specific_yield_year?.available ? F.fmtNumber(d.specific_yield_year.value, 0) : null,
        unit: 'kWh/kWp', status: d.specific_yield_year?.available ? 'good' : 'unavailable', naText: 'Nicht verfügbar', foot: [h('span', d.specific_yield_year?.reason || '')] }),
      kpi({ label: 'Umwandlungsgrad (momentan)', iconName: 'bolt', accent: 'var(--inverter)', value: eff?.available ? F.fmtNumber(eff.percent, 1) : null, unit: '%',
        status: eff?.available ? 'good' : 'unavailable', naText: 'Nicht verfügbar', foot: [h('span', eff?.available ? `Eingang ${F.powerStr(eff.input_w)}` : eff?.reason || '')],
        tip: 'AC-Ausgang / (PV − Laden + Entladen) aus einem gemeinsamen Datensatz derselben Quelle; nur ab 100 W Eingangsleistung.' }),
    );
    // Strings
    const idx = [...new Set(app.byRole('string_power').concat(app.byRole('string_voltage')).map((dp) => dp.index))].sort();
    if (!idx.length) { clear(strings).append(h('div.empty', 'Keine Stringüberwachung konfiguriert bzw. von der Hardware nicht unterstützt.')); }
    else {
      const anyGood = idx.some((i) => ['string_power', 'string_voltage', 'string_current'].some((r) => app.byRole(r).find((x) => x.index === i && app.cur(x.id)?.quality === 'good')));
      const cards = idx.map((i) => {
        const get = (role) => { const dp = app.byRole(role).find((x) => x.index === i); return dp ? { dp, c: app.cur(dp.id) || {} } : null; };
        const p = get('string_power'), u = get('string_voltage'), a = get('string_current'), e = get('string_energy_today');
        const val = (x, unit, kind) => !x ? 'nicht vorhanden' : x.c.quality === 'good' ? F.valueStr(x.c.value, unit, kind) : '–';
        const lastTs = [p, u, a, e].map((x) => x?.c.last_good_ts).filter(Boolean).sort().pop();
        const q = p?.c.quality || 'unavailable';
        const share = p?.c.quality === 'good' && F.isNum(p.c.value) && F.isNum(k.pv_power.value) && k.pv_power.value > 0 ? p.c.value / k.pv_power.value : null;
        return h('div.card', { style: { padding: '14px 16px' } },
          h('div.card-h', { style: { marginBottom: '8px' } }, h('h3', `Eingang ${i}`), h('span.spacer'), pill(F.qualityLabel(q), F.qualityClass(q))),
          h('div.kpi-value', { style: { fontSize: '26px' } }, val(p, 'W', 'power')),
          h('div.bar', { style: { margin: '8px 0', '--c': 'var(--pv)' } }, h('i', { style: { width: `${share !== null ? Math.min(100, share * 100) : 0}%` } })),
          h('dl.kv', h('dt', 'Spannung'), h('dd', val(u, 'V')), h('dt', 'Strom'), h('dd', val(a, 'A')), h('dt', 'Ertrag heute'), h('dd', val(e, 'kWh', 'energy')),
            h('dt', 'Letzter gültiger Wert'), h('dd', lastTs ? F.dateTime(lastTs) : 'nie')));
      });
      clear(strings).append(!anyGood ? notice('warn', 'Derzeit keine aktuellen Stringdaten – die Growatt-Cloud-Werte sind in Home Assistant nicht verfügbar. Angezeigt werden nur gültige Werte.') : null,
        h('div.grid.cols-2', { style: { marginTop: '12px', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' } }, cards));
    }
    const has = (r) => app.byRole(r).length > 0;
    const list = [];
    if (!has('dc_voltage')) list.push(['DC-Spannung gesamt', 'Kein Messpunkt (nur je Eingang, siehe Strings)']);
    if (!has('ac_voltage')) list.push(['AC-Spannung', 'Von noah-mqtt / Growatt-Cloud nicht geliefert']);
    if (!has('ac_current')) list.push(['AC-Strom', 'Nicht geliefert']);
    if (!has('phase_power')) list.push(['Leistung je Phase', 'Einphasiges Balkongerät bzw. nicht geliefert']);
    if (!has('inverter_runtime')) list.push(['Laufzeit', 'Nicht geliefert']);
    if (!has('device_message')) list.push(['Gerätemeldungen / Fehlercodes', 'Schnittstelle liefert keine Fehlercodes']);
    clear(missing).append(list.length ? unavailableList(list) : h('div.empty', 'Alle Kennwerte verfügbar.'));
  }
  return { update };
}
