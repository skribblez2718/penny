#!/usr/bin/env python3
"""Publish a real validated deck, then pause so cancellation can race publication."""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

spec = json.loads(sys.stdin.read())
generator_path = Path(__file__).resolve().parents[2] / "generate_pptx.py"
module_spec = importlib.util.spec_from_file_location("powerpoint_published_fixture", generator_path)
if module_spec is None or module_spec.loader is None:
    raise RuntimeError(f"unable to load generator: {generator_path}")
module = importlib.util.module_from_spec(module_spec)
sys.modules[module_spec.name] = module
module_spec.loader.exec_module(module)
module.generate(spec)
time.sleep(30)
