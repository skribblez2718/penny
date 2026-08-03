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
| `mode`            | string | (unset)        | `"quick"`, `"standard"`, `"deep"`. Omit to let piper declare the mode from the query — mode is model-owned, not keyword-detected. Only an explicit `"quick"` skips planning. |
| `report_format`   | string | `"default"`    | Free-form shaping instruction passed to the synthesizer — **not an enum**. Anything other than `"default"` is forwarded verbatim (`"brief"`, `"academic"`, `"executive"` are common examples, not the permitted set). |
| `max_sub_queries` | int    | `4`            | The one sub-query budget (replaces the per-mode table). Clamped to `max_fan_width`. |
| `max_fan_width`   | int    | `8`            | Cap on parallel research branches.                                 |
| `validate_model`  | string | (unset)        | **Cross-model verification.** Runs the `validating` citation gate (vera) on a DIFFERENT model than the synthesizer, e.g. `"ollama/glm"`. Scoped to `validating` only — never re-points the generator. Unset = vera's own configured model (same-model gate). |
| `critique_passes` | int    | by mode        | Rigor budget, decoupled from the mode label. `>=1` buys carren's report critique; `>=2` adds the plan critique. Overrides the mode preset. |
| `max_research_rounds` | int | by mode      | Total research passes (initial + evidence-seeking). `1` disables evidence-seeking. |
| `rigor_escalation` | bool  | `false`        | Allow a struggling run to EARN one report-critique pass when validation fails with no researchable gap. Off by default (it changes the quick/standard validation loop). |

### Modes

Mode is a rigor/budget preset chosen by the caller (`constraints.mode`) or declared by piper in its plan SUMMARY. It **expands into a budget** rather than gating FSM edges directly, so rigor can be set independently of the label and earned mid-run:

| Mode | `critique_passes` | `max_research_rounds` |
| ---- | ----------------- | --------------------- |
| `quick` | 0 | 2 |
| `standard` | 0 | 2 |
| `deep` | 2 | 3 |

`critique_passes` is a ladder that spends the scarcer budget on the more valuable critique first: `>=1` buys the **report** critique (carren reads the actual output), `>=2` adds the **plan** critique. An explicit `constraints.critique_passes` always wins over the preset.

There is deliberately **no per-mode sub-query count** — mode governs how much *verification* is paid for, never how the model decomposes. `max_sub_queries` stays one budget the model spends within.

## Agent Flow

`researching` is a **dynamic fan** (arrangement 4): one read-only Echo branch per sub-query (bounded by `max_fan_width`); the explicit-quick fast-path stays a single Echo agent. Critique (Carren) and validation (Vera) are **evidence-gated** (Rec 4) — a verdict without captured evidence is rejected by the engine. `validating`
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

## Verification independence

By default synthia (synthesis) and vera (the citation gate) both run `terra`, so
the final gate is a **same-model** judgement over the generator's own work — the
evidence requirement mitigates it (every claim must trace to a captured source)
but correlated single-model errors can still slip a PASS through. carren adds a
cross-model critique only when `critique_passes >= 1` (the deep preset, or a caller/escalation-granted pass).

Pass `constraints.validate_model` (or set `RESEARCH_VERA` / `RESEARCH_DEFAULT` as
`provider/model`) to put a different model on the gate. Precedence:
`validate_model` → `RESEARCH_VERA` → `RESEARCH_DEFAULT` → vera's own model. An
unset or malformed value falls through, so a typo can never break a run.

This edge is a registered, dated exception in `orchestration/independence.py`;
making cross-model the default is a cost/latency change that needs measurement
first, not a flag flip.

## Post-Completion

After the skill completes, present the research report. Do not execute recommendations — the skill's job ends at delivery.

### Procedure

1. Fetch the synthesis report from mempalace:
   ```
   memory_smart_search(query="<session_id> Synthesis", room="skills/research-<session_id>", limit=5, include_full=true)
   ```

2. Present the report with metadata: executive summary, key findings with confidence levels, source count and how the sources rank (primary / reputable secondary / weak), actionable recommendations, and limitations.

3. Report the run's honest status from the result payload: `met` (the report was written) AND `grounded` (vera's citation gate passed). A `grounded: false` run shipped with the claims listed in `unresolved_issues` unverified — surface them, do not present the report as fully sourced.

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
