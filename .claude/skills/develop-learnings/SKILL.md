---
name: develop-learnings
description: Transform completed workflow experiences into structured, reusable learnings organized by cognitive function
tags: learnings, reflection, continuous-improvement, knowledge-capture
---

# develop-learnings

**Description:** After a workflow completes, transform resolved Unknowns and key discoveries into structured, reusable learnings organized by cognitive function, using each cognitive agent to maintain its own learnings

**Status:** production

**Complexity:** complex

## OVERVIEW

The develop-learnings skill embodies "reflection-driven growth" - systematically capturing what was unknown at workflow start but became known through resolution, then distilling these discoveries into reusable patterns. Each cognitive agent maintains its own body of practice, not Penny. This aligns with the Johari/Unknown Registry philosophy and supports continuous system improvement.

**Core Philosophy:**
- Agents own their learnings (SRP maintained)
- Penny orchestrates, agents author
- Learnings are token-efficient, progressively disclosed
- Focus on generalization over task-specific details

## AGENT ORCHESTRATION

### PHASE 1: DISCOVERY

**Agent:** analysis-agent (ANALYSIS function)

**Purpose:** Analyze completed workflow to identify resolved Unknowns and map them to candidate learning records organized by cognitive function

**Trigger:** User invokes skill with task-id

**Instructions:**
1. Load workflow metadata for `task-id` from `.claude/memory/task-{id}-memory.md`
2. Load all agent output files for that task (clarification, research, analysis, synthesis, generation, validation)
3. Load Unknown Registry entries (U1, U2, …) + their resolution points
4. Build a Johari summary of:
   - Unknowns discovered
   - Unknowns resolved
   - Unknowns still open
5. For each resolved Unknown:
   - Identify which cognitive function was primarily responsible for resolving it
   - Identify which artifact(s) contained the resolution
   - Convert into a candidate learning record with fields:
     - `unknown_id` (U3, U7, …)
     - `cognitive_function` (clarification/research/analysis/synthesis/generation/validation)
     - `context` (short description of situation)
     - `resolution` (what we learned)
     - `pattern_type` (heuristic, anti-pattern, checklist, domain-snippet)
     - `reuse_scope` (general vs domain-specific)
     - `risk_if_ignored` (optional)
6. Group candidate records by cognitive function

**Context References:**
- `.claude/memory/task-{id}-memory.md` (workflow metadata) [ALWAYS REQUIRED]
- `.claude/memory/task-{id}-*-memory.md` (all agent outputs) [REQUIRED]
- `.claude/skills/develop-learnings/resources/candidate-extraction-guidelines.md` [REQUIRED]
- `.claude/skills/develop-learnings/resources/learnings-schema.md` [REQUIRED]

**Context Scope:** FULL_TASK
**Token Budget:** 3,000-4,000 tokens (context loading)

**Output Format:**
```markdown
# Discovery Summary

## Workflow Overview
- Task ID: {task-id}
- Domain: {domain}
- Cognitive sequence used: {sequence}

## Unknowns Analysis
- Total unknowns discovered: {count}
- Total unknowns resolved: {count}
- Total unknowns still open: {count}

## Candidate Learnings by Function

### clarification (Count: {n})
[Candidate records for clarification-specialist]

### research (Count: {n})
[Candidate records for research-discovery]

### analysis (Count: {n})
[Candidate records for analysis-agent]

### synthesis (Count: {n})
[Candidate records for synthesis-agent]

### generation (Count: {n})
[Candidate records for generation-agent]

### validation (Count: {n})
[Candidate records for quality-validator]
```

**Handoff Protocol:**
- Save output to `.claude/memory/learnings-{task-id}-discovery.md`
- Pass control to Phase 2 with candidate records grouped by function

---

### PHASE 2: PER-FUNCTION LEARNING AUTHORING

**Agents:** All 6 cognitive agents (invoked sequentially)

**Purpose:** Each agent receives only its candidates and proposes normalized learning entries for its own learnings files

**Trigger:** Phase 1 completes successfully

**Instructions for ALL agents (customized per function):**

**For each cognitive agent:**
1. Receive:
   - Candidate records for THIS function only
   - Relevant excerpts from task memory showing resolution
   - INDEX section only from existing learnings files (not full files - token efficiency)
2. Evaluate each candidate:
   - Does it generalize beyond this specific task?
   - Is it truly reusable or too task-specific?
   - Does it duplicate/overlap with existing learnings?
   - Should it extend an existing learning entry?
3. Propose normalized learning entries following the learnings schema:
   - Assign stable IDs (e.g., R-H-007 for Research-Heuristic-7)
   - Include all required metadata fields
   - Ensure principle is concise and actionable
   - Add domain tags if domain-specific
   - Categorize by pattern type (heuristic, anti-pattern, checklist, domain-snippet)
4. For each proposed entry, specify:
   - Target file (heuristics.md, anti-patterns.md, checklists.md, domain-snippets/*.md)
   - Action (ADD new entry, EXTEND existing entry, SKIP if redundant)

**Context References (per agent):**
- `.claude/memory/learnings-{task-id}-discovery.md` [IMMEDIATE PREDECESSOR - REQUIRED]
- `.claude/learnings/{function}/heuristics.md` (INDEX section only) [REQUIRED]
- `.claude/learnings/{function}/anti-patterns.md` (INDEX section only) [REQUIRED]
- `.claude/learnings/{function}/checklists.md` (INDEX section only) [REQUIRED]
- `.claude/skills/develop-learnings/resources/learnings-schema.md` [REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS + FUNCTION_LEARNINGS_INDEX
**Token Budget:** 2,000-2,500 tokens (context loading per agent)
**Johari Output Limit:** 1,200 tokens maximum (strictly enforced)

**Invocation Sequence (MUST be sequential, not parallel):**
1. clarification-specialist (CLARIFICATION) → output to `.claude/memory/learnings-{task-id}-clarification-proposals.md`
2. research-discovery (RESEARCH) → output to `.claude/memory/learnings-{task-id}-research-proposals.md`
3. analysis-agent (ANALYSIS) → output to `.claude/memory/learnings-{task-id}-analysis-proposals.md`
4. synthesis-agent (SYNTHESIS) → output to `.claude/memory/learnings-{task-id}-synthesis-proposals.md`
5. generation-agent (GENERATION) → output to `.claude/memory/learnings-{task-id}-generation-proposals.md`
6. quality-validator (VALIDATION) → output to `.claude/memory/learnings-{task-id}-validation-proposals.md`

**Output Format (per agent):**
```markdown
# {Function} Learning Proposals

## Proposed Additions

### {ID}: {Title}
- Target file: learnings/{function}/{file}.md
- Action: ADD | EXTEND {existing-id} | SKIP
- Source tasks: [{task-id}]
- Origin unknowns: [{U-IDs}]
- Domain tags: [{tags}] (if applicable)
- Situation: {when relevant}
- Principle: {rule/insight}
- Rationale: {why it matters}
- Example: {optional}
- Failure mode: {what goes wrong if ignored}

[Repeat for each proposal]

## Skipped Candidates

### Candidate: {brief}
- Reason: {why skipped - too specific, already covered, not generalizable}

[Repeat for each skipped]
```

**Handoff Protocol:**
- Each agent saves its proposals to memory
- After all 6 agents complete, pass all proposal files to Phase 3

---

### PHASE 3: CONSOLIDATION

**Agent:** synthesis-agent (SYNTHESIS function)

**Purpose:** Merge overlapping entries across all function proposals, ensure consistent IDs/tags/pattern types, and produce final diff per learnings file

**Trigger:** Phase 2 completes (all 6 agents have submitted proposals)

**Instructions:**
1. Load all 6 proposal files from Phase 2
2. Within each function's proposals:
   - Identify overlapping or duplicate entries
   - Merge where appropriate (keeping best wording)
   - Ensure ID consistency (no ID conflicts)
   - Verify pattern type categorization is correct
   - Standardize domain tags (use existing tag vocabulary)
3. Cross-function check:
   - Flag if same learning appears in multiple functions (may indicate misattribution)
   - Suggest corrections if needed
4. Produce consolidated proposal set with clear file destinations

**Context References:**
- `.claude/memory/learnings-{task-id}-*-proposals.md` (all 6 files) [IMMEDIATE PREDECESSORS - REQUIRED]
- `.claude/skills/develop-learnings/resources/learnings-schema.md` [REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS (6 files)
**Token Budget:** 3,000-3,500 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
```markdown
# Consolidated Learning Proposals

## Summary
- Total proposals received: {count}
- Merged entries: {count}
- Final entries to add: {count}
- Entries to extend: {count}
- Entries skipped: {count}

## Final Proposals by Function and File

### clarification/heuristics.md
[Finalized entries]

### clarification/anti-patterns.md
[Finalized entries]

[Continue for all functions and files...]

## Consolidation Notes
- Merges performed: {list}
- Cross-function flags: {any issues found}
```

**Handoff Protocol:**
- Save output to `.claude/memory/learnings-{task-id}-consolidated.md`
- Pass control to Phase 4 (validation)

---

### PHASE 4: VALIDATION

**Agent:** quality-validator (VALIDATION function)

**Purpose:** Apply learnings-update rubric to ensure proposed learnings are accurate, non-duplicative, appropriately generalized, and concise

**Trigger:** Phase 3 completes successfully

**Instructions:**
1. Load consolidated proposals from Phase 3
2. Apply learnings-update rubric (see resources/learnings-update-rubric.md):
   - **Generalizability:** Entry is reusable beyond specific task (not task-specific details)
   - **Accuracy:** True reflection of what actually happened in task
   - **Non-contradiction:** Doesn't conflict with existing learnings
   - **Conciseness:** Token-efficient, follows compression techniques
   - **Proper Categorization:** Correct function, correct pattern type
   - **Complete Schema:** All required fields present
3. For each entry, assign: PASS | FAIL with specific feedback
4. Overall decision:
   - If all entries PASS → proceed to Phase 5 (commit)
   - If any FAIL → single remediation loop (return to relevant agent with feedback)
5. Token budget check: Ensure INDEX sections will remain under 300 tokens after additions

**Context References:**
- `.claude/memory/learnings-{task-id}-consolidated.md` [IMMEDIATE PREDECESSOR - REQUIRED]
- `.claude/skills/develop-learnings/resources/learnings-update-rubric.md` [REQUIRED]
- `.claude/memory/task-{id}-memory.md` (for accuracy verification) [REQUIRED]

**Context Scope:** IMMEDIATE_PREDECESSORS + TASK_METADATA
**Token Budget:** 2,500-3,000 tokens (context loading)
**Johari Output Limit:** 1,200 tokens maximum

**Output Format:**
```markdown
# Validation Report

## Overall Decision: PASS | FAIL

## Entry-by-Entry Results

### {Function}/{File} - {ID}: {Title}
- Status: PASS | FAIL
- Generalizability: {score} - {feedback}
- Accuracy: {score} - {feedback}
- Non-contradiction: {score} - {feedback}
- Conciseness: {score} - {feedback}
- Proper Categorization: {score} - {feedback}
- Complete Schema: {score} - {feedback}
- Issues: {specific problems if FAIL}

[Repeat for each entry]

## Token Budget Check
- Current INDEX sizes: {per function}
- Projected INDEX sizes after additions: {per function}
- Status: WITHIN_BUDGET | EXCEEDS_BUDGET

## Remediation Required (if FAIL)
- Entries needing revision: {list}
- Feedback for agents: {specific guidance}
```

**Handoff Protocol:**
- Save output to `.claude/memory/learnings-{task-id}-validation.md`
- If PASS: Pass control to Phase 5 (commit)
- If FAIL: Return to relevant agents from Phase 2 with specific feedback, run ONE remediation loop, then re-validate

---

### PHASE 5: COMMIT

**Agent:** Penny (direct execution, not cognitive agent)

**Purpose:** Write or append approved learnings to appropriate learnings files

**Trigger:** Phase 4 validation returns PASS

**Instructions:**
1. Load consolidated proposals and validation report
2. For each entry marked PASS:
   - Determine target file path
   - Read current file contents
   - If ADD: Append to appropriate section
   - If EXTEND: Find existing entry and update
   - Update INDEX section with new entry reference
   - Write updated file
3. Track all file modifications
4. Report completion with summary

**Context References:**
- `.claude/memory/learnings-{task-id}-consolidated.md` [REQUIRED]
- `.claude/memory/learnings-{task-id}-validation.md` [REQUIRED]

**Output Format:**
```markdown
# Learnings Committed

## Files Modified
- `.claude/learnings/clarification/heuristics.md` (+2 entries)
- `.claude/learnings/research/anti-patterns.md` (+1 entry)
[...]

## Entries Added/Extended
- C-H-008: {title}
- R-A-004: {title}
[...]

## Summary
- Total entries committed: {count}
- Files touched: {count}
- Task learnings capture: COMPLETE
```

**Handoff Protocol:**
- Report completion to user
- Clean up temporary memory files (optional)
- Workflow ends

---

## STATE MANAGEMENT

### PERSISTENT STATE

```json
{
  "workflow_id": "learnings-{task-id}",
  "current_phase": "discovery|authoring|consolidation|validation|commit",
  "task_id": "{source-task-id}",
  "discovery_complete": false,
  "authoring_agents_completed": [],
  "consolidation_complete": false,
  "validation_status": "pending|pass|fail",
  "remediation_count": 0,
  "files_to_modify": []
}
```

### STATE TRANSITIONS

- **User invoke** → Phase 1 (Discovery)
- **Phase 1 complete** → Phase 2 (Authoring - sequential agent invocations)
- **Phase 2 complete (all 6 agents)** → Phase 3 (Consolidation)
- **Phase 3 complete** → Phase 4 (Validation)
- **Phase 4 PASS** → Phase 5 (Commit)
- **Phase 4 FAIL (remediation_count < 1)** → Phase 2 (targeted re-authoring)
- **Phase 4 FAIL (remediation_count >= 1)** → Report failure, halt
- **Phase 5 complete** → End workflow

---

## DECISION TREES

### DECISION POINT 1: Candidate Record Attribution

**Context:** Phase 1 - Determining which cognitive function resolved an Unknown

**Logic:**
```
IF Unknown resolved primarily through clarifying requirements/questions
  THEN → Attribute to clarification function

ELSE IF Unknown resolved through information gathering/research
  THEN → Attribute to research function

ELSE IF Unknown resolved through pattern recognition/decomposition
  THEN → Attribute to analysis function

ELSE IF Unknown resolved through design/integration decisions
  THEN → Attribute to synthesis function

ELSE IF Unknown resolved during implementation/creation
  THEN → Attribute to generation function

ELSE IF Unknown resolved through quality checks/testing
  THEN → Attribute to validation function

ELSE
  THEN → Flag for manual review (ambiguous attribution)
```

### DECISION POINT 2: Entry Action (ADD/EXTEND/SKIP)

**Context:** Phase 2 - Each agent deciding what to do with candidate

**Logic:**
```
IF candidate is too task-specific and not generalizable
  THEN → SKIP with reason

ELSE IF candidate duplicates existing learning entry
  THEN → SKIP with reason "duplicate of {existing-id}"

ELSE IF candidate enhances/refines existing learning entry
  THEN → EXTEND {existing-id} with additional details

ELSE IF candidate is novel and generalizable
  THEN → ADD as new entry

ELSE
  THEN → Flag for manual review
```

### DECISION POINT 3: Validation Outcome

**Context:** Phase 4 - Deciding next action based on validation

**Logic:**
```
IF all entries PASS AND token budgets OK
  THEN → Proceed to Phase 5 (Commit)

ELSE IF any entries FAIL AND remediation_count == 0
  THEN → Return to Phase 2 with feedback for specific agents
  THEN → Increment remediation_count
  THEN → Re-run authoring for failed entries only

ELSE IF any entries FAIL AND remediation_count >= 1
  THEN → Report persistent issues
  THEN → Halt workflow
  THEN → Require manual intervention

ELSE IF token budgets EXCEED
  THEN → Request INDEX compression
  THEN → Return to Phase 3 for re-consolidation
```

---

## ERROR HANDLING

### ERROR RECOVERY MATRIX

| Error Type | Detection | Recovery Strategy | Fallback |
|------------|-----------|-------------------|----------|
| Task memory not found | Phase 1 load fails | Prompt user for correct task-id | Halt workflow |
| No resolved Unknowns | Phase 1 analysis | Report "no learnings to extract" | End gracefully |
| Agent proposal empty | Phase 2 check | Continue (agent had no generalizable learnings) | Skip to next agent |
| All proposals skipped | Phase 3 check | Report "no learnings met generalization criteria" | End gracefully |
| Validation fails twice | Phase 4 remediation | Report specific issues to user | Require manual review |
| Token budget exceeded | Phase 4 check | Require INDEX compression first | Halt until compressed |
| File write error | Phase 5 commit | Report error, rollback if possible | Manual file editing |

---

## USAGE EXAMPLES

### SCENARIO 1: Standard Workflow Completion

**Context:** User completed a "postgres-migration" task using develop-project skill

**Interaction:**
```
User: "Use develop-learnings to capture learnings from postgres-migration task"

Penny: Initiating develop-learnings skill for task: postgres-migration

Phase 1: Discovery (analysis-agent)
- Loaded task memory for postgres-migration
- Identified 12 Unknowns, 9 resolved, 3 still open
- Generated 15 candidate learning records across 4 functions
  - research: 6 candidates
  - analysis: 4 candidates
  - synthesis: 3 candidates
  - generation: 2 candidates

Phase 2: Per-function Authoring (6 agents)
- research-discovery: Proposed 4 entries (2 heuristics, 2 domain-snippets)
- analysis-agent: Proposed 3 entries (2 heuristics, 1 anti-pattern)
- synthesis-agent: Proposed 2 entries (1 heuristic, 1 checklist item)
- generation-agent: Proposed 1 entry (1 anti-pattern)
- clarification-specialist: No proposals (no candidates)
- quality-validator: No proposals (no candidates)

Phase 3: Consolidation (synthesis-agent)
- Merged 2 overlapping research heuristics
- Standardized domain tags: [security, databases, postgresql]
- Final count: 9 entries to add

Phase 4: Validation (quality-validator)
- All 9 entries: PASS
- Token budget check: WITHIN_BUDGET
- Overall: PASS

Phase 5: Commit (Penny)
- Modified 6 files across 4 cognitive functions
- Added 9 new learning entries
- Updated INDEX sections

Result: Successfully captured 9 reusable learnings from postgres-migration task
```

### SCENARIO 2: Remediation Loop Triggered

**Context:** Some proposed learnings are too task-specific

**Interaction:**
```
User: "Use develop-learnings for api-integration task"

Penny: Initiating develop-learnings skill for task: api-integration

[Phases 1-3 complete normally]

Phase 4: Validation (quality-validator)
- 5 entries PASS
- 3 entries FAIL:
  - R-H-012: Too task-specific (mentions specific API endpoint)
  - A-H-015: Missing rationale field
  - G-A-008: Contradicts existing G-A-003
- Overall: FAIL - Remediation required

Phase 2 (Remediation): Re-authoring
- research-discovery: Generalized R-H-012 (removed specific endpoint, focused on pattern)
- analysis-agent: Added rationale to A-H-015
- generation-agent: Revised G-A-008 to align with existing G-A-003

[Phase 3 & 4 repeated]

Phase 4: Validation (quality-validator) - Second Pass
- All 8 entries: PASS
- Overall: PASS

Phase 5: Commit (Penny)
- Modified 5 files across 3 cognitive functions
- Added 8 new learning entries

Result: Successfully captured learnings after single remediation loop
```

### SCENARIO 3: No Generalizable Learnings

**Context:** Task completed but learnings too specific to generalize

**Interaction:**
```
User: "Use develop-learnings for quick-fix-typo task"

Penny: Initiating develop-learnings skill for task: quick-fix-typo

Phase 1: Discovery (analysis-agent)
- Loaded task memory for quick-fix-typo
- Identified 2 Unknowns, 2 resolved
- Generated 2 candidate learning records
  - generation: 2 candidates

Phase 2: Per-function Authoring
- generation-agent: Both candidates SKIPPED (too task-specific, not reusable)

Phase 3: Consolidation (synthesis-agent)
- No proposals to consolidate
- Report: No generalizable learnings

Result: Workflow ended gracefully - task was too simple/specific to yield reusable learnings
```

---

## PERFORMANCE CONSIDERATIONS

- **Expected execution time:** 5-15 minutes depending on task complexity
- **Context window usage:**
  - Phase 1: ~15-20% (full task context)
  - Phase 2: ~10-15% per agent (6 sequential invocations)
  - Phase 3: ~15-20% (all proposals)
  - Phase 4: ~15-20% (validation)
  - Phase 5: ~5% (file writes)
- **Token efficiency:**
  - Agents see INDEX sections only (not full learnings files) - saves ~2,000-5,000 tokens per agent
  - Progressive disclosure pattern maintained
  - Johari summaries limited to 1,200 tokens maximum
- **Optimal execution:** Sequential agent invocation required (no parallelization)

---

## DEPENDENCIES

### REQUIRED SKILLS

None (this skill is self-contained)

### REQUIRED RESOURCES

- `.claude/skills/develop-learnings/resources/learnings-schema.md` - Learning entry template
- `.claude/skills/develop-learnings/resources/learnings-update-rubric.md` - Validation criteria
- `.claude/skills/develop-learnings/resources/candidate-extraction-guidelines.md` - How to identify learnings

### REQUIRED DIRECTORY STRUCTURE

```
.claude/learnings/
├── clarification/
│   ├── heuristics.md
│   ├── anti-patterns.md
│   ├── checklists.md
│   └── domain-snippets/
├── research/
│   ├── heuristics.md
│   ├── anti-patterns.md
│   ├── checklists.md
│   └── domain-snippets/
├── analysis/
│   ├── heuristics.md
│   ├── anti-patterns.md
│   ├── checklists.md
│   └── domain-snippets/
├── synthesis/
│   ├── heuristics.md
│   ├── anti-patterns.md
│   ├── checklists.md
│   └── domain-snippets/
├── generation/
│   ├── heuristics.md
│   ├── anti-patterns.md
│   ├── checklists.md
│   └── domain-snippets/
└── validation/
    ├── heuristics.md
    ├── anti-patterns.md
    ├── checklists.md
    └── domain-snippets/
```

---

## TESTING PROTOCOL

1. **Test Case 1: Standard completion with multiple functions**
   - Use task with resolved Unknowns across 3+ cognitive functions
   - Expected: Learnings distributed appropriately, all phases complete successfully

2. **Test Case 2: Remediation loop**
   - Use task with intentionally task-specific learnings
   - Expected: Validation fails, remediation loop triggers, second pass succeeds

3. **Test Case 3: No generalizable learnings**
   - Use simple task (typo fix, trivial update)
   - Expected: Workflow ends gracefully with "no generalizable learnings" message

4. **Test Case 4: Token budget management**
   - Use task that would generate many learnings
   - Expected: INDEX sections stay under 300 tokens, validation checks budgets

5. **Test Case 5: Cross-function attribution**
   - Use task where Unknown resolution spans multiple functions
   - Expected: Consolidation phase correctly attributes or splits learning

---

## MAINTENANCE NOTES

### Guidelines for updating this skill:

1. **Adding new pattern types:** Update learnings-schema.md first, then modify Phase 2 agent instructions to include new pattern type
2. **Changing validation rubric:** Update learnings-update-rubric.md, ensure Phase 4 instructions reference updated criteria
3. **Modifying INDEX token limits:** Update Phase 4 token budget check logic and document new limits
4. **Adding new cognitive functions:** Update Phase 1 attribution logic, Phase 2 to include new agent, update directory structure requirements
5. **Optimizing consolidation:** Modify Phase 3 synthesis-agent instructions, maintain merging logic

---

## KEY PRINCIPLES

1. **Agent Ownership:** Each cognitive agent maintains its own learnings, not Penny
2. **Orchestration Only:** Skill defines WHAT and WHEN, not HOW
3. **Token Efficiency:** Progressive disclosure with INDEX + targeted lookup
4. **Generalization Focus:** Task-specific details excluded, reusable patterns emphasized
5. **Single Remediation:** One feedback loop maximum to avoid infinite cycling
6. **Sequential Execution:** All agent invocations must be sequential
7. **Johari Alignment:** Learnings capture resolved Unknown quadrant discoveries

---

## SUCCESS METRICS

- Learnings are immediately usable by agents in future tasks
- Token budgets remain within limits (INDEX < 300 tokens)
- Generalization rate > 60% (candidates → committed entries)
- No duplicate learnings across functions
- Validation pass rate > 80% on first attempt
- Agent ownership model maintained (no cross-function writes)
