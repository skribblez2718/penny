"""
Analysis Agent Execution Protocol
=================================

Python orchestration for the analysis-agent cognitive agent.

Steps:
    0. Learning Injection - Load accumulated analysis learnings
    1. Context Loading - Load context and identify domain
    2. Framework Selection - Choose analytical dimensions and criteria
    3. Analytical Process - Map, Score, Detect, Calculate, Assess
    4. Synthesis of Findings - Prioritize and group insights
    5. Output Generation - Document using Johari framework
"""

from pathlib import Path

ANALYSIS_AGENT_ROOT = Path(__file__).parent
