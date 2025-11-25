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

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessors:** All prior agents in task workflow

**Additional Resources:**
- `.claude/skills/develop-learnings/resources/candidate-extraction-guidelines.md` [REQUIRED]
- `.claude/skills/develop-learnings/resources/learnings-schema.md` [REQUIRED]

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/task-{id}-analysis-agent-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "MULTIPLE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

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

**Context Loading (per agent):** IMMEDIATE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessor:** analysis-agent (Phase 1 discovery)

**Additional Resources (per agent):**
- `.claude/learnings/{function}/heuristics.md` (INDEX section only) [REQUIRED]
- `.claude/learnings/{function}/anti-patterns.md` (INDEX section only) [REQUIRED]
- `.claude/learnings/{function}/checklists.md` (INDEX section only) [REQUIRED]
- `.claude/skills/develop-learnings/resources/learnings-schema.md` [REQUIRED]

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output (per agent):**
- Write to: `.claude/memory/learnings-{task-id}-{function}-proposals.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "IMMEDIATE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

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
- After all 6 agents complete, pass all proposal files to Phase 2.5

---

### PHASE 2.5: INTEGRATION ANALYSIS

**Agent:** synthesis-agent (SYNTHESIS function)

**Purpose:** Evaluate proposed learnings to determine which should be integrated directly into skills/protocols as permanent rules vs. remaining as standalone learning references

**Trigger:** Phase 2 complete (all 6 agents have submitted proposals)

**Instructions:**
1. Load all 6 proposal files from Phase 2
2. For EACH proposed learning entry, evaluate integration potential using these criteria:
   - **Universal Applicability:** Does this apply to ALL or MOST tasks this agent performs? (>70% of cases)
   - **Blocking Impact:** Would ignoring this cause systematic failures or quality degradation?
   - **Concise Rule:** Can this be expressed as a single sentence rule in a skill/protocol?
   - **Core Workflow:** Is this fundamental to the agent's cognitive function execution?
3. For learnings meeting integration criteria (all 4 YES):
   - Designate as INTEGRATE
   - Identify target file (skill or protocol)
   - Draft specific rule addition with location (phase, section, instruction number)
   - Format: "In [file] [section], add: [rule text]"
4. For learnings NOT meeting criteria:
   - Designate as STANDALONE
   - Note which criteria failed (provides rationale)
   - These remain as learnings only (not integrated into skills)
5. For learnings marked INTEGRATE:
   - Specify proposed modification to skill/protocol
   - Identify exact insertion point
   - Explain how this strengthens the skill
   - Note: Actual file modifications happen AFTER learnings are committed (Phase 5.5)

**Integration Decision Checklist:**

```
For each learning entry:

UNIVERSAL APPLICABILITY (>70% of agent's tasks)?
├─ YES → Continue evaluation
└─ NO → STANDALONE (too domain-specific)

BLOCKING IMPACT (causes failures if ignored)?
├─ YES → Continue evaluation
└─ NO → STANDALONE (nice-to-have, not critical)

CONCISE RULE (expressible in 1-2 sentences)?
├─ YES → Continue evaluation
└─ NO → STANDALONE (too complex for skill rule)

CORE WORKFLOW (fundamental to function execution)?
├─ YES → INTEGRATE
└─ NO → STANDALONE (peripheral guidance)
```

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessors:** All 6 agents from Phase 2 (clarification, research, analysis, synthesis, generation, validation proposals)

**Additional Resources:**
- `.claude/skills/develop-learnings/resources/learnings-schema.md` [REQUIRED]
- `.claude/skills/develop-learnings/resources/integration-criteria.md` [REQUIRED]

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/learnings-{task-id}-integration-analysis.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "MULTIPLE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**Output Format:**
```markdown
# Integration Analysis Report

## Summary
- Total learnings evaluated: {count}
- Recommended for integration: {count}
- Remaining as standalone: {count}

## Integration Recommendations by Function

### clarification

#### C-H-008: {Title}
- **Decision:** INTEGRATE
- **Integration Criteria Met:**
  - Universal Applicability: YES - applies to {X}% of clarification tasks
  - Blocking Impact: YES - {specific failure mode}
  - Concise Rule: YES - "{one-sentence rule}"
  - Core Workflow: YES - {justification}
- **Target File:** `.claude/skills/develop-project/SKILL.md`
- **Target Location:** Phase 1 (Clarification), Instructions, Step 4
- **Proposed Rule Addition:**
  ```
  4a. {Concise rule derived from learning principle}
  ```
- **Rationale:** {Why this strengthens the skill}
- **Learning Metadata Update:**
  - Add field: `integration_status: "integrated"`
  - Add field: `integrated_into: [".claude/skills/develop-project/SKILL.md:Phase1:Step4"]`

#### C-A-012: {Title}
- **Decision:** STANDALONE
- **Integration Criteria Not Met:**
  - Universal Applicability: NO - applies to only ~40% of cases (domain-specific to {domain})
  - Blocking Impact: YES
  - Concise Rule: YES
  - Core Workflow: NO - peripheral guidance, not fundamental
- **Rationale:** Valuable as reference but too domain-specific for universal skill rule
- **Learning Metadata Update:**
  - Add field: `integration_status: "standalone"`

[Repeat for all learnings across all functions...]

### research
[Same format...]

### analysis
[Same format...]

### synthesis
[Same format...]

### generation
[Same format...]

### validation
[Same format...]

## Integration Summary by Target File

### `.claude/skills/develop-project/SKILL.md`
- Total integration points: {count}
- Phases affected: {list}
- Proposed additions: {brief list}

### `.claude/protocols/agent-protocol-core.md`
- Total integration points: {count}
- Sections affected: {list}
- Proposed additions: {brief list}

[Continue for all affected files...]

## Metadata Schema Update Required

Add to learnings-schema.md:

**New Optional Fields:**
- **integration_status:** One of: `standalone`, `integrated`, `pending_integration`
- **integrated_into:** List of files and locations where this learning was integrated
  - Format: `["file-path:section:subsection", ...]`
  - Example: `[".claude/skills/develop-project/SKILL.md:Phase1:Step4"]`

## Next Steps

1. Proceed to Phase 3 (Consolidation) with integration decisions attached to each learning
2. After Phase 5 (Commit learnings files), proceed to Phase 5.5 (Post-Integration Cleanup)
3. Phase 5.5 will apply approved integrations to skill/protocol files
```

**Handoff Protocol:**
- Save output to `.claude/memory/learnings-{task-id}-integration-analysis.md`
- Attach integration decisions to consolidated proposals
- Pass control to Phase 3 (Consolidation) with integration metadata

---

### PHASE 3: CONSOLIDATION

**Agent:** synthesis-agent (SYNTHESIS function)

**Purpose:** Merge overlapping entries across all function proposals, ensure consistent IDs/tags/pattern types, and produce final diff per learnings file

**Trigger:** Phase 2.5 completes (integration analysis finished)

**Instructions:**
1. Load all 6 proposal files from Phase 2 and integration analysis from Phase 2.5
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

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessors:** All 6 agents from Phase 2 (clarification, research, analysis, synthesis, generation, validation proposals)

**Additional Resources:**
- `.claude/skills/develop-learnings/resources/learnings-schema.md` [REQUIRED]

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/learnings-{task-id}-synthesis-agent-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "MULTIPLE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

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

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessors:** synthesis-agent (Phase 3), plus task metadata for accuracy verification

**Additional Resources:**
- `.claude/skills/develop-learnings/resources/learnings-update-rubric.md` [REQUIRED]

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/learnings-{task-id}-quality-validator-memory.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "MULTIPLE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

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

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessors:** synthesis-agent (Phase 3), quality-validator (Phase 4)

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Note:** Phase 5 is executed by Penny directly (orchestrator), not by a cognitive agent. No memory file output required for this phase.

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
- Pass control to Phase 5.5 (Post-Integration Cleanup)

---

### PHASE 5.5: POST-INTEGRATION CLEANUP

**Agent:** analysis-agent (ANALYSIS function)

**Purpose:** After learnings are committed, apply approved skill/protocol integrations and evaluate which learnings should be archived or removed based on redundancy

**Trigger:** Phase 5 completes successfully (learnings committed to files)

**Instructions:**

**Part A: Apply Skill/Protocol Integrations**

1. Load integration analysis from Phase 2.5
2. For each learning marked INTEGRATE with approved status:
   - Read target skill/protocol file
   - Locate specified insertion point
   - Apply proposed rule addition
   - Verify integration doesn't conflict with existing rules
   - Update learning entry with integration_status and integrated_into fields
3. Create summary of all files modified with integration points

**Part B: Learning Retention Evaluation**

4. For EACH committed learning entry (now in learnings files):
   - Load learning content + integration status
   - Apply retention decision criteria (see below)
   - Classify as: KEEP | ARCHIVE | REMOVE
5. Generate retention recommendations with specific rationale

**Retention Decision Criteria:**

```
For each committed learning:

Was this learning INTEGRATED into a skill/protocol?
├─ NO → KEEP (primary reference, not redundant)
└─ YES → Continue evaluation

Does the learning provide WHY/CONTEXT beyond the skill rule's WHAT?
├─ YES → KEEP (adds valuable rationale/examples/failure-modes)
└─ NO → Continue evaluation

Does the learning include:
  - Detailed rationale explaining why the rule matters?
  - Concrete examples showing pattern in action?
  - Failure modes describing consequences?
  - Domain-specific nuances not in skill?
├─ YES to any → KEEP (provides context beyond rule)
└─ NO to all → Continue evaluation

Is the learning's principle identical to the integrated rule with no additional value?
├─ YES → REMOVE (truly redundant, no value beyond skill)
└─ NO → ARCHIVE (marginal value, preserve for history)
```

**IMPORTANT:** Default bias is KEEP. Only REMOVE if learning is truly redundant (provides zero value beyond what's now in the skill). Most integrated learnings should KEEP because they provide the WHY and CONTEXT that skills cannot include due to token constraints.

**Context Loading:** MULTIPLE_PREDECESSORS (see `.claude/protocols/context-loading-patterns.md`)
**Predecessors:** Penny (Phase 5 commit), synthesis-agent (Phase 2.5 integration analysis)

**Additional Resources:**
- `.claude/skills/develop-learnings/resources/retention-criteria.md` [REQUIRED]
- `.claude/learnings/{function}/{file}.md` (newly committed entries) [REQUIRED]

**Protocol References:**
- `.claude/protocols/agent-protocol-core.md` [ALWAYS]

**Memory Output:**
- Write to: `.claude/memory/learnings-{task-id}-post-integration.md`
- **Format: Markdown with JSON Johari Window** (NOT XML)
- See `.claude/references/johari.md` for format specification
- Token Limit: 1200 tokens for Johari section

**CRITICAL OUTPUT FORMAT:**
Your memory file MUST be Markdown format with JSON code blocks.
DO NOT use XML wrapper tags like `<agent_output>` or `<metadata>`.

Required structure:
```
## Context Loaded
```json
{
  "workflow_metadata_loaded": true,
  "context_loading_pattern_used": "MULTIPLE_PREDECESSORS",
  "total_context_tokens": 1200,
  "verification_status": "PASSED"
}
```

## Johari Summary
```json
{
  "open": "What I know that coordinator knows...",
  "hidden": "What I discovered...",
  "blind": "What I need but don't have...",
  "unknown": "What neither of us knows yet..."
}
```
```

**Output Format:**
See `.claude/references/johari.md` for complete Johari Window format

**Output Format:**
```markdown
# Post-Integration Cleanup Report

## Part A: Skill/Protocol Integrations Applied

### Summary
- Total integration points: {count}
- Files modified: {count}
- Integration success rate: {count successful / count attempted}

### Integrations Applied

#### `.claude/skills/develop-project/SKILL.md`

**Integration 1: C-H-008 → Phase 1, Step 4a**
- **Learning:** C-H-008 - {Title}
- **Rule Added:** "{Concise rule text}"
- **Location:** Phase 1 (Clarification), Instructions, Step 4a
- **Status:** SUCCESS
- **Learning Updated:** integration_status = "integrated", integrated_into added

**Integration 2: R-H-015 → Phase 2, Step 3b**
[Same format...]

[Continue for all integrations in this file...]

#### `.claude/protocols/agent-protocol-core.md`
[Same format for protocol integrations...]

### Integration Failures (if any)
- {Learning ID}: {Reason for failure} → MANUAL REVIEW REQUIRED

## Part B: Learning Retention Evaluation

### Summary
- Total learnings evaluated: {count}
- Recommended to KEEP: {count} ({percentage}%)
- Recommended to ARCHIVE: {count} ({percentage}%)
- Recommended to REMOVE: {count} ({percentage}%)

### Retention Decisions by Function

#### clarification/heuristics.md

**C-H-008: {Title}**
- **Integration Status:** integrated → `.claude/skills/develop-project/SKILL.md:Phase1:Step4a`
- **Retention Decision:** KEEP
- **Rationale:**
  - Learning provides detailed rationale: "{excerpt from rationale field}"
  - Learning includes concrete example: "{excerpt from example field}"
  - Learning explains failure mode: "{excerpt from failure_mode field}"
  - Skill rule provides WHAT, learning provides WHY/CONTEXT - complementary, not redundant
- **Value Beyond Skill Rule:** Agents benefit from understanding the reasoning and consequences, not just the rule itself

**C-H-009: {Title}**
- **Integration Status:** standalone
- **Retention Decision:** KEEP
- **Rationale:**
  - Not integrated into any skill (primary reference)
  - Provides actionable guidance for future tasks
- **Value:** Essential reference for clarification agents

**C-A-012: {Title}**
- **Integration Status:** integrated → `.claude/skills/develop-project/SKILL.md:Phase1:Step5`
- **Retention Decision:** REMOVE
- **Rationale:**
  - Principle: "{principle}" is identical to integrated rule
  - No additional rationale beyond "this is the rule"
  - No example provided
  - No failure mode details
  - Truly redundant - provides zero value beyond skill rule
- **Action:** Remove from learnings file, update INDEX

[Continue for all learnings in all files...]

### Retention Summary by Decision

#### KEEP (Recommended: {count} learnings)
- C-H-008, C-H-009, R-H-015, R-H-020, A-H-011, S-H-007, G-A-004, V-H-009
- Rationale: Provide context, examples, rationale beyond integrated rules OR are standalone references

#### ARCHIVE (Recommended: {count} learnings)
- R-D-025, A-D-018
- Rationale: Marginal value, highly domain-specific but integrated. Preserve for historical reference but move to archive.

#### REMOVE (Recommended: {count} learnings)
- C-A-012
- Rationale: Truly redundant with integrated skill rules, no additional value

## Cleanup Actions Required

### Files to Modify
1. `.claude/learnings/clarification/anti-patterns.md`
   - Remove entry: C-A-012
   - Update INDEX: remove C-A-012 reference

[Continue for all files with REMOVE decisions...]

### Archive Operations
[If any learnings marked ARCHIVE]
1. Create archive directory: `.claude/learnings/archive/`
2. Move entries: R-D-025, A-D-018 to archive with date stamp

## Metadata Updates Applied

For all integrated learnings (KEEP decision):
- Updated `integration_status: "integrated"`
- Added `integrated_into: ["{file}:{section}:{subsection}"]`
- Preserved all original fields (rationale, example, failure_mode)

## Verification

### Integration Verification Checklist
- [ ] All approved integrations applied to target files
- [ ] No integration conflicts with existing rules
- [ ] All integrated learnings have updated metadata
- [ ] Modified skill/protocol files maintain formatting

### Retention Verification Checklist
- [ ] Every committed learning has retention decision
- [ ] REMOVE decisions have strong justification (truly redundant)
- [ ] KEEP decisions for integrated learnings explain added value
- [ ] Default bias toward KEEP maintained (most learnings retained)

## Summary

### Overall Impact
- **Skills Enhanced:** {count} skills/protocols improved with {count} new rules
- **Learnings Retained:** {count} learnings provide ongoing value as references
- **Redundancy Eliminated:** {count} truly redundant learnings removed
- **Knowledge Density:** System now has both actionable rules (skills) AND contextual wisdom (learnings)

### Philosophy Maintained
- Skills provide WHAT to do (concise rules for execution)
- Learnings provide WHY and CONTEXT (rationale, examples, consequences)
- Both are complementary, not duplicative
- Agents benefit from having both rule (immediate action) and learning (deeper understanding)
```

**Handoff Protocol:**
- Save output to `.claude/memory/learnings-{task-id}-post-integration.md`
- Apply approved REMOVE actions to learnings files
- Report completion with summary of integrations and cleanup
- Workflow ends

---

## STATE MANAGEMENT

### PERSISTENT STATE

```json
{
  "workflow_id": "learnings-{task-id}",
  "current_phase": "discovery|authoring|integration-analysis|consolidation|validation|commit|post-integration",
  "task_id": "{source-task-id}",
  "discovery_complete": false,
  "authoring_agents_completed": [],
  "integration_analysis_complete": false,
  "integration_decisions": {},
  "consolidation_complete": false,
  "validation_status": "pending|pass|fail",
  "remediation_count": 0,
  "files_to_modify": [],
  "commit_complete": false,
  "integrations_to_apply": [],
  "post_integration_complete": false
}
```

### STATE TRANSITIONS

- **User invoke** → Phase 1 (Discovery)
- **Phase 1 complete** → Phase 2 (Authoring - sequential agent invocations)
- **Phase 2 complete (all 6 agents)** → Phase 2.5 (Integration Analysis)
- **Phase 2.5 complete** → Phase 3 (Consolidation)
- **Phase 3 complete** → Phase 4 (Validation)
- **Phase 4 PASS** → Phase 5 (Commit)
- **Phase 4 FAIL (remediation_count < 1)** → Phase 2 (targeted re-authoring)
- **Phase 4 FAIL (remediation_count >= 1)** → Report failure, halt
- **Phase 5 complete** → Phase 5.5 (Post-Integration Cleanup)
- **Phase 5.5 complete** → End workflow

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

### DECISION POINT 4: Integration Decision

**Context:** Phase 2.5 - Determining if a learning should be integrated into skills/protocols

**Logic:**
```
FOR each proposed learning entry:

IF Universal Applicability < 70% of agent's tasks
  THEN → STANDALONE (too domain-specific for universal skill rule)

ELSE IF Blocking Impact = NO (nice-to-have, not critical)
  THEN → STANDALONE (not essential enough for skill integration)

ELSE IF Concise Rule = NO (requires >2 sentences or complex explanation)
  THEN → STANDALONE (too complex for skill rule, better as learning reference)

ELSE IF Core Workflow = NO (peripheral guidance, not fundamental to function)
  THEN → STANDALONE (helpful but not core to agent's cognitive function)

ELSE IF all criteria = YES (Universal + Blocking + Concise + Core)
  THEN → INTEGRATE
    AND identify target skill/protocol
    AND draft specific rule addition
    AND specify insertion point
    AND explain strengthening rationale

ELSE
  THEN → Flag for manual review (edge case)
```

### DECISION POINT 5: Retention Decision

**Context:** Phase 5.5 - Determining if committed learning should be KEPT, ARCHIVED, or REMOVED

**Logic:**
```
FOR each committed learning:

IF learning was NOT integrated (integration_status = "standalone")
  THEN → KEEP (automatic, no further evaluation needed)

ELSE IF learning provides detailed rationale beyond skill rule
  THEN → KEEP (adds WHY context)

ELSE IF learning includes concrete examples or code samples
  THEN → KEEP (illustrative value)

ELSE IF learning documents failure modes or consequences
  THEN → KEEP (troubleshooting value)

ELSE IF learning includes domain-specific nuances or decision trees
  THEN → KEEP (contextual guidance)

ELSE IF learning has historical/metadata value (source tasks, unknowns)
  THEN → KEEP (preserves discovery context)

ELSE IF learning is highly domain-specific with marginal value
  THEN → ARCHIVE (historical reference only)

ELSE IF learning principle identical to skill rule with NO additional value
  THEN → REMOVE (truly redundant)

ELSE (uncertain)
  THEN → KEEP (default bias toward retention)
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

### SCENARIO 4: Standard Workflow with Integration

**Context:** User completed "api-security-review" task and wants to capture learnings with skill integration

**Interaction:**
```
User: "Use develop-learnings to capture learnings from api-security-review task"

Penny: Initiating develop-learnings skill for task: api-security-review

Phase 1: Discovery (analysis-agent)
- Loaded task memory for api-security-review
- Identified 8 Unknowns, 7 resolved, 1 still open
- Generated 12 candidate learning records across 3 functions
  - research: 5 candidates
  - analysis: 4 candidates
  - validation: 3 candidates

Phase 2: Per-function Authoring (6 agents)
- research-discovery: Proposed 3 entries (2 heuristics, 1 anti-pattern)
- analysis-agent: Proposed 3 entries (2 heuristics, 1 checklist)
- validation-agent: Proposed 2 entries (1 heuristic, 1 checklist)
- Other agents: No proposals (no candidates)

Phase 2.5: Integration Analysis (synthesis-agent)
- Evaluated 8 proposed learnings for integration potential
- Integration recommendations:
  - R-H-025 (Cross-verify security sources): INTEGRATE → develop-project Phase 2, Step 3
    - Universal: YES (95% of research tasks)
    - Blocking: YES (prevents security misconfigurations)
    - Concise: YES ("Cross-verify security requirements from ≥2 authoritative sources")
    - Core: YES (fundamental to research function)
  - A-H-031 (Threat modeling before design): INTEGRATE → develop-project Phase 3, Step 2
  - V-H-018 (Security-specific validation): INTEGRATE → develop-project Phase 6, Step 4
  - R-A-008 (Outdated blog reliance): STANDALONE (valuable but covered by R-H-025 integration)
  - A-C-015 (Security analysis checklist): STANDALONE (too domain-specific, applies to ~40% of tasks)
  - V-C-009 (Security validation checklist): STANDALONE (too complex for single rule)
  - Remaining 2: STANDALONE
- Summary: 3 learnings marked for integration, 5 remain as standalone references

Phase 3: Consolidation (synthesis-agent)
- Merged integration decisions into consolidated proposals
- All 8 entries retain learning status
- 3 entries flagged for skill integration after commit
- Final count: 8 entries to add

Phase 4: Validation (quality-validator)
- All 8 entries: PASS
- Token budget check: WITHIN_BUDGET
- Integration decisions reviewed: APPROVED
- Overall: PASS

Phase 5: Commit (Penny)
- Modified 5 files across 3 cognitive functions
- Added 8 new learning entries (all with integration_status field)
- Updated INDEX sections
- Integration metadata attached to 3 entries

Phase 5.5: Post-Integration Cleanup (analysis-agent)

Part A: Apply Integrations
- Applied 3 skill integrations:
  1. develop-project/SKILL.md Phase 2, Step 3b: Added R-H-025 rule
  2. develop-project/SKILL.md Phase 3, Step 2a: Added A-H-031 rule
  3. develop-project/SKILL.md Phase 6, Step 4c: Added V-H-018 rule
- Updated 3 learning entries: integration_status = "integrated", integrated_into added
- All integrations: SUCCESS

Part B: Retention Evaluation
- Evaluated 8 committed learnings:
  - KEEP: 7 learnings
    - R-H-025 (integrated): KEEP - provides detailed rationale + example + failure mode beyond skill rule
    - A-H-031 (integrated): KEEP - includes threat modeling examples and specific failure scenarios
    - V-H-018 (integrated): KEEP - detailed security validation techniques beyond simple rule
    - R-A-008 (standalone): KEEP - primary reference, not integrated
    - A-C-015 (standalone): KEEP - domain-specific checklist, valuable reference
    - V-C-009 (standalone): KEEP - complex validation checklist
    - Remaining 1 standalone: KEEP
  - REMOVE: 0 learnings (none truly redundant)
- Cleanup: No files to modify, all learnings provide value beyond integrated rules

Result: Successfully captured 8 reusable learnings + integrated 3 critical patterns into develop-project skill
- Skills now have concise rules (WHAT to do)
- Learnings provide context (WHY it matters, examples, failure modes)
- System improved with both immediate guidance and deeper understanding
```

---

## PERFORMANCE CONSIDERATIONS

- **Expected execution time:** 5-20 minutes depending on task complexity
- **Context window usage:**
  - Phase 1: ~15-20% (full task context)
  - Phase 2: ~10-15% per agent (6 sequential invocations)
  - Phase 2.5: ~15-20% (integration analysis across all proposals)
  - Phase 3: ~15-20% (consolidation with integration metadata)
  - Phase 4: ~15-20% (validation)
  - Phase 5: ~5% (file writes)
  - Phase 5.5: ~10-15% (apply integrations + retention evaluation)
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
