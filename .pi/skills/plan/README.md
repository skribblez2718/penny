# Plan Skill

Creates structured, execution-grade plans for any domain using a validated lifecycle: explore → plan → critique → taskify.

## Overview

- **Purpose**: Create actionable plans from goals and context
- **Domains**: Code, Life, Research, Communication, Learning, Events, General
- **Outcome**: Structured plan with steps, resources, acceptance criteria, risks, and execution notes

## Architecture

```
┌─────────────────────────────────────────────┐
│  Penny invokes skill tool                   │
│  skill({ skill_name: "plan", goal: "..." }) │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Skill Extension (TypeScript)               │
│  ┌─────────────────────────────────────┐    │
│  │ Loop:                               │    │
│  │  1. Python orchestrate.py → Action  │    │
│  │  2. Subagent tool → Agent result    │    │
│  │  3. Extract SUMMARY → Feed to Python│    │
│  │  4. Repeat until complete/error     │    │
│  └─────────────────────────────────────┘    │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Python State Machine (orchestrate.py)      │
│  intake → exploring → planning →            │
│  critiquing → taskifying → complete         │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Subagents (fresh context each)             │
│  echo → piper → carren → tabitha   │
│  All read/write via mempalace               │
│  Only SUMMARY goes back to orchestrator    │
└─────────────────────────────────────────────┘
```

**Key principle: Penny's context stays clean.** Agents communicate via mempalace — Penny never sees full agent output. The orchestrator only receives structured summaries (findings_count, verdict, step_count, etc.).

## Supported Domains

| Domain            | Description                      | Focus Areas                          |
| ----------------- | -------------------------------- | ------------------------------------ |
| **Code/Projects** | Features, refactors, migrations  | Files, dependencies, tests, patterns |
| **Life Planning** | Goals, decisions, career         | Timeline, resources, stakeholders    |
| **Research**      | Studies, investigations          | Sources, methodology, analysis       |
| **Communication** | Documents, emails, presentations | Audience, format, timing             |
| **Learning**      | Skills, courses, certifications  | Prerequisites, resources, practice   |
| **Events**        | Trips, parties, conferences      | Logistics, timeline, budget          |
| **General**       | Any multi-step goal              | Steps, resources, verification       |

## State Machine

```
┌─────────┐     ┌──────────┐     ┌─────────┐     ┌───────────┐     ┌──────────┐
│  intake │ ───▶│ explore  │ ───▶│  plan   │ ───▶│  critique │ ───▶│ taskify │
└─────────┘     └──────────┘     └─────────┘     └───────────┘     └──────────┘
     │               │                │                 │                │
     ▼               ▼                ▼                 ▼                ▼
  clarify        gather           synthesize         validate         format
  questions      context          steps              quality          output
                                     │
                                     │ (needs revision)
                                     └────────────────────▶ back to explore/plan
```

### States

| State        | Description    | Entry Action                               |
| ------------ | -------------- | ------------------------------------------ |
| `intake`     | Initial state  | Load context from Mempalace, validate goal |
| `exploring`  | Gather context | Run Echo agents (parallel if configured)   |
| `planning`   | Create plan    | Run Piper agent with explore context       |
| `critiquing` | Validate plan  | Run Carren agent                           |
| `revising`   | Fix issues     | Determine next state (explore or plan)     |
| `taskifying` | Format output  | Run Tabitha agent for structured JSON      |
| `complete`   | Success        | Store learnings in Mempalace               |
| `error`      | Failure        | Log errors, enable retry                   |

### Parallel Exploration

By default, the explore phase runs a single comprehensive exploration. For complex goals, parallel exploration is automatically triggered:

**Triggered by keywords**: migrate, refactor, implement, integrate, architecture, system

**Splits exploration into**:

1. Entry points and call graph
2. Tests and build pipeline
3. Configuration and dependencies

Results are merged and deduplicated before planning.

## Workflow Phases

| Phase      | Agent     | Purpose                                   | Output to Mempalace       |
| ---------- | --------- | ----------------------------------------- | ------------------------- |
| Exploring  | `echo`    | Gather context from codebase, files, web  | Findings, files, unknowns |
| Planning   | `piper`   | Create execution-grade plan               | Full plan text            |
| Critiquing | `carren`  | Validate plan quality (CREST framework)   | Verdict, issues           |
| Taskifying | `tabitha` | Structure plan into machine-readable JSON | Structured plan JSON      |

The critique phase may trigger revising (loop back to exploring or planning) up to 3 iterations.

### Session Room Lifecycle

Each invocation creates a mempalace room `skills/plan-{session_id}` for the session:

- Agents read prior results from this room
- Agents write new results to this room
- On completion, graduation moves the final deliverable to `completed-plans`
- Session rooms are cleaned up after graduation

## Mempalace Integration

**Context Retrieved (before workflow)**:

```python
# Previous planning sessions
sessions = await memory_smart_search("planning session patterns", wing="penny", room="skills")

# Technical context
technical = await memory_smart_search("architecture decisions", wing="penny", room="technical")
```

**Learnings Stored (after completion)**:

```python
# Session record
await memory_add_drawer(wing="penny", room="skills", content=session_summary)

# Knowledge graph relationships
await memory_kg_add("PlanSession:xxx", "completed", "Skill:plan")
```

## Usage

### Via Plan Mode Extension

1. Toggle plan mode: `/plan` or `Ctrl+Alt+P`
2. Describe your goal
3. Select "Generate plan with skill"
4. Review the structured plan
5. Approve, refine, or execute

### Direct Invocation

```bash
cd .pi/skills/plan
python3 scripts/orchestrate.py \
  --session-id my-session \
  --goal "Plan a family vacation to Europe"
```

### With Constraints

```bash
python3 scripts/orchestrate.py \
  --session-id my-session \
  --goal "Refactor authentication system" \
  --constraints '{"parallel_explore": true, "languages": ["typescript"]}'
```

## Configuration

| Environment Variable    | Default | Description                 |
| ----------------------- | ------- | --------------------------- |
| `PLAN_MAX_ITERATIONS`   | 3       | Maximum revision cycles     |
| `PLAN_SKIP_CRITIQUE`    | false   | Skip critique phase         |
| `PLAN_EXPLORE_PARALLEL` | true    | Run multiple explore agents |
| `PLAN_EXPLORE_MAX`      | 2       | Maximum explore iterations  |

## Testing

```bash
cd .pi/skills/plan

# Unit tests
python3 -m pytest tests/test_unit.py -v

# Integration tests
python3 -m pytest tests/test_integration.py -v

# E2E tests (requires model)
python3 -m pytest tests/test_e2e.py -v -m e2e
```

## Files

| File                     | Purpose                         |
| ------------------------ | ------------------------------- |
| `SKILL.md`               | Skill definition and invocation |
| `README.md`              | This documentation              |
| `scripts/orchestrate.py` | State machine entry point       |
| `tests/test_*.py`        | Test suites                     |
| `assets/prompts/*.md`    | Domain-agnostic agent prompts   |
| `resources/reference.md` | Technical reference             |
| `resources/flow.mmd`     | State diagram                   |

## Resilience — Pi Update Safety

The plan skill is designed to survive Pi updates that change:

- Event type strings (`agent_end`, `message_end`)
- Message structure (field names, nesting)
- CLI entry point (`cli.js`)
- SSE timeout behavior
- Subprocess exit semantics

### Defensive Measures

| Layer            | Defense                           | What It Catches                                                                                                      |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator** | `_validate_summary()` per agent   | Missing required SUMMARY fields from empty/crashed agents                                                            |
| **Orchestrator** | `_safe_default_summary()`         | Defaults that do NOT claim completion — prevents advancing on fabricated data                                        |
| **Orchestrator** | `_extract_and_validate_summary()` | Single gatekeeper: every agent result validated before state transition                                              |
| **Orchestrator** | `_check_statemachine_version()`   | Logs python-statemachine version at startup for diagnostics                                                          |
| **TypeScript**   | `parseSummaryFromOutput()`        | Brace-matching JSON parser (handles nested objects/arrays)                                                           |
| **TypeScript**   | `defaultSummaryForAgent()`        | Safe defaults: `explore_complete: false`, `plan_complete: false`, `complete: false`                                  |
| **Agent Runner** | `hasMessageEnd` guard             | When agent exits without `message_end`, sets `stopReason="incomplete"`, `exitCode=1`, and descriptive `errorMessage` |

### Known Failure Modes

| Mode                               | Symptom                                                             | Root Cause                                       | Fix                                                                    |
| ---------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| **SSE Timeout** (pre-0.70.3)       | Agent exits 0, no SUMMARY, skill advances with empty data           | undici `bodyTimeout` killed SSE at 5 min         | 0.70.3 disabled body timeout; skill now validates all summaries        |
| **Missing SUMMARY**                | `parseSummaryFromOutput` returns `{}`; orchestrator gets empty dict | Agent crashed, timed out, or didn't emit SUMMARY | `_validate_summary()` rejects empty dicts; returns error action        |
| **Bad Default Fallback**           | `defaultSummaryForAgent("echo")` returned `explore_complete: true`  | Old defaults lied about completion status        | Fixed: all defaults set `*_complete: false`                            |
| **Pi Rename cli.js**               | `getPiInvocation()` can't spawn subagents                           | Pi renames CLI entry point                       | Fork-bomb guard already exists; monitor changelog for breaking changes |
| **State Machine Version Mismatch** | Guards/transitions behave differently                               | python-statemachine API changes                  | `_check_statemachine_version()` logs version on startup                |

### If the Skill Fails After a Pi Update

1. Check `scripts/orchestrate.py` logs for `_check_statemachine_version()` output
2. Run tests: `python3 -m pytest tests/test_unit.py tests/test_integration.py tests/test_e2e.py -v`
3. Check agent-runner stderr for `"completed without message_end"`
4. Verify `parseSummaryFromOutput` can still find SUMMARY blocks in agent output
5. Check Pi changelog for event type or message structure changes

## Version History

- **1.0.0** - Domain-agnostic planning with parallel exploration
