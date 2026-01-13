# Agent Prompt Template Reference

This document defines the **required format** for DA-to-agent context passing when invoking atomic skills.

**Purpose:** Ensure agents receive consistent, well-structured context including task metadata, role specialization, Johari knowledge, and output requirements.

---

## Template Structure

When invoking ANY atomic skill agent via the Task tool, structure the prompt as follows:

```markdown
# Agent Invocation: {agent_name}

## 1. Task Context

- **Task ID:** `{task_id}`
- **Skill:** `{skill_name}`
- **Phase:** `{phase_id}`
- **Domain:** `{domain}`
- **Agent:** `{agent_name}`

---

## 2. Role Extension

**Task-Specific Focus:**

{DA generates 3-5 bullet points focusing this agent on the specific task}

> This section dynamically extends your base cognitive function for this specific task.

---

## 3. Prior Knowledge (Johari Window)

### Open (Confirmed)
{Known facts and verified requirements from reasoning protocol}

### Blind (Gaps)
{Identified unknowns and missing context}

### Hidden (Inferred)
{Assumptions and inferences made}

### Unknown (To Explore)
{Edge cases, potential risks, areas for investigation}

---

## 4. Task Instructions

{Specific instructions for this cognitive function, derived from user query and skill context}

---

## 5. Related Research Terms

{DA generates 7-10 keywords relevant to this specific task for knowledge discovery}

- Term 1
- Term 2
- Term 3
- ...

---

## 6. Output Requirements

**Memory File:** `.claude/memory/{task_id}-{agent_name}-memory.md`

**Format:** Johari Window Structure

Write your output using this structure:
- Section 0: Context Loaded
- Section 1: Step Overview
- Section 2: Johari Summary
- Section 3: Downstream Directives

---

## 7. Execution Protocol

1. Read any predecessor memory files specified in Task Context
2. Execute your cognitive function as described in Task Instructions
3. Write findings to the memory file path specified above
4. Follow the Johari output format

**Important:** This agent is invoked as part of skill `{skill_name}` phase `{phase_id}`.
```

---

## Section Requirements

| Section | Required | Source | Description |
|---------|----------|--------|-------------|
| Task Context | **Yes** | Skill invocation | Task ID, skill name, phase, domain, agent name |
| Role Extension | **Yes** | DA generates dynamically | Task-specific focus areas (3-5 bullets) |
| Johari Context | If available | Reasoning protocol Step 0 | Open/Blind/Hidden/Unknown quadrants |
| Task Instructions | **Yes** | SKILL.md + user query | Specific cognitive work to perform |
| Research Terms | **Yes** | DA generates dynamically | 7-10 relevant keywords |
| Output Requirements | **Yes** | Standard format | Memory file path and format |
| Execution Protocol | **Yes** | Standard | How to execute and complete |

---

## DA Responsibilities

When invoking any atomic skill agent, the DA **MUST**:

### 1. Generate Role Extension

Create 3-5 task-specific focus areas based on:
- User's original query
- Domain identified in reasoning (technical, personal, creative, professional, recreational)
- Agent's cognitive function (research, analysis, synthesis, etc.)

**Example for Research Agent:**
```markdown
**Task-Specific Focus:**

- Investigate rate limiting algorithms with emphasis on high-traffic scenarios
- Research distributed implementation patterns using Redis or similar
- Identify industry best practices from major API providers (Stripe, GitHub, etc.)
- Explore trade-offs between strictness and user experience
- Document HTTP header conventions for rate limit communication
```

### 2. Extract Johari Context

From reasoning protocol Step 0 output, extract:
- **Open:** Confirmed requirements, verified facts
- **Blind:** Identified gaps, missing context, questions to answer
- **Hidden:** Inferences made, assumptions applied
- **Unknown:** Edge cases, potential risks, areas to explore

**If no Johari findings available:** Include section header with "No prior Johari analysis available for this task."

### 3. Generate Research Terms

Create 7-10 keywords relevant to knowledge discovery:
- Core concepts from the user query
- Domain-specific terminology
- Related patterns and practices
- Alternative approaches to consider

**Example:**
```markdown
- rate limiting algorithms
- token bucket implementation
- sliding window rate limiter
- distributed rate limiting Redis
- API throttling best practices
- X-RateLimit headers
- 429 Too Many Requests handling
- fair queuing algorithms
```

### 4. Structure Output

**CRITICAL:** Follow the template format exactly. Do NOT:
- Skip required sections
- Pass plain text prompts without structure
- Omit the memory file output path
- Leave Role Extension or Research Terms empty

---

## Why This Template Matters

### Consistency
All agents receive context in the same structure, enabling:
- Predictable context loading
- Uniform output formatting
- Cross-agent handoff via memory files

### Johari Knowledge Transfer
The template ensures reasoning protocol discoveries flow to agents:
- Open quadrant provides confirmed requirements
- Blind quadrant highlights gaps to investigate
- Hidden quadrant shares inferences for validation
- Unknown quadrant suggests exploration areas

### Task Specialization
Role Extension allows agents to adapt their generic cognitive function to specific tasks without hardcoded domain logic.

### Output Traceability
Explicit memory file paths ensure:
- Agents write to correct locations
- Successor agents can load predecessor output
- Workflow completion can be verified

---

## Related Documentation

- `agent-system-prompt.md` - Full template file with all placeholders
- `CLAUDE.md` (this directory) - Template system overview
- `DA.md` - Agent Prompt Template Requirements section
- Individual SKILL.md files - Agent Invocation Format sections
