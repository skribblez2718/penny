.PHONY: setup venv install-py install-js init clean test lint format docker-build docker-up docker-down

# ── Setup ───────────────────────────────────────────────────────────────────

setup: venv install-py install-js init
	@echo ""
	@echo "Setup complete. Copy .env.example to .env and fill in your values."
	@echo "Then start Pi in the project directory."

venv:
	uv venv .venv

install-py:
	uv sync

install-js:
	bun install

init:
	bash scripts/setup/setup.sh

# ── Development ─────────────────────────────────────────────────────────────

test:
	bun run test:unit
	@echo ""
	source .venv/bin/activate && python -m pytest .pi/skills/*/tests scripts/system/*/tests -v --tb=short

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
