# Context Loading Patterns

## Metadata

- **Type:** protocol
- **Purpose:** Define reusable context loading patterns for cognitive agents to eliminate redundancy across skill definitions
- **Usage:** Skills reference patterns by name instead of repeating full context specifications

---

## Overview

This protocol defines standard context loading patterns used by cognitive agents. Instead of repeating full context specifications in every agent section of every skill, skills reference these patterns by name.

**Benefits:**
- **Single source of truth:** Update patterns once, applies everywhere
- **Reduced redundancy:** 50% reduction in skill file verbosity
- **Consistency:** All agents follow same context loading rules
- **Maintainability:** Change token budgets or patterns system-wide easily
- **Extensibility:** Add new patterns as workflows evolve

---

## Standard Patterns

### Pattern: WORKFLOW_ONLY

**Use Case:** First agent in workflow with no predecessor agents

**Description:** Agent loads only the workflow metadata file. Used for initial agents like clarification-specialist when starting from scratch.

**Context References:**
- `.claude/memory/task-{id}-memory.md` (workflow metadata) [ALWAYS_REQUIRED]

**Context Scope:** WORKFLOW_ONLY

**Token Budget:** 500-1,000 tokens

**Example Usage in Skills:**
```markdown
**Context Loading:** WORKFLOW_ONLY (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** None (first agent)
```

---

### Pattern: IMMEDIATE_PREDECESSORS

**Use Case:** Standard agent following another agent (most common pattern - ~80% of agents)

**Description:** Agent loads workflow metadata plus the immediately preceding agent's output. This is the default pattern for sequential agent workflows.

**Context References:**
- `.claude/memory/task-{id}-memory.md` (workflow metadata) [ALWAYS_REQUIRED]
- `.claude/memory/task-{id}-{predecessor}-memory.md` [IMMEDIATE_PREDECESSOR_REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS

**Token Budget:** 2,500-3,000 tokens
- Workflow metadata: ~500 tokens
- Predecessor output: ~2,000-2,500 tokens

**Example Usage in Skills:**
```markdown
**Context Loading:** IMMEDIATE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** clarification-specialist
```

**Expanded File Path (for agent invocation):**
- `.claude/memory/task-{id}-memory.md`
- `.claude/memory/task-{id}-clarification-specialist-memory.md`

---

### Pattern: MULTIPLE_PREDECESSORS

**Use Case:** Agent needing context from multiple sources (synthesis, validation, or agents resolving complex dependencies)

**Description:** Agent loads workflow metadata, one required immediate predecessor, and additional optional predecessor outputs for reference.

**Context References:**
- `.claude/memory/task-{id}-memory.md` (workflow metadata) [ALWAYS_REQUIRED]
- `.claude/memory/task-{id}-{predecessor-1}-memory.md` [IMMEDIATE_PREDECESSOR_REQUIRED]
- `.claude/memory/task-{id}-{predecessor-2}-memory.md` ({context note}) [OPTIONAL]
- `.claude/memory/task-{id}-{predecessor-3}-memory.md` ({context note}) [OPTIONAL]

**Context Scope:** IMMEDIATE_PREDECESSORS + OPTIONAL_REFERENCES

**Token Budget:** 3,000-4,000 tokens
- Workflow metadata: ~500 tokens
- Immediate predecessor: ~2,000-2,500 tokens
- Optional references: ~500-1,000 tokens (specific sections only, not full files)

**Example Usage in Skills:**
```markdown
**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor (required):** research-discovery
**Optional References:**
- synthesis-agent (Phase 1 decisions context)
- analysis-agent (requirements for alignment check)
```

**Expanded File Path (for agent invocation):**
- `.claude/memory/task-{id}-memory.md`
- `.claude/memory/task-{id}-research-discovery-memory.md`
- `.claude/memory/task-{id}-synthesis-agent-memory.md` (optional)
- `.claude/memory/task-{id}-analysis-agent-memory.md` (optional)

---

## Pattern Selection Guide

### Decision Tree

```
Is this the first agent in the workflow?
├─ YES → WORKFLOW_ONLY
└─ NO → Does this agent need context from only the immediately preceding agent?
         ├─ YES → IMMEDIATE_PREDECESSORS
         └─ NO → Does this agent need context from multiple previous agents?
                  └─ YES → MULTIPLE_PREDECESSORS
```

### Common Agent → Pattern Mapping

| Agent Type | Typical Pattern | Rationale |
|------------|----------------|-----------|
| clarification-specialist (first) | WORKFLOW_ONLY | No predecessors, starting workflow |
| clarification-specialist (later) | IMMEDIATE_PREDECESSORS | Clarifying previous agent's output |
| research-discovery | IMMEDIATE_PREDECESSORS | Researching based on previous analysis/clarification |
| analysis-agent | IMMEDIATE_PREDECESSORS | Analyzing previous agent's output |
| synthesis-agent | MULTIPLE_PREDECESSORS | Integrating multiple sources (research + decisions + architecture) |
| generation-agent | IMMEDIATE_PREDECESSORS | Generating from previous synthesis/plan |
| generation-agent (iteration) | MULTIPLE_PREDECESSORS | May need architecture + previous generation |
| quality-validator | MULTIPLE_PREDECESSORS | Validating generation + checking requirements |

---

## Usage in Skills

### Standard Format (Option B - Recommended)

```markdown
### AGENT N: {agent-name}

**Purpose:** {what this agent does}

**Gate Entry:** {preconditions}

**Gate Exit:** {postconditions}

**Context Loading:** {PATTERN_NAME} (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** {predecessor-agent-name}
[IF MULTIPLE_PREDECESSORS:
**Optional References:**
- {predecessor-2} ({context note})
- {predecessor-3} ({context note})
]

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]
- `.claude/protocols/agent-protocol-extended.md` [IF technical/code generation]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-{agent-name}-memory.md`
- Format: Johari Window (open, hidden, blind, unknown)
- Token Limit: 1200 tokens for Johari section

{Agent-specific instructions...}
```

### Example: Simple Sequential Agent

```markdown
### AGENT 2: analysis-agent

**Purpose:** Analyze requirements for dependencies, complexity, risks

**Gate Entry:** Clarified requirements available

**Gate Exit:** Requirements validated, complexity assessed

**Context Loading:** IMMEDIATE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** clarification-specialist

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md`

**Memory Output:**
- Write to: `.claude/memory/task-{id}-analysis-agent-memory.md`
- Format: Johari Window
- Token Limit: 1200 tokens
```

### Example: Agent with Multiple Sources

```markdown
### AGENT 5: quality-validator

**Purpose:** Comprehensive quality and security validation

**Gate Entry:** Core implementation complete

**Gate Exit:** All quality gates passed

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor (required):** generation-agent
**Optional References:**
- synthesis-agent (architecture design for compliance check)
- analysis-agent (requirements for acceptance criteria)

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md`
- `.claude/protocols/agent-protocol-extended.md` (security validation)

**Memory Output:**
- Write to: `.claude/memory/task-{id}-quality-validator-memory.md`
- Format: Johari Window
- Token Limit: 1200 tokens
```

---

## Agent Invocation Translation

When Penny (orchestrator) invokes an agent, it must translate the pattern reference into explicit file paths.

### Translation Rules

**Pattern:** `IMMEDIATE_PREDECESSORS`
**Predecessor:** `clarification-specialist`
**Task ID:** `task-oauth2-impl`

**Translates to:**
```
CRITICAL INSTRUCTIONS:

2. LOAD context from (scoped loading):
   - .claude/memory/task-oauth2-impl-memory.md (workflow metadata - ALWAYS READ)
   - .claude/memory/task-oauth2-impl-clarification-specialist-memory.md (immediate predecessor)
```

**Pattern:** `MULTIPLE_PREDECESSORS`
**Predecessor (required):** `research-discovery`
**Optional References:** `synthesis-agent (Phase 1 decisions)`, `analysis-agent (requirements)`
**Task ID:** `task-oauth2-impl`

**Translates to:**
```
CRITICAL INSTRUCTIONS:

2. LOAD context from (scoped loading):
   - .claude/memory/task-oauth2-impl-memory.md (workflow metadata - ALWAYS READ)
   - .claude/memory/task-oauth2-impl-research-discovery-memory.md (immediate predecessor - REQUIRED)
   - .claude/memory/task-oauth2-impl-synthesis-agent-memory.md (Phase 1 decisions context - OPTIONAL)
   - .claude/memory/task-oauth2-impl-analysis-agent-memory.md (requirements reference - OPTIONAL)
```

---

## Adding New Patterns

As workflows evolve, new patterns can be added following this template:

### Pattern: {PATTERN_NAME}

**Use Case:** {when to use this pattern}

**Description:** {detailed description}

**Context References:**
- {file path pattern} ({description}) [{requirement level}]

**Context Scope:** {scope label}

**Token Budget:** {N} tokens

**Example Usage in Skills:**
```markdown
{example}
```

---

## Maintenance Notes

### When to Update This Protocol

- **Token budgets change:** Update pattern definitions, automatically applies to all skills
- **New context scoping needed:** Add new pattern, existing skills unaffected
- **Memory file structure changes:** Update file path patterns here

### Impact of Changes

- **Changing existing patterns:** Affects ALL agents using that pattern
- **Adding new patterns:** No impact on existing skills
- **Deprecating patterns:** Must update all skills referencing deprecated pattern

### Validation

When creating or updating skills:
1. Verify pattern name matches defined patterns
2. Ensure predecessor names are valid agent names
3. Confirm optional references have context notes
4. Check pattern choice matches agent's context needs

---

## References

- **Core execution protocol:** `.claude/protocols/agent-protocol-core.md` (lines 43-110: Context Inheritance Protocol)
- **Skill orchestration:** `.claude/protocols/cognitive-skill-orchestration-protocol.md` (Step 5: agent invocation)
- **Johari Window format:** `.claude/references/johari.md`
- **Context examples:** `.claude/references/context-inheritance.md`
- **Agent descriptions:** `.claude/references/agent-registry.md`

---

## Summary

**Key Takeaways:**
- Three standard patterns cover 95% of agent context needs
- Skills reference patterns by name for 50% verbosity reduction
- Single source of truth for context loading rules
- Easy to extend with new patterns as workflows evolve
- Orchestrator translates patterns to file paths at invocation time

**Pattern Usage Statistics (typical workflow):**
- WORKFLOW_ONLY: ~10% (first agents)
- IMMEDIATE_PREDECESSORS: ~75% (sequential agents)
- MULTIPLE_PREDECESSORS: ~15% (synthesis, validation)

---

## Pattern Compliance Verification

**Purpose:** Define how to verify agents followed the specified context loading pattern correctly.

### Verification Mechanism

When orchestrator invokes agent with a specific pattern, verification happens in THREE stages:

**1. PRE-INVOCATION (Before agent starts):**
- Verify required context files EXIST
- Verify agent prompt lists correct files to read
- Verify agent prompt specifies correct pattern

**2. DURING EXECUTION (Agent's first output):**
- Verify agent outputs "Section 0: CONTEXT LOADED" FIRST
- Verify pattern compliance from "Context Loaded" section

**3. POST-COMPLETION (After agent finishes):**
- Verify memory file created with correct format
- Verify token budget respected

### Pattern-Specific Compliance Rules

#### WORKFLOW_ONLY Pattern Compliance

**Requirements:**
- Agent MUST read workflow metadata file: `.claude/memory/task-{id}-memory.md`
- Agent MUST NOT read any predecessor files
- Agent's "Context Loaded" section MUST show:
  - `workflow_metadata_loaded: true`
  - `predecessors_loaded: []` (empty array)
  - `context_loading_pattern_used: "WORKFLOW_ONLY"`

**Verification:**
```json
{
  "workflow_metadata_loaded": true,
  "predecessors_loaded": [],  // MUST be empty
  "total_context_tokens": 400-600  // Expected range for workflow metadata only
}
```

**FAIL CONDITIONS:**
- `predecessors_loaded` array is NOT empty (agent read predecessor files when it shouldn't)
- `workflow_metadata_loaded` is false (agent didn't read workflow metadata)
- `total_context_tokens` > 1000 (agent loaded extra files)

---

#### IMMEDIATE_PREDECESSORS Pattern Compliance

**Requirements:**
- Agent MUST read workflow metadata file
- Agent MUST read EXACTLY ONE immediate predecessor file: `.claude/memory/task-{id}-{predecessor-name}-memory.md`
- Agent MUST NOT read other predecessor files
- Agent's "Context Loaded" section MUST show:
  - `workflow_metadata_loaded: true`
  - `predecessors_loaded: [exactly 1 item]`
  - `context_loading_pattern_used: "IMMEDIATE_PREDECESSORS"`

**Verification:**
```json
{
  "workflow_metadata_loaded": true,
  "predecessors_loaded": [
    {
      "agent_name": "clarification-specialist",  // The ONE immediate predecessor
      "file_path": ".claude/memory/task-{id}-clarification-specialist-memory.md",
      "tokens_consumed": 1200,
      "required": true
    }
  ],  // Array length MUST be 1
  "total_context_tokens": 1500-2000  // Expected range for workflow + 1 predecessor
}
```

**FAIL CONDITIONS:**
- `predecessors_loaded` array length ≠ 1 (agent read 0, or 2+, predecessors)
- `workflow_metadata_loaded` is false
- `total_context_tokens` < 1000 (likely skipped predecessor)
- `total_context_tokens` > 3000 (likely read extra predecessors)
- Agent listed wrong predecessor (not the immediate one)

---

#### MULTIPLE_PREDECESSORS Pattern Compliance

**Requirements:**
- Agent MUST read workflow metadata file
- Agent MUST read 1+ required predecessor files
- Agent MAY read optional predecessor files for reference
- Agent's "Context Loaded" section MUST show:
  - `workflow_metadata_loaded: true`
  - `predecessors_loaded: [1+ items with required field]`
  - `context_loading_pattern_used: "MULTIPLE_PREDECESSORS"`

**Verification:**
```json
{
  "workflow_metadata_loaded": true,
  "predecessors_loaded": [
    {
      "agent_name": "research-discovery",
      "file_path": ".claude/memory/task-{id}-research-discovery-memory.md",
      "tokens_consumed": 1200,
      "required": true  // At least one MUST have required=true
    },
    {
      "agent_name": "analysis-agent",
      "file_path": ".claude/memory/task-{id}-analysis-agent-memory.md",
      "tokens_consumed": 1100,
      "required": true
    },
    {
      "agent_name": "clarification-specialist",
      "file_path": ".claude/memory/task-{id}-clarification-specialist-memory.md",
      "tokens_consumed": 800,
      "required": false  // Optional reference OK
    }
  ],
  "total_context_tokens": 2500-3500  // Expected range for workflow + multiple predecessors
}
```

**FAIL CONDITIONS:**
- `predecessors_loaded` array is empty (agent didn't read any predecessors)
- No predecessor has `required: true` (all marked optional, but pattern requires at least 1 required)
- `workflow_metadata_loaded` is false
- `total_context_tokens` > 4000 (exceeded hard limit)

---

### Orchestrator Verification Checklist

For EVERY agent invocation, orchestrator MUST verify:

**✅ Pre-Invocation Checks:**
1. Required context files exist
2. Agent prompt lists correct files
3. Agent prompt specifies correct pattern

**✅ During Execution Checks:**
4. Agent's first output is "Context Loaded" section
5. Pattern in "Context Loaded" matches invocation pattern
6. Predecessor count matches pattern requirements:
   - WORKFLOW_ONLY: 0 predecessors
   - IMMEDIATE_PREDECESSORS: Exactly 1 predecessor
   - MULTIPLE_PREDECESSORS: 1+ predecessors
7. Token budget within limits (≤ 4000)

**✅ Post-Completion Checks:**
8. Memory file created with Four-Section format
9. Johari section ≤ 1200 tokens

**❌ Failure Actions:**
- If any check fails: FAIL LOUDLY
- Do NOT proceed to next agent
- Report specific violation to user
- Fix issue before retrying

---

### Common Violation Scenarios

**Scenario 1: Agent Ignores Pattern Specification**
- **Problem:** Agent invoked with WORKFLOW_ONLY but reads predecessor files anyway
- **Detection:** `predecessors_loaded` array not empty when should be
- **Action:** FAIL agent, report pattern violation

**Scenario 2: Agent Skips Required Reading**
- **Problem:** Agent invoked with IMMEDIATE_PREDECESSORS but doesn't read predecessor
- **Detection:** `predecessors_loaded` array empty or `total_context_tokens` suspiciously low
- **Action:** FAIL agent, report missing context

**Scenario 3: Agent Loads All Previous Files**
- **Problem:** Agent ignores scoping and reads all previous agent outputs
- **Detection:** `total_context_tokens` unexpectedly high (e.g., 8000+ tokens)
- **Action:** FAIL agent, report token budget violation and scoping violation

**Scenario 4: Agent Guesses Instead of Reading**
- **Problem:** Agent produces output without reading context files
- **Detection:** Missing "Context Loaded" section or `total_context_tokens` = 0
- **Action:** FAIL agent immediately, report protocol violation

---

### Pattern Compliance Enforcement

**Who Enforces:**
- **Orchestrator (Penny):** Pre-invocation and during execution checks
- **Agent Protocol:** Mandates "Context Loaded" section output
- **Skills:** Specify which pattern each agent should use

**When Enforcement Happens:**
- **Pre-Invocation:** Before agent starts (file existence, prompt correctness)
- **First Response:** Agent's first output (context acknowledgment)
- **Completion:** After agent finishes (memory file validation)

**Enforcement Strength:**
- **MANDATORY:** All three verification stages must pass
- **FAIL LOUDLY:** Any violation stops workflow immediately
- **NO BYPASS:** Agents cannot skip context loading
- **NO TRUST:** Verification required, cannot assume agent followed instructions
