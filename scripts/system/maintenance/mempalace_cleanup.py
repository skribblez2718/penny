#!/usr/bin/env python3
"""Quarantined historical cleanup entrypoint.

The age-independent 2026 cleanup is not a normal production operation.  Use
the hub-routed tiered-memory retention planner for current policy, or make an
explicit copied/offline recovery target and receipt for byte-level recovery.
"""

from __future__ import annotations

import json
import sys
from typing import Sequence


def main(_argv: Sequence[str] | None = None) -> int:
    print(
        json.dumps(
            {
                "error": "historical cleanup is quarantined",
                "replacement": "scripts.system.tiered_memory.archiver",
                "mutated": False,
            },
            sort_keys=True,
        ),
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
