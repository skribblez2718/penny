# Derivation Skill Reference

Technical reference for the derivation skill. The authoritative source is the
engine playbook `DerivationPlaybook` in
`apps/orchestration/src/orchestration/playbooks/derivation.py`; this file
mirrors its FSM. State lives in the durable checkpointer keyed by `run_id` — no
session files, no `--state` argv.

## State Machine

### States

| State                    | Kind      | Agent   | Description                                                                 |
| ------------------------ | --------- | ------- | --------------------------------------------------------------------------- |
| `intake`                 | initial   | —       | Validate goal; route by the SHAPE of `constraints.sources` (directory ⇒ `gathering`, manifest file ⇒ `reviewing`) |
| `gathering`              | dynamic fan | `echo` × N | Runs ONLY when `sources` is a directory. Local, read-only corpus inventory: one branch per scannable file (`.md`/`.txt`/`.rst`/`.text`, large files sharded), each reporting a grounded license/bucket call + headings-only outline. Self-loops (`gather_batch`) for corpora wider than `max_fan_width`. NOT escalatable |
| `reviewing`              | primitive | `annie` | Tier-1 `scripts/prefilter.py` (per-source verbatim overlap) + Tier-2 `resources/rubric.md` (AFC, D1–D7) → the verdict |
| `unknown`                | transient | —       | Escalation staging (from `reviewing` only)                                  |
| `awaiting_clarification` | HITL      | — (user)| Paused on annie's questions; `clarify` resumes at `reviewing`               |
| `complete`               | final     | —       | Verdict rendered                                                            |
| `error`                  | final     | —       | Hard failure: zero scannable files, gather budget exhausted before 100% coverage, or abort |

### Transitions

`intake → gathering` (`start_gather`, sources is a directory) or
`intake → reviewing` (`start_review`, sources is a `manifest.json` file — fast path);
`gathering ⟲` (`gather_batch`, next fan round) `→ reviewing` (`gather_done`, 100% coverage);
`reviewing → complete` (`review_done`) or `→ unknown → awaiting_clarification → reviewing`
(UNCERTAIN / needs_clarification); any state `→ error` (abort). A gather shortfall is a
**terminal error, never a partial-corpus pass-through**.

## SUMMARY contracts

| State | Required | Notable optional |
|-------|----------|------------------|
| gathering (each branch) | `gather_complete: bool` | `license`, `license_confidence`, `license_evidence`, `bucket` (+ confidence/evidence), `outline`, `unresolved`, `confidence` |
| reviewing | `verdict: str`, `confidence: str`, `prefilter: dict`, `dimensions: list`, `flagged: list`, `matched_sources: list`, `fixes: list` | `drawer_id`, `notes`, `needs_clarification`, `clarifying_questions` |

`reviewing` is **evidence-gated**: the engine rejects a verdict without a
non-empty `prefilter` artifact and per-dimension `dimensions` scoring, and any
flagged dimension must name both a fix and its matched source(s)
(`conditional_evidence`). The gather fail-safe is enforced at aggregation: a
non-`unknown` license with no evidence snippet is downgraded to `unknown`
(⇒ restricted); a bucket with no marker defaults to `""`.

## Constraints contract

| Key | Required | Meaning |
|-----|----------|---------|
| `content` | **yes** | Path to the authored content under review (the human-authored source, not a build artifact) |
| `sources` | **yes** | The corpus: a **directory** of source texts (⇒ `gathering` inventories it) or a `manifest.json` **file** of `{id, path\|url, origin, license, bucket, role?}` entries (⇒ fast path). Optional `role` is `learn-from` \| `coverage-reference`; a clean-room rebuild's coverage-reference source MUST be present or the review returns `UNCERTAIN` (no vacuous pass) |
| `skeleton` | no | Concept skeleton / author brief (the idea layer) |
| `provenance` | no | Author's declared per-section sources |
| `gather_workdir` | no | Where gather writes its `manifest.json` (default `{tempdir}/derivation-{session_id}/`, `0o700`; never inside `sources`) |
| `max_fan_width` | no | Max echo branches per gather round (default 8) |
| `skill_dir` | no | Absolute skill path (auto-resolved otherwise) |

## Mempalace

Room `skills/derivation-{session_id}` (penny-wing convention). Drawers: one
consolidated `<session_id> Gather Provenance` (when gather ran; best-effort,
non-fatal) and annie's full review (D1–D7 analysis, prefilter report,
matched-source annotations with license consequence, fixes). The engine records
the terminal outcome into `penny/outcomes` automatically.

## Per-state prompts

`skill_context()` maps states to `assets/prompts/`: `echo.md` (gathering),
`annie.md` (reviewing).

## Scripts

- `scripts/prefilter.py` — Tier-1 deterministic verbatim/n-gram pre-filter
  (`--content … --sources …`; a clean report does NOT imply independence).
- `scripts/outline.py` — headings-only structural outline extractor used by
  gather branches.
- `scripts/orchestrate.py` — the thin delegate to `orchestration.cli`.
