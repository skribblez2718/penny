# Skill Tool Modes — Single, parallel, chain, and resume invocation

## What

The `skill` tool supports four invocation modes. Penny decides when to invoke; skills decide how to execute. Agents communicate via mempalace — Penny's context stays clean.

## Why

Different tasks need different execution patterns. Single mode for one skill. Parallel for independent concurrent work. Chain for sequential handoff. Resume for recovery from failure.

## Rules

1. **Exactly one mode per invocation.** Ambiguous parameters → error.
2. **Parallel max is 3.** Each skill spawns 3–8 agents internally.
3. **Chain max is 10 steps.** Stops on first error. Resumable via checkpoint.
4. **`{previous}` truncates at 2,000 chars.** Word boundary; `…` appended on truncation.
5. **Checkpoints live in `/tmp/skill-checkpoints/`.** Not the project tree. OS-managed, may be cleared on reboot.

## Modes

### Single
```
skill({ skill_name: "plan", goal: "Design auth refactor" })
```

### Parallel (max 3)
```
skill({ skills: [
  { skill_name: "plan", goal: "Design auth refactor" },
  { skill_name: "research", goal: "Research OAuth 2.1" }
]})
```
One failure does not abort others.

### Chain (max 10)
```
skill({ chain: [
  { skill_name: "research", goal: "Research auth patterns" },
  { skill_name: "plan", goal: "Plan based on: {previous}" }
]})
```
Stops on first error. Resumable.

### Resume
```
skill({ resume_chain: "chain-1768176000000" })
```
Reads checkpoint, skips completed steps, resumes from failed step.

## Mode Detection Priority

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
- [ ] Checkpoint updated on step completion
- [ ] Failed chain returns resumable result with `chain_error_step`
- [ ] Stale checkpoints (>24h) warn but allow resume

## Files

| File | Purpose |
|------|---------|
| `.pi/extensions/skill/index.ts` | Skill tool implementation |
| `.pi/extensions/skill/skill-utils.ts` | Mode detection, result types |
| `docs/agents/capabilities/skill-tool/skill-tool.md` | Agent operational guide |
