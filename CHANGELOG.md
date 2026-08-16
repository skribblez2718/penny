# Changelog

All notable changes to Penny will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Removed

- **Self-Improvement Loop, Ambient Watchers, Weekly Digest, Prompt Efficacy, and
  Judgment Calibration — removed in full.** Penny's improvement work is driven by
  the `.pi/prompts/*-audit` prompt family from here on: simpler, more reliable, and
  fully under operator control. Removed, with all code, tests, config, cron wiring,
  and documentation:
  - **Self-Improvement Loop** — the outcome ledger (`scripts/system/outcome_ledger/`,
    `penny/outcomes`, `make rate`, judge-backed auto-capture), the compression loop
    (`scripts/system/self_improve/`), the amendment lifecycle (propose / review /
    approve / apply, `penny/system_amendments`, `make review`), the trust and
    graduated-autonomy gate (`scripts/system/autonomy/`, `PENNY_AUTONOMY_GATE`,
    `BasePlaybook.AUTONOMY_STATES`), the orchestration outcome writer
    (`orchestration/outcome_writer.py`), and the `/tune` prompt with `make tune`
    and `make tune-deep`.
  - **Ambient Watchers** — `scripts/system/watchers/`, signal generation and the
    `penny/signals` room, the session-start checker and the `.penny/SESSION_BRIEF.md`
    session-memory injection, the `memory_acknowledge_signal` and
    `observability_query_watcher_logs` tools, watcher logs (endpoints, models, and
    the `watcher_logs` table — dropped by a new observability **v5 → v6** migration,
    so existing databases migrate forward cleanly), and the ambient cron. The
    tiered-memory archiver, previously scheduled by that cron, keeps its schedule
    via `scripts/system/tiered_memory/archiver_cron.sh`.
  - **Weekly Digest** — `scripts/system/digest/` and the `penny/digests` room.
  - **Prompt Efficacy** — the frame-on/frame-off A/B matrix and its runner, golden
    prompt tasks, the hybrid grader and judge calibration, and
    `make evals-prompt-efficacy`.
  - **Judgment Calibration** — `scripts/system/judgment/`, the judge-agreement
    harness, rubrics, calibration corpus, and `make judge-agreement`.

  The four MemPalace rooms these features owned (`penny/outcomes`, `penny/signals`,
  `penny/digests`, `penny/system_amendments`) were purged, and every agent- and
  skill-facing directive that instructed writes to them was removed.

  **Behavior changes worth noting:** the orchestration engine no longer writes a
  terminal outcome record per run, so the code skill's P0 completion contract no
  longer includes the "canonical terminal outcome persisted before publication"
  condition; and no session-memory brief is injected at session start (the diary
  itself and its tools are unaffected). Retained and unchanged: the behavioral
  ratchet / trajectory eval, the remaining eval sections (compat, invariants,
  retrieval, trajectory), tiered memory, MemPalace and the knowledge graph, the
  observability server, and all skills and agents.

### Changed

- **Track-A recovery is forward-only.** The retired semantic workflow transport is
  never a rollback path. Execution owners can set
  `PENNY_ARTIFACT_DISPATCH_MODE=active|paused` (default `active`; unknown values
  fail closed). Paused mode returns a typed non-terminal/retriable result before
  any new agent, deterministic-tool, or fan-out dispatch; it preserves the running
  checkpoint and selected artifact refs while status and exact artifact reads stay
  available. A fresh-process recover after reactivation reissues the identical
  pending state/input refs/output metadata (or the next explicit compatible
  revision), with no semantic rooms, memory-service fallback, or payload injection.

### Added

- **MemPalace 3.7.1 and exact artifact-plane migration.** Workflow handoff no
  longer depends on semantic memory rooms. The execution owner persists exact
  agent output in a separate immutable content-addressed store before SUMMARY
  acceptance; result protocol v2, execution receipts, stale-safe selection,
  parallel branch refs, bounded `artifact_read`, direct/skill chain refs, and
  compaction `run:`/`artifact:` recovery keep workflows memory-independent.
  Durable recall now uses one pinned, supervised MemPalace 3.7.1 HTTP hub through
  the versioned `platform-memory` contract, with role-scoped tools, primary-only
  diary hooks, governed KG predicates, typed failure, and hard final-envelope
  byte/token budgets with exact continuation. Raw production peers are retired;
  copied/offline recovery is receipt-gated. Added lossless export/reconciliation/
  disposition tools plus shadow, accepted-write journal, canary, replay, and
  rollback tooling. Setup, cleanup, and uninstall preserve memory data. New hub
  deployments remain read-only by default until an owner-approved journaled
  canary and exact reconciliation pass; replay incompatibility fails closed into
  the no-downgrade forward-recovery branch. Setup and package installation never
  perform a cutover automatically.

- **derivation skill — Tier-1.5 compression-distance signal (`ncd.py`).** A new
  deterministic tier between the existing n-gram prefilter (Tier-1) and the
  rubric-based review (Tier-2), computing Normalized Compression Distance
  `NCD(x,y) = (C(xy) - min(C(x),C(y))) / max(C(x),C(y))` between authored content
  and every source in the corpus, flagging outliers against the corpus's own
  median/MAD distribution rather than an absolute threshold. Stdlib-only
  (`lzma`/`zlib`), no network, no new dependencies. It is a **tripwire, never a
  verdict, and never exculpatory**: an unusually low distance means "read that
  source closely in Tier-2" and can strengthen a rubric-based DERIVATIVE*RISK
  case but never establish one, while a high or unflagged distance is \_not*
  evidence of independence — structure, selection, and paraphrase dependence
  survive compression distance untouched. Below a 1000-token floor (or fewer
  than 4 corpus sources) no number-based signal is emitted at all
  (`valid: false`), so a thin corpus cannot manufacture false confidence.
  `SKILL.md` 1.1.0 → 1.2.0 (phase 2 becomes three tiers); `rubric.md` states D7
  information-theoretically and records that the signal is evidence _for_ the
  originality question, not an answer _to_ it. The Tier-1 `prefilter.py` is
  deliberately byte-stable — an empty diff is a regression gate, since the two
  tiers must stay independently interpretable. Test suite 34 → 40.

- **imagegen skill (v1)** — local image generation over the self-hosted ComfyUI
  HTTP API (`127.0.0.1:8188`) as a `BasePlaybook` FSM (framing → composing →
  generating → critiquing → [adjusting → generating]\* → presenting). Routes each
  request across 4 shipped presets (`blog-flux-steampunk`, `learning-qwen`,
  `hero-flux`, `general-flux`) via a deterministic `route_preset` heuristic,
  fails fast in a readiness check (unreachable ComfyUI / missing required
  checkpoint → actionable error; missing optional steampunk LoRA → WARN + base
  FLUX fallback), composes wordless prompts (raw-override passthrough, 4000-char
  cap), generates candidates **one at a time** with a provenance `manifest.json`
  (byte-identical-graph reproduction), runs a vera+carren parallel critique
  (NEEDS_REVISION if either flags), iterates a bounded revise loop
  (`max_iterations` default 2, regenerating only the failed candidates) with
  honest exhaustion (`met=False` + itemized unresolved issues, never a fabricated
  APPROVE), and emits a dual-format (human + machine) result. New
  `ImagegenPlaybook` registered additively in `playbooks/__init__.py`; skill dir
  at `.pi/skills/imagegen/` ships a hardened stdlib-only `comfy_http` client
  (loopback SSRF allow-list + redirect refusal, `/view` path-traversal guards,
  dict-built `/prompt` payloads) and a provenance-aware `comfy-generate.py` CLI.
  Full pytest suite (`test_imagegen_playbook.py`, `test_comfy_http.py`,
  `test_comfy_generate.py`) runs with zero live-service dependency; a live smoke
  test stays opt-in behind `PENNY_IMAGEGEN_LIVE=1`.

### Fixed

- **MemPalace SIGSEGV — real root cause found and fixed; the "corrupted palace"
  story was wrong.** The memory bridge had been dying with `SIGSEGV` every week
  or two for months. The error it printed blamed a corrupted index or an
  incompatible ChromaDB version and prescribed `repair_palace.py`. All of that
  was wrong, and the prescribed rebuild is what kept the failure alive.

  What was actually happening: the bridge runs as a **fresh process per memory
  call**, and ChromaDB only compacts its vector write-ahead log after
  `sync_threshold` (stock default **1000**) operations accumulate _within one
  process_. A per-call process performs a handful of writes and exits, so the
  threshold was never reached — the vector index never flushed, the WAL grew
  without bound, and every call replayed the entire backlog on startup. Once
  that backlog contained a bulk-DELETE burst followed by ADDs, the replay tripped
  a NULL-pointer dereference inside `chromadb_rust_bindings` (upstream defect,
  present in 1.5.9 — the latest published release; there is no version to
  upgrade to). The process then died on **reads and writes alike**, wedging the
  palace: the WAL could not drain, because the replay that would drain it was
  what crashed. `repair_palace.py` cleared the backlog and rebuilt the
  collection **with stock defaults**, which re-armed the identical failure —
  hence the 1-2 week cycle.

  Measured on the live palace, repeating trials on byte-identical input (which
  also rules out corruption — corrupt data fails deterministically):

  | WAL backlog | crashes |
  | ----------- | ------- |
  | 0           | 0/8     |
  | 142         | 0/5     |
  | 162         | 4/4     |
  | 218         | 5/5     |

  Changes:
  - **`memory_bridge.py`** — new `HNSW_TUNING` (`sync_threshold=64`,
    `batch_size=32`) applied when the collection is created, keeping the WAL far
    below the measured crash range. Must be set at creation: ChromaDB accepts
    `collection.modify()` for these keys and persists them, then ignores them
    (verified), so an existing collection can only be fixed by a rebuild.
  - **`palace_doctor.py`** (new) — reports what is _actually_ wrong: WAL backlog,
    segment drift, and whether bounded-WAL config is active. Opens sqlite
    read-only and never imports chromadb, so it stays alive on a palace that is
    actively segfaulting.
  - **`repair_palace.py`** — rebuilds **with** the bounded-WAL settings and
    verifies they persisted, refusing to swap in a palace that would re-accumulate
    an unbounded WAL. Reframed from routine remedy to one-time migration /
    break-glass, with the diagnosis to run first.
  - **`.pi/extensions/memory/index.ts`** — the crash message no longer asserts a
    cause it cannot know. It names the actual signal, states that retrying will
    not help, and reports the doctor's measured findings.

  Verified: live palace migrated (7082 drawers preserved) and now reports
  healthy; 40 queries under the exact delete→add workload that previously
  crashed 7/8 now crash **0/40**, with the WAL peaking at 61 instead of growing
  without bound; full memory suite green (59 unit + 43 integration + 22 bridge).

  Known remaining risk, unaddressed by design: the bridge takes **no lock**, so
  parallel subagents can run several writer processes against one palace
  directory. Concurrency was tested and was _not_ the cause here, so serializing
  it (or moving to a long-lived bridge daemon) is left as a separate decision
  rather than folded into this fix.

- **Compaction goal-recency regression.** The custom compaction extension
  (`.pi/extensions/compaction/`) now guarantees the post-compaction `## Goal`
  reflects the **latest** substantive user intent, not a stale first-seen one.
  The oldest-first message scan and its keyword denylist are removed in favor of
  a newest-first scan over the merged `[messagesToSummarize, turnPrefixMessages]`
  window, so split-turn compactions no longer drop intent. A **completed** skill
  whose goal is displaced by a later ad-hoc user message is now flagged
  `dominant_skill.superseded` and stops setting `## Goal`. Goal selection follows
  one canonical precedence (incomplete active skill → engine-run → newest
  substantive user message → previousSummary carry-forward → system → default)
  with no reason-keyed code fork.

### Added

- **Compaction artifact schema 2.1.0** (additive over 2.0.0 — every new field is
  optional, so 2.0.0-shaped artifacts still validate). New: `dominant_skill.superseded`;
  top-level `current_work` / `next_steps` (rendered as `## Current Work` /
  `## Next Steps` when derivable); `metadata.pi_boundary.boundary_shift` now
  populated on every compaction after a session's first (sourced from
  `branchEntries`' prior `firstKeptEntryId`); `metadata.compaction_reason` /
  `metadata.custom_instructions` (the named sink for Pi's `event.reason` /
  `event.customInstructions`); and `metadata.goal_streak`.
- **Fix A (default): deterministic previousSummary Goal carry-forward** — a pure
  parse of the prior `## Goal`, no subprocess/network/LLM call. **Fix B (opt-in,
  `PI_COMPACTION_FIXB_ENABLED`): LLM-assisted merge** — OFF by default, reuses the
  existing env provider/auth plumbing (no new secret storage), `AbortSignal`-wired
  with a soft timeout, and always falls back to Fix A on disable/misconfig/timeout/
  abort/error (never mandatory, never abandons the summary).
- **Goal-stagnation regression canary** — logs (never mutates) when the goal is
  byte-identical across ≥3 consecutive compactions.

## [0.3.0] - 2026-07-09

### Added

- **Research skill independent verifier.** A `validating` state (agent `vera`, a
  different model from the generators) runs in all three research modes as an
  evidence-based citation-grounding gate before `report_writing` — verifying
  every material claim traces to a cited source. A FAIL triggers a bounded
  re-grounding loop; honest exhaustion still ships the report with the
  unverified claims surfaced; a stall escalates. Restores the
  independent-verifier invariant the engine port had dropped.
- **MemPalace room schema, retention manifest, and cleanup tooling.**
  - `scripts/system/tiered_memory/skill_rooms.json` — single source of truth for
    per-skill scratch retention. The archiver loads it, `scaffold-skill.py`
    appends every new skill to it, and `check_skill_structure.py` fails if a live
    skill is unregistered (the guard against silent re-accretion).
  - `docs/agents/memory/schema.md` — canonical wing/room conventions + tiered
    retention policy.
  - `scripts/system/maintenance/mempalace_audit.py` (read-only inventory +
    categorized candidate manifest) and `mempalace_cleanup.py` (dry-run by
    default; `--execute` cold-archives each drawer to JSONL before deleting).
- `plans/deferred-work/` — organized deferred-work backlog migrated from the
  retired root `TODO.md`.

### Changed

- **Orchestration engine migration COMPLETE.** All seven workflow skills
  (`code`, `plan`, `prd`, `research`, `agent`, `sca`, `jsa`) now run on the shared
  `orchestration` engine as `BasePlaybook` subclasses with ~5-line delegate
  `orchestrate.py` files; run state lives in a durable `run_id`-keyed SQLite
  checkpointer (no `--state` argv, no `/tmp` state files). `rez` remains a
  placeholder pending its own build.
- **Self-improvement: approval-gated auto-apply.** An APPROVED amendment now
  applies to ANY target file — including SYSTEM.md — because reviewing and
  approving the exact diff IS the human-in-the-loop. Guardrails: a concrete
  `old_text`/`new_text` diff is required (empty diffs refused at both approve and
  apply), apply is verbatim + drift-safe, and the immutable security-directives
  block (`<system_directives>` / `<system_boundary>`) stays human-only even with
  approval. `reject` now works from APPROVED (previously a PENDING-only
  dead-end), and `show` renders the proposed diff. The auto-generator stays
  conservative (universal-frame learnings → `REJECTED_UNIVERSAL`, never
  auto-proposed).
- **Tiered archiver: dedicated-wing decay.** Loads per-skill rules from the new
  manifest; `wing_jsa` / `wing_sca` per-session scratch now decays (T2, 30d)
  while curated `*-learnings` rooms are kept permanently (T3) — closing the
  accretion gap where those wings were retained forever.
- **Documentation restructured into a strict tree of indexes.** The root
  `AGENTS.md` now points only to the two next-level sub-indexes
  (`docs/agents/AGENTS.md`, `docs/penny/AGENTS.md`); each `AGENTS.md` links only
  one level down. The duplicate `observability-server` doc trees were merged into
  the canonical copy, and the `docs/humans/` no-`AGENTS.md` policy is documented
  and machine-enforced by `check_agents_links.py`.
- **`word` / `powerpoint` extensions** default output to the OS temp dir
  (`…/penny/{word,powerpoint}/`) instead of `<project>/output/` — generated
  artifacts no longer land in the project tree when no path is given.

### Removed

- **`docs/agents/orchestration/DEPRECATIONS.md`** and the deprecation-ledger
  practice — documentation now reflects current state only (a standing rule was
  added to `docs/agents/documentation/agents-md-standard.md`).
- **Root `TODO.md`** — migrated to `plans/deferred-work/`.
- **MemPalace cleanup: ~2,110 drawers removed (74% reduction).** Transient JSA
  scan scratch, 5.5 MB of raw session-transcript blobs, a defunct `hackerone`
  skill's data, stray agent-name wings, and test artifacts — all cold-archived
  to JSONL first. Curated knowledge (`*-learnings`, decisions, architecture,
  diary) was preserved.
- **4 stale self-improvement amendments** (`RULE_001`–`RULE_004`) rejected —
  legacy hand-authored proposals with empty diffs targeting a taxonomy the loop
  no longer emits.

### Fixed

- **Research validation regression** — the removed Vera VALIDATE pass is restored
  (see Added).
- **Amendment lifecycle dead-end** — an APPROVED-but-unappliable amendment had no
  terminal exit and re-surfaced in every session brief indefinitely; `reject`
  from APPROVED now clears it, and `approve` refuses non-concrete diffs up front.
- **Stray `/output` directory** — traced to the `word`/`powerpoint` extensions
  writing into the project tree; removed the directory and fixed the default.
- **Statusline README example** generalized to `<model>` / `<project-dir>` /
  `<n>` placeholders (was a stale hardcoded model name).

## [0.2.0] - 2026-07-05

### Changed

- **Orchestration engine generalized into the single execution substrate.** The
  `orchestration` package (`apps/orchestration`) is now the shared runtime every
  engine-backed domain skill subclasses `BasePlaybook` onto, with custom-named
  states. New engine seams:
  - **Per-state SUMMARY contracts** (`spec.summary_contract`) — each state
    validates its agent's SUMMARY and fails loud on missing/mistyped fields.
  - **Parallel fan-out** (`PARALLEL_BY_STATE` + `ParallelSpec`) — a state
    dispatches N branch agents and routes once on fan-in, aggregating by weakest
    branch confidence.
  - **Planned-gate HITL** (`GATE_STATES` + `gate_questions`/`route_user`) — a
    declared pause for a user decision with multi-way resume, distinct from the
    `UNCERTAIN`-confidence escalation path.
  - A domain **`extras`** dict on `RunContext`, a **fail-loud `from_dict`**
    (rejects unknown checkpoint keys), and a **`start()` precondition guard**.
- **`code` skill migrated onto the engine as the pilot** — its `orchestrate.py`
  is now a thin delegate; the FSM lives as a `BasePlaybook` subclass at
  `apps/orchestration/src/orchestration/playbooks/code.py`. Other skills
  (`research`, `plan`, `prd`, `agent`, `jsa`, `sca`, `rez`) still run their own
  `orchestrate.py` and migrate later.

### Removed

- **Composable-skills model dropped.** Agents are reasoning specialists composed
  via the `subagent` tool — not "operation primitives." Removed the
  `.pi/skills/{observe,frame,act,verify,learn}` primitive-skill wrappers, the
  `reference-cycle` skill, and the `caido` skill. `StandardCyclePlaybook` /
  `standard_cycle.py` / `primitive_cycle.py` collapsed into a single internal
  engine test fixture (`playbooks/reference_cycle.py`, registered only under
  `reference-cycle` for engine tests — not a user-facing skill).
- The **`caido` extension** (`.pi/extensions/caido`) and its `caido_*` tools are
  **kept** — the `jsa` skill still uses them.

## [0.1.0] - 2026-04-08

### Added

#### Core Extensions

- **Memory Extension** - 19 MemPalace tools for persistent AI memory
  - Palace read tools: status, list_wings, list_rooms, get_taxonomy, search, check_duplicate, get_aaak_spec
  - Palace write tools: add_drawer, delete_drawer
  - Knowledge graph tools: kg_query, kg_add, kg_invalidate, kg_timeline, kg_stats
  - Navigation tools: traverse, find_tunnels, graph_stats
  - Agent diary tools: diary_write, diary_read
  - ChromaDB vector storage + SQLite knowledge graph
  - Python bridge for MemPalace library integration

- **Environment Extension** - Environment variable substitution
  - Loads `.env` into `process.env`
  - Substitutes `${VAR}` in AGENTS.md and SYSTEM.md
  - Auto-derives PROJECT_ROOT

- **Observability Extension** - WebSocket observability client
  - Session lifecycle tracking
  - Message capture and filtering
  - Tool execution monitoring
  - Model change tracking
  - Auto-reconnection with exponential backoff

- **Search Extension** - Web search via Ollama API
  - `web_search` tool for finding information
  - `web_fetch` tool for fetching URLs
  - Configurable result limits

- **Statusline Extension** - TUI footer with context tracking
  - Model and directory display
  - Skills/extensions count
  - Context usage bar with color gradient

- **Subagent Extension** - Delegate tasks to specialized agents
  - Single, parallel, and chain modes
  - Isolated context windows via child process spawning
  - Usage tracking and progress reporting

### Infrastructure

- Comprehensive test suite with Vitest
  - Unit tests in `tests/unit/`
  - Integration tests in `tests/integration/`
  - E2E tests scaffolded in `tests/e2e/`
- Testing standards documented in `.pi/extensions/AGENTS.md`
- Extension README.md files with architecture diagrams
- `.gitignore` for common patterns (node_modules, .env, .venv, .mempalace)
- `.env.example` template for required environment variables
- LICENSE (MIT)

### Project Structure

```
penny/
├── .pi/
│   ├── extensions/        # 6 extensions
│   │   ├── environment/
│   │   ├── memory/
│   │   ├── observability/
│   │   ├── search/
│   │   ├── statusline/
│   │   └── subagent/
│   ├── skills/
│   └── prompts/
├── .mempalace/            # MemPalace storage (gitignored)
├── .venv/                 # Python virtual environment (gitignored)
├── AGENTS.md              # Project context for Pi
├── entities.json          # MemPalace entity codes
└── scripts/               # Utility scripts
    ├── system/            # Runtime scripts, QA checks, system automation
    │   ├── checks/        # QA automation (check_compliance, check_links, check_token_budget)
    │   ├── digest/        # Weekly digest generator
    │   ├── outcome_ledger/# Persistent action/outcome records
    │   ├── self_improve/  # Behavioral learning loop
    │   ├── tiered_memory/ # TTL sweeps, age-based archival
    │   └── watchers/      # Ambient signal generation
    └── setup/             # One-time setup scripts (mempalace init, env bootstrap)
```
