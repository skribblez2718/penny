---
name: learn
description: Turn raw learning material (lectures, slides, notebooks, textbook chapters) into a complete study companion — per-lesson study guides, practice questions with answers, practice exams, and course-wide final prep — authored clean-room, each concept synthesized sources-closed from your own understanding (built on multiple independent sources where available), with a provenance trail. Use when the user has source material and wants study materials produced from it. Do not use when researching an unfamiliar topic from scratch (the research skill), producing a single one-off document (skribble), analyzing material without producing courseware (annie), or fixing code (the code skill).
license: MIT
metadata:
  penny:
    engine: orchestration
    mempalace: true
    subagents: [echo, annie, skribble, synthia, vera, carren]
---

# Learn Skill

Transforms a set of raw learning material into a self-consistent, exam-ready
study companion: per-lesson study guides (each concept taught intuition → worked
example → its formal definition, closing the concept, then graded practice),
companion practice answers, per-lesson practice exams
with fully worked answer keys, and course-wide final prep (comprehensive
review, notation reference, final exam + key). Everything is authored to the
pedagogy spec in `resources/pedagogy-spec.md` and gated by mechanical and
mathematical verification — every quantitative answer is recomputed, never
trusted. Graded practice is emitted as concrete ` ```question ` DSL blocks and
inherently-visual operations as ` ```sim ` exhibit blocks **in the target app's output
contract** — which is *caller-provided* (`app_contract`: the app's own DSL/sim/build docs;
this skill names and bundles no app) — so guides compile straight into interactive,
auto-graded lessons rather than prose.

Authoring is **clean-room**: each concept is built from the *idea layer* (the
facts it must convey) plus your own understanding — synthesized with sources
closed, from multiple independent sources where the corpus allows — never from a
source's prose, structure, or distinctive examples. A per-lesson provenance log
records what taught what. The independence *check* is deliberately NOT in this
skill (an author cannot grade itself, and a checker that sees the sources would
break clean-room): it is the separate **`derivation` skill**, run per lesson
before publish. See *Clean-Room Authoring & Independence* below.

The workflow encodes a methodology proven on a full course
build: conventions are decided ONCE, globally, at design time (convention drift
across files is the single biggest quality killer); analogies are registered
before use and kept one-per-concept forever; and verification always runs
against the whole corpus, because cross-file forks are invisible to
single-file checks.

## When to Use

- User has source learning material (transcripts, slides, notebooks, chapters, videos-with-transcripts) and wants study materials produced from it
- User wants study guides, practice problems, practice exams, or exam-prep packs for a course
- User wants existing rough notes upgraded into structured, pedagogically consistent courseware
- The output must prepare a learner to pass real exams on the topic (platform-agnostic)

## When NOT to Use

- No source material exists yet — the topic must first be researched (use the `research` skill, then chain into `learn`)
- The user wants a single document, summary, or cheat-sheet (use `skribble` or `synthia` directly)
- The user wants analysis or critique of existing study materials without producing new ones (use `annie` or `carren`)
- The material is source code to review (the `sca` skill) or to write (the `code` skill)

## Clean-Room Authoring & Independence

The companion is authored **clean-room**, so the output is a legally independent
work that owes no source attribution, license compliance, or ShareAlike. Copyright
protects *expression*, never facts, mathematics, ideas, methods, or procedures — so
content that takes only the unprotectable layer and expresses it independently is
not a derivative work, and each source's license becomes moot.

- **Idea layer, not expression.** Ingest extracts the *facts / what* a lesson must
  convey (the non-copyrightable skeleton), never a source's prose, section order,
  selection, distinctive examples, analogies, or figures.
- **≥2 independent sources per non-trivial concept**, where the supplied corpus
  allows. Understanding is built from several sources so the synthesis is
  demonstrably the author's, not any one source's; single-source dependence is the
  decisive originality risk. With a single supplied source the discipline still
  holds (sources-closed + own understanding), but the ≥2-source target is reported
  as unmet. **For course builds, chaining `research → learn` is the standard way to
  gather these independent sources** (real citations + provenance) rather than
  relying on the model's internalized knowledge — `learn` itself does not research.
- **Sources-closed synthesis.** Design and drafting happen with sources closed;
  reopen only to *re-learn* a fact, then close and write. Original examples,
  analogies, diagrams, and quiz items — never a source's. (Low text overlap ≠
  independence: paraphrasing or mirroring a source's structure is still derivative.)
- **Provenance log per lesson** — concept → which sources taught it → a one-line note
  on how it was re-expressed. The contemporaneous evidence trail of independence.
- **The independence check is a separate skill.** `learn` carries the *pedagogy*;
  the **`derivation` skill** is the independent, ideally cross-model reviewer, run
  per lesson before publish (see *Post-Completion*). It returns
  `INDEPENDENT` / `NEEDS_REVISION` / `DERIVATIVE_RISK`; a lesson ships only on
  `INDEPENDENT`.

This skill **carries the clean-room *authoring* methodology itself** (topic-agnostic;
binding rules in `pedagogy-spec.md §11`); the independence *check* is the separate
`derivation` skill. It **hardcodes no topic or location**: all course material — the
raw material (`source_dir`), the output (`output_dir`), and the license-vetted **source
registry/corpus** (`source_registry`) — is caller-provided and lives in the *course's
own directory* (e.g. an external `~/<subject>/…` tree), never inside penny.

## Invocation

Invoke via the `skill` tool. The learn skill runs on the shared orchestration
engine (`orchestration.playbooks.learn:LearnPlaybook`) — the thin
`scripts/orchestrate.py` delegate only routes `start`/`step`/`status`/`recover`
to it. Agents communicate via mempalace room `skills/learn-{session_id}`;
Penny only sees structured per-state summaries.

```
skill({
  skill_name: "learn",
  goal: "Build a study companion for <course/topic> that prepares me to pass <target exam(s)>",
  constraints: {
    source_dir: "/path/to/raw/material",          // REQUIRED
    output_dir: "/path/to/output",                 // optional; default <source_dir>/../study_materials
    source_registry: "/path/to/course/sources.md-or-manifest.json", // optional; the license-vetted
    //   corpus (≥2 vetted sources/concept, buckets+licenses) for clean-room grounding + the
    //   `derivation` handoff. Lives in the COURSE dir, not in this skill. Omit → ≥2-source target
    //   reported unmet. Same shape `derivation` consumes as its `sources`.
    app_contract: "/path/to/app/output-contract-or-docs", // optional; the TARGET APP's output
    //   conventions (section model, graded-practice + exhibit DSLs, build/lint) — lives in the app's
    //   OWN repo (this skill names + bundles no app). Omit → guides emit generic markdown practice.
    ingest_branches: { content: "...", math: "..." }, // optional: supply the ingest topology
    //   directly (branch_id -> focus). Omit for the tagged-LOAN 3-focus default
    //   (content/conventions/assessment). max_fan_width caps the branches.
    spec_docs: ["/path/teaching_approach.md"],    // optional; existing teaching docs to reuse
    audience: "adult learner, rusty on prerequisites" // optional audience notes
  }
})
```

`constraints.source_dir` is a hard requirement — `start()` raises without it.

## States

The `LearnMachine` FSM (`orchestration.playbooks.learn`) drives:

```
intake → scoping (echo: quick source scan → emits the ingest topology; skipped when the
           caller supplies ingest_branches)
       → ingesting (parallel echo fan: model-emitted topology, else the tagged-LOAN
           default content / conventions / assessment)
       → designing (annie: curriculum + conventions canon + analogy registry +
           original track/course/lesson names & the author's own spine)
       → charter_gate (HITL: approve / refine / deny)
       → authoring   (skribble: guide + answers, loops once per lesson)
       → assessing   (skribble: exam + key, loops once per lesson)
       → synthesizing (synthia: course-wide final prep)
       → verifying   (vera: mechanical checks + math recomputation; EVIDENCE-GATED —
           the recomputation transcripts are a required, non-empty SUMMARY field)
             clean → critiquing            violations → fixing → verifying
       → critiquing  (carren: learner-experience judgment)
             APPROVE → complete            NEEDS_REVISION → fixing → verifying
```

Loop semantics:

- `authoring` / `assessing` self-loop once per lesson (progress tracked in the checkpointer; crash-resume continues at the same lesson).
- `verifying` → `fixing` → `verifying`: fixes ALWAYS re-verify against the whole corpus. Budgeted by `max_iterations`; a stalled loop (same violations persisting) escalates to the user instead of spinning.
- Budget exhaustion completes honestly with `met=False` and the unresolved violations reported — never a fabricated pass.

Escalation & terminals:

- Any working state → `unknown` → `awaiting_clarification` → resumes at `designing` once the user clarifies (lesson progress is preserved).
- `charter_gate` deny → `error` (terminal). Terminal states: `complete`, `error`.

## Agents

| State | Agent | Role |
|-------|-------|------|
| scoping | echo | Quick source scan; emits the ingest fan topology (`ingest_branches`) shaped to this material |
| ingesting | echo × N (parallel) | Inventory the *idea layer* (facts / what is taught — never a source's prose or structure), source conventions, and audience/assessment style; seed the per-concept source map + provenance |
| designing | annie | Course charter: lessons, topics in dependency order, conventions canon, analogy registry — with **original track/course/lesson/section names** and the **author's own spine** (never a source's titles or table of contents; pedagogy-spec §11) |
| **charter_gate** | *(HITL)* | **User approves the charter before any authoring — conventions locked here cannot drift later** |
| authoring | skribble | One lesson per pass: study guide + practice answers per the pedagogy spec |
| assessing | skribble | One lesson per pass: practice exam + answer key per the exam canon |
| synthesizing | synthia | Course-wide final prep: comprehensive review, notation reference, final exam + key |
| verifying | vera | Full-corpus mechanical conformance suite + recomputation of every quantitative answer |
| fixing | skribble | Apply verified fixes with cross-file sync |
| critiquing | carren | Learner-experience judgment against the teaching philosophy |

## Interactive Gate — charter_gate

Authoring a full course is expensive, and the session that produced this skill
proved that convention decisions made per-file (instead of once, globally)
create contradictions in the most safety-critical content. The gate presents:
lesson count, topic count, the full conventions canon, the analogy registry
size, and the designer's open questions. The user can:

- **Approve**: author the full companion to this charter
- **Refine**: send the charter back to `designing` with a note
- **Deny**: terminate; nothing is authored

## Resources

- `resources/pedagogy-spec.md` — the binding authoring spec: three-phase teaching, canonical callouts, analogy registry rules, conventions canon, exam canon, modality-ready authoring, and clean-room authoring (§11)
- **Target-app output contract** — *caller-provided* via `constraints.app_contract` (the app's own section model, ` ```question ` graded-practice DSL, ` ```sim ` exhibit DSL, and build/lint). The skill names and bundles **no** app; it emits to whatever contract the caller passes. Omit it and guides fall back to generic markdown practice.
- `resources/verification-checklist.md` — the mechanical check suite + math-recomputation protocol vera runs
- `resources/file-structure.md` — required output layout and artifacts per lesson
- `resources/flow.html` — state diagram (self-contained; open in a browser)

## Chain Integration

**Standard for clean-room course builds: `research → triage → learn`.** `learn` consumes a
local `source_dir` and does **not** itself gather or vet sources. Run `research` first to gather
candidates (seed it with the course's existing registry so it builds on vetted anchors and flags
new finds — but `research` stays a general-purpose, open-web tool: it's **free to search the open
web to fill gaps**, and should whenever no registry exists or it lacks the minimum sources); then
**triage** — you/Penny license-classify the new finds into the course's
`source_registry` (Bucket A/B; unknown ⇒ restricted) — before `learn` authors from the vetted
corpus. This meets the ≥2-independent-sources discipline with **real, license-cleared sources +
provenance**, not just internalized knowledge. Triage is **human-owned** (license calls are
consequential). With a single pre-supplied source and no registry, `learn` still authors
sources-closed but reports the ≥2-source target as unmet.

```
skill({
  chain: [
    { skill_name: "research", goal: "Gather authoritative sources on <topic>; seed from the approved
        registry at <course>/sources.md, search the open web to fill gaps, and flag new finds for triage" },
    // → triage: license-classify the new finds into <course>/sources.md (Bucket A/B) — human-owned
    { skill_name: "learn", goal: "Build a study companion from the gathered material",
      constraints: { source_dir: "<course>/resources",
                     source_registry: "<course>/sources.md" } }
  ]
})
```

## Post-Completion

The `complete` result reports `output_dir`, `files_written`, lesson counts,
`verified_clean`, and `critique_verdict`. Full working notes live in mempalace
room `skills/learn-{session_id}`. If `met=False`, `unresolved_violations`
lists exactly what still fails — re-invoke with the same `output_dir` to
resume improvement, or fix manually against `resources/verification-checklist.md`.

**Independence handoff (clean-room).** `learn` does not grade its own independence.
Before publishing, run the **`derivation`** skill per lesson, passing the lesson
content plus its clean-room artifacts (concept skeleton + provenance log from
`_authoring/`, see `resources/file-structure.md`) and the course's source manifest
(`manifest.<course>.json`). **The corpus passed to `derivation` MUST include the
`role=coverage-reference` source(s) the content was rebuilt from** — a corpus that omits the
restricted source yields a vacuously-clean pass (nothing restricted to compare against). Keep the
gate corpus (includes the restricted coverage-reference artifacts) distinct from any shipped
provenance manifest that omits them. Ship a lesson only when it returns `INDEPENDENT`; a
`NEEDS_REVISION` / `DERIVATIVE_RISK` verdict routes back into a `learn` fix pass.
Reviewer ≠ author — pin the review to a different model where possible.
