"""Simulationsquelle – nur nach expliziter Aktivierung. Alle Werte sind als Simulation markiert
und werden niemals in der Historie gespeichert."""
from __future__ import annotations

import asyncio
import math
import random
import time

from .base import BaseIntegration, Reading


def _signal(name: str, t: float, state: dict) -> float | str | None:
    lt = time.localtime(t)
    hour = lt.tm_hour + lt.tm_min / 60
    sun = max(0.0, math.sin((hour - 6) / 14 * math.pi)) if 6 <= hour <= 20 else 0.0
    pv = 1600 * sun * (0.85 + 0.15 * random.random())
    house = 250 + 150 * random.random() + (800 if 18 <= hour <= 20 else 0)
    soc = state.setdefault("soc", 50.0)
    bat = max(min(pv - house, 800), -800)
    if (soc >= 100 and bat > 0) or (soc <= 10 and bat < 0):
        bat = 0
    state["soc"] = min(100.0, max(0.0, soc + bat * 5 / 3600 / 20))
    grid = house - pv + bat
    return {"pv": pv, "house": house, "battery": bat, "soc": state["soc"], "grid": grid,
            "output": pv - bat, "status": "simulation"}.get(name)


class DemoIntegration(BaseIntegration):
    kind = "demo"

    async def _run(self) -> None:
        state: dict = {}
        while True:
            now = time.time()
            for dp in self.datapoints:
                self.sink(Reading(dp.id, _signal(dp.source.get("signal", ""), now, state), now, simulated=True))
            self.set_status("connected", "SIMULATION aktiv", True)
            await asyncio.sleep(self.cfg.interval)

    async def start(self) -> None:
        if not self.cfg.enabled:
            self.set_status("disabled")
            return
        self._task = asyncio.create_task(self._run(), name=f"integration-{self.id}")

    async def test(self) -> dict:
        return {"ok": True, "message": "Simulation benötigt keine Verbindung"}

    async def discover(self, seconds: float = 5) -> list[dict]:
        return [{"signal": s} for s in ("pv", "house", "battery", "soc", "grid", "output", "status")]

