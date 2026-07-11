# Echo Prompt — rez Fresh NIST NICE Lookup

## Mission

Perform a **live** NIST NICE Framework lookup for this run and produce the
alignment digest: current components version + the canonical Task/Knowledge/
Skill (TKS) verbiage for the work roles matching the target job. NICE concepts
and verbiage are the canonical truth for this skill.

## Mempalace-First Communication

Before starting:
- `memory_smart_search(query="<session_id> Gap Analysis", room="skills/rez-<session_id>", limit=3, include_full=true)` — the target role and JD keywords

After completing the lookup:
- `memory_add_drawer(wing="penny", room="skills/rez-<session_id>", content="## <session_id> NICE Alignment\n\n<alignment digest>")`

## Procedure

1. **Version check (always first):** `web_fetch`
   `https://www.nist.gov/itl/applied-cybersecurity/nice/nice-framework-resource-center/nice-framework-current-versions`
   Record the current NICE Framework Components version and release date
   exactly as published — verify, never assume.
2. **Work role selection:** from the gap analysis, identify the 1–3 NICE
   **Work Roles** (`XX-WRL-###`) that best match the target job.
3. **TKS retrieval:** fetch the current Task (`T####`), Knowledge (`K####`),
   and Skill (`S####`) statements for those work roles. Sources in order of
   preference:
   - Links on the Current Versions page (components JSON/XLSX, NIST CPRT).
   - The NICCS-hosted browsable framework (niccs.cisa.gov, linked from that
     page) — use playwright navigation if plain fetches are blocked.
   - Targeted `web_search`
     (e.g. `NICE Framework <work role> tasks knowledge skills site:niccs.cisa.gov`)
     followed by `web_fetch` of the matching page.
4. **Digest:** write version, work role names + IDs, relevant Competency
   Areas (`NF-COM-###`), and the exact TKS statement phrasing relevant to the
   JD to the mempalace room. Pull only the statements relevant to the JD —
   not the whole framework.

## Non-Negotiable Rules

1. **FRESH DATA ONLY** — never rely on cached, remembered, or bundled NICE
   data. If you cannot reach any live source, the lookup FAILED.
2. **Honest failure** — on failure return `nice_available: false` with the
   reason. Never substitute training-data knowledge of the framework for the
   live lookup.
3. **Verbatim verbiage** — TKS statements go into the digest exactly as
   published, with their IDs.

## SUMMARY Format

Return exactly:

```json
{
  "complete": true,
  "nice_available": true,
  "nice_version": "<e.g. 2.2.0 (2026-04-28)>",
  "work_roles": ["<ID> <name>", "..."],
  "confidence": "CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN"
}
```

On failure: `"nice_available": false` and put the reason in the mempalace
drawer (`## <session_id> NICE Alignment` with a `LOOKUP FAILED: <reason>` body).
