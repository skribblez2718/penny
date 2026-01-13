"""develop-skill Entry Point"""
if __name__ == "__main__":
    import sys; from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from skill.composite.common_skill_entry import skill_entry
    skill_entry(Path(__file__).parent.name.replace("_", "-"), Path(__file__).parent)
