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

1. YAML frontmatter (`name`, description, `tools`, `authority`, `tool_profiles`,
   capability metadata, model/provider settings).
2. Purpose.
3. Working Discipline.
4. Non-Negotiables.
5. Output.
6. Canonical `<agent_boundary>` block.

### Capability metadata

Frontmatter is the single source of truth for the roster; there is no parallel
registry file. Every role declares `capability`, `family`, `transformation`,
`accepts`, `produces`, `authority`, `tool_profiles`, `side_effects`, and the
semantic coordinates (`gathers`, `evaluates`, `selects`, `sequences`, `writes`,
`requires_standard`, `neighbors`). Validated by
`scripts/system/checks/check_capability_registry.py`; schema and allowed values in
[Capability Registry](../agents/capability-registry.md).

Descriptions name only an agent's **nearest confusable neighbours** (≤3), not every
other role. Exhaustive pairwise exclusion is quadratic and drifts.

### The purification test

Apply to every invariant before it enters a Role Definition:

> If the subject matter changed from software to travel to scientific research to
> writing, would this invariant still define the capability, or would I sometimes
> want Domain Guidance to turn it off?

If it can be turned off, it is Domain Guidance. Per-step acceptance criteria,
mandatory parallelisation, rubric dimensions, veto conditions, and fixed report
section lists have all failed this test and belong to skills. No Role Definition may
contain an invariant that a shipping skill violates — an invariant the system's own
workflow cannot satisfy is not an invariant.

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
- [ ] `tools:` is exactly the expansion of `tool_profiles:` (CI-enforced).
- [ ] Capability metadata complete; `neighbors` resolve; description ≤3 neighbours.
- [ ] Every invariant passes the purification test, and none is violated by a shipping skill.
- [ ] Role output requires complete content, not memory persistence.
- [ ] Domain prompt contains exact grants, continuation, owner capture, and routing-only SUMMARY.
- [ ] No session-room, duplicate-precheck, diary, routine KG, or memory-drawer protocol.
- [ ] Static prompt contains no dynamic templates or reserved tags.
- [ ] Boundary and wire-format vocabulary match runtime contracts.
