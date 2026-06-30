"""
Example: Simple TDD Skill Implementation

A minimal but complete example of a skill using python-statemachine.

Run this with: python simple_tdd_example.py
"""

from dataclasses import dataclass, field
from typing import List
from statemachine import StateChart, State


@dataclass
class TDDContext:
    """State data for TDD session"""
    feature_name: str = ""
    test_file: str = ""
    impl_file: str = ""
    failing_tests: List[str] = field(default_factory=list)
    iteration: int = 0


class TDDSession(StateChart[TDDContext]):
    """
    TDD Workflow State Machine
    
    States:
        red: Write a failing test
        green: Make it pass
        refactor: Improve the code
        complete: Done
    
    This is a simple example - see the patterns documentation
    for full integration with Pi subagents and Mempalace.
    """
    
    # Define states
    red = State(initial=True)
    green = State()
    refactor = State()
    complete = State(final=True)
    
    # Define transitions
    test_written = red.to(green)
    still_failing = green.to(red)
    all_pass = green.to(refactor, cond="tests_pass")
    done = refactor.to(complete)
    
    def tests_pass(self) -> bool:
        """Guard: can we proceed to refactor?"""
        return len(self.model.failing_tests) == 0


def demo_state_machine():
    """Demonstrate state machine usage"""
    
    print("=" * 60)
    print("TDD Session State Machine Demo")
    print("=" * 60)
    
    # Create context and state machine
    context = TDDContext(
        feature_name="User Authentication",
        test_file="test_auth.py",
    )
    
    session = TDDSession(model=context)
    
    # Check initial state
    print(f"\n[Initial] State: {session.current_state}")
    print(f"          Is red? {session.red.is_active}")
    
    # Simulate writing a test (red phase)
    print("\n--- RED PHASE ---")
    context.failing_tests = ["test_login_returns_token", "test_logout_clears_session"]
    print(f"Wrote tests for: {context.feature_name}")
    print(f"Failing tests: {context.failing_tests}")
    
    # Transition to green
    session.test_written()
    print(f"\n[Transition] test_written → green")
    print(f"          State: {session.current_state}")
    print(f"          Is green? {session.green.is_active}")
    
    # Simulate tests still failing
    print("\n--- GREEN PHASE (attempt 1) ---")
    print("Tests still failing after implementation attempt")
    session.still_failing()
    print(f"[Transition] still_failing → red")
    print(f"          State: {session.current_state}")
    
    # Try again
    print("\n--- GREEN PHASE (attempt 2) ---")
    print("Fixed implementation, all tests pass!")
    context.failing_tests = []  # Clear failing tests
    session.test_written()
    print(f"[Transition] test_written → green")
    print(f"          State: {session.current_state}")
    
    # Check guard
    print(f"\n[Guard Check] tests_pass? {session.tests_pass()}")
    
    # Transition to refactor
    session.all_pass()  # Auto-fires because guard passes
    print(f"[Transition] all_pass → refactor")
    print(f"          State: {session.current_state}")
    
    # Complete
    session.done()
    print(f"\n[Transition] done → complete")
    print(f"          State: {session.current_state}")
    print(f"          Terminated? {session.is_terminated}")
    
    # Generate diagram
    print("\n" + "=" * 60)
    print("State diagram:")
    print("=" * 60)
    print(session._graph().draw(None))  # Mermaid diagram
    
    return session


async def demo_async_callbacks():
    """Demonstrate async callbacks"""
    
    print("\n" + "=" * 60)
    print("Async Callback Demo")
    print("=" * 60)
    
    context = TDDContext(feature_name="Async Example")
    session = TDDSession(model=context)
    
    # Add async callback
    async def on_enter_red():
        print(f"🔴 Entering RED phase for: {context.feature_name}")
        context.failing_tests = ["test_example"]
    
    # Bind callback
    session.on_enter_red = on_enter_red
    
    # The state machine detects async callbacks automatically
    print("Callbacks can be async - detected automatically!")
    print(f"Initial state: {session.current_state}")


if __name__ == "__main__":
    # Run synchronous demo
    demo_state_machine()
    
    # Run async demo (would need asyncio.run in real usage)
    print("\nNote: Async callbacks work with asyncio.run()")
    print("See full patterns documentation for subagent integration.")