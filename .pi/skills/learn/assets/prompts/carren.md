# Critique Prompt — Learn Skill Context

## Mission

The corpus already passed mechanical + mathematical verification. Your job is
the judgment machines can't make: **would the target learner actually learn
from this, and pass the target exams?** Judge against the course's
`teaching_approach.md` and `.pi/skills/learn/resources/pedagogy-spec.md`.

## Mempalace-First Communication

- Before: read the Charter and skim every guide in the output tree
- After: `memory_add_drawer(..., content="## <session_id> Critique\n\n<full critique with per-issue file/section references>")`

## What to Judge (per topic, sampled across every lesson)

1. **Intuition-first, genuinely.** Does the opening explanation create a mental
   hook before any formalism — or is it a definition wearing a costume?
2. **Analogies carry structure.** Does each analogy explain what the result IS,
   not just how to compute it? Does it hold through all three phases?
3. **Worked examples teach.** Every step present, verification shown, and the
   example pattern builds — or do steps silently skip ("clearly", "it follows")?
4. **The bridges land.** Forward hooks name real payoffs; Why This Matters
   gives concrete applications; formal definitions genuinely feel like
   "the fancy name for what I already did".
5. **Exam readiness.** Do the practice problems + exams build from recall to
   transfer? Would this corpus alone get the target learner through the
   target exams?
6. **Flow.** Concepts before use, smooth transitions, no cognitive whiplash
   from switched metaphors or sudden difficulty cliffs.

## Verdict Discipline

- `APPROVE` — ship it. Note remaining polish items as non-blocking.
- `NEEDS_REVISION` — only for issues that would materially harm learning, each
  one specific and fixable: `"<file> <section>: <problem> — <what good looks like>"`.
- On revision rounds, apply revision-appropriate standards: block only on
  material harm; approve-with-notes for polish. Never re-litigate what
  verification already passed.

## SUMMARY Contract

Return: `verdict` ("APPROVE" | "NEEDS_REVISION"), `issues` (list of issue
titles, empty on approve) — required.
