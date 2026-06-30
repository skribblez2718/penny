"""Outcome Ledger schema and validation."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

DeltaScore = Literal["MATCH", "PARTIAL", "MISMATCH", ""]
ConfidenceLevel = Literal["CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN", ""]
DomainCategory = Literal[
    "planning", "coding", "research", "communication",
    "learning", "events", "decision", "other", "",
]


@dataclass
class OutcomeRecord:
    """A single entry in the outcome ledger."""

    decision_id: str
    session_id: str
    action_taken: str
    expected_outcome: str
    actual_outcome: str = ""
    delta_score: DeltaScore = ""
    confidence_at_action: ConfidenceLevel = ""
    domain: DomainCategory = ""
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    user_feedback: str = ""

    def to_json(self) -> str:
        """Serialize to JSON string."""
        import json

        return json.dumps(
            {
                "decision_id": self.decision_id,
                "session_id": self.session_id,
                "action_taken": self.action_taken,
                "expected_outcome": self.expected_outcome,
                "actual_outcome": self.actual_outcome,
                "delta_score": self.delta_score,
                "confidence_at_action": self.confidence_at_action,
                "domain": self.domain,
                "timestamp": self.timestamp,
                "user_feedback": self.user_feedback,
            }
        )

    @classmethod
    def from_json(cls, raw: str) -> "OutcomeRecord":
        """Deserialize from JSON string."""
        import json

        data = json.loads(raw)
        return cls(**data)

    def validate(self) -> None:
        """Validate required fields. Raise ValueError on failure."""
        if not self.decision_id or not self.decision_id.strip():
            raise ValueError("decision_id is required")
        if not self.session_id or not self.session_id.strip():
            raise ValueError("session_id is required")
        if not self.action_taken or not self.action_taken.strip():
            raise ValueError("action_taken is required")
        if not self.expected_outcome or not self.expected_outcome.strip():
            raise ValueError("expected_outcome is required")

        if self.delta_score and self.delta_score not in ("MATCH", "PARTIAL", "MISMATCH", ""):
            raise ValueError(f"Invalid delta_score: {self.delta_score}")
        if self.confidence_at_action and self.confidence_at_action not in (
            "CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN", ""
        ):
            raise ValueError(
                f"Invalid confidence_at_action: {self.confidence_at_action}"
            )

    def is_evaluated(self) -> bool:
        """Return True if actual_outcome and delta_score are populated."""
        return bool(self.actual_outcome and self.delta_score)

    def is_consequential(self) -> bool:
        """Return True for high-stakes or low-confidence actions."""
        return self.confidence_at_action in ("POSSIBLE", "UNCERTAIN", "")


def generate_decision_id(session_id: str, seq: int) -> str:
    """Generate a deterministic decision ID."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"decision_{today}_{seq:03d}"
