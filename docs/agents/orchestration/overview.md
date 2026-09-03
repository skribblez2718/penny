# Orchestration Package — TypeScript execution engine

## What

`apps/orchestration` is Penny’s sole workflow runtime. It provides a registry of
`PlaybookCoreV1` implementations, closed request/directive and `SkillContractV2` contracts,
durable Node SQLite checkpoints, exact artifacts, signed worker receipts, recovery, gates,
owner-resolved research context, and observability.

The skill extension discovers every package once from `.pi/skills`, classifies it by parsed release
status, requires exact production/candidate registry agreement, and constructs
`OrchestrationService` in-process for single, parallel, chain, and resume modes. Skill packages
contain manifests, prompts, and resources—never executable delegates. Directory location grants no
lifecycle status. Model visibility is orthogonal: only parsed `disable-model-invocation: true` hides a
valid package, while candidate execution remains exact-digest host-gated outside
`PLAYBOOK_REGISTRY`.

## Components

| Module                        | Role                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `engine.ts`                   | Closed request handling, playbook dispatch, transitions, receipts, gates, recovery                   |
| `service.ts`                  | Engine/checkpointer/artifact/worker composition                                                      |
| `checkpointer.ts`             | Owner-only Node SQLite state keyed by exact `run_id`; canonical content-review packet/receipt rows   |
| `artifact-store.ts`           | Immutable manifest and content-addressed exact-byte objects                                          |
| `worker.ts`                   | Active-registration checks, bounded Pi SDK execution, capture, fan-out, signed receipts              |
| `model-client.ts`             | Registration guidance, agent SSOT models, YAML maxima, strict-subset validation, and active equality |
| `playbooks/registry.ts`       | Fail-closed playbook, worker-phase, repair-route, and completion construction                        |
| `playbooks/research.ts`       | Research cognitive graph, host sealing/rendering, latest-core product graph and DoD                  |
| `playbooks/knowledge-base.ts` | Knowledge-base machine and host-only gates                                                           |
| `observability.ts`            | Best-effort metadata/digest events                                                                   |

## Rules

1. The request vocabulary is `start`, `step`, `status`, `recover`, `respond`, and `cancel`.
2. Every cognitive directive carries exact input refs and output metadata.
3. The owner persists complete worker bytes and signs a receipt before routing.
4. `RunContext` stores refs, never payload bytes.
5. Playbooks classify structurally valid domain gaps and may update domain bookkeeping only.
   `EvaluationResultV2` cannot select a target or claim exhaustion. The engine resolves the unique
   registered state/kind route, charges its budget, guards control fields, transitions, and records
   body-free route digests in the existing checkpoint event transaction.
6. Structural malformed results remain isolated on the P1.2 routing-repair/liveness path.
   Playbook `repair_routing` declarations cannot claim `malformed_result`.
7. The engine alone admits positive terminals through the registration's closed `CompletionGate`
   v2 and host-owned receipt predicates. A rejected positive candidate becomes durable
   `incomplete/met:false` with its best
   artifacts preserved. Negative terminals pass through without gate evaluation.
8. Recovery is exact-run and forward-only. It never scans semantic memory.
9. Compaction reads only caller-supplied run IDs from the catalog-bound unversioned orchestration database.
10. `PENNY_ARTIFACT_DISPATCH_MODE=paused` preserves pending state and blocks new dispatch.
11. Unknown playbooks, predicates, requests, trust profiles, contract fields, routes, and dispatch modes fail closed.
12. The exact active registration reaches engine, service, worker, and catalog/private model paths.
    Missing guidance and state/agent mismatches refuse before session work.
13. A catalog worker's YAML is its maximum ordinary authority. Direct/parallel/chain paths
    and orchestration phases without `allowed_tools` request and activate YAML exactly. An
    eligible catalog phase may use only one explicit non-empty duplicate-free strict YAML subset
    held by the active `PlaybookRegistrationV1`; the canonical runtime-registration digest and
    worker invocation metadata include it. The model client validates strict YAML membership
    before session creation, passes the list exactly to Pi, and checks active equality before the
    model prompt. Task, trust profile, input, runtime condition, model/liveness policy, typed
    product, context metadata, and optional-service state cannot select or alter tools.
14. A phase subset does not mutate agent YAML/profiles and creates no OS/process sandbox or
    extension-code isolation. Anonymous host-private matrices remain separate and unchanged.
15. New research starts canonicalize `ResearchRequestV1` and validate typed imported semantic-core bytes before run mutation or model/session work.
16. Research context persists metadata-only `ContextSourceRefV1` artifacts; worker owner code re-resolves selected content and fails stale, drifted, unapproved, conflicting, unrelated, or unavailable sources before model use.
17. P3 research returns/forwards the latest canonical `GroundedSynthesisV1` semantic-core ID. Synthia's closed `ResearchSemanticDraftV1` is deterministically projected and sealed by the host before Vera; every changed core re-enters Vera before optional report Carren. Host rendering persists latest-core receipts/renders/envelope and admits success only through the research DoD from `rendering`.

## Composition

Parallel skill invocations create independent TypeScript runs. Chain composition verifies
and forwards the prior terminal artifact ID directly across runs. For research positives this is the
semantic-core ID, never the research product envelope, a render, receipt, or Synthia semantic-draft artifact. The next entry state may
also receive additional explicit fan-in IDs; `{previous}` is never payload transport.
Durable chain checkpoints retain exact terminal/handoff refs across restart.

## Persistence

- State root: `${PENNY_STATE_ROOT:-<Pi getAgentDir()>/penny}`; Pi relocation follows `PI_CODING_AGENT_DIR`.
- Database: `projects/<opaque-project-id>/orchestration/orchestration.db`. It uses WAL, `synchronous=FULL`, bounded busy timeout, project metadata, and co-locates ingest/save content-review packets and receipts with their runs/gates.
- Receipt key: the same partition's `orchestration/receipt-key`; exact key bytes must survive migration.
- Artifacts: the same partition's `artifacts/manifest.db` plus content-addressed objects.
- Chains and subagent sessions: the same project partition, with project-bound checkpoints and durable Pi JSONL. The existing terminal-run cap retains newest run cohorts (500 by default) with all correlated current-format worker sessions; after committed run eviction, ordinary runtime removes only owner-only, no-follow-validated JSONL whose exact metadata reconciles to an absent run. Custody-blocked and nonterminal runs keep their sessions.
- Retired selectors and roots are rejected; ordinary runtime performs no scan, import, or fallback outside that caller-supplied session partition.
- The existing append-only `events` payload carries body-free state-visit and
  admission/refusal metadata. Research host progress also uses selected immutable refs and bounded
  body-free events; no host-progress field/table is added. Admission binds the terminal digest, gate digest, latest
  product, exact visit refs, and indexed evidence refs in the same checkpoint transaction.
  This adds no table, migration, selector, state path, or observability dependency.
- Exact pre-v2 positive terminals remain replayable as legacy truth. A post-v2 envelope is
  verified on `status`/`recover`; corrupt evidence fails closed and is never regenerated.

## Verification

- [ ] Direct/parallel/chain source guards and real-session tests prove exact YAML equality.
- [ ] Orchestration proves subset-absent YAML equality—including ordinary candidate phases—plus
      canonical registration-digest and invocation-metadata binding, exact Pi handoff, synthetic or
      evaluation-only strict subsets, and invalid-subset refusal before session creation.
- [ ] Native and Penny model listings plus `.pi/skills/.ignore` follow only the parsed disable flag,
      independently of release namespace.
- [ ] Candidate docs avoid OS/process sandbox and extension-code-isolation claims; host-private
      isolated tools remain separate.

```bash
bun run --cwd apps/orchestration build
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/compaction test:unit
```
