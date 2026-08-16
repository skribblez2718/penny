# How Skills Get Designed

## What It Is

The design methodology is the thinking that happens _before_ a skill is built: deciding whether a skill is warranted at all, what its phases should be, where the human approval points belong, and how the domain knowledge gets packaged. The [Skill Standard](skill-standard.md) defines what a finished skill must contain; this page explains how a good one comes to exist.

## The Core Idea: Extract, Don't Invent

A Penny skill is a **recording of a workflow that already worked**, not a workflow imagined on a whiteboard. The process starts by doing the job manually — end to end, on real material — and only then encoding it. The phases of the skill are the phases the manual session actually went through, including the mistakes and what fixed them.

For example, a research workflow should add a separate grounding phase only when observed report defects show that synthesis alone does not reliably keep material claims tied to captured sources. The phase earns its place from that evidence, not from a generic preference for more steps.

## Every Phase Must Earn Its Place

For every "do X before Y" rule in a skill, the designer writes down the concrete failure that ordering prevents. If no failure can be named, the phase is cut. This keeps skills lean and makes them maintainable: when someone later asks "can we skip this step?", the answer is written down next to the step.

A few examples of what this looks like in practice:

| Design choice                                                                                  | The failure it prevents                                     |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Make all global decisions (conventions, naming, registries) in one early phase, then lock them | Different output files quietly contradicting each other     |
| Put the human approval gate right before the most expensive phase                              | Mass-producing work to a design the user never wanted       |
| Route every fix back through verification                                                      | A fix to one file silently breaking the file paired with it |
| End exhausted retry loops with an honest "not met" report                                      | The system declaring success it didn't achieve              |

## Where the Human Fits

Skills pause for the human at exactly one _planned_ point: just before the work becomes expensive or hard to reverse. At that gate the skill presents the plan compactly and the human can approve it, refine it with a note, or deny it outright. Everything else relies on the _unplanned_ escape hatch — any agent that becomes genuinely uncertain pauses the whole run and asks, rather than guessing.

## Where the Knowledge Lives

A skill's knowledge is split by how long it stays true:

- **Resources** hold the durable expertise — the distilled "how this domain is done well." These survive redesigns and are useful even outside the skill.
- **Prompts** hold each worker's domain guidance and exact artifact handoff/output contract for one phase — thin, and pointing at the resources.
- **The playbook** holds compact run-specific routing facts and selected canonical refs, never stage payload bytes.

This separation keeps workflow handoff exact. If a lesson is stable and reusable, it is folded into project resources or explicitly curated by the primary runtime; routine runs do not create worker memories or KG links.

## The Shape of a Good Design

1. Confirm the job is really multi-agent and repeatable (otherwise use a single agent).
2. Do the work manually; extract the phases; write the failure-mode table.
3. Pull every global decision to the front and place the approval gate after it.
4. Match agents to phases by their specialty, and draw the flow diagram before writing any code.
5. Build and test every path—including exact handoff, memory-absent recovery, continuation, and unhappy outcomes—then curate only durable learnings that pass a value gate.

## Learn More

- [Skills Overview](overview.md): What skills are and when to use them.
- [Skill Standard](skill-standard.md): The structural requirements a finished skill must meet.
- [Loops](loops.md): The loop patterns skills are built from.
- Agent-facing reference: [Skill Design Methodology](../../agents/skills/design-methodology.md)
