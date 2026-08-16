#!/usr/bin/env python3
"""Quarantined live collection rebuild entrypoint.

Rebuilding through a second live peer is prohibited.  Recovery remains
available through the copied/offline, receipt-gated tools under
``scripts.system.bridge``.
"""

from __future__ import annotations

import json
import sys
from typing import Sequence


def main(_argv: Sequence[str] | None = None) -> int:
    print(
        json.dumps(
            {
                "error": "live/raw collection rebuild is quarantined",
                "mutated": False,
                "recovery": "scripts.system.bridge.rebuild_from_disk",
            },
            sort_keys=True,
        ),
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
