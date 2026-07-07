# State Machine Reference — FSMs on the orchestration engine

## What

Agent reference for the finite-state machine at the core of every Penny skill. A skill's FSM is a plain `statemachine.StateMachine` (states + transition events) that lives **inside a `BasePlaybook` subclass** in the installed `orchestration` package — `apps/orchestration/src/orchestration/playbooks/<skill>.py`. The engine drives the machine; the machine only declares phases and legal transitions. Use this document when declaring states, transition events, routing, and error/terminal states for a skill.

## Why

Skills have non-trivial workflows (red-green-refactor, gather-analyze-synthesize, frame-explore-evaluate-decide). An explicit FSM replaces nested conditionals with named phases and valid transitions, which makes routing, escalation, crash-resume, and testing straightforward.

**There is ONE orchestration engine.** Every skill shares `apps/orchestration/` (an installed package). A skill does NOT ship its own runtime, its own persistence, or a generated state machine. It ships:

- a `StateMachine` subclass (the states/events),
- a `BasePlaybook` subclass (the behavior: primitives per state, routing, gates, done predicate),
- registration in `playbooks/__init__.py`,
- a ~5-line `scripts/orchestrate.py` delegate,
- an engine `SKILL.md` (`metadata.penny.engine: orchestration`) and `assets/prompts/`.

The reference implementations to read are `orchestration/playbooks/code.py` and `plan.py`.

## Rules

1. **The FSM is a `statemachine.StateMachine`.** `from statemachine import State, StateMachine`. Declare it as `machine_cls` on the playbook.
2. **States are custom-named for the domain.** Use meaningful phase names (`exploring`, `analyzing`, `planning`, `implementing`, `verifying`, `learning`), not generic `idle/working/done`.
3. **Include the engine's control states.** A migrated machine has `unknown` + `awaiting_clarification` (escalation seam) and terminal `complete` (final) and `error` (final).
4. **The machine holds NO business data.** Per-run data lives on the `RunContext` (`ctx.extras`, `ctx.iteration`, `ctx.success_criteria`, …). The machine tracks only the current state.
5. **Do not persist manually.** State is saved by the engine to a durable `run_id`-keyed SQLite checkpointer after every step. There is NO `/tmp` session file, NO `--state` argv, NO `extract_state`/`restore_state`.
6. **Routing lives in `route_after`, not in guards.** The playbook inspects the agent SUMMARY and calls `self.sm.send("<event>")`. Guards on the machine, if any, must be side-effect free.
7. **Every loop is bounded.** Retry loops honor `ctx.max_iterations`; exhaustion routes to a terminal state and reports the outcome HONESTLY (`met=False`), never a fabricated success.
8. **Work happens in agents, not callbacks.** The machine does not run tools, write files, or call agents. The engine dispatches the agent named by the state's `PrimitiveSpec`.

### What the FSM should and should NOT do

| Should | Should NOT |
| --- | --- |
| Declare named phases and legal transition events | Execute code, run tests, or write files |
| Provide the escalation seam (`unknown` → `awaiting_clarification`) and terminal `complete`/`error` | Store business data or cross-run knowledge |
| Let `route_after` pick the next event from a SUMMARY | Persist itself to `/tmp` or an argv blob |
| Model bounded retry loops with an exhaustion edge | Fabricate success when a loop runs out of budget |

## Procedure/Constraints

### The machine (states + events)

```python
from statemachine import State, StateMachine

class CodeMachine(StateMachine):
    intake = State(initial=True)
    exploring = State()
    analyzing = State()
    planning = State()
    implementing = State()
    verifying = State()
    learning = State()
    unknown = State()                 # escalation staging
    awaiting_clarification = State()  # paused for the user
    complete = State(final=True)
    error = State(final=True)

    start_explore = intake.to(exploring)
    explore_done = exploring.to(analyzing)
    analyze_done = analyzing.to(planning)
    plan_done = planning.to(implementing)
    implement_done = implementing.to(verifying)
    verify_done = verifying.to(learning)
    learn_retry = learning.to(implementing)     # gap && within budget
    learn_final = verifying.to(complete)        # oracle passed
    learn_exhausted = learning.to(complete)     # budget spent; met=False

    # escalation + abort seams
    to_unknown = exploring.to(unknown) | implementing.to(unknown) | learning.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(exploring)
    abort = exploring.to(error) | implementing.to(error) | verifying.to(error)
```

Use `final=True` for terminal states. `plan_denied = plan_gate.to(error)` is a legitimate terminal edge — deny/exhaustion end in `error`/`complete`, they do not loop silently.

### The playbook binds behavior to states

The `BasePlaybook` subclass names the machine and maps each working state to a `PrimitiveSpec` (which agent + which SUMMARY contract the engine validates):

```python
class CodePlaybook(BasePlaybook):
    NAME = "code"
    machine_cls = CodeMachine
    STEP_CAP = 60
    PRIMITIVE_BY_STATE = {
        "exploring": CODE_EXPLORE,      # agent "echo",   {findings_count, confidence}
        "analyzing": CODE_ANALYZE,      # agent "annie"
        "planning": CODE_PLAN,          # agent "piper"
        "implementing": CODE_IMPLEMENT, # agent "skribble"
        "verifying": CODE_VERIFY,       # oracle-backed: evidence must be non-empty
        "learning": CODE_LEARN,         # agent "carren"
    }
    GATE_STATES = frozenset({"criteria_gate", "plan_gate"})
    ESCALATABLE_STATES = frozenset({"exploring", "implementing", "verifying", "learning"})
```

Optional capabilities are declared the same way:

| Capability | Declared by | Also implement |
| --- | --- | --- |
| Planned HITL gate | `GATE_STATES` | `gate_questions`, `route_user` |
| Parallel fan-out | `PARALLEL_BY_STATE = {"exploring": ParallelSpec(...)}` | — |
| Deterministic in-process state (no agent) | `TOOL_STATES` | `run_tool_state` (must be safe to re-run) |
| Confidence/stall escalation | `ESCALATABLE_STATES` | `progress_check` (optional) |

### Routing on the agent SUMMARY

The engine validates the agent's SUMMARY against the state's contract, then calls `route_after`. The playbook reads the summary and fires the next event:

```python
def route_after(self, state, ctx, summary):
    if state == "verifying":
        passed = summary["passed"]
        ctx.verify_verdict = "PASS" if passed else "FAIL"
        self.sm.send("verify_done" if not passed else "final_verify_pass")
    elif state == "learning":
        if not summary["gap"]:
            self.sm.send("learn_final")
        elif ctx.iteration + 1 < ctx.max_iterations:
            ctx.iteration += 1
            self.sm.send("learn_retry")
        else:
            self.sm.send("learn_exhausted")   # honest exhaustion, met=False
```

`done_predicate(ctx)` decides whether `complete` means success. It reads `ctx`/`ctx.extras`, never the machine:

```python
def done_predicate(self, ctx):
    code = ctx.extras.get("code", {})
    return code.get("learn_gap") is False and code.get("verify_passed", False)
```

### Escalation (no state blob)

When an agent emits `confidence=UNCERTAIN` (or `progress_check` returns a reason) in an `ESCALATABLE_STATES` state, the engine drives the machine to `unknown` → `awaiting_clarification` and pauses the run. The user's answer resumes it via `step --agent user` — routed back into the flow by the machine's `clarify` edge. No `orchestrator_state`, no `previous_state` payload.

### Persistence & crash-resume

State is durable in the checkpointer keyed by `run_id`:

- After each step the engine calls `checkpointer.save(run_id, session_id, playbook, current_state_id, ...)`.
- A fresh subprocess rehydrates by `run_id` — there is no argv state, no replay file.
- A run interrupted mid-step is recovered automatically (`recover_pending` / the engine `recover` CLI) by re-issuing that step. States must therefore be **idempotent to re-enter**; `TOOL_STATES` handlers especially must be safe to re-run.

There is NO `extract_state()`/`restore_state()`, NO `/tmp/<skill>-<session_id>.json`, NO `/tmp/skill-checkpoints`. If you see those in older code or docs, they are pre-engine legacy and removed.

### Bounded loops & honest exhaustion

Every retry edge (`learn_retry`, refinement loops, gather loops) is capped by `ctx.max_iterations` (default 3, from `constraints.max_iterations`) and the global `STEP_CAP`. When the cap is hit, route to a terminal state and let `done_predicate` report `met=False`. A `VERIFY` state with a real oracle must require evidence — `CODE_VERIFY`'s contract marks `evidence` as required-and-non-empty so a bare "passed" assertion is rejected.

## Verification

- [ ] The FSM is a `statemachine.StateMachine` with domain-named states, declared as the playbook's `machine_cls`.
- [ ] The machine carries no business data; per-run data is on `RunContext`.
- [ ] Escalation seam (`unknown` → `awaiting_clarification`) and terminal `complete`/`error` states exist.
- [ ] Routing is in `route_after` (reads SUMMARY, calls `self.sm.send`); guards, if any, are pure.
- [ ] No manual persistence: no `/tmp` file, no `--state`, no `extract_state`/`restore_state`.
- [ ] Every retry loop is capped by `ctx.max_iterations` and ends in a terminal state that reports `met` honestly.
- [ ] Oracle-backed VERIFY states require real evidence in their SUMMARY contract.

## Files

| File | Purpose |
| --- | --- |
| `docs/agents/state-management/state-machine-reference.md` | This reference |
| `docs/agents/state-management/orchestration-integration.md` | How the engine drives the machine (start/step/gates/escalation) |
| `docs/agents/state-management/skill-patterns.md` | Reusable playbook workflow shapes |
| `apps/orchestration/src/orchestration/playbooks/code.py` | Worked reference playbook |
| `apps/orchestration/src/orchestration/playbooks/plan.py` | Worked reference playbook (parallel fan-out) |
</content>
</invoke>
