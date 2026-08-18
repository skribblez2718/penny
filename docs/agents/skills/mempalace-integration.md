# Skill Artifact Handoff and Optional Durable Memory

> The filename is retained for link stability. Its former session-room protocol
> is retired.

## Active workflow handoff

1. The playbook selects exact predecessor refs for each consumer.
2. The directive declares strict `input_artifacts` and an owner
   `output_artifact` contract.
3. The runner grants only those refs to that worker.
4. The worker reads every grant with `artifact_read`, following continuation
   until complete, and returns complete stage content.
5. The execution owner persists and verifies exact response bytes before parsing
   the routing-only `SUMMARY`.
6. The checkpointer records compact routing state and selected refs for retry,
   clarification, restart, and compaction recovery.

Parallel branches are keyed by `branch_id` and receive no sibling grants. A
malformed SUMMARY may create an explicit artifact revision; it never causes a
semantic search for a replacement predecessor.

## Durable memory boundary

Memory is optional and primary-owned for writes. The unmarked primary runtime
may retrieve prior durable knowledge when it could materially affect the task and
may curate a reusable result after completion. Since 2026-08-17 subagent workers
also hold a read-only recall subset (`memory.read`); they hold no write, diary,
KG-mutation, or logstream tool and no lifecycle hooks. Skill drivers receive
nothing. Read-only recall is not a handoff channel — with no write surface, one
agent cannot leave a message for another.

Historical `skills/<skill>-<session_id>` rooms are legacy corpus. They are not
active handoff channels, and their legacy classification is never deletion
authority.

## Context safety

- Artifact reads are exact-ref and grant bound; there is no list/search/guess surface.
- Oversized content uses an opaque, caller/query/revision-bound continuation.
- `RunContext` stores refs, not payload bytes.
- Compaction preserves a prose orientation plus code-owned exact run/artifact refs;
  ordinary continuation does not require memory availability.

## Verification

- [ ] Every stage selects all required exact predecessors.
- [ ] Owner capture and ref verification precede SUMMARY routing.
- [ ] No worker prompt or tool list contains a durable-memory **write** instruction/tool.
- [ ] Retry/restart retain the same selected refs.
- [ ] Legacy rooms are treated only as historical corpus.

## Files

| File                                  | Purpose                               |
| ------------------------------------- | ------------------------------------- |
| `docs/agents/skills/orchestration.md` | Engine protocol                       |
| `.pi/extensions/artifacts/README.md`  | Exact artifact reads and continuation |
| `docs/agents/memory/integration.md`   | Primary durable-memory policy         |
