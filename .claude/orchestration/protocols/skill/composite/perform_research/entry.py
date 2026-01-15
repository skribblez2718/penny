#!/usr/bin/env python3
"""perform-research Entry Point"""
if __name__ == "__main__":
    import argparse
    import sys
    from pathlib import Path

    # Add skill/composite parent to path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

    from skill.composite.common_skill_entry import skill_entry

    def add_depth(p: argparse.ArgumentParser) -> None:
        """Add --depth argument for research depth configuration"""
        p.add_argument(
            "--depth",
            default="standard",
            choices=["quick", "standard", "comprehensive"],
            help="Research depth level: quick (3-7min), standard (15-30min), comprehensive (60-120min)"
        )

    skill_entry(
        Path(__file__).parent.name.replace("_", "-"),
        Path(__file__).parent,
        add_extra_args=add_depth
    )
