# Prompt Improver

## What It Is

The Prompt Improver rewrites your raw prompt into a better-specified version of the same request — goal first, your facts preserved, blocker-grade ambiguities turned into explicit open questions — before Penny's main model sees it. The layer architecture calls this Interaction Circumstances 3 and 4: the improver is a transformation on the Invocation Context, not a new prompt layer. Penny receives the improved prompt as if you had typed it; your original is kept in the session for audit.

## Why It Exists

Task-specification quality is one of the few prompt interventions with robust cross-model support: a well-specified goal (explicit constraints, success criteria, surfaced unknowns) helps every model family, while most prompt "tricks" do not transfer. The improver applies Penny's clarification methodology (the five ambiguity categories) once, automatically, at the moment it matters — instead of relying on every user to write structured prompts by hand.

## How It Works

1. You type a prompt. If it's a slash command, shell escape, short reply, mid-stream steer, or (in `auto` mode) already structured, nothing happens.
2. Otherwise a small LLM call rewrites it per the methodology: restate the goal, preserve every fact, list only the constraints you stated, and append up to three "Open questions" if something blocking is ambiguous.
3. An editor pops up with the improved prompt — accept, edit, or cancel (cancel sends your original).
4. Any failure — improver model down, timeout, bloated rewrite — silently falls back to your original prompt.

## Honest Costs

Improvement blocks prompt submission for one LLM call (tens of seconds on the current Ollama-cloud models). That's why the default mode is `off`, why there's a confirm step, and why headless runs (subagents, print mode) are never improved. Enable it with `PENNY_PROMPT_IMPROVER=auto` and consider a fast improver model (`PENNY_IMPROVER_MODEL=ollama/deepseek-v4-flash:cloud`). Whether the rewrite earns its latency is a prompt-efficacy eval question (north star N6), not an article of faith.

## Learn More

- Operational rules and config: `docs/agents/capabilities/prompt-improver/prompt-improver.md`
- Where it sits in the architecture: [Layer Architecture](../../prompts/layer-architecture.md) (Interaction Circumstances)
- Extension source: `.pi/extensions/prompt-improver/`
