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
- The enhancement is one LLM call: the methodology in `methodology.md`, the
  **full active conversation** in a `<session_context>` block, and the raw prompt
  in a `<raw_prompt>` block (last), at low reasoning effort. The methodology
  restructures the request into a verifiable goal, scope, completion criteria,
  loop/verification design, and guardrails (the six-category "world-class prompt"
  rubric); it never answers and never invents requirements.
- **Session context** comes from `sessionManager.buildContextEntries()` — the
  same compaction-aware entry set pi sends the main model — flattened to text by
  `transcript.ts`. Without it, mid-session referential prompts ("fix that bug",
  "same for the other file") were enhanced into confident *invented* specifics,
  because the rubric demands concreteness the enhancer could not source. The
  methodology constrains that context hard: it resolves references and inherits
  established constraints, but the **goal always comes from `<raw_prompt>`
  alone**. Assistant `thinking` blocks and image bytes are omitted (scratchpad /
  text-only model); a single tool result is capped at 20K chars.
- Reading the session **never blocks input**: a missing or throwing session
  manager yields an empty transcript and enhancement proceeds.
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
| `PENNY_ENHANCE_MODEL` | session model | `provider/model-id` for the enhancement call. Must be a **large-context** model — it receives the whole session. Currently `ollama/glm-5.2:cloud` (999,424 ctx) |
| `PENNY_ENHANCE_TIMEOUT_MS` | `25000` | hard cap on the enhancement call (set to `60000` in `.env`) |
| `PENNY_ENHANCE_CONTEXT_MAX_CHARS` | `3200000` | safety valve only (~800K tokens). Oldest entries are dropped first if the transcript would overflow the enhance model. Not a trimming policy — full context is the design |

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
flag) rather than always-on.

Because the full session is now sent, cost and latency scale with session
length: a `-i` late in a long session is a materially bigger call than one at
the start. The tradeoff is deliberate — a fast small-context model cannot
resolve mid-session references, which was the failure this fixes. Any override
of `PENNY_ENHANCE_MODEL` must keep a large context window.

## Tests

```bash
cd .pi/extensions/enhance && bunx vitest run --config tests/vitest.config.ts
```
