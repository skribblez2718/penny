# Cognitive Skill Orchestration Protocol

## Overview

This protocol defines the execution flow for tasks requiring multi-phase cognitive processing through systematic agent orchestration.

## Trigger Conditions

Use this protocol when:
- Task benefits from multi-phase cognitive processing
- Task requires systematic discovery → analysis → synthesis → generation → validation
- Task matches existing skill patterns (agent creation, skill creation, complex projects)
- Task complexity benefits from structured workflow with gate checks
- Keywords suggest multi-step cognitive work: "create", "develop", "analyze and build", "research and implement"

---

## Execution Steps

### Step 1: Generate task-id

**Format:** `task-<descriptive-keywords>`

**Validation:** 5-40 chars, lowercase + dashes only, starts with "task-"

**Examples:**
- `task-oauth2-auth`
- `task-life-decision`
- `task-creative-story`

**Reference:** `.claude/protocols/TASK-ID.md`

### Step 2: Classify task domain

**Domains:**
- **Technical:** Software, systems, engineering
- **Personal:** Life decisions, health, goals
- **Creative:** Art, writing, content creation
- **Professional:** Business, career, workplace
- **Recreational:** Fun, games, entertainment
- **Hybrid:** Multi-domain requiring mixed approach

### Step 3: Read skill definition or create cognitive workflow

- **Check:** `${PAI_DIRECTORY}/.claude/skills/{skill-name}/SKILL.md` for existing workflow
- **Fallback:** If no skill exists, determine cognitive agent sequence needed
- **Standard sequence:** RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION
- **Flexibility:** Insert CLARIFICATION wherever ambiguity detected

### Step 4: Create memory file with domain context

Create initial workflow memory file: `.claude/memory/task-{task-id}-memory.md`

**Format:**
```markdown
# WORKFLOW METADATA
## Task ID: task-{task-id}
## Workflow: cognitive-orchestration
## Task Domain: {technical|personal|creative|professional|recreational}
## Start Date: YYYY-MM-DD

---

## CRITICAL CONSTRAINTS
- [Domain-specific constraints]

## QUALITY STANDARDS
- [Domain-appropriate standards]

## ARTIFACT TYPES
- [Expected outputs]

## SUCCESS CRITERIA
- [What defines success]

## UNKNOWN REGISTRY
### Active Unknowns
[Initially empty]
```

### Step 5: Trigger cognitive agent flow

**For each agent:**

1. **Prepare invocation with domain context:**

```
Task ID: task-{task-id}
Step: {step-number}
Cognitive Function: {RESEARCH|ANALYSIS|SYNTHESIS|GENERATION|VALIDATION|CLARIFICATION}
Task Domain: {technical|personal|creative|professional|recreational}
Purpose: {what this cognitive step accomplishes}

Token Budget: 1,200 tokens maximum for Johari summary output

Read context from (scoped loading - immediate predecessors only):
- .claude/memory/task-{task-id}-memory.md (workflow metadata)
- .claude/memory/task-{task-id}-{previous-agent}-memory.md
- [other relevant predecessor outputs]

Apply your {cognitive-function} capability to this {domain} task.
Adapt your cognitive process to the domain while maintaining universal quality.
```

2. **Select appropriate protocol:**
   - **Condition:** GENERATION agent + code artifacts → `agent-protocol-extended.md`
   - **Condition:** All other cases → `agent-protocol-core.md`

3. Invoke agent with full context
4. Merge Unknown Registry updates
5. Apply progressive context pruning per `context-pruning-protocol.md` (compress completed phase outputs)
6. Verify cognitive step completion before proceeding

---

## Context Inheritance (MANDATORY)

All agents use enhanced protocol with domain awareness:
- **Extended protocol:** `${PAI_DIRECTORY}/.claude/protocols/agent-protocol-extended.md`
- **Core protocol:** `${PAI_DIRECTORY}/.claude/protocols/agent-protocol-core.md`
- **Context pruning:** `${PAI_DIRECTORY}/.claude/protocols/context-pruning-protocol.md`

---

## Key Principles

- **Domain Adaptation:** Agents adapt cognitive processes to task domain
- **Scoped Context:** Load only immediate predecessors, not all history
- **Progressive Compression:** Prune completed phase outputs to maintain token efficiency
- **Quality Gates:** Verify completion before advancing to next phase
- **Unknown Registry:** Track and resolve unknowns systematically
