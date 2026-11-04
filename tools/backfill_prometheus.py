#!/usr/bin/env python3
"""Importiert vorhandene Historie aus Prometheus (Home-Assistant-Metriken) in die SOLARIS-Datenbank.

Verwendet werden nur Messpunkte der Prometheus-Integration sowie Messpunkte mit ``backfill``-Angabe
(z. B. MQTT-Werte, die Home Assistant parallel erfasst). Zeiträume, in denen Home Assistant die
Entität als nicht verfügbar gemeldet hat, werden übersprungen. Es wird nichts interpoliert;
Duplikate werden über (Messpunkt, Zeitstempel) verhindert.

Aufruf:  .venv/bin/python tools/backfill_prometheus.py --days 35 [--step 60] [--only id1,id2]
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from backend.integrations.prometheus import PrometheusIntegration  # noqa: E402
from backend.services.config_store import ConfigStore  # noqa: E402
from backend.services.store import Store  # noqa: E402
from backend.services.units import to_canonical, units_compatible  # noqa: E402


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=35)
    ap.add_argument("--step", type=int, default=60)
    ap.add_argument("--only", default="")
    ap.add_argument("--config", default=os.path.join(ROOT, "data/config/solaris.json"))
    ap.add_argument("--db", default=os.path.join(ROOT, "data/database/solaris.sqlite"))
    a = ap.parse_args()
    cfg = ConfigStore(a.config).config
    store = Store(a.db)
    only = set(filter(None, a.only.split(",")))
    end = time.time()
    start = end - a.days * 86400
    total = 0
    for dp in cfg.datapoints:
        if not dp.store or dp.kind == "state" or (only and dp.id not in only):
            continue
        if dp.integration in {i.id for i in cfg.integrations if i.type == "prometheus"}:
            integ_id, entity = dp.integration, dp.source.get("entity")
        elif dp.backfill:
            integ_id, entity = dp.backfill.get("integration"), dp.backfill.get("entity")
        else:
            continue
        ic = next((i for i in cfg.integrations if i.id == integ_id), None)
        if not ic or not entity:
            continue
        prom = PrometheusIntegration(ic, [], {}, lambda r: None, lambda *x: None)
        rows, skipped = [], 0
        t = start
        while t < end:
            chunk_end = min(t + 86400 * 5, end)
            try:
                pts = await prom.query_range(entity, t, chunk_end, a.step)
            except Exception as e:  # noqa: BLE001
                print(f"  {dp.id}: Fehler {type(e).__name__}: {e}")
                pts = []
            for ts, v, unit in pts:
                if not units_compatible(dp.kind, unit, dp.unit):
                    skipped += 1
                    continue
                val = to_canonical(v * dp.scale + dp.offset, dp.kind, dp.unit)
                if dp.invert:
                    val = -val
                if dp.sign_convention in ("export_positive", "discharge_positive"):
                    val = -val
                if (dp.min is not None and val < dp.min) or (dp.max is not None and val > dp.max):
                    skipped += 1
                    continue
                rows.append((dp.id, ts, val, None, "good", "prometheus-import"))
            t = chunk_end
        n = store.insert_many(rows) if rows else 0
        total += max(n, 0)
        print(f"{dp.id:32s} {entity:55s} {len(rows):7d} Werte, {skipped} verworfen")
    store.reset_rollup()
    kinds = {d.id: d.kind for d in cfg.datapoints if d.store}
    h = store.rollup(kinds, cfg.settings.storage.max_gap_s)
    store.add_event("info", "database", f"Historie aus Prometheus importiert ({a.days:g} Tage)",
                    details={"rows": total, "hourly": h})
    store.close()
    print(f"Fertig: {total} Zeilen importiert, {h} Stundenwerte berechnet.")


if __name__ == "__main__":
    asyncio.run(main())
