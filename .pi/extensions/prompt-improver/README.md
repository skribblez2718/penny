# Prompt Improver Extension

Implements Circumstances 3/4 of the prompt layer architecture: the raw user
prompt is rewritten into better-structured Invocation Context before the main
model sees it. See `docs/humans/prompts/layer-architecture.md` (Interaction
Circumstances) and `docs/agents/capabilities/prompt-improver/`.

## How it works

- Hooks the **`input` event** and returns `{action: "transform", text}` — the
  improved text becomes the persisted user message. (The architecture docs
  historically said "before_agent_start flow"; that hook cannot rewrite the
  prompt — its result carries only `{message?, systemPrompt?}`.)
- The improvement itself is one LLM call: the methodology in `prompt.md` plus
  the raw prompt in a `<raw_prompt>` block, at low reasoning effort. The
  improver restructures (goal, context, constraints, open questions); it never
  answers, never invents requirements.
- The original prompt is persisted via `appendEntry("prompt-improver", …)` for
  audit; pi itself only stores the transformed text.
- Every failure path (model missing, auth missing, timeout, disproportionate
  rewrite) degrades silently to the raw prompt and logs a warning.
- Headless contexts (`-p`, `--mode json`, subagents) are never improved:
  the handler requires `ctx.hasUI`.

## Configuration (.env, read lazily at each prompt)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PENNY_PROMPT_IMPROVER` | `off` | `off` \| `auto` (improve plain, underspecified prompts) \| `always` |
| `PENNY_IMPROVER_MODEL` | session model | `provider/model-id` for the improver call (try `ollama/deepseek-v4-flash:cloud` for latency) |
| `PENNY_IMPROVER_CONFIRM` | `1` | show the improved prompt in an editor to accept/edit/cancel |
| `PENNY_IMPROVER_TIMEOUT_MS` | `25000` | hard cap on the improvement call |

## Commands

- `/improve <text>` — improve `<text>` and submit it (works in any mode)
- `/improver [off|auto|always]` — show or set the mode for this session

## Why the default is off

Improvement blocks prompt submission for one LLM call — tens of seconds on
the current Ollama-cloud models. Turn it on deliberately
(`PENNY_PROMPT_IMPROVER=auto`), pick a fast improver model, and let the
prompt-efficacy eval (scripts/system/evals/README.md, N6) judge whether
improved Invocation Context earns its latency.

## Auto-mode skip rules

Extension-injected messages, mid-stream steering, `/`- `!`- `?`-prefixed
input, prompts under 40 chars (conversational replies), prompts over 1,200
chars, and prompts that already look structured (headings, fences, 3+ bullets,
`Goal:`/`Constraints:` labels).

## Tests

```bash
cd .pi/extensions/prompt-improver && bunx vitest run --config tests/vitest.config.ts
```
