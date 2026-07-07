.PHONY: setup venv install-py install-js init sca-tools clean test test-integration lint format evals evals-update-baseline docker-build docker-up docker-down

# ── Setup ───────────────────────────────────────────────────────────────────

setup: venv install-py install-js init
	@echo ""
	@echo "Setup complete. Copy .env.example to .env and fill in your values."
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

# Provision the external tools the `sca` skill needs (osv-scanner, gitleaks,
# trivy, trufflehog, njsscan[isolated venv], retire.js, eslint-security, codeql).
# Already invoked as part of `make setup` (via init -> setup.sh init-*.sh glob);
# this target lets you re-run just the sca tool provisioning.
sca-tools:
	bash scripts/setup/init-sca-tools.sh

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
	@echo "==================== eval compat guards ===================="
	@.venv/bin/python scripts/system/evals/run_evals.py --sections compat --quiet --no-history
	@echo ""
	@bash -c 'set -uo pipefail; source .venv/bin/activate; \
	  export PYTEST_TIMEOUT=$(PYTEST_TIMEOUT); rc=0; \
	  for d in .pi/skills/*/tests scripts/system/tests scripts/system/*/tests apps/orchestration/tests apps/observability/tests apps/observability/src/observability/tests; do \
	    [ -d "$$d" ] || continue; \
	    echo "==================== pytest $$d ===================="; \
	    python -m pytest "$$d" -p no:cacheprovider -m "$(PYTEST_MARKERS)" --tb=short -q || rc=1; \
	  done; \
	  exit $$rc'

# Full suite including heavy/external tests (network, integration, slow, e2e).
# These auto-skip when their external dependency (network, Ollama, Joern, ...) is
# absent, so this stays green on machines without those services.
test-integration:
	@bash -c 'set -uo pipefail; source .venv/bin/activate; \
	  export PYTEST_TIMEOUT=$(PYTEST_TIMEOUT); rc=0; \
	  for d in .pi/skills/*/tests scripts/system/tests scripts/system/*/tests; do \
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

# Prompt-efficacy matrix runner: the EXPENSIVE half of the prompt_efficacy eval
# section. Replays golden_prompt_tasks.json frame-on vs frame-off per model
# family via headless pi and writes .penny/evals/prompt_efficacy/latest.json,
# which `make evals` then ratchets. Run manually / weekly — never from cron.
evals-prompt-efficacy:
	@.venv/bin/python scripts/system/evals/run_prompt_efficacy.py

# Judge-agreement runner: scores how well each open model reproduces Fable's
# verdicts on the calibration corpus, and writes .penny/evals/judgment/latest.json
# which `make evals` ratchets (the judgment section). Run to pick/re-check the
# Fable-calibrated verifier. See scripts/system/judgment/.
judge-agreement:
	@.venv/bin/python scripts/system/judgment/run_judge_agreement.py

lint:
	bun run lint
	bun run format:check
	source .venv/bin/activate && flake8 . --config .flake8
	source .venv/bin/activate && black . --check --config pyproject.toml

format:
	bun run format
	source .venv/bin/activate && black . --config pyproject.toml

# ── Docker ─────────────────────────────────────────────────────────────────

docker-build:
	docker build -t penny-observability -f apps/observability/Dockerfile .

docker-up:
	docker run -d --name penny-observability \
		-p 8765:8765 \
		-v $(HOME)/.local/share/penny/observability:/data \
		-v $(PWD)/.env:/app/.env:ro \
		-e PI_OBSERVABILITY_DATA_DIR=/data \
		penny-observability

docker-down:
	docker stop penny-observability 2>/dev/null || true
	docker rm penny-observability 2>/dev/null || true

# ── Cleanup ─────────────────────────────────────────────────────────────────

clean:
	rm -rf .venv node_modules .mempalace
	@echo "Cleaned. Run 'make setup' to rebuild."
