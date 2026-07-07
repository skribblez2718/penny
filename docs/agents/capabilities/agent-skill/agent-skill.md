# Agent Skill — Generate validated Penny agent definitions

## What

A structured skill that produces a Penny agent definition file (`.pi/agents/<name>.md`) from a goal description. It explores existing patterns, designs the agent, critiques it, scaffolds the file, and verifies it against the Penny agent standard.

The skill runs on the shared orchestration engine (`apps/orchestration/`). Its behavior is defined by `AgentPlaybook` (a `BasePlaybook` subclass); `.pi/skills/agent/scripts/orchestrate.py` is a ~5-line delegate that hands control to `orchestration.cli.main(default_playbook="agent")`.

## Why

Agent definitions encode constraints, tool usage, and output contracts. Generating them through a validated workflow keeps new agents consistent with the rest of the system.

## Rules

1. **Use for new agents only.** Do not use the agent skill to modify an existing agent — edit the file directly.
2. **Do not use for one-line edits.** Trivial changes should be executed directly.
3. **Penny is a router.** Agents communicate via mempalace (`skills/agent-<session_id>`); Penny only sees structured SUMMARY payloads.
4. **Approval is required before installation.** The skill returns the generated definition and verification result; Penny must ask for user approval before writing `.pi/agents/<name>.md` and updating indexes.
5. **`create_skill_scaffold` is always rejected.** The agent skill creates agents, not skills.
6. **UNCERTAIN confidence pauses the run.** Any agent returning `confidence: UNCERTAIN` (or `progress_check` flagging needs-clarification / stall) drives the machine to `unknown → awaiting_clarification` and pauses for user direction.

## Procedure

### Invocation

```typescript
skill({
  skill_name: "agent",
  goal: "Generate a research agent for climate data analysis",
  project_root: "/path/to/project",
})
```

Optional constraints:

| Constraint | Meaning |
|------------|---------|
| `agent_name` | Optional hint only. The authoritative name and file path come from skribble's scaffold SUMMARY (`agent_file_path` / `files_created`). |
| `create_skill_scaffold` | Always rejected |

### State machine

The engine drives `AgentMachine` (states and transitions defined in `apps/orchestration/src/orchestration/playbooks/agent.py`):

```
intake → exploring → designing → critiquing → scaffolding → verifying → complete
              ↑___________|            |↖________________________|
       critique_retry_explore /        |  verify_retry (re-scaffold on oracle fail)
       critique_retry_design           critique_pass
```

| State | Agent | Purpose | Output to mempalace |
|-------|-------|---------|----------------------|
| `intake` | — | Validate goal (non-empty), seed `agent` extras, `start_explore` | — |
| `exploring` | `echo` | Gather evidence about existing agent definitions, the schema, and conventions | Findings, files, unknowns (header `<session_id> Explore`) |
| `designing` | `piper` | Design the agent definition from explore findings (10-item checklist) | Design spec (header `<session_id> Design`) |
| `critiquing` | `carren` | Validate the design against the agent standard; verdict `APPROVE` / `NEEDS_REVISION` / `BLOCKED` | Verdict, issues (header `<session_id> Critique`) |
| `scaffolding` | `skribble` | Generate `.pi/agents/<name>.md` from the design spec | Scaffold SUMMARY (`files_created`, `agent_file_path`, …) |
| `verifying` | `vera` | Validate the generated file against the standard; attach per-check evidence | Verification report + `evidence` (header `<session_id> Verify`) |
| `complete` | — | Terminal success (or honest exhaustion, `met=False`) | — |
| `unknown` / `awaiting_clarification` | — | Escalation: pause the run and surface clarifying questions | Escalation questions |
| `error` | — | Terminal failure | Errors |

There is **no** `revising` state. The critique revision decision is made in `route_after`, not by a dedicated state (the legacy `revising` state never fired its transitions and is gone).

### Revision & verify loops

Decided in `route_after` and bounded by `ctx.max_iterations`:

- **Critique loop.** On a non-`APPROVE` verdict with budget remaining, one re-exploration round is allowed (`critique_retry_explore`, tracked by `explore_rounds < 1`); subsequent revisions go straight back to design (`critique_retry_design`). When the budget is spent, `critique_exhausted → complete` with `met=False` and unresolved issues reported — **no fabricated APPROVE**.
- **Verify loop.** On a failing oracle verdict with budget remaining, `verify_retry → scaffolding` re-generates the file (the failing checks are passed to skribble). When the budget is spent, `verify_exhausted → complete` with `met=False` — **no fabricated pass**.

### Escalation

`ESCALATABLE_STATES` = {exploring, designing, critiquing, scaffolding, verifying}. `progress_check` escalates when:

- an agent SUMMARY sets `needs_clarification` (questions surfaced to the user), or
- a critique keeps returning the same issues across design revisions (`is_stalled`), or
- verification keeps failing the same checks across re-scaffolds (`is_stalled`), or
- any agent emits `confidence: UNCERTAIN` (engine auto-escalates).

Escalation runs `to_unknown → escalate`, pausing the run at `awaiting_clarification`. The user's answer resumes the **same run** (keyed by `run_id`) via a `user` step; the clarification text is threaded through `ctx.clarification_text` and the machine re-enters `exploring` (`clarify`). No state blob is threaded on the wire — `previous_state` and the `agent` extras live in `ctx` and are checkpointed.

## Constraints

- Every retry loop is bounded by `ctx.max_iterations`; exhaustion is reported honestly (`complete` with `met=False`, `exhausted=True`, `unresolved_issues` populated).
- SUMMARY validation is the **engine's** job (`contracts.validate_summary_contract`). Empty or malformed summaries are rejected and the run does not advance on fabricated defaults.
- `vera`'s VERIFY is externally grounded: the `AGENT_VERIFY` contract carries an `evidence` requirement, so a verdict must ship the actual per-check validation output (parsed frontmatter, section headers found, failing lines), never a bare boolean assertion.
- Run state lives in the engine's durable SQLite checkpointer keyed by `run_id`. There is no `--state` argv and no `/tmp/agent-<session_id>.json` session file. A run interrupted mid-step is recovered automatically by the engine (`recover` CLI / `recover_pending`) and the interrupted step is re-issued.

## Verification

- [ ] Generated file passes the oracle (`yaml_valid`, `schema_valid`, `diff_applied`) with `vera` evidence attached.
- [ ] No agent returned `confidence: UNCERTAIN` (else the run paused for clarification).
- [ ] `done_predicate` holds (all three verification checks true) before `complete` counts as met.
- [ ] Final output is presented for approval before `.pi/agents/<name>.md` is written.
- [ ] `AGENTS.md` index and human/agent docs are scaffolded after approval.

## Files

| File | Purpose |
|------|---------|
| `apps/orchestration/src/orchestration/playbooks/agent.py` | `AgentPlaybook` — states, contracts, routing, escalation, result payload |
| `apps/orchestration/tests/test_agent_playbook.py` | Playbook behavior tests |
| `.pi/skills/agent/SKILL.md` | Skill definition, invocation, and post-completion procedure (`metadata.penny.engine: orchestration`) |
| `.pi/skills/agent/scripts/orchestrate.py` | ~5-line delegate to `orchestration.cli.main(default_playbook="agent")` |
| `.pi/skills/agent/assets/prompts/*.md` | Agent prompts and SUMMARY contracts (`echo.md`, `piper.md`, `carren.md`, `skribble.md`, `vera.md`) |
| `docs/humans/capabilities/agent-skill/agent-skill.md` | Human-facing overview |
