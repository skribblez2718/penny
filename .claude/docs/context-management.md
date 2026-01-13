# Context Management Reference Guide

**Purpose:** Comprehensive reference for context loading patterns and pruning strategies in multi-agent workflows.

---

## Overview

Context management ensures agents receive the right information at the right time while maintaining sustainable memory file sizes. This document covers:

1. **Context Loading** - How agents consume context from predecessors
2. **Context Pruning** - How to compress context for long-running workflows

---

# Part 1: Context Loading

## Loading Patterns

Three standard patterns cover 95% of agent context needs:

| Pattern | Use Case | Token Budget |
|---------|----------|--------------|
| WORKFLOW_ONLY | First agent, no predecessors | 500-1,000 |
| IMMEDIATE_PREDECESSORS | Standard sequential agent | 2,500-3,000 |
| MULTIPLE_PREDECESSORS | Synthesis, validation, complex dependencies | 3,000-4,000 |

**Usage Statistics (typical workflow):**
- WORKFLOW_ONLY: ~10% (first agents)
- IMMEDIATE_PREDECESSORS: ~75% (sequential agents)
- MULTIPLE_PREDECESSORS: ~15% (synthesis, validation)

## Pattern Selection

```
Is this the first agent in the workflow?
├─ YES → WORKFLOW_ONLY
└─ NO → Does this agent need context from only the immediately preceding agent?
         ├─ YES → IMMEDIATE_PREDECESSORS
         └─ NO → MULTIPLE_PREDECESSORS
```

### Common Agent-to-Pattern Mapping

| Agent Type | Typical Pattern | Rationale |
|------------|----------------|-----------|
| clarification (first) | WORKFLOW_ONLY | No predecessors |
| research | IMMEDIATE_PREDECESSORS | Researching based on previous |
| analysis | IMMEDIATE_PREDECESSORS | Analyzing previous output |
| synthesis | MULTIPLE_PREDECESSORS | Integrating multiple sources |
| generation | IMMEDIATE_PREDECESSORS | Generating from synthesis |
| validation | MULTIPLE_PREDECESSORS | Validating + checking requirements |

## Pattern Translation

When orchestrator invokes an agent, patterns translate to explicit file paths:

**IMMEDIATE_PREDECESSORS Example:**
```
Pattern: IMMEDIATE_PREDECESSORS
Predecessor: clarification
Task ID: task-oauth2-impl

Loads:
- .claude/memory/task-oauth2-impl-memory.md (workflow metadata - ALWAYS)
- .claude/memory/task-oauth2-impl-clarification-memory.md (predecessor)
```

**MULTIPLE_PREDECESSORS Example:**
```
Pattern: MULTIPLE_PREDECESSORS
Predecessor (required): research
Optional: synthesis, analysis

Loads:
- .claude/memory/task-oauth2-impl-memory.md (workflow metadata - ALWAYS)
- .claude/memory/task-oauth2-impl-research-memory.md (required)
- .claude/memory/task-oauth2-impl-synthesis-memory.md (optional)
- .claude/memory/task-oauth2-impl-analysis-memory.md (optional)
```

## Loading Violations

| Violation | Detection | Action |
|-----------|-----------|--------|
| Ignores pattern spec | predecessors_loaded array not empty when should be | FAIL agent |
| Skips required reading | predecessors_loaded empty or low tokens | FAIL agent |
| Loads all previous files | tokens > 8000 unexpectedly | FAIL agent |
| Guesses instead of reading | Missing "Context Loaded" section | FAIL agent |

---

# Part 2: Context Pruning

## Why Pruning is Mandatory

Without pruning:
- Memory files grow to 1,000-2,800 lines
- Context loading consumes 60-70% of agent capacity
- Execution slows 40-50%
- Agents "stall out" in later phases

With pruning:
- Memory files stay 400-600 lines
- Context loading drops to 30-40% of capacity
- Execution accelerates 40-50%
- Agents maintain performance throughout workflow

## Target Metrics

### Memory File Size by Phase

| Phase | Target Size |
|-------|-------------|
| After Phase 0 | 200-300 lines |
| After Phase 1 | 300-400 lines |
| After Phase 2 | 400-500 lines |
| After Phase 3 | 500-600 lines |
| Maximum | 800 lines |

### Performance Targets

| Metric | Before | Target | Reduction |
|--------|--------|--------|-----------|
| Context load per agent | 8,000-12,000 tokens | 2,000-3,000 tokens | 60-75% |
| Agent execution time | 90-180 seconds | 45-90 seconds | 40-50% |
| Workflow completion | 45-60 minutes | 20-30 minutes | 40-50% |

## Memory File Structure

| Section | Lines | Pruning Rule |
|---------|-------|--------------|
| Workflow Metadata | 50-100 | NEVER PRUNED |
| Compressed Context | 150-200 | GROWS PROGRESSIVELY |
| Current Phase Detail | 100-200 | ACTIVE WORK |
| Unknown Registry | 50-100 | MAINTAINED |
| Validation Results | 50-100 | CONDITIONALLY RETAINED |
| **Total** | **400-600** | |

## Pruning Anti-Patterns

### 1. Premature Pruning
- **Problem:** Pruning before downstream phases consume context
- **Symptom:** Agents lack context, request clarification
- **Prevention:** Keep detailed findings until immediate successor completes

### 2. Over-Pruning Decisions
- **Problem:** Compressing key decisions into summaries that lose nuance
- **Symptom:** Downstream phases revisit already-made decisions
- **Prevention:** Preserve decision rationale and trade-offs

### 3. Inconsistent Compression
- **Problem:** Different compression levels for similar content
- **Symptom:** Uneven detail levels across phases
- **Prevention:** Use token budgets as objective measure

### 4. Archive Orphaning
- **Problem:** Moving content to archives without reference links
- **Symptom:** Historical context becomes inaccessible
- **Prevention:** Always include archive references

### 5. Compression Without Validation
- **Problem:** Pruning without checking downstream needs
- **Symptom:** Agents repeatedly ask for pruned context
- **Prevention:** Review downstream requirements before pruning

## Workflow Example

**develop-project with 6 phases:**

| Phase | Output | Compression | Result |
|-------|--------|-------------|--------|
| Phase 0 | 600 lines | None (current) | 600 lines |
| Phase 1 | 500 lines | Phase 0: 600→240 (60%) | 740 lines |
| Phase 2 | 450 lines | Phase 1: 500→200, Phase 0: 240→150 | 800 lines |
| Phase 3 | 400 lines | Phase 2: 450→180, Phase 1: 200→150, Phase 0: 150→80 | 810 lines |

**Without pruning at Phase 3:** ~2,000 lines
**With pruning:** 810 lines (60% reduction)

---

## Implementation Checklist

### Setup
- [ ] Define compression schedule for workflow phases
- [ ] Establish token budgets per phase type
- [ ] Document ALWAYS/CONDITIONALLY/AGGRESSIVELY pruned content

### After Each Phase
- [ ] Identify completed phase section
- [ ] Determine phase age (N-1, N-2, N-3+)
- [ ] Apply appropriate compression level
- [ ] Validate compressed content meets budget
- [ ] Verify essential decisions preserved

### Validation
- [ ] Measure memory file size against targets
- [ ] Monitor agent context load tokens
- [ ] Verify downstream agents have adequate context

---

## Agent Prompt Template Integration

Context loading patterns work in conjunction with the Agent Prompt Template system. When invoking agents via atomic skills, the orchestrator uses the template format to pass context.

### Template Context Sections

| Template Section | Context Source |
|------------------|----------------|
| Task Context | Generated at invocation time |
| Role Extension | DA generates dynamically based on task |
| Johari Context | From reasoning protocol Step 0 |
| Task Instructions | From user query and skill requirements |
| Related Research Terms | DA generates from domain keywords |
| Output Requirements | Memory file path (context loading target) |

### How Context Loading Uses Template Output

1. **Agent invocation** - DA uses template to structure prompt
2. **Agent execution** - Agent reads predecessor context via patterns
3. **Memory file output** - Agent writes to specified path
4. **Next agent loads** - Following agent uses context loading pattern to read memory file

The template ensures agents know:
- **Where to write** - Output Requirements specifies memory file path
- **What to read** - Johari Context indicates knowledge state
- **How to adapt** - Role Extension focuses the agent on specific task needs

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/shared/templates/SKILL-TEMPLATE-REFERENCE.md` for complete template documentation.

---

## Related Documentation

- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/context-loading/` - Pattern execution files
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/context-pruning/` - Pruning execution files
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/johari-format.md` - Output format
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/memory-protocol.md` - Memory requirements
- `${CAII_DIRECTORY}/.claude/orchestration/shared/templates/` - Agent prompt templates
