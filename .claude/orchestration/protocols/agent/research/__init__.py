"""
Research Agent Execution Protocol
=================================

Python orchestration for the research-agent cognitive agent.

Steps:
    0. Learning Injection - Load accumulated research learnings
    1. Context Extraction - Parse task and identify information needs
    2. Unknown Resolution - Address critical unknowns from prior steps
    3. Strategy Formulation - Determine research breadth, depth, sources
    4. Discovery Process - Execute systematic research
    5. Synthesis Documentation - Organize findings using Johari framework
"""

from pathlib import Path

RESEARCH_AGENT_ROOT = Path(__file__).parent
