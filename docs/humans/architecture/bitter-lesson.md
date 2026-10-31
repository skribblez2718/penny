# The Bitter-Lesson Doctrine

## The idea in one sentence

The single most important design principle in Penny is this: **general methods that leverage computation beat methods that hand-code human cleverness — so build the machinery that scales with better models, and be ready to throw away the machinery that doesn't.**

Everything below is the working-out of that sentence: why it's true, what it means for how Penny is built, and the discipline that keeps Penny on the right side of it as models keep improving.

## Where it comes from

In 2019, Richard Sutton — one of the founders of reinforcement learning — published a short essay called _The Bitter Lesson_. His claim, drawn from 70 years of AI history: every time researchers tried to win by encoding what _they_ knew about a problem — chess heuristics, grammar rules, hand-designed vision features — it helped for a while and then lost. What beat it, every single time, was a more general method that simply used more computation: search and learning.

It's called _bitter_ because the hand-crafted knowledge felt like it _should_ win. It represented genuine expertise and hard work. And it kept losing anyway — because human cleverness is roughly a constant, while computation grows exponentially. Any race between a constant and an exponential has one ending.

One honesty note before applying it here: Sutton's essay is a **design analogy** for Penny, not direct empirical proof about system prompts. It supports general search, tool use, feedback, learning, and disposable scaffolding. It does not imply removing user-defined goals, authority, safety limits, domain knowledge, or deterministic controls — and it does not imply that more agents, more iterations, or more computation are automatically better. The next action should be chosen for expected information gain, not because it consumes more compute.

The lesson has a second, deeper half that's easy to miss: Sutton doesn't say _build nothing_. He says build the **meta-methods** — the machinery that lets a system search and learn and discover — rather than building in the discoveries themselves. _"We want AI agents that can discover like we can, not which contain what we have discovered."_

## Why it's Penny's core doctrine

Penny is a layer of human knowledge — prompts, rules, skills, orchestration — wrapped around a model whose capability rises for reasons entirely outside Penny's control. Model upgrades can improve the underlying capability independently of changes to Penny.

That makes **every mechanism in Penny a bet** about what the model can't do on its own. Some of those bets stay good for years. Some go bad the day a new model ships — and worse than merely useless, stale scaffolding actively fights the better model, capping it at last year's cleverness. The doctrine exists so those bets are made deliberately, tracked honestly, and unwound on schedule instead of quietly rotting.

## Three kinds of mechanism

The doctrine's core move is to look at any piece of Penny and ask which of three things it is:

- **Leverage** — it amplifies the model and gets _better_ as the model improves: verification, learning, memory, tools, search. **Protect these.** They are where the compounding happens.
- **Safety** — it encodes a human value or an operational limit, independent of how capable the model is: human approval before irreversible actions, sandboxing on the paths where it's enabled, the trust and action boundaries. A smarter model doesn't make these less necessary — often more. **Protect these too** — but protect the _outcome_ (authorized behavior, controlled consequences), not any particular security paragraph, XML marker, or prompt wording.
- **Knowledge-constraint** — it substitutes a human heuristic for capability: a keyword table, a hard-coded taxonomy, a magic-number threshold, a mandated step-by-step procedure. It helps _today's_ model and fights _tomorrow's_. **Prune it, relax it, or make it a fallback the model can override** — and never treat it as permanent.

The first two are what Penny keeps. The third is the standing target of pruning.

## The hard part: how do you improve without freezing?

Penny's doctrine calls for a safety net against regressions — a ratchet that blocks changes which make protected outcomes measurably worse. This is a policy goal, not a claim that every named capability already has a passing executable gate. But a naive ratchet has a fatal flaw: it protects _everything that passes today's tests_, which means it locks in the knowledge-constraint scaffolding too, because that scaffolding passes today. You'd get ossification with a green check mark.

The rule that resolves this is the heart of the doctrine:

> **Ratchet on capabilities and outcomes, never on implementations.**

In plain terms: **an authorized mechanism change is judged by its protected outcomes, not loyalty to the old implementation.** The guard is deliberately _asymmetric_. Rip out a hand-coded framework-detection table and the system still builds, serves, and tests the project? That change **passes** — even though it deleted working code. Quietly weaken the evidence behind a verification step? That **fails** — even if every benchmark still looks fine.

This is what lets the principle be core without making Penny rigid. It protects the _scaling properties_ while it keeps pruning the _constraints_.

## What Penny protects, forever

The doctrine names a specific set of **capabilities** — not implementations — that the ratchet must never let regress:

- **Grounded verification** — when Penny says something passed, that verdict carries real evidence (test output, a scan result, a proof-of-concept), never a bare assertion.
- **Honest effort with honest limits** — work loops against a verifier until it's actually done; when it runs out of budget, it says so truthfully instead of faking a pass.
- **Independent checking** — the thing that produced the work is not its own only judge. The strongest judges are external evidence: tests, compilers, current authoritative sources, observed system state. Review by a _different model_ is useful supplementary scrutiny (model-diverse review), but it doesn't become independent evidence just because the model name differs — models share training data and blind spots.
- **Durable memory** — decisions and context survive across sessions and can be retrieved.
- **Human oversight at high-stakes gates** — irreversible or high-consequence actions pause for a human.
- **Resumability** — long runs are durable and can pick up where they left off.
- **Safety guards** — authorized tool surfaces, scope limits and trust/action boundaries, with runtime controls preferred over prompt prose. [Runtime tool selection](../../agents/agents/discovery-and-tools.md#binding-runtime-rule) does not provide filesystem/process isolation; untrusted work needs an independent containment boundary.
- **Current retrieval where freshness matters** — fetch live information rather than trusting a frozen snapshot when the answer can have changed.
- **Honest limitation reporting** — unknowns, partial results, and unverified claims are stated as such.

These are required outcomes, not universal enforcement claims. Schemas check structure, exact-byte custody checks identity, and evidence fields can require content without proving its truth. Independent evidence and path-specific tests remain necessary. Prompt prose is policy; tool lists are not a filesystem/process sandbox. The [agent-facing capability map](../../agents/architecture/bitter-lesson.md#capability-invariants-the-protected-set) identifies current tracked owners and evidence limits.

## What Penny deliberately throws away

Knowledge-constraint scaffolding is **deliberately absent** from the protected list — even when it's passing every test today. It's disposable by design and is the standing target of the pruning discipline.

There's a companion rule for the moment of _adding_ scaffolding — the **Bitter-Lesson Gate**:

> Before adding any table, threshold, keyword list, or mandated step, ask: _will this get more or less valuable as the model improves?_ If **less** — can the model do the job by reading an artifact instead? If yes, give the model the artifact and check its output with evidence. Don't hard-code the heuristic.

This catches new constraint-debt at the moment it's written, instead of letting it accumulate and get re-discovered in an audit a year later.

## The one rot-proof thing: the recurring pass

Here's the catch that makes the whole doctrine honest: the _specific_ list of what's leverage versus constraint **rots**. As the codebase and the models change, yesterday's essential scaffold becomes today's dead weight. A doctrine that froze a specific list would itself violate the Bitter Lesson.

So the only genuinely permanent thing is a **ritual**, not a list — a periodic pass that keeps the doctrine live:

1. **Re-audit** the system and re-sort every mechanism into leverage / safety / knowledge-constraint.
2. **Confirm** the ratchet still guards every protected capability; add a guard for any newly-earned one.
3. **Identify** the constraint-debt that's accrued since last time and queue the worst offenders for removal.
4. **Record** dated source/evidence locations and gaps in the caller-authorized audit output, then hand off a short "prune next" list. An existing caller-supplied inventory is optional, not a clean-checkout prerequisite.

Crucially, the pass **proposes; measurement disposes.** Nothing is deleted on taste — every prune candidate goes through the same evidence-and-ratchet gate as any other change. The cadence is roughly quarterly, and _always_ right after a major model upgrade — because a stronger model is exactly when scaffolding becomes newly obsolete.

This ritual is the doctrine's own application of Sutton's second lesson: _build in the method that discovers which of your discoveries to throw away, not a frozen record of the discoveries themselves._

## The honest tension

This doctrine is not a license to delete everything and "just trust the model." Two guardrails keep it honest:

- **Safety and leverage are protected precisely so they _don't_ get swept away** in a burst of enthusiasm for minimalism. The asymmetry cuts both ways: pruning a constraint is cheap and encouraged; weakening a capability is a blocked regression.
- **Removing a protected capability is itself a high-stakes change** — it must be justified and measured, never done casually.

The doctrine's discipline is _directional_, not absolute: lean toward general methods and disposable scaffolding, guard the capability spine like your life depends on it, and let evidence — not conviction in either direction — settle each specific call.

## Where to go deeper

- [Atomic Loop Components](atomic-loop-components.md) — the doctrine made buildable: what a "leverage" capability and a "knowledge-constraint" look like as concrete parts, and how to assemble loops that comply by construction.
- [Agentic Loops](../skills/loops.md) — how these ideas show up in the loops that run Penny's skills.
- [Agent-facing doctrine](../../agents/architecture/bitter-lesson.md) — protected outcomes, tracked contracts and verification limits.
- Richard Sutton, _The Bitter Lesson_ (2019). Caller-supplied research inventories are dated supporting evidence, not required guidance or change authority.
