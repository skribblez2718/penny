---
name: research
description: Structured research workflow with Quick, Standard, and Deep modes. Use when the task requires investigating an unfamiliar topic or gathering authoritative external evidence — finding best practices, comparing approaches, or a deep dive. Do not use when analyzing material you already have (annie), for simple lookups, for quick internal context discovery (echo), or when sufficient information already exists.
license: MIT
metadata:
  version: "2.0.0"
  penny:
    engine: orchestration
    mempalace: true
    subagents:
      - piper
      - echo
      - carren
      - synthia
      - vera
      - skribble
---

## When to Use

- Investigate a technical topic or concept
- Research best practices or design patterns
- Explore architectural tradeoffs or technology comparisons
- Find authoritative sources on a specific question
- Review literature or gather evidence
- Answer complex questions requiring multiple research angles
- Compare options with evidence-backed analysis
- Understand a domain before making decisions

## When Not to Use

- Simple lookups (use `web_search` directly)
- Code implementation (use `plan` skill then execute)
- Already have sufficient information (proceed directly)
- User explicitly says "just do it" (execute directly)

## Invocation

Invoke via the `skill` tool. The skill extension handles orchestration — agents communicate via mempalace, Penny receives structured summaries.

```
skill({
  skill_name: "research",
  goal: "Your research query here",
  project_root: "/path/to/project"
})
```

### Parameters

| Parameter      | Required | Description                                   |
| -------------- | -------- | --------------------------------------------- |
| `skill_name`   | Yes      | Must be `"research"`                          |
| `goal`         | Yes      | The research query                            |
| `session_id`   | No       | Unique session ID (auto-generated if omitted) |
| `project_root` | No       | Project root directory (defaults to cwd)      |
| `constraints`  | No       | JSON object of constraints (see below)        |

### Constraints

| Constraint        | Type   | Default        | Description                                                        |
| ----------------- | ------ | -------------- | ------------------------------------------------------------------ |
| `mode`            | string | `"auto"`       | `"quick"`, `"standard"`, `"deep"`, or `"auto"` (detect from query) |
| `report_format`   | string | `"default"`    | `"default"`, `"brief"`, `"academic"`, `"executive"`                |
| `max_sub_queries` | int    | mode-dependent | Override max parallel sub-queries                                  |
| `purpose`         | string | `"general"`    | `"general"` or `"questionnaire"` (not yet implemented)             |

### Modes

| Mode     | Max Sub-Queries | Agents Used                                       |
| -------- | --------------- | ------------------------------------------------- |
| Quick    | 1               | Echo, Synthia, Vera, Skribble                     |
| Standard | 3               | Piper, Echo, Synthia, Vera, Skribble              |
| Deep     | 4               | Piper, Carren, Echo, Synthia, Vera, Skribble      |

## Agent Flow

`researching` is a single Echo agent that researches all sub-queries. `validating`
(Vera) is an **independent, evidence-based citation-grounding gate** that runs in
every mode as the final check before the report is written: it verifies each
material claim in the synthesis is supported by a cited source (distinct from
Carren's *subjective* critique). A FAIL loops back to synthesizing to re-ground
(bounded; honest exhaustion still ships the report with the unverified claims
surfaced; a stall escalates to the user). This keeps the generator from being its
own only verifier.

**Quick:** intake → researching (Echo) → synthesizing (Synthia) → validating (Vera) → report_writing (Skribble) → complete

**Standard:** intake → planning (Piper) → researching (Echo) → synthesizing (Synthia) → validating (Vera) → report_writing (Skribble) → complete

**Deep:** intake → planning (Piper) → critiquing_plan (Carren) → researching (Echo) → synthesizing (Synthia) → critiquing_report (Carren) → validating (Vera) → report_writing (Skribble) → complete, with two bounded critique loops plus the validation gate

## Post-Completion

After the skill completes, present the research report. Do not execute recommendations — the skill's job ends at delivery.

### Procedure

1. Fetch the synthesis report from mempalace:
   ```
   memory_smart_search(query="<session_id> Synthesis", room="skills/research-<session_id>", limit=5, include_full=true)
   ```

2. Present the report with metadata: executive summary, key findings with confidence levels, source count and quality distribution (T1-T4), actionable recommendations, and limitations.

## Escalation (awaiting_clarification)

The skill pauses at `awaiting_clarification` when an agent sets
`needs_clarification`, when a `*_complete` flag comes back false, or when a
critique stalls. The engine emits escalation questions.

### Procedure

1. Present the questions via `questionnaire`.
2. Resume the SAME run: re-issue `step` with the same `session_id` and `run_id`,
   passing the user's answer as the step result. The engine folds it into
   `clarification_text` and resumes at `planning`.

There is no `orchestrator_state` to thread back — run state lives in the durable
checkpointer keyed by `run_id`.

## Outcomes

The engine records the run outcome automatically (`met`, mode, sub-queries,
warnings, unresolved issues) via the playbook's result payload. Do not manually
write session-summary drawers; the mempalace room `skills/research-{session_id}`
already holds the per-agent drawers (Planner / Research Findings / Synthesis /
Critique / Report Files).
