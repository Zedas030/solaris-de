import { h, clear, card, pill, segmented, api, notice } from '../ui.js';
import * as F from '../format.js';
import { warningsList } from './common.js';

const SEV = { info: ['Information', 'info'], warning: ['Warnung', 'warn'], error: ['Fehler', 'err'] };

export async function render(root, app) {
  let sev = '', offset = 0;
  const limit = 50;
  const active = h('div');
  const list = h('div', h('div.empty', 'Lade …'));
  const pager = h('div.actions', { style: { marginTop: '12px' } });
  root.append(
    card('Aktuelle Warnungen', { sub: 'Zustände, die gerade bestehen. Sie verschwinden automatisch, wenn der Zustand behoben ist.' }, active),
    card('Ereignisprotokoll', { right: segmented([['', 'Alle'], ['info', 'Information'], ['warning', 'Warnung'], ['error', 'Fehler']], sev, (v) => { sev = v; offset = 0; load(); }, 'Schweregrad') }, list, pager));

  async function load() {
    try {
      const d = await api(`/api/events?limit=${limit}&offset=${offset}${sev ? `&severity=${sev}` : ''}`);
      clear(list).append(d.events.length ? h('div.table-wrap', h('table.tbl',
        h('thead', h('tr', h('th', 'Zeitpunkt'), h('th', 'Schweregrad'), h('th', 'Beschreibung'), h('th', 'Gerät'), h('th', 'Messpunkt'))),
        h('tbody', d.events.map((e) => h('tr',
          h('td.small.num', F.dateTime(e.ts)), h('td', pill(...SEV[e.severity])),
          h('td', e.message, e.details ? h('details', h('summary.xs.faint', 'Details'), h('pre.mono', { style: { whiteSpace: 'pre-wrap', margin: '4px 0 0' } }, JSON.stringify(e.details, null, 2))) : null),
          h('td.small', e.device ? (app.device(e.device)?.name || e.device) : '–'), h('td.small.mono', e.datapoint || '–'))))))
        : h('div.empty', sev ? 'Keine Ereignisse dieses Schweregrads.' : 'Noch keine Ereignisse protokolliert.'));
      clear(pager).append(
        h('button.btn.sm', { type: 'button', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - limit); load(); } }, 'Neuere'),
        h('span.small.muted', `${d.total ? offset + 1 : 0}–${Math.min(offset + limit, d.total)} von ${d.total}`),
        h('button.btn.sm', { type: 'button', disabled: offset + limit >= d.total, onclick: () => { offset += limit; load(); } }, 'Ältere'));
    } catch (e) { clear(list).append(notice('err', e.message)); }
  }
  load();
  const t = setInterval(() => { if (offset === 0) load(); }, 30000);
  return { update: (ov) => clear(active).append(warningsList(ov.status.warnings, 50)), destroy: () => clearInterval(t) };
}
