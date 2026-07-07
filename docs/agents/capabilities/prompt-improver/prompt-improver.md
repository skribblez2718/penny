# Prompt Improver

Operational reference for the prompt-improver extension (`.pi/extensions/prompt-improver/`). Human-facing rationale: [Prompt Improver (Human)](../../../humans/capabilities/prompt-improver/prompt-improver.md).

## What It Is

The Prompt Improver implements Interaction Circumstances 3 and 4 from the [Layer Reference](../../prompts/layer-reference.md): a transformation on Invocation Context that rewrites the user's raw message into a better-specified version of the same request before the main model sees it. It is not a prompt layer — its output replaces the raw prompt as the user-role message.

## Mechanism (Normative)

| Aspect | Rule |
|--------|------|
| Hook | Pi `input` event returning `{action: "transform", text}` — NOT `before_agent_start`, whose result carries only `{message?, systemPrompt?}` and cannot rewrite the prompt |
| Improver call | One LLM call: `prompt.md` methodology + raw prompt in a `<raw_prompt>` block, reasoning effort low |
| Original prompt | Persisted via `appendEntry("prompt-improver", {original, improved, model, latencyMs})` — pi stores only the transformed text |
| Confirm step | `ctx.ui.editor` with accept/edit/cancel; cancel or empty → raw prompt is sent |
| Failure semantics | Model missing, auth missing, timeout, or disproportionate rewrite (> 4× raw + 2000 chars) → silently use the raw prompt, log a warning |
| Headless | `ctx.hasUI === false` (print/json mode, subagents) → never improve |

## Modes and Skip Rules

Mode resolves from session override (`/improver`) then `PENNY_PROMPT_IMPROVER` (default `off`).

Skipped in every mode: extension-injected input (`source === "extension"`), mid-stream steering (`streamingBehavior` set), empty input, `/` `!` `?` prefixes, prompts under 40 chars. `auto` additionally skips prompts over 1,200 chars and prompts that already look structured (headings, code fences, 3+ bullets, `Goal:`/`Constraints:` labels).

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PENNY_PROMPT_IMPROVER` | `off` | `off` \| `auto` \| `always` |
| `PENNY_IMPROVER_MODEL` | session model | `provider/model-id` for the improver call |
| `PENNY_IMPROVER_CONFIRM` | `1` | editor confirm before transform |
| `PENNY_IMPROVER_TIMEOUT_MS` | `25000` | hard cap per improvement call |

Commands: `/improve <text>` (one-shot improve-and-submit), `/improver [off|auto|always]` (session mode).

## Compliance Rules for the Methodology (prompt.md)

- The improver NEVER answers the request and NEVER invents requirements — improvement is structure and explicitness only.
- Every user-stated fact, constraint, path, and number is preserved.
- Blocker-grade ambiguity becomes an "Open questions" section (max 3), never a silent resolution — this respects the Instruction Hierarchy (Clarity over Thoroughness).
- Output is the improved prompt text only.

## Measurement

Whether improved Invocation Context earns its latency is an empirical question for the prompt-efficacy harness (`scripts/system/evals/README.md`, north star N6) — extend `golden_prompt_tasks.json` with raw-vs-improved arms before promoting `auto` to a recommended default.
