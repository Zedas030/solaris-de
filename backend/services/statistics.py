"""Energie-Statistiken aus gespeicherten Daten.

Je Kennzahl gilt folgende Rangfolge der Datengrundlage:
  1. ``counter``    – Tageszähler der Quelle (z. B. „PV-Energie heute“): Tageswert = letzter Wert des Tages
  2. ``integrated`` – Integration der Leistungsmesswerte (Halteglied, Lücken > max_gap werden nicht gefüllt)
Stundenwerte sind immer integriert. Wochen-/Monats-/Jahreswerte sind Summen der Tageswerte.
``coverage`` gibt an, welcher Anteil des Zeitraums durch Messdaten abgedeckt ist.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from ..models.config_models import SolarisConfig
from . import energy
from .store import Store

METRICS = {
    "pv": {"label": "PV-Produktion", "counter": "pv_energy_today", "power": "pv_power"},
    "house": {"label": "Hausverbrauch", "counter": "house_energy_today", "power": "house_power"},
    "battery_charge": {"label": "Batterieladung", "counter": "battery_charge_today", "power": "battery_charge_power",
                       "signed": ("battery_power", "pos")},
    "battery_discharge": {"label": "Batterieentladung", "counter": "battery_discharge_today",
                          "power": "battery_discharge_power", "signed": ("battery_power", "neg")},
    "grid_import": {"label": "Netzbezug", "counter": "grid_import_today", "power": "grid_import_power",
                    "signed": ("grid_power", "pos")},
    "grid_export": {"label": "Einspeisung", "counter": "grid_export_today", "power": "grid_export_power",
                    "signed": ("grid_power", "neg")},
}


class Statistics:
    def __init__(self, cfg: SolarisConfig, store: Store):
        self.cfg = cfg
        self.store = store
        self.tz = ZoneInfo(cfg.site.timezone)
        self.max_gap = cfg.settings.storage.max_gap_s

    # ----------------------------------------------------------- Hilfen
    def _dp(self, role: Optional[str]):
        if not role:
            return None
        dps = self.cfg.by_role(role)
        return dps[0] if dps else None

    def hours(self, dp_id: str, kind: str, start: float, end: float) -> dict[int, tuple]:
        h0 = int(start // 3600 * 3600)
        rows = {r[0]: r for r in self.store.hourly_rows(dp_id, h0, end)}
        last = self.store.get_meta(f"rollup:{dp_id}")
        live_from = int(last) + 3600 if last is not None else h0
        h = max(live_from, h0)
        while h < end:
            r = self.store.compute_hour(dp_id, h, kind, self.max_gap)
            if r:
                rows[h] = r[1:]
            h += 3600
        return rows

    def day_bounds(self, start: float, end: float) -> list[tuple[float, float]]:
        d = datetime.fromtimestamp(start, self.tz).replace(hour=0, minute=0, second=0, microsecond=0)
        out = []
        while d.timestamp() < end:
            n = (d + timedelta(days=1)).replace(hour=0)
            n = datetime(n.year, n.month, n.day, tzinfo=self.tz)
            out.append((d.timestamp(), n.timestamp()))
            d = n
        return out

    def month_bounds(self, start: float, end: float) -> list[tuple[float, float]]:
        d = datetime.fromtimestamp(start, self.tz)
        d = datetime(d.year, d.month, 1, tzinfo=self.tz)
        out = []
        while d.timestamp() < end:
            n = datetime(d.year + (d.month == 12), d.month % 12 + 1, 1, tzinfo=self.tz)
            out.append((d.timestamp(), n.timestamp()))
            d = n
        return out

    # ------------------------------------------------------- Energiewerte
    def _integrated(self, metric: str, start: float, end: float) -> Optional[dict]:
        m = METRICS[metric]
        dp = self._dp(m["power"])
        part = None
        if dp is None and m.get("signed"):
            dp = self._dp(m["signed"][0])
            part = m["signed"][1]
        if dp is None:
            return None
        rows = self.hours(dp.id, "power", start, end)
        wh = cov = 0.0
        found = False
        for h, r in rows.items():
            if h < start or h >= end:
                continue
            # r = (hour, avg, min, max, last, n, energy_wh, pos_wh, neg_wh, covered_s)
            e, pos, neg, c = r[6], r[7], r[8], r[9]
            if e is None:
                continue
            found = True
            wh += pos if part == "pos" else neg if part == "neg" else e
            cov += c or 0
        if not found:
            return None
        span = max(min(end, time.time()) - start, 1)
        return {"kwh": round(wh / 1000, 3), "basis": "integrated", "coverage": round(min(cov / span, 1.0), 3),
                "partial": dp.partial, "source": dp.id}

    def _counter_day(self, metric: str, day_start: float, day_end: float) -> Optional[dict]:
        dp = self._dp(METRICS[metric]["counter"])
        if dp is None:
            return None
        rows = self.hours(dp.id, dp.kind, day_start, day_end)
        rows = {h: r for h, r in rows.items() if day_start <= h < day_end and r[5]}
        if not rows:
            return None
        last_h = max(rows)
        hours_with_data = len(rows)
        span_h = max((min(day_end, time.time()) - day_start) / 3600, 1)
        return {"kwh": round(rows[last_h][4], 3), "basis": "counter", "coverage": round(min(hours_with_data / span_h, 1.0), 3),
                "partial": dp.partial, "source": dp.id}

    def metric_value(self, metric: str, start: float, end: float, group: str) -> Optional[dict]:
        if group == "hour":
            return self._integrated(metric, start, end)
        if group == "day":
            return self._counter_day(metric, start, end) or self._integrated(metric, start, end)
        # Monat/Jahr: Summe der Tageswerte
        total = 0.0
        days = 0
        basis = set()
        partial = False
        spans = self.day_bounds(start, min(end, time.time()))
        for ds, de in spans:
            v = self.metric_value(metric, ds, de, "day")
            if v:
                total += v["kwh"]; days += 1; basis.add(v["basis"]); partial |= v["partial"]
        if not days:
            return None
        return {"kwh": round(total, 3), "basis": "+".join(sorted(basis)), "coverage": round(days / max(len(spans), 1), 3),
                "partial": partial, "days_with_data": days}

    def bucket(self, start: float, end: float, group: str) -> dict:
        vals = {k: self.metric_value(k, start, end, group) for k in METRICS}
        pv = vals["pv"]["kwh"] if vals["pv"] else None
        exp = vals["grid_export"]["kwh"] if vals["grid_export"] else None
        house = vals["house"]["kwh"] if vals["house"] else None
        imp = vals["grid_import"]["kwh"] if vals["grid_import"] else None
        partial = bool(vals["house"] and vals["house"]["partial"])
        return {"start": start, "end": end, "values": vals,
                "self_consumption": energy.self_consumption(pv, exp),
                "autarky": energy.autarky(house, imp, partial),
                "grid_dependency": energy.grid_dependency(house, imp, partial)}

    def series(self, start: float, end: float, group: str) -> list[dict]:
        if group == "hour":
            h = int(start // 3600 * 3600)
            spans = []
            while h < end:
                spans.append((h, h + 3600)); h += 3600
        elif group == "day":
            spans = self.day_bounds(start, end)
        else:
            spans = self.month_bounds(start, end)
        now = time.time()
        return [self.bucket(s, e, group) for s, e in spans if s <= now]

    def period_bounds(self, period: str, ref: Optional[float] = None) -> tuple[float, float, float, float]:
        """Liefert (start, ende, vorher_start, vorher_ende) für day/week/month/year in lokaler Zeit."""
        now = datetime.fromtimestamp(ref or time.time(), self.tz)
        today = datetime(now.year, now.month, now.day, tzinfo=self.tz)
        if period == "day":
            s = today; e = s + timedelta(days=1); ps = s - timedelta(days=1)
        elif period == "week":
            s = today - timedelta(days=today.weekday()); e = s + timedelta(days=7); ps = s - timedelta(days=7)
        elif period == "month":
            s = datetime(now.year, now.month, 1, tzinfo=self.tz)
            e = datetime(now.year + (now.month == 12), now.month % 12 + 1, 1, tzinfo=self.tz)
            ps = datetime(now.year - (now.month == 1), (now.month - 2) % 12 + 1, 1, tzinfo=self.tz)
        elif period == "year":
            s = datetime(now.year, 1, 1, tzinfo=self.tz); e = datetime(now.year + 1, 1, 1, tzinfo=self.tz)
            ps = datetime(now.year - 1, 1, 1, tzinfo=self.tz)
        else:
            raise ValueError("period muss day, week, month oder year sein")
        # Sommer-/Winterzeit: Datumsarithmetik mit ZoneInfo-Neuberechnung
        fix = lambda d: datetime(d.year, d.month, d.day, tzinfo=self.tz).timestamp()  # noqa: E731
        return fix(s), fix(e), fix(ps), fix(s)

    def compare(self, period: str) -> dict:
        s, e, ps, pe = self.period_bounds(period)
        grp = "day" if period == "day" else "sum"
        cur = self.bucket(s, min(e, time.time()), grp)
        prev = self.bucket(ps, pe, grp)
        return {"period": period, "current": {"start": s, "end": e, **cur}, "previous": {"start": ps, "end": pe, **prev},
                "note": "Laufender Zeitraum bis jetzt im Vergleich zum vollständigen Vorzeitraum"}
