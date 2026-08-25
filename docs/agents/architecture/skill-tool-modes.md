# Skill Tool Modes — Single, parallel, chain, and resume

## Rules

1. Exactly one invocation mode is selected.
2. Single/parallel stages use owner-selected exact artifact IDs from any run.
3. Chain handoff is the prior skill's verified terminal ID, never inline payload or memory.
4. Chain checkpoints are owner-only, atomic, and retain terminal/handoff refs.
5. Resume verifies checkpoint identity and every exact ref before advancing.
6. Every catalog worker uses its exact YAML tool surface; missing optional services remain
   visible and return typed call errors.
7. Every stage output is persisted and re-read before routing or continuation.

## Modes

| Mode     | Input                                               | Failure behavior                           |
| -------- | --------------------------------------------------- | ------------------------------------------ |
| Single   | One skill and goal plus optional exact IDs          | Typed terminal result/error                |
| Parallel | Independent skill goals/inputs                      | Branch communication failures are explicit |
| Chain    | Ordered goals; automatic prior ID plus optional IDs | Stop on first failure; persist every ref   |
| Resume   | Chain ID plus bounded failed-step overrides         | Skip verified completed steps              |

Mode detection remains `resume_chain > chain > skills > single`; ambiguous mixed parameters
fail rather than guess.

## Chain and fan-in

The owner verifies the prior terminal ID and passes it directly across runs. `{previous}`
is a bounded instruction marker. A chain step may add explicit IDs for multi-source fan-in.
Payload bytes and durable memory are never control transport.

## Verification

- [ ] Every successful producer/stage has a readable exact output ID.
- [ ] Cross-run single/parallel/chain/fan-in pass.
- [ ] Restart reconstructs handoff from refs, not previews or memory.
- [ ] Output persistence/readability failures cannot return success.
