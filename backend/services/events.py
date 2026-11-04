"""Zustandsbasierte Ereignisse: Ein Ereignis entsteht nur beim tatsächlichen Wechsel eines Zustands."""
from __future__ import annotations

import time
from typing import Optional

from .store import Store


class Conditions:
    def __init__(self, store: Store):
        self.store = store
        self.active: dict[str, dict] = {}
        self._pending: dict[str, float] = {}

    def set(self, key: str, active: bool, *, severity: str = "warning", category: str = "system", message: str = "",
            device: Optional[str] = None, datapoint: Optional[str] = None, details: Optional[dict] = None,
            clear_message: Optional[str] = None, min_duration: float = 0, now: Optional[float] = None) -> None:
        now = now or time.time()
        if active:
            first = self._pending.setdefault(key, now)
            if key in self.active:
                self.active[key].update(message=message, details=details)
                return
            if now - first < min_duration:
                return
            self.active[key] = {"key": key, "since": now, "severity": severity, "category": category, "message": message,
                                "device": device, "datapoint": datapoint, "details": details}
            self.store.add_event(severity, category, message, device, datapoint, details, key, ts=now)
        else:
            self._pending.pop(key, None)
            cur = self.active.pop(key, None)
            if cur:
                self.store.add_event("info", cur["category"], clear_message or f"Behoben: {cur['message']}",
                                     cur["device"], cur["datapoint"], None, key, ts=now)

    def clear_prefix(self, prefix: str) -> None:
        for k in [k for k in self.active if k.startswith(prefix)]:
            self.active.pop(k)
        for k in [k for k in self._pending if k.startswith(prefix)]:
            self._pending.pop(k)

    def list(self) -> list[dict]:
        order = {"error": 0, "warning": 1, "info": 2}
        return sorted(self.active.values(), key=lambda c: (order.get(c["severity"], 3), -c["since"]))
