# Skill Orchestration

Penny has one TypeScript workflow engine. A registered playbook names states, happy routing,
gap classification, gates, and terminal candidates. Its active registration binds required
guidance, state/agent/result contracts, repair routes, and completion criteria. The engine owns
repair budgets/transitions, checkpoints, exact artifacts, receipts, workers, positive-terminal
admission, and recovery.

## One stage

1. The playbook selects exact predecessor refs.
2. The engine emits a closed worker directive.
3. The worker reads each needed exact ID through `next_range`.
4. The owner persists/re-reads complete output bytes and signs a receipt.
5. Only then may routing fields advance the checkpoint.
6. For a valid domain gap, the playbook returns a strategy-bearing classification without a
   target. The engine chooses the registered route and records digest-only evidence. Malformed
   routing output remains a separate policy-controlled correction path.

Parallel work uses branch IDs. Chain composition verifies and forwards the exact terminal
ID directly into the next run; `{previous}` never transports payload text.

## Use another skill's product as context

For the seven ordinary skills, pass existing exact product IDs in `context_artifacts` when
they inform the task without becoming binding native inputs. In a chain, set
`previous_artifact_designation: "context"` on the consumer—for example, Plan → Produce.
Explicit IDs can also combine products from several earlier runs. Parallel branches remain
independent; they do not discover each other's results automatically.

The host validates the original accepted product, preserves its exact ID and designation,
and supplies it to workers. It does not turn context into evidence, a specification revision,
verified source claims, permission or approval. Keep native requirements and strict assurance
in `input_artifacts` and the skill's own request. Recovery rejects changed refs/designations;
it never reconstructs a replacement. Correct delivery alone does not prove faithful model use.

## Active generic-child authority

The active registry records explicit runtime parent/provider authority for the seven ordinary
workflows: assess, decide, define, diagnose, plan, produce, and research. Each can target the same all-seven set
at depth one under fixed call and concurrency admission. Active policy deliberately does not guess
how many turns, tools, output bytes, steps, or seconds a child needs and has no aggregate budget or
parent reserve. Every provider binds its own native request/output contracts and fixed registered phase agent, result,
tool, and browser-network carriers. When a phase uses its YAML tool maximum, the registration stores
that exact snapshot and refuses later YAML drift. Missing or unknown workflows deny, and the
dedicated/private knowledge-base workflow is excluded.

This projection authorizes active depth-one child dispatch. Normal services construct the child
owner by default; a host can explicitly disable it. The owner drives a registered child through the
ordinary engine/runner, validates its terminal core, and atomically continues the parent. New calls
use the child's registered repair/liveness policy and any operator-supplied service-wide step limit plus one
content-free inactivity lease bound by the host. Fenced non-empty host-observed worker activity or workflow convergence renews one interval;
stale/empty signals refuse, activity does not manufacture convergence, and expiry stops the child.
Runner and concurrent parent cancellation are also forwarded. Workers do not execute child
directives directly. Parent-mediated child gates/replies, waiting/captured-terminal recovery and
linked control/gate/receipt/session retention are implemented under frozen bindings and
cancellation/selection fences. Arbitrary missing linkage is never reconstructed, and immutable
artifact bytes are preserved. Provider promotion/live qualification remain separate; Gate 2 stays
`not_run`, so execution alone is not qualification evidence. See
[current status](../state-management/state-management.md#current-child-workflow-status). Legacy fixed-time V1 records remain replayable but are not created for
new calls.

## Reviews and repairs

A repair author receives the exact sealed product under review, its draft and the relevant latest reviewer reports—even when a repair first passes through analysis or evidence gathering. Reviewers use earlier findings to check regressions, but must judge the new product again in that skill's review order. An old approval is not approval of a changed result. Derive values from actual operator policy, not test constants or model guesses. Seal corrections, semantic-review repairs and malformed routing correction have separate policies; honor actual operator limits when supplied, but do not infer one-/two-correction or cycle defaults. A successful seal closes the epoch, so a reviewer-requested replacement must not receive stale instructions. Cancellation, inactivity, measured errors and honest exhaustion still apply.

Each new sealed product and seal diagnostic has a separate, draft-addressed version-1 operation. Recovery reuses the exact persisted artifact; version 1 is **not** a run-global attempt number. On exhaustion, the skill tool exposes `seal_diagnostics` with the final diagnostic ID, rejected draft ID, epoch anchor and used/limit separately from semantic `repair_diagnostics` (feedback-report IDs and its own budget). A negative terminal may show a rejected draft or an earlier accepted best partial; it must not label the rejected draft a completed product. Read the exact diagnostic or reviewer report to see what failed. Historical terminals are not rewritten, and an incomplete result is sometimes the honest outcome.

### Preserve judgments and show checks before review

Opted-in routing correction preserves every field and the confidence of the exact source
SUMMARY. It cannot turn a refusal or unverifiable judgment into approval; an unpreservable
source stops incomplete. Produce keeps its stronger immutable review-core checks.

Before Vera runs, Assess, Decide, Define, Diagnose, Plan and Research put the host's actual
native check results in the signed task. Produce keeps its existing mechanical-checks
artifact. These checks cover the exact product's custody, structure and lineage within each
skill's scope—not semantic approval, proof of no effects, or post-review receipts.

When verification capability or trustworthy evidence is unavailable, `UNVERIFIABLE` ends
negative with `verification_incomplete`, retaining the product and report instead of sending
the author around again. A valid blocked, unresolved or partial domain product is a different
outcome and still follows its own completion rules. Unknown effects alone are not a defect.

### Produce reviews without reference copying

Produce's reviewers return their judgments, not copies of artifact IDs, hashes or metadata.
The host binds each review to the exact assigned product and mechanical checks, preserves the
raw response, and verifies the signed execution receipt before creating completion evidence.
It also saves the original assignment so a later compatible prompt change cannot invalidate
that evidence merely by changing its wording. This removes reference-copying as a model task;
it does not relax review criteria or turn mechanical checks into semantic approval.

Historical V1 reviews still require their original exact references. Interrupted runs bound
to the old registration are refused rather than silently upgraded; start a fresh run under
the new contract. Already committed terminals keep their existing replay behavior.

## Specification composition

Define creates one canonical `SpecificationV1`; its exact source manifest numbers each request source. New starts record stable FrameV2 question identities and exact per-question caller responses or admitted evidence uses, then project a product-bound `DefinitionTraceV1` before Vera and Carren review. A claim that a material uncertainty is resolved needs actual target-specific support and review, not just an answer or artifact; unanswered material questions can still yield a useful **blocked** specification, not a ready one. New requests whose protected caller wording cannot fit the V1 product refuse before work begins rather than silently omitting it.

Define-revise and Plan accept either `semantic_only` (validate exact canonical specification bytes, without verifying how it was produced) or `reviewed_definition` (verify a committed new-contract Define producer, its current trace/reviews/completion and immediate revision parent). V2 invocations choose explicitly; V1 invocations map to semantic-only; with no specification the mode is `not_applicable`. If strict evidence is missing, the request refuses before creating a consumer run—it never silently downgrades. Neither mode proves all ancestors or that external sources remain online. Chains still pass the one exact core ID, not a bundle of receipts.

Provider-free tests cover contracts and workflow control, **not** live-model completion reliability. The repeated live qualification cohort for these seven-skill fixes has not been run.

## Build and restart

Penny ships one compiled orchestration generation, including its artifact-reader helper and
matching TypeScript declarations. After code changes, stop workers, run
`bun run build:orchestration`, and start a fresh Pi/service process. A build does not hot-reload
an existing session; an extension reload alone does not establish that cached package code was
replaced. Source/helper/output drift or a rebuild encountered by an old process refuses with
`ORCHESTRATION_BUILD_STALE`. Rebuild from stable sources and restart rather than bypassing the
check. The private package needs its checkout inputs to verify freshness.

Loop-policy declarations also change registration digests. Active/interrupted runs bound to
a different registration refuse with `REGISTRATION_CONTRACT_MISMATCH`, not an automatic
upgrade. A cancelled run remains cancelled; a new policy needs a new authorized run, not
recovery of that terminal. Source inspection or source-mapped fixtures do not prove the
compiled process has these protections, and neither establishes live qualification.

## Recovery

The Node SQLite checkpointer stores compact state and selected refs, never stage payloads.
Retry, clarification, crash recovery, and compaction use exact run/artifact identities.
Retired checkpoints are archived and never converted into active runs.

Retention does not reserve the database writer when the terminal-run count is within its cap.
When eviction is needed, it plans dependencies in a read snapshot, then reserves the writer only
to check that no intervening commit invalidated the plan and to delete the eligible cohort
atomically. Concurrent changes defer cleanup to a later pass. Live runs, custody holds and
retained consumers' producer evidence remain protected; immutable artifact objects are not deleted.

## Memory boundary

Workers and skill execution do not use durable memory as handoff, run state, or persistence
proof. Primary cross-session memory remains a separate optional capability.

## Learn more

- [Skill Standard](skill-standard.md)
- [Testing](testing.md)
- [Agent Orchestration Reference](../../agents/skills/orchestration.md)
