# Enhance

## What It Is

Enhance rewrites your raw prompt into a world-class, goal-oriented prompt — a verifiable goal, explicit scope, completion criteria, loop/verification design, and guardrails — before Penny's main model sees it. You trigger it on demand by ending your prompt with a trailing **` -i`**. The layer architecture calls this Interaction Circumstances 3 and 4: enhancement is a transformation on the Invocation Context, not a new prompt layer. Penny receives the enhanced prompt as if you had typed it; your original (with the flag) is kept in the session for audit.

## Why It Exists

Task-specification quality is one of the few prompt interventions with robust cross-model support: a well-specified goal (explicit constraints, success criteria, verification, surfaced unknowns) helps every model family, while most prompt "tricks" do not transfer. Enhance applies Penny's full "world-class prompt" rubric (six categories, 28 attributes) once, automatically, at the moment it matters — instead of relying on you to write a structured prompt by hand.

It replaces the former `/enhance` prompt template, which required three manual steps: send the rough prompt, copy the enhanced result out of the reply, and re-paste it. Now the whole loop is one keystroke suffix.

## How It Works

1. Type your prompt and append ` -i` (for example: `plan a 3-day trip to Lisbon in March under $1500 -i`).
2. The extension strips the flag and makes one LLM call that rewrites the prompt per the methodology: a verifiable goal, scope boundaries, binary completion criteria, stop conditions, verification, and guardrails — never answering the request, never inventing requirements.
3. The enhanced prompt runs immediately — no confirm step, no copy/paste.
4. Any failure — enhance model down, timeout, empty or runaway rewrite — silently falls back to your original prompt (with the flag stripped), so your request still runs, just un-enhanced.

Prompts **without** the ` -i` suffix are processed normally and untouched.

## Honest Costs

Enhancement blocks prompt submission for one LLM call (tens of seconds on the current Ollama-cloud models). That is why it is opt-in per prompt via the ` -i` flag rather than always-on, and why headless runs (subagents, print mode) strip the flag and run the raw prompt without enhancing. Point it at a fast model with `PENNY_ENHANCE_MODEL=ollama/deepseek-v4-flash:cloud`. Whether the rewrite earns its latency is a prompt-efficacy eval question (north star N6), not an article of faith.

## Learn More

- Operational rules and config: `docs/agents/capabilities/enhance/enhance.md`
- Where it sits in the architecture: [Layer Architecture](../../prompts/layer-architecture.md) (Interaction Circumstances)
- Extension source: `.pi/extensions/enhance/`
