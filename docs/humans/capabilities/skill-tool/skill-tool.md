# Skill Tool — Usage Guide

## Modes

- **Single:** invoke one workflow.
- **Parallel:** invoke independent workflows with isolated branches.
- **Chain:** run dependent workflows in order.
- **Resume:** continue a persisted failed or pending chain.

## Artifact-first chain handoff

Every successful skill exposes a verified terminal `output_artifact_ref`. Chain
mode forwards that exact product as the next skill's input address. `{previous}` points to that
address; it is not an inline copy of the
prior result.

Workers use `artifact_read` and repeat with `next_range` until the exact content
is complete. Checkpoints persist terminal and handoff refs in an owner-only state
root with atomic replacement, so process restart does not depend on temporary
files or memory rooms.

## Production and candidates

All packages live under `.pi/skills`; parsed release status and separate registries determine their
lifecycle. Model visibility is independent: normal discovery shows every valid package unless its
manifest explicitly sets `disable-model-invocation: true`, and `.pi/skills/.ignore` mirrors only those
hidden packages. The current Assess, Decide, Diagnose, Plan, and Produce candidates are visible, but
visibility does not enable execution. They remain outside the production registry and need the
ignored `.pi/candidate-enablement.json` exact local name/contract-digest binding before generic
ingress can select them. The runtime does not mint grants, create the file, move or promote a package,
or hide production Research when candidate configuration is bad. Knowledge Base continues to use its
dedicated tool.

## Failure behavior

A chain stops before advancing if a worker fails, artifact capture/verification
fails, or checkpoint/ref bindings are missing or corrupt. Resume skips only
verified completed steps whose release status and contract digest still match. Parallel branches
report independently. A generic chain failure is directly resumable and does not add a retry/skip
approval ceremony.

Durable memory is optional and not skill, chain, or resume authority.

## Use well

Use parallel only for independent goals. Use chain only when the next workflow
must consume the prior exact product. Prefer one well-scoped skill when chaining
would add no value.
