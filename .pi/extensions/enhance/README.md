# Enhance Extension

On-demand prompt enhancement: end a typed prompt with a trailing **` -i`** and
the raw prompt is rewritten into a world-class, goal-oriented prompt before the
model acts on it — in place, no copy/paste. Prompts without the flag pass
through unchanged.

This replaces the former `/enhance` prompt template, which required sending the
rough prompt, copying the enhanced result out of the reply, and re-pasting it.

## How it works

- Hooks the **`input` event**. On interactive input ending in ` -i`, it strips
  the flag, enhances the prompt, and returns `{action: "transform", text}` — the
  enhanced text becomes the persisted user message and executes immediately.
- The enhancement is one LLM call: the methodology in `methodology.md` plus the
  raw prompt in a `<raw_prompt>` block, at low reasoning effort. The methodology
  restructures the request into a verifiable goal, scope, completion criteria,
  loop/verification design, and guardrails (the six-category "world-class prompt"
  rubric); it never answers and never invents requirements.
- The flag is **always consumed** — the literal `-i` never reaches the model.
- The original prompt (with flag) is persisted via `appendEntry("enhance", …)`
  for audit; pi itself only stores the transformed text.
- Every failure path (model missing, auth missing, timeout, empty or runaway
  rewrite) degrades to the **flag-stripped raw prompt**, so the request still
  runs — just un-enhanced — and logs a warning.
- Headless contexts (`-p`, `--mode json`, subagents) strip the flag and run the
  raw prompt without paying enhancement latency; only interactive input is
  enhanced.

## Configuration (.env, read lazily at each prompt)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PENNY_ENHANCE_MODEL` | session model | `provider/model-id` for the enhancement call (try `ollama/deepseek-v4-flash:cloud` for latency) |
| `PENNY_ENHANCE_TIMEOUT_MS` | `25000` | hard cap on the enhancement call |

## Usage

Type your prompt and append ` -i`:

```
plan a 3-day trip to Lisbon in March under $1500 -i
```

The enhanced, goal-oriented version runs directly. Omit ` -i` for normal
processing.

## Latency note

Enhancement blocks prompt submission for one LLM call — tens of seconds on the
current Ollama-cloud models. That is why it is opt-in per prompt (the ` -i`
flag) rather than always-on, and why a fast improver model can be set via
`PENNY_ENHANCE_MODEL`.

## Tests

```bash
cd .pi/extensions/enhance && bunx vitest run --config tests/vitest.config.ts
```
