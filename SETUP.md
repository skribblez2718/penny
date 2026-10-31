# Local Setup

This operator-local guide is intentionally ignored by Git. It preserves the installation and service-setup material removed from the public README while Penny’s public documentation focuses on what the project is and provides.

## Requirements

- **Pi:** use the exact runtime version pinned in [`package.json`](package.json). Setup rejects a mismatch. See [Pi on GitHub](https://github.com/earendil-works/pi).
- **Node.js:** use the tested runtime pinned in [`.nvmrc`](.nvmrc); setup also checks its bundled SQLite version against the current requirement.
- **Python:** use a version allowed by [`pyproject.toml`](pyproject.toml).
- **Bun:** JavaScript runtime and package manager; the [setup preflight](scripts/setup/preflight.mjs) enforces the current minimum.
- **uv:** Python package manager. See [docs.astral.sh/uv](https://docs.astral.sh/uv).
- **Agent model aliases:** configure any aliases used by the catalog against models available in the current Pi installation; see [Agent Model Aliases](docs/humans/agents/model-aliases.md).

## Quick Start

This is the supported setup **outline for a prepared machine**, not a network bootstrapper. First install the repository-pinned Pi and Node runtimes plus the required Bun, Python, and uv versions. Ensure the Bun and uv caches already contain every locked dependency: setup is deliberately frozen and offline, and the repository does not silently prime those caches.

Check out the repository and create its local configuration:

```bash
git clone https://github.com/skribblez2718/penny.git
cd penny
# With NVM: nvm install && nvm use
cp .env.example .env
```

Complete `.env`, including credentials and caller-owned paths. Configure the [agent model aliases](docs/humans/agents/model-aliases.md). Then create a private memory-hub configuration from [`scripts/setup/mempalace-hub.config.json.in`](scripts/setup/mempalace-hub.config.json.in), start that supervised hub, and replace the example path below with its absolute path:

```bash
make setup STATE_MODE=fresh MEMORY_HUB_CONFIG=/absolute/private/hub.json
pi
```

For an explicitly degraded installation without memory, set `PENNY_MEMORY_MODE=disabled` in `.env` and run `make setup STATE_MODE=fresh MEMORY_MODE=disabled` instead; see [Memory and Observability](#memory-and-observability).

Readiness on a particular machine is established by the checks, not assumed from this outline.

- **Preflight:** setup runs the [prerequisite checks](scripts/setup/preflight.mjs) and [bounded configuration validation](scripts/setup/check-config.mjs) before initialization.
- **Expected setup result:** the [`setup-ready` target](Makefile) prints `Setup complete. Penny is ready for the selected profile.` only after the setup doctor reports success. This does not verify live provider calls or complete workflow behavior.
- **Expected launch result:** `pi` opens the interactive session in the project directory and reports the loaded project resources. A successful launch alone is not evidence that every provider or optional external service works.
- **If setup fails:** keep the typed error and follow the relevant recovery guidance. For retained state, see [database health](docs/humans/state-management/state-management.md#database-health) and the [readiness and schema-upgrade runbook](docs/humans/state-management/state-management.md#readiness-and-schema-upgrade-runbook); for memory, see [retention, repair, and historical data](docs/humans/memory/integration.md#retention-repair-and-historical-data). A missing cache entry requires a separately authorized cache-preparation step; do not weaken the offline setup or reset retained data merely to make a check pass.

MemPalace hub memory is enabled by default. The hub configuration, token, roots, and service remain caller-owned and outside the repository; setup validates them but never discovers, creates, migrates, repairs, or deletes a palace. Memory writes remain disabled until the separate canary and accepted-write reconciliation gates pass.

`STATE_MODE=fresh` is explicit authorization to initialize only a genuinely fresh canonical Penny state target. Existing installations use `STATE_MODE=existing` (the default). Missing, incomplete, incompatible, or retained state never falls through as successful setup; retained state uses the documented migration or recovery flow.

`make setup` performs frozen, offline dependency installs from local caches, builds orchestration and observability once, and exits zero only after state, artifacts, checkpoints, receipt authority, observability, authenticated memory, and provider-free extension loading pass the setup doctor. A missing cache entry is an error rather than permission to resolve or download a package. Setup does not install or update Pi, Node, Bun, Python, or uv.

## Memory and Observability

MemPalace is a core, default-enabled service. Create a private hub configuration from `scripts/setup/mempalace-hub.config.json.in`, start it with your preferred service manager, and set the matching `PENNY_MEMORY_*` values described in `.env.example`. `make setup` requires `MEMORY_HUB_CONFIG=/absolute/private/hub.json` and verifies supervisor identity, liveness, and authenticated status. It never opens palace bytes directly. Memory writes remain disabled until the checks listed in `.env.example` pass.

An explicit `make setup MEMORY_MODE=disabled` remains available for degraded recovery or testing, but `.env` must also explicitly set `PENNY_MEMORY_MODE=disabled` and the result is labeled as a no-memory profile. Memory remains separate from workflow artifacts and checkpoints, so disabling it does not grant setup permission to alter either persistence plane.

Observability is enabled by default. Setup validates the canonical database and exercises the built service against disposable owner-only state on an ephemeral loopback port, including health and authentication behavior; it does not leave a background process running. Penny stores local diagnostic logs but does not copy conversation transcripts into its log database. Conversation history remains in Pi's local session files.
