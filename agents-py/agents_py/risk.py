"""
The Risk Guard's check. It mirrors the server's own `gateViolation` (server/src/learning/propose.ts),
which stays the authority: the server refuses a looser change whatever this says. The two are kept in
step by tests/fixtures/risk_cases.json, which the server generates from its own code.
"""
from __future__ import annotations

import re
from typing import Any


def _tighter_or_equal(before: float, after: float) -> bool:
    """For limits where 0 means off: after may only be tighter."""
    if before <= 0:
        return True
    return after > 0 and after <= before


def _hhmm(v: Any) -> int:
    m = re.match(r"^(\d{1,2}):(\d{2})$", v or "")
    return int(m.group(1)) * 60 + int(m.group(2)) if m else 21 * 60 + 45


def _allowed_hours(risk: dict[str, Any]) -> list[bool]:
    sessions = risk.get("sessions") or []
    out = []
    for h in range(24):
        if not sessions:
            out.append(True)
            continue
        on = False
        for s in sessions:
            a, b = s["startHour"], s["endHour"]
            on = on or (a <= h < b if a <= b else (h >= a or h < b))
        out.append(on)
    return out


def _allowed_days(risk: dict[str, Any]) -> list[int]:
    days = risk.get("tradingDays") or []
    return list(days) if days else [0, 1, 2, 3, 4, 5, 6]


def loosens_risk(before: dict[str, Any], risk_changes: dict[str, Any]) -> str | None:
    """Why this change loosens a risk limit, or None when every limit is tighter or equal."""
    after = {**before, **risk_changes}
    if after["fixedLot"] > before["fixedLot"]:
        return "raises fixedLot"
    if after["riskPercent"] > before["riskPercent"]:
        return "raises riskPercent"
    if after["maxLot"] > before["maxLot"]:
        return "raises maxLot"
    if after["maxOpenPositions"] > before["maxOpenPositions"]:
        return "raises maxOpenPositions"
    if not _tighter_or_equal(before["maxDailyLossPercent"], after["maxDailyLossPercent"]):
        return "loosens maxDailyLossPercent"
    if not _tighter_or_equal(before["maxDailyTrades"], after["maxDailyTrades"]):
        return "loosens maxDailyTrades"
    if not _tighter_or_equal(before["maxSpreadPoints"], after["maxSpreadPoints"]):
        return "loosens maxSpreadPoints"
    if after["cooldownBars"] < before["cooldownBars"]:
        return "shortens cooldownBars"
    if after["minRewardRisk"] < before["minRewardRisk"]:
        return "lowers minRewardRisk"
    if after["maxSpreadToStopRatio"] > before["maxSpreadToStopRatio"]:
        return "raises maxSpreadToStopRatio"
    if before.get("flatBeforeWeekend") and not after.get("flatBeforeWeekend"):
        return "turns off the weekend flat rule"
    if _hhmm(after.get("flatAtUTC")) > _hhmm(before.get("flatAtUTC")):
        return "moves the daily flat time later"
    b, a = _allowed_hours(before), _allowed_hours(after)
    if any(on and not b[h] for h, on in enumerate(a)):
        return "widens trading sessions"
    if not any(a):
        return "removes every trading hour"
    bd, ad = set(_allowed_days(before)), _allowed_days(after)
    if any(d not in bd for d in ad):
        return "widens trading days"
    if not ad:
        return "removes every trading day"
    return None


def risk_of_changes(changes: dict[str, Any]) -> dict[str, Any]:
    r = changes.get("risk")
    return r if isinstance(r, dict) else {}


def touched_settings(changes: dict[str, Any]) -> set[str]:
    """Names of the settings a change touches, in the words the lesson ledger uses (risk.slPoints, ind.*, rules.*)."""
    out: set[str] = set()
    for key, value in changes.items():
        if key == "risk" and isinstance(value, dict):
            out.update(f"risk.{k}" for k in value)
        elif key == "indicators":
            out.add("indicators")
        elif key in ("entryLong", "entryShort"):
            out.add("rules.entry")
        elif key in ("exitLong", "exitShort"):
            out.add("rules.exit")
        else:
            out.add(key)
    return out


def hits_hold(changes: dict[str, Any], holds: list[str]) -> list[str]:
    """Held settings this change would touch. An indicator change touches every held ind.* setting."""
    touched = touched_settings(changes)
    hit = []
    for h in holds:
        if h in touched or (h.startswith("ind.") and "indicators" in touched):
            hit.append(h)
    return sorted(set(hit))
