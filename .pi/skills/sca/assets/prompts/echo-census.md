# P1 — Census (Domain Guidance for `echo`)

Review, confirm, and enrich the repository census the orchestrator has ALREADY
computed. The deterministic inventory (`total_files`, `js_ts_files`,
`js_ts_loc`, `uncovered_files`, `uncovered_loc`, `lockfiles`,
`workspace_count`) is embedded in your task — confirm the counts and add what
raw counts cannot show, do NOT re-walk the tree from scratch. This inventory
sizes the real attack surface for every phase that follows.

**MemPalace:** write ALL entries for this phase to wing `wing_sca`, room
`<session_id>-p1_census`. Search that wing first for the approved P0 charter
(scope and `out_of_scope` bound what counts here). Emit only a compact
`SUMMARY:{...}` JSON block inline; the full census notes live in mempalace.

---

## 1. Confirm the pre-computed inventory

Sanity-check the supplied numbers against the tree: the file and LOC totals are
plausible, the lockfiles resolve to real dependency manifests, and
`workspace_count` reflects every workspace of a monorepo. Note any figure that
looks wrong and why.

## 2. Enrich beyond the counts

Add the facts a file/LOC count alone cannot surface, each grounded in a real
path:

- **entry points** — servers, route handlers, CLIs, scheduled jobs, message
  consumers, webhooks (where untrusted input first enters the code).
- **frameworks and runtimes** — the stack the code actually runs on, inferred
  from lockfiles and config, since it governs which weaknesses apply.
- **dependency risk** — direct dependencies of note (auth, crypto, deserialize,
  templating, DB drivers) worth flagging for the P2 baseline scan.

## 3. Coverage honesty

The `uncovered_files` / `uncovered_loc` (non-JS/TS) count is an explicit
coverage gap, NOT a clean result — the JS/TS SAST lane does not read those
files. State the gap plainly and never let a zero-JS/TS repo read as "nothing
to analyze".

## 4. Output shape

Work from the census and repository already available; if a critical ambiguity
remains that you cannot resolve from them, set `needs_clarification: true` with
`clarifying_questions` naming what you need (the parent process asks the user
and resumes you) — do not guess when you can ask, and do not call the
questionnaire tool directly.

Record the confirmed census plus your enrichments as a mempalace entry in the
P1 room, then emit a compact inline summary:

```
SUMMARY:{"census_confirmed":<true|false>,"entry_points":["<path>"],"frameworks":["<name>"],"key_dependencies":["<name>"],"coverage_gaps":["<one line each>"],"needs_clarification":<true|false>,"clarifying_questions":[],"confidence":"CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN","mempalace_drawer":"<id>"}
```

Confirm the deterministic inventory, add the entry points and stack it cannot
infer, and disclose every coverage gap honestly.
