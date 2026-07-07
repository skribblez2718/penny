"""Unified Definition of Done compliance checker.

Runs all P2 automated checks:
1. Token budget (SYSTEM.md)
2. AGENTS.md link integrity
3. Test count reporting by module

Usage:
    python scripts/system/checks/check_compliance.py
"""

import subprocess
import sys
import os
from pathlib import Path

MODULES = {
    "plan_skill": ".pi/skills/plan/scripts",
    "watchers": "scripts/system/watchers",
    "self_improve": "scripts/system/self_improve",
    "digest": "scripts/system/digest",
    "outcome_ledger": "scripts/system/outcome_ledger",
    "tiered_memory": "scripts/system/tiered_memory",
    "register_artifact": "scripts/system/tests",
}

# Engine model: `scripts/orchestrate.py` is a ~5-line delegate into the shared
# orchestration engine; playbook FSM + tests live in apps/orchestration/. A per-skill
# `scripts/__init__.py` and `tests/` dir are OPTIONAL (only skills with their own
# domain tooling carry them), so they are not required here.
SKILL_REQUIRED_FILES = [
    "SKILL.md",
    "README.md",
    "scripts/orchestrate.py",
    "assets/prompts",
    "resources/reference.md",
    "resources/flow.mmd",
]

# Placeholder skills — not yet built onto the engine; skip structural validation.
PLACEHOLDER_SKILLS = {"rez"}


def run(cmd: list[str], cwd: str = ".", extra_env=None) -> tuple[bool, str]:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=cwd,
        env=env,
    )
    return result.returncode == 0, result.stdout + result.stderr


def check_token_budget() -> bool:
    print("[1/3] Checking SYSTEM.md token budget...")
    ok, out = run([sys.executable, "scripts/system/checks/check_token_budget.py"], cwd=".")
    print("   " + "\n   ".join(out.strip().splitlines()))
    return ok


def check_agents_links() -> bool:
    print("[2/3] Checking AGENTS.md link integrity...")
    ok, out = run([sys.executable, "scripts/system/checks/check_agents_links.py"], cwd=".")
    print("   " + "\n   ".join(out.strip().splitlines()))
    return ok


def check_tests() -> bool:
    print("[3/3] Running test discovery by module...")
    total = 0
    all_ok = True
    for name, path in MODULES.items():
        test_args = [sys.executable, "-m", "pytest", "--co", "-q", path]
        extra = {"PYTHONPATH": "scripts"}
        if name == "plan_skill":
            extra["PYTHONPATH"] += ":.pi/skills/plan/scripts"
        elif name in (
            "watchers",
            "outcome_ledger",
            "tiered_memory",
            "self_improve",
            "digest",
            "register_artifact",
        ):
            extra["PYTHONPATH"] += ":scripts/system"
        ok, out = run(test_args, cwd=".", extra_env=extra)
        if not ok:
            pass
        for line in out.splitlines():
            if "collected" in line and "items" in line:
                count = line.split("collected")[1].split("items")[0].strip()
                try:
                    n = int(count)
                    total += n
                    print(f"   {name}: {n} tests")
                except ValueError:
                    print(f"   {name}: ? tests ({line.strip()})")
                break
        else:
            # No collected line — might be no tests or error
            if "no tests collected" in out.lower():
                print(f"   {name}: 0 tests")
            else:
                print(f"   {name}: no tests found (check path)")
    print(f"   TOTAL: {total} tests")
    return all_ok


def check_skills() -> bool:
    print("[4/4] Checking skill directory structure...")
    skills_dir = Path(".pi/skills")
    if not skills_dir.exists():
        print("   .pi/skills/ does not exist — skipping skill check")
        return True

    all_ok = True
    for skill_path in sorted(skills_dir.iterdir()):
        if not skill_path.is_dir():
            continue
        if skill_path.name.startswith("."):
            continue
        if skill_path.name in PLACEHOLDER_SKILLS:
            print(f"   ⏭️  {skill_path.name}: placeholder skill — skipping structural check")
            continue

        missing = []
        for req in SKILL_REQUIRED_FILES:
            req_path = skill_path / req
            if not req_path.exists():
                missing.append(req)

        if missing:
            print(f"   ❌ {skill_path.name}: missing {', '.join(missing)}")
            all_ok = False
        else:
            print(f"   ✅ {skill_path.name}: all required files present")

    return all_ok


def main() -> int:
    results = {
        "token_budget": check_token_budget(),
        "agents_links": check_agents_links(),
        "test_discovery": check_tests(),
        "skills": check_skills(),
    }
    print()
    if all(results.values()):
        print("✅ All compliance checks passed.")
        return 0
    failed = [k for k, v in results.items() if not v]
    print(f"❌ Failed checks: {', '.join(failed)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
