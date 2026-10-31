import { Type, type Static } from "typebox";
import { ComfyManagedBindingSchema } from "../comfy/managed-binding.js";
import { lstatSync, realpathSync } from "node:fs";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { OpaqueIdSchema, Sha256Schema, validateSkillSchema } from "../skill-contracts/common.js";
import { NativeCapacityRuntimeSchema } from "../host-operations/native-capacity-contracts.js";
import { HostCapacityPolicyV1Schema } from "../host-operations/capacity-contracts.js";
import { NativeManagedWorkerRegistry } from "../host-operations/native-capacity.js";
import {
  hostOperationLeaseProfileSha256,
  validateHostOperationDeclaration,
  type HostOperationAdapterV1,
  type HostOperationExecutionContextV1,
} from "../host-operations/contracts.js";
import { HostOperationCapacityAuthority } from "../host-operations/capacity-authority.js";
import { isCanonicalHostOperationExecutionContextV1 } from "../host-operations/owner.js";
import {
  VoicePrivateBindingSchema,
  VoicePrivateObservationSchema,
} from "./voice-private-client.js";
import { VoiceManagedRelay } from "./voice-managed-relay.js";
import {
  VoiceStudioHostProcessBindingSchema,
  type VoiceStudioHostProcessBinding,
} from "./runtime-voice-observer.js";
import {
  verifyVoiceHostFiles,
  VoiceHostFilePinSchema,
  type VoiceHostFilePin,
  observeVoiceHostProcess,
  observeVoiceHostGpus,
  readVoiceHostObservationFile,
} from "./voice-host-process.js";
import { parseVoiceWireJson } from "./voice-json.js";

const closed = { additionalProperties: false } as const;
const filename = Type.String({ minLength: 1, maxLength: 4096 });
export const VOICE_PREPARATION_ADAPTER = "voice-model-preparation-v1";
export const VoicePreparationRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.voice-preparation-request.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    operation_id: OpaqueIdSchema,
    // Source-custodied explicit operator brief, NOT a configurable approved=true capability.
    brief: Type.String({ minLength: 1, maxLength: 16384 }),
    bindings_sha256: Sha256Schema,
    max_runtime_ms: Type.Integer({ minimum: 1000, maximum: 1800000 }),
    cpu_cores: Type.Integer({ minimum: 1, maximum: 2 }),
    max_output_bytes: Type.Integer({ minimum: 16384, maximum: 2147483648 }),
    max_transfer_bytes: Type.Integer({ minimum: 16384, maximum: 2147483648 }),
  },
  closed
);
export type VoicePreparationRequest = Static<typeof VoicePreparationRequestSchema>;
export const VoicePreparationBindingsSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.voice-preparation-bindings.v1"),
    schema_version: Type.Literal(1),
    activation: Type.Literal("pinned_active_process"),
    project_root: filename,
    state_root: filename,
    backend_binding_id: OpaqueIdSchema,
    capacity_binding_id: OpaqueIdSchema,
    control: VoicePrivateBindingSchema,
    observer: VoiceStudioHostProcessBindingSchema,
    policy: HostCapacityPolicyV1Schema,
    native: NativeCapacityRuntimeSchema,
    comfy_services: Type.Array(
      Type.Object(
        {
          binding: ComfyManagedBindingSchema,
          source_files: Type.Array(VoiceHostFilePinSchema, { minItems: 1, maxItems: 4096 }),
          runtime_files: Type.Array(VoiceHostFilePinSchema, { minItems: 1, maxItems: 32768 }),
        },
        closed
      ),
      { maxItems: 16 }
    ),
  },
  closed
);
export type VoicePreparationBindings = Static<typeof VoicePreparationBindingsSchema>;
/** Large fixed import manifests are host configuration, not provider messages. Canonical
 * readback rejects duplicate keys without widening the voice/provider wire parser. */
export function parseVoicePreparationBindings(bytes: Uint8Array): VoicePreparationBindings {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("voice preparation bindings byte limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  const binding = validateSkillSchema(
    VoicePreparationBindingsSchema,
    value,
    "voice preparation bindings"
  );
  if (canonicalJson(binding) !== text)
    throw new Error("voice preparation bindings must be canonical");
  return binding;
}
export const VOICE_PREPARATION_REQUEST = {
  schema_version: 1,
  port_name: "request",
  artifact_kind: "voice-preparation-request",
  schema_id: "penny.voice-preparation-request.v1",
  schema_version_required: 1,
} as const;
export const VOICE_PREPARATION_RESULT = {
  schema_version: 1,
  port_name: "result",
  artifact_kind: "voice-preparation-result",
  schema_id: "penny.voice-preparation-result.v1",
  schema_version_required: 1,
} as const;
export const VoicePreparationResultSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.voice-preparation-result.v1"),
    schema_version: Type.Literal(1),
    operation_id: OpaqueIdSchema,
    request_sha256: Sha256Schema,
    observation: VoicePrivateObservationSchema,
  },
  closed
);
export function voicePreparationDeclaration(backend: string, request: VoicePreparationRequest) {
  const lease = {
    profile_id: "voice-preparation",
    profile_version: 1 as const,
    duration_ms: 30000,
    renew_after_ms: 5000,
    queue_inactivity_ms: 30000,
  };
  return validateHostOperationDeclaration({
    schema_version: 1,
    operation_kind: "voice_model_preparation",
    adapter_id: VOICE_PREPARATION_ADAPTER,
    request: VOICE_PREPARATION_REQUEST,
    result: VOICE_PREPARATION_RESULT,
    backend_binding_id: backend,
    capability_classes: ["artifact_store"],
    lease_profile: { ...lease, profile_sha256: hostOperationLeaseProfileSha256(lease) },
    operation_inactivity_ms: Math.max(30000, request.max_runtime_ms),
    max_request_bytes: 32768,
    max_input_artifacts: 0,
    max_input_bytes: 0,
    max_output_artifacts: 1,
    max_output_bytes: request.max_output_bytes,
    max_progress_events: 8,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "registered_remote_cancel_then_observe_v1",
  });
}

/** Cold inspection proves identity/exclusive admission/drain, never readiness. Warm inspection
 * additionally requires actual loaded, verified engine objects and their exact physical device. */
export class VoicePreparationObserver {
  readonly build: string;
  readonly model: string;
  readonly #stamps: readonly string[];
  constructor(
    readonly binding: VoiceStudioHostProcessBinding,
    readonly backend: string,
    readonly workers: NativeManagedWorkerRegistry,
    readonly peer_files: readonly VoiceHostFilePin[] = []
  ) {
    if (!binding.service_observations)
      throw new Error("voice preparation requires service instrumentation");
    verifyVoiceHostFiles(binding.source_files);
    verifyVoiceHostFiles(binding.runtime_files);
    if (peer_files.length) verifyVoiceHostFiles(peer_files);
    this.model = verifyVoiceHostFiles(binding.model_files);
    this.build = sha256(
      canonicalJson({
        schema_version: 1,
        source_files: binding.source_files,
        runtime_files: binding.runtime_files,
      })
    );
    this.#stamps = this.pins().map((p) => this.stamp(p.path));
  }
  private pins() {
    return [
      ...this.binding.source_files,
      ...this.binding.runtime_files,
      ...this.binding.model_files,
      ...this.peer_files,
    ];
  }
  private stamp(file: string): string {
    if (realpathSync(file) !== file) throw new Error("voice preparation pin symlink");
    const s = lstatSync(file, { bigint: true });
    if (!s.isFile()) throw new Error("voice preparation pin not regular");
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  }
  inspect(loaded: boolean) {
    const b = this.binding;
    if (this.pins().some((p, i) => this.stamp(p.path) !== this.#stamps[i]))
      throw new Error("voice preparation pin drift");
    const process = observeVoiceHostProcess(b.process),
      gpu = observeVoiceHostGpus(b.gpu);
    this.workers.requireInventory(gpu, b.gpu_uuids);
    const source = b.service_observations;
    if (!source) throw new Error("voice service observations missing");
    const s = validateSkillSchema(
      VoicePrivateObservationSchema,
      readVoiceHostObservationFile(source.path, source.max_bytes),
      "voice preparation observation"
    );
    if (
      s.observed_at_ms > Date.now() ||
      s.observed_at_ms + b.max_snapshot_age_ms <= Date.now() ||
      s.process_epoch !== process.process_epoch ||
      s.service_build_sha256 !== this.build ||
      s.model_sha256 !== this.model ||
      s.admission.mode !== "host_exclusive" ||
      s.admission.backend_binding_id !== this.backend ||
      s.admission.active_unmanaged_calls !== 0 ||
      s.admission.active_job_ids.length !== 0
    )
      throw new Error("voice preparation identity/admission/drain unproven");
    if (loaded || s.models_loaded || s.model_identity_verified || s.gpu_uuids.length) {
      if (
        !s.models_loaded ||
        !s.model_identity_verified ||
        s.engine !== "Qwen3TTSEngine" ||
        canonicalJson([...s.gpu_uuids].sort()) !== canonicalJson([...b.gpu_uuids].sort())
      )
        throw new Error("voice actual engine/model/device residency unproven");
    } else if (!["unconstructed", "Qwen3TTSEngine"].includes(s.engine))
      throw new Error("voice engine identity unexpected");
    return s;
  }
}

export class VoicePreparationAdapter implements HostOperationAdapterV1 {
  readonly adapter_id = VOICE_PREPARATION_ADAPTER;
  constructor(
    readonly request: VoicePreparationRequest,
    readonly backend_key_sha256: string,
    readonly relay: Pick<
      VoiceManagedRelay,
      "prepare" | "requirePreparationWindow" | "enter" | "preload" | "drain" | "close"
    >,
    readonly observer: Pick<VoicePreparationObserver, "inspect" | "backend">,
    readonly capacity: HostOperationCapacityAuthority
  ) {}
  inspectRequest(input: Parameters<HostOperationAdapterV1["inspectRequest"]>[0]) {
    const r = validateSkillSchema(
      VoicePreparationRequestSchema,
      parseVoiceWireJson(input.request_bytes),
      "preparation request"
    );
    if (
      canonicalJson(r) !== canonicalJson(this.request) ||
      input.directive.operation_id !== r.operation_id ||
      input.directive.identity.run_id !== r.run_id ||
      input.directive.policy_binding.backend_key_sha256 !== this.backend_key_sha256
    )
      throw new Error("voice preparation exact request binding drift");
    return {
      schema_version: 1 as const,
      operation_kind: "voice_model_preparation",
      adapter_id: this.adapter_id,
      backend_binding_id: this.observer.backend,
      backend_key_sha256: this.backend_key_sha256,
    };
  }
  private held(c: HostOperationExecutionContextV1): void {
    if (!isCanonicalHostOperationExecutionContextV1(c))
      throw new Error("voice preparation canonical owner context required");
    c.signal.throwIfAborted();
    const hold = this.capacity.inspect(c.journal.operation_record_id);
    if (!hold) throw new Error("voice preparation capacity missing");
    this.capacity.requireHeld(c.journal.operation_record_id, hold.revision);
  }
  async prepare(c: HostOperationExecutionContextV1): Promise<void> {
    this.held(c);
    await this.relay.prepare(c, () => this.held(c));
    this.relay.requirePreparationWindow(this.request.max_runtime_ms);
    this.observer.inspect(false); // MUST NOT require already-loaded models
  }
  async run(c: HostOperationExecutionContextV1) {
    // A guarded/accepted crash is never replayed as another preload. Generic owner quarantines.
    if (c.journal.lifecycle !== "lease_acquired")
      throw new Error("voice preparation remote recovery requires inspection");
    this.held(c);
    this.observer.inspect(false);
    c.beginSubmission();
    this.relay.enter(c);
    await this.relay.preload(this.request.max_runtime_ms);
    c.recordRemoteAccepted(`preload:${this.observer.inspect(true).process_epoch}`);
    await this.relay.drain();
    const observation = this.observer.inspect(true);
    const content = canonicalJson(
      validateSkillSchema(
        VoicePreparationResultSchema,
        {
          schema_id: "penny.voice-preparation-result.v1",
          schema_version: 1,
          operation_id: this.request.operation_id,
          request_sha256: sha256(c.request_bytes),
          observation,
        },
        "voice preparation result"
      )
    );
    c.recordFetched({
      schema_version: 1,
      content_sha256: sha256(content),
      byte_length: Buffer.byteLength(content),
      item_count: 1,
      poll_count: 1,
    });
    const disposition = {
      outcome: "completed",
      remote_disposition: "proven_terminal",
      lease_disposition: "released",
      retryable: false,
      reason_code: null,
    } as const;
    return {
      disposition,
      ...c.persist({
        disposition,
        operation_result: {
          contract: VOICE_PREPARATION_RESULT,
          media_type: "application/json",
          content,
        },
      }),
    };
  }
  close(): void {
    this.relay.close();
  }
}
