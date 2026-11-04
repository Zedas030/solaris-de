"""Erfassung: nimmt Messwerte der Integrationen entgegen, prüft und speichert sie,
überwacht Aktualität und erzeugt Ereignisse sowie die Live-Übersicht."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Optional

from ..integrations import BaseIntegration, Reading, build
from ..models.config_models import Datapoint, SolarisConfig
from . import energy
from .config_store import ConfigStore
from .events import Conditions
from .statistics import Statistics
from .store import Store
from .units import CANONICAL_UNIT, to_canonical, units_compatible

log = logging.getLogger("solaris.collector")

# Rollen, deren Ausfall als eigene Warnung gemeldet wird
CORE_ROLES = {"pv_power", "house_power", "battery_soc", "battery_power", "battery_charge_power",
              "battery_discharge_power", "grid_power", "grid_import_power", "grid_export_power", "inverter_output_power"}

QUALITY_TEXT = {
    "good": "gültig", "stale": "veraltet", "unavailable": "keine Daten", "device_offline": "Gerät offline",
    "out_of_range": "außerhalb Gültigkeitsbereich", "unit_mismatch": "falsche Einheit", "retained": "unbestätigt (gespeicherte MQTT-Nachricht)",
    "simulated": "Simulation", "error": "fehlerhaft",
}


class Collector:
    def __init__(self, cfg_store: ConfigStore, store: Store, env: dict[str, str]):
        self.cfg_store = cfg_store
        self.store = store
        self.env = env
        self.conditions = Conditions(store)
        self.current: dict[str, dict[str, Any]] = {}
        self.integrations: dict[str, BaseIntegration] = {}
        self._last_stored: dict[str, tuple[float, Any]] = {}
        self._subscribers: set[asyncio.Queue] = set()
        self._task: Optional[asyncio.Task] = None
        self._maint_task: Optional[asyncio.Task] = None
        self.started_at = time.time()
        self.last_tick: Optional[float] = None
        self.last_update: Optional[float] = None
        self.overview: dict = {}
        self._stats_cache: dict[str, tuple[float, Any]] = {}
        self.db_ok = True

    @property
    def cfg(self) -> SolarisConfig:
        return self.cfg_store.config

    # --------------------------------------------------------------- Start/Stop
    async def start(self) -> None:
        self.store.add_event("info", "system", "SOLARIS-Backend gestartet")
        await self._start_integrations()
        self._task = asyncio.create_task(self._tick_loop(), name="collector-tick")
        self._maint_task = asyncio.create_task(self._maintenance_loop(), name="collector-maintenance")

    async def stop(self) -> None:
        for t in (self._task, self._maint_task):
            if t:
                t.cancel()
        for i in self.integrations.values():
            await i.stop()
        try:
            self.store.flush()
        except Exception:  # noqa: BLE001
            log.exception("Flush beim Beenden fehlgeschlagen")

    async def _start_integrations(self) -> None:
        self.current = {dp.id: self._empty(dp) for dp in self.cfg.datapoints if dp.enabled}
        self.integrations = {}
        for ic in self.cfg.integrations:
            inst = build(ic, self.cfg.datapoints, self.env, self.ingest, self._on_status)
            self.integrations[ic.id] = inst
            try:
                await inst.start()
            except Exception as e:  # noqa: BLE001
                inst.set_status("error", f"Start fehlgeschlagen: {e}")

    async def reload(self) -> None:
        """Nach Konfigurationsänderungen: Integrationen neu aufbauen."""
        for i in self.integrations.values():
            await i.stop()
        self.conditions.clear_prefix("dp:")
        self.conditions.clear_prefix("dev:")
        self._stats_cache.clear()
        await self._start_integrations()
        self.store.add_event("info", "config", "Konfiguration neu geladen")

    def _empty(self, dp: Datapoint) -> dict:
        return {"id": dp.id, "value": None, "text": None, "unit": dp.canonical_unit, "timestamp": None, "received": None,
                "quality": "unavailable", "source": dp.integration, "message": "Noch keine Daten empfangen",
                "raw": None, "raw_unit": None, "last_good_value": None, "last_good_ts": None}

    # -------------------------------------------------------------- Statusänderung
    def _on_status(self, integ_id: str, old: dict, new: dict) -> None:
        name = next((i.name for i in self.cfg.integrations if i.id == integ_id), integ_id)
        key = f"int:{integ_id}"
        if new["state"] in ("error", "disconnected"):
            self.conditions.set(key, True, severity="error", category="integration",
                                message=f"Datenquelle „{name}“ nicht verfügbar: {new.get('message') or new['state']}",
                                details={"integration": integ_id}, min_duration=0)
        elif new["state"] == "degraded":
            self.conditions.set(key, True, severity="warning", category="integration",
                                message=f"Datenquelle „{name}“ eingeschränkt: {new.get('message')}", details={"integration": integ_id})
        elif new["state"] == "connected":
            if key in self.conditions.active:
                self.conditions.set(key, False, clear_message=f"Datenquelle „{name}“ wieder verbunden (Wiederverbindung erfolgreich)")
            elif old["state"] in ("starting", "connecting"):
                self.store.add_event("info", "integration", f"Datenquelle „{name}“ verbunden")
        elif new["state"] == "not_configured":
            self.store.add_event("info", "integration", f"Datenquelle „{name}“ nicht eingerichtet: {new.get('message')}")

    # ---------------------------------------------------------------- Messwerte
    def ingest(self, r: Reading) -> None:
        dp = self.cfg.datapoint(r.dp_id)
        if dp is None or not dp.enabled:
            return
        cur = self.current.setdefault(dp.id, self._empty(dp))
        now = time.time()
        cur.update(received=now, raw=r.raw if not isinstance(r.raw, (dict, list)) else json.dumps(r.raw)[:200],
                   raw_unit=r.reported_unit, message=r.note, timestamp=r.ts)
        if not r.available or r.raw is None:
            cur.update(value=None, text=None, quality="unavailable")
            self._after_ingest(dp, cur, now)
            return
        if dp.kind == "state":
            cur.update(value=None, text=str(r.raw)[:120], quality="good")
        else:
            try:
                if isinstance(r.raw, bool):
                    raise ValueError
                raw = float(r.raw)
            except (TypeError, ValueError):
                cur.update(value=None, text=None, quality="error", message=f"Kein Zahlenwert: {str(r.raw)[:40]}")
                self._after_ingest(dp, cur, now)
                return
            if not units_compatible(dp.kind, r.reported_unit, dp.unit):
                cur.update(value=None, quality="unit_mismatch",
                           message=f"Quelle meldet '{r.reported_unit}', konfiguriert ist '{dp.unit}'")
                self.conditions.set(f"dp:{dp.id}:unit", True, severity="error", category="data", device=dp.device,
                                    datapoint=dp.id, message=f"Fehlerhafte Einheit bei „{dp.name}“: Quelle meldet "
                                    f"'{r.reported_unit}', erwartet '{dp.unit}'")
                self._after_ingest(dp, cur, now)
                return
            self.conditions.set(f"dp:{dp.id}:unit", False)
            v = to_canonical(raw * dp.scale + dp.offset, dp.kind, dp.unit)
            if dp.invert:
                v = -v
            # Vorzeichen zentral auf kanonische Konvention bringen (+Bezug, +Laden)
            if dp.sign_convention in ("export_positive", "discharge_positive"):
                v = -v
            in_range = (dp.min is None or v >= dp.min) and (dp.max is None or v <= dp.max)
            self.conditions.set(f"dp:{dp.id}:range", not in_range, severity="warning", category="data", device=dp.device,
                                datapoint=dp.id, message=f"Unplausibler Messwert bei „{dp.name}“: {v:g} {dp.canonical_unit} "
                                f"(gültig {dp.min if dp.min is not None else '–∞'} … {dp.max if dp.max is not None else '∞'})")
            cur.update(value=round(v, 4), text=None, quality="good" if in_range else "out_of_range")
        if r.simulated:
            cur["quality"] = "simulated"
        elif r.retained and cur["quality"] == "good":
            cur["quality"] = "retained"
        self._apply_age(dp, cur, now)
        self._after_ingest(dp, cur, now)

    def _apply_age(self, dp: Datapoint, cur: dict, now: float) -> None:
        if cur["quality"] == "good" and cur["timestamp"] and now - cur["timestamp"] > dp.stale_seconds:
            cur["quality"] = "stale"
            cur["message"] = f"Letzter Messwert älter als {dp.stale_seconds} s"

    def _device_offline(self, dp: Datapoint) -> bool:
        dev = next((d for d in self.cfg.devices if d.id == dp.device), None)
        if not dev or not dev.availability or dev.availability.datapoint == dp.id:
            return False
        st = self.current.get(dev.availability.datapoint)
        return bool(st and st["text"] is not None and st["text"].lower() in [v.lower() for v in dev.availability.offline_values])

    def _after_ingest(self, dp: Datapoint, cur: dict, now: float) -> None:
        if cur["quality"] == "good" and self._device_offline(dp):
            cur["quality"] = "device_offline"
            cur["message"] = "Gerät meldet Status offline – Wert ist nicht aktuell"
        if cur["quality"] == "good":
            cur["last_good_value"] = cur["value"] if dp.kind != "state" else cur["text"]
            cur["last_good_ts"] = cur["timestamp"]
            self.last_update = now
            self._maybe_store(dp, cur)

    def _maybe_store(self, dp: Datapoint, cur: dict) -> None:
        if not dp.store:
            return
        val = cur["value"] if dp.kind != "state" else cur["text"]
        ts = cur["timestamp"]
        last = self._last_stored.get(dp.id)
        hb = self.cfg.settings.storage.heartbeat_s
        if last and last[1] == val and ts - last[0] < hb:
            return
        if last and ts <= last[0]:
            return  # gleiche/ältere Messung erneut gemeldet → keine Dublette
        self._last_stored[dp.id] = (ts, val)
        self.store.queue(dp.id, ts, cur["value"], cur["text"], "good", dp.integration)

    # ------------------------------------------------------------------- Takt
    async def _tick_loop(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # noqa: BLE001
                log.exception("Fehler im Erfassungstakt")
            await asyncio.sleep(self.cfg.settings.tick_s)

    async def tick(self) -> None:
        now = time.time()
        self.last_tick = now
        grace = now - self.started_at
        for dp in self.cfg.datapoints:
            if not dp.enabled:
                continue
            cur = self.current.get(dp.id)
            if cur is None:
                continue
            if cur["quality"] == "good":
                self._apply_age(dp, cur, now)
                if cur["quality"] == "good" and self._device_offline(dp):
                    cur["quality"] = "device_offline"
            if dp.role in CORE_ROLES:
                bad = cur["quality"] in ("stale", "unavailable") and grace > dp.stale_seconds
                self.conditions.set(f"dp:{dp.id}:stale", bad, severity="warning", category="data", device=dp.device,
                                    datapoint=dp.id, message=f"Messwert „{dp.name}“ veraltet oder nicht verfügbar",
                                    clear_message=f"Messwert „{dp.name}“ wieder aktuell")
        self._device_conditions(grace)
        try:
            await asyncio.to_thread(self.store.flush)
            if not self.db_ok:
                self.db_ok = True
                self.conditions.set("db", False, clear_message="Datenbank wieder beschreibbar")
        except Exception as e:  # noqa: BLE001
            self.db_ok = False
            self.conditions.set("db", True, severity="error", category="database",
                                message=f"Datenbankproblem: Messwerte werden zwischengespeichert ({type(e).__name__})")
        self.overview = self.build_overview()
        self._balance_conditions()
        self._broadcast(self.overview)

    def _device_conditions(self, grace: float) -> None:
        for dev in self.cfg.devices:
            dps = [d for d in self.cfg.datapoints if d.enabled and d.device == dev.id]
            if not dps:
                continue
            st = self.device_status(dev.id)
            if dev.availability:
                self.conditions.set(f"dev:{dev.id}:offline", st["state"] == "offline", severity="warning", category="device",
                                    device=dev.id, message=f"{dev.name} meldet Status offline",
                                    clear_message=f"{dev.name} wieder online")
            nodata = st["state"] == "no_data" and grace > max(d.stale_seconds for d in dps)
            self.conditions.set(f"dev:{dev.id}:nodata", nodata, severity="warning", category="device", device=dev.id,
                                message=f"{dev.name}: keine aktuellen Messwerte",
                                clear_message=f"{dev.name}: Messwerte wieder verfügbar")

    def _balance_conditions(self) -> None:
        th = self.cfg.settings.thresholds
        checks = {b["node"]: b for b in self.overview.get("flows", {}).get("balance", [])}
        for node in ("inverter", "house"):
            b = checks.get(node)
            self.conditions.set(f"balance:{node}", bool(b and not b["ok"]), severity="warning", category="balance",
                                message=(f"Energiebilanz ({b['name']}) außerhalb der Toleranz: Abweichung {b['deviation_w']:.0f} W "
                                         f"(Toleranz {b['tolerance_w']:.0f} W)") if b else "",
                                details=b, min_duration=th.balance_min_duration_s,
                                clear_message="Energiebilanz wieder innerhalb der Toleranz")

    async def _maintenance_loop(self) -> None:
        await asyncio.sleep(20)
        last_retention = 0.0
        while True:
            try:
                kinds = {d.id: d.kind for d in self.cfg.datapoints if d.store}
                n = await asyncio.to_thread(self.store.rollup, kinds, self.cfg.settings.storage.max_gap_s)
                if n:
                    log.info("Stundenaggregate berechnet: %d", n)
                if time.time() - last_retention > 86400:
                    r = self.cfg.settings.retention
                    res = await asyncio.to_thread(self.store.retention, r.raw_days, r.hourly_days, r.events_days)
                    last_retention = time.time()
                    if any(res.values()):
                        self.store.add_event("info", "database", "Datenaufbewahrung angewendet", details=res)
            except Exception as e:  # noqa: BLE001
                log.exception("Wartung fehlgeschlagen")
                self.conditions.set("db:maint", True, severity="error", category="database",
                                    message=f"Datenbankwartung fehlgeschlagen ({type(e).__name__})")
            await asyncio.sleep(300)

    # ---------------------------------------------------------------- SSE
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=5)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def _broadcast(self, data: dict) -> None:
        for q in list(self._subscribers):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(data)

    # ------------------------------------------------------------ Übersicht
    def value_of(self, role: str, *, require_good: bool = True) -> Optional[energy.V]:
        dps = self.cfg.by_role(role)
        if not dps:
            return None
        dp = dps[0]
        c = self.current.get(dp.id)
        if not c or c["value"] is None:
            return energy.V(None, False, dp.partial, dp.estimated, dp.id)
        good = c["quality"] == "good" or c["quality"] == "simulated"
        if require_good and not good:
            return energy.V(None, False, dp.partial, dp.estimated, dp.id)
        return energy.V(c["value"], good, dp.partial, dp.estimated, dp.id)

    def device_status(self, dev_id: str) -> dict:
        dev = next((d for d in self.cfg.devices if d.id == dev_id), None)
        dps = [d for d in self.cfg.datapoints if d.enabled and d.device == dev_id]
        qs = [self.current.get(d.id, {}).get("quality", "unavailable") for d in dps]
        ts = [self.current.get(d.id, {}).get("last_good_ts") for d in dps]
        last = max([t for t in ts if t], default=None)
        if not dps:
            state = "not_configured"
        elif dev and dev.availability and self._device_offline_flag(dev):
            state = "offline"
        elif all(q in ("good", "simulated") for q in qs):
            state = "online"
        elif any(q in ("good", "simulated") for q in qs):
            state = "partial"
        elif any(q in ("stale", "retained", "device_offline") for q in qs):
            state = "stale"
        else:
            state = "no_data"
        return {"state": state, "last_contact": last, "datapoints": len(dps),
                "good": sum(q in ("good", "simulated") for q in qs)}

    def _device_offline_flag(self, dev) -> bool:
        st = self.current.get(dev.availability.datapoint)
        return bool(st and st["text"] and st["text"].lower() in [v.lower() for v in dev.availability.offline_values])

    def _kpi(self, role: str, label: str, explain: str) -> dict:
        dps = self.cfg.by_role(role)
        if not dps:
            return {"role": role, "label": label, "value": None, "unit": None, "status": "not_configured", "explain": explain}
        dp = dps[0]
        c = self.current.get(dp.id) or self._empty(dp)
        return {"role": role, "label": label, "value": c["value"] if dp.kind != "state" else c["text"], "unit": dp.canonical_unit,
                "status": c["quality"], "timestamp": c["timestamp"], "datapoint": dp.id, "partial": dp.partial,
                "estimated": dp.estimated, "explain": explain + (f" Quelle: {dp.name} ({dp.integration})."),
                "message": c.get("message")}

    def cached_stats(self, key: str, fn, ttl: float = 300):
        hit = self._stats_cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        val = fn()
        self._stats_cache[key] = (time.time(), val)
        return val

    def build_overview(self) -> dict:
        cfg = self.cfg
        th = cfg.settings.thresholds
        roles = ["pv_power", "inverter_output_power", "house_power", "battery_charge_power", "battery_discharge_power",
                 "grid_import_power", "grid_export_power"]
        r: dict[str, Optional[energy.V]] = {k: self.value_of(k) for k in roles}
        r["battery_net"] = self.value_of("battery_power")
        r["grid_net"] = self.value_of("grid_power")
        configured = {d.role for d in cfg.datapoints if d.enabled and d.role}
        flows = energy.compute_flows(r, configured)
        flows["balance"] = energy.balance_checks(r, th.balance_tolerance_w, th.balance_tolerance_pct)

        bat = energy.battery_net(r)
        grid = energy.grid_net(r)
        kpis = {
            "pv_power": self._kpi("pv_power", "PV-Leistung", "Momentane Erzeugungsleistung der PV-Module."),
            "house_power": self._kpi("house_power", "Hausverbrauch", "Momentane Verbrauchsleistung."),
            "battery_soc": self._kpi("battery_soc", "Ladezustand", "Ladezustand (SOC) des Speichers in Prozent."),
            "inverter_output_power": self._kpi("inverter_output_power", "Wechselrichter-Ausgang", "AC-Leistung, die der Wechselrichter ins Hausnetz abgibt."),
            "battery_charge_power": self._kpi("battery_charge_power", "Ladeleistung", "Leistung, mit der der Speicher geladen wird."),
            "battery_discharge_power": self._kpi("battery_discharge_power", "Entladeleistung", "Leistung, mit der der Speicher entladen wird."),
            "pv_energy_today": self._kpi("pv_energy_today", "PV-Energie heute", "Tageszähler der Erzeugung (vom Gerät)."),
            "pv_energy_total": self._kpi("pv_energy_total", "PV-Gesamtertrag", "Fortlaufender Zählerstand der Erzeugung."),
            "house_energy_today": self._kpi("house_energy_today", "Verbrauch heute", "Tageszähler des Verbrauchs."),
            "house_energy_month": self._kpi("house_energy_month", "Verbrauch diesen Monat", "Monatszähler des Verbrauchs."),
            "house_energy_year": self._kpi("house_energy_year", "Verbrauch dieses Jahr", "Jahreszähler des Verbrauchs."),
            "grid_import_today": self._kpi("grid_import_today", "Netzbezug heute", "Tageszähler Netzbezug."),
            "grid_export_today": self._kpi("grid_export_today", "Einspeisung heute", "Tageszähler Einspeisung."),
            "battery_charge_today": self._kpi("battery_charge_today", "Energie in den Speicher heute", "Tageszähler Ladeenergie."),
            "battery_discharge_today": self._kpi("battery_discharge_today", "Energie aus dem Speicher heute", "Tageszähler Entladeenergie."),
        }
        # Batterie- und Netzleistung: kanonisch, getrennt dargestellt
        kpis["battery_power"] = {"label": "Batterieleistung", "unit": "W",
                                 "value": bat.value if bat else None,
                                 "status": ("good" if bat and bat.good else "unavailable") if configured & {"battery_power", "battery_charge_power"} else "not_configured",
                                 "explain": "+ = Laden, − = Entladen. Aus Lade-/Entladeleistung bzw. vorzeichenbehafteter Messung."}
        imp = exp = None
        if grid is not None:
            imp, exp = max(grid.value, 0.0), max(-grid.value, 0.0)
        gconf = bool(configured & {"grid_power", "grid_import_power", "grid_export_power"})
        g_status = ("good" if grid else "unavailable") if gconf else "not_configured"
        kpis["grid_import_power"] = {"label": "Netzbezug", "unit": "W", "value": imp, "status": g_status,
                                     "explain": "Momentaner Bezug aus dem öffentlichen Netz (Netzzähler)."}
        kpis["grid_export_power"] = {"label": "Netzeinspeisung", "unit": "W", "value": exp, "status": g_status,
                                     "explain": "Momentane Einspeisung ins öffentliche Netz (Netzzähler)."}

        # Tageskennzahlen aus Zählern bzw. Historie
        stats = Statistics(cfg, self.store)
        try:
            today = self.cached_stats("today", lambda: stats.bucket(*stats.period_bounds("day")[:2], "day"), ttl=60)
            month = self.cached_stats("month", lambda: stats.bucket(*stats.period_bounds("month")[:2], "sum"), ttl=600)
            year = self.cached_stats("year", lambda: stats.bucket(*stats.period_bounds("year")[:2], "sum"), ttl=1800)
        except Exception:  # noqa: BLE001
            log.exception("Statistik fehlgeschlagen")
            today = month = year = None
        kp = cfg.site.pv_peak_kwp
        pv_year = year["values"]["pv"]["kwh"] if year and year["values"]["pv"] else None
        same_src = len({d.integration for r_ in ("pv_power", "battery_charge_power", "battery_discharge_power",
                                                  "inverter_output_power") for d in cfg.by_role(r_)}) == 1
        eff = (energy.conversion_efficiency(r["pv_power"], r["battery_charge_power"], r["battery_discharge_power"],
                                            r["inverter_output_power"]) if same_src
               else {"available": False, "reason": "Ein- und Ausgangswerte stammen nicht aus derselben Quelle"})
        derived = {
            "today": today, "month": month, "year": year, "efficiency": eff,
            "specific_yield_year": {"available": bool(kp and pv_year is not None),
                                    "value": round(pv_year / kp, 1) if kp and pv_year is not None else None,
                                    "unit": "kWh/kWp",
                                    "reason": None if kp else "Installierte PV-Nennleistung (kWp) nicht konfiguriert"},
        }
        soc = kpis["battery_soc"]["value"]
        soc_level = None
        if isinstance(soc, (int, float)) and kpis["battery_soc"]["status"] == "good":
            if th.soc_critical is not None and soc <= th.soc_critical:
                soc_level = "critical"
            elif soc < th.soc_low:
                soc_level = "low"
            elif soc >= th.soc_high:
                soc_level = "high"
            else:
                soc_level = "medium"
            self.conditions.set("battery:soc_low", soc_level in ("low", "critical"), severity="warning", category="battery",
                                message=f"Niedriger Ladezustand: {soc:.0f} % (Grenze {th.soc_low:.0f} %)",
                                clear_message="Ladezustand wieder über der unteren Grenze", min_duration=120)
        integ = [i.public_info() for i in self.integrations.values()]
        devs = [{"id": d.id, "name": d.name, "class": d.device_class, **self.device_status(d.id)} for d in cfg.devices]
        q_counts: dict[str, int] = {}
        for c in self.current.values():
            q_counts[c["quality"]] = q_counts.get(c["quality"], 0) + 1
        simulated = any(i.cfg.enabled and i.cfg.type == "demo" for i in self.integrations.values())
        return {
            "generated_at": time.time(), "simulation": simulated, "site": cfg.site.model_dump(),
            "kpis": kpis, "flows": flows, "derived": derived, "soc_level": soc_level,
            "status": {"backend": "ok", "db_ok": self.db_ok, "last_update": self.last_update, "started_at": self.started_at,
                       "integrations": integ, "devices": devs, "quality": q_counts, "warnings": self.conditions.list()},
            "current": self.current,
        }
