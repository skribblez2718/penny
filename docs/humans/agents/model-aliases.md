# Agent Model Aliases (capability-tier, upgrade-proof)

Penny's 8 agents reference their model by a **capability-tier alias** (`sol`, `terra`)
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
        "claude-opus-4-8":  { "name": "opus" },
        "claude-sonnet-5":  { "name": "sonnet" },
        "claude-haiku-4-5": { "name": "haiku" }
      }
    },
    "openai-codex": {
      "modelOverrides": {
        "gpt-5.6-sol":   { "name": "sol",   "contextWindow": 272000, "maxTokens": 128000 },
        "gpt-5.6-terra": { "name": "terra", "contextWindow": 272000, "maxTokens": 128000 },
        "gpt-5.6-luna":  { "name": "luna",  "contextWindow": 272000, "maxTokens": 128000 }
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

| Tier      | OpenAI (current fleet) | Anthropic (dormant) |
| --------- | ---------------------- | ------------------- |
| Heavy     | `sol` → `gpt-5.6-sol`     | `opus`   |
| Mid       | `terra` → `gpt-5.6-terra` | `sonnet` |
| Light     | `luna` → `gpt-5.6-luna`   | `haiku`  |

`luna` is defined but **no agent currently uses it** — it exists so a light tier is one
frontmatter edit away.

## How resolution works

The subagent runner passes the frontmatter `model:` value verbatim to `pi --model <value>`,
which pattern-matches against model **id and `name`**. An exact `name` alias wins over
models that merely *contain* the alias mid-id.

## Naming rule (verified by test)

An alias is **unsafe if another model's id *begins with* the alias word** — that competitor
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

All 8 agents run `thinking: xhigh`. The `gpt-5.6-*` models declare
`thinkingLevelMap: {"xhigh": "xhigh", "max": "max", "minimal": "low"}`, so `xhigh` passes
through unchanged. A higher `max` level is available and currently unused.

## Upgrading a model (the whole point)

To move the fleet from `gpt-5.6-sol` to `gpt-5.7-sol`: change the one `modelOverrides` key
in `~/.pi/agent/models.json`. The 8 agent files never change.

```json
"modelOverrides": { "gpt-5.7-sol": { "name": "sol" } }   // was gpt-5.6-sol
```

**Caveat — the roster tripwire cannot see this.** `apps/orchestration/src/orchestration/roster.py`
hashes the *alias* set read from agent frontmatter. Upgrading the model behind an unchanged
alias does **not** move that hash, so the independence/loan review triggers will not fire.
Swapping tiers or providers in frontmatter does move it. See "Roster baseline" below.

## Roster baseline

`BASELINE_ROSTER` is duplicated in `independence.py` and `loans.py` and is asserted equal to
the live fleet hash by `tests/test_roster.py::test_recorded_baseline_matches_the_live_fleet`.
Changing any agent's `model:` will fail that test **by design** — the failure means every
same-model exception and borrowed-scaffolding loan is due for re-measurement.

Per that test's own docstring: *re-measure, then update the constant. **Do NOT just re-type
the new hash.***

| Fleet          | Hash           |
| -------------- | -------------- |
| `opus, sonnet` | `0504ae3f4c3e` |
| `sol, terra`   | `4e55bff3547d` |

## What is deliberately NOT aliased (do not "fix" these)

An earlier revision of this file listed the measurement-harness model literals as
"not yet aliased ... tracked as the remaining half of the capability-tier-alias work."
**That framing was wrong and is retracted (2026-08-01).** Those literals are pinned *on
purpose*, and aliasing them would be a regression, not a completion.

The rule: **agents use aliases; measurement harnesses pin concrete ids.** An alias makes
an agent upgrade-proof, which is what you want. The same alias makes a recorded
measurement *irreproducible* — the model behind it can change without the artifact
showing it, so two runs stop being comparable. Pinning is the correct choice there.

| Literal | Location | Why pinned |
| --- | --- | --- |
| `JUDGE_MODEL = "openai-codex/gpt-5.6-luna"` | `evals/prompt_efficacy_judge.py` | PRD **REQ-003**: *"a CONCRETE model id on purpose: eval artifacts must stay reproducible across model upgrades (unlike agents, which use tier aliases)."* Note it pins `gpt-5.6-luna`, **not** the `luna` alias — see below. Enforced by `test_prompt_efficacy_judge.py`. Override per-run via `PI_EVAL_JUDGE_MODEL`. |
| `default_models` (6 entries) | `evals/golden_prompt_tasks.json` | The eval comparison roster. Aliasing breaks longitudinal comparability of `.penny/evals/prompt_efficacy/run-*.json`. |
| `DEFAULT_DRIVER` / `DEFAULT_JUDGE` | `trajectory/run_trajectory.py` | Trajectory artifacts must stay comparable across runs. Both are Ollama, not Anthropic. Override with `--driver-model` / `--judge-model`. |
| `anthropic/claude-haiku-4-5` | `ablation/detectors.py`, `ablation/run_code_detection_ablation.py` | The cheap **model arm** of a manual ablation experiment; the arm must be a fixed, nameable model or the ablation means nothing. Override with `--model`. |

### Not pinned at all (no action needed)

`PI_SELFIMPROVE_CLUSTER_MODEL`, `PI_SELFIMPROVE_TARGET_MODEL`, `PI_SELFIMPROVE_DIFF_MODEL`
and `PI_LEDGER_DOMAIN_MODEL` have **no hardcoded default** — each reads `os.environ.get(..., "")`
and stays keyword/offline when unset. The `anthropic/claude-haiku-4-5` strings near them are
illustrative comments, not defaults.

The live model env vars that *are* set (`.env`) are all Ollama and unaffected by the fleet
move: `PENNY_ENHANCE_MODEL`, `PI_CODE_DETECT_MODEL`, `PI_STALL_MODEL`.

### Invariant #6, revised 2026-08-01: judge != subject MODEL (not FAMILY)

The judge used to be `anthropic/claude-haiku-4-5`; it is now `openai-codex/gpt-5.6-luna`.

The old rule demanded a **cross-family** judge. That is unachievable in most setups —
typically only one vendor has credentials — so it was aspirational and **nothing enforced
it**. A rule nothing checks is documentation, not a control. It has been replaced with a
narrower rule that is always achievable and carries the actual weight:

> A model must never grade **itself**. Sharing a model **family** is explicitly fine;
> being the **same model** is not.

Self-grading is the correlated-error case a second opinion exists to break — a
confidently-wrong model rates its own wrong answer a PASS. Family overlap does not have
that property, so paying for cross-family judging is a bonus, not a requirement.

**This rule is enforced, not advised.** `judge_self_grading_conflicts()` compares the
resolved judge against every subject and `run_prompt_efficacy.py` **refuses the run**
(exit 2). The check sits *before* the `--dry-run` return, so a misconfiguration surfaces
without spending a run, and it is **not** waivable by `--experimental` — a self-graded
number is invalid, not merely unapproved.

Matching is on model id, provider-agnostic, and alias-aware:

| Subject vs judge `gpt-5.6-luna` | Result |
| --- | --- |
| `openai-codex/gpt-5.6-luna` | **REFUSED** — identical |
| `openai-codex/luna` | **REFUSED** — the alias names the same model |
| `openai-codex/gpt-5.6-sol` / `-terra` | allowed — same family, different model |
| `ollama/glm-5.2:cloud` | allowed — unrelated |

The suffix heuristic that catches the alias case is deliberately biased toward **false
positives**: a false positive costs one clear, actionable refusal, while a false negative
would silently ship a self-graded number.

#### Why the judge pins the concrete id and not `luna`

Two independent reasons, either sufficient:

1. **Reproducibility (REQ-003).** An alias lets the measuring instrument change silently
   between runs, making artifacts incomparable.
2. **`family_of()` cannot classify an alias.** `family_of("gpt-5.6-luna") == "openai"`, but
   `family_of("luna") == "luna"` — a bare alias would defeat the family slice below.

#### The calibration slice now tracks the judge

`run_judge_calibration.py` used to gate on a hardcoded `"claude"` false-pass slice — correct
only while the judge happened to be a Claude model. It now derives the slice from the
*resolved judge's* family, so re-pointing the judge re-aims the bias check automatically.
Under the revised policy the judge may legitimately share a family with its subjects, and
that shared family is exactly where correlated blindness would surface.

**Changing the judge invalidates the existing calibration.** Re-run
`run_judge_calibration.py` (agreement ≥ 0.80, false-pass ≤ 0.20 overall *and* on the
judge-family slice) and re-approve the evidence before the judge may gate. The current
corpus contains no `openai`-family records, so that slice is currently empty and simply
does not apply.
