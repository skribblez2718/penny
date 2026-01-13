"""
Interactive Flow Simulation Runner
==================================

Interactive CLI for simulating orchestration protocol flows.
Supports step-by-step mode, state inspection, and FSM visualization.

Usage:
    python3 interactive_runner.py                          # Full simulation menu
    python3 interactive_runner.py --protocol reasoning     # Reasoning only
    python3 interactive_runner.py --protocol skill --skill develop-skill
    python3 interactive_runner.py --step-by-step           # Pause at transitions
    python3 interactive_runner.py -v --show-state          # Verbose with state

Run: python3 protocols/tests/interactive_runner.py
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

# Add orchestration root to path
_TESTS_DIR = Path(__file__).resolve().parent
_PROTOCOLS_DIR = _TESTS_DIR.parent
_ORCHESTRATION_ROOT = _PROTOCOLS_DIR.parent

if str(_ORCHESTRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_ROOT))
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))


# ==============================================================================
# ANSI Color Codes
# ==============================================================================

class Colors:
    """ANSI color codes for terminal output."""
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    DIM = '\033[2m'


def color(text: str, color_code: str) -> str:
    """Apply color to text."""
    return f"{color_code}{text}{Colors.ENDC}"


def print_header(text: str) -> None:
    """Print a styled header."""
    width = 70
    print()
    print(color("=" * width, Colors.CYAN))
    print(color(f"  {text}", Colors.BOLD + Colors.CYAN))
    print(color("=" * width, Colors.CYAN))
    print()


def print_section(text: str) -> None:
    """Print a section header."""
    print()
    print(color(f"── {text} ", Colors.YELLOW) + color("─" * (50 - len(text)), Colors.DIM))


def print_step(step_num: int | str, description: str, status: str = "pending") -> None:
    """Print a step indicator."""
    status_colors = {
        "pending": Colors.DIM,
        "running": Colors.YELLOW,
        "complete": Colors.GREEN,
        "failed": Colors.RED,
    }
    status_icons = {
        "pending": "○",
        "running": "●",
        "complete": "✓",
        "failed": "✗",
    }
    icon = status_icons.get(status, "○")
    clr = status_colors.get(status, Colors.DIM)
    print(f"  {color(icon, clr)} Step {step_num}: {color(description, clr)}")


def print_state_box(title: str, data: dict) -> None:
    """Print state data in a box."""
    print()
    print(color(f"┌─ {title} ", Colors.BLUE) + color("─" * (60 - len(title)), Colors.BLUE) + color("┐", Colors.BLUE))
    for key, value in data.items():
        if isinstance(value, dict):
            value = json.dumps(value, indent=2, default=str)[:50] + "..."
        elif isinstance(value, list):
            value = f"[{len(value)} items]"
        print(color("│ ", Colors.BLUE) + f"{key}: {value}")
    print(color("└" + "─" * 68 + "┘", Colors.BLUE))


# ==============================================================================
# Simulation Classes
# ==============================================================================

class SimulatedState:
    """Simulated state for protocol execution."""
    
    def __init__(self, protocol_type: str, session_id: str = None):
        self.protocol_type = protocol_type
        self.session_id = session_id or self._generate_id()
        self.current_step: Optional[int] = None
        self.completed_steps: list[int] = []
        self.step_outputs: dict[int, dict] = {}
        self.metadata: dict[str, Any] = {}
        self.fsm_state: str = "INITIALIZED"
        self.created_at = datetime.now().isoformat()
        
    def _generate_id(self) -> str:
        import uuid
        return str(uuid.uuid4())[:12]
    
    def to_dict(self) -> dict:
        return {
            "protocol_type": self.protocol_type,
            "session_id": self.session_id,
            "current_step": self.current_step,
            "completed_steps": self.completed_steps,
            "fsm_state": self.fsm_state,
            "created_at": self.created_at,
        }


class ReasoningSimulator:
    """Simulates the reasoning protocol flow."""
    
    STEP_NAMES = {
        0: "Johari Window Discovery",
        1: "Semantic Understanding",
        2: "Chain of Thought",
        3: "Tree of Thought",
        "3b": "Skill Detection",
        4: "Task Routing",
        5: "Self-Consistency",
        6: "Socratic Self-Interrogation",
        7: "Constitutional Self-Critique",
        8: "Knowledge Transfer",
    }
    
    FULL_SEQUENCE = [0, 1, 2, 3, "3b", 4, 5, 6, 7, 8]
    AGENT_SEQUENCE = [0, 1, 2, 3, "3b", 5, 6, 7, 8]  # Skips Step 4
    
    def __init__(self, step_by_step: bool = False, verbose: bool = False, agent_mode: bool = False):
        self.step_by_step = step_by_step
        self.verbose = verbose
        self.agent_mode = agent_mode
        self.state = SimulatedState("reasoning")
        self.sequence = self.AGENT_SEQUENCE if agent_mode else self.FULL_SEQUENCE
        
    def run(self) -> None:
        """Run the reasoning protocol simulation."""
        print_header("REASONING PROTOCOL SIMULATION")
        
        if self.agent_mode:
            print(color("  Mode: AGENT (skips Step 4)", Colors.YELLOW))
        else:
            print(color("  Mode: FULL (all steps)", Colors.GREEN))
        
        print(f"  Session: {self.state.session_id}")
        print(f"  Steps: {len(self.sequence)}")
        
        for step in self.sequence:
            self._execute_step(step)
            
            if self.step_by_step:
                input(color("\n  Press Enter to continue...", Colors.DIM))
        
        print_section("SIMULATION COMPLETE")
        print(color("  ✓ All reasoning steps executed successfully", Colors.GREEN))
        print(f"  Final FSM State: {color(self.state.fsm_state, Colors.GREEN)}")
        
    def _execute_step(self, step: int | str) -> None:
        """Execute a single reasoning step."""
        step_name = self.STEP_NAMES.get(step, f"Step {step}")
        
        print_section(f"Step {step}: {step_name}")
        print_step(step, step_name, "running")
        
        # Simulate step execution
        time.sleep(0.3)  # Brief pause for visual effect
        
        # Update state
        self.state.current_step = step
        self.state.step_outputs[step] = {"executed": True, "timestamp": datetime.now().isoformat()}
        self.state.completed_steps.append(step)
        self.state.fsm_state = self._get_fsm_state_for_step(step)
        
        if self.verbose:
            print_state_box("State After Step", self.state.to_dict())
        
        print_step(step, step_name, "complete")
        
    def _get_fsm_state_for_step(self, step: int | str) -> str:
        """Get FSM state name for a step."""
        fsm_states = {
            0: "JOHARI_DISCOVERY",
            1: "SEMANTIC_UNDERSTANDING",
            2: "CHAIN_OF_THOUGHT",
            3: "TREE_OF_THOUGHT",
            "3b": "SKILL_DETECTION",
            4: "TASK_ROUTING",
            5: "SELF_CONSISTENCY",
            6: "SOCRATIC_INTERROGATION",
            7: "CONSTITUTIONAL_CRITIQUE",
            8: "KNOWLEDGE_TRANSFER",
        }
        return fsm_states.get(step, "UNKNOWN")


class SkillSimulator:
    """Simulates skill protocol flow."""
    
    SKILL_PHASES = {
        "develop-skill": [
            ("0", "Requirements Clarification", "orchestrate-clarification"),
            ("0.5", "Complexity Analysis", "orchestrate-analysis"),
            ("1", "Workflow Analysis", "orchestrate-analysis"),
            ("2", "Existing Skill Research", "orchestrate-research"),
            ("3", "Skill Synthesis", "orchestrate-synthesis"),
            ("4", "Skill Generation", "orchestrate-generation"),
            ("5", "Validation", "orchestrate-validation"),
        ],
        "develop-learnings": [
            ("0", "Scope Clarification", "orchestrate-clarification"),
            ("1", "Experience Analysis", "orchestrate-analysis"),
            ("2", "Pattern Research", "orchestrate-research"),
            ("3", "Synthesis", "orchestrate-synthesis"),
            ("4", "Learning Generation", "orchestrate-generation"),
            ("5", "Validation", "orchestrate-validation"),
            ("6", "Finalization", "orchestrate-generation"),
        ],
    }
    
    def __init__(self, skill_name: str, step_by_step: bool = False, verbose: bool = False):
        self.skill_name = skill_name
        self.step_by_step = step_by_step
        self.verbose = verbose
        self.state = SimulatedState("skill")
        self.phases = self.SKILL_PHASES.get(skill_name, self.SKILL_PHASES["develop-skill"])
        
    def run(self) -> None:
        """Run the skill protocol simulation."""
        print_header(f"SKILL PROTOCOL: {self.skill_name.upper()}")
        
        print(f"  Skill: {self.skill_name}")
        print(f"  Session: {self.state.session_id}")
        print(f"  Phases: {len(self.phases)}")
        
        for phase_id, phase_name, atomic_skill in self.phases:
            self._execute_phase(phase_id, phase_name, atomic_skill)
            
            if self.step_by_step:
                input(color("\n  Press Enter to continue...", Colors.DIM))
        
        print_section("SKILL COMPLETE")
        print(color(f"  ✓ {self.skill_name.upper()}_COMPLETE", Colors.GREEN))
        
    def _execute_phase(self, phase_id: str, phase_name: str, atomic_skill: str) -> None:
        """Execute a single skill phase."""
        print_section(f"Phase {phase_id}: {phase_name}")
        
        # Phase entry
        print(f"  {color('▶', Colors.BLUE)} Starting phase...")
        print(f"    Atomic Skill: {color(atomic_skill, Colors.CYAN)}")
        
        # Simulate agent invocation
        agent_name = atomic_skill.replace("orchestrate-", "")
        print(f"    Agent: {color(agent_name + '-agent', Colors.YELLOW)}")
        
        time.sleep(0.3)
        
        # Simulate memory file creation
        memory_file = f"task-{self.state.session_id[:8]}-{agent_name}-memory.md"
        print(f"    Memory: {color(memory_file, Colors.DIM)}")
        
        # Update state
        self.state.step_outputs[phase_id] = {
            "phase_name": phase_name,
            "atomic_skill": atomic_skill,
            "memory_file": memory_file,
        }
        self.state.fsm_state = f"PHASE_{phase_id}"
        
        if self.verbose:
            print_state_box("Phase State", {
                "phase_id": phase_id,
                "phase_name": phase_name,
                "atomic_skill": atomic_skill,
                "memory_file": memory_file,
            })
        
        print(f"  {color('✓', Colors.GREEN)} Phase {phase_id} complete")


class AgentSimulator:
    """Simulates agent protocol flow."""
    
    AGENT_STEPS = {
        "clarification": [
            (0, "Learning Injection", "Load domain learnings"),
            (1, "Johari Discovery", "Identify unknown unknowns"),
            (2, "Requirements Analysis", "Analyze requirements"),
            (3, "Clarification Generation", "Generate clarifying questions"),
        ],
        "research": [
            (0, "Learning Injection", "Load domain learnings"),
            (1, "Johari Discovery", "Identify knowledge gaps"),
            (2, "Research Planning", "Plan research approach"),
            (3, "Research Execution", "Execute research"),
            (4, "Findings Synthesis", "Synthesize findings"),
        ],
        "analysis": [
            (0, "Learning Injection", "Load domain learnings"),
            (1, "Johari Discovery", "Identify analysis scope"),
            (2, "Decomposition", "Decompose problem"),
            (3, "Risk Assessment", "Assess risks"),
            (4, "Dependency Mapping", "Map dependencies"),
        ],
        "synthesis": [
            (0, "Learning Injection", "Load domain learnings"),
            (1, "Johari Discovery", "Identify synthesis goals"),
            (2, "Integration Planning", "Plan integration"),
            (3, "Design Synthesis", "Synthesize design"),
        ],
        "generation": [
            (0, "Learning Injection", "Load domain learnings"),
            (1, "Johari Discovery", "Identify generation scope"),
            (2, "Test Design (RED)", "Design tests first"),
            (3, "Implementation (GREEN)", "Implement to pass tests"),
            (4, "Refactoring", "Refactor for quality"),
        ],
        "validation": [
            (0, "Learning Injection", "Load domain learnings"),
            (1, "Johari Discovery", "Identify validation criteria"),
            (2, "Criteria Definition", "Define validation criteria"),
            (3, "Validation Execution", "Execute validation"),
            (4, "Verdict Generation", "Generate GO/NO-GO verdict"),
        ],
    }
    
    def __init__(self, agent_name: str, step_by_step: bool = False, verbose: bool = False):
        self.agent_name = agent_name
        self.step_by_step = step_by_step
        self.verbose = verbose
        self.state = SimulatedState("agent")
        self.steps = self.AGENT_STEPS.get(agent_name, self.AGENT_STEPS["clarification"])
        
    def run(self) -> None:
        """Run the agent protocol simulation."""
        print_header(f"AGENT PROTOCOL: {self.agent_name.upper()}")
        
        print(f"  Agent: {self.agent_name}")
        print(f"  Session: {self.state.session_id}")
        print(f"  Steps: {len(self.steps)}")
        
        for step_num, step_name, description in self.steps:
            self._execute_step(step_num, step_name, description)
            
            if self.step_by_step:
                input(color("\n  Press Enter to continue...", Colors.DIM))
        
        # Generate memory file
        memory_file = f"task-{self.state.session_id[:8]}-{self.agent_name.replace('-agent', '')}-memory.md"
        
        print_section("AGENT COMPLETE")
        print(f"  {color('✓', Colors.GREEN)} {self.agent_name.upper()}_COMPLETE")
        print(f"  Memory File: {color(memory_file, Colors.CYAN)}")
        
    def _execute_step(self, step_num: int, step_name: str, description: str) -> None:
        """Execute a single agent step."""
        print_section(f"Step {step_num}: {step_name}")
        print(f"  {color(description, Colors.DIM)}")
        
        print_step(step_num, step_name, "running")
        time.sleep(0.2)
        
        self.state.current_step = step_num
        self.state.step_outputs[step_num] = {
            "step_name": step_name,
            "description": description,
        }
        
        if self.verbose:
            print_state_box("Step Output", self.state.step_outputs[step_num])
        
        print_step(step_num, step_name, "complete")


# ==============================================================================
# Interactive Menu
# ==============================================================================

def interactive_menu() -> None:
    """Display interactive menu for simulation selection."""
    print_header("ORCHESTRATION FLOW SIMULATOR")
    
    print("  Select a simulation to run:")
    print()
    print(f"  {color('1.', Colors.CYAN)} Reasoning Protocol (Full)")
    print(f"  {color('2.', Colors.CYAN)} Reasoning Protocol (Agent Mode)")
    print(f"  {color('3.', Colors.CYAN)} Skill Protocol (develop-skill)")
    print(f"  {color('4.', Colors.CYAN)} Skill Protocol (develop-learnings)")
    print(f"  {color('5.', Colors.CYAN)} Agent Protocol (clarification-agent)")
    print(f"  {color('6.', Colors.CYAN)} Agent Protocol (research-agent)")
    print(f"  {color('7.', Colors.CYAN)} Agent Protocol (generation-agent)")
    print(f"  {color('8.', Colors.CYAN)} Agent Protocol (validation-agent)")
    print(f"  {color('0.', Colors.CYAN)} Full End-to-End Flow")
    print()
    print(f"  {color('q.', Colors.DIM)} Quit")
    print()
    
    choice = input(color("  Enter choice: ", Colors.YELLOW)).strip().lower()
    
    step_by_step = input(color("  Step-by-step mode? [y/N]: ", Colors.DIM)).strip().lower() == 'y'
    verbose = input(color("  Verbose output? [y/N]: ", Colors.DIM)).strip().lower() == 'y'
    
    print()
    
    if choice == '1':
        ReasoningSimulator(step_by_step=step_by_step, verbose=verbose).run()
    elif choice == '2':
        ReasoningSimulator(step_by_step=step_by_step, verbose=verbose, agent_mode=True).run()
    elif choice == '3':
        SkillSimulator("develop-skill", step_by_step=step_by_step, verbose=verbose).run()
    elif choice == '4':
        SkillSimulator("develop-learnings", step_by_step=step_by_step, verbose=verbose).run()
    elif choice == '5':
        AgentSimulator("clarification", step_by_step=step_by_step, verbose=verbose).run()
    elif choice == '6':
        AgentSimulator("research", step_by_step=step_by_step, verbose=verbose).run()
    elif choice == '7':
        AgentSimulator("generation", step_by_step=step_by_step, verbose=verbose).run()
    elif choice == '8':
        AgentSimulator("validation", step_by_step=step_by_step, verbose=verbose).run()
    elif choice == '0':
        run_full_e2e_flow(step_by_step=step_by_step, verbose=verbose)
    elif choice == 'q':
        print(color("  Goodbye!", Colors.DIM))
        return
    else:
        print(color("  Invalid choice", Colors.RED))


def run_full_e2e_flow(step_by_step: bool = False, verbose: bool = False) -> None:
    """Run a full end-to-end flow simulation."""
    print_header("FULL END-TO-END FLOW SIMULATION")
    
    print(color("  This simulates the complete flow:", Colors.DIM))
    print(color("  User Query → Reasoning → Skill → Agents → Complete", Colors.DIM))
    print()
    
    # Step 1: Reasoning Protocol
    print(color("  ┌─ PHASE 1: REASONING PROTOCOL", Colors.BOLD))
    print(color("  │", Colors.DIM))
    reasoning = ReasoningSimulator(step_by_step=step_by_step, verbose=verbose)
    reasoning.run()
    
    print()
    print(color("  │", Colors.DIM))
    print(color("  ├─ Routing Decision: skill-orchestration", Colors.YELLOW))
    print(color("  │", Colors.DIM))
    
    # Step 2: Skill Protocol
    print(color("  ├─ PHASE 2: SKILL PROTOCOL (develop-skill)", Colors.BOLD))
    print(color("  │", Colors.DIM))
    skill = SkillSimulator("develop-skill", step_by_step=step_by_step, verbose=verbose)
    
    # Show first few phases with agent invocations
    for i, (phase_id, phase_name, atomic_skill) in enumerate(skill.phases[:3]):
        print(color(f"  │  Phase {phase_id}: {phase_name}", Colors.CYAN))
        agent_name = atomic_skill.replace("orchestrate-", "")
        print(color(f"  │    └─ Agent: {agent_name}-agent", Colors.DIM))
        
        if verbose:
            # Show abbreviated agent steps
            agent = AgentSimulator(f"{agent_name}-agent", step_by_step=False, verbose=False)
            print(color(f"  │       Steps: {len(agent.steps)}", Colors.DIM))
        
        if step_by_step and i < 2:
            input(color("\n  │  Press Enter to continue...", Colors.DIM))
    
    print(color("  │  ...(remaining phases)...", Colors.DIM))
    print(color("  │", Colors.DIM))
    
    # Step 3: Completion
    print(color("  └─ PHASE 3: COMPLETION", Colors.BOLD))
    print()
    print(color("  ═══════════════════════════════════════════════════════════════════", Colors.GREEN))
    print(color("  ║                     SIMULATION COMPLETE                          ║", Colors.GREEN + Colors.BOLD))
    print(color("  ═══════════════════════════════════════════════════════════════════", Colors.GREEN))
    print()
    print(f"  {color('✓', Colors.GREEN)} Reasoning Protocol: COMPLETED")
    print(f"  {color('✓', Colors.GREEN)} Skill Protocol: COMPLETED")
    print(f"  {color('✓', Colors.GREEN)} All Agents: COMPLETED")
    print()


# ==============================================================================
# CLI Entry Point
# ==============================================================================

def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Interactive Orchestration Flow Simulator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                                    # Interactive menu
  %(prog)s --protocol reasoning               # Reasoning protocol only
  %(prog)s --protocol skill --skill develop-skill
  %(prog)s --protocol agent --agent clarification-agent
  %(prog)s --step-by-step                     # Pause at each transition
  %(prog)s -v --show-state                    # Verbose with state display
  %(prog)s --full-e2e                         # Full end-to-end simulation
"""
    )
    
    parser.add_argument(
        "--protocol",
        choices=["reasoning", "skill", "agent"],
        help="Protocol type to simulate"
    )
    parser.add_argument(
        "--skill",
        default="develop-skill",
        help="Skill name for skill protocol (default: develop-skill)"
    )
    parser.add_argument(
        "--agent",
        default="clarification",
        help="Agent name for agent protocol (default: clarification-agent)"
    )
    parser.add_argument(
        "--step-by-step", "-s",
        action="store_true",
        help="Pause at each transition"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Verbose output"
    )
    parser.add_argument(
        "--show-state",
        action="store_true",
        help="Show state after each step"
    )
    parser.add_argument(
        "--agent-mode",
        action="store_true",
        help="Run reasoning in agent mode (skips Step 4)"
    )
    parser.add_argument(
        "--full-e2e",
        action="store_true",
        help="Run full end-to-end simulation"
    )
    
    args = parser.parse_args()
    
    verbose = args.verbose or args.show_state
    
    try:
        if args.full_e2e:
            run_full_e2e_flow(step_by_step=args.step_by_step, verbose=verbose)
        elif args.protocol == "reasoning":
            ReasoningSimulator(
                step_by_step=args.step_by_step,
                verbose=verbose,
                agent_mode=args.agent_mode
            ).run()
        elif args.protocol == "skill":
            SkillSimulator(
                args.skill,
                step_by_step=args.step_by_step,
                verbose=verbose
            ).run()
        elif args.protocol == "agent":
            AgentSimulator(
                args.agent,
                step_by_step=args.step_by_step,
                verbose=verbose
            ).run()
        else:
            interactive_menu()
        
        return 0
        
    except KeyboardInterrupt:
        print(color("\n\n  Interrupted by user", Colors.YELLOW))
        return 130


if __name__ == "__main__":
    sys.exit(main())
