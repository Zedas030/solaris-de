import { h, clear, card, kpi, kpiFromRole, notice, pill } from '../ui.js';
import * as F from '../format.js';
import { historyCard, HEX, energyBuckets, dpTable } from './common.js';

export async function render(root, app) {
  const roles = ['grid_power', 'grid_import_power', 'grid_export_power', 'grid_import_today', 'grid_export_today', 'grid_import_total', 'grid_export_total'];
  const configured = roles.some((r) => app.byRole(r).length);
  const kpis = h('div.grid.kpis');
  const phases = h('div');
  const gp = app.byRole('grid_power')[0];
  clear(root).append(
    !configured ? card('Netzanschluss nicht konfiguriert', {},
      notice('info', 'Es ist kein Netz- bzw. Zweirichtungszähler eingebunden. Netzbezug und Einspeisung werden deshalb nicht angezeigt und nicht geschätzt.'),
      h('p', 'Für Netzbezug, Einspeisung, Eigenverbrauchsquote und Autarkiegrad wird ein Messpunkt am Netzanschluss benötigt, z. B.:'),
      h('ul.small', h('li', 'IR-Lesekopf am modernen Messeinrichtung (z. B. Tasmota/Hichi → MQTT)'), h('li', 'Shelly Pro 3EM / EM im Zählerschrank'),
        h('li', 'Tibber Pulse, Smart-Meter-Gateway oder vorhandener Home-Assistant-Sensor')),
      h('p.small.muted', 'Einbindung unter ', h('a', { href: '#/integrations' }, 'Datenquellen'), ' mit Rolle „grid_power“ und dokumentierter Vorzeichenkonvention ',
        '(import_positive: + = Bezug, − = Einspeisung; export_positive: umgekehrt) oder getrennt mit „grid_import_power“/„grid_export_power“.'),
      app.byRole('house_power')[0]?.partial ? h('p.small.muted', 'Hinweis: Eine Berechnung als „Hausverbrauch − Wechselrichter-Ausgang“ ist nicht möglich, weil der Hausverbrauch nur eine Teilmessung ist.') : null) : null,
    gp ? notice('info', `Vorzeichenkonvention des Messpunkts „${gp.name}“: ${gp.sign_convention === 'import_positive' ? '+ = Netzbezug, − = Einspeisung' : '+ = Einspeisung, − = Netzbezug'}. SOLARIS rechnet zentral auf „+ = Bezug“ um.`) : null,
    kpis,
    configured ? historyCard(app, { title: 'Netzleistung', key: 'grid-power', spec: [
      { role: 'grid_power', name: 'Netz (+Bezug/−Einspeisung)', color: HEX.grid_import },
      { role: 'grid_import_power', name: 'Netzbezug', color: HEX.grid_import, area: true }, { role: 'grid_export_power', name: 'Einspeisung', color: HEX.grid_export, negate: true, area: true }] }) : null,
    configured ? energyBuckets(app, { title: 'Bezug und Einspeisung je Tag', key: 'grid-days', group: 'day', range: '30d', metrics: ['grid_import', 'grid_export'] }) : null,
    phases,
    card('Netzbezogene Messwerte anderer Geräte', { sub: 'Vom Wechselrichter gemessen – kein Netzzähler.' },
      dpTable(app, app.config.datapoints.filter((d) => d.enabled && ['grid_frequency', 'grid_voltage'].includes(d.role)))),
  );

  function update(ov) {
    const k = ov.kpis;
    const fr = app.byRole('grid_frequency')[0];
    const c = fr && app.cur(fr.id);
    clear(kpis).append(
      kpiFromRole(k.grid_import_power, { label: 'Netzbezug (momentan)', iconName: 'grid', accent: 'var(--import)' }),
      kpiFromRole(k.grid_export_power, { label: 'Einspeisung (momentan)', iconName: 'grid', accent: 'var(--export)' }),
      kpiFromRole(k.grid_import_today, { label: 'Bezug heute', kind: 'energy', iconName: 'grid', accent: 'var(--import)' }),
      kpiFromRole(k.grid_export_today, { label: 'Einspeisung heute', kind: 'energy', iconName: 'grid', accent: 'var(--export)' }),
      kpiFromRole(fr ? { value: c?.value, unit: 'Hz', status: c?.quality || 'unavailable', timestamp: c?.timestamp, explain: `${fr.name} (gemessen vom Wechselrichter)` } : null,
        { label: 'Netzfrequenz', kind: 'freq', iconName: 'bolt', accent: 'var(--inverter)' }),
    );
    const pp = app.byRole('phase_power');
    if (pp.length) {
      const vals = pp.map((d) => ({ d, c: app.cur(d.id) })).sort((a, b) => a.d.index - b.d.index);
      const ws = vals.map((v) => (v.c?.quality === 'good' ? v.c.value : null)).filter(F.isNum);
      const avg = ws.length ? ws.reduce((a, b) => a + Math.abs(b), 0) / ws.length : 0;
      const imb = ws.length === 3 && avg > 50 ? (Math.max(...ws.map(Math.abs)) - Math.min(...ws.map(Math.abs))) / avg * 100 : null;
      const lim = app.config.settings.thresholds.phase_imbalance_pct;
      clear(phases).append(card('Phasen', {},
        h('div.grid.cols-3', vals.map((v) => kpi({ label: `L${v.d.index}`, iconName: 'bolt', accent: 'var(--import)', value: v.c?.quality === 'good' ? F.power(v.c.value)[0] : null, unit: F.power(v.c?.value)[1], status: v.c?.quality }))),
        imb !== null ? h('p', pill(imb > lim ? 'Schieflast' : 'ausgeglichen', imb > lim ? 'warn' : 'ok'), ` Abweichung ${F.fmtNumber(imb, 0)} % vom Mittel (Grenze ${lim} %)`) : null));
    }
  }
  return { update };
}
