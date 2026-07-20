# Karpathy Coding Methodology — Synthesis & Design Rationale

> Purpose: the durable justification for the `code`-skill flow diagram in this
> directory (`flow.html`). It describes the actual `CodeMachine` FSM — ONE
> `BasePlaybook` subclass (`orchestration.playbooks.code:CodePlaybook`) with
> custom-named states — that the code skill now runs on the shared orchestration
> engine. (An earlier `flow.v2.mmd` sketched a never-built "composable primitive
> skills" variant; it has been removed. The code skill is a single playbook, not a
> composition of primitive skills.)
>
> Provenance & confidence: this brief was synthesized **manually** from the primary
> sources listed below. Live web research was attempted via the `research`/`echo`
> subagents but they hung, so external talks/tweets are cited from memory and marked
> `PROBABLE` (no fabricated quotes). The two verbatim sources are marked `CERTAIN`.

---

## 1. Sources

| # | Source | Confidence | Notes |
|---|--------|-----------|-------|
| S1 | `/tmp/karpathy.txt` — Karpathy's "A few random notes from claude coding" (Dec 2025) | `CERTAIN` (verbatim in hand) | The "Leverage" paragraph is the load-bearing one. |
| S2 | `/tmp/andrej-karpathy-skills` — third-party reverse-engineering (`forrestchang/andrej-karpathy-skills`), the `karpathy-guidelines` skill | `CERTAIN` (text in hand) | Four principles, attributed by the author to Karpathy's X post `2015883857489522876`. Attribution is the author's claim; the *content* is what we use. |
| S3 | Karpathy, "Software Is Changing Again" / *Software 3.0* (YC AI Startup School talk, ~Jun 2025) | `PROBABLE` (from memory) | Autonomy slider; generation↔verification loop; "keep the AI on a leash"; make the verification loop fast. |
| S4 | Karpathy, "vibe coding" (coined ~Feb 2025, X) | `PROBABLE` (from memory) | Throwaway/weekend-project mode; explicitly NOT production engineering. |

---

## 2. The problems Karpathy names (what the loop must defend against)

Verbatim from S1 (`CERTAIN`):

> "The most common category is that the models make wrong assumptions on your behalf and
> just run along with them without checking. They also don't manage their confusion, they
> don't seek clarifications, they don't surface inconsistencies, they don't present
> tradeoffs, they don't push back when they should, and they are still a little too
> sycophantic."

> "They also really like to overcomplicate code and APIs, they bloat abstractions, they
> don't clean up dead code after themselves... They will implement an inefficient,
> bloated, brittle construction over 1000 lines of code and it's up to you to be like
> 'umm couldn't you just do this instead?'"

> "They still sometimes change/remove comments and code they don't like or don't
> sufficiently understand as side effects, even if it is orthogonal to the task at hand."

**Four failure modes** → the four guidelines in S2:

| Failure mode (S1) | Guideline (S2) | Where it lands in the loop |
|---|---|---|
| Wrong assumptions; no clarification; no tradeoffs; sycophancy | **Think Before Coding** | FRAME + Ambiguity/clarification gate (up front) |
| Overcomplication; bloated abstractions; 1000 lines for 100 | **Simplicity First** | A dedicated **simplicity check** in VERIFY/REVIEW |
| Orthogonal edits; touching code it doesn't understand | **Surgical Changes** | A **surgical-diff check** in VERIFY/REVIEW |
| — (the positive lever) | **Goal-Driven Execution** | The whole declarative FRAME⇄VERIFY loop |

## 3. The Leverage insight (the engine)

Verbatim from S1 (`CERTAIN`):

> "LLMs are exceptionally good at looping until they meet specific goals... **Don't tell it
> what to do, give it success criteria and watch it go. Get it to write tests first and
> then pass them. Put it in the loop with a browser MCP. Write the naive algorithm that is
> very likely correct first, then ask it to optimize it while preserving correctness.
> Change your approach from imperative to declarative to get the agents looping longer and
> gain leverage.**"

Five operational directives fall out of this one paragraph:

1. **Declarative, not imperative** — hand the agent success criteria, not step-by-step instructions.
2. **Success criteria == verification criteria** — the same artifact written once, checked at the end. (This is exactly Penny's existing `prd` `IDEAL_STATE`, which the code skill consumes when available — synthesized from the goal otherwise.)
3. **Tests first, then pass them** — Karpathy explicitly endorses tests-first *as the encoding of the criteria*, not as per-line ceremony.
4. **Naive-correct first, then optimize preserving correctness** — a two-beat ACT: get it green simply, *then* optimize with the green battery as the guardrail.
5. **Loop with real execution** ("browser MCP") — verification must include a **functional/e2e** tier, not just unit mocks. `PROBABLE` link to S3: keep the generation↔verification loop fast.

Cross-cutting stance (S1 + S3): the human is a **reviewing hawk** — the loop must surface tradeoffs, keep diffs small, and make verification cheap enough to run every iteration.

---

## 4. The resolved tension — strict TDD vs. the guarantee

**User's constraint (immutable):** every deliverable ships with passing **lint + unit +
integration + e2e + functional** tests. This is non-negotiable.

**User's pain:** strict per-unit `RED → GREEN → REFACTOR` ceremony is tedious and slow.

### What argues FOR strict per-unit RED→GREEN→REFACTOR
- Forces a failing test to exist before code (prevents "passing" vacuous tests).
- Micro-steps keep each change tiny and traceable (aligns with **Surgical Changes**).

### What argues AGAINST it (per Karpathy)
- It is **imperative micro-management** — the opposite of "give it success criteria and
  watch it go" (S1). It shortens the loop the model is best at running.
- The *ceremony* (one failing assertion → minimal code → refactor, per function) adds hops
  and context tax without adding to the **guarantee**. The guarantee is "all tiers green,"
  which is a property of the *battery*, not of the authoring micro-rhythm.
- It does nothing about Karpathy's actual top failure modes (bloat, orthogonal edits,
  wrong assumptions) — those need Simplicity/Surgical/Think gates, which strict TDD omits.

### The faster-but-still-rigorous alternative

Keep the **guarantee**; drop the **ceremony**. Concretely:

1. **FRAME the test surface up front, at behavior granularity.** The IDEAL_STATE's
   `success_criteria` are written as *executable* acceptance checks across all five tiers.
   This preserves "tests first" (Karpathy-endorsed) — but as a **criteria battery**, not a
   per-function red-first ritual.
2. **ACT = naive-correct-first.** Skribble writes the simplest implementation that can
   satisfy the whole battery. No per-unit RED gate; the battery is the gate.
3. **VERIFY = the whole battery every iteration** (lint, type, unit, integration, e2e,
   functional). `PASS` only if **all** tiers are green. This *is* the guarantee, enforced
   at the loop boundary instead of per unit. ACT↔VERIFY loops until green or budget spent
   (never fakes success — records the miss).
4. **Two new VERIFY dimensions** (Karpathy's real pain points, absent from classic TDD):
   - **Simplicity check** — "would a senior engineer say this is overcomplicated? if 200
     lines could be 50, rewrite" (S2 §2).
   - **Surgical-diff check** — "every changed line traces to the request; no orthogonal
     edits; only your own orphans cleaned" (S2 §3).
5. **OPTIMIZE preserving correctness** — an *optional* post-green beat: optimize with the
   green battery as the revert guardrail (S1), keep-if-better / revert-if-worse. (The
   current `CodeMachine` has no dedicated optimize state — see §5.)

Net: tests-first survives, the all-tiers-green guarantee is *strengthened* (checked as a
battery every loop), and the slow per-unit ritual is replaced by a declarative loop plus
two review gates that target Karpathy's documented failure modes.

---

## 5. Mapping to the CodeMachine FSM

`flow.html` encodes §4 as ONE `BasePlaybook` subclass (`CodePlaybook`) with
custom-named states — not a composition of primitive skills, and not a separate
`build-cycle` playbook. The table below traces each Karpathy concern to where it
lands in the real graph.

| Concern | Where it lands in `flow.html` / `CodeMachine` |
|---|---|
| Unit of orchestration | one `CodePlaybook` (a `BasePlaybook` subclass) on the shared engine |
| States | custom domain phases: `exploring`/`analyzing`/`checking_criteria`/`planning`/`implementing`/`verifying`/`learning` |
| Think Before Coding | `checking_criteria` (carren judges criteria quality) + the `criteria_gate` HITL, both before any code |
| Simplicity First / Surgical Changes | carren's `learning` gap check (DRY, self-documenting, no orthogonal edits) |
| Goal-Driven / criteria == verification | IDEAL_STATE `success_criteria` (from the prd skill) drive the `verifying` battery |
| Naive-correct then optimize | `implementing` (write the simplest code + tests that satisfy the battery; authoring rhythm is the model's call) → `verifying`; there is no separate `optimizing` state |
| Guarantee (all tiers green) | `verifying` runs every configured tier; the `verifying ⇄ learning ⇄ implementing` loop drives to green, bounded by `max_iterations` |
| Human-as-hawk | `plan_gate` approval + `unknown`/`awaiting_clarification` escalation |

Note how the FSM realizes §4's alternative: skribble's `implementing` guidance
leaves the authoring rhythm to the model (test-first / alongside / after) — the
all-tiers-green battery is the gate, not a per-unit RED → GREEN → REFACTOR ritual —
and it folds the Simplicity/Surgical review into carren's `learning` gap check
rather than a dedicated `reviewing`/`optimizing` state. The
§4 **guarantee** — all configured tiers green, enforced as a loop battery — is
what the `verifying` state implements.
