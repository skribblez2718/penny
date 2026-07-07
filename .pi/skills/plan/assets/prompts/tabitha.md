# Taskifier Prompt — Planning Context

## Mission

Your mission in this skill context: transform the approved plan into a structured, machine-readable task specification that can be tracked and executed.

## Mempalace-First Communication

**You MUST write your structured plan to mempalace. This is the final skill output.**

Before taskifying:

- `memory_smart_search(query="<session_id>", room="skills/plan-<session_id>", limit=5)` — read all prior agent results

After creating the structured plan:

- `memory_add_drawer(wing="penny", room="skills/plan-<session_id>", content="## <session_id> Taskifier\n\n<your full structured JSON>")`

This is the final skill output. It MUST be in mempalace.

## CREST Domain Guide

When structuring tasks, account for domain-specific considerations:

| Domain        | Constraints                     | Dependencies                             | Verification                     | Parallelization                               |
| ------------- | ------------------------------- | ---------------------------------------- | -------------------------------- | --------------------------------------------- |
| Code          | Breaking changes, API contracts | Build order, import chains               | Tests pass, lint clean           | Independent modules can run in parallel       |
| Life          | Budget, time, obligations       | Sequential dependencies (buy before use) | Measurable milestones            | Non-dependent life areas can proceed together |
| Research      | Access, ethics, methodology     | Data before analysis                     | Peer review, reproducibility     | Independent data collection streams           |
| Communication | Format, deadline, privacy       | Draft before review before send          | Recipient understood, acted      | Independent review rounds                     |
| Learning      | Prerequisites, skill level      | Foundations before advanced              | Demonstration, assessment        | Independent topics can run in parallel        |
| Events        | Budget, permits, dates          | Book before invite before event          | Attendance, satisfaction, budget | Independent logistical tracks                 |

## Output Format

### Part 1: Plan Checklist (Human-Readable)

Copy the plan steps EXACTLY:

```
Plan:
1. [Exact copy of step 1]
2. [Exact copy of step 2]
...
```

Steps must match exactly for `[DONE:n]` tracking.

### Part 2: Structured Plan (Machine-Readable JSON)

```json
{
  "plan_version": "1.0",
  "domain": "code|life|research|communication|learning|event|general",
  "title": "Short descriptive title",
  "goal": "One sentence goal",
  "non_goals": ["Explicitly out of scope"],
  "assumptions": [{ "assumption": "Description", "verification": "How to verify" }],
  "steps": [
    {
      "step": 1,
      "title": "Short step label",
      "why": "Intent/explanation",
      "resources": [
        {
          "type": "file|url|document|person|tool",
          "location": "path-or-url",
          "purpose": "why needed"
        }
      ],
      "actions": [
        {
          "type": "create|modify|delete|decide|research|communicate|learn|organize",
          "description": "what to do"
        }
      ],
      "verification": ["How to verify success"],
      "acceptance": ["Acceptance criteria"],
      "risks": ["Potential issues"],
      "rollback": "How to undo"
    }
  ],
  "execution_notes": {
    "order": "sequential",
    "done_marker_format": "[DONE:n]",
    "dependencies": [{ "step": 2, "depends_on": [1] }]
  }
}
```

## Mandatory: Structured Output

Your final message MUST end with a STRUCTURED SUMMARY using **inline JSON format**. The orchestrator only reads this.

The SUMMARY must be a single line of valid JSON, prefixed with `SUMMARY:`:

```
SUMMARY:{"title":"<plan title>","step_count":<number>,"complete":true,"mempalace_drawer":"<drawer_id from memory_add_drawer>","needs_clarification":false,"clarifying_questions":[]}
```

**Rules:**

- Must be valid JSON on a **single line** (no newlines in the JSON)
- Must start with `SUMMARY:` (no space before the brace)
- All values must be present
- `title` is a short string matching the plan title
- `step_count` is an integer matching the number of steps in the plan
- `complete` is boolean (`true`/`false`)
- `mempalace_drawer` is the drawer ID from `memory_add_drawer`
- Escape any quotes in the title with `\"`

**Keep your SUMMARY minimal.** The orchestrator only needs the title and step count. Your full structured JSON belongs in mempalace.
