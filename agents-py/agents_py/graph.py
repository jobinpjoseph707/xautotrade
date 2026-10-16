"""
The graph:

  load -> doctor -> optimizer -> tester -> critic -> risk_guard -> submit
                       ^                     |
                       +---- (oppose, at most 2 rounds)

Any step can end the run by setting `outcome`.
"""
from __future__ import annotations

from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph

from . import nodes
from .state import RunState


def _go(next_node: str):
    def route(state: RunState) -> str:
        return END if state.get("outcome") else next_node

    return route


def after_critic(state: RunState) -> str:
    if state.get("outcome"):
        return END
    return "optimizer" if state.get("objections") else "risk_guard"


def build_graph(checkpointer: BaseCheckpointSaver | None = None) -> Any:
    g = StateGraph(RunState)
    for name in ("load", "doctor", "optimizer", "tester", "critic", "risk_guard", "submit"):
        g.add_node(name, nodes.safe(getattr(nodes, name)))
    g.add_edge(START, "load")
    g.add_conditional_edges("load", _go("doctor"), ["doctor", END])
    g.add_conditional_edges("doctor", _go("optimizer"), ["optimizer", END])
    g.add_conditional_edges("optimizer", _go("tester"), ["tester", END])
    g.add_conditional_edges("tester", _go("critic"), ["critic", END])
    g.add_conditional_edges("critic", after_critic, ["optimizer", "risk_guard", END])
    g.add_conditional_edges("risk_guard", _go("submit"), ["submit", END])
    g.add_edge("submit", END)
    return g.compile(checkpointer=checkpointer)
