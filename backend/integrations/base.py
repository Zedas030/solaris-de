"""Gemeinsame Basis aller Integrationen. Alle Integrationen sind ausschließlich lesend."""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

from ..models.config_models import Datapoint, Integration


@dataclass
class Reading:
    dp_id: str
    raw: Any                       # float | str | None
    ts: float                      # Messzeitpunkt (laut Quelle, sonst Empfangszeit)
    reported_unit: Optional[str] = None
    available: bool = True
    retained: bool = False         # MQTT-Retained-Nachricht (Alter unbekannt)
    simulated: bool = False
    note: Optional[str] = None


def sanitize(msg: str, secrets: list[Optional[str]]) -> str:
    """Entfernt Geheimnisse aus Fehlermeldungen, bevor sie geloggt oder ausgegeben werden."""
    out = str(msg)
    for s in secrets:
        if s and len(s) >= 3:
            out = out.replace(s, "***")
    return out[:500]


def extract_json(payload: Any, path: Optional[str]) -> Any:
    """Einfacher JSON-Pfad: ``solar_w``, ``$.power``, ``a.b.0``."""
    if not path:
        return payload
    p = path[2:] if path.startswith("$.") else path.lstrip("$")
    cur = payload
    for part in [x for x in p.replace("[", ".").replace("]", "").split(".") if x]:
        if isinstance(cur, dict):
            if part not in cur:
                return None
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return None
    return cur


def parse_payload(raw: bytes | str, path: Optional[str]) -> Any:
    text = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else raw
    text = text.strip()
    try:
        data = json.loads(text)
    except ValueError:
        data = text
    if path:
        if not isinstance(data, (dict, list)):
            return None
        return extract_json(data, path)
    return data


class BaseIntegration:
    kind = "base"

    def __init__(self, cfg: Integration, datapoints: list[Datapoint], env: dict[str, str],
                 sink: Callable[[Reading], None], on_status: Callable[[str, dict, dict], None]):
        self.cfg = cfg
        self.datapoints = [d for d in datapoints if d.enabled and d.integration == cfg.id]
        self.env = env
        self.sink = sink
        self.on_status = on_status
        self.status: dict[str, Any] = {"state": "disabled" if not cfg.enabled else "starting", "message": None,
                                       "last_ok": None, "last_error": None, "since": time.time()}
        self._task: Optional[asyncio.Task] = None

    @property
    def id(self) -> str:
        return self.cfg.id

    def secret(self, env_name: Optional[str]) -> Optional[str]:
        return self.env.get(env_name) if env_name else None

    def secrets(self) -> list[Optional[str]]:
        return [self.secret(self.cfg.password_env), self.secret(self.cfg.token_env), self.secret(self.cfg.username_env)]

    def set_status(self, state: str, message: Optional[str] = None, ok: bool = False) -> None:
        old = dict(self.status)
        message = sanitize(message, self.secrets()) if message else None
        if state != old["state"]:
            self.status["since"] = time.time()
        self.status["state"] = state
        self.status["message"] = message
        if ok:
            self.status["last_ok"] = time.time()
        if state in ("error", "disconnected"):
            self.status["last_error"] = message
        if old["state"] != state:
            self.on_status(self.id, old, dict(self.status))

    def public_info(self) -> dict:
        c = self.cfg
        return {"id": c.id, "type": c.type, "name": c.name, "enabled": c.enabled, "host": c.host, "port": c.port,
                "url": c.url, "tls": c.tls, "interval": c.interval, "job": c.job, "notes": c.notes,
                "credentials": {
                    "username": ("gesetzt" if self.secret(c.username_env) else "nicht gesetzt") if c.username_env else None,
                    "password": ("gesetzt" if self.secret(c.password_env) else "nicht gesetzt") if c.password_env else None,
                    "token": ("gesetzt" if self.secret(c.token_env) else "nicht gesetzt") if c.token_env else None},
                "datapoints": len(self.datapoints), "status": self.status}

    async def start(self) -> None:
        raise NotImplementedError

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def test(self) -> dict:
        raise NotImplementedError

    async def discover(self, seconds: float = 5) -> list[dict]:
        return []
