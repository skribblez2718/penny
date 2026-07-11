# MemPalace Room Schema & Retention

The canonical structure for MemPalace wings/rooms and how each is retained. This
is what keeps memory **signal, not accretion** — every drawer has a home and a
lifecycle, and new skills inherit both automatically.

## Room conventions

| Class | Wing / room | Who writes it |
|-------|-------------|---------------|
| **Lightweight skill scratch** | `penny` / `skills/<skill>-<session_id>` | agent, code, learn, plan, prd, research, rez — each agent writes its phase output here |
| **Dedicated-wing skill scratch** | `wing_<skill>` / `<session_id>-<phase>` (e.g. `wing_jsa/plan-<ts>-findings`) | security skills (jsa, sca) that isolate untrusted target-scan data from general memory |
| **Curated knowledge** | `<skill>-learnings`, `decisions`, `architecture`, `bug_bounty_methodology`, … | distilled, cross-session knowledge that must survive the scratch sweep |
| **System / operational** | `penny/` `outcomes`, `diary`, `signals`, `digests`, `system_amendments`, `compactions` | the flywheel, watchers, digest, compaction |

**Rule of thumb:** per-session run output is **scratch** (decays); anything meant
to inform a *future* session is **curated** (persists) and lives in a stable,
non-session-prefixed room.

## Retention (tiers)

Retention is **opt-in per room** — an unclassified room is KEPT by default, so a
new or mislabelled room is never silently mass-archived.

| Tier | Meaning | TTL |
|------|---------|-----|
| **T2** | warm scratch — decays, recall-extended up to 4× | 30d (`signals` 7d, `diary` 90d, `compactions` 90d) |
| **T3** | curated / permanent | −1 (never) |
| **T4** | cold archive — aged-out drawers written to grep-able JSONL under `.mempalace/archive/` **before** deletion (never lost) | — |

Policy lives in `scripts/system/tiered_memory/archiver.py`:

- Base rules (hardcoded): `penny/skills/` and `penny/plan-` → T2 30d; the system
  rooms above; the permanent `penny/{decisions,architecture,digests,skills}`.
- Per-skill rules (**loaded from the manifest**, see below): each dedicated-wing
  skill's scratch prefixes → T2, its curated rooms → T3.

The archiver runs nightly via `scripts/system/watchers/ambient_cron.sh`.

## Single source of truth: `skill_rooms.json`

`scripts/system/tiered_memory/skill_rooms.json` is the **one** place a skill's
memory footprint is declared. Three consumers read it, so they can never drift:

1. **`archiver.py`** loads it and applies each dedicated-wing skill's decay +
   curated-keep rules (penny-wing skills need nothing — the `penny/skills/` base
   rule covers them).
2. **`scripts/tools/scaffold-skill.py`** appends an entry (`convention: penny-wing`)
   for every new scaffolded skill, so its scratch decays from day one.
3. **`scripts/system/checks/check_skill_structure.py`** fails if a live skill is
   missing from the manifest — the guard that stops a new dedicated-wing skill
   silently re-creating the `wing_jsa` accretion.

**Adding a dedicated-wing skill:** change its manifest entry to
`convention: dedicated-wing` and declare `wing`, `scratch_prefixes` (room-name
prefixes under that wing that are transient — `""` means "all rooms"),
`curated_rooms` (kept permanent), and `ttl_days`.

## One-time cleanup tooling

For reclaiming accreted bulk that decay alone won't clear promptly:

- `scripts/system/maintenance/mempalace_audit.py` — **read-only** inventory +
  categorized candidate manifest (test artifacts, dead-name references,
  oversized transcripts, transient scratch).
- `scripts/system/maintenance/mempalace_cleanup.py` — **dry-run by default**;
  `--execute` cold-archives then deletes. Categorization is imported from the
  audit so the two never disagree.

Always back up (`cp -r .mempalace .mempalace.bak.<date>`) before `--execute`.
