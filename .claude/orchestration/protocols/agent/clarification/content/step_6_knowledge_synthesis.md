# Knowledge Synthesis

## Synthesis Framework

Organize all clarification results into the four Johari quadrants:

### OPEN (Known to Both)
**What we explicitly established together**

Include:
- Explicit specifications obtained through questioning
- Validated requirements and constraints
- Confirmed assumptions
- Agreed-upon success criteria
- Clear boundaries and scope definitions

### HIDDEN (Known to User, Discovered by Agent)
**Implicit knowledge made explicit**

Include:
- Implicit requirements made explicit
- Unstated assumptions now documented
- Background context that informs decisions
- Domain knowledge affecting implementation
- Preferences and priorities surfaced

### BLIND (Unknown to User, Revealed by Questions)
**New considerations surfaced**

Include:
- Considerations they hadn't thought of
- Dependencies they weren't aware of
- Edge cases requiring decisions
- Constraints affecting feasibility
- Risk areas identified

### UNKNOWN (Unknown to Both)
**Areas requiring further investigation**

Include:
- Areas still requiring clarification
- External factors needing research
- Technical feasibility questions
- Open decisions marked for later resolution
- Dependencies on external information

## Output Generation

Generate the agent output following the template:

1. **Section 0: Context Loaded** - Document what context was loaded
2. **Section 1: Step Overview** - Summarize clarification process and results
3. **Section 2: Johari Summary** - Structured JSON of four quadrants
4. **Section 3: Downstream Directives** - Next agent and handoff context

## Unknown Registry

Create registry of all unresolved unknowns:

| ID | Phase | Category | Description | Status | Impact |
|----|-------|----------|-------------|--------|--------|
| U1 | {discovery phase} | {technical/business/user} | {description} | Unresolved | {P0-P3} |

## Memory File Update

Write clarification results to task memory:
- Path: `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md`
- Append clarification section with:
  - Specifications generated
  - Johari summary
  - Unknown registry
  - Downstream directive

## Compression Techniques

Apply to keep within token budget:
- Use decisions over descriptions (WHAT decided, not HOW)
- Abbreviate common terms (API, CRUD, TDD, JWT, etc.)
- Use lists over prose
- Reference previous findings, don't repeat
- Quantify, don't elaborate
- Focus on NEW information only

## Completion Criteria

- [ ] Johari quadrants fully populated
- [ ] Unknown registry complete
- [ ] Output follows template format
- [ ] Memory file updated
- [ ] Downstream directive specified
- [ ] Token budget respected (≤5,000 total)
- [ ] Ready for handoff to next agent
