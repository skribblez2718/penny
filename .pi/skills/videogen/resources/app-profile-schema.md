# App Profile Schema

An app profile is caller-owned JSON data that supplies stable per-application
values to the generic `videogen` intake contract. It is configuration sugar,
not a second workflow: resolve and shallow-merge the profile, validate the same
normalized contract used by direct mode, and execute the same phase graph.

Profiles are never shipped inside Penny. This resource defines fields and
validation only; it contains no profile data, app name, selected service,
selected voice, selected theme, destination convention, or target-app logic.

## Layout

```text
<profiles_root>/
└── <safe_profile_name>/
    ├── profile.json
    └── <optional sibling files referenced by profile.json>
```

The resolver reads exactly:

```text
<profiles_root>/<safe_profile_name>/profile.json
```

Sibling files are optional caller-owned data. A profile is JSON only; it cannot
contain executable code, commands, hooks, imports, or build/publish actions.

## Exact Allowed Top-Level Field Set

A profile may contain only the following stable fields. Unknown fields fail
profile validation.

### Stable required-contract fields

- `teaching_canon_paths`
- `analogy_registry`
- `pronunciation_canon`
- `universe_canon_dir`
- `superpose_url`
- `voice_studio_url`
- `voice_id`
- `theme`
- `primitive_schema_source`
- `workspace_dir`
- `output_dir`
- `publish_target_conventions`

### Stable optional-contract fields

- `character_usage_policy`
- `length_cap_seconds`
- `length_guide_seconds`
- `max_scene_tail_seconds`
- `max_refine_iterations`

A profile may provide any subset of this allowed set because inline constraints
may complete or override it. After merge, the ordinary intake validator still
requires every required contract field and applies all ordinary types and
semantics. Profile presence never makes a required value optional.

`quality_tier` is deliberately not in this profile schema. Any new stable
capability must be added generically to this field set and validator before a
profile may use it.

## Exact Forbidden Top-Level Field Set

Per-work-item fields are forbidden inside a profile:

- `section_content`
- `section_identity`
- `content_gate`
- `mode`
- `existing_video`
- `feedback_text`

Profile-resolution controls are also forbidden inside profile data:

- `app_profile`
- `profiles_dir`

The presence of any forbidden field fails before snapshots, service calls, or
output writes. These values must come from the invocation. Unknown fields fail
rather than being ignored.

## Field Shapes

The profile uses the same shapes as direct intake:

| Field | Shape |
|---|---|
| `teaching_canon_paths` | Nonempty array of readable files |
| `analogy_registry` | Readable file |
| `pronunciation_canon` | Readable file |
| `universe_canon_dir` | Readable directory |
| `superpose_url` | Absolute `http` or `https` service base URL; no credentials, query, or fragment |
| `voice_studio_url` | Absolute `http` or `https` service base URL; no credentials, query, or fragment |
| `voice_id` | Nonempty caller selection |
| `theme` | Nonempty caller selection |
| `primitive_schema_source` | Exact one-key object: `url` or `path` |
| `workspace_dir` | Absolute caller write root |
| `output_dir` | Absolute caller staging root |
| `publish_target_conventions` | Inline exact object or readable profile-owned JSON/Markdown file |
| `character_usage_policy` | String or JSON object, or omitted |
| `length_cap_seconds` | Positive number, or omitted for no hard cap |
| `length_guide_seconds` | Positive number, or omitted for no soft guide |
| `max_scene_tail_seconds` | Nonnegative number, or omitted for the contract default |
| `max_refine_iterations` | Positive non-boolean integer, or omitted for the contract default |

`publish_target_conventions` source objects have this exact key set:

- required: `video_id_template`, `base_name_template`,
  `video_destination_template`, `captions_destination_template`,
  `poster_destination_template`, `attach_behavior`, `handoff_only`;
- optional: `consumer_preference`, `required_sidecars`,
  `requires_word_timings`, `instructions`, `metadata`.

Unknown publish keys fail. `handoff_only` must be boolean `true`. The v1 required
sidecars are exactly `vtt` and `jpg`. A request requiring word timings fails
before output until a producer and schema are explicitly pinned.

## Resolution Order

1. If `app_profile` is absent, return a shallow copy of direct constraints with
   provenance exactly `{"mode":"direct"}`. Do not inspect profile environment or
   directories.
2. If `app_profile` is present, choose the profile root from nonempty inline
   `profiles_dir`; otherwise use nonempty `VIDEOGEN_PROFILES_DIR`; otherwise
   fail with an actionable profile-resolution error.
3. Validate the profile name as one safe path component.
4. Resolve exactly `<root>/<name>/profile.json` and prove the canonical file
   remains beneath the canonical root.
5. Read exact UTF-8 bytes, hash those bytes with lowercase SHA-256, parse one JSON
   object, and validate allowed/forbidden keys.
6. Resolve permitted profile-relative read-only paths against the profile
   directory.
7. Shallow-merge profile top-level values first and inline top-level values
   second. An inline object replaces the corresponding profile object in full;
   nested objects are never recursively blended.
8. Remove only the resolver controls needed by normalization, then run the same
   complete normalized-intake validator used by direct mode.
9. Record profile provenance exactly as `mode`, `name`, canonical
   `resolved_path`, and exact-byte `sha256`.

An unknown name, missing root, unreadable file, invalid UTF-8/JSON, non-object,
forbidden key, unsafe path, or invalid merged contract fails before any service
or output side effect. Resolver errors never leak raw filesystem or JSON
exceptions as partial success.

## Merge and Override Semantics

- Merge is shallow and top-level only.
- Inline values always win, including explicit falsey values that are valid for
  their fields.
- An inline nested object replaces the complete profile nested object.
- Arrays replace arrays; they are never concatenated.
- No app-specific conflict rule exists.
- After merge, unknown names and all ordinary field/type/semantic errors are
  reported by the single normalized contract path.
- Direct and profile mode produce equivalent normalized values when their
  resolved inputs are equal.

## Path Safety

### Profile name and root

- Profile names are nonempty, have no surrounding whitespace, and are exactly
  one path component.
- Reject `.`, `..`, absolute paths, separators, control characters, NUL, and any
  normalized multi-component value.
- Canonical profile resolution must remain beneath the canonical root.
- Refuse symlink traversal or escape.

### Relative paths permitted inside a profile

Only these profile-owned read-only inputs may be relative and are resolved
against the profile directory:

- entries in `teaching_canon_paths`;
- `analogy_registry`;
- `pronunciation_canon`;
- `universe_canon_dir`;
- file-backed `primitive_schema_source.path`; and
- file-backed `publish_target_conventions`.

### Paths that must remain absolute

- `workspace_dir` and `output_dir` are absolute caller roots even when stored in
  a profile.
- Direct-invocation paths are absolute.
- URL-backed service/schema fields are absolute `http`/`https` URLs.

Write roots and later artifact joins reject lexical or resolved traversal,
existing symlinks in write components, unsafe destination names, and paths
outside the validated root. Publish destination templates are relative handoff
strings only and never authorize Penny writes.

## Publish Template Safety

Template expansion is ordered: base name, video ID, then destinations. Allowed
placeholders are exactly:

- `course_slug`
- `unit_slug`
- `lesson_slug`
- `stable_key`
- `base_name` after it resolves

Reject unknown placeholders, conversions, format specs, attribute/index access,
empty expansions, absolute or URL destinations, control characters, separators
that escape, and any `..` path component. Expanded base name and video ID must be
safe components.

## Fully Generic Placeholder Profile

This is an abstract shape, not executable configuration. Every angle-bracket
value must be replaced by caller-owned data of the field's documented type
before validation. It intentionally contains no concrete path, endpoint,
selection, profile name, destination, or app value.

```json
{
  "teaching_canon_paths": [
    "<profile-relative teaching canon file>"
  ],
  "analogy_registry": "<profile-relative analogy registry file>",
  "pronunciation_canon": "<profile-relative pronunciation canon file>",
  "universe_canon_dir": "<profile-relative visual canon directory>",
  "superpose_url": "<absolute caller renderer base URL>",
  "voice_studio_url": "<absolute caller voice-service base URL>",
  "voice_id": "<caller voice selection>",
  "theme": "<caller renderer theme selection>",
  "primitive_schema_source": {
    "path": "<profile-relative primitive schema file>"
  },
  "workspace_dir": "<absolute caller workspace root>",
  "output_dir": "<absolute caller staging root>",
  "publish_target_conventions": {
    "video_id_template": "<caller video identity template>",
    "base_name_template": "<caller safe base-name template>",
    "video_destination_template": "<caller relative video destination template>",
    "captions_destination_template": "<caller relative captions destination template>",
    "poster_destination_template": "<caller relative poster destination template>",
    "attach_behavior": "<caller handoff instruction value>",
    "consumer_preference": "<caller preference or omit>",
    "required_sidecars": ["vtt", "jpg"],
    "requires_word_timings": false,
    "instructions": ["<caller handoff instruction or omit>"],
    "metadata": {},
    "handoff_only": true
  },
  "character_usage_policy": "<caller policy or omit>",
  "length_cap_seconds": "<positive number or omit>",
  "length_guide_seconds": "<positive number or omit>",
  "max_scene_tail_seconds": "<nonnegative number or omit>",
  "max_refine_iterations": "<positive integer or omit>"
}
```

Because numeric placeholders above are explanatory strings, replace or omit them
before use; an unchanged placeholder profile must fail normal type validation.

## Capability Boundary

A profile is data. The skill must not branch on a profile or application name,
load executable profile content, or infer a missing service, schema, voice,
theme, path, or convention. If an application needs a capability the generic
schema cannot express, extend this schema, resolver, normalized contract, and
tests generically so every profile can use it.

Profile resolution evidence is summarized in `{sid} Intake Contract`. The full
profile bytes remain in the immutable caller workspace snapshot and are
represented in drawers/checkpoints only by path and hash.
