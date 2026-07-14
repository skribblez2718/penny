# Learn Skill — Study-Companion Generation

## What

The learn skill turns raw learning material (lectures, slides, notebooks, textbook chapters) into a complete study companion: per-lesson study guides, practice questions with answers, practice exams, and course-wide final prep. It runs on the shared orchestration engine as `LearnPlaybook` (`apps/orchestration/src/orchestration/playbooks/learn.py`), a `BasePlaybook` subclass; `.pi/skills/learn/scripts/orchestrate.py` is a ~5-line delegate into `orchestration.cli`.

## Why

Authoring a full course is a long-horizon, verification-heavy task: dozens of files must agree on notation, every quantitative answer must be correct, and the pedagogy must actually prepare a learner for the target exams. The skill separates ingest → design → author → verify → critique so each concern is checked independently, with a human gate before mass authoring and an executed recomputation oracle before the corpus is accepted.

## Procedure

### Invocation

```
skill({ skill_name: "learn", goal: "Build a study companion for the quantum course",
        constraints: { source_dir: "/path/to/material" } })
```

`constraints.source_dir` is required (`start()` raises without it). Optional: `output_dir` (default `<source_dir>/../study_materials`), `spec_docs`, `ingest_branches`, `max_fan_width`, `max_iterations`.

### Engine states (`LearnMachine`)

`intake → scoping (echo) → ingesting (echo fan) → designing (annie) → charter_gate (HITL) → authoring ⟳ (skribble, one lesson/pass) → assessing ⟳ (skribble) → synthesizing (synthia) → verifying (vera) ⇄ fixing (skribble) → critiquing (carren) → complete`, plus `unknown`/`awaiting_clarification`/`error`. A caller `constraints.ingest_branches` skips `scoping`. `clarify` resumes at `designing`.

### Bitter-Lesson / atomic-loops compliance

- **Ingest topology is model-emitted** (arrangement 4). The `scoping` state (echo) quickly scans the source and emits `ingest_branches`; `route_after` turns them into `ctx.extras["dynamic_branches"]["ingesting"]` and the engine fans out one read-only `echo` branch per focus, bounded by `max_fan_width`. A caller `constraints.ingest_branches` supplies the topology directly and skips `scoping`. The legacy 3-focus split (content / conventions / assessment) survives only as the **tagged LOAN** `learn_default_ingest_topology` (`LEARN_INGEST_DEFAULT`), used when scoping emits nothing; ablated, an empty scoping output escalates to the user rather than baking the fixed decomposition.
- **Verification is evidence-gated** (Rec 4): `LEARN_VERIFY` is an executed oracle (mechanical conformance + recomputation of every quantitative answer); its contract requires a non-empty `evidence` field carrying the recomputation transcripts, so `verified: true` on a bare assertion is rejected. `LEARN_CRITIQUE` likewise requires `evidence` (what carren examined). Both flow to `ctx.verify_evidence` and the outcome ledger.
- **Honest exhaustion.** The verify⇄fix and critique loops are bounded by `max_iterations`; on budget exhaustion the run completes with `met=False` and the unresolved violations/issues, never a fabricated pass; a stalled loop escalates.
- **Recall.** `_task_summary` seeds the first agent directive with distilled lessons from prior runs (advisory).
- **HITL.** `charter_gate` pauses for human approval of the design before mass authoring.

### Agents

echo (ingest, READ-ONLY), annie (curriculum design + conventions canon), skribble (author / assess / fix), synthia (final prep), vera (verification — recompute-tier evidence hierarchy), carren (learner-experience critique). Domain guidance in `.pi/skills/learn/assets/prompts/*.md`; the pedagogy spec and file-structure canon live in `resources/`.

## Constraints

- Run state is durable in the `run_id`-keyed checkpointer; no `--state` argv, no `/tmp` session file; crash-resume re-issues the pending step.
- Materials are written under `output_dir`; the skill never writes elsewhere in the project tree.
- The mempalace room is `skills/learn-<session_id>` (penny wing).

## Verification

- [ ] Playbook tests pass: `python3 -m pytest apps/orchestration/tests/test_learn_playbook.py`
- [ ] `LEARN_VERIFY`/`LEARN_CRITIQUE` reject empty evidence; `verify_evidence` lands in ctx + ledger
- [ ] Ingest topology: caller override drives the fan; loan-ablated + no caller topology fails loud
- [ ] `resources/flow.mmd` matches `LearnMachine` transition-for-transition

## Files

| File | Purpose |
|------|---------|
| `apps/orchestration/src/orchestration/playbooks/learn.py` | `LearnPlaybook` FSM |
| `.pi/skills/learn/assets/prompts/*.md` | Per-state domain guidance |
| `.pi/skills/learn/resources/{pedagogy-spec,file-structure,flow.mmd}` | Teaching canon + diagram |
| `research/atomic-loop-components/prds/learn-skill-revamp.md` | Compliance PRD |
