"""
The agents as graph steps. Each step reads the shared state, adds what it found, and passes it on.
A step that decides the run is over sets `outcome`; the graph then ends. Only `submit` can ask for a proposal,
and only with a test the server says survived.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable

from langchain_core.runnables import RunnableConfig

from . import prompts
from .client import ServerClient
from .errors import BudgetExceeded, CallCapped, ClaudeUnreachable, RunStop, ServerRefused
from .model import Model, flat
from .risk import hits_hold, loosens_risk, risk_of_changes
from .state import RunState


@dataclass
class Deps:
    client: ServerClient
    model: Model
    max_rounds: int


def step(agent: str, text: str, data: Any = None) -> dict[str, Any]:
    out: dict[str, Any] = {"agent": agent, "at": int(time.time() * 1000), "text": flat(text, 600)}
    if data is not None:
        out["data"] = data
    return out


def stop(outcome: str, summary: str, agent: str = "system") -> dict[str, Any]:
    return {"outcome": outcome, "summary": summary, "steps": [step(agent, summary)]}


def deps_of(config: RunnableConfig) -> Deps:
    return config["configurable"]["deps"]


def safe(fn: Callable[[RunState, Deps], dict[str, Any]]) -> Callable[[RunState, RunnableConfig], dict[str, Any]]:
    """Run a step; turn every way it can fail into an outcome, so a run always ends with an answer."""

    def run(state: RunState, config: RunnableConfig) -> dict[str, Any]:
        try:
            return fn(state, deps_of(config))
        except RunStop as e:
            return stop(e.outcome, e.summary)
        except BudgetExceeded as e:
            return stop("budget", f"Stopped: {e}")
        except ClaudeUnreachable as e:
            return stop("claude_unreachable", f"Claude could not be reached: {e}")
        except CallCapped as e:
            return stop("call_cap", f"Stopped: {e}")
        except ServerRefused as e:
            return stop("error", f"The trading server refused: {e.message}")
        except Exception as e:  # a bug must not leave the run hanging
            return stop("error", f"Unexpected error: {type(e).__name__}: {e}")

    run.__name__ = fn.__name__
    return run


# --- the steps ---------------------------------------------------------------


def load(state: RunState, d: Deps) -> dict[str, Any]:
    try:
        dossier = d.client.dossier(state["strategy_id"])
    except ServerRefused as e:
        if e.status == 404:
            return stop("error", "That strategy no longer exists.")
        raise
    demo = dossier.get("demo") or {}
    text = f"Loaded the dossier: {dossier['strategy'].get('name')} ({dossier.get('stage')}, tier {dossier.get('tier')}, {demo.get('trades', 0)} demo trades in the last {demo.get('days', 0)} days)."
    waiting = dossier.get("openChange")
    if waiting:
        return {"dossier": dossier, **stop("refused", f"A change to this strategy is already {waiting['status']}: {waiting['summary']}. One change at a time.", "dossier")}
    return {"dossier": dossier, "rounds": 0, "objections": [], "steps": [step("dossier", text)]}


def _doctor_check(data: Any) -> str | None:
    if not isinstance(data, dict) or not isinstance(data.get("wrong"), bool):
        return 'it needs {"wrong": true|false, "finding": "...", "evidence": [...]}.'
    if not isinstance(data.get("finding"), str) or not data["finding"].strip():
        return "it needs a finding."
    return None


def doctor(state: RunState, d: Deps) -> dict[str, Any]:
    data = d.model.ask_json("doctor", prompts.doctor(state["dossier"]), _doctor_check)
    evidence = [flat(e, 200) for e in (data.get("evidence") or []) if isinstance(e, str)][:6]
    d.client.note(state["run_id"], state["strategy_id"], "doctor", data["finding"], evidence)
    s = step("doctor", data["finding"], {"wrong": data["wrong"], "evidence": evidence})
    if not data["wrong"]:
        return {"diagnosis": data, "outcome": "nothing_wrong", "summary": f"Nothing is wrong: {flat(data['finding'])}", "steps": [s]}
    if state.get("kind") == "diagnose":
        return {"diagnosis": data, "outcome": "diagnosed", "summary": flat(data["finding"]), "steps": [s]}
    return {"diagnosis": data, "steps": [s]}


def _theory_check(data: Any) -> str | None:
    if not isinstance(data, dict):
        return "it must be a JSON object."
    if not isinstance(data.get("claim"), str) or not data["claim"].strip():
        return "it needs a claim."
    if not isinstance(data.get("changes"), dict) or not data["changes"]:
        return "it needs a non-empty changes object."
    dp = data.get("disproof")
    if not isinstance(dp, dict) or not all(k in dp for k in ("metric", "op", "value")):
        return "it needs a disproof with metric, op and value."
    cl = data.get("checklist")
    if not isinstance(cl, dict) or not cl.get("evidence") or not cl.get("change"):
        return "it needs a checklist with evidence and change."
    return None


def optimizer(state: RunState, d: Deps) -> dict[str, Any]:
    rounds = state.get("rounds", 0)
    data = d.model.ask_json("optimizer", prompts.optimizer(state["dossier"], state.get("diagnosis") or {}, state.get("objections") or []), _theory_check)
    theory = {
        "claim": data["claim"], "changes": data["changes"], "disproof": data["disproof"], "checklist": data["checklist"],
        # The rows the optimizer was shown, so the proposal can say what it leaned on. Taken from the dossier, not from the model.
        "lessonsUsed": list((state["dossier"].get("lessons") or {}).get("optimizer", [])),
    }
    d.client.note(state["run_id"], state["strategy_id"], "optimizer", data["claim"], [flat(data["checklist"].get("evidence"), 200)])
    s = step("optimizer", f"{data['claim']} Change: {flat(data['checklist'].get('change'))}", {"changes": data["changes"], "disproof": data["disproof"], "round": rounds})
    held = hits_hold(data["changes"], state["dossier"].get("holds") or [])
    if held:
        msg = f"Past results disagree about {', '.join(held)} in this market, so the run holds and changes nothing."
        return {"theory": theory, "outcome": "hold", "summary": msg, "steps": [s, step("optimizer", f"On hold: {', '.join(held)}.")]}
    return {"theory": theory, "steps": [s]}


def tester(state: RunState, d: Deps) -> dict[str, Any]:
    t = state["theory"]
    try:
        res = d.client.backtest(state["run_id"], state["strategy_id"], "optimizer", t)
    except ServerRefused as e:
        if e.code == "hold":
            return stop("hold", f"Held: {e.message}", "tester")
        if e.code == "open_change":
            return stop("refused", e.message, "tester")
        return stop("refused", f"The test could not be run: {e.message}", "tester")
    reasons = [flat(r, 200) for r in (res.get("reasons") or [])][:3]
    s = step("tester", ("The theory survived the test on unseen bars. " if res.get("survived") else "The theory did not survive the test on unseen bars. ") + " ".join(reasons), {"trialId": res.get("trialId"), "testWindow": res.get("testWindow")})
    if not res.get("survived"):
        d.client.note(state["run_id"], state["strategy_id"], "tester", f"Theory dropped: {t['claim']} ({reasons[0] if reasons else 'failed its test'})", reasons)
        return {"trial": res, "outcome": "dropped", "summary": f"The theory was dropped: {reasons[0] if reasons else 'it failed its test'}", "steps": [s]}
    return {"trial": res, "steps": [s]}


def _critic_check(data: Any) -> str | None:
    if not isinstance(data, dict) or data.get("verdict") not in ("support", "caution", "oppose"):
        return 'it needs {"verdict": "support"|"caution"|"oppose", "points": [...]}.'
    return None


def critic(state: RunState, d: Deps) -> dict[str, Any]:
    data = d.model.ask_json("critic", prompts.critic(state["dossier"], state["theory"], state["trial"]), _critic_check)
    points = [flat(p, 200) for p in (data.get("points") or []) if isinstance(p, str)][:3]
    s = step("critic", f"{data['verdict'].capitalize()}. " + " ".join(points), {"verdict": data["verdict"], "points": points})
    d.client.note(state["run_id"], state["strategy_id"], "critic", f"{data['verdict']}: " + " ".join(points), [])
    if data["verdict"] == "oppose":
        rounds = state.get("rounds", 0)
        if rounds >= d.max_rounds:
            return {"critic": data, "outcome": "no_agreement", "summary": f"The Critic still objected after {rounds} rounds, so no proposal was made.", "steps": [s]}
        return {"critic": data, "rounds": rounds + 1, "objections": points or ["The critic opposed it."], "steps": [s]}
    return {"critic": data, "objections": [], "steps": [s]}


def risk_guard(state: RunState, d: Deps) -> dict[str, Any]:
    changes = state["theory"]["changes"]
    why = loosens_risk(state["dossier"]["strategy"]["risk"], risk_of_changes(changes))
    if why:
        d.client.note(state["run_id"], state["strategy_id"], "risk_guard", f"Refused: the change {why}.", [])
        return stop("refused", f"The Risk Guard refused the change: it {why}.", "risk_guard")
    return {"steps": [step("risk_guard", "No risk limit is loosened." if risk_of_changes(changes) else "The change does not touch the risk limits.")]}


def submit(state: RunState, d: Deps) -> dict[str, Any]:
    try:
        res = d.client.propose(state["run_id"], state["strategy_id"], state["trial"]["trialId"], state["theory"]["changes"])
    except ServerRefused as e:
        return stop("refused", f"The server did not accept the proposal: {e.message}", "submit")
    return {
        "proposal_id": res["proposalId"], "outcome": "proposal",
        "summary": f"A proposal is waiting in the Inbox: {flat(res.get('summary'))}", "steps": [step("submit", f"Sent to the Inbox for your approval: {flat(res.get('summary'))}", {"proposalId": res["proposalId"]})],
    }
