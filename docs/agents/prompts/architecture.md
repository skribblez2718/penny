# Prompt Layer Architecture — Assembly and artifact handoff

## Named layers

| Layer              | Function                                                 | Source                             |
| ------------------ | -------------------------------------------------------- | ---------------------------------- |
| Cognitive Frame    | Stable operating policy and outcome contract             | `.pi/SYSTEM.md`                    |
| Role Definition    | Project-local worker role and constraints                | `.pi/agents/*.md`                  |
| Domain Guidance    | Static task-family criteria and SUMMARY contract         | `.pi/skills/*/assets/prompts/*.md` |
| Project Index      | Navigation                                               | `AGENTS.md` indexes                |
| Invocation Context | Current goal, constraints, identifiers, and exact grants | Runtime task                       |

`.pi/agents` is the project-local catalog. Remote harness/service presence belongs
to the harness/service registry and is not inferred from the catalog or memory.

## Worker assembly

1. Transform the Cognitive Frame for the worker and strip parent-only protocols.
2. Read the selected Role Definition from the current catalog snapshot.
3. Inject optional static Domain Guidance before the literal `<agent_boundary>`.
4. Append Project Index and runtime context.
5. Set worker lifecycle role, strip approval/receipt secrets, and apply the role
   tool allowlist.
6. Expose `artifact_read` only when trusted owner invocation metadata grants exact
   current-run refs.

Markers are parsing aids and insertion anchors, not enforcement. Runtime tools,
approval receipts, artifact grants, and OS/container permissions are the control
plane.

## Artifact-first invocation context

A workflow task carries compact current-run facts plus:

- `input_artifacts`: owner-selected exact predecessor slots/refs;
- `output_artifact`: the contract for exact response capture;
- state, run, branch, producer, and consumer bindings;
- request-specific constraints and any clarification.

Workers read every granted input with `artifact_read`, following typed
continuation until complete. They return complete stage content and append the
Domain Guidance SUMMARY only as routing data. The owner persists and verifies
exact response bytes before SUMMARY parsing; failure prevents workflow advance.

Do not inject payload bytes, durable-memory search results, session-room pointers,
or model-authored persistence claims into the task. Workers have no memory tools.
The unmarked primary runtime retains value-triggered durable recall, curated
writes, its diary, and governed temporal KG access outside the handoff contract.

## Context-safe recovery

Run checkpoints retain selected refs and compact routing state. Retry,
clarification, restart, and partial parallel recovery reissue only pending work
with the exact selected refs. Compaction contributes a prose orientation plus a
code-owned `[RESUME-REFS v2]` appendix. Resume FSM state from the exact run ref;
read an artifact only when currently granted and use its continuation until
complete. Memory absence never blocks workflow recovery.

## Budgets

| Layer           | Budget                                |
| --------------- | ------------------------------------- |
| Cognitive Frame | ≤1,500 `cl100k_base` tokens, CI-gated |
| Role Definition | ≤1,200 tokens                         |
| Domain Guidance | ≤1,000 tokens                         |
| Typical total   | ≤3,000 tokens                         |

Tool-result budgets are separate. Artifact and memory adapters measure final
serialized envelopes and return typed continuation rather than silent truncation.

## Compliance

### Role Definition

- [ ] Catalog frontmatter declares minimum tools, includes `artifact_read`, and
      contains no `memory_*` tool.
- [ ] `authority` and `tool_profiles` are declared, and `tools:` is exactly their
      expansion (`check_tool_profiles.py`).
- [ ] Capability metadata is complete and valid (`check_capability_registry.py`).
- [ ] Working Discipline states exact granted input handling.
- [ ] Output requires complete content before a routing SUMMARY.
- [ ] No session-room, duplicate-precheck, diary, routine-KG, or memory-persistence instruction.
- [ ] Boundary marker remains literal and canonical.

### Domain Guidance

- [ ] Static Mission and domain criteria only; no template variables or reserved tags.
- [ ] Exact `input_artifacts` / `artifact_read` / continuation contract.
- [ ] Complete stage output and owner-capture statement.
- [ ] SUMMARY shape exactly matches the playbook contract and is routing-only.
- [ ] No worker memory instruction or claim of artifact registration.

### Project Index

- [ ] Every `AGENTS.md` is list-format navigation only.
- [ ] References exist; descriptions stay one line; no standards prose is embedded.

### Invocation Context

- [ ] Goal and material constraints are present.
- [ ] Exact owner refs and bindings are machine-produced, not model-granted.
- [ ] No predecessor payload bytes or semantic workflow pointer.

## Enforcement

Deterministic source guards reject worker memory tools/instructions, retired
session-room handoff, model-authored memory drawer fields, required room
manifests, and scaffolds that omit artifact-first handoff. Contract tests verify
SUMMARY keys and artifact selection. Model-diverse review remains supplementary
to these source, schema, and integration gates.
