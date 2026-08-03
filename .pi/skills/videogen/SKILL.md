---
name: videogen
description: Orchestrate one finalized, derivation-gated instructional section into a storyboarded, narrated, rendered, quality-checked video bundle with a hard operator review-and-refine gate. Use when the caller asks to create an instructional video, render a finalized lesson section, regenerate a stale section video, resume a video run, or refine an existing video bundle and can supply the complete source, canon, service, schema, output, and publish contract. Do not use before content is final and independently derivation-gated, for stories or featurettes, for verbatim read-aloud audio, for still-image-only work, or to publish, build, import, or commit media into a target application.
license: MIT
metadata:
  penny:
    engine: orchestration
    mempalace: true
    subagents:
      - annie
      - synthia
      - skribble
      - carren
      - vera
---

# Videogen

`videogen` produces one source-bound instructional video bundle for one finalized
Markdown section per run. It owns concept analysis, storyboard and narration,
pre-synthesis critique, voice synthesis, live-schema-grounded scene code,
validation, draft rendering, independent AUTO_QA, a durable operator review and
refine loop, final rendering, and publish handoff. It does not author or repair
the source section, run its independence review, modify renderer or voice
services, or mutate a consuming application.

## When to Use

Use `videogen` only when all of these conditions hold:

- The work item is exactly one finalized Markdown section.
- The caller supplies an `INDEPENDENT` derivation verdict and evidence reference.
- The desired result is a visually driven instructional video, not a read-aloud.
- The caller can supply every required source, canon, service, live primitive
  schema, workspace, output, and publish constraint.
- A human operator can review the complete QA-passed draft and explicitly
  approve, refine, or abort it.

Appropriate requests include creating a first section video, regenerating a
stale video after an exact source-hash change, resuming a durable run, and
refining a compatible prior bundle from structured operator feedback.

## When NOT to Use

Do not use `videogen`:

- before the section is final or when its derivation verdict is not
  `INDEPENDENT`;
- for a story, featurette, episode, documentary lane, arbitrary HTML section,
  quiz, prediction, or simulation;
- to introduce, repair, or expand source theory—route that change upstream;
- for decorative-motion read-alouds or still-image-only output;
- when required canon, services, or the caller's primitive schema are
  unavailable and no caller-approved replacement exists;
- to modify a rendering or voice service; or
- to copy, attach, import, build, publish, or commit artifacts in a target
  application. `PUBLISH_HANDOFF` emits staged artifacts and instructions only.

## Invocation

Invoke through the `skill` tool. The shared orchestration engine owns durable
state by `run_id`; the thin delegate routes `start`, `step`, `status`, and
`recover` to `orchestration.playbooks.videogen:VideogenPlaybook`.

```text
skill({
  skill_name: "videogen",
  goal: "Produce an instructional video for the finalized section",
  constraints: {
    section_content: { ... },
    section_identity: { ... },
    content_gate: { ... },
    teaching_canon_paths: [ ... ],
    analogy_registry: "<caller path>",
    pronunciation_canon: "<caller path>",
    universe_canon_dir: "<caller directory>",
    superpose_url: "<caller service base URL>",
    voice_studio_url: "<caller service base URL>",
    voice_id: "<caller selection>",
    theme: "<caller selection>",
    primitive_schema_source: { ... },
    workspace_dir: "<caller workspace>",
    output_dir: "<caller staging root>",
    publish_target_conventions: { ... }
  }
})
```

A named `app_profile` may supply stable caller-owned values. Profile resolution
is data-only sugar over the same validation and execution path; per-work-item
section, identity, gate, mode, prior-video, and feedback fields remain outside
the profile. See `resources/app-profile-schema.md`.

The complete contract is validated before any service call or output write.
There are no defaults for caller paths, service URLs, voice, theme, primitive
schema, output roots, or publish conventions.

## Workflow and Hard Gate

The domain phases are fixed:

```text
INGEST → STORYBOARD → NARRATION_SCRIPT → VOICE_SYNTH → CODEGEN → VALIDATE
→ DRAFT_RENDER → AUTO_QA → OPERATOR_REVIEW → REFINE → FINALIZE
→ PUBLISH_HANDOFF
```

Repair and refinement edges route to the earliest affected existing phase and
always reconverge on full validation, full AUTO_QA, and `OPERATOR_REVIEW`.
Carren must approve the exact storyboard and narration hashes before any voice
mutation. Vera independently verifies all mechanical and alignment rows after
deterministic evidence exists.

`OPERATOR_REVIEW` is a durable hard pause. Only an exact structured response
with `action: approve|refine|abort` is accepted; refine also requires nonempty
feedback. Silence, timeout, prose approval, or a changed protected hash never
approves a draft. Exhausted budgets end honestly with domain lifecycle
`EXHAUSTED`, `met: false`, and the latest evidence. Success uses engine state
`complete` with domain lifecycle `HANDOFF_READY`.

## Output Boundary

Successful handoff atomically stages a final MP4, WebVTT captions, a same-dimension
JPEG from scene 1's first final-quality frame, the complete editable render bundle,
AUTO_QA evidence, the exact
operator approval record, publish instructions, and a handoff receipt. The
receipt repeats source identity, exact content hash, provenance, approval, and
checksums. `HANDOFF_READY` means the handoff packet is ready; it never means the
target application was changed or publication completed.

## Resources

- `resources/video-pedagogy-spec.md` — source-bound video teaching rules.
- `resources/storyboard-conventions.md` — stable scene/beat and coverage schema.
- `resources/app-profile-schema.md` — generic profile fields and resolution.
- `resources/qa-checklist.md` — all mechanical/alignment checks and roll-up.
- `resources/flow.html` — self-contained FSM/control-state diagram.

Agents exchange compact SUMMARY wire data through room
`skills/videogen-{session_id}`. Full text and binary artifacts remain under
caller-owned paths; drawers contain paths, hashes, and evidence references only.
