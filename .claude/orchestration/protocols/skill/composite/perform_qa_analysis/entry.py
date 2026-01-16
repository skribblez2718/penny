#!/usr/bin/env python3
"""Perform QA Analysis Skill Entry Point"""
if __name__ == "__main__":
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from common_skill_entry import skill_entry
    skill_entry(Path(__file__).resolve().parent.name)
