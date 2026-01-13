# Integration Criteria Guidelines

## Purpose

This document provides detailed guidance for evaluating whether a proposed learning should be integrated into a skill or protocol file as a permanent rule, or remain as a standalone learning reference.

## Integration Decision Framework

### The Four Integration Criteria

A learning should be integrated into a skill/protocol ONLY if it meets ALL FOUR criteria:

#### 1. Universal Applicability (>70% threshold)

**Definition:** Does this learning apply to the majority (>70%) of tasks that this cognitive agent performs?

**Evaluation Questions:**
- Is this pattern relevant to most use cases, or only specific domains?
- Would this apply to general-purpose tasks or only specialized scenarios?
- Does this span multiple domains, or is it limited to one?

**Examples:**
- ✅ UNIVERSAL: "Use absolute imports in Python" - applies to 100% of Python projects
- ❌ DOMAIN-SPECIFIC: "Use PostgreSQL advisory locks for distributed transactions" - applies to ~30% of database projects

**Scoring:**
- 90-100%: Strongly universal
- 70-89%: Universal enough for integration
- <70%: Too domain-specific, keep as standalone learning

#### 2. Blocking Impact

**Definition:** Would ignoring this learning cause systematic failures, critical errors, or significant quality degradation?

**Evaluation Questions:**
- What happens if an agent ignores this pattern?
- Does it cause build failures, runtime errors, or security vulnerabilities?
- Is this a "nice-to-have" or a "must-have"?

**Examples:**
- ✅ BLOCKING: "Install tools as service user, not root" - causes installation failures
- ❌ NON-BLOCKING: "Consider using connection pooling for performance" - improves performance but system still functions

**Scoring:**
- Critical: Causes hard failures (build errors, crashes, security breaches)
- High: Causes systematic quality issues or maintainability problems
- Medium: Best practice but system functions without it
- Low: Optimization or preference, not essential

**Integrate if: Critical or High**

#### 3. Concise Rule

**Definition:** Can this learning's core principle be expressed as a single, clear rule in 1-2 sentences suitable for a skill instruction?

**Evaluation Questions:**
- Can I express this as a simple imperative statement?
- Does this require extensive explanation or a decision tree?
- Is there a clear, actionable rule, or is it nuanced guidance?

**Examples:**
- ✅ CONCISE: "Always use absolute imports starting from package root (from src.module)"
- ❌ TOO COMPLEX: "Choose between ProtectHome=true, read-only, or omit based on home directory location, write requirements, and security needs..." (requires decision tree)

**Test:** If the rule requires more than 3 bullet points to express in a skill, it's too complex for integration.

#### 4. Core Workflow

**Definition:** Is this learning fundamental to the agent's cognitive function execution, or is it peripheral/advisory guidance?

**Evaluation Questions:**
- Is this core to how this agent performs its function?
- Would this be in the "critical path" of the agent's workflow?
- Is this about the agent's primary responsibility or a secondary concern?

**Examples:**
- ✅ CORE (generation): "Use HTTP/SSE transport for MCP servers" - core to generating functional servers
- ❌ PERIPHERAL (generation): "Consider adding telemetry for observability" - valuable but not core to generation function

**Cognitive Function Mapping:**
- **Clarification:** Requirements gathering, ambiguity resolution, user interaction
- **Research:** Information discovery, source evaluation, knowledge synthesis
- **Analysis:** Pattern recognition, decomposition, structural analysis
- **Synthesis:** Design integration, architecture decisions, component composition
- **Generation:** Code/artifact creation, implementation patterns, structural generation
- **Validation:** Quality verification, testing, standards compliance

## Integration Decision Logic

```
FOR each learning:

1. Evaluate Universal Applicability
   IF <70% → STANDALONE (stop evaluation)

2. Evaluate Blocking Impact
   IF Low or Medium → STANDALONE (stop evaluation)

3. Evaluate Concise Rule
   IF cannot express in 1-2 sentences → STANDALONE (stop evaluation)

4. Evaluate Core Workflow
   IF peripheral to function → STANDALONE (stop evaluation)

5. IF all 4 criteria = YES
   THEN → INTEGRATE
   AND determine target file (skill or protocol)
   AND draft concise rule text
   AND identify insertion point
```

## Integration Specification Requirements

When marking a learning for INTEGRATE, you MUST provide:

1. **Target File:** Specific skill or protocol file path
2. **Target Location:** Phase number, section, subsection, or instruction number
3. **Proposed Rule Addition:** Exact text to add (1-2 sentences)
4. **Integration Rationale:** Brief explanation of why this strengthens the skill
5. **Learning Reference:** Note that detailed rationale/examples remain in learning

**Example Integration Specification:**

```markdown
### G-H-001: Use Absolute Imports Only in Python Projects

**Integration Decision:** INTEGRATE

**Integration Criteria Met:**
- Universal Applicability: YES - 100% of Python projects
- Blocking Impact: YES - causes ImportError, pytest failures
- Concise Rule: YES - "Use absolute imports starting from package root (from src.module)"
- Core Workflow: YES - fundamental to generating functional Python code

**Integration Specification:**
- Target File: `${CAII_DIRECTORY}/.claude/skills/develop-mcp-server/SKILL.md`
- Target Location: Phase 4 (Core Implementation), Instructions, Step 3
- Proposed Rule Addition:
  ```
  - **CRITICAL: Use ONLY absolute imports - NO relative imports allowed** (see G-H-001)
    - Pattern: `from src.module import Item`
    - NEVER use: `from .module` or `from ..module`
    - See `${CAII_DIRECTORY}/.claude/learnings/generation/heuristics.md` for detailed rationale
  ```
- Integration Rationale: Prevents systematic import errors across all generated Python projects; blocks workflow if violated
- Learning Reference: G-H-001 retains detailed failure modes, examples, validation commands
```

## Standalone Classification

Learnings should remain STANDALONE when they provide:

1. **Domain-Specific Guidance:** Applies to <70% of agent's tasks
   - Example: PostgreSQL-specific patterns, AWS-specific configurations

2. **Advisory Best Practices:** Non-blocking optimizations or preferences
   - Example: Performance tuning suggestions, code style preferences

3. **Complex Decision Trees:** Requires extensive conditional logic
   - Example: "Choose security hardening based on threat model, deployment environment, compliance requirements..."

4. **Troubleshooting Information:** Primarily for debugging or edge cases
   - Example: "If you see error X, check Y" patterns

5. **Peripheral Guidance:** Related to function but not core workflow
   - Example: Documentation suggestions, optional tooling

## Common Edge Cases

### Case: Learning applies to 75% but only in specific domains

**Decision:** Evaluate the 70% threshold within the agent's general-purpose scope, not domain subsets.

**Example:** "Use connection pooling for database clients" might apply to 90% of database-related tasks, but only 40% of generation's overall tasks → STANDALONE

### Case: Learning is universal but very complex to express

**Decision:** STANDALONE - complexity overrides universality

**Example:** Systemd ProtectHome decision tree (G-DS-001) is universal for deployment but requires extensive conditional logic → STANDALONE (even though it applies to 100% of systemd services)

### Case: Learning is both core AND peripheral to different functions

**Decision:** Integrate into the function where it's CORE, reference from functions where it's peripheral

**Example:** "Validate API credentials before making requests" might be:
- CORE for generation → INTEGRATE
- PERIPHERAL for research → STANDALONE + reference

### Case: Learning seems to meet all criteria but skill already has similar rule

**Decision:** Check for redundancy first. If existing rule covers this:
- Mark as STANDALONE with note: "Already covered by existing skill rule"
- Consider if learning extends/clarifies existing rule → may warrant rule enhancement

## Philosophy: Skills + Learnings Relationship

**Remember:** The goal is NOT to eliminate learnings by integrating everything. The goal is to:

1. **Extract essential rules** that ALL agents must follow (WHAT)
2. **Retain contextual wisdom** that explains rationale, consequences, examples (WHY)
3. **Create complementary resources:**
   - Skills: Concise checklists for execution
   - Learnings: Detailed references for understanding

**Most learnings should remain standalone.** Integration is for the ~20% of patterns that are:
- Universal across all tasks
- Blocking if ignored
- Simple enough for a rule
- Core to the function

This maintains lean, scannable skills while preserving rich knowledge in learnings.

## Validation Checklist

Before finalizing integration decisions:

- [ ] All INTEGRATE decisions have ALL 4 criteria marked YES
- [ ] All INTEGRATE decisions include complete integration specification
- [ ] Proposed rule additions are concise (1-2 sentences)
- [ ] Target files and locations are specific and valid
- [ ] STANDALONE decisions note which criteria failed
- [ ] No duplicate integrations (check existing skill content first)
- [ ] Integration ratio reasonable (~20-30% integrate, 70-80% standalone)
