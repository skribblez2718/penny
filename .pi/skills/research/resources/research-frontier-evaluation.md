# Research Skill — Frontier Evaluation & Design Rationale

> Purpose: the durable justification behind the `research` skill's design. The
> `ResearchPlaybook` on the shared orchestration engine realizes this rationale; the
> patterns below informed which states, critique loops, and escalation seams it carries,
> and which remain open future work (called out in §5).
>
> Method: web research performed **manually via the Playwright browser** (the `research`
> skill was NOT used — it hangs; and I have no standalone search-API tool). Primary source
> fetched verbatim = Anthropic's engineering post (`CERTAIN`). OpenAI's Deep Research page
> is a JS SPA that failed to render its body, so its pattern is cited from knowledge
> (`PROBABLE`). Gemini likewise `PROBABLE`.

---

## 1. Sources

| # | Source | Confidence | Fetched |
|---|--------|-----------|---------|
| S1 | Anthropic, *How we built our multi-agent research system* (engineering, Jun 13 2025), `anthropic.com/engineering/multi-agent-research-system` | `CERTAIN` (verbatim) | ✅ full article |
| S2 | OpenAI, *Introducing deep research* (Feb 2025), `openai.com/index/introducing-deep-research/` | `PROBABLE` (page SPA failed to render; from knowledge) | ⚠️ blocked |
| S3 | Google, *Gemini Deep Research* (2024–2025) | `PROBABLE` (from knowledge) | — |

## 2. What frontier deep-research systems actually do

**From S1 (Anthropic, verbatim — `CERTAIN`):**
- **Orchestrator-worker.** A `LeadResearcher` analyzes the query, **saves its plan to memory**, then **spawns parallel subagents**, each with its own context window, tools, and task boundaries.
- **Iterative research loop (the core).** *"The LeadResearcher synthesizes these results and decides whether more research is needed — if so, it can create additional subagents or refine its strategy. Once sufficient information is gathered, the system exits the research loop."* Subagents use **interleaved thinking after tool results to evaluate quality, identify gaps, and refine their next query.**
- **Dedicated CitationAgent (final pass).** After the loop, *"passes all findings to a CitationAgent, which processes the documents and research report to identify specific locations for citations… ensures all claims are properly attributed."*
- **Scale effort to query complexity** (validates the mode idea, with numbers): simple fact-finding = **1 agent, 3–10 tool calls**; direct comparison = **2–4 subagents, 10–15 calls each**; complex = **10+ subagents** with divided responsibilities.
- **Start wide, then narrow.** Begin with short, broad queries; evaluate; progressively narrow.
- **Parallelism, explicitly:** (1) lead spins up **3–5 subagents in parallel**, (2) each subagent uses **3+ tools in parallel** — *"cut research time by up to 90%."*
- **LLM-as-judge rubric** (the gold-standard quality bar — grade 0.0–1.0 + pass/fail on): **factual accuracy** (claims match sources), **citation accuracy** (cited sources match claims), **completeness** (all requested aspects), **source quality** (primary over secondary), **tool efficiency**.
- Evidence it matters: multi-agent (Opus-4 lead + Sonnet-4 subagents) beat single-agent Opus-4 by **90.2%** on their internal research eval; token usage alone explained **80%** of BrowseComp variance. (Cost caveat: multi-agent burns ~**15× chat tokens** — reserve for high-value queries.)

**From S2 (OpenAI Deep Research — `PROBABLE`):** asks **clarifying questions up front** before the long autonomous run, so the whole run is aimed correctly; then iterative search→read→reason→synthesize with inline citations.

**From S3 (Gemini Deep Research — `PROBABLE`):** generates a **multi-step plan the user can review/edit/approve** before execution, then browses iteratively and self-critiques.

## 3. Scorecard — current skill vs. frontier

| Frontier pattern | Current `research` skill | Gap? |
|---|---|---|
| Scale effort to complexity (modes) | quick/standard/deep modes ✅ | **Aligned** — keep |
| Parallel subagent search | `researching` is a single echo researching all sub-queries (the engine's fixed `ParallelSpec` does not fit a dynamic branch count) | Partial — sub-queries covered, but sequentially in one agent |
| Orchestrator decomposes → plan | `planning` (piper) ✅ (std+deep) | OK |
| Self-critique of plan | `critiquing_plan` (carren) + revise loop ✅ (deep) | OK |
| Self-critique of report | `critiquing_report` (carren) + revise loop ✅ (deep) | OK |
| **Iterative research loop (gap→more search)** | **Single round only** — no coverage/gap gate; no "decide if more needed" | **MISSING (biggest gap)** |
| **Independent evidence verification** (factual/citation/source-quality/contradiction) | **Vera `validating` state was REMOVED** — "folded into synthesizing" | **REGRESSION** — the generator now self-validates |
| **Dedicated citation/grounding pass** | none (skribble writes `sources.md`, but no claim→source verification) | **MISSING** |
| Up-front clarification | reactive only (on `UNCERTAIN` mid-run), not proactive | Partial gap |
| User plan approval (optional) | none (self-critique only) | Minor gap |
| Quality rubric (factual/citation/completeness/source/efficiency) | implicit in agent prompts; no explicit gate | Weak |

## 4. Are Quick / Standard "world-class, unbiased, reliable, factual"?

- **Quick** (`intake→1 echo→synthesize→write`): fast, but ships with **no grounding guarantee, no citation check, single-source risk, no independent verification**. Fast ≠ unverified. Fix: keep it lean but make three things non-negotiable in *every* mode — (a) claims grounded in ≥1 real source **with citation**, (b) **confidence tag** per finding, (c) a **minimal grounding self-check** before output.
- **Standard** (`intake→plan→parallel echo→synthesize→write`): has **zero verification** — no validate, no report critique. A report goes out with no independent cross-check. This is the reliability hole. Fix: add a **light independent VALIDATE** (factual + citation + source-quality) and the citation pass.
- **Deep**: strongest (dual critique loops) but still lacks the **iterative research loop**, an **independent verifier** (removed), and a **citation pass**.

**Conclusion:** not yet world-class on the axis the user cares most about (unbiased/reliable/factual). The scale-to-complexity mode design is right; the *verification and iteration* machinery is under-built. Adjustments recommended.

## 5. Design rationale — what the playbook carries, and what stays open

**Realized in `ResearchPlaybook` today:**
- **Scale effort to complexity (modes).** quick / standard / deep pick the FSM edges; `max_sub_queries` scales 1 / 3 / 4.
- **Plan-critique and report-critique revise loops** (deep, carren), each **bounded by `max_iterations`** with **honest exhaustion** (proceed with a recorded warning + surfaced unresolved issues; never a forced approval).
- **Stall-aware escalation**: a critique that keeps raising the same issues escalates to the user rather than burning budget.
- **Escalation seam**: `needs_clarification` or a false `*_complete` flag routes through the engine's single HITL gate.

**Open future work (motivated here, not yet in the playbook):**
1. **Independent VERIFY step** driven by **a different model than the synthesizer**, graded on the S1 rubric: factual accuracy, citation accuracy, completeness, source quality (primary>secondary), contradiction detection. *The generator should never be its own only verifier.* (The legacy `validating`/vera state was removed before the port; `researching` is a single echo agent and `synthesizing` self-validates.)
2. **Iterative research loop** (coverage/gap gate): after `researching`, assess gaps; if gaps remain and budget allows, loop back with refined sub-queries (Anthropic's "decide whether more research is needed"), bounded by a research-round cap. The current playbook does one research round.
3. **Dedicated citation/grounding pass** after synthesis: every claim maps to a real source or is cut/flagged (Anthropic's CitationAgent). skribble writes `sources.md`, but there is no claim→source verification.
4. **Proactive scoping/clarification** up front (OpenAI pattern), instead of only reacting to `needs_clarification` mid-run.
5. **Optional plan-approval** (Gemini pattern): fold into the deep plan critique as an optional human gate.

## 6. Reading the FSM

- **Multiple guarded arrows from one state = XOR** (exactly one fires), **not** parallel. `researching` is a single echo agent researching all sub-queries — there is no per-sub-query fan-out in the current playbook.
- **Every loop is bounded**: the plan and report critique loops by `max_iterations`; no unbounded cycles.
- **Mode gates** are guards on transitions (`[quick]`/`[standard]`/`[deep]`), so one FSM serves all three modes — the engine picks edges by the detected mode.
- If the independent-verify / citation passes in §5 are added, they must run on a different model than `synthesizing` (anti-gaming; uncorrelated errors).
