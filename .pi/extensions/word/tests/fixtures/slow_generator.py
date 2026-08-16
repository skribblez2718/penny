#!/usr/bin/env python3
"""Test helper that leaves staged bytes until its parent kills it."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

spec = json.loads(sys.stdin.read())
Path(spec["staging_path"]).write_bytes(b"partial staged package")
time.sleep(30)
