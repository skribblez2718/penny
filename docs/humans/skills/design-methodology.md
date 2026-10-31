# How Skills Get Designed

## What It Is

The design methodology is the thinking that happens _before_ a skill is built: deciding whether a skill is warranted at all, what its phases should be, where the human approval points belong, and how the domain knowledge gets packaged. The [Skill Standard](skill-standard.md) defines what a finished skill must contain; this page explains how a good one comes to exist.

## The Core Idea: Justify the Workflow

A skill earns its overhead through durable state, gates, policy-led repair, fan-out, or recovery—even
with one worker. Ground its design in requirements and evidence from existing work, source
contracts, prototypes, or tests. A manual end-to-end run can reveal defects, but is optional;
its incidental steps are not automatically permanent phases.

For example, a research workflow should add a separate grounding phase only when observed report defects show that synthesis alone does not reliably keep material claims tied to captured sources. The phase earns its place from that evidence, not from a generic preference for more steps.

## Every Phase Must Earn Its Place

For every "do X before Y" rule in a skill, the designer writes down the concrete failure that ordering prevents. If no failure can be named, the phase is cut. This keeps skills lean and makes them maintainable: when someone later asks "can we skip this step?", the answer is written down next to the step.

A few examples of what this looks like in practice:

| Design choice                                                                                   | The failure it prevents                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Resolve shared decisions (conventions, naming, registries) before dependent work                | Different output files quietly contradicting each other       |
| When consequences require human approval, put its gate immediately before the irreversible span | Performing expensive or external work without needed approval |
| Route every fix back through verification                                                       | A fix to one file silently breaking the file paired with it   |
| End exhausted retry loops with an honest "not met" report                                       | The system declaring success it didn't achieve                |

## Where the Human Fits

Human gates are consequence-conditioned, not a universal phase count. When a planned gate is required, place it immediately before expensive, external, or hard-to-reverse work and offer approve / refine / deny. The seven ordinary generic-child peers currently add no planned approval gate; knowledge-base publication paths use host-mediated review and approval where their operation requires it. Blocking ambiguity still uses the unplanned escalation seam rather than guessing.

## How Review Order Is Chosen

Separate evidence verification from subjective critique when both are needed, but order authorship and review by the failure each phase prevents. The current catalog deliberately varies: `assess` moves from Annie analysis to Carren authoring to Vera verification; `decide` verifies the produced decision with Vera before Carren critiques it; `diagnose` uses Vera as its sole review stage after diagnosis production; `plan` verifies the produced strategy with Vera before Carren critiques it; `produce` sends the produced artifact to Carren before Vera; `research` validates Synthia's synthesis with Vera before optional Carren report critique (and may critique its plan earlier); and knowledge-base work moves from Synthia composition to Carren lint to Vera support verification and consequence-conditioned human review. There is no universal “verifier before critic” sequence.

## Where the Knowledge Lives

A skill's knowledge is split by how long it stays true:

- **Resources** hold the durable expertise — the distilled "how this domain is done well." These survive redesigns and are useful even outside the skill.
- **Prompts** hold each worker's domain guidance and exact artifact handoff/output contract for one phase — thin, and pointing at the resources.
- **The playbook** holds compact run-specific routing facts and selected canonical refs, never stage payload bytes.

This separation keeps workflow handoff exact. If a lesson is stable and reusable, it is folded into project resources or explicitly curated by the primary runtime; routine runs do not create worker memories or KG links.

## The Shape of a Good Design

1. Confirm the job needs durable workflow state, policy-led repair, resume, or consequence-conditioned gates; otherwise use direct work or a single agent.
2. Use requirements and evidence to justify phases; write the failure-mode table. A manual run is one option.
3. Resolve shared decisions before their consumers and add only consequence-justified approval gates.
4. Match agents by capability and review order by failure mode. Co-design contracts, playbook, and flow mirror in any useful order; final topology and visual checks remain required.
5. Implement registered TypeScript states and repair routes with checkpointed `RunContext` state, then test every path—including exact handoff, continuation, exhaustion, and unhappy outcomes—and curate only durable learnings that pass a value gate.

## Learn More

- [Skills Overview](overview.md): What skills are and when to use them.
- [Skill Standard](skill-standard.md): The structural requirements a finished skill must meet.
- [Loops](loops.md): The loop patterns skills are built from.
- Agent-facing reference: [Skill Design Methodology](../../agents/skills/design-methodology.md)
