# Enhance

Operational reference for the enhance extension (`.pi/extensions/enhance/`). Human-facing rationale: [Enhance (Human)](../../../humans/capabilities/enhance/enhance.md).

## What It Is

Enhance transforms the Invocation Context ([Layer Reference](../../prompts/layer-reference.md)): one model call rewrites an admitted raw request before the main model sees it. It is not a prompt layer; its output replaces the user-role message. The six-category methodology specifies intended behavior, not a demonstrated improvement or permission to expand the user's scope.

## Mechanism (Normative)

| Aspect            | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger           | A trailing ` -i` after trimming trailing whitespace, with a whitespace boundary and non-empty stripped request, on non-steering **interactive** input. `FLAG_RE = /\s-i$/`. Other inputs pass through unchanged                                                                                                                                                                                                                                    |
| Flag consumption  | For admitted flagged requests, the flag is stripped on success, fallback, and headless paths. Non-interactive, steering, and empty-after-stripping input bypass the transform                                                                                                                                                                                                                                                                      |
| Hook              | Pi `input` event returning `{action: "transform", text}` — NOT `before_agent_start`, whose result carries only `{message?, systemPrompt?}` and cannot rewrite the prompt                                                                                                                                                                                                                                                                           |
| Enhance call      | One LLM call: `methodology.md` (the six-category "world-class prompt" rubric) + the full active session in a `<session_context>` block + raw prompt in a `<raw_prompt>` block (last), reasoning effort low                                                                                                                                                                                                                                         |
| Session context   | `sessionManager.buildContextEntries()` — the same compaction-aware entry set pi sends the main model — flattened by `transcript.ts`. Renders the four context-participating entry types (`message`, `custom_message`, `compaction`, `branch_summary`); skips bookkeeping entries. Omits assistant `thinking` and image bytes; retains the first 20K chars of tool-result text plus a truncation marker. Full session by design — no turn windowing |
| Context failure   | A missing or throwing `sessionManager` yields an empty transcript; enhancement still runs. There is no reference-resolution guarantee                                                                                                                                                                                                                                                                                                              |
| Original prompt   | On successful enhancement, `appendEntry("enhance", …)` stores original/enhanced text, model/latency, and transcript counts/truncation metadata; the user message is transformed. Fallback creates no enhance audit row                                                                                                                                                                                                                             |
| Confirm step      | None — the enhanced prompt runs immediately                                                                                                                                                                                                                                                                                                                                                                                                        |
| Failure semantics | No model, auth failure, provider error/abort, empty or runaway rewrite (> 16,000 chars) → flag-stripped raw prompt and warning. An unresolved model override warns and uses the session model. No extension elapsed-time ceiling or caller abort signal is supplied                                                                                                                                                                                |
| Headless          | For an admitted interactive request, `ctx.hasUI === false` → strip the flag and run raw without enhancement; non-interactive inputs already bypassed the hook                                                                                                                                                                                                                                                                                      |
| Source gate       | Only `source === "interactive"` is enhanced; `rpc`/`extension`-injected input passes through. Mid-stream `steer` is skipped                                                                                                                                                                                                                                                                                                                        |

## Configuration

| Variable                          | Default       | Meaning                                                                                                                                                                         |
| --------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PENNY_ENHANCE_MODEL`             | session model | `provider/model-id` override; unknown override falls back to session model. Choose a context window sufficient for the serialized active session plus methodology/request/reply |
| `PENNY_ENHANCE_CONTEXT_MAX_CHARS` | `3200000`     | Oldest-block dropping threshold, not a guaranteed token/window or hard aggregate-character bound: at least one block is retained and omission markers add text                  |

No commands and no modes — the ` -i` suffix is the sole trigger. The current implementation does not read `PENNY_ENHANCE_TIMEOUT_MS`; do not infer an elapsed abort from that retired setting.

The transcript uses all active compaction-aware entries, not a turn window. Tool-result/bash text retains its first 20,000 characters and serialized tool arguments their first 2,000, plus truncation markers; assistant thinking and image bytes are omitted. Oldest blocks may be dropped, and a missing/throwing session manager supplies empty context. These are reference/size limits, not proof that the model resolves references correctly.

## Current Methodology Contract

[The existing methodology](../../../../.pi/extensions/enhance/methodology.md) prescribes a fixed ordered six-category scan and permits standard completion-criteria additions. The following are instructions to the enhancer, not semantic properties enforced by runtime validation:

- The enhancer NEVER answers the request and NEVER redirects the goal or scope.
- Every user-stated fact, constraint, path, name, and number is preserved.
- It adds only standard completion criteria (stop conditions, verification, error handling) that any world-class prompt should have — never new domain requirements, technologies, or preferences the user did not state.
- **`<session_context>` is reference material, not a turn to respond to.** It resolves references (pronouns, "that file", "the same thing") and supplies constraints already established in-session. The goal comes from `<raw_prompt>` ALONE — never adopted from the conversation, never re-opening finished work.
- An unresolvable reference is left as the user wrote it. An honest vague reference beats a confident wrong one.
- Output is the enhanced prompt text only — no JSON, no commentary, no code fences, no label.
- Deeply ambiguous prompts get a best-effort enhancement (no clarifying questions — this is a fire-and-run transform).

## Runtime Limits and Pending Evaluation

The runtime rejects provider error/abort and empty or over-16,000-character output. It does not independently verify preserved facts, goal/scope, provenance, resolved references, or invented obligations. A plausible but wrong rewrite can pass those guards and executes without confirmation. Session text remains reference material, not approval or a new source of goals.

Changing the fixed scan, completion additions, or methodology dependency is **pending separately authorized evaluation**. This documentation change does not alter that methodology or establish benefit. A paired raw/current/candidate comparison should measure scope/provenance drift, invented requirements, latency/cost, and task outcomes; live/paid calls need separate authorization.

## Measurement

Whether enhanced Invocation Context earns its latency is an empirical question — measure raw-vs-enhanced arms before treating enhancement as a default reflex.
