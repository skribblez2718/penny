# Skill Design Methodology — From proven workflow to engine playbook

## What

The design process for creating a new skill: decide whether a skill is warranted, derive its states, place its gates, split its knowledge between prompts and resources, and ship it compliant. The mechanics (files, formats, hooks, tests) are specified in `skill-standard.md`, `skill-md-format.md`, and `quick-reference.md`; this document covers the design decisions those specs assume you have already made.

## Why

The specs answer "what must a skill contain" but not "how do I know what the states, gates, contracts, and prompts should BE." Skills designed ad hoc drift toward two failure modes: workflows invented on paper that don't survive contact with real material, and phase orderings that nobody can justify when they need changing.

## Rules

### 1. Prove the workflow manually before encoding it

A skill is an **extraction, not an invention**. Do the work by hand (or observe it done) at least once, end to end, on real material. The session's actual work phases — including the mistakes and their fixes — are the state machine. If no proven manual workflow exists yet, that is a signal to do the work directly first, not to design a skill speculatively.

### 2. Every phase-ordering rule must name the failure mode it prevents

For each "X before Y" in the flow, write down the concrete defect that ordering prevents — ideally one actually observed in the manual run. Record the table in the skill's `README.md`:

| Order rule                                  | Failure mode it prevents                           |
| ------------------------------------------- | -------------------------------------------------- |
| Global conventions decided before authoring | Convention forks across output files               |
| Required human gate before consequence span | Acting externally or irreversibly without approval |
| Fixes always re-enter verification          | A fix to one file breaking its linked partner      |

A phase that prevents no nameable failure has not earned its place — cut it.

### 3. Front-load global decisions; gate only when consequences justify it; then do not re-decide

Anything that can drift across artifacts (conventions, registries, naming schemes, output layout) is decided in one early state and treated as binding canon downstream. Add a gate only when the task's consequences justify one. Downstream agents look decisions up rather than silently redefining them.

### 4. Place required HITL gates at the reversibility cliff

When a planned human-in-the-loop (HITL) gate is required, place it immediately before an expensive, external, or hard-to-reverse span. Present the decision compactly with approve / refine / deny; refine loops back to the deciding state with the user's note, and deny terminates safely. Do not add a human gate merely because a workflow has multiple phases. The six generic-ingress playbooks currently declare no additional planned approval gate; knowledge-base publication paths use host-mediated review/approval states. Unplanned blocking ambiguity still uses the escalation seam (`needs_clarification` / UNCERTAIN). See `loops.md` §L4.

### 5. Choose loop shapes from the work's structure and the registered TypeScript contract

- **Per-unit iteration** (N lessons, N files, N findings) is optional. When the failure mode warrants it, model it with explicit registered states/transitions and durable typed `RunContext`/playbook data plus selected artifact refs, so crash-resume continues from checkpointed state. Use only the current TypeScript state, `RunContext`, and registration APIs.
- **Repair** is driven by typed evaluation feedback and the registration contract's `repair_routing` table. The engine resolves exactly one route, charges `RunContext.iteration` against `RunContext.maxIterations` (including reserved attempts), applies playbook bookkeeping without allowing it to mutate engine-owned control fields, and follows the registered repair or exhaustion target.
- A repair must return to an evidence-producing/review state before completion; budget exhaustion completes honestly rather than fabricating success. Playbook-specific stall checks may terminate repeated no-progress feedback early. See `loops.md` §L3.

### 6. Choose authorship, verification, and critique order by failure mode

Keep evidence-grounded verification separate from subjective quality critique when both are required, and never let subjective approval substitute for objective checks. Order them according to the defect each phase prevents rather than a universal role sequence. The current catalog intentionally varies: Annie analyzes, Carren authors, then Vera verifies (`assess`); Annie/Echo/Demetri produce a decision, then Vera verifies before Carren critiques (`decide`); Annie/Ida/Demetri produce a diagnosis with Vera as its sole review stage (`diagnose`); Piper/Echo produce a strategy, then Vera verifies before Carren critiques (`plan`); Ida/Demetri/Skribble produce an artifact, then Carren critiques before Vera verifies (`produce`); Synthia's research synthesis is validated by Vera before optional Carren report critique (`research`, with a separate optional plan critique earlier); and after Synthia composes knowledge-base content, Carren semantic lint precedes Vera support verification and consequence-conditioned human review. Verifiers demand evidence artifacts, not assertions (`loops.md` §Verifier Design).

### 7. Split knowledge into three layers by volatility

| Layer                               | Holds                                                                                                             | Lifetime                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `resources/*.md`                    | The durable domain spec — the distilled, generalized "how this domain is done well" (checklists, canons, layouts) | Survives skill redesigns; reusable outside the skill |
| `assets/prompts/<agent>-<state>.md` | Per-state role guidance: mission, exact artifact handoff, non-negotiables, complete output, SUMMARY contract      | Changes when the workflow changes                    |
| Task builders (playbook)            | Run-specific context: exact input slots/refs, paths, unit index, prior-round violations                           | Per invocation                                       |

Prompts stay thin and reference resources; resources never contain run-specific detail. When one agent serves multiple states with different jobs, use one `<agent>-<state>.md` file per cognitive phase, not one bloated prompt. The active registry binding supplies `guidance.skill_root`; the orchestration ingress resolves the matching role/state guidance for each directive and passes it to the worker invocation.

### 8. Design contracts minimal-required, generous-optional

Required SUMMARY fields are only what `route_after` needs to route (a completion boolean, an index, a verdict, a violations list). Everything informational is optional. Every contract carries the escalation trio as optional fields: `needs_clarification`, `clarifying_questions`, `confidence`. Violation lists must be **actionable strings** (`"<where>: <what> — <expected vs found>"`); a violation the fixer can't act on is itself a defect.

### 9. Derive parallelism from independence, not enthusiasm

Fan out (`PARALLEL_BY_STATE`) only where branches share no ordering dependency (e.g. three ingest perspectives). Work with cross-unit consistency requirements (authoring artifacts that must agree with each other) runs sequentially through a canon, even though parallel would be faster.

### 10. Preserve reusable learning deliberately

After the skill ships, keep durable design rationale in the requested project documentation. The unmarked primary runtime may curate a reusable memory or governed KG relationship only when future retrieval will plausibly use it. Do not create per-run worker memories, routine graph links, or active workflow rooms.

## The Design Sequence

1. **Warrant check** — multi-agent, multi-step, repeatable? If it fits one agent's scope, don't build a skill (`overview.md`).
2. **Extract phases** from the proven manual workflow; write the failure-mode table (Rule 2).
3. **Mark decisions** — pull every global decision into an early design state (Rule 3); add only the consequence-conditioned gates warranted by Rule 4.
4. **Assign agents to states** by capability, never by subject matter. The roster below is generated from `.pi/agents/*.md` frontmatter — do not hand-edit it:
   <!-- BEGIN GENERATED: role_semantics -->
   (`annie` analyzes, `carren` critiques, `echo` explores, `synthia` synthesizes, `vera` verifies, `demetri` decides, `ida` ideates, `piper` plans, `skribble` generates, `tabitha` taskifies)
   <!-- END GENERATED -->
5. **Choose loop, review, and budget shapes** (Rules 5–6); start `resources/flow.html` from `scripts/tools/templates/skill-flow.html` FIRST. Reserve lanes/gutters for every branch and repair, then inspect the graph at every standard validation viewport before playbook review.
6. **Write contracts** (Rule 8), then the playbook, then register it.
7. **Distill resources, then prompts** (Rule 7).
8. **Build per `quick-reference.md`** (delegate, SKILL.md, exact artifact contracts) and test per `testing.md` — every branch, every gate route, exhaustion, stall, escalation, and recovery ref.
9. **Validate** — `check_skill_structure.py`, the full engine test suite (regressions), and a live CLI smoke test (`start` → first directive has the right action, branches, and `skillContext`).
10. **Record** (Rule 10).

## Constraints

- **No speculative skills.** If the workflow hasn't been proven manually, prove it first.
- **No unjustified phases.** Every state and every ordering rule carries a named failure mode.
- **No downstream re-deciding** of established global decisions.
- **No repair path that skips renewed evidence/review.**
- **Honest exhaustion everywhere** — budget ends are `met=False` completions, never fabricated passes.

## Verification

- [ ] The skill's README contains the order-rule → failure-mode table
- [ ] Global decisions live in one early state; any planned gate is justified by consequence and sits at the reversibility cliff
- [ ] Repair edges re-enter evidence/review; exhaustion paths report unmet completion honestly
- [ ] Authorship, verification, and critique are separate where needed and ordered by a named failure mode
- [ ] Prompts are thin and reference `resources/`; run-specific detail lives only in task builders
- [ ] `flow.html` was reviewed before the playbook was written and matches it after

## Files

| File                                    | Purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| `docs/agents/skills/quick-reference.md` | The build checklist this methodology feeds     |
| `docs/agents/skills/skill-standard.md`  | Structure and compliance specification         |
| `docs/agents/skills/loops.md`           | Loop taxonomy, gates, verifier design          |
| `docs/agents/skills/testing.md`         | Playbook test requirements                     |
| `apps/orchestration/src/playbooks/`     | Registered TypeScript playbook implementations |
| `.pi/skills/`                           | Current skill catalog documentation            |
