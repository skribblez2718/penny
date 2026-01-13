# Workflow Validation Guide - develop-project

This document defines validation metrics and health checks for the develop-project workflow.

## Token Budget Compliance

### Agent Output Limits (Per Agent)
- **Total output per agent**: ≤5,000 tokens
- **Johari Summary**: ≤1,200 tokens
  - open: 200-300 tokens
  - hidden: 200-300 tokens
  - blind: 150-200 tokens
  - unknown: 150-200 tokens
  - domain_insights: 150-200 tokens (optional)
- **Step Overview**: ≤750 tokens
- **Downstream Directives**: ≤300 tokens

### Phase Summary Limits
- **phaseHistory[N] per phase**: ≤500 tokens

### Validation Method
After workflow completion, check:
```bash
# Count tokens in each agent memory file
for file in .claude/memory/task-*-*-memory*.md; do
  echo "$file:"
  wc -w "$file" | awk '{print $1 * 1.3 " estimated tokens"}'
done

# Flag if any file >6,500 words (~5,000 tokens * 1.3 = 6,500 words)
```

## Python Project Requirements Compliance

### Phase 3 (Foundation) Requirements
After Phase 3 completes, verify:
- [ ] `pyproject.toml` exists with [project] section
- [ ] `.venv/` directory exists
- [ ] `.venv/bin/python` executable exists
- [ ] `src/project_name/` directory structure exists
- [ ] NO `requirements.txt` file exists
- [ ] `uv sync` succeeds without errors
- [ ] Test import works: `uv run python -c "import project_name; print('OK')"`

### Phase 4 (Implementation) Requirements
After Phase 4 completes, verify:
- [ ] All imports are absolute (no relative imports)
  ```bash
  # Should return no matches:
  grep -r "^from \\.\\|^from [a-z_]\\+ import" src/
  ```
- [ ] Dependencies install: `uv sync` succeeds
- [ ] Tests pass: `uv run pytest` succeeds
- [ ] Application starts: `uv run python -m project_name` succeeds
- [ ] No ModuleNotFoundError in any execution

### Phase 5 (Validation) Requirements
Validator must have executed actual commands (not theoretical checks):
- [ ] Validator ran `uv sync` (check logs for command execution)
- [ ] Validator ran `uv run pytest` (check logs for command execution)
- [ ] Validator ran `uv run python -m project_name` (check logs for command execution)
- [ ] All actual executions succeeded (no errors in output)

## Dependency Validation Compliance

### Phase 1 (Research) Requirements
Research agent output must document for each library:
- [ ] Exact version specified (not "latest")
- [ ] Compatible version ranges documented
- [ ] Installation command documented (e.g., `uv add fastapi==0.104.1`)
- [ ] Known conflicts flagged (if any)

### Phase 2 (Synthesis) Requirements
Synthesis agent output must document:
- [ ] Decision rationale for each library selection
- [ ] Compatibility matrix (which versions work together)
- [ ] Installation tested or flagged as unknown
- [ ] Conflicts resolved or documented in blind/unknown quadrants

## Workflow Phase Gates

### Phase 0 → Phase 1 Gate
- [ ] Requirements explicit with acceptance criteria
- [ ] Scope boundaries defined
- [ ] Constraints documented

### Phase 1 → Phase 2 Gate
- [ ] Minimum 3 options per decision point
- [ ] Decisions coherent with rationale
- [ ] Trade-offs explicitly stated

### Phase 2 → Phase 3 Gate
- [ ] Complete design/architecture
- [ ] Patterns applied
- [ ] No critical issues
- [ ] Quality validated (by analysis agent)

### Phase 3 → Phase 4 Gate (CRITICAL FOR PYTHON)
- [ ] Plan complete
- [ ] Foundation operational (for Python: uv environment working)
- [ ] Environment validated (test import succeeds)

### Phase 4 → Phase 5 Gate (CRITICAL FOR PYTHON)
- [ ] System works end-to-end
- [ ] Dependencies install (uv sync succeeds)
- [ ] Imports resolve (no ModuleNotFoundError)
- [ ] Tests pass (uv run pytest succeeds)
- [ ] Application starts (uv run python -m project_name succeeds)

### Phase 5 → Completion Gate
- [ ] All quality gates met
- [ ] Documentation complete
- [ ] Deployment ready

## Expected Token Usage Per Phase

Baseline metrics (6-agent, 6-phase workflow):

| Phase | Agent Invocations | Expected Total Tokens |
|-------|-------------------|----------------------|
| Phase 0 | CLARIFICATION + ANALYSIS | 8,000-10,000 tokens |
| Phase 1 | RESEARCH + SYNTHESIS | 10,000-14,000 tokens |
| Phase 2 | RESEARCH + SYNTHESIS + ANALYSIS | 12,000-16,000 tokens |
| Phase 3 | CLARIFICATION + GENERATION | 8,000-11,000 tokens |
| Phase 4 | GENERATION (iterative) | 5,000-10,000 tokens |
| Phase 5 | VALIDATION + GENERATION | 8,000-11,000 tokens |

**Total Workflow:** 50,000-70,000 tokens target

Exceeding 100,000 tokens indicates agent output bloat (agents exceeding 5,000 token limit).

## Health Check Commands

### Validate Token Budgets
```bash
# Check agent memory file sizes
for file in .claude/memory/task-*-agent-memory*.md; do
  words=$(wc -w < "$file")
  tokens=$((words * 13 / 10))  # Approximate: 1 word ≈ 1.3 tokens
  if [ $tokens -gt 5000 ]; then
    echo "❌ OVER LIMIT: $file ($tokens tokens estimated)"
  else
    echo "✅ OK: $file ($tokens tokens estimated)"
  fi
done
```

### Validate Python Project Structure
```bash
# From project root
cd /path/to/generated/project

# Check files exist
test -f pyproject.toml && echo "✅ pyproject.toml exists" || echo "❌ pyproject.toml MISSING"
test -d .venv && echo "✅ .venv exists" || echo "❌ .venv MISSING"
test ! -f requirements.txt && echo "✅ No requirements.txt (good)" || echo "❌ requirements.txt EXISTS (forbidden)"

# Check imports are absolute
if grep -r "^from \\.\\|^from [a-z_]\\+ import" src/ 2>/dev/null | grep -v "__pycache__"; then
  echo "❌ RELATIVE IMPORTS FOUND"
else
  echo "✅ All imports are absolute"
fi

# Check environment works
uv sync && echo "✅ uv sync succeeded" || echo "❌ uv sync FAILED"
uv run pytest && echo "✅ Tests pass" || echo "❌ Tests FAILED"
```

### Validate Dependency Decisions
```bash
# Check research agent documented versions
grep -E "version|compatible|install" .claude/memory/task-*-research-memory*.md | head -20

# Check synthesis agent documented compatibility
grep -E "compatibility|conflict|version" .claude/memory/task-*-synthesis-memory*.md | head -20
```

## Failure Patterns to Watch For

### Token Budget Violations
- **Symptom**: Agent memory files >1,500 lines or >20KB
- **Root Cause**: Agent not following 5,000 token limit
- **Fix**: Check agent descriptions have token budget at top (lines 9-22)

### Relative Import Errors
- **Symptom**: ModuleNotFoundError when running application
- **Root Cause**: Generation agent used relative imports
- **Fix**: Verify Python context injection in SKILL.md Phase 4 (lines 416-452)

### Dependency Conflicts
- **Symptom**: uv sync fails with version conflicts
- **Root Cause**: Research/Synthesis didn't validate compatibility
- **Fix**: Verify dependency validation context in SKILL.md Phase 1 (lines 162-194)

### Environment Setup Failures
- **Symptom**: Phase 4 generation can't import modules
- **Root Cause**: Phase 3 didn't setup uv environment
- **Fix**: Verify Phase 3 foundation context in SKILL.md (lines 415-457)

### Validation Theater
- **Symptom**: Validator passes but application doesn't work
- **Root Cause**: Validator checked theoretically, didn't run actual commands
- **Fix**: Verify Phase 5 validation context in SKILL.md (lines 514-673)

## Success Criteria

A healthy workflow execution shows:
- ✅ All agents ≤5,000 tokens output
- ✅ All phase gates passed with required criteria
- ✅ Python projects: Environment setup in Phase 3, working end-to-end by Phase 4
- ✅ Actual validation execution in Phase 5 (not theoretical)
- ✅ Dependencies documented with versions and compatibility
- ✅ Total workflow ≤100,000 tokens

If any criterion fails, review the specific phase context injection in SKILL.md.
