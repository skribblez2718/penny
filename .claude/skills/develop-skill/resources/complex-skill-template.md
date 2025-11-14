---
name: [skill-name]
version: 1.0.0
description: [comprehensive description]
author: [author]
tags: [relevant, tags, here]
status: development
complexity: complex
agents_required: [number]
estimated_turns: [number]
---

[SKILL NAME]

OVERVIEW
[Comprehensive description of the skill's purpose and capabilities]

ARCHITECTURE

WORKFLOW DIAGRAM
[ASCII or text-based workflow diagram showing orchestration flow]

AGENT ORCHESTRATION

AGENT 1: [NAME]

Purpose: [Detailed purpose - WHAT this agent accomplishes in the workflow]

Trigger: [What initiates this agent]

Instructions:
[Detailed agent instructions defining WHAT tasks to perform, not HOW to perform them]

Output Format:
[Expected output structure]

Handoff Protocol:
[How to pass control to next agent]

AGENT 2: [NAME]
[Repeat structure for all agents]

STATE MANAGEMENT

PERSISTENT STATE
{
  "workflow_id": "[unique_id]",
  "current_phase": "[phase_name]",
  "collected_data": {},
  "decisions_made": [],
  "agents_completed": []
}

STATE TRANSITIONS
[Define how state changes between agents]

DECISION TREES

DECISION POINT 1: [NAME]
IF [condition]
  THEN ’ Agent [X]
ELSE IF [condition]
  THEN ’ Agent [Y]
ELSE
  THEN ’ Agent [Z]

ERROR HANDLING

ERROR RECOVERY MATRIX
Error Type | Detection | Recovery Strategy | Fallback
[Type 1]   | [Method]  | [Strategy]        | [Action]
[Type 2]   | [Method]  | [Strategy]        | [Action]

USAGE EXAMPLES

SCENARIO 1: [COMMON USE CASE]
User: [Request]
Penny: Initiating complex skill [name]
Agent 1: [Action]
Agent 2: [Action]
[...]
Result: [Outcome]

SCENARIO 2: [EDGE CASE]
[Example with error handling]

PERFORMANCE CONSIDERATIONS
- Expected execution time: [estimate]
- Context window usage: [percentage per agent]
- Optimal agent parallelization opportunities

DEPENDENCIES

REQUIRED SKILLS
- [Skill 1]: [Why needed]
- [Skill 2]: [Why needed]

REQUIRED RESOURCES
- [Resource 1]: [Purpose]
- [Resource 2]: [Purpose]

TESTING PROTOCOL
1. [Test case 1]: [Expected behavior]
2. [Test case 2]: [Expected behavior]
3. [Edge case test]: [Expected behavior]

MAINTENANCE NOTES
[Guidelines for updating this skill]
