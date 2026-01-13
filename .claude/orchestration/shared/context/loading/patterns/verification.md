# Pattern Compliance Verification

## Purpose

Define how to verify agents followed the specified context loading pattern correctly.

---

## Verification Stages

Verification happens in THREE stages when orchestrator invokes agent with a specific pattern:

### 1. PRE-INVOCATION (Before agent starts)

- [ ] Verify required context files EXIST
- [ ] Verify agent prompt lists correct files to read
- [ ] Verify agent prompt specifies correct pattern

### 2. DURING EXECUTION (Agent's first output)

- [ ] Verify agent outputs "Section 0: CONTEXT LOADED" FIRST
- [ ] Verify pattern compliance from "Context Loaded" section

### 3. POST-COMPLETION (After agent finishes)

- [ ] Verify memory file created with correct format
- [ ] Verify token budget respected

---

## Pattern-Specific Compliance Rules

### WORKFLOW_ONLY Pattern

**Requirements:**
- Agent MUST read workflow metadata file: `${CAII_DIRECTORY}/.claude/memory/task-{id}-memory.md`
- Agent MUST NOT read any predecessor files

**Expected "Context Loaded" section:**
```json
{
  "workflow_metadata_loaded": true,
  "predecessors_loaded": [],
  "total_context_tokens": 400-600,
  "context_loading_pattern_used": "WORKFLOW_ONLY"
}
```

**FAIL CONDITIONS:**
- `predecessors_loaded` array is NOT empty
- `workflow_metadata_loaded` is false
- `total_context_tokens` > 1000

---

### IMMEDIATE_PREDECESSORS Pattern

**Requirements:**
- Agent MUST read workflow metadata file
- Agent MUST read EXACTLY ONE immediate predecessor file
- Agent MUST NOT read other predecessor files

**Expected "Context Loaded" section:**
```json
{
  "workflow_metadata_loaded": true,
  "predecessors_loaded": [
    {
      "agent_name": "{predecessor}",
      "file_path": "${CAII_DIRECTORY}/.claude/memory/task-{id}-{predecessor}-memory.md",
      "tokens_consumed": 1200,
      "required": true
    }
  ],
  "total_context_tokens": 1500-2000,
  "context_loading_pattern_used": "IMMEDIATE_PREDECESSORS"
}
```

**FAIL CONDITIONS:**
- `predecessors_loaded` array length != 1
- `workflow_metadata_loaded` is false
- `total_context_tokens` < 1000 (likely skipped predecessor)
- `total_context_tokens` > 3000 (likely read extra predecessors)
- Agent listed wrong predecessor

---

### MULTIPLE_PREDECESSORS Pattern

**Requirements:**
- Agent MUST read workflow metadata file
- Agent MUST read 1+ required predecessor files
- Agent MAY read optional predecessor files for reference

**Expected "Context Loaded" section:**
```json
{
  "workflow_metadata_loaded": true,
  "predecessors_loaded": [
    {
      "agent_name": "{predecessor-1}",
      "required": true
    },
    {
      "agent_name": "{predecessor-2}",
      "required": false
    }
  ],
  "total_context_tokens": 2500-3500,
  "context_loading_pattern_used": "MULTIPLE_PREDECESSORS"
}
```

**FAIL CONDITIONS:**
- `predecessors_loaded` array is empty
- No predecessor has `required: true`
- `workflow_metadata_loaded` is false
- `total_context_tokens` > 4000 (exceeded hard limit)

---

## Failure Actions

**If any check fails:**
1. FAIL LOUDLY - do not silently continue
2. Do NOT proceed to next agent
3. Report specific violation to user
4. Fix issue before retrying

---

## Enforcement Notes

- **MANDATORY:** All three verification stages must pass
- **FAIL LOUDLY:** Any violation stops workflow immediately
- **NO BYPASS:** Agents cannot skip context loading
- **NO TRUST:** Verification required, cannot assume agent followed instructions
