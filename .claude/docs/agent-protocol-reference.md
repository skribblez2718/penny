# Agent Protocol Reference Guide

**Purpose:** Reference documentation for cognitive agent protocols in the system

---

## Overview

Seven universal cognitive agents adapt to ANY task domain through domain-adaptive processing. This guide provides validation checklists, success factors, and quick reference for agent operation.

---

## Protocol Validation Checklist

Before completing work, EVERY agent verifies:

### Context Loading
- [ ] Task-ID extracted successfully
- [ ] Task domain identified (confidence level documented)
- [ ] Workflow context fully loaded
- [ ] Previous agent outputs integrated (per pattern)
- [ ] Context loading pattern followed correctly

### Cognitive Processing
- [ ] Unknown Registry checked and updates proposed
- [ ] Cognitive function adapted to domain
- [ ] Quality standards applied appropriately
- [ ] Johari Summary compressed effectively (≤1200 tokens)

### Output Generation
- [ ] Context Loaded section output FIRST
- [ ] Downstream Directives complete
- [ ] Output formatted correctly (Markdown + JSON)
- [ ] Gate criteria satisfied
- [ ] Context preserved for next agent

### Memory Protocol
- [ ] Memory file written to correct location
- [ ] Four-section structure followed
- [ ] Token limits respected

---

## Critical Success Factors

| Factor | Description |
|--------|-------------|
| **Domain Identification** | Correctly identify task domain early in processing |
| **Cognitive Consistency** | Apply universal process regardless of domain |
| **Context Adaptation** | Adjust WHAT not HOW based on domain |
| **Quality Maintenance** | Apply domain-appropriate standards |
| **Token Efficiency** | Compress intelligently while preserving critical context |
| **Handoff Clarity** | Next agent receives sufficient context to adapt |

---

## Quick Reference

### Agent Invocation Always Includes

| Element | Example |
|---------|---------|
| Task-ID | `task-oauth2-implementation` |
| Step number and name | `Step 2: Research Execution` |
| Purpose statement | Purpose: Investigate authentication patterns |
| Gate entry/exit criteria | Entry: Requirements clear, Exit: Patterns identified |
| Context files to read | `${CAII_DIRECTORY}/.claude/memory/task-xxx-clarification-memory.md` |
| Previous agent dependencies | Predecessor: clarification |

### Prompt Template Requirements (CRITICAL)

When invoking agents via atomic skills, the DA **MUST** structure the Task tool prompt using the standardized Agent Prompt Template format. Plain text prompts are NOT acceptable.

**Required Template Sections:**

| Section | Required | Source |
|---------|----------|--------|
| Task Context | Yes | task_id, skill_name, phase_id, domain, agent_name |
| Role Extension | Yes | DA generates 3-5 task-specific focus areas |
| Johari Context | If available | From reasoning protocol Step 0 |
| Task Instructions | Yes | Specific cognitive work for this agent |
| Related Research Terms | Yes | DA generates 7-10 keywords |
| Output Requirements | Yes | Memory file path |

**Why This Matters:**
- Ensures consistent context passing across all agents
- Transfers Johari knowledge discoveries from reasoning to agents
- Adapts agents to specific task requirements via Role Extension

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/shared/templates/SKILL-TEMPLATE-REFERENCE.md` or individual `SKILL.md` "Agent Invocation Format" sections.

### Agent Always Produces

| Output | Format |
|--------|--------|
| Context Loaded section | JSON (Section 0 - FIRST) |
| Step Overview | Markdown narrative |
| Johari Summary | JSON (≤1200 tokens) |
| Downstream Directives | JSON |
| Unknown Registry updates | JSON |
| Task domain classification | String with confidence |
| Quality validation results | PASS/FAIL with details |

### Memory File Locations

| Type | Path Pattern |
|------|--------------|
| Workflow metadata | `${CAII_DIRECTORY}/.claude/memory/task-{id}-memory.md` |
| Agent outputs | `${CAII_DIRECTORY}/.claude/memory/task-{id}-{agent}-memory.md` |

---

## Domain-Specific Standards

### Technical Domain

| Standard | Application |
|----------|-------------|
| TDD | Write tests before implementation |
| SOLID | Apply design principles |
| Security | OWASP Top 10, input validation |
| Performance | Benchmarks, load testing |

### Personal Domain

| Standard | Application |
|----------|-------------|
| Values alignment | Decisions reflect user values |
| Privacy | Data stays local |
| Wellbeing | Consider emotional impact |

### Creative Domain

| Standard | Application |
|----------|-------------|
| Audience fit | Content matches target |
| Vision clarity | Creative direction defined |
| Quality | Meets artistic standards |

### Professional Domain

| Standard | Application |
|----------|-------------|
| Business case | ROI justified |
| Stakeholder | Needs addressed |
| Compliance | Regulations followed |

### Recreational Domain

| Standard | Application |
|----------|-------------|
| Fun factor | Engagement high |
| Safety | Participants protected |
| Accessibility | All can participate |

---

## Common Failure Modes

| Failure | Cause | Prevention |
|---------|-------|------------|
| Missing Context Loaded section | Agent started work without verification | Always output Section 0 FIRST |
| Token budget exceeded | Loaded too much context | Follow pattern limits strictly |
| Memory file not created | Agent completed without writing output | Verify file exists post-completion |
| Domain mismatch | Incorrect classification | Document confidence level |
| Incomplete handoff | Missing downstream directives | Use checklist before completion |

---

## Related Documentation

- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/` - Execution protocols
- `${CAII_DIRECTORY}/.claude/docs/context-loading-reference.md` - Context pattern selection
- `${CAII_DIRECTORY}/.claude/docs/code-generation-reference.md` - Code generation standards
- `${CAII_DIRECTORY}/.claude/docs/context-pruning-reference.md` - Compression techniques
