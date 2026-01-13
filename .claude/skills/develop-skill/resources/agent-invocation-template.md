# Agent Invocation Template

**Type:** Copy-Paste Template
**Purpose:** Standard agent invocation block for skills

## Standard Invocation Block

Copy and customize for each agent invocation in a skill:

```markdown
### Step {N}: {Step Name}

**Agent:** {agent-name}
**Cognitive Function:** {CLARIFICATION|RESEARCH|ANALYSIS|SYNTHESIS|GENERATION|VALIDATION}

**Purpose:** {One-line description of what this step accomplishes}

**Context Loading:** {WORKFLOW_ONLY|IMMEDIATE_PREDECESSORS|MULTIPLE_PREDECESSORS}
**Predecessors:** {List predecessor agent names if applicable}

**Gate Entry:**
- {Condition that must be true to start}
- {Another condition}

**Gate Exit:**
- {Success criterion}
- {Another success criterion}

**Memory Output:** Standard format per `${CAII_DIRECTORY}/.claude/docs/agent-protocol-reference.md`
- Agent: {agent-name}
- Task: {task-id}
```

## Field Explanations

| Field | Required | Description |
|-------|----------|-------------|
| Step Number | Yes | Sequential step in workflow (1, 2, 3...) |
| Step Name | Yes | Descriptive name for this step |
| Agent | Yes | Cognitive agent to invoke |
| Cognitive Function | Yes | Which cognitive domain this step uses |
| Purpose | Yes | What this step accomplishes (1 line) |
| Context Loading | Yes | Pattern for loading predecessor context |
| Predecessors | If applicable | Which agent outputs to load |
| Gate Entry | Yes | Conditions required to start |
| Gate Exit | Yes | Success criteria to proceed |
| Memory Output | Yes | Reference to standard format |

## Context Loading Pattern Selection

### WORKFLOW_ONLY
**Use when:**
- First agent in workflow
- Agent needs no predecessor output
- Agent only needs task metadata

**Example:**
```markdown
**Context Loading:** WORKFLOW_ONLY
**Predecessors:** None
```

### IMMEDIATE_PREDECESSORS
**Use when:**
- Agent needs only the previous step's output
- Linear workflow progression
- Standard handoff between agents

**Example:**
```markdown
**Context Loading:** IMMEDIATE_PREDECESSORS
**Predecessors:** clarification
```

### MULTIPLE_PREDECESSORS
**Use when:**
- Agent needs outputs from multiple previous agents
- Synthesis or validation requiring comprehensive context
- Cross-referencing between different cognitive outputs

**Example:**
```markdown
**Context Loading:** MULTIPLE_PREDECESSORS
**Predecessors:** research, analysis
```

## Example Invocations

### Clarification Step (First Agent)

```markdown
### Step 1: Requirements Clarification

**Agent:** clarification
**Cognitive Function:** CLARIFICATION

**Purpose:** Transform vague inputs into actionable specifications

**Context Loading:** WORKFLOW_ONLY
**Predecessors:** None

**Gate Entry:**
- Workflow metadata exists
- Initial request captured

**Gate Exit:**
- Ambiguities resolved or documented
- Specifications explicit and testable
- Success criteria defined

**Memory Output:** Standard format per `${CAII_DIRECTORY}/.claude/docs/agent-protocol-reference.md`
- Agent: clarification
- Task: {task-id}
```

### Research Step (After Clarification)

```markdown
### Step 2: Domain Research

**Agent:** research
**Cognitive Function:** RESEARCH

**Purpose:** Investigate options and gather domain knowledge

**Context Loading:** IMMEDIATE_PREDECESSORS
**Predecessors:** clarification

**Gate Entry:**
- Clarification complete
- Research scope defined

**Gate Exit:**
- Sources evaluated
- Options compared
- Recommendations documented

**Memory Output:** Standard format per `${CAII_DIRECTORY}/.claude/docs/agent-protocol-reference.md`
- Agent: research
- Task: {task-id}
```

### Validation Step (Multiple Predecessors)

```markdown
### Step 5: Quality Validation

**Agent:** validation
**Cognitive Function:** VALIDATION

**Purpose:** Verify deliverables meet quality standards

**Context Loading:** MULTIPLE_PREDECESSORS
**Predecessors:** generation, synthesis

**Gate Entry:**
- Artifacts generated
- Quality criteria defined

**Gate Exit:**
- All criteria evaluated
- Issues documented
- GO/NO-GO verdict issued

**Memory Output:** Standard format per `${CAII_DIRECTORY}/.claude/docs/agent-protocol-reference.md`
- Agent: validation
- Task: {task-id}
```

## Domain-Specific Extensions

When a step needs domain-specific behavior, add after the standard block:

```markdown
**Domain-Specific Extensions:**
- {Domain-specific instruction 1}
- {Domain-specific instruction 2}
```

Example for MCP server development:
```markdown
**Domain-Specific Extensions:**
- Validate against 7 required MCP inputs
- Ensure Python 3.10+ compatibility
- Apply factory method patterns
```

## Protocol References

- **Memory Output Format:** `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/`
- **Context Loading Details:** `${CAII_DIRECTORY}/.claude/docs/context-loading-reference.md`
- **Johari Format:** `${CAII_DIRECTORY}/.claude/docs/johari-reference.md`
- **Token Limits:** `${CAII_DIRECTORY}/.claude/docs/johari-reference.md` (Token Limits section)
