# Knowledge Base Skill

Private, advisory knowledge-base workflows backed by the TypeScript orchestration engine.
The public `knowledge_base` tool supports status, ingest, query, save, lint, promote
preparation, and host-gated publication paths. Child agents advise; only host code holds
capabilities, policy, durable records, generation selectors, and apply authority.

## Authority

- Source/page bodies remain in the private content plane.
- Orchestration checkpoints carry metadata and exact refs, never private bodies.
- Ingest and save stop at a human review gate before publication.
- Promotion preparation produces plan, patch, and host-verification artifacts but cannot apply.
- Canonical-target mutation requires the separately authorized signed host apply path.
- Memory is neither workflow transport nor publication proof.

## Agent states

| State     | Agent    | Purpose                                            |
| --------- | -------- | -------------------------------------------------- |
| `ingest`  | Echo     | Extract evidence from owner-admitted sources       |
| `compose` | Synthia  | Build candidate pages from exact admitted material |
| `lint`    | Carren   | Critique page quality and actionable defects       |
| `verify`  | Vera     | Verify support and contract compliance             |
| `plan`    | Piper    | Plan a bounded promotion transition                |
| `patch`   | Skribble | Scope the advisory patch; never apply it           |

The machine and `resources/flow.html` are bidirectionally drift-tested. Prompts use the
shared `<agent>-<state>.md` convention.

## References

- `resources/reference.md`
- `resources/flow.html`
- `docs/agents/knowledge-base/`
- `apps/orchestration/src/playbooks/knowledge-base.ts`
- `apps/orchestration/src/kb/`
