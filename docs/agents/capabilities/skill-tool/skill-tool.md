# Skill Tool — Four-mode skill invocation for agents

## What

The `skill` tool supports single, parallel, chain, and resume modes. Penny routes; skills execute. Agents communicate via mempalace.

## Why

Different tasks need different execution patterns. Single for one skill. Parallel for concurrent work. Chain for sequential handoff. Resume for recovery.

## Rules

1. **Exactly one mode per invocation.** Ambiguous → error.
2. **Parallel max: 3.** Chain max: 10.
3. **`{previous}` truncates at 2,000 chars.** Word boundary.
4. **Chain stops on first error.** Resumable via checkpoint in `/tmp/skill-checkpoints/`.

## Modes

| Mode | Syntax | Use When |
|------|--------|----------|
| Single | `skill({ skill_name, goal })` | One skill, one goal |
| Parallel | `skill({ skills: [{skill_name, goal}] })` | Independent concurrent work |
| Chain | `skill({ chain: [{skill_name, goal}] })` | Sequential with `{previous}` handoff |
| Resume | `skill({ resume_chain: "id" })` | Recover failed chain |

## Mode Detection

```
resume_chain > chain > skills > single
```

## Constraints

| Limit | Value |
|-------|-------|
| MAX_PARALLEL_SKILLS | 3 |
| MAX_CHAIN_STEPS | 10 |
| `{previous}` truncation | 2,000 chars |
| Skill timeout | 90 min |
| Agent timeout | 30 min |

## Verification

- [ ] Checkpoint written before each chain step
- [ ] Failed chain returns resumable result
- [ ] Stale checkpoints (>24h) warn but allow resume

## Files

| File | Purpose |
|------|---------|
| `.pi/extensions/skill/index.ts` | Implementation |
| `docs/agents/architecture/skill-tool-modes.md` | Architecture reference |
