"""Why a run stops early. Each one maps to a run outcome the app understands."""


class RunStop(Exception):
    """End the run with an outcome and a plain-words summary."""

    def __init__(self, outcome: str, summary: str):
        super().__init__(summary)
        self.outcome = outcome
        self.summary = summary


class BudgetExceeded(Exception):
    """The run used all of its model calls."""


class ClaudeUnreachable(Exception):
    """The server could not reach Claude (signed out, CLI missing)."""


class CallCapped(Exception):
    """The daily limit on automatic Claude calls is used up."""


class ServerRefused(Exception):
    """The trading server said no. `code` is its reason code, if it gave one."""

    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
