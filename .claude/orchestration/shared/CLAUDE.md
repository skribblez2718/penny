# Shared Content

Reusable markdown content snippets included by agents and skills. Provides standardized patterns and protocols for consistent behavior across the system.

## Directory Structure

```
shared/
├── CLAUDE.md              # THIS FILE
├── __init__.py            # Module init with load_shared_content()
│
├── agents/                # Agent-specific patterns
│   ├── protocols/         # Agent execution protocols
│   │   ├── error-handling.md      # Error handling patterns
│   │   ├── communication.md       # Inter-agent context passing
│   │   ├── learning.md            # Learning injection at Step 0
│   │   ├── memory.md              # Memory file format and creation
│   │   └── unknowns.md            # Unknown tracking format
│   ├── gates/             # Quality gates
│   │   └── gates.md               # Quality gate definitions
│   └── format/            # Output formatting
│       └── output.md              # Standard output structure
│
├── protocols/             # Cross-cutting protocols
│   └── johari.md                  # Johari Window Discovery (SHARE/ASK/ACK/EXPLORE)
│
├── format/                # General formatting
│   └── johari.md                  # Johari output format specification
│
├── context/               # Context management
│   ├── loading/           # Context loading patterns
│   │   ├── checklist.md           # Orchestrator verification checklist
│   │   └── patterns/              # Specific patterns
│   │       ├── workflow.md            # Workflow-only pattern
│   │       ├── immediate-predecessors.md   # Immediate predecessor pattern
│   │       ├── multiple-predecessors.md    # Multiple predecessors pattern
│   │       └── verification.md        # Compliance verification
│   └── pruning/           # Token efficiency
│       ├── implementation.md      # Implementation methods
│       ├── levels.md              # Pruning level definitions
│       └── compression/           # Compression specifics
│           ├── levels.md              # Compression level definitions
│           └── techniques.md          # Compression techniques
│
└── skills/                # Skill-specific patterns
    └── code-generation/   # Shared across coding skills
        ├── tdd.md                 # TDD methodology (RED-GREEN-REFACTOR)
        ├── security.md            # Security best practices
        ├── error-handling.md      # Error handling in code
        ├── structure-patterns.md  # Code organization patterns
        └── python-setup.md        # Python project structure
```

## Content Categories

### agents/protocols/

Patterns for agent execution and communication.

| File | Purpose | Used By |
|------|---------|---------|
| `memory.md` | How to write memory files | All agents at complete.py |
| `communication.md` | Context passing patterns | All agents |
| `learning.md` | How Step 0 loads learnings | All agents (Step 0) |
| `error-handling.md` | Error handling patterns | All agents |
| `unknowns.md` | Unknown tracking format | clarification |

### agents/gates/

| File | Purpose | Used By |
|------|---------|---------|
| `gates.md` | Quality criteria definitions | validation |

### agents/format/

| File | Purpose | Used By |
|------|---------|---------|
| `output.md` | Standard output format | All agents |

### protocols/

Cross-cutting protocols used by multiple subsystems.

| File | Purpose | Used By |
|------|---------|---------|
| `johari.md` | SHARE/ASK/ACKNOWLEDGE/EXPLORE framework | All agents (Step 1), Reasoning Step 0 |

### format/

| File | Purpose | Used By |
|------|---------|---------|
| `johari.md` | Johari Window output formatting | clarification |

### context/loading/

Patterns for loading context from predecessors.

| File | Purpose | When Used |
|------|---------|-----------|
| `checklist.md` | Verification checklist | Skill orchestration |
| `patterns/workflow.md` | Load only workflow context | First phase of skill |
| `patterns/immediate-predecessors.md` | Load immediate predecessor | Sequential phases |
| `patterns/multiple-predecessors.md` | Load multiple predecessors | Synthesis phases |
| `patterns/verification.md` | Compliance checking | Validation phases |

### context/pruning/

Patterns for token efficiency and context management.

| File | Purpose | When Applied |
|------|---------|--------------|
| `implementation.md` | Implementation approaches | Agent budgets |
| `levels.md` | Pruning thresholds | Context budget enforcement |
| `compression/levels.md` | Define compression levels | Long context scenarios |
| `compression/techniques.md` | Compression methods | Context loading |

### skills/code-generation/

Patterns for code creation shared across coding skills.

| File | Purpose | Used By |
|------|---------|---------|
| `tdd.md` | RED-GREEN-REFACTOR methodology | generation |
| `security.md` | Security best practices | generation, validation |
| `error-handling.md` | Error handling in code | generation |
| `structure-patterns.md` | Code organization patterns | generation |
| `python-setup.md` | Python project structure | generation |

## Usage Pattern

```python
from shared import load_shared_content

# Load content by relative path within shared/
johari_protocol = load_shared_content("protocols/johari.md")
memory_protocol = load_shared_content("agents/protocols/memory.md")
tdd_protocol = load_shared_content("skills/code-generation/tdd.md")
```

## Key Shared Patterns

### Johari Discovery Protocol (protocols/johari.md)

```
SHARE/ASK/ACKNOWLEDGE/EXPLORE Framework:

1. SHARE: What I can infer from the prompt
2. ASK: What I need to know (MAX 5 questions, only if critical)
3. ACKNOWLEDGE: Boundaries and assumptions
4. EXPLORE: Unknown unknowns to consider

CRITICAL RULE: If ANY clarifying questions exist, HALT and ask.
```

### Memory File Format (agents/protocols/memory.md)

```markdown
# {Agent Name} Memory
Task: {task_id}
Skill: {skill_name} Phase: {phase_id}

## Step 0: learning_injection
{Step 0 output}

## Step 1: {step_name}
{Step 1 output}
...
---
**{AGENT_NAME}_COMPLETE**
```

### TDD Protocol (skills/code-generation/tdd.md)

```
RED-GREEN-REFACTOR Cycle:
1. RED: Write failing test first
2. GREEN: Write minimum code to pass
3. REFACTOR: Improve code while tests pass
```

## Critical Invariants

```
⚠️  INVARIANTS - VIOLATING THESE BREAKS THE SYSTEM

1. Memory file format must be consistent
   └→ All agents use agents/protocols/memory.md format

2. TDD protocol is mandatory for generation
   └→ generation always follows skills/code-generation/tdd.md

3. Context loading patterns are phase-specific
   └→ First phase: context/loading/patterns/workflow.md
   └→ Synthesis phases: context/loading/patterns/multiple-predecessors.md

4. Johari Discovery Protocol is mandatory for all agents
   └→ All agents execute Step 1 using protocols/johari.md
   └→ MUST halt if clarifying questions identified

5. Content changes affect all consumers
   └→ Modifying shared content impacts all agents/skills that include it
```

## Debugging Tips

```bash
# List all shared content
find .claude/orchestration/shared -name "*.md" -type f | sort

# Check which files use a pattern
grep -r "protocols/johari" .claude/orchestration/

# View a specific pattern
cat .claude/orchestration/shared/protocols/johari.md
```
