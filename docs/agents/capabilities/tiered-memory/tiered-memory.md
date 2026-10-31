# Tiered Memory — Operational capability

## Runtime ownership

The unmarked primary runtime owns every memory write and lifecycle hook. Catalog workers may receive owner-granted, YAML-declared bounded read-only recall/KG, never writes, advisory logs, or lifecycle hooks. Skill drivers expose no memory tools. Immutable owner artifacts carry workflow handoff; the checkpointer owns run state.

## Ownership and lookup scope

[Architecture](../../architecture/tiered-memory.md) owns tier/custody definitions; read it for architecture or lifecycle changes. For HTTP, role, automatic-retention, or continuation implementation work, read [Integration](../../memory/integration.md); for archival/legacy planning or apply, read [Retention](../../memory/schema.md). Simple recall needs no additional memory guide.

## Operational rules

- Search only when prior context could materially affect the task.
- Start with bounded summaries; fetch exact IDs only when needed. Continue memory reads with returned `continuation.cursor` as `cursor` until `truncated: false`; `continuation.next_range` is informational, not a memory input. Preserve exact UTF-8 reassembly and source digest/revision; expired, changed, stale, evicted, malformed, wrong-caller/query cursors fail with typed errors. Continuation never replays writes.
- [Invocation](../../agents/invocation.md) owns artifact handoff: `artifact_read` uses explicit non-expiring byte ranges, unlike memory cursors. Memory is never handoff, checkpoint, or recovery authority.
- Curate stable reusable results; skip routine/transient output.
- Rely on write-path duplicate enforcement rather than a routine duplicate precheck.
- Write the primary diary only from the primary runtime. Automatic retention is separately default-off; retain requires the ordinary write gate plus exact source/provenance admission, not a model safety claim. See integration when changing or diagnosing that lifecycle. No persisted candidate restores authorization after restart; never blindly replay an ambiguous write.
- Add KG facts only when future traversal/invalidation value justifies them.
- Treat old skill rooms as legacy corpus, never active handoff or deletion authority.
- Use one authenticated supervised MemPalace 3.7.1 HTTP hub; no production/admin raw fallback.
- Keep the optional advisory logstream default-off and primary-only. It is bounded, strictly self-addressed append/list/wait/ack and rejects raw upstream broadcasts. Dedicated artifact/patch endpoints and refs are absent; free-form advisory body text is non-authoritative by policy and is never consumed as artifact handoff, workflow state, a persistence receipt, or recovery input.
- Keep generic `platform-memory` logstream denial; worker access remains the exact read-only bundle with no writes or lifecycle hooks.
- Keep uninstall data-preserving.

## Verification

- [ ] No retrieved memory appears in worker directives.
- [ ] Advisory list/wait enforces requested filters, anchor exclusion, unique IDs, and strict positive sequence order.
- [ ] Advisory ack proves configured stream/principal/correlation under bounded reads.
- [ ] Retention apply is reviewed, manifest-bound, archive-first, and journaled.
- [ ] Offline byte access is receipt-bound to a copied target.
