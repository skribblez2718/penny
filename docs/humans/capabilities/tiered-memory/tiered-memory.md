# Tiered Memory

## What It Is

Penny's memory is organized into five tiers, each with different lifetime, size, and injection rules. This ensures the right information is available at the right time without flooding context.

## The Five Tiers

| Tier              | Content                                                    | Lifetime  | How It Reaches Penny      |
| ----------------- | ---------------------------------------------------------- | --------- | ------------------------- |
| **T0: Identity**  | `SYSTEM.md` — who Penny is, how she thinks                 | Permanent | Always injected           |
| **T1: Active**    | Current session data, FSM state, active task               | Hours     | Built during the session  |
| **T2: Working**   | Recent outcomes, diary, pending signals, last 5-10 actions | 7-30 days | Pre-turn smart search     |
| **T3: Reference** | Architecture docs, decisions, KG facts                     | Permanent | RAG on demand (AGENTS.md) |
| **T4: Archive**   | Old sessions, expired outcomes, past versions              | 90+ days  | Search only, not injected |

## How It Works

- **T0** is your cognitive identity — always there, defines how you think
- **T1** is the current conversation — what you're doing right now
- **T2** is your short-term memory — recent experiences that inform this conversation
- **T3** is your long-term knowledge — things you can look up when needed
- **T4** is deep storage — accessible via search when relevant, never automatic

## Current Status

| Tier | Status                                                     |
| ---- | ---------------------------------------------------------- |
| T0   | ✅ Static (self-update pipeline designed but not active)   |
| T1   | ✅ Automatic via session state                             |
| T2   | ✅ Pre-turn injection via `memory_smart_search`            |
| T3   | ✅ AGENTS.md hierarchy + KG                                |
| T4   | ✅ Archival via `scripts/system/tiered_memory/archiver.py` |

T3→T4 archival runs age-based sweeps: signals expire at 7 days, outcomes at 30 days, diary at 90 days, permanent T3 items never archive.

## Learn More

- Architecture: `docs/agents/architecture/tiered-memory.md`
- Design: `plans/ai-gaps-resolution/02-designs/09-tiered-memory.md`
- Self-update: `docs/agents/self-improving-guidance.md` (Step 7)
