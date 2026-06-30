# Tiered Memory: Managing What Penny Remembers

## What It Is

Penny's memory is split into five tiers. Each tier has a different lifetime, a different priority for being loaded into the model's context, and a different cost to keep around. The tiers exist because not everything Penny has ever learned should be recalled at every moment.

## The Five Tiers

| Tier | Content | Lifetime | How It Reaches Penny |
| --- | --- | --- | --- |
| **T0: Identity** | `SYSTEM.md` — who Penny is and how she thinks | Permanent | Always injected |
| **T1: Active** | Current session data, state machine state, active task | Hours | Built during the session |
| **T2: Working** | Recent outcomes, diary entries, pending signals | 7–30 days | Pre-turn smart search |
| **T3: Reference** | Architecture docs, decisions, knowledge graph facts | Permanent | Fetched on demand |
| **T4: Archive** | Old sessions, expired outcomes, past versions | 90+ days | Search only, never injected |

T0 is identity. T1 is now. T2 is recent context that might matter today. T3 is long-term knowledge you look up when you need it. T4 is deep storage.

## Why Tiering Matters

A language model has a finite context window. If everything Penny has ever seen were injected every turn, there would be no room for the actual task. Worse, low-signal old information would drown out high-signal recent information.

Tiering solves this by ranking information:

- Identity and current session are always present because they define who is acting and what is happening now.
- Recent working memory is searched before each turn, but only the most relevant results are injected.
- Reference material is loaded only when explicitly needed.
- Archives are searchable but never automatically recalled.

This design also makes forgetting explicit and intentional. Some information naturally ages out unless someone decides it is important enough to keep.

## How the Distillation Pipeline Works

Memories do not sit in one tier forever. They move through a pipeline as they age:

| Transition | Trigger | What Happens |
| --- | --- | --- |
| **T1 → T2** | Session ends | The session is summarized into a diary entry and outcome records |
| **T2 → T3** | About 30 days pass, or a durable pattern is detected | Working memory ages out of pre-turn injection and is distilled into reference facts |
| **T3 → T4** | About 90 days pass, or the material is explicitly superseded | Reference material moves to archive rooms |

The pipeline means that something said today does not stay in Penny's working memory forever. It either gets distilled into durable knowledge or it fades.

## What This Means for Users

- Penny remembers the current conversation automatically.
- Penny recalls recent experiences before each turn if they seem relevant.
- Penny does not automatically remember everything from months ago. If something needs to persist, it should be stored explicitly in mempalace, preferably as a decision, architecture note, or knowledge graph fact.
- Old sessions are not lost, but they require explicit search to surface.
- If you want a preference, a decision, or a pattern to stick, ask Penny to write it to a T3 room rather than assuming it will be remembered from chat alone.

## Related Documents

- Agent docs: `docs/agents/architecture/tiered-memory.md`
- Human capability guide: `docs/humans/capabilities/tiered-memory/tiered-memory.md`
- Design document: `plans/ai-gaps-resolution/02-designs/09-tiered-memory.md`
