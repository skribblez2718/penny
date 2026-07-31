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
  PRECEDES it. Every practice set also includes **scenario-based recognize-the-tool items** (§14)
  alongside the mechanical ones. NO "Quick Check" — those are just practice questions. The question is authored as a
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

- **Every concept section declares its information delta** — the one thing a learner who has
  absorbed every preceding section could not yet produce. Deliberately redundant sections declare
  a scaffold purpose instead. Both are authoring metadata, never learner-facing prose (§15).
- **A concept section MAY open a prediction point** before the payload it teaches: an ungraded
  predict → commit → reveal prompt that is *additive* to the graded practice above and never a
  replacement for it (§16).

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
- **Hierarchy verbiage is fixed: Track → Course → Unit → Lesson → Section.** A track consists of
  one or more courses; a course of units; a unit of lessons; a lesson of sections. These five are
  the ONLY structural nouns in learner-facing prose and cross-references ("Lesson N", "the *Name*
  section", "the *Name* course"). BANNED as structural nouns: "Topic", "Chapter", "Module",
  "Part N". The same verbiage governs the target app's UI labels.
- **Cross-notation visual anchors.** When a subject has two or more notations for the same object,
  teach an explicit look-up rule that lets the learner see one and *picture* the other (and run
  worked translations in BOTH directions), not just a statement that they are equivalent.
- Track/course/lesson/section **titles are the author's own** — never a source's course/lesson
  titles, never a "Lesson N of <Source Course>" self-identification — and the spine (course
  boundaries, unit bundling, lesson order) follows the author's own pedagogical logic, not a
  source's table of contents (binding rule + rationale in §11)
- Header grammar: lessons `## N. Title` — `0` is reserved for the course's "What You Will
  Learn" intro (§1), teaching lessons number from `1` (consistent per guide and matching the
  answers file); phase headers at `###`; sub-parts at `####`; compiled DSL exam problems use a
  **bare `## Problem N`** heading (title/difficulty go in the block's `title:`; see §7 and the
  app_contract) — a `: Title (Difficulty)` suffix in the heading can fail a strict exam compiler
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

## 4. Canonical Callouts (exactly seven, everywhere)

| Callout | Marker | Job |
|---|---|---|
| Everyday analogy | `> **🍳 Everyday analogy:**` | Ground the math in the tangible |
| Note (forward ref) | `> **📌 Note:**` | Define a not-yet-taught concept at first use + where it's formally introduced + reassurance |
| Remember This | `> **🧠 Remember This:**` | One-sentence takeaway (end of Formal Definitions; end of key solutions) |
| Common Mistake | `> ⚠️ **Common Mistake:**` | The specific error learners make on this exact step (answers + keys) |
| Everyday Take | `> 💡 **Everyday Take:**` | Result restated in plain language (answers + keys) |
| Flashcard | `> **Front:** / > **Back:**` inside a 🧠 block | Spaced-repetition extraction unit (final-prep files only) |
| Prediction point | `> 🔮 **Predict first:**` / `> 🔮 **Reveal:**` | Ungraded predict-commit-reveal pair in the markdown fallback rendering (§16) |

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
- **Every reference resolves to a real target.** A 📌 Note that promises "formally introduced in
  …" names a section or lesson that (a) exists in the corpus and (b) actually teaches the
  promised concept; every "Recall from …" names a section that exists and precedes the reference.
  A promise no section fulfils is a defect of the same size as a wrong answer — the learner has
  no way to tell a forward reference from a dead end, and a later "Recall" of never-taught content
  compounds it. Vague promises ("later", "in a future lesson") are unverifiable: name the target.
- Basic intro concepts are taught once (first guide) and never re-taught;
  build-on relationships are made explicit.
- Re-covering taught ground is permitted **only as declared scaffold** (§15) — analogy
  reinforcement, spaced restatement, review, or a bridge into the next result — never as
  accidental duplication, and never removed merely because it repeats.

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
  each problem is a fenced ` ```question ` block under a problem heading whose exact shape is set by
  the target app's exam contract (`app_contract`). A strict exam compiler commonly requires a **bare
  `## Problem N`** heading (any other level-2 text fails the build); carry the human title + difficulty
  in the block's `title:` field, ramping difficulty by ordering — do NOT bake a `: Title (Difficulty)`
  suffix into the heading unless the app_contract explicitly allows it. The ` ```question ` block
  grammar is the SAME as inline practice (§1), so the offline build compiles it into the course's
  graded Exam. Pick the tightest auto-gradable `qtype` (write domain-accurate distractors +
  per-option `feedback`); use `self-check` only for a genuinely open derivation. The companion
  `<course>/exam/answer_key.md` stays the author-facing worked key (Approach → Step-by-Step → Key
  Formula). Authoring an exam directly in the app's code breaks the author-in-tree → build → ship
  mirror and is prohibited.
- Difficulty ramps (Easy → Hard, labeled). Final-prep ships the same way — its ` ```question ` blocks
  become graded lessons — with a per-lesson coverage balance and a self-assessment table.
- Cross-notation translation problems appear in every exam (a known learner
  weak spot).
- **Scenario-based items appear in every exam** (§14): a described situation, the learner picks
  WHICH taught tool applies (then optionally applies it). Additive to — never replacing — the
  mechanical items.
- **Assessment Blueprint — the difficulty decision is made in the charter, not discovered in the
  question bank.** Correct answers are not the bar; *fit to the target exam* is. The charter
  carries a required **Assessment Blueprint**, approved at the charter gate alongside the
  conventions canon, holding:
  - **Format quotas** per exam and per practice set — the share of each `qtype` (multi-select,
    numeric, ordering, scenario, cross-notation) and of any presentation medium the target exam
    uses. Quotas are targets with a floor, never a ceiling on rigor.
  - **A skill-ceiling table** — one row per skill the target exam tests, naming the level it is
    tested at. Every row must resolve to ≥1 worked example AND ≥1 assessment item at that level;
    a skill taught only below the level it is tested at is an unmet row, surfaced at the gate.
  - **Exam metadata** — length, point weighting, pass mark, and timing (see the exam-metadata
    bullet below).
  Where the caller supplies `exam_exemplars` (sample items from the target exam, text or images),
  the scoping/ingest pass **characterizes** them into the *difficulty profile* the blueprint is
  built from: format mix, option counts, cognitive demand, presentation media, and how messy the
  numbers are. **Characterize, never copy** — §11 governs exemplars exactly as it governs any
  other source: no exemplar's wording, parameters, distractors, or figures enter the corpus, only
  the shape of the demand it makes. With no exemplars supplied, the blueprint records that, and
  the default format floor below binds.
- **Default format floor — binds whenever the blueprint sets no stricter quota.** A ramp that only
  *orders* questions is not a difficulty model: with ordering alone, a bank made entirely of the
  easiest format satisfies "Easy → Hard" and still leaves the learner unready. So, floor: every
  exam includes ≥1 multi-select item, ≥1 numeric item, ≥1 scenario item (§14), and ≥1
  cross-notation item; every lesson's practice set includes ≥1 item that is NOT the single-answer
  multiple-choice form, wherever the content allows one. Where the content genuinely allows no
  harder format, the charter records which section and why — the floor is waived by a recorded
  decision, never by silence. The floor counts **graded** items only (` ```question ` blocks).
- **Assessments carry the target exam's presentation media.** If the target exam *presents*
  artifacts pictorially (per the exemplar profile above), practice and exams MUST present the same
  artifact classes pictorially: reading the picture is part of the skill being tested, and a prose
  paraphrase of it quietly tests something easier. §10 mandates exhibits for inherently-visual
  *teaching*; this is its assessment half. Resolve the figure mechanism against the
  caller-provided `app_contract` (inline vector markup, an image field, or a figure-capable
  prompt). If the contract cannot carry figures, report it as a **blocking gap** in the charter
  — a decision for the human — rather than silently authoring prose descriptions of what the
  target exam shows as a picture.
- **Exam metadata is decided, never left unset.** The blueprint records, per exam: how many items,
  how they are weighted (uniform weighting is a choice, and recorded as one), the pass mark, and
  the timing — where **untimed is a legitimate decision** when the readiness model is
  mastery-based, but it is recorded as a decision with its reason. The assessing pass writes the
  decided values into the exam artifact's metadata fields (shape per the `app_contract`). An unset
  or null metadata field is indistinguishable from a decision never made, so verification treats
  it as a violation.
- **No prediction points in exams.** Exam and final-exam files carry graded items only; ungraded
  predict → commit → reveal prompts (§16) belong in study guides, before the content that teaches
  the payload. The single exception is an explicit prediction-point allowance in the charter's
  assessment blueprint, which must name the count and the artifact. Exam difficulty and surprise
  come from fresh parameters, scenario framing, and format mix — never from an ungraded guess and
  never from untaught content.

## 8. Final Prep (course-wide)

- Comprehensive review: formula tables with "In Plain Terms" columns,
  protocols/pitfalls sections, balanced across ALL lessons.
- Notation reference: same three-phase structure per notation, master
  translation tables.
- Final exam + key covering every lesson proportionally.
- **Cumulative mixed practice — review material is graded, not just readable.** Between
  per-section practice (§1, which tests one section against the content just before it) and the
  final exam (which tests the whole course under exam conditions) sits the level nothing else
  covers: interleaved retrieval across lessons. So every course's review/final-prep material
  carries a **mixed graded question set** — ` ```question ` blocks, drawing on all lessons
  proportionally, format-mixed per the blueprint (§7) and at minimum to the default format floor.
  A review unit that ships with zero graded questions is a defect, however good its prose.
- Cumulative review material stays **pure retrieval**: no prediction points inside review or
  final-prep practice (§16). At review time the learner is recalling taught content, and a
  pre-answer guess prompt there displaces the retrieval instead of preparing it.

## 9. The Practical Why

Every topic answers "why" twice: the forward hook (intuition phase) and the
Why This Matters applications bridge (after worked examples). The learner
never learns a procedure without knowing what it buys them.

**And the physical WHAT comes before the mechanics.** Before any "here is how you compute it,"
state in plain language what the operation *is* and what it *does* in the real world (what the
symbols are modeling, and why the construction is shaped the way it is). The bar for every
section: the learner can explain, in one plain-English sentence each, WHAT the math is doing and
WHY — not merely execute the recipe. A section that opens with mechanics before meaning is a
defect.

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

Prediction points (§16) are exhibit-class artifacts on the same footing: this spec fixes the
pattern and its placement rules, the **target app's output contract** (caller-provided
`app_contract`) fixes the block grammar, and the markdown fallback in §16.4 must stand alone as
readable prose in a text-only renderer.

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

## 12. Term Introduction — No Assumed Knowledge

Assume zero/minimal prior knowledge, everywhere, always. Every term, symbol, and name is
introduced before anything else uses it, in language a newcomer can say out loud and explain back.

- **Pronunciation at first introduction.** Every new symbol, notation, or named term gets a
  plain-English pronunciation the first time it appears (a phonetic gloss for names, a spoken
  reading for symbols). A learner should never meet a symbol they cannot say out loud.
- **All common aliases taught at first introduction.** When a concept goes by more than one name
  in the wild, teach every common name the moment the concept is introduced — otherwise the
  learner meets the second name elsewhere and thinks it is a new concept.
- **No term debuts outside the prose.** A term may not appear FIRST in a sim title, sim UI text,
  exam question, quiz option, figure caption, or app label. If any artifact uses a word, the prose
  BEFORE that point must have introduced it.
- **Every piece of jargon gets an everyday-language gloss at first use** — not just a formal
  definition, a plain-English one.
- **No cold opens.** A section may not "bring up" a concept and start manipulating it as though
  the learner has background. Every section opens by situating its concept: what it is in plain
  language, where it came from (backward reference), and why it is taught now (forward hook, §9).
- **No assumed *toolchain* either — the prerequisite inventory.** Term-level introduction is not
  enough: a mathematical *technique* can arrive with every surrounding word glossed and still be
  unusable, because nothing ever taught the learner to carry it out. So the charter carries a
  **prerequisite inventory**, written at design time: every mathematical tool or technique any
  lesson *uses* → the section that *teaches* it, or an explicit `assumed: <justification against
  the stated audience>` row. The teaching section must precede first use. A technique used in
  prose, a worked example, a practice item, or an exam with neither a teaching section nor a
  justified assumption is a violation — a gloss of its symbols does not resolve it. Unresolved
  rows surface at the charter gate, where the human decides whether to teach the tool or to state
  the assumption, before authoring spends on either.

## 13. Voice and Register — Patient Mentor, Not Academic

The authorial voice is a conversational, patient teacher/mentor making sure the learner
understands every detail and every why. An academic/textbook register is a defect.

- Write TO the learner ("you"), beside them — not AT them, as a lecture.
- Never dump math: every equation is narrated — said in words before (or as) it is shown, the
  reader told what to look at and why it matters (this also keeps text read-aloud ready, §10).
- Prefer short sentences and everyday words; formal words arrive WITH their plain-English gloss
  (§12).
- Density check: a paragraph that reads like a journal abstract or a theorem statement —
  symbol-heavy, unnarrated, no "you" — gets rewritten. Rigor lives in the formal definition that
  closes the section (§1); the road to it is conversational.
- Reassure at friction points: acknowledge hard steps and remind the learner what they already
  know that makes the step doable.

> **No stock phrasing.** Learner-facing text must survive the read-aloud test: if you would not say
> the sentence to a friend across a table, rewrite it. The following are banned in learner-facing
> copy (prose, prompts, feedback, review sheets): "load-bearing", "delve into", "deep dive",
> "unpack" (for explaining), "leverage" (as a verb), "utilize", "seamless(ly)", "robust" (as generic
> praise — a domain term of art with this spelling stays), "it's worth noting that", "it is
> important to note", "at its core", "in the realm of", "navigate the complexities", "a testament
> to", "tapestry", "game-changer", "supercharge", "unlock the power", "harness", "foster",
> "empower", "crucially,"/"critically," as sentence openers, and "In this section, we will…"
> openings. Prefer the plain word: "use" not "utilize"; "look at" not "delve into"; "explain" not
> "unpack"; show why something matters instead of calling it "crucial".

## 14. Scenario-Based Questions — Recognize the Tool, Not Just Run It

A primary course goal: the learner can recognize WHICH concept a situation calls for — in real
life, on any exam — not merely execute a named procedure on command.

- Every practice set AND every exam includes scenario-based items alongside mechanical ones: a
  situation is described (everyday, experimental, or story-framed) and the learner identifies
  which taught tool applies, then optionally applies it.
- Scenario items are auto-gradable like all practice (§1 DSL): mcq-single ("which tool does this
  situation need?"), order (solution steps), numeric ("now compute it").
- Distractors are other TAUGHT tools — the misconception tested is "wrong tool," so the wrong
  options must be tools the learner knows (§7 scope rules apply).
- Scenario items are ADDITIVE: they join, never replace, the verified mechanical items.

## 15. Information Delta — Every Section Names What It Adds

A learner is a noisy channel: attention lapses, misparses, and forgetting all corrupt what
arrives. Structured redundancy — the registered analogy that returns, the intuition → worked
example → formal close, the deliberate restatement at a distance — is the error-correcting code
that gets content through that channel intact; the **delta** is the signal the code carries. Both
are required, and they are not interchangeable: strip the redundancy and nothing survives the
trip, ship redundancy with no delta and nothing was sent.

So every concept section declares its **delta**: the specific thing a learner who has absorbed
every preceding section could not yet produce. A delta is concrete and checkable — a computation
they can now carry out, a judgment they can now make, a distinction they can now draw. "Covers
X" is not a delta; "can compute X from a given Y" is.

- **One declared delta per concept section**, written as a capability sentence starting with a
  verb the *learner* performs ("compute…", "decide whether…", "distinguish… from…"), naming the
  smallest new thing that section supplies.
- **Deltas are unique within a course.** Two sections may not declare the same delta. A section
  whose content is genuinely predictable from what precedes it does not get a delta — it gets a
  scaffold tag.
- **Redundant or restating content is permitted, and only when declared.** A section that
  intentionally re-covers taught ground carries a **scaffold tag** from this closed vocabulary,
  plus the section(s) it reinforces:
  - `analogy-reinforcement` — re-runs a registered analogy (§3) on new material so the mapping
    holds.
  - `spaced-restatement` — restates an earlier result at a deliberate distance, so it is
    retrieved rather than re-read.
  - `review` — consolidates several taught sections for review or final-prep material (§8).
  - `bridge` — carries a taught result into the notation, framing, or context the next delta
    needs.
- **Undeclared redundancy is a defect.** A section with neither a delta nor a scaffold tag is
  either filler (cut it) or an unnamed capability (name it). Deciding which is an authoring
  judgment, not an automatic cut.
- **This rule never licenses a cut on novelty grounds.** Removing content requires showing it is
  neither a delta nor scaffold; the scaffold test comes first, always. Deleting repetition to
  raise novelty is prohibited — repetition paired with retrieval is doing real work; it is not filler.
- **Scope: concept sections.** One ledger row per concept section (§1). Practice-item sections,
  the course's "What You Will Learn" intro lesson (§1), and the fixed closing sections
  (`Quick-Reference Flashcard Summary`, `Unified Diagram`) are outside the ledger — their job is
  fixed by their own rules.
- **Where it lives.** Deltas and scaffold tags are **authoring metadata, never learner-facing
  prose** (the meta-reference ban in §1 applies): they are recorded in the lesson's provenance log
  under a `## Section Delta Ledger` table (see the file-structure spec), one row per concept
  section, written in the same pass that authors the section. A back-filled ledger is worse than
  none.

## 16. Prediction Points (Predict → Commit → Reveal)

A **prediction point** asks the learner to commit to an answer *before* they read the content
that settles it, then reveals the answer. Committing is the whole mechanism: a reader who is
simply told a surprising fact has merely read it, while a reader who staked a wrong answer — and
especially a confidently wrong one — has a hook the correction can attach to. Prediction points
are optional per section and always additive (§16.5).

### 16.1 The pattern

Exactly three parts, in this order:

1. **Predict** — one prompt with a small set of concrete, mutually exclusive options (or a single
   short numeric / true-false payload), answerable in one guess from what the learner already
   has.
2. **Commit** — the learner picks an option **and states a confidence** on a coarse scale
   (for example: guessing / fairly sure / certain). Confidence capture is **required**, not
   optional: a high-confidence miss is the highest-value event a prediction point can produce,
   and it is invisible unless confidence was asked for.
3. **Reveal** — the correct payload with per-option feedback (§16.3), placed immediately after
   the content that teaches it, in the same section.

### 16.2 Placement and payload rules

Surprise is a budget, not a firehose. These rules are binding; a prediction point that breaks one
is worse than no prediction point at all.

- **Adjacency.** The prompt sits immediately before the content that answers it — same section,
  no intervening concept, no other prediction point between them. The attention a prompt opens
  closes the moment the answer is found, so everything it was meant to sharpen must come *before*
  the reveal.
- **Discrete, concrete payloads only.** One computed value, one entry of a result, one
  valid/invalid or same/different judgment, one ordering. Never a multi-step inference, a
  derivation, an explanation, or "what do you think this means" — open-inference prompts do not
  produce the effect and spend attention that the content needs.
- **Already-taught vocabulary only.** The prompt precedes the teaching, so it may use only terms,
  symbols, and techniques already introduced in the prose before that point (§12's no-debut rule
  applies to prediction prompts exactly as it does to practice items and exhibit text). If the
  payload cannot be *stated* without a new term, the prediction point does not belong there.
- **Low stakes by construction.** Never scored, never gated, never required to continue, never
  counted in any grade, progress bar, or completion requirement. The wording carries this: invite
  the guess, promise the answer.
- **At most one per concept section.** Spend prediction points where the learner's expectation is
  most likely to be wrong — the counterintuitive result, the case where the everyday analogy
  breaks — not on every heading. A section with no counterintuitive discrete payload gets none.
- **Never in exams** (§7), and **never inside review or final-prep practice** (§8), except under
  an explicit allowance in the charter's assessment blueprint that names the count and the
  artifact.

### 16.3 Feedback — misconception-respecting, and it explains itself

Feedback is authored per option, and it does two jobs.

- **Name the misconception, per option.** Each wrong option's feedback names the specific belief
  that makes that option attractive, then corrects it ("this is the answer if you expect … to
  behave like …; what actually happens is …"). A generic "Not quite — see above" is a defect. The
  correct option's feedback confirms the *reasoning*, not just the answer.
- **Say why being wrong helped.** Every reveal carries one sentence, in the author's own words,
  telling the learner that a wrong guess is the mechanism working — that the gap between what
  they expected and what happened is what makes the correction stick. Learners routinely rate
  guess-first material as less useful than re-reading even while it helps them more, and an
  unexplained wrong guess reads as wasted effort or as evidence they cannot do this. The
  explanation is therefore part of the pattern, not encouragement. Reusable sentence pattern
  (vary the wording, keep the content):

  > If you predicted <the tempting wrong answer>, that gap is doing the work — the surprise is
  > what makes <the correct payload> stick.

- **Confidence is acknowledged, never punished.** Feedback for a high-confidence miss speaks to
  the learner's stated certainty directly and kindly. Nothing anywhere scores, ranks, or displays
  a learner's confidence as a performance measure.
- **Voice and labels.** All prediction-point text follows §13 (patient mentor, written to the
  learner) and the callout canon in §4. No new labels.

### 16.4 Rendering — resolve through the app contract, degrade cleanly

A prediction point is authored like graded practice (§1) and interactive exhibits (§10): this
spec fixes the pattern, the **target app's output contract** (caller-provided `app_contract`)
fixes the grammar. Resolve in this order and record which branch applies in the charter:

1. **The contract has a prediction primitive** (a predict/reveal block, or a practice type that
   supports an ungraded pre-answer prompt): author to it — one block per prediction point,
   carrying at minimum the prompt, the options with per-option feedback, a confidence field, the
   revealed payload, and an explanation. If the primitive has no confidence field, put the
   confidence request in the prompt text and record in the charter that no confidence signal is
   captured.
2. **The contract exists but has no prediction primitive:** author the markdown fallback below.
   Never invent a fence the app's build will reject, and never re-purpose a graded-practice block
   for a prediction — that would make the guess scored, violating §16.2.
3. **No `app_contract` was supplied:** author the markdown fallback below.

Markdown fallback — the prompt block immediately before the content, the reveal immediately
after it:

> 🔮 **Predict first:** <the discrete payload question>
>
> - A. <option>
> - B. <option>
> - C. <option>
>
> Pick one, and note how sure you are — guessing, fairly sure, or certain. The answer is a few
> lines below.

…then the teaching content that settles it, then:

> 🔮 **Reveal:** <the correct option and payload>. <One short correction per wrong option, naming
> the misconception behind it.> <One sentence on why a wrong prediction helped.>

The fallback degrades to plain readable prose in any renderer and keeps the confidence request as
text (the learner answers it internally); note in the charter that this mode captures no
confidence signal.

### 16.5 Additive, never a substitution

- Prediction points **add to** the graded practice a section already requires (§1: one graded
  question per section, authored as a graded-practice block). Guessing before content prepares
  the learner for it; retrieving after content is what makes it durable, and the second is the
  stronger of the two. Author both, in that order. **A lesson whose only assessment is prediction
  points is a defect.**
- Prediction points **count toward nothing**: not the per-section graded question, not the
  practice-set format mix or format floor, not exam length, weighting, or coverage. They are not
  assessment; they are teaching.
- A prediction point never replaces the intuition, worked example, or formal close of a section
  (§1). It sits inside the section, before the payload it asks about.
- Authoring a prediction point to satisfy a quota, on a section with no counterintuitive discrete
  payload, is a defect. A quota is a ceiling with a target, never an obligation.
