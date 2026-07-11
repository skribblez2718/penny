# Penny Capabilities

This index lists the Penny capabilities that have human-readable documentation. Each entry explains what the capability does in one line. For operational rules and implementation details that agents use, see the corresponding `docs/agents/capabilities/` entry.

| Capability | What it does |
| --- | --- |
| [Agent Skill](agent-skill/agent-skill.md) | Generates validated Penny agent definitions through explore, design, critique, scaffold, and verify stages. |
| [Ambient Watchers](ambient-watchers/ambient-watchers.md) | Surfaces signals before you ask, by checking outcomes, staleness, and mempalace growth at session start. |
| [Behavioral Ratchet](behavioral-ratchet/behavioral-ratchet.md) | Replays Oracle-authored fixtures through the current system and blocks drift below the accepted baseline — the anti-drift floor under quality. |
| [Error Logging](error-logging/error-logging.md) | Streams structured, coded log entries from extensions to the observability server for querying and correlation. |
| [Graduated Autonomy](graduated-autonomy/graduated-autonomy.md) | Decides per action whether Penny can act alone (reversible + earned trust) or must ask (irreversible/destructive always ask). |
| [JSA Skill](jsa-skill/jsa-skill.md) | Runs production-grade JavaScript security analysis across 22 vulnerability classes with SAST and browser PoC verification. |
| [Judgment Calibration](judgment-calibration/judgment-calibration.md) | Freezes Oracle's PASS/FAIL judgment into a corpus and picks an open-model verifier that reproduces it, so quality survives the driver-model downgrade. |
| [Observability Server](observability-server/observability-server.md) | Ingests real-time events and structured logs from extensions into a persistent, queryable backend. |
| [Outcome Capture](outcome-capture/outcome-capture.md) | Gives the learning ledger a source that matches real usage — `make rate` turns recent work into high-signal outcomes with your quick MATCH/MISMATCH verdicts. |
| [Outcome Ledger](outcome-ledger/outcome-ledger.md) | Records consequential actions, their expected results, and the actual deltas that close the learning loop. |
| [Plan Skill](plan-skill/plan-skill.md) | Breaks complex goals into actionable, reviewed, and taskified plans through a multi-agent workflow. |
| [PRD Skill](prd-skill/prd-skill.md) | Generates production-grade product requirements and an IDEAL_STATE artifact to feed into implementation. |
| [Progress Heartbeats](progress-heartbeats/index.md) | Resets the kill timer for long-running agents whenever they produce real progress, replacing fixed timeouts. |
| [Enhance](enhance/enhance.md) | On-demand: end a prompt with ` -i` to rewrite it into a world-class, goal-oriented prompt — verifiable goal, scope, completion criteria, guardrails — before Penny acts. |
| [Research Skill](research-skill/research-skill.md) | Conducts structured, evidence-based research at quick, standard, or deep depth with source credibility scoring. |
| [Self-Improving Guidance](self-improving-guidance/self-improving-guidance.md) | Proposes amendments to skill prompts and preferences based on patterns in the outcome ledger, with human approval. |
| [Skill Tool](skill-tool/skill-tool.md) | Invokes skills in single, parallel, chain, or resume modes to match execution patterns to the task. |
| [Tiered Memory](tiered-memory/tiered-memory.md) | Organizes memory into five tiers so the right information is injected, recalled, or archived at the right time. |
| [UNKNOWN_STATE](unknown-state/unknown-state.md) | Halts the plan skill and asks for direction when confidence is UNCERTAIN or no guard can handle the situation. |
| [Verification State](verification-state/verification-state.md) | Pauses high-stakes, POSSIBLE-confidence actions for explicit user confirmation before proceeding. |
| [Weekly Digest](weekly-digest/weekly-digest.md) | Aggregates outcomes, confidence trends, signals, and pending amendments into a weekly accountability summary. |

## How This Index Is Organized

- **Human docs** live in `docs/humans/capabilities/` and focus on what a capability is, why it exists, and when to use it.
- **Agent docs** live in `docs/agents/capabilities/` and contain the machine-readable rules, schemas, and checklists that agents follow.
- Every capability listed here has a corresponding agent doc in `docs/agents/capabilities/`.