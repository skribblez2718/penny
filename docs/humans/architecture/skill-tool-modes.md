# Skill Tool Modes

The skill tool supports single, parallel, chain, and resume patterns. All use the
same artifact-first owner contract.

## Modes

- **Single:** one workflow goal.
- **Parallel:** independent workflow goals; branches stay isolated.
- **Chain:** ordered goals; the next skill receives the prior skill's verified
  terminal artifact ref.
- **Resume:** reload an owner-only chain checkpoint and retry the failed/pending step.

## Exact chain handoff

The old inline `{previous}` payload and temporary checkpoint model is retired.
`{previous}` may appear as a bounded instruction pointing at one granted ref, but
the canonical artifact remains authoritative. The next worker reads it with
`artifact_read` and typed continuation.

Chain checkpoints live under a caller-selected or platform state root, use
owner-only permissions, and are atomically replaced. They retain exact
terminal/handoff refs across process restart. Missing, corrupt, wrong-run, or
ungranted refs stop the chain before the next skill advances.

Durable memory and historical skill rooms are not handoff or resume authority.

## Failure behavior

Parallel branches report independently. Chains stop on the first worker,
artifact, or checkpoint failure. Resume skips only completed steps whose refs and
bindings verify.

## Related documents

- Agent architecture: `docs/agents/architecture/skill-tool-modes.md`
- Capability guide: `docs/humans/capabilities/skill-tool/skill-tool.md`
