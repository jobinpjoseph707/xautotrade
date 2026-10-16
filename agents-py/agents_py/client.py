"""
How the service talks to the trading server. The server's agent key opens exactly five routes, so
this file is also the full list of what the service can do: read a dossier, ask for a test, ask for a
model answer, leave a note, submit a proposal.
"""
from __future__ import annotations

from typing import Any, Protocol

import httpx

from .errors import BudgetExceeded, CallCapped, ClaudeUnreachable, ServerRefused


class ServerClient(Protocol):
    def dossier(self, strategy_id: str) -> dict[str, Any]: ...

    def backtest(self, run_id: str, strategy_id: str, agent: str, theory: dict[str, Any]) -> dict[str, Any]: ...

    def llm(self, run_id: str, agent: str, prompt: str) -> str: ...

    def note(self, run_id: str, strategy_id: str, agent: str, text: str, evidence: list[str]) -> None: ...

    def propose(self, run_id: str, strategy_id: str, trial_id: str, changes: dict[str, Any]) -> dict[str, Any]: ...


class HttpServerClient:
    def __init__(self, base_url: str, agent_key: str, timeout: float = 300.0):
        self._http = httpx.Client(base_url=f"{base_url.rstrip('/')}/api/agent", headers={"x-agent-key": agent_key}, timeout=timeout)

    def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        try:
            res = self._http.request(method, path, json=body)
        except httpx.HTTPError as err:
            raise ServerRefused(0, f"could not reach the trading server: {err}", "unreachable") from err
        try:
            data = res.json()
        except ValueError:
            data = {}
        if res.status_code == 200 and data.get("ok"):
            return data.get("data")
        code = data.get("code")
        message = data.get("error") or f"the server answered {res.status_code}"
        if code == "claude_unreachable":
            raise ClaudeUnreachable(message)
        if code == "call_cap":
            raise CallCapped(message)
        if code == "run_budget":
            raise BudgetExceeded(message)
        raise ServerRefused(res.status_code, message, code)

    def dossier(self, strategy_id: str) -> dict[str, Any]:
        return self._call("GET", f"/dossier/{strategy_id}")

    def backtest(self, run_id: str, strategy_id: str, agent: str, theory: dict[str, Any]) -> dict[str, Any]:
        return self._call("POST", "/backtest", {"runId": run_id, "strategyId": strategy_id, "agent": agent, "theory": theory})

    def llm(self, run_id: str, agent: str, prompt: str) -> str:
        return self._call("POST", "/llm", {"runId": run_id, "agent": agent, "prompt": prompt})["text"]

    def note(self, run_id: str, strategy_id: str, agent: str, text: str, evidence: list[str]) -> None:
        self._call("POST", "/notes", {"runId": run_id, "strategyId": strategy_id, "agent": agent, "text": text, "evidence": evidence})

    def propose(self, run_id: str, strategy_id: str, trial_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        return self._call("POST", "/proposals", {"runId": run_id, "strategyId": strategy_id, "trialId": trial_id, "changes": changes})
