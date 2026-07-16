---
name: learn
description: Turn raw learning material (lectures, slides, notebooks, textbook chapters) into a complete study companion — per-lesson study guides, practice questions with answers, practice exams, and course-wide final prep. Use when the user has source material and wants study materials built from it. Do not use when researching an unfamiliar topic from scratch (the research skill), producing a single one-off document (skribble), analyzing material without producing courseware (annie), or fixing code (the code skill).
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
trusted.

The workflow encodes a methodology proven on a full quantum-information course
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
intake → ingesting (parallel echo fan: caller ingest_branches, else the tagged-LOAN
           default content / conventions / assessment)
       → designing (annie: curriculum + conventions canon + analogy registry)
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
| ingesting | echo ×3 (parallel) | Inventory content, source conventions, and audience/assessment style |
| designing | annie | Course charter: lessons, topics in dependency order, conventions canon, analogy registry |
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

- `resources/pedagogy-spec.md` — the binding authoring spec: three-phase teaching, canonical callouts, analogy registry rules, conventions canon, exam canon, modality-ready authoring
- `resources/verification-checklist.md` — the mechanical check suite + math-recomputation protocol vera runs
- `resources/file-structure.md` — required output layout and artifacts per lesson
- `resources/flow.mmd` — state diagram

## Chain Integration

```
skill({
  chain: [
    { skill_name: "research", goal: "Gather authoritative material on <topic>" },
    { skill_name: "learn", goal: "Build a study companion from the gathered material",
      constraints: { source_dir: "<research output dir>" } }
  ]
})
```

## Post-Completion

The `complete` result reports `output_dir`, `files_written`, lesson counts,
`verified_clean`, and `critique_verdict`. Full working notes live in mempalace
room `skills/learn-{session_id}`. If `met=False`, `unresolved_violations`
lists exactly what still fails — re-invoke with the same `output_dir` to
resume improvement, or fix manually against `resources/verification-checklist.md`.
