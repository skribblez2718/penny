# Agent Overview — Catalog, lifecycle, and exact communication

## Catalog

`.pi/agents/*.md` is the sole project-local catalog. Each file defines one
domain-invariant capability role, model settings, and a required YAML `tools:` list.
Remote harness/service presence belongs to a separate registry.

## Maximum and active tool surfaces

YAML declares maximum catalog authority; invocation activates exact YAML or a registered
strict subset under the [binding runtime rule](discovery-and-tools.md#binding-runtime-rule).
That owner defines every admission condition, including the guarded zero-tool exception;
tasks and prompt layers cannot select tools. [Profiles](tool-profiles.md#rules) lint the
static YAML maximum, not phase selection. Anonymous host-private sessions remain separate.

## Artifact communication

Exact work products move by immutable artifact ID or caller-specified path, never memory
or substitute search. IDs are communication addresses, not permissions.
[Invocation](invocation.md#task-contract) owns full reads, `missing_input:`, mode-specific
handoff, exact output capture/readback before routing, and recovery.

## Lifecycle

The direct execution owner captures the current catalog for each invocation, assembles a
fresh worker context, preflights names/inputs/providers, and captures output before success.
Catalog edits do not require reloading the direct tool; registered orchestration bindings
remain independently frozen and checked. Use the
[invocation procedure](invocation.md#assembly) for dispatch and capture. For changes to
layer assembly, use [prompt architecture](../prompts/architecture.md#worker-assembly).

## Isolation

Fresh context and tool allowlists are not filesystem/process isolation. Direct and
skill-invoked workers run with the invoking user's OS permissions. Use an external
container/VM for untrusted or unattended work.

## Verification

- [ ] Every local role has one `.pi/agents/<name>.md` file with valid catalog metadata.
- [ ] [Tool activation](discovery-and-tools.md#verification) and
      [handoff](invocation.md#verification) checks cover the selected execution path.
- [ ] Fresh context and tool allowlists are not described as filesystem/process isolation.
