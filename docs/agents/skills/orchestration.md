# Skill Orchestration — Engine and exact-artifact protocol

## Architecture

Every workflow skill is a registered `BasePlaybook` subclass. The playbook owns
its named states, SUMMARY contracts, input selection, routing, gates, fan-out,
and terminal result. The shared engine owns protocol validation, checkpointing,
recovery, artifact metadata, budgets, and observability. The skill-directory
`orchestrate.py` is the canonical thin delegate.

## Protocol rules

1. Use `start`, `step`, `status`, and `recover` through `orchestration.cli`.
2. Persist run control state in the SQLite checkpointer keyed by `run_id`; never
   serialize it to argv, a temporary file, an artifact, or durable memory.
3. Emit one JSON directive per CLI invocation.
4. Every cognitive directive carries strict `input_artifacts` plus an owner
   `output_artifact` contract.
5. Grant only the selected current-state refs. An output scope contains the
   same-state retry/fan-in consumer, actual non-control FSM successors, and only
   explicitly declared retained-input consumers whose graph reachability validates.
   Never use the full playbook state registry as a scope. Workers use
   `artifact_read`, follow continuation until complete, and return the complete
   stage output.
6. Canonical finalized output is all `text` parts in the final assistant message,
   concatenated in order without an inserted separator. Preserve part whitespace;
   exclude thinking/reasoning and tool calls; never fall back to an earlier turn.
   Persist and verify those exact UTF-8 bytes before parsing the model-authored
   `SUMMARY`; artifact failure prevents `step`.
7. Keep payload bytes out of `RunContext`. Store only compact routing fields,
   canonical refs, branch identities, warnings, and terminal metadata.
8. Workers and skill drivers receive no durable-memory tools. Memory availability
   cannot affect start, retry, fan-in, clarification, restart, or completion.

## Directives

| Action                   | Required handoff                                                                 |
| ------------------------ | -------------------------------------------------------------------------------- |
| `invoke_agent`           | Agent, state/run/session IDs, task, exact input slots, output contract.          |
| `invoke_agents_parallel` | Branch-ID keyed tasks; each branch gets only its own grants and output contract. |
| `escalate_to_user`       | Persisted prior state and questions; no state blob.                              |
| `complete`               | Honest result with selected exact product ref, warnings, unresolved issues.      |
| `paused`                 | Typed non-terminal/retriable dispatch stop plus exact `recover` instruction.     |
| `error`                  | Typed errors and run identity.                                                   |
| `status`                 | Current persisted state and completion status.                                   |

## Recovery and continuation

- Crash recovery reissues only pending work from the checkpointer.
- Track A is forward-only. `PENNY_ARTIFACT_DISPATCH_MODE=paused` blocks new agent, deterministic-tool, and fan-out dispatch before selected refs or the pending checkpoint can change. The default is `active`; unknown values fail closed as typed retriable pauses.
- Status and exact artifact reads remain available while paused. After reactivation, a fresh-process `recover` reissues the identical pending state, selected input refs, and output metadata, or the next explicit compatible revision.
- Accepted sibling refs survive partial parallel recovery.
- Clarification resumes the producer state selected by the playbook with the
  exact checkpointed predecessor refs.
- Malformed SUMMARY retry creates a versioned owner artifact rather than
  replacing exact handoff with semantic discovery; the retry/fan-in state is an
  explicit legal consumer without authorizing unrelated phases.
- Large artifact inputs use typed UTF-8 continuation until `truncated` is false.
- `[RESUME-REFS v2]` after compaction supplies code-owned exact addresses;
  recover control state from the run ref and read artifacts only when granted.

## Safety and truth

States must be safe to reissue. Bounded loops end with honest `met=False` and
unresolved issues when the goal was not met. Verification states require
captured evidence. Skill-invoked workers have separate context and tool
allowlists but no filesystem/process sandbox.

## Verification

- [ ] Delegate is the canonical engine stub.
- [ ] Directive and result protocols validate exact refs and signed owner receipts.
- [ ] Pairwise wrong legitimate phases, stale checkpoints, retries, loops,
      clarification re-entry, and dynamic fan-in fail closed under least-authority scopes.
- [ ] Ordinary output, persisted bytes, byte length, and digest use the same
      multipart final-assistant text sequence.
- [ ] Artifact persistence/ref verification precedes SUMMARY parsing.
- [ ] Fan-in is branch-ID based, not completion-order based.
- [ ] RunContext contains no artifact payloads or retrieved memory.
- [ ] Recovery and compaction continuation are exact-ref based.
- [ ] Memory-absent integration paths pass.
- [ ] Pause/unpause drills prove no dispatch, unchanged manifest/object and memory-sentinel hashes, and same-ref forward recovery without semantic rooms or payload injection.

## Files

| File                                                         | Purpose                    |
| ------------------------------------------------------------ | -------------------------- |
| `apps/orchestration/src/orchestration/engine.py`             | Shared engine              |
| `apps/orchestration/src/orchestration/artifacts.py`          | Immutable artifact store   |
| `apps/orchestration/src/orchestration/checkpointer.py`       | Durable run state          |
| `apps/orchestration/src/orchestration/playbooks/research.py` | Current workflow reference |
| `.pi/extensions/skill/README.md`                             | TypeScript owner loop      |
