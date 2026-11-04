"""Textliche Tageszusammenfassung – ausschließlich aus gespeicherten Messwerten abgeleitet."""
from __future__ import annotations

import time
from datetime import datetime
from typing import Optional

from ..models.config_models import SolarisConfig
from .statistics import Statistics
from .store import Store

PHASE_MIN_W = 20.0       # darunter gilt der Speicher als ruhend
PHASE_MIN_S = 600        # kürzere Phasen werden nicht erwähnt


def de(x: float, digits: int = 2) -> str:
    """Zahl im deutschen Format (Dezimalkomma)."""
    return f"{x:,.{digits}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _daypart(h: int) -> str:
    if 5 <= h < 11:
        return "am Vormittag"
    if 11 <= h < 14:
        return "mittags"
    if 14 <= h < 18:
        return "am Nachmittag"
    if 18 <= h < 23:
        return "am Abend"
    return "in der Nacht"


def phases(points: list[tuple[float, float]], threshold: float, max_gap: float, min_len: float = PHASE_MIN_S) -> list[dict]:
    """Zusammenhängende Zeiträume mit Leistung > threshold (Lücken > max_gap trennen Phasen)."""
    out: list[dict] = []
    cur: Optional[dict] = None
    last_ts = None
    for ts, v in points:
        gap = last_ts is not None and ts - last_ts > max_gap
        if v is not None and v > threshold and not gap:
            if cur is None:
                cur = {"start": ts, "end": ts, "max_w": v}
            cur["end"] = ts
            cur["max_w"] = max(cur["max_w"], v)
        else:
            if cur:
                out.append(cur)
            cur = {"start": ts, "end": ts, "max_w": v} if (v is not None and v > threshold and gap) else None
        last_ts = ts
    if cur:
        out.append(cur)
    return [p for p in out if p["end"] - p["start"] >= min_len]


def today_summary(cfg: SolarisConfig, store: Store, now: Optional[float] = None) -> dict:
    st = Statistics(cfg, store)
    s, _, _, _ = st.period_bounds("day", now)
    e = now or time.time()
    tz = st.tz
    fmt = lambda t: datetime.fromtimestamp(t, tz).strftime("%H:%M")  # noqa: E731
    gap = cfg.settings.storage.max_gap_s
    lines: list[dict] = []
    facts: dict = {}

    def series(role: str) -> tuple[Optional[str], list[tuple[float, float]]]:
        dps = cfg.by_role(role)
        if not dps:
            return None, []
        rows = store.bucketed(dps[0].id, s, e, 120)
        return dps[0].id, [(r[0], r[1]) for r in rows]

    day = st.bucket(s, e, "day")
    pv = day["values"]["pv"]
    if pv:
        facts["pv_kwh"] = pv["kwh"]
        basis = "Tageszähler" if pv["basis"] == "counter" else "integriert aus Leistungswerten"
        _, pvs = series("pv_power")
        peak = max(pvs, key=lambda p: p[1]) if pvs else None
        txt = f"Bisher wurden heute {de(pv['kwh'])} kWh PV-Energie erzeugt ({basis})."
        if peak and peak[1] > 0:
            txt += f" Die höchste PV-Leistung lag bei {peak[1]:.0f} W gegen {fmt(peak[0])} Uhr."
        lines.append({"topic": "pv", "text": txt})
    for role, verb, key in (("battery_charge_power", "geladen", "charge"), ("battery_discharge_power", "entladen", "discharge")):
        dp_id, pts = series(role)
        if not dp_id:
            continue
        ph = phases(pts, PHASE_MIN_W, gap)
        facts[f"{key}_phases"] = ph
        if ph:
            parts = [f"{_daypart(datetime.fromtimestamp(p['start'], tz).hour)} von {fmt(p['start'])} bis {fmt(p['end'])} Uhr "
                     f"(max. {p['max_w']:.0f} W)" for p in ph[:3]]
            lines.append({"topic": "battery", "text": f"Der Speicher wurde {', '.join(parts)} {verb}."})
        elif pts:
            lines.append({"topic": "battery", "text": f"Der Speicher wurde heute bisher nicht nennenswert {verb} (Schwelle {PHASE_MIN_W:.0f} W)."})
    outdp = cfg.by_role("inverter_output_power")
    if outdp:
        r = st.hours(outdp[0].id, "power", s, e)
        wh = sum(x[6] or 0 for h, x in r.items() if s <= h < e)
        if r:
            facts["inverter_output_kwh"] = round(wh / 1000, 3)
            lines.append({"topic": "inverter", "text": f"Der Wechselrichter hat heute {de(wh / 1000)} kWh ins Hausnetz abgegeben "
                                                       f"(integriert aus der AC-Ausgangsleistung)."})
    house = day["values"]["house"]
    if house:
        facts["house_kwh"] = house["kwh"]
        note = " Dies ist eine Teilmessung (nicht alle Verbraucher erfasst)." if house["partial"] else ""
        lines.append({"topic": "house", "text": f"Der erfasste Verbrauch beträgt bisher {de(house['kwh'])} kWh.{note}"})
        if "inverter_output_kwh" in facts and house["kwh"] > 0 and not house["partial"]:
            share = min(facts["inverter_output_kwh"] / house["kwh"] * 100, 100)
            lines.append({"topic": "house", "text": f"Rund {share:.0f} % des Verbrauchs wurden vom Wechselrichter gedeckt."})
    sc = day["self_consumption"]
    if pv and not sc["available"]:
        lines.append({"topic": "kpi", "text": f"Die Eigenverbrauchsquote ist nicht bestimmbar: {sc['reason']}."})
    elif sc.get("available"):
        lines.append({"topic": "kpi", "text": f"Die Eigenverbrauchsquote liegt heute bei {sc['percent']:.0f} %."})
    if not lines:
        lines.append({"topic": "none", "text": "Für heute liegen noch keine ausreichenden Messdaten für eine Zusammenfassung vor."})
    return {"generated_at": e, "lines": lines, "facts": facts}
