"""SOLARIS – lokales Energie-Dashboard. Start: ``uvicorn backend.app:app --host 0.0.0.0 --port 8095``"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.routes import admin, router
from .services.collector import Collector
from .services.config_store import ConfigStore, load_env
from .services.store import Store

VERSION = "1.0.0"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

logging.basicConfig(level=os.environ.get("SOLARIS_LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)


@dataclass
class Context:
    env: dict
    cfg_store: ConfigStore
    store: Store
    collector: Collector
    backup_dir: str
    version: str = VERSION


def create_app(config_path: str | None = None, db_path: str | None = None, env_path: str | None = None,
               start_collector: bool = True) -> FastAPI:
    env = load_env(env_path if env_path is not None else os.path.join(ROOT, ".env"))
    data_dir = env.get("SOLARIS_DATA_DIR", os.path.join(ROOT, "data"))
    config_path = config_path or os.path.join(data_dir, "config", "solaris.json")
    db_path = db_path or os.path.join(data_dir, "database", "solaris.sqlite")
    backup_dir = os.path.join(os.path.dirname(os.path.dirname(db_path)), "backups")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        cfg_store = ConfigStore(config_path)
        store = Store(db_path)
        col = Collector(cfg_store, store, env)
        app.state.ctx = Context(env, cfg_store, store, col, backup_dir)
        if start_collector:
            await col.start()
        else:
            col.overview = col.build_overview()
        yield
        await col.stop()
        store.close()

    app = FastAPI(title="SOLARIS API", version=VERSION, lifespan=lifespan,
                  description="Lokales Energie-Monitoring (nur lesend). Verwaltungsendpunkte unter /api/admin erfordern einen Bearer-Token.")
    app.include_router(router)
    app.include_router(admin)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        if not request.url.path.startswith("/api/"):
            resp.headers.setdefault("Content-Security-Policy",
                                    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'")
        return resp

    @app.exception_handler(404)
    async def not_found(request: Request, exc):
        if request.url.path.startswith("/api/"):
            detail = getattr(exc, "detail", "Nicht gefunden")
            return JSONResponse({"detail": detail}, status_code=404)
        return FileResponse(os.path.join(ROOT, "frontend", "index.html"))

    frontend = os.path.join(ROOT, "frontend")
    app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    return app


app = create_app()
