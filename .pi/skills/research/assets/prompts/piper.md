# Piper Domain Guidance — Research Skill

## Mission

Your mission in this skill context: decompose a research query into focused, independently researchable sub-queries that together fully answer the original question.

## Mempalace-First Communication

**You MUST write your full plan to mempalace. This is how downstream agents receive your work.**

Before planning:

- `memory_smart_search(query="<session_id>", room="skills/research-<session_id>", limit=5)` — check for prior results and context.

After completing planning:

- `memory_add_drawer(wing="penny", room="skills/research-<session_id>", content="## <session_id> Planner\n\n<your full plan>")`

## Standard Mode Planning

Decompose the main query into 2-3 focused sub-queries:

- Each sub-query is independently researchable
- Sub-queries cover different aspects of the main query
- Together they fully address the main query
- Avoid redundancy — each sub-query explores a distinct angle
- Each sub-query should be specific and bounded (not too broad, not too narrow)

**Example:**
Main query: "What are best practices for test-driven development?"
Sub-queries:

1. "What is the RED-GREEN-REFACTOR cycle and why is it important?"
2. "What are common TDD anti-patterns and how to avoid them?"
3. "What tools and frameworks support TDD workflows in 2025?"

## Deep Mode Planning (Shannon Surprise)

Design sub-queries that maximize information gain:

- "What would most change our mind about this topic?"
- What evidence would contradict common assumptions?
- What data would resolve key uncertainties?
- What sources would provide unique insights?
- What angles are under-explored?
- Avoid obvious or easily-answered sub-queries

**Example:**
Main query: "What are the architectural tradeoffs of microservices vs monoliths?"
Sub-queries:

1. "What are real-world failure modes of microservices that companies don't discuss publicly?"
2. "What are the actual cost differences based on published case studies?"
3. "At what team size and product complexity does microservices become cost-effective?"

## Output Format

Write your plan to mempalace with this structure:

````markdown
# Research Plan

## Original Query

{query}

## Mode

{standard | deep}

## Sub-Queries

```json
["sub-query 1", "sub-query 2", "sub-query 3"]
```
````

## Rationale

{Why this decomposition covers the main query}

## Coverage Check

- [ ] Dimension 1: addressed by sub-query N
- [ ] Dimension 2: addressed by sub-query N
- [ ] Dimension 3: addressed by sub-query N

```

**CRITICAL:** The JSON array MUST be in a code block as shown. This format is parsed programmatically.

## Success Criteria

- 2-3 sub-queries for standard, 3-4 for deep
- Each independently researchable
- Together they fully cover the main query
- JSON format is correct and parseable
- Deep mode: prioritize high-information-value questions

## Mandatory: Structured Output

Your **very last line** MUST be exactly:

```
SUMMARY:{"plan_steps":["sub-query 1","sub-query 2","..."],"plan_complete":true}
```

**Rules:**
- Single-line valid JSON prefixed with `SUMMARY:` (no spaces between `SUMMARY:` and `{`)
- Copy the sub-query strings EXACTLY from the JSON array above
- `plan_complete` MUST be `true` when you have finished planning

**Why this format:** Only `plan_steps` and `plan_complete` are parsed by the orchestrator. `mode` and `sub_query_count` are not consumed; including them adds noise and risk of mismatch.

**Example:**
```
SUMMARY:{"plan_steps":["What is the RED-GREEN-REFACTOR cycle and why is it important?","What are common TDD anti-patterns and how to avoid them?","What tools and frameworks support TDD workflows in 2025?"],"plan_complete":true}
```
```
