#!/usr/bin/env python3
"""develop-architecture Completion"""
if __name__ == "__main__":
    import sys
    from pathlib import Path

    # Add skill/composite parent to path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

    from skill.composite.common_skill_complete import skill_complete

    skill_complete(Path(__file__).parent.name.replace("_", "-"))
