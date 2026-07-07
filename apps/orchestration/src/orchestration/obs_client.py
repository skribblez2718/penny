"""obs_client — best-effort emission of orchestration digests to the server.

Design invariants (pack §7):
  * **Digests only** — never full agent output (that lives in MemPalace).
  * **Fail silent** — a down/slow server NEVER raises, NEVER blocks a run, and
    adds no latency beyond the first-attempt timeout. A process-lifetime circuit
    breaker trips after the first failure so later emissions are instant no-ops.
  * **Correlated by session_id** — the shared session_id is what lets the server
    weave orchestration events into one timeline with the Pi agent/tool events.
  * ``seq`` is derived from the persisted ``ctx.last_seq`` so ordering survives
    the start/step subprocess boundaries.

Uses only the stdlib (``urllib``) so the package stays dependency-light.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .context import RunContext

_DEFAULT_URL = "http://localhost:8765"
_TIMEOUT_SECONDS = 1.5

# Process-lifetime circuit breaker: once a POST fails, stop trying for the life
# of this process (a spawned start/step subprocess), so a down server costs at
# most one timeout per process.
_CIRCUIT_OPEN = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_base_url(explicit: str | None) -> str:
    """Resolve the REST base URL, refusing non-HTTP schemes.

    PI_OBSERVABILITY_URL is the ecosystem's *WebSocket* URL (ws://...); the REST
    base lives in PI_OBSERVABILITY_REST_URL. Reading the wrong one made urllib
    raise "unknown url type: ws" on the first POST, which the fail-silent
    transport swallowed and the circuit breaker turned into a permanent no-op —
    zero orchestration runs ever reached the server. Guard the scheme so a
    misconfigured value can never silently kill telemetry again.
    """
    for candidate in (
        explicit,
        os.environ.get("PI_OBSERVABILITY_REST_URL"),
        os.environ.get("PI_OBSERVABILITY_URL"),  # legacy fallback, http(s) only
    ):
        if candidate and candidate.startswith(("http://", "https://")):
            return candidate.rstrip("/")
    return _DEFAULT_URL


class ObsClient:
    def __init__(self, base_url: str | None = None, api_key: str | None = None) -> None:
        self.base_url = _resolve_base_url(base_url)
        self.api_key = (
            api_key if api_key is not None else os.environ.get("PI_OBSERVABILITY_API_KEY", "")
        )

    # -- transport (never raises) ----------------------------------------
    def _post(self, path: str, payload: dict[str, Any]) -> bool:
        global _CIRCUIT_OPEN
        if _CIRCUIT_OPEN:
            return False
        url = f"{self.base_url}{path}"
        try:
            body = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(url, data=body, method="POST")
            req.add_header("Content-Type", "application/json")
            if self.api_key:
                req.add_header("Authorization", f"Bearer {self.api_key}")
            with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
                return 200 <= resp.status < 300
        except Exception as exc:
            # Any failure (connection refused, timeout, auth, HTTP error) trips
            # the breaker and is swallowed — emission must never break a run.
            # One stderr line when the breaker first trips: fail-silent must not
            # mean undiagnosable (this exact failure mode hid for weeks).
            _CIRCUIT_OPEN = True
            print(
                f"[obs_client] emission disabled for this process: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
            return False

    def _next_seq(self, ctx: "RunContext") -> int:
        ctx.last_seq += 1
        return ctx.last_seq

    def _event(
        self,
        ctx: "RunContext",
        event_type: str,
        *,
        state_id: str | None = None,
        primitive: str | None = None,
        agent: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> bool:
        return self._post(
            "/orchestration/events",
            {
                "events": [
                    {
                        "run_id": ctx.run_id,
                        "session_id": ctx.session_id,
                        "seq": self._next_seq(ctx),
                        "event_type": event_type,
                        "state_id": state_id,
                        "primitive": primitive,
                        "agent": agent,
                        "data": data or {},
                        "timestamp": _now(),
                    }
                ]
            },
        )

    # -- lifecycle emitters (digests only) --------------------------------
    def run_start(self, ctx: "RunContext") -> None:
        self._post(
            "/orchestration/runs",
            {
                "run_id": ctx.run_id,
                "session_id": ctx.session_id,
                "playbook": ctx.playbook,
                "goal": ctx.goal,
                "status": "running",
                "started_at": _now(),
            },
        )
        self._event(ctx, "run_start", data={"playbook": ctx.playbook, "goal": ctx.goal})

    def step_start(self, ctx: "RunContext", primitive: str, agent: str, state_id: str) -> None:
        self._event(
            ctx,
            "step_start",
            state_id=state_id,
            primitive=primitive,
            agent=agent,
            data={"primitive": primitive, "agent": agent, "state_id": state_id},
        )

    def step_end(
        self,
        ctx: "RunContext",
        primitive: str,
        digest: dict[str, Any] | None,
        confidence: str,
    ) -> None:
        digest = digest or {}  # never let a None digest raise (fail-silent invariant)
        payload = {"primitive": primitive, "confidence": confidence}
        if "verdict" in digest:
            payload["verdict"] = digest["verdict"]
        if "gaps_count" in digest:
            payload["gaps_count"] = digest["gaps_count"]
        self._event(ctx, "step_end", primitive=primitive, data=payload)

    def transition(self, ctx: "RunContext", frm: str, to: str, event: str, guard: str = "") -> None:
        self._event(
            ctx,
            "transition",
            state_id=to,
            data={"from": frm, "to": to, "event": event, "guard": guard},
        )

    def escalation(self, ctx: "RunContext", reason: str, questions_count: int = 0) -> None:
        self._event(
            ctx,
            "escalation",
            state_id=ctx.previous_state,
            data={"reason": reason, "questions_count": questions_count},
        )

    def run_end(self, ctx: "RunContext", status: str, met: bool, iterations: int) -> None:
        self._post(
            "/orchestration/runs",
            {
                "run_id": ctx.run_id,
                "session_id": ctx.session_id,
                "status": status,
                "ended_at": _now(),
                "met": met,
                "iterations": iterations,
            },
        )
        self._event(ctx, "run_end", data={"status": status, "met": met, "iterations": iterations})


def reset_circuit_breaker() -> None:
    """Test hook: re-close the process-lifetime circuit breaker."""
    global _CIRCUIT_OPEN
    _CIRCUIT_OPEN = False
