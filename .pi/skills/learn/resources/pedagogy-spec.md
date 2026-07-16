# Pedagogy Spec — Binding authoring rules for all study materials

> Agent-consumable. Every study guide, practice answer file, exam, answer key,
> review sheet, and reference produced by the learn skill follows these rules.
> Distilled from the quantum-information course build (2026-07), where every
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

## 1. Concept Structure (intuition → example → formal per concept; graded practice)

Each **concept** is taught end-to-end in ONE chunk — **intuition → worked example → its formal
definition** — and the formal definition **CLOSES that chunk**. There is NO separate "Formal
Definitions" section. Practice is **graded and interactive**, one question per chunk. Natural
headers only:

- **Intuition** opens the concept chunk (no separate header). It MUST contain: one
  `> **🍳 Everyday analogy:**` (verified per Rule 3), a forward hook (one or two sentences naming
  where the concept pays off later), and `> **📌 Note:**` callouts for any concept used before its
  formal introduction.
- The **worked example** (inside the same chunk) shows every algebraic step from the problem
  statement to the solution, ends in verification, then a `#### Why This Matters` bridge (2–3
  applications tied to specific later sections/lessons). NEVER narrate the teaching method itself.
- The **formal definition CLOSES the same chunk**: a "nothing new here" statement (varied wording),
  the definition mapped back to THAT chunk's example, and `> **🧠 Remember This:**`. Never a standalone
  `### Formal Definitions` section; never "see the definition below".
- **Practice = graded questions, one per chunk.** Each practice item is its OWN chunk with a single
  graded, interactive question (multiple-choice, ordering, true/false, numeric) answerable from the
  content that PRECEDES it. NO "Quick Check" — those are just practice questions. The companion
  answers file carries the full worked solution (Approach → Step-by-Step → Key Formula) for the
  deeper problems.

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
- Header grammar: topics `## N. Title` (numbering may start at 0 or 1 but must
  be consistent per lesson and match the answers file); phase headers at
  `###`; sub-parts at `####`; exams `## Problem N: Title (Difficulty)`
- Fixed section names: `Quick-Reference Flashcard Summary` (each entry an atomic one-per-chunk card)
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
- Difficulty ramps (Easy → Hard, labeled). Per-lesson exams are open-response;
  final-prep may be multiple choice with a per-lesson coverage balance and a
  self-assessment table.
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
Bloch-sphere animations for gate operations). Author text-first (the prose must stand alone as a
text-only fallback), modality-ready: callouts are stable machine-recognizable blocks; worked-example
steps are atomic (one transformation per displayed equation, stated in words first); analogies are
physically drawable; no layout-dependent meaning (markdown tables and LaTeX arrays, not ASCII art —
ASCII diagrams only where the concept IS the diagram, always with equivalent prose); flashcard tables
use a consistent extractable shape. **Inherently-visual operations specify an interactive
visualization** (initial state → operation → resulting motion) alongside the standalone prose.
