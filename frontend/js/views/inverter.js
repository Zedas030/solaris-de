import { h, clear, card, kpiFromRole, pill, notice, api } from '../ui.js';
import * as F from '../format.js';
import { historyCard, HEX, dpTable, statusLed } from './common.js';

export async function render(root, app) {
  const devs = app.config.devices.filter((d) => ['inverter', 'battery_inverter'].includes(d.device_class));
  const kpis = h('div.grid.kpis');
  const details = h('div.grid.cols-2');
  const tables = h('div.grid');
  const events = h('div', h('div.empty', 'Lade …'));
  root.append(kpis, details,
    historyCard(app, { title: 'Temperatur & Ausgangsleistung', key: 'inv-temp', kind: 'temperature', defRange: '7d',
      spec: [{ role: 'inverter_temperature', name: 'Wechselrichtertemperatur', color: HEX.temp }, { role: 'battery_temperature', name: 'Batteriemodul-Temperatur', color: HEX.soc }] }),
    tables,
    card('Fehler & Warnungen (Gerät)', { right: h('a.small', { href: '#/events' }, 'Alle Ereignisse') }, events));
  if (!devs.length) root.prepend(notice('warn', 'Kein Wechselrichter konfiguriert.'));

  api('/api/events?limit=200').then((d) => {
    const ids = new Set(devs.map((x) => x.id));
    const ev = d.events.filter((e) => ids.has(e.device)).slice(0, 15);
    clear(events).append(ev.length ? h('ul.summary-list', ev.map((e) => h('li', h('i', { style: { '--c': e.severity === 'error' ? 'var(--error)' : e.severity === 'warning' ? 'var(--warn)' : 'var(--house)' } }),
      h('div', h('div', e.message), h('div.xs.faint', F.dateTime(e.ts)))))) : h('div.empty', 'Keine Ereignisse zu diesem Gerät.'),
    h('p.xs.faint', 'Gerätemeldungen/Fehlercodes werden von der angebundenen Schnittstelle nicht geliefert; hier erscheinen von SOLARIS erkannte Zustandswechsel.'));
  }).catch(() => {});

  function update(ov) {
    const k = ov.kpis;
    const freq = app.byRole('grid_frequency')[0];
    const fc = freq && app.cur(freq.id);
    const temp = app.byRole('inverter_temperature')[0];
    const tc = temp && app.cur(temp.id);
    const asKpi = (dp, c, label, kind) => kpiFromRole(dp ? { label, value: dp.kind === 'state' ? c?.text : c?.value, unit: dp.unit, status: c?.quality || 'unavailable', timestamp: c?.timestamp,
      explain: dp.description || dp.name } : null, { label, kind, iconName: 'inverter', accent: 'var(--inverter)' });
    clear(kpis).append(
      kpiFromRole(k.inverter_output_power, { label: 'AC-Ausgangsleistung', iconName: 'inverter', accent: 'var(--inverter)' }),
      kpiFromRole(k.pv_power, { label: 'DC-/PV-Eingang', iconName: 'sun', accent: 'var(--pv)' }),
      asKpi(app.byRole('inverter_status')[0], app.cur(app.byRole('inverter_status')[0]?.id), 'Betriebszustand', 'state'),
      asKpi(app.byRole('inverter_mode')[0], app.cur(app.byRole('inverter_mode')[0]?.id), 'Betriebsmodus', 'state'),
      asKpi(temp, tc, 'Temperatur', 'temp'),
      asKpi(freq, fc, 'AC-Frequenz', 'freq'),
    );
    clear(details).append(devs.map((d) => {
      const st = ov.status.devices.find((x) => x.id === d.id) || {};
      return card(d.name, { right: h('span.status-item', statusLed(st.state), F.DEVICE_STATE[st.state]?.[0] || st.state) },
        h('dl.kv',
          h('dt', 'Hersteller / Modell'), h('dd', [d.manufacturer, d.model].filter(Boolean).join(' ') || 'nicht angegeben'),
          h('dt', 'Seriennummer'), h('dd', d.serial ? `${d.serial}` : 'nicht verfügbar', d.serial_source ? h('div.xs.faint', `Quelle: ${d.serial_source}`) : null),
          h('dt', 'Firmware'), h('dd', d.firmware || 'nicht verfügbar (von der Schnittstelle nicht geliefert)'),
          h('dt', 'Kommunikation'), h('dd', d.protocol || '–'),
          h('dt', 'IP-Adresse / Host'), h('dd', d.host || 'nicht zutreffend (Daten über Broker/Cloud)'),
          h('dt', 'Letzter Kontakt'), h('dd', st.last_contact ? `${F.dateTime(st.last_contact)} (${F.ago(st.last_contact)})` : 'kein gültiger Messwert'),
          h('dt', 'Messpunkte'), h('dd', `${st.good ?? 0} von ${st.datapoints ?? 0} aktuell gültig`)),
        d.notes ? h('p.small.muted', d.notes) : null);
    }));
    clear(tables).append(devs.map((d) => card(`Messwerte – ${d.name}`, {}, dpTable(app, app.config.datapoints.filter((x) => x.enabled && x.device === d.id)))));
  }
  return { update };
}
