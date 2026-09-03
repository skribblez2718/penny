# Decide candidate

`decide` is a source-defined orchestration candidate. It is model-visible: native discovery and Penny's model-facing catalog may describe it, but visibility grants no execution authority. It remains outside the production registry and never self-enables or promotes; ignored host configuration may reversibly enable explicit `skill` invocation for the exact candidate contract digest.

```text
intake → analyzing_decision (Annie) → decision_evidence_gate (host)
       → [typed gap only] gathering_decision_evidence (Echo) → deciding (Demetri)
       → sealing_decision (host) → verifying_decision (Vera)
       → critiquing_decision (Carren) → admitting_decision (host) → complete
```

Reviewer evidence and analysis gaps use engine-owned routes back through Annie and the explicit evidence gate; product gaps return to Demetri. Every repaired product is resealed and re-verified. Exhausted or stalled work terminates as `incomplete` with the exact typed reason and without resetting the state counter; cancellation is `cancelled`. Typed engine faults remain out-of-band `error` results and are not Decide flow states.

## Frozen boundaries

- Annie analyzes; the host validates and persists the typed evidence admission; only Echo may acquire narrowly targeted read-only local/web evidence for the exact admitted gap when caller constraints permit; Demetri authors; Vera verifies validity; Carren alone approves quality; the host seals, mints receipts/envelopes, and performs final completion admission. Echo records source locators and reports unresolved evidence honestly.
- Ordinary candidate phases omit `allowed_tools`, so each assigned catalog agent's exact YAML tool list is active. `artifact_read` is mandatory for exact workflow predecessors and no other channel may substitute for missing refs. Other YAML tools are usable only when materially relevant and allowed by caller/task and phase consequence boundaries. Normal-phase external calls are capped at 8 per worker and 64 per run; routing-only repair remains at 0. This is not OS/process sandboxing and does not isolate provider extension code.
- Exact artifact handoff is mandatory. Request, analysis, evidence packet, draft, review, receipt, and feedback refs are transport lineage, never semantic basis IDs. Only admitted exact `GroundedSynthesisV1` refs may be artifact basis IDs.
- `DecisionV2` remains the canonical semantic product with `execution_started:false`.
- Host-derived validity and quality receipts bind the exact latest product, admitted upstream digest, report, reviewer verdict, and signed execution result. Quality depends on validity.
- A deterministic integrity artifact and `DecisionProductEnvelopeV1` bind the full exact graph, including the host evidence-admission artifact and one-to-one accepted worker execution evidence.
- `complete/met:true` requires Carren APPROVE over the current Vera-passed product. Valid `unresolved` and `not_applicable` assessments may complete. Missing exact material is `incomplete` with a typed reason; it creates no internal clarification state.
- No execution, taskification, external mutation, false sandbox claim, native registration, promotion, or enablement authority exists.

## Review and repair

Vera FAIL and Carren NEEDS_REVISION expose only one closed `gap_kind` with its owner, never a target state. Carren cannot approve a major or critical finding. Product repair returns to Demetri, then host sealing and Vera. Analysis or evidence repair returns to Annie; only Annie's newly accepted typed gap may reopen bounded Echo, which then hands directly to Demetri. Stale receipts cannot complete a revised product.

The unsealed evaluation registration remains a deliberately narrow Demetri-only ablation and is not the orchestrated candidate product path.

## Provider-free evaluator preparation

The additive `penny.decision-semantic-evaluation.v3` wire retains the bounded `rationale_report` plus every Decision semantic field while excluding execution, transport, provenance, arm, receipt, artifact, and performance metadata. Symmetric sealed-candidate, unsealed-ablation, and direct-baseline normalizers target that wire. Its six explicit clause IDs map exactly to child-plan §9.3.

The deterministic grader may `FAIL` only closed task-oracle facts such as sets, enums, feasibility/recommendation relations, basis coverage, and disposition boundaries. Matching structure remains `UNVERIFIABLE` for every substantive prose/evidence clause until an independently authorized semantic judge reviews it; no keyword table, required report term, exact prose equality, or projection digest can create a semantic `PASS`. The separate review-output contract requires per-clause `PASS|FAIL|UNVERIFIABLE` with bounded reasons and exact refs, and aggregate success requires every applicable clause to be `PASS`.

Provider-free checks cover bidirectional clause ownership, candidate/baseline/ablation symmetry under meaning-preserving rationale rewording, reason/ref bounds, closed oracle markers, known-good/bad/boundary blocking, and metadata isolation. They do not formally qualify the evaluator or authorize native-production admission/promotion. Separately authorized practical live smokes and reversible exact-digest candidate enablement are independent of this optional formal evaluator path.

## Preserved provider-free harness control

The active public `decide-provider-free-evaluator-preparation-v1` plan is a harness self-test over the unchanged development population, not a Part-B measurement or an admission decision. The prior `decide-development-known-delta-v1` plan-binding bytes remain preserved. Its frozen schedule has one held-out pair and one repetition: direct Demetri baseline, orchestrated `decide`, and `decide-unsealed`, for three independently normalized and graded trials. Each completed trial contributes one `task_score`; workflow phases, reviewer turns, and diagnostic mutation cases are not additional scored trials.

| Frozen measurement                            |     Expected deterministic value |
| --------------------------------------------- | -------------------------------: |
| Scheduled / complete trials                   |                            3 / 3 |
| Baseline primary mean                         |                                0 |
| Orchestrated candidate primary mean           |                                1 |
| Candidate minus baseline                      | +1 (material-effect floor: +0.5) |
| Protected-capability mean / floor             |                            1 / 1 |
| Trigger precision / floor                     |                            1 / 1 |
| Negative-transfer rate / ceiling              |                            0 / 0 |
| Candidate-to-baseline cost ratio / ceiling    |                       1.1 / 1.25 |
| Candidate-to-baseline latency ratio / ceiling |                       1.1 / 1.25 |
| Unsealed primary mean                         |                                1 |
| Candidate minus unsealed / floor              |                            0 / 0 |

The separate eight-case mutation diagnostic exercises terminal validation and composition. The current validator rejects every invalid draft in both orchestrated and unsealed paths (zero escapes for each), so this development plan freezes `mutation_gate:null`; those diagnostics do not alter the three-trial aggregate. The deterministic harness disposition is `CANDIDATE`, but that word is only the plan's self-test outcome and grants no registration, admission, promotion, or enablement.

The archived safe-recovery replay is likewise diagnostic and non-controlling. It preserves 8/60 recorded normalized historical trials and projects 53/60 under the repaired normalizer (45 recovered) without rewriting historical result bytes or disposition. It is not the active three-trial schedule, not a per-run score, and not evidence of current provider-backed quality.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `DECIDE_FLOW`.
It is checked by `tests/decide-flow.test.ts`, the shared drift test, and
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill decide`.
Uniform incomplete/cancelled seams and out-of-band engine errors are documented,
not invented as descriptor edges.
