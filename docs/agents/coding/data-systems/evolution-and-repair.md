# Schema Evolution and Derived-State Repair

## Applies when

Designing, changing, reviewing or diagnosing schemas, encodings, stored records, messages, API payloads, enums/status meanings, rolling compatibility, propagation, projection rebuilds or migration/repair procedures.

## Compatibility includes old data and in-flight work

Identify old/new readers, old/new writers, stored data, queued messages and versions that can coexist. Define backward and forward compatibility separately. Adding a field may be harmless to one reader and rejected by another; changing defaults, removing an enum case or reusing a field with new meaning can silently change behavior.

Assess an encoding through the readers and writers that must exchange it. Inspect schema enforcement, unknown-field behavior, defaults, type changes, inspectability, size and language independence using the actual format and library versions. A compact schema-based format and an inspectable textual format can have different migration costs; neither label establishes compatibility. Language-specific object serialization can couple durable data to one implementation and introduce security hazards. A serializer change is not merely internal when its bytes or interpretation cross a public or persisted boundary.

Use an expand/migrate/contract transition when mixed versions require it: establish a compatible representation, move the readers/writers and data, verify use, then retire the old form when safe. This is a conditional migration technique, not a required ritual for every private field rename. Test the actual format and consumer behavior. Keep network latency, failure and version skew explicit even when an RPC tool presents a local-looking API.

## Rebuild without inventing a second truth

Name the authoritative input, derivation version, progress/checkpoint and comparison used to judge a repair. Establish that inputs and history survive long enough to rebuild; an expired source log cannot recreate missing history by intention alone. Choose an incremental repair, resynchronization or full rebuild according to correctness and operational cost.

Bootstrap and catch-up need one coherent boundary between a source snapshot and subsequent changes. Identify its log position/version, avoid a gap or double application, preserve required ordering and handle writes arriving during reconstruction. Before cutover, check that the new representation is caught up enough for its promised freshness. Keep old/new routing and interruption recovery explicit.

For denormalized copies, caches, indexes and search/read models, expose propagation lag and failures. Prevent independently writable copies from becoming conflicting authorities during dual-write migration. Change-data capture can reliably expose committed changes only under its actual source/retention contract; it does not automatically make downstream effects atomic or exactly once.

## Operational boundaries

Keep repair tools inspectable, restartable or idempotent where needed, with progress and safe stop behavior. Read [Runtime Lifecycle](../reliability/runtime-lifecycle.md) when operational automation or startup is involved and [Deployment Conventions](../deployment-conventions.md) for deployed migration/release work. Guidance does not authorize running a migration, destructive repair or production test.

## Verification

Test the relevant old/new reader-writer combinations with stored and in-flight examples, including defaults, unknown fields/cases and errors. Interrupt migration/rebuild, restart it and compare the derived result with the authoritative input. Check retention expiry, snapshot/change-log handoff, late updates, catch-up and cutover. Report irrecoverable historical data or missing compatibility evidence instead of calling the path rebuildable or rollback-safe.
