// Formulare zum Anlegen/Bearbeiten von Konfigurationsobjekten (Verwaltung, Bearer-Token erforderlich).
import { h, clear, modal, api, toast, admin, notice } from '../ui.js';

export function requireAdmin(app, then) {
  if (admin.token) return then();
  const inp = h('input.input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Admin-Token' });
  const err = h('div.form-errors');
  const dlg = modal('Verwaltung entsperren', [
    h('p.small.muted', 'Änderungen an der Konfiguration erfordern den Admin-Token (SOLARIS_ADMIN_TOKEN aus der Datei .env auf dem Server). Er wird nur für diese Browsersitzung gespeichert.'),
    h('div.field', h('label', 'Admin-Token'), inp), err,
  ], [h('button.btn.primary', { type: 'button', onclick: async () => {
    admin.token = inp.value.trim();
    try { await api('/api/admin/login', { method: 'POST' }); dlg.close(); toast('Verwaltung entsperrt'); then(); } catch (e) { admin.token = ''; err.textContent = e.message; }
  } }, 'Entsperren')]);
  inp.focus();
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') dlg.querySelector('.btn.primary').click(); });
}

const field = (label, input, hint, wide) => h('div.field', { class: wide ? 'wide' : '' }, h('label', label), input, hint ? h('span.hint', hint) : null);
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

/** Messpunkt-Editor. dp = bestehender oder vorbelegter Messpunkt. */
export function editDatapoint(app, dp, { isNew = false, onSaved } = {}) {
  requireAdmin(app, () => {
    const meta = app.config.meta;
    const d = { enabled: true, store: true, scale: 1, offset: 0, interval: 60, kind: 'power', unit: 'W', source: {}, ...dp };
    const integ = app.config.integrations.find((i) => i.id === d.integration) || app.config.integrations[0];
    const I = {};
    const inp = (k, attrs = {}) => (I[k] = h('input.input', { value: d[k] ?? '', ...attrs }));
    const sel = (k, opts) => (I[k] = h('select.input', opts.map(([v, t]) => h('option', { value: v, selected: String(d[k] ?? '') === String(v) }, t))));
    const srcType = () => app.config.integrations.find((i) => i.id === I.integration.value)?.type;
    const srcBox = h('div.form', { style: { gridColumn: '1 / -1' } });
    const drawSrc = () => {
      const t = srcType();
      clear(srcBox).append(t === 'mqtt' ? [
        field('MQTT-Topic', I.topic = h('input.input', { value: d.source.topic || '', placeholder: 'z. B. haus/zaehler/state' }), 'Wildcards + und # erlaubt'),
        field('JSON-Pfad (optional)', I.json_path = h('input.input', { value: d.source.json_path || '', placeholder: 'z. B. power oder $.data.0.value' }), 'Leer = Payload ist der Wert')]
        : t === 'demo' ? [field('Signal', I.signal = h('input.input', { value: d.source.signal || '' }))]
          : [field('Entity-ID', I.entity = h('input.input', { value: d.source.entity || '', placeholder: 'sensor.xyz' }), 'Home-Assistant-Entität')]);
    };
    const unitSel = h('select.input');
    const drawUnits = () => {
      const us = meta.kinds[I.kind.value] || [''];
      clear(unitSel).append(us.map((u) => h('option', { value: u, selected: u === d.unit }, u || '(ohne)')));
    };
    const roleOpts = [['', '– keine (nur anzeigen) –'], ...Object.entries(meta.roles).map(([k, v]) => [k, `${v} (${k})`])];
    const err = h('div.form-errors');
    const form = h('div.form',
      field('ID', inp('id', { disabled: !isNew, pattern: '[a-z0-9][a-z0-9_-]*' }), 'a–z, 0–9, _ und -; nicht änderbar'),
      field('Anzeigename', inp('name')),
      field('Gerät', sel('device', app.config.devices.map((x) => [x.id, x.name]))),
      field('Datenquelle', sel('integration', app.config.integrations.map((x) => [x.id, `${x.name} (${x.type})`]))),
      srcBox,
      field('Messwerttyp', sel('kind', Object.keys(meta.kinds).map((k) => [k, k]))),
      field('Einheit der Quelle', unitSel, 'Wird zentral in die kanonische Einheit umgerechnet'),
      field('Rolle', sel('role', roleOpts), 'Für Berechnungen; pro Rolle nur ein aktiver Messpunkt', true),
      field('Vorzeichenkonvention', sel('sign_convention', [['', '– keine –'], ['import_positive', 'Netz: + = Bezug'], ['export_positive', 'Netz: + = Einspeisung'], ['charge_positive', 'Batterie: + = Laden'], ['discharge_positive', 'Batterie: + = Entladen']]),
        'Pflicht für grid_power / battery_power'),
      field('Skalierungsfaktor', inp('scale', { type: 'number', step: 'any' })),
      field('Offset', inp('offset', { type: 'number', step: 'any' })),
      field('Minimum (Gültigkeit)', inp('min', { type: 'number', step: 'any' })),
      field('Maximum (Gültigkeit)', inp('max', { type: 'number', step: 'any' })),
      field('Aktualisierungsintervall (s)', inp('interval', { type: 'number', min: 1 })),
      field('Veraltet nach (s)', inp('stale_after', { type: 'number', min: 5, placeholder: 'Standard: 3 × Intervall + 30' })),
      field('Gruppe', inp('group')), field('Index (String/Phase/Modul)', inp('index', { type: 'number' })),
      field('Beschreibung', I.description = h('textarea.input', { style: { fontFamily: 'inherit', minHeight: '60px' } }, d.description || ''), null, true),
      h('label.check', I.enabled = h('input', { type: 'checkbox', checked: d.enabled }), 'Aktiv'),
      h('label.check', I.store = h('input', { type: 'checkbox', checked: d.store }), 'Historie speichern'),
      h('label.check', I.invert = h('input', { type: 'checkbox', checked: d.invert }), 'Vorzeichen umkehren'),
      h('label.check', I.partial = h('input', { type: 'checkbox', checked: d.partial }), 'Teilmessung'),
      h('label.check', I.estimated = h('input', { type: 'checkbox', checked: d.estimated }), 'Schätz-/Rechenwert der Quelle'),
    );
    I.integration.addEventListener('change', drawSrc);
    I.kind.addEventListener('change', drawUnits);
    drawSrc(); drawUnits();
    const collect = () => {
      const t = srcType();
      const source = t === 'mqtt' ? { topic: I.topic.value.trim(), ...(I.json_path.value.trim() ? { json_path: I.json_path.value.trim() } : {}) }
        : t === 'demo' ? { signal: I.signal.value.trim() } : { entity: I.entity.value.trim() };
      return { ...dp, id: I.id.value.trim(), name: I.name.value.trim(), device: I.device.value, integration: I.integration.value, source,
        kind: I.kind.value, unit: unitSel.value, role: I.role.value || null, sign_convention: I.sign_convention.value || null,
        scale: num(I.scale.value) ?? 1, offset: num(I.offset.value) ?? 0, min: num(I.min.value), max: num(I.max.value),
        interval: num(I.interval.value) ?? 60, stale_after: num(I.stale_after.value), group: I.group.value || null, index: num(I.index.value),
        description: I.description.value || null, enabled: I.enabled.checked, store: I.store.checked, invert: I.invert.checked,
        partial: I.partial.checked, estimated: I.estimated.checked };
    };
    const dlg = modal(isNew ? 'Messpunkt anlegen' : `Messpunkt bearbeiten: ${d.name}`, [form, err], [
      !isNew ? h('button.btn.danger', { type: 'button', onclick: async () => {
        if (!confirm(`Messpunkt „${d.name}“ löschen? Gespeicherte Historie bleibt in der Datenbank erhalten.`)) return;
        try { await api(`/api/admin/datapoints/${encodeURIComponent(d.id)}`, { method: 'DELETE' }); dlg.close(); toast('Messpunkt gelöscht'); await app.reloadConfig(); onSaved?.(); } catch (e) { err.textContent = e.message; }
      } }, 'Löschen') : null,
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      h('button.btn.primary', { type: 'button', onclick: async () => {
        const body = collect();
        try {
          await api(`/api/admin/datapoints/${encodeURIComponent(body.id)}`, { method: 'PUT', body });
          dlg.close(); toast('Gespeichert – Datenquellen werden neu geladen'); await app.reloadConfig(); onSaved?.(body);
        } catch (e) { err.textContent = e.message; if (e.status === 401) admin.token = ''; }
      } }, 'Speichern'),
    ]);
  });
}

export function editDevice(app, dev, { isNew = false, onSaved } = {}) {
  requireAdmin(app, () => {
    const d = { device_class: 'other', ...dev };
    const I = {};
    const inp = (k, a = {}) => (I[k] = h('input.input', { value: d[k] ?? '', ...a }));
    const classes = ['inverter', 'battery_inverter', 'battery', 'pv', 'grid_meter', 'submeter', 'virtual_meter', 'sensor', 'other'];
    const err = h('div.form-errors');
    const form = h('div.form',
      field('ID', inp('id', { disabled: !isNew })), field('Name', inp('name')), field('Hersteller', inp('manufacturer')), field('Modell', inp('model')),
      field('Geräteklasse', I.device_class = h('select.input', classes.map((c) => h('option', { value: c, selected: c === d.device_class }, c)))),
      field('Schnittstelle / Protokoll', inp('protocol')), field('IP-Adresse / Host', inp('host'), 'Nur angeben, wenn tatsächlich bekannt'),
      field('Seriennummer', inp('serial')), field('Firmware', inp('firmware')),
      field('Verfügbarkeits-Messpunkt', I.av = h('select.input', [h('option', { value: '' }, '– keiner –'), ...app.config.datapoints.filter((x) => x.kind === 'state').map((x) =>
        h('option', { value: x.id, selected: d.availability?.datapoint === x.id }, x.name))]), 'Statusmesspunkt, dessen Wert „offline“ bedeutet'),
      field('Offline-Werte', I.offv = h('input.input', { value: (d.availability?.offline_values || ['offline']).join(', ') }), 'Kommagetrennt'),
      field('Notizen', I.notes = h('textarea.input', { style: { fontFamily: 'inherit', minHeight: '60px' } }, d.notes || ''), null, true));
    const dlg = modal(isNew ? 'Gerät anlegen' : `Gerät bearbeiten: ${d.name}`, [form, err], [
      !isNew ? h('button.btn.danger', { type: 'button', onclick: async () => {
        if (!confirm(`Gerät „${d.name}“ löschen? Nur möglich, wenn keine Messpunkte zugeordnet sind.`)) return;
        try { await api(`/api/admin/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' }); dlg.close(); await app.reloadConfig(); onSaved?.(); } catch (e) { err.textContent = e.message; }
      } }, 'Löschen') : null,
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      h('button.btn.primary', { type: 'button', onclick: async () => {
        const nul = (v) => (v.trim() === '' ? null : v.trim());
        const body = { ...dev, id: I.id.value.trim(), name: I.name.value.trim(), manufacturer: nul(I.manufacturer.value), model: nul(I.model.value),
          device_class: I.device_class.value, protocol: nul(I.protocol.value), host: nul(I.host.value), serial: nul(I.serial.value), firmware: nul(I.firmware.value),
          availability: I.av.value ? { datapoint: I.av.value, offline_values: I.offv.value.split(',').map((x) => x.trim()).filter(Boolean) } : null, notes: nul(I.notes.value) };
        try { await api(`/api/admin/devices/${encodeURIComponent(body.id)}`, { method: 'PUT', body }); dlg.close(); toast('Gerät gespeichert'); await app.reloadConfig(); onSaved?.(); } catch (e) { err.textContent = e.message; }
      } }, 'Speichern')]);
  });
}

export function editIntegration(app, integ, { isNew = false, onSaved } = {}) {
  requireAdmin(app, () => {
    const d = { type: 'mqtt', enabled: false, interval: 15, timeout: 5, tls: false, ...integ };
    const I = {};
    const inp = (k, a = {}) => (I[k] = h('input.input', { value: d[k] ?? '', ...a }));
    const err = h('div.form-errors');
    const form = h('div.form',
      field('ID', inp('id', { disabled: !isNew })), field('Name', inp('name')),
      field('Typ', I.type = h('select.input', { disabled: !isNew }, [['mqtt', 'MQTT-Broker'], ['homeassistant', 'Home Assistant REST'], ['prometheus', 'Prometheus (HA-Metriken)'], ['demo', 'Simulation']]
        .map(([v, t]) => h('option', { value: v, selected: v === d.type }, t)))),
      field('Host (MQTT)', inp('host', { placeholder: '127.0.0.1' })), field('Port', inp('port', { type: 'number' })),
      field('URL (HA/Prometheus)', inp('url', { placeholder: 'http://127.0.0.1:8123' })),
      field('Job (Prometheus)', inp('job', { placeholder: 'homeassistant' })),
      field('Benutzername (Variable)', inp('username_env', { placeholder: 'SOLARIS_MQTT_USERNAME' }), 'Name der Umgebungsvariable in .env – nie das Geheimnis selbst'),
      field('Passwort (Variable)', inp('password_env', { placeholder: 'SOLARIS_MQTT_PASSWORD' })),
      field('Token (Variable)', inp('token_env', { placeholder: 'SOLARIS_HA_TOKEN' })),
      field('Abfrageintervall (s)', inp('interval', { type: 'number', min: 1 })), field('Timeout (s)', inp('timeout', { type: 'number', step: 'any' })),
      h('label.check', I.tls = h('input', { type: 'checkbox', checked: d.tls }), 'TLS verwenden'),
      h('label.check', I.enabled = h('input', { type: 'checkbox', checked: d.enabled }), 'Aktiviert'),
      field('Notizen', I.notes = h('textarea.input', { style: { fontFamily: 'inherit', minHeight: '50px' } }, d.notes || ''), null, true));
    const dlg = modal(isNew ? 'Datenquelle anlegen' : `Datenquelle: ${d.name}`, [notice('info', 'Passwörter und Tokens werden ausschließlich in der Datei .env auf dem Server hinterlegt. Hier wird nur der Variablenname eingetragen.'), form, err], [
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      h('button.btn.primary', { type: 'button', onclick: async () => {
        const nul = (v) => (String(v).trim() === '' ? null : String(v).trim());
        const body = { ...integ, id: I.id.value.trim(), name: I.name.value.trim(), type: I.type.value, host: nul(I.host.value), port: num(I.port.value),
          url: nul(I.url.value), job: nul(I.job.value), username_env: nul(I.username_env.value), password_env: nul(I.password_env.value), token_env: nul(I.token_env.value),
          interval: num(I.interval.value) ?? 15, timeout: num(I.timeout.value) ?? 5, tls: I.tls.checked, enabled: I.enabled.checked, notes: nul(I.notes.value) };
        try { await api(`/api/admin/integrations/${encodeURIComponent(body.id)}`, { method: 'PUT', body }); dlg.close(); toast('Datenquelle gespeichert'); await app.reloadConfig(); onSaved?.(); } catch (e) { err.textContent = e.message; }
      } }, 'Speichern')]);
  });
}
