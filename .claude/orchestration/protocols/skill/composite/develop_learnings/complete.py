"""develop-learnings Completion - emits memory cleanup directive"""
import sys
from pathlib import Path

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from skill.composite.common_skill_complete import skill_complete
    skill_complete(Path(__file__).parent.name.replace("_", "-"))

    # HARD ENFORCEMENT: Emit directive for Claude to execute /clean:memories
    # This replaces unreliable Python subprocess cleanup
    print("")
    print("---")
    print("")
    print("**MANDATORY FINAL STEP - EXECUTE NOW:**")
    print("")
    print("Invoke the memory cleanup command:")
    print("")
    print("```")
    print("/clean:memories")
    print("```")
    print("")
    print("This clears all working memory files now that learnings have been captured.")
