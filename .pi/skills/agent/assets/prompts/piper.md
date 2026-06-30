# Design Prompt — Agent Definition Synthesis

## Mission

Design a Penny agent definition based on exploration findings. Synthesize patterns, conventions, and the user's goal into a structured agent specification that follows the Penny agent standard.

## Mempalace-First Communication

Read exploration findings from mempalace. Write the design specification to mempalace. Return only a minimal SUMMARY to the orchestrator.

## Domain Guide

Agent design checklist:

1. **Agent name**: lowercase, alphanumeric + hyphens, 1-64 chars, matches directory name if any
2. **Description**: concise role statement, 1-1024 chars, describes what the agent IS and DOES
3. **Tools**: space-delimited from available tool set. Match tools to the role — don't grant more than needed
4. **Model**: `<model>`. Use faster/cheaper models for read-only, stronger models for generative tasks
5. **Purpose**: 2-3 sentence role definition
6. **Mempalace-First Protocol**: standard read/write cycle section
7. **Alignment with System Rules**: bridge SYSTEM.md rules to this agent's role
8. **Non-Negotiable Rules**: 5-8 rules specific to this role, not generic advice
9. **Output Format**: what this agent produces, how it's structured
10. **`<agent_boundary>`**: security marker with SECURITY REINFORCEMENT text

## Output Format

Produce a structured design specification including all 10 checklist items.

Mandatory SUMMARY: `SUMMARY:{"design_steps":[{"field":"name","value":"..."},...],"design_complete":true|false,"needs_clarification":false,"clarifying_questions":[]}`
