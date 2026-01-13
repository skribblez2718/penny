# Validation Agent

**Cognitive Function:** VALIDATION
**Purpose:** Systematically verify artifacts against established criteria

## Step Execution Flow

```
entry.py → step_0 → step_1 → step_2 → step_3 → step_4 → complete.py
           │        │        │        │        │
           │        │        │        │        └→ gate_decision
           │        │        │        └→ gap_analysis
           │        │        └→ systematic_verification
           │        └→ criteria_loading
           └→ learning_injection
```

## Steps (from config.py)

| Step | Name | Purpose |
|------|------|---------|
| 0 | `learning_injection` | Load validation-specific learnings from .claude/learnings/validation/ |
| 1 | `criteria_loading` | Load acceptance criteria from synthesis, define quality gates |
| 2 | `systematic_verification` | Verify artifacts against each criterion |
| 3 | `gap_analysis` | Identify gaps, missing requirements, failed criteria |
| 4 | `gate_decision` | Make GO/NO-GO/CONDITIONAL verdict |

## When Invoked

- Validation phase of composite skills (after generation)
- Quality gate checkpoints
- Via `orchestrate-validation` atomic skill
- Via Task tool: `subagent_type: "validation"`

## Files

```
validation/
├── entry.py      # → agent_entry("validation")
├── complete.py   # → agent_complete("validation")
├── content/
│   └── step_{0-4}.md   # Markdown instructions per step (5 steps total)
└── steps/
    └── step_{n}_{name}.py  # Step implementations
```

## Context Budget

- **Max Input:** 2500 tokens
- **Max Output:** 1500 tokens
- **Priority Sections:** artifact, criteria, constraints

## Output

Memory file: `.claude/memory/{task_id}-validation-memory.md`

Contains:
- Verification results per criterion
- Gap analysis findings
- Gate decision: `GO` | `NO-GO` | `CONDITIONAL`
- Remediation requirements (if NO-GO or CONDITIONAL)
- Confidence score

## Gate Decisions

| Decision | Meaning | Action |
|----------|---------|--------|
| `GO` | All criteria met | Proceed to next phase |
| `NO-GO` | Critical failures | Trigger remediation loop (max 2) |
| `CONDITIONAL` | Minor issues | Proceed with noted exceptions |

## Remediation Loop

If `NO-GO`:
1. Returns to generation with gap analysis
2. Generation-agent fixes issues
3. Validation-agent re-verifies
4. Max 2 remediation loops before escalation to user
