"""Home-Assistant-REST-API (lesend). Benötigt einen Long-Lived-Access-Token in .env.

Dokumentation: https://developers.home-assistant.io/docs/api/rest/
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime

import httpx

from .base import BaseIntegration, Reading, sanitize


def _ts(s: str | None) -> float:
    if not s:
        return time.time()
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


class HomeAssistantIntegration(BaseIntegration):
    kind = "homeassistant"

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.secret(self.cfg.token_env)}", "Content-Type": "application/json"}

    async def _states(self, client: httpx.AsyncClient) -> list[dict]:
        r = await client.get(f"{self.cfg.url.rstrip('/')}/api/states", headers=self._headers(), timeout=self.cfg.timeout)
        if r.status_code == 401:
            raise PermissionError("Token ungültig oder abgelaufen (HTTP 401)")
        r.raise_for_status()
        return r.json()

    async def poll_once(self, client: httpx.AsyncClient) -> int:
        states = {s["entity_id"]: s for s in await self._states(client)}
        n = 0
        now = time.time()
        for dp in self.datapoints:
            e = dp.source.get("entity")
            s = states.get(e)
            if s is None:
                self.sink(Reading(dp.id, None, now, available=False, note=f"Entität {e} existiert nicht"))
                continue
            attr = dp.source.get("attribute")
            raw = s.get("attributes", {}).get(attr) if attr else s.get("state")
            ts = _ts(s.get("last_reported") or s.get("last_updated"))
            if raw in (None, "unavailable", "unknown", ""):
                self.sink(Reading(dp.id, None, ts, available=False, note=f"Home Assistant: {raw or 'kein Wert'}"))
                continue
            unit = None if attr else s.get("attributes", {}).get("unit_of_measurement")
            self.sink(Reading(dp.id, raw, ts, reported_unit=unit))
            n += 1
        return n

    async def _run(self) -> None:
        async with httpx.AsyncClient() as client:
            while True:
                try:
                    n = await self.poll_once(client)
                    self.set_status("connected", f"{n} Werte aktuell", True)
                except PermissionError as e:
                    self.set_status("error", str(e))
                except (httpx.HTTPError, ValueError) as e:
                    self.set_status("error", f"{type(e).__name__}: {e}")
                await asyncio.sleep(self.cfg.interval)

    async def start(self) -> None:
        if not self.cfg.enabled:
            self.set_status("disabled")
            return
        if not self.secret(self.cfg.token_env):
            self.set_status("not_configured", f"Kein Token in Umgebungsvariable {self.cfg.token_env}")
            return
        self.set_status("connecting", self.cfg.url)
        self._task = asyncio.create_task(self._run(), name=f"integration-{self.id}")

    async def test(self) -> dict:
        if not self.secret(self.cfg.token_env):
            return {"ok": False, "message": f"Kein Token gesetzt ({self.cfg.token_env} in .env)"}
        try:
            async with httpx.AsyncClient() as client:
                r = await client.get(f"{self.cfg.url.rstrip('/')}/api/", headers=self._headers(), timeout=self.cfg.timeout)
            if r.status_code == 401:
                return {"ok": False, "message": "Token ungültig (HTTP 401)"}
            r.raise_for_status()
            return {"ok": True, "message": r.json().get("message", "OK")}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "message": sanitize(f"{type(e).__name__}: {e}", self.secrets())}

    async def discover(self, seconds: float = 5) -> list[dict]:
        async with httpx.AsyncClient() as client:
            states = await self._states(client)
        out = []
        for s in states:
            if not s["entity_id"].startswith(("sensor.", "binary_sensor.")):
                continue
            a = s.get("attributes", {})
            out.append({"entity": s["entity_id"], "name": a.get("friendly_name"), "unit": a.get("unit_of_measurement"),
                        "value": s.get("state"), "device_class": a.get("device_class")})
        return sorted(out, key=lambda x: x["entity"])
