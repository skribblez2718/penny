# Output Generation

## Instructions

1. **Write Memory File** (MANDATORY)

   Path: `.claude/memory/{task-id}-memory-memory.md`

   Use the Write tool to create this file with the following format:

   ```markdown
   # Agent Output: memory

   ## Section 0: Context Loaded
   ```json
   {
     "workflow_metadata_loaded": true,
     "context_loading_pattern_used": "IMMEDIATE_PREDECESSORS",
     "predecessors_loaded": ["{previous-agent}"],
     "verification_status": "PASSED"
   }
   ```

   ## Section 1: Assessment Summary

   ### Goal State
   **Primary Goal:** {single sentence}
   **Active Subgoals:** {count} active, {count} blocked, {count} resolved

   ### Progress Assessment
   **Progress Made:** Yes|No
   **Score:** SIGNIFICANT|PARTIAL|MINIMAL|NONE
   **Evidence:** {key indicators}

   ### Impasse Detection
   **Impasse Detected:** Yes|No
   **Type:** {none|no-change|tie|conflict|missing-knowledge}
   **Confidence:** {0.0-1.0}

   ### Remediation
   **Action:** {continue|re-invoke|escalate|abort}
   **Target:** {agent if applicable}
   **Rationale:** {brief justification}

   ## Section 2: Johari Summary
   ```json
   {
     "open": "{things now confirmed}",
     "hidden": "{context not yet shared}",
     "blind": "{assumptions proved wrong}",
     "unknown": "{new questions identified}"
   }
   ```

   ## Section 3: Downstream Directives
   **Next Agent:** {agent-name or "continue workflow"}
   **Handoff Context:** {critical information for next step}
   ```

2. **Token Enforcement**
   - Total output MUST NOT exceed 800 tokens
   - Prioritize essential information
   - Omit verbose explanations

3. **Print Completion Directive**
   ```
   GOAL-MEMORY ASSESSMENT COMPLETE:
   python3 {protocol_path}/complete.py --state {state_file}
   ```

## Completion Criteria

- [ ] Memory file written via Write tool
- [ ] All required sections present
- [ ] Token limit respected (< 800 tokens)
- [ ] Completion directive printed
- [ ] Assessment ready for orchestrator processing
