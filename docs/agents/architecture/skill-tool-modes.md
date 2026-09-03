# Skill Tool Modes — Single, parallel, chain, and resume

## Rules

1. Exactly one invocation mode is selected.
2. Single/parallel stages use owner-selected exact artifact IDs from any run.
3. Chain handoff is the prior skill's verified terminal ID, never inline payload or memory.
4. Chain checkpoints are owner-only, atomic, and retain terminal/handoff refs plus each step's
   release status and canonical contract digest.
5. Resume verifies checkpoint identity, registration/digest, and every exact ref before advancing;
   schema-v1 checkpoints are production-only.
6. Direct/parallel/chain ordinary catalog-agent invocation always uses exact YAML equality.
   A TypeScript orchestration catalog-worker phase uses exact YAML when `allowed_tools` is
   absent, or one explicit non-empty duplicate-free registration/digest-bound strict YAML
   subset when present. No task, trust profile, input, runtime condition, or optional service
   may select it; missing optional services remain visible when selected and return typed call
   errors.
7. A phase subset is projected unchanged into worker invocation metadata, validated against
   YAML before session creation, passed exactly to Pi, and checked for active equality before
   the model prompt. It does not mutate agent YAML/profiles and is not OS/process sandboxing or
   extension-code isolation. Host-private isolated tools remain separate.
8. Every stage output is persisted and re-read before routing or continuation.

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
      subsets; empty/duplicate/equality-sized/non-YAML or dynamic declarations fail before
      session creation, and active removal/addition/replacement fails before the model prompt.
- [ ] Ordinary candidate phases pin absent `allowed_tools` and exact YAML; synthetic/evaluation
      strict subsets and separate host-private tools remain independently covered.
- [ ] Cross-run single/parallel/chain/fan-in pass.
- [ ] Restart reconstructs handoff from refs, not previews or memory.
- [ ] Output persistence/readability failures cannot return success.
