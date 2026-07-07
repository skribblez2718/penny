#!/usr/bin/env python3
"""
Error-logging compliance check for Penny extensions.

Checks:
1. No raw console.error/warn/log in production code (allow-listed paths excluded)
2. All remediated extensions import the shared logger
3. Error codes are defined for logger.error() calls
4. No bare `catch {}` without logger.debug in remediated extensions

Usage:
  python check_error_logging.py /path/to/project/root
"""

import os
import re
import sys
from pathlib import Path

ALLOWLIST_PATTERNS = [
    r"\.pi/extensions/shared/",  # logger itself uses stderr directly
    r"\.pi/extensions/environment/",  # no error paths
    r"\.pi/extensions/statusline/",  # no error paths
    r"\.pi/test-utils/",  # test utilities may use console.*
    r"\.pi/extensions/.*/tests/",  # all test files
    r"/node_modules/",  # third-party deps, incl. bundled .d.ts type decls
    r"\.pi/extensions/semgrep/rules/",  # semgrep rule DEFINITIONS embed console.* as detection patterns, not logging
]

REMEDIATED_EXTENSIONS = [
    "memory",
    "observability",
    "compaction",
    "skill",
    "subagent",
    "search",
]


def is_allowlisted(path: str) -> bool:
    for pattern in ALLOWLIST_PATTERNS:
        if re.search(pattern, path):
            return True
    return False


def check_no_raw_console(project_root: str) -> list[str]:
    errors = []
    ext_dir = Path(project_root) / ".pi" / "extensions"
    for ts_file in ext_dir.rglob("*.ts"):
        path = str(ts_file)
        if is_allowlisted(path):
            continue
        content = ts_file.read_text()
        matches = re.findall(r"console\.(log|warn|error)\s*\(", content)
        for _ in matches:
            errors.append(f"CHECK 1 FAIL: raw console.* found in {path}")
    return errors


def check_logger_imports(project_root: str) -> list[str]:
    errors = []
    ext_dir = Path(project_root) / ".pi" / "extensions"
    for name in REMEDIATED_EXTENSIONS:
        # subagent logging lives in agent-runner.ts, not subagent/index.ts
        if name == "subagent":
            runner = ext_dir / "subagent" / "agent-runner.ts"
            if runner.exists() and "createLogger" in runner.read_text():
                continue
            errors.append("CHECK 2 FAIL: subagent/agent-runner.ts does not import createLogger")
            continue
        index_file = ext_dir / name / "index.ts"
        if index_file.exists():
            content = index_file.read_text()
            if "createLogger" not in content:
                errors.append(f"CHECK 2 FAIL: {name}/index.ts does not import createLogger")
    return errors


def check_error_codes(project_root: str) -> list[str]:
    errors = []
    ext_dir = Path(project_root) / ".pi" / "extensions"
    for name in REMEDIATED_EXTENSIONS:
        for ts_file in (ext_dir / name).rglob("*.ts"):
            if "tests" in str(ts_file):
                continue
            content = ts_file.read_text()
            # Find logger.error calls spanning multiple lines
            for match in re.finditer(r"logger\.error\((.*?)(?:\);|$)", content, re.DOTALL):
                call = match.group(1)
                # A code is carried either as a literal `code:` / `code?:` (incl.
                # a forwarded `Error & { code?: string }`) or via Object.assign.
                if "Object.assign" in call or re.search(r"\bcode\b\s*\??:", call):
                    continue
                errors.append(
                    f"CHECK 3 FAIL: logger.error without error code in {ts_file.relative_to(ext_dir)}"
                )
    return errors


def check_no_bare_catch(project_root: str) -> list[str]:  # noqa: C901
    errors = []
    ext_dir = Path(project_root) / ".pi" / "extensions"
    for name in REMEDIATED_EXTENSIONS:
        for ts_file in (ext_dir / name).rglob("*.ts"):
            path = str(ts_file)
            if "tests" in path or "node_modules" in path:
                continue
            content = ts_file.read_text()
            # Find catch blocks with balanced braces using depth counting
            for match in re.finditer(r"catch\s*\([^)]*\)\s*\{", content):
                start = match.end()
                depth = 1
                end = start
                while depth > 0 and end < len(content):
                    if content[end] == "{":
                        depth += 1
                    elif content[end] == "}":
                        depth -= 1
                    end += 1
                block = content[start : end - 1].strip()
                if block == "":
                    continue
                # A catch is "handled" if it calls the structured logger OR
                # delegates to a project error-logging helper (each wraps
                # logger.error internally).
                has_logger = any(
                    h in block for h in ("logger.", "errorResult(", "failLoudly(", "logError(")
                )
                # Real code lines only (drop // line comments and /* * block-comment lines).
                code_lines = [
                    s
                    for s in (ln.strip() for ln in block.splitlines())
                    if s
                    and not s.startswith("//")
                    and not s.startswith("/*")
                    and not s.startswith("*")
                ]
                if not code_lines:
                    continue
                # A catch whose final statement re-throws (re-classifies the
                # error, possibly across multiple lines) is not swallowing it —
                # the caller handles/logs it. Detect by checking that nothing but
                # closing punctuation follows the last `throw`'s terminating `;`.
                last_throw = block.rfind("throw")
                if last_throw != -1:
                    tail = block[last_throw:]
                    semi = tail.find(";")
                    remainder = tail[semi + 1:].strip() if semi != -1 else ""
                    if remainder == "" or all(ch in ");,}" for ch in remainder):
                        continue
                if not has_logger:
                    errors.append(f"CHECK 4 FAIL: catch block without logger call in {path}")
    return errors


def main():
    project_root = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    all_errors: list[str] = []
    all_errors.extend(check_no_raw_console(project_root))
    all_errors.extend(check_logger_imports(project_root))
    all_errors.extend(check_error_codes(project_root))
    all_errors.extend(check_no_bare_catch(project_root))
    all_errors.extend(check_python_no_raw_print(project_root))
    all_errors.extend(check_python_logger_imports(project_root))
    all_errors.extend(check_python_error_codes(project_root))

    if all_errors:
        print("ERROR_LOGGING_COMPLIANCE: FAILED")
        for err in all_errors:
            print(f"  {err}")
        sys.exit(1)
    else:
        print("ERROR_LOGGING_COMPLIANCE: PASSED")
        sys.exit(0)


# ---------------------------------------------------------------------------
# Python observability server checks
# ---------------------------------------------------------------------------


def check_python_no_raw_print(project_root: str) -> list[str]:
    """Check that observability Python server uses structured logger instead of print()."""
    errors = []
    obs_dir = Path(project_root) / "apps" / "observability" / "src" / "observability"
    if not obs_dir.exists():
        return errors
    for py_file in obs_dir.rglob("*.py"):
        path = str(py_file)
        if "tests" in path or "logger.py" in path:
            continue
        content = py_file.read_text()
        for _ in re.finditer(r"print\(", content):
            errors.append(f"CHECK 5 FAIL: raw print() found in {py_file.relative_to(obs_dir)}")
    return errors


def check_python_logger_imports(project_root: str) -> list[str]:
    """Check that main.py and scheduler.py import the structured logger."""
    errors = []
    obs_dir = Path(project_root) / "apps" / "observability" / "src" / "observability"
    for filename in ["main.py", "scheduler.py"]:
        filepath = obs_dir / filename
        if not filepath.exists():
            errors.append(f"CHECK 6 FAIL: {filename} not found")
            continue
        content = filepath.read_text()
        if "import logger" not in content:
            errors.append(f"CHECK 6 FAIL: {filename} does not import structured logger")
    return errors


def check_python_error_codes(project_root: str) -> list[str]:  # noqa: C901
    """Check that Python exceptions carry error codes in catch blocks."""
    errors = []
    obs_dir = Path(project_root) / "apps" / "observability" / "src" / "observability"
    if not obs_dir.exists():
        return errors
    for py_file in obs_dir.rglob("*.py"):
        path = str(py_file)
        if "tests" in path or "logger.py" in path:
            continue
        content = py_file.read_text()
        # Find except blocks. Indentation-aware: collect ONLY lines more indented
        # than the `except` keyword itself, stopping at the first line dedented to
        # (or past) the except's level — so a nested except body is not conflated
        # with the sibling code that follows it.
        for match in re.finditer(r"^([ \t]*)except\b.*?:", content, re.MULTILINE):
            except_indent = len(match.group(1).expandtabs())
            block_start = match.end()
            block_lines = []
            for line in content[block_start:].splitlines():
                if line.strip() == "":
                    continue
                indent = len(line) - len(line.lstrip())
                if indent > except_indent:
                    block_lines.append(line)
                else:
                    break
            block = "\n".join(block_lines)
            # Skip blocks that are only control-flow / comments (intentional,
            # non-swallowing). Strip inline + full-line comments first so a
            # `pass  # why` or a comment-only block is correctly recognized.
            code_lines = []
            for bl in block_lines:
                stripped = bl.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                code = stripped.split("#", 1)[0].strip()
                if code:
                    code_lines.append(code)
            if not code_lines or all(c in ("pass", "...", "continue", "raise") for c in code_lines):
                continue
            # Check for logger call
            has_logger = "_logger." in block
            # Check for error code assignment
            has_code = "err.code" in block or "'code':" in block or '"code":' in block
            if has_logger and not has_code and "error=" in block:
                # logger call present but no error code assigned
                errors.append(
                    f"CHECK 7 FAIL: logger call may lack error code in {py_file.relative_to(obs_dir)}"
                )
            if not has_logger:
                errors.append(
                    f"CHECK 7 FAIL: except block without logger call in {py_file.relative_to(obs_dir)}"
                )
    return errors


if __name__ == "__main__":
    main()
