# Rez Skill — Resume Tailoring

## What

The rez skill tailors a base resume to a specific job description: gap analysis (matches, misses, transferables), a fresh NIST NICE Framework alignment every run, achievement-focused (STAR/XYZ) bullet rewriting, ATS keyword optimization, anti-fabrication validation, and a modern `.docx` export to `/tmp/resumes/`. It runs on the shared orchestration engine as `RezPlaybook` (`apps/orchestration/src/orchestration/playbooks/rez.py`), a `BasePlaybook` subclass; `scripts/orchestrate.py` is a ~5-line delegate.

## Why

A tailored resume must optimize for the target role and ATS without ever fabricating experience. The skill separates gap analysis, live framework alignment, tailoring, and independent validation so the anti-fabrication check is done by an agent that did not write the bullets, and so the NICE alignment reflects the framework as it is *now* rather than a stale snapshot.

## Procedure

### Invocation

```
skill({ skill_name: "rez", goal: "<job description URL or text>" })
```

The goal is the job description (URL, file path, or pasted text). The base resume lives in `resources/resume/`. `start()` errors clearly if either is missing. Optional: `max_iterations` (default 3).

### Engine states (`RezMachine`)

`intake → analyzing (annie: JD ingest + gap analysis) → aligning (echo: fresh NICE lookup, every run) → tailoring (synthia: STAR/ATS/NICE) → validating (vera) ⇄ tailoring → exporting (skribble: .docx) → complete`, plus `unknown`/`awaiting_clarification`/`error`. `clarify` re-enters at `analyzing` (the gap analysis may change and the NICE lookup must be fresh anyway).

### Bitter-Lesson / atomic-loops compliance

- **Live retrieval over baked snapshots.** `aligning` always performs a fresh NIST NICE lookup — never a cached snapshot — the doctrine's fresh-retrieval pattern. When NICE is unavailable the run degrades honestly (`[UNALIGNED]` bullets), never fabricated alignment.
- **Evidence-gated validation** (Rec 4): `REZ_VALIDATE` requires a non-empty `evidence` field — captured per-bullet source traceability plus STAR/ATS/NICE checks — so a resume is never marked `valid`/`fabrication_free` on a bare assertion. Evidence flows to `ctx.verify_evidence` and the outcome ledger. An unverified resume is never exported; on budget exhaustion the run completes `met=False`.
- **Anti-fabrication is the core boundary.** Every tailored bullet traces to the source materials; a JD keyword is applied only where the candidate's evidence supports it.
- **Recall.** `_task_summary` seeds the first agent directive with distilled lessons from prior runs (advisory).

### Agents

annie (gap analysis, NULL-AWARE), echo (fresh NICE lookup, READ-ONLY live retrieval), synthia (STAR/ATS/NICE tailoring, zero fabrication), vera (validation, evidence-gated), skribble (.docx export, NO-EXECUTION, `/tmp/resumes/` scoped). Domain guidance in `.pi/skills/rez/assets/prompts/*.md`.

## Constraints

- Output is a `.docx` in `/tmp/resumes/`; the skill writes nowhere else and has no fallback format (export failure aborts honestly).
- Run state is durable in the `run_id`-keyed checkpointer; crash-resume re-issues the pending step.
- The mempalace room is `skills/rez-<session_id>` (penny wing).

## Verification

- [ ] Playbook tests pass: `python3 -m pytest apps/orchestration/tests/test_rez_playbook.py`
- [ ] `REZ_VALIDATE` rejects empty evidence; `verify_evidence` lands in ctx + ledger
- [ ] `aligning` performs a fresh NICE lookup every run (no cache)
- [ ] `resources/flow.mmd` matches `RezMachine` transition-for-transition

## Files

| File | Purpose |
|------|---------|
| `apps/orchestration/src/orchestration/playbooks/rez.py` | `RezPlaybook` FSM |
| `.pi/skills/rez/assets/prompts/*.md` | Per-state domain guidance |
| `.pi/skills/rez/resources/{resume/,flow.mmd}` | Base resume + state diagram |
| `research/atomic-loop-components/prds/rez-skill-revamp.md` | Compliance PRD |
