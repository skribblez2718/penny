# manim skill — domain reference

Durable domain knowledge for all states. Prompts reference this file; they do
not restate it.

## What good mathematical animation is (3Blue1Brown grammar)

- **One idea per scene.** A scene earns its cut when the narration shifts idea.
  Beats inside a scene are progressive disclosure of the SAME idea.
- **Show the object before transforming it.** A state vector appears, then
  rotates. An equation appears, then morphs stepwise. Never transform something
  the viewer hasn't seen at rest.
- **Motion means meaning.** Movement encodes the concept (rotation = unitary
  evolution, collapse = measurement); decorative motion is noise.
- **Anchor notation to picture.** When narration names |+⟩, the ket and its
  Bloch position should be on screen simultaneously, consistently colored.
- **Pacing follows narration.** Audio-first: measured narration duration is a
  hard constraint; animation fills it, holds included. Never leave dead air
  longer than ~1.5s; never cut an animation short of its narration.
- **Consistency beats novelty.** The same concept uses the same primitive,
  color, and position across every scene — this is what the canon locks.

## The canon (what designing_canon must decide)

scene count + boundaries (idea per scene); primitive-to-concept mapping
(which primitive carries which concept — e.g. state change = BlochSphere,
probability = StateVectorBars); notation conventions (ket style, operator
casing, subscript order); theme (from the schema export's theme list);
narration register (person, tense, sentence length) and pronunciation rules
for spoken math (`|0⟩` → "ket zero", `H` → "the Hadamard gate"); target
duration and its allocation across scenes.

## Scene code contract (what authoring writes)

- One file per storyboard scene: `scenes/<scene_id>.py`, kebab→snake filename.
- Exactly ONE `manim.Scene` subclass with `construct()`.
- First call: `setup_scene(self, THEME)`; theme from
  `superpose.primitives.THEMES[<canon theme>]`.
- Visuals are primitive compositions ONLY — never raw Manim mobjects; every
  primitive call uses schema-listed params and an explicit `duration=`.
- The sum of `duration=` values must cover the scene's `measured_duration`
  from storyboard.json (tolerance 0.75s shortfall).
- No I/O, no network, no imports beyond `manim`'s `Scene` and the primitive
  library import surface stated in the schema's `scene_contract`.

## Storyboard contract

`resources/storyboard-schema.json` is normative. scene_ids are stable,
content-derived, kebab-case (never array indices). Each visual references a
schema primitive by exact name with schema-valid params, an integer `beat`,
and a `duration`. `measured_duration` is attached by the narrating state —
storyboarding leaves it null.

## Evidence tiers for verification (execute > apply-the-rule > judge)

Tier 1 (EXECUTE — validate_bundle.py): py_compile per scene; AST single-Scene
check; primitive signature validation vs the schema export; duration
arithmetic vs measured narration; storyboard structural validation; orphan
detection. Tier 2 (APPLY-THE-RULE): canon conformance — notation, palette,
primitive-to-concept mapping match the locked canon; storyboard↔scene-file
correspondence. Tier 3 (JUDGE — critiquing only, NEVER verifying): pedagogy,
pacing, visual clarity.

## Degradation policy

A scene that cannot be repaired within budget ships flagged (`degraded_scenes`
in the manifest) — the render app substitutes a fallback title card. The
bundle always ships; `met=False` reports honest exhaustion. Estimated (not
synthesized) narration flags every scene `narration_estimated`.
