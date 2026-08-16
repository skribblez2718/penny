#!/usr/bin/env python3
"""Quarantined one-time July 2026 raw-store migration.

This historical procedure must never be used as a normal online path.  It is
retained only as a tombstone so old runbooks fail closed instead of opening a
live peer.
"""

from __future__ import annotations

import json
import sys
from typing import Sequence


def main(_argv: Sequence[str] | None = None) -> int:
    print(
        json.dumps(
            {
                "error": "one-time raw cleanup is quarantined",
                "mutated": False,
                "recovery": "use receipt-gated copied/offline bridge recovery tools",
            },
            sort_keys=True,
        ),
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
