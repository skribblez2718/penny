.PHONY: setup venv install-py install-js init clean test test-integration check-public lint format evals evals-update-baseline trajectory

# ── Setup ───────────────────────────────────────────────────────────────────

setup: venv install-py install-js init
	@echo ""
	@echo "Setup complete. Ensure .env exists and holds your values (cp .env.example .env if needed)."
	@echo "Then start Pi in the project directory."

venv:
	uv venv .venv

install-py:
	# --extra dev installs the dev/test toolchain (pytest, flake8, black, mypy, ...)
	# declared under [project.optional-dependencies] dev. Plain `uv sync` does NOT
	# install extras, which previously left `make test`/`make lint` unable to run.
	uv sync --extra dev

install-js:
	bun install

init:
	bash scripts/setup/setup.sh

# ── Development ─────────────────────────────────────────────────────────────

# Per-test timeout (pytest-timeout) so a hung or external test can't stall the
# whole suite. Override: make test PYTEST_TIMEOUT=120
PYTEST_TIMEOUT ?= 60
# Fast-lane marker deselection. Heavy/external tests are opt-in (see test-integration).
# Override to run everything: make test PYTEST_MARKERS=""
PYTEST_MARKERS ?= not e2e and not slow and not network and not integration

# Python tests run PER SKILL in isolated processes. This is required: every skill
# ships its own top-level modules (orchestrate.py, fsm.py, scripts/ package), so a
# single pytest process would collide on sys.modules. Per-skill isolation is the
# robust, permanent fix; each skill's tests/conftest.py puts its scripts/ on path.
test:
	bun run test:unit
	@echo ""
	@echo "==================== orchestration CI guards ===================="
	@.venv/bin/python scripts/system/checks/check_orchestration_guards.py
	@echo ""
	@echo "==================== public-boundary guard ===================="
	@.venv/bin/python scripts/system/checks/check_public_boundary.py
	@echo ""
	@echo "==================== eval compat guards ===================="
	@.venv/bin/python scripts/system/evals/run_evals.py --sections compat --quiet --no-history
	@echo ""
	@bash -c 'set -uo pipefail; source .venv/bin/activate; \
	  export PYTEST_TIMEOUT=$(PYTEST_TIMEOUT); rc=0; \
	  for d in .pi/skills/*/tests scripts/system/tests scripts/system/*/tests apps/orchestration/tests apps/observability/tests apps/observability/src/observability/tests .pi/extensions/powerpoint/tests/python .pi/extensions/word/tests/python; do \
	    [ -d "$$d" ] || continue; \
	    echo "==================== pytest $$d ===================="; \
	    python -m pytest "$$d" -p no:cacheprovider -m "$(PYTEST_MARKERS)" --tb=short -q || rc=1; \
	  done; \
	  exit $$rc'

# Full suite including heavy/external tests (network, integration, slow, e2e).
# These auto-skip when their external dependency (for example network or Ollama)
# is absent, so this stays green on machines without those services.
test-integration:
	bun run test:integration
	@bash -c 'set -uo pipefail; source .venv/bin/activate; \
	  export PYTEST_TIMEOUT=$(PYTEST_TIMEOUT); rc=0; \
	  for d in .pi/skills/*/tests scripts/system/tests scripts/system/*/tests .pi/extensions/powerpoint/tests/python .pi/extensions/word/tests/python; do \
	    [ -d "$$d" ] || continue; \
	    echo "==================== pytest $$d ===================="; \
	    python -m pytest "$$d" -p no:cacheprovider --tb=short -q || rc=1; \
	  done; \
	  exit $$rc'

# Eval & regression suite: measures what "better" means for Penny against the
# LIVE stores (mempalace, checkpointer, observability) and gates on the ratchet
# in scripts/system/evals/baseline.json. See scripts/system/evals/README.md.
evals:
	@.venv/bin/python scripts/system/evals/run_evals.py

evals-update-baseline:
	@.venv/bin/python scripts/system/evals/run_evals.py --update-baseline

# Behavioral-regression ratchet: replay the Oracle-authored fixtures through the
# current system, judge each against its pass bar, and write
# .penny/evals/trajectory/latest.json which `make evals` ratchets (the
# trajectory section). Run weekly. Anti-drift.
trajectory:
	@.venv/bin/python scripts/system/trajectory/run_trajectory.py $(ARGS)

# Public-boundary guard: fail if a tracked file reintroduces an operator-filesystem path
# (enforces the AGENTS.md "Public repository boundary" invariant; also runs inside `make test`).
check-public:
	@.venv/bin/python scripts/system/checks/check_public_boundary.py

lint:
	bun run lint
	bun run format:check
	source .venv/bin/activate && flake8 . --config .flake8
	source .venv/bin/activate && black . --check --config pyproject.toml

format:
	bun run format
	source .venv/bin/activate && black . --config pyproject.toml

# ── Cleanup ─────────────────────────────────────────────────────────────────

clean:
	rm -rf .venv node_modules
	@echo "Cleaned code dependencies; memory data was preserved. Run 'make setup' to rebuild."
