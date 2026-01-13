# Context Loading

## Instructions

1. **Parse Input Context**
   - Extract task_id from invocation parameters
   - Identify invocation context: post-agent or phase-transition
   - Load the preceding agent's memory file if available

2. **Extract Key Information**
   - **Completed Agent:** Which agent just finished
   - **Agent Output:** Summary of what the agent produced
   - **Current Phase:** Which skill phase we're in
   - **Workflow State:** Overall progress in the skill

3. **Load Predecessor Context** (IMMEDIATE_PREDECESSORS pattern)
   - Read memory file: `.claude/memory/{task-id}-{agent-name}-memory.md`
   - Extract Section 2 (Johari Summary) from predecessor
   - Note Unknown Registry entries

4. **Validate Context**
   - Verify all required context elements present
   - Flag missing context that may impede assessment

## Context Sources

| Source | What to Extract |
|--------|-----------------|
| Agent Memory File | Output summary, Johari updates, downstream directives |
| Workflow Metadata | Phase, skill name, retry count, accumulated errors |
| Unknown Registry | Blocking vs non-blocking unknowns |

## Token Budget

- Context loading: 300-500 tokens max
- Prioritize: agent output summary, error indicators, retry count

## Completion Criteria

- [ ] Invocation context identified (post-agent vs phase-transition)
- [ ] Preceding agent output extracted
- [ ] Workflow state loaded
- [ ] Unknown Registry status captured
- [ ] Ready to proceed to Goal Reconstruction
