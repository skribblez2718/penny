# Agent Model Aliases (capability-tier, upgrade-proof)

Penny's 10 agents reference their model by a **capability-tier alias** (`sol`, `terra`)
instead of a pinned version string. This removes the per-upgrade edit tax: on a model
upgrade you change **one** line in one file instead of editing every agent.

## Required global config — `~/.pi/agent/models.json`

The aliases are defined here (NOT in the project repo). **The agent files depend on this
block existing.** On a fresh machine, add it or the agents' `model: sol` / `model: terra`
will not resolve.

```json
{
  "providers": {
    "anthropic": {
      "modelOverrides": {
        "claude-opus-4-8": { "name": "opus" },
        "claude-sonnet-5": { "name": "sonnet" },
        "claude-haiku-4-5": { "name": "haiku" }
      }
    },
    "openai-codex": {
      "modelOverrides": {
        "gpt-5.6-sol": { "name": "sol", "contextWindow": 272000, "maxTokens": 128000 },
        "gpt-5.6-terra": { "name": "terra", "contextWindow": 272000, "maxTokens": 128000 },
        "gpt-5.6-luna": { "name": "luna", "contextWindow": 272000, "maxTokens": 128000 }
      }
    }
  }
}
```

### Why the context/token overrides are there

The values explicitly keep every GPT-5.6 tier at Pi's short-context defaults:
`contextWindow: 272000` with a `128000` maximum output. This prevents an alias-only config
from silently changing the fleet's context limit if the built-in catalog changes later.
Values are decimal, matching the catalog's convention.

`modelOverrides` entries are applied by model **id**, so each alias and its context/token
limits are bound together in one override.

- Built-in models (Anthropic `claude-*`, OpenAI `gpt-*`) are aliased via `modelOverrides`
  (they are not listed under `models`; they come from the provider's built-in catalog).
- Custom-provider models (Ollama, defined in `models.json`) are aliased by putting a
  `name` field directly on the model entry. A dormant Ollama base is staged:
  `deepseek` → `deepseek-v4-pro:cloud`, `glm5` → `glm-5.2:cloud`, `kimi`, `minimax`.

## The two tier ladders

`sol` / `terra` / `luna` are the OpenAI ladder; `opus` / `sonnet` / `haiku` are the
Anthropic one. Both alias sets stay defined so the fleet can be swapped back by editing
frontmatter alone.

| Tier  | OpenAI (current fleet)    | Anthropic (dormant) |
| ----- | ------------------------- | ------------------- |
| Heavy | `sol` → `gpt-5.6-sol`     | `opus`              |
| Mid   | `terra` → `gpt-5.6-terra` | `sonnet`            |
| Light | `luna` → `gpt-5.6-luna`   | `haiku`             |

`luna` is defined but **no agent currently uses it** — it exists so a light tier is one
frontmatter edit away.

### Current tier assignment

| Tier           | Agents                                                    |
| -------------- | --------------------------------------------------------- |
| `sol` (heavy)  | `annie`, `carren`, `demetri`, `echo`, `piper`, `skribble` |
| `terra` (mid)  | `ida`, `synthia`, `tabitha`, `vera`                       |
| `luna` (light) | — none                                                    |

Tiers are chosen by the **reasoning demand of the capability contract**, never by
convenience or by which tier avoids a test failure. `demetri` is `sol` because selection
under competing objectives is the highest-stakes deliberative reasoning in the roster and a
wrong decision propagates into planning and everything downstream. `ida` is `terra` because
its hardest invariant — candidates must differ in _approach_, not phrasing — is
reasoning-hard rather than sampling-easy, and the characteristic light-tier failure is
exactly the banned defect.

Two standing opportunities, both currently unexercised:

- **`tabitha` → `luna`.** Taskification introduces no new judgment, which makes it the
  strongest light-tier candidate. It is a hypothesis and must be **measured** before it is
  applied — asserting it would be exactly the reasoning this table exists to prevent.
- **`synthia` `terra` → `sol`.** `VERIFY_EDGES` contains one edge, `research: synthia → vera`.
  Both endpoints are `terra`, so the system carries a dated same-model independence
  exception. Re-tiering either endpoint makes the edge cross-model and lets the exception be
  **retired rather than renewed**. Because it is a `sol`↔`terra` move the distinct model set
  is unchanged, so the roster hash does not move and no re-measurement is triggered.

> **Hard constraint: never put `vera` on `luna`.** Verification is the system's evidence
> backstop. If the same-model edge needs breaking, raise `synthia` rather than lower `vera`.

## How resolution works

The subagent runner passes the frontmatter `model:` value verbatim to `pi --model <value>`,
which pattern-matches against model **id and `name`**. An exact `name` alias wins over
models that merely _contain_ the alias mid-id.

## Naming rule (verified by test)

An alias is **unsafe if another model's id _begins with_ the alias word** — that competitor
can win by list order.

- Safe: `sol`, `terra`, `luna` — every OpenAI id starts with `gpt-`, so a bare tier word is
  never a prefix collision. Each is also a unique substring across the whole catalog.
- Safe: `opus`, `sonnet`, `haiku` — every Anthropic id starts with `claude-`.
- Unsafe: bare `glm` resolved to `glm-ocr:bf16`, not `glm-5.2:cloud`. Use a distinctive
  alias (`glm5`). Same latent risk for any family with >1 model sharing a prefix.

## Provider caveat — `provider:` is MANDATORY on every agent

The runner's provider auto-resolver is indexed by model **id** and only reads
`providers.*.models[]`, so an alias defined via `modelOverrides` resolves to **nothing**
and falls through to `pi`'s own cross-provider id resolution.

**Verified failure mode:** `pi --model sol` with no `--provider` resolves to **openrouter**
and dies with `No API key found for openrouter`. It does not merely misroute to the default
provider — it hard-fails at startup.

Every agent therefore pins `provider: openai-codex` in frontmatter. Provider precedence in
the runner is: explicit `provider/model` override → agent frontmatter `provider:` →
`resolveProviderForModel(model)` → Pi's configured default.

> The provider id is `openai-codex` (matching `~/.pi/agent/auth.json`), **not** `openai`.

## Thinking levels

All 10 agents run `thinking: xhigh`. The `gpt-5.6-*` models declare
`thinkingLevelMap: {"xhigh": "xhigh", "max": "max", "minimal": "low"}`, so `xhigh` passes
through unchanged. A higher `max` level is available and currently unused.

## Upgrading a model (the whole point)

To move the fleet from `gpt-5.6-sol` to `gpt-5.7-sol`: change the one `modelOverrides` key
in `~/.pi/agent/models.json`. The 10 agent files never change.

```json
"modelOverrides": { "gpt-5.7-sol": { "name": "sol" } }   // was gpt-5.6-sol
```

**Caveat:** upgrading the concrete model behind an unchanged alias is intentionally
invisible to agent frontmatter. `check_tool_profiles.py` verifies the declared SSOT tool/model
shape, but it does not treat alias-target changes as orchestration state. Re-run relevant model
smokes and ablations when alias targets change; do not maintain a duplicate fleet hash in the
workflow engine.

## What is deliberately NOT aliased (do not "fix" these)

An earlier revision of this file listed the measurement-harness model literals as
"not yet aliased ... tracked as the remaining half of the capability-tier-alias work."
**That framing was wrong and is retracted (2026-08-01).** Those literals are pinned _on
purpose_, and aliasing them would be a regression, not a completion.

The rule: **agents use aliases; measurement harnesses pin concrete ids.** An alias makes
an agent upgrade-proof, which is what you want. The same alias makes a recorded
measurement _irreproducible_ — the model behind it can change without the artifact
showing it, so two runs stop being comparable. Pinning is the correct choice there.

| Literal                            | Location                                                           | Why pinned                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_DRIVER` / `DEFAULT_JUDGE` | `trajectory/run_trajectory.py`                                     | Trajectory artifacts must stay comparable across runs. Both are Ollama, not Anthropic. Override with `--driver-model` / `--judge-model`.                 |
| `anthropic/claude-haiku-4-5`       | `ablation/detectors.py`, `ablation/run_code_detection_ablation.py` | The cheap **model arm** of a manual ablation experiment; the arm must be a fixed, nameable model or the ablation means nothing. Override with `--model`. |

Component-specific runtime model overrides are separate from the agent-fleet aliases described here. Because the active component set changes independently, inspect the current component documentation and local configuration rather than treating an enumerated environment-variable list in this page as the capability catalog.
