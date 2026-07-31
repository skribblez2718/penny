# File Structure — Required output layout

```
<output_dir>/                        # caller-provided output directory (passed as a constraint)
├── teaching_approach.md            # student-facing philosophy (create or reuse via constraints.spec_docs)
├── teaching_concepts.md            # course-local authoring spec + conventions canon + analogy registry
│                                    #   (instantiated from pedagogy-spec.md at design time; the ONLY
│                                    #   place authoring rules live — never in learner files)
├── _authoring/                     # author-only; NEVER learner-facing. Clean-room evidence the
│   │                                #   `derivation` gate consumes per lesson (pedagogy-spec §11)
│   ├── concept_skeletons/
│   │   └── <lesson_slug>.md         # the idea layer — the non-copyrightable facts/what a lesson conveys
│   └── provenance/
│       └── <lesson_slug>.md         # provenance log: concept → sources that taught it → re-expression
│                                    #   note; PLUS the lesson's "## Section Delta Ledger" (pedagogy-spec §15)
└── <course_name>/
    ├── <lesson_slug>/               # one per lesson, in curriculum order
    │   ├── study_guide/
    │   │   ├── study_guide.md       # three-phase topics, flashcard summary, one-diagram close
    │   │   └── practice_answers.md  # mirrored headers, "### Problem N:" solutions
    │   └── exam/
    │       ├── practice_exam.md     # "## Problem N: Title (Difficulty)", ramped; each problem a
    │       │                        #   fenced ```question DSL block (pedagogy-spec §7) — the build
    │       │                        #   compiles it into the graded Exam; never hardcoded in app code
    │       └── answer_key.md        # author-facing: Approach / Step-by-Step / Key Formula per problem
    └── final_prep/
        ├── comprehensive_review.md  # balanced across all lessons; carries the CUMULATIVE mixed
        │                            #   graded ```question set (pedagogy-spec §8)
        ├── notation_reference.md    # cross-notation translation, three-phase per notation
        ├── practice_exam.md         # course-wide, proportional coverage, self-assessment table;
        │                            #   problems are ```question DSL blocks (become graded lessons)
        └── exam_answer_key.md       # includes Front/Back flashcard blocks
```

Rules:

- Lesson slugs are lowercase_underscore, derived from lesson titles, ordered by
  the charter's curriculum sequence.
- Source material is NEVER modified — it may live anywhere (`source_dir`) and
  may optionally be linked from guides as `resources/`.
- The zero-indexing / foundational-conventions reminder appears in the FIRST
  study guide only.
- Every study guide opens with the single sanctioned link line to
  `teaching_approach.md`.
- The charter (mempalace) records this tree with every planned file; verifying
  checks the tree is complete.
- `_authoring/` is clean-room evidence, not courseware: concept skeletons and
  provenance logs are never linked from or rendered in learner files. They are the
  inputs the `derivation` gate reads per lesson (`skeleton` + `provenance`), alongside
  the course's source manifest (`manifest.<course>.json`). Keep one skeleton and one
  provenance log per lesson; keep the provenance log honest and current.
- **Section Delta Ledger** (pedagogy-spec §15). Each lesson's provenance log carries a
  `## Section Delta Ledger` table — one row per **concept** section, written in the same pass that
  authors the section (practice-item sections, the "What You Will Learn" intro lesson, and the
  fixed closing sections are out of scope). Every row declares EITHER a delta (a capability
  sentence: what a learner who absorbed all prior sections could not produce before this section)
  OR a scaffold tag from the closed vocabulary `analogy-reinforcement` / `spaced-restatement` /
  `review` / `bridge` plus the section(s) it reinforces — never neither, never both. This is
  author-only pedagogy metadata; it is never rendered, linked, or quoted in learner files, and the
  `derivation` gate reads the provenance portion of the file.

  ```markdown
  ## Section Delta Ledger

  | Section | Delta (capability the learner gains) | Scaffold | Reinforces |
  |---|---|---|---|
  | 1. <section title> | Compute <result> from a given <input> | — | — |
  | 2. <section title> | Decide whether <condition> holds for a given <object> | — | — |
  | 3. <section title> | — | spaced-restatement | 1 |
  ```
- The course's source manifest is an **honest ledger of both roles**: `role=learn-from`
  (the cited independent sources) and `role=coverage-reference` (a restricted source the
  course was rebuilt against, with license/bucket/URL + a do-not-ship note). Restricted
  artifacts are **authoring-tree-only** — never copied into a build artifact or served
  endpoint; the build ingests only authored content, never `resources/` (pedagogy-spec §11).
  The gate corpus passed to `derivation` MUST include the coverage-reference source even
  when a shipped manifest omits it.
- **All paths are caller-provided.** `<output_dir>`, `source_dir`, and any spec docs are passed as
  constraints at invocation; the skill hardcodes no filesystem location and assumes nothing about
  where content lives. App-specific serialization (e.g. compiling markdown into an LMS import
  artifact) is defined by the caller-provided `app_contract` (the target app's own docs), never
  in this general layout.
