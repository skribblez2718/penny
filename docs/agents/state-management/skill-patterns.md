# Skill Patterns — Reusable state machine workflows

## What

Ready-to-use state machine structures for common skill shapes: TDD cycle, research flow, decision flow, iterative refinement, and event-driven processing. Each pattern includes states, transitions, guards, and callback integration points.

## Why

Most Penny skills follow one of a small number of workflow shapes. Starting from a pattern keeps machines consistent, reduces copy-paste errors, and makes integration with `orchestrate.py` predictable.

## Rules

1. **Choose the simplest pattern that fits the workflow.** Do not add compound or parallel states unless the shape requires them.
2. **Use compound states for sequential sub-phases inside a single phase.** Example: a review phase with `draft → review → revise`.
3. **Use parallel states only for independent concurrent tracks.** Both regions must reach a final state before the parent can exit.
4. **Guards must prevent infinite loops.** Always include an iteration cap or a confidence threshold.
5. **Each `on_enter` callback handles one dispatch or one state change.** Do not combine multiple agent dispatches in a single callback unless using `invoke_agents_parallel`.
6. **Persist after every externally visible state change.** When running inside `orchestrate.py`, save the session before emitting a directive.

### Pattern selection guide

| Workflow shape | Pattern | State style |
| --- | --- | --- |
| Red-green-refactor with optional loopback | TDD cycle | Simple + loopback transitions |
| Gather → analyze → synthesize | Research flow | Simple with reflexive/conditional transitions |
| Frame → explore → evaluate → decide | Decision flow | Simple with option/criteria guards |
| Improve → evaluate until threshold | Iterative refinement | Simple with iteration cap guards |
| Wait → process → respond on external trigger | Event-driven | Simple with retry guard |

## Procedure/Constraints

### Pattern 1: TDD cycle

Linear red → green → refactor → completed, with loopbacks when tests still fail or new tests appear.

```python
from dataclasses import dataclass, field
from typing import List
from statemachine import StateChart, State

@dataclass
class TDDContext:
    session_id: str
    feature: str
    test_file: str = ""
    impl_file: str = ""
    failing_tests: List[str] = field(default_factory=list)
    refactor_suggestions: List[str] = field(default_factory=list)
    iteration: int = 0
    max_iterations: int = 10

class TDDCycle(StateChart[TDDContext]):
    red = State(initial=True)
    green = State()
    refactor = State()
    completed = State(final=True)

    # Normal flow
    test_written = red.to(green)
    all_pass = green.to(refactor, cond="tests_pass")
    refactored = refactor.to(completed)

    # Loopbacks
    still_failing = green.to(red, cond="tests_still_failing")
    needs_more_refactor = refactor.to(red, cond="discovered_new_tests")

    # Guards
    def tests_pass(self) -> bool:
        return len(self.model.failing_tests) == 0

    def tests_still_failing(self) -> bool:
        return len(self.model.failing_tests) > 0

    def discovered_new_tests(self) -> bool:
        return bool(self.model.refactor_suggestions)

    # Key callbacks
    async def on_enter_red(self):
        self.model.iteration += 1
        # Dispatch: write failing test
        emit_agent("coder", f"Write failing test for {self.model.feature}")

    async def on_enter_green(self):
        # Dispatch: make tests pass
        emit_agent("coder", f"Implement to pass tests for {self.model.feature}")

    async def on_enter_refactor(self):
        # Dispatch: refactor while keeping tests green
        emit_agent("coder", f"Refactor implementation for {self.model.feature}")

    async def on_enter_completed(self):
        await memory_add_drawer(
            wing="penny",
            room="skills",
            content=f"TDD completed: {self.model.session_id}\nFeature: {self.model.feature}\nIterations: {self.model.iteration}"
        )
```

### Pattern 2: Research flow

Gather sources, analyze findings, synthesize an answer. Loop back if confidence is low or more data is needed.

```python
from dataclasses import dataclass, field
from typing import List, Dict
from statemachine import StateChart, State

@dataclass
class ResearchContext:
    session_id: str
    topic: str
    questions: List[str] = field(default_factory=list)
    sources: List[Dict] = field(default_factory=list)
    findings: List[str] = field(default_factory=list)
    confidence: float = 0.0
    min_confidence: float = 0.8
    max_rounds: int = 3
    round: int = 0

class ResearchFlow(StateChart[ResearchContext]):
    question = State(initial=True)
    gathering = State()
    analyzing = State()
    synthesizing = State()
    complete = State(final=True)

    start = question.to(gathering)
    sufficient_data = gathering.to(analyzing, cond="has_enough_data")
    keep_gathering = gathering.to.itself(cond="needs_more_data")

    analyze_complete = analyzing.to(synthesizing)
    low_confidence = synthesizing.to(gathering, cond="below_confidence")
    complete_research = synthesizing.to(complete)

    # Eventless fallback when max rounds reached
    synthesizing.to(complete, cond="max_rounds_reached")

    def has_enough_data(self) -> bool:
        return len(self.model.sources) >= 3 and len(self.model.findings) >= 3

    def needs_more_data(self) -> bool:
        return not self.has_enough_data() and self.model.round < self.model.max_rounds

    def below_confidence(self) -> bool:
        return self.model.confidence < self.model.min_confidence and self.model.round < self.model.max_rounds

    def max_rounds_reached(self) -> bool:
        return self.model.round >= self.model.max_rounds

    async def on_enter_question(self):
        context = await memory_smart_search(f"research {self.model.topic}", limit=3)
        self.model.context = context

    async def on_enter_gathering(self):
        self.model.round += 1
        emit_agent("researcher", f"Gather sources for {self.model.topic}")

    async def on_enter_analyzing(self):
        emit_agent("analyst", f"Analyze findings for {self.model.topic}")

    async def on_enter_synthesizing(self):
        emit_agent("writer", f"Synthesize answer for {self.model.topic}")

    async def on_enter_complete(self):
        await memory_add_drawer(
            wing="penny",
            room="research",
            content=f"Research completed: {self.model.session_id}\nTopic: {self.model.topic}\nConfidence: {self.model.confidence}"
        )
```

### Pattern 3: Decision flow

Frame the decision, explore options, evaluate against criteria, then decide and document.

```python
from dataclasses import dataclass, field
from typing import List, Dict, Optional
from statemachine import StateChart, State

@dataclass
class DecisionContext:
    session_id: str
    decision: str
    options: List[Dict] = field(default_factory=list)
    criteria: List[Dict] = field(default_factory=list)
    evaluations: List[Dict] = field(default_factory=list)
    choice: Optional[str] = None
    rationale: str = ""

class DecisionFlow(StateChart[DecisionContext]):
    framing = State(initial=True)
    exploring = State()
    evaluating = State()
    deciding = State(final=True)

    frame_complete = framing.to(exploring)
    options_sufficient = exploring.to(evaluating, cond="has_options")
    need_more_options = exploring.to.itself(cond="needs_more_options")
    criteria_complete = evaluating.to(deciding, cond="has_evaluations")
    need_criteria = evaluating.to(exploring, cond="missing_criteria")

    def has_options(self) -> bool:
        return len(self.model.options) >= 2

    def needs_more_options(self) -> bool:
        return len(self.model.options) < 2

    def has_evaluations(self) -> bool:
        return len(self.model.evaluations) > 0 and self.model.choice is not None

    def missing_criteria(self) -> bool:
        return len(self.model.criteria) == 0

    async def on_enter_framing(self):
        emit_agent("analyst", f"Frame decision: {self.model.decision}")

    async def on_enter_exploring(self):
        emit_agent("researcher", f"Explore options for {self.model.decision}")

    async def on_enter_evaluating(self):
        emit_agent("analyst", f"Evaluate options for {self.model.decision}")

    async def on_enter_deciding(self):
        emit_agent("writer", f"Document decision: {self.model.decision}")
        await memory_kg_add(
            subject=f"Decision:{self.model.session_id}",
            predicate="decided",
            object=self.model.choice or "unknown"
        )
        await memory_add_drawer(
            wing="penny",
            room="decisions",
            content=f"Decision: {self.model.decision}\nChoice: {self.model.choice}\nRationale: {self.model.rationale}"
        )
```

### Pattern 4: Iterative refinement

Repeatedly refine an artifact and evaluate it until quality passes a threshold or the iteration cap is reached.

```python
from dataclasses import dataclass, field
from typing import List
from statemachine import StateChart, State

@dataclass
class RefinementContext:
    session_id: str
    artifact: str
    current_version: str = ""
    feedback: List[str] = field(default_factory=list)
    quality_score: float = 0.0
    threshold: float = 0.9
    iteration: int = 0
    max_iterations: int = 5

class RefinementFlow(StateChart[RefinementContext]):
    initial = State(initial=True)
    refining = State()
    evaluating = State()
    complete = State(final=True)

    start = initial.to(refining)
    evaluate = refining.to(evaluating)
    not_good_enough = evaluating.to(refining, cond="below_threshold")
    good_enough = evaluating.to(complete, cond="above_threshold")

    # Eventless cap
    evaluating.to(complete, cond="max_iterations_reached")

    def below_threshold(self) -> bool:
        return self.model.quality_score < self.model.threshold and self.model.iteration < self.model.max_iterations

    def above_threshold(self) -> bool:
        return self.model.quality_score >= self.model.threshold

    def max_iterations_reached(self) -> bool:
        return self.model.iteration >= self.model.max_iterations

    async def on_enter_refining(self):
        self.model.iteration += 1
        emit_agent("improver", f"Refine artifact: {self.model.artifact} (iteration {self.model.iteration})")

    async def on_enter_evaluating(self):
        emit_agent("evaluator", f"Evaluate quality of {self.model.artifact}")

    async def on_enter_complete(self):
        await memory_add_drawer(
            wing="penny",
            room="skills",
            content=f"Refinement completed: {self.model.session_id}\nQuality: {self.model.quality_score}\nIterations: {self.model.iteration}"
        )
```

### Pattern 5: Event-driven

Wait for an external event, process it, respond, and complete. Retry a bounded number of times on failure.

```python
from dataclasses import dataclass
from statemachine import StateChart, State

@dataclass
class EventContext:
    session_id: str
    event_type: str
    event_data: dict = None
    response: str = ""
    retries: int = 0
    max_retries: int = 3

class EventFlow(StateChart[EventContext]):
    idle = State(initial=True)
    waiting = State()
    processing = State()
    responding = State()
    done = State(final=True)

    receive = idle.to(waiting)
    process = waiting.to(processing)
    respond = processing.to(responding)
    complete = responding.to(done)
    retry = processing.to(waiting, cond="can_retry")

    # Built-in error transition
    error_execution = processing.to(waiting)

    def can_retry(self) -> bool:
        return self.model.retries < self.model.max_retries

    async def on_enter_waiting(self):
        # Emitted directive pauses until Penny supplies the next event
        print(json.dumps({
            "action": "escalate_to_user",
            "unknown_reason": "awaiting_external_event",
            "questions": [f"Provide next {self.model.event_type} event"],
            "state": self.extract_state(),
        }))

    async def on_enter_processing(self):
        self.model.retries += 1
        emit_agent("processor", f"Process {self.model.event_type} event")

    async def on_enter_responding(self):
        emit_agent("responder", f"Generate response for {self.model.event_type}")

    async def on_enter_done(self):
        await memory_add_drawer(
            wing="penny",
            room="events",
            content=f"Event processed: {self.model.session_id}\nType: {self.model.event_type}\nResponse: {self.model.response}"
        )
```

### Compound vs. simple states

Use these rules when deciding how to structure a machine:

| Use simple states when... | Use compound states when... | Use parallel states when... |
| --- | --- | --- |
| The workflow is a straight sequence or simple loop | A phase has its own sub-phases (draft → review → revise) | Two or more tracks run independently and must both finish |
| Guards and callbacks are easy to scan top-to-bottom | You want to collapse sub-phases in diagrams and logs | Each track has its own final state |
| There is no need for hierarchical visualization | Exiting the parent should implicitly exit any active child | The parent auto-transitions only after all regions finalize |

## Verification

- [ ] The chosen pattern matches the actual workflow shape.
- [ ] Every loop has a guard that can terminate (iteration cap, threshold, or max retries).
- [ ] Compound states group sub-phases; parallel states group independent tracks.
- [ ] `on_enter` callbacks either emit a single agent directive or a parallel batch.
- [ ] Final states store learnings in Mempalace and emit a `complete` directive.
- [ ] Error paths use `error.execution` or explicit guarded transitions, not silent catches.

## Files

| File | Purpose |
| --- | --- |
| `docs/agents/state-management/skill-patterns.md` | This pattern catalog |
| `docs/agents/state-management/state-machine-reference.md` | `python-statemachine` API details |
| `docs/agents/state-management/orchestration-integration.md` | Wiring patterns into `orchestrate.py` |
