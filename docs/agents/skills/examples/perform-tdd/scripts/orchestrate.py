"""
Perform TDD Skill - Orchestration

Test-Driven Development workflow with:
- Python-statemachine for state management
- Pi subagent for execution
- Mempalace for memory
"""

from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from pathlib import Path
from datetime import datetime
from statemachine import StateChart, State
import json
import asyncio
import sys


# ============================================================
# Context Data Class
# ============================================================

@dataclass
class TDDContext:
    """Per-session TDD state data"""
    session_id: str = ""
    project_root: str = ""
    feature_name: str = ""
    
    # Files
    test_file: str = ""
    impl_file: str = ""
    
    # Test state
    failing_tests: List[str] = field(default_factory=list)
    passing_tests: List[str] = field(default_factory=list)
    
    # Workflow
    phase: str = "red"
    iteration: int = 0
    max_iterations: int = 10
    refactor_passes: int = 0
    
    # Results
    decisions: List[str] = field(default_factory=list)
    lessons: List[str] = field(default_factory=list)


# ============================================================
# State Machine Definition
# ============================================================

class TDDWorkflow(StateChart[TDDContext]):
    """
    TDD Workflow State Machine
    
    States:
        red: Write failing test
        green: Make test pass
        refactor: Improve code quality
        document: Add documentation
        complete: Done
        error: Failure state
    """
    
    # ═══════════════════════════════════════════════════════
    # States
    # ═══════════════════════════════════════════════════════
    
    red = State(initial=True)
    green = State()
    refactor = State()
    document = State(final=True)
    error = State(final=True)
    
    # ═══════════════════════════════════════════════════════
    # Transitions
    # ═══════════════════════════════════════════════════════
    
    # Normal flow
    test_written = red.to(green)
    still_failing = green.to(red, cond="can_retry")
    all_pass = green.to(refactor, cond="tests_pass")
    needs_more = refactor.to(red, cond="needs_more_tests")
    refactored = refactor.to(document, cond="refactor_done")
    complete = document.to(document)  # Final state
    
    # Error handling
    error_execution = State.Compound.error.to(error)
    
    # ═══════════════════════════════════════════════════════
    # Guards
    # ═══════════════════════════════════════════════════════
    
    def tests_pass(self) -> bool:
        """All tests must pass before refactor"""
        return len(self.model.failing_tests) == 0
    
    def can_retry(self) -> bool:
        """Can retry if under max iterations"""
        return self.model.iteration < self.model.max_iterations
    
    def needs_more_tests(self) -> bool:
        """Refactor revealed need for more tests"""
        return hasattr(self, '_needs_more_tests') and self._needs_more_tests
    
    def refactor_done(self) -> bool:
        """Refactoring is complete"""
        return self.model.refactor_passes >= 1
    
    # ═══════════════════════════════════════════════════════
    # Callbacks - RED Phase
    # ═══════════════════════════════════════════════════════
    
    async def on_enter_red(self):
        """Write failing test (RED phase)"""
        self.model.phase = "red"
        self.model.iteration += 1
        
        if self.model.iteration > self.model.max_iterations:
            raise RuntimeError(f"Max iterations ({self.model.max_iterations}) exceeded")
        
        print(f"\n{'='*60}")
        print(f"🔴 RED PHASE (iteration {self.model.iteration})")
        print(f"{'='*60}")
        
        # Get context from Mempalace
        context = await self._get_context()
        
        # Load and interpolate prompt
        prompt = self._load_prompt("assets/prompts/red.md")
        prompt = self._interpolate(prompt, {
            "feature_name": self.model.feature_name,
            "test_file": self.model.test_file or "tests/test_{feature}.py",
            "context": context,
            "failing_tests": "\n".join(self.model.failing_tests) if self.model.failing_tests else "None"
        })
        
        # Execute via subagent
        result = await self._subagent("coder", prompt)
        
        # Update state
        self.model.test_file = result.get("test_file", self.model.test_file)
        self.model.failing_tests = result.get("failing_tests", [])
        
        print(f"   Test file: {self.model.test_file}")
        print(f"   Failing tests: {self.model.failing_tests}")
    
    # ═══════════════════════════════════════════════════════
    # Callbacks - GREEN Phase
    # ═══════════════════════════════════════════════════════
    
    async def on_enter_green(self):
        """Make tests pass (GREEN phase)"""
        self.model.phase = "green"
        
        print(f"\n{'='*60}")
        print(f"🟢 GREEN PHASE")
        print(f"{'='*60}")
        
        prompt = self._load_prompt("assets/prompts/green.md")
        prompt = self._interpolate(prompt, {
            "feature_name": self.model.feature_name,
            "test_file": self.model.test_file,
            "failing_tests": "\n".join(f"- {t}" for t in self.model.failing_tests)
        })
        
        result = await self._subagent("coder", prompt)
        
        self.model.impl_file = result.get("impl_file", "")
        self.model.failing_tests = result.get("remaining_failures", [])
        self.model.passing_tests = result.get("passing_tests", [])
        
        if self.model.failing_tests:
            print(f"   ⚠️ Tests still failing: {self.model.failing_tests}")
        else:
            print(f"   ✅ All tests passing!")
    
    # ═══════════════════════════════════════════════════════
    # Callbacks - REFACTOR Phase
    # ═══════════════════════════════════════════════════════
    
    async def on_enter_refactor(self):
        """Refactor for quality (REFACTOR phase)"""
        self.model.phase = "refactor"
        self.model.refactor_passes += 1
        
        print(f"\n{'='*60}")
        print(f"🔵 REFACTOR PHASE (pass {self.model.refactor_passes})")
        print(f"{'='*60}")
        
        prompt = self._load_prompt("assets/prompts/refactor.md")
        prompt = self._interpolate(prompt, {
            "feature_name": self.model.feature_name,
            "impl_file": self.model.impl_file,
            "test_file": self.model.test_file
        })
        
        result = await self._subagent("coder", prompt)
        
        changes = result.get("changes", [])
        if changes:
            self.model.decisions.append(f"Refactored: {', '.join(changes)}")
            print(f"   Refactored: {changes}")
        
        self._needs_more_tests = result.get("needs_more_tests", False)
    
    # ═══════════════════════════════════════════════════════
    # Callbacks - DOCUMENT Phase
    # ═══════════════════════════════════════════════════════
    
    async def on_enter_document(self):
        """Add documentation (DOCUMENT phase)"""
        self.model.phase = "document"
        
        print(f"\n{'='*60}")
        print(f"📝 DOCUMENT PHASE")
        print(f"{'='*60}")
        
        prompt = self._load_prompt("assets/prompts/document.md")
        prompt = self._interpolate(prompt, {
            "feature_name": self.model.feature_name,
            "impl_file": self.model.impl_file,
            "test_file": self.model.test_file
        })
        
        result = await self._subagent("coder", prompt)
        
        docs_updated = result.get("docs_updated", [])
        print(f"   Documented: {docs_updated}")
        
        # Store learnings in Mempalace
        await self._store_learnings()
        
        print(f"\n{'='*60}")
        print(f"✅ TDD COMPLETE")
        print(f"{'='*60}")
        print(f"   Session: {self.model.session_id}")
        print(f"   Iterations: {self.model.iteration}")
        print(f"   Refactor passes: {self.model.refactor_passes}")
        print(f"   Files: {self.model.test_file}, {self.model.impl_file}")
    
    # ═══════════════════════════════════════════════════════
    # Helper Methods
    # ═══════════════════════════════════════════════════════
    
    async def _get_context(self) -> str:
        """Retrieve context from Mempalace"""
        context_parts = []
        
        # Get TDD patterns
        patterns = await memory_smart_search(
            f"TDD patterns {self.model.feature_name}",
            wing="penny",
            room="technical",
            limit=3
        )
        if patterns:
            context_parts.append(f"Previous TDD patterns:\n{patterns}")
        
        # Get related sessions
        sessions = await memory_smart_search(
            f"TDD session {self.model.feature_name}",
            wing="penny",
            room="skills",
            limit=2
        )
        if sessions:
            context_parts.append(f"Related sessions:\n{sessions}")
        
        return "\n\n".join(context_parts) if context_parts else "No previous context found."
    
    async def _subagent(self, agent: str, task: str) -> Dict[str, Any]:
        """Execute via Pi subagent"""
        try:
            result = await subagent(
                agent=agent,
                task=task,
                cwd=self.model.project_root
            )
            return result
        except Exception as e:
            print(f"   ❌ Subagent error: {e}")
            raise
    
    async def _store_learnings(self):
        """Store session learnings in Mempalace"""
        
        summary = f"""
        TDD Session: {self.model.session_id}
        Feature: {self.model.feature_name}
        Timestamp: {datetime.now().isoformat()}
        
        Files:
        - Test: {self.model.test_file}
        - Implementation: {self.model.impl_file}
        
        Metrics:
        - Iterations: {self.model.iteration}
        - Refactor passes: {self.model.refactor_passes}
        
        Decisions:
        {chr(10).join(f'  - {d}' for d in self.model.decisions)}
        
        Lessons:
        {chr(10).join(f'  - {l}' for l in self.model.lessons)}
        """
        
        await memory_add_drawer(
            wing="penny",
            room="skills",
            content=summary
        )
        
        # Store knowledge graph relationship
        await memory_kg_add(
            subject=f"TDDSession:{self.model.session_id}",
            predicate="implemented",
            object=f"Feature:{self.model.feature_name}"
        )
    
    def _load_prompt(self, path: str) -> str:
        """Load prompt template from file"""
        skill_dir = Path(__file__).parent.parent
        prompt_path = skill_dir / path
        return prompt_path.read_text()
    
    def _interpolate(self, template: str, variables: Dict[str, Any]) -> str:
        """Interpolate variables into template"""
        result = template
        for key, value in variables.items():
            result = result.replace(f"{{{{{key}}}}}", str(value))
        return result
    
    def _session_file(self) -> Path:
        """Get session state file path"""
        return Path(self.model.project_root) / ".context" / f"{self.model.session_id}.json"
    
    def save_session(self):
        """Persist session state"""
        file = self._session_file()
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps({
            "session_id": self.model.session_id,
            "current_state": self.current_state,
            "phase": self.model.phase,
            "context": {
                "feature_name": self.model.feature_name,
                "test_file": self.model.test_file,
                "impl_file": self.model.impl_file,
                "failing_tests": self.model.failing_tests,
                "passing_tests": self.model.passing_tests,
                "iteration": self.model.iteration,
                "refactor_passes": self.model.refactor_passes,
                "decisions": self.model.decisions,
                "lessons": self.model.lessons
            },
            "timestamp": datetime.now().isoformat()
        }, indent=2, default=str))


# ============================================================
# Session Manager
# ============================================================

class TDDSessionManager:
    """Manage TDD session lifecycle"""
    
    def __init__(self, session_id: str, feature_name: str, project_root: Path,
                 test_file: str = "", max_iterations: int = 10):
        self.session_id = session_id
        self.project_root = project_root
        
        # Initialize context
        self.context = TDDContext(
            session_id=session_id,
            project_root=str(project_root),
            feature_name=feature_name,
            test_file=test_file,
            max_iterations=max_iterations
        )
        
        # Initialize state machine
        self.machine = TDDWorkflow(model=self.context)
    
    def load(self) -> bool:
        """Load existing session"""
        file = self.project_root / ".context" / f"{self.session_id}.json"
        if file.exists():
            data = json.loads(file.read_text())
            ctx = data.get("context", {})
            self.context.feature_name = ctx.get("feature_name", "")
            self.context.test_file = ctx.get("test_file", "")
            self.context.impl_file = ctx.get("impl_file", "")
            self.context.failing_tests = ctx.get("failing_tests", [])
            self.context.passing_tests = ctx.get("passing_tests", [])
            self.context.iteration = ctx.get("iteration", 0)
            self.context.refactor_passes = ctx.get("refactor_passes", 0)
            self.context.decisions = ctx.get("decisions", [])
            self.context.lessons = ctx.get("lessons", [])
            return True
        return False
    
    async def run(self) -> bool:
        """Execute TDD workflow"""
        
        # Resume or start
        if self.load():
            print(f"Resuming session: {self.session_id}")
            print(f"Current phase: {self.context.phase}")
        else:
            print(f"Starting new TDD session: {self.session_id}")
            print(f"Feature: {self.context.feature_name}")
        
        try:
            # Start workflow
            self.machine.test_written()  # Trigger first transition
            
            # Continue until complete
            while not self.machine.is_terminated:
                await asyncio.sleep(0.1)  # Let callbacks complete
            
            return True
            
        except Exception as e:
            self.machine.save_session()
            print(f"\n❌ Session paused due to error: {e}")
            print(f"Resume with session_id: {self.session_id}")
            return False
    
    def complete(self):
        """Clean up completed session"""
        file = self.project_root / ".context" / f"{self.session_id}.json"
        if file.exists():
            file.unlink()


# ============================================================
# Entry Point
# ============================================================

async def main():
    """CLI entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Perform TDD skill orchestration"
    )
    parser.add_argument(
        "--session-id",
        required=True,
        help="Unique session identifier"
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root directory"
    )
    parser.add_argument(
        "--feature",
        required=True,
        help="Feature name to implement"
    )
    parser.add_argument(
        "--test-file",
        default="",
        help="Test file path (optional)"
    )
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=10,
        help="Maximum TDD iterations"
    )
    
    args = parser.parse_args()
    
    manager = TDDSessionManager(
        session_id=args.session_id,
        feature_name=args.feature,
        project_root=Path(args.project_root),
        test_file=args.test_file,
        max_iterations=args.max_iterations
    )
    
    success = await manager.run()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    asyncio.run(main())