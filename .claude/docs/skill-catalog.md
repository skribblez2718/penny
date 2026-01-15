# Skill Catalog

**Purpose:** Quick reference for all available skills in the system.

---

## Skill Types

| Type | Description | Invocation |
|------|-------------|------------|
| **Composite Skills** | Multi-phase workflows using multiple cognitive agents | Skill Orchestration Protocol |
| **Atomic Skills** | Single-agent wrappers for individual cognitive functions | Dynamic Skill Sequencing |

---

## Composite Skills

Composite skills orchestrate multiple cognitive agents through defined phase sequences.

| Skill | Semantic Trigger | NOT for | Location |
|-------|------------------|---------|----------|
| develop-command | create/modify slash commands, utility commands | workflow skills, multi-phase operations | `.claude/skills/develop-command/` |
| develop-learnings | capture learnings, document insights, preserve knowledge | mid-workflow tasks, skill creation, active execution | `.claude/skills/develop-learnings/` |
| develop-skill | create/modify skills, update workflows, new skill | system mods, direct code, architecture changes | `.claude/skills/develop-skill/` |
| perform-research | deep research, comprehensive investigation, multi-source research | quick lookups, simple searches, single-source queries | `.claude/skills/perform-research/` |

### develop-command

**Purpose:** Create and manage Claude Code slash commands for utility operations.

**Type:** composite

**When to Use:**
- Creating new slash commands for utility operations
- Modifying existing command implementations
- Managing command catalog and routing

**Location:** `.claude/skills/develop-command/`

**Orchestration:** `.claude/orchestration/protocols/skill/composite/develop_command/`

---

### develop-learnings

**Purpose:** Transform completed workflow experiences into structured, reusable learnings organized by cognitive function.

---

### develop-skill

**Purpose:** Meta-skill for creating and updating workflow skills using 6 universal cognitive agents. Supports composite-to-composite skill composition.

---

### perform-research

**Purpose:** Production-grade research with adaptive depth and quality validation

**Type:** composite

**When to Use:**
- Deep research requiring multiple sources
- Comprehensive investigation with validation
- Academic or literature review tasks
- Research requiring quality thresholds

**Location:** `.claude/skills/perform-research/`

**Orchestration:** `.claude/orchestration/protocols/skill/composite/perform_research/`

---

### develop-command

**Purpose:** Create and manage Claude Code slash commands for utility operations.

---

## Atomic Skills (orchestrate-*)

Atomic skills wrap single cognitive agents for use in Dynamic Skill Sequencing. Each maps to exactly one cognitive function.

| Skill | Cognitive Function | Semantic Trigger | NOT for |
|-------|-------------------|------------------|---------|
| orchestrate-clarification | CLARIFICATION | ambiguity resolution, requirements refinement | well-defined tasks with clear specifications |
| orchestrate-research | RESEARCH | knowledge gaps, options exploration | tasks with complete information |
| orchestrate-analysis | ANALYSIS | complexity decomposition, risk assessment | simple tasks without dependencies |
| orchestrate-synthesis | SYNTHESIS | integration of findings, design creation | single-source tasks without integration |
| orchestrate-generation | GENERATION | artifact creation, TDD implementation | read-only or research tasks |
| orchestrate-validation | VALIDATION | quality verification, acceptance testing | tasks without deliverables to verify |
| orchestrate-memory | METACOGNITION | progress tracking, impasse detection | simple linear workflows |

### When to Use Atomic Skills

Atomic skills are building blocks for Dynamic Skill Sequencing when:
- Task requires multiple cognitive functions but doesn't match a composite skill
- Flexible orchestration is needed for novel task patterns
- Single cognitive function needs isolated invocation

**Routing heuristic:** clarification (if ambiguous) → research (if gaps) → analysis (if complex) → synthesis (if integration needed) → generation (if artifacts needed) → validation (if verification required)

### Example Skill Sequences

| Task Type | Atomic Skill Sequence |
|-----------|----------------------|
| Research task | orchestrate-clarification → orchestrate-research → orchestrate-synthesis |
| Analysis task | orchestrate-analysis → orchestrate-synthesis → orchestrate-validation |
| Complex task | orchestrate-clarification → orchestrate-research → orchestrate-analysis → orchestrate-synthesis → orchestrate-generation → orchestrate-validation |

### Location

All atomic skills located at: `${CAII_DIRECTORY}/.claude/skills/orchestrate-*/`

---

## Skill Selection Guide

### Decision Tree

```
Does task match a composite skill pattern?
├── YES → Use Skill Orchestration Protocol with matching composite skill
└── NO → Does task require multiple cognitive functions?
         ├── YES → Use Dynamic Skill Sequencing with atomic skills
         └── NO → Does task pass triviality criteria?
                  ├── YES → Use Direct Execution
                  └── NO → Use single atomic skill or escalate
```

### Quick Reference

| Query Intent | Matches Semantic Trigger | Skill |
|--------------|-------------------------|-------|
| "Create a new skill for Z" | create skill, new skill | develop-skill |
| "Modify the validation workflow" | modify skill, update workflow | develop-skill |
| "Capture what we learned" | capture learnings, document insights | develop-learnings |
| "Create a /clean command" | create command, slash command | develop-command |
| Novel multi-step task | (no match) | Dynamic Skill Sequencing |

**Confidence-Based Routing:** When confidence is not HIGH, HALT and ask user for clarification rather than guessing.

---

## Related Documentation

- `${CAII_DIRECTORY}/.claude/docs/execution-protocols.md` - Protocol details
- `${CAII_DIRECTORY}/.claude/docs/cognitive-function-taxonomy.md` - Agent functions
- `${CAII_DIRECTORY}/.claude/DA.md` - System prompt with skill definitions
