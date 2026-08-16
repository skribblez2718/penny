# Skill Tool Modes — Single, parallel, chain, and resume

## Rules

1. Exactly one invocation mode is selected.
2. Single/parallel skill stages use owner-selected exact artifact contracts.
3. Chain handoff is the prior skill's verified terminal `output_artifact_ref`,
   never an inline `{previous}` payload or memory room.
4. Chain checkpoints persist under the caller-supplied state root or platform
   state directory with owner-only permissions and atomic replacement.
5. Resume verifies checkpoint identity and every terminal/handoff ref before
   advancing. Missing, corrupt, wrong-run, or ungranted refs fail closed.
6. Workers read grants with `artifact_read` and typed continuation.

## Modes

| Mode     | Input                                    | Failure behavior                                          |
| -------- | ---------------------------------------- | --------------------------------------------------------- |
| Single   | One skill and goal                       | Return typed terminal result/error.                       |
| Parallel | Independent skill goals                  | Branch failures do not cancel accepted siblings.          |
| Chain    | Ordered dependent skill goals            | Stop on first failure; persist exact refs.                |
| Resume   | Existing chain ID plus allowed overrides | Skip verified completed steps; retry failed/pending step. |

Mode detection remains `resume_chain > chain > skills > single`; ambiguous mixed
parameters fail rather than guess.

## Chain handoff

The previous step's terminal ref is read and verified by the owner, then wrapped
as an immutable chain-run handoff ref for the next skill. The first fresh worker
in that skill receives only that grant. `{previous}` may remain in goal text as a
bounded instruction pointing to the grant, but never contains authoritative
payload bytes. Large or multibyte content is consumed through continuation.

Durable memory is optional and not chain authority. A memory outage cannot alter
single, parallel, chain, or resume correctness.

## Verification

- [ ] Every successful step has a verified exact terminal ref.
- [ ] Checkpoint writes are owner-only and atomic.
- [ ] Restart reconstructs handoff from refs, not previews or memory.
- [ ] Parallel branches remain grant-isolated.
- [ ] Final result exposes authoritative product refs.

## Files

| File                                            | Purpose                          |
| ----------------------------------------------- | -------------------------------- |
| `.pi/extensions/skill/README.md`                | Skill owner loop and chain state |
| `.pi/extensions/skill/skill-chain-artifacts.ts` | Chain artifact handoff           |
| `.pi/extensions/skill/chain-checkpoint.ts`      | Durable chain checkpoint         |
