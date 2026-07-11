"""Background scheduler for size-based observability DB rotation.

Replaces the old age-based cron cleanup. The scheduler runs a size-based
rotation:

  * once on startup (so an already-oversized DB is bounded immediately), and
  * on a periodic asyncio ``IntervalTrigger`` (a size check, not a fixed 03:00
    cron).

Rotation runs are awaited by APScheduler (``run_rotation_job`` is a coroutine
function registered directly), so a failure surfaces via ``EVENT_JOB_ERROR`` and
is also recorded as an ERROR row in the logs table — never silently swallowed.
"""

import asyncio
import os

from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED, JobExecutionEvent
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from observability.config import Config
from observability.db import Database
from observability import logger as _logger

# Singleton scheduler instance
_scheduler: AsyncIOScheduler | None = None

# How often the periodic size check runs (seconds). Overridable for operators;
# defaults to hourly. This is an interval, never a fixed wall-clock time.
_ROTATION_INTERVAL_SECONDS = int(
    os.getenv("PI_OBSERVABILITY_ROTATION_INTERVAL_SECONDS", "3600")
)

_GIB = 1024**3


def get_scheduler() -> AsyncIOScheduler | None:
    """Return the global scheduler instance, if started."""
    return _scheduler


def _on_job_executed(event: JobExecutionEvent) -> None:
    """Log successful job execution."""
    if event.exception:
        return
    _logger.info(
        "observability.scheduler",
        f"Scheduled rotation job '{event.job_id}' executed successfully",
    )


def _on_job_error(event: JobExecutionEvent) -> None:
    """Log failed job execution (fired on EVENT_JOB_ERROR)."""
    exc = event.exception
    traceback_str = event.traceback if hasattr(event, "traceback") else ""
    err = Exception(str(exc))
    err.code = "OBSERV_SCHEDULER_ROTATION_FAIL"
    _logger.error(
        "observability.scheduler",
        f"Scheduled rotation job '{event.job_id}' FAILED: {exc}",
        error=err,
        extra={"traceback": traceback_str},
    )


async def run_rotation_job(db: Database) -> dict:
    """Execute one size-based rotation and log the result.

    On failure the error is recorded as an ERROR log row and then re-raised so
    the failure also surfaces via APScheduler's EVENT_JOB_ERROR. Nothing is
    swallowed.
    """
    cap_bytes = int(Config.DB_SIZE_MAX_GB * _GIB)
    floor_bytes = int(Config.DB_SIZE_FLOOR_GB * _GIB)

    try:
        result = await db.rotate(cap_bytes, floor_bytes)
    except Exception as exc:
        err = Exception(str(exc))
        err.code = "OBSERV_ROTATION_FAIL"
        _logger.error(
            "observability.scheduler",
            f"Size rotation FAILED: {exc}",
            error=err,
        )
        # Surface the failure as an ERROR log row too (best-effort).
        try:
            await db.insert_log(
                "ERROR",
                "scheduler",
                "rotation_failed",
                data={"error": str(exc)},
            )
        except Exception:
            pass
        raise

    if result.get("triggered"):
        _logger.info(
            "observability.scheduler",
            (
                "Size rotation ran: "
                f"deleted_total={result.get('deleted_total')} "
                f"file_bytes {result.get('file_bytes_before')} -> {result.get('file_bytes_after')} "
                f"live_bytes {result.get('live_bytes_before')} -> {result.get('live_bytes_after')}"
            ),
            extra={
                "deleted_total": result.get("deleted_total"),
                "file_bytes_after": result.get("file_bytes_after"),
                "live_bytes_after": result.get("live_bytes_after"),
            },
        )
        await db.insert_log(
            "INFO",
            "scheduler",
            "rotation_complete",
            data={
                "deleted_total": result.get("deleted_total"),
                "deleted": result.get("deleted"),
                "file_bytes_after": result.get("file_bytes_after"),
                "live_bytes_after": result.get("live_bytes_after"),
            },
        )
    return result


async def _startup_rotation(db: Database) -> None:
    """Run the startup rotation, isolating its failure from server startup.

    ``run_rotation_job`` already logs + re-raises on failure; here we catch so a
    fire-and-forget startup task never produces an unretrieved-exception warning.
    """
    try:
        await run_rotation_job(db)
    except Exception as exc:
        err = Exception(str(exc))
        err.code = "OBSERV_STARTUP_ROTATION_FAIL"
        _logger.error(
            "observability.scheduler",
            f"Startup rotation failed: {exc}",
            error=err,
        )


def start_scheduler(db: Database) -> None:
    """Start the scheduler: a rotation on startup plus a periodic interval check."""
    global _scheduler

    if _scheduler is not None:
        return

    _scheduler = AsyncIOScheduler(timezone="UTC")
    _scheduler.add_listener(_on_job_executed, EVENT_JOB_EXECUTED)
    _scheduler.add_listener(_on_job_error, EVENT_JOB_ERROR)

    # Periodic size check on a fixed interval (NOT a 03:00 cron). run_rotation_job
    # is a coroutine function, so AsyncIOScheduler awaits it and EVENT_JOB_ERROR
    # fires on failure.
    _scheduler.add_job(
        run_rotation_job,
        trigger=IntervalTrigger(seconds=_ROTATION_INTERVAL_SECONDS),
        id="size_rotation",
        replace_existing=True,
        kwargs={"db": db},
    )

    _scheduler.start()
    _logger.info(
        "observability.scheduler",
        f"Scheduler started: size rotation every {_ROTATION_INTERVAL_SECONDS}s "
        f"(cap={Config.DB_SIZE_MAX_GB}GB, floor={Config.DB_SIZE_FLOOR_GB}GB)",
    )

    # Run a rotation immediately on startup (fire-and-forget on the running loop).
    asyncio.create_task(_startup_rotation(db))


def stop_scheduler() -> None:
    """Stop the scheduler cleanly.

    The singleton is always cleared, even if ``shutdown`` raises (e.g. the
    scheduler was never fully started) — otherwise a half-built instance would
    leak and block the next ``start_scheduler``.
    """
    global _scheduler
    if _scheduler is not None:
        try:
            _scheduler.shutdown(wait=False)
        except Exception as exc:
            err = Exception(str(exc))
            err.code = "OBSERV_SCHEDULER_SHUTDOWN_FAIL"
            _logger.warn(
                "observability.scheduler",
                f"Scheduler shutdown raised (clearing anyway): {exc}",
                error=err,
            )
        finally:
            _scheduler = None
            _logger.info("observability.scheduler", "Scheduler stopped")
