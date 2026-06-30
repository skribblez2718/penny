"""
Example: Full TDD Skill with Pi Integration

A complete example showing:
- State machine with compound states
- Async subagent integration
- Mempalace knowledge storage
- Session persistence
- Error handling

This is a reference implementation - adapt for your specific skill.
"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
from datetime import datetime
from pathlib import Path
import json
from statemachine import StateChart, State, HistoryState
import asyncio


# ============================================================
# Context Data Class
# ============================================================

@dataclass
class TDDContext:
    """Session data for TDD workflow"""
    session_id: str = ""
    project_root: str = ""
    feature_name: str = ""
    
    # Files
    test_file: str = ""
    impl_file: str = ""
    
    # Test state
    failing_tests: List[str] = field(default_factory=list)
    passing_tests: List[str] = field(default_factory=list)
    
    # Iteration tracking
    iteration: int = 0
    max_iterations: int = 10
    
    # Results
    refactor_count: int = 0
    decisions: List[str] = field(default_factory=list)
    lessons: List[str] = field(default_factory=list)


# ============================================================
# State Machine Definition
# ============================================================

class TDDWorkflow(StateChart[TDDContext]):
    """
    Complete TDD Workflow with Error Handling
    
    State Flow:
        
        ┌─────────────────────────────────────────────────┐
        │                                                  │
        │   red ─────► green ─────► refactor ─────► doc  │
        │    ▲           │               │              │
        │    │           │               │              │
        │    └───────────┘               └──────────────┘│
        │    still_failing                needs_more      │
        │                                  refactor       │
        └─────────────────────────────────────────────────┘
        
        Plus: error_execution handling at any state
    """
    
    # ═══════════════════════════════════════════════════════
    # States
    # ═══════════════════════════════════════════════════════
    
    class implementing(State.Compound):
        """Hierarchical state for implementation phase"""
        writing_test = State(initial=True)
        writing_code = State()
        test_failing = State()
        
        test_written = writing_test.to(writing_code)
        test_still_fails = writing_code.to(test_failing)
        test_fixed = test_failing.to(writing_code)
    
    reviewing = State()
    documenting = State()
    complete = State(final=True)
    
    # Error state
    error = State(final=True)
    
    # ═══════════════════════════════════════════════════════
    # Transitions
    # ═══════════════════════════════════════════════════════
    
    # Normal flow
    start = implementing.to(implementing.writing_test)
    test_passes = implementing.to(reviewing, cond="all_tests_pass")
    needs_refactor = reviewing.to(implementing.writing_test)
    refactored = reviewing.to(documenting, cond="refactor_complete")
    documented = documenting.to(complete)
    
    # Error handling
    error_execution = implementing.to(error)
    retry_from_error = error.to(implementing, cond="can_retry")
    
    # ═══════════════════════════════════════════════════════
    # Guards
    # ═══════════════════════════════════════════════════════
    
    def all_tests_pass(self) -> bool:
        """All tests must pass before refactor"""
        return len(self.model.failing_tests) == 0
    
    def refactor_complete(self) -> bool:
        """Refactoring is satisfactory"""
        return self.model.refactor_count >= 1
    
    def can_retry(self) -> bool:
        """Can retry after error"""
        return self.model.iteration < self.model.max_iterations
    
    # ═══════════════════════════════════════════════════════
    # Callbacks - Async integration
    # ═══════════════════════════════════════════════════════
    
    async def on_enter_writing_test(self):
        """Start TDD cycle - write failing test"""
        self.model.iteration += 1
        
        if self.model.iteration > self.model.max_iterations:
            raise RuntimeError(f"Max iterations exceeded: {self.model.max_iterations}")
        
        print(f"\n{'='*60}")
        print(f"🔴 RED PHASE (iteration {self.model.iteration})")
        print(f"{'='*60}")
        
        # Get context from Mempalace
        context = await self._get_context()
        
        # Execute via subagent (simulated for example)
        result = await self._subagent("coder", f"""
        Write a failing test for: {self.model.feature_name}
        
        Previous context:
        {context}
        
        Test file: {self.model.test_file or 'create new'}
        
        Write a test that describes expected behavior.
        The test should fail (not implemented yet).
        
        Return JSON:
        - test_file: str
        - failing_tests: list of test names
        - test_code: the test code written
        """)
        
        self.model.test_file = result.get("test_file")
        self.model.failing_tests = result.get("failing_tests", [])
        
        print(f"   Test file: {self.model.test_file}")
        print(f"   Failing tests: {self.model.failing_tests}")
    
    async def on_enter_writing_code(self):
        """Make tests pass"""
        print(f"\n{'='*60}")
        print(f"🟢 GREEN PHASE")
        print(f"{'='*60}")
        
        result = await self._subagent("coder", f"""
        Make tests pass for: {self.model.feature_name}
        
        Test file: {self.model.test_file}
        Failing tests: {self.model.failing_tests}
        
        Write minimum implementation to pass.
        Don't worry about perfect code yet.
        
        Return JSON:
        - impl_file: str
        - failing_tests: remaining failures (empty if all pass)
        - passing_tests: tests that pass
        """)
        
        self.model.impl_file = result.get("impl_file")
        self.model.failing_tests = result.get("failing_tests", [])
        self.model.passing_tests = result.get("passing_tests", [])
        
        if self.model.failing_tests:
            print(f"   ⚠️ Tests still failing: {self.model.failing_tests}")
            # Transition to test_failing will happen via guard
        else:
            print(f"   ✅ All tests passing!")
    
    async def on_enter_reviewing(self):
        """Review and refactor"""
        print(f"\n{'='*60}")
        print(f"🔵 REFACTOR PHASE")
        print(f"{'='*60}")
        
        result = await self._subagent("coder", f"""
        Refactor implementation: {self.model.feature_name}
        
        Implementation: {self.model.impl_file}
        Tests: {self.model.test_file}
        
        Improve code quality:
        - Remove duplication
        - Improve naming
        - Extract methods
        - Apply design patterns
        
        Return JSON:
        - changes: list of changes made
        - suggestions: remaining improvement suggestions
        """)
        
        changes = result.get("changes", [])
        suggestions = result.get("suggestions", [])
        
        if changes:
            self.model.refactor_count += 1
            self.model.decisions.append(f"Refactored: {', '.join(changes)}")
            print(f"   Refactored: {changes}")
        
        if suggestions:
            print(f"   Remaining suggestions: {suggestions}")
    
    async def on_enter_documenting(self):
        """Document the feature"""
        print(f"\n{'='*60}")
        print(f"📝 DOC PHASE")
        print(f"{'='*60}")
        
        result = await self._subagent("coder", f"""
        Document: {self.model.feature_name}
        
        Files:
        - {self.model.test_file}
        - {self.model.impl_file}
        
        Add/update:
        - Docstrings
        - README updates if needed
        - API documentation
        
        Return JSON:
        - docs_updated: list of files
        """)
        
        print(f"   Documented: {result.get('docs_updated', [])}")
    
    async def on_enter_complete(self):
        """Workflow complete - store learnings"""
        print(f"\n{'='*60}")
        print(f"✅ COMPLETE")
        print(f"{'='*60}")
        
        # Store in Mempalace
        await self._store_learnings()
        
        print(f"   Session: {self.model.session_id}")
        print(f"   Iterations: {self.model.iteration}")
        print(f"   Refactors: {self.model.refactor_count}")
    
    async def on_enter_error(self):
        """Handle errors gracefully"""
        print(f"\n{'='*60}")
        print(f"❌ ERROR STATE")
        print(f"{'='*60}")
        print(f"   Iteration: {self.model.iteration}")
        print(f"   Can retry: {self.can_retry()}")
        
        if self.can_retry():
            print("   Will attempt to recover...")
    
    # ═══════════════════════════════════════════════════════
    # Helper Methods
    # ═══════════════════════════════════════════════════════
    
    async def _get_context(self) -> str:
        """Get relevant context from Mempalace"""
        try:
            # This would call the actual memory tool
            context = await memory_smart_search(
                f"TDD patterns {self.model.feature_name}",
                room="technical",
                limit=3
            )
            return context or "No previous context found."
        except Exception:
            return "No previous context found."
    
    async def _subagent(self, agent: str, task: str) -> Dict[str, Any]:
        """Execute via subagent"""
        try:
            # This would call the actual subagent tool
            result = await subagent(
                agent=agent,
                task=task,
                cwd=self.model.project_root
            )
            return result
        except Exception as e:
            # Error will trigger error_execution transition
            raise
    
    async def _store_learnings(self):
        """Store session learnings in Mempalace"""
        try:
            await memory_add_drawer(
                wing="penny",
                room="skills",
                content=f"""
                TDD Session: {self.model.session_id}
                Feature: {self.model.feature_name}
                
                Files:
                - Test: {self.model.test_file}
                - Implementation: {self.model.impl_file}
                
                Metrics:
                - Iterations: {self.model.iteration}
                - Refactors: {self.model.refactor_count}
                
                Decisions:
                {chr(10).join(f'  - {d}' for d in self.model.decisions)}
                
                Lessons:
                {chr(10).join(f'  - {l}' for l in self.model.lessons)}
                """
            )
            
            # Store relationships
            await memory_kg_add(
                subject=f"TDDSession:{self.model.session_id}",
                predicate="implemented",
                object=f"Feature:{self.model.feature_name}"
            )
        except Exception:
            pass  # Don't fail on storage errors


# ============================================================
# Session Persistence
# ============================================================

class TDDSessionManager:
    """Manage TDD session persistence"""
    
    def __init__(self, session_id: str, project_root: Path):
        self.session_id = session_id
        self.project_root = project_root
        self.sessions_dir = project_root / ".sessions" / "tdd"
        self.state_file = self.sessions_dir / f"{session_id}.json"
        
        # Initialize context
        self.context = TDDContext(
            session_id=session_id,
            project_root=str(project_root)
        )
        
        # Initialize state machine
        self.machine = TDDWorkflow(model=self.context)
    
    def load(self) -> bool:
        """Load existing session. Returns True if found."""
        if self.state_file.exists():
            data = json.loads(self.state_file.read_text())
            
            # Restore context
            for key, value in data.get("context", {}).items():
                setattr(self.context, key, value)
            
            # Note: State machine state restoration would need
            # python-statemachine support for state serialization
            
            return True
        return False
    
    def save(self):
        """Persist session state"""
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.state_file.write_text(json.dumps({
            "session_id": self.session_id,
            "context": self.context.__dict__,
            "timestamp": datetime.now().isoformat()
        }, indent=2, default=str))
    
    def complete(self):
        """Mark session complete - clean up"""
        if self.state_file.exists():
            self.state_file.unlink()
    
    async def run(self, feature_name: str, test_file: str = "") -> bool:
        """Run complete TDD workflow"""
        
        self.context.feature_name = feature_name
        self.context.test_file = test_file
        
        # Resume or start fresh
        if self.load():
            print(f"Resuming session: {self.session_id}")
        else:
            print(f"Starting new session: {self.session_id}")
            self.save()
        
        try:
            # Start workflow
            await self.machine.start()
            
            # Continue until complete
            while not self.machine.is_terminated:
                await asyncio.sleep(0.1)  # Let callbacks complete
            
            # Clean up on success
            self.complete()
            return True
            
        except Exception as e:
            # Save state for recovery
            self.save()
            print(f"Session paused due to error: {e}")
            print(f"Resume with same session_id to continue")
            return False


# ============================================================
# Example Usage
# ============================================================

async def main():
    """Example: Run TDD session"""
    
    session_id = "tdd-user-auth-2026-04-09"
    project_root = Path("/home/user/projects/myapp")
    feature_name = "User Authentication"
    
    manager = TDDSessionManager(session_id, project_root)
    
    success = await manager.run(
        feature_name=feature_name,
        test_file="tests/test_auth.py"
    )
    
    if success:
        print("\n✅ TDD workflow completed successfully!")
    else:
        print("\n⚠️ Session paused - can be resumed")


if __name__ == "__main__":
    # Note: This example requires the actual subagent and memory tools
    # to be available. For testing, mock implementations can be used.
    
    print("TDD Skill Example with Pi Integration")
    print("=" * 60)
    print("\nThis example demonstrates:")
    print("  • Compound states (implementing with sub-states)")
    print("  • Async callbacks for subagent integration")
    print("  • Guards for conditional transitions")
    print("  • Error handling with error state")
    print("  • Session persistence")
    print("  • Mempalace integration for learnings")
    print("\nRun with: python tdd_skill_example.py")
    
    # Uncomment to run:
    # asyncio.run(main())