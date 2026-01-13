"""Synthesis Agent Entry Point"""
if __name__ == "__main__":
    import sys; from pathlib import Path; sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from common.entry import agent_entry; agent_entry(Path(__file__).resolve().parent.name)
