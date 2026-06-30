---
name: research
description: "Structured research workflow with Quick/Standard/Deep modes. Use for investigating technical topics, researching best practices, exploring tradeoffs, finding authoritative sources, or conducting evidence-backed analysis. Do not use for simple lookups, code implementation, or when sufficient information already exists."
license: MIT
metadata:
  version: "1.0.0"
  penny:
    state_machine: true
    mempalace: true
    subagents:
      - echo
      - piper
      - vera
      - carren
      - synthia
---

## When to Use

- Investigate a technical topic or concept
- Research best practices or design patterns
- Explore architectural tradeoffs or technology comparisons
- Find authoritative sources on a specific question
- Conduct literature review or evidence gathering
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

| Mode     | Min Sub-Queries | Max Sub-Queries | Min Tool Invocations | Agents Used                     |
| -------- | --------------- | --------------- | -------------------- | ------------------------------- |
| Quick    | 1               | 1               | 3                    | Echo, Synthia                   |
| Standard | 2               | 3               | 5                    | Piper, Echo, Synthia            |
| Deep     | 3               | 4               | 7                    | Piper, Carren, Echo, Vera, Synthia, Carren |

## Agent Flow

**Quick:** intake → researching (Echo) → synthesizing (Synthia) → complete

**Standard:** intake → planning (Piper) → researching (Echo, 2-3 parallel) → synthesizing (Synthia) → complete

**Deep:** intake → planning (Piper) → critiquing_plan (Carren) → researching (Echo, 3-4 parallel) → validating (Vera) → synthesizing (Synthia) → critiquing_report (Carren) → complete

## Post-Completion

After the skill completes, present the research report. Do not execute recommendations — the skill's job ends at delivery.

### Procedure

1. Fetch the synthesis report from mempalace:
   ```
   memory_smart_search(query="<session_id> Synthesis", room="skills/research-<session_id>", limit=5, include_full=true)
   ```

2. Present the report with metadata: executive summary, key findings with confidence levels, source count and quality distribution (T1-T4), actionable recommendations, and limitations.

## UNKNOWN_STATE

When the skill returns `success: false` with `escalation` data, an agent returned `UNCERTAIN` confidence or unresolvable conflicts were detected during validation.

### Procedure

1. Check for escalation data: `if (result.escalation) { ... }`
2. Present the questions via `questionnaire` using `result.escalation.questions`.
3. Re-invoke with the user's response:
   ```typescript
   skill({
     skill_name: "research",
     goal: "<same goal>",
     constraints: {
       user_response: questionnaire_result,
       orchestrator_state: result.escalation.orchestrator_state,
     },
   });
   ```

## Storing Learnings

```python
memory_add_drawer(wing="penny", room="skills", content="## Research Skill Session\n\n**Session:** {session_id}\n**Query:** {goal}\n**Mode:** {mode}\n**Sources:** {count}\n**Confidence:** {confidence}")
memory_kg_add(f"SkillSession:{session_id}", "completed", f"Skill:research:{goal[:50]}")
```
