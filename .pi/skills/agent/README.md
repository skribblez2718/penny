# Agent Skill

Generate Penny agent definitions (`.pi/agents/<name>.md`) using a structured 7-state workflow with deep parallelism.

## Overview

- **Purpose**: Automate agent definition creation from a goal description
- **Use When**: New agent needed, standalone or as sub-skill
- **Outcome**: Validated agent definition file

## State Machine

```
intake → exploring → designing → critiquing → scaffolding → verifying → complete
         ↑______________|        ↓
         (critique fail          (verify fail
          → revise)               → re-scaffold)
```

## Subagents Used

| Agent    | Purpose                 | Prompt File |
| -------- | ----------------------- | ----------- |
| echo     | Explore agent patterns  | echo.md     |
| vera     | Verify generated file   | vera.md     |
| piper    | Design agent definition | piper.md    |
| carren   | Critique design         | carren.md   |
| skribble | Generate agent file     | skribble.md |

## Mempalace Integration

- Session room: `skills/agent-<session_id>`
- Full findings written to mempalace
- Orchestrator receives SUMMARY only

## Files

| File                     | Purpose             |
| ------------------------ | ------------------- |
| `scripts/orchestrate.py` | State machine       |
| `assets/prompts/*.md`    | Domain Guidance     |
| `resources/reference.md` | Technical reference |
| `resources/flow.mmd`     | State diagram       |

## Usage

```bash
cd .pi/skills/agent
python3 scripts/orchestrate.py start --session-id test-001 --goal "research agent for climate data"
```

## Testing

```bash
cd .pi/skills/agent
pytest tests/test_unit.py tests/test_integration.py -v
```

## Version History

- **1.0.0** - Initial release with parallel explore/design/critique
