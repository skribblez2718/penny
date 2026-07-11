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
| Enhance call | One LLM call: `methodology.md` (the six-category "world-class prompt" rubric) + raw prompt in a `<raw_prompt>` block, reasoning effort low |
| Original prompt | Persisted via `appendEntry("enhance", {original, enhanced, model, latencyMs})` — pi stores only the transformed text |
| Confirm step | None — the enhanced prompt runs immediately |
| Failure semantics | Model missing, auth failed, timeout/abort, empty or runaway rewrite (> 16,000 chars) → transform to the flag-stripped raw prompt (request still runs, un-enhanced), log a warning |
| Headless | `ctx.hasUI === false` (print/json mode, subagents) → strip the flag and run the raw prompt; never enhance |
| Source gate | Only `source === "interactive"` is enhanced; `rpc`/`extension`-injected input passes through. Mid-stream `steer` is skipped |

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PENNY_ENHANCE_MODEL` | session model | `provider/model-id` for the enhance call |
| `PENNY_ENHANCE_TIMEOUT_MS` | `25000` | hard cap per enhancement call |

No commands and no modes — the ` -i` suffix is the sole trigger.

## Compliance Rules for the Methodology (methodology.md)

- The enhancer NEVER answers the request and NEVER redirects the goal or scope.
- Every user-stated fact, constraint, path, name, and number is preserved.
- It adds only standard completion criteria (stop conditions, verification, error handling) that any world-class prompt should have — never new domain requirements, technologies, or preferences the user did not state.
- Output is the enhanced prompt text only — no JSON, no commentary, no code fences, no label.
- Deeply ambiguous prompts get a best-effort enhancement (no clarifying questions — this is a fire-and-run transform).

## Measurement

Whether enhanced Invocation Context earns its latency is an empirical question for the prompt-efficacy harness (`scripts/system/evals/README.md`, north star N6) — extend `golden_prompt_tasks.json` with raw-vs-enhanced arms before treating enhancement as a default reflex.
