# Evaluation

## Why some numbers were frozen before implementation

Three values could not be chosen honestly after seeing results: the **package surface**, the
**retrieval quality bar**, and the **research observation window**. If any had been selected after
observing an outcome, the "gate" would have measured nothing — it would only have described what
happened.

For the completed implementation gate sequence, each was fixed in an explicit, operator-approved,
independently reviewed decision receipt written before its boundary and digest-recorded:

| Receipt              | Approved | Must predate                                        |
| -------------------- | -------- | --------------------------------------------------- |
| Package surface      | After G2 | The first app-package source write                  |
| Retrieval baseline   | After G6 | Any retrieval implementation, tuning, or result run |
| Research observation | After G5 | The first canary result                             |

Those implementation-time receipts were strict canonical JSON in an ignored, owner-only store. The
approver and independent reviewer were **different** identities, and the review hashed the complete
decision. A model-authored or unreviewed file was not approval. Changing a frozen field invalidated
the implementation evidence gathered under it.

The completed receipts are historical decision evidence, not runtime state and not inputs to the
current test suite. Current regression coverage is self-contained in tracked code and fixtures:

- package-surface tests retain the receipt parser, validator, and exact-comparison unit contracts;
- retrieval scoring reads `apps/orchestration/tests/fixtures/kb-retrieval.json` directly with
  tracked `k = 10` and hit@k/MRR/contradiction-recall floors of `1 / 1 / 1`;
- deterministic answer-quality execution reads the same fixture directly with `k = 10` and a
  maximum bad-answer rate of `0`.

No current regression test requires an owner-local legacy decision receipt.

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

## The gate ladder

| Gate | Established                                                                            |
| ---- | -------------------------------------------------------------------------------------- |
| G0   | External dirty-worktree baseline; no project mutation                                  |
| G1   | Root bootstrap grammar and repository-wide nested `AGENTS.md` purity                   |
| G2   | Canonical KB docs, exact five-file scaffold, privacy admission; no executable KB claim |
| G3   | Compiled Node TypeScript shell and durable checkpointer                                |
| G4   | Frozen research contract/trace parity and complete legacy-test disposition             |
| G5   | Typed terminating results are the sole control boundary; no prose parsing              |
| G6   | One thin two-tool adapter; research canary, rollback, owner-stickiness, privacy        |
| G7   | Profiles, policy, capabilities, storage, generations, retrieval floor, lint floor      |
| G8   | Artifact plane, stateful flows, skill, semantic lint, prepare-only end-to-end          |
| G9   | Signed host-only promotion apply; package and copy-surface hardening                   |
| G10  | Research cutover, owner drain, fresh consumer inventory, evidence-mapped retirement    |
| G11  | Clean-clone release and capability ratchet                                             |

**G6 is non-negotiable.** No stateful KB source, test, workflow, or implementation begins before it.
The reason is ordering, not ceremony: the KB inherits the orchestration engine's typed result
boundary, session isolation, and recovery semantics. Building KB state on an unproven engine would
mean debugging two unproven layers at once and would make a privacy failure impossible to localize.

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
