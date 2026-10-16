"""The service's HTTP face: start a run, read a run. Nothing else."""
from __future__ import annotations

import hmac
import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from .client import HttpServerClient, ServerClient
from .config import Settings
from .engine import Busy, Engine, make_checkpointer


class RunRequest(BaseModel):
    runId: str
    strategyId: str
    kind: str = "tune"
    trigger: str = "owner"


def create_app(settings: Settings | None = None, client: ServerClient | None = None, engine: Engine | None = None) -> FastAPI:
    st = settings or Settings.from_env()
    eng = engine or Engine(client or HttpServerClient(st.server_url, st.agent_key), st, make_checkpointer(st.db_path))
    app = FastAPI(title="XAutoTrade agent service")

    def check(key: str | None) -> None:
        # The trading server sends the same key it hands to this service. With no key configured, only this computer can reach it.
        if st.agent_key and not hmac.compare_digest(key or "", st.agent_key):
            raise HTTPException(401, "Invalid or missing agent key.")

    @app.get("/health")
    def health() -> dict:
        return {"ok": True}

    @app.post("/runs")
    def start(req: RunRequest, x_agent_key: str | None = Header(default=None)) -> dict:
        check(x_agent_key)
        if req.kind not in ("diagnose", "tune"):
            raise HTTPException(400, "kind must be diagnose or tune.")
        try:
            return eng.run(req.runId, req.strategyId, req.kind, req.trigger)
        except Busy as e:
            raise HTTPException(409, str(e))

    @app.get("/runs/{run_id}")
    def read(run_id: str, x_agent_key: str | None = Header(default=None)) -> dict:
        check(x_agent_key)
        t = eng.trace(run_id)
        if t is None:
            raise HTTPException(404, "No such run.")
        return t

    return app


def main() -> None:
    import uvicorn

    st = Settings.from_env()
    uvicorn.run(create_app(st), host="127.0.0.1", port=st.port)


if __name__ == "__main__":
    main()
