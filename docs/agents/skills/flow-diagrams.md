# Skill Flow Diagrams — Visual reference for skill state machines

## What

A self-contained, interactive **HTML** diagram showing the state transitions of each skill's engine playbook (the `BasePlaybook` subclass in `apps/orchestration/src/orchestration/playbooks/<skill>.py`). Stored at `resources/flow.html`, it opens in any browser with no build step and renders nodes (FSM states) + labelled edges (transitions) from an embedded data model. Used for design review and debugging.

## Why

State machines with 10+ states and conditional transitions are hard to reason about from code alone. A rich, styled diagram makes the flow — agents, TOOL/gate states, loops, escalation, and terminals — explicit at a glance. HTML (over static Mermaid) gives per-agent colour, badges, callouts, and notes that a plain state chart can't.

## The standard: `resources/flow.html`

`resources/flow.html` is **the** flow-diagram format. (The legacy Mermaid `resources/flow.mmd` is still _accepted_ by the structure checker for skills not yet migrated, but it is deprecated — new and updated skills MUST ship `flow.html`, and the `.mmd` should be removed once converted.)

**Rules**

1. **One diagram per skill**, at `resources/flow.html`, mirroring the playbook's `machine_cls` transitions.
2. **Data-driven + regex-parseable.** Two script constants carry the model so the drift guard can read them:
   - `const N = { <state_id>:{...}, ... };` — one node per line, keyed by the **verbatim FSM state id**.
   - `const E = [ {from:'<id>',to:'<id>', ...}, ... ];` — one edge per object, `from` before `to`.
3. **Show every state**, and every transition **except** the two uniform seams that may be collapsed into a documented note: `* → error` (abort, from every non-final state) and `* → unknown` (escalation, from every agent state). Everything else — pipeline, gates, loops, `unknown → awaiting_clarification`, and the `awaiting_clarification` resume targets — MUST be drawn.
4. **Self-contained.** No external JS/CSS/network; inline `<style>` + `<script>` only.

Start from the retained research diagram at `.pi/skills/research/resources/flow.html`, then replace the header, legend, `N`, `E`, and footer while preserving the self-contained rendering pattern.

## Enforcement (validation scripts)

- **Drift guard — `apps/orchestration/tests/test_flow_diagrams.py`** parses each diagram's `N`/`E` and cross-checks it against the live FSM. Adding / removing / rewiring a state without updating `flow.html` (or vice-versa) fails CI. It asserts: every FSM state has a node, no phantom nodes, every non-collapsible edge is drawn, no invented edges, the `abort`/`escalation` omissions are documented, and the legacy `.mmd` is gone. **Register a newly-converted skill by adding it to `CASES`.**
- **Structure checker — `scripts/system/checks/check_skill_structure.py`** requires a flow diagram to exist and warns when a skill still ships the legacy `.mmd`.

## Constraints

- **Diagrams must match implementation.** Stale diagrams are worse than no diagrams — the drift guard makes a mismatch a hard failure.
- **Update the diagram in the same PR** that changes the playbook's machine.

## Verification

- [ ] `resources/flow.html` exists; the legacy `resources/flow.mmd` is removed
- [ ] `N` keys are the verbatim FSM state ids; `E` mirrors the machine's transitions
- [ ] The skill is registered in `test_flow_diagrams.py::CASES` and the suite passes
- [ ] `abort → error` and `escalation → unknown` omissions are documented in the diagram

## Files

| File                                                        | Purpose                             |
| ----------------------------------------------------------- | ----------------------------------- |
| `.pi/skills/<skill>/resources/flow.html`                    | The skill's flow diagram (standard) |
| `apps/orchestration/tests/test_flow_diagrams.py`            | Drift guard (HTML ↔ FSM)            |
| `apps/orchestration/src/orchestration/playbooks/<skill>.py` | The playbook (`<Skill>Machine`)     |
| `docs/agents/skills/orchestration.md`                       | Engine-backed skill protocol        |
