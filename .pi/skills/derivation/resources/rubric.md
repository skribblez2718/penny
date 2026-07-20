# Derivation Review Rubric — Abstraction–Filtration–Comparison (D1–D7)

**Scope:** this is the scoring instrument only — the *how* of judging expression
similarity. It is **source- and license-agnostic**: it says "the source(s)",
never any specific publisher. The license-consequence mapping is applied *after*
this rubric (see §Rollup). The reviewer (annie) owns the judgement; this file
owns the criteria.

**What copyright protects (the whole basis of this rubric):** expression, never
facts, mathematics, ideas, procedures, methods, or discoveries (17 USC §102(b);
*Feist*). Content that takes only unprotectable material and expresses it
independently is **not a derivative work**. So the question is never "is it
similar?" but "is the *protected expression* substantially similar?"

---

## Method — Abstraction → Filtration → Comparison (Computer Associates v. Altai)

Apply these three steps to the content and every source it may derive from.

### 1. Abstract
Break the content and each candidate source into levels: **idea** (the concept/
fact/theorem being taught) → **structure** (selection, sequence, organization) →
**detailed expression** (sentences, examples, analogies, figures, notation).

### 2. Filter out the unprotectable — MANDATORY, do this BEFORE comparing
Remove from consideration anything not protectable. Similarity in these is
**expected and must NOT be flagged** — flagging them would make the content
impossible to write:

- **Facts & data** — physical constants, experimental results, historical facts.
- **Mathematics** — equations, derivations, theorems, proofs *as mathematical
  truth*. (The specific *prose wording* around them can still be expression — see D2.)
- **Standard/canonical notation & definitions** — field-conventional symbols and
  the conventional statement of a standard definition.
- **Merger** — where an idea has only one or a few ways to be expressed, the
  expression is not protected (idea and expression merge).
- **Scènes à faire** — stock elements that naturally follow from the topic (e.g.
  the conventional order of a standard derivation; the obvious worked-first
  example for a concept).
- **Public-domain material** and anything the author demonstrably originated.

### 3. Compare
On the **protected expression that remains after filtration**, assess substantial
similarity to each source across D1–D7. Score each dimension `clear` /
`concern` / `breach` with a one-line note and, for any non-`clear`, the source
id(s) it traces to.

---

## Dimensions

Each dimension is scored **independently** and is **null-aware** (if a dimension
does not apply — e.g. the content has no figures — mark it `n/a`, not `clear`).

| Dim | Protected-expression vector | What a breach looks like |
| --- | --- | --- |
| **D1** | **Verbatim / near-verbatim text** | Sentences/passages copied or lightly edited from a source (Tier-1 pre-filter feeds this; confirm hits are real expression, not filtered standard phrasing). |
| **D2** | **Close paraphrase** | A passage reworded sentence-by-sentence while tracking a source's *expression and explanatory moves* — the AI-reword trap. Low text overlap, still a derivative. |
| **D3** | **Structure, sequence & selection (SSO)** | The lesson's organization, ordering, and what-to-include/omit mirror a **single** source's — beyond what the topic dictates (that would be scènes à faire). Also a D3 tell: adopting a source's **course/lesson titles, numbering, or "Lesson N of <Source Course>" self-identification**, or reproducing its lesson→sub-lesson bundling in order — these are the source's editorial identity, **not** scènes à faire (standard *topic* names like "Inner Products" still are). |
| **D4** | **Examples, problems & exercises** | Specific worked examples, problem sets, or numerical instances lifted from a source (even re-worded or re-numbered). |
| **D5** | **Distinctive explanatory devices** | A source's specific analogy, metaphor, framing, mnemonic, or *non-standard* notation reused. (Standard notation is filtered in step 2.) |
| **D6** | **Figures, diagrams & tables** | A source's specific figure/diagram/table recreated (redrawing does not cure it). |
| **D7** | **Single-source dependence** | Across D2–D6, does a section lean on **one** source rather than synthesizing several? Independent work matches *no single* source's structure/selection/examples. Flag even at 0% verbatim overlap. |

**D7 is the decisive originality signal.** The strongest evidence of an
independent work is that its structure, selection, examples, and framing are
synthesized across multiple sources and match none of them. A section that tracks
one source across several dimensions is derivative even if no single dimension is
individually damning.

**House scaffolding is not a D3 signal.** The authoring standard mandates certain
structural fixtures in every course — notably a first-unit **Introduction** containing a
"What You Will Learn" overview (welcome, outcome list, how-to-work-it), plus fixed closers
like a flashcard summary. The *presence and shape* of these fixtures is the author's own
house convention: do not score them as structure copied from a source, even if a source
also opens with objectives (course-overview openers are commonplace — scènes à faire).
Their *content* gets the full review like any prose: outcome lists that mirror a single
source's objective list in selection, ordering, or wording are a D2/D3/D7 finding as usual.

**Quotation is separate.** A short, marked, *attributed* verbatim quote is a
deliberate choice, not a D1 breach — route it to an attribution / fair-use
decision (the "quotable-with-attribution" path), not to the verdict.

---

## Rollup — from dimension scores to a verdict (similarity × license)

First determine the **expression finding** from D1–D7, then map it through the
**license** of each matched source. License comes from the corpus manifest;
**missing/unknown ⇒ treat as restricted** (fail-safe).

1. **No dimension is `concern`/`breach` after filtration →** `INDEPENDENT`.
2. **Concerns/breaches trace only to unrestricted sources** (public-domain /
   permissively-licensed) **→** `INDEPENDENT` (add an attribution note if the
   licence requests it; still not a derivative-work obligation).
3. **Localized, fixable concern(s) against a restricted source** (CC-BY-SA /
   all-rights-reserved / unknown) **→** `NEEDS_REVISION` — list concrete `fixes`
   and the `matched_sources`.
4. **Substantial similarity to a restricted source** — a D1 breach of real
   expression, or pervasive D2/D3/D7 dependence on one restricted source **→**
   `DERIVATIVE_RISK`. Do not ship; re-author the section.

**Confidence.** Emit `CERTAIN` only with direct, citable evidence; `UNCERTAIN`
when the idea/expression line is genuinely unclear for a passage — an `UNCERTAIN`
verdict escalates to a human rather than guessing.

**Every non-`clear` dimension must name the source id(s) it traces to and a
concrete fix.** A verdict with a flagged dimension but no fix and no named source
is rejected by the engine contract.
