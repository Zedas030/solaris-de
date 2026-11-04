# Konfiguration

Die gesamte Anlage wird in einer Datei beschrieben: `data/config/solaris.json`. Sie wird beim Start
und bei jeder Änderung über die Verwaltung vollständig mit Pydantic geprüft
(`backend/models/config_models.py`). Ist sie ungültig, nennt die Fehlermeldung Messpunkt und Ursache.
Eine lauffähige Vorlage mit Simulation ist `data/config/solaris.example.json`.

```text
solaris.json
├── version        immer 1
├── site           Name, Zeitzone, optionale Anlagendaten
├── settings       Anzeige, Schwellwerte, Aufbewahrung, Speichertakt
├── integrations   Datenquellen (MQTT, Prometheus, Home Assistant, Simulation)
├── devices        Geräte, zu denen Messpunkte gehören
└── datapoints     Messpunkte: Quelle, Einheit, Typ, Rolle
```

## Geheimnisse

Passwörter und Tokens stehen **nie** in `solaris.json`. Integrationen nennen nur die Namen von
Umgebungsvariablen (`username_env`, `password_env`, `token_env`), deren Werte in `.env` stehen.
Die Prüfung lehnt Felder ab, die nicht wie ein Variablenname aussehen. `SOLARIS_ADMIN_TOKEN` schützt
alle Endpunkte unter `/api/admin`. Ist er nicht gesetzt, ist die Verwaltung abgeschaltet.

| Variable | Zweck |
|---|---|
| `SOLARIS_ADMIN_TOKEN` | Bearer-Token für die Verwaltung (langer Zufallswert) |
| `SOLARIS_DATA_DIR` | anderer Datenordner statt `./data` |
| `SOLARIS_LOG_LEVEL` | `DEBUG`, `INFO`, `WARNING` |
| frei wählbar, z. B. `SOLARIS_HA_TOKEN` | Werte, auf die Integrationen per `*_env` verweisen |

## site

| Feld | Bedeutung |
|---|---|
| `name` | Anzeigename der Anlage |
| `timezone` | Zeitzone für Tageswerte, z. B. `Europe/Berlin` |
| `pv_peak_kwp` | installierte PV-Leistung, nur aus Datenblatt oder Anlagenpass |
| `battery_capacity_kwh` | nutzbare Speicherkapazität |
| `battery_reserve_soc` | untere Entladegrenze laut Gerät |

Unbekannte Anlagendaten bleiben `null`. SOLARIS rechnet dann nichts damit, statt zu raten.

## settings

| Bereich | Felder |
|---|---|
| `display` | `power_unit` (`auto`, `W`, `kW`), `kw_threshold_w`, `energy_unit` |
| `thresholds` | `soc_high`, `soc_low`, `soc_critical`, `balance_tolerance_w`, `balance_tolerance_pct`, `balance_min_duration_s`, `phase_imbalance_pct`, `battery_temp_max_c`, `battery_temp_min_c` |
| `retention` | `raw_days` (Rohwerte), `hourly_days` (`null` = unbegrenzt), `events_days` |
| `storage` | `heartbeat_s` (unveränderte Werte spätestens alle X s speichern), `max_gap_s` (ab hier gilt ein Abstand als Datenlücke) |
| oben | `tick_s` (Rechentakt), `default_chart_range` (`15m`, `1h`, `today`, `yesterday`, `7d`, `30d`) |

Die Energiebilanz meldet ein Ereignis, wenn PV, Haus, Speicher und Netz länger als
`balance_min_duration_s` um mehr als `balance_tolerance_w` **und** `balance_tolerance_pct` auseinanderliegen.

## integrations

| Typ | Pflichtfelder | Optional |
|---|---|---|
| `mqtt` | `host` | `port`, `tls`, `username_env`, `password_env`, `client_id` |
| `prometheus` | `url` | `job`, `interval`, `timeout` |
| `homeassistant` | `url` | `token_env`, `interval`, `timeout` |
| `demo` | – | `interval` |

Jede Integration hat `id`, `name` und `enabled`. In der Oberfläche unter „Datenquellen“ lässt sich
jede testen, und „Entdecken“ listet die Topics oder Entitäten auf, die sie gerade liefert.

## devices

| Feld | Bedeutung |
|---|---|
| `id`, `name` | Kennung (a–z, 0–9, `_`, `-`) und Anzeigename |
| `device_class` | `inverter`, `battery_inverter`, `battery`, `pv`, `grid_meter`, `submeter`, `virtual_meter`, `sensor`, `other` |
| `manufacturer`, `model`, `firmware`, `serial`, `serial_source` | Stammdaten |
| `protocol`, `host` | wie das Gerät angebunden ist |
| `availability` | Messpunkt und Werte, an denen „offline“ erkannt wird |

## datapoints

| Feld | Bedeutung |
|---|---|
| `id`, `name`, `device`, `integration` | Kennung und Zuordnung |
| `source` | MQTT: `{"topic": …, "json_path": …}` · Prometheus/HA: `{"entity": …}` · Simulation: `{"signal": …}` |
| `unit`, `kind` | gelieferte Einheit und Messgröße, siehe unten |
| `role` | Bedeutung für Bilanz und Ansichten, siehe unten |
| `scale`, `offset`, `invert` | Umrechnung des Rohwerts |
| `sign_convention` | Pflicht für `grid_power` (`import_positive`/`export_positive`) und `battery_power` (`charge_positive`/`discharge_positive`) |
| `min`, `max` | Plausibilitätsgrenzen |
| `interval`, `stale_after` | erwarteter Takt der Quelle; ohne `stale_after` gilt ein Wert nach 3 × `interval` + 30 s als veraltet |
| `store` | in der Historie speichern (Simulationswerte werden nie gespeichert) |
| `partial`, `estimated` | Wert erfasst nur einen Teil bzw. ist eine Schätzung der Quelle |
| `group`, `index` | Strang-, Phasen- oder Modulnummer |
| `backfill` | Prometheus-Entität, aus der `tools/backfill_prometheus.py` Historie nachlädt |

### Messgrößen und Einheiten

| `kind` | erlaubte `unit` | intern |
|---|---|---|
| `power` | `W`, `kW` | W |
| `energy`, `energy_total` | `Wh`, `kWh` | kWh |
| `percent` | `%` | % |
| `temperature` | `°C` | °C |
| `voltage` | `V` | V |
| `current` | `A`, `mA` | A |
| `frequency` | `Hz` | Hz |
| `duration` | `s`, `min`, `h` | s |
| `count`, `state` | leer | – |

### Rollen

Bilanzen und Kennzahlen rechnen ausschließlich mit Rollen. Rollen, die für die Bilanz zählen,
dürfen nur einmal aktiv belegt sein, sonst meldet die Prüfung eine Doppelzählung.

| Gruppe | Rollen |
|---|---|
| PV | `pv_power`, `pv_energy_today`, `pv_energy_total`, `string_power`, `string_voltage`, `string_current`, `string_energy_today`, `dc_power`, `dc_voltage`, `dc_current` |
| Wechselrichter | `inverter_output_power`, `inverter_temperature`, `inverter_status`, `inverter_mode`, `inverter_runtime`, `ac_voltage`, `ac_current`, `device_message` |
| Speicher | `battery_power`, `battery_charge_power`, `battery_discharge_power`, `battery_soc`, `battery_module_soc`, `battery_temperature`, `battery_voltage`, `battery_current`, `battery_cycles`, `battery_count`, `battery_charge_today`, `battery_discharge_today` |
| Haus | `house_power`, `house_energy_today`, `house_energy_week`, `house_energy_month`, `house_energy_year`, `house_energy_total`, `consumer_power`, `consumer_energy_today` |
| Netz | `grid_power`, `grid_import_power`, `grid_export_power`, `grid_voltage`, `grid_frequency`, `grid_import_today`, `grid_export_today`, `grid_import_total`, `grid_export_total`, `phase_power`, `phase_voltage`, `phase_current` |

## Beispiel: Messpunkt über MQTT

```json
{
  "id": "speicher_soc",
  "name": "Ladezustand",
  "device": "speicher",
  "integration": "mqtt_local",
  "source": {"topic": "noah2mqtt/<seriennummer>", "json_path": "soc"},
  "unit": "%",
  "kind": "percent",
  "role": "battery_soc",
  "min": 0,
  "max": 100,
  "interval": 60
}
```
