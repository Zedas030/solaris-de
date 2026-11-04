"""Laden, Validieren und nachvollziehbares Speichern der Konfiguration."""
from __future__ import annotations

import json
import os
import time
from typing import Any, Optional

from ..models.config_models import SolarisConfig


def load_env(path: Optional[str]) -> dict[str, str]:
    """Liest eine .env-Datei (KEY=VALUE) und überlagert sie mit echten Umgebungsvariablen."""
    env: dict[str, str] = {}
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
                    v = v[1:-1]
                env[k.strip()] = v
    env.update({k: v for k, v in os.environ.items() if k.startswith("SOLARIS_")})
    return env


class ConfigStore:
    def __init__(self, path: str, history_dir: Optional[str] = None, keep: int = 100):
        self.path = path
        self.history_dir = history_dir or os.path.join(os.path.dirname(path), "history")
        self.keep = keep
        self.config = self.load()

    def load(self) -> SolarisConfig:
        if not os.path.exists(self.path):
            cfg = SolarisConfig()
            self._write(cfg.model_dump(mode="json"))
            return cfg
        with open(self.path, encoding="utf-8") as f:
            return SolarisConfig.model_validate(json.load(f))

    def _write(self, data: dict) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def snapshot(self) -> Optional[str]:
        """Sichert die aktuelle Datei mit Zeitstempel (Versionsverlauf)."""
        if not os.path.exists(self.path):
            return None
        os.makedirs(self.history_dir, exist_ok=True)
        dest = os.path.join(self.history_dir, time.strftime("solaris-%Y%m%d-%H%M%S.json"))
        n = 1
        while os.path.exists(dest):
            dest = dest.replace(".json", f"-{n}.json"); n += 1
        with open(self.path, "rb") as src, open(dest, "wb") as dst:
            dst.write(src.read())
        files = sorted(os.listdir(self.history_dir))
        for old in files[:-self.keep]:
            os.remove(os.path.join(self.history_dir, old))
        return dest

    def validate(self, data: dict[str, Any]) -> SolarisConfig:
        return SolarisConfig.model_validate(data)

    def save(self, data: dict[str, Any]) -> SolarisConfig:
        cfg = self.validate(data)          # wirft bei ungültiger Konfiguration – nichts wird geschrieben
        self.snapshot()
        self._write(cfg.model_dump(mode="json"))
        self.config = cfg
        return cfg

    def as_dict(self) -> dict[str, Any]:
        return self.config.model_dump(mode="json")
