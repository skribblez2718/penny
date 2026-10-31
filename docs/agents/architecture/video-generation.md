# Video Generation Architecture

The hidden exact-name `videogen` skill is registered and has an executable TypeScript core. It requires explicit private host configuration; registration and offline fixtures do **not** establish a qualified production deployment or a finished film.

## Boundary

Video generation is registered asynchronous host work. Model workers and callers do not receive network, filesystem, process, model-selection, or arbitrary graph authority.

The trusted host owns:

- exact approved profile injection;
- literal-loopback backend selection;
- exact prepared graph construction;
- reference upload, transport-specific submission, exact-job cancellation/terminal observation, polling and retrieval;
- durable remote-effect journaling;
- bounded MP4 admission and artifact persistence.

A profile is immutable at its approved digest. It binds one T2V or I2V source graph, the only mutable node inputs, output node, dimensions, frame counts, frame rates, required classes and models, backend endpoint, and resource limits. Preparing a graph changes only those registered mutation addresses. Normalizing the mutations back to their source values must reproduce the exact source graph.

## Two remote effects, two operations

I2V reference upload and render submission are separate host operations. Each can be accepted remotely before the response is observed, so combining them under one remote correlation journal would make crash recovery ambiguous.

### Reference upload

The upload operation:

1. reads one exact canonical PNG artifact and exact profile snapshot;
2. derives the remote filename from the PNG SHA-256 digest;
3. uploads only to the profile-owned input subfolder through the registered loopback HTTP client (also on the currently managed upload path);
4. records the deterministic upload correlation before later work;
5. reads the exact input locator back through the API;
6. compares byte length and SHA-256 before persisting an upload receipt.

A disconnect or malformed successful response after the upload begins is remote-unknown and quarantined. Recovery uses only the deterministic registered locator; it never searches backend storage or uploads a second name.

### Render generation

The render operation:

1. verifies the exact profile snapshot, submitted-graph artifact, and optional I2V upload receipt;
2. proves graph changes are confined to the registered mutations;
3. checks required backend classes and model identifiers;
4. journals the submission guard before either managed private-IPC submission or explicit legacy `POST /prompt`, then records the exact prompt ID immediately after known acceptance;
5. polls only `/history/{exact_prompt_id}`;
6. accepts exactly one descriptor from the registered output node;
7. retrieves only that descriptor through `/view`;
8. caches exact fetched bytes before the durable fetched milestone;
9. validates and persists the MP4 plus structured receipts.

Accepted-prompt recovery never resubmits. Fetched-result recovery compares the cached bytes with a fresh exact-descriptor read before persistence. A mismatch fails closed.

## HTTP and cancellation policy

The fixed private adapter binding selects exactly one branch: `managed`, explicit `legacy_http: true`, or explicit `assurance: "trusted_local_api"`. All three retain exact approved profiles and the operation journal. The compiled [binding/factory](../../../apps/orchestration/src/videogen/runtime-adapters.ts) and [private runtime contract](../../../.pi/skills/videogen/resources/private-runtime.md#managed-comfy-video-bindings) define construction; neither configuration nor these docs activate or qualify a deployment.

- **Managed rendering:** requires the matching native `worker_id`, current native capacity/meter binding (not measurement-file substitution), pinned process/build/helper/socket and exact operation/request/fence grants. The owner closes and drains **all** registered overlapping services before native baseline observation; a missing bridge refuses even for an apparently inactive service. After transport initialization and the durable guard, the relay admits only the approved canonical prepared graph through authenticated private IPC. Pinned stored object-info contracts validate source and prepared graphs, including required nested dynamic-combo inputs and literal dotted keys; current backend contracts must still match. HTTP readiness, inventory, history and retrieval are read-only on this render branch and use actual one-use socket counters, awaited through socket closure.
- **Managed reference upload:** shares native closure/preparation and HTTP socket metering, but the current upload adapter still calls bounded multipart `POST /upload/image`; it does not send a render graph or open the render grant window. Selecting a managed binding is not proof that every mutation uses IPC or that managed upload is production-qualified. The deterministic PNG locator and exact readback rules above remain mandatory.
- **Trusted local API:** uses the normal fixed Comfy HTTP client plus concrete operation-bound allocation/socket/owned-payload accounting. It requires `capacity.local_api`, `penny_serialized_api` policy and exact logical worker/resource mappings. It proves neither external/manual-work exclusion nor physical GPU usage/drain. It never falls back from managed mode or enables interrupts.
- **Legacy HTTP:** upload/submission require explicit opt-in and do not prove managed exclusion, native grants or native metering. Render submits only the prepared graph to `POST /prompt`. A generic HTTP mutation API is never exposed to callers or workers.

The shared ComfyUI HTTP client is constrained to literal `127.0.0.1` or `::1`, plain HTTP and a registered port. It refuses redirects, compressed responses, unsafe path descriptors, unbounded bodies, malformed JSON, wrong prompt-key history and unsafe prompt IDs. Upload uses bounded multipart construction; callers cannot provide arbitrary fields or remote paths. Profile poll-count/transient-failure limits, connect/read inactivity and owner cleanup bounds remain applicable; transport activity is not capacity productivity.

Cancellation is exact-job only. Managed rendering registers owned relay cancellation/drain, not a global interrupt; exact job/task/device and socket drain precede CLOSED, final measurements and settlement. A cancel acknowledgement, terminal HTTP history or disconnected bridge alone is not managed drain proof. Loss, expiry, ambiguous acceptance or incomplete final accounting keeps the hold; there is no automatic restart or manual takeover. Managed recovery without independent drain/reconciliation refuses rather than reopening an accepted grant window.

The current legacy adapter's cancellation observer only checks the exact accepted prompt's terminal history. HTTP interrupts remain disabled because retained constructor/profile/worker evidence does not establish current deployment version/revocation custody. Poll exhaustion likewise requires exact terminal observation or quarantine; do not infer targeted-interrupt permission from the client's `/interrupt` method. Tests must retain refusal for unqualified, forged, stale or mismatched cancellation evidence, post-acceptance profile changes, and accepted-recovery input drift. Neither a new name/upload nor duplicate submission can repair ambiguous acceptance.

The [managed runtime tests](../../../apps/orchestration/tests/comfy-managed-runtime.test.ts) exercise local IPC credentials, catalog/journal/grant transitions and socket counters with fake compute and controlled physical probes. They do not qualify GPU execution, cross-UID inspection, model residency or production activation. Installation/source-pinned service patches and independent controls require separate operator authorization; loading a manifest changes no privileges. Unobservable cross-UID services cannot qualify through self-reported identity.

## MP4 admission

`video/mp4` output is admitted by repository-owned bounded ISO Base Media File Format validation. The validator requires:

- exactly one `ftyp` and `moov`, and at least one non-empty `mdat`;
- a supported ISO brand;
- exactly one video track;
- H.264 or HEVC sample entry with codec configuration;
- coherent track, time-to-sample, sample-size, sample-to-chunk, and chunk-offset tables;
- every sample range wholly inside an `mdat` payload;
- valid length-prefixed coded-picture NAL units and at least one independently decodable frame;
- exact requested dimensions, frame count, frame rate, and duration tolerance;
- configured byte, box-count, nesting, sample-count, and table-count bounds.

Admission proves bounded container and elementary-stream structure, not perceptual or temporal quality. The videogen playbook separately requires current objective/quality reviews and independent AV playback evidence.

## Current scope

The implementation includes typed start admission, the registered story/script → G1 → references/voice → G2 → animatic → G3 → drafts/rough → G4 → finals/master → G5 → local-delivery executor, current-owner effect checks, review/repair states and seven fixed completion proofs. `OrchestrationService` and the default `skill` extension load an explicitly selected owner-private JSON manifest through `PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE`; trusted constructor bindings remain supported. Without either binding, invocation refuses before run creation. The package remains hidden from model discovery.

The manifest supplies complete configuration, immutable artifact inputs, fixed recipes, compiled adapter bindings and, whenever adapters are present, an already-installed capacity policy with exact demands and an actual measurement source. It cannot select JavaScript modules, phase callbacks or PASS predicates. Loading never installs policy, migrates retained state or starts a service/model. The complete minimal JSON fixture and typed builder exercise default manifest loading; the fixture intentionally has no effects and ends at G1.

Managed Voice bindings support either an owner-private process snapshot or the compiled native process observer. Native process/file/GPU observations do not prove model residency, exclusive admission or completed-job voice/chunk identity. Missing instrumentation, unloaded models, unknown unmanaged calls or conflicting GPU contexts remain not-ready. A successful health GET is not readiness.

Isolated tests cover executor/control-flow and synthetic dual-product publication. Full default-manifest production, deployed meters/external-work exclusion, audible performance, native interoperability, legal clearance and all 18 distinct production routes remain unqualified. See the [runtime reference](../../../.pi/skills/videogen/resources/reference.md) and [private manifest contract](../../../.pi/skills/videogen/resources/private-runtime.md).

## Explicit normal Voice API assurance

The separately named API profile/adapter/result contracts use the normal selected local
Voice service with verified transport and bounded read-only schema/voice/sample inspection.
They require the same current rights/consent, approval, budget, exact input, fenced capacity,
original acceptance and settled artifact-custody checks. Actual WAV/PCM inspection produces
runtime voice/audio products; it grants no human playback, intelligibility or alignment.
Unloaded unrelated models do not block this branch. Actual resolved runtime voice, fallback,
per-chunk execution and external exclusion remain explicitly unknown. Cooperative cancellation
is not drain proof; ambiguous mutations retain/quarantine the same hold without resubmission.

`LocalApiOperationMeter` records exact allocated slot windows, bidirectional socket bytes
(including Voice TLS), retained cache/artifact payloads and verified delivery-file bytes in
the existing artifact store. Cumulative/final snapshots bind the exact operation, requests
and owner-adopted fence. These are allocation/internal-tariff units, not kernel telemetry,
internet egress or currency. Unknown engine steps are not charged; unfinished crash sockets
cannot get fabricated final measurements. API-policy/snapshot assurance mismatch refuses.

The fixed CLI exports the closed schemas and builds a private Voice API JSON fragment;
no per-deployment JavaScript factory or privileged inspector is needed. An explicit unused-
catalog policy version operation preserves original immutable policies and refuses quota,
reserve, inventory, unrelated-binding or existing-admission changes. Ordinary startup never
selects policy. See the [normal API procedure](../../../.pi/skills/videogen/resources/private-runtime.md#normal-trusted-local-apis-no-service-instrumentation).

## Current-source production composition

The private runtime can explicitly bind settled render/Voice outputs to bounded
preparation through the existing media operation. Canonical AVC has distinct bytes,
rights lineage and a lossy transformation record; zero-tail PCM preserves all
source samples and refuses speech trimming. Exact consumed producer custody and
current selection/rights are checked before work and again before materialization.
Raw producer artifacts and original receipts remain separate.

Optional host-authored story/script/animatic choices and inert look/native templates
avoid fabricated worker receipts and placeholder performance/edit products. A closed
one-shot edit policy derives media and native resources from current measurements
and accepted shots. These features grant no reviews, rights, activation or completion.
See the [private composition contract](../../../.pi/skills/videogen/resources/private-runtime.md#current-source-preparation-and-authored-choices).

## Provider-free foundation

The pure foundation modules under `apps/orchestration/src/videogen/` supply contracts to the registered executor. Their standalone validation results remain non-authorizing: they issue no qualification, install no policy or migration, and grant no effect permission.

- `foundation-contracts.ts` defines closed request/envelope, policy, budget, story,
  script-draft/script, asset-intent and look/voice schemas. Platform `ArtifactRefSchema`
  is reused unchanged. `bounds.ts` bounds representation and reads exact canonical JSON
  through the project-bound artifact store.
- `admission.ts` prepares against injected current configuration, qualified-route and
  capacity projections before a run. Missing consequential fields produce typed questions;
  malformed input or absent authority refuses. Every result has `effect_permission: none`.
  This is not atomic capacity reservation; a later owner must reserve and recheck at apply.
- `rights-ledger.ts` checks current host-selected rights, consent, territory, lifetime and
  explicit cross-run provenance edges. Its pure dependency projection removes affected
  approvals/reviews while retaining independent siblings. Checkpoints select ledger refs,
  never ledger bodies. Readable license/receipt bytes alone are not legal clearance or
  signed-journal verification: the current authority index is a trusted host input.
- `gates.ts` validates exact G1–G5 or clarification packets and classifies matched replies.
  G1 is bounded preview scope, G3 draft scope, G4 final scope; G2/G5 are version-only.
  Clarification answers grant nothing. The existing engine still owns durable challenges,
  cancellation and exact-response replay. Scope classification does not dispatch an effect.
- `rational-time.ts` and `timeline-validation.ts` distinguish seconds from rates, use
  checked BigInt arithmetic, quantize absolute frame/sample boundaries nearest ties-even,
  and validate the measured-source hard-cut timing slice. The slice is not `EditDecisionV1`
  and provides no native editor, speed-map, gain, caption or effect interoperability.
- `shot-modes.ts` closes the seven input variants and binds exact registered ports,
  output fields, profiles and rights. Speech preflight also checks the committed exact G2
  response, selected look/performance/timing and host decode/alignment/playback projections.
  It does not decode audio or prove intelligibility; synthetic projections do not qualify
  a live speech-conditioned route.
- `completion.ts` registers seven fixed CompletionGate v2 proof evaluators: current gates,
  current final shots, audio/playback, portable native package, current rights, exact delivery,
  and settled effects. They re-read selected artifacts and concrete owner journals; absent,
  stale or unqualified evidence refuses. The legacy `UNWIRED` export aliases those same
  evaluators, not always-false placeholders. No caller boolean or arbitrary evidence callback
  can replace a proof.
- `public-boundary.ts` provides a caller-scoped source inspection for hardcoded private
  bindings. It is not a comprehensive secret scanner or a runtime security boundary.

`apps/orchestration/tests/videogen-foundation-*.test.ts` exercises these boundaries,
including isolated real-engine waits, replies, restart, legacy replay and durable positive
refusal with temporary project-bound stores. The fixture traceability file distinguishes
foundation coverage from deferred atomic scheduling, media/native/delivery proof, final
workflow encoding and live route productions. These tests do not establish a finished
AV master, a reopenable Kdenlive package, legal clearance, or deployed route support.

## Captured audio: bounded read-only protocol

`audio-sources.ts` defines the closed four-source `AudioSourceV1` union, five stem
roles and rational decoded-measurement fields. Decode references require exact
host-operation receipt schema v1 metadata; that syntax does not prove journal custody.
Read-only capture/inspection reuses exact project artifact readback and current
rights/consent checks. Every operand must already exist; a later timing/source
wrapper cannot replace capture evidence.

This standalone read-only slice does not admit production. Its registered-generator and general
nonvoice-rights cases remain unsupported; the executor uses separate fixed effect/evidence adapters. Source-clip strip/sole-speech/mix checks conservatively
prevent duplicate speech; they do not strip or mix media. Voice-only checks reject
nonvoice/absent speech and block even well-shaped speech pending real decoding,
intelligibility, timing and playback evidence. The dedicated unit and reopened-store
integration tests use silent constructed PCM, not decoded speech or a live voice job.

## Opt-in shared-capacity core

[Host Operations — Opt-in capacity accounting](host-operations.md#opt-in-capacity-accounting) owns the generic admission/hold, exact-fence and demand rechecks, finishing reserve, independent clocks, nonterminal parking/compensation, productive-evidence, final-measurement, drain/quarantine and settlement rules. Its [compatibility policy](host-operations.md#compatibility-and-schema-policy) preserves closed V1 replay versus new V2 semantics in schema **4**, older-binary refusal and explicit backup-before-DDL upgrades. These requirements apply unchanged to video; records retain `effect_permission: none` and never replace effect, rights, approval or qualification authority.

Video-specific bindings remain local:

- `videogen/capacity-scheduler.ts` maps host-selected exact profile versions and operation kinds to the generic authority. Missing/stale selections and actual-worker/profile conflicts refuse. Purpose comes from the immutable journal binding, never a caller-selected finish alias.
- The host supplies immutable worker/resource mappings and concrete project-journal custody. New physical-worker keys are independent of endpoint/profile names; co-located services must name the same actual resources. Retained profile keys, journals and adapter dispatch are not reinterpreted. Mapping/configuration digests do not prove physical topology or external-job exclusion.
- The explicit private manifest requires an already installed policy, exact demand mapping and an actual measurement source whenever adapters are configured. Managed Comfy requires native capacity and its transport/drain conditions above. Construction reads policy only: it installs no policy, performs no runtime DDL and does not migrate retained state. Do not restart a retained deployment against schema 4 without an approved, externally backed-up and verified upgrade under the global write lock.
- The registered hidden executor consumes these opt-in boundaries; the capacity core alone activates neither profiles nor a workflow. Its seven fixed completion predicates require exact current proof graphs, not reservations or synthetic deployment claims. Physical deployment/external-job qualification, production progress/meters and whole capacity acceptance remain incomplete.

Generic temporary-store and real engine/owner/service coverage is listed at the host owner. Video-specific fixtures remain contract/protocol evidence, not a qualified film or production route. Missing final measurements block consumption; uncertain remote work retains quarantined holds even after a backend reset.

## Opt-in imagegen child recovery

The shared child owner now supports durable parent-projected child waits, exact mediated replies,
serial imagegen calls under a separate registration policy, captured-terminal recovery and a
transactional parent-cancellation fence. A concrete adapter reuses current G1/rights authority and
native imagegen reviewed-result validation; it imports canonical PNG and review/operation lineage
without adding imagegen to the ordinary seven-peer child allowlist. Parent/child control and catalog
session cohorts evict together only after safe settlement; quarantined effects pin them, and
immutable artifact objects remain preserved.

The [engine protocol](../orchestration/overview.md) records the closed response and opt-in boundaries.
Provider-free real-owner tests cover child custody and continuation, not live image qualification or a qualified videogen production.

### Current image authority is checkpoint-owned

`VideogenOwnerSelection` binds only concrete same-project artifact/checkpoint owners and one run.
Its constructor accepts no approval, presented-version, intent or rights index. Each use reloads
`videogen_owner_selection` from that actual checkpoint. The engine records original answered
G1–G5 gate/challenge and selected decision/packet bindings in its existing response transaction;
ordinary unrelated gates are not reinterpreted as videogen decisions. The original engine answer
remains required. Current selected refs, approved intent versions, rights replacement/revocation,
wall-clock expiry and parent terminal status are rechecked before effects and native child import.
A copied/proxied gate projection, forged/proxied owner or cached previous check cannot grant use.

The service's `imageAssetAuthorityForRun(runId)` constructs this binding from its own stores.
It grants no missing G1, profile, child policy or activation. Concrete trusted in-process host
code is not an OS isolation boundary. The host must initialize and commit selections in the
existing run, then inject the authority into the already supported imagegen/child composition.
The registered executor and explicit private manifest loader supply composition; constructing this owner alone neither activates them nor grants missing authority.

### Opt-in prepared video effects

`createComfyVideogenDeclaration` and `createComfyVideoUploadDeclaration` accept the optional
`effect_protocol: request_intent_v1`. With it they declare the closed `video_render` and
`reference_upload` kinds, require paired request/intent refs, retain per-item results unselected,
and opt into the generic post-receipt result-wrapper milestone. Without it, retained operation
kinds and declaration bytes remain unchanged. Requests have an additive optional `operation_id`;
when supplied it must match the directive, and the opted-in protocol requires it.

The [host-operation protocol](host-operations.md) documents ordering, crash recovery and bounds.
Real-owner local HTTP fixtures prove upload/render wrapper recovery without another POST; a real
raw-decode adapter fixture proves post-receipt recovery without re-decoding. Its subprocess boundary
is synthetic, not CPU/deployment qualification. Generic wrappers preserve raw-result/receipt
custody but do not supply missing domain AV evidence, measured playback, current gates/rights,
route attestation, native interoperability or any of the seven completion proofs. The executor separately constructs and validates domain result/evidence graphs. Production admission
still requires qualified actual media, playback, native, rights and delivery proof; generic wrapper
custody alone cannot supply it.

## Bounded cold Voice preparation

The fixed operator CLI now has a separate `prep --requestfile=PATH` management
entrypoint. Its closed request captures the explicit preparation brief and exact
bindings in the existing project journal; it grants no narration, G1, rights or
film authority. Registration uses no model workers or new generic skill.

The existing host owner reserves shared capacity and a backend fence before
external-service closure, cold identity/drain inspection and native baseline.
Only the durable submission guard opens the owned preload command. Cold
inspection does not require already-loaded models. Successful preparation does
require the actual verified engine/model/device observations, same-epoch drain,
transfer counters and final native measurements. A partial load, uncertain drain
or guarded crash quarantines the original hold instead of retrying preload.
Ordinary managed film/narration readiness remains strict.

Source/runtime/model manifests and all resource paths remain private caller
inputs. Large fixed runtime import inventories use bounded canonical bindings,
not a widened provider-message parser. The synchronous preload window must fit
inside the observed service control lease. Operator activation and independent
CPU/network controls remain prerequisites; neither this CLI nor configuration
checking starts/restarts services, installs policy or enables a film manifest.
Offline tests cover protocol behavior and actual fake-engine IPC loading, not
real GPU residency or production qualification.
