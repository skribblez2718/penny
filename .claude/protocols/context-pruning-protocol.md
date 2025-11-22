CONTEXT PRUNING PROTOCOL

PURPOSE

Progressive context pruning ensures memory files remain consumable by compressing completed phase outputs while preserving essential knowledge for downstream phases. Without pruning, memory files grow to 1,000-2,800 lines, consuming 60-70% of available context budget and causing agent "stalling."

CORE PRINCIPLES

PRINCIPLE 1: PROGRESSIVE COMPRESSION
Each phase completion triggers compression of that phase's detailed output into summary form. Detailed execution logs are pruned; decisions and discoveries are preserved.

PRINCIPLE 2: SCOPE-AWARE RETENTION
Context retention is determined by downstream consumption needs:
- ALWAYS RETAINED: Workflow metadata, key decisions, architecture choices
- CONDITIONALLY RETAINED: Detailed findings needed by immediate successor phases
- AGGRESSIVELY PRUNED: Process descriptions, intermediate reasoning, exploratory paths

PRINCIPLE 3: JOHARI WINDOW AS COMPRESSION TARGET
Each completed phase's detailed Johari output (often 400-800 lines) compresses to:
- OPEN: 200-300 tokens (confirmed core decisions only)
- HIDDEN: 200-300 tokens (key insights discovered)
- BLIND: 150-200 tokens (gaps identified)
- UNKNOWN: 150-200 tokens (questions for registry)

Total compressed size: 1,200 tokens maximum (~150-200 lines in markdown)

PRUNING EXECUTION SCHEDULE

WHEN TO PRUNE: After each phase's final agent completes and before next phase starts

WHO EXECUTES: The orchestrating skill invokes pruning as post-phase action

WHAT GETS PRUNED: Detailed execution logs, verbose explanations, redundant confirmations

WHAT GETS PRESERVED: Decisions, discoveries, unknowns resolved, new unknowns identified

PRUNING LEVELS BY PHASE AGE

CURRENT PHASE (N): No pruning - full detail retained for active work

IMMEDIATE PREDECESSOR (N-1): Moderate compression
- Preserve decisions and key findings
- Compress process descriptions
- Remove verbose explanations
- Retain 40-50% of original detail

TWO PHASES BACK (N-2): Aggressive compression
- Compress to Johari summary only (1,200 tokens)
- Remove all process descriptions
- Preserve only decisions and critical discoveries
- Retain 15-20% of original detail

THREE+ PHASES BACK (N-3+): Archive-level compression
- Compress to executive summary (300-500 tokens)
- Preserve only decisions that affect system architecture
- Archive full detail to separate archive file
- Retain 5-10% of original detail

COMPRESSION IMPLEMENTATION METHODS

METHOD 1: IN-PLACE COMPRESSION (Recommended)
Directly edit memory file to replace verbose sections with compressed summaries

EXECUTION STEPS:
1. Identify completed phase section in memory file
2. Extract all OPEN/HIDDEN/BLIND/UNKNOWN quadrants
3. Compress each quadrant using decision-focused writing
4. Replace original section with compressed version
5. Verify token count compliance (1,200 max)

METHOD 2: ARCHIVE AND SUMMARIZE
Move detailed phase output to archive, replace with summary link

EXECUTION STEPS:
1. Extract completed phase full output
2. Write to .claude/memory/archives/task-{id}-phase-{n}.md
3. Generate compressed summary (1,200 tokens max)
4. Replace phase section with summary + archive link
5. Update workflow metadata with archive reference

METHOD 3: PROGRESSIVE SUMMARIZATION
Maintain summary section that grows; prune details after each phase

EXECUTION STEPS:
1. Maintain "COMPRESSED CONTEXT" section at top of memory file
2. After each phase, append compressed summary to this section
3. Remove or compress detailed phase output
4. Keep COMPRESSED CONTEXT section as primary reference
5. Downstream agents read compressed section first

COMPRESSION TECHNIQUES REFERENCE

TECHNIQUE 1: DECISION-FOCUSED WRITING
Before: "We conducted extensive research into authentication methods, examining OAuth2, SAML, and JWT approaches. After analyzing security implications, developer experience, and ecosystem maturity, we concluded that OAuth2 with Google provider would be most suitable."

After: "Selected OAuth2/Google (vs SAML, JWT) for superior DX, security, and ecosystem support."

Compression ratio: 95% reduction (41 words → 2 words decision + 10 words justification)

TECHNIQUE 2: LIST CONSOLIDATION
Before:
- Researched authentication libraries
- Evaluated security implications
- Assessed developer experience
- Reviewed documentation quality
- Tested integration complexity
- Compared performance characteristics

After: "Auth library selection: passport.js (security, DX, docs, integration ease)"

Compression ratio: 70% reduction (30 words → 9 words)

TECHNIQUE 3: ABBREVIATION STANDARDIZATION
Common abbreviations to use consistently:
- API (Application Programming Interface)
- CRUD (Create Read Update Delete)
- TDD (Test-Driven Development)
- JWT (JSON Web Token)
- REST (Representational State Transfer)
- OWASP (security standards)
- DB (Database)
- UI/UX (User Interface/Experience)
- Auth (Authentication)
- CI/CD (Continuous Integration/Deployment)

TECHNIQUE 4: REFERENCE OVER REPETITION
Before: "The authentication system uses JWT tokens as described in Phase 1. The API design incorporates JWT authentication as outlined in Phase 2. The implementation follows the JWT approach selected earlier."

After: "Auth implementation per Phase 1 JWT decision."

Compression ratio: 80% reduction (35 words → 7 words)

TECHNIQUE 5: QUANTIFIED SUMMARIES
Before: "We identified several security vulnerabilities including SQL injection risks, XSS attack vectors, and CSRF weaknesses. Each was addressed through appropriate mitigation strategies."

After: "Fixed 3 security issues: SQL injection (parameterized queries), XSS (sanitization), CSRF (tokens)."

Compression ratio: 70% reduction (27 words → 8 words core + 7 words detail)

MEMORY FILE TARGET STRUCTURE POST-PRUNING

Optimal memory file structure after pruning:

```
WORKFLOW METADATA (50-100 lines) - NEVER PRUNED
- Task ID, domain, requirements, success criteria

COMPRESSED CONTEXT (150-200 lines) - GROWS PROGRESSIVELY
Phase 0 Summary (Johari compressed - 1,200 tokens max)
Phase 1 Summary (Johari compressed - 1,200 tokens max)
Phase 2 Summary (Johari compressed - 1,200 tokens max)
...

CURRENT PHASE DETAIL (100-200 lines) - ACTIVE WORK
Full Johari output for phase currently executing

UNKNOWN REGISTRY (50-100 lines) - MAINTAINED THROUGHOUT
Active unknowns requiring resolution

VALIDATION RESULTS (50-100 lines) - CONDITIONALLY RETAINED
Recent validation outputs if needed by downstream phases
```

Total target: 400-600 lines (down from 1,000-2,800)
Token budget: 3,000-5,000 tokens context load per agent (down from 8,000-12,000)

PRUNING EFFECTIVENESS METRICS

SUCCESS CRITERIA FOR PRUNING IMPLEMENTATION:

Memory File Size:
- Before optimization: 1,000-2,800 lines
- After Phase 0: 200-300 lines
- After Phase 1: 300-400 lines
- After Phase 2: 400-500 lines
- After Phase 3: 500-600 lines
- Maximum at any point: 800 lines

Context Load Per Agent:
- Before: 8,000-12,000 tokens
- Target: 2,000-3,000 tokens
- Reduction: 60-75%

Agent Execution Time:
- Before: 90-180 seconds per agent
- Target: 45-90 seconds per agent
- Reduction: 40-50%

Workflow Completion Time:
- Before: 45-60 minutes
- Target: 20-30 minutes
- Reduction: 40-50%

ANTI-PATTERNS TO AVOID

ANTI-PATTERN 1: PREMATURE PRUNING
Pruning context before downstream phases have consumed it

SYMPTOM: Agents lack necessary context, request clarification, or make suboptimal decisions

PREVENTION: Follow scope-aware retention - keep detailed findings until immediate successor completes

ANTI-PATTERN 2: OVER-PRUNING DECISIONS
Compressing key decisions into summaries that lose critical nuance

SYMPTOM: Downstream phases revisit already-made decisions or contradict earlier choices

PREVENTION: Preserve decision rationale, alternatives considered, and trade-offs accepted

ANTI-PATTERN 3: INCONSISTENT COMPRESSION
Applying different compression levels to similar content across phases

SYMPTOM: Memory file has uneven detail levels, some phases verbose while others over-compressed

PREVENTION: Apply standard compression techniques consistently; use token budgets as objective measure

ANTI-PATTERN 4: ARCHIVE ORPHANING
Moving content to archives without maintaining reference links

SYMPTOM: Critical historical context becomes inaccessible, forcing agents to repeat research

PREVENTION: Always include archive references when moving content; maintain archive index

ANTI-PATTERN 5: COMPRESSION WITHOUT VALIDATION
Pruning content without verifying downstream phases don't need it

SYMPTOM: Agents repeatedly ask for context that was pruned prematurely

PREVENTION: Review downstream phase requirements before pruning; err on side of retention for N-1

INTEGRATION WITH EXISTING PROTOCOLS

This protocol integrates with:

AGENT-PROTOCOL-CORE.MD (Section 2.2: Scoped Context Loading)
- Scoped loading defines what each agent reads
- Pruning ensures what they read is compressed and relevant
- Together achieve 60-75% reduction in context overhead

AGENT-PROTOCOL-CORE.MD (Section 5.2: Progressive Summarization)
- Defines compression format (Johari Window)
- Specifies token limits per quadrant
- Pruning protocol implements these specifications

JOHARI.MD (Token Limits and Compression Standards)
- Defines target token budgets
- Provides compression technique examples
- Pruning protocol applies these techniques systematically

WORKFLOW INTEGRATION EXAMPLE

Consider develop-project workflow with 6 phases:

PHASE 0 COMPLETION: Requirements Discovery & Analysis
- Phase 0 detailed output: 600 lines
- Action: No pruning (current phase)
- Memory file size: 600 lines

PHASE 1 COMPLETION: Research & Decision Synthesis
- Phase 1 detailed output: 500 lines
- Phase 0 now N-1 (immediate predecessor)
- Action: Moderate compression of Phase 0 (600 → 240 lines, 60% reduction)
- Memory file size: 240 + 500 = 740 lines

PHASE 2 COMPLETION: Architecture Design & Validation
- Phase 2 detailed output: 450 lines
- Phase 1 now N-1, Phase 0 now N-2
- Action:
  - Moderate compression of Phase 1 (500 → 200 lines, 60% reduction)
  - Aggressive compression of Phase 0 (240 → 150 lines, 38% further reduction)
- Memory file size: 150 + 200 + 450 = 800 lines

PHASE 3 COMPLETION: Implementation Planning & Foundation
- Phase 3 detailed output: 400 lines
- Phase 2 now N-1, Phase 1 now N-2, Phase 0 now N-3
- Action:
  - Moderate compression of Phase 2 (450 → 180 lines)
  - Aggressive compression of Phase 1 (200 → 150 lines)
  - Archive compression of Phase 0 (150 → 80 lines + archive)
- Memory file size: 80 + 150 + 180 + 400 = 810 lines

At Phase 3 completion without pruning: ~2,000 lines
With progressive pruning: 810 lines (60% reduction)

IMPLEMENTATION CHECKLIST

For workflow orchestrators implementing context pruning:

SETUP PHASE:
[ ] Define compression schedule for your workflow's phases
[ ] Establish token budgets per phase type
[ ] Create archive directory structure if using METHOD 2
[ ] Document which content is ALWAYS/CONDITIONALLY/AGGRESSIVELY pruned

EXECUTION PHASE (After Each Phase):
[ ] Identify completed phase section in memory file
[ ] Determine phase age (N-1, N-2, N-3+)
[ ] Apply appropriate compression level
[ ] Validate compressed content meets token budget
[ ] Verify essential decisions and discoveries preserved
[ ] Update workflow metadata with compression timestamp

VALIDATION PHASE:
[ ] Measure memory file size against targets
[ ] Monitor agent context load tokens
[ ] Track agent execution time trends
[ ] Verify downstream agents have adequate context
[ ] Collect feedback on information availability

OPTIMIZATION PHASE:
[ ] Analyze which content was frequently referenced
[ ] Identify over-pruned sections causing re-research
[ ] Refine compression schedules based on actual usage
[ ] Update compression techniques based on effectiveness
[ ] Document lessons learned for similar workflows

CRITICAL SUCCESS FACTORS

1. CONSISTENCY: Apply pruning systematically after every phase, not sporadically

2. MEASUREMENT: Track memory file size and agent performance metrics to validate effectiveness

3. BALANCE: Preserve essential context while aggressively pruning process descriptions

4. AUTOMATION: Integrate pruning into workflow orchestration, not manual cleanup

5. VALIDATION: Verify downstream agents have adequate context before aggressive pruning

CONCLUSION

Context pruning is not optional optimization - it is MANDATORY for sustainable multi-phase workflows. Without systematic pruning:
- Memory files grow 1,000-2,800 lines
- Context loading consumes 60-70% of agent capacity
- Execution slows 40-50%
- Agents "stall out" in later phases

With disciplined pruning:
- Memory files stay 400-600 lines
- Context loading drops to 30-40% of capacity
- Execution accelerates 40-50%
- Agents maintain performance throughout workflow

Implement progressive context pruning. Measure results. Refine compression techniques. Achieve sustainable workflow execution.
