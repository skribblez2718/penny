# Learning Injection Protocol

## Purpose

Enable cognitive agents to leverage accumulated learnings from previous tasks without manual context loading.

## Loading Strategy

**Always Load (Step 0 of every agent execution):**
- `learnings/{cognitive_function}/heuristics.md` (INDEX section only, ~100-150 tokens)
- `learnings/{cognitive_function}/anti-patterns.md` (INDEX section only, ~50-100 tokens)
- `learnings/{cognitive_function}/checklists.md` (INDEX section only, ~50-100 tokens)

**Triggered Deep Lookup (conditional):**
When INDEX contains pattern matching task characteristics:
- **Domain match:** "technical + API" → grep "API" in learnings/{function}/domain-snippets/
- **Pattern match:** "multi-source research" → grep "cross-checking" in learnings/research/heuristics.md
- Load only matched section (~100-200 tokens)

## Token Budget

- **INDEX loading:** 200-400 tokens (always, before main task execution)
- **Deep lookup:** 0-200 tokens (conditional, only when pattern matches)
- **Total maximum:** 600 tokens for learning injection

## Integration with Context Loading

Learning injection happens BEFORE main context loading in agent execution:

**Execution Order:**
1. **Step 0 - Learning Injection:** 200-600 tokens
2. **Context Loading (existing):** 2,500-3,000 tokens (workflow metadata + predecessors)
3. **Total available:** ~3,200-3,600 tokens for pre-work context

## Per-Agent Triggers

**Clarification:**
- Technical domain + security → search "security" in clarification/heuristics.md
- Requirements gathering → load clarification/checklists.md relevant sections

**Research:**
- Security research → search "security" in research/heuristics.md
- Technical + API → search "API" in research/domain-snippets/

**Analysis:**
- Complexity assessment → load analysis/heuristics.md decomposition patterns
- Risk analysis → search "risk" in analysis/heuristics.md

**Synthesis:**
- Integration task → load synthesis/heuristics.md integration patterns
- Contradiction resolution → search "contradiction" in synthesis/heuristics.md

**Generation:**
- Code generation → load generation/heuristics.md code-related patterns
- Security-sensitive code → search "security" in generation/anti-patterns.md

**Validation:**
- Code validation → load validation/checklists.md code quality sections
- Security validation → search "security" in validation/heuristics.md

## Progressive Disclosure Pattern

**Philosophy:** Don't load what you don't need, but know what's available.

**Mechanism:**
- **INDEX** acts as a "table of contents" - always loaded, minimal tokens
- **Deep lookup** fetches specific sections only when relevant pattern detected
- Agents scan INDEX first, then decide whether to fetch full entries
