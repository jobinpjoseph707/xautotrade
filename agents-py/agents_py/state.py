import operator
from typing import Annotated, Any, TypedDict


class RunState(TypedDict, total=False):
    """What every agent in the run can see. Findings are added here and passed on."""

    run_id: str
    strategy_id: str
    kind: str  # diagnose | tune
    trigger: str  # owner | weekly
    dossier: dict[str, Any]
    diagnosis: dict[str, Any]
    theory: dict[str, Any]
    trial: dict[str, Any]
    critic: dict[str, Any]
    #: Critic-to-Optimizer rounds used so far.
    rounds: int
    objections: list[str]
    #: One entry per agent turn, in order. This is the trail "Why was this proposed?" shows.
    steps: Annotated[list[dict[str, Any]], operator.add]
    outcome: str
    summary: str
    proposal_id: str
