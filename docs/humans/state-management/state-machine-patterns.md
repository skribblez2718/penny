# Common Skill Patterns

This document provides ready-to-use patterns for implementing various skill types with `python-statemachine`.

## Pattern 1: TDD Skill

Test-Driven Development workflow with red-green-refactor cycle.

```python
from statemachine import StateChart, State
from dataclasses import dataclass, field
from typing import List, Optional
import json
from pathlib import Path

@dataclass
class TDDContext:
    """Per-session TDD state data"""
    session_id: str
    feature_name: str
    test_file: str = ""
    implementation_file: str = ""
    failing_tests: List[str] = field(default_factory=list)
    refactor_suggestions: List[str] = field(default_factory=list)
    iteration: int = 0
    max_iterations: int = 10

class TDDSession(StateChart[TDDContext]):
    """TDD workflow state machine"""

    # States
    red = State(initial=True)
    green = State()
    refactor = State()
    doc = State(final=True)

    # Transitions
    test_written = red.to(green)
    still_failing = green.to(red)
    all_pass = green.to(refactor, cond="tests_pass")
    needs_refactor = refactor.to(red, cond="needs_more_refactor")
    refactored = refactor.to(doc)

    # Eventless transition (auto-fires)
    refactor.to(red, cond="discovered_new_tests")

    def tests_pass(self) -> bool:
        return len(self.model.failing_tests) == 0

    def needs_more_refactor(self) -> bool:
        return bool(self.model.refactor_suggestions) and self.model.iteration < 3

    def discovered_new_tests(self) -> bool:
        # Check if refactoring revealed missing test coverage
        return hasattr(self, '_new_tests_found') and self._new_tests_found

    async def on_enter_red(self):
        """Start red phase"""
        self.model.iteration += 1

        if self.model.iteration > self.model.max_iterations:
            raise RuntimeError(f"Max iterations ({self.model.max_iterations}) exceeded")

        # Get context from Mempalace
        context = await memory_smart_search(
            f"TDD patterns {self.model.feature_name}",
            room="technical"
        )

        # Use subagent to write failing test
        result = await subagent(
            agent="coder",
            task=f"""Write a failing test for: {self.model.feature_name}

            Context from previous sessions:
            {context}

            Test file: {self.model.test_file}

            Write a test that describes the expected behavior.
            The test should fail (not implemented yet).
            """,
            cwd=self.project_root
        )

        self.model.failing_tests = result.get("failing_tests", [])
        self.model.test_file = result.get("test_file")

    async def on_enter_green(self):
        """Make tests pass"""
        result = await subagent(
            agent="coder",
            task=f"""Make the tests pass for: {self.model.feature_name}

            Test file: {self.model.test_file}
            Failing tests: {self.model.failing_tests}

            Write the minimum implementation to pass the tests.
            Don't worry about perfect code - we'll refactor next.
            """,
            cwd=self.project_root
        )

        self.model.implementation_file = result.get("implementation_file")
        self.model.failing_tests = result.get("remaining_failures", [])

        # Check if tests pass
        if self.model.failing_tests:
            self.still_failing()  # Transition back to red
        else:
            self.test_written()  # Stay in green, auto-transition will fire

    async def on_enter_refactor(self):
        """Refactor for quality"""
        result = await subagent(
            agent="coder",
            task=f"""Refactor the implementation for: {self.model.feature_name}

            Implementation: {self.model.implementation_file}
            Test: {self.model.test_file}

            Improve code quality while keeping tests green:
            - Remove duplication
            - Improve naming
            - Extract methods
            - Apply design patterns where appropriate

            Do NOT change test behavior.
            """,
            cwd=self.project_root
        )

        self.model.refactor_suggestions = result.get("suggestions", [])

    async def on_enter_doc(self):
        """Document and store learnings"""
        await subagent(
            agent="coder",
            task=f"""Update documentation for: {self.model.feature_name}

            Implementation: {self.model.implementation_file}

            Add/update:
            - Docstrings
            - README updates if needed
            - API documentation
            """,
            cwd=self.project_root
        )

        # Store in Mempalace
        await memory_add_drawer(
            wing="penny",
            room="skills",
            content=f"""
            TDD Session: {self.model.session_id}
            Feature: {self.model.feature_name}
            Iterations: {self.model.iteration}
            Test file: {self.model.test_file}
            Implementation: {self.model.implementation_file}

            Key decisions made during implementation:
            - [Document here]
            """
        )
```

## Pattern 2: Research Skill

Gather, analyze, and synthesize information.

```python
from statemachine import StateChart, State
from dataclasses import dataclass, field
from typing import List, Dict

@dataclass
class ResearchContext:
    session_id: str
    topic: str
    questions: List[str] = field(default_factory=list)
    sources: List[Dict] = field(default_factory=list)
    findings: List[Dict] = field(default_factory=list)
    confidence: float = 0.0
    min_confidence: float = 0.8

class ResearchSession(StateChart[ResearchContext]):
    """Research workflow state machine"""

    # States
    question = State(initial=True)
    gathering = State()
    analyzing = State()
    synthesizing = State()
    complete = State(final=True)

    # Transitions
    define_question = question.to(gathering)
    more_needed = gathering.to(gathering)  # reflexive
    sufficient_data = gathering.to(analyzing, cond="has_enough_data")
    need_clarification = analyzing.to(question)
    analyze_complete = analyzing.to(synthesizing)
    low_confidence = synthesizing.to(gathering)
    complete_research = synthesizing.to(complete)

    # Eventless (auto-fires when confidence high)
    synthesizing.to(complete, cond="high_confidence")

    def has_enough_data(self) -> bool:
        return len(self.model.sources) >= 3 and len(self.model.findings) >= 3

    def high_confidence(self) -> bool:
        return self.model.confidence >= self.model.min_confidence

    async def on_enter_gathering(self):
        """Gather information"""
        result = await subagent(
            agent="researcher",
            task=f"""Research: {self.model.topic}

            Questions to answer:
            {chr(10).join(f'- {q}' for q in self.model.questions)}

            Previous context:
            {await self._get_context()}

            Find credible sources and gather key information.
            Return JSON with:
            - sources: list of {title, url, relevance}
            - findings: list of key insights
            """,
            cwd=self.project_root
        )

        self.model.sources.extend(result.get("sources", []))
        self.model.findings.extend(result.get("findings", []))

    async def on_enter_analyzing(self):
        """Analyze gathered information"""
        result = await subagent(
            agent="analyst",
            task=f"""Analyze research findings for: {self.model.topic}

            Sources: {len(self.model.sources)}
            Findings: {len(self.model.findings)}

            Analyze:
            1. What patterns emerge?
            2. What contradictions exist?
            3. What unknowns remain?
            4. What is the confidence level?

            Return JSON with:
            - patterns: list of identified patterns
            - contradictions: list of conflicts
            - unknowns: remaining questions
            - confidence: 0.0-1.0
            """
        )

        self.model.confidence = result.get("confidence", 0.5)

    async def on_enter_synthesizing(self):
        """Synthesize final answer"""
        result = await subagent(
            agent="writer",
            task=f"""Synthesize research on: {self.model.topic}

            Sources:
            {json.dumps(self.model.sources, indent=2)}

            Findings:
            {json.dumps(self.model.findings, indent=2)}

            Create:
            1. Executive summary
            2. Key findings
            3. Supporting evidence
            4. Limitations
            5. Recommendations
            """
        )

        self.synthesis = result

    async def on_enter_complete(self):
        """Store learnings"""
        await memory_add_drawer(
            wing="penny",
            room="research",
            content=f"""
            Research: {self.model.topic}
            Session: {self.model.session_id}

            Questions: {self.model.questions}
            Sources: {self.model.sources}
            Key Findings: {self.model.findings[:5]}
            Confidence: {self.model.confidence}
            """
        )

    async def _get_context(self) -> str:
        context = await memory_smart_search(
            f"research {self.model.topic}",
            limit=3
        )
        return context or "No previous context found."
```

## Pattern 3: Decision Skill

Frame options, evaluate, and decide.

```python
from statemachine import StateChart, State
from dataclasses import dataclass, field
from typing import List, Dict, Optional

@dataclass
class DecisionContext:
    session_id: str
    decision: str
    options: List[Dict] = field(default_factory=list)
    criteria: List[Dict] = field(default_factory=list)
    evaluations: List[Dict] = field(default_factory=list)
    final_choice: Optional[str] = None
    rationale: str = ""

class DecisionSession(StateChart[DecisionContext]):
    """Decision-making workflow"""

    # States
    framing = State(initial=True)
    exploring = State()
    evaluating = State()
    deciding = State(final=True)

    # Transitions
    frame_complete = framing.to(exploring)
    need_more_options = exploring.to(exploring)
    options_sufficient = exploring.to(evaluating, cond="has_options")
    need_criteria = evaluating.to(exploring)
    evaluate_complete = evaluating.to(deciding)

    def has_options(self) -> bool:
        return len(self.model.options) >= 2

    async def on_enter_framing(self):
        """Define the decision space"""
        result = await subagent(
            agent="analyst",
            task=f"""Frame the decision: {self.model.decision}

            Help me understand:
            1. What is the core question?
            2. What constraints exist?
            3. What outcomes matter?
            4. Who are the stakeholders?

            Establish decision criteria with weights.
            """
        )

        self.model.criteria = result.get("criteria", [])

    async def on_enter_exploring(self):
        """Generate and explore options"""
        result = await subagent(
            agent="researcher",
            task=f"""Explore options for: {self.model.decision}

            Criteria:
            {json.dumps(self.model.criteria, indent=2)}

            Current options:
            {json.dumps(self.model.options, indent=2)}

            Find:
            - Additional options if needed
            - Data for each option
            - Trade-offs between options
            """
        )

        # Merge new options
        for opt in result.get("options", []):
            if opt not in self.model.options:
                self.model.options.append(opt)

    async def on_enter_evaluating(self):
        """Evaluate options against criteria"""
        result = await subagent(
            agent="analyst",
            task=f"""Evaluate options for: {self.model.decision}

            Options:
            {json.dumps(self.model.options, indent=2)}

            Criteria (with weights):
            {json.dumps(self.model.criteria, indent=2)}

            Score each option on each criterion.
            Show the math.
            Identify the best choice.
            """
        )

        self.model.evaluations = result.get("evaluations", [])
        self.model.final_choice = result.get("recommendation")
        self.model.rationale = result.get("rationale", "")

    async def on_enter_deciding(self):
        """Finalize and document decision"""
        await subagent(
            agent="writer",
            task=f"""Document the decision: {self.model.decision}

            Choice: {self.model.final_choice}
            Rationale: {self.model.rationale}

            Create:
            1. Decision summary
            2. Key factors
            3. Alternatives considered
            4. Implementation notes
            5. Review date
            """
        )

        # Store in knowledge graph
        await memory_kg_add(
            subject=f"Decision:{self.model.session_id}",
            predicate="decided",
            object=self.model.final_choice
        )

        await memory_add_drawer(
            wing="penny",
            room="decisions",
            content=f"""
            Decision: {self.model.decision}
            Session: {self.model.session_id}
            Choice: {self.model.final_choice}
            Rationale: {self.model.rationale}
            Alternatives: {[o['name'] for o in self.model.options]}
            """
        )
```

## Pattern 4: Iterative Refinement Skill

Continuous improvement loop with exit criteria.

```python
from statemachine import StateChart, State
from dataclasses import dataclass, field

@dataclass
class RefinementContext:
    session_id: str
    artifact: str  # What we're refining
    current_version: str = ""
    feedback: List[str] = field(default_factory=list)
    iteration: int = 0
    max_iterations: int = 5
    quality_score: float = 0.0
    threshold: float = 0.9

class RefinementSession(StateChart[RefinementContext]):
    """Iterative refinement with quality threshold"""

    # States
    initial = State(initial=True)
    refining = State()
    evaluating = State()
    complete = State(final=True)

    # Transitions
    start = initial.to(refining)
    iterate = refining.to.itself(on="do_refine", cond="can_improve")
    evaluate = refining.to(evaluating)
    not_good_enough = evaluating.to(refining, cond="below_threshold")
    good_enough = evaluating.to(complete, cond="above_threshold")

    # Eventless - stop if max iterations
    evaluating.to(complete, cond="max_iterations_reached")

    def can_improve(self) -> bool:
        return self.model.iteration < self.model.max_iterations

    def below_threshold(self) -> bool:
        return self.model.quality_score < self.model.threshold

    def above_threshold(self) -> bool:
        return self.model.quality_score >= self.model.threshold

    def max_iterations_reached(self) -> bool:
        return self.model.iteration >= self.model.max_iterations

    async def on_enter_refining(self):
        """Refine the artifact"""
        self.model.iteration += 1

        result = await subagent(
            agent="improver",
            task=f"""Refine: {self.model.artifact}

            Current version:
            {self.model.current_version}

            Previous feedback:
            {chr(10).join(f'- {f}' for f in self.model.feedback)}

            Iteration {self.model.iteration}/{self.model.max_iterations}

            Improve based on feedback.
            """,
            cwd=self.project_root
        )

        self.model.current_version = result.get("version")
        self.model.feedback = result.get("new_feedback", [])

    async def on_enter_evaluating(self):
        """Evaluate quality"""
        result = await subagent(
            agent="evaluator",
            task=f"""Evaluate quality of:

            {self.model.current_version}

            Score on:
            - Completeness (0-1)
            - Correctness (0-1)
            - Clarity (0-1)

            Return overall score and specific feedback.
            """
        )

        self.model.quality_score = result.get("score", 0.0)
        self.model.feedback.extend(result.get("feedback", []))
```

## Pattern 5: Event-Driven Skill

Wait for external events, process, respond.

```python
from statemachine import StateChart, State
from dataclasses import dataclass

@dataclass
class EventContext:
    session_id: str
    event_type: str
    event_data: dict = None
    response: str = ""

class EventSession(StateChart[EventContext]):
    """Event-driven workflow with async waits"""

    # States
    idle = State(initial=True)
    waiting = State()
    processing = State()
    responding = State()
    done = State(final=True)

    # Transitions
    receive = idle.to(waiting)
    process = waiting.to(processing)
    respond = processing.to(responding)
    complete = responding.to(done)
    retry = processing.to(waiting)

    # Error handling
    error_execution = processing.to(waiting)

    async def on_enter_waiting(self):
        """Wait for event"""
        # In real implementation, this would integrate with
        # an event queue or message broker
        pass

    async def on_enter_processing(self):
        """Process the event"""
        try:
            result = await subagent(
                agent="processor",
                task=f"""Process event: {self.model.event_type}

                Data: {json.dumps(self.model.event_data, indent=2)}

                Analyze and prepare response.
                """
            )

            self.model.response = result.get("response")
            self.respond()  # Transition to responding

        except Exception as e:
            # Error will trigger error_execution transition
            raise
```

## Session Persistence Utility

Shared utility for persisting sessions:

```python
import json
from datetime import datetime
from pathlib import Path
from typing import TypeVar, Generic, Type

T = TypeVar('T')  # Context type

class SessionManager(Generic[T]):
    """Manage session persistence"""

    def __init__(self, session_id: str, context_class: Type[T], sessions_dir: Path):
        self.session_id = session_id
        self.context = context_class()
        self.sessions_dir = sessions_dir
        self.state_file = sessions_dir / f"{session_id}.json"

    def load(self) -> bool:
        """Load existing session. Returns True if found."""
        if self.state_file.exists():
            data = json.loads(self.state_file.read_text())
            for key, value in data.get("context", {}).items():
                setattr(self.context, key, value)
            self.state = data.get("state", "initial")
            return True
        return False

    def save(self, state: str):
        """Persist session state"""
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.state_file.write_text(json.dumps({
            "session_id": self.session_id,
            "state": state,
            "context": self.context.__dict__,
            "timestamp": datetime.now().isoformat()
        }, indent=2))

    def delete(self):
        """Remove session file"""
        if self.state_file.exists():
            self.state_file.unlink()
```

## Usage Example

```python
# Create session
session_id = "tdd-user-auth-2026-04-09"
project_root = Path("/home/user/projects/myapp")

# Initialize with persistence
manager = SessionManager(session_id, TDDContext, project_root / ".sessions")
manager.context.session_id = session_id
manager.context.feature_name = "User Authentication"

# Create state machine
machine = TDDSession(model=manager.context)

# Run workflow
async def run_tdd():
    # Restore or start fresh
    if manager.load():
        print(f"Resuming session from state: {manager.state}")
    else:
        print("Starting new TDD session")

    # Subscribe to state changes for persistence
    async def on_state_change(event):
        manager.save(machine.current_state)

    # Run until complete
    while not machine.is_terminated:
        # Process current phase
        await machine.send("next")  # or appropriate event

    # Cleanup
    manager.delete()  # Session complete
```
