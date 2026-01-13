# Phase 1: Discovery

**Uses Atomic Skill:** `orchestrate-analysis`

## Purpose

Identify resolved Unknowns and map to candidate learning records.

## Domain-Specific Extensions

When discovering learnings, focus on:

1. **Unknown Registry Analysis**
   - Load Unknown Registry from task memory
   - Categorize by status: discovered/resolved/open
   - Identify resolution patterns

2. **Attribution Logic**
   Map resolutions to cognitive functions:

   | Resolution Method | Cognitive Function |
   |-------------------|-------------------|
   | Via questioning | CLARIFICATION |
   | Via information gathering | RESEARCH |
   | Via pattern recognition | ANALYSIS |
   | Via design decisions | SYNTHESIS |
   | During implementation | GENERATION |
   | Via quality checks | VALIDATION |

3. **Candidate Record Generation**
   For each resolved Unknown, create candidate with:
   - `unknown_id`: Original ID from registry
   - `cognitive_function`: Attributed function
   - `context`: What was the situation
   - `resolution`: How was it resolved
   - `pattern_type`: heuristic/anti-pattern/checklist/snippet
   - `reuse_scope`: task-specific/domain/universal

## Resources

- `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/candidate-extraction-guidelines.md`
- `${CAII_DIRECTORY}/.claude/skills/develop-learnings/resources/learnings-schema.md`

## Gate Exit Criteria

- [ ] Unknowns analyzed (discovered/resolved/open)
- [ ] Candidates grouped by cognitive function
- [ ] Attribution to resolving function determined
- [ ] Ready for per-function authoring

## Output

Document candidate learnings in the analysis memory file for use by Phase 2 (Per-Function Authoring).
