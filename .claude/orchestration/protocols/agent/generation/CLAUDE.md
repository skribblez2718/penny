# Generation Agent

**Cognitive Function:** GENERATION
**Purpose:** Create artifacts using domain-appropriate creation cycles (TDD for code)

## Step Execution Flow

```
entry.py → step_0 → step_1 → step_2 → step_3 → step_4 → step_5 → complete.py
           │        │        │        │        │        │
           │        │        │        │        │        └→ output_preparation
           │        │        │        │        └→ quality_checks
           │        │        │        └→ artifact_generation
           │        │        └→ creation_cycle
           │        └→ context_extraction
           └→ learning_injection
```

## Steps (from config.py)

| Step | Name | Purpose |
|------|------|---------|
| 0 | `learning_injection` | Load generation-specific learnings from .claude/learnings/generation/ |
| 1 | `context_extraction` | Extract specifications from synthesis, understand what to build |
| 2 | `creation_cycle` | Define creation approach (TDD for code: RED-GREEN-REFACTOR) |
| 3 | `artifact_generation` | Generate artifacts: code, docs, configs, tests |
| 4 | `quality_checks` | Self-verify artifacts against specifications |
| 5 | `output_preparation` | Prepare output for validation agent |

## When Invoked

- Generation phase of composite skills (after synthesis)
- When specifications are ready for artifact creation
- Via `orchestrate-generation` atomic skill
- Via Task tool: `subagent_type: "generation"`

## Files

```
generation/
├── entry.py      # → agent_entry("generation")
├── complete.py   # → agent_complete("generation")
├── content/
│   └── step_{0-5}.md   # Markdown instructions per step
└── steps/
    └── step_{n}_{name}.py  # Step implementations
```

## Context Budget

- **Max Input:** 4000 tokens
- **Max Output:** 8000 tokens (highest - produces code)
- **Priority Sections:** specification, design, constraints

## Output

Memory file: `.claude/memory/{task_id}-generation-memory.md`

Contains:
- Generated artifacts (code, docs, configs)
- Test files created
- TDD cycle documentation (if applicable)
- Self-verification results
- File paths of created artifacts

## TDD Cycle (for code generation)

```
RED:    Write failing test first
GREEN:  Implement minimum code to pass test
REFACTOR: Clean up while keeping tests passing
```

## Key Tools Used

- `Write` - Create new files
- `Edit` - Modify existing files
- `Read` - Understand existing code patterns
- `Bash` - Run tests, build commands
