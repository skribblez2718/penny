"""Background job scheduler for observability retention cleanup.

Uses APScheduler's BackgroundScheduler for non-blocking daily cleanup jobs.
The scheduler is started during FastAPI lifespan startup and shut down cleanly
on application exit.
"""

import asyncio
from typing import Any

from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED, JobExecutionEvent
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from observability.config import Config
from observability.db import Database
from observability import logger as _logger

# Singleton scheduler instance
_scheduler: AsyncIOScheduler | None = None


def get_scheduler() -> AsyncIOScheduler | None:
    """Return the global scheduler instance, if started."""
    return _scheduler


def _on_job_executed(event: JobExecutionEvent) -> None:
    """Log successful job execution."""
    if event.exception:
        return
    _logger.info(
        "observability.scheduler",
        f"Scheduled cleanup job '{event.job_id}' executed successfully",
    )


def _on_job_error(event: JobExecutionEvent) -> None:
    """Log failed job execution."""
    exc = event.exception
    traceback_str = event.traceback if hasattr(event, "traceback") else ""
    err = Exception(str(exc))
    err.code = "OBSERVERV_SCHEDULER_FAIL"
    _logger.error(
        "observability.scheduler",
        f"Scheduled cleanup job '{event.job_id}' FAILED: {exc}",
        error=err,
        extra={"traceback": traceback_str},
    )


async def run_cleanup_job(db: Database) -> dict[str, Any]:
    """Execute the retention cleanup job and log results."""
    stats_before = await db.get_stats()
    _logger.info(
        "observability.scheduler",
        f"Running scheduled cleanup (db_size_mb={stats_before['db_size_mb']})",
        extra={"db_size_mb_before": stats_before["db_size_mb"]},
    )
    await db.insert_log(
        "INFO", "scheduler", "cleanup_start",
        data={"db_size_mb": stats_before["db_size_mb"]},
    )

    result = await db.cleanup(
        raw_retention_days=Config.RETENTION_RAW_DAYS,
        compaction_retention_days=Config.RETENTION_COMPACTION_DAYS,
    )
    deleted_logs = await db.cleanup_logs(Config.RETENTION_LOG_DAYS)
    result["deleted_logs"] = deleted_logs

    stats_after = await db.get_stats()
    _logger.info(
        "observability.scheduler",
        (
            f"Cleanup complete: deleted_raw_entries={result['deleted_raw_entries']} "
            f"deleted_compactions={result['deleted_compactions']} "
            f"deleted_logs={deleted_logs} "
            f"db_size_mb_before={stats_before['db_size_mb']} "
            f"db_size_mb_after={stats_after['db_size_mb']}"
        ),
        extra={
            "deleted_raw_entries": result["deleted_raw_entries"],
            "deleted_compactions": result["deleted_compactions"],
            "deleted_logs": deleted_logs,
            "db_size_mb_before": stats_before["db_size_mb"],
            "db_size_mb_after": stats_after["db_size_mb"],
        },
    )
    await db.insert_log(
        "INFO", "scheduler", "cleanup_complete",
        data={
            "deleted_raw_entries": result["deleted_raw_entries"],
            "deleted_compactions": result["deleted_compactions"],
            "deleted_logs": deleted_logs,
            "db_size_mb_before": stats_before["db_size_mb"],
            "db_size_mb_after": stats_after["db_size_mb"],
        },
    )
    return result


async def check_startup_emergency_cleanup(db: Database) -> dict[str, Any] | None:
    """Run immediate cleanup if the DB exceeds the emergency size threshold.

    Returns the cleanup result dict if cleanup was triggered, None otherwise.
    """
    stats = await db.get_stats()
    db_size_gb = stats["db_size_mb"] / 1024
    if db_size_gb <= Config.DB_SIZE_MAX_GB:
        return None

    _logger.warn(
        "observability.scheduler",
        (
            f"EMERGENCY CLEANUP TRIGGERED: db_size_gb={db_size_gb:.2f} "
            f"exceeds threshold={Config.DB_SIZE_MAX_GB} GB"
        ),
        extra={"db_size_gb": db_size_gb, "threshold_gb": Config.DB_SIZE_MAX_GB},
    )

    # Emergency: shorten retention to 7 days for raw, 30 days for compactions, 3 days for logs
    result = await db.cleanup(
        raw_retention_days=min(Config.RETENTION_RAW_DAYS, 7),
        compaction_retention_days=min(Config.RETENTION_COMPACTION_DAYS, 30),
    )
    deleted_logs = await db.cleanup_logs(min(Config.RETENTION_LOG_DAYS, 3))
    result["deleted_logs"] = deleted_logs

    stats_after = await db.get_stats()
    _logger.info(
        "observability.scheduler",
        (
            f"Emergency cleanup complete: "
            f"deleted_raw_entries={result['deleted_raw_entries']} "
            f"deleted_compactions={result['deleted_compactions']} "
            f"deleted_logs={deleted_logs} "
            f"db_size_mb={stats_after['db_size_mb']}"
        ),
        extra={
            "deleted_raw_entries": result["deleted_raw_entries"],
            "deleted_compactions": result["deleted_compactions"],
            "deleted_logs": deleted_logs,
            "db_size_mb": stats_after["db_size_mb"],
        },
    )
    await db.insert_log(
        "WARN", "scheduler", "emergency_cleanup",
        data={
            "db_size_gb": db_size_gb,
            "threshold_gb": Config.DB_SIZE_MAX_GB,
            "deleted_raw_entries": result["deleted_raw_entries"],
            "deleted_compactions": result["deleted_compactions"],
            "deleted_logs": deleted_logs,
            "db_size_mb_after": stats_after["db_size_mb"],
        },
    )
    return result


def start_scheduler(db: Database) -> None:
    """Start the background scheduler with daily cleanup at 03:00 UTC.

    Also triggers an emergency startup cleanup if the DB exceeds size limits.
    """
    global _scheduler

    if _scheduler is not None:
        return

    _scheduler = AsyncIOScheduler(timezone="UTC")

    # Log job results and errors
    _scheduler.add_listener(_on_job_executed, EVENT_JOB_EXECUTED)
    _scheduler.add_listener(_on_job_error, EVENT_JOB_ERROR)

    # Schedule daily cleanup at 03:00 UTC
    _scheduler.add_job(
        _async_cleanup_wrapper,
        trigger="cron",
        hour=3,
        minute=0,
        id="daily_cleanup",
        replace_existing=True,
        kwargs={"db": db},
    )

    _scheduler.start()
    _logger.info(
        "observability.scheduler",
        "Scheduler started: daily cleanup at 03:00 UTC",
    )

    # Run startup emergency cleanup (fire-and-forget)
    asyncio.create_task(_startup_cleanup_wrapper(db))


def stop_scheduler() -> None:
    """Stop the background scheduler cleanly."""
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        _logger.info("observability.scheduler", "Scheduler stopped")


def _async_cleanup_wrapper(db: Database) -> None:
    """APScheduler-compatible wrapper that schedules a coroutine on the event loop."""
    # APScheduler's AsyncIOScheduler runs jobs in the event loop thread,
    # but we still need to ensure the coroutine is properly awaited.
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(run_cleanup_job(db))
    except RuntimeError:
        # No event loop — should not happen with AsyncIOScheduler
        err = RuntimeError("No event loop running")
        err.code = "OBSERVERV_SCHEDULER_FAIL"
        _logger.error(
            "observability.scheduler",
            "Failed to schedule cleanup: no event loop",
            error=err,
        )


async def _startup_cleanup_wrapper(db: Database) -> None:
    """Async wrapper for startup emergency cleanup."""
    try:
        await check_startup_emergency_cleanup(db)
    except Exception as exc:
        err = Exception(str(exc))
        err.code = "OBSERVERV_STARTUP_CLEANUP_FAIL"
        _logger.error(
            "observability.scheduler",
            f"Startup emergency cleanup failed: {exc}",
            error=err,
        )
        try:
            await db.insert_log(
                "ERROR", "scheduler", "startup_cleanup_fail",
                data={"error": str(exc)},
            )
        except Exception:
            pass
