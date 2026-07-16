# Graduated Autonomy

Operational reference for `scripts/system/autonomy/`. Human rationale: [Graduated Autonomy (Human)](../../../humans/capabilities/graduated-autonomy/graduated-autonomy.md).

## What It Is

"Almost autonomous" can't be a global switch — trustworthy at renaming a variable ≠ trustworthy at a schema migration. This composes two machine-checkable signals into an act-vs-ask decision on reversible work, with a permanent human floor on the actions that matter.

## The Decision (gate.py)

```
if reversibility(action) in (irreversible, destructive):  ASK   # hard rule, first
elif trust(domain) >= threshold and graduated(domain):    ACT   # unattended
else:                                                     ASK
```

The hard rule comes first and **no trust score overrides it**. (When `PENNY_AUTONOMY_REVERSIBILITY_MODEL` is enabled, `reversibility(action)` above is the *vetoed* verdict — see [Reversibility veto](#reversibility-veto--optional-model-second-opinion-penny_autonomy_reversibility_model) below.)

## Components

| File | Role |
|------|------|
| `action_classes.py` | `classify(text) → ActionClass(domain, operation, reversibility)`. Keyword taxonomy, **most-severe rule wins**, unknown → irreversible (ask). Reversible = undoable (edit/summarize/plan/draft); irreversible = deploy/send/merge/publish; destructive = delete/drop/wipe/overwrite. Also `model_veto_reversibility(...)` — the optional, veto-only model second opinion (see below). |
| `trust.py` | `compute_trust(outcomes, domain, now, false_pass_rate) → TrustScore`. Per-domain, earned from the ledger. |
| `gate.py` | `decide(...)` (pure) and `decide_live(action)` (against the live ledger + verifier cap). |
| `dashboard.py` (`make trust`) | Per-domain trust + sample gate decisions. |

## Reversibility veto — optional model second opinion (`PENNY_AUTONOMY_REVERSIBILITY_MODEL`)

The keyword taxonomy is a conservative floor, but it has one residual blind spot: a **keyword false positive** — an action that matches a `REVERSIBLE` rule yet is actually dangerous (e.g. "update config to shorten data retention", "toggle off the nightly backup"). Unknown verbs already fall to `irreversible → ask`; the only gap is a reversible-*looking* phrasing of a harmful action.

`model_veto_reversibility(action_text, base_reversibility, runner=)` closes it, **veto-only**:

- **Consulted only when the keyword verdict is `REVERSIBLE`** (the sole act-eligible case) and `PENNY_AUTONOMY_REVERSIBILITY_MODEL` is set to a `provider/model` spec. Unset (default) ⇒ byte-identical to the keyword-only gate; irreversible/destructive classes never spend a model call.
- **Monotone — most-severe wins.** The model emits a label from the same `{reversible, irreversible, destructive}` taxonomy; the effective verdict is the *most severe* of {keyword, model}. So the model can only move a verdict **away** from `REVERSIBLE` (adding an ASK) — it can **never** upgrade a non-reversible verdict into an ACT. The deny-by-default floor is preserved by construction; a better model catches more false positives without ever loosening the gate.
- **Fail-safe, never raises.** Any transport/parse failure keeps the keyword verdict (zero behavior change); a **low-confidence** answer on a reversible action is treated as a veto (force ASK), per the `classify_gate_intent` precedent ("never silently approve on ambiguity"). Uses the shared `pi_json_call` caller (`timeout 30s`); `classify()` itself stays pure/deterministic — the model layer lives only in `decide()`/`decide_live()`.
- **Audit:** a veto shows in `Decision.reason` ("model second opinion flagged this '<class>' …"). No separate audit store (v1).

Tested hermetically in `tests/test_autonomy.py` via an injected `runner`: veto forces ASK, disabled = byte-identical, model failure falls back, a model 'reversible' cannot upgrade a keyword irreversible/destructive, and low-confidence vetoes.

## Trust Properties (all enforced + tested)

- **Starts at zero.** No outcomes → no trust → ask. Trust is earned.
- **Low sample caps trust low** (`confidence = min(1, weighted_n / FULL_SAMPLE=8)`) — no trust from 2 data points.
- **Recent MISMATCH decays hard** — recency half-life 14d, and a MISMATCH counts as `FAILURE_WEIGHT=3` failures in the rate, so one recent failure pulls a high-trust domain back below the act threshold (slow to earn, fast to lose).
- **Capped by the verifier's false-pass rate** (from the `judgment` eval's latest artifact): `trust ≤ 1 − false_pass`. You cannot be more confident in unattended work than your ability to catch it being wrong.

## Why "almost" — the permanent human floor

1. Irreversible/destructive actions **always** ask.
2. New / low-sample domains ask (trust is earned first).
3. The `make rate` / auto-capture loop keeps generating the outcomes that maintain or decay trust — and every autonomous ACT records one.

## Engine wiring (live)

`decide_live` is wired into the orchestration engine's action path. `BasePlaybook` declares `AUTONOMY_STATES` (action-taking states, must be a subset of `ESCALATABLE_STATES`); in `_advance_to` — the forward-transition path, so recovery re-issues never re-trigger it — the engine calls `engine._autonomy_ask_reason(self.autonomy_action(state, ctx))` before dispatching an action state. When the gate returns ASK, the engine escalates to the human via the existing HITL path (`_escalate` → `awaiting_clarification`) instead of proceeding; on ACT it dispatches normally.

- **Opt-in and dormant by default.** The gate consults the ledger only when `PENNY_AUTONOMY_GATE` is set. Unset (the default) ⇒ `_autonomy_ask_reason` returns None immediately ⇒ zero behavior change to existing runs. Best-effort: any failure loading the autonomy module means no gating.
- **Wired playbook:** `CodePlaybook.AUTONOMY_STATES = {"implementing"}` — before writing/changing code, the engine asks act-vs-ask on the run's goal. Tested in `apps/orchestration/tests/test_autonomy_gate.py` (dormant-by-default, escalates-on-ASK, proceeds-on-ACT, goal-is-the-action-text).
- `autonomy_action(state, ctx)` (overridable) selects the text classified; default is `ctx.goal`.

The calibration graduation gate (`graduated(domain)`) remains an optional hook — pass a per-domain `calibration_gap`-based predicate when `quality.calibration_gap_90d` has per-domain data.

Current state: with a thin ledger every domain reads zero trust → everything asks, the correct safe starting state; domains graduate to ACT as outcomes accumulate. Enable the engine gate with `PENNY_AUTONOMY_GATE=1` once the ledger has enough per-domain history to graduate.
