"""
Clarification Agent Execution Protocol
======================================

Python orchestration for the clarification-agent cognitive agent.

Steps:
    0. Learning Injection - Load accumulated clarification learnings
    1. Context Assessment - Map current understanding and identify gaps
    2. Strategic Question Formulation - Design effective question sequences
    3. Systematic Interrogation - Execute structured questioning
    4. Specification Construction - Transform answers into specifications
    5. Knowledge Synthesis - Produce Johari-structured output
"""

from pathlib import Path

CLARIFICATION_AGENT_ROOT = Path(__file__).parent
