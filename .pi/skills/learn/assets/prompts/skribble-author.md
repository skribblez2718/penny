# Author Prompt — Learn Skill Context (study guide + practice answers)

## Mission

Author ONE lesson's `study_guide.md` and `practice_answers.md`, exactly to
spec. Read COMPLETELY before writing: the Charter (mempalace),
`.pi/skills/learn/resources/pedagogy-spec.md`, and
`.pi/skills/learn/resources/file-structure.md`. Your task message names the
lesson index.

## Mempalace-First Communication

- Before: read `<session_id> Charter` and every prior `<session_id> Author — lesson *`
  note from `wing=penny room=skills/learn-<session_id>` (earlier lessons define
  what "Recall from…" may reference and which analogies are in play)
- After: `memory_add_drawer(..., content="## <session_id> Author — lesson <i>\n\n<topics authored, analogies used, forward refs planted, files written>")`

## Non-Negotiables (each one shipped a real defect when skipped)

1. **Conventions canon is law.** Look up every notation/ordering decision in the
   charter — never decide locally, never follow the source when it conflicts.
2. **Three-phase per topic, unlabeled** — intuition (🍳 analogy + forward hook +
   📌 notes) → `### Worked Examples` (2–3, every step, verification, ending
   `#### Why This Matters` with 2–3 concrete applications) →
   `### Formal Definitions` ("nothing new" opener, maps back to examples,
   closes 🧠) → `### Practice Problems` (2–3 numbered, substantive).
3. **Registry analogies only**, carried through all phases of the topic.
4. **Do the math while you write.** Verify every worked example's arithmetic as
   you produce it — including intermediate products, and that diagrams, prose,
   and math describe the SAME configuration.
5. **Practice answers mirror the guide**: identical topic headers,
   `### Problem N:` per problem, Approach / Step-by-Step Solution / Key Formula,
   `**Answer:**` line, one ⚠️ Common Mistake + one 💡 Everyday Take each.
6. **Guide closes with** `## Quick-Reference Flashcard Summary` (one row per
   topic) and `## The One Diagram That Ties It All Together` (LaTeX arrays or
   markdown tables — no ASCII art).
7. First lesson only: foundational-conventions reminder at the top. Every
   guide: the single sanctioned `teaching_approach.md` link line. NOTHING else
   meta — no method labels (any case), no structure descriptions, no authoring
   rules.

## SUMMARY Contract

Return: `lesson_complete` (bool), `lesson_index` (int, the index you were
assigned) — required; optionally `lesson_title`, `files_written` (paths),
`topic_count`. Blocked on missing charter data → `needs_clarification: true`
+ `clarifying_questions`.
