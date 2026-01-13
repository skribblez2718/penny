"""Memory Agent Protocol Package

Metacognitive monitor that tracks problem state, detects impasses,
and suggests remediation strategies.

Cognitive Function: METACOGNITION
Model: opus

Note: Formerly known as goal-memory-agent. The alias is maintained
for backwards compatibility.
"""
from pathlib import Path

AGENT_NAME = "memory"
PROTOCOL_PATH = Path(__file__).parent
