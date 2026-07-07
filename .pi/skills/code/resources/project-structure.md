# Project Structure — Multi-Server Single-Command Startup

Reference for skribble. Read when the project ships **more than one
long-running process** (e.g. a backend + a frontend dev server, or two
backends, or a backend + a worker). Auto-injected by the code skill
when `_detect_multi_server` returns `is_multi_server: True`.

## The Rule

> **If the project requires multiple servers to fully function, the
> project MUST be set up so all servers can be started with a single
> command.**

A user should be able to clone, install, and run with **one** command:

```bash
git clone <repo> && cd <repo>
make install   # or: ./scripts/install.sh
make dev       # or: ./scripts/dev.sh
# browser opens, app is live
```

If the README says "open two terminals and run X, then Y" — that is a
**bug in the project**, not a design choice. Fix it.

## Why This Rule Exists

| Without single-command startup | With single-command startup |
|---|---|
| New contributor spends 30 min wiring up terminals | New contributor is running in 60 seconds |
| "Works on my machine" because someone had a stale terminal | One source of truth: the script knows the right order |
| Ctrl-C leaves zombie processes on the wrong port | Trap-based cleanup leaves a clean machine |
| Hard to script (CI, demos, agent-driven verification) | `make check` returns 0 when ready, 1 otherwise |
| Easy to forget a service, debug the wrong one | The script waits for each service to be healthy before proceeding |

## What "Single Command" Means

The single command must:
1. **Start all long-running processes** the project needs to be usable.
2. **Wait for each to be healthy** before declaring success (so opening
   the browser doesn't show a half-loaded app).
3. **Forward or display logs** in a way the user can read.
4. **Tear down all processes cleanly** on Ctrl-C / SIGTERM (no zombies
   on the wrong port).
5. **Be idempotent** — running it twice in a row is safe (either
   refuses to start because ports are taken, or kills the previous run
   and restarts).
6. **Have a `--check` or equivalent mode** that exits 0 only when all
   services are responsive (for CI / agent verification).

## Recommended Implementation Patterns

Pick **one** of these (don't combine — pick the simplest that fits the
ecosystem):

### Pattern A — Shell script + Makefile (most portable)

Best for: polyglot projects, projects with > 2 processes, projects
that want maximum transparency.

```text
project/
├── Makefile          # thin wrappers: make install, make dev, make test
├── scripts/
│   ├── dev.sh        # starts all servers, traps signals, tails logs
│   ├── test.sh       # runs all test suites
│   └── stop.sh       # kills leftovers (or just pkill in Makefile)
```

```makefile
# Makefile
.PHONY: dev test install check stop

dev:
\t@./scripts/dev.sh

check:
\t@./scripts/dev.sh --check

test:
\t@./scripts/test.sh

install:
\t@./scripts/install.sh   # or inline the venv + bun steps
```

**Why this works:**
- `make` is everywhere (Linux, macOS, WSL). If absent, the README
  documents `./scripts/dev.sh` as the fallback.
- The script owns all the messy bits (PIDs, signals, log file paths,
  health checks). The Makefile is a thin alias.
- The same script can be invoked by CI, by an agent, or by a user.

### Pattern B — `concurrently` (Node ecosystem)

Best for: JS/TS-only projects with 2–3 services.

```json
// package.json
{
  "scripts": {
    "dev": "concurrently -n backend,frontend -c blue,magenta \"npm:dev:backend\" \"npm:dev:frontend\"",
    "dev:backend": "tsx watch src/server.ts",
    "dev:frontend": "vite"
  }
}
```

Add `concurrently` as a dev dependency. `Ctrl-C` kills both because
`concurrently` traps signals and forwards them.

### Pattern C — `honcho` / `foreman` (Python ecosystem)

Best for: Python projects with multiple processes, especially with
Procfile-style process definitions.

```text
# Procfile
backend: .venv/bin/uvicorn app.main:app --port 8000
worker:  .venv/bin/python -m app.worker
```

```bash
honcho start        # or: foreman start
```

### Pattern D — `docker compose` (heavyweight, but explicit)

Best for: production-like local dev, projects that already have a
container story.

```yaml
# docker-compose.yml
services:
  backend:
    build: ./backend
    ports: ["8000:8000"]
  frontend:
    build: ./frontend
    ports: ["5173:5173"]
    depends_on: [backend]
```

`docker compose up` is the one command. Trade-off: heavier
(prerequisites, image builds, slower iteration).

## What Goes in the Dev Script

The dev script is the heart of the rule. It MUST:

| Concern | Implementation |
|---|---|
| **Track every child PID** | An `ALL_CHILD_PIDS=()` array updated on each `start_*` call. Do NOT rely on process groups — signaling the PGID of the script can re-fire the script's own signal trap. |
| **Trap SIGINT and SIGTERM** | `trap 'cleanup INT; exit 0' INT` and `trap 'cleanup TERM; exit 0' TERM` |
| **Cleanup is per-PID, not per-group** | `for pid in "${ALL_CHILD_PIDS[@]}"; do kill -"$sig" "$pid" 2>/dev/null; done` |
| **Health probe** | After starting each service, poll its health endpoint (e.g. `GET /api/health`) with a deadline. Fail the script if the service isn't ready in time. |
| **Logs to a file, not stdout** | Per-service log files (`$LOG_DIR/backend.log`, `$LOG_DIR/frontend.log`) keep the terminal clean. Tail the files in a `tail -F` background job so the user sees activity. |
| **Idempotent port check** | Before starting, check if the port is already in use. If it is, either fail with a clear "port X is busy — run `make stop` first" or kill the previous run. |
| **`--check` mode** | Exits 0 if all services are healthy, 1 otherwise. Used by `make check`, CI, and agent verification. |

## Anti-Patterns (AVOID)

| Anti-pattern | Why it's wrong |
|---|---|
| `nohup uvicorn ... &` then `npm start &` in a README | No PID tracking, no cleanup, no health check, no idempotency |
| `tmux new-session -d` with split panes | Looks slick, but tmux is an extra dependency, and "what tmux session is this app in?" is unanswerable |
| `screen -dmS backend` etc. | Same tmux problem, plus screen is rarely installed on macOS anymore |
| `disown` + `&` in a shell script with no PID tracking | Same problem as nohup — Ctrl-C won't kill the children |
| A root `package.json` that runs a backend Python process via `child_process` | Cross-language process spawning is hard; signals don't translate cleanly. Use a shell script. |
| "Run `docker compose up`" as the only option | Forces Docker on contributors who don't need it. Offer the shell-script path as the default. |
| Reading logs by piping the child's stdout through `tee` | Mixing logs with the script's own output makes it impossible to follow. Use log files. |

## Verification

The `verify` phase of the code skill should:
1. **Run** the project's single-command startup (e.g. `make dev`).
2. **Poll** the health endpoint(s) until they're green (or timeout).
3. **Run** `make check` (or equivalent) and assert exit 0.
4. **Send SIGTERM** to the script and assert all child ports are free
   within 5 seconds.
5. **Re-run** the script and assert it still works (idempotency).

If any of these fail, the project is **not done**, regardless of how
many unit tests pass.

## Reference Implementation

The `simple_rag` project (built by the code skill on 2026-06-09) has
a working reference implementation at:
- `simple_rag/Makefile`
- `simple_rag/scripts/dev.sh`
- `simple_rag/scripts/test.sh`

Read these before writing your own — they handle the rough edges
(PID tracking, signal traps, health probes, log file paths) that
every dev script needs to get right.
