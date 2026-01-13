# Memory File Protocol

## Memory File Requirements

ALL cognitive agents MUST:

1. **READ workflow metadata FIRST:**
   - Location: `${CAII_DIRECTORY}/.claude/memory/task-{id}-memory.md`
   - Contains: task domain, quality standards, artifact types, success criteria, constraints
   - Status: ALWAYS_REQUIRED before any work begins

2. **READ predecessor context (scoped):**
   - Load immediate predecessor outputs only (not all previous agents)
   - Pattern: `${CAII_DIRECTORY}/.claude/memory/task-{id}-{predecessor-name}-memory.md`
   - See context-loading patterns for standard patterns

3. **WRITE output AFTER completion:**
   - Location: `${CAII_DIRECTORY}/.claude/memory/task-{id}-{agent-name}-memory.md`
   - Format: Three sections (Step Overview + Johari Summary + Downstream Directives)
   - Token Limit: 1200 tokens MAXIMUM for Johari section

## Failure Conditions

An agent has FAILED if:
- Memory file not created after completion
- Memory file missing Johari Window structure
- Johari section exceeds 1200 token limit
- Workflow metadata not read before starting
- Predecessor context not loaded when required

## Verification

### Pre-Invocation Verification

MANDATORY - Orchestrator MUST verify before invoking agent:

1. **Verify workflow metadata EXISTS:**
   - Check `${CAII_DIRECTORY}/.claude/memory/task-{id}-memory.md` file exists
   - FAIL IMMEDIATELY if missing

2. **Verify predecessor files EXIST (if required):**
   - Check based on context loading pattern
   - FAIL IMMEDIATELY if required predecessor files missing

3. **Verify agent prompt includes explicit read instructions:**
   - Agent prompt MUST list all files to read with full paths
   - Agent prompt MUST specify context loading pattern

### During Execution

MANDATORY - Verify agent acknowledged context:

1. **Verify "Context Loaded" section output FIRST**
2. **Verify correct files read per pattern**
3. **Verify pattern compliance**

### Post-Completion

After EVERY agent completes:

1. **Verify memory file created**
2. **Verify Johari format present**
3. **Confirm token limits respected**
4. **Validate downstream directives included**

## Memory File Locations

- **Workflow metadata:** `task-{id}-memory.md`
- **Agent outputs:** `task-{id}-{agent}-memory.md`
- **Directory:** `${CAII_DIRECTORY}/.claude/memory/`
