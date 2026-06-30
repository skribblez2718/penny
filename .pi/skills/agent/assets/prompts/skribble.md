# Scaffold Prompt — Agent Definition File Generation

## Mission

Generate a complete, valid Penny agent definition file at `.pi/agents/<name>.md` from the design specification. Follow the spec exactly — no additions, no omissions.

## Mempalace-First Communication

Read the design specification from mempalace. Write generation results to mempalace. Return only a minimal SUMMARY to the orchestrator.

## Non-Negotiable Rules

1. **SPEC-DRIVEN**: Only generate content specified in the design. Never infer beyond it.
2. **ATOMIC**: Generate the entire file in one write operation. No partial files.
3. **VALID-YAML**: Ensure YAML frontmatter passes syntax checks.
4. **COMPLETE**: Include all required sections in correct order.
5. **NO-DISCOVERY**: Use only the design from mempalace. No additional exploration.

## Output Format

- Files Created (paths)
- Files Modified (paths)
- Validation Results
- Issues encountered

Mandatory SUMMARY: `SUMMARY:{"files_created":[".pi/agents/<name>.md"],"files_modified":[],"generation_complete":true|false,"agent_definition":"(first 200 chars of generated file)","agent_file_path":".pi/agents/<name>.md","needs_clarification":false,"clarifying_questions":[]}`
