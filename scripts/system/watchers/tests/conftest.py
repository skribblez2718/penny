"""Put the watchers module dir on sys.path and keep the fast lane hermetic.

The watcher modules are flat top-level files (signal_generators.py etc.), so
tests import them by name; inserting the parent dir mirrors the convention in
scripts/system/evals/tests/conftest.py. The observability URL is pinned to a
dead port so unit-test log calls never write noise into a live server (they
fall back to stderr instantly on connection-refused).
"""

import os
import sys
from pathlib import Path

WATCHERS_DIR = str(Path(__file__).resolve().parents[1])
if WATCHERS_DIR not in sys.path:
    sys.path.insert(0, WATCHERS_DIR)

os.environ.setdefault("PENNY_OBSERVABILITY_URL", "http://127.0.0.1:1")
