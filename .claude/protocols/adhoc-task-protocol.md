# Ad-Hoc Task Protocol

**Purpose:** Define how Penny handles tasks that don't require formal skills

---

## Overview

Not every task requires a formal skill workflow. Simple, one-off tasks can be handled directly by Penny without invoking the full cognitive agent orchestration system. However, even ad-hoc tasks must follow certain protocols to maintain system consistency.

---

## When to Use Ad-Hoc Protocol

Use this protocol for tasks that are:

1. **Simple and straightforward** - Can be completed in a single interaction
2. **Non-complex** - Don't require multiple cognitive phases
3. **One-time operations** - Not part of a recurring workflow
4. **Low-stakes** - Don't need validation or quality gates
5. **Direct execution** - Can be done with built-in tools without agent coordination

### Examples of Ad-Hoc Tasks

**Appropriate for ad-hoc:**
- Read a specific file and answer a question about it
- Make a simple edit to a single file
- Run a command and report results
- Search for files matching a pattern
- Explain a concept or provide information
- Simple file operations (move, copy, delete)

**NOT appropriate for ad-hoc (use skills instead):**
- Multi-step implementations requiring planning
- Complex code generation across multiple files
- Tasks requiring research → analysis → synthesis
- Workflows needing validation gates
- Projects with multiple phases or dependencies

---

## Ad-Hoc Task Decision Tree

```
User Request
    |
    |- Can be completed in single interaction?
    |   |
    |   |- YES → Continue to next check
    |   |- NO → Use appropriate skill
    |
    |- Requires multiple cognitive functions?
    |   |
    |   |- NO → Continue to next check
    |   |- YES → Use appropriate skill
    |
    |- Needs validation or quality gates?
    |   |
    |   |- NO → Continue to next check
    |   |- YES → Use appropriate skill
    |
    |- Is it complex or high-stakes?
        |
        |- NO → Use ad-hoc protocol ✓
        |- YES → Use appropriate skill
```

---

## Protocol Steps

### Step 1: Task Assessment

When receiving a user request, assess:

1. **Complexity:** Simple or complex?
2. **Cognitive functions needed:** Single or multiple?
3. **Stakes:** Low or high impact?
4. **Recurrence:** One-time or recurring?

If all indicators point to "simple", proceed with ad-hoc. Otherwise, invoke appropriate skill.

### Step 2: Direct Execution

For ad-hoc tasks:

1. **Use built-in tools directly:**
   - Read, Write, Edit for file operations
   - Bash for command execution
   - Grep, Glob for searching
   - WebFetch, WebSearch for information gathering

2. **No agent invocation needed (typically):**
   - Don't use the Task tool with cognitive agents for simple tasks
   - Handle directly in main conversation
   - Respond immediately to user

3. **EXCEPTION - If agents ARE invoked for ad-hoc work:**
   - **MUST follow full memory protocol** (same as skill workflows)
   - Create workflow metadata file: `.claude/memory/task-{task-id}-memory.md`
   - All agents MUST read workflow metadata and write outputs
   - Follow cognitive-skill-orchestration-protocol.md Steps 4-6
   - Prompt for develop-learnings after completion
   - **Rationale:** If agents need coordination, they need context. Memory files are NON-NEGOTIABLE for agent work.

4. **Follow tool usage policies:**
   - Use specialized tools over bash when possible
   - Run independent operations in parallel
   - Follow security and safety guidelines

### Step 3: Response

Provide clear, concise response to user:

1. **Acknowledge the task**
2. **Execute using appropriate tools**
3. **Report results directly**
4. **Answer any questions**

---

## Memory Protocol for Ad-Hoc Tasks

### Default Behavior (No Agents Invoked)

**Ad-hoc tasks do NOT create memory files by default when using only built-in tools.**

Rationale:
- Memory protocol is for cognitive agent coordination
- Simple tool usage doesn't require agent orchestration
- Creating memory for every simple task creates noise
- No downstream agents need context

**Examples of no-memory ad-hoc:**
- Reading a file and answering a question
- Making a simple edit
- Running a command
- Searching for files
- Information lookups

### MANDATORY Behavior (Agents ARE Invoked)

**If ANY cognitive agent is invoked during ad-hoc work, FULL memory protocol MUST be followed.**

**NON-NEGOTIABLE REQUIREMENTS:**

1. **Create workflow metadata BEFORE first agent:**
   - File: `.claude/memory/task-{task-id}-memory.md`
   - Follow cognitive-skill-orchestration-protocol.md Step 4
   - Include task domain, quality standards, success criteria
   - **VERIFY file exists before invoking agent**

2. **ENFORCE reading before agent invocation (Pre-Invocation):**
   - Verify workflow metadata file EXISTS before agent starts
   - Verify predecessor files EXIST if agent pattern requires them
   - Agent prompt MUST list all files to read with full paths
   - Agent prompt MUST instruct agent to output "Context Loaded" section FIRST
   - **FAIL IMMEDIATELY if context files missing**

3. **VERIFY agent read required context (During Execution):**
   - Agent's FIRST output section MUST be "Section 0: CONTEXT LOADED"
   - Check agent listed all required files in "Context Loaded" section
   - Verify pattern compliance (WORKFLOW_ONLY / IMMEDIATE_PREDECESSORS / MULTIPLE_PREDECESSORS)
   - Verify token budget not exceeded (≤ 4000 tokens)
   - **FAIL LOUDLY if agent starts work without context verification**

4. **VERIFY agent wrote memory file (After Completion):**
   - Check `.claude/memory/task-{task-id}-{agent-name}-memory.md` EXISTS
   - Verify Four-Section format (Context Loaded + Step Overview + Johari + Downstream)
   - Confirm token limits respected (Johari ≤ 1200 tokens)
   - **FAIL LOUDLY if memory file missing or malformed**

5. **Complete workflow with learning prompt:**
   - Follow cognitive-skill-orchestration-protocol.md Step 6
   - Aggregate agent outputs
   - ALWAYS prompt for develop-learnings
   - Same standard as skill workflows

**Rationale:**
- Agent coordination requires context sharing
- Memory files are the ONLY mechanism for cross-agent communication
- No distinction between skill-invoked vs ad-hoc-invoked agents
- Consistency prevents system failures

**FAILURE CONDITION:** Invoking agents without memory protocol will cause agent failures when they attempt to read non-existent context files.

### Exception: Complex Ad-Hoc Tasks

If an ad-hoc task becomes unexpectedly complex during execution:

1. **Stop and reassess:** Should this be a skill workflow?
2. **Ask user:** Would you like me to use a formal workflow for this?
3. **If invoking agents:** Follow MANDATORY memory protocol (above)
4. **If switching to skill:** Invoke appropriate skill and follow full protocol

---

## Examples

### Example 1: Simple File Read (Ad-Hoc)

**User:** "What's in the README.md file?"

**Penny Response:**
```
[Uses Read tool on README.md]
[Summarizes contents]
```

**Memory created:** None (simple query)

---

### Example 2: Simple Edit (Ad-Hoc)

**User:** "Change the port from 3000 to 4000 in server.js"

**Penny Response:**
```
[Uses Read to verify current content]
[Uses Edit to change port]
[Confirms change made]
```

**Memory created:** None (simple edit)

---

### Example 3: Complex Task Escalation (Switch to Skill)

**User:** "Add authentication to my API"

**Penny Assessment:**
- Complex: YES
- Multiple cognitive functions: YES (research patterns → design → implement → validate)
- High stakes: YES
- Recurrence: Potentially

**Penny Response:**
```
Adding authentication to your API is a complex task that would benefit from
a structured workflow. I recommend using the develop-project skill to ensure
we follow best practices and validation gates.

Would you like me to proceed with the develop-project skill workflow?
```

---

### Example 4: Research Question (Ad-Hoc with Tool Use)

**User:** "What's the latest version of React?"

**Penny Response:**
```
[Uses WebSearch to find latest React version]
[Reports findings with sources]
```

**Memory created:** None (simple information lookup)

---

### Example 5: Multiple Independent Commands (Ad-Hoc Parallel)

**User:** "Run git status and check the build status"

**Penny Response:**
```
[Uses Bash tool twice in parallel]
[Reports both results]
```

**Memory created:** None (simple commands)

---

## Anti-Patterns

### Don't: Create Memory Files for Simple Tasks

**Wrong:**
```
User: "What's in config.json?"
Penny:
  [Reads config.json]
  [Creates .claude/memory/task-adhoc-123-memory.md]
  [Writes Johari summary of config file]
```

**Right:**
```
User: "What's in config.json?"
Penny:
  [Reads config.json]
  [Summarizes contents directly to user]
```

### Don't: Invoke Agents for Direct Operations

**Wrong:**
```
User: "Find all TypeScript files"
Penny: [Invokes research-discovery agent to find TypeScript files]
```

**Right:**
```
User: "Find all TypeScript files"
Penny: [Uses Glob tool directly with pattern "**/*.ts"]
```

### Don't: Overthink Simple Tasks

**Wrong:**
```
User: "Run npm install"
Penny: "This task requires multiple phases:
1. Clarification of dependencies needed
2. Analysis of package.json
3. Synthesis of installation strategy
4. Validation of results
Would you like me to create a formal workflow?"
```

**Right:**
```
User: "Run npm install"
Penny: [Runs npm install via Bash]
[Reports results]
```

---

## Boundary Cases

### Case 1: Multi-Step but Simple

**Scenario:** User asks to "update version in package.json and commit the change"

**Decision:** Ad-hoc (2 simple steps, no complexity)

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

**Decision:** Ad-hoc (simple query doesn't interrupt skill)

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

### Transitioning from Ad-Hoc to Skill

If an ad-hoc task needs to become a skill workflow:

1. **Explain why:** Tell user why skill workflow is better
2. **Get approval:** Ask user if they want to proceed with skill
3. **Create workflow metadata:** Initialize task memory
4. **Invoke skill:** Start at appropriate phase
5. **Include ad-hoc context:** Summarize what was done ad-hoc in workflow metadata

### Transitioning from Skill to Ad-Hoc

If user requests ad-hoc task during skill execution:

1. **Assess independence:** Does it affect skill workflow?
2. **If independent:** Handle ad-hoc, continue skill
3. **If dependent:** Incorporate into skill workflow
4. **Maintain context:** Don't mix ad-hoc and skill memory

---

## Quality Standards

Even for ad-hoc tasks, maintain quality:

1. **Accuracy:** Provide correct information
2. **Clarity:** Respond concisely and clearly
3. **Safety:** Follow security guidelines
4. **Efficiency:** Use appropriate tools
5. **Professionalism:** Maintain objective tone

---

## When in Doubt

If you're unsure whether a task should be ad-hoc or use a skill:

**Default to skill workflow if:**
- Task involves code generation
- Multiple files will be modified
- Task requires validation
- Stakes are high
- User might need to review plan first

**Use ad-hoc if:**
- Task is clearly simple
- User expects immediate response
- No coordination needed
- Low stakes and reversible

---

## Summary

**Ad-hoc tasks are for simple, direct operations.**

- No memory files needed
- No agent invocation required
- Direct tool usage
- Immediate responses
- Low complexity only

**Use skills for everything else.**

When in doubt, ask yourself: "Would this benefit from a structured workflow with validation?" If yes, use a skill. If no, handle ad-hoc.

---

## Related Documentation

- `.claude/protocols/cognitive-skill-orchestration-protocol.md` - When to use skills
- `.claude/references/skill-template.md` - How to create skills
- `.claude/docs/philosophy.md` - System design principles
- `.claude/protocols/agent-protocol-core.md` - Agent invocation (for contrast)
