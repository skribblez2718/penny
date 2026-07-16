# Deployment & Environment Conventions (the WHY)

This page explains the reasoning behind how Penny-built web apps split **dev** from **prod**,
bootstrap the admin, and refuse to run insecurely in production. The agent-facing rules live in
[`docs/agents/coding/deployment-conventions.md`](../../agents/coding/deployment-conventions.md).
Two apps implement this pattern identically today: **blog** and **ketwise**.

## The one idea: make the dev/prod boundary loud

Most production incidents at the small-app scale come from a **blurred boundary** — dev debug flags,
weak/shared secrets, or an insecure cookie sneaking into a real deployment. So the convention is
deliberately blunt:

> **`make dev` runs locally. `make prod` runs Docker. Nothing else deploys.**

You should never have to *wonder* which environment you're in. The command you type, the file that
holds the secrets, and the failure you get when something's missing all tell you.

## Why `dev = local` and `prod = Docker`

- **Local dev** should be instant and forgiving: autoreload, a throwaway SQLite file, auto-generated
  dev secrets. No containers to rebuild, no compose to reason about.
- **Prod** should be reproducible and hardened: a pinned, multi-stage image; a real database; strong
  secrets; a non-root, read-only, capability-dropped container behind TLS.

Trying to make one command serve both ends in compromise. Two commands, two mental models, zero
overlap.

## Why prod secrets live in a separate `.env.prod`

`docker compose` automatically reads a `.env` file for `${VAR}` interpolation. If prod reused the
dev `.env`, your **dev secrets would silently flow into the prod stack**. That's the exact "blurred
boundary" we're avoiding. So `make prod` passes `--env-file .env.prod` — a dedicated, gitignored
file (with a committed `.env.prod.example` template). Missing values fail fast because compose marks
them `${VAR:?…}`.

## Why production is "fail-closed"

A settings validator refuses to boot in prod if debug is on, the session cookie isn't `Secure`, the
CSRF origin is unset, or any secret looks like a placeholder. This turns four classic
critical-severity misconfigurations into a **loud startup crash** instead of a silent live weakness.
The check lives in one place and is copied verbatim between apps, so "hardened" means the same thing
everywhere. (This is the "give the model the artifact and verify the output" philosophy: the app
verifies its own config at boot rather than trusting a human checklist.)

## Why the admin lives in the database, per environment

There is exactly one admin, and it is a **database row** created by a CLI — never a web signup, never
an env var. Two consequences fall out naturally:

- **Dev and prod have independent admin credentials and MFA**, because they're different databases.
  You can hand out a throwaway dev login without touching prod.
- **Rotating credentials is a data operation**, not a config change: `delete-admin` then
  `create-admin`. A DB-level unique index makes a second admin physically impossible.

MFA (TOTP) is enrolled on first login and the shared secret is encrypted at rest — so even a DB leak
doesn't hand over the second factor.

## Why the admin login is HTTPS-only in prod

Prod cookies use the `__Host-` prefix and the `Secure` flag, which browsers only send over HTTPS.
That's intentional: it means a misconfigured plaintext deployment simply **can't** log in, rather
than logging in insecurely. Put the stack behind a TLS-terminating reverse proxy.

## Per-app database topology

The hardening is identical everywhere. Both current apps (**ketwise** and **blog**) run a single
self-hosted container with **SQLite on a `/data` volume** — the simplest footprint for a self-hoster,
and a good fit because each runs a single writer process. If an app genuinely needs a managed database
(high write concurrency, multiple replicas), the pattern still holds: add it as a compose service
(e.g. `postgres:16` with a healthcheck + `depends_on`), install its driver via a `uv` extra, and point
`BLOG_DATABASE_URL`/equivalent at it — the rest of the convention is unchanged. Standardize on SQLite
unless there's a concrete reason not to (SQLite and Postgres are not drop-in compatible, so pick one
per app and keep it consistent across dev and prod).

## Why authored content is "code" — and why the importer can't just rebuild

Apps like ketwise ship their courses as committed `content/*.json`. That data is baked into the prod
image, and `make prod` seeds it. The subtle trap: the *obvious* way to seed — "drop the old content,
insert the new" — quietly destroys **learner progress**, because progress is stored per-lesson keyed
by the lesson's database id, and a drop-and-reinsert hands every lesson a brand-new id. The saved
progress then points at ids that no longer exist.

So the seed is a **non-destructive, stable-id upsert**: it matches content by slug and updates rows
*in place*, keeping their ids. Editing a lesson keeps its progress; adding a lesson gives it a fresh
id so it shows as *incomplete* until completed; removing a lesson deletes it. This is exactly the
behavior you'd want intuitively — but it only holds because the importer is careful about identity,
and a regression test pins it so a future refactor can't silently break it. The lesson generalizes:
**when a deploy re-seeds data that user state points at, the seed must preserve identity, not rebuild.**

There's a second half once you author content **in an admin panel** rather than only building it from
source: the **database becomes the source of truth**, so the seed must stop overwriting it. In ketwise
the seed became *bootstrap-only* — it fills an empty database and then never touches it, so your edits
survive every restart. To ship those edits, you run an **explicit export** (`make export-content`) that
regenerates the committed `content/` (JSON + a media folder) *from the DB*. Why explicit rather than a
live mirror that's always in sync? Because a live mirror fights your in-progress edits and produces
noisy churn; an explicit export gives you a **reviewable `git diff`** and lets you decide when content
ships — export, review, commit, then `git pull && make prod` applies it (progress preserved). The
export/import is proven to **round-trip** (export then import into a fresh DB reproduces everything),
and media travels as content-hashed files so it's stable and deduped across environments.

## Why prod config never comes from a baked file

Prod configuration comes only from the container's environment (via compose), never from a file baked
into the image. We learned this the loud way: a `COPY backend/ …` swept the dev `.env` into the prod
image, and the app read it — which both leaked dev secrets and flipped production into debug mode. The
fail-closed validator caught it at boot (that's its job), but the real fix is to keep env files out of
the image entirely (`.dockerignore` excludes `**/.env`). Config lives in exactly one place per
environment; nothing can quietly shadow it.

## What you actually type

```bash
# Dev
make dev                       # local: autoreload, SQLite, dev secrets
make create-admin-dev u=me e=me@example.com

# Prod
cp .env.prod.example .env.prod # fill in strong secrets once
make prod                      # docker compose --env-file .env.prod up --build
make create-admin-prod u=me e=me@example.com
```

If you're adding a new service, copy this shape from blog or ketwise rather than inventing a new one
— consistency here is worth more than local cleverness.
