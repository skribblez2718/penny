# Atomic Loop Components

How to build Python-orchestrated loops that comply with the [Bitter-Lesson Doctrine](bitter-lesson.md): instead of one universal loop, a small set of atomic components arranged per task. This is the **construction** companion to the doctrine — the doctrine says *ratchet on capabilities, prune constraints*; this doc says *here are the parts that are capabilities and the parts that are constraints, and here is how to assemble them.* Full derivation, close reading of Sutton's essay, and reference Python live in `research/atomic-loop-components/`.

## The one structural law

> **Intelligence is confined to exactly two atoms (`Decide`, `Critique`). Every other atom is deterministic, model-agnostic Python.**

Consequences that make the whole approach compliant:

- The **procedure** for solving a task is never encoded in any atom — it is an output of `Decide` at runtime.
- When the model improves, only the two intelligent atoms improve their outputs; nothing else needs to change, so nothing else *fights* the improvement.
- Models are swappable because they appear behind exactly one interface.

The anti-goal is a **universal loop** — one concrete control-flow object all tasks flow through. Any such object forces task-knowledge (phases, routers, decompositions) to be baked in, which maximizes the constraint budget and rots hardest exactly as the Bitter Lesson predicts. The compliant inversion: an **empty kernel** + a library of atoms, with each task's loop assembled late.

## The compliance criterion

Every loop component must pass one test:

> **A component is compliant iff its value is non-decreasing as (a) model capability rises and (b) available compute grows** — i.e. it is a conduit for search or learning, a consequence boundary that exists for human/business reasons independent of capability, or capability-neutral plumbing.

A component whose value *decreases* as the model improves is a **KNOWLEDGE-CONSTRAINT** (doctrine term): permitted only as an explicitly-tagged, instrumented, deletable **loan**.

## The atom catalog (18 atoms, 7 families)

Each atom is classified by **Kind** (`SEARCH-CONDUIT` · `LEARNING-CONDUIT` · `BOUNDARY` · `PLUMBING` · `INTELLIGENCE`), **Durability** (`DURABLE` vs `LOAN`), and **Decision owner** (`CODE` vs `MODEL`).

| # | Atom | Family | Kind | Durability | Decisions |
|---|---|---|---|---|---|
| A1 | **Thread** — append-only event log; unified execution+business state | State | plumbing | durable | code |
| A2 | **Checkpoint** — durable pause/resume; interrupt between intent selection & execution | State | plumbing | durable | code |
| A3 | **Workspace** — externalized artifacts (files, git, progress notes) in media the model already knows | State | plumbing / learning | durable | model content |
| B1 | **Decide** — the single intelligent step: `render(thread) → structured Intent` | Intelligence | **intelligence** | durable (prompts = loans) | **model** |
| B2 | **Critique** — separated evaluator in fresh context, ideally a different model | Intelligence | intelligence / search | durable | **model** |
| C1 | **Act** — deterministic dispatch of an intent; errors are data, not control flow | Action | plumbing | durable | code executes, model chooses |
| C2 | **Toolspace** — the declared action surface; broad primitives, not bespoke wrappers | Action | search-conduit | durable (wrappers = loans) | code declares, model uses |
| D1 | **Verify** — externally grounded verification; the objective function of the search | Control | **search-conduit** | **durable — top survivor** | code |
| D2 | **Budget** — bounded expenditure + honest exhaustion; the primary scaling knob | Control | boundary + scaling dial | durable | code caps, model spends |
| D3 | **Gate** — deny-by-default consequence boundary on irreversible/external actions | Control | **boundary** | durable | code / human |
| D4 | **Escalate** — human contact as a first-class Intent (`AskHuman`) | Control | boundary / search | durable | model asks, code transports |
| E1 | **Fan** — parallelism: sectioning, voting/best-of-N, spawn (isolated sub-context) | Scale | **search-conduit (purest)** | durable | model topology, code mechanics |
| E2 | **Compact** — context economy; trim stale results, summarize resolved errors | Scale | search-conduit | need durable, mechanisms = loans | model preferred |
| F1 | **Ledger** — record outcome + evidence per run | Learning | learning-conduit | durable | code |
| F2 | **Recall** — retrieve distilled lessons into `Decide` context at run start | Learning | learning-conduit | durable | code retrieves, model applies |
| F3 | **Distill** — compress ledger into reusable lessons/skills, gated by ratchet + human | Learning | learning-conduit | durable | model drafts, ratchet gates |
| G1 | **Observe** — structured traces; audit + measurement substrate | Meta | plumbing / boundary | durable | code |
| G2 | **Ablate** — scaffold ON vs OFF measurement; the deletion mechanism | Meta | **meta-method** | **permanent** | code measures, human disposes |

**`Verify` (D1) is where extra engineering investment is *most* compliant** — the verifier is the objective function of the search, and its quality is the ceiling of the whole system (Carlini: "the task verifier must be nearly perfect, otherwise the agent solves the wrong problem"). Strength hierarchy: **oracle** (test suite, compiler, environment state) > **rules** (schema, lint, invariant) > **proxy** (Goodhart-vulnerable measurable stand-in) > **critic** (B2, never sole). A PASS with empty evidence is a contract violation.

**`Ablate` (G2) is the only permanent atom** — it is Sutton's meta-method clause made executable (build in the machinery of discovery, not the discoveries). Every LOAN-tagged component carries an ablation hook.

**Deliberately absent** (not atoms — they are arrangements or loans inside `Decide`'s prompt, never first-class parts): a Planner module, a Router with a keyword table, a fixed pipeline/DAG DSL, an output-format repair layer, a custom memory abstraction, a universal orchestrator base class with mandated phases.

## The composition kernel

Every loop is the same three-line kernel; everything else is which atoms decorate it and who owns the `while`.

```
context = Recall(Thread)            # F2 → A1: seed with lessons + history
while Budget.ok():                  # D2: the only unconditional bound
    intent = Decide(render(Thread)) # B1: the ONE intelligent step
    Thread.append(intent)
    match intent:
        done   → if Verify(claim): return done        # D1 gates success
                 else: append verdict; continue        # verify failed → search continues
        ask    → Checkpoint; break                     # D4/A2: pause for human
        act    → gated = Gate(intent)                   # D3: consequence boundary
                 Thread.append(Act(gated, Toolspace))   # C1/C2
Ledger.record(Thread)               # F1: outcome → learning substrate
```

The kernel is universal because it contains **no task knowledge** — no steps, no decomposition, no routing. All of that is `Decide`'s runtime output. Chasing a universal loop means over-specifying this kernel; the compliant move is to keep it empty of task-content and vary the *arrangement* around it.

## The seven assembly invariants

Every arrangement must hold all seven; violating any one is non-compliant regardless of how clever the shape is.

1. **Exactly one intelligence interface.** `Decide` (+ optional `Critique`). If a second place in the code "understands the task," move it into the prompt or delete it.
2. **At least one bound.** Every loop has a `Budget`; unbounded loops are forbidden (paralysis containment).
3. **At least one grounded exit.** Success terminates only on `Verify`, never on `Done` alone (premature-termination containment).
4. **State is external.** Anything routing-relevant lives in `Thread`/`Workspace`/`Checkpoint`, never implicitly in a context window.
5. **Consequence actions pass a `Gate`.** Irreversible/external effects are deny-by-default.
6. **Every LOAN atom carries an `Ablate` hook.** If it exists because the current model is weak, it is toggleable and scheduled for measurement.
7. **Arrangement is data, chosen late.** Topology (chain? loop? fan?) is per-task — ideally `Decide`-chosen — not hardwired into a base class.

## The control-flow dial

The master design lever, and what makes the strategy age well:

> **Who owns the control flow — your Python or the model?** Not binary; a dial. The Bitter-Lesson-correct direction is to turn it toward the model over model releases.

| Dial position | Who decides the path | When correct | Atoms emphasized |
|---|---|---|---|
| **Code-owned** (workflow) | `if/elif`/DAG fixes the sequence | Steps fixed, nameable, reversibility matters, audit required | Chain of `Decide` calls + `Gate`s |
| **Mixed** (micro-agents in a DAG) | Code owns the skeleton, model owns segments | Most 2026 production work | Short agent loops (3–20 steps) between code-owned gates |
| **Model-owned** (agent) | `Decide` chooses every next step and when to stop | Open-ended, unpredictable step count, trusted sandbox | The full kernel; `Fan` orchestrator; `Escalate` |

A compliant codebase makes moving the dial a small edit, not a rewrite — which is why arrangements are data, not inheritance.

## The six canonical arrangements

These are **not** distinct architectures to choose a framework for — they are six ways to wire the same atoms. They map onto the [seven loop classes](../skills/loops.md) (L1–L7 are these arrangements nested) and Anthropic's five workflow patterns. You move between them by re-wiring, not re-building.

| Arrangement | Dial | Atoms | Loop-class map |
|---|---|---|---|
| **1. Chain** (prompt chaining) | code-owned | `Decide`×n + `Gate`/`Verify` between; no loop-back | L-pipeline |
| **2. Agent loop** | model-owned | the bare kernel; keep 3–20 effective steps | L1 + L5 |
| **3. Evaluator-optimizer** | model-owned loop | kernel + `Critique`/`Verify` in-loop + bounded repair; **retries must change strategy** | L2 + L3 |
| **4. Orchestrator-workers** | model-owned | `Decide` emits subtasks *at runtime*; `Fan`-spawn worker loops; `Decide`-synthesis fan-in | L5 + fan-out |
| **5. Parallel vote/sample** | pure search | `Fan` N attempts; select by `Verify` (oracle/rules), never by vibes | pure search |
| **6. Background tick** | scheduled | cron/event trigger that starts or *resumes* (via `Checkpoint`) any of 1–5 | L7 |

They nest: a tick (6) resumes an orchestrator (4) whose workers are evaluator-optimizer loops (3) that internally vote (5) on a code-owned chain (1). Depth of composition, not competing designs.

## The LOAN lifecycle (how loops stay compliant over time)

Loans (KNOWLEDGE-CONSTRAINT scaffolding a current model still needs) must be repaid or they become the *BLE-hobbled system* — scaffolding aged past usefulness, now making the system worse. Triggered at every model upgrade (when scaffolding becomes newly obsolete) and periodically:

1. **Inventory** all LOAN-tagged components (they're tagged per invariant 6).
2. **Ablate** each: task set scaffold-ON vs OFF, behavior-blind grader (`G2`); record pass-rate + cost deltas.
3. **Dispose:** OFF ≥ ON → delete the loan (the common upgrade outcome). OFF materially worse → keep, re-tag with new expiry. OFF slightly worse but far simpler → usually delete (thin wins on distribution shift).
4. **Ratchet:** confirm every protected capability (grounded `Verify`, honest exhaustion, durable memory, resume, HITL gates) still measures green. Removing a constraint while keeping capabilities green **passes**; weakening a capability **fails** — regardless of any single benchmark.
5. **Distill & record.**

Proposes; measurement disposes. No loan deleted on taste, none kept on sentiment.

## The add-side gate

Before adding any component — atom instance, prompt clause, threshold, tool wrapper, routing rule, mandated step — answer:

> **Will this get more or less valuable as the model improves and compute gets cheaper?**
> - **More / neutral** (search/learning conduit, consequence boundary, capability-neutral plumbing) → compliant, add it.
> - **Less** (substitutes for capability) → do NOT hard-code it. Can the model do it by reading an artifact? If yes, give the model the artifact (a `Recall` lesson, a prompt line, a tool description) and verify with evidence. If it genuinely can't yet, add it as a **tagged LOAN** with an `Ablate` hook and expiry — never as a first-class atom.

## Anti-patterns (the non-compliant tells)

| Anti-pattern | Why it violates | Compliant replacement |
|---|---|---|
| Universal loop / `BaseOrchestrator` with mandated phases | Maximizes frozen decisions; bakes a theory of how tasks should be solved | Empty kernel + atoms; arrangement per task |
| Keyword/regex router table | Encodes task understanding outside `Decide` | `Decide` routes; or a tiny classifier as a tagged LOAN |
| Hard-coded task decomposition | Procedure frozen at author time | Orchestrator `Decide` emits subtasks at runtime (arr. 4) |
| Bespoke tool wrappers "to help the model" | Narrow surface the model outgrows | Broad primitives (bash/http/files); wrappers only for consequence shaping |
| Output-format repair layer | Compensates for a dissolving weakness | Error → event → model repairs; ablate each upgrade |
| "Think step by step" / procedure prompts | Tells a capable model how to think | State goals+constraints; prompt-ablate on upgrades |
| Success on `Done` claim alone | Premature-termination class; no grounded exit | Gate success on `Verify` with captured evidence |
| Unbounded loop / retry-without-strategy-change | Paralysis class | `Budget` bound + reflection-informed repair |
| Custom memory abstraction | Model re-taught it every release | `Workspace`: files + git + markdown |
| Fixed `Fan` topology ("always 3 workers") | Org chart, not search | Topology is `Decide`'s output, bounded by `Budget` |

## Pre-ship checklist (run on any new loop)

```
INTELLIGENCE
[ ] All model judgment goes through Decide/Critique — no second "task brain"
[ ] Prompts state goals+constraints+capabilities, NOT step-by-step procedure
[ ] Intent space starts wide-and-safe, restricted by evidence (not an enumerated whitelist)

CONTROL & TERMINATION
[ ] Exactly one Budget bounds the loop; a global step cap backs it up
[ ] Success terminates ONLY on an externally-grounded Verify pass, with captured evidence
[ ] Verify uses the strongest available tier (oracle > rules > proxy > critic)
[ ] Budget exhaustion returns met=False + best artifact + reason (no fake pass, no loop-past)
[ ] Retries change strategy (reflection-informed), never blind repeat

CONSEQUENCE & CONTINUITY
[ ] Irreversible/external actions pass a deny-by-default Gate; sandbox/allow-lists present
[ ] All routing-relevant state in Thread/Workspace/Checkpoint
[ ] Long-horizon work reconstructs progress from external state (memoryless-safe)

SCALING & LEARNING
[ ] Improving output = turning a knob (iterations/samples/Fan/verifier), not editing control flow
[ ] Ledger records outcome+evidence; Recall seeds lessons at start (dated, overridable)

COMPLIANCE HYGIENE
[ ] Every component passed the add-side gate; every LOAN is tagged + has an Ablate hook + expiry
[ ] Arrangement is data (per task); moving the control-flow dial toward the model is a small edit
[ ] Protected capabilities (grounded verify, honest exhaustion, HITL, resume, memory) are ratchet-guarded
```

## How this maps onto Penny today

The atoms are not a rewrite target — they are a **lens** for reading and evolving the existing engine. The mapping (fuller version in `research/atomic-loop-components/`):

| Atom | Penny mechanism |
|---|---|
| Thread / Checkpoint / Workspace | `RunContext`, durable `run_id` checkpointer + `recover_pending`, MemPalace + git |
| Decide / Critique | `invoke_agent` (pi subagent) / Vera (objective) + Carren (subjective) |
| Verify / Budget / Gate / Escalate | `done_predicate` + evidence `summary_contract` / `max_iterations` + `learn_exhausted` / `GATE_STATES` / UNCERTAIN → `awaiting_clarification` |
| Fan / Compact | parallel fan-out with weakest-confidence fan-in / context discipline |
| Ledger / Recall / Distill | outcome ledger (now outcome+evidence) / `recall_lessons` — run-start lesson seeding into the first agent directive (advisory, never gating) / daily compression loop |
| Observe / Ablate | observability events / `run_prompt_efficacy.py --ablate` + the eval ratchet |

Of the five gaps this framing sharpened (see [loops.md](../skills/loops.md)), four are now closed at the engine level (2026-07-14): strategy-delta enforcement and stall detection are **default-on** (the base `progress_check` + engine-recorded iteration digests, opt-out via `LOOP_GUARDS = False`), run-start reflection retrieval is live (`recall.py`), and evidence-grounded verify contracts are enforced (`contracts.py` + ledger capture). The engine also carries a LOAN registry with Ablate toggles (`loans.py`, invariant 6), an honest-exhaustion backstop on the iteration budget, runtime-emitted fan topology (`parallel_spec` seam), and model-owned routing as a small edit (`fire_model_route`). The remaining open gap is **verifier-gaming hardening** (dual-verifier agreement at high-stakes gates).

## Related

- [Bitter-Lesson Doctrine](bitter-lesson.md) — the LEVERAGE/SAFETY/KNOWLEDGE-CONSTRAINT triage and the ratchet this framework operationalizes
- [Agentic Loops — Reference](../skills/loops.md) — the L1–L7 loop classes (arrangements of these atoms) and per-class design rules
- [Outcome Ledger](outcome-ledger.md) — the ratchet substrate the LOAN lifecycle measures against
- [Atomic Loop Components (Human)](../../humans/architecture/atomic-loop-components.md) — conceptual overview and rationale
- Full research pack: `research/atomic-loop-components/` (essay reading, compliance rules, reference Python, prompt-rewrite change map)
