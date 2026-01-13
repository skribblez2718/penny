# Learnings Update Rubric

## Purpose

This rubric provides validation with specific criteria for evaluating proposed learning entries before they're committed to the learnings files. The goal is to ensure learnings are accurate, reusable, token-efficient, and properly categorized.

## Evaluation Criteria

### 1. Generalizability

**Question:** Is this entry reusable beyond the specific task that generated it?

**PASS Indicators:**
- Removes task-specific details (exact names, values, endpoints)
- Focuses on repeatable pattern, not one-off instance
- Situation description matches potential future scenarios
- Principle can be applied to multiple similar cases
- Would help agents in ≥5 future tasks (reasonable estimate)

**FAIL Indicators:**
- Contains task-specific names, IDs, or exact values
- Principle only applies to one unique scenario
- Overly narrow situation description
- Reads like a task log entry, not a learning
- Example: "Set SSL=1 in connection string for task #42" (too specific)

**Scoring:**
- **EXCELLENT:** Broadly applicable across domain, clear pattern
- **GOOD:** Applies to common scenarios within domain
- **ACCEPTABLE:** Applies to specific but recurring situations (domain-tagged appropriately)
- **POOR:** Limited reusability, needs more generalization
- **UNACCEPTABLE:** Task-specific details prevent reuse

**Remediation Guidance (if FAIL):**
- Remove specific names/values, replace with pattern descriptions
- Broaden situation to match category of scenarios
- Focus on "when X type of situation" not "when task Y occurred"

---

### 2. Accuracy

**Question:** Does this entry truly reflect what happened in the source task?

**PASS Indicators:**
- Traceable to specific Unknown resolution in task memory
- Principle matches what actually worked/failed
- Rationale aligns with agent outputs and decisions made
- Example (if included) is authentic, not hypothetical
- Source tasks and origin unknowns correctly cited

**FAIL Indicators:**
- Invented or hypothetical pattern (not from actual task)
- Principle contradicts what actually happened
- Misattributes resolution to wrong cognitive function
- Rationale doesn't match task evidence
- Fabricated example

**Scoring:**
- **EXCELLENT:** Perfectly traceable to task evidence, well-documented
- **GOOD:** Clear connection to task events
- **ACCEPTABLE:** Generally accurate with minor ambiguities
- **POOR:** Loose connection to task, some inaccuracies
- **UNACCEPTABLE:** Contradicts task evidence or fabricated

**Remediation Guidance (if FAIL):**
- Review specific agent outputs and Unknown resolutions
- Quote or reference actual task decisions/discoveries
- Verify cognitive function attribution is correct
- Remove hypothetical elements, stick to what happened

---

### 3. Non-Contradiction

**Question:** Does this entry conflict with existing learnings or system principles?

**PASS Indicators:**
- No contradiction with existing learnings in same function
- Aligns with system architecture principles (see DA.md)
- Compatible with cognitive function's role
- If overlaps with existing entry, proposes EXTEND not duplicate ADD
- Doesn't contradict learnings in other functions

**FAIL Indicators:**
- Directly contradicts existing heuristic/checklist
- Violates system principles (e.g., "skip validation for speed")
- Misaligned with cognitive function's purpose
- Duplicates existing entry without adding value
- Creates logical conflict between learnings

**Scoring:**
- **EXCELLENT:** Fully compatible, enriches existing body of learnings
- **GOOD:** No conflicts, integrates smoothly
- **ACCEPTABLE:** Minor tension but reconcilable
- **POOR:** Some contradiction, needs revision
- **UNACCEPTABLE:** Direct contradiction or violation of principles

**Remediation Guidance (if FAIL):**
- Compare against INDEX of existing learnings
- Check if this should EXTEND existing entry instead
- Revise principle to align with system architecture
- Consult DA.md and agent-registry.md for role alignment

---

### 4. Conciseness

**Question:** Is this entry token-efficient while remaining clear and useful?

**PASS Indicators:**
- Total entry under 250 tokens
- Situation: 20-40 tokens
- Principle: 20-50 tokens
- Rationale: 30-60 tokens
- Example (if present): 40-100 tokens
- No filler words or redundant content
- Active voice, tight phrasing
- One example maximum (if any)

**FAIL Indicators:**
- Total entry exceeds 300 tokens
- Verbose or repetitive phrasing
- Multiple examples when one suffices
- Passive voice inflating word count
- Redundant information between fields
- Includes information already in ID/title

**Scoring:**
- **EXCELLENT:** ≤200 tokens, maximally clear and concise
- **GOOD:** 201-250 tokens, efficient phrasing
- **ACCEPTABLE:** 251-275 tokens, could be tighter but acceptable
- **POOR:** 276-300 tokens, needs compression
- **UNACCEPTABLE:** >300 tokens, excessive verbosity

**Remediation Guidance (if FAIL):**
- Apply compression techniques from learnings-schema.md
- Remove filler words: "it is important to", "should be noted that"
- Use active voice: "verify settings" not "settings should be verified"
- Trim examples to most illustrative single case
- Combine redundant sentences

---

### 5. Proper Categorization

**Question:** Is this entry in the right function, with the right pattern type?

**PASS Indicators:**
- Cognitive function matches where Unknown was resolved
- Pattern type fits content:
  - Heuristic = "how to do X well"
  - Anti-pattern = "avoid doing Y"
  - Checklist = "verify these items"
  - Domain-snippet = domain-specific, stored appropriately
- Domain tags applied correctly (general vs. specific)
- Stored in correct file (heuristics.md vs. anti-patterns.md vs. checklists.md)

**FAIL Indicators:**
- Assigned to wrong cognitive function
- Heuristic phrased as anti-pattern (or vice versa)
- Checklist without checkable items
- General learning tagged as domain-specific (or vice versa)
- Domain-snippet in main file instead of domain-snippets/ directory

**Scoring:**
- **EXCELLENT:** Perfect categorization, right function + type + storage
- **GOOD:** Correct with minor tagging improvements possible
- **ACCEPTABLE:** Mostly correct, small adjustments needed
- **POOR:** Wrong pattern type or function
- **UNACCEPTABLE:** Completely miscategorized

**Remediation Guidance (if FAIL):**
- Review Unknown resolution: which agent actually resolved it?
- Check pattern type definitions in learnings-schema.md
- Convert between heuristic/anti-pattern if needed (flip positive/negative framing)
- Add domain tags if learning is domain-specific (<30% reuse)
- Move to domain-snippets/ if highly specialized

---

### 6. Complete Schema

**Question:** Are all required fields present and properly formatted?

**PASS Indicators:**
- ID format: `{F}-{T}-{NNN}` (e.g., R-H-007)
- ID doesn't conflict with existing entries
- source_tasks list present
- origin_unknowns list present
- cognitive_function specified
- pattern_type specified
- situation field present (required)
- principle field present (required)
- rationale field present (required)
- Optional fields (example, failure_mode, alternative) included where appropriate

**FAIL Indicators:**
- Missing required field
- ID format incorrect
- ID conflicts with existing entry
- Empty or placeholder values
- Fields in wrong format (e.g., tags not in list)
- Anti-pattern missing "alternative" field

**Scoring:**
- **EXCELLENT:** All fields complete, perfectly formatted
- **GOOD:** All required fields, formatting correct
- **ACCEPTABLE:** All required fields, minor formatting issues
- **POOR:** Missing optional field that should be present
- **UNACCEPTABLE:** Missing required field(s) or major format errors

**Remediation Guidance (if FAIL):**
- Reference learnings-schema.md for complete field list
- Check INDEX for ID conflicts
- Add missing fields
- Format lists properly: [item1, item2, item3]
- For anti-patterns, add "alternative" field

---

## Special Considerations

### TOKEN BUDGET CHECK

**Critical:** After evaluating entries, verify INDEX sections won't exceed limits:

**Requirements:**
- INDEX section must remain under 300 tokens after additions
- Each INDEX entry: `{ID} - {one-line-description}` (~8-15 tokens)
- If additions would exceed 300 tokens:
  - FAIL validation with reason: "INDEX token budget exceeded"
  - Request consolidation or compression of INDEX
  - May need to archive old entries or create sub-indices

**Check Process:**
1. Count current INDEX tokens for affected files
2. Estimate tokens for new INDEX entries (~12 tokens average per entry)
3. Total = current + (new_entries × 12)
4. If total > 300: FAIL with compression request

---

### DOMAIN-SPECIFIC THRESHOLD

**Rule:** If learning applies to <30% of future tasks in that cognitive function, it should be domain-tagged and potentially moved to domain-snippets/

**Indicators for domain-snippet storage:**
- Technology-specific (PostgreSQL, React, AWS)
- Industry-specific (legal, medical, finance)
- Highly specialized domain (crypto, ML, embedded systems)
- Limited cross-domain applicability

**Borderline cases:** Domain-tag but keep in main file if useful for reference

---

## Overall Decision Logic

### PASS Decision

**Criteria:** ALL of the following:
1. All 6 criteria score ACCEPTABLE or better
2. No criteria score UNACCEPTABLE
3. TOKEN BUDGET CHECK passes
4. At least 4 criteria score GOOD or EXCELLENT

**Action:** Proceed to Phase 5 (Commit)

### FAIL Decision - Remediation Required

**Criteria:** ANY of the following:
1. Any criterion scores UNACCEPTABLE
2. More than 2 criteria score POOR
3. TOKEN BUDGET CHECK fails
4. Fewer than 3 criteria score ACCEPTABLE or better

**Action:**
- Identify failing entries and specific issues
- Return to originating cognitive agent(s) with detailed feedback
- Single remediation loop (re-author → re-validate)
- If second validation fails: Halt workflow, require manual intervention

### FAIL Decision - Persistent Issues

**Criteria:**
- Second validation after remediation still shows FAILs
- Fundamental issues that can't be resolved through revision

**Action:**
- Report specific persistent issues to user
- Halt workflow
- Require manual review and intervention

---

## Feedback Format

When returning feedback for remediation, use this structure:

```markdown
# Validation Feedback for {Function}

## Entry: {ID} - {Title}

**Overall:** PASS | FAIL

### Criterion Results:
- Generalizability: {score} - {specific feedback}
- Accuracy: {score} - {specific feedback}
- Non-Contradiction: {score} - {specific feedback}
- Conciseness: {score} ({token-count} tokens) - {specific feedback}
- Proper Categorization: {score} - {specific feedback}
- Complete Schema: {score} - {specific feedback}

### Required Changes:
1. {Specific actionable change}
2. {Specific actionable change}
[...]

### Suggested Revision:
{Optional: provide suggested wording for key fields}
```

---

## Examples

### Example 1: PASS - Excellent Entry

```markdown
### R-H-015: Cross-verify security requirements from multiple authoritative sources

- Source tasks: [api-security-audit-2025-11-18]
- Origin unknowns: [U4, U9]
- Domain tags: [security, research]
- Situation: When researching security requirements for system implementation.
- Principle: Cross-check security-critical requirements across ≥2 independent authoritative sources (official docs, standards bodies, security advisories).
- Rationale: Single-source guidance may contain errors, be outdated, or miss critical considerations; multi-source verification reduces risk.
- Failure mode: Implementing incomplete or incorrect security controls based on single-source guidance.
```

**Evaluation:**
- Generalizability: EXCELLENT - broadly applicable pattern
- Accuracy: EXCELLENT - traced to actual task discoveries
- Non-Contradiction: EXCELLENT - aligns with existing research principles
- Conciseness: EXCELLENT - 147 tokens, tight phrasing
- Proper Categorization: EXCELLENT - research heuristic, correctly tagged
- Complete Schema: EXCELLENT - all fields present, formatted correctly

**Decision:** PASS

---

### Example 2: FAIL - Too Task-Specific

```markdown
### G-A-042: Don't use connection pooling for the users API endpoint

- Source tasks: [api-refactor-2025-11-20]
- Origin unknowns: [U12]
- Domain tags: [generation, api, nodejs]
- Situation: When implementing the /api/users endpoint in Node.js with Express.
- Anti-pattern: Using connection pooling for the users endpoint caused timeout issues.
- Rationale: Connection pooling added overhead for this specific endpoint.
- Failure mode: Timeouts on the /api/users endpoint.
- Alternative: Use direct connections without pooling for this endpoint.
```

**Evaluation:**
- Generalizability: UNACCEPTABLE - hyper-specific to one endpoint, not reusable
- Accuracy: ACCEPTABLE - did happen in task
- Non-Contradiction: POOR - contradicts general best practice without explaining why
- Conciseness: GOOD - 126 tokens
- Proper Categorization: ACCEPTABLE - generation anti-pattern is correct category
- Complete Schema: GOOD - all fields present

**Specific Issues:**
- "users API endpoint" - task-specific detail
- Principle contradicts best practices without clear reasoning
- Doesn't explain WHY pooling was problematic (load pattern? implementation bug?)
- Not generalizable to future tasks

**Required Changes:**
1. Generalize to pattern: "connection pooling inappropriate for X type of workload"
2. Explain WHY pooling was problematic (load characteristics, latency requirements)
3. Remove specific endpoint reference
4. Make principle reusable: when to avoid pooling vs. when to use it

**Decision:** FAIL - Remediation required

---

### Example 3: FAIL - Exceeds Token Budget

```markdown
### V-H-023: Comprehensive validation approach for generated artifacts

- Source tasks: [react-component-generator-2025-11-19]
- Origin unknowns: [U7, U8, U11]
- Domain tags: [validation, code-generation]
- Situation: When validating code artifacts generated by the generation, it's important to apply a comprehensive, multi-faceted validation approach that goes beyond simple syntax checking and includes semantic analysis, security considerations, performance implications, and alignment with architectural principles.
- Principle: A thorough validation process should include the following steps: first, verify syntactic correctness using appropriate linters and parsers; second, analyze semantic correctness by checking business logic alignment; third, assess security implications by scanning for common vulnerabilities and anti-patterns; fourth, evaluate performance characteristics and potential bottlenecks; and fifth, ensure alignment with system architecture and design patterns established in the project.
- Rationale: Generated code can easily contain subtle issues that simple syntax checking won't catch, such as security vulnerabilities, performance problems, or architectural misalignments. By applying a multi-layered validation approach, we can catch these issues before they reach production and cause problems. This is especially important for generated code because the generation process might not have full context of all system constraints and requirements. Comprehensive validation acts as a safety net.
- Example: In the React component generation task, initial syntax validation passed, but deeper semantic analysis revealed that the component wasn't handling edge cases properly, and security scanning found an XSS vulnerability in user input handling. Performance analysis also showed unnecessary re-renders. Without comprehensive validation, all these issues would have made it to production.
- Failure mode: Generated code with syntax errors, semantic issues, security vulnerabilities, or performance problems making it to production, causing bugs, security incidents, or degraded system performance.
```

**Evaluation:**
- Generalizability: GOOD - applies to validation broadly
- Accuracy: GOOD - reflects actual discoveries
- Non-Contradiction: EXCELLENT - aligns with validation principles
- Conciseness: UNACCEPTABLE - 345 tokens, way over limit
- Proper Categorization: EXCELLENT - validation heuristic, correct
- Complete Schema: EXCELLENT - all fields present

**Specific Issues:**
- Situation: 62 tokens (should be 20-40)
- Principle: 95 tokens (should be 20-50)
- Rationale: 98 tokens (should be 30-60)
- Example: 90 tokens (acceptable range but could be tighter)
- Total: 345 tokens (limit is 250)

**Required Changes:**
1. Compress situation to core context (remove filler words)
2. Condense principle to essence (list → core rule)
3. Tighten rationale (remove redundant explanations)
4. Trim example to single most illustrative issue
5. Target: reduce to ~200 tokens

**Suggested Revision (Situation):**
"When validating generated code artifacts."
(7 tokens vs. 62 tokens)

**Decision:** FAIL - Remediation required (conciseness)

---
