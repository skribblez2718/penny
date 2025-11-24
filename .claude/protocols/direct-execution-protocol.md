# Direct Execution Protocol

## Overview

This protocol defines the execution flow for tasks that don't require multi-phase cognitive processing or skill orchestration. Use this for straightforward tasks that can be completed immediately.

## Trigger Conditions

Use this protocol when:
- Task is simple modification to existing code
- Task requires immediate response without orchestration overhead
- Task doesn't match skill patterns but requires coding assistance
- Single cognitive function sufficient (just research, just generation, etc.)
- Quick, focused work that doesn't benefit from structured workflow

---

## Execution Steps

### Step 1: Identify single cognitive function

Determine which single cognitive function is needed:

#### Options:

**Just needs research → Direct RESEARCH invocation**
- Gathering information from documentation
- Looking up APIs or libraries
- Finding examples or patterns
- Quick knowledge retrieval

**Just needs analysis → Direct ANALYSIS invocation**
- Examining existing code
- Identifying patterns or issues
- Assessing complexity
- Diagnosing problems

**Just needs generation → Direct GENERATION invocation**
- Writing simple code changes
- Creating configuration files
- Generating documentation
- Quick implementations

**Simple clarification → Direct CLARIFICATION invocation**
- Resolving ambiguous requirements
- Confirming user intent
- Quick Q&A exchanges
- Validating assumptions

### Step 2: If single cognitive agent sufficient

When a single agent can handle the task:

1. **Invoke that specific agent with task context:**
   - Provide clear task description
   - Include relevant constraints
   - Specify expected output format
   - Set quality criteria

2. **Apply domain adaptation from context:**
   - Technical domain → apply technical standards
   - Personal domain → consider personal preferences
   - Creative domain → emphasize creativity
   - Professional domain → follow business standards
   - Recreational domain → prioritize enjoyment

3. **Return result directly:**
   - No need for memory files
   - No workflow orchestration
   - Immediate output to user
   - Single-step completion

### Step 3: Else use available tools

When no agent invocation needed, use tools directly:

#### File Operations for Code Modifications
- **Read:** View existing code
- **Edit:** Make targeted changes
- **Write:** Create new files
- **Glob/Grep:** Find files or patterns

#### Direct Coding Assistance for Simple Changes
- Fix bugs
- Add comments
- Refactor small sections
- Update configurations

#### Information Synthesis from Training Knowledge
- Answer questions directly
- Explain concepts
- Provide examples
- Share best practices

### Step 4: Maintain quality standards

Even for direct execution, maintain quality:

#### Clear, Well-Documented Outputs
- Explain what was done
- Include context for decisions
- Make changes understandable
- Use clear variable names

#### Comprehensive Error Handling
- Validate inputs
- Handle edge cases
- Provide useful error messages
- Fail gracefully

#### Explicit Assumptions and Limitations
- State what you assumed
- Note any limitations
- Identify potential issues
- Suggest follow-up actions if needed

---

## When NOT to Use Direct Execution

Avoid this protocol when:

### Multi-Step Complexity
If the task naturally breaks into multiple cognitive phases, use **Cognitive Skill Orchestration** instead.

### System Architecture Changes
If modifying Penny system files, use **Penny Meta Work Protocol** instead.

### Uncertainty or Ambiguity
If requirements are unclear, invoke **CLARIFICATION agent** first to resolve ambiguity before proceeding.

### Quality Risk
If mistakes could have significant consequences, use structured workflow with validation gates.

---

## Key Principles for Direct Execution

### Speed with Quality
Work quickly but don't sacrifice quality. Simple doesn't mean sloppy.

### Context Awareness
Even without full workflow, understand the broader context of changes.

### Transparency
Explain what you're doing and why, even for simple tasks.

### Completeness
Finish what you start. Don't leave partial implementations.

### User Focus
Prioritize user needs and clear communication over process.

---

## Examples of Direct Execution Tasks

### Good Candidates:
- "Fix this typo in the README"
- "What does this function do?"
- "Add a comment explaining this algorithm"
- "Search for all uses of this variable"
- "Show me the git status"
- "Explain how authentication works in this codebase"

### Poor Candidates (Use Other Protocols):
- "Build a new authentication system" → Use Cognitive Skill Orchestration
- "Refactor the entire agent architecture" → Use Penny Meta Work Protocol
- "I need help but I'm not sure what I want" → Start with CLARIFICATION
- "Implement a complex feature with tests" → Use Cognitive Skill Orchestration
