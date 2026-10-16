"""Runs the graph for one request and reads saved runs back."""
from __future__ import annotations

import sqlite3
import threading
from typing import Any

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.sqlite import SqliteSaver

from .client import ServerClient
from .config import Settings
from .graph import build_graph
from .model import Model
from .nodes import Deps


class Busy(Exception):
    """A run is already going on this strategy."""


def make_checkpointer(path: str | None):
    """A saved-runs file of its own (never the trading database). None = in memory, for tests."""
    if not path:
        return InMemorySaver()
    conn = sqlite3.connect(path, check_same_thread=False)
    return SqliteSaver(conn)


class Engine:
    def __init__(self, client: ServerClient, settings: Settings | None = None, checkpointer=None):
        self.client = client
        self.settings = settings or Settings()
        self.graph = build_graph(checkpointer or InMemorySaver())
        self._active: dict[str, str] = {}
        self._lock = threading.Lock()

    def run(self, run_id: str, strategy_id: str, kind: str = "tune", trigger: str = "owner") -> dict[str, Any]:
        """Run to the end and return the result. One run per strategy at a time."""
        with self._lock:
            if strategy_id in self._active:
                raise Busy(f"A run is already in progress on this strategy ({self._active[strategy_id]}).")
            self._active[strategy_id] = run_id
        model = Model(self.client, run_id, self.settings.max_calls)
        config = {"configurable": {"thread_id": run_id, "deps": Deps(self.client, model, self.settings.max_rounds)}}
        try:
            # durability="sync": each step is saved before the next begins, so a run can be read while it is still going.
            final = self.graph.invoke({"run_id": run_id, "strategy_id": strategy_id, "kind": kind, "trigger": trigger, "steps": []}, config, durability="sync")
        finally:
            with self._lock:
                self._active.pop(strategy_id, None)
        return {
            "runId": run_id,
            "outcome": final.get("outcome", "error"),
            "summary": final.get("summary", "The run ended without an answer."),
            "steps": final.get("steps", []),
            "proposalId": final.get("proposal_id"),
            "modelCalls": model.used,
        }

    def trace(self, run_id: str) -> dict[str, Any] | None:
        """Steps so far (or all of them), read from the saved run. None when there is no such run."""
        snap = self.graph.get_state({"configurable": {"thread_id": run_id}})
        if not snap or not snap.values:
            return None
        v = snap.values
        return {
            "runId": run_id,
            "status": "running" if snap.next else "done",
            "steps": v.get("steps", []),
            "outcome": v.get("outcome"),
            "summary": v.get("summary"),
            "proposalId": v.get("proposal_id"),
        }

    def history(self, run_id: str) -> list[dict[str, Any]]:
        """Every saved step of a run, oldest first: the full trail (for debugging and replay)."""
        states = list(self.graph.get_state_history({"configurable": {"thread_id": run_id}}))
        return [{"next": list(s.next), "steps": len(s.values.get("steps", []))} for s in reversed(states)]
