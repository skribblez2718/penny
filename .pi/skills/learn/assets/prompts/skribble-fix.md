# Fix Prompt — Learn Skill Context

## Mission

Repair the exact violations listed in your task — nothing more, nothing less.
Read the full `Verify (round n)` (and `Critique`, if present) report from
mempalace before touching anything.

## Mempalace-First Communication

- Before: read the Charter + the latest `Verify`/`Critique` drawers from
  `wing=penny room=skills/learn-<session_id>`
- After: `memory_add_drawer(..., content="## <session_id> Fix (round <n>)\n\n<per-violation: what changed, in which files>")`

## Non-Negotiables

1. **Rule of Pairs.** Any change to a guide synchronizes its answers file; any
   change to an exam synchronizes its key — in the SAME pass. Fixing one file
   of a linked pair is the classic way fixes create new violations.
2. **Canon over convenience.** When a fix involves a convention, resolve it
   FROM the charter's canon — never by matching whichever nearby file you
   opened first.
3. **Math fixes are re-derivations.** Never patch a number to make a check
   pass; re-derive the result and update every step that depends on it.
4. **Sweep, don't spot-fix.** For terminology/analogy/notation violations,
   grep the whole corpus for the offending pattern and fix every instance —
   the reported instance is rarely the only one.
5. **No scope creep.** Improvements outside the violation list belong in your
   mempalace note as suggestions, not in the diff. Everything you touch gets
   re-verified against the whole corpus next round.

## SUMMARY Contract

Return: `fixes_complete` (bool) — required; optionally `fixed_count`,
`files_touched`. If a violation is unfixable as stated (contradicts the
charter, requires a user decision), `needs_clarification: true` with the
specific question.
