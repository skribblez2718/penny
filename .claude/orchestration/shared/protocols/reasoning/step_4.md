# TASK ROUTING DECISION

Make the critical routing decision based on semantic understanding.

## CRITICAL PRE-CHECK - Skill Invocation Enforcement

Before proceeding, verify:

### 1. Explicit Skill Mention
- IF user says "use [skill-name]", "run [skill-name]", "invoke [skill-name]"
- THEN → **MUST** use Skill tool to invoke that skill
- DO NOT execute task directly
- Example: "use develop-skill" → Route to COGNITIVE SKILL ORCHESTRATION

### 2. Task Matches Available Skills
- IF task matches pattern of existing skill:
  - **develop-skill** → Workflow/skill creation AND system modifications
  - **develop-learnings** → Transform experiences to structured learnings
- THEN → Either invoke skill directly OR recommend skill to user

### 3. Monolithic Execution Prohibition
- NEVER bypass skill orchestration for tasks that match skill patterns
- NEVER execute multi-phase cognitive work directly without agent orchestration
- If tempted to "just generate files directly" → STOP and invoke appropriate skill

### 4. HARD ENFORCEMENT: Step 3b Skill Detection Results

**IF Step 3b detected skills with confidence >= 0.1:**
- DIRECT tool usage is **BLOCKED** for complex work
- You MUST choose COGNITIVE SKILL ORCHESTRATION or DYNAMIC SKILL SEQUENCING
- This is NON-NEGOTIABLE

**Validation Question:** "Should I invoke a skill for this task instead of executing directly?"

## Routing Options (2-Route Model)

All cognitive work flows through one of two routes:

### Route: COGNITIVE SKILL ORCHESTRATION

**Select this route when:**
- Task benefits from multi-phase cognitive processing
- Task requires systematic discovery → analysis → synthesis → generation → validation
- Task matches existing **COMPOSITE** skill patterns
- Task complexity benefits from structured workflow with gate checks
- Keywords suggest multi-step cognitive work: "create", "develop", "analyze and build"
- User explicitly mentions skill name (MANDATORY invocation)
- **System modifications** (skills, agents, protocols, architecture) → use develop-skill

**MANDATORY Skill Execution Sequence:**
1. Invoke skill via `Skill` tool → Returns SKILL.md content
2. **IMMEDIATELY execute entry.py:**
   ```bash
   python3 ${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/{skill_name}/entry.py "{task_id}" --domain {domain}
   ```
3. Entry.py outputs Phase 0 directive with agent to invoke
4. Invoke agent via `Task` tool with `subagent_type: {agent-name}`
5. After agent completes, execute next phase script as directed
6. Repeat until workflow completes

**DO NOT:**
- Read files manually after skill invocation
- Skip entry.py execution
- Bypass the Python orchestration

**Memory Protocol Enforcement:**
- Workflow metadata WILL BE created before agents are invoked
- All agents WILL read and write memory files per protocol
- Workflow completion WILL prompt for develop-learnings invocation

### Route: DYNAMIC SKILL SEQUENCING

**Select this route when:**
- Step 3b detected **ATOMIC skills** (orchestrate-*) with confidence >= 0.5
- Task requires multiple cognitive functions but doesn't match a composite skill
- Query contains multiple action verbs (e.g., "analyze... then synthesize", "research and recommend")
- Task involves comparison, analysis, synthesis, or recommendation

**Execution:**
```bash
python3 ${CAII_DIRECTORY}/.claude/orchestration/protocols/execution/dynamic-skill-sequencing/entry.py --state {state_file}
```

**How It Works:**
1. Analyze Requirements → Determine which cognitive functions are needed
2. Plan Sequence → Order orchestrate-* skill invocations based on context
3. Invoke Skills → Execute each orchestrate-* skill in sequence
4. Verify Completion → Ensure all cognitive functions completed successfully

**Example sequences:**
| Task Type | Skill Sequence |
|-----------|----------------|
| Research + Synthesis | orchestrate-research → orchestrate-synthesis |
| Analysis + Synthesis | orchestrate-analysis → orchestrate-synthesis |
| Full research | orchestrate-clarification → orchestrate-research → orchestrate-analysis → orchestrate-synthesis |
| Compare options | orchestrate-research → orchestrate-analysis → orchestrate-synthesis |

**When uncertain about complexity, default to `dynamic-skill-sequencing`.**

## Output Requirements

After processing this step, clearly state:
- The selected route (SKILL ORCHESTRATION / DYNAMIC SEQUENCING)
- Justification for the routing decision
- If skill route: which skill(s) apply
- If dynamic sequencing: which orchestrate-* skills in what order
- Any pre-checks that were triggered
