"""Zentrale, dokumentierte Energieberechnungen (reine Funktionen, vollständig getestet).

Vorzeichen intern (kanonisch):
  * Netz:     ``grid_net_w  > 0`` = Bezug aus dem Netz,  ``< 0`` = Einspeisung
  * Batterie: ``battery_net_w > 0`` = Laden,             ``< 0`` = Entladen

Energieflussgrafik (Topologie „AC-Hausbus“)::

    PV ──► Wechselrichter ◄──► Batterie
                │
                ▼ AC-Ausgang
              Haus ◄──► Netz

Jede Linie entspricht genau einer Messgröße. Fehlt eine Messgröße, darf sie nur über eine
vollständige Knotenbilanz berechnet werden (Status ``calculated``); ist das nicht möglich,
bleibt die Linie ``unknown`` – es wird nichts geraten.

Kennzahlen:
  * Eigenverbrauch [kWh]   = PV-Erzeugung − Netzeinspeisung
  * Eigenverbrauchsquote   = Eigenverbrauch / PV-Erzeugung × 100
  * Autarkiegrad           = (Hausverbrauch − Netzbezug) / Hausverbrauch × 100
        Der Zähler entspricht dem aus PV direkt *und* über den Speicher gedeckten Verbrauch.
        Speicherverluste sind dadurch automatisch berücksichtigt, weil nur die tatsächlich im
        Haus verbrauchte Energie zählt (keine Doppelzählung von Lade- und Entladeenergie).
  * Netzabhängigkeit       = Netzbezug / Hausverbrauch × 100
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional


@dataclass
class V:
    """Ein Eingangswert für Berechnungen."""
    value: Optional[float]
    good: bool = True          # Qualität 'good' (nicht veraltet, nicht offline, ...)
    partial: bool = False      # erfasst nur einen Teil (z. B. Summe von Steckdosen)
    estimated: bool = False
    source: Optional[str] = None

    @property
    def known(self) -> bool:
        return self.value is not None


def normalize_grid(value: float, convention: str) -> tuple[float, float]:
    """Wandelt eine vorzeichenbehaftete Netzleistung in (Bezug, Einspeisung) ≥ 0 um.

    ``import_positive``: +Wert = Bezug, −Wert = Einspeisung (üblich bei Smart Metern)
    ``export_positive``: +Wert = Einspeisung, −Wert = Bezug
    """
    if convention == "import_positive":
        net = value
    elif convention == "export_positive":
        net = -value
    else:
        raise ValueError(f"Unbekannte Netz-Vorzeichenkonvention: {convention}")
    return (net, 0.0) if net >= 0 else (0.0, -net)


def normalize_battery(value: float, convention: str) -> tuple[float, float]:
    """Wandelt eine vorzeichenbehaftete Batterieleistung in (Laden, Entladen) ≥ 0 um."""
    if convention == "charge_positive":
        net = value
    elif convention == "discharge_positive":
        net = -value
    else:
        raise ValueError(f"Unbekannte Batterie-Vorzeichenkonvention: {convention}")
    return (net, 0.0) if net >= 0 else (0.0, -net)


@dataclass
class Edge:
    id: str
    a: str
    b: str
    value_w: Optional[float]        # Betrag
    direction: Optional[str]        # 'a->b', 'b->a', None (keine Leistung / unbekannt)
    status: str                     # measured | calculated | partial | unknown | not_configured
    uncertain: bool = False
    note: Optional[str] = None
    sources: list[str] = field(default_factory=list)


def _edge(eid, a, b, signed: Optional[float], status, *, uncertain=False, note=None, sources=None, eps=1.0) -> Edge:
    if signed is None:
        return Edge(eid, a, b, None, None, status, uncertain, note, sources or [])
    if abs(signed) < eps:
        return Edge(eid, a, b, abs(signed), None, status, uncertain, note, sources or [])
    return Edge(eid, a, b, abs(signed), "a->b" if signed > 0 else "b->a", status, uncertain, note, sources or [])


def battery_net(r: dict[str, Optional[V]]) -> Optional[V]:
    """Netto-Batterieleistung (+Laden) aus Rolle battery_power oder charge/discharge."""
    bp = r.get("battery_net")
    if bp is not None and bp.known:
        return bp
    ch, dis = r.get("battery_charge_power"), r.get("battery_discharge_power")
    if ch is not None and dis is not None and ch.known and dis.known:
        return V(ch.value - dis.value, ch.good and dis.good, source=f"{ch.source},{dis.source}")
    return None


def grid_net(r: dict[str, Optional[V]]) -> Optional[V]:
    gp = r.get("grid_net")
    if gp is not None and gp.known:
        return gp
    imp, exp = r.get("grid_import_power"), r.get("grid_export_power")
    if imp is not None and exp is not None and imp.known and exp.known:
        return V(imp.value - exp.value, imp.good and exp.good, source=f"{imp.source},{exp.source}")
    return None


def compute_flows(r: dict[str, Optional[V]], configured: set[str]) -> dict:
    """Berechnet Linien der Energieflussgrafik.

    ``r`` enthält V-Objekte für: pv_power, inverter_output_power, house_power, battery_net,
    battery_charge_power, battery_discharge_power, grid_net, grid_import_power, grid_export_power.
    ``configured`` enthält die überhaupt konfigurierten Rollen (Unterscheidung „nicht
    konfiguriert“ vs. „derzeit keine Daten“).
    """
    pv = r.get("pv_power")
    out = r.get("inverter_output_power")
    house = r.get("house_power")
    bat = battery_net(r)
    grid = grid_net(r)
    has_battery = bool(configured & {"battery_power", "battery_charge_power", "battery_discharge_power"})
    has_grid = bool(configured & {"grid_power", "grid_import_power", "grid_export_power"})
    has_pv = "pv_power" in configured

    edges: list[Edge] = []
    nodes: dict[str, dict] = {}

    # PV → Wechselrichter
    if not has_pv:
        edges.append(_edge("pv_inverter", "pv", "inverter", None, "not_configured"))
    elif pv is None or not pv.known:
        edges.append(_edge("pv_inverter", "pv", "inverter", None, "unknown", note="Keine aktuellen PV-Daten"))
    else:
        edges.append(_edge("pv_inverter", "pv", "inverter", pv.value, "measured", uncertain=not pv.good, sources=[pv.source]))

    # Wechselrichter ↔ Batterie  (+ = Laden = inverter → battery)
    if not has_battery:
        edges.append(_edge("inverter_battery", "inverter", "battery", None, "not_configured"))
    elif bat is None:
        edges.append(_edge("inverter_battery", "inverter", "battery", None, "unknown", note="Batterieleistung nicht verfügbar"))
    else:
        edges.append(_edge("inverter_battery", "inverter", "battery", bat.value, "measured", uncertain=not bat.good, sources=[bat.source]))

    # Wechselrichter → Haus (AC-Ausgang)
    out_val: Optional[float] = None
    out_good = True
    if out is not None and out.known:
        out_val, out_good = out.value, out.good
        edges.append(_edge("inverter_house", "inverter", "house", out.value, "measured", uncertain=not out.good, sources=[out.source]))
    elif pv is not None and pv.known and (bat is not None or not has_battery):
        b = bat.value if bat is not None else 0.0
        out_val = pv.value - b
        out_good = pv.good and (bat.good if bat else True)
        edges.append(_edge("inverter_house", "inverter", "house", out_val, "calculated", uncertain=not out_good,
                           note="Berechnet: PV − Batterieladung + Batterieentladung (Wandlungsverluste nicht berücksichtigt)"))
    else:
        edges.append(_edge("inverter_house", "inverter", "house", None, "unknown", note="AC-Ausgang weder gemessen noch berechenbar"))

    # Netz ↔ Haus (+ = Bezug = grid → house)
    if grid is not None:
        edges.append(_edge("grid_house", "grid", "house", grid.value, "measured", uncertain=not grid.good, sources=[grid.source]))
    elif house is not None and house.known and not house.partial and out_val is not None:
        g = house.value - out_val
        edges.append(_edge("grid_house", "grid", "house", g, "calculated", uncertain=not (house.good and out_good),
                           note="Berechnet: Hausverbrauch − Wechselrichter-AC-Ausgang"))
    elif not has_grid:
        note = "Kein Netzzähler konfiguriert"
        if house is not None and house.partial:
            note += "; Hausverbrauch ist nur eine Teilmessung, daher keine Berechnung möglich"
        edges.append(_edge("grid_house", "grid", "house", None, "not_configured", note=note))
    else:
        edges.append(_edge("grid_house", "grid", "house", None, "unknown", note="Netzleistung nicht verfügbar"))

    # Knotenwerte
    nodes["pv"] = {"value_w": pv.value if pv and pv.known else None, "configured": has_pv}
    nodes["battery"] = {"value_w": bat.value if bat else None, "configured": has_battery}
    nodes["grid"] = {"value_w": grid.value if grid else None, "configured": has_grid}
    if house is not None and house.known:
        nodes["house"] = {"value_w": house.value, "status": "partial" if house.partial else "measured", "configured": True}
    elif grid is not None and out_val is not None:
        nodes["house"] = {"value_w": out_val + grid.value, "status": "calculated", "configured": True}
    else:
        nodes["house"] = {"value_w": None, "status": "unknown", "configured": "house_power" in configured}
    nodes["inverter"] = {"value_w": out_val, "configured": True}

    return {"nodes": nodes, "edges": [e.__dict__ for e in edges], "allocation": allocate(pv, house, bat, grid, has_battery)}


def allocate(pv: Optional[V], house: Optional[V], bat: Optional[V], grid: Optional[V], has_battery: bool) -> dict:
    """Aufteilung der Leistungsflüsse nach Quelle (PV→Haus, PV→Batterie, …).

    Nur möglich, wenn PV, Hausverbrauch (vollständig), Batterie (falls vorhanden) und Netz
    bekannt sind. Wandlungsverluste werden nicht zugeordnet (Näherung, dokumentiert).
    Priorität: PV deckt zuerst die Batterieladung, dann das Haus, der Rest geht ins Netz;
    die Batterieentladung deckt das Haus vor dem Netz.
    """
    missing = []
    if pv is None or not pv.known:
        missing.append("PV-Leistung")
    if house is None or not house.known:
        missing.append("Hausverbrauch")
    elif house.partial:
        missing.append("vollständiger Hausverbrauch (nur Teilmessung)")
    if has_battery and bat is None:
        missing.append("Batterieleistung")
    if grid is None:
        missing.append("Netzleistung (Bezug/Einspeisung)")
    if missing:
        return {"available": False, "missing": missing}
    p = max(pv.value, 0.0)
    h = max(house.value, 0.0)
    charge = max(bat.value, 0.0) if bat else 0.0
    discharge = max(-bat.value, 0.0) if bat else 0.0
    imp = max(grid.value, 0.0)
    exp = max(-grid.value, 0.0)
    pv_bat = min(p, charge)
    rest = p - pv_bat
    pv_house = min(rest, h)
    pv_grid = max(0.0, min(exp, rest - pv_house))
    bat_house = min(discharge, max(h - pv_house, 0.0))
    bat_grid = max(0.0, min(exp - pv_grid, discharge - bat_house))
    grid_house = max(0.0, min(imp, h - pv_house - bat_house))
    grid_bat = max(0.0, min(imp - grid_house, charge - pv_bat))
    flows = {"pv_house": pv_house, "pv_battery": pv_bat, "pv_grid": pv_grid, "battery_house": bat_house,
             "battery_grid": bat_grid, "grid_house": grid_house, "grid_battery": grid_bat}
    return {"available": True, "flows_w": {k: round(v, 1) for k, v in flows.items()},
            "note": "Näherung ohne Zuordnung von Wandlungsverlusten"}


def balance_checks(r: dict[str, Optional[V]], tol_w: float, tol_pct: float) -> list[dict]:
    """Prüft Knotenbilanzen, sofern alle beteiligten Größen gemessen sind. Rohdaten bleiben unverändert."""
    res = []
    pv, out, house = r.get("pv_power"), r.get("inverter_output_power"), r.get("house_power")
    bat = battery_net(r)
    grid = grid_net(r)
    if pv and pv.known and out and out.known and bat is not None:
        # Eingang PV + Entladung = Laden + AC-Ausgang + Verluste
        dev = pv.value - bat.value - out.value
        ref = max(abs(pv.value), abs(out.value), abs(bat.value))
        tol = max(tol_w, ref * tol_pct / 100)
        res.append({"node": "inverter", "name": "Wechselrichter-Bilanz", "deviation_w": round(dev, 1),
                    "tolerance_w": round(tol, 1), "ok": abs(dev) <= tol,
                    "formula": "PV − (Laden − Entladen) − AC-Ausgang",
                    "terms": {"pv_w": pv.value, "battery_net_w": bat.value, "ac_output_w": out.value},
                    "sources": [x for x in (pv.source, bat.source, out.source) if x]})
    if house and house.known and not house.partial and out and out.known and grid is not None:
        dev = out.value + grid.value - house.value
        ref = max(abs(house.value), abs(out.value), abs(grid.value))
        tol = max(tol_w, ref * tol_pct / 100)
        res.append({"node": "house", "name": "Hausanschluss-Bilanz", "deviation_w": round(dev, 1),
                    "tolerance_w": round(tol, 1), "ok": abs(dev) <= tol,
                    "formula": "AC-Ausgang + Netz (netto) − Hausverbrauch",
                    "terms": {"ac_output_w": out.value, "grid_net_w": grid.value, "house_w": house.value},
                    "sources": [x for x in (out.source, grid.source, house.source) if x]})
    return res


def self_consumption(pv_kwh: Optional[float], export_kwh: Optional[float]) -> dict:
    if pv_kwh is None:
        return {"available": False, "reason": "PV-Energie nicht verfügbar"}
    if export_kwh is None:
        return {"available": False, "reason": "Kein Einspeisezähler konfiguriert"}
    if pv_kwh <= 0:
        return {"available": False, "reason": "Keine PV-Erzeugung im Zeitraum"}
    if export_kwh < 0 or export_kwh > pv_kwh * 1.02:
        return {"available": False, "reason": "Unplausibel: Einspeisung größer als PV-Erzeugung"}
    used = max(pv_kwh - export_kwh, 0.0)
    return {"available": True, "energy_kwh": round(used, 3), "percent": round(used / pv_kwh * 100, 1)}


def autarky(house_kwh: Optional[float], import_kwh: Optional[float], house_partial: bool = False) -> dict:
    if house_kwh is None:
        return {"available": False, "reason": "Hausverbrauch nicht verfügbar"}
    if house_partial:
        return {"available": False, "reason": "Hausverbrauch ist nur eine Teilmessung"}
    if import_kwh is None:
        return {"available": False, "reason": "Kein Netzbezugszähler konfiguriert"}
    if house_kwh <= 0:
        return {"available": False, "reason": "Kein Verbrauch im Zeitraum"}
    if import_kwh < 0 or import_kwh > house_kwh * 1.02:
        return {"available": False, "reason": "Unplausibel: Netzbezug größer als Hausverbrauch"}
    own = max(house_kwh - import_kwh, 0.0)
    return {"available": True, "energy_kwh": round(own, 3), "percent": round(own / house_kwh * 100, 1)}


def grid_dependency(house_kwh: Optional[float], import_kwh: Optional[float], house_partial: bool = False) -> dict:
    a = autarky(house_kwh, import_kwh, house_partial)
    if not a["available"]:
        return a
    return {"available": True, "percent": round(import_kwh / house_kwh * 100, 1)}


def integrate_power(samples: Iterable[tuple[float, float]], start: float, end: float, max_gap: float,
                    prev: Optional[tuple[float, float]] = None) -> tuple[float, float]:
    """Integriert Leistungswerte (W) zu Energie (Wh) im Intervall [start, end).

    Verfahren: Halteglied (jeder Wert gilt bis zum nächsten Messwert), aber höchstens ``max_gap``
    Sekunden – längere Abstände sind Datenlücken und werden **nicht** interpoliert.
    ``prev`` ist der letzte Messwert vor ``start`` (für Kontinuität an Intervallgrenzen).
    Rückgabe: (Energie in Wh, abgedeckte Sekunden).
    """
    pts = sorted(samples)
    if prev is not None and prev[0] < start:
        pts = [prev] + pts
    wh = 0.0
    covered = 0.0
    for i, (ts, w) in enumerate(pts):
        nxt = pts[i + 1][0] if i + 1 < len(pts) else end
        seg_end = min(nxt, ts + max_gap, end)
        seg_start = max(ts, start)
        if seg_end > seg_start:
            dur = seg_end - seg_start
            wh += w * dur / 3600.0
            covered += dur
    return wh, covered


def conversion_efficiency(pv: Optional[V], charge: Optional[V], discharge: Optional[V], output: Optional[V],
                          min_input_w: float = 100.0) -> dict:
    """Momentaner Umwandlungsgrad = AC-Ausgang / (PV − Laden + Entladen).

    Nur gültig, wenn alle vier Größen gemessen, gültig und aus *demselben* Datensatz stammen
    (gleiche Quelle) und die Eingangsleistung mindestens ``min_input_w`` beträgt – sonst
    entstehen scheinpräzise Werte.
    """
    vals = (pv, charge, discharge, output)
    if any(v is None or not v.known or not v.good for v in vals):
        return {"available": False, "reason": "Nicht alle benötigten Messwerte gültig verfügbar"}
    inp = pv.value - charge.value + discharge.value
    if inp < min_input_w:
        return {"available": False, "reason": f"Eingangsleistung unter {min_input_w:.0f} W – keine aussagekräftige Berechnung"}
    eff = output.value / inp * 100
    if not 0 < eff <= 100.5:
        return {"available": False, "reason": f"Unplausibles Ergebnis ({eff:.0f} %) – Messzeitpunkte vermutlich nicht synchron"}
    return {"available": True, "percent": round(min(eff, 100.0), 1), "input_w": round(inp, 1)}
