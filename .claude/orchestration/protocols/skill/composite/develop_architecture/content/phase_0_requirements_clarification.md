# Phase 0: Requirements Clarification

**Uses Atomic Skill:** `orchestrate-clarification`
**Phase Type:** LINEAR (MANDATORY)

## Purpose

Extract architecture-relevant requirements and establish team defaults.

## Domain-Specific Extensions (Architecture)

**Clarification Questions:**

1. **Application Type** (P0 - Blocking)
   - Options: Web Application, Mobile Application, Desktop Application, API Service, Hybrid
   - Default: None (MUST clarify)
   - Impact: Determines platform-specific Phase 5 content

2. **Team Size & Scale** (P0 - Blocking)
   - Team size: <10, 10-25, 25-50, >50 developers
   - Expected users: <1K, 1K-10K, 10K-100K, 100K-1M, >1M
   - Default: 2-person team (user + Penny), <100K users
   - Impact: Pattern selection in Phase 1

3. **Consistency Model** (P1 - Important)
   - Options: Strong consistency (ACID), Eventual consistency (BASE), Hybrid
   - Default: Strong consistency
   - Impact: Database and pattern selection

4. **Cloud Strategy** (P2 - Clarifying)
   - Options: Cloud-native, Hybrid, On-premise
   - **Default: On-premise**
   - Impact: Infrastructure templates Phase 4

5. **Security Sensitivity** (P1 - Important)
   - Options: Standard, High (healthcare/finance), Critical (government)
   - Default: Standard
   - Impact: Security architecture depth Phase 3

## Team Defaults (2-Person Team)

**CRITICAL:** Embed these defaults in clarification output:
- Cloud strategy: on-premise
- Pattern preference: modular, extensible
- Team size: 2 (user + Penny)
- Expected scale: <100K users
- Consistency: Strong (ACID)

**Reference:** `${CAII_DIRECTORY}/.claude/skills/develop-architecture/resources/decision-frameworks/team-defaults.md`

## Gate Exit Criteria

- [ ] Application type clarified
- [ ] Team size and expected scale determined
- [ ] Consistency model selected
- [ ] Cloud strategy confirmed (default: on-premise)
- [ ] Security sensitivity assessed
- [ ] Team defaults documented

## Output

Clarification context document with all parameters for downstream phases.

## MANDATORY Agent Invocation

After completing this phase content, IMMEDIATELY invoke:

```bash
Task tool with subagent_type: "orchestrate-clarification"
```

The clarification agent will produce: `.claude/memory/{task_id}-clarification-memory.md`
