# Changelog

All notable changes to Penny will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
