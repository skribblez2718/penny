# Evaluation

## Current regression baseline

Current regression coverage is self-contained in tracked code and fixtures; no owner-local legacy decision receipt is a current test input:

- package-surface tests retain the receipt parser, validator, and exact-comparison unit contracts;
- retrieval scoring reads `apps/orchestration/tests/fixtures/kb-retrieval.json` directly with tracked `k = 10` and hit@k/MRR/contradiction-recall floors of `1 / 1 / 1`;
- deterministic answer-quality execution reads the same fixture directly with `k = 10` and a maximum bad-answer rate of `0`.

For a new implementation comparison, freeze the package surface before its first app-package source write, the retrieval baseline before retrieval implementation/tuning/result runs, and the observation cohort before the first canary result. Each decision requires explicit operator approval, an independent reviewer distinct from the approver, and a digest over the complete decision in strict canonical JSON. A model-authored or unreviewed file is not approval. Changing a frozen field invalidates the evidence collected under it. Historical implementation receipts do not supply runtime state or present-day qualification.

## Objective oracles

**Package.** The implementation-time oracle deep-compared canonicalized package `name`, `version`,
`private`, `exports`, `bin`, and `scripts` against its decision, then required exact sorted equality
with the parsed pack dry-run file list. Any extra or missing field or file failed. Current tracked
unit tests preserve the closed decision contract, parser hardening, dry-run parsing, and exact field
and file comparison without loading the historical live receipt.

**Retrieval.** Over a closed, synthetic, non-personal fixture with unique corpus and cases:

- `hit@k` — the fraction of cases whose top-k intersects the labeled relevant set
- `MRR` — mean reciprocal rank of the first relevant result, scoring 0 when none is retrieved
- `contradiction recall` — the micro fraction of labeled contradiction pairs for which **both**
  endpoint claims appear in the top-k

These three core floors gate G7. A fixture with zero labeled contradiction pairs is invalid, so the
metric can never be satisfied by having nothing to find.

**Answer quality.** At G8 every fixture case must produce exactly one scored final result. A case is
**bad** when its result is missing, is not `complete, met: true`, cites anything outside the
supported citation set, or has an unsupported claim reported by verification. Abstentions and errors
count as bad rather than being excluded from the denominator — otherwise a system could improve its
score by refusing more often.

**Observation.** The cohort fixes research fixtures, runtime configuration, the exact model set,
cases, repetitions, fault modes, and the cost unit before the canary. Every scheduled case and
repetition must have **exactly one** baseline run and one candidate run with the same bound inputs,
budgets, models, and tools. Metrics use all and only those pairs; no post-start exclusion is
permitted, and a missing or nonterminal pair fails the gate.

Latency is measured for **every** terminal outcome including refused, error, exhausted, and
fault-recovery cases — not only successes — with p95 by nearest rank. Cost includes every pair and
fails if provider-reported cost is missing.

A **parity mismatch** is any unequal field in the normalized, language-neutral projection, except a
delta explicitly prelisted in the frozen normalization rules. The projection replaces run-local IDs
with first-appearance ordinal tokens, sorts identity collections, and omits timestamps, latency, and
cost — so two engines are compared on behavior, not on incidental identifiers.

Privacy incidents, recovery failures, and unexplained parity mismatches all have a maximum of
**zero**. Later gates cannot infer, exclude, or weaken an absent value.

## Implementation history versus current gates

The G0–G11 sequence records implementation chronology, not a present-day bootstrap prohibition. Its former pre-G6 ordering rule is not a gate on maintaining the completed KB. Current changes must preserve the typed engine-result boundary, session isolation, recovery, privacy, approval, and metric requirements below and supply current evidence; a historical milestone cannot substitute for it.

## Capability tests, not implementation tests

The release gate asserts **language-neutral capabilities**: grounded typed results, separate
verification, checkpoint and resume, gates, honest exhaustion, the frozen retrieval and answer-
quality thresholds, contradiction and evidence-gap lint, the query/lint publication snapshot and
allowed-delta oracles, opaque source identity and its distinct digest roles, source and revision
immutability, old/new generation views, profile-safe restart, deny-before-session, path-free
handles, parent delivery, approval cryptography and single use, and byte-preserving rollback.

These survive an implementation rewrite. The completed implementation-time decisions remain tied
to their historical receipts and evidence. Current tracked regression fixtures and constants change
through an explicit reviewed repository update with corresponding regression evidence; they are not
reconstructed from owner-local receipts.

A completion claim must carry current command and test evidence and must name anything it did not
verify.
