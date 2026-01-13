# Direct Execution Reference Guide

**Purpose:** Reference documentation for direct/ad-hoc task handling (simple tasks that don't require formal skill workflows)

---

## When to Use Direct Execution

Use direct execution for tasks that are:

1. **Simple and straightforward** - Can be completed in a single interaction
2. **Non-complex** - Don't require multiple cognitive phases
3. **One-time operations** - Not part of a recurring workflow
4. **Low-stakes** - Don't need validation or quality gates
5. **Direct execution** - Can be done with built-in tools without agent coordination

### Appropriate for Direct Execution

- Read a specific file and answer a question about it
- Make a simple edit to a single file
- Run a command and report results
- Search for files matching a pattern
- Explain a concept or provide information
- Simple file operations (move, copy, delete)

### NOT Appropriate (Use Skills Instead)

- Multi-step implementations requiring planning
- Complex code generation across multiple files
- Tasks requiring research -> analysis -> synthesis
- Workflows needing validation gates
- Projects with multiple phases or dependencies

---

## Decision Tree

```
User Request
    |
    |- Can be completed in single interaction?
    |   |
    |   |- YES -> Continue to next check
    |   |- NO -> Use appropriate skill
    |
    |- Requires multiple cognitive functions?
    |   |
    |   |- NO -> Continue to next check
    |   |- YES -> Use appropriate skill
    |
    |- Needs validation or quality gates?
    |   |
    |   |- NO -> Continue to next check
    |   |- YES -> Use appropriate skill
    |
    |- Is it complex or high-stakes?
        |
        |- NO -> Use direct execution
        |- YES -> Use appropriate skill
```

---

## Examples

### Example 1: Simple File Read

**User:** "What's in the README.md file?"

**Action:** Use Read tool, summarize contents directly

**Memory created:** None (simple query)

### Example 2: Simple Edit

**User:** "Change the port from 3000 to 4000 in server.js"

**Action:**
1. Use Read to verify current content
2. Use Edit to change port
3. Confirm change made

**Memory created:** None (simple edit)

### Example 3: Complex Task Escalation

**User:** "Add authentication to my API"

**Assessment:**
- Complex: YES
- Multiple cognitive functions: YES (research -> design -> implement -> validate)
- High stakes: YES

**Action:** Recommend using develop-project skill workflow

### Example 4: Research Question

**User:** "What's the latest version of React?"

**Action:** Use WebSearch, report findings with sources

**Memory created:** None (simple information lookup)

### Example 5: Multiple Independent Commands

**User:** "Run git status and check the build status"

**Action:** Use Bash tool twice in parallel, report both results

**Memory created:** None (simple commands)

---

## Anti-Patterns

### Don't: Create Memory Files for Simple Tasks

**Wrong:**
```
User: "What's in config.json?"
Assistant:
  [Reads config.json]
  [Creates .claude/memory/task-adhoc-123-memory.md]
  [Writes Johari summary of config file]
```

**Right:**
```
User: "What's in config.json?"
Assistant:
  [Reads config.json]
  [Summarizes contents directly to user]
```

### Don't: Invoke Agents for Direct Operations

**Wrong:**
```
User: "Find all TypeScript files"
Assistant: [Invokes research to find TypeScript files]
```

**Right:**
```
User: "Find all TypeScript files"
Assistant: [Uses Glob tool directly with pattern "**/*.ts"]
```

### Don't: Overthink Simple Tasks

**Wrong:**
```
User: "Run npm install"
Assistant: "This task requires multiple phases:
1. Clarification of dependencies needed
2. Analysis of package.json
3. Synthesis of installation strategy
4. Validation of results
Would you like me to create a formal workflow?"
```

**Right:**
```
User: "Run npm install"
Assistant: [Runs npm install via Bash]
[Reports results]
```

---

## Boundary Cases

### Case 1: Multi-Step but Simple

**Scenario:** User asks to "update version in package.json and commit the change"

**Decision:** Direct execution (2 simple steps, no complexity)

**Execution:**
1. Use Edit to update version
2. Use Bash for git commands
3. Report completion

### Case 2: Simple but High-Stakes

**Scenario:** User asks to "delete the production database"

**Decision:** STOP - Confirm intent regardless of simplicity

**Execution:**
1. Ask for explicit confirmation
2. Warn about consequences
3. Only proceed if user confirms
4. Execute carefully with safeguards

### Case 3: Simple but Part of Larger Workflow

**Scenario:** During develop-project skill, user asks "what's the current directory?"

**Decision:** Direct execution (simple query doesn't interrupt skill)

**Execution:**
1. Answer question directly
2. Continue with skill workflow
3. Don't create separate memory

### Case 4: Starts Simple, Becomes Complex

**Scenario:** User asks to "fix this bug" but investigation reveals architectural issues

**Decision:** Escalate to skill mid-task

**Execution:**
1. Report findings
2. Recommend switching to formal workflow
3. Get user approval
4. Invoke appropriate skill with context

---

## Integration with Skills

### Transitioning from Direct Execution to Skill

If a direct execution task needs to become a skill workflow:

1. **Explain why:** Tell user why skill workflow is better
2. **Get approval:** Ask user if they want to proceed with skill
3. **Create workflow metadata:** Initialize task memory
4. **Invoke skill:** Start at appropriate phase
5. **Include context:** Summarize what was done directly in workflow metadata

### Transitioning from Skill to Direct Execution

If user requests direct execution during skill:

1. **Assess independence:** Does it affect skill workflow?
2. **If independent:** Handle directly, continue skill
3. **If dependent:** Incorporate into skill workflow
4. **Maintain context:** Don't mix direct and skill memory

---

## Quality Standards

Even for direct execution, maintain quality:

1. **Accuracy:** Provide correct information
2. **Clarity:** Respond concisely and clearly
3. **Safety:** Follow security guidelines
4. **Efficiency:** Use appropriate tools
5. **Professionalism:** Maintain objective tone

---

## When in Doubt

**Default to skill workflow if:**
- Task involves code generation
- Multiple files will be modified
- Task requires validation
- Stakes are high
- User might need to review plan first

**Use direct execution if:**
- Task is clearly simple
- User expects immediate response
- No coordination needed
- Low stakes and reversible

---

## Related Documentation

- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/protocols/agent/memory-protocol.md` - Memory requirements when agents invoked
- `${CAII_DIRECTORY}/.claude/docs/philosophy.md` - System design principles
