.PHONY: setup venv install-py install-js init clean test test-integration check-public check-agents-links check-kb-privacy check-tool-profiles check-tool-descriptions check-skill-structure check-capability-registry check-agent-roster lint typecheck verify-publication format evals

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
	@echo "==================== AGENTS.md index guard ===================="
	@.venv/bin/python scripts/system/checks/check_agents_links.py
	@echo ""
	@echo "==================== knowledge-base privacy guard ===================="
	@.venv/bin/python scripts/system/checks/check_kb_privacy.py
	@echo ""
	@echo "==================== provider-visible tool guidance guard ===================="
	@.venv/bin/python scripts/system/checks/check_tool_descriptions.py
	@echo ""
	@echo "==================== skill structure guard ===================="
	@.venv/bin/python scripts/system/checks/check_skill_structure.py
	@echo ""
	@bash -c 'set -uo pipefail; source .venv/bin/activate; \
	  export PYTEST_TIMEOUT=$(PYTEST_TIMEOUT); rc=0; \
	  for d in .pi/skills/*/tests scripts/system/tests scripts/system/*/tests apps/orchestration/tests; do \
	    [ -d "$$d" ] || continue; \
	    echo "==================== pytest $$d ===================="; \
	    python -m pytest "$$d" -p no:cacheprovider -m "$(PYTEST_MARKERS)" --tb=short -q || { \
	      pytest_status=$$?; [ "$$pytest_status" -eq 5 ] || rc=1; \
	    }; \
	  done; \
	  exit $$rc'

# Full suite including heavy/external tests (network, integration, slow, e2e).
# These auto-skip when their external dependency (for example network or Ollama)
# is absent, so this stays green on machines without those services.
test-integration:
	bun run test:integration
	@bash -c 'set -uo pipefail; source .venv/bin/activate; \
	  export PYTEST_TIMEOUT=$(PYTEST_TIMEOUT); rc=0; \
	  for d in .pi/skills/*/tests scripts/system/tests scripts/system/*/tests; do \
	    [ -d "$$d" ] || continue; \
	    echo "==================== pytest $$d ===================="; \
	    python -m pytest "$$d" -p no:cacheprovider --tb=short -q || { \
	      pytest_status=$$?; [ "$$pytest_status" -eq 5 ] || rc=1; \
	    }; \
	  done; \
	  exit $$rc'

# EVALUATION — stub.
# The legacy behavioral ratchet (scripts/system/evals + scripts/system/trajectory)
# was retired 2026-08-21. A new evaluation system (prompt architecture, agents,
# skills, etc.) is being built from scratch under evals/. Oracle-authored
# trajectory fixtures are preserved at evals/fixtures/trajectory-fixtures.json.
evals:
	@echo "[evals] legacy ratchet retired — the new evaluation system lands under evals/ (see evals/README.md)"

# Public-boundary guard: fail if a tracked file reintroduces an operator-filesystem path
# (enforces the AGENTS.md "Public repository boundary" invariant; also runs inside `make test`).
check-public:
	@.venv/bin/python scripts/system/checks/check_public_boundary.py

# AGENTS.md grammar guard: the repository root uses the bounded bootstrap grammar; every
# other tracked AGENTS.md — anywhere in the repo, including docs/penny/ — must be a pure,
# complete, direct-child index. docs/humans/ may contain none. Tracked files only, so a
# configured private root is never scanned. See docs/agents/documentation/agents-md-standard.md.
check-agents-links:
	@.venv/bin/python scripts/system/checks/check_agents_links.py

# Knowledge-base privacy gate: the docs/kb scaffold stays exactly five tracked files with a
# default-deny ignore grammar, no live KB path is ever tracked, and root admission is
# default-deny for any registry-resolved root. See docs/agents/knowledge-base/privacy-and-promotion.md.
check-kb-privacy:
	@.venv/bin/python scripts/system/checks/check_kb_privacy.py

# Tool-authority conformance: each agent's `tools:` must be exactly the expansion of
# its declared `tool_profiles:`. Fails on drift, forbidden tools, and any non-modifying
# role exceeding the browser authority ceiling. See docs/agents/agents/tool-profiles.md.
check-tool-profiles:
	@.venv/bin/python scripts/system/checks/check_tool_profiles.py

# Provider-visible tool guidance: Penny's custom system prompt omits Pi's
# promptGuidelines, so runtime source must keep required guidance in descriptions,
# parameter schemas, or SYSTEM.md.
check-tool-descriptions:
	@.venv/bin/python scripts/system/checks/check_tool_descriptions.py

# Skill manifests: validate frontmatter routing descriptions, required sections,
# engine markers, prompt resources, and flow descriptors.
check-skill-structure:
	@.venv/bin/python scripts/system/checks/check_skill_structure.py

# Capability registry: `.pi/agents/*.md` frontmatter is the single source of truth for
# the roster. Validates completeness, enums, unique capabilities, neighbour referential
# integrity, and the description budget (silent truncation is the defect being prevented).
check-capability-registry:
	@.venv/bin/python scripts/system/checks/check_capability_registry.py

# Generated roster regions: every roster table in the docs is emitted from the registry.
# Hand-maintained roster tables are prohibited — they demonstrably drift.
check-agent-roster:
	@.venv/bin/python scripts/system/generate_agent_roster.py --check

lint:
	bun run lint
	bun run format:check
	.venv/bin/flake8 . --config .flake8
	.venv/bin/black . --check --config pyproject.toml
	.venv/bin/python scripts/system/checks/check_tool_profiles.py
	.venv/bin/python scripts/system/checks/check_tool_descriptions.py
	.venv/bin/python scripts/system/checks/check_capability_registry.py
	.venv/bin/python scripts/system/checks/check_skill_structure.py
	.venv/bin/python scripts/system/checks/check_agents_links.py
	.venv/bin/python scripts/system/checks/check_kb_privacy.py
	.venv/bin/python scripts/system/generate_agent_roster.py --check

typecheck:
	bun run typecheck

# Complete offline-safe publication gate. It never stages, commits, contacts a Git
# remote, or enables the live-model cohort; final candidate-tree/range checks remain
# Phase-5 procedures because they require an explicitly reviewed index and remote base.
verify-publication:
	bun install --frozen-lockfile
	uv sync --frozen --extra dev
	bun run format:check
	bun run lint
	bun run typecheck
	bun run typescript:inventory
	bun run typescript:architecture
	bun run typescript:guard-tests
	bun run test:typescript
	bun run test:all
	bun run build:observability
	bun run build:orchestration
	$(MAKE) lint
	$(MAKE) test
	$(MAKE) test-integration
	$(MAKE) check-public
	$(MAKE) check-kb-privacy
	bun run security:secrets:staged

format:
	bun run format
	.venv/bin/black . --config pyproject.toml

# ── Cleanup ─────────────────────────────────────────────────────────────────

clean:
	rm -rf .venv node_modules
	@echo "Cleaned code dependencies; memory data was preserved. Run 'make setup' to rebuild."
