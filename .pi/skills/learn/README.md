# learn — study-material generation skill

Turns raw learning material into a complete, verified study companion.
Distilled from a full course build (2026-07): the same
pipeline that produced four study guides, four practice-answer files, five
exams with fully worked keys, and course-wide final prep — then survived a
full conformance + math audit.

Authoring is **clean-room**: each concept is synthesized sources-closed from the
*idea layer* (the facts it must convey) plus the author's own understanding, from
≥2 independent sources where the corpus allows, with a per-lesson provenance log.
The independence *check* is a separate skill (`derivation`), not self-graded here.
App-specific serialization is **caller-provided** via `app_contract` (the target app's own
DSL/sim/build docs) — the skill names and bundles no app. All course material (raw sources,
the license-vetted registry, output) is likewise caller-provided and lives in the course's own
directory, not in penny. See `resources/pedagogy-spec.md §11`.

## Flow

See `resources/flow.html` (self-contained state diagram; open in a browser). **Bitter-Lesson / atomic-loops compliance:** the ingest fan topology is caller-supplied (`constraints.ingest_branches`) or a tagged LOAN default (`learn_default_ingest_topology`, ablated + no caller topology → fail-loud start); the verify **and** critique gates are evidence-gated (Rec 4) — `LEARN_VERIFY` requires the recomputation transcripts and `LEARN_CRITIQUE` requires what carren examined, or the engine rejects the verdict; Recall lessons seed the first agent directive. In prose: parallel ingest passes (default content /
conventions / assessment) feed a curriculum design that locks every convention
and analogy BEFORE authoring; a human gate approves the charter; guides,
answers, exams, and final prep are authored lesson by lesson; then a
verify ⇄ fix loop (mechanical checks + full math recomputation, always against
the whole corpus) and a final pedagogical critique gate completion.

## Why the phases are ordered this way (failure modes each order prevents)

| Order rule | Failure mode it prevents |
|---|---|
| Conventions canon before authoring | Convention forks across files (e.g. two conflicting notation schemes in one course, including inside its "CRITICAL" section) |
| Analogy registry before authoring | Mixed metaphors and banned mechanical analogies re-emerging |
| Charter gate before authoring | Mass-authoring to a wrong design (expensive to unwind) |
| Answers authored with guides, exams after guides | Exams testing untaught formulas; answer files drifting from problems |
| Fixes always re-verify (whole corpus) | A fix to one file of a linked pair breaking its partner |
| Critique after verification | Subjective review wasting cycles on objectively broken content |
| Honest exhaustion (met=False) | Fabricated passes hiding unresolved violations |

## Diagnostics

- Run state: `python .pi/skills/learn/scripts/orchestrate.py status --session-id <sid> --run-id <rid>`
- Working notes: mempalace room `skills/learn-{session_id}` (Ingest ×3, Charter,
  Author/Assess per lesson, Synthesize, Verify/Fix per round, Critique)
- A `met=False` completion carries `unresolved_violations` — the exact re-entry
  point for a follow-up run or manual fixes.

## Version history

- v1 (2026-07): initial extraction from the first full course build session.
- v2 (2026-07): clean-room authoring (≥2 sources, sources-closed, per-lesson
  provenance; independence gated by the separate `derivation` skill) and
  a caller-provided app output contract (`app_contract`) — the skill names no app.
- v3 (2026-07): aligned to the content & derivation standards (CG-26 exams
  authored as `question` DSL in the course tree; CG-27/28 original names + the
  author's own spine; DR-8 coverage-glance vs learn-from with an honest
  dual-role manifest; DR-9 gate corpus includes the coverage-reference source;
  GV-2 restricted artifacts authoring-tree-only); flow diagram converted to
  `resources/flow.html`.
