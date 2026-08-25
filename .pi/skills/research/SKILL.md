---
name: research
description: Structured research workflow with Quick, Standard, and Deep modes. Use when a task requires investigating an unfamiliar topic or gathering authoritative external evidence. Do not use for simple lookups, analysis of already-supplied material, or implementation when sufficient evidence exists.
license: MIT
metadata:
  version: "2.2.0"
  penny:
    engine: orchestration
    mempalace: false
    subagents:
      - piper
      - echo
      - carren
      - synthia
      - vera
      - skribble
---

## When to Use

- Investigate an unfamiliar technical topic or concept.
- Research best practices, design patterns, or architectural tradeoffs.
- Compare options using authoritative external evidence.
- Review literature or gather evidence before a decision.
- Answer a complex question requiring multiple independent research angles.

## When Not to Use

- Simple lookup: use `web_search` directly.
- Analysis of material already provided: delegate to the relevant analysis agent.
- Implementation when sufficient evidence exists: proceed directly or delegate appropriately.
- The user explicitly requests immediate execution and research would not change the result.

## Invocation

Invoke through the `skill` tool:

```
skill({
  skill_name: "research",
  goal: "Your research query here"
})
```

| Parameter | Required | Description |
|---|---:|---|
| `skill_name` | yes | Must be `research`. |
| `goal` | yes | Research query. |
| `session_id` | no | Generated when omitted. |
| `project_root` | no | Target root; defaults to cwd. |
| `constraints` | no | Run budgets and shaping instructions below. |
| `model` | no | Optional per-invocation test/caller override for every worker; production defaults remain in agent SSOT frontmatter. |

### Constraints

| Constraint | Default | Meaning |
|---|---|---|
| `mode` | unset | `quick`, `standard`, or `deep`; omit to let Piper declare it. Only explicit caller `quick` skips planning. |
| `report_format` | `default` | Free-form report-shaping instruction sent to Synthia. |
| `max_sub_queries` | 4 | One decomposition budget, clamped to `max_fan_width`. |
| `max_fan_width` | 8 | Maximum parallel research branches. |
| `validate_model` | unset | Optional different model for Vera only. |
| `critique_passes` | by mode | `>=1` report critique; `>=2` plan critique. |
| `max_research_rounds` | by mode | Initial plus evidence-seeking rounds; `1` disables re-research. |
| `rigor_escalation` | false | Permit one report-critique pass after repeated validation difficulty without a researchable gap. |

### Modes are budget presets

| Mode | `critique_passes` | `max_research_rounds` |
|---|---:|---:|
| quick | 0 | 2 |
| standard | 0 | 2 |
| deep | 2 | 3 |

There is no per-mode sub-query table. Code caps budgets; the model chooses how much to spend within them.

## Exact Artifact Handoff

The engine supplies versioned `input_artifacts` and an `output_artifact` contract for every cognitive stage. Each agent reads every task-provided predecessor with `artifact_read`, returns complete stage content, and emits a small routing-only `SUMMARY`. The execution owner captures exact response bytes before SUMMARY routing; agents never assert artifact persistence or registration.

Research does not require a memory endpoint or memory extension. Checkpoint state contains exact selected references for retries, clarification, and restart. Parallel fan-in maps branch artifacts by `branch_id`, never result order.

The final Skribble response contains the complete `report.md`, `sources.md`, and `README.md` content. Its owner-captured `agent-output` reference is returned as `result.output_artifact_ref` and is the registered product artifact. The same contents are still written to the three user-facing files under the report directory.

## Agent Flow

`researching` is a dynamic fan: one read-only Echo branch per sub-query, bounded by `max_fan_width`. Explicit caller-quick uses one Echo agent. Carren critique and Vera validation require non-empty captured evidence.

- **Quick:** intake → researching → synthesizing → validating → report_writing → complete
- **Standard:** intake → planning → researching → synthesizing → validating → report_writing → complete
- **Deep:** intake → planning → critiquing_plan → researching → synthesizing → critiquing_report → validating → report_writing → complete

All critique and validation loops are bounded. Exhaustion proceeds honestly with warnings and unresolved issues; it never creates a fake approval. Vera may name `evidence_needed`, which drives a bounded evidence-seeking loop through Echo and Synthia before re-validation.

## Verification Independence

Synthia and Vera may resolve to the same model by default. Pass `constraints.validate_model` or configure `RESEARCH_VERA` / `RESEARCH_DEFAULT` to select a different Vera model. Precedence is constraint → Vera environment override → default environment override → Vera's configured model. The override never changes Synthia.

## Clarification and Recovery

The run pauses when a stage requests clarification, reports incomplete work, uses `UNCERTAIN`, or repeats the same unresolved issue. Present the engine's questions, then resume the same `session_id` and `run_id` with the user's answer.

Resume is producer-oriented:

- planning or plan critique → planning;
- researching → researching;
- synthesis, report critique, or validation → synthesizing.

The resumed directive retains exact checkpointed artifact references and includes the user's clarification. No orchestration-state blob must be threaded by the caller.

## Terminal Result

The skill result text prints the terminal artifact as `Exact output artifact: art_…`. Read those exact bytes with `artifact_read` when the full report matters; the inline preview is bounded and is not the product. Present that artifact, plus:

- `met`: final report production completed;
- `grounded`: Vera's final citation gate passed;
- `report_dir` and `report_files`: user-facing file products;
- warnings, exhausted flags, and `unresolved_issues`.

After honest validation exhaustion, a useful report may still be delivered with `met: false` and `grounded: false`. Surface those unresolved claims and do not present the report as fully verified. Do not execute recommendations; the skill ends at research delivery.
