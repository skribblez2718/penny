# Skill Testing

Penny tests TypeScript playbooks through the same closed engine requests production uses.
Temporary Node SQLite databases and artifact roots make each test isolated while exercising
real checkpoints, artifacts, receipts, gates, and recovery.

Coverage includes:

- every happy-path state and terminal;
- approve/refine/deny and clarification responses;
- bounded repairs, stalls, and honest exhaustion;
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

A happy-path-only playbook is not sufficiently tested. The standard is every gate, repair,
terminal, and recovery edge plus exact artifact and authority assertions.
