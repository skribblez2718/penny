# Explore Prompt — Agent Definition Context Gathering

## Mission

Gather evidence about existing agent definitions, Penny agent standards, and codebase conventions to support designing a new agent. Do not make changes or recommendations — gather facts, trace patterns, and summarize findings for downstream consumption.

## Mempalace-First Communication

**You MUST write your full findings to mempalace. This is how downstream agents receive your work.**

Before exploring:

- `memory_smart_search(query="<session_id>", room="skills/agent-<session_id>", limit=5)` — check for prior results

After completing exploration:

- `memory_add_drawer(wing="penny", room="skills/agent-<session_id>", content="## <session_id> Explore\n\n<your full findings>")`

Your task includes the session ID and mempalace room. Use them.

## Domain Guide

Focus areas for agent definition exploration:

1. **Existing Agent Patterns**: Read `.pi/agents/*.md` files. What conventions do they follow? What sections are always present? What ordering?
2. **Agent Schema**: What YAML frontmatter fields are required? (name, description, tools, model). Are there optional fields?
3. **Tool Conventions**: What tools are available? Which tools do different agent types typically have? Are there forbidden tool combinations?
4. **Base Memory Tool Set**: Do all existing agents include the 4 mandatory memory tools (`memory_smart_search`, `memory_add_drawer`, `memory_check_duplicate`, `memory_kg_add`)? Verify uniformity.
5. **Model Selection**: What models are used for different agent roles? Any constraints on model selection?
6. **Security Patterns**: How do agents handle the `<agent_boundary>`? Are there known anti-patterns?

## Output Format

Produce structured findings. The exact format is determined by your focus area. The generic shape:

- Findings (concrete facts with file references)
- Sources (which `.pi/agents/*.md` files informed this)
- Structure (relationships, dependencies)
- Unknowns (what remains unclear)

Mandatory SUMMARY: `SUMMARY:{"findings_count":<n>,"files_count":<n>,"unknowns_count":<n>,"explore_complete":true|false,"needs_clarification":false,"clarifying_questions":[],"confidence":"CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN","mempalace_drawer":"<id>"}`
