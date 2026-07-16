# Deployment & Environment Conventions — Agent Reference

Rules for how Penny-built web apps separate **development** from **production**, bootstrap the
admin, and stay fail-closed in prod. Apply these to any new service and when touching an existing
one. Reference implementations: `~/projects/blog` and `~/projects/ketwise` (identical shape).

The intent is a **clear, total, intentional** dev/prod split — never an accidental one.

## 1. The invariant: `dev = local`, `prod = Docker`

- `make dev` → run locally (autoreload, dev DB, dev secrets). Fast iteration, zero ceremony.
- `make prod` → build and run the hardened container(s) via `docker compose`. The **only** supported
  deployment path.
- Do not blur these. A local "prod-style" host run may exist as a **legacy/smoke-test** target
  (e.g. `make run`), but it is explicitly labeled *not the deploy path*.

## 2. Make-target contract (identical across repos)

| Target | Meaning |
|---|---|
| `make dev` | DEV: local processes (backend `--reload` + frontend), dev DB, dev secrets |
| `make prod` | PROD: `docker compose --env-file .env.prod up --build` |
| `make prod-down` / `make prod-logs` | stop / tail the prod stack |
| `make create-admin-dev` | create the single admin in the **dev** DB |
| `make create-admin-prod` | create the single admin **inside the running prod container** |
| `make delete-admin-dev` / `make delete-admin-prod` | remove that environment's single admin (rotate/reset) |

- Keep any pre-existing names (`start`, `run`, `create-admin`) as **aliases** so nothing breaks.
- `create-admin-prod` execs the CLI in the container (`docker compose --env-file .env.prod exec <svc> …`).

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
- The entrypoint runs `alembic upgrade head`, then `exec`s the ASGI server (clean PID-1 signals).
- If the app has an in-process scheduler, run **one** worker; document how to scale (separate
  scheduler-owning process).
- **Default DB topology: SQLite on the `/data` volume**, single writer process — both ketwise and blog
  use this. Only add a managed DB service (e.g. `postgres:16` + healthcheck + `depends_on`, driver via
  a `uv` extra) when there's a concrete need (write concurrency / replicas). SQLite↔Postgres are not
  drop-in compatible: pick one per app and keep dev and prod on the same engine. Hardening is identical
  either way.
- **`.dockerignore` MUST exclude `**/.env` and `**/.env.*`.** A dev `.env` swept into the image (e.g.
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
- Targets expand: `make -n prod`, `make -n create-admin-prod`.
- Build + run the image; hit the health endpoint; exercise the seed and confirm **id-stability** on a
  re-seed. State explicitly if any of this was not executed.
