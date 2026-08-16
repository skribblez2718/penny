# Prompt Architecture Overview

Penny separates stable policy, worker roles, domain guidance, project navigation,
and the current task so each concern has one owner.

| Layer              | Purpose                                           | Source              |
| ------------------ | ------------------------------------------------- | ------------------- |
| Cognitive Frame    | Stable operating policy and outcome contract      | `.pi/SYSTEM.md`     |
| Role Definition    | Project-local worker identity and constraints     | `.pi/agents/*.md`   |
| Domain Guidance    | Static task-family criteria and output contract   | Skill prompts       |
| Project Index      | Navigation                                        | `AGENTS.md` indexes |
| Invocation Context | Current goal, constraints, and exact owner grants | Runtime task        |

## Local catalog and remote services

`.pi/agents` is the local worker catalog. It does not advertise remote service
availability; that belongs to the harness/service registry.

## Context preservation

Workflows no longer use durable memory as a relay. The execution owner grants
exact immutable predecessor refs, workers read them with `artifact_read`, and the
owner captures each complete response before consuming a small routing SUMMARY.
Large reads use typed continuation, and checkpoints keep refs rather than payload
bytes.

Workers and skill drivers have no memory tools. The unmarked primary runtime
still owns value-triggered durable recall, curated writes, a primary diary, and
governed temporal KG access.

## Recovery

Retry, clarification, restart, and partial fan recovery reuse checkpointed exact
refs. Compaction keeps a prose resumption brief plus optional code-owned
`[RESUME-REFS v2]` addresses. Memory availability is not required to continue an
active workflow.

## Boundaries

Prompt markers clarify structure but do not enforce permissions. Tool allowlists,
owner artifact grants, approval receipts, and OS/container permissions are the
control plane.

## Related documents

- [Layer Architecture](layer-architecture.md)
- [Assembly Pipeline](assembly-pipeline.md)
- [Design Principles](design-principles.md)
- [Security Architecture](security-architecture.md)
