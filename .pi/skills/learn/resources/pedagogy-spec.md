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

## 1. Three-Phase Teaching (always followed, never labeled)

Every topic: **intuitive explanation → worked examples → formal definitions →
practice**, under natural headers only:

- Intuition flows directly under the topic title (no separate header). It MUST
  contain: one `> **🍳 Everyday analogy:**` callout, a forward hook (one or two
  sentences naming where the concept pays off later — a specific section,
  lesson, or named application), and `> **📌 Note:**` callouts for any concept
  used before its formal introduction.
- `### Worked Examples` — 2–3 examples building in complexity, every algebraic
  step shown, nothing "left to the reader", each ending in verification.
  Consistent pattern: identify states/objects → scenario creating the need →
  step-by-step derivation → result in every notation taught so far. Ends with
  a `#### Why This Matters` bridge: 2–3 concrete applications tied to specific
  later sections/lessons. NEVER narrate the teaching method itself ("the
  analogy gave you the intuition, the examples gave you the mechanics…" is
  banned meta-commentary).
- `### Formal Definitions` — opens with a "nothing new here" statement (varied
  wording), maps every definition back to the worked examples explicitly, ends
  with `> **🧠 Remember This:**` (one sentence).
- `### Practice Problems` — 2–3 numbered problems testing THIS topic only,
  with all needed context inline; substantive, not one-word answers. Every
  problem has an identically-scoped solution in the companion answers file.

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
- Fixed section names: `Quick-Reference Flashcard Summary` and
  `The One Diagram That Ties It All Together` close every guide
- All math in LaTeX (`$`/`$$`), never ASCII math, never backtick-wrapped math

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

Text-only today; a web app with read-aloud and visuals is the roadmap. So:
callouts are stable machine-recognizable blocks; worked-example steps are
atomic (one transformation per displayed equation, stated in words first);
analogies are physically drawable; no layout-dependent meaning (markdown
tables and LaTeX arrays, not ASCII art — ASCII diagrams only where the concept
IS the diagram, always with equivalent prose); flashcard tables use a
consistent extractable shape.
