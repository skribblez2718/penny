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

`resources/flow.mmd` is the canonical FSM diagram (an edge-for-edge mirror of
`JSAMachine`, drift-tested by `apps/orchestration/tests/test_jsa_flow_diagram.py`).
The pipeline is strictly linear with a single human gate, a bounded agent wave
loop, and an evidence-gated agent tail:

```
intake ─(gate)→ acquire → cve_research → sast_scan → normalize
→ dedup_within_source → correlate_evidence → agent_review → sast_validate
→ structure → slice → investigate ⟲(wave loop) → collect → merge
→ verify →⟨reverify?⟩→ poc_capture → report → reflect → complete
```

- **TOOL_STATES** (deterministic, no agent, run inline): `acquire`,
  `cve_research`, `sast_scan`, `normalize`, `dedup_within_source`,
  `correlate_evidence`, `agent_review`, `sast_validate`, `structure`, `slice`,
  `collect`, `poc_capture`. `agent_review` and `sast_validate` are LOCAL
  heuristics despite the name; `poc_capture` is an engine-owned browser-PoC
  artifact check that demotes any claimed-verified finding lacking a decodable
  screenshot.
- **Agent states** (`PRIMITIVE_BY_STATE`): `investigate` → annie,
  `merge` → synthia, `verify` → vera, `reverify` → vera (optional second pass),
  `report` → skribble, `reflect` → carren.
- **GATE_STATES** (`{intake}`): the only human gate, resumed via `route_user`
  (`user_response` on the same `run_id`) — not the legacy `escalate_to_user`
  protocol. `intake` is a schema questionnaire (target_url, auth mode, session
  management, auth details); seeded from `constraints`, a valid record skips the
  gate and the pipeline fires straight into `acquire`. There is **no** post-
  investigate `stop` gate — the waves flow straight into `collect`.
- **INVESTIGATE parallel batch fan (per-class)**: a bounded self-transition. `slice`
  emits one annie branch per candidate vuln class (a FRESH context focused on a single
  class + its `assets/references/<class>.md` catalog) into `dynamic_branches`; the
  engine dispatches them in BATCHES of up to `max_fan_width` agents CONCURRENTLY,
  iterating batch after batch until ALL classes are covered, then a trailing GENERALIST
  SWEEP batch (novel patterns, logic/auth flaws, cross-class chains). `total_batches =
  ceil(len(candidate_classes) / max_fan_width) + 1`; `max_fan_width` is a tunable Budget
  (`constraints["max_fan_width"]`, jsa default 5) that also caps the engine fan. No
  cap/fold — every class gets a dedicated agent (class count ≤ 22); annie always runs at
  least the sweep (≥ 1 batch). Findings still unverified after the batches are reported
  honestly as `unverified_after_waves`. (`wave_size` is an informational per-class
  candidate-batch hint.)
- **Dual-verify (optional)**: with `constraints["dual_verify"]`, a `verify` PASS
  routes to `reverify` — a second, independent vera (a different model via
  `constraints["reverify_model"]`) — and only findings BOTH passes confirm are
  reported verified.
- **Escalation seam** (`ESCALATABLE_STATES = {investigate, merge, verify,
  reverify, report, reflect}`): an agent SUMMARY with `needs_clarification`
  routes `to_unknown → escalate → awaiting_clarification`, and `clarify` resumes
  the agent portion at `investigate`.
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
