# Agent Overview — Catalog, lifecycle, and exact communication

## Catalog

`.pi/agents/*.md` is the sole project-local catalog. Each file defines one
domain-invariant capability role, model settings, and a required YAML `tools:` list.
Remote harness/service presence belongs to a separate registry.

## Maximum and active tool surfaces

YAML frontmatter is the maximum ordinary catalog authority. Direct, parallel, and chain
invocation activates it exactly. A TypeScript orchestration catalog-worker phase activates
YAML exactly when its active registration omits `allowed_tools`; otherwise it may activate
one explicit non-empty duplicate-free strict YAML subset bound into the canonical runtime-
registration digest and worker invocation metadata.

No trust profile, task, input, liveness/model policy, optional-service state, or runtime
condition may select or change that subset. Missing, empty, duplicate, additive,
replacement, equality-sized, unavailable, and non-YAML selections fail before session
creation; Pi receives the accepted list exactly and active equality is checked before the
model prompt. `authority:` and `tool_profiles:` continue to lint YAML exactly and are not
mutated by a phase subset.

All provider extensions load before activation. An unavailable backing service behind a
registered selected tool returns a typed error when called; its tool is not conditionally
hidden. Anonymous host-private isolated sessions remain separate and are not catalog roles.

## Artifact communication

Exact task outputs move by immutable artifact ID or a caller-specified file path.
Artifacts are communication addresses, not permissions.

1. Owner code verifies every supplied `input_artifacts` ID by exact manifest lookup and
   digest/length before spawn.
2. The worker reads needed IDs with `artifact_read`, repeating with `next_range` until
   complete.
3. The worker returns complete assistant output and any closed routing `SUMMARY`.
4. Owner code persists and re-reads exact bytes before routing or success.
5. Result text prints the exact output ID.

IDs may cross runs/sessions and support arbitrary multi-source fan-in. Chain mode inserts
the prior step ID automatically and permits extra explicit IDs. Memory, `/tmp`, repository
search, and name-only pointers are not substitute handoff channels.

## Lifecycle

1. Discover the requested definition from the current catalog snapshot.
2. Assemble Cognitive Frame + Role Definition + optional Domain Guidance + Project Index.
3. Preflight required providers and exact input IDs.
4. Spawn a fresh Pi process/session with exact YAML or the one eligible registration-bound
   orchestration strict subset.
5. Capture complete final assistant bytes.
6. Persist and re-read output, then parse any routing-only `SUMMARY`.

## Isolation

Fresh context and tool allowlists are not filesystem/process isolation. Direct and
skill-invoked workers run with the invoking user's OS permissions. Use an external
container/VM for untrusted or unattended work.

## Verification

- [ ] Every local role has one `.pi/agents/<name>.md` file.
- [ ] Every file has a non-empty duplicate-free known `tools:` list.
- [ ] Direct/parallel/chain runners assert exact YAML equality before model use.
- [ ] TypeScript orchestration asserts absent-subset YAML equality and validates only
      registration/digest-bound strict subsets before session creation.
- [ ] Ordinary candidate phases omit `allowed_tools` and activate exact agent YAML; synthetic or
      evaluation-only strict subsets remain separately tested without sandbox/isolation claims, and
      host-private tools remain separate.
- [ ] Every successful output is persisted, re-read, and returned with an ID.
- [ ] Cross-run single/parallel/chain/fan-in communication is tested.
