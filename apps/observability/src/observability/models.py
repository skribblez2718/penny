"""Pydantic response models for observability REST endpoints."""

from typing import Any

from pydantic import BaseModel, Field


class LogEntry(BaseModel):
    """A single operational log row."""

    id: int
    timestamp: int = Field(description="Unix timestamp in milliseconds")
    level: str = Field(description="Log severity: DEBUG, INFO, WARN, ERROR")
    component: str = Field(description="Subsystem that emitted the log")
    event: str = Field(description="Short event identifier")
    session_id: str | None = None
    client_id: str | None = None
    data: Any | None = None
    created_at: int = Field(description="Unix timestamp in seconds")


class LogListResponse(BaseModel):
    """Paginated list of log entries."""

    items: list[LogEntry]
    total: int
    limit: int
    offset: int


class LevelCount(BaseModel):
    """Count of logs at a specific severity level."""

    level: str
    count: int


class ComponentCount(BaseModel):
    """Count of logs from a specific component."""

    component: str
    count: int


class CreateLogRequest(BaseModel):
    """Payload for ingesting a structured operational log entry."""

    level: str = Field(default="INFO", description="Log severity: DEBUG, INFO, WARN, ERROR, CRITICAL")
    component: str = Field(..., description="Subsystem that emitted the log")
    event: str = Field(..., description="Short event identifier / message")
    session_id: str | None = Field(default=None, description="Optional session correlation ID")
    client_id: str | None = Field(default=None, description="Optional client/source ID")
    data: dict[str, Any] | None = Field(default=None, description="Structured additional data")


class LogStatsResponse(BaseModel):
    """Aggregated statistics over the logs table."""

    total: int
    by_level: list[LevelCount]
    by_component: list[ComponentCount]
    oldest_timestamp: int | None = None
    newest_timestamp: int | None = None


class WatcherLogEntry(BaseModel):
    """A single ambient watcher log row."""

    id: int
    timestamp: int = Field(description="Unix timestamp in milliseconds")
    level: str = Field(description="Log severity: DEBUG, INFO, WARN, ERROR")
    source: str = Field(description="Watcher source name (e.g. mismatch_rate_watcher)")
    event: str = Field(description="Short event identifier / message")
    session_id: str | None = None
    data: Any | None = None
    created_at: int = Field(description="Unix timestamp in seconds")


class WatcherLogListResponse(BaseModel):
    """Paginated list of ambient watcher log entries."""

    items: list[WatcherLogEntry]
    total: int
    limit: int
    offset: int


class SourceCount(BaseModel):
    """Count of watcher logs from a specific source."""

    source: str
    count: int


class WatcherLogStatsResponse(BaseModel):
    """Aggregated statistics over the watcher_logs table."""

    total: int
    by_level: list[LevelCount]
    by_source: list[SourceCount]
    oldest_timestamp: int | None = None
    newest_timestamp: int | None = None


# ---------------------------------------------------------------------------
# Orchestration runs / events (v5) — the correlated timeline
# ---------------------------------------------------------------------------


class CreateOrchestrationRunRequest(BaseModel):
    """Payload for creating/updating an orchestration run (run_start/run_end)."""

    run_id: str = Field(..., description="Unique run identifier")
    session_id: str = Field(..., description="Correlating Pi session id")
    playbook: str | None = Field(default=None, description="Playbook name")
    goal: str | None = Field(default=None)
    status: str | None = Field(default=None, description="running | awaiting_user | complete | error")
    started_at: str | None = Field(default=None, description="ISO8601")
    ended_at: str | None = Field(default=None, description="ISO8601")
    met: bool | None = Field(default=None)
    iterations: int | None = Field(default=None)


class OrchestrationEvent(BaseModel):
    """A single orchestration event digest (never full agent output)."""

    run_id: str = Field(..., description="Run this event belongs to")
    session_id: str = Field(..., description="Correlating Pi session id")
    seq: int = Field(..., description="Monotonic sequence within the run")
    event_type: str = Field(
        ..., description="run_start|step_start|step_end|transition|escalation|run_end"
    )
    state_id: str | None = None
    primitive: str | None = None
    agent: str | None = None
    data: dict[str, Any] | None = Field(default=None, description="JSON digest")
    timestamp: str | None = Field(default=None, description="ISO8601")


class CreateOrchestrationEventsRequest(BaseModel):
    """Payload for ingesting one or a small batch of orchestration events."""

    events: list[OrchestrationEvent] = Field(..., min_length=1)
