"""A fake trading server and a scripted model, so every test runs with no network and no Claude."""
from __future__ import annotations

import json
from typing import Any, Callable

from agents_py.errors import BudgetExceeded, CallCapped, ClaudeUnreachable, ServerRefused

RISK = {
    "lotMode": "fixed", "fixedLot": 0.01, "riskPercent": 0.5, "minLot": 0.01, "maxLot": 0.5, "lotStep": 0.01,
    "slMode": "points", "slPoints": 200, "slAtrMult": 2, "tpMode": "points", "tpPoints": 300, "tpAtrMult": 3, "tpRR": 2,
    "trailingEnabled": False, "trailingStartPoints": 0, "trailingStepPoints": 0, "breakEvenPoints": 0,
    "maxSpreadPoints": 40, "maxOpenPositions": 1, "maxDailyLossPercent": 3, "maxDailyTrades": 10, "cooldownBars": 3,
    "sessions": [], "tradingDays": [], "closeOnOppositeSignal": False, "minRewardRisk": 1.5, "maxSpreadToStopRatio": 0.3,
    "flatAtUTC": "21:45", "flatBeforeWeekend": True,
}


def dossier(**over: Any) -> dict[str, Any]:
    d = {
        "generatedAt": 1, "strategy": {"id": "str_a", "name": "Gold scalp", "symbol": "XAUUSD", "timeframe": "1m", "risk": dict(RISK)},
        "stage": "demo", "tier": 3,
        "market": {"symbol": "XAUUSD", "timeframe": "1m", "key": "XAUUSD|1m|vol:mid|trend:mid|spread:mid", "state": None, "snapshot": None},
        "demo": {"days": 14, "trades": 60, "net": -35.5, "profitFactor": 0.8, "avgWin": 4, "avgLoss": 5, "winRatePct": 41, "maxDrawdown": 60},
        "slices": {"direction": [], "hourUtc": [], "spread": []},
        "lessons": {"optimizer": ["setting=risk.tpPoints | change=up | effect=helped | agree=5 | against=0 | trust=1.00 | last=2026-10-01"], "doctor": [], "guard": [], "critic": [], "strategist": []},
        "holds": [], "openChange": None, "theories": {"attempts": []}, "recentChanges": [], "notes": [], "trimmed": [],
    }
    d.update(over)
    return d


def j(o: Any) -> str:
    return json.dumps(o)


DOCTOR_WRONG = j({"wrong": True, "finding": "Losses cluster in high volatility: 14 of 20 stopped out within 2 bars.", "evidence": ["14 of 20 losses stopped out in 2 bars"]})
DOCTOR_FINE = j({"wrong": False, "finding": "Results are within normal range for 60 trades.", "evidence": []})


def theory(changes: dict[str, Any] | None = None, claim: str = "Stops are too tight in high volatility") -> str:
    return j({
        "claim": claim, "changes": changes or {"risk": {"slPoints": 180}},
        "disproof": {"metric": "profitFactor", "op": "<", "value": 1},
        "checklist": {"evidence": "14 of 20 losses stopped out within 2 bars", "change": "slPoints 200 -> 180"},
    })


CRITIC_OK = j({"verdict": "support", "points": ["Evidence is specific and the change is small."]})
CRITIC_NO = j({"verdict": "oppose", "points": ["Only 60 trades; this may be noise."]})


class FakeServer:
    """Stands in for the trading server. `models` maps an agent to a reply or a function of (prompt, call number)."""

    def __init__(self, dossier_data: dict[str, Any] | None = None, models: dict[str, Any] | None = None):
        self.dossier_data = dossier_data or dossier()
        self.models = models or {"doctor": DOCTOR_WRONG, "optimizer": theory(), "critic": CRITIC_OK}
        self.calls: list[tuple[str, str]] = []  # (agent, prompt)
        self.notes: list[dict[str, Any]] = []
        self.backtests: list[dict[str, Any]] = []
        self.proposals: list[dict[str, Any]] = []
        self.survives = True
        self.backtest_error: ServerRefused | None = None
        self.propose_error: ServerRefused | None = None
        self.llm_error: Exception | None = None
        self.on_llm: Callable[[str, int], None] | None = None
        self.network_calls = 0

    def dossier(self, strategy_id: str) -> dict[str, Any]:
        if self.dossier_data is None:
            raise ServerRefused(404, "No such strategy.")
        return self.dossier_data

    def backtest(self, run_id: str, strategy_id: str, agent: str, theory_: dict[str, Any]) -> dict[str, Any]:
        self.backtests.append(theory_)
        if self.backtest_error:
            raise self.backtest_error
        reasons = ["Held up on unseen data."] if self.survives else ["The theory met its own disproof line (profitFactor < 1 on unseen bars): it is dropped."]
        return {"trialId": f"trial{len(self.backtests)}", "status": "survived" if self.survives else "dropped", "survived": self.survives, "reasons": reasons, "testWindow": {"from": 1, "to": 2}}

    def llm(self, run_id: str, agent: str, prompt: str) -> str:
        n = len(self.calls) + 1
        self.calls.append((agent, prompt))
        if self.llm_error:
            raise self.llm_error
        if self.on_llm:
            self.on_llm(agent, n)
        reply = self.models.get(agent)
        if callable(reply):
            return reply(prompt, sum(1 for a, _ in self.calls if a == agent))
        if isinstance(reply, list):
            return reply[min(sum(1 for a, _ in self.calls if a == agent) - 1, len(reply) - 1)]
        return reply

    def note(self, run_id: str, strategy_id: str, agent: str, text: str, evidence: list[str]) -> None:
        self.notes.append({"agent": agent, "text": text, "evidence": evidence})

    def propose(self, run_id: str, strategy_id: str, trial_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        if self.propose_error:
            raise self.propose_error
        self.proposals.append({"trialId": trial_id, "changes": changes})
        return {"proposalId": f"prop{len(self.proposals)}", "summary": "Update Gold scalp: slPoints 200 -> 180"}

    def calls_by(self, agent: str) -> int:
        return sum(1 for a, _ in self.calls if a == agent)
