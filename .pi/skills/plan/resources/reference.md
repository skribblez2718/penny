# Plan Skill Reference

Detailed technical reference for the Plan skill.

## State Machine

### States

| State        | Description           | Entry Action                          | Exit Action                   |
| ------------ | --------------------- | ------------------------------------- | ----------------------------- |
| `intake`     | Initial state         | Load Mempalace context, validate goal | Transition to exploring       |
| `exploring`  | Run Echo agent        | Execute explore agent with context    | Parse exploration results     |
| `planning`   | Run Piper agent       | Execute planner agent with context    | Parse plan steps              |
| `critiquing` | Run Carren agent      | Execute critique agent                | Parse verdict                 |
| `revising`   | Handle revision logic | Determine next state                  | Send to exploring or planning |
| `taskifying` | Run Tabitha agent     | Execute taskifier agent               | Parse structured JSON         |
| `complete`   | Final success state   | Store learnings in Mempalace          | None                          |
| `error`      | Final failure state   | Log errors, save state                | None                          |

### Transitions

| Transition       | From       | To         | Guard                  | Description                 |
| ---------------- | ---------- | ---------- | ---------------------- | --------------------------- |
| `start`          | intake     | exploring  | `has_goal()`           | Goal is defined             |
| `explore_done`   | exploring  | planning   | `explore_complete()`   | Exploration has results     |
| `explore_more`   | exploring  | exploring  | -                      | Need more exploration       |
| `plan_done`      | planning   | critiquing | `plan_complete()`      | Plan has steps              |
| `critique_pass`  | critiquing | taskifying | `critique_approved()`  | Critique verdict is APPROVE |
| `critique_fail`  | critiquing | revising   | `has_issues()`         | Critique found issues       |
| `revise_explore` | revising   | exploring  | `needs_more_context()` | Need more exploration       |
| `revise_plan`    | revising   | planning   | `can_fix_plan()`       | Can fix at plan level       |
| `taskify_done`   | taskifying | complete   | `output_valid()`       | Structured JSON is valid    |
| `fail_*`         | any        | error      | `on_error()`           | Subagent failure            |

### Guards

```python
def has_goal(self) -> bool:
    """Goal is defined and non-empty"""
    return bool(self.model.goal)

def explore_complete(self) -> bool:
    """Exploration produced context"""
    return bool(self.model.explore_context)

def plan_complete(self) -> bool:
    """Plan has at least one step"""
    return len(self.model.plan_steps) > 0

def critique_approved(self) -> bool:
    """Critique verdict is APPROVE"""
    return self.model.critique_result.get("verdict") == "APPROVE"

def has_issues(self) -> bool:
    """Critique found issues needing revision"""
    return (
        self.model.critique_result.get("verdict") != "APPROVE"
        and len(self.model.critique_issues) > 0
    )

def needs_more_context(self) -> bool:
    """Revision requires more exploration"""
    return self.model.exploration_iterations < self.model.max_exploration_iterations

def can_fix_plan(self) -> bool:
    """Revision can be done at plan level"""
    return not self.needs_more_context()

def output_valid(self) -> bool:
    """Structured output is valid JSON"""
    return bool(self.model.structured_plan)
```

## Subagent Integration

### Explore Agent

**Purpose**: Gather context from codebase

**Input**:

- Goal
- Constraints
- Previous context from Mempalace

**Output**:

- High-signal findings
- Files with line ranges
- Key symbols/APIs
- Architecture notes
- Open questions/risks

**Prompt File**: `assets/prompts/echo.md`

**Invocation**:

```python
result = await subagent(
    agent="echo",
    task=interpolated_prompt,
    cwd=project_root
)
```

### Planner Agent

**Purpose**: Create execution-grade plan

**Input**:

- Goal
- Constraints
- Explore context

**Output**:

- Plan with numbered steps
- Step details (why, files, changes, verification, rollback)
- Risks & mitigations
- Acceptance criteria

**Prompt File**: `assets/prompts/piper.md`

**Invocation**:

```python
result = await subagent(
    agent="piper",
    task=interpolated_prompt,
    cwd=project_root
)
```

### Critique Agent

**Purpose**: Validate plan quality

**Input**:

- Goal
- Plan text
- Explore context

**Output**:

- Verdict (APPROVE/NEEDS_REVISION/BLOCKED)
- Issues list
- Gaps
- Risks
- Suggestions

**Prompt File**: `assets/prompts/carren.md`

**Invocation**:

```python
result = await subagent(
    agent="carren",
    task=interpolated_prompt,
    cwd=project_root
)
```

### Taskifier Agent

**Purpose**: Convert plan to structured JSON

**Input**:

- Goal
- Plan text
- Plan steps

**Output**:

- Plan checklist (exact copy)
- Structured JSON plan

**Prompt File**: `assets/prompts/tabitha.md`

**Invocation**:

```python
result = await subagent(
    agent="tabitha",
    task=interpolated_prompt,
    cwd=project_root
)
```

## Mempalace Integration

### Context Retrieval (Before Workflow)

```python
async def _get_context(self) -> Dict[str, Any]:
    """Retrieve context from Mempalace"""

    # Previous planning sessions
    sessions = await memory_smart_search(
        f"planning session {self.model.skill_name}",
        wing="penny",
        room="skills",
        limit=3
    )

    # Technical context
    technical = await memory_smart_search(
        "architecture decisions",
        wing="penny",
        room="technical",
        limit=3
    )

    # Knowledge graph relationships
    relationships = await memory_kg_query(
        entity="PlanSkill",
        direction="incoming"
    )

    return {
        "sessions": sessions,
        "technical": technical,
        "relationships": relationships
    }
```

### Learning Storage (After Completion)

```python
async def _store_learnings(self):
    """Store learnings in Mempalace"""

    # Store session record
    await memory_add_drawer(
        wing="penny",
        room="skills",
        content=f"""
        Plan Skill Session: {self.model.session_id}
        Timestamp: {datetime.now().isoformat()}

        Goal: {self.model.goal}

        Plan Steps: {len(self.model.plan_steps)}
        Steps:
        {json.dumps(self.model.plan_steps, indent=2)}

        Iterations: {self.model.iteration}
        Explore Iterations: {self.model.exploration_iterations}

        Key Decisions:
        {self._format_decisions()}

        Issues Encountered:
        {self._format_issues()}

        Lessons Learned:
        {self._format_lessons()}
        """
    )

    # Store knowledge graph relationships
    await memory_kg_add(
        subject=f"PlanSession:{self.model.session_id}",
        predicate="created_plan_for",
        object=self.model.goal
    )

    await memory_kg_add(
        subject=f"PlanSession:{self.model.session_id}",
        predicate="used_skill",
        object="PlanSkill"
    )
```

## Session Persistence

### State File

Location: `.context/{session_id}.json`

```json
{
  "session_id": "plan-001",
  "skill_name": "plan",
  "current_state": "planning",
  "context": {
    "goal": "...",
    "constraints": {},
    "explore_context": {},
    "plan_text": "...",
    "plan_steps": [],
    "structured_plan": {},
    "critique_result": {},
    "iteration": 1,
    "exploration_iterations": 0,
    "errors": [],
    "complete": false
  },
  "timestamp": "2024-01-15T10:30:00"
}
```

### Recovery

```python
manager = PlanSessionManager(session_id="plan-001")
if manager.load():
    # Resume from saved state
    success = await manager.run()
```

## Error Handling

### Error States

| State                     | Trigger              | Recovery                     |
| ------------------------- | -------------------- | ---------------------------- |
| `error` (from intake)     | No goal provided     | Cannot recover - need goal   |
| `error` (from exploring)  | Echo agent failed    | Retry with different context |
| `error` (from planning)   | Piper agent failed   | Retry with more exploration  |
| `error` (from critiquing) | Carren agent failed  | Accept plan without critique |
| `error` (from taskifying) | Tabitha agent failed | Accept plan without JSON     |

### Retry Logic

```python
# In revise state
if self.model.iteration > self.model.max_iterations:
    # Force approval and proceed
    self.model.critique_result["verdict"] = "APPROVE"
    self.send("critique_pass")
```

## Configuration

| Environment Variable    | Default | Description                 |
| ----------------------- | ------- | --------------------------- |
| `PLAN_MAX_ITERATIONS`   | 3       | Maximum revision cycles     |
| `PLAN_SKIP_CRITIQUE`    | false   | Skip critique phase         |
| `PLAN_EXPLORE_PARALLEL` | true    | Run multiple explore agents |
| `PLAN_EXPLORE_MAX`      | 2       | Maximum explore iterations  |

## Testing

### Unit Tests

```python
# test_unit.py

def test_has_goal_guard():
    """has_goal returns True when goal is set"""
    context = PlanContext(session_id="test", goal="test goal")
    workflow = PlanWorkflow(model=context)
    assert workflow.has_goal() == True

def test_explore_complete_guard():
    """explore_complete returns True when context exists"""
    context = PlanContext(session_id="test")
    workflow = PlanWorkflow(model=context)
    assert workflow.explore_complete() == False
    context.explore_context = {"findings": []}
    assert workflow.explore_complete() == True

def test_critique_approved_guard():
    """critique_approved returns True for APPROVE verdict"""
    context = PlanContext(session_id="test")
    workflow = PlanWorkflow(model=context)
    assert workflow.critique_approved() == False
    context.critique_result = {"verdict": "APPROVE"}
    assert workflow.critique_approved() == True
```

### Integration Tests

```python
# test_integration.py

@pytest.mark.asyncio
async def test_full_workflow():
    """Test complete explore → plan → critique → taskify workflow"""
    manager = PlanSessionManager(
        session_id="test-session",
        goal="Add authentication middleware",
        project_root="/tmp/test-project"
    )

    success = await manager.run()
    assert success == True
    assert manager.context.complete == True
    assert len(manager.context.plan_steps) > 0
    assert manager.context.structured_plan != {}
```

## Usage Examples

### Basic Usage

```python
from skills.plan.orchestrate import PlanSessionManager

manager = PlanSessionManager(
    session_id="plan-auth",
    goal="Add OAuth authentication to the API"
)

success = await manager.run()
plan = manager.get_plan()
```

### With Constraints

```python
manager = PlanSessionManager(
    session_id="plan-migrate",
    goal="Migrate from REST to GraphQL",
    constraints={
        "languages": ["typescript"],
        "must_not_touch": ["src/legacy/**"],
        "deadline": "2024-02-01"
    }
)

success = await manager.run()
```

### Skip Critique (Faster)

```python
manager = PlanSessionManager(
    session_id="plan-quick",
    goal="Add logging to services",
    skip_critique=True  # Skip critique phase
)

success = await manager.run()
```

### Resume Session

```python
manager = PlanSessionManager(
    session_id="plan-resume",
    goal=""  # Will be loaded from session
)

if manager.load():
    print(f"Resuming from state: {manager.machine.current_state}")
    success = await manager.run()
```
