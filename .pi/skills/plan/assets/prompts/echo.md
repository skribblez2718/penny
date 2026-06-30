# Explore Prompt — Planning Context

## Mission

Your mission in this skill context: gather evidence and context to enable high-quality planning.

## Mempalace-First Communication

**You MUST write your full findings to mempalace. This is how downstream agents receive your work.**

Before exploring:

- `memory_smart_search(query="<session_id>", room="skills/plan-<session_id>", limit=5)` — check for prior results

After completing exploration:

- `memory_add_drawer(wing="penny", room="skills/plan-<session_id>", content="## <session_id> Explore\n\n<your full findings>")`

Your task includes the session ID and mempalace room. Use them.

## Domain Guides (CREST Framework)

For each domain, explore across five dimensions: **C**onstraints, **R**esources, **E**valuation, **S**equence, **T**radeoffs.

### Code/Projects

| Dim   | What to Find                                                 |
| ----- | ------------------------------------------------------------ |
| **C** | Breaking changes, API contracts, must-not-touch paths        |
| **R** | Libraries, patterns, test infra, deploy pipeline             |
| **E** | Tests pass, build succeeds, no regressions                   |
| **S** | Dependency order, build → test → deploy                      |
| **T** | Speed vs. quality, new vs. refactor, coverage vs. simplicity |

### Life

| Dim   | What to Find                                         |
| ----- | ---------------------------------------------------- |
| **C** | Budget, time, obligations, non-negotiables           |
| **R** | Money, time, energy, skills, relationships           |
| **E** | Measurable milestones, person's own success criteria |
| **S** | Dependencies, timeline pressure points               |
| **T** | Cost vs. quality, speed vs. thoroughness             |

### Research

| Dim   | What to Find                                             |
| ----- | -------------------------------------------------------- |
| **C** | Time, access, ethics, methodology requirements           |
| **R** | Prior work, databases, experts, analysis tools           |
| **E** | What constitutes a valid answer, source quality criteria |
| **S** | Hypothesis → method → data → analysis → synthesis        |
| **T** | Breadth vs. depth, speed vs. rigor                       |

### Communication

| Dim   | What to Find                                 |
| ----- | -------------------------------------------- |
| **C** | Length, tone, privacy, deadlines, format     |
| **R** | Templates, audience knowledge, reviewers     |
| **E** | Did audience understand? Act? Respond?       |
| **S** | Draft → review → revise → approve → send     |
| **T** | Completeness vs. brevity, speed vs. accuracy |

### Learning

| Dim   | What to Find                                     |
| ----- | ------------------------------------------------ |
| **C** | Time, prerequisites, current skill level         |
| **R** | Courses, mentors, practice environments          |
| **E** | Projects, tests, demonstrated ability            |
| **S** | Prerequisites → concepts → practice → assessment |
| **T** | Theory vs. practice, breadth vs. depth           |

### Events

| Dim   | What to Find                                           |
| ----- | ------------------------------------------------------ |
| **C** | Budget, date constraints, permits, capacity            |
| **R** | Venues, vendors, volunteers, equipment                 |
| **E** | Attendance, satisfaction, budget adherence             |
| **S** | Book → invite → arrange → rehearse → event → follow-up |
| **T** | Cost vs. experience, formality vs. fun                 |

## Output Format

### Goal Restatement

One paragraph restating the goal from your exploration perspective.

### High-Signal Findings

- Specific, actionable facts with sources
- What matters for planning

### Key Information

Sources and references that matter.

### Structure and Relationships

Dependencies, sequences, constraints.

### Open Questions

What remains unclear.

## Mandatory: Structured Output

Your final message MUST end with a STRUCTURED SUMMARY using **inline JSON format**. The orchestrator only reads this.

The SUMMARY must be a single line of valid JSON, prefixed with `SUMMARY:`:

```
SUMMARY:{"findings_count":<number>,"files_count":<number>,"unknowns_count":<number>,"explore_complete":true,"mempalace_drawer":"<drawer_id from memory_add_drawer>","needs_clarification":false,"clarifying_questions":[]}
```

**Optional:** Include `"context_received":{"goal":"<echoed goal>","sources_count":<N>}` to confirm the task and constraints were understood. This helps the orchestrator verify context transfer.

- `needs_clarification` is REQUIRED — set to `true` if critical information is missing that prevents you from completing this task. When `true`, provide `clarifying_questions` (array of strings). The parent process will present these questions to the user and resume you with answers. Do NOT call the `questionnaire` tool directly from a subagent subprocess.

- `clarifying_questions` is REQUIRED when `needs_clarification` is `true` — list the specific questions the user must answer. Empty array when `needs_clarification` is `false`.

**Rules:** Single-line valid JSON prefixed with `SUMMARY:` (no space before brace). `findings_count`, `files_count`, `unknowns_count` are integers; `explore_complete` is boolean; `mempalace_drawer` is the drawer ID. Escape quotes with `\"`.

**Keep your SUMMARY minimal.** The orchestrator only needs counts and a completion flag. Your detailed findings belong in mempalace, not in the summary.
