# Penny Evals — What "Better" Means

Penny's promise is not "runs without errors." It is: **a system that compounds
— every session leaves her measurably better at the next one.** This suite
defines "better" operationally and guards it with a regression ratchet.

## The north stars

Everything here rolls up to a few outcomes. If a proposed metric doesn't serve
one of these, it's probably a proxy.

| #   | North star                    | The question it answers                                                 | Primary metrics                                                                          |
| --- | ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| N1  | **Stored ⇒ findable**         | Can Penny recall what she stored, when it matters?                      | `retrieval.golden_recall_hit5`                                                           |
| N2  | **Behavior doesn't drift**    | Does the system still handle the Oracle-authored fixtures correctly?    | `trajectory.pass_rate`, `trajectory.regressed_fixtures`, `trajectory.results_fresh_days` |
| N3  | **Contracts hold**            | Do writers and consumers still agree; is every test actually collected? | all `compat.*` contract checks                                                           |
| N4  | **Capabilities don't weaken** | Are the protected capabilities still enforced?                          | all `invariants.*` checks                                                                |

## Anti-metrics — proxies this suite refuses to gate on

| Proxy                      | Why it lies                                                        | What we track instead                         |
| -------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Drawer / memory count      | Accumulation ≠ learning; 4,000 unfindable drawers are a liability  | golden-recall hit rate; archiver backlog      |
| Warning logs as monitoring | 3,079 WARNs changed nothing; logs nobody reads aren't a control    | delivery checks against the destination store |
| Tests existing             | A test file the runner never collects is reassurance, not coverage | `compat.dead_tests`                           |

## Running

```bash
make evals                  # full suite against the live stores
make evals-update-baseline  # absorb current reality into the ratchet
.venv/bin/python scripts/system/evals/run_evals.py --sections compat   # fast, deterministic
```

## The ratchet (baseline.json)

- **expected_failures** — checks that are known-broken. They show ❌ in the
  scorecard but don't gate. When one starts passing, the runner flags it
  `FIXED`; remove the entry (or rerun `--update-baseline`) to lock the fix in
  as a hard guard. The goal is an empty list.
- **metrics** — last accepted value + tolerance per ratcheted metric.
  Automatic updates only ever **tighten** (move the good direction). Loosening
  a baseline is a human edit with a git diff to answer for.

Run history accumulates in `.penny/evals/history.jsonl` for trend analysis.

## Sections

| Section    | File                 | Needs live stores    | Character                                                                                                                          |
| ---------- | -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| compat     | `eval_compat.py`     | no                   | writer/consumer contracts, dead tests — belongs in `make test`                                                                     |
| invariants | `eval_invariants.py` | no                   | leverage-spine capability invariants — grounded VERIFY, independent verify, HITL gates, checkpoint/resume; regress red if weakened |
| retrieval  | `eval_retrieval.py`  | yes                  | golden-set recall hit@5                                                                                                            |
| trajectory | `eval_trajectory.py` | no (reads artifacts) | behavioral-regression ratchet over Oracle-authored fixtures                                                                        |

Checks SKIP below minimum sample sizes — a rate over three records is noise,
and ratcheting noise trains the baseline on luck.

### Capability invariants (the leverage spine)

`eval_invariants.py` makes the Bitter-Lesson doctrine self-enforcing through the TypeScript orchestration test surface
(`docs/agents/architecture/bitter-lesson.md`). It asserts the protected
capabilities — evidence-grounded VERIFY, separate verification (generator ≠
judge — model-diverse review; the `invariants.independent_verification` check
name is a stable identifier, and evidence independence comes from the evidence
contract, not the model split), HITL gates on high-stakes skills, durable
checkpoint/resume — at the
contract/config level, in-process, no model calls. Per the doctrine's rule
_ratchet on capabilities, not implementations_, each check asserts a capability
(evidence is required; a human gate exists) rather than a code shape, so the
checks don't ossify. Gating checks carry no baseline metric: they pass silently
and **REGRESS loudly** if the capability is weakened. Behavioural invariants
(honest exhaustion) are `informational` — tracked in the scorecard, never
gating on a proxy.

## Curating the golden recall set

`golden_recall.json` is curated, not generated. Whenever recall fails you in
real use — you _knew_ Penny had stored something and she couldn't surface it —
add the query and target drawer as a case. Never delete a failing case; a
failing case is the eval doing its job. Searches run with `track_recall:
False` so measuring recall doesn't fabricate the reuse signal that retention
decisions key on.
