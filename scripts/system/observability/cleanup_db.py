#!/usr/bin/env python3
"""Standalone size-based rotation for the Penny observability SQLite database.

OPTIONAL manual maintenance CLI. In normal operation the observability server
bounds its own DB in-process (size-based rotation on startup + a periodic
interval — see observability/scheduler.py); there is NO cron/systemd timer.

This script exists for manual, out-of-band maintenance: it connects directly to
the SQLite DB and runs the SAME rotation routine the server uses (evict oldest
rows across ALL tables until live bytes fall to the floor). Unlike the
steady-state in-process path, this manual tool MAY optionally VACUUM afterwards
to physically shrink the file (``--vacuum``).

Usage:
    python cleanup_db.py [--dry-run] [--vacuum]

Environment:
    PI_OBSERVABILITY_DATA_DIR — path to observability data
        (default: ~/.local/share/penny/observability)
    PI_OBSERVABILITY_DB_SIZE_MAX_GB — rotation cap in GB (default: 5.0)
    PI_OBSERVABILITY_DB_SIZE_FLOOR_GB — rotation floor in GB (default: 1.0)
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

# Resolve Penny project root for PYTHONPATH
PENNY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PENNY_ROOT / "apps" / "observability" / "src"))

# Load .env for config. These imports intentionally follow the sys.path/.env
# bootstrap above (this is a standalone maintenance script, not a package module).
from dotenv import load_dotenv  # noqa: E402

load_dotenv(PENNY_ROOT / ".env")

from observability.config import Config  # noqa: E402
from observability.db import Database  # noqa: E402

_GIB = 1024**3


async def main_async(dry_run: bool = False, vacuum: bool = False) -> dict:
    """Run size-based rotation and return a summary."""
    db = Database()
    await db.connect()

    cap_bytes = int(Config.DB_SIZE_MAX_GB * _GIB)
    floor_bytes = int(Config.DB_SIZE_FLOOR_GB * _GIB)

    file_bytes = await db.file_bytes()
    live_bytes = await db.live_bytes()

    if dry_run:
        print(f"[DRY RUN] file_bytes: {file_bytes / _GIB:.3f} GB")
        print(f"[DRY RUN] live_bytes: {live_bytes / _GIB:.3f} GB")
        print(f"[DRY RUN] cap:        {Config.DB_SIZE_MAX_GB} GB")
        print(f"[DRY RUN] floor:      {Config.DB_SIZE_FLOOR_GB} GB")
        if file_bytes >= cap_bytes:
            print("[DRY RUN] Over cap — rotation WOULD run, draining oldest rows to floor.")
        else:
            print("[DRY RUN] Under cap — rotation would be a no-op.")
        await db.close()
        return {"dry_run": True, "file_bytes": file_bytes, "live_bytes": live_bytes}

    result = await db.rotate(cap_bytes, floor_bytes)

    print("Rotation complete:")
    print(f"  Triggered:      {result['triggered']}")
    print(f"  Deleted total:  {result.get('deleted_total', 0)}")
    for table, count in (result.get("deleted") or {}).items():
        if count:
            print(f"    {table}: {count}")
    print(
        f"  file_bytes: {result['file_bytes_before'] / _GIB:.3f} GB "
        f"→ {result['file_bytes_after'] / _GIB:.3f} GB"
    )
    print(
        f"  live_bytes: {result['live_bytes_before'] / _GIB:.3f} GB "
        f"→ {result['live_bytes_after'] / _GIB:.3f} GB"
    )

    if vacuum:
        # Manual-only: physically reclaim disk (the in-process path never VACUUMs).
        print("  Running VACUUM to shrink the file on disk...")
        cursor = await db._execute("VACUUM")
        await cursor.close()
        file_after_vacuum = await db.file_bytes()
        print(f"  file_bytes after VACUUM: {file_after_vacuum / _GIB:.3f} GB")

    await db.close()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Penny Observability — manual size-based rotation"
    )
    parser.add_argument("--dry-run", action="store_true", help="Show what would happen")
    parser.add_argument(
        "--vacuum",
        action="store_true",
        help="Physically shrink the file after rotation (manual-only, not the steady-state path)",
    )
    args = parser.parse_args()

    start = time.time()
    asyncio.run(main_async(dry_run=args.dry_run, vacuum=args.vacuum))
    elapsed = time.time() - start
    print(f"Completed in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
