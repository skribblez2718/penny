# jsa — JavaScript Security Analysis

Multi-agent JavaScript security-analysis skill for Pi/Penny. See `SKILL.md` for
the full specification and `resources/reference.md` + `resources/flow.mmd` for
the FSM.

## Orchestration

jsa runs on the shared orchestration engine. The skill is a `BasePlaybook`
subclass — `JSAPlaybook` in
`apps/orchestration/src/orchestration/playbooks/jsa.py` — and
`scripts/orchestrate.py` is a ~5-line delegate that hands `start`/`step`/
`status`/`recover` to `orchestration.cli:main`. There is no per-skill state
machine, no `session.json`, no `--state` argv, and no `extract_state` /
`restore_state`. Run state (FSM position + lean domain counts in
`ctx.extras["jsa"]`) lives in the engine's durable SQLite checkpointer keyed by
`run_id`. Heavy domain artifacts (cards, findings, scan output) still live on
disk under `output_dir`; the deterministic scan/card/analyzer modules stay in
this `scripts/` dir and are imported lazily by the playbook via `jsa_domain.py`.

## States

The FSM is a strictly linear pipeline with two human gates, a bounded agent loop,
and an agent tail:

```
intake ─(gate)→ acquire → cve_research → sast_scan → normalize
→ dedup_within_source → correlate_evidence → agent_review → sast_validate
→ structure → slice → investigate ⟲(wave loop) → stop ─(gate)→ collect
→ merge → verify → report → reflect → complete
```

- **TOOL_STATES** (deterministic, no agent, run inline): `acquire`,
  `cve_research`, `sast_scan`, `normalize`, `dedup_within_source`,
  `correlate_evidence`, `agent_review`, `sast_validate`, `structure`, `slice`,
  `collect`. Note: `agent_review` and `sast_validate` are LOCAL heuristics
  despite the name — no agent runs.
- **Agent states** (`PRIMITIVE_BY_STATE`): `investigate` → annie,
  `merge` → synthia, `verify` → vera, `report` → skribble, `reflect` → carren.
- **GATE_STATES** (`{intake, stop}`): human HITL gates resumed via `route_user`
  (`user_response` on the same `run_id`) — not the legacy `escalate_to_user`
  protocol.
  - `intake` — schema questionnaire (target_url, auth mode, session
    management, auth details). Seeded from `constraints`; if already valid the
    gate is skipped and the pipeline fires straight into `acquire`.
  - `stop` — continue/stop checkpoint after INVESTIGATE. `continue` →
    `collect`; `stop` → `complete` early (findings remain un-merged/un-verified;
    `done_predicate` reports `met=False` honestly).
- **INVESTIGATE wave loop**: a bounded self-transition. `total_waves =
  max(1, ceil(needs_llm / WAVE_SIZE))` with `WAVE_SIZE = 10`; annie always runs
  at least one wave (the general sweep). Findings still unverified after the
  waves are reported honestly as `unverified_after_waves`.
- **Escalation seam** (`ESCALATABLE_STATES = {investigate, merge, verify,
  report, reflect}`): an agent SUMMARY with `needs_clarification` routes
  `to_unknown → escalate → awaiting_clarification`, and `clarify` resumes the
  agent portion at `investigate`.
- **Completion**: `done_predicate` is met when the pipeline reaches `reflect`
  with a `verify` verdict recorded.

## Verify is the external oracle

VERIFY (vera, browser PoC) carries an `evidence` contract: its SUMMARY must
attach the executed-PoC transcripts, so a bare `verdict: PASS` with no captured
transcript fails loud. The transcript list may legitimately be empty for a clean
target — it is not forced non-empty (which would pressure fabricating a PoC).
VERIFY also enforces the `out_of_scope` scope constraint.

## MemPalace

Wing: `wing_jsa`. Per-session rooms (`{session_id}-…`): `mesh`, `feed`,
`findings`, `merged`, `sast-findings`, `cve-research`, `verified`, `reports`.
Cross-session persistent room: `jsa-learnings` (carren writes FP/FN pattern
corrections here). The subprocess cannot call MCP tools, so SAST/CVE results are
written to `{output_dir}/mempalace_stubs.json` and the completion `result`
instructs Penny to replay `memory_add_drawer` for each stub into `wing_jsa`.

## Development

```bash
cd .pi/skills/jsa
python -m pytest tests/ -v
```

The playbook's deterministic tool bodies bridge to the skill-dir modules via the
`_domain_run` seam, which tests override so no real scanner (semgrep / jsluice /
OSV / joern / katana) runs.
