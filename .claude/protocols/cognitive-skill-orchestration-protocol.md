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

**CRITICAL - ORCHESTRATOR RESPONSIBILITY:** This step is MANDATORY before invoking ANY agent. Workflow metadata MUST exist.

**WHO DOES THIS:** Penny (the orchestrator) creates this file BEFORE any agent invocation. This is NOT delegated to agents.

**WHEN:** Immediately after Step 3 (reading skill definition), before Step 5 (agent invocation).

Create initial workflow memory file: `.claude/memory/task-{task-id}-memory.md`

**Format:**
```markdown
# WORKFLOW METADATA
## Task ID: task-{task-id}
## Workflow: cognitive-orchestration (or specific skill name)
## Task Domain: {technical|personal|creative|professional|recreational}
## Start Date: YYYY-MM-DD

---

## CRITICAL CONSTRAINTS
- [Domain-specific constraints]
- [Technical requirements if applicable]

## QUALITY STANDARDS
- [Domain-appropriate standards]
- [Quality criteria agents should apply]

## ARTIFACT TYPES
- [Expected outputs: code, docs, plans, etc.]

## SUCCESS CRITERIA
- [What defines success for this workflow]
- [Measurable completion criteria]

## UNKNOWN REGISTRY
### Active Unknowns
[Initially empty - agents will populate as unknowns discovered]

### Resolved Unknowns
[Initially empty - moves from Active when resolved]

---

## PHASE HISTORY
[Initially empty - Penny updates after each phase/agent completes]

### Phase 0: [Phase Name] (STATUS)
- **Agent**: [agent-name]
- **Outcome**: [brief outcome]
- **Critical Decisions**: [key decisions made]
- **Memory File**: `task-{id}-{agent-name}-memory.md`

---

## CURRENT CONTEXT
### Current Phase
- **Phase Number**: [N]
- **Phase Name**: [name]
- **Agent**: [current agent]
- **Status**: PENDING | IN_PROGRESS | COMPLETED

### Phase Focus
- [What this phase aims to accomplish]

### Needs from Previous Phases
- [What current phase needs from predecessors]
```

**Verification After Creation:**
1. File exists at `.claude/memory/task-{task-id}-memory.md`
2. All required sections present
3. Task domain classified
4. Success criteria defined

**FAILURE CONDITION:** If this file does not exist, agents WILL FAIL. Do not proceed to Step 5 without completing this step.

### Step 5: Trigger cognitive agent flow

**CRITICAL:** Follow this template for EVERY agent invocation to ensure protocol compliance.

**For each agent:**

1. **Prepare invocation with domain context:**

```
Task ID: task-{task-id}
Step: {step-number}
Cognitive Function: {RESEARCH|ANALYSIS|SYNTHESIS|GENERATION|VALIDATION|CLARIFICATION}
Task Domain: {technical|personal|creative|professional|recreational}
Purpose: {what this cognitive step accomplishes}

CRITICAL INSTRUCTIONS (NON-NEGOTIABLE):

0. CONTEXT LOADING VERIFICATION (YOUR FIRST ACTION - BEFORE ANY WORK):

   **MANDATORY:** Your FIRST output MUST be "Section 0: CONTEXT LOADED" proving you read required files.

   **If you cannot read required files:**
   - STOP immediately
   - Output error message explaining which files are missing
   - DO NOT proceed with work
   - Wait for orchestrator to fix the issue

   **Context Loaded Section Format:**
   ```json
   {
     "workflow_metadata_loaded": true,
     "workflow_file_path": ".claude/memory/task-{task-id}-memory.md",
     "workflow_tokens_consumed": 500,
     "context_loading_pattern_used": "{WORKFLOW_ONLY|IMMEDIATE_PREDECESSORS|MULTIPLE_PREDECESSORS}",
     "predecessors_loaded": [{agent_name, file_path, tokens_consumed, required}],
     "total_context_tokens": 1700,
     "token_budget_status": "WITHIN_BUDGET (1700/4000)",
     "protocols_referenced": [list of protocol files read],
     "verification_timestamp": "YYYY-MM-DD HH:MM:SS",
     "verification_status": "PASSED"
   }
   ```

   **Validation:**
   - If pattern = WORKFLOW_ONLY: `predecessors_loaded` MUST be empty array `[]`
   - If pattern = IMMEDIATE_PREDECESSORS: Exactly 1 predecessor in array
   - If pattern = MULTIPLE_PREDECESSORS: 1+ predecessors in array
   - Total tokens MUST be ≤ 4000 (hard limit)

   **FAILURE CONDITION:** If you output ANYTHING before this section, you FAIL verification.

1. READ these protocol files FIRST (before context loading):
   - /path/to/.claude/protocols/agent-protocol-core.md [ALWAYS]
   - /path/to/.claude/protocols/agent-protocol-extended.md [IF code generation]
   - /path/to/.claude/protocols/context-loading-patterns.md [ALWAYS - for context loading guidance]

2. LOAD context from (scoped loading per pattern):
   - .claude/memory/task-{task-id}-memory.md (workflow metadata - ALWAYS READ FIRST)
   - .claude/memory/task-{task-id}-{predecessor}-memory.md (immediate predecessor - if applicable)
   [Additional context files as specified in skill definition for this agent]

   See skill definition for Context Loading pattern (WORKFLOW_ONLY, IMMEDIATE_PREDECESSORS, or MULTIPLE_PREDECESSORS)

   **Track token usage:** Record how many tokens each file consumes during loading.

3. EXECUTE your cognitive function:
   - Apply your {cognitive-function} capability to this {domain} task
   - Adapt your cognitive process to the domain while maintaining universal quality
   - Follow gate entry/exit criteria from skill definition
   - Token Budget: 1,200 tokens MAXIMUM for Johari summary output

4. WRITE your output to (MANDATORY - FAILURE IF NOT DONE):
   - Location: .claude/memory/task-{task-id}-{agent-name}-memory.md
   - Format: Four sections (in this exact order)
     * Section 0: Context Loaded (JSON verification format - MUST BE FIRST)
     * Section 1: Step Overview (narrative of work performed)
     * Section 2: Johari Summary (JSON format: open, hidden, blind, unknown)
     * Section 3: Downstream Directives (JSON format: findings, actions, constraints, unknowns)
   - Token Limit: 1200 tokens for Johari section (STRICT)

{Agent-specific instructions from skill definition...}
```

2. **Select appropriate protocol references:**
   - **ALWAYS:** `agent-protocol-core.md`
   - **IF technical domain + code generation:** `agent-protocol-extended.md`
   - **ALWAYS:** `context-loading-patterns.md`

3. **PRE-INVOCATION VERIFICATION** (MANDATORY - do BEFORE invoking agent):

   **Step 3a. Verify workflow metadata exists:**
   - Check `.claude/memory/task-{task-id}-memory.md` file EXISTS
   - **FAIL IMMEDIATELY if missing** - cannot invoke agent without workflow context
   - Fix: Create workflow metadata file (see Step 4 of this protocol)

   **Step 3b. Verify predecessor files exist (if required):**
   - If context pattern = WORKFLOW_ONLY: Skip this check (no predecessors)
   - If context pattern = IMMEDIATE_PREDECESSORS:
     - Check `.claude/memory/task-{task-id}-{predecessor-name}-memory.md` EXISTS
     - **FAIL IMMEDIATELY if missing** - agent needs predecessor context
   - If context pattern = MULTIPLE_PREDECESSORS:
     - Check ALL required predecessor files exist
     - **FAIL IMMEDIATELY if any missing**

   **Step 3c. Verify agent prompt includes context instructions:**
   - Prompt MUST explicitly list all files agent should read (with full paths)
   - Prompt MUST specify context loading pattern to use
   - Prompt MUST instruct agent to output "Context Loaded" section FIRST
   - Prompt MUST instruct agent to STOP if required files cannot be read

   **FAILURE CONDITION:** If any pre-invocation check fails, DO NOT invoke agent. Fix the issue first, then retry.

4. **Invoke agent** with full structured prompt

5. **VERIFY agent acknowledged context** (MANDATORY - check immediately after invocation):

   **Step 5a. Check agent's first output:**
   - Agent's FIRST section MUST be "Section 0: CONTEXT LOADED"
   - **FAIL IMMEDIATELY if agent starts work without context verification**
   - This proves agent actually read the files (not just guessed)

   **Step 5b. Verify context loading compliance:**
   - Check "Context Loaded" section lists workflow metadata as read
   - Check pattern used matches pattern specified in invocation
   - Check predecessors loaded match pattern requirements:
     - WORKFLOW_ONLY: `predecessors_loaded` array must be empty
     - IMMEDIATE_PREDECESSORS: Exactly 1 predecessor in array
     - MULTIPLE_PREDECESSORS: 1+ predecessors in array
   - **FAIL LOUDLY if pattern violated** (agent read wrong files)

   **Step 5c. Verify token budget:**
   - Check `total_context_tokens` ≤ 4000 tokens
   - Warn if approaching limit (> 3500 tokens)
   - **FAIL if budget exceeded** (agent loaded too much context)

6. **VERIFY memory file created** (MANDATORY - do not proceed if missing):
   - Check `.claude/memory/task-{task-id}-{agent-name}-memory.md` EXISTS
   - Verify Four-Section format present (Context Loaded + Step Overview + Johari + Downstream)
   - Confirm token limits respected (Johari ≤ 1200 tokens)
   - **FAIL LOUDLY if memory file missing or malformed**

7. **Update workflow metadata:**
   - Add agent to phase history
   - Merge Unknown Registry updates
   - Update current phase status

8. **Apply progressive context pruning** per `context-pruning-protocol.md`:
   - Compress completed phase outputs
   - Maintain phase summaries
   - Keep immediate predecessors accessible

9. **Verify cognitive step completion** before proceeding to next agent:
   - Gate exit criteria met
   - No blocking issues
   - Memory file valid

---

## Context Inheritance (MANDATORY)

All agents use enhanced protocol with domain awareness:
- **Extended protocol:** `${PAI_DIRECTORY}/.claude/protocols/agent-protocol-extended.md`
- **Core protocol:** `${PAI_DIRECTORY}/.claude/protocols/agent-protocol-core.md`
- **Context pruning:** `${PAI_DIRECTORY}/.claude/protocols/context-pruning-protocol.md`

### Step 6: Complete workflow and prompt for learning capture

**CRITICAL:** This step is MANDATORY after all agents complete. Learning capture closes the improvement loop.

**WHO DOES THIS:** Penny (the orchestrator) after final agent completes and deliverables are ready.

**WHEN:** Immediately after the final agent/phase completion, before returning control to user.

**Actions:**

1. **Aggregate deliverables:**
   - Compile all agent outputs into final deliverables
   - Present complete package to user
   - Verify all success criteria met

2. **Review Unknown Registry:**
   - Check for unresolved unknowns
   - Document any remaining uncertainty
   - Flag critical unresolved items

3. **ALWAYS prompt for develop-learnings invocation:**
   - Use this exact prompt template:

   ```
   Would you like to capture learnings from this workflow using the develop-learnings skill?

   This will extract insights and patterns from the {skill-name} workflow to improve future executions.
   Task ID: task-{task-id}
   ```

   - If user accepts: Invoke develop-learnings skill with task-id
   - If user declines: Log decision and complete workflow

4. **Finalize workflow:**
   - Mark workflow status as COMPLETED
   - Archive workflow metadata
   - Clear working context

**FAILURE CONDITION:** If learning prompt is skipped, the continuous improvement loop is broken. This is a SYSTEM-LEVEL FAILURE.

---

## Key Principles

- **Domain Adaptation:** Agents adapt cognitive processes to task domain
- **Scoped Context:** Load only immediate predecessors, not all history
- **Progressive Compression:** Prune completed phase outputs to maintain token efficiency
- **Quality Gates:** Verify completion before advancing to next phase
- **Unknown Registry:** Track and resolve unknowns systematically
- **Learning Capture:** ALWAYS prompt for develop-learnings after workflow completion
