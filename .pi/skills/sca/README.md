# sca — Secure Code Analysis

`sca` is a Penny skill that performs deep, gated **secure code analysis of
cloned source repositories** (any language). It is an engine-backed
`BasePlaybook` subclass — `ScaPlaybook` in
`apps/orchestration/src/orchestration/playbooks/sca.py`. The skill-dir
`scripts/orchestrate.py` is a thin delegate that routes `start`/`step`/
`status`/`recover` to the shared orchestration engine
(`orchestration.cli:main`, `default_playbook="sca"`). State lives in the
engine's durable SQLite checkpointer keyed by `run_id` — there is no per-skill
FSM, no `/tmp` session file, no `--state` argv, and no
`extract_state`/`restore_state`.

The deterministic scan/PoC tooling (`baseline_scan.py`, `targeted_scan.py`,
`sandbox.py`, `normalize.py`, `dedup.py`, `redact.py`, …) stays in `scripts/`
and is imported lazily by the playbook; the heavy domain logic (charter draft,
census, augment-rule writing, PoC processing, report artifacts) lives in
`scripts/sca_domain.py`.

> **Test-lane contract:** see [`TESTING.md`](TESTING.md) for the fast-lane /
> integration-lane coverage contract (why the default lane is fully mocked and
> why real-semgrep / real-Docker tests are opt-in).

## Pipeline

Strictly-sequential 13-phase FSM, `charter → report → complete`, with one
non-linear transition: the bounded augmentation loop `deep_dive → targeted_scan`
(re-run P9-authored rules against newly surfaced targets), capped at **3**
rounds (`constraints["augment_cap"]`).

| State | Phase | Kind | Agent | What it does |
|-------|-------|------|-------|--------------|
| `charter` | P0 | agent | echo | Charter, scope, rules of engagement; confirm deterministic charter draft |
| `census` | P1 | agent | echo | Inventory repo: languages, entry points, dependencies |
| `baseline_scan` | P2 | **tool** | — | Deterministic baseline scan; HARD-BLOCKS only if ALL required tools are missing; auto-advances |
| `context` | P3 | agent | synthia | Business/domain context: actors, data classes, PII, integrations |
| `architecture` | P4 | agent | synthia | Architecture + trust boundaries |
| `requirements` | P5 | agent | synthia | Derive SR-### security requirements |
| `threat_model` | P6 | agent | tabitha | STRIDE/LINDDUN threat model against requirements |
| `targeted_scan` | P7 | **tool** | — | Deterministic targeted scan (+ augment rules); merges/dedupes vs P2; never blocks; auto-advances |
| `triage` | P8 | agent | annie | Triage merged findings: dedup, prioritize, filter false positives |
| `deep_dive` | P9 | agent | annie | Deep-dive suspicious findings; optionally request an augment scan |
| `verification` | P10 | agent | vera | Single-shot non-destructive PoC batch in the Docker sandbox |
| `fix_verification` | P11 | agent | vera | Note whether prior findings appear remediated (enrichment, no re-scan) |
| `report` | P12 | agent | skribble | Human-readable report narrative over deterministic artifacts |

The two `tool` states run in-process with no agent (`run_tool_state`). Terminal
states are `complete` and `error`.

### Human gates (6)

Gates are engine planned-gate seams; each pauses exactly once. A gate cleared
once stays cleared (recorded in `cleared_gates`), so the augment loop
re-entering `triage` does not re-gate.

- **AFTER** `charter`, `context`, `threat_model`, `triage` — the phase result
  routes to a `*_gate` that pauses; approve advances, revise re-runs the phase.
  `charter_gate` presents a structured charter questionnaire.
- **BEFORE** `verification_gate` — pauses before dispatching vera; approve
  dispatches vera exactly once. This is the sole checkpoint before any
  sandboxed code execution.
- **AT** `report_gate` — pauses on entering the report phase; approve builds
  the deterministic report artifacts, then dispatches skribble exactly once;
  completion happens on skribble's return.

### Escalation

Any agent phase whose summary carries `needs_clarification` is caught by
`progress_check` and routed `to_unknown → escalate → awaiting_clarification`,
pausing on the engine's HITL path. Resume is by `run_id` + `user_response`;
the run lands back on the exact escalating phase.

### Honesty invariants

PoCs are recorded `poc_executed_pending_review` (never auto pass/fail); the
augment loop is code-capped and its cap is disclosed in the report; a missing
skribble narrative writes an HONEST fallback; coverage gaps are recorded,
never fabricated.

## jsa boundary

`sca` analyzes **cloned source repositories** on disk (any language). The
sibling `jsa` skill analyzes **JavaScript acquired from live URLs**. The
boundary is the input, not the language.

## Output

Defaults to `/tmp/sca-{repo_basename}-{shorthash}`, where `shorthash` is a
sha256 of the resolved absolute target path so two repos that share a basename
never collide. Output is **never** written into the project tree; an
`output_dir` that resolves inside the project (contains `AGENTS.md` / `.pi` /
`.git`) is redirected to `/tmp` automatically. Run state (phase, cleared gates,
augment counter, phase results) is persisted by the engine checkpointer keyed
by `run_id`, so the pipeline survives subprocess boundaries and context resets.

## Reference material (`resources/`)

- `flow.mmd` — the playbook FSM diagram (edge-for-edge with `ScaPlaybook`).
- `reference.md` — states, transitions, gates, loop, escalation, payload.
- `division-of-labor.md`, `conventions.md`, `standards.md`,
  `threat-catalog-jsts.md` — evergreen methodology docs.

## Running the tests

Fast lane (the default; fully mocked — no live tools, LLM, network, or Docker):

```bash
cd /path/to/penny
source .venv/bin/activate
python -m pytest .pi/skills/sca/tests -p no:cacheprovider \
  -m "not e2e and not slow and not network and not integration" -q
```

The opt-in live tests (real semgrep, real Docker, and the NodeGoat benchmark)
are documented in [`TESTING.md`](TESTING.md).
