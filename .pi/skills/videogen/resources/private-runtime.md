# Private videogen runtime

The default exact-name skill can read an explicitly selected private JSON manifest. This enables construction and invocation; it does not install services, enable imagegen, approve rights, or qualify a film.

Set `PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE` to the caller-supplied canonical absolute path. The file must be an owner-only, nonsymlink regular file. Keep it and every deployment-specific input outside tracked Penny files. With neither this manifest nor explicit constructor providers, invocation refuses before run creation.

## Manifest contract

The closed `penny.videogen-runtime-manifest.v1` object has these fields:

| Field                         | Meaning                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_id`, `schema_version` | Exact schema ID above and version `1`.                                                                                                                                                                                                                                                                                                                                            |
| `artifacts`                   | Named immutable inputs: `id`, `kind`, `media_type`, optional `schema_id`, and a `source`. Source is either `{ "json": value }` or `{ "file": { "path": privatePath, "sha256": pinnedDigest, "max_bytes": bound } }`. File inputs have the same private-file checks; JSON files must already be canonical.                                                                         |
| `config`                      | Complete `VideogenPrivateConfigV1`: explicit activation, project envelope, rights, assets, routes, initial products, model-capability evidence and optional story stages.                                                                                                                                                                                                         |
| `recipes`                     | Complete `VideogenEffectRecipeV1` entries, including exact budgets, output contracts and backend keys. Top-level `operands` resolve selected slots. `input_bindings` can map a selected source slot to an adapter's exact input-port name; `predecessor_slot` selects the exact effect predecessor. No phase callbacks are accepted.                                              |
| `adapters`                    | Fixed compiled bindings for video rendering, reference upload, Voice Studio, raw or AV media decoding, timeline/master rendering, native construction, and local delivery. Each binding supplies its closed policy and deployment-specific pins.                                                                                                                                  |
| `result_cache_root`           | Optional pre-provisioned private exact-result cache. Controlled image operations require this cache or an explicit host cache binding. Opening it never provisions or repairs it.                                                                                                                                                                                                 |
| `capacity`                    | Required whenever any fixed adapter is configured; otherwise optional. Supplies an already-installed immutable capacity policy, exact demands, and one measurement branch: native, private `measurement_file`, or explicit `local_api` allocation/socket/owned-payload accounting described below. Missing measurements refuse at use. Opening the service never installs policy. |
| `image_children`              | Optional separate image-child authorization and finite call allowance. Each asset request includes the exact native imagegen request, approved `profile_sha256`, and bounded `cost_microcredits`. Existing imagegen host configuration and enabled activation remain required.                                                                                                    |
| `information_triggers`        | Optional allowed parent state, ordinary `child_name`, exact native `request`, and `input_slots`. The separate parent-only authority is derived from unchanged ordinary provider declarations; videogen is not added as an ordinary provider.                                                                                                                                      |

Inside JSON input values, configuration, requests and adapter bindings, `{ "$artifact": "id" }` resolves only to a manifest-declared immutable artifact. Dependencies must precede their users. Missing symbols refuse; the loader never searches a filesystem or memory for them. The complete manifest determines the recovery fingerprint. Changes require a new run, not silent rebinding.

Schemas and fixed factories are exported from `$PROJECT_ROOT/apps/orchestration/src/videogen/runtime-manifest.ts`, `runtime-config.ts`, `runtime-adapters.ts` and `runtime-voice-observer.ts`. Module paths, executable JavaScript and qualification callbacks are not manifest fields.

## Complete minimal fixture and typed builder

[The complete minimal JSON template](../../../../apps/orchestration/tests/fixtures/videogen-minimal-manifest.json) contains every required configuration field and embeds its synthetic artifact dependencies in dependency order. It has no deployment paths, concrete existing-store refs, adapters or recipes. It is an **isolated G1/reopen fixture**, not a production configuration or a way to bypass later evidence requirements. The default `skill` extension test uses this shape without injecting runtime providers and verifies real worker-session tools and exact artifact reads.

Private callers can use `buildVideogenRuntimeManifest(input)` with the complete typed `artifacts`, `config`, `recipes`, `adapters` and any optional bindings. It supplies the fixed schema identity, checks the closed JSON contract and returns an independent copy. Serialize that result with `canonicalJson` into a new owner-only private file; keep the caller's actual configuration separate from Penny. Bootstrap then resolves symbols, validates the concrete config/recipes/adapters and capacity mappings before publishing artifact inputs. JSON shape validation alone does not qualify an adapter or grant an approval.

## Native/CPU composition

Optional closed configuration fields include `import_authorization_ref`,
`script_rights_source_slots`, and `portable`. The portable policy supplies `package_id`,
`credits_ref`, `provenance_ref`, `feature_subset_ref`, `instructions_ref`, `environment`,
`environment_files` (`id`/`ref` entries), and bounded `package_policy`
(`max_files`, `max_file_bytes`, `max_payload_bytes`). Recipes may declare
`rights_source_slots`. These select existing rights sources; they do not issue clearance.
Ancestor revocation, current grants, exact approvals and settled custody still apply.

`{ "$artifact_digest": "id" }` resolves to an imported artifact's content digest;
`{ "$artifact": "id" }` resolves to its canonical reference. Both contain exactly one
key. Bootstrap JSON uses the bounded artifact-wire number representation, preventing
silent numeric changes to imported semantic references.

Native/timeline requests bind the current edit and its complete media, caption, style
and font dependencies. Compiled native production materializes products and the portable
manifest from settled native evidence—not qualification callbacks or copied project refs.
Shared state/lease owners are constructed by the service, never granted by JSON fields.
Supplied-audio admission uses the pinned CPU decoder and current consent/rights; an old
prebuilt audio-source record is not a substitute. It does not authorize generated voice.
Local CPU/native/delivery work uses settled artifact custody rather than the network
capture cache; network image children retain their required cache.

## Current-source preparation and authored choices

`config.brief_context_refs` optionally selects 1–32 unique exact artifacts for
`brief_analysis`, in order as `context-0`, `context-1`, and so on. Select only the
relevant existing author brief, story/script choices, saved-voice selection,
style or board inputs. Manifest `$artifact` symbols work here as elsewhere.
Admission verifies each exact ref and its bytes before run creation; dispatch
applies the existing aggregate input count/byte bounds. No context is discovered
from initial-product names, private recipes, backend configuration or memory.
These are task material, not proof of rights, approval, recorded performance or
playback. Omission preserves request/Q/L-only analysis; it does not imply that
host-only selections are visible to the worker. Changing the selection requires
a new run, not rebinding a retained terminal.

`config.authored_products` may supply exact `story_plan`, `script_text` and
`animatic_plan` inputs. The host validates and seals those author choices through
the existing continuation; it does not create worker receipts or accept authored
review results. Objective and quality workers, G1–G5 and the seven completion
predicates remain unchanged.

Inert `penny.videogen-look-voice-template.v1` and
`penny.videogen-native-build-template.v1` inputs carry author/build choices without
inventing a performance, edit, resource closure or accepted master. Their full
products are constructed only from current selected runtime operands. Existing
full templates remain supported.

A `media_decode_extract` binding with `mode: "runtime"` can explicitly select
`source_preparation: true`. This extends that existing operation, not the set of
seven operation kinds. Its preparation request binds `subject_id`, `media_ref`,
`source_result_ref`, `source_receipt_ref`, `decode_policy_ref` and one closed
`preparation` choice. Exact input ports are `media`, `source-result`,
`source-receipt`, `decode-policy`, in that order.

- `avc_import` specifies width, height, frame count, fps and maximum bytes. It
  checks the original consumed render operation and current rights/selection,
  performs complete confined decoding and **lossy** canonical AVC normalization,
  and persists separate canonical bytes and the transformation record. A following
  ordinary media recipe decodes the newly selected clip. Raw producer bytes and
  their original receipt are not rewritten.
- `pcm_silence_pad` specifies a rational `duration`. It preserves every canonical
  PCM source sample and appends zeros only. Trimming, resampling, fractional sample
  endpoints and oversized output refuse. A longer performance needs a real timing
  decision, not silent speech removal. Audio evidence retains unassessed listening,
  voice identity and word alignment.

An explicitly selected asset-stage media-preparation recipe for a declared asset
is included in the G1 preview scope before approval. Draft/final recipes and
unrelated subjects cannot add preview authority; ordinary use-time checks remain.

`config.single_shot_edit` is an explicit bounded one-shot author policy: shot,
voice and board asset IDs, canvas, duration, and caption/style/notes refs. It
constructs animatic and rough edits from current narration measurements and the
accepted draft. It requires the full measured audio endpoint; it neither loops,
freezes, stretches nor black-pads generated picture. Native requests then derive
their exact media/font/caption resource closure from the selected edit. This
construction is not an audio, picture or legal review.

## Normal trusted-local APIs (no service instrumentation)

Select this branch explicitly when the operator trusts the existing local Voice and
Comfy services but has not installed Penny's managed admission/observation integration.
It uses their normal HTTP APIs; it neither restarts them nor reads privileged process
state, changes network namespaces/CPU quotas, preloads every model, or installs patches.
It is not an automatic fallback from a failed managed binding.

The closed bindings are:

- Voice: `assurance: "trusted_local_api"`, `profile_ref`, verified
  `transport`, and the existing media `policy`. The profile schema is separately named
  `penny.videogen-voice-api-profile.v1`; it does not accept a native model digest or
  claim a process certificate. `profile.process_worker_id` names logical serialized API capacity.
- Comfy video/upload: `assurance: "trusted_local_api"`, `worker_id`, exact approved
  `profiles` and `approved_profile_sha256_by_id`, plus the existing operation `policy`.
  An optional pinned `inventory` file (`path`, `sha256`, `max_bytes`) validates the
  complete source/prepared graph and is compared with current node contracts.
  This uses the fixed bounded Comfy client, not a caller-selected HTTP implementation.
- Capacity: `{ "policy": ..., "local_api": { ...meter binding... }, "demands": [...] }`.
  Policy `external_work_policy` must be `penny_serialized_api`. The binding declares
  `assurance`, exact resource IDs, their allocated `cpu_slots`/`gpu_slots`, explicit
  `storage_resource_id`/`network_resource_id`, finite internal `tariffs` and
  `max_socket_observations`. Each meter resource multiplies its slot allocation by the held demand slots. Every effect
  still has an ordinary exact capacity demand and
  fenced hold. CPU/native/delivery effects in this manifest use the same collector.
  Explicit storage/network carriers may have zero compute allocation; their byte
  measurements do not thereby become CPU/GPU usage.

Inspect exported JSON schemas from the built CLI rather than writing JavaScript:

```sh
node apps/orchestration/dist/videogen-runtime-cli.js --api-schemas
```

`bind-api --requestfile=PATH --outputfile=PATH` accepts the exported `binding_request` schema, inspects
only bounded GET endpoints through the selected verified transport, and atomically writes a new
canonical owner-only JSON fragment into a caller-provisioned owner-only directory. It
never overwrites an existing file. Without `--outputfile` it emits the fragment on stdout. Its output contains `artifacts`, `adapter`, `inspection`, `assurance` and explicit
unknowns. Import its artifact declarations, use the returned adapter, and bind the recipe to the exact runtime-approved script/chunk plan. The
fragment is not a complete film manifest, an approval, or evidence of speech quality.

`inspect-comfy --requestfile=PATH --outputfile=NEW_PATH` accepts the exported
`comfy_inspection_request` (exact profile), performs bounded GET `/object_info`,
validates the complete source graph and atomically pins its selected node contracts.
It submits no graph and establishes neither model residency nor generation support.
HTTP requires literal isolated loopback; trusted TLS retains CA, name and exact
certificate-pin verification. Never disable TLS verification to make a binding work.

Voice checks the selected saved voice and sample bytes, then records exact narration
creation, the original accepted job response, exact terminal readback and fetched WAV.
The fixed materializer consumes the settled receipt and verifies correlation, immutable
coverage, WAV/PCM bytes, current rights and consent. It cannot manufacture word alignment,
intelligibility, speaker identity or human playback approval. API coverage labels resolved
runtime voice, fallback use, per-chunk execution and external-work exclusion as **unknown**.
A completed trusted producer job is not a physical GPU-drain certificate. Cooperative
`cancelled` alone leaves the original hold quarantined; ambiguous create/start never
repeats the mutation. Warm/reopened final usage is read back, not resampled.

### What the API meter actually charges

The compiled collector stores cumulative counters and final snapshots in the existing
immutable artifact store, tied to operation/request/capacity request/fence. It observes:

- wall-clock allocated CPU/GPU slot-milliseconds, **not** actual CPU execution or GPU
  kernels, utilization, memory occupancy or cross-service exclusion;
- actual bidirectional socket bytes, including TLS records/handshake for Voice TLS,
  **not** internet-egress bills or network-interface packet totals;
- exact retained original cache payload, registered observation/result artifacts and
  verified owned delivery-file lengths, **not** recursive disk scans or transient peak
  scratch usage;
- explicitly configured internal tariffs over those units, **not** currency, energy,
  invoices or provider pricing. Engine-step usage remains unknown and uncharged.

Counters/fences survive validated owner adoption. A socket left unfinished by a crash
cannot receive a fabricated final zero; it blocks settlement. Missing final measurement
or uncertain remote work still blocks consumption and keeps the hold. Exclusion applies
only among Penny's serialized API work; unrelated/manual service calls remain unknown.
Keep this assurance distinct from the stronger managed/native branch below.

### Explicit unused-policy version selection

Startup still refuses policy drift. If a retained catalog has no capacity records,
snapshots, queue entries, active backend leases or quarantine, the operator may explicitly
select a new immutable policy version without deleting its predecessor:

```sh
node apps/orchestration/dist/videogen-runtime-cli.js --api-schemas
node apps/orchestration/dist/videogen-runtime-cli.js install-policy-version --requestfile=PATH
```

The request pins `state_root`, `expected_policy_sha256`, explicitly selected `binding_ids`
and the complete new `policy`. The command atomically preserves the original policy in
that same catalog and compare-and-sets the new selection. It refuses any quota/reserve
change, changed resource inventory or unselected binding, existing admissions, stale digest,
or reused policy ID. This is an explicit policy write, not a bootstrap action; review and
back up the selected catalog first. No DDL, timer, cleanup, hold release or migration is
performed. Older binaries refuse the version envelope. Existing immutable policy bytes
and history are retained; this command was not run against a production catalog by tests.

## Native voice observation

The host observation-source contract defines exactly one `process_snapshot_path` or
`process_observer`. Default-manifest adapter composition must use this same closed contract
and compiled factory; defining a JSON schema alone does not wire an adapter.
The native branch uses `VoiceStudioHostProcessBindingSchema`: `process` pins PID, boot ID,
start ticks, executable path/digest and working directory; `source_files`, `runtime_files`
and `model_files` pin exact ordered file manifests; `gpu` pins the probe executable and
bounded timeout/output; `gpu_uuids` maps physical devices; `max_snapshot_age_ms` bounds age.
Optional `service_observations: { path, max_bytes }` selects only the compiled bounded,
canonical, owner-private file reader. Profile identity and isolation derive from the
separate profile/transport binding. No shell arguments, module imports, callbacks or
configured readiness flags are accepted.

The native observer verifies file/build/model pins at construction and rechecks native and
service facts at use. Without private runtime instrumentation it reports not-ready. Unloaded
or unverified models, uncontrolled admission, unknown unmanaged calls, conflicting GPU
processes and missing actual job/chunk/resolved-voice records cannot become readiness or
coverage proof. Health, selected voice metadata and on-disk model files alone are insufficient.
Changing deployed source, models or process identity requires fresh pins and profile selection;
the loader neither applies instrumentation nor loads models.

## Optional work and recovery

Informational children run only at the six declared optional parent states. Their exact result returns to that parent as the optional `information` input. The request plus exact configured inputs determine the call key. Image and informational calls have separate allowances; both retain serial depth-one execution and the existing project-concurrency boundary.

An objective verifier can declare two distinct supplied `contradiction_slots`. The owner captures those exact inputs, requests evidence synthesis, and reruns the original verifier with the synthesis result. Synthesis grants neither approval nor a PASS. Unresolved synthesis or a repeated identical conflict stops non-positive.

Image requests retain the proposed G1 intent; reviewed image results bind the separately approved current intent. The parent prepares a continuation from the exact recorded child terminal before atomic consumption, without treating an unconsumed terminal as permission to repeat the child. Native, delivery and timeline result consumption also reruns concrete inspection; historical result bytes are not current authority.

## What remains unqualified

Offline tests prove default skill-tool manifest loading through G1/reopen, fixed JSON native-observer construction and not-ready refusal, informational-child completion, bounded synthesis, serial reviewed image revisions/reopen, and isolated G1–G5 publication. A separately pinned native/CPU test exercises the complete default JSON composition with actual raw-to-canonical AVC preparation, current-measurement one-shot edits, inert look/native templates, decoding, editor rendering, exact frame/PCM comparison, portable packaging, SQLite-owner reopen recovery and local delivery/replay. Content, reviews, generation backend, rights and some resource/metering facts remain synthetic. This does not qualify a production film, deployed metering, audible performance, production legal clearance or all 18 production routes. Native results marked `constructed_unqualified` still cannot complete positively.

## Real native/CPU verification

Use `apps/orchestration/vitest.videogen-native-cpu.config.ts` with
`PENNY_VIDEOGEN_NATIVE_CPU=1`. Supply caller-selected pinned inputs through
`VIDEOGEN_NATIVE_TEST_BINDINGS`, `VIDEOGEN_NATIVE_TEST_FONT`,
`VIDEOGEN_NATIVE_TEST_FIXTURES` (path/digest entries) and
`VIDEOGEN_MEDIA_TEST_BINDINGS` (CPU binding JSON). The default-flow fixture additionally
requires `VIDEOGEN_NATIVE_TEST_OUTPUT` and a package-resource inventory: either
`VIDEOGEN_NATIVE_TEST_PRIOR_RAW` or `VIDEOGEN_NATIVE_TEST_PLUGIN_INVENTORY`
(a bounded JSON array of observed plugin digests, each present in the native pins).
This selects package dependencies, never an earlier qualification verdict.
`VIDEOGEN_NATIVE_TEST_RETAIN=1` preserves its temporary project. Select the default-flow
test explicitly when only that test is intended; missing prerequisites refuse, not skip.

That test checks all five gates, exact playback-attestation plumbing, native/delivery
wrapper and consume crashes, immutable settled evidence, delivery replay without recopy,
and cancellation before adapter entry. Both SQLite owners close and reopen at crash
boundaries. Passing proves the pinned local composition, not production readiness.

## Managed Voice private control and operator entrypoint

The compiled `voice_job` binding now has a `private_control` variant. It uses a
persistent, same-UID, exact-PID AF_UNIX connection for acquire/bind/renew, narration
creation, generation and cancellation. TLS HTTP is read-only on this path. The
old HTTP-mutation variants require explicit `legacy_http: true`; they do not
implement managed compute admission.

`private_control` supplies `socket_path`, `checker_socket_path`, pinned `python`
(`path`/`sha256`), `helper_sha256`, `worker`, `transfer_counter_file` and
`refresh_ms`. The worker includes the exact native process, gate build,
state/grant files and freshness bound from the native capacity schema. The
counter path contains exactly one `{operation_record_id}` token and must match
the native meter's network counter. The process observer must select the actual
service observation export and match the same worker process. Use distinct
owner-private paths; no path or process identity is inferred. The fixed helper
is copied beside compiled JavaScript during the orchestration build.

From `$PROJECT_ROOT`, build and inspect the actual closed control-binding schema:

```sh
bun run --cwd apps/orchestration build
node apps/orchestration/dist/videogen-runtime-cli.js --voice-binding-schema
```

Supply the complete manifest above as a canonical owner-private file, with an
already installed capacity policy and actual native CPU/GPU/worker/transfer
bindings. Configure the instrumented Voice service separately with its own
owner-private configuration before starting it through the operator's existing
service manager. Source, process, runtime and model pins must describe that
actual deployment; JSON shape validation cannot establish them.

With caller-supplied `OPERATOR_PROJECT_ROOT`, `PRIVATE_RUNTIME_MANIFEST` and
`PRIVATE_REQUEST` paths, the production service entrypoint is:

```sh
export PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE="$PRIVATE_RUNTIME_MANIFEST"
node "$PROJECT_ROOT/apps/orchestration/dist/videogen-runtime-cli.js" \
  --check --project-root="$OPERATOR_PROJECT_ROOT"
node "$PROJECT_ROOT/apps/orchestration/dist/videogen-runtime-cli.js" \
  --execute --project-root="$OPERATOR_PROJECT_ROOT" < "$PRIVATE_REQUEST"
```

`--check` constructs and closes the same `OrchestrationService` as `--execute`.
It validates bindings and may materialize immutable manifest artifacts into the
already initialized private state; it is not a read-only readiness check.
`--execute` accepts one existing orchestration request, including exact responses
to the normal approval gates. Neither mode installs policy, starts/restarts a
service, fabricates approvals, or bypasses G1. The older generic orchestration
CLI is not this fixed videogen service composition.

After the real host hold, the owner acquires actual exclusive Voice admission
and proves drain before the native baseline. Only after the durable submission
guard does it enter the native grant window. The service calls back to the live
catalog authority at reservations and nested engine boundaries; a copied grant
or timer is not permission. Exact approved text/voice projection is enforced by
the compiled relay. Actual control/callback frames and request-specific socket read/write counters
from TLS connections are exported under the exact operation, request, capacity
request and fence binding. These are bidirectional application/socket measurements,
not NIC packet capture, Internet-egress billing or CUDA transfer measurements. Control
handshake traffic before the measurement window is reported separately, not
misrepresented as operation-window traffic or provider billing.

Drain must be proven before CLOSED publication and capacity release. A cancel
acknowledgement, a terminal HTTP job or a disconnected bridge is not drain proof.
Loss, release or expiry of a capacity-bound Voice owner faults service admission
closed, including manual routes. Recovery requires independently verified drain
and an operator-managed restart with fresh process pins; reconnecting a fresh
bridge does not clear the fault. No automatic restart is performed.

## Explicit bounded cold preparation

`videogen-runtime-cli prep --requestfile=PATH` runs the separate compiled
`voice-preparation` management registration. It has no model workers, generic
skill package, narration request, G1 approval or rights authority. The request
file is a canonical owner-private `penny.voice-preparation-cli.v1` object with
`schema_version: 1`, `bindings_file` and `request`. Inspect both closed contracts
with `--prep-schema`; no handwritten JavaScript provider is needed.

The request binds `run_id`, `operation_id`, the explicit operator `brief`,
`bindings_sha256`, `max_runtime_ms`, `cpu_cores`, `max_output_bytes` and
`max_transfer_bytes`. Its finite ceilings derive the exact capacity demand;
protected finishing reserves are not changed. Actual CPU quota, effective cgroup
CPU set and process affinity must fit the request. Every managed worker/meter
process must inhabit an actual loopback-only network namespace. Caller flags are
not proof of these controls. Tariffs are 1 internal unit per allocated GPU-slot
millisecond and per allocated CPU-slot millisecond, derived from native monotonic
allocation windows and held slots. Actual cgroup CPU usage is retained separately.
These units are never currency, invoices or claimed energy measurements.

Bindings must have `activation: pinned_active_process`, exact project/state
roots, the installed shared policy, native meters, Voice private control and
observer pins. Each `comfy_services` entry carries the compiled private binding
and fixed complete source/runtime file manifests. The admin gate source must
appear in that manifest. Missing activation, process pins, peers, meters or
current policy refuses; the CLI neither initializes nor migrates state.

The engine records the explicit brief and exact immutable request/bindings in
its existing project journal. The generic host owner obtains its current global
backend fence and atomic multi-resource hold before closing every overlapping
service and taking the native measurement baseline. Cold inspection requires
current process/build/model-file pins, exclusive admission, zero unmanaged calls
and zero active jobs, **not** already-loaded models or a nonempty residency UUID
list. This grants preparation only; ordinary narration readiness stays strict.

Only after the durable submission guard and current native grant does the relay
send owned `preload`. Success requires the service's actual verified
`Qwen3TTSEngine` model objects on the exact devices and matching model digests,
same-epoch drain, real transfer counters and native final measurements before
settlement and consumption. Partial load, uncertain drain and guarded crash keep
the same operation quarantined; reopening never repeats preload or invents a
zero final reading.

Preload is synchronous on the existing owned socket. Its configured bound must
fit strictly inside the observed control-lease interval, including the refresh
margin; an oversized window refuses before submission. A lost reply or timeout
is not drain proof. This deliberately does not claim renewable progress during
an opaque load.

Runtime import manifests permit up to 32,768 exact files, while source/model
lists retain their existing bounds. Canonical private binding files have an
8 MiB ceiling; provider-message parser limits are unchanged. Keep complete
installed-package import manifests and local-only model trees under caller
custody; no model download or automatic multi-gigabyte copy is performed.

The isolated real-process tests call an actual fake engine loader through IPC
and exercise guarded preparation, strict cold/warm observation, failure,
quarantine, metering and reopen. They do not qualify real GPU residency,
production shared-GPU exclusion, audible output or a film. Do not enable the
private production film manifest before the Comfy coordinator and all deployment
pins and independent controls are valid.

## Managed Comfy video bindings

The fixed `video_render` and `reference_upload` adapter bindings select exactly one
of `managed` or explicit `legacy_http: true`. They retain `profiles`, approved profile
digests and the optional historical worker key; managed mode requires `worker_id` to
match `managed.worker.worker_id`. It requires native capacity, not a measurement-file
substitute. These branches cannot select JavaScript modules or callbacks.

`managed` uses `ComfyManagedBindingSchema`: exact native `worker` (process/build,
state/grant paths and freshness), `backend_uid`, `socket_path`, pinned `python`,
pinned `helper` (`path`, `sha256`, `package_sha256`) and `transfer_counter_file` with
one `{operation_record_id}` token matching the native meter. `inventory` is a pinned
owner-private file (`path`, `sha256`, `max_bytes`) containing actual selected object-info
node contracts. Source and prepared graphs are fully checked against it. Current backend
contracts must match; nested dynamic-combo inputs stay required and enum-checked.
A literal dotted input name is not filesystem or JavaScript traversal authority.
Image profile syntax and model/endpoint authority are unchanged.

The canonical owner uses the same native collector/global catalog to close **all**
registered overlapping services before baseline GPU observation. Missing bridges refuse,
even for apparently inactive processes. Only after that closure and exact operation-bound
transport initialization does it capture the native baseline, guard submission and issue
one grant. Comfy receives only the approved canonical graph through authenticated private
IPC. The strict HTTP client is read-only for managed rendering and meters actual one-use
socket counters; it waits for socket closure before return. Exact job/task/device and socket
drain precede CLOSED, final measurements and settlement. Refreshing gate observations is
not productive-work evidence. Loss, ambiguous submission, expiry or incomplete final
accounting retains the hold; no automatic restart or manual takeover is provided.

Offline tests use real IPC credentials, catalog/journal/grant transitions and socket
counters, with fake compute and controlled physical probes. They do not qualify GPU
execution, cross-UID native inspection, model residency or production activation.
An installer must independently authorize/review the source-pinned service patch and
provision narrow private IPC/native observation. No privilege change is performed by loading
the manifest. Unobservable cross-UID services cannot qualify through self-reported identity.
