# Trigger Cognitive Agent Flow

Execute the cognitive agent sequence defined in Step 3.

## Agent Invocation Protocol

For EACH agent in the sequence:

### Pre-Invocation Verification
1. Verify workflow metadata exists at `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md`
2. Verify predecessor files exist (if required by context pattern)
3. Verify agent prompt includes all context instructions

### Invocation Template

```
Task ID: task-{task-id}
Step: {phase-number}
Cognitive Function: {RESEARCH|ANALYSIS|SYNTHESIS|GENERATION|VALIDATION|CLARIFICATION}
Task Domain: {domain}
Purpose: {what this cognitive step accomplishes}

CRITICAL INSTRUCTIONS:
1. READ protocol files first:
   - agent-protocol-core.md (ALWAYS)
   - agent-protocol-extended.md (if code generation)
   - context-loading-patterns.md (ALWAYS)

2. LOAD context from:
   - ${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md (ALWAYS)
   - ${CAII_DIRECTORY}/.claude/memory/task-{task-id}-{predecessor}-memory.md (if applicable)

3. EXECUTE your cognitive function for this {domain} task

4. WRITE output to:
   - ${CAII_DIRECTORY}/.claude/memory/task-{task-id}-{agent-name}-memory.md
   - Format: Section 0 (Context) + Section 1 (Overview) + Section 2 (Johari) + Section 3 (Directives)
```

### Post-Invocation Verification
1. Verify agent's first output is "Context Loaded" section
2. Verify memory file was created
3. Verify token limits respected
4. Update workflow metadata with phase completion

## Cognitive Agent Reference

| Agent | Function | When to Use |
|-------|----------|-------------|
| clarification | Resolve ambiguity | Unclear requirements |
| research | Gather information | Knowledge gaps |
| analysis | Decompose complexity | Risk assessment |
| synthesis | Integrate findings | Design creation |
| generation | Create artifacts | Implementation |
| validation | Verify quality | Quality gates |

## Output Requirements

For each agent invocation, report:
```
AGENT: {agent-name}
PHASE: {phase-number}
STATUS: {INVOKED|COMPLETED|FAILED}
MEMORY FILE: {path to created memory file}
```

Continue invoking agents in sequence until all phases complete.
