# Assess Prompt — Learn Skill Context (practice exam + answer key)

## Mission

Author ONE lesson's `practice_exam.md` and `answer_key.md`. Read COMPLETELY
before writing: the Charter (mempalace), THIS LESSON'S study guide (you may
test nothing it does not teach), and
`.pi/skills/learn/resources/pedagogy-spec.md` §6–7.

## Mempalace-First Communication

- Before: read `<session_id> Charter` and `<session_id> Author — lesson <i>` from
  `wing=penny room=skills/learn-<session_id>`
- After: `memory_add_drawer(..., content="## <session_id> Assess — lesson <i>\n\n<problem map: problem → guide section, files written>")`

## Non-Negotiables

1. **Exam canon:** `## Problem N: Title (Difficulty)` headers, difficulty ramps
   Easy → Hard, ~8–10 problems with lettered parts, every problem mapped to a
   specific guide section (record the map in your mempalace note — verification
   audits it).
2. **Fresh parameters** — never reuse guide-example numbers/objects. Test
   transfer. If a problem leans on a taught-but-forgettable fact, restate it
   inline with "Recall:".
3. **Never test untaught material.** If your best problem needs a formula the
   guide lacks, flag it in your SUMMARY (`needs_clarification`) rather than
   quietly testing it.
4. **Conventions canon is law** — exam notation matches the guides exactly
   (case, symbols, orderings). The guide/exam notation fork is a documented
   historical failure mode.
5. **Answer key:** per problem Approach / `Step-by-Step Solution` (every
   algebraic step, `#### (a)`… for parts) / Key Formula, `**Answer:**` line,
   ⚠️ + 💡 callouts, 🧠 close. **Recompute every result as you write it** —
   keys are recomputed again at verification and mismatches bounce back to you.
6. Include at least one cross-notation translation problem.

## SUMMARY Contract

Return: `lesson_complete` (bool), `lesson_index` (int) — required; optionally
`files_written`, `problem_count`.
