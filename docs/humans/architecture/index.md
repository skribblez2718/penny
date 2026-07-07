# Architecture Documentation

This section explains how Penny is designed. It focuses on what each part of the system is, why it works the way it does, and what those choices mean for people who use or contribute to Penny. For operational instructions aimed at agents, see `docs/agents/architecture/`.

| Document | Description |
| --- | --- |
| [Overview](overview.md) | The big picture: prompt layers, state machines, mempalace, and tiered memory |
| [Project Standards](project-standards.md) | Why Penny has canonical implementations and how the ten-check task completion protocol works |
| [Outcome Ledger](outcome-ledger.md) | How prediction-and-result tracking closes the learning loop |
| [Tiered Memory](tiered-memory.md) | How the five memory tiers decide what Penny remembers, recalls, and archives |
| [Skill Tool Modes](skill-tool-modes.md) | How single, parallel, chain, and resume modes match tasks to execution patterns |
