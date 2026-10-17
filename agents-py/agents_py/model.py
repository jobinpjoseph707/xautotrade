"""One run's model calls: counted, capped, and parsed as JSON."""
from __future__ import annotations

import json
import re
from typing import Any, Callable

from .client import ServerClient
from .errors import BudgetExceeded, RunStop


def extract_json(text: str) -> Any | None:
    """The first JSON object or array in a model reply, or None."""
    start = None
    for i, ch in enumerate(text):
        if ch in "{[":
            start = i
            break
    if start is None:
        return None
    opener = text[start]
    closer = "}" if opener == "{" else "]"
    depth = 0
    in_str = False
    esc = False
    for j in range(start, len(text)):
        c = text[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == opener:
            depth += 1
        elif c == closer:
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : j + 1])
                except ValueError:
                    return None
    return None


class Model:
    """Asks the server for model answers. Refuses the call after the limit, before it is made."""

    def __init__(self, client: ServerClient, run_id: str, limit: int):
        self.client = client
        self.run_id = run_id
        self.limit = limit
        self.used = 0

    def ask(self, agent: str, prompt: str) -> str:
        if self.used >= self.limit:
            raise BudgetExceeded(f"The run has used its {self.limit} model calls.")
        self.used += 1
        return self.client.llm(self.run_id, agent, prompt)

    def ask_json(self, agent: str, prompt: str, check: Callable[[Any], str | None]) -> Any:
        """Ask; if the answer is not usable JSON, say what was wrong and ask once more."""
        problem = ""
        for attempt in range(2):
            text = self.ask(agent, prompt if not problem else f"{prompt}\n\nYour last answer was not usable: {problem}\nReply with ONLY the JSON, nothing else.")
            data = extract_json(text)
            problem = "it contained no JSON." if data is None else (check(data) or "")
            if not problem:
                return data
        raise RunStop("error", f"The {agent} did not give a usable answer twice: {problem}")


def flat(text: Any, limit: int = 300) -> str:
    return re.sub(r"\s+", " ", str(text)).strip()[:limit]
