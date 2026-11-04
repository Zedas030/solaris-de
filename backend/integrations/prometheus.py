"""Lesender Zugriff auf Home-Assistant-Sensoren über die Prometheus-HTTP-API.

Home Assistant exportiert (Integration ``prometheus:``) jeden Sensor als Metrik
``homeassistant_sensor_<…>_<einheit>{entity="sensor.x"}``. Prometheus speichert sie mit
echtem Zeitstempel; die Einheit lässt sich aus dem Metriknamen ablesen und wird gegen die
konfigurierte Einheit geprüft. Dokumentation: https://prometheus.io/docs/prometheus/latest/querying/api/
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import Optional

import httpx

from .base import BaseIntegration, Reading, sanitize

SUFFIX_UNITS = [("_kwh", "kWh"), ("_wh", "Wh"), ("_kw", "kW"), ("_w", "W"), ("_percent", "%"), ("_celsius", "°C"),
                ("_v", "V"), ("_ma", "mA"), ("_a", "A"), ("_hz", "Hz"), ("_seconds", "s"), ("_state", None)]
VALUE_METRIC = re.compile(r"^homeassistant_sensor_")


def unit_from_metric(name: str) -> Optional[str]:
    for suf, unit in SUFFIX_UNITS:
        if name.endswith(suf):
            return unit
    return None


class PrometheusIntegration(BaseIntegration):
    kind = "prometheus"

    def _entities(self) -> dict[str, list[str]]:
        m: dict[str, list[str]] = {}
        for d in self.datapoints:
            e = d.source.get("entity")
            if e:
                m.setdefault(e, []).append(d.id)
        return m

    def _job(self) -> str:
        return self.cfg.job or "homeassistant"

    async def _query(self, client: httpx.AsyncClient, q: str) -> list[dict]:
        r = await client.get(f"{self.cfg.url.rstrip('/')}/api/v1/query", params={"query": q}, timeout=self.cfg.timeout)
        r.raise_for_status()
        data = r.json()
        if data.get("status") != "success":
            raise RuntimeError(data.get("error", "Abfrage fehlgeschlagen"))
        return data["data"]["result"]

    async def poll_once(self, client: httpx.AsyncClient) -> int:
        ents = self._entities()
        if not ents:
            return 0
        regex = "|".join(re.escape(e) for e in ents).replace("\\", "\\\\")  # PromQL-String-Escaping
        lookback = max(self.cfg.interval * 4, 180)
        series = await self._query(client, f'{{job="{self._job()}",entity=~"{regex}",'
                                           f'__name__=~"homeassistant_sensor_.+|homeassistant_entity_available"}}[{lookback}s]')
        latest: dict[str, dict] = {}
        for s in series:
            name, ent = s["metric"]["__name__"], s["metric"].get("entity")
            if not s.get("values"):
                continue
            ts, val = s["values"][-1]
            slot = latest.setdefault(ent, {})
            if name == "homeassistant_entity_available":
                slot["available"] = float(val) == 1.0
                slot["avail_ts"] = float(ts)
            elif VALUE_METRIC.match(name):
                if "ts" not in slot or float(ts) > slot["ts"]:
                    slot.update(value=float(val), ts=float(ts), unit=unit_from_metric(name), metric=name)
        n = 0
        now = time.time()
        for ent, dp_ids in ents.items():
            slot = latest.get(ent)
            for dp_id in dp_ids:
                if not slot or "value" not in slot:
                    self.sink(Reading(dp_id, None, now, available=False, note="Keine aktuellen Daten in Prometheus"))
                elif slot.get("available") is False:
                    self.sink(Reading(dp_id, None, slot.get("avail_ts", now), available=False,
                                      note="Home Assistant meldet die Entität als nicht verfügbar"))
                else:
                    self.sink(Reading(dp_id, slot["value"], slot["ts"], reported_unit=slot["unit"]))
                    n += 1
        return n

    async def _run(self) -> None:
        async with httpx.AsyncClient() as client:
            while True:
                try:
                    up = await self._query(client, f'up{{job="{self._job()}"}}')
                    n = await self.poll_once(client)
                    if up and float(up[0]["value"][1]) == 0:
                        self.set_status("degraded", f"Prometheus erreicht '{self._job()}' derzeit nicht (up=0)", True)
                    else:
                        self.set_status("connected", f"{n} Werte aktuell", True)
                except (httpx.HTTPError, RuntimeError, ValueError, KeyError) as e:
                    self.set_status("error", f"Abfrage fehlgeschlagen: {type(e).__name__}: {e}")
                await asyncio.sleep(self.cfg.interval)

    async def start(self) -> None:
        if not self.cfg.enabled:
            self.set_status("disabled")
            return
        self.set_status("connecting", self.cfg.url)
        self._task = asyncio.create_task(self._run(), name=f"integration-{self.id}")

    async def test(self) -> dict:
        try:
            async with httpx.AsyncClient() as client:
                up = await self._query(client, f'up{{job="{self._job()}"}}')
            if not up:
                return {"ok": False, "message": f"Prometheus erreichbar, aber kein Job '{self._job()}' gefunden"}
            return {"ok": True, "message": f"Prometheus erreichbar, Job '{self._job()}' up={up[0]['value'][1]}"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "message": sanitize(f"{type(e).__name__}: {e}", self.secrets())}

    async def discover(self, seconds: float = 5) -> list[dict]:
        async with httpx.AsyncClient() as client:
            series = await self._query(client, f'{{job="{self._job()}",__name__=~"homeassistant_sensor_.+",domain="sensor"}}')
        out = {}
        for s in series:
            m = s["metric"]
            e = m.get("entity")
            if not e:
                continue
            out[e] = {"entity": e, "name": m.get("friendly_name"), "unit": unit_from_metric(m["__name__"]),
                      "value": float(s["value"][1]), "metric": m["__name__"]}
        return sorted(out.values(), key=lambda x: x["entity"])

    async def query_range(self, entity: str, start: float, end: float, step: int) -> list[tuple[float, float, Optional[str]]]:
        """Für den Historien-Import: liefert (ts, wert, einheit)."""
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{self.cfg.url.rstrip('/')}/api/v1/query_range", timeout=60, params={
                "query": f'{{job="{self._job()}",entity="{entity}",__name__=~"homeassistant_sensor_.+"}}',
                "start": start, "end": end, "step": step})
            r.raise_for_status()
            res = r.json()["data"]["result"]
            avail = await client.get(f"{self.cfg.url.rstrip('/')}/api/v1/query_range", timeout=60, params={
                "query": f'homeassistant_entity_available{{job="{self._job()}",entity="{entity}"}}',
                "start": start, "end": end, "step": step})
            avail_map = {}
            for s in avail.json()["data"]["result"]:
                avail_map.update({float(t): float(v) for t, v in s["values"]})
        out = []
        for s in res:
            unit = unit_from_metric(s["metric"]["__name__"])
            for t, v in s["values"]:
                if avail_map.get(float(t), 1.0) == 1.0:
                    out.append((float(t), float(v), unit))
        return sorted(out)
