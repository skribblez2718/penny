# Storyboard Conventions

The storyboard is the human-editable design record and the machine-checkable
bridge between source coverage, narration, live renderer primitives, measured
audio, scene code, refinement, and QA. It is generic: all concrete content and
canon arrive from the caller.

## Relationship to the Live Renderer Schema

- The run-time primitive schema snapshot and the live Superpose storyboard
  schema are authoritative. This resource does not duplicate either schema.
- `storyboard.json` must satisfy the schema accepted by the caller-selected
  renderer and must contain the live-required scene fields, including
  `scene_id`, `title`, `narration`, `visuals`, `duration_hint`,
  `measured_duration`, and `depends_on` when required.
- Each visual records a primitive by its exact schema name and records only
  parameters allowed by the immutable schema snapshot.
- Never infer a primitive, parameter, default, or library version from this
  document. Unknown or incompatible names route to `CODEGEN` before rendering.
- The storyboard hash binds the exact candidate reviewed by Carren, used by
  codegen, validated in the bundle, and presented at operator review.

## Stable Identifier Rules

### `scene_id`

- A scene receives one path-safe, nonempty `scene_id` when first accepted into
  the storyboard.
- The ID is opaque identity, not a mutable title, sequence number, timestamp,
  filename, concept name, or narration summary.
- An unaffected scene keeps the same ID and relative identity through every
  refinement. Never renumber all scenes after an insertion, deletion, or reorder.
- Scene code, audio, captions, render jobs, cache records, feedback notes,
  checksums, and QA evidence use the same ID.
- IDs are unique within the run and are never recycled for a semantically
  different scene.

### `beat_id`

- Every teaching action receives one stable `beat_id` when first accepted.
- A beat ID remains stable while its teaching purpose and source claim remain
  materially the same, even when wording, timing, or primitive parameters change.
- A materially new teaching action receives a new ID. A retired beat ID remains
  in lineage/history and is not reused.
- Beats are unique within the run and map to exactly one current scene; coverage
  and feedback may still reference retired lineage explicitly.

## Scene Record Discipline

Each scene records at least:

- stable `scene_id` and human-editable `title`;
- one concise pedagogical `purpose`;
- ordered `concept_ids` and source-span references;
- exact narration or an explicit approved-silence marker;
- ordered visuals with `beat_id`, beat type, source/claim reference, primitive
  schema name, schema-valid parameters, and duration;
- dependency IDs and current order position;
- `duration_hint` from planned visual beats;
- `measured_duration` once narration/render evidence exists;
- accessibility annotations for readable text, non-color-only meaning,
  narration/visual redundancy, and captions;
- narration and visual-input hashes used by the refine/cache loop; and
- any caller-authorized canon references needed to verify the scene.

A scene title or summary is descriptive only. It does not replace source spans,
coverage rows, exact narration, or visual beat evidence.

## Coverage and Source Maps

Maintain both directions:

1. **Concept → beat → scene coverage matrix**
   - one row per concept in Annie's inventory;
   - source span, covered `beat_id` values, rendered `scene_id` values, and
     verification evidence;
   - every concept must reach at least one teaching beat in one rendered scene.

2. **Claim → source reverse map**
   - one row per narration claim, equation, and explanatory visual;
   - owning scene/beat plus exact section or caller-canon evidence;
   - prerequisite recall is marked as recall and requires explicit authorization.

Decorative mention is not concept coverage. A claim without source evidence
fails the source boundary rather than being accepted as helpful context.

## Beat Types

Use these semantic beat types; they describe teaching function, not renderer
APIs:

- `intuition` — the registered analogy when one exists, otherwise a source-backed
  intuition hook;
- `worked_step` — exactly one visible source-backed transformation;
- `verification` — the visible check that closes a worked example;
- `bridge` — a source-backed transition between already-taught ideas;
- `formal_mapping` — maps the same concrete objects/steps to formal notation;
- `mnemonic_landing` — delivers an existing section/canon mnemonic at concept
  closure; and
- `character_reaction` — optional, brief, and present only with positive caller
  policy and canon evidence.

A character reaction never carries a required worked step, introduces theory,
or creates plot. If authorization is absent, omit this beat type.

## Primitive Selection

- Record `primitive` as the exact name in the immutable run-time schema snapshot.
- Record `params` as the exact schema-valid parameter object.
- Record the schema version/hash used to validate the selection outside the
  storyboard where the live contract requires it.
- Do not write imagined method calls or use prose aliases as primitive names.
- Scene code must preserve the storyboard beat order and IDs and must define one
  renderable scene for its `scene_id`.

## Duration Accounting

- `duration_hint` is the sum of planned visual beat durations plus only
  schema/canon-supported transitions.
- After voice synthesis, use measured WAV duration, never word-count or file-size
  estimates.
- After render, record measured scene-video duration and signed tail:
  `video_duration - narration_duration`.
- Every narrated scene must satisfy `video_duration >= narration_duration` and
  tail `<= max_scene_tail_seconds`.
- The assembled duration is measured from media evidence. A caller hard cap is
  blocking; a soft guide produces only a review flag.
- No scene is padded, clipped, or artificially sped up to target a duration.

## Scene Boundaries

Choose boundaries where a pedagogical unit can be understood and verified as a
coherent segment. Also prefer boundaries that allow one affected unit to be
re-synthesized and re-rendered without invalidating unrelated scenes. Do not use
arbitrary fixed lengths, equal scene counts, or renderer convenience as the
primary boundary rule.

## Hashes and Refinement

For each scene, track at least:

- exact narration hash;
- visual/storyboard input hash;
- code hash;
- audio hash tied to the narration hash;
- draft and final render hashes; and
- cache/job evidence.

A hash-identical narration reuses exact audio. A hash-identical visual/code/audio
input may reuse renderer cache only when the renderer reports evidence of that
reuse. Any changed protected input invalidates dependent artifacts and prior
draft approval.

## Add, Split, Merge, and Retire Rules

- **Add:** issue new scene and beat IDs; do not renumber existing IDs. Declare
  dependencies and insertion order explicitly.
- **Split:** retain the original scene ID for the portion that preserves its
  primary purpose; issue a new scene ID for the new semantic unit. Preserve beat
  IDs with the teaching actions they still represent.
- **Merge:** retain the ID of the scene whose primary purpose survives; retire the
  other scene ID with an explicit lineage mapping. Never silently reuse the
  retired ID.
- **Retire:** remove the scene from the active set but preserve its ID, reason,
  replacement mapping, and evidence in the refinement ledger.
- Update feedback mappings, coverage/source maps, dependencies, caption windows,
  and scene order after every structural change.
- Every complete candidate must have exact active-scene set equality across
  storyboard, scene code, narration-bearing audio, expected render jobs, and
  outputs.

## Generic JSON Example

This example is structural and abstract. Every placeholder must be replaced by
caller-grounded evidence or a live-schema value before use.

```json
{
  "scenes": [
    {
      "scene_id": "scene_alpha",
      "title": "<source-grounded scene title>",
      "purpose": "<one source-grounded teaching purpose>",
      "concept_ids": ["concept_alpha"],
      "source_spans": ["<section source span reference>"],
      "narration": "<exact approved spoken narration>",
      "approved_silence": false,
      "visuals": [
        {
          "beat_id": "beat_alpha",
          "type": "intuition",
          "claim_ref": "<claim-to-source reference>",
          "primitive": "<live schema primitive name>",
          "params": {
            "<live schema parameter name>": "<caller-grounded value>"
          },
          "duration": 0.0
        }
      ],
      "depends_on": [],
      "duration_hint": 0.0,
      "measured_duration": null,
      "accessibility": {
        "readable_text": "<evidence requirement>",
        "non_color_meaning": "<evidence requirement>",
        "essential_fact_redundancy": "<evidence requirement>",
        "captions_required": true
      },
      "narration_sha256": "<lowercase SHA-256 after narration freezes>",
      "visual_input_sha256": "<lowercase SHA-256 after visuals freeze>"
    }
  ],
  "coverage": [
    {
      "concept_id": "concept_alpha",
      "source_spans": ["<section source span reference>"],
      "beat_ids": ["beat_alpha"],
      "scene_ids": ["scene_alpha"],
      "evidence_refs": ["<locatable evidence reference>"]
    }
  ],
  "claim_source_map": [
    {
      "claim_id": "claim_alpha",
      "scene_id": "scene_alpha",
      "beat_id": "beat_alpha",
      "source_refs": ["<section or caller-canon evidence reference>"]
    }
  ]
}
```

The storyboard artifact is summarized in `{sid} Storyboard i{n}`; exact
narration and source maps are summarized in `{sid} Narration i{n}`. Complete
files remain under caller-owned paths and are referenced by absolute path and
hash.
