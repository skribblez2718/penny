"""Put the evals directory on sys.path so tests import modules directly."""

import sys
from pathlib import Path

EVALS_DIR = str(Path(__file__).resolve().parents[1])
if EVALS_DIR not in sys.path:
    sys.path.insert(0, EVALS_DIR)
