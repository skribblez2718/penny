# Prompt Architecture Overview

Penny separates stable policy, worker roles, domain guidance, project navigation,
and the current task so each concern has one owner.

| Layer              | Purpose                                             | Source              |
| ------------------ | --------------------------------------------------- | ------------------- |
| Cognitive Frame    | Stable operating policy and outcome contract        | `.pi/SYSTEM.md`     |
| Role Definition    | Project-local worker identity and constraints       | `.pi/agents/*.md`   |
| Domain Guidance    | Static task-family criteria and output contract     | Skill prompts       |
| Project Index      | Navigation                                          | `AGENTS.md` indexes |
| Invocation Context | Current goal, constraints, exact artifact IDs/paths | Runtime task        |

## Local catalog and remote services

`.pi/agents` is the local worker catalog. It does not advertise remote service
availability; that belongs to the harness/service registry.

## Context preservation

Workflows never use durable memory as a relay. The execution owner verifies
exact immutable predecessor IDs, workers read them with `artifact_read`, and the owner
persists/re-reads each complete response before consuming a small routing SUMMARY. Large
reads repeat with `next_range`, and checkpoints keep refs rather than payload bytes.

Workers may have YAML-declared read-only recall tools, but write-capable memory remains
primary-only and memory is never workflow transport.

## Recovery

Retry, clarification, restart, and partial fan recovery reuse checkpointed exact
refs. Compaction keeps a prose resumption brief plus optional code-owned
`[RESUME-REFS v2]` addresses. Memory availability is not required to continue an
active workflow.

## Boundaries

Prompt markers clarify structure but do not enforce permissions. Tool allowlists,
exact YAML tools, artifact integrity, approval receipts, and OS/container permissions are the
control plane.

## Related documents

- [Layer Architecture](layer-architecture.md)
- [Assembly Pipeline](assembly-pipeline.md)
- [Design Principles](design-principles.md)
- [Security Architecture](security-architecture.md)
