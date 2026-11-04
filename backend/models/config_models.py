"""Konfigurationsmodell von SOLARIS (Single Source of Truth für Geräte, Messpunkte und Datenquellen).

Die Konfiguration liegt in ``data/config/solaris.json``. Geheimnisse (Passwörter, Tokens)
stehen dort nie, sondern nur die *Namen* von Umgebungsvariablen (``*_env``), deren Werte
aus ``.env`` gelesen werden.
"""
from __future__ import annotations

import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from ..services.units import CANONICAL_UNIT, KIND_UNITS

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")

Kind = Literal[
    "power", "energy", "energy_total", "percent", "temperature",
    "voltage", "current", "frequency", "count", "state", "duration",
]

# Semantische Rollen, die von der zentralen Berechnungslogik verwendet werden.
ROLES = {
    "pv_power": "PV-Leistung (DC/Erzeugung)",
    "inverter_output_power": "AC-Ausgangsleistung Wechselrichter",
    "house_power": "Hausverbrauch (Leistung)",
    "battery_power": "Batterieleistung (vorzeichenbehaftet)",
    "battery_charge_power": "Batterie-Ladeleistung",
    "battery_discharge_power": "Batterie-Entladeleistung",
    "battery_soc": "Batterie-Ladezustand gesamt",
    "battery_module_soc": "Ladezustand einzelnes Batteriemodul",
    "battery_temperature": "Batterietemperatur",
    "battery_voltage": "Batteriespannung",
    "battery_current": "Batteriestrom",
    "battery_cycles": "Ladezyklen",
    "battery_count": "Anzahl Batteriemodule",
    "grid_power": "Netzleistung (vorzeichenbehaftet)",
    "grid_import_power": "Netzbezug (Leistung)",
    "grid_export_power": "Netzeinspeisung (Leistung)",
    "grid_voltage": "Netzspannung",
    "grid_frequency": "Netzfrequenz",
    "phase_power": "Leistung je Phase",
    "phase_voltage": "Spannung je Phase",
    "phase_current": "Strom je Phase",
    "pv_energy_today": "PV-Energie heute",
    "pv_energy_total": "PV-Energie gesamt (Zählerstand)",
    "house_energy_today": "Hausverbrauch heute",
    "house_energy_week": "Hausverbrauch diese Woche",
    "house_energy_month": "Hausverbrauch diesen Monat",
    "house_energy_year": "Hausverbrauch dieses Jahr",
    "house_energy_total": "Hausverbrauch gesamt (Zählerstand)",
    "grid_import_today": "Netzbezug heute",
    "grid_export_today": "Netzeinspeisung heute",
    "grid_import_total": "Netzbezug Zählerstand",
    "grid_export_total": "Netzeinspeisung Zählerstand",
    "battery_charge_today": "Energie in den Speicher heute",
    "battery_discharge_today": "Energie aus dem Speicher heute",
    "inverter_temperature": "Wechselrichtertemperatur",
    "inverter_status": "Betriebszustand",
    "inverter_mode": "Betriebsmodus",
    "inverter_runtime": "Laufzeit",
    "ac_voltage": "AC-Spannung",
    "ac_current": "AC-Strom",
    "dc_voltage": "DC-Spannung",
    "dc_current": "DC-Strom",
    "dc_power": "DC-Leistung",
    "string_power": "String-/MPPT-Leistung",
    "string_voltage": "String-/MPPT-Spannung",
    "string_current": "String-/MPPT-Strom",
    "string_energy_today": "String-Ertrag heute",
    "consumer_power": "Einzelverbraucher (Leistung)",
    "consumer_energy_today": "Einzelverbraucher heute",
    "device_message": "Gerätemeldung / Fehlercode",
}

# Rollen, von denen es höchstens einen Messpunkt geben darf (für Bilanzen).
SINGLE_ROLES = {
    "pv_power", "inverter_output_power", "house_power", "battery_power",
    "battery_charge_power", "battery_discharge_power", "battery_soc",
    "grid_power", "grid_import_power", "grid_export_power",
    "pv_energy_today", "pv_energy_total", "house_energy_today", "grid_import_today",
    "grid_export_today", "battery_charge_today", "battery_discharge_today",
}


class DisplaySettings(BaseModel):
    power_unit: Literal["auto", "W", "kW"] = "auto"
    kw_threshold_w: float = Field(1000, ge=1)
    energy_unit: Literal["auto", "Wh", "kWh"] = "kWh"


class Thresholds(BaseModel):
    soc_high: float = Field(60, ge=0, le=100)
    soc_low: float = Field(20, ge=0, le=100)
    soc_critical: Optional[float] = Field(None, ge=0, le=100,
                                          description="Nur setzen, wenn sachlich begründet (z. B. Entladegrenze des BMS).")
    balance_tolerance_w: float = Field(60, ge=0)
    balance_tolerance_pct: float = Field(15, ge=0, le=100)
    balance_min_duration_s: int = Field(300, ge=0)
    phase_imbalance_pct: float = Field(30, ge=0, le=100)
    battery_temp_max_c: Optional[float] = None
    battery_temp_min_c: Optional[float] = None


class RetentionSettings(BaseModel):
    raw_days: int = Field(180, ge=1, description="Rohmesswerte; ältere Werte nur löschen, wenn Stundenwerte existieren")
    hourly_days: Optional[int] = Field(None, ge=1, description="None = unbegrenzt")
    events_days: int = Field(365, ge=1)


class StorageSettings(BaseModel):
    heartbeat_s: int = Field(60, ge=5, le=3600, description="Unveränderte Werte spätestens alle X s speichern")
    max_gap_s: int = Field(600, ge=30, description="Größere Abstände gelten als Datenlücke")


class Settings(BaseModel):
    display: DisplaySettings = DisplaySettings()
    thresholds: Thresholds = Thresholds()
    retention: RetentionSettings = RetentionSettings()
    storage: StorageSettings = StorageSettings()
    tick_s: int = Field(5, ge=1, le=60)
    default_chart_range: Literal["15m", "1h", "today", "yesterday", "7d", "30d"] = "today"


class Site(BaseModel):
    name: str = "Meine Anlage"
    timezone: str = "Europe/Berlin"
    pv_peak_kwp: Optional[float] = Field(None, gt=0, description="Installierte PV-Nennleistung, nur aus Datenblatt/Anlagenpass")
    battery_capacity_kwh: Optional[float] = Field(None, gt=0, description="Nutzbare Speicherkapazität, nur aus Datenblatt")
    battery_reserve_soc: Optional[float] = Field(None, ge=0, le=100, description="Untere Entladegrenze laut Gerät")


class Integration(BaseModel):
    id: str
    type: Literal["mqtt", "prometheus", "homeassistant", "demo"]
    name: str
    enabled: bool = False
    # gemeinsame / typabhängige Felder
    host: Optional[str] = None
    port: Optional[int] = Field(None, ge=1, le=65535)
    url: Optional[str] = None
    tls: bool = False
    username_env: Optional[str] = None
    password_env: Optional[str] = None
    token_env: Optional[str] = None
    job: Optional[str] = None
    interval: int = Field(15, ge=1, le=3600)
    timeout: float = Field(5, gt=0, le=60)
    client_id: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not ID_RE.match(v):
            raise ValueError("ID darf nur a-z, 0-9, _ und - enthalten")
        return v

    @field_validator("username_env", "password_env", "token_env")
    @classmethod
    def _env(cls, v: Optional[str]) -> Optional[str]:
        if v and not re.match(r"^[A-Z][A-Z0-9_]{0,63}$", v):
            raise ValueError("Name einer Umgebungsvariablen erwartet (z. B. SOLARIS_MQTT_PASSWORD), niemals das Geheimnis selbst")
        return v

    @model_validator(mode="after")
    def _required(self) -> "Integration":
        if self.type == "mqtt" and not self.host:
            raise ValueError("MQTT benötigt 'host'")
        if self.type in ("prometheus", "homeassistant") and not self.url:
            raise ValueError(f"{self.type} benötigt 'url'")
        if self.url and not re.match(r"^https?://", self.url):
            raise ValueError("url muss mit http:// oder https:// beginnen")
        return self


class Availability(BaseModel):
    datapoint: str
    offline_values: list[str] = ["offline"]


class Device(BaseModel):
    id: str
    name: str
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    device_class: Literal["inverter", "battery_inverter", "battery", "pv", "grid_meter",
                          "submeter", "virtual_meter", "sensor", "other"] = "other"
    protocol: Optional[str] = None
    host: Optional[str] = None
    serial: Optional[str] = None
    serial_source: Optional[str] = None
    firmware: Optional[str] = None
    availability: Optional[Availability] = None
    notes: Optional[str] = None

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not ID_RE.match(v):
            raise ValueError("ID darf nur a-z, 0-9, _ und - enthalten")
        return v


class Datapoint(BaseModel):
    id: str
    name: str
    device: str
    integration: str
    source: dict[str, Any] = Field(description="mqtt: {topic, json_path?}; prometheus/homeassistant: {entity}; demo: {signal}")
    unit: str = Field(description="Einheit, die die Quelle liefert")
    kind: Kind
    role: Optional[str] = None
    group: Optional[str] = None
    index: Optional[int] = Field(None, description="Strang-/Phasen-/Modulnummer")
    scale: float = 1.0
    offset: float = 0.0
    sign_convention: Optional[Literal["import_positive", "export_positive",
                                      "charge_positive", "discharge_positive"]] = None
    invert: bool = False
    min: Optional[float] = None
    max: Optional[float] = None
    interval: int = Field(60, ge=1, le=86400, description="Erwartetes Aktualisierungsintervall der Quelle (s)")
    stale_after: Optional[int] = Field(None, ge=5, description="Default: 3× interval + 30 s")
    enabled: bool = True
    store: bool = True
    partial: bool = Field(False, description="Messpunkt erfasst nur einen Teil (z. B. Summe einzelner Steckdosen)")
    estimated: bool = Field(False, description="Wert ist eine Schätzung der Quelle, keine Messung")
    description: Optional[str] = None
    backfill: Optional[dict[str, Any]] = Field(None, description="Optionale Prometheus-Entity für Historien-Import")

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not ID_RE.match(v):
            raise ValueError("ID darf nur a-z, 0-9, _ und - enthalten")
        return v

    @field_validator("role")
    @classmethod
    def _role(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in ROLES:
            raise ValueError(f"Unbekannte Rolle '{v}'")
        return v

    @model_validator(mode="after")
    def _check(self) -> "Datapoint":
        allowed = KIND_UNITS[self.kind]
        if self.unit not in allowed:
            raise ValueError(f"Einheit '{self.unit}' passt nicht zum Typ '{self.kind}' (erlaubt: {', '.join(allowed) or 'keine'})")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("min darf nicht größer als max sein")
        if self.sign_convention in ("import_positive", "export_positive") and self.role != "grid_power":
            raise ValueError("Netz-Vorzeichenkonvention nur für Rolle grid_power")
        if self.sign_convention in ("charge_positive", "discharge_positive") and self.role != "battery_power":
            raise ValueError("Batterie-Vorzeichenkonvention nur für Rolle battery_power")
        if self.role in ("grid_power", "battery_power") and not self.sign_convention:
            raise ValueError(f"Rolle {self.role} benötigt eine dokumentierte Vorzeichenkonvention")
        return self

    @property
    def canonical_unit(self) -> str:
        return CANONICAL_UNIT[self.kind]

    @property
    def stale_seconds(self) -> int:
        return self.stale_after or (self.interval * 3 + 30)


class SolarisConfig(BaseModel):
    version: int = 1
    site: Site = Site()
    settings: Settings = Settings()
    integrations: list[Integration] = []
    devices: list[Device] = []
    datapoints: list[Datapoint] = []

    @model_validator(mode="after")
    def _refs(self) -> "SolarisConfig":
        errors: list[str] = []
        for name, items in (("Integration", self.integrations), ("Gerät", self.devices), ("Messpunkt", self.datapoints)):
            seen: set[str] = set()
            for it in items:
                if it.id in seen:
                    errors.append(f"{name} '{it.id}' ist doppelt vorhanden")
                seen.add(it.id)
        integ = {i.id for i in self.integrations}
        devs = {d.id for d in self.devices}
        dps = {d.id for d in self.datapoints}
        role_count: dict[str, list[str]] = {}
        for dp in self.datapoints:
            if dp.integration not in integ:
                errors.append(f"Messpunkt '{dp.id}': Integration '{dp.integration}' existiert nicht")
            if dp.device not in devs:
                errors.append(f"Messpunkt '{dp.id}': Gerät '{dp.device}' existiert nicht")
            if dp.enabled and dp.role in SINGLE_ROLES:
                role_count.setdefault(dp.role, []).append(dp.id)
        for role, ids in role_count.items():
            if len(ids) > 1:
                errors.append(f"Rolle '{role}' ist mehrfach aktiv belegt ({', '.join(ids)}) – Doppelzählung")
        for d in self.devices:
            if d.availability and d.availability.datapoint not in dps:
                errors.append(f"Gerät '{d.id}': Verfügbarkeits-Messpunkt '{d.availability.datapoint}' existiert nicht")
        if self.settings.thresholds.soc_low > self.settings.thresholds.soc_high:
            errors.append("SOC-Grenze 'niedrig' liegt über 'hoch'")
        if errors:
            raise ValueError("; ".join(errors))
        return self

    def datapoint(self, dp_id: str) -> Optional[Datapoint]:
        return next((d for d in self.datapoints if d.id == dp_id), None)

    def by_role(self, role: str) -> list[Datapoint]:
        return [d for d in self.datapoints if d.enabled and d.role == role]
