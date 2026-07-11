# FastAPI — Documentation Lookup

> **Hybrid lookup.** The table below is a self-healing cache of known-good URLs.
> Fetch the URL for your concept; if it 404s or drifts, repair the row per
> [../library-docs.md](../library-docs.md). Fetch the live page for current API.

- **Canonical docs:** https://fastapi.tiangolo.com/
- **URL scheme:** `https://fastapi.tiangolo.com/<section>/…` (e.g. `/tutorial/…`, `/advanced/…`)
- **Version:** confirm `fastapi` and `pydantic` (v1 vs v2 differ substantially)
  from the project's `pyproject.toml` / lockfile, and fetch docs for the
  installed major versions.

## Concept → URL table (self-healing cache)

`Verified`: `✓ <date>` = confirmed live that date · `seed` = curated, confirm on
first use (a failed fetch self-heals and dates the row).

| Concept | URL | Verified |
|---|---|---|
| Overview / features | https://fastapi.tiangolo.com/features/ | seed |
| Tutorial (first steps) | https://fastapi.tiangolo.com/tutorial/ | seed |
| Path & query params | https://fastapi.tiangolo.com/tutorial/query-params/ | seed |
| Request body (Pydantic models) | https://fastapi.tiangolo.com/tutorial/body/ | ✓ 2026-07-10 |
| Response model | https://fastapi.tiangolo.com/tutorial/response-model/ | seed |
| Dependencies (DI) | https://fastapi.tiangolo.com/tutorial/dependencies/ | seed |
| Bigger apps / routers | https://fastapi.tiangolo.com/tutorial/bigger-applications/ | seed |
| CORS | https://fastapi.tiangolo.com/tutorial/cors/ | seed |
| Middleware | https://fastapi.tiangolo.com/advanced/middleware/ | seed |
| Streaming / custom responses (SSE) | https://fastapi.tiangolo.com/advanced/custom-response/ | seed |
| Security (OAuth2, JWT) | https://fastapi.tiangolo.com/tutorial/security/ | seed |
| Async / concurrency | https://fastapi.tiangolo.com/async/ | seed |
| Deployment | https://fastapi.tiangolo.com/deployment/ | seed |
