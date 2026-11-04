"""SQLite-Speicherung von Messwerten, Stundenaggregaten, Ereignissen und Konfigurationsänderungen."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from typing import Any, Iterable, Optional

from .energy import integrate_power

SCHEMA = """
CREATE TABLE IF NOT EXISTS measurements (
    dp_id   TEXT NOT NULL,
    ts      REAL NOT NULL,
    value   REAL,
    text    TEXT,
    quality TEXT NOT NULL,
    source  TEXT,
    PRIMARY KEY (dp_id, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_meas_ts ON measurements(ts);

CREATE TABLE IF NOT EXISTS hourly (
    dp_id     TEXT NOT NULL,
    hour      INTEGER NOT NULL,
    avg       REAL, min REAL, max REAL, last REAL,
    n         INTEGER NOT NULL,
    energy_wh REAL,
    energy_pos_wh REAL,
    energy_neg_wh REAL,
    covered_s REAL,
    PRIMARY KEY (dp_id, hour)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        REAL NOT NULL,
    severity  TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
    category  TEXT NOT NULL,
    device    TEXT,
    datapoint TEXT,
    message   TEXT NOT NULL,
    details   TEXT,
    cond_key  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS config_audit (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      REAL NOT NULL,
    actor   TEXT,
    action  TEXT NOT NULL,
    target  TEXT,
    before  TEXT,
    after   TEXT
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


class Store:
    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, check_same_thread=False, timeout=30)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.executescript(SCHEMA)
        self._db.commit()
        self._pending: list[tuple] = []

    # ---------------------------------------------------------------- Messwerte
    def queue(self, dp_id: str, ts: float, value: Optional[float], text: Optional[str], quality: str, source: str) -> None:
        with self._lock:
            self._pending.append((dp_id, round(ts, 3), value, text, quality, source))

    def flush(self) -> int:
        """Schreibt gepufferte Messwerte gebündelt. Bei Fehler bleiben sie im Puffer (kein stilles Verwerfen)."""
        with self._lock:
            if not self._pending:
                return 0
            rows = self._pending
            try:
                self._db.executemany(
                    "INSERT OR IGNORE INTO measurements(dp_id, ts, value, text, quality, source) VALUES (?,?,?,?,?,?)", rows)
                self._db.commit()
            except sqlite3.Error:
                self._db.rollback()
                if len(self._pending) > 200_000:   # Speicherschutz: älteste verwerfen erst bei extremem Rückstau
                    self._pending = self._pending[-200_000:]
                raise
            self._pending = []
            return len(rows)

    def insert_many(self, rows: Iterable[tuple]) -> int:
        with self._lock:
            cur = self._db.executemany(
                "INSERT OR IGNORE INTO measurements(dp_id, ts, value, text, quality, source) VALUES (?,?,?,?,?,?)", rows)
            self._db.commit()
            return cur.rowcount

    def raw(self, dp_ids: list[str], start: float, end: float, limit: int = 10000, offset: int = 0) -> list[tuple]:
        q = ",".join("?" * len(dp_ids))
        with self._lock:
            return self._db.execute(
                f"SELECT dp_id, ts, value, text, quality FROM measurements WHERE dp_id IN ({q}) AND ts >= ? AND ts < ? "
                f"ORDER BY ts, dp_id LIMIT ? OFFSET ?", (*dp_ids, start, end, limit, offset)).fetchall()

    def count_raw(self, dp_ids: list[str], start: float, end: float) -> int:
        q = ",".join("?" * len(dp_ids))
        with self._lock:
            return self._db.execute(f"SELECT COUNT(*) FROM measurements WHERE dp_id IN ({q}) AND ts >= ? AND ts < ?",
                                    (*dp_ids, start, end)).fetchone()[0]

    def bucketed(self, dp_id: str, start: float, end: float, bucket: int) -> list[tuple]:
        """Mittelwert/Min/Max je Zeitfenster aus Rohdaten; leere Fenster entfallen (= Datenlücke)."""
        with self._lock:
            return self._db.execute(
                "SELECT CAST(ts / ? AS INTEGER) * ? AS b, AVG(value), MIN(value), MAX(value), COUNT(*) "
                "FROM measurements WHERE dp_id = ? AND ts >= ? AND ts < ? AND value IS NOT NULL "
                "GROUP BY b ORDER BY b", (bucket, bucket, dp_id, start, end)).fetchall()

    def hourly_rows(self, dp_id: str, start: float, end: float) -> list[tuple]:
        with self._lock:
            return self._db.execute(
                "SELECT hour, avg, min, max, last, n, energy_wh, energy_pos_wh, energy_neg_wh, covered_s FROM hourly WHERE dp_id=? AND hour>=? AND hour<? ORDER BY hour",
                (dp_id, int(start), int(end))).fetchall()

    def last_before(self, dp_id: str, ts: float) -> Optional[tuple[float, float]]:
        with self._lock:
            row = self._db.execute("SELECT ts, value FROM measurements WHERE dp_id=? AND ts<? AND value IS NOT NULL "
                                   "ORDER BY ts DESC LIMIT 1", (dp_id, ts)).fetchone()
        return (row[0], row[1]) if row else None

    def latest(self, dp_id: str) -> Optional[tuple]:
        with self._lock:
            return self._db.execute("SELECT ts, value, text, quality FROM measurements WHERE dp_id=? ORDER BY ts DESC LIMIT 1",
                                    (dp_id,)).fetchone()

    def first_ts(self) -> Optional[float]:
        with self._lock:
            r = self._db.execute("SELECT MIN(ts) FROM measurements").fetchone()
        return r[0] if r else None

    # ------------------------------------------------------------- Aggregation
    def compute_hour(self, dp_id: str, hour: int, kind: str, max_gap: float) -> Optional[tuple]:
        start, end = hour, hour + 3600
        with self._lock:
            rows = self._db.execute("SELECT ts, value FROM measurements WHERE dp_id=? AND ts>=? AND ts<? AND value IS NOT NULL ORDER BY ts",
                                    (dp_id, start, end)).fetchall()
        if not rows:
            return None
        vals = [r[1] for r in rows]
        energy = pos = neg = covered = None
        if kind == "power":
            prev = self.last_before(dp_id, start)
            if prev and start - prev[0] > max_gap:
                prev = None
            energy, covered = integrate_power(rows, start, end, max_gap, prev)
            pos, _ = integrate_power([(t, max(v, 0.0)) for t, v in rows], start, end, max_gap,
                                     (prev[0], max(prev[1], 0.0)) if prev else None)
            neg = pos - energy   # Betrag des negativen Anteils
        return (dp_id, hour, sum(vals) / len(vals), min(vals), max(vals), vals[-1], len(vals), energy, pos, neg, covered)

    def rollup(self, datapoints: dict[str, str], max_gap: float, until: Optional[float] = None) -> int:
        """Berechnet Stundenaggregate für alle abgeschlossenen Stunden ab der letzten Aggregation."""
        until = until or time.time()
        last_full_hour = int(until // 3600 * 3600) - 3600
        done = 0
        for dp_id, kind in datapoints.items():
            if kind == "state":
                continue
            key = f"rollup:{dp_id}"
            start_hour = self.get_meta(key)
            if start_hour is None:
                with self._lock:
                    r = self._db.execute("SELECT MIN(ts) FROM measurements WHERE dp_id=?", (dp_id,)).fetchone()
                if not r or r[0] is None:
                    continue
                start_hour = int(r[0] // 3600 * 3600)
            else:
                start_hour = int(start_hour) + 3600
            rows = []
            h = start_hour
            while h <= last_full_hour:
                row = self.compute_hour(dp_id, h, kind, max_gap)
                if row:
                    rows.append(row)
                h += 3600
            if rows:
                with self._lock:
                    self._db.executemany("INSERT OR REPLACE INTO hourly VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
                    self._db.commit()
                done += len(rows)
            if start_hour <= last_full_hour:
                self.set_meta(key, str(last_full_hour))
        return done

    def reset_rollup(self, dp_id: Optional[str] = None) -> None:
        with self._lock:
            if dp_id:
                self._db.execute("DELETE FROM meta WHERE key=?", (f"rollup:{dp_id}",))
            else:
                self._db.execute("DELETE FROM meta WHERE key LIKE 'rollup:%'")
            self._db.commit()

    # -------------------------------------------------------------- Ereignisse
    def add_event(self, severity: str, category: str, message: str, device: Optional[str] = None,
                  datapoint: Optional[str] = None, details: Optional[dict] = None, cond_key: Optional[str] = None,
                  ts: Optional[float] = None) -> int:
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO events(ts, severity, category, device, datapoint, message, details, cond_key) VALUES (?,?,?,?,?,?,?,?)",
                (ts or time.time(), severity, category, device, datapoint, message,
                 json.dumps(details, ensure_ascii=False) if details else None, cond_key))
            self._db.commit()
            return cur.lastrowid

    def events(self, severity: Optional[str] = None, limit: int = 100, offset: int = 0,
               device: Optional[str] = None) -> tuple[list[dict], int]:
        where, args = [], []
        if severity:
            where.append("severity=?"); args.append(severity)
        if device:
            where.append("device=?"); args.append(device)
        w = ("WHERE " + " AND ".join(where)) if where else ""
        with self._lock:
            total = self._db.execute(f"SELECT COUNT(*) FROM events {w}", args).fetchone()[0]
            rows = self._db.execute(f"SELECT id, ts, severity, category, device, datapoint, message, details FROM events {w} "
                                    f"ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?", (*args, limit, offset)).fetchall()
        out = [{"id": r[0], "ts": r[1], "severity": r[2], "category": r[3], "device": r[4], "datapoint": r[5],
                "message": r[6], "details": json.loads(r[7]) if r[7] else None} for r in rows]
        return out, total

    # ------------------------------------------------------------------ Audit
    def audit(self, actor: str, action: str, target: str, before: Any, after: Any) -> None:
        with self._lock:
            self._db.execute("INSERT INTO config_audit(ts, actor, action, target, before, after) VALUES (?,?,?,?,?,?)",
                             (time.time(), actor, action, target,
                              json.dumps(before, ensure_ascii=False) if before is not None else None,
                              json.dumps(after, ensure_ascii=False) if after is not None else None))
            self._db.commit()

    def audit_log(self, limit: int = 100) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT id, ts, actor, action, target, before, after FROM config_audit ORDER BY id DESC LIMIT ?",
                                    (limit,)).fetchall()
        return [{"id": r[0], "ts": r[1], "actor": r[2], "action": r[3], "target": r[4],
                 "before": json.loads(r[5]) if r[5] else None, "after": json.loads(r[6]) if r[6] else None} for r in rows]

    # ------------------------------------------------------------------- Meta
    def get_meta(self, key: str) -> Optional[str]:
        with self._lock:
            r = self._db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return r[0] if r else None

    def set_meta(self, key: str, value: str) -> None:
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)", (key, value))
            self._db.commit()

    # ------------------------------------------------------ Pflege & Backup
    def retention(self, raw_days: int, hourly_days: Optional[int], events_days: int) -> dict:
        """Löscht Rohwerte nur dort, wo bereits Stundenaggregate existieren."""
        now = time.time()
        cut_raw = now - raw_days * 86400
        res = {}
        with self._lock:
            cur = self._db.execute(
                "DELETE FROM measurements WHERE ts < ? AND EXISTS (SELECT 1 FROM hourly h WHERE h.dp_id = measurements.dp_id "
                "AND h.hour = CAST(measurements.ts / 3600 AS INTEGER) * 3600)", (cut_raw,))
            res["raw_deleted"] = cur.rowcount
            if hourly_days:
                res["hourly_deleted"] = self._db.execute("DELETE FROM hourly WHERE hour < ?", (now - hourly_days * 86400,)).rowcount
            res["events_deleted"] = self._db.execute("DELETE FROM events WHERE ts < ?", (now - events_days * 86400,)).rowcount
            self._db.commit()
        return res

    def stats(self) -> dict:
        with self._lock:
            n = self._db.execute("SELECT COUNT(*) FROM measurements").fetchone()[0]
            h = self._db.execute("SELECT COUNT(*) FROM hourly").fetchone()[0]
            e = self._db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            first = self._db.execute("SELECT MIN(ts) FROM measurements").fetchone()[0]
        size = sum(os.path.getsize(p) for p in (self.path, self.path + "-wal") if os.path.exists(p))
        return {"measurements": n, "hourly": h, "events": e, "first_ts": first, "size_bytes": size,
                "pending": len(self._pending)}

    def backup(self, dest: str) -> str:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with self._lock:
            target = sqlite3.connect(dest)
            self._db.backup(target)
            target.close()
        return dest

    def integrity_ok(self) -> bool:
        with self._lock:
            return self._db.execute("PRAGMA quick_check").fetchone()[0] == "ok"

    def close(self) -> None:
        with self._lock:
            try:
                self.flush()
            finally:
                self._db.close()
