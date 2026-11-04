import { h, clear, card, pill, api, notice } from '../ui.js';
import * as F from '../format.js';
import { dpTable, statusLed } from './common.js';
import { editDatapoint, editDevice } from './editors.js';

export async function render(root, app, params) {
  const devId = params?.[0];
  if (devId) return renderDevice(root, app, decodeURIComponent(devId));
  const devBox = h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' } });
  const filter = h('input.input', { type: 'search', placeholder: 'Messpunkte filtern (Name, ID, Rolle, Quelle) …', 'aria-label': 'Filter', style: { maxWidth: '420px' } });
  const dpBox = h('div');
  root.append(
    card('Geräte', { right: h('button.btn.sm', { type: 'button', onclick: () => editDevice(app, {}, { isNew: true, onSaved: rerender }) }, '+ Gerät') }, devBox),
    card('Messpunkte', { right: h('button.btn.sm', { type: 'button', onclick: () => editDatapoint(app, {}, { isNew: true, onSaved: rerender }) }, '+ Messpunkt'),
      sub: 'Alle konfigurierten Messpunkte mit Zuordnung, Einheit und Status. Klick auf eine Zeile zum Bearbeiten (Admin-Token erforderlich).' }, filter, h('div', { style: { height: '12px' } }), dpBox));
  function rerender() { location.reload(); }
  function drawDevs(ov) {
    clear(devBox).append(app.config.devices.map((d) => {
      const st = ov.status.devices.find((x) => x.id === d.id) || {};
      return h('a.card', { href: `#/devices/${encodeURIComponent(d.id)}`, style: { textDecoration: 'none', color: 'inherit', display: 'block' } },
        h('div.card-h', h('h3', d.name), h('span.spacer'), h('span.status-item', statusLed(st.state), F.DEVICE_STATE[st.state]?.[0] || st.state)),
        h('dl.kv', h('dt', 'Klasse'), h('dd', d.device_class), h('dt', 'Hersteller / Modell'), h('dd', [d.manufacturer, d.model].filter(Boolean).join(' ') || '–'),
          h('dt', 'Schnittstelle'), h('dd', d.protocol || '–'), h('dt', 'Letzter Kontakt'), h('dd', st.last_contact ? F.ago(st.last_contact) : '–'),
          h('dt', 'Messpunkte'), h('dd', `${st.good ?? 0} / ${st.datapoints ?? 0} gültig`)));
    }));
  }
  function drawDps() {
    const q = filter.value.toLowerCase();
    const rows = app.config.datapoints.filter((d) => !q || [d.name, d.id, d.role, d.integration, d.source.topic, d.source.entity].join(' ').toLowerCase().includes(q));
    clear(dpBox).append(h('div.table-wrap', h('table.tbl',
      h('thead', h('tr', h('th', 'Name / ID'), h('th', 'Gerät'), h('th', 'Quelle'), h('th', 'Typ / Einheit'), h('th', 'Rolle'), h('th', 'Intervall'), h('th', 'Status'), h('th.r', 'Wert'))),
      h('tbody', rows.map((d) => {
        const c = app.cur(d.id) || {};
        return h('tr.click', { tabindex: 0, onclick: () => editDatapoint(app, d, { onSaved: rerender }), onkeydown: (e) => { if (e.key === 'Enter') editDatapoint(app, d, { onSaved: rerender }); } },
          h('td', d.name, h('div.xs.faint.mono', d.id)), h('td.small', app.device(d.device)?.name || d.device),
          h('td.small', d.integration, h('div.xs.faint.mono', d.source.topic ? `${d.source.topic}${d.source.json_path ? ' → ' + d.source.json_path : ''}` : d.source.entity || d.source.signal || '')),
          h('td.small', d.kind, h('div.xs.faint', `${d.unit || '–'} → ${app.config.meta.canonical_units[d.kind] || '–'}${d.scale !== 1 ? ` · ×${d.scale}` : ''}${d.offset ? ` · ${d.offset >= 0 ? '+' : ''}${d.offset}` : ''}${d.sign_convention ? ' · ' + d.sign_convention : ''}`)),
          h('td.small.mono', d.role || '–'), h('td.small.num', `${d.interval} s`),
          h('td', d.enabled ? pill(F.qualityLabel(c.quality || 'unavailable'), F.qualityClass(c.quality || 'unavailable')) : pill('deaktiviert', 'off')),
          h('td.r.num.small', c.quality === 'good' ? F.valueStr(d.kind === 'state' ? c.text : c.value, app.config.meta.canonical_units[d.kind], d.kind) : '–'));
      })))));
  }
  filter.addEventListener('input', drawDps);
  drawDps();
  return { update(ov) { drawDevs(ov); drawDps(); } };
}

function renderDevice(root, app, id) {
  const d = app.device(id);
  if (!d) { root.append(notice('err', `Gerät „${id}“ ist nicht konfiguriert.`), h('a', { href: '#/devices' }, 'Zur Geräteübersicht')); return {}; }
  const info = h('div');
  const table = h('div');
  const ev = h('div', h('div.empty', 'Lade …'));
  root.append(h('div.actions', h('a.btn.sm', { href: '#/devices' }, '‹ Alle Geräte'), h('button.btn.sm', { type: 'button', onclick: () => editDevice(app, d, { onSaved: () => location.reload() }) }, 'Bearbeiten')),
    card(d.name, {}, info), card('Zugeordnete Messpunkte', {}, table), card('Letzte Fehler & Warnungen', {}, ev));
  api(`/api/events?device=${encodeURIComponent(id)}&limit=20`).then((r) => {
    const list = r.events.filter((e) => e.severity !== 'info');
    clear(ev).append(list.length ? h('ul.summary-list', list.map((e) => h('li', h('i', { style: { '--c': e.severity === 'error' ? 'var(--error)' : 'var(--warn)' } }),
      h('div', h('div', e.message), h('div.xs.faint', F.dateTime(e.ts)))))) : h('div.empty', 'Keine Fehler oder Warnungen protokolliert.'));
  });
  return {
    update(ov) {
      const st = ov.status.devices.find((x) => x.id === id) || {};
      clear(info).append(h('dl.kv',
        h('dt', 'Status'), h('dd', h('span.status-item', statusLed(st.state), F.DEVICE_STATE[st.state]?.[0] || st.state)),
        h('dt', 'Geräteklasse'), h('dd', d.device_class), h('dt', 'Hersteller'), h('dd', d.manufacturer || 'nicht angegeben'), h('dt', 'Modell'), h('dd', d.model || 'nicht angegeben'),
        h('dt', 'Schnittstelle'), h('dd', d.protocol || '–'), h('dt', 'Host'), h('dd', d.host || '–'),
        h('dt', 'Seriennummer'), h('dd', d.serial || 'nicht verfügbar'), h('dt', 'Version / Firmware'), h('dd', d.firmware || 'nicht verfügbar'),
        h('dt', 'Letzter Kontakt'), h('dd', st.last_contact ? `${F.dateTime(st.last_contact)} (${F.ago(st.last_contact)})` : 'kein gültiger Messwert'),
        d.availability ? [h('dt', 'Verfügbarkeit'), h('dd', `über Messpunkt ${d.availability.datapoint} (offline bei: ${d.availability.offline_values.join(', ')})`)] : null),
      d.notes ? h('p.small.muted', d.notes) : null);
      clear(table).append(dpTable(app, app.config.datapoints.filter((x) => x.device === id && x.enabled)));
    },
  };
}
