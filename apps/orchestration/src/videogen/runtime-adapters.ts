import {
  SourcePreparationRequestSchema,
  PREPARED_VIDEO,
  PREPARED_PCM,
} from "./runtime-preparation.js";
import { VoiceApiProfileSchema } from "./voice-api-contracts.js";
import { LocalApiOperationMeter } from "../host-operations/local-api-meter.js";
import { ComfyHttpClient } from "../comfy/client.js";
import { VoiceApiAdapter, createVoiceApiDeclaration } from "./voice-api-adapter.js";
import { VoiceApiObservationCollector } from "./voice-api-observations.js";
import { ComfyManagedBindingSchema } from "../comfy/managed-binding.js";
import { requireComfyGraphInventory } from "../comfy/graph-inventory.js";
import { VoicePrivateBindingSchema } from "./voice-private-client.js";
import type { VoiceManagedRelay } from "./voice-managed-relay.js";
import type { NativeCapacityMeter } from "../host-operations/native-capacity.js";
import {
  createNativeMediaAdapter,
  NativeMediaRequestSchema,
  SourceMediaRequestSchema,
  NATIVE_MEDIA_REQUEST,
  NATIVE_MEDIA_RESULT,
} from "./runtime-media.js";
import { Type, type Static } from "typebox";
import { readVideogenPrivateFile } from "./private-input.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema as Ref,
  validateContract,
  type HostOperationArtifactContractV1,
} from "../contracts.js";
import { OpaqueIdSchema as Id, Sha256Schema } from "../skill-contracts/common.js";
import { ConfinedMediaRunner } from "../host-operations/confined-media-runner.js";
import {
  ConfinedNativeBindingsSchema,
  ConfinedNativeRunner,
} from "../host-operations/confined-native-runner.js";
import {
  hostOperationLeaseProfileSha256,
  validateHostOperationDeclaration,
} from "../host-operations/contracts.js";
import { HOST_RECEIPTED_RESULT_CONTRACT } from "../host-operations/effect-protocol.js";
import {
  VideogenProfileV1Schema,
  VideoGenerationOperationRequestV1Schema,
  VideoReferenceUploadOperationRequestV1Schema,
} from "./contracts.js";
import { ComfyWorkerIdentityRegistry } from "../comfy/worker-identity.js";
import { StaticVideogenProfileRegistry } from "./profile-registry.js";
import {
  createComfyVideogenDeclaration,
  ComfyVideogenOperationAdapter,
} from "./operation-owner.js";
import {
  createComfyVideoUploadDeclaration,
  ComfyVideogenUploadOperationAdapter,
} from "./upload-operation.js";
import {
  MediaDecodePolicyV1Schema,
  RawMediaDecodeRequestV1Schema,
  RAW_MEDIA_REQUEST_CONTRACT,
  RAW_MEDIA_RESULT_CONTRACT,
  MEDIA_FRAME_CONTRACT,
  MEDIA_PCM_CONTRACT,
} from "./media-contracts.js";
import {
  AvMediaPolicyV1Schema,
  AvMediaRequestV1Schema,
  AV_MEDIA_REQUEST_CONTRACT,
  AV_MEDIA_RESULT_CONTRACT,
} from "./av-media-contracts.js";
import { createRawMediaDecodeAdapter } from "./media-decode.js";
import { createAvMediaDecodeAdapter } from "./av-media-adapter.js";
import {
  VoiceStudioProfileV1Schema,
  VoiceStudioTransportV1Schema,
  VoiceStudioJobRequestV1Schema,
} from "./voice-studio-contracts.js";
import { VoiceStudioAuthority } from "./voice-studio-authority.js";
import { VoiceStudioObservationCollector } from "./voice-studio-observations.js";
import { observeVoiceHostProcess } from "./voice-host-process.js";
import {
  VoiceStudioHostProcessBindingSchema,
  createVoiceStudioHostProcessObserver,
} from "./runtime-voice-observer.js";
import { createVoiceStudioAdapter, createVoiceStudioDeclaration } from "./voice-studio-adapter.js";
import { KdenliveFixtureRegistry } from "./kdenlive-registry.js";
import { createKdenliveAdapter } from "./kdenlive-adapter.js";
import {
  NativeOperationRequestSchema,
  NATIVE_REQUEST_CONTRACT,
  NATIVE_RESULT_CONTRACT,
  NATIVE_PROJECT_CONTRACT,
  NATIVE_RENDER_CONTRACT,
} from "./native-contracts.js";
import {
  createLocalDeliveryAdapter,
  DeliveryOperationRequestSchema,
  DELIVERY_REQUEST_CONTRACT,
  DELIVERY_RESULT_CONTRACT,
} from "./delivery.js";
import { LocalDeliveryFiles } from "./delivery-files.js";
import { readVideogenOwnerSelection, type VideogenOwnerSelection } from "./owner-selection.js";
import { RationalTimeSchema } from "./rational-time.js";
import type { EditHostV1 } from "./edit-decision.js";
import type { FoundationLimitsV1 } from "./bounds.js";
import type { VideogenEffectProviderV1 } from "./runtime-config.js";
import {
  createTimelineMasterAdapter,
  TIMELINE_MASTER_REQUEST,
  TIMELINE_MASTER_RESULT,
  TIMELINE_MASTER_VIDEO,
  TimelineMasterRequestSchema,
} from "./timeline-master.js";

const closed = { additionalProperties: false } as const;
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const filename = Type.String({ minLength: 1, maxLength: 4096 });
const executable = Type.Object({ path: filename, sha256: Sha256Schema }, closed);
const runtimeFile = Type.Object(
  { source: filename, target: filename, sha256: Sha256Schema },
  closed
);
export const VideogenCpuBindingsSchema = Type.Object(
  {
    bubblewrap: executable,
    prlimit: executable,
    ffmpeg: runtimeFile,
    ffprobe: runtimeFile,
    runtime_files: Type.Array(runtimeFile, { maxItems: 1024 }),
    scratch_root: filename,
    max_runtime_bytes: positive,
  },
  closed
);
export const VideogenNativeBindingsSchema = ConfinedNativeBindingsSchema;
const processPolicy = Type.Object(
  {
    max_input_bytes: positive,
    max_output_bytes: positive,
    max_writable_bytes: positive,
    max_writable_inodes: positive,
    max_diagnostic_bytes: positive,
    inactivity_ms: positive,
    max_elapsed_ms: Type.Optional(positive),
    address_space_bytes: positive,
    cpu_seconds: positive,
    max_processes: positive,
    max_open_files: positive,
  },
  closed
);
export const VideogenEditPolicySchema = Type.Object(
  {
    max_frames: positive,
    max_samples: positive,
    max_duration: RationalTimeSchema,
    sync_tolerance: RationalTimeSchema,
    max_width: positive,
    max_height: positive,
    max_abs_gain_db: positive,
  },
  closed
);
const packagePolicy = Type.Object(
  { max_files: positive, max_file_bytes: positive, max_payload_bytes: positive },
  closed
);
export const VideogenOperationPolicySchema = Type.Object(
  {
    backend_binding_id: Id,
    backend_key_sha256: Sha256Schema,
    lease_profile_id: Id,
    lease_duration_ms: positive,
    lease_renew_after_ms: positive,
    queue_inactivity_ms: positive,
    operation_inactivity_ms: positive,
    max_request_bytes: positive,
    max_input_bytes: positive,
    max_output_bytes: positive,
    max_progress_events: positive,
  },
  closed
);
const comfyBase = {
  worker_id: Type.Optional(Id),
  profiles: Type.Array(VideogenProfileV1Schema, { minItems: 1, maxItems: 64 }),
  approved_profile_sha256_by_id: Type.Record(Type.String(), Sha256Schema),
};
const comfy = Type.Union([
  Type.Object(
    {
      ...comfyBase,
      managed: ComfyManagedBindingSchema,
      inventory: Type.Object({ path: filename, sha256: Sha256Schema, max_bytes: positive }, closed),
    },
    closed
  ),
  Type.Object({ ...comfyBase, legacy_http: Type.Literal(true) }, closed),
  Type.Object(
    {
      ...comfyBase,
      assurance: Type.Literal("trusted_local_api"),
      inventory: Type.Optional(
        Type.Object({ path: filename, sha256: Sha256Schema, max_bytes: positive }, closed)
      ),
    },
    closed
  ),
]);
const native = {
  runtime: ConfinedNativeBindingsSchema,
  comparison: Type.Optional(
    Type.Object({ runtime: VideogenCpuBindingsSchema, policy: MediaDecodePolicyV1Schema }, closed)
  ),
  process_policy: processPolicy,
  edit_policy: VideogenEditPolicySchema,
  output_root_selector: Id,
  registry: Type.Object(
    {
      editor_build_digest: Sha256Schema,
      mlt_build_digest: Sha256Schema,
      fixtures: Type.Array(
        Type.Object({ path: filename, sha256: Sha256Schema, max_bytes: positive }, closed),
        { minItems: 1, maxItems: 64 }
      ),
      limits: Type.Object(
        { max_bytes: positive, max_nodes: positive, max_depth: positive, max_text: positive },
        closed
      ),
    },
    closed
  ),
};
export const VideogenAdapterManifestV1Schema = Type.Union([
  Type.Object(
    { kind: Type.Literal("video_render"), policy: VideogenOperationPolicySchema, binding: comfy },
    closed
  ),
  Type.Object(
    {
      kind: Type.Literal("reference_upload"),
      policy: VideogenOperationPolicySchema,
      binding: comfy,
    },
    closed
  ),
  Type.Object(
    {
      kind: Type.Literal("voice_job"),
      policy: VideogenOperationPolicySchema,
      binding: Type.Union([
        Type.Object(
          {
            assurance: Type.Literal("trusted_local_api"),
            profile_ref: Ref,
            profile: VoiceApiProfileSchema,
            transport: VoiceStudioTransportV1Schema,
          },
          closed
        ),
        Type.Object(
          {
            private_control: VoicePrivateBindingSchema,
            profile_ref: Ref,
            profile: VoiceStudioProfileV1Schema,
            transport: VoiceStudioTransportV1Schema,
            process_observer: VoiceStudioHostProcessBindingSchema,
          },
          closed
        ),
        Type.Object(
          {
            legacy_http: Type.Literal(true),
            profile_ref: Ref,
            profile: VoiceStudioProfileV1Schema,
            transport: VoiceStudioTransportV1Schema,
            process_observer: VoiceStudioHostProcessBindingSchema,
          },
          closed
        ),
        Type.Object(
          {
            profile_ref: Ref,
            profile: VoiceStudioProfileV1Schema,
            transport: VoiceStudioTransportV1Schema,
            process_snapshot_path: filename,
            legacy_http: Type.Literal(true),
          },
          closed
        ),
      ]),
    },
    closed
  ),
  Type.Object(
    {
      kind: Type.Literal("media_decode_extract"),
      policy: VideogenOperationPolicySchema,
      binding: Type.Union([
        Type.Object(
          {
            mode: Type.Literal("runtime"),
            source_preparation: Type.Optional(Type.Literal(true)),
            runtime: VideogenCpuBindingsSchema,
            policy_ref: Ref,
            policy: MediaDecodePolicyV1Schema,
          },
          closed
        ),
        Type.Object(
          {
            mode: Type.Literal("raw"),
            runtime: VideogenCpuBindingsSchema,
            policy_ref: Ref,
            policy: MediaDecodePolicyV1Schema,
          },
          closed
        ),
        Type.Object(
          {
            mode: Type.Literal("av"),
            runtime: VideogenCpuBindingsSchema,
            policy_ref: Ref,
            policy: AvMediaPolicyV1Schema,
          },
          closed
        ),
      ]),
    },
    closed
  ),
  Type.Object(
    {
      kind: Type.Literal("timeline_master"),
      policy: VideogenOperationPolicySchema,
      binding: Type.Object(native, closed),
    },
    closed
  ),
  Type.Object(
    {
      kind: Type.Literal("kdenlive_build_verify"),
      policy: VideogenOperationPolicySchema,
      binding: Type.Object(native, closed),
    },
    closed
  ),
  Type.Object(
    {
      kind: Type.Literal("local_delivery"),
      policy: VideogenOperationPolicySchema,
      binding: Type.Object(
        {
          edit_policy: VideogenEditPolicySchema,
          package_policy: packagePolicy,
          destinations: Type.Array(
            Type.Object(
              {
                destination_id: Id,
                root: filename,
                max_files: positive,
                max_bytes: positive,
                reserve_bytes: positive,
              },
              closed
            ),
            { minItems: 1, maxItems: 64 }
          ),
        },
        closed
      ),
    },
    closed
  ),
]);
export type VideogenAdapterManifestV1 = Static<typeof VideogenAdapterManifestV1Schema>;
/** Only policy data enters from JSON. Current identity/rights/dependencies come from the owner. */
function editHost(
  owner: VideogenOwnerSelection,
  edit_policy: Static<typeof VideogenEditPolicySchema>
): EditHostV1 {
  const h = readVideogenOwnerSelection(owner);
  return {
    ...h.gate,
    ...h.rights,
    edit_policy,
    current_dependencies: [],
    measured_source_refs: [],
    audio_sources: [],
  };
}
function localDeclaration(
  kind: string,
  adapter_id: string,
  policy: Static<typeof VideogenOperationPolicySchema>,
  request: HostOperationArtifactContractV1,
  result: HostOperationArtifactContractV1,
  outputs: readonly HostOperationArtifactContractV1[],
  network = false
) {
  const lease = {
    profile_id: policy.lease_profile_id,
    profile_version: 1 as const,
    duration_ms: policy.lease_duration_ms,
    renew_after_ms: policy.lease_renew_after_ms,
    queue_inactivity_ms: policy.queue_inactivity_ms,
  };
  return validateHostOperationDeclaration({
    schema_version: 1,
    operation_kind: kind,
    adapter_id,
    effect_protocol: "request_intent_v1",
    receipt_citing_result: HOST_RECEIPTED_RESULT_CONTRACT,
    request,
    result,
    output_contracts: [...outputs],
    backend_binding_id: policy.backend_binding_id,
    capability_classes: network
      ? ["artifact_store", "registered_loopback_http"]
      : ["artifact_store"],
    lease_profile: { ...lease, profile_sha256: hostOperationLeaseProfileSha256(lease) },
    operation_inactivity_ms: policy.operation_inactivity_ms,
    max_request_bytes: policy.max_request_bytes,
    max_input_artifacts: 128,
    max_input_bytes: policy.max_input_bytes,
    max_output_artifacts: 256,
    max_output_bytes: policy.max_output_bytes,
    max_progress_events: policy.max_progress_events,
    max_pre_acceptance_retries: 0,
    result_selection_policy: "unselected",
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "local_abort_only_v1",
  });
}
export function assembleVideogenEffects(
  values: readonly VideogenAdapterManifestV1[],
  limits: FoundationLimitsV1,
  nativeMeter?: NativeCapacityMeter,
  localMeter?: LocalApiOperationMeter
): ReadonlyMap<string, VideogenEffectProviderV1> {
  const effects = new Map<string, VideogenEffectProviderV1>();
  for (const value of values) {
    const v = validateContract(VideogenAdapterManifestV1Schema, value, "fixed videogen adapter"),
      p = v.policy;
    let provider: VideogenEffectProviderV1;
    if (v.kind === "video_render" || v.kind === "reference_upload") {
      const worker = v.binding.worker_id;
      const profiles = new StaticVideogenProfileRegistry({
        ...(worker === undefined
          ? {}
          : {
              worker_identities: new ComfyWorkerIdentityRegistry([
                {
                  worker_id: worker,
                  endpoints: [
                    ...new Map(
                      v.binding.profiles.map((profile) => [
                        canonicalJson(profile.endpoint),
                        profile.endpoint,
                      ])
                    ).values(),
                  ],
                },
              ]),
            }),
        profiles: v.binding.profiles,
        approved_profile_sha256_by_id: new Map(
          Object.entries(v.binding.approved_profile_sha256_by_id)
        ),
      });
      let approvedInventory: unknown;
      if ("managed" in v.binding) {
        if (!nativeMeter || worker !== v.binding.managed.worker.worker_id)
          throw new Error("Comfy managed native worker binding required");
        if (
          v.binding.profiles.some(
            (profile) =>
              profiles.resolve(profile.profile_id).backend_key_sha256 !== p.backend_key_sha256
          )
        )
          throw new Error("Comfy managed policy/physical worker key drift");
        nativeMeter.registerComfy(v.binding.managed);
      }
      if ("inventory" in v.binding && v.binding.inventory) {
        const bytes = readVideogenPrivateFile(
          v.binding.inventory.path,
          v.binding.inventory.max_bytes
        );
        if (sha256(bytes) !== v.binding.inventory.sha256)
          throw new Error("Comfy stored inventory digest drift");
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        for (const profile of v.binding.profiles)
          requireComfyGraphInventory(profile.source_graph, parsed);
        approvedInventory = parsed;
      }
      const binding = v.binding;
      const options = () => {
        if ("assurance" in binding) {
          if (!localMeter || !binding.worker_id)
            throw new Error("explicit API meter/worker binding required");
          return {
            profiles,
            legacy_http: true as const,
            ...(approvedInventory ? { approved_inventory: approvedInventory } : {}),
            client_factory: (
              endpoint: ConstructorParameters<typeof ComfyHttpClient>[0],
              limits: ConstructorParameters<typeof ComfyHttpClient>[1]
            ) => new ComfyHttpClient(endpoint, limits, localMeter),
          };
        }
        if (!("managed" in binding)) return { profiles, legacy_http: true as const };
        if (!nativeMeter) throw new Error("Comfy native meter missing");
        return {
          profiles,
          managed_relay: nativeMeter.comfyRelay(binding.managed.worker.worker_id),
          grant_file: binding.managed.worker.grant_file,
          approved_inventory: approvedInventory,
        };
      };
      provider =
        v.kind === "video_render"
          ? {
              declaration: createComfyVideogenDeclaration({
                ...p,
                managed: "managed" in v.binding,
                effect_protocol: "request_intent_v1",
              }),
              request_schema: VideoGenerationOperationRequestV1Schema,
              createAdapter: () => new ComfyVideogenOperationAdapter(options()),
            }
          : {
              declaration: createComfyVideoUploadDeclaration({
                ...p,
                managed: "managed" in v.binding,
                effect_protocol: "request_intent_v1",
              }),
              request_schema: VideoReferenceUploadOperationRequestV1Schema,
              createAdapter: () => new ComfyVideogenUploadOperationAdapter(options()),
            };
    } else if (v.kind === "voice_job") {
      const b = v.binding;
      if ("assurance" in b) {
        if (!localMeter) throw new Error("Voice trusted API requires compiled operation meter");
        provider = {
          declaration: createVoiceApiDeclaration(p),
          request_schema: VoiceStudioJobRequestV1Schema,
          createAdapter: (owners) => {
            if (!owners.capacity) throw new Error("Voice API current capacity owner required");
            const observations = new VoiceApiObservationCollector({
              ...b,
              owner: owners.owner,
              wire_meter: localMeter,
            });
            return new VoiceApiAdapter(
              new VoiceStudioAuthority({
                ...b,
                ...owners,
                observations,
                limits,
                capacity: owners.capacity.runtime,
                capacity_authority: owners.capacity.authority,
              })
            );
          },
        };
      } else {
        if (sha256(canonicalJson(b.profile)) !== b.profile_ref.content_digest)
          throw new Error("voice observer profile binding drift");
        // Reject process/file/profile drift at bootstrap, without GPU probes or service work.
        if ("process_observer" in b) observeVoiceHostProcess(b.process_observer.process);
        const observation_source =
          "process_observer" in b
            ? {
                process_observer: createVoiceStudioHostProcessObserver({
                  binding: b.process_observer,
                  profile_ref: b.profile_ref,
                  profile: b.profile,
                  isolation: b.transport.mode,
                }),
              }
            : { process_snapshot_path: b.process_snapshot_path };
        let managedRelay: VoiceManagedRelay | undefined;
        if ("private_control" in b) {
          if (!nativeMeter || b.transport.mode !== "trusted_tls")
            throw new Error("voice private control requires native capacity and verified TLS");
          nativeMeter.registerVoice(b.private_control, b.profile.backend_binding_id);
          nativeMeter.requireManagedBinding(
            b.private_control.worker,
            b.private_control.transfer_counter_file,
            b.profile.process_worker_id
          );
          if (
            canonicalJson(b.private_control.worker.process) !==
              canonicalJson(b.process_observer.process) ||
            b.private_control.refresh_ms >= b.private_control.worker.max_age_ms ||
            !b.process_observer.service_observations
          )
            throw new Error("voice private process/observation mapping drift");
        }
        provider = {
          declaration: createVoiceStudioDeclaration(p),
          request_schema: VoiceStudioJobRequestV1Schema,
          createAdapter: (owners) => {
            if (owners.capacity === undefined)
              throw new Error(
                "VIDEOGEN_VOICE_CAPABILITY_MISSING: concrete current capacity policy and host measurement source required"
              );
            if (nativeMeter && observation_source.process_observer !== undefined)
              observation_source.process_observer.bindManagedWorkers(nativeMeter.managedWorkers());
            if ("private_control" in b)
              managedRelay ??= nativeMeter?.voiceRelay(b.profile.process_worker_id);
            const observations = new VoiceStudioObservationCollector({
              ...(managedRelay ? { on_bytes: (n: number) => managedRelay?.countHttp(n) } : {}),
              profile_ref: b.profile_ref,
              profile: b.profile,
              transport: b.transport,
              ...observation_source,
              owner: owners.owner,
            });
            return createVoiceStudioAdapter(
              new VoiceStudioAuthority({
                ...b,
                ...owners,
                limits,
                observations,
                ...(managedRelay ? { managed_relay: managedRelay } : {}),
                capacity: owners.capacity.runtime,
                capacity_authority: owners.capacity.authority,
              })
            );
          },
        };
      }
    } else if (v.kind === "media_decode_extract") {
      const b = v.binding,
        adapter_id = "videogen.cpu-media.v1";
      const runner = new ConfinedMediaRunner(b.runtime);
      provider =
        b.mode === "runtime"
          ? {
              declaration: localDeclaration(
                v.kind,
                adapter_id,
                p,
                NATIVE_MEDIA_REQUEST,
                NATIVE_MEDIA_RESULT,
                [
                  MEDIA_FRAME_CONTRACT,
                  MEDIA_PCM_CONTRACT,
                  ...(b.source_preparation ? [PREPARED_VIDEO, PREPARED_PCM] : []),
                ]
              ),
              request_schema: Type.Union([
                NativeMediaRequestSchema,
                SourceMediaRequestSchema,
                ...(b.source_preparation ? [SourcePreparationRequestSchema] : []),
              ]),
              media: { policy_ref: b.policy_ref },
              createAdapter: (owners) => {
                if (b.source_preparation && !owners.leases)
                  throw new Error("preparation concrete lease owner required");
                return createNativeMediaAdapter({
                  ...b,
                  ...p,
                  adapter_id,
                  runner,
                  limits,
                  ...(b.source_preparation && owners.leases
                    ? {
                        preparation: {
                          runner,
                          policy: b.policy,
                          policy_ref: b.policy_ref,
                          limits,
                          owner: owners.owner,
                          custody: {
                            store: owners.store,
                            checkpointer: owners.checkpointer,
                            project_id: readVideogenOwnerSelection(owners.owner).gate.project_id,
                            leases: owners.leases,
                            limits,
                          },
                          sourceDeclaration: (kind: string) => {
                            const source = effects.get(kind);
                            if (!source) throw new Error("preparation source declaration missing");
                            return source.declaration;
                          },
                        },
                      }
                    : {}),
                });
              },
            }
          : b.mode === "raw"
            ? {
                declaration: localDeclaration(
                  v.kind,
                  adapter_id,
                  p,
                  RAW_MEDIA_REQUEST_CONTRACT,
                  RAW_MEDIA_RESULT_CONTRACT,
                  [MEDIA_FRAME_CONTRACT, MEDIA_PCM_CONTRACT]
                ),
                request_schema: RawMediaDecodeRequestV1Schema,
                createAdapter: () =>
                  createRawMediaDecodeAdapter({ ...b, ...p, adapter_id, runner, limits }),
              }
            : {
                declaration: localDeclaration(
                  v.kind,
                  adapter_id,
                  p,
                  AV_MEDIA_REQUEST_CONTRACT,
                  AV_MEDIA_RESULT_CONTRACT,
                  [MEDIA_FRAME_CONTRACT, MEDIA_PCM_CONTRACT]
                ),
                request_schema: AvMediaRequestV1Schema,
                createAdapter: () =>
                  createAvMediaDecodeAdapter({ ...b, ...p, adapter_id, runner, limits }),
              };
    } else if (v.kind === "kdenlive_build_verify" || v.kind === "timeline_master") {
      const b = v.binding,
        adapter_id =
          v.kind === "timeline_master" ? "videogen.timeline-master.v1" : "videogen.kdenlive.v1";
      const { comparison, ...nativeBinding } = b;
      const runner = new ConfinedNativeRunner(b.runtime);
      const registry = new KdenliveFixtureRegistry({
        ...b.registry,
        fixtures: b.registry.fixtures.map((f) => {
          // Registry and runner independently compare pinned bytes and strict structure.
          const bytes = readVideogenPrivateFile(f.path, f.max_bytes);
          if (bytes.length > f.max_bytes || sha256(bytes) !== f.sha256)
            throw new Error("VIDEOGEN_NATIVE_FIXTURE_DRIFT");
          return { bytes, sha256: f.sha256 };
        }),
      });
      provider =
        v.kind === "timeline_master"
          ? {
              declaration: localDeclaration(
                v.kind,
                adapter_id,
                p,
                TIMELINE_MASTER_REQUEST,
                TIMELINE_MASTER_RESULT,
                [TIMELINE_MASTER_VIDEO]
              ),
              native: { registry, edit_policy: b.edit_policy },
              request_schema: TimelineMasterRequestSchema,
              createAdapter: (owners) =>
                createTimelineMasterAdapter({
                  ...nativeBinding,
                  ...p,
                  adapter_id,
                  runner,
                  registry,
                  ...(comparison === undefined
                    ? {}
                    : {
                        comparison: {
                          runner: new ConfinedMediaRunner(comparison.runtime),
                          policy: comparison.policy,
                        },
                      }),
                  owner: owners.owner,
                  host: editHost(owners.owner, b.edit_policy),
                }),
            }
          : {
              declaration: localDeclaration(
                v.kind,
                adapter_id,
                p,
                NATIVE_REQUEST_CONTRACT,
                NATIVE_RESULT_CONTRACT,
                [NATIVE_PROJECT_CONTRACT, NATIVE_RENDER_CONTRACT]
              ),
              native: { registry, edit_policy: b.edit_policy },
              request_schema: NativeOperationRequestSchema,
              createAdapter: (owners) =>
                createKdenliveAdapter({
                  ...nativeBinding,
                  ...p,
                  adapter_id,
                  runner,
                  registry,
                  ...(comparison === undefined
                    ? {}
                    : {
                        comparison: {
                          runner: new ConfinedMediaRunner(comparison.runtime),
                          policy: comparison.policy,
                        },
                      }),
                  owner: owners.owner,
                  host: editHost(owners.owner, b.edit_policy),
                }),
            };
    } else {
      const b = v.binding,
        adapter_id = "videogen.local-delivery.v1",
        files = new LocalDeliveryFiles(b.destinations);
      provider = {
        declaration: localDeclaration(
          v.kind,
          adapter_id,
          p,
          DELIVERY_REQUEST_CONTRACT,
          DELIVERY_RESULT_CONTRACT,
          []
        ),
        request_schema: DeliveryOperationRequestSchema,
        createAdapter: (owners) =>
          createLocalDeliveryAdapter({
            ...p,
            adapter_id,
            owner: owners.owner,
            files,
            ...(localMeter ? { operation_meter: localMeter } : {}),
            host: { ...editHost(owners.owner, b.edit_policy), package_policy: b.package_policy },
          }),
      };
    }
    if (localMeter) {
      const original = provider;
      provider = {
        ...original,
        createAdapter: (owners) => localMeter.wrap(original.createAdapter(owners)),
      };
    }
    effects.set(v.kind, provider);
  }
  return effects;
}
