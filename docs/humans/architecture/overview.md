# Penny's Architecture: A Human Overview

Penny separates concerns that newcomers often conflate: guidance says how work
should be approached; routing chooses whether to work directly, use one worker,
or run a skill; artifacts carry exact task content; checkpoints carry workflow
control state; and memory preserves selected knowledge across sessions.

For term definitions, see the [Penny glossary](../glossary.md). Use the
[architecture hub](index.md) for the rest of this section, the
[human-documentation hub](../index.md) to browse other domains, and the
[Penny README](../../../README.md) for broader project orientation.

## A request from start to finish

Consider this request:

> Use the supplied requirements and design notes to produce a reviewed
> implementation plan that can resume after an interruption.

The path is:

**request → applicable guidance → direct/agent/skill route → exact artifact →
checkpoint → optional memory**

1. **The request supplies the goal and constraints.** The caller provides the
   requirements and notes as exact artifact IDs or caller-specified paths, along
   with the desired plan and resumability requirement.
2. **Penny loads applicable guidance.** Standing system policy remains in force;
   the project index points to relevant architecture, writing, and skill
   guidance; a selected worker contributes its role definition; and a selected
   skill contributes task-family guidance. These layers inform behavior but do
   not expand runtime permissions.
3. **Penny chooses the simplest suitable route.** A small, self-contained plan
   could be written directly in the primary session. One bounded planning job
   could go to a planning worker. This example needs a reviewed, resumable
   sequence, so an engine-backed skill is appropriate. The task does not become
   a skill merely because a skill exists; checkpoints, review stages, or other
   workflow behavior must earn the overhead.
4. **Each stage uses exact artifacts.** The workflow owner verifies the supplied
   IDs before a worker starts. The worker reads each needed artifact with
   `artifact_read`, follows any continuation until complete, and returns its
   complete product. The owner persists and re-reads that product, then passes
   its exact output artifact ID to the next stage. A summary may guide routing,
   but it is not the stage payload.
5. **The engine checkpoints control state.** After a stage is accepted, the
   checkpoint records compact run state and selected artifact references, not
   the plan bytes. If the process stops, resume verifies the checkpoint and the
   referenced artifacts rather than reconstructing work from a preview or
   semantic search.
6. **Memory is optional and separate.** After completion, the primary may curate
   a stable decision or reusable preference if it is likely to matter later. It
   may also recall relevant prior knowledge before work begins. Neither action
   is required for the run, and memory never becomes handoff, checkpoint state,
   or proof that an artifact was saved.

## The major boundaries

### Guidance and control

Penny combines standing policy, project-local role definitions, task-family
Domain Guidance, project indexes, and the current invocation. Prompt text and
documentation explain intent and constraints. Runtime tool activation, artifact
validation, approval receipts, and host permissions enforce consequences.

### Direct work, agents, and skills

- **Direct:** use the primary session when separate context or workflow state
  would add no useful value.
- **Agent:** use a fresh worker for one bounded transformation when specialization,
  isolation of model context, parallel work, or separate judgment earns the
  handoff.
- **Skill:** use a registered workflow when durable checkpoints, gates, repair,
  fan-out, or resume behavior materially improves reliability.

Workers have fresh model context and declared tool surfaces, but Penny does not
provide filesystem or process sandboxing. Use an external container or virtual
machine when operating-system isolation is required.

A registered workflow may also request a bounded asynchronous host operation.
Those directives go only from the runner to the [host-operation owner](host-operations.md),
never to a worker or model tool. The owner binds a trusted adapter to the active
registration, journals intermediate milestones, and uses a state-root-global fenced
lease when backend capacity must be serialized across projects.

### Artifacts, checkpoints, and memory

- **Artifacts** hold exact current-run content and are addressed by immutable IDs.
- **Checkpoints** hold compact workflow state and selected artifact references.
- **Memory** holds curated, advisory cross-session knowledge and remains optional
  for active workflow recovery.

Keeping these planes separate prevents a convenient summary, search result, or
memory entry from silently replacing the exact bytes a later stage must consume.

## Continue reading

- [Project Standards](project-standards.md)
- [Bitter-Lesson Doctrine](bitter-lesson.md)
- [Tiered Memory](tiered-memory.md)
- [Skills](../skills/overview.md)
- [Prompt Architecture](../prompts/overview.md)
