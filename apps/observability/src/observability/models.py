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
