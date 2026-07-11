# Verification Checklist — The full-corpus gate every course must pass

> Run by vera in the `verifying` state. Two tiers: mechanical conformance and
> mathematical recomputation. BOTH must pass. Always run against the ENTIRE
> output corpus — cross-file forks (notation, conventions) are invisible in
> single-file runs. Every check below caught a real shipped defect on the
> course build that produced this skill.

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

# 6. Callout canon — whitelist approach (anything not canonical is a violation):
grep -rh "^> \*\*" $LF | grep -v "🍳 Everyday analogy\|📌 Note\|🧠 Remember This\|Front:\|Back:"
grep -rn "layman\|Layman" $LF   # inclusive-language check

# 7. Notation fork — for EVERY canon convention, grep both variants course-wide;
#    the non-canon variant must return zero (e.g. lowercase vs uppercase named states,
#    alternative symbols, competing orderings). Build these greps FROM the charter's
#    conventions canon — one check per canon row.

# 8. Convention statements audit — every sentence stating an ordering/labeling rule
#    must match the canon verbatim in meaning:
grep -rn -i "<canon keywords: e.g. 'top wire', 'leftmost', 'first qubit'>" $LF

# 9. Vendor branding (platform-agnostic requirement):
grep -rn "<vendor names from the charter>" $LF
```

## Tier 2 — Structural alignment

- [ ] Guide↔answers: numbered topic headers match 1:1 per lesson (diff the
      `grep "^## [0-9]"` output of each pair)
- [ ] Every numbered practice problem has exactly one `### Problem N:` solution
      with the same parameters and wording
- [ ] Every answer/key solution has Approach / Step-by-Step Solution / Key
      Formula stages, an `**Answer:**` line, one ⚠️ and one 💡
- [ ] Every Formal Definitions section opens with a "nothing new" statement and
      ends with exactly one 🧠
- [ ] Every topic has ≥2 practice problems; exams ramp in labeled difficulty
- [ ] Exam-teaches-what-guides-teach audit: every named formula/operator/
      technique in an exam grep-hits in that lesson's guide (or carries an
      inline Recall restatement)
- [ ] Forward references have 📌 Notes; "Recall" never references untaught
      content
- [ ] Guide-required fixed sections present: Quick-Reference Flashcard Summary,
      The One Diagram That Ties It All Together

## Tier 3 — Mathematical recomputation (never trust, always recompute)

- [ ] **Script it wherever the domain allows** (numpy/sympy for math-heavy
      courses): recompute every final numeric/matrix/symbolic result in every
      answers file and answer key and compare to the stated answer
- [ ] Multiple-choice keys: recompute the correct letter for EVERY question
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
