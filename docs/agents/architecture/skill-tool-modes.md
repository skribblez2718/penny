# Skill Tool Modes — Single, parallel, chain, and resume

## Rules

1. Exactly one invocation mode is selected.
2. Single/parallel stages use owner-selected exact artifact IDs from any run.
3. Chain handoff is the prior skill's verified terminal ID, never inline payload or memory.
4. Chain checkpoints are owner-only, atomic, and retain terminal/handoff refs plus each step's
   canonical contract digest.
5. Resume verifies checkpoint identity, registration/digest, and every exact ref before advancing;
   legacy checkpoints without a digest fail closed.
6. Tool selection follows the [binding runtime rule](../agents/discovery-and-tools.md#binding-runtime-rule): direct catalog paths and subset-absent orchestration use exact YAML; otherwise orchestration may use only its registered strict subset or the guarded zero-tool exception with its required model, host-admitted payload/disclosure and final-opening authorization. Modes, tasks, trust and optional-service availability cannot choose authority. [Tool Profiles](../agents/tool-profiles.md) owns static YAML expansion, not phase selection; these controls are not OS/process or extension-code isolation.
7. [Agent Invocation](../agents/invocation.md) owns exact communication and capture. Every stage output is persisted and re-read before routing or continuation; no mode substitutes previews or memory for exact refs.

## Modes

| Mode     | Input                                               | Failure behavior                                                                   |
| -------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Single   | One skill and goal plus optional exact IDs          | Typed terminal result/error                                                        |
| Parallel | Independent skill goals/inputs                      | Branch communication failures are explicit                                         |
| Chain    | Ordered goals; automatic prior ID plus optional IDs | Stop on first failure; exact refs + `resumable:true`, no generic approval ceremony |
| Resume   | Chain ID plus bounded failed-step overrides         | Skip verified completed steps                                                      |

Mode detection remains `resume_chain > chain > skills > single`; ambiguous mixed parameters
fail rather than guess.

## Chain and fan-in

The owner verifies the prior terminal ID and passes it directly across runs. `{previous}`
is a bounded instruction marker. A chain step may add explicit IDs for multi-source fan-in.
Payload bytes and durable memory are never control transport.

## Verification

- [ ] Every successful producer/stage has a readable exact output ID.
- [ ] Direct/parallel/chain ordinary agent paths prove exact YAML equality.
- [ ] Orchestration proves absent-subset YAML equality and only registration-bound strict
      subsets or the closed guarded zero-tool exception; unguarded-empty/duplicate/equality-sized/
      non-YAML or dynamic declarations fail before session creation, and active removal/addition/
      replacement fails before the model prompt.
- [ ] Ordinary registered phases pin absent `allowed_tools` and exact YAML; synthetic
      registration-bound strict subsets and separate host-private tools remain independently
      covered.
- [ ] Cross-run single/parallel/chain/fan-in pass.
- [ ] Restart reconstructs handoff from refs, not previews or memory.
- [ ] Output persistence/readability failures cannot return success.
