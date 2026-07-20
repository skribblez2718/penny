# manim skill — internals

Companion doc to [SKILL.md](SKILL.md). The playbook lives at
`apps/orchestration/src/orchestration/playbooks/manim.py`; this directory holds
the manifest, per-state prompts, resources, and the two load-bearing scripts.

## Provenance & compliance note

This skill was designed **before** its first end-to-end production run (a
knowing deviation from design-methodology Rule 1, recorded in the source PRD).
Consequences: the state list is hypothesis, and the order-rule table below is
populated with **predicted** failure modes. After the first real video bundle
is produced,every row must be confirmed, corrected, or deleted, and the delta
recorded in mempalace. A row that survives unconfirmed is a deletion candidate.

## Order-rule → failure-mode table `[ALL PREDICTED — CONFIRM AFTER FIRST RUN]`

| Order rule | Failure mode it prevents | Status |
|---|---|---|
| Canon decided before storyboard | Notation forks across scenes (`\|0⟩` vs `\|0>`); palette drift | `[PREDICTED]` |
| Canon decided before authoring | Same concept drawn two different ways in one video | `[PREDICTED]` |
| Gate before storyboard + authoring | Generating 20 scenes against a wrong pedagogical arc | `[PREDICTED]` |
| Narration synthesized before authoring | Animations that don't fit narration; stretching audio produces pitch artifacts | `[PREDICTED]` |
| Verify before critique | Burning judgment cycles on code that doesn't compile | `[PREDICTED]` |
| Fixes re-enter verify | A fix to scene N breaking a shared primitive call used by scene N-1 | `[PREDICTED]` |
| Primitive schema read at start | Generating calls to primitives that don't exist or changed signature | `[PREDICTED]` |

## The verification problem

The skill generates Manim code but **cannot render it** (rendering is the
app's loop). What CAN be executed without rendering lives in
`scripts/validate_bundle.py` — py_compile (compiles, never executes), AST
single-Scene check, primitive signature validation against the exported
schema, duration arithmetic vs measured narration, storyboard structural
validation, and orphan detection. vera runs it and cites its JSON report as
evidence (execute > apply-the-rule > judge).

**Known accepted gap:** a scene can pass every static check and still render
to a black frame or overlapping text. The render app's preview + degraded-
scene handling exists for exactly this.

## Voice Studio integration decisions

- **Durability**: Voice Studio keeps audio ephemeral by design; the `narrating`
  tool state fetches each WAV and persists it into the bundle (the bundle is
  the durable store). Voice Studio is not modified.
- **Word timings**: the API exposes none; the bundle omits `captions/` and the
  render app generates scene-level captions from measured durations. If the
  underlying TTS later exposes alignment, add it here — don't block on it.
- **Down**: actionable failure by default; `allow_estimated_durations: true`
  opts into word-count estimates with scenes flagged `narration_estimated`.

## Control-flow dial

- **Code-owned**: verify/critique wire verdicts, the authoring scene-index
  self-loop, verify⇄fix pairing, honest exhaustion, gate resume routing.
- **Model-owned**: ingest fan topology (scoping emits it; the fixed 3-branch
  fallback is the tagged LOAN `manim_default_ingest_topology`), every canon
  decision, storyboard sequencing, all generated artifacts.

## Bundle contract (app boundary)

```
<output_dir>/<video_id>/
├── manifest.json      # bundle_version, video_id, primitive_library_version, theme, degraded flags
├── storyboard.json    # primary human-editable artifact (+ measured_duration per scene)
├── scenes/<id>.py     # one manim.Scene subclass per storyboard scene
├── audio/<id>.wav     # narration per scene
└── report.md          # what was generated, what is degraded, open questions
```

The app edits in place (storyboard editor + file watching); re-import is the
same operation as import. The primitive schema export is the tightest coupling
— the manifest records the version a bundle targets.
