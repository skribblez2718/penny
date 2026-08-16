# Penny Capabilities

This index lists the Penny capabilities that have human-readable documentation. Each entry explains what the capability does in one line. For operational rules and implementation details that agents use, see the corresponding `docs/agents/capabilities/` entry.

| Capability                                                           | What it does                                                                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [Behavioral Ratchet](behavioral-ratchet/behavioral-ratchet.md)       | Replays Oracle-authored fixtures through the current system and blocks drift below the accepted baseline — the anti-drift floor under quality. |
| [Enhance](enhance/enhance.md)                                        | Rewrites a raw prompt into a world-class, goal-oriented one before the model sees it, on demand via a trailing ` -i` suffix.                   |
| [Error Logging](error-logging/error-logging.md)                      | Streams structured, coded log entries from extensions to the observability server for querying and correlation.                                |
| [Observability Server](observability-server/observability-server.md) | Ingests real-time events and structured logs from extensions into a persistent, queryable backend.                                             |
| [Progress Heartbeats](progress-heartbeats/index.md)                  | Resets the kill timer for long-running agents whenever they produce real progress, replacing fixed timeouts.                                   |
| [Research Skill](research-skill/research-skill.md)                   | Conducts structured, evidence-based research at quick, standard, or deep depth with source credibility scoring.                                |
| [Skill Tool](skill-tool/skill-tool.md)                               | Invokes single/parallel/chain/resume workflows with verified artifact-ref handoff and durable checkpoints.                                     |
| [Tiered Memory](tiered-memory/tiered-memory.md)                      | Keeps durable recall/curation primary-only, uses one supervised hub, and preserves legacy corpus through gated retention.                      |
| [UNKNOWN_STATE](unknown-state/unknown-state.md)                      | Pauses an orchestration run and asks for direction when confidence is UNCERTAIN or no guard can handle the situation.                          |
| [Verification State](verification-state/verification-state.md)       | Pauses high-stakes, POSSIBLE-confidence actions for explicit user confirmation before proceeding.                                              |

## How This Index Is Organized

- **Human docs** live in `docs/humans/capabilities/` and focus on what a capability is, why it exists, and when to use it.
- **Agent docs** live in `docs/agents/capabilities/` and contain the machine-readable rules, schemas, and checklists that agents follow.
- Every capability listed here has a corresponding agent doc in `docs/agents/capabilities/`.
