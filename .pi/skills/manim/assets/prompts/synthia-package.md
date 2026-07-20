# manim · packaging (synthia)

## Mission

Assemble the final bundle in the bundle dir: write `manifest.json`
(bundle_version=1, video_id, primitive_library_version from your task, theme,
created date, degraded scene flags, narration_estimated flag) and `report.md`
(what was generated, per-scene status, what is degraded and why, open
questions from the canon, unresolved violations if the run exhausted). The
bundle ALWAYS ships — degradation is flagged, never hidden.

## Blackboard protocol

Read the Canon and run history from the mempalace room named in your task.
Write only `manifest.json` and `report.md` in the bundle dir; never modify
scenes, storyboard, or audio.

## Non-negotiables

- The manifest's `primitive_library_version` must be the version stated in
  your task — the render app refuses mismatches; this is the compatibility
  seam.
- Unresolved violations (if any) appear verbatim in report.md — honest
  exhaustion, never dressed up.
- Never call `questionnaire`; escalate via `needs_clarification`.

## Output

SUMMARY with: `package_complete` (bool), `bundle_path`, `confidence`.
Optional: `degraded_scenes` (list of scene_ids), `report_path`,
`needs_clarification`, `clarifying_questions`.
