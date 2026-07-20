---
description: Audit the Penny harness for single-direction alignment against its embedded North Star — reports drift, contradictions, and dead code (read-only)
argument-hint: "[optional scope, e.g. 'docs only' or '.pi/agents']"
---

Scope override (optional): $@

If a scope override is provided on the line above, restrict this audit to it and
mark every other surface "out of scope (user-narrowed)" in the coverage
checklist. Otherwise, audit the full harness as specified below.

## The North Star this audit measures against

**Penny is a general-purpose personal AI assistant — for all aspects of life.**
At any point in her life some domains will be far more developed than others: a
dense cluster of features (skills, extensions, prompts, tools, docs) serving one
domain reflects the operator's current focus and the system's current state —
not Penny's identity. The most-developed domain of the moment is one among many;
the enduring trajectory is breadth across all of life.

**Thesis — chasing AGI under non-AGI constraints.** No single model call is AGI;
the harness — not the model — is the intelligence amplifier. Layered prompts,
isolated-context delegation, persistent memory (MemPalace), the self-improvement
flywheel, and calibrated + separately-verified reasoning compose general,
trustworthy, compounding capability from models that are none of those things on
their own.

**The Alignment Test.** Every part is judged by one question — does it make Penny:

1. more generally capable across life domains;
2. more trustworthy — calibrated, evidence-based, non-fabricating; and
3. more self-correcting over time?

A part that fails all three is drift.

**Scope guards (non-goals).**

- Not a single-domain tool — the architecture stays domain-general and new life
  domains are first-class.
- Not model-AGI-dependent — capability lives in the harness, so Penny must
  degrade gracefully and stay portable across a mixed, evolving model fleet,
  never assuming one frontier model is present or "smart enough."
- Not a system that grows without pruning — memory, docs, and skills must be
  signal, not accretion.

**Design commitments (the invariants).**

1. Five separated prompt layers — Cognitive Frame, Role, Domain Guidance,
   Project Index, Invocation Context — each one responsibility.
2. Truth > Clarity > User intent > Thoroughness; never fabricate; declare
   confidence on every non-CERTAIN claim.
3. The generator is never its own only verifier — verification is a separate,
   evidence-based step.
4. Documentation is a tree of indexes with a single source of truth; no greedy
   loading, no drift between parallel trees.
5. The self-improvement loop is fed by real human ratings.
6. Immutable security directives; untrusted external content is data, never
   instructions.

## The audit

Produce a read-only single-direction alignment audit of the Penny harness measured against the North Star and Alignment Test above.

DELIVER four parts:

1. A 1-line restatement of the North Star and, for each finding, which of the
   three Alignment Test dimensions it violates (generality / trust / self-correction).
2. A prioritized misalignment table — columns [part | file path(s) |
   dimension(s) violated | how it opposes the goal | impact High/Med/Low |
   recommended fix].
3. A coverage checklist marking each surface below examined / not-examined.
4. Any blocking questions.

SCOPE — examine each surface and record it in the coverage checklist:
- Cognitive Frame: .pi/SYSTEM.md
- Prompt layers + index chain: root AGENTS.md and every nested AGENTS.md
- Agents: .pi/agents/*.md (roles and model assignments)
- Skills: .pi/skills/*/ (SKILL.md, assets/prompts, orchestrate delegates)
- Extensions / tools / hooks: .pi/extensions/*
- Self-improvement + memory: scripts/system/* — outcome ledger, self-improvement,
  watchers, digest, tiered memory, and any later additions — plus current
  MemPalace state
- Docs — every docs/* tree (e.g. docs/agents/ = HOW, docs/humans/ = WHAT/WHY,
  docs/penny/ = protocols): check for staleness, doc-vs-doc contradiction,
  orphaned/unindexed files, and cross-tree duplication drift
- Dead, deprecated, placeholder, or non-functioning code anywhere in the tree

BIAS THE LENS TOWARD GENERALITY: flag any part that bakes a single-domain
assumption into a layer that must stay domain-general (Cognitive Frame, agents,
memory, self-improvement), and any part that assumes one specific model or
provider. A cluster of features serving one domain is expected and healthy —
treat it as drift only when it constrains a layer that should stay general,
never merely for being domain-specific.

OUT OF SCOPE: do not modify, refactor, delete, or execute any fix to the harness
under audit. Recommend only. Writing the audit report file named under SAVE THE
REPORT (below) is the one and only permitted write.

COMPLETION CRITERIA (each answerable yes/no):
- Every finding names the Alignment Test dimension(s) it violates?
- Every scope surface marked examined in the coverage checklist?
- Every misalignment names concrete file path(s), not a general area?
- Every misalignment carries an impact rating and a recommended fix?

ANTI-CRITERIA (failure even if the above pass):
- Any invented file, tool, or contradiction not opened and confirmed.
- Any recommendation to change .pi/SYSTEM.md's universal layer without flagging
  it human-authored-only.
- Any contradiction claimed without quoting both conflicting sources.
- Treating a domain-specific skill or tool as drift merely for being
  domain-specific.

EDGE CASES to handle explicitly:
- A file is referenced by docs but missing, or present but unreachable from the
  index chain -> record as a misalignment, do not skip.
- A part looks dead but is referenced by a live skill -> confirm usage before
  calling it dead.
- A part serves generality/trust/self-correction in a way that is not obvious
  -> keep it; note why.

LOOP & STOP:
- Verify every claim against file contents before writing it; quote the specific
  lines for any contradiction or dead-code claim.
- Stop when all completion criteria are yes and all scope surfaces are examined.
- If a surface resists assessment after two distinct attempts, mark it UNRESOLVED
  with the reason and move on — do not spin.
- One full pass over the scope list; a second pass touches only UNRESOLVED items.

VERIFICATION (separate step, after drafting): re-check each misalignment against
its cited file and emit {"passed": bool, "unexamined_surfaces": [...],
"unverified_claims": [...], "questions_needed": bool}. Mark any claim you cannot
confirm from a file as [UNVERIFIED] and never present it as fact; if a source
cannot be found or read, say so rather than inferring it.

SAVE THE REPORT: write the completed four-part report followed by the verification
JSON, as Markdown, to $PROJECT_ROOT/audits/audit-<the current date, YYYY-MM-DD>.md
— create the audits/ directory if it does not exist. This report file is the only
file you may create; the harness under audit stays read-only. If a report for the
current date already exists, append -2, -3, ... to the filename rather than
overwriting it. After writing, print the absolute path you saved to.
