# Enhance

Operational reference for the enhance extension (`.pi/extensions/enhance/`). Human-facing rationale: [Enhance (Human)](../../../humans/capabilities/enhance/enhance.md).

## What It Is

Enhance implements Interaction Circumstances 3 and 4 from the [Layer Reference](../../prompts/layer-reference.md): a transformation on Invocation Context that rewrites the user's raw message into a world-class, goal-oriented version of the same request before the main model sees it. It is not a prompt layer — its output replaces the raw prompt as the user-role message. It replaces the former `/enhance` prompt template (send → copy → re-paste), collapsing that loop into a single trailing ` -i` suffix.

## Mechanism (Normative)

| Aspect | Rule |
|--------|------|
| Trigger | A trailing ` -i` (whitespace boundary required) on **interactive** input. `FLAG_RE = /\s-i$/`. Prompts without the flag pass through unchanged |
| Flag consumption | The flag is ALWAYS stripped — the literal `-i` never reaches the model, on every path (success, failure, headless) |
| Hook | Pi `input` event returning `{action: "transform", text}` — NOT `before_agent_start`, whose result carries only `{message?, systemPrompt?}` and cannot rewrite the prompt |
| Enhance call | One LLM call: `methodology.md` (the six-category "world-class prompt" rubric) + the full active session in a `<session_context>` block + raw prompt in a `<raw_prompt>` block (last), reasoning effort low |
| Session context | `sessionManager.buildContextEntries()` — the same compaction-aware entry set pi sends the main model — flattened by `transcript.ts`. Renders the four context-participating entry types (`message`, `custom_message`, `compaction`, `branch_summary`); skips bookkeeping entries. Omits assistant `thinking` and image bytes; caps a single tool result at 20K chars. Full session by design — no turn windowing |
| Context failure | A missing or throwing `sessionManager` yields an empty transcript; enhancement still runs. Reading the session never blocks the input path |
| Original prompt | Persisted via `appendEntry("enhance", {original, enhanced, model, latencyMs})` — pi stores only the transformed text |
| Confirm step | None — the enhanced prompt runs immediately |
| Failure semantics | Model missing, auth failed, timeout/abort, empty or runaway rewrite (> 16,000 chars) → transform to the flag-stripped raw prompt (request still runs, un-enhanced), log a warning |
| Headless | `ctx.hasUI === false` (print/json mode, subagents) → strip the flag and run the raw prompt; never enhance |
| Source gate | Only `source === "interactive"` is enhanced; `rpc`/`extension`-injected input passes through. Mid-stream `steer` is skipped |

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PENNY_ENHANCE_MODEL` | session model | `provider/model-id` for the enhance call. **Must be large-context** — it receives the whole session. Currently `ollama/glm-5.2:cloud` (999,424) |
| `PENNY_ENHANCE_TIMEOUT_MS` | `25000` | hard cap per enhancement call (`.env` sets `60000`) |
| `PENNY_ENHANCE_CONTEXT_MAX_CHARS` | `3200000` | safety valve (~800K tokens); drops oldest entries first. Guards against a provider hard-error when the session model's window exceeds the enhance model's — not a trimming policy |

No commands and no modes — the ` -i` suffix is the sole trigger.

## Compliance Rules for the Methodology (methodology.md)

- The enhancer NEVER answers the request and NEVER redirects the goal or scope.
- Every user-stated fact, constraint, path, name, and number is preserved.
- It adds only standard completion criteria (stop conditions, verification, error handling) that any world-class prompt should have — never new domain requirements, technologies, or preferences the user did not state.
- **`<session_context>` is reference material, not a turn to respond to.** It resolves references (pronouns, "that file", "the same thing") and supplies constraints already established in-session. The goal comes from `<raw_prompt>` ALONE — never adopted from the conversation, never re-opening finished work.
- An unresolvable reference is left as the user wrote it. An honest vague reference beats a confident wrong one.
- Output is the enhanced prompt text only — no JSON, no commentary, no code fences, no label.
- Deeply ambiguous prompts get a best-effort enhancement (no clarifying questions — this is a fire-and-run transform).

## Known Behavior

Before session context was injected, mid-session referential prompts were the enhancer's worst case: it could not resolve "that bug" or "the other file", yet the rubric still demanded concrete specificity, so it produced confident prompts aimed at invented targets. The failure was silent — only hard failures (timeout, empty, >16K chars) degrade to the raw prompt. Context injection targets exactly this; the methodology's goal-source rules are what keep the added context from causing the opposite failure (drift toward a goal taken from the conversation).

## Measurement

Whether enhanced Invocation Context earns its latency is an empirical question — measure raw-vs-enhanced arms before treating enhancement as a default reflex.
