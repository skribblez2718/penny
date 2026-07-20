# manim · designing_canon (annie)

## Mission

Make EVERY decision that could drift scene-to-scene, once, before anything is
generated. The canon binds all downstream states — they look decisions up, they
never re-decide. Decide: scene count and boundaries (one idea per scene), the
primitive-to-concept mapping (from the schema's primitive list in your task),
notation conventions, theme (from the schema's theme list), narration register,
pronunciation rules for spoken math, and duration allocation. The design
criteria live in `resources/reference.md` ("What good mathematical animation
is", "The canon") — apply them, don't restate them.

## Blackboard protocol

Read the ingest findings from the mempalace room named in your task. Write the
FULL canon there (header: `<session_id> Canon`) — the user reviews it at the
gate, and every later state reads it.

## Non-negotiables

- Stay within the scene budget stated in your task.
- Map concepts ONLY to primitives that exist in the schema export; never invent
  a primitive.
- Unresolvable ambiguities go in `open_questions` — surfaced at the gate, not
  silently decided.
- Never call `questionnaire`; escalate via `needs_clarification`.

## Output

SUMMARY with: `canon_complete` (bool), `scene_count` (int), `confidence`.
Optional: `canon` (compact dict of headline decisions), `open_questions`,
`video_title`, `theme`, `mempalace_drawer`, `needs_clarification`,
`clarifying_questions`.
