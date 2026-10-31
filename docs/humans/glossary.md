# Glossary

Terms used across Penny's documentation are defined here in their Penny-specific sense.

## A

**Agent.** A named capability role that performs one focused kind of work in a separate Pi session. An agent is defined by its instructions and declared tool surface; it is not a security sandbox.

**Artifact.** An immutable work product stored under an exact identifier, digest, media type, and byte length. Required work moves between workflow steps by artifact reference rather than by memory or a descriptive name.

**Artifact handle.** A path-free reference to an artifact. It identifies the bytes without exposing a filesystem location.

## C

**Catalog agent.** An agent registered in Penny's project-local agent catalog and available through the `subagent` tool or an orchestration registration.

**Checkpoint.** Durable workflow control state used to resume a run. A checkpoint stores state and selected artifact references, not substitute copies of semantic work products.

**Completion gate.** A deterministic final check that admits a positive terminal result only when the required states, current artifacts, receipts, and unresolved-item policy all pass.

**Consequence boundary.** The limit on what a task or workflow stage may do, such as read external sources, write files, call a host service, or publish a result.

## D

**Domain guidance.** Static, task-family instructions supplied to a particular agent phase. It defines the phase's mission, criteria, inputs, outputs, and consequence boundary.

**Durable memory.** Curated cross-session recall for reusable facts, preferences, relationships, or continuity. It is advisory and cannot replace an exact artifact or workflow checkpoint.

## E

**Engine-backed skill.** A reusable workflow coordinated by Penny's TypeScript orchestration engine. It can sequence agents and host operations, persist checkpoints, enforce gates, and resume after interruption.

**Evidence.** Material that supports a claim or verdict. A policy, instruction, model assertion, or intended control is not evidence that an action occurred or a standard was met.

## H

**Host operation.** A bounded operation executed by host-controlled code rather than by a model, such as readiness checking, artifact persistence, or a policy-approved external action.

## I

**Invocation context.** The current request's goal, constraints, exact artifact IDs, and caller-supplied parameters. It is the task-specific prompt layer and does not grant authority beyond the actual tool and host policy.

## K

**Knowledge base (KB).** Penny's private, advisory, evidence-linked synthesis store. It does not replace the canonical `AGENTS.md` documentation chain, and its content requires verification before being treated as current authority.

## P

**Playbook.** The registered state machine and contract that implement an engine-backed skill.

**Primary Penny session.** The main user-facing session. It owns task routing and any permitted durable-memory lifecycle operations; worker sessions remain isolated and bounded to their assigned job.

**Product.** The current semantic work product selected by a workflow, such as a specification, plan, assessment, or generated artifact.

## R

**Receipt.** Structured evidence emitted or admitted by the host to bind a completed check or operation to exact run, state, and artifact identities.

**Role definition.** The instructions and declared tool list for one catalog agent's capability role.

**Run.** One durable execution of a playbook, identified independently from the surrounding conversation session.

## S

**Skill.** A reusable multi-step job. In Penny, active skills are generally registered playbooks invoked through the `skill` tool; the private knowledge-base workflow uses its dedicated typed tool.

**Source snapshot.** An immutable, admitted capture of source material used as evidence during a run.

## T

**Tool profile.** A documented and linted description of a catalog role's declared tool surface. It supports consistency checks but does not provide process or filesystem isolation.

## W

**Worker session.** A separate agent session created for one delegated task or workflow phase. It receives bounded context and returns output for owner capture.
