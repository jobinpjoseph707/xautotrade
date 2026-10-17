"""
The agent graph, with a scripted model and a fake server (no network, no Claude).
Test IDs AG-1 to AG-7, AG-12 and AG-14 are from docs/plan/xautotrade-test-plan.md.
"""
import json
import socket
import threading
from pathlib import Path

import pytest

from agents_py.config import Settings
from agents_py.engine import Busy, Engine
from agents_py.errors import BudgetExceeded, CallCapped, ClaudeUnreachable, ServerRefused
from agents_py.model import Model, extract_json
from agents_py.risk import hits_hold, loosens_risk
from fakes import CRITIC_NO, CRITIC_OK, DOCTOR_FINE, DOCTOR_WRONG, RISK, FakeServer, dossier, j, theory


def run(server: FakeServer, kind: str = "tune", run_id: str = "r1", settings: Settings | None = None):
    engine = Engine(server, settings or Settings())
    return engine, engine.run(run_id, "str_a", kind)


def agents(result) -> list[str]:
    return [s["agent"] for s in result["steps"]]


def test_AG_1_graph_runs_end_to_end_with_a_fake_model_and_no_network(monkeypatch):
    def no_network(*a, **k):
        raise AssertionError("the graph must not open a network connection")

    monkeypatch.setattr(socket.socket, "connect", no_network)
    server = FakeServer()
    _, res = run(server)
    assert res["outcome"] == "proposal"
    assert agents(res) == ["dossier", "doctor", "optimizer", "tester", "critic", "risk_guard", "submit"]
    assert res["proposalId"] == "prop1"
    assert server.proposals == [{"trialId": "trial1", "changes": {"risk": {"slPoints": 180}}}]
    assert [n["agent"] for n in server.notes] == ["doctor", "optimizer", "critic"], "each agent leaves a note the next run can read"
    assert res["modelCalls"] == 3
    assert "Losses cluster" in server.calls[1][1], "the optimizer is shown the doctor's finding"
    assert "setting=risk.tpPoints" in server.calls[1][1], "and the lesson rows for this market"


def test_AG_2_doctor_says_nothing_is_wrong_the_run_ends_with_a_note_and_no_proposal():
    server = FakeServer(models={"doctor": DOCTOR_FINE})
    _, res = run(server)
    assert res["outcome"] == "nothing_wrong"
    assert agents(res) == ["dossier", "doctor"]
    assert server.calls_by("optimizer") == 0 and server.calls_by("critic") == 0
    assert len(server.notes) == 1 and server.notes[0]["agent"] == "doctor"
    assert server.proposals == []


def test_a_diagnose_run_stops_after_the_doctor():
    server = FakeServer()
    _, res = run(server, kind="diagnose")
    assert res["outcome"] == "diagnosed"
    assert agents(res) == ["dossier", "doctor"]
    assert server.calls_by("optimizer") == 0
    assert server.proposals == []


def test_AG_3_tester_fails_its_own_test_theory_dropped_and_noted_no_proposal():
    server = FakeServer()
    server.survives = False
    _, res = run(server)
    assert res["outcome"] == "dropped"
    assert "dropped" in res["summary"]
    assert agents(res)[-1] == "tester"
    assert server.calls_by("critic") == 0, "a dropped theory is not argued about"
    assert any(n["agent"] == "tester" and "dropped" in n["text"] for n in server.notes)
    assert server.proposals == []


def test_AG_4_critic_objects_goes_back_to_optimizer_then_support_ends_in_a_proposal():
    server = FakeServer(models={"doctor": DOCTOR_WRONG, "optimizer": [theory(), theory({"risk": {"slPoints": 170}}, "Stops are too tight; widen less")], "critic": [CRITIC_NO, CRITIC_OK]})
    _, res = run(server)
    assert res["outcome"] == "proposal"
    assert server.calls_by("optimizer") == 2 and server.calls_by("critic") == 2
    second = [p for a, p in server.calls if a == "optimizer"][1]
    assert "Only 60 trades; this may be noise." in second, "the optimizer sees the objection"
    assert server.proposals[0]["changes"] == {"risk": {"slPoints": 170}}, "the revised change is the one proposed"


def test_AG_4_critic_that_never_agrees_stops_the_run_after_two_rounds():
    server = FakeServer(models={"doctor": DOCTOR_WRONG, "optimizer": theory(), "critic": CRITIC_NO})
    _, res = run(server)
    assert res["outcome"] == "no_agreement"
    assert server.calls_by("optimizer") == 3 and server.calls_by("critic") == 3, "first try plus two rounds"
    assert server.proposals == []
    assert res["modelCalls"] == 7


def test_AG_5_risk_guard_refuses_a_change_that_loosens_risk():
    server = FakeServer(models={"doctor": DOCTOR_WRONG, "optimizer": theory({"risk": {"fixedLot": 0.05}}, "Bigger size makes up the losses"), "critic": CRITIC_OK})
    _, res = run(server)
    assert res["outcome"] == "refused"
    assert "raises fixedLot" in res["summary"]
    assert agents(res)[-1] == "risk_guard"
    assert server.proposals == []
    assert any(n["agent"] == "risk_guard" for n in server.notes)


FIXTURE = Path(__file__).parent / "fixtures" / "risk_cases.json"


@pytest.mark.parametrize("case", json.loads(FIXTURE.read_text()), ids=lambda c: c["name"])
def test_AG_5_risk_guard_agrees_with_the_servers_own_check(case):
    got = loosens_risk(case["before"], case["changes"])
    assert (got is not None) == case["loosens"], f"{case['name']}: server says {case['why']!r}, guard says {got!r}"
    if case["why"]:
        assert got == case["why"]


def test_AG_6_more_than_eight_model_calls_in_a_run_is_refused():
    # Every agent gives unusable JSON first and a good answer second, so each costs two calls.
    def twice(good):
        return lambda prompt, n: "I think the strategy is fine." if n % 2 == 1 else good

    server = FakeServer(models={"doctor": twice(DOCTOR_WRONG), "optimizer": twice(theory()), "critic": twice(CRITIC_NO)})
    _, res = run(server)
    assert res["outcome"] == "budget"
    assert len(server.calls) == 8, "the ninth call was never made"
    assert res["modelCalls"] == 8
    assert server.proposals == []


def test_model_refuses_before_it_calls():
    server = FakeServer(models={"doctor": "x"})
    m = Model(server, "r", 2)
    m.ask("doctor", "a")
    m.ask("doctor", "b")
    with pytest.raises(BudgetExceeded):
        m.ask("doctor", "c")
    assert len(server.calls) == 2


def test_AG_7_a_run_is_refused_while_a_change_waits_and_while_another_run_is_active():
    waiting = dossier(openChange={"summary": "Update Gold scalp: slPoints", "status": "waiting to be scored"})
    server = FakeServer(waiting)
    _, res = run(server)
    assert res["outcome"] == "refused"
    assert "waiting to be scored" in res["summary"]
    assert server.calls == [], "no model call was spent"

    gate = threading.Event()
    started = threading.Event()
    slow = FakeServer()

    def hold(agent, n):
        started.set()
        gate.wait(5)

    slow.on_llm = hold
    engine = Engine(slow, Settings())
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("a", engine.run("rA", "str_a", "tune")))
    t.start()
    assert started.wait(5)
    with pytest.raises(Busy):
        engine.run("rB", "str_a", "tune")
    gate.set()
    t.join(5)
    assert out["a"]["outcome"] == "proposal"
    assert engine.run("rC", "str_a", "diagnose")["outcome"] == "diagnosed", "free again afterwards"


def test_AG_12_two_trusted_lessons_that_disagree_end_the_run_with_hold():
    server = FakeServer(dossier(holds=["risk.slPoints"]))
    _, res = run(server)
    assert res["outcome"] == "hold"
    assert "risk.slPoints" in res["summary"]
    assert server.backtests == [], "no test was spent on a held setting"
    assert server.proposals == []
    # The server can also call a hold at test time.
    server2 = FakeServer()
    server2.backtest_error = ServerRefused(409, "Past results disagree about risk.slPoints in this market, so it is on hold.", "hold")
    _, res2 = run(server2)
    assert res2["outcome"] == "hold"


def test_holds_match_indicator_changes_too():
    assert hits_hold({"risk": {"slPoints": 1}}, ["risk.slPoints", "risk.tpPoints"]) == ["risk.slPoints"]
    assert hits_hold({"indicators": []}, ["ind.ema.period"]) == ["ind.ema.period"]
    assert hits_hold({"entryLong": {}}, ["rules.entry"]) == ["rules.entry"]
    assert hits_hold({"risk": {"fixedLot": 1}}, ["risk.slPoints"]) == []


def test_AG_14_a_run_can_be_read_back_step_by_step():
    server = FakeServer()
    engine, res = run(server, run_id="why1")
    t = engine.trace("why1")
    assert t["status"] == "done"
    assert t["outcome"] == "proposal"
    assert [s["agent"] for s in t["steps"]] == ["dossier", "doctor", "optimizer", "tester", "critic", "risk_guard", "submit"]
    assert all(s["text"] for s in t["steps"])
    assert t["proposalId"] == "prop1"
    assert engine.trace("nope") is None
    assert len(engine.history("why1")) >= 7, "every step was saved, not just the last"


def test_AG_14_steps_are_readable_while_the_run_is_still_going():
    server = FakeServer()
    engine = Engine(server, Settings())
    seen = {}

    def peek(agent, n):
        if agent == "critic":
            seen["t"] = engine.trace("live")

    server.on_llm = peek
    engine.run("live", "str_a", "tune")
    assert [s["agent"] for s in seen["t"]["steps"]] == ["dossier", "doctor", "optimizer", "tester"]
    assert seen["t"]["status"] == "running"


def test_p_7_claude_unreachable_ends_the_run_cleanly_with_no_proposal():
    server = FakeServer()
    server.llm_error = ClaudeUnreachable("Claude is not signed in on the laptop")
    _, res = run(server)
    assert res["outcome"] == "claude_unreachable"
    assert server.proposals == [] and server.backtests == []


def test_the_daily_call_cap_ends_the_run_cleanly():
    server = FakeServer()
    server.llm_error = CallCapped("The daily limit of 40 automatic Claude calls is used up.")
    _, res = run(server, run_id="cap")
    assert res["outcome"] == "call_cap"


def test_server_refusing_the_proposal_is_an_outcome_not_a_crash():
    server = FakeServer()
    server.propose_error = ServerRefused(409, "A change to this strategy is already waiting.", "open_change")
    _, res = run(server)
    assert res["outcome"] == "refused"
    assert "already waiting" in res["summary"]


def test_a_bug_in_a_step_still_gives_an_answer():
    server = FakeServer()
    server.dossier_data["strategy"] = None  # breaks the first step
    _, res = run(server)
    assert res["outcome"] == "error"


def test_unusable_model_answers_stop_the_run_after_one_retry():
    server = FakeServer(models={"doctor": "no idea"})
    _, res = run(server)
    assert res["outcome"] == "error"
    assert server.calls_by("doctor") == 2
    assert extract_json('noise {"a": [1, {"b": "}"}]} tail') == {"a": [1, {"b": "}"}]}
    assert extract_json("none here") is None


def test_AG_14_saved_runs_survive_a_restart(tmp_path):
    from agents_py.engine import make_checkpointer

    db = str(tmp_path / "runs.db")
    first = Engine(FakeServer(), Settings(), make_checkpointer(db))
    first.run("keep1", "str_a", "tune")
    second = Engine(FakeServer(), Settings(), make_checkpointer(db))  # a fresh process reading the same file
    t = second.trace("keep1")
    assert t is not None and t["outcome"] == "proposal" and t["status"] == "done"
    assert len(t["steps"]) == 7
