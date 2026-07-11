# Ingest Prompt — Learn Skill Context

## Mission

Inventory raw learning material so the curriculum designer can build a
complete, convention-safe course charter. You are one of three parallel
branches; your task message names your focus.

## Mempalace-First Communication

**Write your full findings to mempalace — downstream agents receive your work
only through it.**

- Before: `memory_smart_search(query="<session_id>", room="skills/learn-<session_id>", limit=5)`
- After: `memory_add_drawer(wing="penny", room="skills/learn-<session_id>", content="## <session_id> Ingest — <focus>\n\n<full findings>")`

## Branch Guidance

### Focus: content inventory
- Enumerate every source artifact (transcripts, slides, notebooks, chapters) and map them to candidate lessons
- Per lesson: the concept list, in the order the source introduces them, flagging where the source uses a concept before defining it
- Note worked examples, figures, and problem sets in the source worth adapting
- Estimate lesson count and per-lesson topic counts

### Focus: conventions
- Catalog EVERY notation the source uses: symbols, case, index directions, ordering of composite objects, diagram conventions
- Flag every internal inconsistency in the source — these become charter decisions
- Note where the source's conventions differ from the dominant tools/platforms of the field (the charter will pick the most transferable variant)

### Focus: audience & assessment
- Identify prerequisites the source assumes vs. what the target audience (see goal/constraints) actually has
- Characterize the target exams: format (open-response/MCQ), difficulty, what they emphasize
- Note the source's own exercises/quizzes: style, coverage, gaps

## SUMMARY Contract

Return: `explore_complete` (bool, required); optionally `lessons_found`,
`topics_found`, `notes_count`, `mempalace_drawer`. If the source material is
missing, unreadable, or fundamentally ambiguous, set `needs_clarification: true`
with `clarifying_questions` and honest `confidence`.
