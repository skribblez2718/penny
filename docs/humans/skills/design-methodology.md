# How Skills Get Designed

## What It Is

The design methodology is the thinking that happens *before* a skill is built: deciding whether a skill is warranted at all, what its phases should be, where the human approval points belong, and how the domain knowledge gets packaged. The [Skill Standard](skill-standard.md) defines what a finished skill must contain; this page explains how a good one comes to exist.

## The Core Idea: Extract, Don't Invent

A Penny skill is a **recording of a workflow that already worked**, not a workflow imagined on a whiteboard. The process starts by doing the job manually — end to end, on real material — and only then encoding it. The phases of the skill are the phases the manual session actually went through, including the mistakes and what fixed them.

The `learn` skill is the reference example: a full course of study materials was built and repaired by hand first. Every phase of the resulting skill exists because skipping it during the manual run produced a real, observed defect.

## Every Phase Must Earn Its Place

For every "do X before Y" rule in a skill, the designer writes down the concrete failure that ordering prevents. If no failure can be named, the phase is cut. This keeps skills lean and makes them maintainable: when someone later asks "can we skip this step?", the answer is written down next to the step.

A few examples of what this looks like in practice:

| Design choice | The failure it prevents |
| ------------- | ----------------------- |
| Make all global decisions (conventions, naming, registries) in one early phase, then lock them | Different output files quietly contradicting each other |
| Put the human approval gate right before the most expensive phase | Mass-producing work to a design the user never wanted |
| Route every fix back through verification | A fix to one file silently breaking the file paired with it |
| End exhausted retry loops with an honest "not met" report | The system declaring success it didn't achieve |

## Where the Human Fits

Skills pause for the human at exactly one *planned* point: just before the work becomes expensive or hard to reverse. At that gate the skill presents the plan compactly and the human can approve it, refine it with a note, or deny it outright. Everything else relies on the *unplanned* escape hatch — any agent that becomes genuinely uncertain pauses the whole run and asks, rather than guessing.

## Where the Knowledge Lives

A skill's knowledge is split by how long it stays true:

- **Resources** hold the durable expertise — the distilled "how this domain is done well." These survive redesigns and are useful even outside the skill.
- **Prompts** hold each agent's role instructions for one phase — thin, and pointing at the resources.
- **The playbook** holds only run-specific context (which session, which file, which round).

This separation is why a skill improves over time: lessons learned in one run are folded into the resources, and every future run inherits them.

## The Shape of a Good Design

1. Confirm the job is really multi-agent and repeatable (otherwise use a single agent).
2. Do the work manually; extract the phases; write the failure-mode table.
3. Pull every global decision to the front and place the approval gate after it.
4. Match agents to phases by their specialty, and draw the flow diagram before writing any code.
5. Build, test every path (including the unhappy ones), validate, and record what was learned.

## Learn More

- [Skills Overview](overview.md): What skills are and when to use them.
- [Skill Standard](skill-standard.md): The structural requirements a finished skill must meet.
- [Loops](loops.md): The loop patterns skills are built from.
- Agent-facing reference: [Skill Design Methodology](../../agents/skills/design-methodology.md)
