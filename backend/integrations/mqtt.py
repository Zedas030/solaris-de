"""MQTT-Integration (nur Abonnieren – es wird niemals publiziert)."""
from __future__ import annotations

import asyncio
import json
import ssl
import time
import uuid
from typing import Any

import paho.mqtt.client as mqtt

from .base import BaseIntegration, Reading, parse_payload


class MqttIntegration(BaseIntegration):
    kind = "mqtt"

    def _client(self, suffix: str) -> mqtt.Client:
        cid = (self.cfg.client_id or "solaris") + f"-{suffix}-{uuid.uuid4().hex[:6]}"
        c = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id=cid)
        user = self.secret(self.cfg.username_env)
        if user:
            c.username_pw_set(user, self.secret(self.cfg.password_env))
        if self.cfg.tls:
            c.tls_set(cert_reqs=ssl.CERT_REQUIRED)
        c.reconnect_delay_set(min_delay=2, max_delay=60)
        return c

    def _port(self) -> int:
        return self.cfg.port or (8883 if self.cfg.tls else 1883)

    async def start(self) -> None:
        if not self.cfg.enabled:
            self.set_status("disabled")
            return
        loop = asyncio.get_running_loop()
        self._loop = loop
        self._client_rt = c = self._client("ro")
        topics = sorted({d.source.get("topic") for d in self.datapoints if d.source.get("topic")})

        def on_connect(client, userdata, flags, reason_code, properties):
            if reason_code.is_failure:
                loop.call_soon_threadsafe(self.set_status, "error", f"Verbindung abgelehnt: {reason_code}")
                return
            for t in topics:
                client.subscribe(t, qos=0)
            loop.call_soon_threadsafe(self.set_status, "connected", f"{len(topics)} Topics abonniert", True)

        def on_disconnect(client, userdata, flags, reason_code, properties):
            loop.call_soon_threadsafe(self.set_status, "disconnected", f"Verbindung getrennt ({reason_code})")

        def on_message(client, userdata, msg):
            now = time.time()
            for dp in self.datapoints:
                t = dp.source.get("topic")
                if t and mqtt.topic_matches_sub(t, msg.topic):
                    try:
                        val = parse_payload(msg.payload, dp.source.get("json_path"))
                    except Exception:
                        val = None
                    r = Reading(dp.id, val, now, available=val is not None, retained=bool(msg.retain),
                                note=None if val is not None else "Feld nicht im Payload enthalten")
                    loop.call_soon_threadsafe(self.sink, r)
            loop.call_soon_threadsafe(self._mark_ok)

        c.on_connect, c.on_disconnect, c.on_message = on_connect, on_disconnect, on_message
        self.set_status("connecting", f"{self.cfg.host}:{self._port()}")
        try:
            c.connect_async(self.cfg.host, self._port(), keepalive=30)
            c.loop_start()
        except Exception as e:  # noqa: BLE001
            self.set_status("error", f"Verbindungsfehler: {e}")

    def _mark_ok(self) -> None:
        self.status["last_ok"] = time.time()

    async def stop(self) -> None:
        c = getattr(self, "_client_rt", None)
        if c:
            c.disconnect()
            c.loop_stop()
            self._client_rt = None

    async def _probe(self, subscribe: str | None, seconds: float) -> dict[str, Any]:
        result: dict[str, Any] = {"connected": False, "error": None, "messages": {}}
        done = asyncio.Event()
        loop = asyncio.get_running_loop()
        c = self._client("probe")

        def on_connect(client, userdata, flags, reason_code, properties):
            if reason_code.is_failure:
                result["error"] = f"Verbindung abgelehnt: {reason_code}"
                loop.call_soon_threadsafe(done.set)
                return
            result["connected"] = True
            if subscribe:
                client.subscribe(subscribe)
            else:
                loop.call_soon_threadsafe(done.set)

        def on_message(client, userdata, msg):
            if len(result["messages"]) < 500:
                result["messages"][msg.topic] = (msg.payload[:2000], msg.retain)

        c.on_connect, c.on_message = on_connect, on_message
        try:
            c.connect_async(self.cfg.host, self._port(), keepalive=15)
            c.loop_start()
            try:
                await asyncio.wait_for(done.wait(), timeout=seconds if subscribe else self.cfg.timeout)
            except asyncio.TimeoutError:
                if not result["connected"] and not result["error"]:
                    result["error"] = "Zeitüberschreitung beim Verbindungsaufbau"
        except Exception as e:  # noqa: BLE001
            result["error"] = str(e)
        finally:
            c.disconnect()
            c.loop_stop()
        return result

    async def test(self) -> dict:
        r = await self._probe(None, self.cfg.timeout)
        from .base import sanitize
        return {"ok": r["connected"], "message": "Broker erreichbar" if r["connected"] else sanitize(r["error"] or "Fehler", self.secrets())}

    async def discover(self, seconds: float = 5) -> list[dict]:
        r = await self._probe("#", seconds)
        out = []
        for topic, (payload, retained) in sorted(r["messages"].items()):
            text = payload.decode("utf-8", "replace")
            fields = []
            try:
                data = json.loads(text)
                if isinstance(data, dict):
                    for k, v in data.items():
                        if isinstance(v, (int, float, str)) and not isinstance(v, bool):
                            fields.append({"path": k, "value": v})
                elif isinstance(data, (int, float)):
                    fields.append({"path": None, "value": data})
            except ValueError:
                fields.append({"path": None, "value": text[:80]})
            if topic.startswith("homeassistant/") and topic.endswith("/config"):
                continue  # Discovery-Konfigurationen sind keine Messwerte
            out.append({"topic": topic, "retained": retained, "sample": text[:300], "fields": fields})
        return out
