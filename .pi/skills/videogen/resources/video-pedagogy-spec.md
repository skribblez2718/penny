# Video Pedagogy Specification

This resource is the binding, source-agnostic authoring contract for one
`videogen` work item. It contains generic rules only. The finalized section and
caller-supplied canon provide every concrete claim, analogy, term, notation,
convention, mnemonic, visual-language choice, and character authorization.

## 1. Scope and Precedence

- Teach exactly one finalized Markdown section per run.
- Do not introduce, repair, broaden, or silently reinterpret the section's
  theory.
- Resolve disagreements in this order: finalized section boundary; caller
  teaching, analogy, pronunciation, convention, and visual canon; caller
  publish contract; this generic resource; free-form goal.
- A free-form goal never overrides source or canon evidence.
- If source and canon cannot be reconciled from cited evidence, set
  `needs_clarification: true`; do not blend or guess.
- If the section cannot support the complete source-backed arc in rule group 3,
  block with an upstream-content report rather than weaken the lesson.

## 2. Concept Inventory Contract

Before storyboarding, inventory every source-backed concept and assign a stable
`concept_id`. Each inventory row records:

- exact section source span(s) and claim(s);
- prerequisite recall explicitly authorized by the section or canon;
- registered `analogy_id`, or evidence that no analogy binding exists;
- first-appearance terminology, notation, and pronunciation events;
- caller-supplied convention obligations;
- any source/canon mnemonic to preserve;
- accessibility-sensitive facts and relevant visual-canon references; and
- downstream `beat_id` and `scene_id` coverage once assigned.

Coverage is proven by a concept → beat → rendered-scene join. A decorative
mention is not coverage. Missing or ambiguous source evidence blocks that row;
it never licenses added theory.

## 3. Unlabeled Three-Phase On-Screen Arc — Mandatory

Every concept uses all three phases without displaying methodology labels to the
learner.

### Intuition hook

Use `<the section's registered analogy>` when one exists. Preserve the bound key
property and physical orientation. Otherwise use
`<a source-backed intuition hook from the section>` and invent no everyday
analogy.

### Worked example

Show `<every source-backed worked step>` in order. Use one transformation per
beat. Spoken words establish the action; the visual executes that same action.
Do not hide arithmetic, algebra, state changes, intermediate labels, or logical
moves. End with a visible source-backed check.

### Formal close

Map `<the same concrete objects and steps>` into
`<the section's formal notation>`. Explicitly frame the notation as the compact
form of what was just shown, so the close adds no surprise theory. Land the
existing remember/mnemonic line when the section or canon supplies one.

If any concept lacks source support for one of these phases, stop before
synthesis and report the unsupported concept, phase, and source gap.

## 4. Analogy Discipline

- Use `<the section's registered analogy>` when a binding exists; preserve its
  identity, key property, and orientation.
- Spoken adaptation may improve delivery but may not switch, combine, extend,
  or add a metaphor.
- When no binding exists, record the absence evidence and use only
  `<a source-backed intuition hook from the section>`.
- Evidenced absence is valid input and produces a tested PASS, not a defect.
- Ambiguous or conflicting registry evidence pauses the run before synthesis.

## 5. Narration, Visual, and Character Roles

- Narration teaches; visuals demonstrate the exact teaching action.
- Do not recite section prose verbatim or place decorative motion behind a
  read-aloud.
- Every visual beat must name its teaching purpose and source/claim mapping.
- Character use requires positive caller policy and visual-canon evidence.
- An authorized character may embody a concept or provide a brief reaction but
  may not create plot, carry untaught theory, replace the worked example, or
  open a story lane.
- When authorization is absent or ambiguous, use no character.

## 6. Notation and Pronunciation

- Synchronize the first spoken appearance of each new term or symbol with its
  matching on-screen notation.
- Apply the caller's pronunciation canon exactly; a missing required
  pronunciation blocks voice synthesis.
- Apply caller-supplied notation and display conventions consistently across all
  scenes.
- Render screen mathematics with LaTeX-quality typography; do not substitute
  ASCII forms.
- Later repetition may omit a repeated pronunciation explanation, but notation
  and spoken meaning must remain aligned.

## 7. Physics and Mathematical Honesty

- Simplify presentation only inside the boundary supported by the section and
  caller canon.
- Show every source-backed worked step; do not skip a transformation because it
  appears obvious.
- Do not rely on an untaught premise, unstated convention, hidden algebra, or
  physically false motion.
- Every equation, narration claim, and explanatory visual must map to a section
  source span or explicitly authorized prerequisite recall.
- A visual simplification must preserve the property being taught and must not
  imply a false rule.

## 8. Tone and Pacing

- Use a warm, precise, concise, engaging, quasi-formal adult register.
- Keep playfulness subordinate to factual clarity; avoid kiddy, patronizing,
  plot-driven, or imprecisely casual delivery.
- Let storyboard coverage and measured narration determine natural length.
- Do not pad toward a duration value.
- Never omit, compress, or silently split source-backed teaching to meet a soft
  guide.
- A caller hard cap blocks overage; a soft-guide overage is reported for review
  and remains non-failing.

## 9. Accessibility

- Produce nonempty captions covering every narration-bearing scene.
- Keep text readable at 1080p and at the selected final-quality output.
- Never make color the only carrier of required information.
- Reinforce essential facts across narration and visuals without adding theory.
- Record storyboard/scene accessibility annotations and evidence for visual
  readability, contrast-independent meaning, notation legibility, and caption
  timing.
- Do not infer accessibility PASS from resolution alone when visual evidence is
  unavailable; report `UNCERTAIN`.

## 10. Caller-Grounded Placeholders — Not Templates to Copy

The following placeholders state evidence obligations; they are not example
content and must never appear in learner-facing output:

- storyboard `<the section's registered analogy>` when one exists;
- otherwise storyboard `<a source-backed intuition hook from the section>`;
- show `<every source-backed worked step>`; and
- map `<the same concrete objects and steps>` into
  `<the section's formal notation>`.

All concrete canon—analogy, orientation, conventions, terminology,
pronunciation, mnemonic, visual language, and any authorized character use—must
arrive through caller constraints and be cited. This resource embeds no domain
worked example or built-in character identity.

## 11. Forbidden Patterns

Reject or revise any candidate containing:

- visible methodology labels;
- a new, switched, combined, or extended analogy;
- new or repaired theory;
- recited source prose;
- unexplained symbols or unsynchronized first appearances;
- hidden algebra or skipped worked steps;
- imagined primitive APIs or visual behavior unsupported by schema/canon;
- arbitrary character business or story-lane drift;
- color-only encoding, tiny text, missing captions, or out-of-range cues;
- padding, artificial speed-up, clipping, or omission to hit a duration; or
- a kiddy, patronizing, plot-first, or fact-obscuring tone.

The concept inventory is summarized in `{sid} Concept Inventory`, the storyboard
in `{sid} Storyboard i{n}`, narration in `{sid} Narration i{n}`, and
pre-synthesis evidence in `{sid} Carren Gate i{n}`. These drawers hold paths,
hashes, and compact evidence; the complete artifacts remain under caller-owned
paths.
