# AUTO_QA Checklist

AUTO_QA combines deterministic mechanical evidence with an independent semantic
audit. Deterministic checks run first. Vera then verifies that evidence and
audits source/canon mappings; Vera never repairs the candidate. A draft reaches
`OPERATOR_REVIEW` only when the exact unweighted roll-up is `PASS`.

This checklist embeds no topic rules, visual canon, service base URL, primitive
schema, theme, voice, duration cap, or application convention. Those values
come from the normalized caller contract and immutable run snapshots.

## Status, Severity, and Evidence Semantics

### Row status

- `PASS` — the check's pass condition is proven by nonempty, locatable evidence.
- `FAIL` — required evidence proves a violation or a required known state is
  absent. A missing or unknown render job is `FAIL`, not `UNCERTAIN`.
- `UNCERTAIN` — a required observation could not be obtained or evidence cannot
  resolve the judgment. It blocks the roll-up and pauses for clarification or
  evidence recovery.
- `n/a` — the rubric explicitly permits non-applicability and nonempty evidence
  proves why. Only `ALIGN-CONVENTIONS` and `ALIGN-MNEMONIC` permit `n/a`.

Evidenced absence of a registered analogy is a tested `PASS`, not `n/a`.
Omitted length constraints are a reported `PASS`, not `n/a`.

### Severity

Every check has checklist severity `BLOCKING`: `FAIL` or `UNCERTAIN` prevents an
AUTO_QA PASS and therefore prevents operator review, finalization, and handoff.
Severity is checklist metadata and is not an extra key in the exact result row.
A soft duration-guide overage is represented by a `review_flags` entry while
`MECH-CAP` remains `PASS`.

### Evidence reference

Every status, including `n/a`, requires at least one evidence reference with
exact keys:

```json
{
  "kind": "<file|api|probe|source-span|canon-span|command|ledger>",
  "ref": "<absolute artifact path or stable evidence ID>",
  "sha256": "<lowercase SHA-256 or null>",
  "detail": "<compact locatable fact>"
}
```

Bare assertions, empty lists, unlocatable prose, and fabricated command/API
results are invalid evidence.

## Canonical Check Registry

A passing or `n/a` row uses `fix_route: NONE`. A failing or uncertain row uses
the narrowest evidence-supported route from the allowed set below.

| ID | Severity | Evidence type | Owner | Allowed non-pass fix route |
|---|---|---|---|---|
| `MECH-BUNDLE` | BLOCKING | local bundle/schema ledger + import/validation API | `VALIDATE` | `INGEST`, `CODEGEN`, `VALIDATE` |
| `MECH-SCENES` | BLOCKING | storyboard/job/output join + render logs/hashes | `DRAFT_RENDER` | `CODEGEN`, `DRAFT_RENDER` |
| `MECH-ASSEMBLY` | BLOCKING | media probe + concat/order ledger + draft hash | `DRAFT_RENDER` | `DRAFT_RENDER` |
| `MECH-DRIFT` | BLOCKING | measured narration/video durations + signed-tail calculation | `AUTO_QA` | `NARRATION_SCRIPT`, `VOICE_SYNTH`, `CODEGEN` |
| `MECH-CAPTIONS` | BLOCKING | VTT parse + scene/cue coverage + bounds + hash | `AUTO_QA` | `NARRATION_SCRIPT`, `DRAFT_RENDER`, `FINALIZE` |
| `MECH-CAP` | BLOCKING | media duration + resolved cap/guide + comparison | `AUTO_QA` | `STORYBOARD`, `NARRATION_SCRIPT` |
| `MECH-PROVENANCE` | BLOCKING | exact manifest/provenance parse + intake/checksum comparison | `VALIDATE` | `INGEST`, `VALIDATE` |
| `MECH-ACCESS` | BLOCKING | media resolution + storyboard annotations + visual/caption evidence | `AUTO_QA` | `STORYBOARD`, `CODEGEN`, `DRAFT_RENDER` |
| `ALIGN-COVERAGE` | BLOCKING | concept→beat→rendered-scene matrix | `STORYBOARD` | `STORYBOARD` |
| `ALIGN-BOUNDARY` | BLOCKING | claim/equation/visual→source map | `STORYBOARD` | `STORYBOARD`, `NARRATION_SCRIPT`, `CODEGEN` |
| `ALIGN-ARC` | BLOCKING | per-concept intuition/worked-step/formal-close evidence | `STORYBOARD` | `STORYBOARD`, `NARRATION_SCRIPT` |
| `ALIGN-ANALOGY` | BLOCKING | registry binding/absence + section span + frame/narration comparison | `STORYBOARD` | `STORYBOARD`, `NARRATION_SCRIPT`, `CODEGEN` |
| `ALIGN-PRONUNCIATION` | BLOCKING | first-appearance table + pronunciation canon + audio/notation evidence | `NARRATION_SCRIPT` | `NARRATION_SCRIPT`, `VOICE_SYNTH` |
| `ALIGN-CONVENTIONS` | BLOCKING | applicable caller-convention matrix or evidenced non-applicability | `STORYBOARD` | `STORYBOARD`, `NARRATION_SCRIPT`, `CODEGEN` |
| `ALIGN-MATH` | BLOCKING | worked-step/source mapping + equation/frame audit | `STORYBOARD` | `STORYBOARD`, `NARRATION_SCRIPT`, `CODEGEN` |
| `ALIGN-TONE` | BLOCKING | exact narration spans + independent register audit | `NARRATION_SCRIPT` | `NARRATION_SCRIPT` |
| `ALIGN-ROLES` | BLOCKING | narration/visual purpose map + caller policy/canon evidence | `STORYBOARD` | `STORYBOARD`, `NARRATION_SCRIPT`, `CODEGEN` |
| `ALIGN-MNEMONIC` | BLOCKING | source/canon mnemonic mapping or evidenced non-applicability | `NARRATION_SCRIPT` | `NARRATION_SCRIPT` |

## Deterministic Check Adapters and Commands

Checks consume injected observations. QA code does not import service clients,
subprocess runners, media tools, artifact modules, or network packages globally.
Probe exceptions and unavailable observations become evidence-backed
`UNCERTAIN`; malformed caller data raises the QA contract error before roll-up.

### Bundle and renderer API evidence

- Local bundle probe validates exact scene-set correspondence, exact manifest
  keys, storyboard shape, Python syntax/static schema use, narration-bearing
  audio, dependency order, and checksums.
- Import uses `POST /api/bundles/import` with the caller-owned bundle path.
- Project validation uses `POST /api/projects/{project_id}/validate` with no
  body and must return no violations.
- Job reconciliation uses
  `GET /api/projects/{project_id}/jobs?limit=N`; job IDs, terminal statuses,
  scene IDs, output refs, and logs are persisted before evaluation.
- Every adapter call is timeout-bounded, redirect-refusing, exactly once, and
  has no automatic retry. A known-job poll is reconciliation, not retry.

### Media evidence

- `probe_media` executes exactly one command equivalent to:

  ```text
  ffprobe -v error -show_format -show_streams -of json <artifact>
  ```

- The probe records duration, format, size, video streams, and audio streams.
  Nonzero exit, timeout, malformed JSON, missing duration, or undecodable stream
  is unavailable evidence and yields `UNCERTAIN` where observation is missing;
  a successfully observed defective artifact yields `FAIL`.
- Assembly evidence joins the active storyboard order to the concat/order ledger
  and requires no missing or duplicate scene.
- WAV duration comes from the container header/frame count, not file size or word
  count.
- Caption evidence uses strict WebVTT parsing and `caption_coverage`; cue text and
  approved narration are compared after whitespace collapse only. Case and
  punctuation are not discarded.
- Final poster evidence uses the first decoded frame of scene 1's final-quality
  render, no scale/crop, same 16:9 dimensions, MJPEG output, and the pinned
  qscale-2 / quality-85 policy. It never uses the assembled draft or generated
  still imagery.

### Hash and provenance evidence

- Exact source SHA-256 is computed over exact bytes with no normalization.
- Manifest validation enforces set equality with exactly
  `bundle_version`, `video_id`, `primitive_library_version`, and `theme`.
- Provenance identity/hash/bindings/approval/checksums are compared to immutable
  intake and current files.
- Checksum probes return all mismatches; stale, unknown, or incompatible
  provenance cannot pass.
- Final recheck reruns mechanical checks and compares semantic/input hashes to
  the approved draft. Any semantic difference reopens refinement and operator
  review.

## Mechanical Checks

### `MECH-BUNDLE` — Bundle validates

**PASS:** local bundle/schema checks pass; import succeeds; project validation
returns no violations; bundle/schema hashes and declared versions are present
and mutually compatible.

**FAIL:** any observed local/schema/import/validation defect, unsupported
relationship, imagined primitive/parameter, or violation exists.

**UNCERTAIN:** required local or API evidence cannot be obtained after safe
reconciliation. Never downgrade a known schema/version failure to uncertainty.

### `MECH-SCENES` — All scenes render

**PASS:** exact set equality joins each active storyboard scene to one successful
terminal render and one output; there are no omitted, duplicate, failed, or
unknown jobs.

**FAIL:** any expected scene lacks exactly one successful render/output, any
unexpected/duplicate output exists, or any job is failed, missing, or unknown.

**UNCERTAIN:** only when the required join evidence itself cannot be read; a job
whose recorded state is unknown is a known failure.

### `MECH-ASSEMBLY` — Complete draft is valid

**PASS:** assembled MP4 exists, is nonempty and decodable, contains expected
video and required audio streams, has positive duration, includes every scene
exactly once, and follows dependency/order sequence.

**FAIL:** a successful probe/order ledger proves any omission, duplicate,
reorder, missing stream, empty artifact, or decode defect.

**UNCERTAIN:** the required media/order evidence cannot be obtained.

### `MECH-DRIFT` — Narration/scene timing is safe

For every scene calculate signed tail:

```text
tail_seconds = rendered_video_duration_seconds - narration_duration_seconds
```

**PASS:** every narrated scene has rendered video duration greater than or equal
to measured narration duration, every signed tail is nonnegative and less than
or equal to resolved `max_scene_tail_seconds`, and storyboard measured durations
match evidence.

**FAIL:** any video is shorter than narration, any tail exceeds the bound, or any
recorded duration disagrees with measured evidence. Do not clip or speed speech
to force PASS.

**UNCERTAIN:** a required measured duration is unavailable.

### `MECH-CAPTIONS` — Captions are present and usable

**PASS:** nonempty WebVTT exists; cues are ordered and in range; every
narration-bearing scene is covered; whitespace-collapsed cue text exactly covers
the approved narration; no cue exceeds video duration; cue count/text survive
any format conversion.

**FAIL:** caption artifact is absent/empty/malformed, a scene or narration span is
missing, text mismatches, cues overlap/reverse, or a cue is out of range.

**UNCERTAIN:** the caption or timing artifact cannot be observed.

### `MECH-CAP` — Length constraints are honored

**PASS:** duration is always reported. If a hard cap exists, duration is at or
below it. If a soft guide exists, comparison is recorded; over-guide adds a
review flag and remains PASS. If neither exists, evidence records their absence
and no cap failure is invented.

**FAIL:** and only if a supplied hard cap is exceeded or the resolved constraint
evidence is inconsistent.

**UNCERTAIN:** assembled duration or resolved-constraint evidence is unavailable.

### `MECH-PROVENANCE` — Manifest/provenance are complete

**PASS:** manifest has exact four-key set; provenance has exact intake section
identity/content hash, conditional profile evidence, current renderer/voice
bindings, lifecycle-current approval, and matching checksums; repeated handoff
subtrees deep-equal workspace provenance when handoff exists.

**FAIL:** stale/different/unknown identity, changed content, missing/incompatible
binding, extra/missing manifest key, malformed approval, or checksum mismatch.

**UNCERTAIN:** a required current file or binding observation cannot be obtained.

### `MECH-ACCESS` — Baseline accessibility mechanics

**PASS:** evidence proves readable text at 1080p and selected final output,
required information is not color-only, accessibility annotations map to
rendered frames/scenes, and captions are available.

**FAIL:** evidence proves unreadable text, color-only required meaning, missing
annotations for required content, or missing captions.

**UNCERTAIN:** visual evidence cannot inspect readability or non-color meaning.
Resolution alone never proves PASS.

## Content-Alignment Checks

### `ALIGN-COVERAGE` — Every concept is carried

PASS only when every inventoried concept maps to at least one source-backed beat
that appears in at least one rendered scene. Decorative mention is insufficient.
A missing concept or non-rendered mapped beat fails.

### `ALIGN-BOUNDARY` — No new theory

PASS only when every narration claim, equation, and explanatory visual maps to
the finalized section. Prerequisite recall is allowed only when marked as recall
and authorized by section/canon evidence. Any untaught premise or theory
expansion fails.

### `ALIGN-ARC` — Three-phase teaching appears on screen

PASS only when each concept contains an unlabeled source-backed intuition hook,
every atomic worked step visibly in order with a check, and a formal close that
maps the same objects/steps into notation as a compact restatement. If the
section cannot support the complete arc, block upstream; never pass a degraded
arc.

### `ALIGN-ANALOGY` — Analogy identity is exact

When a registry binding exists, PASS requires that exact analogy, key property,
and orientation, with no switch/addition. When none exists, PASS requires
absence evidence plus a source-backed intuition hook and no invented everyday
analogy. Ambiguous/conflicting evidence is `UNCERTAIN`; a switched or added
analogy is `FAIL`.

### `ALIGN-PRONUNCIATION` — Symbols and terms are speakable

PASS requires every first appearance to use caller pronunciation canon while
matching notation is visible. A missing, conflicting, or mismatched required
pronunciation fails or is uncertain according to the evidence, and blocks voice
progress until resolved.

### `ALIGN-CONVENTIONS` — Caller conventions hold

PASS requires every applicable caller-supplied convention to hold in narration
and frames. `n/a` is permitted only when nonempty evidence proves no supplied
convention applies. This generic check contains no domain convention.

### `ALIGN-MATH` — Visuals remain honest

PASS requires correct simplification, every source-backed worked step, no hidden
transformation, and LaTeX-quality screen mathematics. Any false implication,
skipped step, incorrect calculation, or ASCII substitute fails.

### `ALIGN-TONE` — Adult quasi-formal register

PASS requires warm, precise, concise, engaging, lightly playful spoken delivery
without kiddy, patronizing, plot-driven, fact-obscuring, or imprecisely casual
language. Audit exact narration spans, not a summary.

### `ALIGN-ROLES` — Media roles are disciplined

PASS requires narration to teach and visuals to demonstrate. Any character use
must have positive caller policy/canon evidence and remain concept-serving and
brief. Plot, untaught theory, or replacing the worked example fails. Absence of
character use is valid.

### `ALIGN-MNEMONIC` — Existing mnemonic survives

PASS requires every source/canon mnemonic to land at concept closure without
inventing a new one. `n/a` is permitted only when nonempty evidence proves none
exists.

## Exact QA Result and Report Schema

Each result row has exactly six keys:

```json
{
  "id": "MECH-BUNDLE",
  "status": "PASS",
  "evidence": [
    {
      "kind": "file",
      "ref": "<locatable evidence reference>",
      "sha256": "<lowercase SHA-256 or null>",
      "detail": "<compact fact>"
    }
  ],
  "owner": "VALIDATE",
  "affected_scene_ids": [],
  "fix_route": "NONE"
}
```

Rules:

- `id` is one of the exact 18 IDs in the registry; every report contains each ID
  exactly once, in mechanical-then-alignment registry order.
- `status` is exactly `PASS`, `FAIL`, `UNCERTAIN`, or lowercase `n/a`.
- `evidence` is nonempty and every item has exact EvidenceRef keys.
- `owner` is the canonical nonempty owner from the registry.
- `affected_scene_ids` is sorted and unique.
- `fix_route` is `NONE` for PASS/`n/a`; otherwise it is the narrowest allowed
  uppercase domain phase.
- Unknown/duplicate/missing IDs, unknown keys, unauthorized `n/a`, malformed or
  empty evidence, empty owner, unsorted/duplicate scene IDs, or illegal route is
  a contract error before roll-up.

The report has this exact typed shape; `QAResult[18]` means an array containing
all 18 exact six-key rows, not a literal placeholder value:

```text
QAReport = {
  "schema_version": 1,
  "verdict": "PASS" | "FAIL" | "UNCERTAIN",
  "checks": QAResult[18],
  "counts": {
    "PASS": nonnegative_integer,
    "FAIL": nonnegative_integer,
    "UNCERTAIN": nonnegative_integer,
    "n/a": nonnegative_integer
  },
  "blocking_ids": registry_order_unique_check_id_array,
  "uncertain_ids": registry_order_unique_check_id_array,
  "review_flags": json_object_array
}
```

The top-level key set and `counts` key set are exact. Counts must equal the row
statuses; `blocking_ids` contains exactly the failing IDs in registry order and
`uncertain_ids` exactly the uncertain IDs in registry order. `review_flags`
contains compact JSON
objects such as a soft-guide comparison; it
does not change the verdict. Vera's SUMMARY must reference the report path/hash,
repeat all 18 validated rows, provide rationale, and use verdict exactly
`PASS|FAIL|UNCERTAIN`. Vera's `met` is true if and only if verdict is `PASS`.
A bare PASS, an empty evidence row, or disagreement with deterministic roll-up
is invalid.

## Roll-Up Rules

The roll-up is unweighted and ordered:

1. Any `FAIL` → report verdict `FAIL`.
2. Otherwise any `UNCERTAIN` → report verdict `UNCERTAIN`.
3. Otherwise, when every row is `PASS` or authorized evidence-backed `n/a` →
   report verdict `PASS`.

`n/a` never means omission and never counts as evidence-free PASS. No score,
majority, severity weight, operator preference, or model rationale can override
these rules. Failures route to the earliest owning phase, then full validation,
full AUTO_QA, and operator review run again.

## Operator Review Packet Integration

AUTO_QA PASS is embedded in the exact persisted gate packet below. There are no
additional top-level keys:

```json
{
  "gate": "operator_review",
  "run_id": "<durable run id>",
  "iteration": 0,
  "draft_video_path": "<absolute caller-workspace path>",
  "draft_video_sha256": "<lowercase SHA-256>",
  "captions_path": "<absolute caller-workspace path>",
  "duration_seconds": 0.0,
  "content_sha256": "<lowercase SHA-256>",
  "storyboard_summary": [
    {
      "scene_id": "<stable scene id>",
      "concept_ids": ["<stable concept id>"],
      "purpose": "<source-grounded purpose>",
      "analogy_id": null,
      "narration_summary": "<compact narration summary>"
    }
  ],
  "auto_qa": {
    "verdict": "PASS",
    "report_path": "<absolute report path>"
  },
  "changes_since_last_review": []
}
```

The packet is stored and hashed before the durable pause. Review responses are
exactly approve, abort, or refine with nonempty feedback. Approval binds the
stored draft/content/protected hashes; any change invalidates the packet and
reopens validation/QA.

QA evidence is summarized in `{sid} Auto QA i{n}` and the packet/response in
`{sid} Operator Review i{n}`. Full reports remain under caller-owned paths.

## Required Fixtures

Hermetic tests provide one clean aggregate fixture plus isolated failures. Each
fixture names the expected check/status/evidence/fix route and report verdict.

| Fixture | Required oracle |
|---|---|
| `clean` | All IDs PASS or authorized evidence-backed `n/a`; roll-up PASS |
| `failed` | Generic isolated blocking row; roll-up FAIL |
| `stale` | `MECH-PROVENANCE` FAIL |
| `captionless` | `MECH-CAPTIONS` FAIL |
| `over-cap` | `MECH-CAP` FAIL only when a hard cap exists |
| `over-guide` | `MECH-CAP` PASS plus review flag |
| `drifted` | `MECH-DRIFT` FAIL for negative or over-bound signed tail |
| `schema-hallucinated` | `MECH-BUNDLE` FAIL and route to `CODEGEN` |
| `analogy-switched` | `ALIGN-ANALOGY` FAIL |
| `theory-expanded` | `ALIGN-BOUNDARY` FAIL |
| `convention-broken` | `ALIGN-CONVENTIONS` FAIL |
| `kiddy-tone` | `ALIGN-TONE` FAIL |
| `probe-unavailable` | Evidence-backed `UNCERTAIN`; roll-up UNCERTAIN |
| `unauthorized-na` | Contract rejection before roll-up |

All 18 IDs require isolated PASS and FAIL coverage. Finalization additionally
reruns mechanical checks, verifies semantic hash equality with the approved
draft, and captures poster/media evidence before `PUBLISH_HANDOFF`.
