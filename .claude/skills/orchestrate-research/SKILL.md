---
name: orchestrate-research
description: Atomic skill for research using research agent
semantic_trigger: knowledge gaps, options exploration
not_for: tasks with complete information
tags: atomic-skill, research, discovery
type: atomic
---

# orchestrate-research

**Type:** Atomic Skill
**Purpose:** Investigate options, gather domain knowledge, and document findings

## Interface

### Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | string | yes | Workflow task identifier (format: `task-[a-z0-9-]{1,36}`) |
| research_depth | string | no | quick\|standard\|deep (default: standard) |

### Output

| Output | Type | Description |
|--------|------|-------------|
| status | PASS\|FAIL | Execution result |
| memory_file | string | Path to research output (`.claude/memory/task-{id}-research-memory.md`) |

## Research Depth Configuration

| Depth | Behavior | Use Case |
|-------|----------|----------|
| quick | Surface-level scan, key findings only | Time-sensitive decisions |
| standard | Balanced investigation, multiple sources | Most research tasks |
| deep | Comprehensive analysis, exhaustive sources | Critical decisions |

## Exit Criteria

- [ ] Research scope covered
- [ ] Sources evaluated and documented
- [ ] Findings documented with evidence
- [ ] Memory file written in standard format

---

## Agent Invocation Format

**CRITICAL:** When invoking the research agent via Task tool, you **MUST** structure the prompt using this template format.

### Required Sections

When you invoke the Task tool for the research agent, include ALL of these sections:

#### 1. Task Context (REQUIRED)

```markdown
## Task Context
- **Task ID:** `{task_id}`
- **Skill:** `orchestrate-research`
- **Phase:** `{phase_id}`
- **Domain:** `{domain}`
- **Agent:** `research`
```

#### 2. Role Extension (REQUIRED - Generate dynamically)

Generate 3-5 task-specific focus areas based on the user's query and domain:

```markdown
## Role Extension

**Task-Specific Focus:**

- [Focus area 1 relevant to this specific research task]
- [Focus area 2 relevant to this specific research task]
- [Focus area 3 relevant to this specific research task]
- [Additional focus areas as needed]

> This section dynamically extends your base cognitive function for this specific task.
```

#### 3. Johari Context (REQUIRED if available from reasoning)

Extract from reasoning protocol Step 0 output:

```markdown
## Prior Knowledge (Johari Window)

### Open (Confirmed)
[Known facts and requirements from reasoning protocol]

### Blind (Gaps)
[Identified unknowns and missing context]

### Hidden (Inferred)
[Assumptions and inferences made]

### Unknown (To Explore)
[Areas requiring investigation]
```

#### 4. Task Instructions (REQUIRED)

```markdown
## Task

[Specific research instructions derived from user query]

Research depth: {quick|standard|deep}
```

#### 5. Related Research Terms (REQUIRED - Generate 7-10 items)

Generate keywords relevant to this specific research task:

```markdown
## Related Research Terms

- [Term 1]
- [Term 2]
- [Term 3]
- [Term 4]
- [Term 5]
- [Term 6]
- [Term 7]
```

#### 6. Output Requirements (REQUIRED)

```markdown
## Output

Write findings to: `.claude/memory/{task_id}-research-memory.md`

Use the standard Johari output format with sections:
- Section 0: Context Loaded
- Section 1: Step Overview
- Section 2: Johari Summary
- Section 3: Downstream Directives
```

### Example Invocation

For a query about "rate limiting best practices for REST APIs":

```markdown
# Agent Invocation: research

## Task Context
- **Task ID:** `task-rate-limit-abc123`
- **Skill:** `orchestrate-research`
- **Phase:** `1`
- **Domain:** `technical`
- **Agent:** `research`

## Role Extension

**Task-Specific Focus:**

- Investigate rate limiting algorithms (token bucket, sliding window, fixed window)
- Research distributed implementation patterns using Redis or similar
- Identify industry best practices from major API providers
- Explore HTTP header conventions for rate limit communication
- Document trade-offs between user experience and protection

## Prior Knowledge (Johari Window)

### Open (Confirmed)
- User needs rate limiting for a REST API
- Target scale: 10,000 requests per second
- Platform: e-commerce

### Blind (Gaps)
- Specific programming language/framework not specified
- Current infrastructure details unknown

### Hidden (Inferred)
- Likely needs fair distribution across users
- May need special handling for checkout flows

### Unknown (To Explore)
- Flash sale scenarios
- Geographic distribution of users

## Task

Research the best practices for implementing rate limiting in REST APIs, focusing on:
1. Rate Limiting Algorithms (token bucket, sliding window, fixed window)
2. Implementation Best Practices (headers, response codes, key design)
3. High-Traffic Considerations (10,000 RPS, fair distribution)
4. Industry Implementations (Stripe, GitHub, Twitter patterns)

Research depth: standard

## Related Research Terms

- rate limiting algorithms
- token bucket implementation
- sliding window rate limiter
- distributed rate limiting Redis
- API throttling best practices
- X-RateLimit headers
- 429 Too Many Requests
- fair queuing algorithms
- leaky bucket algorithm
- API gateway rate limiting

## Output

Write findings to: `.claude/memory/task-rate-limit-abc123-research-memory.md`
```

### Template Reference

For full template documentation, see:
`${CAII_DIRECTORY}/.claude/orchestration/shared/templates/SKILL-TEMPLATE-REFERENCE.md`

---

## References

- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/` - Memory output format
- `${CAII_DIRECTORY}/.claude/docs/context-loading-reference.md` - Context loading patterns
- `${CAII_DIRECTORY}/.claude/docs/agent-protocol-reference.md` - Quick reference checklist
- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/agent-invocation-template.md` - Invocation patterns
