# Composite Skill Reference Protocol

## Overview

Protocol for referencing composite skills within other composite skills, enabling skill composition with depth constraints.

## Composition Hierarchy

```
Level-1 Composite (depth: 1)
    |
    ├─→ Base Composite A (depth: 0) → Atomic Skills → Agents
    ├─→ Base Composite B (depth: 0) → Atomic Skills → Agents
    └─→ Atomic Skills (direct)      → Agents
```

## Depth Constraint (CRITICAL)

**Maximum composition depth: 1**

- A skill with `composition_depth: 1` can ONLY invoke skills with `composition_depth: 0`
- This prevents unbounded nesting (A→B→C→D chains)
- Base composites (depth 0) can ONLY use atomic skills, never other composites

### Depth Rules

| Parent Depth | Can Invoke | Cannot Invoke |
|--------------|------------|---------------|
| 0 (base) | Atomic skills only | Any composite skills |
| 1 (level-1) | Atomics + depth-0 composites | Depth-1 composites |

## Frontmatter Requirements

All composite skills MUST include these fields:

```yaml
---
name: skill-name
description: What the skill does
tags: [relevant, tags]
type: composite
composition_depth: 0  # 0=base (atomics only), 1=uses composites
uses_composites: []   # list of composite skill names if any
---
```

## Syntax: Uses Composite Skill

### Basic Block Structure

```markdown
### Phase [N]: [Phase Name]

**Uses Composite Skill:** `{skill-name}`

**Purpose:** [What this composite skill accomplishes in the workflow]

**Trigger:** [When to invoke / prerequisite conditions]

**Configuration:**
- param1: value1
- param2: value2

**Sub-workflow Mode:** {embedded | delegated}

**Context Passthrough:**
- task_id: {inherit | new}
- workflow_memory: {merge | isolated}

**Gate Exit Criteria:**
- [Expected output from composite]
- [Quality standard required]
```

## Sub-workflow Modes

| Mode | Context Sharing | Memory Files | Use When |
|------|-----------------|--------------|----------|
| `embedded` | Shares parent context | Writes to parent's memory | Tight integration, shared state needed |
| `delegated` | Isolated context | Own memory, returns summary | Loose coupling, isolation preferred |

### Embedded Mode

- Child skill receives parent's task-id
- Child writes to shared memory files
- Parent can access child's outputs directly
- Best for sequential phases that build on each other

### Delegated Mode

- Child generates new task-id
- Child maintains separate memory space
- Child returns summarized output to parent
- Best for parallel or independent sub-workflows

## Context Passthrough Options

| Option | Values | Description |
|--------|--------|-------------|
| `task_id` | `inherit` | Child uses parent's task-id (for embedded mode) |
| `task_id` | `new` | Child generates own task-id (for delegated mode) |
| `workflow_memory` | `merge` | Child outputs merge into parent memory |
| `workflow_memory` | `isolated` | Child maintains separate memory space |

### Recommended Combinations

| Mode | task_id | workflow_memory | Result |
|------|---------|-----------------|--------|
| embedded | inherit | merge | Full integration |
| delegated | new | isolated | Full isolation |
| embedded | inherit | isolated | Shared ID, separate outputs |
| delegated | new | merge | Separate ID, merged outputs |

## Configuration Interface

Each composite skill documents its configuration interface in its SKILL.md. When referencing a composite, configuration parameters must match the child skill's documented interface.

### Example: perform-research Interface

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| research_depth | enum | no | standard | quick \| standard \| deep |
| max_sources | int | no | 10 | Maximum sources to gather |
| topic_constraints | object | no | none | Include/exclude topic filters |

### Passing Configuration

```markdown
**Uses Composite Skill:** `perform-research`
**Configuration:**
- research_depth: deep
- max_sources: 20
- topic_constraints:
    include: [API documentation, rate limits]
    exclude: [deprecated features]
```

## Validation Requirements

Before a skill can reference composites:

1. **Verify target skill exists** in `${CAII_DIRECTORY}/.claude/skills/` directory
2. **Check target has `composition_depth: 0`** in frontmatter
3. **Validate configuration against interface** documented in target's SKILL.md
4. **Set parent's `composition_depth: 1`** in frontmatter
5. **Populate `uses_composites` list** with all referenced skill names
6. **Check for circular references** (A→B→A not allowed)

## Circular Reference Detection

A circular reference occurs when skill A uses skill B which (directly or indirectly) uses skill A.

**Detection approach:**
1. Build dependency graph from all skills
2. Traverse from new skill through all `uses_composites` references
3. If traversal returns to starting skill, REJECT

**Example of circular reference (INVALID):**
```
skill-A uses [skill-B]
skill-B uses [skill-C]
skill-C uses [skill-A]  ← Circular!
```

## Phase Mixing Rules

Within a single phase, use EITHER atomic skills OR composite skills, not both:

**Valid:**
```markdown
### Phase 1: Research
**Uses Composite Skill:** `perform-research`

### Phase 2: Analysis
**Uses Atomic Skill:** `orchestrate-analysis`
```

**Invalid:**
```markdown
### Phase 1: Research and Analysis
**Uses Composite Skill:** `perform-research`
**Uses Atomic Skill:** `orchestrate-analysis`  ← Cannot mix in same phase!
```

## Anti-Patterns

| Anti-Pattern | Problem | Instead |
|--------------|---------|---------|
| Referencing depth-1 skill | Exceeds max nesting | Only reference base composites (depth 0) |
| Mixing atomic and composite in same phase | Ambiguous execution order | One skill type per phase |
| Circular references | Infinite loop risk | Build acyclic dependency graph |
| Missing configuration | Undefined behavior | Specify all required params |
| Unspecified sub-workflow mode | Ambiguous context handling | Always specify embedded/delegated |
| Omitting context passthrough | Unknown state management | Always define task_id and workflow_memory |

## Complete Example: Social Media Research Skill

```yaml
---
name: research-social-media
description: Multi-platform social media research aggregating platform-specific findings
tags: research, social-media, aggregation
type: composite
composition_depth: 1
uses_composites: [perform-research]
---
```

```markdown
# research-social-media

## Workflow Phases

### Phase 0: Platform Scope Clarification

**Uses Atomic Skill:** `orchestrate-clarification`

**Purpose:** Clarify which platforms to research and specific focus areas

**Gate Exit Criteria:**
- Platforms list confirmed
- Research focus for each platform defined

---

### Phase 1: Twitter/X Research

**Uses Composite Skill:** `perform-research`

**Purpose:** Conduct platform-specific research for Twitter/X

**Configuration:**
- research_depth: standard
- topic_constraints:
    include: [Twitter API, rate limits, developer portal]
    exclude: [deprecated v1 endpoints]

**Sub-workflow Mode:** embedded

**Context Passthrough:**
- task_id: inherit
- workflow_memory: merge

**Gate Exit Criteria:**
- Twitter research findings documented
- API capabilities catalogued

---

### Phase 2: LinkedIn Research

**Uses Composite Skill:** `perform-research`

**Purpose:** Conduct platform-specific research for LinkedIn

**Configuration:**
- research_depth: standard
- topic_constraints:
    include: [LinkedIn API, OAuth flow, profile data access]

**Sub-workflow Mode:** embedded

**Context Passthrough:**
- task_id: inherit
- workflow_memory: merge

**Gate Exit Criteria:**
- LinkedIn research findings documented
- Authentication requirements captured

---

### Phase 3: Cross-Platform Synthesis

**Uses Atomic Skill:** `orchestrate-synthesis`

**Purpose:** Synthesize findings across all platforms

**Gate Exit Criteria:**
- Unified research report
- Platform comparison matrix
- Recommendations prioritized

---

### Phase 4: Validation

**Uses Atomic Skill:** `orchestrate-validation`

**Purpose:** Validate research quality and completeness

**Gate Exit Criteria:**
- All platforms covered
- Quality standards met
- Gaps identified and documented
```

## References

- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/validation-checklist.md` - Validation requirements
- `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/complex-skill-template.md` - Template with composite sections
- `${CAII_DIRECTORY}/.claude/orchestration/protocols/execution/skill/` - Workflow lifecycle
