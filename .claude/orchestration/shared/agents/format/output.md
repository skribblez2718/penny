# Agent Output Structure

## Four-Section Output Structure (Universal)

**CRITICAL:** All agents MUST produce output in this exact order. Section 0 is MANDATORY and MUST come FIRST.

### Section 0: CONTEXT LOADED (Verification Format - MANDATORY)

**Purpose:** Prove agent read required context files per protocol

**Required Fields (JSON format):**
```json
{
  "workflow_metadata_loaded": true,
  "workflow_file_path": "${CAII_DIRECTORY}/.claude/memory/task-{id}-memory.md",
  "workflow_tokens_consumed": 500,

  "context_loading_pattern_used": "WORKFLOW_ONLY | IMMEDIATE_PREDECESSORS | MULTIPLE_PREDECESSORS",

  "predecessors_loaded": [
    {
      "agent_name": "clarification",
      "file_path": "${CAII_DIRECTORY}/.claude/memory/task-{id}-clarification-memory.md",
      "tokens_consumed": 1200,
      "required": true
    }
  ],

  "total_context_tokens": 1700,
  "token_budget_status": "WITHIN_BUDGET (1700/3000)",

  "protocols_referenced": [
    "${CAII_DIRECTORY}/.claude/orchestration/shared/protocols/agent/"
  ],

  "verification_timestamp": "YYYY-MM-DD HH:MM:SS",
  "verification_status": "PASSED"
}
```

**Validation Rules:**
- `workflow_metadata_loaded` MUST be true
- `context_loading_pattern_used` MUST match pattern specified in invocation
- `predecessors_loaded` MUST match pattern requirements
- `total_context_tokens` MUST be ≤ 4000
- `token_budget_status` MUST indicate WITHIN_BUDGET or APPROACHING_LIMIT

**FAILURE CONDITION:** If agent outputs ANYTHING before this section, verification FAILS.

### Section 1: STEP OVERVIEW

- **Title:** STEP {N}: {Cognitive Function} Execution
- **Content:** Domain-adapted narrative of work performed

### Section 2: JOHARI SUMMARY (JSON format)

- **open:** Confirmed knowledge adapted to domain
- **hidden:** Discoveries relevant to domain
- **blind:** Domain-specific gaps identified
- **unknown:** Domain-appropriate unknowns

### Section 3: DOWNSTREAM DIRECTIVES (JSON format)

- **primaryFindings:** Key findings from this step
- **recommendedActions:** Actions for next steps
- **criticalConstraints:** Constraints to observe
- **unknownRegistryUpdates:** Updates to unknown registry

## Output Format Anti-Patterns

**WRONG: XML Wrapper Format**
Do not use XML tags. Use Markdown headings and JSON code blocks.

**CORRECT: Markdown + JSON Format**
```markdown
# Agent Output

## Context Loaded
```json
{...}
```

## Johari Summary
```json
{...}
```
```

## Domain-Specific Output Adaptations

- **Technical:** Include code snippets, architecture diagrams, API specs
- **Personal:** Include decision matrices, goal alignments, reflection prompts
- **Creative:** Include creative samples, mood boards, audience profiles
- **Professional:** Include metrics, KPIs, strategic alignments
- **Recreational:** Include fun factors, engagement metrics, participant feedback
