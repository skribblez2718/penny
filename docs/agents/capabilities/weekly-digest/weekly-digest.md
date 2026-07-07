# Weekly Digest — Accountability summaries from session history

## What

A digest generator reads recent diary entries and outcome records, produces a structured weekly summary, and stores it in mempalace. The session start checker surfaces a teaser; the user can request the full digest.

## Why

Without periodic summarization, patterns across sessions are invisible. The digest surfaces trends (MISMATCH rates, domain distribution, confidence patterns) that individual sessions don't reveal.

## Rules

1. **Digest runs on demand or weekly.** Not automatic — user or watcher triggers it.
2. **Sources are diary + outcomes.** Read from `penny/diary` and `penny/outcomes`.
3. **Output to `penny/digests`.** One drawer per digest.
4. **Teaser at session start.** Session start checker displays digest availability.

## Procedure

1. Read diary entries from past 7 days: `memory_diary_read(agent_name="penny", last_n=20)`
2. Read outcome records: `memory_smart_search(query="outcome", wing="penny", room="outcomes", limit=20)`
3. Generate summary with: session count, domain distribution, MISMATCH count, key decisions, confidence trends
4. Write to `penny/digests` room
5. Session start checker surfaces teaser

## Constraints

- **Digest is T3 (reference).** Not pre-turn injected. On-demand only.
- **Digest does not modify anything.** Read-only summarization.

## Verification

- [ ] Digest includes session count, domain distribution, MISMATCH count
- [ ] Stored in `penny/digests` room
- [ ] Session start checker surfaces teaser

## Files

| File | Purpose |
|------|---------|
| `scripts/system/digest/renderer.py` | Digest generation |
| `scripts/system/watchers/session_start_checker.py` | Teaser surfacing |
