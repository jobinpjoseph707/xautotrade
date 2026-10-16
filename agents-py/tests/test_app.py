"""The service's HTTP face."""
from fastapi.testclient import TestClient

from agents_py.app import create_app
from agents_py.config import Settings
from fakes import FakeServer


def client(key: str = "secret") -> tuple[TestClient, FakeServer]:
    server = FakeServer()
    app = create_app(Settings(agent_key=key, db_path=""), client=server)
    return TestClient(app), server


def test_runs_need_the_agent_key():
    c, _ = client()
    body = {"runId": "r1", "strategyId": "str_a", "kind": "tune", "trigger": "owner"}
    assert c.post("/runs", json=body).status_code == 401
    assert c.post("/runs", json=body, headers={"x-agent-key": "wrong"}).status_code == 401
    assert c.get("/runs/r1").status_code == 401
    assert c.get("/health").status_code == 200


def test_start_a_run_and_read_it_back():
    c, server = client()
    h = {"x-agent-key": "secret"}
    res = c.post("/runs", json={"runId": "r1", "strategyId": "str_a", "kind": "tune", "trigger": "owner"}, headers=h)
    assert res.status_code == 200
    body = res.json()
    assert body["outcome"] == "proposal" and body["runId"] == "r1" and body["modelCalls"] == 3
    again = c.get("/runs/r1", headers=h).json()
    assert again["status"] == "done"
    assert [s["agent"] for s in again["steps"]][:2] == ["dossier", "doctor"]
    assert c.get("/runs/missing", headers=h).status_code == 404


def test_a_bad_kind_is_refused():
    c, _ = client()
    r = c.post("/runs", json={"runId": "r1", "strategyId": "str_a", "kind": "trade"}, headers={"x-agent-key": "secret"})
    assert r.status_code == 400
