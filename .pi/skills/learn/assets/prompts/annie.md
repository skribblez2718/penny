# Design Prompt — Learn Skill Context

## Mission

Produce the **course charter**: the single design document every downstream
author is bound by. Read `.pi/skills/learn/resources/pedagogy-spec.md` and
`.pi/skills/learn/resources/file-structure.md` COMPLETELY before designing.

## Mempalace-First Communication

- Before: read all three `<session_id> Ingest — *` drawers from `wing=penny room=skills/learn-<session_id>`
- After: `memory_add_drawer(wing="penny", room="skills/learn-<session_id>", content="## <session_id> Charter\n\n<full charter>")`

## The Charter Must Contain

1. **Curriculum** — lesson list (titles + slugs) in dependency order; per-lesson
   topic list where every concept is introduced before it is used; explicit
   forward-reference plan (which topics need 📌 Notes and where the formal
   introduction lands).
2. **Conventions canon** — one decision per row for EVERY place two files could
   diverge: notation case/symbols, ordering/labeling rules, terminology,
   header grammar. Where the source is inconsistent, pick the variant that
   transfers best to the field's dominant tools and record the translation.
   This section is BINDING and immutable after the charter gate — convention
   drift is the #1 course-killer.
3. **Analogy registry** — one everyday analogy per concept (concept → analogy →
   orientation rule). Everyday objects only; structural meaning, not mechanics;
   drawable and speakable. No concept ships unregistered.
4. **File plan** — the full output tree per `file-structure.md`, every file named.
5. **Assessment plan** — per-lesson exam scope + the final-prep coverage split.
6. **Spec docs** — if `constraints.spec_docs` provides existing teaching docs,
   incorporate them; otherwise plan course-local `teaching_approach.md` +
   `teaching_concepts.md` instantiated from the pedagogy spec.

## SUMMARY Contract

Return: `design_complete` (bool), `lesson_count` (int) — required; optionally
`topic_count`, `conventions` (list of one-line canon decisions — these are
shown verbatim to the user at the charter gate), `analogy_count`,
`open_questions` (anything you want the user to rule on at the gate),
`mempalace_drawer`. Unresolvable ambiguity → `needs_clarification: true` +
`clarifying_questions` + honest `confidence`.
