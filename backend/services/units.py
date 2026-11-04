"""Zentrale Einheiten-Umrechnung.

Intern wird jede Größe in genau einer kanonischen Einheit geführt:

=============  ===========  ==============================================
Typ (kind)     kanonisch    Umrechnung aus Quelleinheit
=============  ===========  ==============================================
power          W            kW × 1000 → W
energy         kWh          Wh ÷ 1000 → kWh (Periodenzähler, z. B. „heute“)
energy_total   kWh          Wh ÷ 1000 → kWh (fortlaufender Zählerstand)
percent        %            –
temperature    °C           –
voltage        V            –
current        A            mA ÷ 1000 → A
frequency      Hz           –
duration       s            min × 60, h × 3600 → s
count / state  –            –
=============  ===========  ==============================================

Die Reihenfolge der Rohwertverarbeitung ist immer:
``kanonisch = (roh × scale + offset) × Einheitenfaktor`` und danach ggf. Vorzeichenumkehr.
"""
from __future__ import annotations

from typing import Optional

CANONICAL_UNIT = {
    "power": "W", "energy": "kWh", "energy_total": "kWh", "percent": "%",
    "temperature": "°C", "voltage": "V", "current": "A", "frequency": "Hz",
    "count": "", "state": "", "duration": "s",
}

KIND_UNITS: dict[str, dict[str, float]] = {
    "power": {"W": 1.0, "kW": 1000.0},
    "energy": {"Wh": 0.001, "kWh": 1.0},
    "energy_total": {"Wh": 0.001, "kWh": 1.0},
    "percent": {"%": 1.0},
    "temperature": {"°C": 1.0},
    "voltage": {"V": 1.0},
    "current": {"A": 1.0, "mA": 0.001},
    "frequency": {"Hz": 1.0},
    "count": {"": 1.0},
    "state": {"": 1.0},
    "duration": {"s": 1.0, "min": 60.0, "h": 3600.0},
}

# Einheitenkennungen, die Fremdsysteme (z. B. Prometheus-Metriknamen von Home Assistant) melden.
UNIT_ALIASES = {
    "w": "W", "kw": "kW", "wh": "Wh", "kwh": "kWh", "percent": "%", "%": "%",
    "celsius": "°C", "°c": "°C", "v": "V", "a": "A", "ma": "mA", "hz": "Hz",
    "s": "s", "min": "min", "h": "h",
}


def normalize_unit(u: Optional[str]) -> Optional[str]:
    if u is None:
        return None
    return UNIT_ALIASES.get(u.strip().lower(), u.strip())


def to_canonical(value: float, kind: str, unit: str) -> float:
    """Rechnet ``value`` aus ``unit`` in die kanonische Einheit des Typs um."""
    factors = KIND_UNITS[kind]
    if unit not in factors:
        raise ValueError(f"Einheit '{unit}' ist für '{kind}' nicht zulässig")
    return value * factors[unit]


def units_compatible(kind: str, reported: Optional[str], configured: str) -> bool:
    """Prüft eine von der Quelle gemeldete Einheit gegen die konfigurierte."""
    if reported is None or reported == "":
        return True  # Quelle meldet keine Einheit → keine Aussage möglich
    rep = normalize_unit(reported)
    return rep == configured


def format_power(w: Optional[float], mode: str = "auto", kw_threshold: float = 1000) -> tuple[Optional[float], str]:
    """Darstellungshilfe (Backend-Spiegel der Frontend-Logik, u. a. für Tests/CSV)."""
    if w is None:
        return None, "W"
    if mode == "kW" or (mode == "auto" and abs(w) >= kw_threshold):
        return round(w / 1000, 2), "kW"
    return round(w, 0), "W"
