import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    server_url: str = "http://127.0.0.1:4000"
    agent_key: str = ""
    db_path: str = "agents.db"
    port: int = 8000
    #: Model calls one run may make. The server enforces the same number.
    max_calls: int = 8
    #: Times the Critic may send the proposal back to the Optimizer.
    max_rounds: int = 2

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            server_url=os.environ.get("SERVER_URL", "http://127.0.0.1:4000").rstrip("/"),
            agent_key=os.environ.get("AGENT_API_KEY", ""),
            db_path=os.environ.get("AGENTS_DB", "agents.db"),
            port=int(os.environ.get("PORT", "8000")),
        )
