# P03 bootstrap retired from ordinary SCA

The SCA-specific bootstrap, native operator enrollment/login, predecessor certification and activation ceremony is **retired as an implementation or runtime prerequisite**. Ordinary SCA uses the existing skill registry, orchestration engine, catalog agents, immutable artifacts and registered host-operation infrastructure. Do not run the legacy CLI or compose a private host/profile to enable ordinary SCA, and do not create a replacement install/auth UI.

The extension registers only `sca_source_query`, `sca_graph_query` and `sca_application_test`. It no longer installs `/sca-p03-initial` or authentication commands, nor eagerly imports their native-host modules. Dormant components and tests remain useful historical implementation evidence; their presence does not make them a required setup path.

Keep real scanner and graph fidelity checks, PHP + JavaScript/TypeScript coverage, exact source/evidence bindings, bounded execution and exports, cancellation, cleanup and quarantine. Target execution still requires the admitted execution-plan/policy and isolation boundary. Normal platform human approval remains at the actual exact-report release/publication consequence, not before ordinary engineering or tests. Complete ordinary-skill integration and live capability evidence are still in progress; this retirement notice does not claim they passed.

## Historical implementation reference — not setup instructions

The following original guide is preserved verbatim for component behavior, schema identities and recorded verification limits. Its imperative commands and private bootstrap/capsule/operator-profile/phase-activation requirements apply only to that retired path. They are not next-work instructions or authority for ordinary SCA. No legacy operation is authorized by this page.

<details>
<summary>Retired P03 guide (historical text)</summary>

# P03 bootstrap and production sampling

For a fresh P01 Joern root, use the host-only `issueScaP01JoernRootV1` component documented in [P01 Joern root custody](P01-JOERN-ROOT.md). It produces bounded measured closure/package bytes and the existing P01 receipt, not an image archive or accepted campaign. Preserve those exact refs through P01 admission; production P03 cannot substitute a historical or same-version root.

The `penny-sca-p03-bootstrap` binary is an operator-only entry point. It is **not** a broker action, an ordinary service route, an engine, a runtime registration, a qualification gate, or authority to run P04. Do not interpret its local proof as AC-P03: real-host qualification and independent review still need to be performed on the intended host.

Build with `bun run --cwd "$PROJECT_ROOT/apps/sca-service" build`. Invoke `node "$PROJECT_ROOT/apps/sca-service/dist/p03-bootstrap-cli.js" freeze-record --manifest ABS_PATH`, then `seal --manifest ABS_PATH`, then `verify --manifest ABS_PATH`. The package also exposes the `penny-sca-p03-bootstrap` bin. No default path, image, executable, project, source tree, reviewer key, or Docker configuration is built into the CLI. Each manifest is **canonical JSON** (the repository's `canonicalJson` serialization), an owner-owned regular file with mode `0600`, addressed by a canonical absolute path; duplicate JSON keys, extra fields, symlinks, and noncanonical bytes are refused. Use a non-root owner and a private (`0700`) working directory and staging parent. The ArtifactStore project ID is exactly `prj_` followed by 32 lowercase hex digits; `create_store` is required in the freeze manifest and is the only permission to provision a store. Keep manifests and handoffs out of tracked files.

A separate production-lineage mode uses `freeze-production-record`, `seal-production`, and `verify-production`. It never upgrades a standalone freeze. Its freeze manifest requires `create_store: false`, a pre-existing project-bound ArtifactStore, the complete accepted-P01 binding, and exact P01 toolchain/executable/measurement refs. Accepted P01 lineage is validated before Docker measurement or P03 persistence and again around measurement, finalization, seal, verification, and runtime use. Production writes `production-freeze-handoff.json` and `production-sealed-handoff.json`; the latter carries the separate production qualification-record ref and production-binding digest. Bootstrap V3 remains embedded component evidence, not production evidence by relabeling.

Production composition is now read-only at construction. Runtime measurement and proof replay occur inside the submitted canonical P03 operation context, under its existing backend lease—not a nested owner or acquisition. Each use checks exact request/input bindings, current native policy, approved backend resources, and production proof before accepting results. The retired direct V3 runtime constructor still rejects with `p03_guarded_runtime_composition_unavailable`; it is not a fallback. Constructing a service does not install or activate an authority.

The public runtime policy (`penny.sca-p03-runtime-policy.v1`) stores only
`staging_parent_sha256`: lowercase SHA-256 of the **exact UTF-8 bytes** of
`config.staging_parent`, without JSON quoting, normalization, or realpath substitution.
The canonical absolute staging path stays in caller-owned private manifests/configuration
and runtime memory. Freeze, bootstrap proof verification, post-run issuers, host runtime
construction/reverification, and service operations compare that private path against
the frozen digest; a different path fails even if it resolves to the same directory.
Ownership, permissions, no-follow/realpath checks, and container confinement still apply
independently. Legacy policies containing `staging_parent` or missing/invalid digests
are rejected by the closed schema, not migrated or adopted. Existing path-bearing
freezes cannot be repaired in place: create a fresh freeze and obtain a new independent
review before signing. Private configuration and its paths must not be included as
implementation-source inputs or artifact metadata.

Frozen inputs shared with production P03 are issued with the canonical kinds,
producers, and content schemas in `SCA_P03_PRODUCTION_INPUT_CONTRACTS` from
`p03-contracts`: runtime policy and identity, implementation identity,
qualification profile and fixtures, and baseline query set/scripts/plans. Source
oracle/review/validation retain their existing authorities. Seal issues the exact
host-isolation-attestation ref under the P03 isolation-qualification producer.
Bootstrap record/review/binding/attempt/cleanup/isolation evidence and auxiliary
build/package bytes retain their separate bootstrap custody roles. These labels
alone grant no execution or activation authority; current-selection, independent
review, exact custody, role separation, and runtime fidelity checks still apply.

Import shared inputs by preserving their complete metadata and bytes, never by
wrapping or reissuing refs. A campaign may issue separate production isolation
evidence citing the exact sealed host-attestation ref. Earlier bootstrap-only
input metadata is rejected rather than relabeled or adopted: **r5 requires a fresh
freeze and candidate attempt, independent review, seal, and verify**. The r4 proof
cannot be converted downstream or used as the new qualification proof.

The closed schemas are exported from `src/p03-bootstrap-cli-contracts.ts`:

- **Freeze manifest** (`penny.sca-p03-cli-freeze-manifest.v1`): `schema_version: 1`, `store_root`, `project_id`, `run_id`, `working_dir`, `create_store`, `corpus_id`, `query_set_id`, `release_id`, `implementation_id`, `implementation_revision`, `root_tool_id`, `policy_id`, `oracle_path`, `source_oracle_review_path`, `profile_path`, `policy_path`, `fixtures` (one path per PHP/JavaScript/TypeScript), `implementation` (tagged `{role,path}` entries for source/build/normalizer/query\*runner), `config` (all `ScaP03DockerCandidateConfigV1` fields), and `toolchain_version_commands`. The PHP and JavaScript frontend commands are exact eight-argument `find /opt/joern -type f -name <frontend-pattern> -printf %f\\n` vectors; JVM, PHP runtime, and helper use exact two-argument `[tool, version-flag]` vectors with `--version`, `-version`, or `-v`. All source, review, profile, policy, fixture, and implementation files are stable-read through no-follow owner-only descriptors. Each role requires 1–64 distinct files; at most 128 files and 32 MiB combined. Paths do not enter public artifact bodies. The commands execute only inside a pinned, no-pull, networkless, read-only temporary image container; they are version commands, not measured-version values. The independent measurement must match the Docker/Joern pins in `config`. The pinned `config.image_ref` is the repository manifest digest used with `--pull=never`; Docker's separately measured canonical image configuration `Id` is retained as `image_id`, drives `runtime_tree_sha256` and deployment identity, and must not be derived from or equated with the manifest digest. Only bounded numeric version tokens are persisted from tool output; banners and filesystem paths are discarded. Specify real version-reporting tools for the pinned image, not `echo` or wrappers that conceal a different tool. Review these commands alongside the image before live use.
- Freeze writes `freeze-handoff.json`, `registry.json`, and `package-0.json` through `package-2.json` in `working_dir`, all mode `0600`. The handoff carries exact store/project/run, frozen refs, mapping digest, attempt/evidence/record refs, and `ready_for_review` or `blocked`, but not the underlying private file names or observation bodies. One candidate attempt is made. A failed candidate still persists a witness and private `blocked-diagnostic.json`, then returns a blocked handoff; cleanup/isolation/record refs may be null. A preflight failure aborts without a positive record. Repeating a complete matching handoff adopts it without a second candidate run; an incomplete interrupted attempt without a completed handoff refuses an automatic rerun and requires owner inspection. Do **not** manually synthesize a PASS handoff.
- **Seal manifest** (`penny.sca-p03-cli-seal-manifest.v1`): `schema_version: 1`, the same exact store/project/run/working_dir/config, `freeze_handoff_path`, `freeze_handoff_sha256`, exact `implementation` mappings `{role,path,ref}`, exact `runtime_packages` mappings `{path,ref}`, `external_review_path`, `reviewer_public_key_path`, `reviewer_public_key_sha256`, `reviewer_id`, `reviewer_authority_id`, `evaluator_id`, `attester_id`, and `attestation_id`. The key digest is SHA-256 of the Ed25519 public key's DER/SPKI bytes. The external reviewer—not the CLI—creates a separate canonical file containing `external_review_id`, exact `record_ref`, `attempt_ref`, `cleanup_ref`, `isolation_ref`, reviewer identifiers, `decision: "PASS"`, UTC `reviewed_at`, and a base64 Ed25519 `signature` over canonical JSON of those fields **excluding** `signature`. Signature, subject, role separation and time are checked before positive review persistence. Seal writes current `selection.json` and `sealed-handoff.json` as private files; it refuses a different or revoked selection, and a proof failure revokes a newly selected one. It does not activate a runtime.
- **Verify manifest** (`penny.sca-p03-cli-verify-manifest.v1`): seal manifest fields with the verify schema ID, plus exact `sealed_handoff_path` and `sealed_handoff_sha256`. Verify reopens the store read-only, rechecks current selection, key, external review, build/package mappings, Docker image and container/workspace census through the concrete V3 authority, and emits only verified proof refs/status. Its live identity check creates and removes an ephemeral Docker probe container and private temporary Docker config; “read-only” here means it does not alter the ArtifactStore, selection, or other durable qualification state. The selection can be revoked by an owner-controlled canonical `penny.sca-p03-bootstrap-selection.v1` object with `status: "revoked"` and a recomputed self-digest. A historical PASS does not bypass a revoked/current-selection check.
- **Production manifests** use `penny.sca-p03-cli-production-freeze-manifest.v1`, `penny.sca-p03-cli-production-seal-manifest.v1`, and `penny.sca-p03-cli-production-verify-manifest.v1`. The freeze schema adds `accepted_p01`, `toolchain_ref`, `root_executable_ref`, and `root_measurement_ref`, and requires `create_store: false`. Seal and verify otherwise retain the same private mappings and independent bootstrap-review inputs, then create/check the separately self-digested `penny.sca-p03-production-qualification-record.v1`. That record carries exact accepted P01 lineage and exact bootstrap record/review/binding/attestation refs. This makes production lineage independently inspectable; it does not replace later formal AC-P03 review, gate, or activation.

## Guarded production-bootstrap verification

The previous synchronous child bridge remains retired. `createScaP03ProductionBootstrapSamplerV1` retains installed-authority authentication, exact manifest/executable/entrypoint pins, protected deployment checks, and dependency-tree checks. Its asynchronous overload accepts a concrete `ScaP03NativeVerificationInvocationV1` and reads only that invocation’s completed, consumed result; it does not dispatch or accept a callback substitute. Without that invocation it still refuses with `p03_guarded_bootstrap_verification_unavailable`. The executable `sample-production` route remains disabled without a native owner context. Existing `verify-production` is the separate explicit operator CLI described above, not an execution grant.

An injected, zero-model registration in `apps/orchestration/src/sca/p03-bootstrap-verification.ts` now exercises one real `invoke_host_operation` through the existing engine, runner, project journal, and state-root-global lease authority. It is absent from the public registry, package exports, and skill catalog. The registration's approval declaration is **not** human approval. That registration remains an explicitly deterministic-test-only seam. Native sealed verification instead uses the separate initial-permission workflow described below, with a trusted questionnaire witness and canonical owner context. The workflow terminates `incomplete/met:false` even when its verification operation succeeds. Its evidence cannot issue formal AC-P03 PASS, initial issuance, runtime qualification, activation, or P04 authority.

The caller supplies an exact canonical request artifact, fresh run/invocation nonce, production verify-manifest digest, independently approved backend-resource digest, and a sorted, unique closure of full proof refs. The adapter checks the backend resource against its independently supplied binding; run, nonce, request, project, and authority changes cannot substitute a new resource to bypass quarantine. The result envelope carries current run, invocation nonce, and request digest **outside** the unchanged stable `ScaP03CurrentBootstrapSampleV1` body.

Before any temporary Docker config or probe effect, the adapter calls the existing owner's `beginSubmission()`: the global lease becomes `submission_guarded`, then the project journal records `submitting`. Journal failure leaves the global guard durable. The production proof reader grants only exact directive-bound reads and metadata, backed by the real project-bound ArtifactStore and owner `readInput()`; it checks complete refs, bytes, lengths, digests, and actual lineage metadata. It grants no discovery, selection, write, or selected-latest capability.

After full proof replay and cleanup, the owner persists and verifies the operation result, applies global disposition, settles exact platform result/receipt refs, and atomically commits the parent continuation with `settled → consumed`. `readScaP03ConsumedVerificationV1` accepts only that invocation's consumed, completed canonical record and exact request/result/platform/receipt bindings. Another invocation's sample, historical PASS, cached result, or receipt cannot stand in for it. Two successful fresh offline invocations produce distinct result/receipt refs while preserving the stable sample-body bytes.

Recovery uses only the existing journal and global lease authority. An ambiguous `submitting` operation quarantines; fresh nonces, runs, and projects sharing that backend remain blocked. No JSON sentinel, new state owner/table, migration, automatic rearm, or synthetic operation row is added. An inspected reset requires the canonical authority's exact quarantine ID and evidence disposition. Activation revocation remains separate from backend cleanup truth.

Offline tests exercise real parsing, custody, proof replay, journal transitions, global fencing, persistence, settlement, and consumption; only Docker observations are substituted. They include actual test-worker `SIGKILL` after the durable guard/journal, reopen/quarantine, cross-project blocking, exact inspected reset, journal-write failure, settlement-write failure, and current-invocation checks. These tests do **not** verify deployed Docker cleanup after process death. The new V3 deterministic runtime seam is explicitly simulated and cannot mint a live runtime brand or qualify a host.

### Sample digest agreement

`handoff_sha256` remains SHA-256 of the exact canonical production sealed-handoff bytes and equals the manifest's `sealed_handoff_sha256`. It is not the freeze digest or proof-object digest. `selection_sha256` hashes the complete exact current-selection bytes, not its internal self-digest. Preserve every returned full ArtifactRef. Existing checks still cover independent signature/key, accepted P01 lineage, current selection, parser/package/source bytes, deployment identity, and cleanup; missing or changed operands fail closed.

## Initial permission and pre-live preparation (not final bootstrap)

The private native command `/sca-p03-initial start EXACT_PROPOSAL_ARTIFACT_ID`
followed by `/sca-p03-initial respond EXACT_RUN_ID` uses the existing trusted
questionnaire transport. It is registered by the SCA extension, but its default
host is absent: it reports `missing_input: trusted native authenticated operator/profile + canonical backend/state authority composition`.
A same-UID command, ordinary `respond` answer, signed execution receipt, predecessor
gate, approval boolean, or model callback cannot supply that host authority.

The owner presents the exact proposal; the questionnaire signs only the
owner-registered interactive response. The native gate driver verifies that witness,
then the canonical engine's initial authorization guard checks principal, policy,
installation, project, state authority, shared backend, time, revocation, exact refs,
and proposal/resource commitments. HMAC custody alone does not authenticate the
operator principal. A real trusted operator/profile installation is still required.
The realm UI key stays in the trusted host: it is never exported to a model or child.
Domain-separated child compatibility keys cannot sign realm UI events. No supported
source consumer of `PENNY_APPROVAL_HMAC_KEY` as a legacy human-gate verifier has been
located; compatibility with an unspecified external/retained consumer is unverified.

`src/p03-initial-live.ts` now defines the closed
`penny.sca-p03-pre-live-inputs.v1` manifest and the read-only
`prepareScaP03InitialProbeV1` seam. The obsolete factories that required post-live bindings before a first measurement
remain removed. The configured `createScaP03InitialNativeOwnerV1` now supports two
closed proposal purposes: `fixture_qualification` consumes pre-live inputs, while
`bootstrap_verification` consumes separate sealed inputs. Neither purpose installs
a default trusted host or supplies final activation authority. Read-only preparation
still returns a typed **blocked**
`penny.sca-p03-initial-prepared-probe.v1`, not a live sample or qualification PASS.

Pre-live inputs contain the intact accepted P01/P02 bindings, exact P01 root refs,
current P02 authority/issuance refs and a closed native proposed-start operand,
reviewed fixture content/corpus, source oracle/review/validation, qualification
profile, and exact seven query scripts/plans/set. The proposed-start operand is
inline: it does not invent independently retained proposal-artifact custody.
The manifest commits to deployment, private configuration, evidence destination,
and the exact initial resource policy. All preimages must be in the proposal's exact
bound proof slots. The reader refuses an unbound ref; it has no selected-latest,
artifact discovery, effect, or write capability. Preparation replays P01 root and
native source-oracle/query preimages; it explicitly reports current P02 owner
admission, protected deployment measurement, and fixture execution **not performed**.
It cannot authenticate placeholder P02 refs by reading their labels or bytes.

Every private native capsule must supply `source_manifest_sha256`, the digest of
the complete current `SCA_P03_IMPLEMENTATION_SOURCE_PATHS` census computed with
`scaP03SourceManifestSha256`. This commitment is part of the exact configuration
digest bound into the proposal and approval; it is independent of `module_files`.
Host construction rejects a missing, malformed or stale commitment. Admission,
submission and each normal command boundary remeasure the census, so changing a
source file omitted from deployed module mappings cannot evade the approval.
Reconstructing the host does not adopt changed source. Legacy capsules without the
commitment must be replaced and reviewed with fresh approval, not defaulted or
repaired in place. Cleanup remains narrowly authorized on failure.

No pre-live manifest accepts a sealed bootstrap, production handoff/current
selection, live-qualified P03 runtime identity, or active P03 authority. Those
belong to later boundaries. Pure validators may be reused, but initial preparation
never calls `readP03ProductionInputs` or runs the standalone bootstrap CLI.

### Strict consumed-fixture readback

`readScaP03ConsumedFixtureEvidenceV1` in `src/p03-consumed-fixture-evidence.ts`
verifies one exact initial `fixture_qualification` operation after the canonical
owner has completed and consumed it. Supply the concrete project-bound ArtifactStore
and Checkpointer, pinned proposal binding, exact directive, owning declaration, and
an explicit expected measurement scope. It accepts only `status: "observed"` with
all 21 original ordered cases; an owner-completed `fixture_blocked` is not success.
Missing, mismatched, malformed, out-of-bounds or reread-drifted evidence refuses
without a partial positive result or fallback.

The reader checks the original proposal/transport/approval operands, approved
preimages and provenance, fixture/query/oracle consistency, the ordered native
Docker transcript, original witness, graph/inventory-to-case bindings, platform
result, receipt and retained lease disposition. Final rereads check unchanged
refs, metadata, bytes and canonical operation record. Results preserve complete
result/platform/receipt refs and copies of the original evidence and witness bytes.
They explicitly report `historical_consumed_fixture_evidence` and
`current_execution_authorization: "not_evaluated"`. Independent review remains
required; formal qualification, activation and P04 permissions remain false.

`runScaP03InitialLiveCohortV1` retains its current authenticated authorization,
pinned pending gate, original same-realm approval token, first-live 1 GiB condition,
and existing `service.execute({ action: "respond", ... })` owner path. After that
execution it checks the retained registration/declaration and exact operation
bindings, compares the engine-persisted approval event with the original submitted
bytes, then calls the strict reader with `live_observed`. The UI token ref need not
equal the engine-persisted witness ref. A strict refusal cannot return through the
former loose acceptance path.

Historical readback performs no execution, recovery, Docker command, discovery,
selection, persistence or current authorization evaluation. Expiry or revocation
does not rewrite old evidence, but still blocks current use through the existing
live/owner checks. Readback neither independently authenticates the historical
human principal nor grants renewed approval, current P02 admission, current source
or deployment validity, present-day cleanup, or production readiness.

The genuine offline native-owner harness exercises questionnaire signing and actual
authorization, engine/runner, journal/global lease, collector, persistence,
settlement and consumption, substituting only low-level Docker observations. Its
success/success cases retain original bytes and refs, 21 cases, 146 observations
and the 17-execution witness, distinct refs for fresh invocations, and read-only
repeated/refused reads checked against logical SQLite and immutable-object snapshots.
The real live wrapper must refuse that evidence as `deterministic_transport_test`,
not relabel it live; a second scenario retains genuinely owner-completed blocked
fixture evidence and verifies refusal. Genuine-record directive/declaration
cross-binding tests also refuse. A separate real-wrapper refusal test injects
service-declaration drift only after genuine owner consumption; it creates no
alternate operation rows or canned terminal success. Deployed-live verification
remains unrun.

There is **still no full native consumed-fixture freeze/seal bridge**: this reader
creates no freeze, review packet, selection, seal, qualification or final authority.
Native witness candidate identity commits to the original request, not a frozen
candidate; native package identity hashes recorded versions, not V3's ref-bound
package closure. Native resource-sized `/tmp` and `/work` plus `JAVA_TOOL_OPTIONS`
differ from V3 confinement policy. The reader understands those original semantics
without changing V3 or claiming compatibility. Workspace digests and historical
absence remain recorded claims: the native in-process registry does not retain
resumable owner-controlled path/device/inode custody, so that custody and independent
present-day absence cannot be reconstructed. These remain bridge blockers, not
permissions inferred from successful readback.

### Native sealed verification and ordinary P03 use

A `bootstrap_verification` proposal binds the exact sealed-input ref and canonical
`initial:<approval_id>:<invocation_nonce>` operation identity. Its sealed manifest
retains original production/bootstrap refs, accepted P01/P02 lineage, protected
configuration and deployment, and approved resource digests. A fresh run and nonce
may reuse those original immutable inputs; the original manifest lineage is not
rewritten to the new invocation’s run.

After native approval, the existing owner guards submission before workspace or
probe effects, records bounded recovery correlation, and runs sealed sampling in
process. Current policy, source, configuration, selection, proof and custody are
rechecked; probe and runtime commands share one owner-context command budget.
Temporary containers have deterministic owner labels and bounded cleanup. Uncertain
cleanup quarantines rather than claiming terminal success.

The consumed sealed evidence explicitly records verification-only purpose. It
cannot authorize fixture mutation, a campaign, activation, formal AC-P03 or P04.
`ScaP03NativeVerificationInvocationV1.collect()` validates exact consumed
proposal/result/platform/receipt bindings without repeating effects. Repeated
readback adds no commands; two fresh approvals produce distinct result and receipt
refs while retaining the stable sample body.

Ordinary P03 start now checkpoints its qualification operation immediately instead
of leaving an initial status directive stalled. Production composition accepts the
exact optional sealed-verification binding and original proof operands; proof replay
and qualification run within that ordinary operation’s own genuine lease. The
closed skill contract has 70 declared input ports, within the generic 128-port
representation ceiling. Operation authority and independent count/byte budgets
remain separate from that representation capacity.

Offline native tests exercise trusted questionnaire signing, current P02 admission,
protected installed programs, canonical owner fencing/journals, exact artifact
custody, fresh sealed verification, and ordinary production qualification. Docker
observations alone are substituted for the positive transport path; this does not
verify a deployed Docker host, installed operator configuration, or live cleanup.

### Required private trusted-host configuration

Before any first live effect, a separately configured trusted native host must supply:

- Authenticated interactive operator mapping, current permission policy,
  installation/revocation state, and issuer-owned clock.
- Canonical project/store/control/catalog authorities and independently approved
  backend identity; a request or nonce cannot create a parallel lease authority.
- Fresh eligible P02 owner/phase-registry admission and current binding replay.
  Expired historical authority and an active row alone are insufficient. Renewal
  and disposition of conflicting active history are separate authorized work.
- Caller-selected protected executable, entrypoint, build/dependency mappings,
  local Docker socket/image/toolchain pins, private working/staging/evidence
  destinations, and exact current-byte measurements. No tracked path default exists.
- Reviewed PHP/JavaScript/TypeScript source fixtures, independent oracle review,
  parser validation, profile, query preimages, and explicit resource policy.
- An initial owner-context collector that measures the environment and collects
  fixture/freeze evidence without final-bootstrap dependencies. The global
  `submission_guarded` write must precede the project `submitting` write and all
  temporary configuration, workspace, probe, graph, and query effects. Cleanup and
  independent absence verification must precede evidence settlement/consumption.

Outer ceilings are **2 CPUs, 1 GiB memory, 64 PIDs, 64 MiB TOTAL tmpfs, 1 MiB command
output, concurrency one, and 60-second renewable inactivity**. `/tmp` and `/work`
share the tmpfs ceiling. Inner graph/query/AST/page/JVM/source/storage caps, their
partition, queue bounds, and cleanup grace remain caller-required reviewed values;
none of the proposed inner values is an approved default. Backend heartbeats do
not prove productive work or renew operation inactivity. No observation may be
fabricated as PASS; uncertain cleanup blocks release/positive evidence.

## Deployment and final authority remain separate

After initial live collection, independent bootstrap review, guarded seal/current
proof replay, exact operational evidence, formal AC-P03 evaluation, and separately
gated final issuance/install/activation remain necessary. Final verification needs
original production handoffs/current selection, signed independent review and pinned
public key, complete protected build/package/source mappings and current proofs.
The native verification and production-composition source paths are implemented,
but passing offline tests does not install a trusted host, refresh deployed
qualification, grant final authority, or prove live Docker cleanup. The no-invocation
sampler and direct CLI sampling path still refuse before effects.
P04 disclosure/spend has its own later permission boundary.

## Exact predecessor inspection

`loadScaP03PredecessorInputsV1` opens only the caller-bound native ArtifactStore in
`verify` mode and follows validated explicit refs. Request/transition artifact phase
comes from the owning P02 candidate contract (`sca-p02-candidate`), not conceptual
qualification `phase_id: SCA-P02`. Native upstream ordering is preserved, including
legitimate unsorted inventory provenance. Only producers/owning schemas with an
explicit sorted contract enforce sorting. External historical issuance linkage
compares exact members without rewriting the metadata. Duplicate/revision rules
remain native-store rules; qualification snapshots retain their source guards.
Opaque linked auxiliary JSON keeps its original bytes, including historical newline
formatting; typed canonical-JSON operands still reject noncanonical serialization.
Octet-stream root closure uses native exact-ref reads without media relabeling.
The loader never renews, reissues, repairs, or activates old evidence. Historical
linkage/replay, current host binding, and usable authenticated authority are distinct.

The standalone handoff schemas are `penny.sca-p03-cli-freeze-handoff.v1` and `penny.sca-p03-cli-sealed-handoff.v1`. Production uses `penny.sca-p03-cli-production-freeze-handoff.v1` and `penny.sca-p03-cli-production-sealed-handoff.v1`. Do not edit them or move any backing file between stages. Seal and verify reject a changed key, artifact ref, accepted-P01 binding, package source, implementation byte, selection, or upstream. The service's offline tests use injected fake command/probe/candidate seams; they are not a substitute for live Docker validation. The optional live test requires an explicit `PENNY_SCA_P03_CLI_LIVE=1` and an owner-provided `PENNY_SCA_P03_CLI_LIVE_MANIFEST` path. It is skipped by default.

## Current P03 qualification identity

The fixed owning P03 census includes initial authorization/preparation, live transport,
predecessor inspection, native operator/trusted gate/questionnaire/realm security
surfaces and their regression tests, alongside the existing verification and runtime
sources. The consumed-fixture reader, its custody/transcript helpers, both core test/helper
files and the genuine integration snapshot helper are included. Source-drift tests
use actual bytes and reject changed reader/helper commitments under the old identity;
the protected native capsule also refuses drift in the reader omitted from deployed
module mappings. Its schema bounds and count checks derive from the exact sorted path list,
not a stale fixed count. Existing measured source
manifests and formal host bindings cannot be adopted as the new identity; obtain
fresh qualification/review/authority for changed source bytes. P02's census is
unchanged, but any separately frozen qualification covering shared changed sources
must be independently reassessed; this slice does not reissue it.

The P03 registration regression pins current candidate identity
`6634f667e4c19ac4c7cef5c71c995ecbc1b0f236e5967a78fb73cc33674d0211`.
Adding exact P02 V3, source-oracle, sealed-verification and runtime-package ports
changed the contract digest to
`e0500abdebb26335ca52ca9a0112dda129a66f5d1caad7fbde9d48ca7b5690a5`;
the operation-authority digest remains unchanged at
`99f7a47b99f81d5466b0cba4ede323884e7549b119e425504a91e77c2e640548`.
The test independently projects canonical fields, pins both subdigests, checks
execution-affecting mutations and order invariance, and verifies that neither P03
registration enters the public registry. These source identities are not formal
independent review or deployed qualification. The older `40cbcbb3…` golden still
has no recorded canonical preimage; no historical contents or single-cause
provenance are invented.

</details>
