# Role Definition and Domain Guidance Standards

## Separation

| Layer           | Source              | Purpose                                           |
| --------------- | ------------------- | ------------------------------------------------- |
| Role Definition | `.pi/agents/*.md`   | Domain-invariant capability and YAML tool maximum |
| Domain Guidance | skill prompt assets | Static task-family criteria and SUMMARY contract  |

## Role Definition

[Definition Format](../agents/definition-format.md#required-shape) owns role shape,
frontmatter, Working Discipline, confidence vocabulary, conditional SUMMARY, and the exact
`<agent_boundary>` block. Use that scaffold and its linked registry/profile validators rather
than a second template here.

Keep capability, evidence/honesty, and consequence boundaries domain-invariant. Domain
Guidance supplies criteria, not agent identity, tool selection, or permission. Role output
is complete work, never a model-authored persistence claim or memory handoff.

Keep role-level proportionality domain-invariant: distinguish binding requirements from
proposed means and challenge unsupported additions. Reusable design rationale belongs in
[Project Standards](../architecture/project-standards.md#proportionality-outcomes-before-mechanisms),
and prerequisite timing belongs in [Bounded Work](../agents/bounded-work.md#dependencies-and-composition),
not repeated domain checklists or new role-specific approval machinery.

## Domain Guidance

Required sections:

1. Mission.
2. Exact Artifact Handoff—self-contained IDs/paths, `artifact_read` through `next_range`
   until complete, `missing_input:` when a required ID/path is absent, no memory/`/tmp`/repository
   or name-only substitute search.
3. Domain criteria and evidence constraints.
4. Non-negotiables.
5. Complete Output—return the full work; the owner captures and reads back exact bytes
   before routing or success, not a model-authored persistence claim.
6. SUMMARY—normally, registered cognitive phases emit one exact closed JSON line at the end,
   routing-only. A phase may instead explicitly declare a versioned registration-owned pure
   host projection from a bounded, closed captured core. Its guidance must name that exception,
   accepted grammar and redundant-footer refusal policy. The host preserves raw bytes/provenance,
   derives only confidence and complete phase details, and grants no new judgment or completion
   authority. Produce's Carren/Vera reviews opt in; unopted phases retain their existing transport.
   An ordinary role appends SUMMARY only when Domain Guidance defines it; preserve exact phase
   fields, including clarification fields only where declared.

Static prompts contain no dynamic template values, reserved boundary tags, memory room
protocol, model-authored persistence fields, or injected result-tool instructions.

## Exact semantics

[Invocation](../agents/invocation.md#task-contract) owns transport, capture, readback,
and failure semantics. Keep the worker-local obligations above self-contained: a worker
may receive static Domain Guidance without access to authoring links. IDs are communication
addresses, not permissions; preflight/integrity checks do not prove payload claims true.

## Context and recovery

[Invocation recovery](../agents/invocation.md#recovery-and-compaction) owns exact-ref reuse.
Static Domain Guidance must not embed current run/branch IDs, retry state, or recovered
payloads; those belong to Invocation Context.

## Verification

- [ ] Role shape and metadata pass [Definition Format checks](../agents/definition-format.md#verification).
- [ ] Domain prompts retain self-contained full-read, missing-input, no-substitute-search,
      complete-output, and declared final-SUMMARY obligations or the explicit bound host-projection exception.
- [ ] Static guidance has no dynamic variables, reserved tags, injected result tools, or
      model-authored persistence fields.
- [ ] Runtime transport/capture passes [Invocation checks](../agents/invocation.md#verification);
      domain prompts do not select tools or assert grant/consumer/expiry restrictions.
