# Skill Design Methodology — Outcome-driven engine playbooks

## What

The design process for creating a new skill: decide whether a skill is warranted, derive its states, place its gates, split its knowledge between prompts and resources, and ship it compliant. Requirements belong to [Skill Standard](skill-standard.md), manifest syntax to [SKILL.md Format](skill-md-format.md), and evidence to [Testing](testing.md). The [Quick Reference](quick-reference.md) is optional navigation.

## Why

The specs answer "what must a skill contain" but not "how do I know what the states, gates, contracts, and prompts should BE." Skills designed ad hoc drift toward two failure modes: workflows invented on paper that don't survive contact with real material, and phase orderings that nobody can justify when they need changing.

## Rules

### 1. Establish the need and evidence for a workflow

Use a skill when durable state, gates, repair, fan-out, or resume earns its overhead—even with one
worker. Ground the design in requirements, observed work, source contracts, prototypes, or tests.
A manual end-to-end run can reveal failure modes, but is not a prerequisite or a state-machine
specification: do not freeze incidental steps or mistakes into permanent phases.

### 2. Every phase-ordering rule must name the failure mode it prevents

For each "X before Y" in the flow, write down the concrete defect that ordering prevents — supported by requirements or observed evidence. Record the table in the skill's `README.md`:

| Order rule                                  | Failure mode it prevents                           |
| ------------------------------------------- | -------------------------------------------------- |
| Global conventions decided before authoring | Convention forks across output files               |
| Required human gate before consequence span | Acting externally or irreversibly without approval |
| Fixes always re-enter verification          | A fix to one file breaking its linked partner      |

A phase that prevents no nameable failure has not earned its place — cut it.

### 3. Front-load global decisions; gate only when consequences justify it; then do not re-decide

Resolve shared decisions before dependent work consumes them; use one canonical record for conventions, registries, names, or output layout when consistency matters. Independent decisions need not share one early state. Add gates only for justified consequences. Downstream agents use the selected decision rather than silently redefining it; a changed decision invalidates dependent evidence.

### 4. Place required HITL gates at the reversibility cliff

When a planned human-in-the-loop (HITL) gate is required, place it immediately before an expensive, external, or hard-to-reverse span. Present the decision compactly with approve / refine / deny; refine loops back to the deciding state with the user's note, and deny terminates safely. Do not add a human gate merely because a workflow has multiple phases. The seven ordinary generic-child peers currently declare no additional planned approval gate; knowledge-base publication paths use host-mediated review/approval states. Unplanned blocking ambiguity uses the phase-declared escalation seam (for example, `needs_clarification` / UNCERTAIN where permitted). See [L4](loops.md#l4-human-in-the-loop-gates).

### 5. Choose loop shapes from the work's structure and the registered TypeScript contract

- **Per-unit iteration** (N lessons, N files, N findings) is optional. When the failure mode warrants it, model it with explicit registered states/transitions and durable typed `RunContext`/playbook data plus selected artifact refs, so crash-resume continues from checkpointed state. Use only the current TypeScript state, `RunContext`, and registration APIs.
- **Repair** is driven by typed evaluation feedback and the registration contract's `repair_routing` table. The engine resolves exactly one route, records repair use and enforces actual operator-supplied limits (including reserved attempts) when present, applies playbook bookkeeping without allowing it to mutate engine-owned control fields, and follows the registered repair or exhaustion target.
- A repair must return to an evidence-producing/review state before completion; budget exhaustion completes honestly rather than fabricating success. Playbook-specific stall checks may terminate repeated no-progress feedback early. See `loops.md` §L3.

### 6. Choose authorship, verification, and critique order by failure mode

Keep evidence-grounded verification separate from subjective quality critique when both are required, and never let subjective approval substitute for objective checks. Order them according to the defect each phase prevents rather than a universal role sequence. The current catalog intentionally varies: Annie analyzes, Carren authors, then Vera verifies (`assess`); Annie/Echo/Demetri produce a decision, then Vera verifies before Carren critiques (`decide`); Rhea produces a specification from Piper's frame and optional Echo evidence, then Vera verifies before Carren critiques (`define`); Annie/Ida/Demetri produce a diagnosis with Vera as its sole review stage (`diagnose`); Piper/Echo produce a strategy, then Vera verifies before Carren critiques (`plan`); Ida/Demetri/Skribble produce an artifact, then Carren critiques before Vera verifies (`produce`); Synthia's research synthesis is validated by Vera before optional Carren report critique (`research`, with a separate optional plan critique earlier); and after Synthia composes knowledge-base content, Carren semantic lint precedes Vera support verification and consequence-conditioned human review. Verifiers demand evidence artifacts, not assertions (`loops.md` §Verifier Design).

### 7. Split knowledge into three layers by volatility

| Layer                               | Holds                                                                                                             | Lifetime                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `resources/*.md`                    | The durable domain spec — the distilled, generalized "how this domain is done well" (checklists, canons, layouts) | Survives skill redesigns; reusable outside the skill |
| `assets/prompts/<agent>-<state>.md` | Per-state role guidance: mission, exact artifact handoff, non-negotiables, complete output, SUMMARY contract      | Changes when the workflow changes                    |
| Task builders (playbook)            | Run-specific context: exact input slots/refs, paths, unit index, prior-round violations                           | Per invocation                                       |

Prompts stay thin and reference resources; resources never contain run-specific detail. When one agent serves multiple states with different jobs, use one `<agent>-<state>.md` file per cognitive phase, not one bloated prompt. The active registry binding supplies `guidance.skill_root`; the orchestration ingress resolves the matching role/state guidance for each directive and passes it to the worker invocation.

### 8. Let registered closed schemas own SUMMARY

Each active phase schema owns its required, optional, and forbidden keys, literal values, framing,
and escalation behavior. Keep routing data separate from product content, but do not infer that
informational or confidence fields are optional. For example, Plan's closed
`StrategyRoutingSummaryV1` requires `confidence` and `complete: true` and rejects extra keys.
Add `needs_clarification` or `clarifying_questions` only where the phase schema permits them;
use its declared escalation seam rather than appending a generic trio. Preserve the confidence
wire vocabulary CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN where used. Violation lists must be
actionable strings (`"<where>: <what> — <expected vs found>"`).

### 9. Derive parallelism from independence, not enthusiasm

Use `invoke_agents_parallel` with stable branch IDs where branches have no unresolved ordering dependency. Cross-unit consistency requires a shared canonical decision and reconciliation before dependent acceptance; it does not by itself require sequential authoring. Bound fan-out through the registered contract and preserve accepted siblings on recovery.

### 10. Preserve reusable learning deliberately

After the skill ships, keep durable design rationale in the requested project documentation. The unmarked primary runtime may curate a reusable memory or governed KG relationship only when future retrieval will plausibly use it. Do not create per-run worker memories, routine graph links, or active workflow rooms.

## Design dependencies

Choose an authoring order that resolves the actual dependencies:

- Establish why orchestration is warranted and record state/order → failure-mode rationale in README.
- Resolve shared decisions before their consumers; place required approval before consequences.
- Assign agents by capability. The roster below is generated from catalog frontmatter:
  <!-- BEGIN GENERATED: role_semantics -->
  (`annie` analyzes, `carren` critiques, `echo` explores, `synthia` synthesizes, `vera` verifies, `demetri` decides, `ida` ideates, `piper` plans, `rhea` specifies, `skribble` generates, `tabitha` taskifies)
   <!-- END GENERATED -->
- Co-design closed phase contracts, registered repair/budget routes, playbook, resources, and prompts.
  Use [Flow Diagrams](flow-diagrams.md) when producing the required `resources/flow.html` from the
  safe template. The descriptor is topology authority; diagram-first is optional, final drift and
  viewport checks are required.
- Implement the [standard](skill-standard.md), then produce the applicable
  [testing evidence](testing.md), including every declared branch/gate, exhaustion, escalation,
  stall behavior and recovery ref. A CLI smoke is useful for changed ingress/lifecycle behavior,
  not a mandatory live-model invocation for every documentation or design change.
- Record durable rationale and only curate reusable learning when Rule 10's value condition holds.

## Constraints

- **Evidence-backed design.** Do not add phases or topology without a requirement, dependency, or supported failure mode.
- **No unjustified phases.** Every state and every ordering rule carries a named failure mode.
- **No downstream re-deciding** of established global decisions.
- **No repair path that skips renewed evidence/review.**
- **Honest exhaustion everywhere** — budget ends follow registered honest successors, including
  `incomplete/met:false`, never fabricated passes.

## Verification

- [ ] The skill's README contains the order-rule → failure-mode table
- [ ] Shared decisions precede dependent work; planned gates are consequence-justified and sit at the reversibility cliff
- [ ] Repair edges re-enter evidence/review; exhaustion paths report unmet completion honestly
- [ ] Authorship, verification, and critique are separate where needed and ordered by a named failure mode
- [ ] Prompts are thin and reference `resources/`; run-specific detail lives only in task builders
- [ ] Descriptor and `flow.html` match; required structural and visual checks have evidence

## Files

| File                                    | Purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| `docs/agents/skills/quick-reference.md` | The build checklist this methodology feeds     |
| `docs/agents/skills/skill-standard.md`  | Structure and compliance specification         |
| `docs/agents/skills/loops.md`           | Loop taxonomy, gates, verifier design          |
| `docs/agents/skills/testing.md`         | Playbook test requirements                     |
| `apps/orchestration/src/playbooks/`     | Registered TypeScript playbook implementations |
| `.pi/skills/`                           | Current skill catalog documentation            |
