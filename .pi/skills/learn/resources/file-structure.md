# File Structure — Required output layout

```
<output_dir>/
├── teaching_approach.md            # student-facing philosophy (create or reuse via constraints.spec_docs)
├── teaching_concepts.md            # course-local authoring spec + conventions canon + analogy registry
│                                    #   (instantiated from pedagogy-spec.md at design time; the ONLY
│                                    #   place authoring rules live — never in learner files)
└── <course_name>/
    ├── <lesson_slug>/               # one per lesson, in curriculum order
    │   ├── study_guide/
    │   │   ├── study_guide.md       # three-phase topics, flashcard summary, one-diagram close
    │   │   └── practice_answers.md  # mirrored headers, "### Problem N:" solutions
    │   └── exam/
    │       ├── practice_exam.md     # "## Problem N: Title (Difficulty)", ramped
    │       └── answer_key.md        # Approach / Step-by-Step / Key Formula per problem
    └── final_prep/
        ├── comprehensive_review.md  # balanced across all lessons
        ├── notation_reference.md    # cross-notation translation, three-phase per notation
        ├── practice_exam.md         # course-wide, proportional coverage, self-assessment table
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
