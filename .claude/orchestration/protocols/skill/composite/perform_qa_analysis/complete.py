#!/usr/bin/env python3
"""Perform QA Analysis Skill Completion"""
if __name__ == "__main__":
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from common_skill_complete import skill_complete
    skill_complete(Path(__file__).resolve().parent.name)
