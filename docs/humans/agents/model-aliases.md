# Agent Model Aliases (capability-tier, upgrade-proof)

Penny's 8 agents reference their model by a **capability-tier alias** (`opus`, `sonnet`)
instead of a pinned version string. This removes the per-upgrade edit tax: on a model
upgrade you change **one** line in one file instead of editing every agent.

## Required global config — `~/.pi/agent/models.json`

The aliases are defined here (NOT in the project repo). **The agent files depend on this
block existing.** On a fresh machine, add it or the agents' `model: opus` / `model: sonnet`
will not resolve.

```json
{
  "providers": {
    "anthropic": {
      "modelOverrides": {
        "claude-opus-4-8":  { "name": "opus" },
        "claude-sonnet-5":  { "name": "sonnet" },
        "claude-haiku-4-5": { "name": "haiku" }
      }
    }
  }
}
```

- Built-in models (Anthropic `claude-*`) are aliased via `modelOverrides` (they are not
  listed in `models.json`; they come from `/model`).
- Custom-provider models (Ollama, defined in `models.json`) are aliased by putting a
  `name` field directly on the model entry. A dormant Ollama base is staged:
  `deepseek` → `deepseek-v4-pro:cloud`, `glm5` → `glm-5.2:cloud`, `kimi`, `minimax`.

## How resolution works

The subagent runner passes the frontmatter `model:` value verbatim to `pi --model <value>`,
which pattern-matches against model **id and `name`**. An exact `name` alias wins over
models that merely *contain* the alias mid-id.

## Naming rule (verified by test)

An alias is **unsafe if another model's id *begins with* the alias word** — that competitor
can win by list order.

- Safe: `opus`, `sonnet`, `haiku` — every Anthropic id starts with `claude-`, so a bare
  family word is never a prefix collision (despite many substring matches).
- Unsafe: bare `glm` resolved to `glm-ocr:bf16`, not `glm-5.2:cloud`. Use a distinctive
  alias (`glm5`). Same latent risk for any family with >1 model sharing a prefix.

## Provider caveat

The runner's provider auto-resolver is indexed by model **id**, so an alias falls back to
the default provider (`anthropic`). Anthropic-aliased agents therefore need no explicit
provider, but the frontmatter sets `provider: anthropic` for robustness. **An agent pointed
at an Ollama alias MUST add `provider: ollama`** or it will 404 against Anthropic.

## Upgrading a model (the whole point)

To move the daily driver from `claude-opus-4-8` to `claude-opus-4-9`: change the one
`modelOverrides` key in `~/.pi/agent/models.json`. The 8 agent files never change.

```json
"modelOverrides": { "claude-opus-4-9": { "name": "opus" } }   // was claude-opus-4-8
```

## Not yet aliased (out of scope here)

The eval-roster model literals (`scripts/system/evals/golden_prompt_tasks.json`
`default_models`, `scripts/system/trajectory/run_trajectory.py` `--driver/--judge-model`,
the hardcoded judge model) are still pinned. Aliasing those is tracked as the remaining
half of the capability-tier-alias work.
