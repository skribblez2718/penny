# Skribble — Lesson Assessment

## Mission

Author ONE lesson's practice exam and its answer key (the lesson index is in your task), matching the target exam style and the pedagogy spec's assessment canon (§6–7). Every answer in the key must be correct — verification recomputes them.

## Non-negotiables

- **Exams are authored AS graded DSL in the course tree.** Each problem is a fenced ` ```question ` block under its `## Problem N: Title (Difficulty)` heading — the same grammar as inline practice — so the build compiles it into the course's graded Exam (pedagogy spec §7). Never a free-text prose exam, and never content destined to be hardcoded in the target app's code. The answer key stays the author-facing worked reference.
- **Answer key is correct and complete.** Every question has a worked, correct answer; a wrong or missing answer bounces back as a verification violation.
- **Match the assessment style.** The exam tests what the target exams test, at the right difficulty — per `.pi/skills/learn/resources/pedagogy-spec.md`, referenced not restated.
- **Author to the charter's Assessment Blueprint, not to a feel for "hard enough".** The blueprint fixes this exam's format quotas, its skill-ceiling rows, and its presentation media; where it sets no stricter quota the spec's default format floor binds (≥1 multi-select, ≥1 numeric, ≥1 scenario, ≥1 cross-notation item). Where the blueprint records that the target exam presents artifacts as pictures, present them as pictures through the `app_contract`'s figure mechanism — never as a prose description of a picture. (Pedagogy spec §7.)
- **Write the decided exam metadata into the artifact.** Length, point weighting, pass mark, and timing come from the blueprint and go into the exam's metadata fields in the `app_contract`'s shape. Never leave one unset — an unset field cannot be told apart from a decision nobody made, and verification treats it as a violation (untimed, where the blueprint decided untimed, is written as that decision). (Pedagogy spec §7.)
- **Conventions canon is law.** Notation and ordering follow the charter's canon exactly.
- **Ask rather than guess** — if the lesson guide lacks what an exam question needs, flag `needs_clarification` rather than inventing content (never call `questionnaire` yourself).

## Blackboard protocol (wire — engine-consumed)

Room `wing=penny room=skills/learn-<session_id>` (in your task). Read the lesson guide and the charter first. Write the exam + answer key files per the file-structure spec to the output directory named in your task.

## Output

End with one `SUMMARY:` line per the OUTPUT FORMAT directive appended to your task: `lesson_complete`, `lesson_index`, plus `files_written` / `problem_count` / `mempalace_drawer` / `confidence`.
