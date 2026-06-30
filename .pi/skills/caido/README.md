# Caido Skill

Guided workflow for creating any Caido extension — backend plugins, frontend pages, full-stack plugins, and workflows.

## Architecture

```
.pi/skills/caido/
├── SKILL.md              # Skill definition + 6-phase workflow
├── README.md             # This file
├── requirements.txt      # Python deps for orchestrator
├── assets/               # Static assets (templates, icons)
├── resources/
│   └── reference.md      # Constraints, API patterns, testing patterns, reference docs
├── scripts/
│   └── orchestrate.py    # State machine orchestrator (TODO)
├── prompts/
│   ├── explore.md        # Echo: research extension type (TODO)
│   ├── design.md         # Piper: design architecture (TODO)
│   ├── scaffold.md       # Codee: scaffold project (TODO)
│   ├── implement.md      # Codee: implement with constraints (TODO)
│   ├── test.md           # Codee: TDD with Caido mocks (TODO)
│   └── build.md          # Codee: build and verify (TODO)
└── tests/                # Skill tests (TODO)
```

## Design

The skill injects `resources/reference.md` as `skillContext` into every agent. This ensures all 10 hard constraints are enforced during implementation — agents cannot repeat the mistakes learned during the header-injector development session.

### Why a skill instead of documentation?
Agents don't read documentation unless explicitly told. A skill makes constraints part of the agent's system prompt, preventing known failure patterns before they happen.

### Extension Type Coverage
The workflow adapts based on what the user is building:
- **Backend-only**: Phases 1-4 (skip frontend scaffolding), test + build
- **Frontend-only**: Phases 1-4 (skip backend), test + build
- **Full-stack**: All 6 phases
- **Workflow**: EXPLORE → DESIGN → SCAFFOLD (workflow JSON) → IMPLEMENT → BUILD (skip TEST for now)

## Status

| Component | Status |
|-----------|--------|
| SKILL.md | ✅ |
| README.md | ✅ |
| resources/reference.md | ✅ |
| requirements.txt | ✅ |
| scripts/orchestrate.py | ✅ |
| prompts/*.md | ✅ |
| tests/ | ✅ |
