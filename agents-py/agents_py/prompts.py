"""What each agent is told. Short on purpose: the numbers come from the dossier, never from memory."""
from __future__ import annotations

import json
from typing import Any

CHANGE_FIELDS = "risk (any risk field, e.g. {\"risk\":{\"slPoints\":180}}), indicators, entryLong, entryShort, exitLong, exitShort, name"


def dossier_text(d: dict[str, Any], who: str) -> str:
    """The parts of the dossier an agent needs, as compact JSON."""
    keep = {
        "strategy": d.get("strategy"),
        "stage": d.get("stage"),
        "tier": d.get("tier"),
        "market": d.get("market"),
        "demo": d.get("demo"),
        "slices": d.get("slices"),
        "recentChanges": d.get("recentChanges"),
        "attempts": (d.get("theories") or {}).get("attempts"),
        "notes": d.get("notes"),
        "lessons": (d.get("lessons") or {}).get(who, []),
        "holds": d.get("holds"),
    }
    return json.dumps(keep, separators=(",", ":"))


def doctor(d: dict[str, Any]) -> str:
    return (
        "You are the DOCTOR agent of a trading app. Look at one strategy's real demo results and decide whether something is going wrong, and where.\n"
        "Use only the numbers below. Do not invent numbers. If the sample is too small or nothing stands out, say nothing is wrong.\n"
        "Reply with ONLY this JSON:\n"
        '{"wrong": true|false, "finding": "one or two sentences", "evidence": ["short fact with its number", "..."]}\n\n'
        f"DOSSIER\n{dossier_text(d, 'doctor')}"
    )


def optimizer(d: dict[str, Any], diagnosis: dict[str, Any], objections: list[str]) -> str:
    redo = ""
    if objections:
        redo = (
            "\nThe CRITIC objected to your last proposal:\n- " + "\n- ".join(objections) +
            "\nChange your theory or your change to answer this, or pick a different change.\n"
        )
    return (
        "You are the OPTIMIZER agent. Form ONE theory for why the strategy is failing and the ONE change that follows from it.\n"
        f"The change uses these fields only: {CHANGE_FIELDS}. Change one or two parameters at most. Never loosen a risk limit.\n"
        "State the result on bars nobody has seen that would PROVE YOUR THEORY WRONG (metric netProfitPct, profitFactor, maxDrawdownPct, winRatePct or trades; op < <= > >=; a number).\n"
        "Rows under lessons are proven results in exactly this market. HOLD means the results disagree, so do not touch that setting.\n"
        "Reply with ONLY this JSON:\n"
        '{"claim": "what is going wrong and why", "changes": {"risk": {"slPoints": 180}}, '
        '"disproof": {"metric": "profitFactor", "op": "<", "value": 1}, '
        '"checklist": {"evidence": "the numbers it comes from", "change": "one line: what changes from what to what"}}\n'
        f"{redo}\nDOCTOR'S FINDING\n{json.dumps(diagnosis)}\n\nDOSSIER\n{dossier_text(d, 'optimizer')}"
    )


def critic(d: dict[str, Any], theory: dict[str, Any], trial: dict[str, Any]) -> str:
    return (
        "You are the CRITIC agent. Argue AGAINST this proposal where it is warranted: too few trades, too many changes at once, fitted to noise, repeats a past failure, reasoning does not follow from the evidence. Be fair: if it is sound, support it.\n"
        "Reply with ONLY this JSON:\n"
        '{"verdict": "support"|"caution"|"oppose", "points": ["at most 3 short points"]}\n\n'
        f"THEORY\n{json.dumps(theory)}\n\nTEST ON UNSEEN BARS\n{json.dumps(trial)}\n\nDOSSIER\n{dossier_text(d, 'critic')}"
    )
