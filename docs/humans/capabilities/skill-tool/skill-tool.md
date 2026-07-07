# Skill Tool — Usage Guide

The `skill` tool lets you invoke skills in four modes: single, parallel, chain, and resume.

## Quick Start

### Invoke a single skill

```
"Create a plan to refactor the auth module"
→ Penny calls skill({ skill_name: "plan", goal: "..." })
```

### Run two skills in parallel

```
"Research OAuth patterns AND plan the auth refactor simultaneously"
→ Penny calls skill({ skills: [{skill_name:"research",...}, {skill_name:"plan",...}] })
```

### Chain skills together

```
"Research the auth module, then plan a refactor based on what you find"
→ Penny calls skill({ chain: [{skill_name:"research",...}, {skill_name:"plan", goal:"Plan {previous}"}] })
```

The second skill receives the first skill's output via `{previous}`.

### Resume after a failure

```
"The chain failed at step 2 — retry that step with a longer timeout"
→ Penny calls skill({ resume_chain: "chain-xxx", step_overrides: {1: {constraints: {agent_timeout_ms: 3600000}}} })
```

## When to Use Each Mode

| Mode | Best For |
|------|----------|
| **Single** | One focused task. The default. |
| **Parallel** | Independent tasks. No shared state. Max 3 concurrent. |
| **Chain** | Sequential pipelines. Step N+1 depends on step N's output. Max 10 steps. |
| **Resume** | Recovering from a chain error. Applies overrides to the failed step. |

## Constraints

- **Parallel skills:** Max 3 at once. Each spawns agents internally — 3 skills × 3–8 agents = resource-intensive.
- **Chain steps:** Max 10. Each step is sequential — chain execution time is the sum of all steps.
- **`{previous}` size:** Truncated to 2,000 characters. If you need the full output, access the mempalace room directly.
- **Checkpoints:** Saved as JSON files. Not synced across machines.

## Anti-Patterns

- ❌ Chaining independent skills (use parallel instead)
- ❌ Parallelizing sequential dependencies (use chain instead)
- ❌ Resuming a chain that was completed (returns success immediately)
- ❌ Overriding steps that didn't fail (only the failed step is applied)

## Examples

### Research → Plan → Implement Pipeline

```
"Research the current auth patterns, plan a refactor based on findings, then scaffold the implementation"
```

This is a 3-step chain: research → plan → agent.

### Multi-Program HackerOne Run

```
"Score and rank programs from Shopify, GitLab, and Dropbox"
```

The hackerone skill now uses parallel enrichment internally — scopes, weaknesses, and hacktivity are fetched in parallel batches.

### Resilience

If a chain step fails (agent timeout, UNCERTAIN confidence, API error):
1. Penny presents the error with diagnostic questions
2. You diagnose the issue (e.g., via observability logs)
3. You re-invoke with `resume_chain` and optional `step_overrides`
4. The chain resumes from the failed step

No progress is lost — completed steps are preserved.
