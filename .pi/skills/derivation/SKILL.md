---
name: derivation
description: Review authored content against the corpus of source materials it was built from and render a defensible verdict on whether it is a genuinely independent work or a derivative — source-agnostic and license-aware. Use when you need to gate content for legal independence before shipping it as your own. Do not use to author or revise the content (the author's job), to review its factual accuracy or teaching quality (a critique/verify step such as carren), or when there is no source corpus to compare against.
license: MIT
metadata:
  version: "1.1.0"
  penny:
    engine: orchestration
    mempalace: true
    subagents:
      - echo
      - annie
    invocation_modes:
      - single
      - chain
---

# Derivation Skill

A **verify-only, source-agnostic** derivation/independence gate. Given authored
**content** and the **corpus of source materials** it was built from, it renders
a verdict — `INDEPENDENT` / `NEEDS_REVISION` / `DERIVATIVE_RISK` — on whether the
content is a genuinely independent work or a derivative of any source in the
corpus. It **judges, never fixes**: a non-`INDEPENDENT` verdict loops the author,
not this skill.

The core principle is the copyright idea/expression split (17 USC §102(b);
*Feist*): **copyright protects expression, never facts, math, ideas, or
procedures.** Content that takes only unprotectable material from its sources and
expresses it independently is **not a derivative work** — and then the source's
license is moot. So the skill separates two questions:

1. **Expression independence (PRIMARY, license-independent).** Does the content
   substantially reproduce a source's *protected expression*? Judged by
   Abstraction–Filtration–Comparison against `resources/rubric.md` (D1–D7).
2. **License consequence (SECONDARY, best-effort).** Only if (1) found copied
   expression: a public-domain/permissive match is shippable; a CC-BY-SA / all-
   rights-reserved / **unlicensed** match is restricted. **A missing/unfindable
   license ⇒ treated as restricted** (the common case for arXiv/textbooks) — but
   it never bites when (1) is clean.

## When to Use

- You collected several sources on a topic and built your own content, and need to prove it is independent (not a derivative owing attribution/ShareAlike).
- Gating rebuilt lessons/courseware/articles before publishing them as proprietary work.
- Auditing whether content mirrors a single source's structure, examples, or expression.

## When Not to Use

- To author or revise the content — this skill only judges (that's the author's job).
- To review the content's factual accuracy or teaching quality — `derivation` judges *independence*, not *quality* (use `carren` or a verify step).
- When there is no source corpus to compare against — there's nothing to judge independence against.

## Invocation

```
skill({
  skill_name: "derivation",
  goal: "Review <content> for derivation against its sources",
  constraints: {
    content:    "/abs/path/to/authored-content.md",
    sources:    "/abs/path/to/corpus (dir of source texts OR manifest.json)",
    skeleton:   "/abs/path/to/concept-skeleton.md",   // optional — the idea layer
    provenance: "/abs/path/to/provenance-log.md",     // optional — declared sources
    gather_workdir: "/abs/path/for/gather/manifest"   // optional — where gather writes manifest.json
  }
})
```

### Constraints

| Key | Required | Effect |
| --- | -------- | ------ |
| `content` | Yes | Path to the authored content under review. |
| `sources` | Yes | The **source corpus**, in one of two shapes that AUTO-ROUTE the flow (no extra flag): a **directory** of source texts ⇒ the read-only `gathering` phase inventories it into a `manifest.json` first; or a `manifest.json` **file** of `{id, path\|url, origin, license, bucket, role?}` entries ⇒ straight to `reviewing` (fast path). The pre-filter scans `content` against every entry. Optional **`role`** is `learn-from` (the independent registry) or `coverage-reference` (a restricted source the content was rebuilt *against*); a `coverage-reference` source MUST be present when the content is a clean-room rebuild of it — see the corpus-completeness rule below. |
| `skeleton` | No | Concept skeleton / author brief (the idea layer) — helps separate idea from expression. |
| `provenance` | No | Author's declared per-section sources — part of the evidence trail. |
| `gather_workdir` | No | Where the `gathering` phase writes its `manifest.json` (default `{tempdir}/derivation-{session_id}/`, created `0o700`). Never inside `sources` (no source mutation). Only used when `sources` is a directory. |
| `max_fan_width` | No | Max echo branches per gather round (default 8). Wider corpora are batched across rounds, bounded by `max_iterations`. |
| `skill_dir` | No | Absolute skill path; lets the engine surface the `scripts/`/`resources/` paths to the agents (auto-resolved from the repo otherwise). |

**The reviewer sees the corpus; the author does not.** The clean-room wall is on
the author. The reviewer (annie) legitimately compares both sides — the classic
"dirty" reviewer.

**The corpus MUST include the source(s) the content was rebuilt from.** Independence is judged
*against* a corpus: a manifest that OMITS the restricted source a lesson was rebuilt from yields a
vacuously "clean" pass — there is nothing restricted left to compare against. When the content is a
clean-room rebuild of a specific restricted source (a copyleft / unknown-license course), that
source MUST be in `sources`, tagged `role: "coverage-reference"`. If the rebuilt source is absent
from the corpus, the reviewer returns `UNCERTAIN` (escalate to a human) rather than a clean pass.
Note that a *shipped* provenance manifest may deliberately omit restricted artifacts — so pass the
**gate corpus** (which includes them) here, not the shipped manifest. Adopting the rebuilt source's
course/lesson **titles, numbering, or "Lesson N" identity** is itself a structural (D3/SSO)
dependence tell (see `rubric.md` D3).

**Run the review on a model different from the content author's.** annie defaults
to her own model; when the author used the same model, pin the review to another
via the engine's per-state `model` override so the independence check is not
correlated with the author.

**All inputs are caller-provided paths.** `content`, `sources`, `skeleton`, and
`provenance` are absolute paths passed at invocation; the skill hardcodes no location
and assumes nothing about where content lives or what project it serves. Point
`content` at the **human-authored source** under review (e.g. the markdown), not at a
compiled or generated build artifact.

## How it works (two phases, auto-routed by the shape of `sources`)

`intake → [gathering (echo) →] reviewing (annie) → complete`, with
UNCERTAIN/needs-clarification escalating to the user from `reviewing` only.

### Phase 1 — `gathering` (echo, runs ONLY when `sources` is a directory)

A parallel, **verify-only, local, read-only** inventory of the corpus. One echo
branch per scannable source file (`.md`/`.txt`/`.rst`/`.text`, mirroring
`prefilter.py`), fanned out by the engine's dynamic-fan and bounded by
`max_fan_width` (default 8), with multi-round batching bounded by
`max_iterations` for wider corpora. Each branch reports a **grounded license and
bucket call** (identifier + evidence snippet + confidence) and a **structural
outline** (headings only). The playbook then:

- aggregates every branch into **exactly one** `prefilter.py`-compatible
  `manifest.json` (zero prefilter.py changes), written atomically to a run-scoped
  `0o700` workdir (the `manifest.json` itself `0o600`) — **never** into the
  caller's `sources` directory;
- enforces the fail-safe: a non-`unknown` license with no evidence snippet is
  **downgraded to `unknown`** (unknown ⇒ restricted), and a bucket with no marker
  defaults to `""` (never fabricated from the license);
- writes one consolidated `"<session_id> Gather Provenance"` mempalace drawer
  (each source's license/bucket call with its evidence + confidence; a
  drawer-write failure is non-fatal and surfaced as a warning);
- hands `reviewing` the **manifest PATH** plus a content-section outline and
  candidate section↔source pairings — pointers only.

Gather **never fetches a URL, never discovers a source beyond the caller's
directory** (a URL-only manifest entry is recorded `unresolved: true` and never
fetched), **never mutates the corpus, and never sets or influences the verdict.**
100% of scannable files are inventoried before `reviewing` is entered;
exhausting the iteration budget before full coverage, or a zero-file corpus, is a
**terminal error**, never a partial-corpus pass-through.

### Phase 2 — `reviewing` (annie, UNCHANGED, two tiers)

When `sources` is a `manifest.json` file the run routes straight here, exactly as
before. annie:

1. **Tier-1 (deterministic):** runs `scripts/prefilter.py --content … --sources …`
   for per-source verbatim/n-gram overlap. A hard breach may short-circuit to
   `DERIVATIVE_RISK`. (This is only the literal D1 axis; a clean report does not
   imply independence.)
2. **Tier-2 (judgement):** applies `resources/rubric.md` — abstract → **filter out
   the unprotectable (facts, math, standard notation, merger/scènes à faire,
   public domain)** → compare what remains across D1–D7, including **D7
   single-source dependence** (leaning on one source vs. synthesizing several).

## Verdict

| Verdict | Meaning | Caller action |
| --- | --- | --- |
| `INDEPENDENT` | Original expression, or overlap only with unrestricted sources. | Ship. |
| `NEEDS_REVISION` | Localized, fixable similarity to a restricted source. | Apply `fixes`, re-run. |
| `DERIVATIVE_RISK` | Substantial similarity to a restricted source / clean-room breach. | Do not ship; re-author. |

## Mempalace Output Contract

After completion, `skills/derivation-{session_id}/` holds annie's full review
(the D1–D7 analysis, per-source prefilter report, matched-source annotations with
license consequence, and fixes). The `SUMMARY` is the wire format; the drawer is
the durable record. The engine records the terminal outcome into `penny/outcomes`
automatically — do not write session-learning drawers manually.

## Escalation (awaiting_clarification)

Only `reviewing` escalates. If annie is UNCERTAIN (a borderline independence
call) or a required input is missing, the run pauses in `awaiting_clarification`
with her questions. Present them via `questionnaire`, then resume the SAME run
keyed on its `run_id`.

The `gathering` phase is **not** escalatable: uncertainty about a source's
license simply lands as `unknown` (⇒ restricted) via the fail-safe, and any
shortfall (zero scannable files, or the iteration budget spent before full
coverage) is a terminal error — never a HITL pause and never a partial-corpus
pass-through.

## Resilience

The engine validates every SUMMARY against the state's contract before advancing,
rejecting a verdict that omits its Tier-1 artifact or per-dimension scoring, or a
flagged dimension with no fix and no named source. State is checkpointed by
`run_id`, so a killed run resumes via `recover`.
