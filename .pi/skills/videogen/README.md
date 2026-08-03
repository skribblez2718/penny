# videogen

`videogen` is a public, source-agnostic orchestration skill that turns one
finalized, derivation-gated Markdown section into a narrated instructional video
bundle, independently verifies the draft, pauses for explicit operator review,
and stages a handoff-only release after hash-bound approval.

This directory contains the WP-1 skill card, delegate, flow diagram, and durable
resources. The engine playbook, agent prompts, adapters, and tests are separate
work packages and must preserve the contracts documented here.

## Public Boundary

Tracked files contain only generic field names, protocol rules, and abstract
placeholders. Every section, canon path, service base URL, voice selection,
theme, primitive schema, workspace, output root, publish convention, and any
character authorization comes from the caller. The skill contains no app
profile data, static primitive schema, target-app adapter, app-named branch, or
automatic publication path.

The skill writes only beneath caller-validated `workspace_dir` and `output_dir`.
Destination strings from `publish_target_conventions` are handoff data, never
filesystem authority.

## Engine Model

The skill delegates to the shared orchestration engine:

```text
.pi/skills/videogen/scripts/orchestrate.py
  → orchestration.cli.main(default_playbook="videogen")
  → orchestration.playbooks.videogen:VideogenPlaybook
```

The checkpointer persists the run by `run_id`. Domain data is represented by
paths, hashes, IDs, and compact ledgers; source, canon, schema, WAV, MP4, image,
and generated-code bytes never enter checkpoint extras or MemPalace.

## Domain Phases and Control States

The twelve domain phases are:

```text
INGEST → STORYBOARD → NARRATION_SCRIPT → VOICE_SYNTH → CODEGEN → VALIDATE
→ DRAFT_RENDER → AUTO_QA → OPERATOR_REVIEW → REFINE → FINALIZE
→ PUBLISH_HANDOFF
```

The machine also has only these engine control states:

```text
intake · unknown · awaiting_clarification · complete · error
```

`complete` is interpreted through the result:

- `lifecycle_state: HANDOFF_READY`, `met: true` — verified handoff success.
- `lifecycle_state: EXHAUSTED`, `met: false` — honest budget exhaustion with the
  latest complete candidate and unresolved evidence.

The interactive edge-for-edge design is in `resources/flow.html`.

## Why the Order Is Fixed

| Order rule | Failure mode prevented |
|---|---|
| Validate the entire intake before snapshots, services, or output | Partial side effects from an invalid or incomplete caller contract |
| Snapshot exact source/canon/schema bytes before analysis | Mid-run input drift and unrepeatable evidence |
| Build concept coverage before storyboard prose | Visually polished output that omits a source concept |
| Freeze storyboard and narration, then run Carren before voice synthesis | Paying for voice work on a pedagogically or canonically defective script |
| Measure narration audio before code generation | Scene timing based on estimates rather than the produced audio |
| Generate only against the immutable live-schema snapshot | Imagined primitive APIs and version drift |
| Validate the complete bundle before rendering | Expensive render jobs for malformed or incompatible inputs |
| Capture deterministic evidence before Vera's audit | A model verdict substituting for bundle, media, timing, or checksum facts |
| Require AUTO_QA PASS before operator review | Human review masking a failed automated gate |
| Bind approval to the exact draft hash before final rendering | Finalizing a draft the operator did not review |
| Route every refinement through full validation and AUTO_QA | A targeted fix silently breaking unchanged scenes or global invariants |
| Recheck protected hashes before mutation, finalization, and handoff | Reusing stale approval or incompatible provenance |
| Stage a handoff rather than mutating the consumer | Unreviewed external writes, builds, imports, or commits |

## Intake Contract

The direct contract requires:

- `section_content` — exactly one inline text or absolute file source;
- `section_identity` — exact safe keys `course_slug`, `unit_slug`,
  `lesson_slug`, and `stable_key`;
- `content_gate` — `finalized: true`, `derivation_verdict: INDEPENDENT`, and a
  nonempty evidence reference;
- nonempty teaching canon paths plus analogy, pronunciation, and visual-universe
  canon locations;
- caller-selected renderer and voice-service base URLs, voice ID, and theme;
- one caller-selected primitive schema URL or absolute file;
- absolute workspace and output roots; and
- an executable, handoff-only publish convention.

Optional constraints include an app profile, caller character-use policy,
scene-tail bound, optional hard duration cap, optional soft duration guide,
quality tier, create/refine mode inputs, and a positive refine budget. Omitted
hard caps remain absent. Soft-guide overage is a review flag, not a failure.
The baseline refine budget is three; exhaustion never self-approves.

Profile mode resolves caller-owned data according to
`resources/app-profile-schema.md`, records exact profile path/hash evidence, and
then enters the same normalized-intake path as direct mode.

## Human Gate

`OPERATOR_REVIEW` persists the exact gate packet defined by the orchestration
contract. Accepted responses have only these shapes:

```json
{"action":"approve"}
```

```json
{"action":"abort"}
```

```json
{"action":"refine","feedback":"<nonempty verbatim feedback>"}
```

No free-text approval, timeout, silence, unknown key, or mismatched protected
hash advances the run. Refinement consumes one resolved-budget iteration and
returns a complete QA-passed draft to the same hard gate.

## Bundle and Handoff

The render bundle has this generic shape:

```text
<bundle>/
├── manifest.json
├── provenance.json
├── storyboard.json
├── scenes/<scene_id>.py
├── audio/<scene_id>.wav
└── captions/<scene_id>.json    # only when supported timing data exists
```

`manifest.json` has exactly four keys: `bundle_version`, `video_id`,
`primitive_library_version`, and `theme`. Source identity, exact content hash,
profile evidence, canon/schema/theme/voice bindings, approval, and checksums live
in `provenance.json` and the handoff receipt, never in the manifest.

A successful handoff atomically stages:

1. final assembled MP4;
2. nonempty WebVTT captions;
3. a same-dimension JPEG from the first decoded frame of scene 1's final-quality
   render;
4. the complete editable bundle;
5. AUTO_QA and exact approval evidence;
6. caller-rendered publish instructions; and
7. a `HANDOFF_READY` receipt with a no-target-side-effect attestation.

Word-level timing JSON is optional and is not invented when no pinned producer
or schema exists.

## Bundled Resources

| Resource | Binding content |
|---|---|
| `resources/video-pedagogy-spec.md` | Eleven source-bound authoring rule groups and caller-grounded placeholders |
| `resources/storyboard-conventions.md` | Live-schema relationship, stable IDs, coverage/source maps, timing, hashes, and generic JSON |
| `resources/app-profile-schema.md` | Exact allowed/forbidden profile fields, shallow merge, provenance, and path safety |
| `resources/qa-checklist.md` | All 18 check IDs, evidence, owner/fix routes, exact result schema, verdict semantics, and gate packet integration |
| `resources/flow.html` | Twelve domain phases, five control states, repair/refine paths, escalation, and terminal mapping |

## MemPalace Wire Contract

Room: `skills/videogen-{session_id}`. Let `sid = session_id` and `n = iteration`.
Drawer titles are exact and earlier iterations are immutable:

1. `{sid} Intake Contract`
2. `{sid} Concept Inventory`
3. `{sid} Storyboard i{n}`
4. `{sid} Narration i{n}`
5. `{sid} Carren Gate i{n}`
6. `{sid} Voice Synth i{n}`
7. `{sid} Codegen i{n}`
8. `{sid} Validation i{n}`
9. `{sid} Draft Render i{n}`
10. `{sid} Auto QA i{n}`
11. `{sid} Operator Review i{n}`
12. `{sid} Refine i{n}`
13. `{sid} Finalize`
14. `{sid} Publish Handoff`

Drawer bodies carry compact text/JSON, paths, hashes, IDs, and evidence
references only. The durable checkpointer—not MemPalace—is the source of truth
for current run state.

## Layout

```text
.pi/skills/videogen/
├── SKILL.md
├── README.md
├── assets/prompts/              # agent guidance supplied by its owning work package
├── scripts/
│   └── orchestrate.py
└── resources/
    ├── flow.html
    ├── video-pedagogy-spec.md
    ├── storyboard-conventions.md
    ├── app-profile-schema.md
    └── qa-checklist.md
```

## Validation

Run the structural gate from the repository root:

```text
python scripts/system/checks/check_skill_structure.py --skill videogen
```

The flow drift suite becomes authoritative after the playbook and its additive
`VideogenMachine` test registration land. Public-boundary review must continue
to reject caller values, profile data, static primitive schemas, target-app
logic, and writes outside caller roots.
