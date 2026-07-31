# Verification Checklist — The full-corpus gate every course must pass

> Run by vera in the `verifying` state. Three tiers: mechanical conformance,
> structural alignment, and mathematical recomputation. ALL must pass. Always
> run against the ENTIRE output corpus — cross-file forks (notation,
> conventions) are invisible in single-file runs. Every check below caught a real shipped defect on the
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

# 13. Hierarchy-verbiage drift (pedagogy-spec §2) — banned structural nouns must return NOTHING:
grep -rniE '\b(topic|chapter|module|part) [0-9]+' $LF

# 14. Sim/exam/prediction term-debut audit (pedagogy-spec §12, §16.2) — every technical term in a
#     sim block's title or fallback text, every named term in an exam/quiz option, AND every term
#     in a prediction prompt or its option list must grep-hit in the guide prose BEFORE that
#     artifact's line/file position.

# 14b. Format floor (pedagogy-spec §7) — a bank of one easy format satisfies an ordering-only
#      "difficulty ramp", so count the formats. Every exam carries ≥1 multi-select and ≥1 numeric
#      item; every lesson practice set carries ≥1 item that is not single-answer multiple choice.
#      (Substitute the app_contract's own qtype vocabulary; scenario + cross-notation coverage and
#      the blueprint's own quotas are Tier 2. A charter-recorded waiver clears a named section.)
for f in <output_dir>/*/*/exam/practice_exam.md <output_dir>/*/final_prep/practice_exam.md; do
  [ -f "$f" ] || continue
  for t in mcq-multi numeric; do
    grep -qE "^[[:space:]]*qtype:[[:space:]]*$t\b" "$f" ||
      echo "$f: format floor — expected ≥1 $t item, found 0"
  done
done
for f in <output_dir>/*/*/study_guide/study_guide.md; do
  [ -f "$f" ] || continue
  n=$(grep -cE '^[[:space:]]*qtype:' "$f")
  s=$(grep -cE '^[[:space:]]*qtype:[[:space:]]*mcq-single\b' "$f")
  [ "$n" -gt 0 ] || continue        # no graded practice at all is check 10's violation, not this one
  [ "$n" -gt "$s" ] ||
    echo "$f: practice set is entirely mcq-single ($s of $n) — expected ≥1 other format"
done

# 14c. Reference resolution (pedagogy-spec §1, §5) — every 📌 Note's forward PROMISE and every
#      "Recall from ..." backward reference must resolve to a real header in the corpus. Extract
#      the targets, then diff them against the real headers; an unresolvable target is a
#      violation (an unfulfilled promise reads to the learner as a dead end):
grep -rhn '📌' $LF |
  grep -oiE '(formally introduced|introduced|taught|explored|covered|developed) in [^.;)]+' |
  sed 's/^/promise-target: /' | sort -u
grep -rhoE 'Recall from [^.,;)]+' $LF | sed 's/^/recall-target: /' | sort -u
grep -rh '^## \|^### ' $LF | sort -u          # the real headers each target must match
#      Also flag unnameable promises — "later", "a future lesson" cannot be resolved mechanically:
grep -rn '📌' $LF | grep -iE 'in (a )?(later|future|upcoming) (lesson|section)s?|later on'

# 15. Prediction-block integrity (pedagogy-spec §16) — app-rendered mode (charter rendering
#     branch 1). Substitute the app_contract's own prediction fence name for `predict`.
#     Every prediction block must carry a revealed payload and a confidence field:
awk '
  /^```predict/ { inblk=1; rev=0; conf=0; line=FNR; next }
  inblk && /^```[[:space:]]*$/ {
      if (!rev)  printf "%s:%d: predict block missing reveal payload\n", FILENAME, line
      if (!conf) printf "%s:%d: predict block missing confidence field\n", FILENAME, line
      inblk=0; next }
  inblk && /^[[:space:]]*reveal:/     { rev=1 }
  inblk && /^[[:space:]]*confidence:/ { conf=1 }
' $LF

# 15b. Prediction-block integrity — markdown fallback mode (charter rendering branch 2 or 3).
#      Every "Predict first" block is answered by a "Reveal" block in the SAME file; counts match:
for f in $LF; do
  p=$(grep -c '^> 🔮 \*\*Predict first:\*\*' "$f")
  r=$(grep -c '^> 🔮 \*\*Reveal:\*\*' "$f")
  [ "$p" = "$r" ] || echo "$f: prediction blocks=$p vs reveals=$r (each must pair 1:1)"
done

# 16. No prediction points in exams or final prep (pedagogy-spec §7, §8) — must return NOTHING
#     unless the charter's assessment blueprint records an explicit prediction allowance:
grep -rn '```predict\|🔮 \*\*Predict first:\*\*' \
  <output_dir>/*/*/exam/*.md <output_dir>/*/final_prep/*.md

# 17. Predictions never stand alone as a lesson's assessment (pedagogy-spec §16.5) — every guide
#     containing a prediction block must also contain graded ```question blocks:
for f in $(grep -rl '```predict\|🔮 \*\*Predict first:\*\*' <output_dir>/*/*/study_guide/study_guide.md); do
  grep -q '```question' "$f" || echo "$f: prediction blocks present but no graded question blocks"
done

# 18. Stock-phrase blacklist (§13) — zero hits over learner-facing files
grep -rniE 'load.bearing|delv(e|ing) into|deep dive|unpack|leverag|utiliz|seamless|worth noting|important to note|at its core|in the realm of|tapestry|testament to|game.changer|supercharge|unlock the power|harness|empower' \
  <output_dir> --include='*.md' \
  | grep -v '_authoring/' # authoring metadata is not learner-facing
#     A hit is a violation reported through the standard "<file>: <what> — <expected vs found>"
#     contract (expected: zero stock phrases; found: the offending line). A domain term that
#     collides with the pattern (a legitimate technical use of the word as a property under study)
#     is whitelisted with an inline `<!-- voice-ok -->` comment on the same line, excluded from the
#     grep, and justified in the provenance log.
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
      content — and every promise RESOLVES: the section a 📌 Note names exists and
      actually teaches the promised concept, and every "Recall from …" names an
      existing, earlier section (mech-check 14c clean; a header that exists but
      never teaches the promised concept is this tier's call, not the grep's)
- [ ] Guide-required fixed sections present: Quick-Reference Flashcard Summary
      (atomic one-per-card entries) and Unified Diagram; wide math is stacked to
      fit the display column (no horizontal overflow)
- [ ] Hierarchy verbiage: only Track/Course/Unit/Lesson/Section as structural
      nouns in learner prose and cross-references (mech-check 13 clean)
- [ ] Every new symbol/term carries a pronunciation at first introduction, and
      every common alias is taught at first use (pedagogy-spec §12)
- [ ] No cold opens: every section situates its concept (plain-language what +
      backward ref + forward hook) before manipulating it; the physical WHAT
      precedes the mechanics in every operation-teaching section (§9, §12)
- [ ] Voice is conversational patient-mentor: no unnarrated equation dumps, no
      textbook-register paragraphs (§13)
- [ ] Every practice set and every exam contains scenario-based
      recognize-the-tool items, additive to the mechanical ones (§14)
- [ ] Honest manifest: when the charter records a coverage-reference source, the
      course's source manifest carries BOTH roles — `role=learn-from` (the cited
      independent sources) and `role=coverage-reference` (the restricted rebuilt
      source, with license/bucket/URL + a do-not-ship note) — and no restricted
      artifact appears outside the authoring tree (`resources/`, `_authoring/`)
- [ ] **Blueprint conformance** (pedagogy-spec §7): compute each authored exam's and practice
      set's format mix (count `qtype:` by kind across its ` ```question ` blocks, plus the
      figure-bearing and cross-notation items) and compare it to the charter's Assessment
      Blueprint quotas. Report as `"<file>: format mix — expected <quota>, found <count>"`.
      Every answer being correct does NOT clear this check — fit to the target exam is a
      separate property from correctness
- [ ] **Skill-ceiling resolution** (§7): every skill-ceiling row in the blueprint resolves to a
      NAMED worked example and a NAMED assessment item at the level that row states. A row that
      resolves only below its stated level, or not at all, is a violation
- [ ] **Format floor** (§7): where the blueprint sets no stricter quota, every exam carries ≥1
      multi-select, ≥1 numeric, ≥1 scenario (§14) and ≥1 cross-notation item, and every lesson
      practice set carries ≥1 non-single-answer-multiple-choice item (mech-check 14b clean) —
      or the charter records the named section whose content allows no harder format
- [ ] **Prerequisite inventory resolved** (§12): every mathematical tool or technique used in
      prose, a worked example, a practice item, or an exam has an inventory row resolving it to
      the section that TEACHES it (that section preceding first use), or an explicit `assumed:`
      row justified against the stated audience. This is the toolchain-level analogue of the
      term-debut audit: a technique whose every symbol is glossed but which is never taught is
      still a violation
- [ ] **Presentation media** (§7, §10): where the blueprint records that the target exam presents
      artifacts pictorially, count the figure-bearing practice/exam items and compare to the
      blueprint quota; figures route through the `app_contract`'s own mechanism. A contract that
      cannot carry figures must appear as a **blocking gap** in the charter — prose descriptions
      substituted silently for pictures are a violation, not a fallback
- [ ] **Final-prep existence** (§8, file-structure spec): every final-prep artifact the file
      structure requires EXISTS on disk, is non-empty, and is non-trivial — each carries its own
      required sections rather than a heading with no body. Assertion that final prep is complete
      is not evidence; list the files and their section counts
- [ ] **Promise audit** (§8): every commitment made in an intro/overview section ("you will get a
      comprehensive review… an answer key… a final exam…") maps to an artifact that exists.
      Intros are short and enumerable, so enumerate them: a promised artifact that was never
      authored is a violation reported against the intro that promised it
- [ ] **Exam metadata decided** (§7): every exam artifact carries the blueprint's decided length,
      point weighting, pass mark, and timing in its metadata fields, and each matches the
      blueprint. An unset/null field is a violation — it cannot be distinguished from a decision
      never made (an *untimed* exam records that decision explicitly)
- [ ] **Cumulative mixed practice** (§8): the course's review/final-prep material carries a mixed
      GRADED question set (` ```question ` blocks) covering all lessons proportionally and
      format-mixed per the blueprint — count the blocks and their per-lesson coverage. A review
      artifact with zero graded questions is a violation however complete its prose
- [ ] **Delta audit** (pedagogy-spec §15): each lesson's provenance log carries a
      `## Section Delta Ledger` with exactly one row per **concept** section in that lesson's guide
      (practice-item sections, the "What You Will Learn" intro lesson, and the fixed closing
      sections are out of scope). Every row carries EITHER a non-empty delta capability sentence
      OR a scaffold tag from `analogy-reinforcement` / `spaced-restatement` / `review` / `bridge`
      plus the section(s) it reinforces. A row with neither, a ledger row naming a section that
      does not exist, and a concept section with no row are each violations. A delta that only
      restates the section title ("covers X") is not a delta
- [ ] **Delta uniqueness** (§15): no two ledger rows in a course declare the same delta. A
      duplicate is a violation unless one of the pair carries a scaffold tag instead of a delta
- [ ] **Prediction placement** (§16.2): every prediction prompt precedes, in the same section, the
      content that reveals its payload, with no intervening concept; the payload is a single
      discrete value, judgment, or ordering (never a derivation, explanation, or open question);
      at most one prediction point per concept section; nothing scores, gates, or requires a
      prediction
- [ ] **Prediction feedback** (§16.3): every option carries feedback naming the misconception that
      makes it attractive (no generic "not quite"), and every reveal carries the one-sentence
      explanation of why a wrong prediction helped
- [ ] **Prediction additivity** (§16.5): every section carrying a prediction point still carries
      its own graded practice question, and prediction blocks are excluded from every computed
      assessment count (per-section question requirement, format mix/floor, exam length,
      coverage)
- [ ] **Rendering branch recorded** (§16.4): the charter names which prediction rendering branch
      applies (contract primitive / markdown fallback), and where a fallback or a
      confidence-less primitive is used, records that no confidence signal is captured

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
