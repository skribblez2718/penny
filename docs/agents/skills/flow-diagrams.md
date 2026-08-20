# Skill Flow Diagrams — TypeScript playbook mirror

## Standard

Every engine-backed skill ships a self-contained `.pi/skills/<skill>/resources/flow.html`.
It embeds machine-readable nodes and edges and contains no external scripts, styles, or
network dependencies.

The TypeScript playbook exports a `*_FLOW` descriptor. The diagram and descriptor are
compared bidirectionally by `apps/orchestration/tests/flow-diagrams.test.ts`; missing or
invented states/edges fail.

## Requirements

1. One HTML diagram per skill.
2. One node per state/control boundary and one object per drawn edge.
3. Agent-state nodes name the assigned agent and prompt.
4. Gates identify host-only decisions and all approve/refine/deny routes.
5. Repairs identify their feedback kind and bounded budget.
6. Terminals distinguish positive, incomplete, cancelled, and error outcomes.
7. Uniform cancel/abort seams may be collapsed only when the omission is documented.
8. Update descriptor and diagram in the same change.
9. Do not retain a second Mermaid source.

KB’s diagram uses strict JSON `const N`/`const E` blocks. Research retains the earlier
regex-parseable JavaScript literal shape; both are read without executing diagram code.
New diagrams should use strict JSON.

## Verification

```bash
bun run --cwd apps/orchestration test -- tests/flow-diagrams.test.ts
python scripts/system/checks/check_skill_structure.py
```

## Files

| File                                             | Purpose                               |
| ------------------------------------------------ | ------------------------------------- |
| `.pi/skills/<skill>/resources/flow.html`         | Self-contained visual reference       |
| `apps/orchestration/src/playbooks/<skill>.ts`    | Playbook and exported flow descriptor |
| `apps/orchestration/tests/flow-diagrams.test.ts` | Bidirectional drift guard             |
