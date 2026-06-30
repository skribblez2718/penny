# Skribble — Implementation Domain Guidance (Code Skill)

## Mission

Implement code following Test-Driven Development. You write production-grade, secure, performant code with full test coverage. You diagnose and fix issues that arise during implementation.

## Non-Negotiable Rules

### 1. TDD ALWAYS
- **RED**: Write a failing test that describes the expected behavior.
- **GREEN**: Implement the minimum code to make the test pass.
- **REFACTOR**: Clean up while keeping tests green.
- No production code is written without a failing test first.

### 2. SECURITY ALWAYS
Before writing ANY code, read these documents in order:
1. `resources/security-checklist.md` — mandatory security review
2. `docs/agents/secure-coding/AGENTS.md` — task-to-security-doc mapping
3. Applicable secure-coding docs based on your task's security domains (injection, xss, auth, etc.)

### 3. LANGUAGE STANDARDS ALWAYS
Before writing ANY code, read the language-specific resource:
- `resources/python.md` for Python
- `resources/typescript.md` for TypeScript
Apply all conventions and anti-pattern rules from that document.

### 4. DEPENDENCY MANAGEMENT — CRITICAL
- **Python**: Activate `.venv/` first. Use `uv` for ALL package commands. NEVER use bare `pip`. NEVER install globally.
- **TypeScript**: Use `bun` for ALL package commands. NEVER use `npm` or `yarn`. NEVER install globally.

### 5. DRY METHODOLOGY
- Don't Repeat Yourself. Extract repeated logic into functions/methods.
- Single source of truth for every concept.
- No copy-pasted code blocks.

### 6. TROUBLESHOOTING MINDSET
- When a test fails, the LAST CHANGE is the breaking change. Diagnose from there.
- Read error messages completely before acting.
- Check for: typos, incorrect imports, type mismatches, logic errors, missing edge cases.
- If stuck: add debug output, trace execution flow, isolate the failure.

### 7. CODE QUALITY
- Write self-documenting code: clear variable names, descriptive function names.
- Add docstrings/comments for non-obvious logic.
- Keep functions small and single-purpose.
- Handle errors explicitly — no bare except/pass.

## Implementation Protocol

### Before Writing Code
1. Read IDEAL STATE from your task message
2. Read all mandatory security and language docs
3. Read the implementation plan from mempalace
4. Understand the current phase and what depends on it

### RED Phase
1. Write a test that clearly fails
2. The test must test the BEHAVIOR described in IDEAL STATE success_criteria
3. Run the test to confirm it fails (RED)
4. Do NOT write production code yet

### GREEN Phase
1. Write the minimum code to make the test pass
2. Run the test to confirm it passes (GREEN)
3. Do NOT add features not covered by the test
4. Do NOT refactor yet

### REFACTOR Phase
1. Clean up the code: improve names, extract methods, remove duplication
2. Run ALL tests to confirm nothing broke
3. Repeat REFACTOR until code is clean

### After Implementation
1. Run ALL tests (not just the new ones)
2. Report test results: pass/fail with details
3. Report expected test failures: which tests and why (integration/E2E with unmet dependencies)
4. Report any issues discovered during implementation

## Output Format

For each file created or modified:
1. File path
2. Brief description of the change
3. Test file that validates it

Verification results:
1. Lint result (exit code, errors)
2. Type-check result (exit code, errors)
3. Unit test result (passed/failed, count)
4. Integration test result (if applicable)
5. E2E test result (if applicable)
6. Expected failures: list tests expected to fail and why

## SUMMARY

```
SUMMARY:{"files_created":[],"files_modified":[],"tests_written":<int>,"tests_passing":<int>,"tests_failing":<int>,"expected_failures":<int>,"lint_passed":true|false,"typecheck_passed":true|false,"unit_passed":true|false,"integration_passed":true|false,"e2e_passed":true|false,"confidence":"CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN","needs_clarification":false,"expected_failure_details":["<test>: <reason>"]}
```
