# Implementation Methods

## Context Pruning Approaches

Three methods for implementing context pruning. Choose based on workflow needs.

---

## Method 1: In-Place Compression (RECOMMENDED)

Directly edit memory file to replace verbose sections with compressed summaries.

### Steps

1. **Identify** completed phase section in memory file
2. **Extract** all OPEN/HIDDEN/BLIND/UNKNOWN quadrants
3. **Compress** each quadrant using decision-focused writing
4. **Replace** original section with compressed version
5. **Verify** token count compliance (1,200 max)

### When to Use

- Standard workflow execution
- Memory file is primary context source
- No need for historical detail access

### Advantages

- Simple implementation
- Single file to maintain
- Immediate context reduction

---

## Method 2: Archive and Summarize

Move detailed phase output to archive, replace with summary link.

### Steps

1. **Extract** completed phase full output
2. **Write** to `${CAII_DIRECTORY}/.claude/memory/archives/task-{id}-phase-{n}.md`
3. **Generate** compressed summary (1,200 tokens max)
4. **Replace** phase section with summary + archive link
5. **Update** workflow metadata with archive reference

### When to Use

- Complex workflows where historical detail may be needed
- Debugging or audit requirements
- When phases might need to be revisited

### Advantages

- Full detail preserved for reference
- Memory file stays lean
- Audit trail maintained

---

## Method 3: Progressive Summarization

Maintain summary section that grows; prune details after each phase.

### Steps

1. **Maintain** "COMPRESSED CONTEXT" section at top of memory file
2. **After each phase**, append compressed summary to this section
3. **Remove or compress** detailed phase output
4. **Keep** COMPRESSED CONTEXT section as primary reference
5. **Downstream agents** read compressed section first

### When to Use

- Very long workflows (6+ phases)
- When context accumulation is a concern
- Agent performance optimization priority

### Advantages

- Predictable context growth
- Agents always read compressed summary first
- Best for extended workflows

---

## Method Selection Guide

| Workflow Type | Recommended Method |
|---------------|-------------------|
| Short (2-3 phases) | In-Place Compression |
| Medium (4-5 phases) | In-Place or Archive |
| Long (6+ phases) | Progressive Summarization |
| Audit-required | Archive and Summarize |
| Performance-critical | Progressive Summarization |

---

## Implementation Notes

- **Consistency:** Use same method throughout a workflow
- **Timing:** Apply after phase completes, before next phase starts
- **Validation:** Always verify compressed output before removing detail
- **Archives:** If using Method 2, maintain archive index for easy lookup
