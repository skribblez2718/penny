# Candidate Extraction Guidelines

## Purpose

This guide helps the analysis in Phase 1 (Discovery) identify which resolved Unknowns should become candidate learning records, and how to map them to the appropriate cognitive function and pattern type.

## Core Principle

**Not all resolved Unknowns become learnings.** Learnings should capture **reusable patterns** that will help agents perform better in future tasks. Task-specific facts and one-off discoveries should be filtered out during candidate extraction.

## Extraction Criteria

### Include as Candidate IF:

1. **Pattern Recognition:** The Unknown resolution revealed a repeatable pattern, approach, or principle
   - Example: "Always check X before doing Y" (heuristic)
   - Example: "Don't assume X when Y" (anti-pattern)

2. **Generalizable Discovery:** The resolution applies to a class of situations, not just this task
   - Test: Would this help in ≥5 future similar tasks?
   - If yes → candidate

3. **Non-Obvious Insight:** The resolution wasn't immediately apparent; required discovery/learning
   - If everyone would know this → not a learning
   - If we had to figure it out → potential learning

4. **Actionable Guidance:** The resolution can be formulated as actionable advice
   - Can be phrased as: "When X, do Y" or "Avoid Z because..."
   - If it's just a fact → not a learning (unless it's a critical fact worth remembering)

5. **Quality Impact:** Following this learning would prevent errors or improve outcomes
   - Ask: Would ignoring this lead to problems?
   - If yes → strong candidate

### Exclude as Candidate IF:

1. **Task-Specific Fact:** Resolution is a one-time fact with no reusable pattern
   - Example: "The API key for service X is ABC123" → not a learning
   - Example: "Service X rate limit is 100 req/min" → not a learning (unless pattern emerges)

2. **Common Knowledge:** Resolution is widely known or obvious
   - Example: "APIs require authentication" → too basic
   - But: "API authentication should be tested with expired tokens" → potential learning

3. **No Clear Action:** Resolution doesn't suggest what to do differently
   - If it's just "we learned X exists" without implications → weak candidate

4. **Trivial Resolution:** Unknown was resolved immediately without meaningful discovery process
   - Simple lookups → usually not learnings
   - Deep research or analysis → more likely to be learnings

5. **Already Documented:** Resolution is already captured in existing learnings
   - Check: Does this duplicate an existing heuristic/anti-pattern?
   - If yes → exclude (or mark as EXTEND existing)

## Cognitive Function Attribution

For each candidate, identify which cognitive function was primarily responsible for resolving the Unknown. Use this decision tree:

### Decision Tree

```
Unknown was resolved through...

├─ Asking clarifying questions, resolving ambiguity, defining terms
│  → CLARIFICATION function
│
├─ Gathering information, research, finding sources, discovering facts
│  → RESEARCH function
│
├─ Breaking down complexity, identifying patterns, decomposing problems, assessing risks
│  → ANALYSIS function
│
├─ Designing solutions, integrating components, making architectural decisions, combining insights
│  → SYNTHESIS function
│
├─ Creating artifacts, writing code, generating content, implementing designs
│  → GENERATION function
│
└─ Testing, verifying, quality checking, validating against standards
   → VALIDATION function
```

### Attribution Guidelines

**Primary Responsibility Rule:** Attribute to the function that did the main work of resolving the Unknown, not where it was first discovered or last mentioned.

**Example 1:**
- Unknown: "What SSL mode should we use?"
- Clarification: Identified uncertainty
- Research: Found documentation on SSL modes
- Synthesis: Decided on specific mode based on requirements
- **Attribution:** RESEARCH (research found the answer)

**Example 2:**
- Unknown: "How should we structure the database schema?"
- Research: Gathered examples
- Analysis: Decomposed requirements into entities/relationships
- Synthesis: Designed final schema
- **Attribution:** SYNTHESIS (synthesis made the design decision)

**Example 3:**
- Unknown: "Is the generated code secure?"
- Generation: Created code
- Validation: Identified XSS vulnerability
- **Attribution:** VALIDATION (validation discovered the security issue)

**Ambiguous Cases:**
- If resolution spans multiple functions equally: Choose the function where the *actionable insight* emerged
- If still unclear: Default to ANALYSIS (pattern recognition is often the key discovery)
- Flag for manual review in discovery output

## Pattern Type Classification

For each candidate, classify into one of four pattern types:

### 1. Heuristic

**Definition:** A "how to do it well" rule - approach that works, strategy to follow, good practice

**Indicators:**
- Prescriptive (tells you what TO do)
- Positive framing ("Do X", "Use Y", "Check Z")
- Decision strategy or approach
- Rule of thumb

**Examples:**
- "Prefer primary sources for security research"
- "Cross-verify facts from ≥2 independent sources"
- "Test edge cases during validation"

**Trigger Phrases in Resolution:**
- "We should always..."
- "The best approach is..."
- "It works well to..."
- "Effective strategy: ..."

### 2. Anti-Pattern

**Definition:** A "what NOT to do" warning - mistake to avoid, problematic approach, pitfall

**Indicators:**
- Proscriptive (tells you what NOT to do)
- Negative framing ("Don't X", "Avoid Y", "Never Z")
- Describes a mistake or problem
- Usually includes "better alternative"

**Examples:**
- "Don't assume configuration defaults are secure"
- "Avoid single-source research for security decisions"
- "Never skip validation for generated code"

**Trigger Phrases in Resolution:**
- "We made the mistake of..."
- "Problem was caused by..."
- "Failed because we..."
- "Should not have..."

### 3. Checklist

**Definition:** A pre-flight or post-flight list - items to verify before/after a cognitive task

**Indicators:**
- List structure (multiple checkable items)
- Verification steps
- Quality gates
- Pre-conditions or post-conditions

**Examples:**
- "Research verification checklist: [ ] primary source, [ ] version check, [ ] cross-reference..."
- "Code generation readiness: [ ] requirements clear, [ ] architecture defined, [ ] patterns selected..."

**Trigger Phrases in Resolution:**
- "We should have checked..."
- "Verification steps: ..."
- "Before X, ensure..."
- "To avoid this, verify..."

### 4. Domain-Snippet

**Definition:** Domain-specific guidance - only relevant in particular technology, industry, or specialized context

**Indicators:**
- Mentions specific technology (PostgreSQL, React, AWS)
- Industry-specific (legal, medical, finance)
- Highly specialized domain
- Limited applicability outside domain (<30% of tasks)

**Examples:**
- "PostgreSQL SSL configuration nuances"
- "AWS RDS parameter group gotchas"
- "React Hook dependency array patterns"

**Trigger Phrases in Resolution:**
- Technology/tool names prominent
- "In [specific domain]..."
- "When using [specific technology]..."

**Storage:** Domain-snippets go in separate files: `learnings/{function}/domain-snippets/{domain}.md`

## Candidate Record Construction

For each candidate, build a record with these fields:

### Required Fields

```markdown
### Candidate {N}

**unknown_id:** {U-ID}
**cognitive_function:** {clarification|research|analysis|synthesis|generation|validation}
**pattern_type:** {heuristic|anti-pattern|checklist|domain-snippet}

**Context:** {1-2 sentences: when this Unknown was encountered}
**Resolution:** {How the Unknown was resolved and what we learned}
**Reuse Scope:** {general | domain-specific: [{domain-tags}]}
**Risk if Ignored:** {What could go wrong if this pattern is not followed}

**Evidence:**
- Agent output: {file reference where resolution occurred}
- Key quote: "{brief excerpt showing resolution}"
```

### Example Candidate Record

```markdown
### Candidate 3

**unknown_id:** U5
**cognitive_function:** research
**pattern_type:** heuristic

**Context:** When researching PostgreSQL SSL configuration requirements, initial blog posts gave conflicting guidance. Uncertainty about which source to trust.
**Resolution:** Consulting official PostgreSQL documentation revealed that sslmode (client) and ssl_mode (server) are distinct parameters often conflated in tutorials. Primary source provided authoritative, version-specific guidance.
**Reuse Scope:** general
**Risk if Ignored:** Relying on secondary sources for security-critical configurations increases risk of misconfig uration or insecure defaults.

**Evidence:**
- Agent output: task-postgres-migration-research-memory.md
- Key quote: "Official PostgreSQL docs (v14) clarify that client sslmode and server ssl_mode serve different purposes. Tutorials often conflate these, leading to confusion."
```

## Discovery Output Structure

Phase 1 (Discovery) should produce:

```markdown
# Discovery Summary

## Workflow Overview
- Task ID: {task-id}
- Domain: {domain}
- Cognitive sequence used: {sequence}
- Duration: {time period}

## Unknowns Analysis
- Total unknowns discovered: {count}
- Total unknowns resolved: {count}
- Total unknowns still open: {count}

## Extraction Statistics
- Unknowns examined for learning potential: {count}
- Candidates extracted: {count}
- Excluded (task-specific facts): {count}
- Excluded (common knowledge): {count}
- Excluded (trivial resolutions): {count}

## Candidate Learnings by Function

### clarification (Count: {n})

#### Candidate 1
[Record structure as above]

#### Candidate 2
[Record structure as above]

[Continue for each candidate in this function]

### research (Count: {n})
[Candidates for research function]

### analysis (Count: {n})
[Candidates for analysis function]

### synthesis (Count: {n})
[Candidates for synthesis function]

### generation (Count: {n})
[Candidates for generation function]

### validation (Count: {n})
[Candidates for validation function]

## Ambiguous Attributions
[Flag any candidates where cognitive function attribution was unclear]

## Manual Review Recommended
[Flag any edge cases or complex situations needing human judgment]
```

## Quality Checks for Discovery Phase

Before passing to Phase 2, verify:

- [ ] Each candidate has all required fields
- [ ] Cognitive function attribution is justified
- [ ] Pattern type classification makes sense
- [ ] Evidence links to actual task files
- [ ] Reuse scope assessment is reasonable
- [ ] Task-specific details are flagged for removal (agents will do this in Phase 2)
- [ ] No obvious duplicates with existing learnings
- [ ] Candidates are distributed across functions (if applicable)
- [ ] Extraction statistics add up correctly

## Common Extraction Mistakes

### Mistake 1: Including Task-Specific Facts

**Bad Candidate:**
> "U7 - The database password for production is stored in AWS Secrets Manager key 'prod-db-pass'"

**Why Bad:** This is a one-time fact with no reusable pattern

**Better:** Skip this or generalize:
> "U7 - Secrets should be stored in secure vault (e.g., AWS Secrets Manager) not in config files"

### Mistake 2: Overly Broad Attribution

**Bad:**
> "This Unknown was resolved by multiple agents so attribute to ALL functions"

**Why Bad:** Dilutes ownership, makes it hard to know where learning belongs

**Better:** Identify PRIMARY resolver:
> "Research found the information, but Synthesis made the decision → attribute to SYNTHESIS"

### Mistake 3: Wrong Pattern Type

**Bad:**
> Heuristic: "Don't use weak SSL modes"

**Why Bad:** This is negatively framed (what NOT to do) → should be Anti-pattern

**Better:**
> Anti-pattern: "Avoid weak SSL modes (SSLv3, TLS 1.0)"
> Alternative: "Use TLS 1.2 or higher"

### Mistake 4: No Evidence Trail

**Bad:**
> "Resolution: We learned that X is better than Y"
> Evidence: [none provided]

**Why Bad:** Can't verify accuracy in validation phase

**Better:**
> "Resolution: Analysis showed X had O(n) performance while Y was O(n²)"
> Evidence:
> - Agent output: task-xyz-analysis-memory.md
> - Key quote: "Performance analysis reveals..."

### Mistake 5: Extracting Noise

**Bad:**
> Including trivial resolutions like "U3 - Found the documentation URL"

**Why Bad:** Finding a URL isn't a learning, it's just task progress

**Better:** Only extract if there's a pattern:
> "U3 - Official documentation is more reliable than blogs for security configs (used official docs to resolve SSL confusion)"

## Advanced Considerations

### Multi-Function Resolutions

Sometimes an Unknown is resolved through collaboration:

**Example:**
- Research: Gathered data
- Analysis: Identified pattern
- Synthesis: Made decision

**Approach:**
1. Identify where the key insight emerged
2. Attribute to that function
3. In candidate "Evidence" section, note the collaborative nature
4. Alternative: Create separate candidates for different insights (one per function)

### Negative Learnings

When Unknown resolution revealed what DIDN'T work:

**Approach:**
- These become Anti-patterns
- Example: "We tried X, it failed because Y" → Anti-pattern: "Avoid X when Y"
- Ensure "alternative" field suggests better approach

### Checklist Emergence

When multiple related Unknowns resolved through systematic checks:

**Approach:**
- Group related Unknowns into single checklist candidate
- Example: U5, U7, U9 all resolved by verifying different aspects of SSL config
- Candidate: "SSL Configuration Verification Checklist" covering all items

### Domain-Specific Threshold

**Rule:** If learning applies to <30% of future tasks in that cognitive function, mark as domain-specific

**How to Assess:**
- General: Would help in research/analysis/etc. regardless of domain
- Domain-specific: Only helps when working with that technology/industry

**Example:**
- General: "Cross-verify security requirements from multiple sources"
- Domain-specific: "PostgreSQL ssl_mode vs sslmode distinction"
