# Learn Skill Reference

Technical reference for the learn skill. The authoritative source is the engine
playbook `LearnPlaybook` in
`apps/orchestration/src/orchestration/playbooks/learn.py`; this file mirrors
its FSM. State lives in the durable checkpointer keyed by `run_id` — no session
files, no `--state` argv.

## State Machine

### States

| State                    | Kind         | Agent        | Description                                                        |
| ------------------------ | ------------ | ------------ | ------------------------------------------------------------------ |
| `intake`                 | initial      | —            | Validate goal + `constraints.source_dir`; seed `learn` extras       |
| `ingesting`              | parallel     | `echo` × 3   | Fan out content / conventions / assessment inventory                |
| `designing`              | primitive    | `annie`      | Course charter: curriculum, conventions canon, analogy registry; emit `lesson_count` |
| `charter_gate`           | planned gate | — (user)     | HITL approve / refine / deny the charter before authoring           |
| `authoring`              | primitive    | `skribble`   | ONE lesson's guide + practice answers per pass (self-loops)         |
| `assessing`              | primitive    | `skribble`   | ONE lesson's exam + answer key per pass (self-loops)                |
| `synthesizing`           | primitive    | `synthia`    | Course-wide final prep                                              |
| `verifying`              | primitive    | `vera`       | Full-corpus mechanical + math verification; emit `verified` + `violations` |
| `fixing`                 | primitive    | `skribble`   | Apply violations with cross-file sync                               |
| `critiquing`             | primitive    | `carren`     | Learner-experience judgment; emit `verdict` + `issues`              |
| `unknown`                | transient    | —            | Escalation staging                                                  |
| `awaiting_clarification` | HITL         | — (user)     | Paused; `clarify` resumes at `designing` (lesson progress kept)     |
| `complete`               | final        | —            | Success (`met=True`) or honest exhaustion (`met=False`)             |
| `error`                  | final        | —            | Failure / charter denied                                            |

### Transitions

`intake → ingesting → designing → charter_gate → {authoring | designing | error}`;
`authoring ⟲ per lesson → assessing ⟲ per lesson → synthesizing → verifying`;
`verifying → {critiquing | fixing | complete(met=False)}`; `fixing → verifying`;
`critiquing → {complete | fixing | complete(met=False)}`.

### Loop budgets

- `authoring`/`assessing` self-loop `lesson_count` times (from the design SUMMARY; tracked in `extras.learn.authored/assessed`).
- The verify⇄fix and critique→fix loops share `ctx.iteration` against `ctx.max_iterations` (default 3). Stalled identical violations escalate via `progress_check`; exhaustion completes with `met=False` and `unresolved_violations`.

## SUMMARY contracts

| State | Required | Notable optional |
|-------|----------|------------------|
| ingesting (each branch) | `explore_complete: bool` | `lessons_found`, `topics_found` |
| designing | `design_complete: bool`, `lesson_count: int` | `topic_count`, `conventions`, `analogy_count`, `open_questions` |
| authoring / assessing | `lesson_complete: bool`, `lesson_index: int` | `files_written`, `topic_count` / `problem_count` |
| synthesizing | `synthesis_complete: bool` | `files_written` |
| verifying | `verified: bool`, `violations: list` | `checks_run`, `math_checked`, `files_checked` |
| fixing | `fixes_complete: bool` | `fixed_count`, `files_touched` |
| critiquing | `verdict: str`, `issues: list` | — |

All states accept `needs_clarification` + `clarifying_questions` + `confidence`
(UNCERTAIN on an escalatable state escalates).

## Constraints contract

| Key | Required | Meaning |
|-----|----------|---------|
| `source_dir` | **yes** | Directory holding the raw learning material |
| `output_dir` | no | Output root (default `<source_dir>/../study_materials`) |
| `spec_docs` | no | Existing teaching-approach/spec docs to reuse |
| `audience` | no | Audience override notes |

## Mempalace

Room `skills/learn-{session_id}` (penny-wing convention). Drawers: `Ingest — <focus>` ×3,
`Charter`, `Author — lesson <i>`, `Assess — lesson <i>`, `Synthesize`,
`Verify (round n)`, `Fix (round n)`, `Critique`.

## Per-state prompts

`skill_context()` maps states to `assets/prompts/`: `echo.md`, `annie.md`,
`skribble-author.md`, `skribble-assess.md`, `skribble-fix.md`, `synthia.md`,
`vera.md`, `carren.md`.
