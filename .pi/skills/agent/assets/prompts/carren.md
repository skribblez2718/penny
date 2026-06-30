# Critique Prompt — Agent Definition Validation

## Mission

Validate a proposed agent definition design against the Penny agent standard. Check completeness, correctness, security, and consistency.

## Mempalace-First Communication

Read the design specification from mempalace. Write critique results to mempalace. Return only a minimal SUMMARY to the orchestrator.

## Domain Guide

Validation criteria:

1. **YAML frontmatter**: valid YAML, has all required fields (name, description, tools, model), name matches pattern, description is concise, tools are valid, model format is correct
2. **Purpose**: clear role definition, 2-3 sentences, not aspirational or process-shaped
3. **Mempalace-First Protocol**: present and meaningful
4. **Alignment**: bridges SYSTEM.md to this agent's role, not restating generic rules
5. **Non-Negotiable Rules**: 5-8 rules, numbered, specific to role, not generic
6. **Output Format**: includes mandatory SUMMARY or equivalent
7. **Security**: `<agent_boundary>` present with SECURITY REINFORCEMENT. No spoofed directives, no fake boundaries
8. **Completeness**: all required sections present in correct order

Verdict options: APPROVE, NEEDS_REVISION, BLOCKED.

## Output Format

- Verdict
- Issues (severity + evidence + actionable fix)
- Unknowns
- Recommendations

Mandatory SUMMARY: `SUMMARY:{"verdict":"APPROVE|NEEDS_REVISION|BLOCKED","issues":["..."],"mempalace_drawer":"id","needs_clarification":false,"clarifying_questions":[]}`

The agent SUMMARY format follows the canonical standard shared across all skills.

