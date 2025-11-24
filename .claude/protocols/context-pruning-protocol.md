# Context Pruning Protocol

## Metadata

- **Type:** optimization
- **Purpose:** Progressive context pruning ensures memory files remain consumable by compressing completed phase outputs while preserving essential knowledge for downstream phases. Without pruning, memory files grow to 1,000-2,800 lines, consuming 60-70% of available context budget and causing agent "stalling."

## Core Principles

### Progressive Compression

Each phase completion triggers compression of that phase's detailed output into summary form. Detailed execution logs are pruned; decisions and discoveries are preserved.

### Scope-Aware Retention

Context retention is determined by downstream consumption needs:
- **Always retained:** Workflow metadata, key decisions, architecture choices
- **Conditionally retained:** Detailed findings needed by immediate successor phases
- **Aggressively pruned:** Process descriptions, intermediate reasoning, exploratory paths

### Johari Window as Compression Target

Each completed phase's detailed Johari output (often 400-800 lines) compresses to:
- **open:** 200-300 tokens (confirmed core decisions only)
- **hidden:** 200-300 tokens (key insights discovered)
- **blind:** 150-200 tokens (gaps identified)
- **unknown:** 150-200 tokens (questions for registry)
- **Total:** 1,200 tokens maximum (~150-200 lines in markdown)

## Execution Schedule

- **When:** After each phase's final agent completes and before next phase starts
- **Who:** The orchestrating skill invokes pruning as post-phase action
- **What pruned:** Detailed execution logs, verbose explanations, redundant confirmations
- **What preserved:** Decisions, discoveries, unknowns resolved, new unknowns identified

## Pruning Levels

### Current Phase (N)
- **Compression:** No pruning - full detail retained for active work

### Immediate Predecessor (N-1)
- **Compression:** Moderate compression
- **Preserve:** Decisions and key findings
- **Compress:** Process descriptions
- **Remove:** Verbose explanations
- **Retention:** 40-50% of original detail

### Two Phases Back (N-2)
- **Compression:** Aggressive compression
- **Compress to:** Johari summary only (1,200 tokens)
- **Remove:** All process descriptions
- **Preserve:** Only decisions and critical discoveries
- **Retention:** 15-20% of original detail

### Three+ Phases Back (N-3+)
- **Compression:** Archive-level compression
- **Compress to:** Executive summary (300-500 tokens)
- **Preserve:** Only decisions that affect system architecture
- **Archive:** Full detail to separate archive file
- **Retention:** 5-10% of original detail

## Implementation Methods

### Method 1: In-Place Compression (RECOMMENDED)

Directly edit memory file to replace verbose sections with compressed summaries

**Steps:**
1. Identify completed phase section in memory file
2. Extract all OPEN/HIDDEN/BLIND/UNKNOWN quadrants
3. Compress each quadrant using decision-focused writing
4. Replace original section with compressed version
5. Verify token count compliance (1,200 max)

### Method 2: Archive and Summarize

Move detailed phase output to archive, replace with summary link

**Steps:**
1. Extract completed phase full output
2. Write to `.claude/memory/archives/task-{id}-phase-{n}.md`
3. Generate compressed summary (1,200 tokens max)
4. Replace phase section with summary + archive link
5. Update workflow metadata with archive reference

### Method 3: Progressive Summarization

Maintain summary section that grows; prune details after each phase

**Steps:**
1. Maintain "COMPRESSED CONTEXT" section at top of memory file
2. After each phase, append compressed summary to this section
3. Remove or compress detailed phase output
4. Keep COMPRESSED CONTEXT section as primary reference
5. Downstream agents read compressed section first

## Compression Techniques

### Decision-Focused Writing

**Before:**
> We conducted extensive research into authentication methods, examining OAuth2, SAML, and JWT approaches. After analyzing security implications, developer experience, and ecosystem maturity, we concluded that OAuth2 with Google provider would be most suitable.

**After:**
> Selected OAuth2/Google (vs SAML, JWT) for superior DX, security, and ecosystem support.

**Compression Ratio:** 95% reduction (41 words → 12 words)

### List Consolidation

**Before:**
- Researched authentication libraries
- Evaluated security implications
- Assessed developer experience
- Reviewed documentation quality
- Tested integration complexity
- Compared performance characteristics

**After:**
> Auth library selection: passport.js (security, DX, docs, integration ease)

**Compression Ratio:** 70% reduction (30 words → 9 words)

### Abbreviation Standardization

Common abbreviations to use consistently:
- **API** - Application Programming Interface
- **CRUD** - Create Read Update Delete
- **TDD** - Test-Driven Development
- **JWT** - JSON Web Token
- **REST** - Representational State Transfer
- **OWASP** - Security standards
- **DB** - Database
- **UI/UX** - User Interface/Experience
- **Auth** - Authentication
- **CI/CD** - Continuous Integration/Deployment

### Reference Over Repetition

**Before:**
> The authentication system uses JWT tokens as described in Phase 1. The API design incorporates JWT authentication as outlined in Phase 2. The implementation follows the JWT approach selected earlier.

**After:**
> Auth implementation per Phase 1 JWT decision.

**Compression Ratio:** 80% reduction (35 words → 7 words)

### Quantified Summaries

**Before:**
> We identified several security vulnerabilities including SQL injection risks, XSS attack vectors, and CSRF weaknesses. Each was addressed through appropriate mitigation strategies.

**After:**
> Fixed 3 security issues: SQL injection (parameterized queries), XSS (sanitization), CSRF (tokens).

**Compression Ratio:** 70% reduction (27 words → 15 words)

## Target Structure

### Memory File Target Structure Post-Pruning

**Section: Workflow Metadata**
- **Lines:** 50-100 lines
- **Pruning:** NEVER PRUNED
- **Content:** Task ID, domain, requirements, success criteria

**Section: Compressed Context**
- **Lines:** 150-200 lines
- **Pruning:** GROWS PROGRESSIVELY
- **Content:**
  - Phase 0 Summary (Johari compressed - 1,200 tokens max)
  - Phase 1 Summary (Johari compressed - 1,200 tokens max)
  - Phase 2 Summary (Johari compressed - 1,200 tokens max)

**Section: Current Phase Detail**
- **Lines:** 100-200 lines
- **Pruning:** ACTIVE WORK
- **Content:** Full Johari output for phase currently executing

**Section: Unknown Registry**
- **Lines:** 50-100 lines
- **Pruning:** MAINTAINED THROUGHOUT
- **Content:** Active unknowns requiring resolution

**Section: Validation Results**
- **Lines:** 50-100 lines
- **Pruning:** CONDITIONALLY RETAINED
- **Content:** Recent validation outputs if needed by downstream phases

**Totals:**
- **Target lines:** 400-600 lines (down from 1,000-2,800)
- **Token budget:** 3,000-5,000 tokens context load per agent (down from 8,000-12,000)

## Effectiveness Metrics

### Memory File Size
- **Before optimization:** 1,000-2,800 lines
- **After Phase 0:** 200-300 lines
- **After Phase 1:** 300-400 lines
- **After Phase 2:** 400-500 lines
- **After Phase 3:** 500-600 lines
- **Maximum:** 800 lines at any point

### Context Load Per Agent
- **Before:** 8,000-12,000 tokens
- **Target:** 2,000-3,000 tokens
- **Reduction:** 60-75%

### Agent Execution Time
- **Before:** 90-180 seconds per agent
- **Target:** 45-90 seconds per agent
- **Reduction:** 40-50%

### Workflow Completion Time
- **Before:** 45-60 minutes
- **Target:** 20-30 minutes
- **Reduction:** 40-50%

## Anti-Patterns

### Premature Pruning
- **Description:** Pruning context before downstream phases have consumed it
- **Symptom:** Agents lack necessary context, request clarification, or make suboptimal decisions
- **Prevention:** Follow scope-aware retention - keep detailed findings until immediate successor completes

### Over-Pruning Decisions
- **Description:** Compressing key decisions into summaries that lose critical nuance
- **Symptom:** Downstream phases revisit already-made decisions or contradict earlier choices
- **Prevention:** Preserve decision rationale, alternatives considered, and trade-offs accepted

### Inconsistent Compression
- **Description:** Applying different compression levels to similar content across phases
- **Symptom:** Memory file has uneven detail levels, some phases verbose while others over-compressed
- **Prevention:** Apply standard compression techniques consistently; use token budgets as objective measure

### Archive Orphaning
- **Description:** Moving content to archives without maintaining reference links
- **Symptom:** Critical historical context becomes inaccessible, forcing agents to repeat research
- **Prevention:** Always include archive references when moving content; maintain archive index

### Compression Without Validation
- **Description:** Pruning content without verifying downstream phases don't need it
- **Symptom:** Agents repeatedly ask for context that was pruned prematurely
- **Prevention:** Review downstream phase requirements before pruning; err on side of retention for N-1

## Protocol Integration

### Integration with Existing Protocols

This protocol integrates with:

#### agent-protocol-core.md Section 2.2: Scoped Context Loading
- Scoped loading defines what each agent reads
- Pruning ensures what they read is compressed and relevant
- Together achieve 60-75% reduction in context overhead

#### agent-protocol-core.md Section 5.2: Progressive Summarization
- Defines compression format (Johari Window)
- Specifies token limits per quadrant
- Pruning protocol implements these specifications

#### johari.md: Token Limits and Compression Standards
- Defines target token budgets
- Provides compression technique examples
- Pruning protocol applies these techniques systematically

## Workflow Example

Consider develop-project workflow with 6 phases:

### Phase 0: Requirements Discovery and Analysis
- **Detailed output:** 600 lines
- **Action:** No pruning (current phase)
- **Memory file size:** 600 lines

### Phase 1: Research and Decision Synthesis
- **Detailed output:** 500 lines
- **Phase 0 status:** N-1 (immediate predecessor)
- **Action:** Moderate compression of Phase 0 (600 → 240 lines, 60% reduction)
- **Memory file size:** 240 + 500 = 740 lines

### Phase 2: Architecture Design and Validation
- **Detailed output:** 450 lines
- **Phase 1 status:** N-1
- **Phase 0 status:** N-2
- **Action:**
  - Moderate compression of Phase 1 (500 → 200 lines, 60% reduction)
  - Aggressive compression of Phase 0 (240 → 150 lines, 38% further reduction)
- **Memory file size:** 150 + 200 + 450 = 800 lines

### Phase 3: Implementation Planning and Foundation
- **Detailed output:** 400 lines
- **Phase 2 status:** N-1
- **Phase 1 status:** N-2
- **Phase 0 status:** N-3
- **Action:**
  - Moderate compression of Phase 2 (450 → 180 lines)
  - Aggressive compression of Phase 1 (200 → 150 lines)
  - Archive compression of Phase 0 (150 → 80 lines + archive)
- **Memory file size:** 80 + 150 + 180 + 400 = 810 lines

**Summary:**
- **Without pruning:** At Phase 3 completion: ~2,000 lines
- **With pruning:** 810 lines (60% reduction)

## Implementation Checklist

### Setup Phase
- Define compression schedule for your workflow's phases
- Establish token budgets per phase type
- Create archive directory structure if using METHOD 2
- Document which content is ALWAYS/CONDITIONALLY/AGGRESSIVELY pruned

### Execution Phase (After Each Phase)
- Identify completed phase section in memory file
- Determine phase age (N-1, N-2, N-3+)
- Apply appropriate compression level
- Validate compressed content meets token budget
- Verify essential decisions and discoveries preserved
- Update workflow metadata with compression timestamp

### Validation Phase
- Measure memory file size against targets
- Monitor agent context load tokens
- Track agent execution time trends
- Verify downstream agents have adequate context
- Collect feedback on information availability

### Optimization Phase
- Analyze which content was frequently referenced
- Identify over-pruned sections causing re-research
- Refine compression schedules based on actual usage
- Update compression techniques based on effectiveness
- Document lessons learned for similar workflows

## Success Factors

### Consistency
Apply pruning systematically after every phase, not sporadically

### Measurement
Track memory file size and agent performance metrics to validate effectiveness

### Balance
Preserve essential context while aggressively pruning process descriptions

### Automation
Integrate pruning into workflow orchestration, not manual cleanup

### Validation
Verify downstream agents have adequate context before aggressive pruning

## Conclusion

### Importance
Context pruning is not optional optimization - it is MANDATORY for sustainable multi-phase workflows.

### Without Pruning
- Memory files grow 1,000-2,800 lines
- Context loading consumes 60-70% of agent capacity
- Execution slows 40-50%
- Agents "stall out" in later phases

### With Pruning
- Memory files stay 400-600 lines
- Context loading drops to 30-40% of capacity
- Execution accelerates 40-50%
- Agents maintain performance throughout workflow

### Call to Action
Implement progressive context pruning. Measure results. Refine compression techniques. Achieve sustainable workflow execution.
