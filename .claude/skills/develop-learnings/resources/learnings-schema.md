# Learnings Entry Schema

## Purpose

This schema defines the structure for all learning entries across cognitive functions. Consistent schema ensures learnings are:
- Machine-parseable for progressive disclosure
- Human-readable for manual review
- Token-efficient for context loading
- Reusable across tasks and domains

## Entry Structure

### Metadata Fields

**Required:**

- **id:** Stable ID format: `[Function-Initial]-[Type-Initial]-[Number]`
  - Function codes: C (Clarification), R (Research), A (Analysis), S (Synthesis), G (Generation), V (Validation)
  - Type codes: H (Heuristic), A (Anti-pattern), C (Checklist), D (Domain-snippet)
  - Examples: `R-H-007`, `A-A-003`, `G-C-012`

- **source_tasks:** List of task-ids where this pattern was observed
  - Format: `[task-id-1, task-id-2, ...]`
  - Allows tracing learning back to origin

- **origin_unknowns:** List of Unknown Registry IDs that gave rise to this learning
  - Format: `[U3, U5, U12]`
  - Links learning to specific discoveries

- **cognitive_function:** One of: `clarification`, `research`, `analysis`, `synthesis`, `generation`, `validation`

- **pattern_type:** One of: `heuristic`, `anti-pattern`, `checklist`, `domain-snippet`

**Optional:**

- **domain_tags:** Tags for domain-specific context
  - Examples: `[security, databases, postgresql]`, `[career, interviews]`, `[api, rest, authentication]`
  - Enables targeted lookup in domain-snippets
  - Use existing tag vocabulary when possible

- **integration_status:** Tracks whether learning was integrated into skills/protocols (added during Phase 2.5)
  - Values: `standalone`, `integrated`, `pending_integration`
  - Default: `standalone`
  - Set to `integrated` after Phase 5.5 applies integration
  - Example: `integration_status: "integrated"`

- **integrated_into:** List of files and locations where this learning was integrated (added during Phase 5.5)
  - Format: `["{file-path}:{section}:{subsection}", ...]`
  - Only present if integration_status = "integrated"
  - Allows tracing learning to skill rules
  - Example: `integrated_into: ["${CAII_DIRECTORY}/.claude/skills/develop-project/SKILL.md:Phase2:Step3b"]`

### Body Fields

**Required:**

- **situation:** 1-2 sentences describing when this learning is relevant
  - Should be general enough to match future scenarios
  - Focus on context, not specific task details
  - Example: "When researching security best practices for a new technology stack"

- **principle:** One concise rule, insight, or pattern (heuristics/checklists) OR what to avoid (anti-patterns)
  - Must be actionable
  - Should be memorable
  - Typically 1-2 sentences maximum
  - Example (heuristic): "Always prioritize primary sources (official docs, standards bodies) over blogs when making security decisions"
  - Example (anti-pattern): "Avoid relying solely on blog posts for security-critical decisions"

- **rationale:** Why this matters, impact if followed/ignored
  - Keep tight (1-3 sentences)
  - Explain consequences
  - Example: "Secondary sources often omit edge cases or are outdated; primary docs define normative behavior"

**Optional:**

- **example:** 1 short, anonymized example showing pattern in action
  - Remove task-specific details
  - Focus on the pattern, not the specifics
  - Keep under 100 tokens
  - Example: "When researching PostgreSQL SSL requirements, official docs revealed mandatory settings that popular tutorials omitted"

- **failure_mode:** What goes wrong if this is ignored (especially important for anti-patterns and checklists)
  - Specific consequences
  - Example: "Increased risk of insecure defaults or misconfiguration"

- **alternative:** (Anti-patterns only) Better approach to use instead
  - What to do instead of the anti-pattern
  - Example: "Consult official documentation first, then use blogs for implementation examples only"

## Pattern Types

### Heuristic

**Definition:** A "how to think" pattern - rules of thumb, decision strategies, approaches that work well

**Use when:** Captured a repeatable decision pattern or approach

**Example (without integration):**
```markdown
### R-H-007: Prefer primary sources for security guidance

- Source tasks: [postgres-migration-2025-11-21]
- Origin unknowns: [U3, U5]
- Domain tags: [security, research]
- Situation: When researching security best practices for a new technology stack.
- Principle: Always prioritize primary sources (official docs, standards bodies) over blogs when making security decisions.
- Rationale: Secondary sources often omit edge cases or are outdated; primary docs define normative behavior.
- Failure mode: Increased risk of insecure defaults or misconfiguration if relying on outdated advice.
```

**Example (with integration metadata):**
```markdown
### G-H-001: Use absolute imports only in Python projects

- Source tasks: [task-mcp-1764008090]
- Origin unknowns: []
- Domain tags: [python, imports]
- Integration status: integrated
- Integrated into: ["${CAII_DIRECTORY}/.claude/skills/develop-mcp-server/SKILL.md:Phase4:Step3"]
- Situation: When generating Python code for any project structure.
- Principle: Always use absolute imports starting from the package root (from src.module), never relative imports.
- Rationale: Eliminates import path ambiguity, prevents ImportError in various execution contexts, enables proper pytest execution.
- Example: Use `from src.config import Config` not `from .config import Config`
- Failure mode: ImportError when running scripts directly, pytest collection failures, import errors in different contexts.
```

### Anti-Pattern

**Definition:** A mistake to avoid - common pitfalls, problematic approaches, things that went wrong

**Use when:** Encountered an error, mistake, or suboptimal approach worth documenting

**Example:**
```markdown
### A-A-005: Assuming similar technologies work identically

- Source tasks: [postgres-migration-2025-11-21]
- Origin unknowns: [U8]
- Domain tags: [analysis, databases]
- Situation: When analyzing migration between similar but different technologies (e.g., MySQL → PostgreSQL).
- Anti-pattern: Assuming configuration patterns from one technology directly apply to another.
- Rationale: Subtle differences in defaults, behavior, or requirements can cause critical failures.
- Example: PostgreSQL SSL enforcement differs from MySQL; assuming identical behavior led to initial connection failures.
- Failure mode: Deployment failures, security gaps, or performance issues from incorrect assumptions.
- Alternative: Explicitly research and document differences between technologies as part of analysis phase.
```

### Checklist

**Definition:** A pre-flight or post-flight checklist - items to verify before/after performing a task

**Use when:** Identified a sequence of checks that would prevent errors or ensure quality

**Example:**
```markdown
### V-C-003: Security research verification checklist

- Source tasks: [postgres-migration-2025-11-21, api-security-audit-2025-11-18]
- Origin unknowns: [U3, U5, U17]
- Domain tags: [validation, security, research]
- Situation: After researching security requirements for a technology implementation.
- Items:
  - [ ] Verified information from official documentation
  - [ ] Cross-checked with standards body recommendations (OWASP, NIST, etc.)
  - [ ] Confirmed version-specific requirements (not outdated)
  - [ ] Identified mandatory vs. recommended configurations
  - [ ] Documented source URLs and dates accessed
- Rationale: Systematic verification prevents security gaps from outdated or incorrect information.
- Failure mode: Implementing insecure configurations due to incomplete or incorrect research.
```

### Domain-Snippet

**Definition:** Domain-specific patterns, notes, or examples that don't fit general learnings

**Use when:** Learning is valuable but only within a specific domain context

**Storage:** Separate files in `domain-snippets/` directory named by domain (e.g., `security.md`, `postgresql.md`)

**Example:**
```markdown
### R-D-012: PostgreSQL SSL/TLS configuration research patterns

- Source tasks: [postgres-migration-2025-11-21]
- Origin unknowns: [U3, U5]
- Domain tags: [research, databases, postgresql, security]
- Situation: When researching PostgreSQL SSL/TLS connection requirements.
- Principle: PostgreSQL SSL configuration has three critical parameters often confused: ssl, sslmode (client), and ssl_mode (server). Official docs are essential because tutorials frequently conflate these.
- Rationale: Misconfiguration of SSL parameters is a common PostgreSQL deployment error with security implications.
- Example: Setting client `sslmode=require` doesn't enforce server SSL; server needs `ssl=on` in postgresql.conf.
- Failure mode: Believing connections are encrypted when they're not, or connection failures from mismatched settings.
```

## INDEX Section Format

Every learnings file must start with an INDEX section that gets loaded automatically:

```markdown
# {Function} {Pattern-Type}

## INDEX (Always Loaded)
<!-- Keep this section under 300 tokens -->
<!-- List: {ID} - One-line description -->

- R-H-001 - Prefer primary sources for security guidance
- R-H-002 - Cross-check facts across ≥2 independent sources
- R-H-007 - Verify version-specific requirements not outdated
[...]

---

## {Pattern-Type}

[Full entries below]
```

**INDEX Rules:**
- First 300 tokens of every learnings file
- One-line descriptions only (ID + brief title)
- Enables fast scanning for relevant patterns
- Triggers deep lookup when pattern matches

## Generalization Guidelines

### Good Generalization

**Characteristics:**
- Removes task-specific details (names, specific values, exact steps)
- Focuses on the pattern, not the instance
- Applicable to future similar situations
- Contains actionable guidance

**Example - Good:**
> "When researching security requirements, prioritize official documentation over blog posts to avoid outdated or incomplete information."

**Example - Bad (too specific):**
> "When setting up PostgreSQL on AWS RDS with SSL, set sslmode=require in the connection string and check the AWS RDS parameter group for SSL=1."

### Domain Tagging Strategy

**General learnings:** No domain tags or very broad tags
- Example: `[research]`, `[validation]`

**Domain-specific learnings:** Specific tags
- Example: `[security, databases, postgresql]`
- Example: `[career, technical-interviews, system-design]`

**Rule:** If learning applies to <30% of future tasks in that cognitive function, it needs domain tags and may belong in domain-snippets/

## Token Efficiency Guidelines

### Target Lengths

- **Situation:** 20-40 tokens
- **Principle:** 20-50 tokens
- **Rationale:** 30-60 tokens
- **Example:** 40-100 tokens (optional, skip if principle is self-evident)
- **Failure mode:** 20-40 tokens
- **Total per entry:** 100-250 tokens

### Compression Techniques

1. **Remove filler words:** "It is important to note that" → "Note:"
2. **Use active voice:** "Should be verified by" → "Verify"
3. **Abbreviate where clear:** "documentation" → "docs" (when context is clear)
4. **Avoid redundancy:** Don't repeat the ID/title in the body
5. **One example max:** Multiple examples → pick most illustrative

## Validation Checklist

Before submitting a learning entry, verify:

- [ ] ID follows format: `{F}-{T}-{NNN}`
- [ ] ID doesn't conflict with existing entries
- [ ] All required fields present
- [ ] Situation is generalizable (not task-specific)
- [ ] Principle is actionable (can be applied)
- [ ] Rationale explains why (not just what)
- [ ] Total token count under 250
- [ ] No duplication of existing learnings
- [ ] Appropriate pattern type selected
- [ ] Domain tags match existing vocabulary (if applicable)

## Common Mistakes to Avoid

### Mistake 1: Too Task-Specific

**Bad:**
> "Situation: When migrating the production users table from MySQL 5.7 to PostgreSQL 14 on AWS RDS..."

**Good:**
> "Situation: When analyzing migration requirements between SQL database systems..."

### Mistake 2: Not Actionable

**Bad:**
> "Principle: Documentation is useful."

**Good:**
> "Principle: Consult official documentation before secondary sources when researching critical configurations."

### Mistake 3: Too Vague

**Bad:**
> "Principle: Be careful when doing research."

**Good:**
> "Principle: Cross-check security-critical facts across ≥2 independent authoritative sources before implementing."

### Mistake 4: Duplicate Content

**Before adding:** Check INDEX for similar entries. If similar entry exists, consider EXTEND instead of ADD.

### Mistake 5: Wrong Pattern Type

- If it tells you what to do → Heuristic
- If it tells you what NOT to do → Anti-pattern
- If it's a list of checks → Checklist
- If it's only relevant in specific domain → Domain-snippet