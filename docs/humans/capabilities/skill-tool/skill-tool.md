# Skill Tool — Usage Guide

## Modes

- **Single:** invoke one workflow.
- **Parallel:** invoke independent workflows with isolated branches.
- **Chain:** run dependent workflows in order.
- **Resume:** continue a persisted failed or pending chain.

## Artifact-first chain handoff

Every successful skill exposes a verified terminal `output_artifact_ref`. Chain
mode turns that exact product into the sole handoff grant for the next skill's
first worker. `{previous}` points to the grant; it is not an inline copy of the
prior result.

Workers use `artifact_read` and follow typed continuation until the exact content
is complete. Checkpoints persist terminal and handoff refs in an owner-only state
root with atomic replacement, so process restart does not depend on temporary
files or memory rooms.

## Failure behavior

A chain stops before advancing if a worker fails, artifact capture/verification
fails, or checkpoint/ref bindings are missing or corrupt. Resume skips only
verified completed steps. Parallel branches report independently and never
receive sibling grants.

Durable memory is optional and not skill, chain, or resume authority.

## Use well

Use parallel only for independent goals. Use chain only when the next workflow
must consume the prior exact product. Prefer one well-scoped skill when chaining
would add no value.
