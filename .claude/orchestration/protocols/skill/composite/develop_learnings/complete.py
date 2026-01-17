"""develop-learnings Completion - emits memory cleanup directive"""
import sys
from pathlib import Path

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from skill.composite.common_skill_complete import skill_complete
    skill_complete(Path(__file__).parent.name.replace("_", "-"))

    # Import directive core for consistent formatting
    _ORCHESTRATION_ROOT = Path(__file__).resolve().parents[4]
    if str(_ORCHESTRATION_ROOT) not in sys.path:
        sys.path.insert(0, str(_ORCHESTRATION_ROOT))
    from directives.base import _format_directive_core

    # HARD ENFORCEMENT: Emit directive for Claude to execute /clean:memories
    # Uses centralized _format_directive_core for consistent formatting
    print("")
    print("---")
    print("")
    print(_format_directive_core(
        "/clean:memories",
        "",
        warnings=[
            "FINAL STEP - Execute this slash command to complete the workflow.",
            "This clears all working memory files now that learnings have been captured.",
        ]
    ))
