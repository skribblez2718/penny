# Phase 6: Validation & Documentation

**Uses Atomic Skill:** `orchestrate-validation`
**Phase Type:** REMEDIATION

## Purpose

Validate architecture artifacts and finalize documentation.

## Domain-Specific Extensions (Architecture)

**Validation Checklist:**

Reference: `${CAII_DIRECTORY}/.claude/skills/develop-architecture/resources/validation-checklist.md`

**Categories:**
1. HLD completeness (C4 Level 1, components, dependencies, tech stack)
2. LLD completeness (C4 Levels 2-3, sequences, module graph)
3. Database schema quality (normalization, indexes, DDL)
4. API specification compliance (OpenAPI 3.0, auth, versioning)
5. Security architecture (OWASP Top 10, defense-in-depth, encryption)
6. Infrastructure architecture (IaC templates, idempotency, cost)
7. ADR catalog (pattern selection, major tech decisions)
8. C4 diagrams (Levels 1-3 minimum)
9. Platform-specific (conditional based on app type)
10. AWS Well-Architected Framework (5 pillars)

**Architecture Validation Tools:**
- ArchUnit rules for package dependencies
- Fitness functions for performance/security
- Architecture smell detection (circular deps, god classes)
- CI/CD integration plan

**If Validation Fails:**
- Identify specific missing/incomplete artifacts
- Transition back to relevant phase (2, 3, 4, or 5)
- Max 2 remediation iterations before forced completion

## Gate Exit Criteria

- [ ] All validation checklist items addressed or justified
- [ ] C4 diagram set complete (Levels 1-3)
- [ ] ADR catalog finalized with cross-references
- [ ] ArchUnit rules and fitness functions defined
- [ ] AWS Well-Architected evaluation complete
- [ ] Architecture review PASSED

## Output

- validation-report.md
- c4-diagrams/ (finalized)
- adrs/ (finalized with cross-refs)
- archunit-rules.md
- fitness-functions.md
- well-architected-review.md
- architecture-package.zip (all artifacts)

## Remediation Loop

If validation identifies gaps:
1. Identify target phase (2, 3, 4, or 5)
2. FSM transitions to remediation_target
3. Target phase re-executes with focused generation
4. Return to Phase 6 for re-validation
5. Max 2 iterations before forced completion

## MANDATORY Agent Invocation

```bash
Task tool with subagent_type: "orchestrate-validation"
```

Produces: `.claude/memory/{task_id}-validation-memory.md`
