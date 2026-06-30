#!/usr/bin/env python3
"""Standalone retention cleanup for the Penny observability SQLite database.

Runs independently of the observability server as a systemd timer
or cron job. Connects directly to the SQLite database and executes
retention cleanup using the same logic as the in-process APScheduler.

Usage:
    python cleanup_db.py [--dry-run]

Environment:
    PI_OBSERVABILITY_DATA_DIR — path to observability data (default: ~/.local/share/penny/observability)
    PI_OBSERVABILITY_RETENTION_RAW_DAYS — raw entry retention days (default: 14)
    PI_OBSERVABILITY_RETENTION_COMPACTION_DAYS — compaction retention days (default: 90)
    PI_OBSERVABILITY_RETENTION_LOG_DAYS — log retention days (default: 14)
    PI_OBSERVABILITY_RETENTION_WATCHER_LOG_DAYS — watcher log retention days (default: 14)
    PI_OBSERVABILITY_DB_SIZE_MAX_GB — emergency cleanup threshold GB (default: 5)
"""

import argparse
import os
import sys
import time
from pathlib import Path

# Resolve Penny project root for PYTHONPATH
PENNY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PENNY_ROOT / "apps" / "observability" / "src"))

# Load .env for config
from dotenv import load_dotenv
load_dotenv(PENNY_ROOT / ".env")

from observability.config import Config
from observability.db import Database
import asyncio


async def main_async(dry_run: bool = False) -> dict:
    """Run retention cleanup and return stats."""
    db = Database()
    await db.connect()

    stats_before = await db.get_stats()
    db_size_mb_before = stats_before["db_size_mb"]

    if dry_run:
        print(f"[DRY RUN] DB size: {db_size_mb_before:.2f} MB")
        print(f"[DRY RUN] Sessions: {stats_before['session_count']}")
        print(f"[DRY RUN] Entries: {stats_before['entry_count']}")
        print(f"[DRY RUN] Logs: {stats_before['log_count']}")
        print(f"[DRY RUN] Watcher logs: {stats_before['watcher_log_count']}")
        print(f"[DRY RUN] Would delete raw entries older than {Config.RETENTION_RAW_DAYS} days")
        print(f"[DRY RUN] Would delete compactions older than {Config.RETENTION_COMPACTION_DAYS} days")
        print(f"[DRY RUN] Would delete logs older than {Config.RETENTION_LOG_DAYS} days")
        print(f"[DRY RUN] Would delete watcher logs older than {Config.RETENTION_WATCHER_LOG_DAYS} days")
        await db.close()
        return {"dry_run": True, "db_size_mb": db_size_mb_before}

    # Run cleanup
    result = await db.cleanup(
        raw_retention_days=Config.RETENTION_RAW_DAYS,
        compaction_retention_days=Config.RETENTION_COMPACTION_DAYS,
    )
    deleted_logs = await db.cleanup_logs(Config.RETENTION_LOG_DAYS)
    deleted_watcher_logs = await db.cleanup_watcher_logs(Config.RETENTION_WATCHER_LOG_DAYS)
    result["deleted_logs"] = deleted_logs
    result["deleted_watcher_logs"] = deleted_watcher_logs

    # VACUUM to reclaim disk space after deletes (SQLite doesn't auto-shrink)
    cursor = await db._execute("VACUUM")
    await cursor.close()

    stats_after = await db.get_stats()
    db_size_mb_after = stats_after["db_size_mb"]

    total_deleted = (
        result.get("deleted_raw_entries", 0)
        + result.get("deleted_compactions", 0)
        + deleted_logs
        + deleted_watcher_logs
    )

    print(f"Cleanup complete:")
    print(f"  Raw entries deleted: {result.get('deleted_raw_entries', 0)}")
    print(f"  Compactions deleted: {result.get('deleted_compactions', 0)}")
    print(f"  Logs deleted: {deleted_logs}")
    print(f"  Watcher logs deleted: {deleted_watcher_logs}")
    print(f"  Total deleted: {total_deleted}")
    print(f"  DB size: {db_size_mb_before:.2f} MB → {db_size_mb_after:.2f} MB")

    # Emergency cleanup if over threshold
    if db_size_mb_after / 1024 > Config.DB_SIZE_MAX_GB:
        print(f"WARNING: DB size ({db_size_mb_after / 1024:.2f} GB) exceeds threshold ({Config.DB_SIZE_MAX_GB} GB)")
        print("Emergency cleanup needed — run with emergency flag or reduce retention days")

    await db.close()
    return {
        **result,
        "db_size_mb_before": db_size_mb_before,
        "db_size_mb_after": db_size_mb_after,
        "total_deleted": total_deleted,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Penny Observability — Standalone retention cleanup"
    )
    parser.add_argument("--dry-run", action="store_true", help="Show what would be deleted")
    args = parser.parse_args()

    start = time.time()
    asyncio.run(main_async(dry_run=args.dry_run))
    elapsed = time.time() - start
    print(f"Completed in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
