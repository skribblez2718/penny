# Atomic Loop Components

## The question this answers

Is there one universal loop that can run any task — and if not, what's the alternative? Penny's [loop research](../skills/loops.md) already established the answer's first half: there is a universal _shape_ (gather context → act → verify → repeat) but no universal _architecture_. This document is the second half: **the set of reusable building blocks from which any specific loop is assembled**, and the rule that keeps those blocks from ageing badly as models improve.

It is the construction companion to the [Bitter-Lesson Doctrine](bitter-lesson.md). The doctrine is the philosophy — _general methods that leverage computation beat hand-coded human knowledge, so protect capabilities and prune constraints_. This is the practice — _here is what a capability looks like as a Python component, here is what a constraint looks like, and here is how you snap them together into a working loop._

## Why not just build the one perfect loop?

Because the one perfect loop is the trap. Richard Sutton's _Bitter Lesson_ — 70 years of AI history — says that any system which bakes in _how we think the problem should be solved_ wins in the short term and then plateaus, because a constant (human cleverness) is racing an exponential (compute and model capability). A single universal loop is the maximum expression of baked-in procedure: to make one loop work for every task, you have to hard-code phases, routers, and decompositions into it. That is exactly the scaffolding the next model release makes obsolete.

The 2024–2026 record confirms this at the harness layer, on a faster clock. Teams that built elaborate orchestration around their agents watched a new model dissolve it: hand-rolled planners, format-repair layers, and multi-agent graphs became overhead the moment the underlying model got good enough. The lesson that keeps repeating: **the model eats the harness.**

So the goal is inverted. Instead of chasing a loop that does everything, you build an _empty_ loop and a _library of parts_, and you assemble the specific loop a task needs at the last possible moment — increasingly letting the model itself decide the assembly.

## The one idea that makes it work

**All the thinking lives in one place.** Exactly two of the sixteen core components ever touch a model: one that decides what to do next, and one that judges whether work is good. Everything else — the event log, the budget counter, the safety gates, the checkpoints, the parallel-execution machinery — is ordinary, deterministic host code that knows nothing about the task.

This single constraint delivers most of the payoff:

- **The procedure is never written down.** How to solve the task — what steps, which tools, what order — is an _output_ of the deciding component at runtime, not something a human coded. That is the part that would otherwise rot.
- **Better model, better loop, for free.** When the model improves, only those two thinking components get smarter. Nothing else changes, so nothing else _fights_ the improvement.
- **Models are swappable.** They sit behind exactly one interface, so switching from one to another is a one-line change, not a rewrite.

## Why sixteen, while still preserving learning

The catalog includes only single-responsibility building blocks. It does not turn every useful capability into another atom.

- Recording outcomes is a **projection** of parts already present: the event thread contains terminal facts, verification carries evidence, observation carries measurements, and the workspace carries durable artifacts. A separate authoritative ledger would duplicate truth.
- Distilling reusable knowledge is an **arrangement**, not one part. It retrieves material, compacts it, asks the deciding/judging components to propose and challenge a lesson, verifies or ablates it, passes consequential promotion through a human gate, and stores the approved artifact.

This preserves the complete learning capability without calling a data view or a multi-stage workflow an atom. Safe retrieval remains one of the sixteen core parts: it is explicit, relevant, provenance-linked, and advisory—never automatic authority.

## Three kinds of part

Every component is one of these, and knowing which is the whole discipline:

- **Conduits** let the system spend more computation for a better answer. Two flavors: _search_ conduits (run more iterations, try several attempts in parallel, verify and retry) and _learning_ conduits (record what happened, distill lessons, recall them next time). These get _more_ valuable as compute and models grow. **Invest here.**
- **Consequence boundaries** exist for human reasons, not capability reasons — the security rules, the "ask a human before doing something irreversible" gates, the sandbox. A smarter model doesn't make these less necessary; it often makes them _more_ necessary. **Keep these permanently.**
- **Plumbing** is capability-neutral machinery — the event log, the checkpoint store, the tracing. It neither helps nor fights the model. **Keep it boring.**

Anything that doesn't fit these three is a fourth thing: **a loan.** It's scaffolding that compensates for a _current_ model's weakness — a format-fixer, a step-by-step script, a workaround for a quirk. Loans are allowed, but only if you tag them and schedule their repayment, because the next model release is when they turn from helpful to harmful.

## The one test

Before adding anything to a loop, ask: **will this get more or less valuable as the model improves?**

- More or neutral → it's a conduit, boundary, or plumbing. Add it.
- Less → it substitutes for capability. Don't hard-code it. Give the model the information as something it can read and override, and check the result with evidence. If the current model genuinely can't manage without the scaffold, add it as a tagged loan with an expiry — never as a permanent part.

## The verifier is the ceiling

One component deserves more engineering investment than any other: the **verifier** — the thing that decides whether work is actually done. It's the objective function of the whole search. As one practitioner building a 100,000-line compiler with parallel agents put it: _the task verifier must be nearly perfect, otherwise the agent solves the wrong problem._

Verifiers come in strength tiers, and the difference is enormous:

- **Oracle** — ground truth you can execute: a test suite passes, the code compiles, the environment reaches a known state. Strongest.
- **Rules** — a schema validates, a linter is clean, an invariant holds.
- **Proxy** — a measurable number that stands in for the real goal. Works until it drifts from what you actually care about (Goodhart's Law).
- **Critic** — another model reading the output. Cheapest, weakest; never the only check, because a model judging its own family shares its blind spots.

The strongest systems build an oracle wherever they can. Often, _building the verifier is the highest-leverage act in the whole task_ — because no amount of model capability can safely deliver work you can't check.

## The loop that never claims false success

Two failure modes sit at opposite ends of the same axis, and the atoms defend against both:

- **Spinning** — the loop retries a failing approach forever. Defense: every loop has a budget, and a retry must _change strategy_, not repeat — the next attempt is worth making only when inputs, method, model, or evidence source changed enough that a different result is plausible. When it's out of budget, it stops and reports honestly what it did and didn't achieve — it never dresses a partial result as a success.
- **Quitting early** — the loop declares half-finished work done. Defense: success is only ever granted by the verifier, never by the model's own say-so. "I think I'm done" is not "done"; "the tests pass" is.

## Same parts, any task

The proof that this isn't just theory: unlike tasks are all _the same parts in a different arrangement._

- **Fix a failing test** → a generate-check-repair loop, verified by the test suite (an oracle), with a retry budget.
- **Answer a research question** → an exploration loop with parallel search, verified by "claims carry sources," seeded with prior findings.
- **Deploy to production** → a fixed sequence with a hard human-approval gate before the irreversible step.
- **A long build across many sessions** → a scheduled tick that resumes a big orchestrated run, keeping its progress in files and git so nothing is lost between sessions.

In each case the engineering work is: _pick the strongest verifier you can build, set the budgets, place the safety gates, choose how much of the driving the model does._ The step-by-step procedure is never written — the model produces it, and it improves on its own when the model does.

## How this shows up in Penny

The atoms aren't a demand to rebuild anything — they're a **lens** for reading the engine Penny already has and deciding what to evolve. Penny's orchestration engine already implements most of them: the durable checkpointer and crash-resume (state and continuity), the Vera/Carren split (deciding and judging intelligence), evidence-backed verification contracts and iteration budgets (control), parallel fan-out (scale), and a tagged-loan registry with measurement off-switches. Retries must change strategy, stalled loops escalate, budget exhaustion is reported honestly, and runtime fan-out can come from the model rather than a fixed shape.

Memory retrieval is explicit rather than injected automatically: an agent uses approved memory tools when prior decisions or work could matter. Penny has no automatic outcome-ledger/compression/amendment pipeline. When a product needs cross-run learning, it composes the optional gated learning arrangement from the same sixteen parts instead of creating a second source of truth or silently feeding stored text into prompts. Verifier-gaming hardening remains an active frontier.

## Where to go deeper

- [Bitter-Lesson Doctrine](bitter-lesson.md) — the philosophy: what Penny protects and what it prunes as models improve
- [Agentic Loops](../skills/loops.md) — the seven loop classes, which are these atoms arranged and nested
- [Atomic Loop Components (Agent Reference)](../../agents/architecture/atomic-loop-components.md) — the full catalog, assembly rules, and pre-ship checklist for building loops
- Full research pack (with Sutton's essay read closely, the compliance rules, and reference Python): `research/atomic-loop-components/`
