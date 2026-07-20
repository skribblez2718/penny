# Pedagogy Spec — Binding authoring rules for all study materials

> Agent-consumable. Every study guide, practice answer file, exam, answer key,
> review sheet, and reference produced by the learn skill follows these rules.
> Distilled from a full course build (2026-07), where every
> rule below caught (or would have caught) a real shipped defect.

## 0. Course Positioning

- **Platform-agnostic.** Prepare the learner to pass ANY introductory exam on
  the topic. Never brand content as belonging to one vendor. Where conventions
  differ across platforms, teach the course canon explicitly and note the
  translation once.
- **Audience default:** adult learner with rusty prerequisites, learns by
  doing, not assumed to be a programmer or domain specialist. Honor
  `constraints.audience` overrides.
- **Three learning channels:** doing (practice, today), listening and seeing
  (read-aloud + visuals, future renderer). Author text-first but
  modality-ready (Rule 10).
- **Clean-room by construction.** Author each concept sources-closed from your own
  understanding, built on ≥2 independent sources where the corpus allows; keep a
  provenance log. See §11. Independence is verified *separately* by the `derivation`
  skill — never self-graded here.

## 1. Course Opener + Concept Structure (intuition → example → formal per concept; graded practice)

**Every course opens with an Introduction unit.** The FIRST unit of every course is an
**Introduction** whose single lesson is a **"What You Will Learn"** overview section, written
in the author's own words:

- a short welcome paragraph placing the course in the track (what came before, what it
  unlocks next);
- a **"By the end of this course you will be able to:"** list of concrete, checkable
  learning outcomes (one bullet per capability, bolding the key term each outcome teaches);
- a closing line on how to work the course (practice completes on a correct answer; finish
  with the course exam where one exists).

Header grammar: the intro lesson takes topic number `0` (`## 0. What You Will Learn`) — or the
target app's own intro-unit convention where it differs — and the teaching topics then number
from `1`. The overview is scope-setting prose only: no new concepts, no practice questions.

Each **concept** is taught end-to-end in ONE section — **intuition → worked example → its formal
definition** — and the formal definition **CLOSES that section**. There is NO separate "Formal
Definitions" section. Practice is **graded and interactive**, one question per section. Natural
headers only:

- **Intuition** opens the concept section (no separate header). It MUST contain: one
  `> **🍳 Everyday analogy:**` (verified per Rule 3), a forward hook (one or two sentences naming
  where the concept pays off later), and `> **📌 Note:**` callouts for any concept used before its
  formal introduction.
- The **worked example** (inside the same section) shows every algebraic step from the problem
  statement to the solution, ends in verification, then a `#### Why This Matters` bridge (2–3
  applications tied to specific later sections/lessons). NEVER narrate the teaching method itself.
- The **formal definition CLOSES the same section**: a "nothing new here" statement (varied wording),
  the definition mapped back to THAT section's example, and `> **🧠 Remember This:**`. Never a standalone
  `### Formal Definitions` section; never "see the definition below".
- **Practice = graded questions, one per section, authored as `question` DSL blocks.** Each practice
  item is its OWN section with a single graded, interactive question answerable from the content that
  PRECEDES it. NO "Quick Check" — those are just practice questions. The question is authored as a
  fenced ` ```question ` block under the section's `### Practice` heading (one block per question,
  never a free-text numbered list); the offline build compiles each into one graded section. Canonical
  grammar: the **target app's output contract** (caller-provided `app_contract` — the app's own
  content-DSL docs, in the app's repo; this spec bundles no app grammar).
  - **`qtype` — pick the tightest auto-gradable form:** `mcq-single` / `mcq-multi` for concept checks
    (write domain-accurate distractors + per-option `feedback` naming each misconception;
    `mcq-single` = exactly one `correct: true`, `mcq-multi` = one or more), `order` for step-sequences
    (options authored in correct order, shuffled at serve time), `numeric` with an `answer:`
    normalization block for computed values, `true_false` for a single claim. Use `self-check`
    (reveal-only) **only** for genuinely non-auto-gradable derivations — prefer an auto-gradable type.
  - **CRITICAL YAML + LaTeX rule:** any field containing KaTeX (`$…$`) MUST use a single-quoted
    (`'…'`) or block-scalar (`|`) YAML scalar, **never a double-quoted** (`"…"`) one — YAML eats the
    backslashes inside double quotes and the build rejects it, naming the block.
  - The block carries its own `explanation` + per-option `feedback`, so the companion
    `practice_answers.md` is an **author-only reference** (answer-verification + the deeper worked
    solutions: Approach → Step-by-Step → Key Formula), not the learner's grading path.

  Example (`mcq-single`; `$…$` fields single-quoted, block scalars via `|`):

  ```question
  qtype: mcq-single
  prompt: |
    What is $\tfrac12 + \tfrac14$?
  options:
    - text: '$\tfrac34$'
      correct: true
      feedback: 'Common denominator 4: $\tfrac24+\tfrac14=\tfrac34$.'
    - text: '$\tfrac13$'
      correct: false
      feedback: 'Numerators and denominators are not added separately.'
  explanation: |
    $\tfrac12+\tfrac14=\tfrac24+\tfrac14=\tfrac34$.
  ```

**Meta-reference ban:** no methodology labels (crawl/walk/run or equivalents,
ANY case), no "how to use this guide" blocks, no authoring conventions, no
structure descriptions in learner files. The one sanctioned exception: a
single link line to the course's student-facing teaching-approach doc at the
top of each study guide.

## 2. Conventions Canon (decide once, globally, BEFORE authoring)

The single biggest quality killer is a convention decided per-file. At design
time, enumerate EVERY decision two files could make differently and fix each
one course-wide in the charter:

- Notation for every recurring object (case, symbols, decorations)
- Ordering conventions (index direction, ordering of composite labels,
  diagram-position ↔ notation-position mappings)
- Terminology (one primary term per concept; synonyms introduced once,
  parenthetically, then never used)
- Track/course/lesson/section **titles are the author's own** — never a source's course/lesson
  titles, never a "Lesson N of <Source Course>" self-identification — and the spine (course
  boundaries, unit bundling, lesson order) follows the author's own pedagogical logic, not a
  source's table of contents (binding rule + rationale in §11)
- Header grammar: topics `## N. Title` — `0` is reserved for the course's "What You Will
  Learn" intro (§1), teaching topics number from `1` (consistent per lesson and matching the
  answers file); phase headers at `###`; sub-parts at `####`; exams
  `## Problem N: Title (Difficulty)`
- Fixed section names: `Quick-Reference Flashcard Summary` (each entry an atomic one-per-section card)
  and `Unified Diagram` close every guide; gate-teaching guides add a **gate cheat sheet** giving
  each covered gate in matrix + Dirac form
- All math in LaTeX (`$`/`$$`), never ASCII math, never backtick-wrapped math — AND it must **fit the
  display column**: wide expressions (ket lists, ket→bra conversions, rows of column vectors) are
  **stacked vertically**, never laid out horizontally where they overflow; use LaTeX symbols
  (`\neq`, `\otimes`) not pasted Unicode that can render as a blank box

Where the source material itself is inconsistent, the charter picks the
variant that maximizes transfer to real-world tools/exams and documents the
translation.

## 3. Analogy Registry (one analogy per concept, forever)

- Maintain a registry table in the charter: concept → canonical everyday
  analogy → orientation rule. Every analogy used anywhere MUST be registered
  first; changing one requires a grep-sweep of ALL files.
- Everyday objects only (kitchen/living-room test). NEVER programming
  analogies. Analogies must carry structural meaning (what the result IS), not
  just computation steps ("multiplication table"-style mechanical analogies
  are banned).
- **Verify the analogy actually DEMONSTRATES the concept's key property before shipping it** — a
  mismatched analogy is worse than none. A non-commutative operation needs an analogy where order
  genuinely changes the result (cake-making: mix-then-bake ≠ bake-then-mix), not steps that commute.
  Drop forced or self-referential metaphors in favor of ones that map cleanly.
- Physical orientation matches mathematical orientation (vertical analogies
  for column-like objects, horizontal for row-like).
- Analogies must be drawable (future visuals) and speakable (future
  read-aloud).

## 4. Canonical Callouts (exactly six, everywhere)

| Callout | Marker | Job |
|---|---|---|
| Everyday analogy | `> **🍳 Everyday analogy:**` | Ground the math in the tangible |
| Note (forward ref) | `> **📌 Note:**` | Define a not-yet-taught concept at first use + where it's formally introduced + reassurance |
| Remember This | `> **🧠 Remember This:**` | One-sentence takeaway (end of Formal Definitions; end of key solutions) |
| Common Mistake | `> ⚠️ **Common Mistake:**` | The specific error learners make on this exact step (answers + keys) |
| Everyday Take | `> 💡 **Everyday Take:**` | Result restated in plain language (answers + keys) |
| Flashcard | `> **Front:** / > **Back:**` inside a 🧠 block | Spaced-repetition extraction unit (final-prep files only) |

No file invents new callout labels. Bold-labeled blockquotes that aren't these
six are banned — use plain bold text or fold into Key Formula. Inclusive
language always ("in plain terms", never "layman's").

## 5. Cross-File Alignment (Rule of Pairs)

- Answers files mirror guide topic headers exactly (same numbers, same
  titles). Number problems (`### Problem N:`) so alignment is machine-checkable.
- Every edit to one file of a linked pair (guide↔answers, exam↔key)
  synchronizes the other in the same pass.
- Backward references ("Recall from Lesson/Section N…") only for
  already-taught content; forward references always via 📌 Note.
- Basic intro concepts are taught once (first guide) and never re-taught;
  build-on relationships are made explicit.

## 6. Answer & Key Canon

Every solution — practice answers and exam keys — uses the stages
**Approach → Step-by-Step Solution → Key Formula** (one header level below the
problem header), a bold `**Answer:**` line, then ⚠️ Common Mistake and
💡 Everyday Take. Show every algebraic step. Keys may close with a
quick-reference table and a common-mistakes checklist.

## 7. Exam Canon

- Exams test ONLY what the guides teach. Every problem maps to a taught
  section; any formula not in a guide must be added to the guide first or
  restated inline with a "Recall:" note.
- Fresh parameters — never copies of guide examples. Test transfer, not recall.
- **Exams are authored AS graded DSL in the course tree and build like study guides — never
  hardcoded in the target app's code.** A per-course exam lives at `<course>/exam/practice_exam.md`;
  each problem is a fenced ` ```question ` block under a `## Problem N: Title (Difficulty)` heading —
  the SAME grammar as inline practice (§1) — so the offline build compiles it into the course's
  graded Exam. Pick the tightest auto-gradable `qtype` (write domain-accurate distractors +
  per-option `feedback`); use `self-check` only for a genuinely open derivation. The companion
  `<course>/exam/answer_key.md` stays the author-facing worked key (Approach → Step-by-Step → Key
  Formula). Authoring an exam directly in the app's code breaks the author-in-tree → build → ship
  mirror and is prohibited.
- Difficulty ramps (Easy → Hard, labeled). Final-prep ships the same way — its ` ```question ` blocks
  become graded lessons — with a per-lesson coverage balance and a self-assessment table.
- Cross-notation translation problems appear in every exam (a known learner
  weak spot).

## 8. Final Prep (course-wide)

- Comprehensive review: formula tables with "In Plain Terms" columns,
  protocols/pitfalls sections, balanced across ALL lessons.
- Notation reference: same three-phase structure per notation, master
  translation tables.
- Final exam + key covering every lesson proportionally.

## 9. The Practical Why

Every topic answers "why" twice: the forward hook (intuition phase) and the
Why This Matters applications bridge (after worked examples). The learner
never learns a procedure without knowing what it buys them.

## 10. Modality-Ready Authoring

The web app renders read-aloud narration, inline images, and **interactive exhibits** (e.g.
an animated geometric transformation). Author text-first (the prose must stand alone as a
text-only fallback), modality-ready: callouts are stable machine-recognizable blocks; worked-example
steps are atomic (one transformation per displayed equation, stated in words first); analogies are
physically drawable; no layout-dependent meaning (markdown tables and LaTeX arrays, not ASCII art —
ASCII diagrams only where the concept IS the diagram, always with equivalent prose); flashcard tables
use a consistent extractable shape. **Inherently-visual operations specify an interactive
visualization** (initial state → operation → resulting motion) alongside the standalone prose. That
visualization is authored as a fenced ` ```sim ` block — `title`, `engine`, and optional `config`
(injected as `window.SIM_CONFIG`) — whose `engine` names an engine directory `sims/<engine>/`
(`index.html` + `style.css` + `main.js`, optional `fallback.txt`) relative to the study guide; the
build inlines the engine files into a sandboxed exhibit. Canonical grammar: the **target app's
output contract** (caller-provided `app_contract` — the app's own interactive-exhibit DSL; this
spec bundles no app grammar).
Example:

```sim
title: Unit Circle — Sine and Cosine
engine: unit-circle
config:
  angle: 45
```

## 11. Clean-Room Authoring (independence by construction)

Every lesson is authored so the result is a **legally independent work** — built from a
corpus of sources and your own understanding of the underlying material, owing no
attribution, license compliance, or ShareAlike to any source. Copyright protects
**expression**, never facts, mathematics, ideas, methods, or procedures — so content
that takes only the unprotectable layer and expresses it independently is not a
derivative work, and each source's license becomes moot.

- **Idea layer only from sources.** From the material, extract the *facts / what* a
  concept must convey (a bare skeleton). Never carry over a source's prose, section
  order, selection/arrangement, distinctive examples, analogies, or figures — those are
  protected expression **even when reworded**.
- **≥2 independent sources per non-trivial concept** (where the corpus allows). Learn the
  mathematics from several sources, then write from the synthesis. Multiplicity of inputs
  is what makes the output demonstrably yours; single-source dependence is the decisive
  originality risk. With one supplied source, hold the discipline and report the target as
  unmet.
- **Sources-closed synthesis.** Design scaffolding (§1–§2) and draft prose with all
  sources closed. If you get stuck on a fact, reopen a source to *re-learn* it, close it,
  and write again — never with a source's prose open as a template. Low text overlap ≠
  independence: paraphrasing or mirroring a source's structure with fresh wording still
  creates a derivative.
- **Original examples, analogies, diagrams, quizzes** (already required by §1, §3, §7,
  §10) — never a source's. Keep field-standard *objects of the subject* (e.g. a fair
  coin, a canonical worked example); invent your own packaging. Canonical field citations
  (textbooks, papers) are fine — you cite results, you do not lift their exposition.
- **Provenance log per lesson** — concept → which sources taught it → date → a one-line
  note on how it was re-expressed. The evidence trail of independence; keep it honest and
  current (a back-filled log is worse than none).
- **Original names & the author's own spine.** The track, course, lesson, and section *titles* are
  the author's own — never a source's course/lesson titles, and never a "Lesson N of <Source
  Course>" self-identification (adopting a source's course identity is a structural derivation tell).
  Organize the spine — course boundaries, unit bundling, lesson order — on your own pedagogical
  logic; where it improves the build-up, re-sequence and re-bundle **away from** a source's table of
  contents. Standard *topic* names ("Inner Products", "No-Cloning Theorem") are unprotectable and
  fine; a source's distinctive *course/lesson naming and bundling* is not.
- **Coverage-glance vs learn-from.** A restricted source that *is* the course being rebuilt (a
  copyleft/unknown-license course) is a **`role=coverage-reference`** — glance it ONCE for *coverage*
  (which topics exist), never for *how*, and never as a learn-from source. Learn-from sources are the
  independent, license-vetted registry (≥2/concept, above). The course `manifest.json` records both
  roles honestly: `role=learn-from` (the cited independent sources) and `role=coverage-reference`
  (the restricted source, with license/bucket/URL + a do-not-ship note).
- **Restricted artifacts are authoring-tree-only, never shipped.** A restricted source's notebooks,
  slides, and verbatim transcripts live in the course `resources/` as a provenance archive; they are
  NEVER copied into a build artifact, container image, or any served endpoint of the target app. The
  build ingests only authored content, never `resources/`.
- **The independence *check* is a separate skill.** This spec carries the *pedagogy*; it
  does not grade independence. That is the **`derivation` skill**, run per lesson before
  publish, by a different agent/model than the author (an author cannot grade itself, and a
  checker that sees the sources would break clean-room). The **source registry** (buckets +
  licenses), manifest, and provenance logs are **caller-provided, in the course directory** —
  not in this skill; this spec carries the *authoring* discipline, the `derivation` skill the
  *check*.
