# Phase 2: Per-Function Authoring

**Agents:** All 6 cognitive agents (invoked SEQUENTIALLY)

## Purpose

Each agent proposes normalized learning entries for its own learnings files.

## Invocation Sequence

Invoke each agent sequentially:

1. `clarification` → `learnings-{task-id}-clarification-proposals.md`
2. `research` → `learnings-{task-id}-research-proposals.md`
3. `analysis` → `learnings-{task-id}-analysis-proposals.md`
4. `synthesis` → `learnings-{task-id}-synthesis-proposals.md`
5. `generation` → `learnings-{task-id}-generation-proposals.md`
6. `validation` → `learnings-{task-id}-validation-proposals.md`

## Per-Agent Instructions

Each agent:

1. **Receive** candidates for THIS function only
2. **Load** INDEX sections from existing learnings (not full files)
3. **Evaluate** generalizability of each candidate
4. **Propose** action for each:
   - **ADD:** Novel and generalizable
   - **EXTEND:** Enhances existing learning
   - **SKIP:** Redundant or task-specific

## Proposal Format

Each proposal must include:
- `id`: Unique learning ID
- `target_file`: heuristics.md | anti-patterns.md | checklists.md | domain-snippets/
- `action`: ADD | EXTEND | SKIP
- `source_tasks`: Task IDs that contributed
- `origin_unknowns`: Unknown IDs resolved
- `domain_tags`: Applicable domains

## Entry Action Decision Tree

| Criteria | Action |
|----------|--------|
| Too task-specific | SKIP |
| Duplicates existing | SKIP |
| Enhances existing | EXTEND |
| Novel and generalizable | ADD |

## Resources

- `${CAII_DIRECTORY}/.claude/learnings/{function}/heuristics.md` (INDEX only)
- `${CAII_DIRECTORY}/.claude/learnings/{function}/anti-patterns.md` (INDEX only)
- `${CAII_DIRECTORY}/.claude/learnings/{function}/checklists.md` (INDEX only)
- `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/learnings-schema.md`

## Gate Exit Criteria

- [ ] All 6 agents have proposed learnings
- [ ] Proposals documented per function
- [ ] Actions assigned (ADD/EXTEND/SKIP)
- [ ] Ready for integration analysis

## Output

Document proposals in per-agent memory files for use by Phase 2.5 (Integration Analysis).
