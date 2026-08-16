# Deployment & Environment Conventions — Agent Reference

Rules for how Penny-built web apps separate **development** from **production**, bootstrap the
admin, and stay fail-closed in prod. Apply these to any new service and when touching an existing
one. Reference implementations that follow this identical shape live in the operator's local project
workspace (outside this public repo).

The intent is a **clear, total, intentional** dev/prod split — never an accidental one.

**Default web stack: ASGI app + Hypercorn serving HTTP/2.** Every web app MUST be operable through
`make` alone — a newcomer with a clone and nothing else runs `make setup && make dev`. See §2 and §2a.

## 1. The invariant: `dev = local`, `prod = Docker`

- `make dev` → run locally (autoreload, dev DB, dev secrets). Fast iteration, zero ceremony.
- `make prod` → build and run the hardened container(s) via `docker compose`. The **only** supported
  deployment path.
- Do not blur these. A local "prod-style" host run may exist as a **legacy/smoke-test** target
  (e.g. `make run`), but it is explicitly labeled _not the deploy path_.

## 2. Make-target contract (identical across repos)

**Every web app is driven entirely by `make`. No target may require the reader to know a server
command, a port, an interpreter path, or an activation step.** `make help` is the default goal and
lists every target.

| Target                                             | Meaning                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make help`                                        | **Default goal.** Self-documenting target list                                                                                                                                  |
| `make setup`                                       | **Idempotent, from-clone bootstrap**: create venv, install deps (`uv sync`), build frontend if any, scaffold gitignored dev `.env`, mint the dev TLS cert (§2a). Safe to re-run |
| `make dev`                                         | DEV: local processes (Hypercorn `--reload` + frontend), dev DB, dev secrets                                                                                                     |
| `make start`                                       | DEV-PROD-STYLE: Hypercorn on the host, no reload, prod-shaped flags. **Not the deploy path**                                                                                    |
| `make prod`                                        | PROD: `docker compose --env-file .env.prod up --build`                                                                                                                          |
| `make prod-down` / `make prod-logs`                | stop / tail the prod stack                                                                                                                                                      |
| `make stop`                                        | kill this project's stray dev processes                                                                                                                                         |
| `make check`                                       | the full local gate (lint + types + tests)                                                                                                                                      |
| `make create-admin-dev`                            | create the single admin in the **dev** DB                                                                                                                                       |
| `make create-admin-prod`                           | create the single admin **inside the running prod container**                                                                                                                   |
| `make delete-admin-dev` / `make delete-admin-prod` | remove that environment's single admin (rotate/reset)                                                                                                                           |

- `make setup` MUST be safe to run on a clean clone **and** on an existing tree — detect and skip
  completed steps rather than failing.
- `make dev` MUST depend on (or fail with a one-line pointer to) `make setup`. Never let a contributor
  hit a raw `ModuleNotFoundError`.
- Keep any pre-existing names (`run`, `install`, `create-admin`) as **aliases** so nothing breaks.
- `create-admin-prod` execs the CLI in the container (`docker compose --env-file .env.prod exec <svc> …`).

## 2a. ASGI server: Hypercorn over HTTP/2 (not uvicorn)

**Hypercorn is the default ASGI server. Uvicorn is not used.** Uvicorn speaks HTTP/1.1 only, which
forces the proxy→origin hop onto a protocol whose message framing is inherently ambiguous
(`Content-Length` vs `Transfer-Encoding`). That ambiguity is the root cause of HTTP request
smuggling / desync attacks. HTTP/2's binary framing carries an unambiguous per-message length, so an
HTTP/2 origin hop removes the vulnerability class rather than mitigating it.

- **Use HTTP/2, not HTTP/3, for the origin.** Behind Cloudflare Tunnel this is not a preference:
  `cloudflared` supports exactly HTTP/1.1 (default) or HTTP/2 (`http2Origin: true`) to the origin.
  There is **no HTTP/3/QUIC-to-origin option**. The `--protocol quic|http2|auto` flag configures the
  cloudflared↔Cloudflare-edge transport, **not** the origin hop — do not confuse the two.
- Config lives in a committed **`hypercorn.toml`** at the repo root; the server is always started as
  `hypercorn --config hypercorn.toml <module>:<app>`. Never scatter host/port flags across scripts.
- Set `alpn_protocols = ["h2", "http/1.1"]`. Hypercorn then serves h2 over TLS via ALPN, and h2c over
  cleartext (prior-knowledge and Upgrade), with HTTP/1.1 as fallback.
- Depend on **`hypercorn`** and **`h2`** explicitly. `h2` is what makes HTTP/2 actually available.
- **WSGI apps** (Flask/Django) are served by Hypercorn too — use `-k wsgi` / `worker_class = "wsgi"`.
  They still get an HTTP/2 origin hop; only the app-side concurrency model differs.

### TLS is mandatory, in dev AND prod (no cleartext listener)

The origin listener is **TLS-only**. There is deliberately **no cleartext/h2c bind and no
`insecure_bind`** — a cleartext port is an HTTP/1.1-capable surface, which is the thing being
eliminated. `http://localhost:<port>` must not answer.

Because the cert is gitignored and therefore never present on a fresh clone, **every launch path
mints-or-reuses it**:

| Path                                   | Behaviour                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `make setup`                           | mints the dev cert into `certs/` if absent                                                           |
| `make dev` / `make start` / `make run` | depend on the `certs` target — mint if absent, **reuse** if present                                  |
| `make prod` (container)                | the entrypoint mints into **`/data/certs`** if absent, **reuses** if present, then `exec`s Hypercorn |

The `certs` target MUST be a **file target** (`$(CERT_DIR)/dev-cert.pem`), not a phony one, so a
second run is a no-op (`make: Nothing to be done for 'certs'`) and the fingerprint is stable. A phony
target would re-mint on every launch and invalidate any pinned trust.

In containers the cert MUST land on the **persisted data volume**, never baked into the image:
baked certs are identical across every deployment and leak into image layers. `read_only` rootfs
makes the volume the only writable location anyway. Where the container runs non-root and cannot
write `/data`, use a Dockerfile-created, chowned directory instead — and say so in the entrypoint.

### Consequences of a TLS-only origin — update every internal consumer

Flipping the scheme breaks anything still speaking `http://` to the app port. All of these must move
to `https://` with verification disabled (self-signed):

- **Docker `HEALTHCHECK`** — prefer `python -c` with `ssl._create_unverified_context()` over `curl -k`;
  slim images often have no `curl`.
- **Dev-server proxies** (e.g. Vite `server.proxy`) — target `https://` and set `secure: false`.
- **Browser-facing dev servers stay http** — only the _proxy target_ changes. So CORS
  `allow_origins` needs the **app's own origin as `https://`** while the dev-server origin stays
  `http://`. Getting this half-right is a silent breakage.
- **Readiness/health polls** in dev scripts and launchers.
- **Test harnesses** — the in-test Hypercorn `Config` must set `certfile`/`keyfile` or it serves
  cleartext and the suite tests the wrong thing; clients need `verify=False`. Skip with a clear
  message when the cert is absent rather than failing obscurely.
- **Playwright** — `ignoreHTTPSErrors: true`.

### The cloudflared requirement — the part that is easy to get wrong

A cleartext h2c listener **does not** give you an HTTP/2 origin hop behind Cloudflare Tunnel.
`cloudflared` implements `http2Origin` via Go's `http.Transport` with `ForceAttemptHTTP2`, which
negotiates h2 **only over TLS via ALPN** — it never speaks cleartext h2c. An origin serving plaintext
h2c will silently be talked to over **HTTP/1.1**, leaving the desync exposure fully intact even though
Hypercorn is installed and HTTP/2-capable.

Closing the gap requires all three, together:

1. Hypercorn serving HTTP/2 — `alpn_protocols` + the `h2` dependency.
2. The origin listening on **TLS**: `certfile` / `keyfile` in `hypercorn.toml`. `make setup` mints a
   gitignored self-signed dev cert; prod supplies its own.
3. The tunnel pointed at an **https** origin with HTTP/2 enabled:

```yaml
ingress:
  - hostname: <host>
    service: https://localhost:<port>
    originRequest:
      http2Origin: true # HTTP/2 to the origin — the desync fix
      noTLSVerify: true # accept the local self-signed cert
```

Items 1–2 live in the repo. **Item 3 lives in tunnel configuration outside the repo** — a migration is
not complete until it is applied, and an agent MUST say so explicitly rather than implying the work is
done.

- Cert material is **never committed**: `.gitignore` the dev cert path (e.g. `certs/`).
- Keep a cleartext bind available for local tooling and container healthchecks that predate HTTP/2.

## 3. Secrets: dev is frictionless, prod is a dedicated file

- **Dev**: the app may auto-scaffold a gitignored `.env` with generated dev secrets; weak/placeholder
  values are acceptable **only** in dev/test.
- **Prod**: use a dedicated, gitignored **`.env.prod`** (ship a committed `.env.prod.example`).
  `make prod*` targets pass `--env-file .env.prod` so the dev env is **never** read for prod — this
  prevents dev secrets leaking into prod via compose interpolation.
- In `docker-compose.yml`, mark required prod values with `${VAR:?message}` so compose **fails fast**
  when they are missing.
- `.gitignore` must track the example but ignore the real file: `.env.*` + `!.env.example` +
  `!.env.prod.example`.

## 4. Prod config is fail-closed (a settings validator)

Settings live in one typed module (`app/core/config.py`), `env` ∈ {`dev`,`prod`} (optionally `test`). A
`model_validator(mode="after")` MUST refuse to boot when `env=prod` and any of:

- `debug` is true;
- the session cookie is not `Secure`;
- the CSRF `admin_origin` is unset (coerce blank env `""` → `None` first, via a `before` validator);
- any secret (`session_secret*`, `csrf_secret_key`, `mfa_enc_key`) `_looks_weak` — `< 32` chars,
  contains a placeholder marker (`changeme`, `example`, `placeholder`, `test-`, `dev-`, `secret-key`),
  or has a `(.)\1{3,}` repeated run.

Both blog and ketwise share this exact validator — copy it, do not reinvent per-app thresholds.

## 5. Admin bootstrap: credentials live in the DB, per-environment

- The single admin is a **DB row** (username + Argon2id hash), created **only** by the `create-admin`
  CLI. There is **no web/registration path**.
- Because dev and prod use **different databases**, they have **independent** admin credentials + MFA.
  Never put admin credentials in env/config.
- Enforce single-admin with a **DB unique index on a constant expression** (`(1)`), so a second row is
  physically impossible — plus an app-level guard in the CLI.
- Provide a **`delete-admin`** command (parity across apps) plus **per-environment make targets**
  (`delete-admin-dev`/`delete-admin-prod`) so credentials are rotated/reset explicitly per environment
  — each acts only on that environment's own database.
- MFA (TOTP) enrolls on **first login**, mandatory; the TOTP secret is encrypted at rest under
  `mfa_enc_key`.

## 6. Prod cookie ⇒ HTTPS-only admin

Prod cookies are `Secure` + `__Host-`, so **the admin login only works over HTTPS**. Prod is expected
to sit behind a **TLS-terminating reverse proxy**; honor forwarded client IPs only from configured
trusted proxy CIDRs (never trust `*`).

## 7. Container shape

- **Multi-stage**: a Node builder produces the frontend bundle; the runtime is **pure Python** via
  `uv sync --frozen --no-dev`. No Node in the runtime image. (Default to SQLite — stdlib, no driver;
  add `--extra <driver>` only if an app genuinely needs a managed DB, e.g. `postgres`.)
- Non-root user, `read_only` rootfs + `tmpfs:/tmp`, `cap_drop: [ALL]`, `no-new-privileges`, a
  `HEALTHCHECK` hitting the health endpoint, and a named **data volume** for media/DB.
- The entrypoint runs `alembic upgrade head`, then `exec`s Hypercorn
  (`exec hypercorn --config hypercorn.toml <module>:<app>`) for clean PID-1 signal handling.
- The image installs `hypercorn` + `h2`; it MUST NOT install or reference `uvicorn`.
- If the app has an in-process scheduler, run **one** worker; document how to scale (separate
  scheduler-owning process).
- **Default DB topology: SQLite on the `/data` volume**, single writer process — both ketwise and blog
  use this. Only add a managed DB service (e.g. `postgres:16` + healthcheck + `depends_on`, driver via
  a `uv` extra) when there's a concrete need (write concurrency / replicas). SQLite↔Postgres are not
  drop-in compatible: pick one per app and keep dev and prod on the same engine. Hardening is identical
  either way.
- **`.dockerignore` MUST exclude `**/.env`and`**/.env.\*`.** A dev `.env` swept into the image (e.g.
  by `COPY backend/ …`) leaks dev secrets AND overrides the prod environment (it flipped `env=prod`
  into `debug=true` in a real build — the fail-closed validator caught it, but exclude it anyway).
  Prod config comes from the container environment only, never a baked file.

## 8. Content-as-code + progress-safe seeding (apps with authored data)

For apps whose authored data (courses, catalogs, seed content) ships via git:

- Treat data as **content-as-code**: the canonical source is committed files (e.g. `content/*.json`),
  **baked into the prod image**; a deploy step seeds from them. `make prod` seeds after the stack is
  healthy (`up -d --wait` then a seed exec), **not** on every container restart when the seed can
  touch user data.
- The importer MUST be a **non-destructive, stable-id upsert** whenever user state references content
  ids: match by slug, UPDATE in place (**keep ids**), insert new, delete removed. A
  delete-and-reinsert that reassigns ids **silently resets** any user state keyed to those ids.
- **Before** wiring seed-on-deploy, verify how user state is keyed (row-id vs slug). Real example:
  ketwise stores learner completion client-side in localStorage keyed by **lesson id**, so the
  importer had to preserve lesson/chunk ids across re-imports or every learner's progress would reset.
- Prove it with a **regression test**: re-import keeps ids; edit keeps id (state preserved); add gets a
  new id (shows incomplete); remove deletes it. Then run the seed in the actual container and confirm
  a sample id is unchanged after a re-seed.
- **If the data is authored in an admin UI (not just built from source), the DB is the source of
  truth.** Then: (a) the seed is **bootstrap-only** — it populates an empty DB and NEVER overwrites,
  so admin edits persist across restarts; (b) shipping is an **explicit export** (`export-content`:
  DB → the committed files + a `media/` folder), NOT a live JSON mirror — an explicit export gives a
  reviewable `git diff` and lets the author choose when content ships; (c) the export/import must
  **round-trip** (export then import into a fresh DB reproduces structure + text + media), and binary
  media is committed (content-hash filenames = stable + deduped; keyed by hash, not per-env row id).
  Skip code-generated rows (e.g. curated quiz chunks) on export — the importer re-adds them. Prove it
  with a **round-trip test**. Reference: ketwise `scripts/export_content.py` +
  `tests/integration/test_export_import_roundtrip.py`.

## 9. Verification an agent MUST run before claiming done

- App gate green: `ruff` + `mypy`/`tsc` + the test suite (add a config-hardening test, a
  `delete-admin` test, and an importer id-stability test where applicable).
- Compose parses: `docker compose --env-file .env.prod config -q` (use a throwaway `.env.prod`).
- Targets expand: `make -n setup`, `make -n dev`, `make -n prod`, `make -n create-admin-prod`.
- **From-clone UX holds**: `make setup && make dev` works with no other command, and `make help`
  lists every target.
- **HTTP/2 is actually being served** — assert the negotiated protocol, do not assume it from config:
  - cleartext: `curl -sI --http2-prior-knowledge http://127.0.0.1:<port>/ | head -1` → `HTTP/2 200`
  - TLS/ALPN: `openssl s_client -alpn h2 -connect 127.0.0.1:<port> </dev/null 2>&1 | grep ALPN`
    → `ALPN protocol: h2`
- **No uvicorn remains**: `grep -ri uvicorn` returns nothing outside changelogs/history.
- Build + run the image; hit the health endpoint; exercise the seed and confirm **id-stability** on a
  re-seed. State explicitly if any of this was not executed.
