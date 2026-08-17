# Agent Overview — Architecture, lifecycle, and invocation patterns

## What

Agents are specialized worker subprocesses with isolated model context, a
project-local role definition, and a scoped tool set. Penny may work directly or
delegate through `subagent`; engine-backed skills use the same worker path.

## Catalog and presence

`.pi/agents/*.md` frontmatter is the **project-local agent catalog**. Discovery
reads that catalog only; it does not query durable memory, scan `PATH`, or infer
availability from prior runs. Reload the Pi session after the catalog changes so
the registered schema and execution snapshot agree.

Remote harness or service presence belongs to the separate harness/service
registry. Never duplicate or infer remote presence in `.pi/agents`.

## Rules

1. **Use the lowest-complexity sufficient path.** Delegate only when role
   specialization, separate context, parallel work, or separate judgment earns
   the handoff.
2. **Workers have no durable-memory tools.** Durable recall, curated writes, the
   primary diary, and governed temporal KG operations belong to the unmarked
   primary runtime.
3. **Exact current-run inputs use artifacts.** When the execution owner grants
   `input_artifacts`, the worker reads each with `artifact_read` and follows
   typed continuation until complete. Workers cannot list, search, guess, or
   self-grant artifacts.
4. **Return complete work.** The execution owner captures exact response bytes
   before a routing `SUMMARY` may advance a workflow. `SUMMARY` is routing data,
   not the stage artifact.
5. **Keep roles domain-invariant.** An agent is a capability contract whose
   objective, invariants, authority, tool posture, and input→output transformation
   stay stable when the subject matter changes. Domain-specific criteria come from
   injected Domain Guidance; do not create domain variants of an existing role. A
   proposed agent must pass the six-gate admission test in
   [Capability Registry](capability-registry.md).

## Lifecycle

1. Discover the requested role from the `.pi/agents` catalog.
2. Assemble Cognitive Frame + Role Definition + optional Domain Guidance.
3. Construct a current-run task with constraints and exact artifact grants.
4. Spawn a fresh worker process with the role's tool allowlist; expose
   `artifact_read` only when an owner grant exists.
5. Capture the worker's complete final response, persist and verify it when an
   owner output contract exists, then parse any required routing `SUMMARY`.

## Isolation

Separate context is not filesystem isolation. Direct and skill-invoked workers
run in separate Pi processes with tool allowlists but with the invoking user's OS
permissions. Approval and receipt secrets are stripped from worker environments.
Use an external container or VM for untrusted or unattended work.

## Verification

- [ ] Every local agent is represented by one `.pi/agents/<name>.md` catalog file.
- [ ] No worker frontmatter contains a `memory_*` tool.
- [ ] Every worker frontmatter declares `artifact_read`; the runner suppresses it
      when no exact grant exists.
- [ ] Remote presence is represented only in the harness/service registry.
- [ ] Owner-captured output precedes SUMMARY routing.

## Files

| File                                           | Purpose                             |
| ---------------------------------------------- | ----------------------------------- |
| `docs/agents/agents/definition-format.md`      | Agent catalog entry format          |
| `docs/agents/agents/discovery-and-tools.md`    | Catalog discovery and tool exposure |
| `docs/agents/agents/invocation.md`             | Invocation and exact handoff        |
| `docs/agents/agents/system-prompt-security.md` | Trust and runtime controls          |
