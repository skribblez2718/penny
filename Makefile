.PHONY: setup venv install-py install-js init sca-tools clean test test-integration check-public lint format evals evals-update-baseline rate auto-capture trust trajectory review tune tune-deep

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
	@echo "==================== public-boundary guard ===================="
	@.venv/bin/python scripts/system/checks/check_public_boundary.py
	@echo ""
	@echo "==================== eval compat guards ===================="
	@.venv/bin/python scripts/system/evals/run_evals.py --sections compat --quiet --no-history
	@echo ""
	@bash -c 'set -uo pipefail; source .venv/bin/activate; \
	  export PYTEST_TIMEOUT=$(PYTEST_TIMEOUT); rc=0; \
	  for d in .pi/skills/*/tests scripts/system/tests scripts/system/*/tests apps/orchestration/tests apps/observability/tests apps/observability/src/observability/tests .pi/extensions/memory/tests; do \
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
	  for d in .pi/skills/*/tests scripts/system/tests scripts/system/*/tests .pi/extensions/memory/tests; do \
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

# Human quick-rating of recent work → high-signal outcomes into the ledger.
# This is the source that actually feeds the self-improvement flywheel (the
# engine terminal-state writer almost never fires in practice). `make rate`
# rates interactively; `make rate ARGS=--json` reports the pending count.
rate:
	@.venv/bin/python scripts/system/outcome_ledger/rate_recent.py $(ARGS)

# Judge-backed auto-capture: run the calibrated judge (MiniMax, = vera) over
# recent unrated tasks and record outcomes automatically. Also runs in the
# ambient cron (capped, best-effort). `make auto-capture ARGS=--dry-run` to
# preview. Complements `make rate` (they share dedup, so no double-recording).
auto-capture:
	@.venv/bin/python scripts/system/outcome_ledger/auto_capture.py $(ARGS)

# Trust dashboard: per-domain earned trust from the outcome ledger and how the
# act-vs-ask gate would decide. `make trust ARGS=--check` probes sample actions.
# Thin ledger → everything asks (the safe start); trust is earned from outcomes.
trust:
	@.venv/bin/python scripts/system/autonomy/dashboard.py $(ARGS)

# Prompt-efficacy matrix runner: the EXPENSIVE half of the prompt_efficacy eval
# section. Replays golden_prompt_tasks.json frame-on vs frame-off per model
# family via headless pi and writes .penny/evals/prompt_efficacy/latest.json,
# which `make evals` then ratchets. Run manually / weekly — never from cron.
evals-prompt-efficacy:
	@.venv/bin/python scripts/system/evals/run_prompt_efficacy.py

# Judge-agreement runner: scores how well each open model reproduces Oracle's
# verdicts on the calibration corpus, and writes .penny/evals/judgment/latest.json
# which `make evals` ratchets (the judgment section). Run to pick/re-check the
# Oracle-calibrated verifier. See scripts/system/judgment/.
judge-agreement:
	@.venv/bin/python scripts/system/judgment/run_judge_agreement.py

# Behavioral-regression ratchet: replay the Oracle-authored fixtures through the
# current system, judge each against its pass bar, and write
# .penny/evals/trajectory/latest.json which `make evals` ratchets (the
# trajectory section). Run weekly / before adopting an amendment. Anti-drift.
trajectory:
	@.venv/bin/python scripts/system/trajectory/run_trajectory.py $(ARGS)

# Amendment review gate: list/show/approve/reject/apply proposed amendments.
# `make review` lists pending; `make review ARGS="show <id>"` / "approve <id>" /
# "reject <id>" / "apply <id>". apply git-commits the prompt edit and is gated by
# the trajectory ratchet. This is the human approval gate of the flywheel.
review:
	@.venv/bin/python scripts/system/self_improve/review_amendments.py $(ARGS)

# One-command improvement cycle ("tune Penny"). Runs the flywheel end-to-end in
# dependency order: rate recent work (human) → generate amendments from ALL
# outcomes → surface the pending amendments to review → run the eval ratchet →
# show the trust dashboard. Steps 1 & 3 are the human gates; 2/4/5 are automated.
# Apply stays a deliberate follow-up (`make review ARGS="apply <id>"`), never
# auto-run — so tune never commits on its own.
tune:
	@echo "── tune 1/5: rate recent work ─────────────────────────────────"
	@.venv/bin/python scripts/system/outcome_ledger/rate_recent.py $(ARGS)
	@echo "── tune 2/5: generate amendments from outcomes ────────────────"
	@.venv/bin/python scripts/system/self_improve/run_compression.py
	@echo "── tune 3/5: pending amendments to review ─────────────────────"
	@.venv/bin/python scripts/system/self_improve/review_amendments.py list
	@echo "   review with: make review ARGS=\"approve <id>\" then \"apply <id>\""
	@echo "── tune 4/5: eval ratchet ─────────────────────────────────────"
	@.venv/bin/python scripts/system/evals/run_evals.py
	@echo "── tune 5/5: trust dashboard ──────────────────────────────────"
	@.venv/bin/python scripts/system/autonomy/dashboard.py

# Deep tune: refresh only stale/invalidated eval producers non-interactively.
# Not in cron — run manually when tune_due signals fire. Uses default models;
# no --models/--driver-model/--judge-model flags. Sequential, best-effort.
tune-deep:
	@.venv/bin/python scripts/system/evals/tune_freshness.py

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
	rm -rf .venv node_modules .mempalace
	@echo "Cleaned. Run 'make setup' to rebuild."
