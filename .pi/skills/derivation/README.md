# derivation skill — internals

Companion doc to [SKILL.md](SKILL.md). The playbook lives at
`apps/orchestration/src/orchestration/playbooks/derivation.py`; this directory
holds the manifest, per-agent prompts, resources, and the two review scripts.

## What it is

A **verify-only, source-agnostic** derivation/independence gate. Given authored
`content` and the `sources` corpus it was built from, it renders a verdict —
`INDEPENDENT` / `NEEDS_REVISION` / `DERIVATIVE_RISK` — on whether the content is
a genuinely independent work or a derivative of any source. It **judges, never
fixes**: a non-`INDEPENDENT` verdict loops the author, not this skill.

## Core principle (why the verdict is defensible)

The copyright idea/expression split (17 USC §102(b); *Feist*): copyright
protects **expression**, never facts, math, ideas, or procedures. Two separated
questions:

1. **Expression independence (PRIMARY, license-independent).** Does the content
   substantially reproduce a source's *protected expression*? Judged by
   Abstraction–Filtration–Comparison against `resources/rubric.md` (D1–D7).
2. **License consequence (SECONDARY, best-effort).** Only if (1) found copied
   expression does license matter. A missing/unfindable license ⇒ treated as
   **restricted** (the arXiv/textbook common case) — but it never bites when (1)
   is clean.

## States

```
intake → [gathering (echo) →] reviewing (annie) → complete
```

Auto-routed by the shape of `sources` (`resources/flow.html` is the diagram):

| State | Agent | Job |
|---|---|---|
| `gathering` | echo (dynamic fan) | Runs ONLY when `sources` is a directory. Verify-only, local, read-only inventory: one branch per scannable source file, each reporting a grounded license/bucket call (identifier + evidence snippet + confidence) and a headings-only structural outline. Aggregates into exactly one `prefilter.py`-compatible `manifest.json` in a run-scoped `0o700` workdir — never inside `sources`. |
| `reviewing` | annie | Tier-1 `scripts/prefilter.py` (per-source verbatim overlap) + Tier-2 `resources/rubric.md` (AFC, D1–D7) → the verdict. Escalates to the user on UNCERTAIN / needs_clarification. |

Fast path: a `manifest.json` `sources` file skips `gathering` and goes straight
to `reviewing`.

## Design guarantees

- **Clean-room wall is on the author, not the reviewer.** annie (the "dirty"
  reviewer) legitimately sees both content and corpus.
- **De-correlate author and reviewer.** Run the review on a different model than
  the content author's (per-state `model` override) so the independence check is
  not correlated with the author.
- **Fail-safe licensing.** A non-`unknown` license with no evidence snippet is
  downgraded to `unknown` (⇒ restricted); a bucket with no marker defaults to
  `""` — never fabricated from the license.
- **echo never sets the verdict** and never fetches or discovers new sources —
  local read-only inventory only. A coverage shortfall is a terminal error, not
  a partial-corpus pass.
- **Source-agnostic, path-driven.** `content`, `sources`, `skeleton`,
  `provenance` are all caller-provided absolute paths; the skill hardcodes no
  location and assumes nothing about the downstream project.
- **Corpus completeness is guarded (no vacuous pass).** Manifest entries may
  carry `role: learn-from | coverage-reference`; when the content is a clean-room
  rebuild of a restricted source, that source MUST be in the corpus
  (`coverage-reference`) — if absent, the review returns `UNCERTAIN` (escalates)
  rather than a vacuously-clean verdict. Adopting the rebuilt source's
  course/lesson titles or "Lesson N" identity is a structural (D3) tell.

## Resources & scripts

- `resources/rubric.md` — the D1–D7 Abstraction–Filtration–Comparison rubric
  (the skill's domain reference).
- `resources/reference.md` — technical reference mirroring the playbook FSM
  (states, contracts, constraints).
- `resources/flow.html` — state diagram mirroring the playbook FSM
  (self-contained; open in a browser).
- `scripts/prefilter.py` — per-source verbatim-overlap pre-filter (Tier-1).
- `scripts/outline.py` — structural outline helper.
- `scripts/orchestrate.py` — the thin delegate to `orchestration.cli`.

## Testing

```
pytest apps/orchestration/tests/test_derivation_playbook.py -q
```
