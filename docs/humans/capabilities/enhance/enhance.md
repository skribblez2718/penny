# Enhance

## What It Is

Enhance rewrites your raw prompt using a goal-oriented rubric — intended to clarify the goal, scope, completion criteria, loop/verification design, and guardrails — before Penny's main model sees it. You trigger it on demand by ending your prompt with a trailing **` -i`**. In the layer architecture, enhancement is a transformation on the Invocation Context — not a new prompt layer. Penny receives the enhanced prompt as if you had typed it; on successful enhancement your original (with the flag) is kept in an audit entry. A fallback runs raw without creating that entry.

## Why It Exists

Enhance applies the existing six-category, 28-attribute prompt rubric to make goals and constraints explicit. Whether that fixed scan improves a particular task is an evaluation question, not an established cross-model benefit.

It replaces the former `/enhance` prompt template, which required three manual steps: send the rough prompt, copy the enhanced result out of the reply, and re-paste it. Now the whole loop is one keystroke suffix.

## How It Works

1. Type your prompt and append ` -i` (for example: `plan a 3-day trip to Lisbon in March under $1500 -i`).
2. The extension strips the flag and makes one LLM call that rewrites the prompt per the methodology: a verifiable goal, scope boundaries, binary completion criteria, stop conditions, verification, and guardrails — with instructions not to answer or invent domain requirements. Those semantic instructions are not independently validated by the runtime.
3. The enhanced prompt runs immediately — no confirm step, no copy/paste.
4. No available model, auth/provider failure or abort, or empty/over-16,000-character output falls back to your stripped raw prompt with a warning. An unknown model override instead warns and uses the session model. There is no extension elapsed-time timeout. Non-interactive, steering, and empty-after-stripping inputs bypass the transform.

Prompts **without** the ` -i` suffix are processed normally and untouched.

## Honest Costs

Enhancement blocks submission for one model call. Cost and latency depend on model and active-session size; choose a `PENNY_ENHANCE_MODEL` with enough context capacity. The transcript omits thinking/image bytes and bounds individual tool material; oldest blocks may be dropped, but the configured threshold is not a hard aggregate/window guarantee. Admitted headless interactive requests run stripped raw text without enhancement.

Length/provider guards do not catch every plausible wrong rewrite. Changes to the fixed rubric are pending separately authorized evaluation of scope/provenance drift, invented requirements, latency/cost, and task outcomes. No method change or evaluated benefit is claimed here.

## Learn More

- Operational rules and config: `docs/agents/capabilities/enhance/enhance.md`
- Where it sits in the architecture: [Layer Architecture](../../prompts/layer-architecture.md) (Invocation Context)
- Extension source: `.pi/extensions/enhance/`
