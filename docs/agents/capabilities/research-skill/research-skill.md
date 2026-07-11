# Research Skill — Structured evidence-based research

## What

A multi-agent research workflow that investigates a query, assesses source credibility, resolves conflicts, and synthesizes a coherent report. It operates at three depths: Quick, Standard, and Deep.

## Why

Agents need to ground claims in evidence. The research skill separates evidence gathering from synthesis, tracks source quality, and flags uncertainty rather than fabricating consensus.

## Rules

1. **Use for complex or multi-source questions.** Do not use for simple lookups (`web_search` directly), code implementation, or when you already have enough information.
2. **Penny is a router.** Agents communicate via mempalace (`skills/research-<session_id>`); Penny only sees per-state SUMMARY contracts.
3. **Mode is auto-detected but can be overridden.** Use `constraints.mode` only when the default detection is wrong.
4. **Credibility tiers are mandatory.** Echo classifies every source as T1–T4; Synthia uses those tiers when assigning confidence.
4a. **Video sources are in scope, not optional extras.** Echo holds the `youtube_transcript` tool and runs a YouTube-targeted `web_search` for every sub-query; relevant videos (official channels, conference talks, established practitioners) get their transcript pulled and tiered like any written source. A miss is documented explicitly ("No relevant video content found"), not silently skipped.
5. **Deep mode adds critique gates.** Plan critique and report critique catch gaps and overclaiming.
6. **The skill returns a report, not decisions.** Do not execute recommendations without user approval.

## Procedure

### Invocation

```typescript
skill({
  skill_name: "research",
  goal: "What are the tradeoffs of microservices vs monoliths?",
  project_root: "/path/to/project",
})
```

Optional constraints:

| Constraint | Values | Default | Description |
|------------|--------|---------|-------------|
| `mode` | `auto`, `quick`, `standard`, `deep` | `auto` | Research depth |
| `report_format` | `default`, `brief`, `academic`, `executive` | `default` | Output style |
| `max_sub_queries` | int | mode-dependent | Cap on the number of sub-queries |

### Engine

The research skill runs on the shared orchestration engine at `apps/orchestration/`. The behavior lives in `ResearchPlaybook` (`apps/orchestration/src/orchestration/playbooks/research.py`), a `BasePlaybook` subclass with custom-named states, per-state SUMMARY contracts, `route_after` routing, a `done_predicate`, and a `progress_check` escalation gate. `.pi/skills/research/scripts/orchestrate.py` is a ~5-line delegate into `orchestration.cli`; it holds no state machine.

Run state lives in the engine's durable SQLite checkpointer keyed by `run_id`. There is no `--state` argv and no `/tmp` session file. A run interrupted mid-step is recovered automatically by the engine (`recover_pending`), which re-issues the interrupted step.

### Mode detection

| Mode | Triggers |
|------|----------|
| **Quick** | Short single-question queries, or phrases like "what is", "define", "overview", "quickly", "briefly", "summary", "tldr" |
| **Deep** | Phrases like "deep research", "comprehensive", "thorough", "in-depth", "detailed analysis", "exhaustive" |
| **Standard** | Everything else |

### State phases

#### Quick mode

```
intake → researching → synthesizing → report_writing → complete
```

Agents: `echo` → `synthia` → `skribble`

Quick mode skips planning; `intake` routes straight to `researching`.

#### Standard mode

```
intake → planning → researching → synthesizing → report_writing → complete
```

Agents: `piper` → `echo` → `synthia` → `skribble`

#### Deep mode

```
intake → planning → critiquing_plan → researching → synthesizing → critiquing_report → report_writing → complete
```

Agents: `piper` → `carren` → `echo` → `synthia` → `carren` → `skribble`

In deep mode `critiquing_plan` and `critiquing_report` are bounded revise loops: a `NEEDS_REVISION` verdict routes back to `planning` (respectively `synthesizing`) for another cycle, capped by `ctx.max_iterations`. When the budget is exhausted the run proceeds honestly with a recorded warning and the unresolved issues surfaced in the result — it never force-approves.

### State descriptions

| State | Agent | Purpose |
|-------|-------|---------|
| `intake` | — | Validate query, detect mode, seed `max_sub_queries` |
| `planning` | `piper` | Decompose query into sub-queries (standard/deep; also the clarify-resume entry point) |
| `critiquing_plan` | `carren` | Review sub-query plan; APPROVE or NEEDS_REVISION (deep only) |
| `researching` | `echo` | A single agent researches ALL sub-queries, writing one findings drawer per sub-query |
| `synthesizing` | `synthia` | Merge findings into a coherent, cited report |
| `critiquing_report` | `carren` | Review synthesis for overclaiming, bias, fairness; APPROVE or NEEDS_REVISION (deep only) |
| `report_writing` | `skribble` | Write `report.md`, `sources.md`, `README.md` to the output directory |
| `complete` | — | Return report metadata (`met` reflects whether the report was actually written) |
| `unknown` / `awaiting_clarification` | — | Escalation seam (see below) |
| `error` | — | Terminal failure |

`researching` is a single Echo agent instructed to research every sub-query; there is no per-sub-query fan-out and no separate validation state (Vera is not invoked — that state was removed from the workflow). Echo's toolset for this state is `web_search`, `web_fetch`, and `youtube_transcript` (per `.pi/agents/echo.md`); the domain prompt (`assets/prompts/echo.md`) requires a YouTube-targeted search per sub-query and a transcript pull on relevant hits.

### Escalation and resilience

Escalatable states: `planning`, `critiquing_plan`, `researching`, `synthesizing`, `critiquing_report`.

An agent that emits `needs_clarification` (or `confidence=UNCERTAIN`), a `plan_complete`/`explore_complete`/`synthesis_complete` of `false`, or a critique loop that stalls (the same issues persisting across revisions) drives the machine `→ unknown → awaiting_clarification` and pauses the run. `progress_check` decides this; it is the engine's HITL seam.

The user's answer resumes the SAME run (keyed by `run_id`) via a `user` step; the clarification text is carried into the next task through `ctx`. Resume re-enters at `planning` (a quick-mode resume passes through planning, which then routes straight on to researching). No state blob is threaded on the wire — `previous_state` lives in `ctx` and is checkpointed.

Summary validation is the engine's job (`contracts.py` `validate_summary_contract`), not a per-skill helper. Empty or malformed summaries are rejected and the run does not advance on fabricated defaults.

### Credibility framework

| Tier | Name | Examples |
|------|------|----------|
| T1 | Primary / Authoritative | Official docs, RFCs, arXiv papers, specs |
| T2 | Expert / Established | ACM Queue, official blogs, recognized experts, official vendor YouTube channels, recorded conference talks |
| T3 | Community / Practitioner | High-vote Stack Overflow, dev.to, tutorials, established practitioner YouTube channels |
| T4 | Unverified / Commercial | Product pages, SEO content, unknown blogs, unverified/low-authority YouTube channels |

Video transcripts are tiered by publisher/channel authority, exactly like written sources — the medium (video vs. text) does not change the tier.

Confidence markers used in the report:

| Marker | Meaning |
|--------|---------|
| ✅ High | Multiple authoritative sources agree |
| ⚠️ Medium | Some credible support |
| ❓ Low | Thin or lower-tier evidence |
| ⚡ Conflicting | Sources disagree |

### Deep-mode quality gates

1. **Plan critique** — Carren reviews Piper's sub-query plan before dispatch.
2. **Report critique** — Carren reviews Synthia's final report for overclaiming, bias, and fairness to conflicting evidence.
3. **Conflict resolution** — Uses a 5-step hierarchy: tier authority → recency → consensus → context match → escalation.

### Mempalace room organization

Room: `skills/research-<session_id>`

| Drawer | Content |
|--------|---------|
| `<sid> Planner` | Sub-queries, scope, rationale (piper) |
| `<sid>-echo-<n> Research Findings` | Tiered, cited findings for sub-query N (echo) |
| `<sid> Synthesis` | Synthesized thematic report (synthia) |
| `<sid> Critique` | Plan and report critique verdicts (carren, deep mode) |
| `<sid> Report Files` | Written report files (skribble) |

Run state is not stored in mempalace — it lives in the engine's durable checkpointer.

## Constraints

| Mode | Max sub-queries |
|------|-----------------|
| Quick | 1 |
| Standard | 3 |
| Deep | 4 |

- `max_sub_queries` is enforced at dispatch: the plan is truncated to the cap before researching.
- Malformed or empty agent summaries are rejected by the engine (no fabricated defaults; the run does not advance).
- Critique revise loops are bounded by `ctx.max_iterations` and report exhaustion honestly.
- Crash-resume is automatic via the engine checkpointer keyed by `run_id`.

## Verification

- [ ] Report includes executive summary, key findings, source count/quality, recommendations, and constraints.
- [ ] Every key finding has a confidence marker.
- [ ] Conflicting evidence is reported, not smoothed over.
- [ ] Sources are classified T1–T4.
- [ ] Deep mode includes both plan critique and report critique.

## Files

| File | Purpose |
|------|---------|
| `apps/orchestration/src/orchestration/playbooks/research.py` | `ResearchPlaybook` — states, SUMMARY contracts, routing, escalation |
| `apps/orchestration/tests/test_research_playbook.py` | Playbook tests |
| `.pi/skills/research/SKILL.md` | Skill definition and invocation (`metadata.penny.engine: orchestration`) |
| `.pi/skills/research/scripts/orchestrate.py` | ~5-line delegate into `orchestration.cli` |
| `.pi/skills/research/assets/prompts/*.md` | Agent domain prompts and SUMMARY blocks |
| `docs/humans/capabilities/research-skill/research-skill.md` | Human-facing overview |
