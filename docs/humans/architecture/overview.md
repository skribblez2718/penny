# Penny's Architecture: A Human Overview

## What It Is

Penny is not a single prompt or a single model call. She is a layered reasoning system built on top of the Pi agent runtime. At a high level, her architecture does three things: it composes the right instructions for the current moment, it delegates complex work to specialized subagents, and it remembers enough across sessions to stop repeating the same mistakes.

This document explains the big pieces and why they are arranged the way they are.

## The Five Prompt Layers

Every interaction with Penny is shaped by five layers of instructions. They are separated because a one-size-fits-all prompt would either be too generic to be useful or too specific to fit in the context window.

| Layer | Purpose | What It Contains | How Often It Changes |
| --- | --- | --- | --- |
| **Cognitive Frame** | How to think | Universal reasoning rules: never fabricate, verify before stating, prefer reversible decisions | Rarely |
| **Role Definition** | Who is acting | Agent identity: Penny, Echo, Carren, Piper, Tabitha and their constraints | Per agent |
| **Domain Guidance** | How to think about this domain | Skill-specific guidance for planning, research, coding, documentation, etc. | Per skill |
| **Project Index** | Where things are | `AGENTS.md` files that map the project tree and point to relevant docs | Per project |
| **Invocation Context** | What to do now | The user's task, the current conversation, and runtime state | Every turn |

In a normal conversation only three layers are active: Cognitive Frame, Role Definition, and Invocation Context. When Penny invokes a skill, all five layers are assembled so the skill gets domain guidance and project navigation too.

## Why the Layers Are Separated

The separation is not decorative. It solves three real problems:

1. **Context budget.** A monolithic prompt with everything in it would burn most of the model's attention on rules that do not matter for the current task. Layering lets Penny load only what is needed.
2. **Security boundaries.** Universal rules live in system-role content. Domain guidance is injected in the right place so user content cannot override system instructions. Project-specific navigation stays in user-role reference material.
3. **Maintainability.** When a skill changes, only its Domain Guidance changes. When a project changes, only its `AGENTS.md` files change. The Cognitive Frame, which every turn depends on, stays stable.

## Three Big Architectural Choices

### State machine skills

Complex tasks — design a feature, refactor a module, run research — have phases. Without an explicit state machine these workflows collapse into nested conditionals that are hard to inspect and harder to resume.

Penny skills declare states, transitions, guards, and callbacks as a state machine. This makes the current phase always visible, lets failures route to recovery states, and makes long skills resumable. Every workflow skill delegates that machinery to a shared **orchestration engine** — each skill is a `BasePlaybook` subclass with a durable, `run_id`-keyed checkpointer that auto-resumes an interrupted run, with no exceptions.

### Mempalace memory

Penny cannot remember anything just by being told it in a conversation. The model's context window resets. Important facts must be written to a persistent store and retrieved when relevant.

Mempalace is that store. It holds structured drawers, a knowledge graph for relationships, and semantic search for retrieval. Skills write their results there, agents read context from there, and the outcome ledger records predictions and results there.

### Tiered memory

Not everything deserves the same attention. `SYSTEM.md` is always loaded because it defines identity. The current session stays in context because it is what Penny is doing right now. Recent outcomes are searched before each turn because they might prevent a repeated mistake. Reference material is fetched only when needed. Old sessions are archived and searchable but never injected.

This five-tier design is described in detail in the [tiered memory](tiered-memory.md) document.

## What This Means in Practice

- Penny acts differently in normal chat than when running a skill, because the prompt assembly is different.
- Penny can hand off work to agents without losing her own context, because agents write full results to mempalace and return only a summary.
- Penny can learn from mistakes, because the outcome ledger captures what was predicted versus what happened.
- Penny can remember things across sessions, but only if they are stored in the right tier.

## Related Documents

- [Project Standards](project-standards.md) — the canonical implementations that keep the architecture consistent
- [Tiered Memory](tiered-memory.md) — how the five memory tiers work
- [Skill Tool Modes](skill-tool-modes.md) — how skills are invoked
- [Outcome Ledger](outcome-ledger.md) — how Penny learns from results
- [Prompt Architecture Overview](../prompts/overview.md) — deeper dive into the five prompt layers
