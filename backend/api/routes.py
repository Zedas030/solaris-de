"""REST-API von SOLARIS. Lesende Endpunkte sind im Heimnetz offen, alle Verwaltungs-
endpunkte unter ``/api/admin`` verlangen ``Authorization: Bearer <SOLARIS_ADMIN_TOKEN>``."""
from __future__ import annotations

import asyncio
import csv
import hmac
import io
import json
import os
import time
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import ValidationError

from ..models.config_models import ROLES
from ..services.statistics import METRICS, Statistics
from ..services.units import CANONICAL_UNIT, KIND_UNITS

router = APIRouter(prefix="/api")
admin = APIRouter(prefix="/api/admin")

RANGES = {"15m": 900, "1h": 3600, "6h": 21600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}


def ctx(request: Request):
    return request.app.state.ctx


def require_admin(request: Request) -> str:
    token = request.app.state.ctx.env.get("SOLARIS_ADMIN_TOKEN")
    if not token:
        raise HTTPException(503, "Verwaltung deaktiviert: SOLARIS_ADMIN_TOKEN ist in .env nicht gesetzt")
    auth = request.headers.get("authorization", "")
    given = auth[7:] if auth.lower().startswith("bearer ") else ""
    if not given or not hmac.compare_digest(given.encode(), token.encode()):
        raise HTTPException(401, "Nicht autorisiert", headers={"WWW-Authenticate": "Bearer"})
    return request.client.host if request.client else "unbekannt"


def _resolve_range(c, range_: Optional[str], start: Optional[float], end: Optional[float]) -> tuple[float, float]:
    now = time.time()
    if start is not None:
        e = end if end is not None else now
        if e <= start:
            raise HTTPException(400, "end muss nach start liegen")
        return start, e
    if range_ in ("today", "yesterday"):
        st = Statistics(c.cfg_store.config, c.store)
        s, e, ps, pe = st.period_bounds("day")
        return (s, now) if range_ == "today" else (ps, pe)
    if range_ in RANGES:
        return now - RANGES[range_], now
    raise HTTPException(400, f"Unbekannter Zeitraum '{range_}'")


# ------------------------------------------------------------------ lesend
@router.get("/health")
def health(c=Depends(ctx)):
    col = c.collector
    return {"status": "ok", "time": time.time(), "uptime_s": round(time.time() - col.started_at),
            "last_tick": col.last_tick, "last_update": col.last_update, "db_ok": col.db_ok,
            "integrations": {k: v.status["state"] for k, v in col.integrations.items()}, "version": c.version}


@router.get("/overview")
def overview(c=Depends(ctx)):
    return c.collector.overview or c.collector.build_overview()


@router.get("/measurements/current")
def current(c=Depends(ctx), ids: Optional[str] = None):
    cfg = c.cfg_store.config
    want = set(ids.split(",")) if ids else None
    out = []
    for dp in cfg.datapoints:
        if not dp.enabled or (want and dp.id not in want):
            continue
        cur = c.collector.current.get(dp.id) or c.collector._empty(dp)
        out.append({**cur, "name": dp.name, "device": dp.device, "kind": dp.kind, "role": dp.role, "group": dp.group,
                    "index": dp.index, "partial": dp.partial, "estimated": dp.estimated, "interval": dp.interval,
                    "min": dp.min, "max": dp.max, "stale_after": dp.stale_seconds})
    return {"generated_at": time.time(), "measurements": out}


@router.get("/measurements/history")
def history(c=Depends(ctx), ids: str = Query(..., description="Kommagetrennte Messpunkt-IDs"),
            range: Optional[str] = Query("1h", alias="range"), start: Optional[float] = None, end: Optional[float] = None,
            max_points: int = Query(1500, ge=10, le=10000)):
    cfg = c.cfg_store.config
    s, e = _resolve_range(c, range, start, end)
    span = e - s
    dps = [cfg.datapoint(i) for i in ids.split(",") if i]
    if not dps or any(d is None for d in dps):
        raise HTTPException(404, "Unbekannter Messpunkt")
    if len(dps) > 12:
        raise HTTPException(400, "Höchstens 12 Messpunkte je Abfrage")
    if span <= 3 * 3600:
        bucket = 0
    else:
        bucket = max(60, int(span / max_points // 60 * 60) or 60)
    series = {}
    for dp in dps:
        if dp.kind == "state":
            continue
        if bucket == 0:
            rows = c.store.raw([dp.id], s, e, limit=max_points * 4)
            pts = [[r[1], r[2], r[2], r[2]] for r in rows if r[2] is not None]
        elif bucket >= 3600 or span > 10 * 86400:
            bucket = max(bucket, 3600)
            st = Statistics(cfg, c.store)
            rows = st.hours(dp.id, dp.kind, s, e)
            pts = [[h, r[1], r[2], r[3]] for h, r in sorted(rows.items()) if s - 3600 < h < e]
        else:
            pts = [[b, avg, mn, mx] for b, avg, mn, mx, n in c.store.bucketed(dp.id, s, e, bucket)]
        series[dp.id] = {"name": dp.name, "unit": dp.canonical_unit, "kind": dp.kind, "points": pts}
    gap = max(cfg.settings.storage.max_gap_s, bucket * 2.5)
    return {"start": s, "end": e, "bucket_s": bucket, "gap_threshold_s": gap, "series": series,
            "note": "Leere Zeitfenster sind Datenlücken und werden nicht interpoliert"}


@router.get("/measurements/raw")
def raw(c=Depends(ctx), id: str = Query(...), start: Optional[float] = None, end: Optional[float] = None,
        range: Optional[str] = "1h", limit: int = Query(500, ge=1, le=5000), offset: int = Query(0, ge=0)):
    s, e = _resolve_range(c, range, start, end)
    rows = c.store.raw([id], s, e, limit, offset)
    return {"total": c.store.count_raw([id], s, e), "limit": limit, "offset": offset,
            "rows": [{"ts": r[1], "value": r[2], "text": r[3], "quality": r[4]} for r in rows]}


@router.get("/statistics")
def statistics(c=Depends(ctx), group: str = Query("day", pattern="^(hour|day|month)$"), range: Optional[str] = None,
               period: Optional[str] = Query(None, pattern="^(day|week|month|year)$"),
               start: Optional[float] = None, end: Optional[float] = None, ref: Optional[float] = None):
    cfg = c.cfg_store.config
    st = Statistics(cfg, c.store)
    if period:
        s, e, _, _ = st.period_bounds(period, ref)
    else:
        s, e = _resolve_range(c, range or "7d", start, end)
    if (e - s) / 3600 > 24 * 62 and group == "hour":
        raise HTTPException(400, "Stundenauflösung höchstens für 62 Tage")
    if (e - s) / 86400 > 800 and group == "day":
        raise HTTPException(400, "Tagesauflösung höchstens für 800 Tage")
    buckets = c.collector.cached_stats(f"stats:{group}:{int(s)}:{int(e // 60)}", lambda: st.series(s, e, group), ttl=60)
    total = st.bucket(s, e, "day" if group == "hour" and e - s <= 86400 else "sum") if group != "hour" or e - s <= 86400 else None
    return {"start": s, "end": e, "group": group, "metrics": {k: v["label"] for k, v in METRICS.items()},
            "buckets": buckets, "total": total}


@router.get("/statistics/compare")
def compare(c=Depends(ctx), period: str = Query("day", pattern="^(day|week|month|year)$")):
    st = Statistics(c.cfg_store.config, c.store)
    return c.collector.cached_stats(f"cmp:{period}", lambda: st.compare(period), ttl=120)


@router.get("/summary/today")
def summary_today(c=Depends(ctx)):
    from ..services.summary import today_summary
    return c.collector.cached_stats("summary", lambda: today_summary(c.cfg_store.config, c.store), ttl=120)


@router.get("/setup-status")
def setup_status(c=Depends(ctx)):
    """Welche Angaben fehlen noch für eine vollständige Inbetriebnahme?"""
    cfg = c.cfg_store.config
    roles = {d.role: d for d in cfg.datapoints if d.enabled and d.role}
    checks = []

    def add(cid, ok, text, hint=None, level="warning"):
        checks.append({"id": cid, "ok": bool(ok), "text": text, "hint": None if ok else hint, "level": level})

    add("pv", "pv_power" in roles, "PV-Leistung zugeordnet", "Messpunkt mit Rolle pv_power anlegen")
    add("battery", "battery_soc" in roles, "Speicher-Ladezustand zugeordnet", "Messpunkt mit Rolle battery_soc anlegen")
    add("output", "inverter_output_power" in roles, "Wechselrichter-AC-Ausgang zugeordnet", "Messpunkt mit Rolle inverter_output_power anlegen")
    hp = roles.get("house_power")
    add("house", hp is not None and not hp.partial, "Vollständiger Hausverbrauch gemessen",
        "Derzeit nur Summe einzelner Steckdosen. Für einen vollständigen Wert wird ein Netzzähler benötigt "
        "(Hausverbrauch = AC-Ausgang + Netzbezug − Einspeisung).")
    add("grid", any(r in roles for r in ("grid_power", "grid_import_power", "grid_export_power")),
        "Netzbezug/Einspeisung gemessen",
        "Zweirichtungszähler auslesen (z. B. IR-Lesekopf/Tasmota, Shelly Pro 3EM, Tibber Pulse, Smart-Meter-Gateway) "
        "und per MQTT/Home Assistant als Rolle grid_power mit Vorzeichenkonvention einbinden.")
    add("grid_counters", "grid_import_today" in roles and "grid_export_today" in roles, "Netz-Tageszähler vorhanden",
        "Nötig für Eigenverbrauchsquote, Autarkiegrad und Netzabhängigkeit.", level="info")
    add("kwp", cfg.site.pv_peak_kwp is not None, "Installierte PV-Nennleistung (kWp) eingetragen",
        "Wert aus Datenblatt/Anlagenpass unter Einstellungen → Anlage eintragen (für spezifischen Ertrag).", level="info")
    add("capacity", cfg.site.battery_capacity_kwh is not None, "Nutzbare Speicherkapazität eingetragen",
        "Wert aus Datenblatt unter Einstellungen → Anlage eintragen (für kWh-Inhalt und Restlaufzeit).", level="info")
    add("admin", bool(c.env.get("SOLARIS_ADMIN_TOKEN")), "Verwaltungszugang abgesichert", "SOLARIS_ADMIN_TOKEN in .env setzen")
    for i in c.collector.integrations.values():
        if i.cfg.enabled:
            add(f"int:{i.id}", i.status["state"] in ("connected", "degraded"), f"Datenquelle „{i.cfg.name}“ verbunden",
                i.status.get("message") or "Verbindung prüfen", level="error")
    return {"checks": checks, "complete": all(x["ok"] for x in checks if x["level"] != "info")}


@router.get("/devices")
def devices(c=Depends(ctx)):
    cfg = c.cfg_store.config
    out = []
    for d in cfg.devices:
        dps = [p.id for p in cfg.datapoints if p.device == d.id]
        evs, _ = c.store.events(device=d.id, limit=5)
        out.append({**d.model_dump(), **{"status": c.collector.device_status(d.id)}, "datapoints": dps,
                    "recent_events": [e for e in evs if e["severity"] != "info"][:5]})
    return {"devices": out}


@router.get("/integrations")
def integrations(c=Depends(ctx)):
    return {"integrations": [i.public_info() for i in c.collector.integrations.values()]}


@router.get("/events")
def events(c=Depends(ctx), severity: Optional[str] = Query(None, pattern="^(info|warning|error)$"),
           limit: int = Query(100, ge=1, le=1000), offset: int = Query(0, ge=0), device: Optional[str] = None):
    items, total = c.store.events(severity, limit, offset, device)
    return {"total": total, "limit": limit, "offset": offset, "events": items, "active": c.collector.conditions.list()}


@router.get("/config")
def config(c=Depends(ctx)):
    """Nicht geheime Konfiguration (Geheimnisse stehen nie in der Konfigurationsdatei)."""
    data = c.cfg_store.as_dict()
    return {**data, "meta": {"roles": ROLES, "kinds": {k: list(v) for k, v in KIND_UNITS.items()},
                             "canonical_units": CANONICAL_UNIT, "admin_enabled": bool(c.env.get("SOLARIS_ADMIN_TOKEN")),
                             "version": c.version}}


@router.get("/system")
def system(c=Depends(ctx)):
    return {"database": c.store.stats(), "config_path": c.cfg_store.path, "version": c.version,
            "backups": sorted(os.listdir(c.backup_dir))[-20:] if os.path.isdir(c.backup_dir) else []}


@router.get("/export/csv")
def export_csv(c=Depends(ctx), ids: str = Query(...), range: Optional[str] = "today", start: Optional[float] = None,
               end: Optional[float] = None, resolution: str = Query("raw", pattern="^(raw|hour)$"),
               sep: str = Query(";", max_length=1)):
    cfg = c.cfg_store.config
    s, e = _resolve_range(c, range, start, end)
    dps = [cfg.datapoint(i) for i in ids.split(",") if i]
    if not dps or any(d is None for d in dps):
        raise HTTPException(404, "Unbekannter Messpunkt")
    tz = Statistics(cfg, c.store).tz

    def gen():
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=sep)
        if resolution == "raw":
            w.writerow(["timestamp", "unix_ts", "datapoint_id", "name", "value", "unit", "quality", "source"])
        else:
            w.writerow(["hour_start", "unix_ts", "datapoint_id", "name", "avg", "min", "max", "samples", "energy_wh",
                        "unit", "quality", "coverage_s"])
        yield buf.getvalue()
        for dp in dps:
            if resolution == "raw":
                offset = 0
                while True:
                    rows = c.store.raw([dp.id], s, e, 5000, offset)
                    if not rows:
                        break
                    buf.seek(0); buf.truncate()
                    for r in rows:
                        w.writerow([datetime.fromtimestamp(r[1], tz).isoformat(timespec="seconds"), f"{r[1]:.3f}", dp.id,
                                    dp.name, r[2] if r[2] is not None else (r[3] or ""), dp.canonical_unit, r[4], dp.integration])
                    yield buf.getvalue()
                    offset += len(rows)
            else:
                rows = Statistics(cfg, c.store).hours(dp.id, dp.kind, s, e)
                buf.seek(0); buf.truncate()
                for h, r in sorted(rows.items()):
                    if not (s - 3600 < h < e):
                        continue
                    w.writerow([datetime.fromtimestamp(h, tz).isoformat(timespec="seconds"), h, dp.id, dp.name,
                                round(r[1], 4), r[2], r[3], r[5], "" if r[6] is None else round(r[6], 2),
                                dp.canonical_unit, "aggregated", "" if r[9] is None else round(r[9])])
                yield buf.getvalue()

    fname = f"solaris-{datetime.fromtimestamp(s, tz):%Y%m%d-%H%M}-{datetime.fromtimestamp(e, tz):%Y%m%d-%H%M}.csv"
    return StreamingResponse(gen(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@router.get("/stream")
async def stream(request: Request, c=Depends(ctx)):
    """Server-Sent Events: sendet bei jedem Erfassungstakt die aktuelle Übersicht."""
    q = c.collector.subscribe()

    async def gen():
        try:
            yield "retry: 3000\n\n"
            if c.collector.overview:
                yield f"event: overview\ndata: {json.dumps(c.collector.overview, default=str)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"event: overview\ndata: {json.dumps(data, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            c.collector.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------------- Verwaltung
def _save(c, actor: str, action: str, target: str, mutate) -> dict:
    data = c.cfg_store.as_dict()
    before = json.loads(json.dumps(data))
    result = mutate(data)
    try:
        cfg = c.cfg_store.validate(data)
    except ValidationError as e:
        raise HTTPException(422, {"message": "Konfiguration ungültig – nichts gespeichert",
                                  "errors": [err["msg"] for err in e.errors()]})
    c.cfg_store.save(cfg.model_dump(mode="json"))
    c.store.audit(actor, action, target, result.get("before") if isinstance(result, dict) else None,
                  result.get("after") if isinstance(result, dict) else None)
    c.store.add_event("info", "config", f"Konfiguration geändert: {action} {target}", details={"by": actor})
    return {"ok": True}


async def _apply(c):
    await c.collector.reload()


@admin.post("/login")
def login(actor: str = Depends(require_admin)):
    return {"ok": True, "message": "Angemeldet"}


@admin.get("/audit")
def audit(c=Depends(ctx), _: str = Depends(require_admin), limit: int = Query(100, le=1000)):
    return {"audit": c.store.audit_log(limit)}


@admin.post("/validate")
def validate(payload: dict = Body(...), c=Depends(ctx), _: str = Depends(require_admin)):
    try:
        c.cfg_store.validate(payload)
        return {"ok": True}
    except ValidationError as e:
        return {"ok": False, "errors": [err["msg"] for err in e.errors()]}


def _upsert(collection: str):
    async def handler(item_id: str, payload: dict = Body(...), c=Depends(ctx), actor: str = Depends(require_admin)):
        if payload.get("id") != item_id:
            raise HTTPException(400, "ID in URL und Inhalt stimmen nicht überein")

        def mutate(data):
            items = data[collection]
            idx = next((i for i, x in enumerate(items) if x["id"] == item_id), None)
            before = items[idx] if idx is not None else None
            if idx is None:
                items.append(payload)
            else:
                items[idx] = payload
            return {"before": before, "after": payload}

        exists = any(x["id"] == item_id for x in c.cfg_store.as_dict()[collection])
        res = _save(c, actor, "geändert" if exists else "erstellt", f"{collection}/{item_id}", mutate)
        await _apply(c)
        return res
    return handler


def _delete(collection: str):
    async def handler(item_id: str, c=Depends(ctx), actor: str = Depends(require_admin)):
        def mutate(data):
            items = data[collection]
            before = next((x for x in items if x["id"] == item_id), None)
            if before is None:
                raise HTTPException(404, "Nicht gefunden")
            data[collection] = [x for x in items if x["id"] != item_id]
            return {"before": before, "after": None}
        res = _save(c, actor, "gelöscht", f"{collection}/{item_id}", mutate)
        await _apply(c)
        return res
    return handler


for coll, path in (("datapoints", "datapoints"), ("devices", "devices"), ("integrations", "integrations")):
    admin.put(f"/{path}/{{item_id}}")(_upsert(coll))
    admin.delete(f"/{path}/{{item_id}}")(_delete(coll))


@admin.put("/settings")
async def put_settings(payload: dict = Body(...), c=Depends(ctx), actor: str = Depends(require_admin)):
    def mutate(data):
        before = {"settings": data["settings"], "site": data["site"]}
        if "settings" in payload:
            data["settings"] = payload["settings"]
        if "site" in payload:
            data["site"] = payload["site"]
        return {"before": before, "after": payload}
    res = _save(c, actor, "geändert", "settings", mutate)
    await _apply(c)
    return res


@admin.post("/integrations/{item_id}/test")
async def test_integration(item_id: str, c=Depends(ctx), _: str = Depends(require_admin)):
    inst = c.collector.integrations.get(item_id)
    if not inst:
        raise HTTPException(404, "Integration nicht gefunden")
    return await inst.test()


@admin.post("/integrations/{item_id}/discover")
async def discover(item_id: str, c=Depends(ctx), _: str = Depends(require_admin), seconds: float = Query(5, ge=1, le=30)):
    inst = c.collector.integrations.get(item_id)
    if not inst:
        raise HTTPException(404, "Integration nicht gefunden")
    try:
        items = await inst.discover(seconds)
    except Exception as e:  # noqa: BLE001
        from ..integrations.base import sanitize
        raise HTTPException(502, sanitize(f"Ermittlung fehlgeschlagen: {type(e).__name__}: {e}", inst.secrets()))
    return {"items": items}


@admin.get("/backup")
def backup_config(c=Depends(ctx), _: str = Depends(require_admin)):
    data = c.cfg_store.as_dict()
    body = json.dumps({"solaris_backup": 1, "created": time.time(), "config": data}, ensure_ascii=False, indent=2)
    return JSONResponse(json.loads(body), headers={
        "Content-Disposition": f'attachment; filename="solaris-config-{time.strftime("%Y%m%d-%H%M%S")}.json"'})


@admin.post("/restore")
async def restore(payload: dict = Body(...), c=Depends(ctx), actor: str = Depends(require_admin)):
    data = payload.get("config", payload)
    try:
        cfg = c.cfg_store.validate(data)
    except ValidationError as e:
        raise HTTPException(422, {"message": "Sicherung ungültig – nichts geändert", "errors": [err["msg"] for err in e.errors()]})
    before = c.cfg_store.as_dict()
    c.cfg_store.save(cfg.model_dump(mode="json"))
    c.store.audit(actor, "wiederhergestellt", "config", before, cfg.model_dump(mode="json"))
    c.store.add_event("info", "config", "Konfiguration aus Sicherung wiederhergestellt", details={"by": actor})
    await _apply(c)
    return {"ok": True}


@admin.post("/db-backup")
async def db_backup(c=Depends(ctx), _: str = Depends(require_admin)):
    dest = os.path.join(c.backup_dir, time.strftime("solaris-db-%Y%m%d-%H%M%S.sqlite"))
    await asyncio.to_thread(c.store.backup, dest)
    c.store.add_event("info", "database", "Datenbanksicherung erstellt", details={"file": os.path.basename(dest)})
    return {"ok": True, "file": os.path.basename(dest), "size_bytes": os.path.getsize(dest)}


@admin.get("/db-backup/{name}")
def db_backup_download(name: str, c=Depends(ctx), _: str = Depends(require_admin)):
    if "/" in name or not name.startswith("solaris-db-"):
        raise HTTPException(400, "Ungültiger Dateiname")
    p = os.path.join(c.backup_dir, name)
    if not os.path.exists(p):
        raise HTTPException(404, "Nicht gefunden")
    return FileResponse(p, filename=name)


@admin.post("/rollup/reset")
async def rollup_reset(c=Depends(ctx), actor: str = Depends(require_admin)):
    c.store.reset_rollup()
    c.collector._stats_cache.clear()
    c.store.add_event("info", "database", "Stundenaggregate werden neu berechnet", details={"by": actor})
    return {"ok": True}
