# Knowledge Base Skill

Private, advisory knowledge-base workflows backed by the TypeScript orchestration engine.
The public `knowledge_base` tool supports init, ingest, query, save, lint, promote
preparation, status, and resume. Child agents advise; only host code holds
capabilities, policy, durable records, generation selectors, and apply authority.

## Authority

- Profile-session and parent-delivery grants share the owner-only
  catalog-bound project `kb/host-grants/` WAL/FULL authority; unexpected legacy
  fragments fail closed instead of being scanned or adopted.
- Each model-visible call records an exact session/profile/invocation/request/policy grant use;
  parent delivery additionally binds provider/model and remains exact single-use.
- Source/page bodies remain in the private content plane.
- Orchestration checkpoints carry metadata and exact refs, never private bodies.
- Ingest and save stop at a human review gate before publication.
- The public promotion run produces plan, patch, and host-verification artifacts but cannot apply.
- Canonical-target mutation requires a strict-JCS, HMAC-SHA-256 signed, expiring, single-use receipt
  and the separately authenticated host apply path; apply journals, verifies, restores, or blocks.
- Memory is neither workflow transport nor publication proof.

## Agent states

| State     | Agent    | Purpose                                              |
| --------- | -------- | ---------------------------------------------------- |
| `ingest`  | Echo     | Extract evidence from owner-admitted sources         |
| `compose` | Synthia  | Build candidate pages from exact admitted material   |
| `query`   | Synthia  | Synthesize a cited answer from a bound candidate set |
| `lint`    | Carren   | Critique page quality and actionable defects         |
| `verify`  | Vera     | Verify page claims or every query-answer citation    |
| `plan`    | Piper    | Plan a bounded promotion transition                  |
| `patch`   | Skribble | Scope the advisory patch; never apply it             |

The public machine and `resources/flow.html` are bidirectionally drift-tested. Prompts use the
shared `<agent>-<state>.md` convention. Approval/apply is deliberately outside the public action
machine and is available only through `penny-kb-gate promotion-*` host commands.

## Order rules and prevented failure modes

| Order rule                                                                                               | Failure mode it prevents                                                                |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Resolve the host session/profile grant and validate root admission before any private read               | A model-selected, remapped, or unsafe root gaining read authority                       |
| Admit the current policy and exact parent/child model tuples before a private body read or child session | Private content reaching a denied provider or an already-created unauthorized session   |
| Preindex and snapshot source capabilities before Echo reads them                                         | A crash creating an unowned source file or refinement reopening changed external bytes  |
| Run deterministic lint before Carren semantic lint                                                       | Model critique treating malformed hashes, schemas, or references as valid evidence      |
| Run Vera verification after composition or query synthesis                                               | Unverified claims or citations becoming review, save-claim, or parent-delivery inputs   |
| Persist the complete content-review packet before exposing `awaiting_user`                               | A restart approving or re-presenting a different ingest/save candidate                  |
| Require content-review approval before selector replacement                                              | Advisory ingest/save output publishing without human authority                          |
| Prepare and host-verify promotion before the signed host-only apply path                                 | A public/model request mutating canonical targets or approval binding stale bytes       |
| Capture every target preimage before the first promotion mutation and re-verify after each write         | Partial apply becoming unrecoverable or being reported successful with wrong bytes/mode |
| Route every refine/repair back through lint and verification                                             | A correction bypassing the checks whose evidence authorized the prior candidate         |

## References

- `resources/reference.md`
- `resources/flow.html`
- `docs/agents/knowledge-base/`
- `apps/orchestration/src/playbooks/knowledge-base.ts`
- `apps/orchestration/src/kb/`

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `KB_FLOW`, validated
by the shared drift test and `bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill knowledge-base`.
It documents the omitted uniform cancellation seam while retaining the
host-only review and promotion-authority boundaries in the drawn topology.
