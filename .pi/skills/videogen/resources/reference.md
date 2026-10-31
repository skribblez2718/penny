# Videogen runtime reference

These contracts drive the registered executor. Isolated protocol fixtures are not production qualification evidence.

## Cognitive states

| State                | Accountable agent | Semantic schema                        |
| -------------------- | ----------------- | -------------------------------------- |
| `brief_analysis`     | annie             | `penny.videogen-brief-analysis.v1`     |
| `research_fact`      | echo              | `penny.videogen-fact-research.v1`      |
| `story_options`      | ida               | `penny.videogen-story-options.v1`      |
| `story_choice`       | demetri           | `penny.videogen-story-choice.v1`       |
| `story_plan`         | piper             | `penny.videogen-story-outline.v1`      |
| `script_text`        | skribble          | `penny.videogen-script-draft.v1`       |
| `story_check`        | annie             | `penny.videogen-coverage-review.v1`    |
| `look_check`         | annie             | `penny.videogen-look-review.v1`        |
| `reference_verify`   | vera              | `penny.videogen-objective-review.v1`   |
| `reference_critique` | carren            | `penny.videogen-quality-review.v1`     |
| `animatic_plan`      | piper             | `penny.videogen-animatic-plan.v1`      |
| `route_choice`       | demetri           | `penny.videogen-route-choice.v1`       |
| `draft_verify`       | vera              | `penny.videogen-objective-review.v1`   |
| `draft_critique`     | carren            | `penny.videogen-quality-review.v1`     |
| `rough_review`       | vera              | `penny.videogen-objective-review.v1`   |
| `rough_critique`     | carren            | `penny.videogen-quality-review.v1`     |
| `final_verify`       | vera              | `penny.videogen-objective-review.v1`   |
| `final_critique`     | carren            | `penny.videogen-quality-review.v1`     |
| `master_verify`      | vera              | `penny.videogen-objective-review.v1`   |
| `master_critique`    | carren            | `penny.videogen-quality-review.v1`     |
| `evidence_synthesis` | synthia           | `penny.videogen-evidence-synthesis.v1` |

## Policy-led repair declarations

Derive values from actual operator policy, not test constants or model guesses. The engine records repair use and enforces actual operator iteration limits and finish reservations when present; unspecified limits remain optional, not guessed finite defaults. Cancellation, trusted progress/inactivity, measured errors, current approval, exact custody and honest `incomplete` exhaustion remain binding. Malformed output stays on the engine routing-repair path, not this table.

| Origin               | Evaluation       | Earliest repair producer |
| -------------------- | ---------------- | ------------------------ |
| `brief_analysis`     | `analysis_gap`   | `brief_analysis`         |
| `research_fact`      | `evidence_gap`   | `research_fact`          |
| `story_options`      | `analysis_gap`   | `story_options`          |
| `story_choice`       | `analysis_gap`   | `story_options`          |
| `story_plan`         | `product_gap`    | `story_plan`             |
| `script_text`        | `product_gap`    | `script_text`            |
| `story_check`        | `validation_gap` | `story_plan`             |
| `story_check`        | `product_gap`    | `script_text`            |
| `look_check`         | `analysis_gap`   | `asset_prepare`          |
| `reference_verify`   | `validation_gap` | `asset_prepare`          |
| `reference_critique` | `product_gap`    | `asset_prepare`          |
| `animatic_plan`      | `product_gap`    | `animatic_plan`          |
| `route_choice`       | `analysis_gap`   | `route_choice`           |
| `draft_verify`       | `validation_gap` | `shot_prepare`           |
| `draft_critique`     | `product_gap`    | `shot_prepare`           |
| `rough_review`       | `validation_gap` | `rough_build`            |
| `rough_critique`     | `product_gap`    | `rough_build`            |
| `final_verify`       | `validation_gap` | `final_prepare`          |
| `final_critique`     | `product_gap`    | `final_prepare`          |
| `master_verify`      | `validation_gap` | `finish_prepare`         |
| `master_verify`      | `product_gap`    | `final_prepare`          |
| `master_critique`    | `product_gap`    | `finish_prepare`         |
| `evidence_synthesis` | `synthesis_gap`  | `evidence_synthesis`     |

## Evidence rules

The fixed semantic catalog checks exact project artifact bytes, canonical JSON, closed fields and bounded representation. Plural state inputs use contiguous `<port>-0`, `<port>-1` slot names; scalar ports use their exact names. Every post-admission nonterminal inherits one envelope (`Q`), dependency ledger (`L`) and all applicable earlier gate refs. Optional child and synthesis preflights also require their closed host-selected `parent_state` or `return_state` controls; synthesis needs two distinct captured refs. Structural port checking does not authorize an effect or validate a gate response.

Workers use slot labels, never ArtifactRefs. The host alone binds review results to exact targets, model capability and evidence. Sampled PNGs do not establish motion, sound, intelligibility or sync. A full AV playback record must be captured independently and bound to current master bytes. Domain wrappers may cite an already settled receipt; a receipt cannot depend on a later wrapper that cites it.

G1 authorizes bounded image/voice previews; G2 selects actual versions. G3 bounds drafts; G4 requires an actual moving rough cut and bounds finals. G5 accepts exact current master/package, not a new destination. Delivery is local, exclusive and non-overwriting. Missing evidence always remains non-positive.

## Private host binding

`VideogenRuntimeProvidersV1` supplies the exact project ID; closed activation/configuration; fixed recipes; registered effects; and optional controlled imagegen policy/native requests. A recipe declares fields, exact artifact-slot substitutions and immutable operation policy; it cannot evaluate a workflow phase. The service constructs concrete same-project owner bindings and validates current gates on every effect recovery/cache path.

`constraints` is the full `penny.videogen-request.v1` request. The request is captured before the first cognitive stage. Missing configuration or disabled activation refuses before run creation.

For independent playback, recover the exact run with the existing `skill` tool in trusted interactive Pi. At the final-playback clarification, its registered native UI provider asks the actual user for the exact file path and device profile through `questionnaire`; unknown inputs have no defaults. Native completion returns the read-only viewer URL and a new one-time review questionnaire capability. Only actual interactive input is signed and submitted to the retained owner, which captures a fully positive complete-AV attestation through the existing `captureVideogenPlaybackForRun` API. Negative/cancelled input stays blocked. The original engine clarification and G5 approval remain separate responses. No Bash subprocess or manual JavaScript call is needed. See the [operator procedure](../../../../apps/orchestration/VIDEOGEN-HUMAN-REVIEW.md). The signature proves transport custody, not authenticated identity or actual watch proof.

## Production evidence status

`VideogenProductionDossierV1Schema` binds one distinct UC route to a run, exact terminal, manual review, qualification refs and timestamp. `videogenCapabilityStatus` verifies exact custody and keeps isolated fixtures separate from production. All 18 routes must have production evidence before `whole_skill_supported` is true. No route production, live editor qualification, actual voice performance or legal clearance is asserted by offline executor tests.

Optional informational child workflows use separate parent-only authority at declared states; exact results return to the original worker. Objective contradictions route to synthesis and then a fresh verifier pass. Unresolved synthesis or repeated identical conflicts remain non-positive. Missing providers or proof are never silently skipped.

The default extension can load the explicit private JSON binding described in [private-runtime.md](private-runtime.md). Loader tests through G1 and isolated full-flow fixtures are not evidence of a complete default-manifest production.
