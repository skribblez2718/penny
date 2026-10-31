# Skill Testing

Penny tests TypeScript playbooks through the same closed engine requests production uses.
Temporary Node SQLite databases and artifact roots make each test isolated while exercising
real checkpoints, artifacts, receipts, gates, and recovery.

Coverage includes:

- every happy-path state and terminal;
- approve/refine/deny and clarification responses;
- operator-policy repair controls (including absent limits), stalls, and honest exhaustion;
- malformed results and wrong artifact identities;
- crash recovery and partial parallel recovery;
- exact owner capture before routing;
- single, parallel, chain, and chain resume;
- operation without durable memory.

Model behavior is deterministic in unit tests through fixture `ModelClient` implementations.
Live tests use a caller override and never change production agent frontmatter.

```bash
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
bun run --cwd .pi/extensions/skill test:unit
```

The [agent evidence matrix](../../agents/skills/testing.md#required-coverage) distinguishes reusable
shared-runtime checks from skill-specific routes, schemas, and consequences. Storage-only child
checks, active dispatch/gate/recovery/cohort checks, and live provider qualification are separate;
Gate 2 remains `not_run`. Existing assertions are not receipts that tests ran.

Loop-protection checks cover source-judgment preservation, verification-incomplete negatives,
actual pre-review evidence, exact recurrence across restart, and unmeasurable routes that
must not be labeled progress or stall. Source-mapped fixtures, matching compiled-package
tests and live-model qualification are separate evidence levels; none implies the next.

A happy-path-only playbook is not sufficiently tested. The standard is every gate, repair,
terminal, and recovery edge plus exact artifact and authority assertions.
