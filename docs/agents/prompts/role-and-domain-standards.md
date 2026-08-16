# Role Definition and Domain Guidance Standards

## Separation

| Layer           | Source                             | Purpose                                                                 |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| Role Definition | `.pi/agents/*.md`                  | Project-local worker identity, tools, role constraints, generic output. |
| Domain Guidance | `.pi/skills/*/assets/prompts/*.md` | Static task-family criteria, exact handoff, state output and SUMMARY.   |

`.pi/agents` is the local catalog. Remote harness/service presence belongs to its
own registry and is never inferred from local files or memory.

## Role Definition standard

Required order:

1. YAML frontmatter (`name`, description, `tools`, model/provider settings).
2. Purpose.
3. Working Discipline.
4. Non-Negotiables.
5. Output.
6. Canonical `<agent_boundary>` block.

### Tools

- Grant only role-minimum tools.
- Include `artifact_read` in every worker definition. The runner excludes it when
  no trusted owner grant exists.
- Include no `memory_*` tool. Durable recall, curated writes, primary diary, and
  governed temporal KG operations belong to the unmarked primary runtime.

### Working Discipline

```markdown
- **Exact-input discipline**: when `input_artifacts` are granted, read every ref
  with `artifact_read` and follow continuation until complete. Do not discover
  predecessor workflow output through another channel.
- **[Role honesty rule]**: one evidence/honesty contract.
- **Confidence is a wire format**: CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN.
- **Escalate, don't guess**: use `needs_clarification` when the active SUMMARY
  contract defines it and missing inputs block valid work.
```

Role definitions return complete work. They do not claim model-authored
persistence, say that full output lives in memory, require duplicate prechecks,
or add routine KG links.

## Domain Guidance standard

Required sections:

1. **Mission** — current task-family role, not identity.
2. **Exact Artifact Handoff** — task supplies `input_artifacts`; read each exact
   grant with `artifact_read` through complete continuation; no predecessor
   discovery through another channel.
3. **Domain Guidance** — constraints, evidence criteria, tradeoffs, and resources.
4. **Non-negotiables** — task-family boundaries.
5. **Complete Output** — full stage content in the response or specified files;
   owner captures it; worker does not claim registration.
6. **SUMMARY** — exact state contract at the end, explicitly routing-only.

Static prompts contain no template variables, reserved boundary tags, session
rooms, memory read/write instructions, model-authored drawer identifiers, or
routine KG requirements.

## Exact handoff semantics

The execution owner produces grants from trusted invocation context. Tool
visibility does not authorize a ref; the artifact extension checks run,
consumer, digest, expiry, and cursor binding. Typed continuation is byte-exact
and must be followed until `truncated` is false. Missing or invalid grants fail
closed rather than triggering semantic search.

## Context and recovery

Task builders carry current-run facts, exact slots/refs, and clarification text.
Checkpoints retain selected refs. Retry, producer-oriented clarification,
restart, and compaction recovery reuse those refs. A `[RESUME-REFS v2]` appendix
contains code-owned addresses; prose remains the primary orientation.

## Token budgets

- Cognitive Frame: ≤1,500 `cl100k_base` tokens.
- Role Definition: ≤1,200 tokens.
- Domain Guidance: ≤1,000 tokens.
- Typical combined system prompt: ≤3,000 tokens.

## Verification

- [ ] Role tools contain `artifact_read` and no `memory_*` entries.
- [ ] Role output requires complete content, not memory persistence.
- [ ] Domain prompt contains exact grants, continuation, owner capture, and routing-only SUMMARY.
- [ ] No session-room, duplicate-precheck, diary, routine KG, or memory-drawer protocol.
- [ ] Static prompt contains no dynamic templates or reserved tags.
- [ ] Boundary and wire-format vocabulary match runtime contracts.
