# Compaction Resume Protocol

Execute this protocol once when a compaction summary containing a `[RESUME-REFS v2]` block appears in your context. The summary is your memory of the compacted stretch of this session: a prose brief for orientation, followed by a pointer appendix into durable memory. Nothing was lost — anything not carried in the prose is dereferenceable through the refs.

Once processed, do not re-execute in this session.

## 1. Detection

The compaction summary is prose markdown (`## Goal`, `## Active Skill`, `## Current Work`, `## In-Flight Orchestration Runs`, `## Pending`, `## Next Steps`, ...) ending in:

```
[RESUME-REFS v2]
run: run_id=<id> playbook=<name> state=<state> status=<status> resume=skill(skill_name="<name>", resumeFrom="<session_id>")
room: <wing>/<room> drawers=<id,id,...>
decision: <drawer_id> (<confidence>) <summary>
kg: <entity_id> [<predicates>]
tool-ok: <tool> <verbatim params JSON>
tool-fix: <tool> failed=<params> error="<message>" fixed=<params>
[/RESUME-REFS]
```

Every line is a real, dereferenceable address. Placeholder IDs are never rendered.

## 2. Reorient from the Prose

Read the brief top to bottom: the goal, the active skill, current work, any in-flight orchestration runs, pending questions to the user, next steps, constraints, key decisions, unresolved errors, and touched files. This is enough to continue most work without any retrieval.

- **`## Goal` is the LATEST substantive intent, not the first-seen one.** The extractor scans newest-first with no keyword denylist, merges the split-turn window, and carries the prior goal forward only when the current window has nothing fresher. Trust it as the current objective.
- **`## Active Skill` may be flagged `superseded by a newer request`.** That means a completed skill's goal was displaced by a later ad-hoc user message; the skill is shown for provenance, but `## Goal` (the newer request) is what you act on.
- **`## Current Work` / `## Next Steps`** (when present) summarize what was in flight and the concrete next actions. A `Focus (from /compact): …` next step echoes the user's `/compact <focus>` hint — treat it as the priority.

## 3. Resume In-Flight Runs

`run:` lines come from the orchestration engine's durable run_id checkpointer — they are exact, not inferred.

- `status=awaiting_user` — the run is blocked on the user. An `awaiting-user:` line carries the open question; re-present it if it is still unanswered, then resume with the `resume=skill(...)` call given on the line.
- `status=running` — the run was mid-step when compaction hit. Resume it with the `resume=skill(...)` call; the engine rehydrates from its checkpoint and re-issues the pending step.

Never reconstruct run state from memory searches — the checkpointer already holds it.

## 4. Dereference on Demand

When you need detail the prose didn't carry:

- `room:` → `memory_smart_search(query=<topic>, room=<room>)` or read the listed drawers directly. Rooms marked `(active session)` belong to in-flight work.
- `decision:` → the outcome-ledger drawer holding the full decision record.
- `kg:` → `memory_kg_query(entity)` or `memory_kg_timeline(entity)`.
- `tool-ok:` / `tool-fix:` → verbatim tool-call examples from before compaction. Follow the `tool-ok` shapes; avoid repeating the `tool-fix` failures.

Do not bulk-prefetch. Dereference a pointer when the work actually needs it.

## 5. Handle Pending State

If the `## Pending` section is present, an escalation was active at compaction time. Read the reason, check whether a `run:` line with `status=awaiting_user` covers the same question (prefer the engine's version — it is authoritative), and re-present to the user if still open.

## 6. Budget Awareness

- The summary is built under a hard token budget with priority-based eviction. If something seems missing, it was demoted from "carried" to "addressable" — check the refs before concluding data doesn't exist.
- A `[summary truncated to fit compaction budget]` marker means the tail (file lists, tool examples) was cut; goal, runs, and pending state always survive at the top.
