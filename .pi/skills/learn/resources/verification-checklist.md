# Verification Checklist — The full-corpus gate every course must pass

> Run by vera in the `verifying` state. Two tiers: mechanical conformance and
> mathematical recomputation. BOTH must pass. Always run against the ENTIRE
> output corpus — cross-file forks (notation, conventions) are invisible in
> single-file runs. Every check below caught a real shipped defect on the
> course build that produced this skill.
>
> **Scope:** this suite is mechanical + mathematical conformance only. Clean-room
> *independence* (built from ≥2 sources, sources-closed, no derivative expression) is
> a **separate** gate — the `derivation` skill, run per lesson before publish — not
> checked here. App-specific serialization (DSL fences, lint command) follows the
> **target app's output contract** (caller-provided `app_contract` — the app's own DSL/build docs).

## Tier 1 — Mechanical conformance (scripted; adapt paths per course)

```bash
LF=$(find <output_dir> -name "*.md")   # all learner files

# 1. Method-label leak — CASE-INSENSITIVE (title-case leaks like "the Walk" are real):
grep -rni "crawl\|the walk\b\|walk example\|walk section\|walk phase\|🐢\|🚶\|🏃\|✏️" $LF

# 2. Author-facing content leak (authoring rules, spec references, "how we teach" blocks):
grep -rln "General Principles\|Analogy Registry\|pedagogy-spec\|authoring rules" $LF

# 3. Duplicate NUMBERED section headers within a file:
grep "^## " <file> | grep -o "^## [0-9][0-9.]*" | sort | uniq -d

# 4. Duplicated paragraphs / copy-paste artifacts:
awk 'length($0)>200' <file> | sort | uniq -d

# 5. ASCII math, backtick math, latex fences, literal unicode escapes:
grep -rn '`[\\$]\|```latex\|\\u00[0-9a-f]' $LF

# 5b. Retired structures + stale wording (standalone Formal-Definitions section, Quick Check,
#     "the below definition" pointers) — all must return zero:
grep -rni "^#\+ *Formal Definitions\|Quick Check\|below definition\|definition below\|the below\b" $LF

# 6. Callout canon — whitelist approach (anything not canonical is a violation):
grep -rh "^> \*\*" $LF | grep -v "🍳 Everyday analogy\|📌 Note\|🧠 Remember This\|Front:\|Back:"
grep -rn "layman\|Layman" $LF   # inclusive-language check

# 7. Notation fork — for EVERY canon convention, grep both variants course-wide;
#    the non-canon variant must return zero (e.g. lowercase vs uppercase named states,
#    alternative symbols, competing orderings). Build these greps FROM the charter's
#    conventions canon — one check per canon row.

# 8. Convention statements audit — every sentence stating an ordering/labeling rule
#    must match the canon verbatim in meaning:
grep -rn -i "<canon keywords: e.g. 'first column', 'leftmost', 'top row'>" $LF

# 9. Vendor branding (platform-agnostic requirement):
grep -rn "<vendor names from the charter>" $LF

# 9b. Source-identity leak (original-naming rule, pedagogy-spec §11) — the coverage-reference
#     source's distinctive course/lesson titles and any "Lesson N of <Source Course>"
#     self-identification must return ZERO in learner files. Build the grep list FROM the
#     charter's source map (annie lists the coverage-reference titles there):
grep -rni "<coverage-reference course/lesson titles from the charter>\|Lesson [0-9]* of" $LF

# 10. Practice authored as DSL, not prose — every ### Practice Problems section must contain a
#     ```question fence (a free-text numbered practice list is a defect); exhibits are ```sim fences
#     (grammar: the caller-provided app_contract — the target app's own content DSL):
grep -rln '```question' $LF          # study guides with graded practice should hit
grep -rn  '```sim' $LF               # interactive exhibits, where present

# 10b. Exams authored as DSL (exam canon, pedagogy-spec §7) — every per-lesson exam AND the
#      final-prep exam must author each problem as a ```question fence; a prose-only exam file
#      is a defect (this list must return NOTHING):
grep -rL '```question' <output_dir>/*/*/exam/practice_exam.md <output_dir>/*/final_prep/practice_exam.md

# 11. KaTeX in a DSL scalar must be single-quoted or block-scalar, NEVER double-quoted (must return NOTHING):
grep -rnE '^[[:space:]]*(-[[:space:]]+)?(prompt|text|feedback|explanation|reveal|title):[[:space:]]*"[^"]*\$' $LF

# 12. Structural validity of every ```question/```sim block (mcq-single exactly-one-correct, numeric
#     has answer:, sim engine dir + files exist) is enforced by the target app's DSL gate — pre-check
#     with the target app's own DSL lint (whatever the caller-provided app_contract specifies)
```

## Tier 2 — Structural alignment

- [ ] The course's FIRST unit is an **Introduction** whose single lesson is a
      "What You Will Learn" overview: welcome paragraph, a "By the end of this
      course you will be able to:" outcome list, and a how-to-work-it closing
      line — scope-setting prose only, no new concepts, no practice questions

- [ ] Guide↔answers: numbered topic headers match 1:1 per lesson (diff the
      `grep "^## [0-9]"` output of each pair)
- [ ] Every numbered practice problem has exactly one `### Problem N:` solution
      with the same parameters and wording
- [ ] Every answer/key solution has Approach / Step-by-Step Solution / Key
      Formula stages, an `**Answer:**` line, one ⚠️ and one 💡
- [ ] Every concept section CLOSES with its inline formal definition (a "nothing
      new" statement + exactly one 🧠) — there is NO standalone
      `### Formal Definitions` section and no "Quick Check"
- [ ] Practice is graded + interactive, one question per section, answerable from
      the content that precedes it; exams ramp in labeled difficulty
- [ ] Each practice item is a fenced ` ```question ` block (not a free-text
      numbered list) under the `### Practice` heading; each interactive exhibit is a
      fenced ` ```sim ` block (grammar: the caller-provided `app_contract` —
      the target app's own content DSL)
- [ ] Every `mcq-single` block has exactly one `correct: true` (`mcq-multi` ≥1);
      `numeric` carries an `answer:` normalization; `self-check` only where nothing
      auto-gradable fits; all KaTeX (`$…$`) DSL fields are single-quoted or
      block-scalar, never double-quoted (pre-check with `--dsl-lint-only`)
- [ ] Exams are DSL, in the course tree: every exam file's problems are fenced
      ` ```question ` blocks under `## Problem N: Title (Difficulty)` headings
      (never free-text prose, never content destined for app code); the answer
      key remains the author-facing worked reference
- [ ] Exam-teaches-what-guides-teach audit: every named formula/operator/
      technique in an exam grep-hits in that lesson's guide (or carries an
      inline Recall restatement)
- [ ] Forward references have 📌 Notes; "Recall" never references untaught
      content
- [ ] Guide-required fixed sections present: Quick-Reference Flashcard Summary
      (atomic one-per-card entries) and Unified Diagram; wide math is stacked to
      fit the display column (no horizontal overflow)
- [ ] Honest manifest: when the charter records a coverage-reference source, the
      course's source manifest carries BOTH roles — `role=learn-from` (the cited
      independent sources) and `role=coverage-reference` (the restricted rebuilt
      source, with license/bucket/URL + a do-not-ship note) — and no restricted
      artifact appears outside the authoring tree (`resources/`, `_authoring/`)

## Tier 3 — Mathematical recomputation (never trust, always recompute)

- [ ] **Script it wherever the domain allows** (numpy/sympy for math-heavy
      courses): recompute every final numeric/matrix/symbolic result in every
      answers file and answer key and compare to the stated answer
- [ ] Multiple-choice keys AND ` ```question ` blocks: recompute the correct
      option for EVERY question and confirm it matches the one marked `correct: true`
- [ ] Worked examples in guides: verify each derivation's end state (at
      minimum) and any step the derivation pivots on
- [ ] Intermediate products in multi-step derivations (matrix products,
      compound expressions) — the course build found a printed product whose
      final answer was right but whose intermediate rows were wrong
- [ ] Diagrams vs prose vs math: when a worked example has all three, check
      they describe the SAME thing (a diagram with markers on the wrong
      element while prose and math agree is a real failure mode)
- [ ] Convention-dependent results (anything whose value depends on an
      ordering/labeling canon) get re-derived UNDER THE CANON, not pattern-
      matched

## Reporting contract

Emit `verified: true` only when every tier passes. Otherwise emit
`verified: false` and `violations` as a list of specific, fixable strings:
`"<file>: <what> — <expected vs found>"`. Vague violations ("style issues in
guide 2") are themselves a violation. Write the full report to the session's
mempalace room; the SUMMARY carries only the list.
