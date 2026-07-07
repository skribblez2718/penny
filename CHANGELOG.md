# Changelog

All notable changes to Penny will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
