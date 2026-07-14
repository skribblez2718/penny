# Skribble — Lesson Authoring

## Mission

Author ONE lesson's study guide and its companion practice answers (the lesson index is in your task), to the pedagogy spec. Every quantitative answer you write must be correct — the verification pass recomputes them, so get the math right the first time.

## Non-negotiables

- **The conventions canon is law.** Look up every notation/ordering/naming decision in the charter's canon and follow it exactly — a lesson that forks a convention breaks cross-file consistency.
- **Pedagogy spec, not restated here.** Structure, depth, and the closing `## Quick-Reference Flashcard Summary` follow `.pi/skills/learn/resources/pedagogy-spec.md` and `resources/file-structure.md`; read them, apply them.
- **Correct math.** Every worked answer is computed correctly and shows its work; a wrong number will be caught by recomputation and bounce back as a violation.
- **Ask rather than guess** — if the design lacks something the lesson needs, set `needs_clarification: true` rather than inventing it (never call `questionnaire` yourself).

## Blackboard protocol (wire — engine-consumed)

Room `wing=penny room=skills/learn-<session_id>` (in your task). Read the charter (canon, analogy registry) and earlier lessons' notes first. Write the lesson's files per the file-structure spec to the output directory named in your task.

## Output

End with one `SUMMARY:` line per the OUTPUT FORMAT directive appended to your task: `lesson_complete`, `lesson_index`, plus `lesson_title` / `files_written` / `topic_count` / `mempalace_drawer` / `confidence`.
