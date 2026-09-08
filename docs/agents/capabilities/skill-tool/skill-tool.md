# Skill Tool — Artifact-first invocation modes

## Modes

| Mode     | Use                                                                |
| -------- | ------------------------------------------------------------------ |
| Single   | One workflow goal.                                                 |
| Parallel | Independent workflow goals.                                        |
| Chain    | Ordered goals whose next step consumes the prior verified product. |
| Resume   | Continue a persisted failed/pending chain.                         |

## Handoff contract

Each skill run exposes an engine-selected terminal `output_artifact_ref`. Chain
mode verifies those exact bytes, registers a chain-run handoff artifact, and
passes that direct exact ID to the next skill's first worker. `{previous}` is a
bounded instruction pointing to the verified exact ID, never an authoritative
inline payload. Workers use `artifact_read` and repeat with `next_range` until
complete.

Schema-v3 checkpoints persist exact terminal/handoff refs and each step's canonical contract digest
in the active catalog-bound project partition beneath the canonical Penny state root. They are
owner-only and atomically replaced. Resume skips only steps whose checkpoint/ref bindings verify;
corrupt or missing refs fail closed.

Durable memory and historical skill rooms are not handoff or resume authority. Track-A recovery is forward-only: owner `PENNY_ARTIFACT_DISPATCH_MODE=paused` stops new dispatch, returns a non-success/retriable result, and leaves chain/run checkpoints plus exact refs pending. Unknown values fail closed. After `active`, resume reuses those refs; semantic memory is never a fallback.

## Registration and model visibility

The `skill` tool resolves only `ingress:skill` registrations from the sole executable
`PLAYBOOK_REGISTRY`. `.pi/skills` is the one package root. Knowledge Base remains on
`knowledge_base`. A model-visible package omits `disable-model-invocation`; only a hidden package
sets `disable-model-invocation: true`. Redundant `false` is not permitted. Pi native and Penny model
metadata include the visible packages, while `.pi/skills/.ignore` contains exactly explicitly
model-disabled packages. A model-disabled development package may remain unregistered for static
documentation work, but generic invocation refuses it with `SKILL_NOT_REGISTERED` until a playbook
exists.

## Limits

- Parallel and chain width/length limits are enforced by the extension schema.
- One mode per invocation; ambiguous input errors.
- Parallel branches are isolated and report independently.
- Chain stops on first worker, artifact, registration-digest, or checkpoint error with exact refs
  and `resumable:true`; generic failures add no retry-approval questionnaire.

## Verification

- [ ] Successful steps persist before chain advancement.
- [ ] Next consumer receives only the verified prior ref.
- [ ] Restart uses durable checkpoint refs.
- [ ] Memory absence does not change behavior.
- [ ] Paused single/parallel/chain execution dispatches no worker and remains retriable from the same refs.
- [ ] Terminal details expose authoritative output refs.

## Files

| File                                           | Purpose                 |
| ---------------------------------------------- | ----------------------- |
| `.pi/extensions/skill/README.md`               | Implementation contract |
| `docs/agents/architecture/skill-tool-modes.md` | Architecture            |
