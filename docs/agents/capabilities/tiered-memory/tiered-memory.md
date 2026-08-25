# Tiered Memory — Operational capability

## Runtime ownership

The unmarked primary runtime alone exposes durable-memory tools. Worker and
skill-driver processes expose none. Active workflow handoff uses immutable
owner artifacts, and orchestration state uses the checkpointer.

## Tiers

| Tier | Content                                   | Retrieval                        |
| ---- | ----------------------------------------- | -------------------------------- |
| T0   | Stable frame/identity                     | Always present.                  |
| T1   | Conversation + compact run state/refs     | Current context/checkpointer.    |
| T2   | Primary diary and warm classified data    | Bounded relevant primary recall. |
| T3   | Curated durable knowledge and temporal KG | Explicit primary recall.         |
| T4   | Cold archive / legacy corpus              | Manual offline recovery only.    |

## Operational rules

- Search only when prior context could materially affect the task.
- Start with bounded summaries; use exact IDs and `next_range` only when needed.
- Curate stable reusable results; skip routine/transient output.
- Rely on write-path duplicate enforcement rather than a routine duplicate precheck.
- Write the primary diary only from the primary runtime.
- Add KG facts only when future traversal/invalidation value justifies them.
- Treat old skill rooms as legacy corpus, never active handoff or deletion authority.
- Use one authenticated supervised MemPalace 3.7.1 HTTP hub; no production/admin raw fallback.
- Keep the optional advisory logstream default-off and primary-only. It is bounded, strictly self-addressed append/list/wait/ack and rejects raw upstream broadcasts. Dedicated artifact/patch endpoints and refs are absent; free-form advisory body text is non-authoritative by policy and is never consumed as artifact handoff, workflow state, a persistence receipt, or recovery input.
- Keep generic `platform-memory` logstream denial and worker memory/tool scrubbing unchanged.
- Keep uninstall data-preserving.

## Verification

- [ ] No retrieved memory appears in worker directives.
- [ ] No worker memory/logstream tool or lifecycle hook exists.
- [ ] Artifact continuation is complete and exact for workflow inputs.
- [ ] Advisory list/wait enforces requested filters, anchor exclusion, unique IDs, and strict positive sequence order.
- [ ] Advisory ack proves configured stream/principal/correlation under bounded reads.
- [ ] Retention apply is reviewed, manifest-bound, archive-first, and journaled.
- [ ] Offline byte access is receipt-bound to a copied target.

## Files

| File                                        | Purpose                     |
| ------------------------------------------- | --------------------------- |
| `docs/agents/architecture/tiered-memory.md` | Full architecture           |
| `docs/agents/memory/integration.md`         | HTTP and primary policy     |
| `docs/agents/memory/schema.md`              | Retention and legacy corpus |
