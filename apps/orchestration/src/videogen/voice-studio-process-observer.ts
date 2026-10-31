import { NativeManagedWorkerRegistry } from "../host-operations/native-capacity.js";
import { lstatSync, realpathSync } from "node:fs";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import {
  VoiceStudioProfileV1Schema,
  VoiceStudioCoverageV1Schema,
  VoiceStudioReadinessV1Schema,
  type VoiceStudioReadinessV1,
  type VoiceStudioProfileV1,
  type VoiceStudioCorrelationV1,
  type VoiceStudioJobRequestV1,
  type VoiceStudioNarrationV1,
  type VoiceStudioChunkPlanV1Schema,
} from "./voice-studio-contracts.js";
import type { Static } from "typebox";
import {
  observeVoiceHostGpus,
  observeVoiceHostProcess,
  readVoiceHostObservationFile,
  verifyVoiceHostFiles,
  VoiceHostServiceObservationSchema,
  type VoiceHostFilePin,
  type VoiceHostProcessPin,
  type VoiceHostGpuProbe,
} from "./voice-host-process.js";

export interface VoiceStudioServiceObservationProtocol {
  /** Trusted host injection; returns raw facts from the pinned service, never caller readiness.
   * Must be bounded/cooperative, with no generation or side effects. */
  read(): unknown;
}
export class VoiceStudioServiceObservationFile implements VoiceStudioServiceObservationProtocol {
  constructor(
    readonly path: string,
    readonly max_bytes: number
  ) {}
  read(): unknown {
    return readVoiceHostObservationFile(this.path, this.max_bytes);
  }
}
export interface VoiceStudioProcessObserverBindingsV1 {
  readonly profile_ref: ArtifactRef;
  readonly profile: VoiceStudioProfileV1;
  readonly process: VoiceHostProcessPin;
  readonly source_files: readonly VoiceHostFilePin[];
  readonly runtime_files: readonly VoiceHostFilePin[];
  readonly model_files: readonly VoiceHostFilePin[];
  readonly gpu: VoiceHostGpuProbe;
  readonly gpu_uuids: readonly string[];
  readonly isolation: "trusted_tls" | "isolated_loopback";
  readonly max_snapshot_age_ms: number;
  readonly service_observations?: VoiceStudioServiceObservationProtocol;
  readonly managed_workers?: NativeManagedWorkerRegistry;
}
export interface VoiceStudioObservedJobInputV1 {
  readonly correlation: VoiceStudioCorrelationV1;
  readonly request: VoiceStudioJobRequestV1;
  readonly narration: VoiceStudioNarrationV1;
  readonly plan: Static<typeof VoiceStudioChunkPlanV1Schema>;
}
export class VoiceStudioNotReadyError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Voice Studio currently not ready: ${reasons.join(", ")}`);
  }
}
/** Concrete host exporter/qualifier. Native identity, file pins and GPU membership are observed,
 * not supplied as PASS booleans. Loaded-model/dispatch/chunk facts need private service hooks.
 * Absence is renewable not-ready, not a permanently disabled adapter or health-based readiness. */
export class VoiceStudioProcessObserver {
  readonly #b: VoiceStudioProcessObserverBindingsV1;
  readonly #stamps: ReadonlyMap<string, string>;
  #managed: NativeManagedWorkerRegistry | undefined;
  constructor(b: VoiceStudioProcessObserverBindingsV1) {
    if (
      new.target !== VoiceStudioProcessObserver ||
      !Number.isSafeInteger(b.max_snapshot_age_ms) ||
      b.max_snapshot_age_ms < 1 ||
      b.max_snapshot_age_ms > 300000
    )
      throw new Error("voice observer bindings invalid");
    if (
      sha256(canonicalJson(b.profile)) !== b.profile_ref.content_digest ||
      !b.gpu_uuids.length ||
      new Set(b.gpu_uuids).size !== b.gpu_uuids.length
    )
      throw new Error("voice observer profile/GPU binding drift");
    validateSkillSchema(ArtifactRefSchema, b.profile_ref, "voice observer profile ref");
    validateSkillSchema(VoiceStudioProfileV1Schema, b.profile, "voice observer profile");
    if (
      b.gpu_uuids.length !== b.profile.gpu_resource_ids.length ||
      b.gpu_uuids.some((u) => !/^GPU-[a-f0-9-]+$/u.test(u))
    )
      throw new Error("voice observer physical GPU mapping invalid");
    const before = new Map(
      [...b.source_files, ...b.runtime_files, ...b.model_files].map((p) => [
        p.path,
        this.stamp(p.path),
      ])
    );
    verifyVoiceHostFiles(b.source_files);
    verifyVoiceHostFiles(b.runtime_files);
    const build = {
      schema_version: 1,
      source_files: b.source_files,
      runtime_files: b.runtime_files,
    };
    if (
      sha256(canonicalJson(build)) !== b.profile.service_build_ref.content_digest ||
      verifyVoiceHostFiles(b.model_files) !== b.profile.model_sha256
    )
      throw new Error("voice observer build/model manifest drift");
    this.#managed = b.managed_workers;
    this.#stamps = new Map(
      [...b.source_files, ...b.runtime_files, ...b.model_files].map((p) => [
        p.path,
        this.stamp(p.path),
      ])
    );
    for (const [file, stamp] of before)
      if (this.#stamps.get(file) !== stamp)
        throw new Error("voice pins changed during binding verification");
    // Service protocol retains its host capability; all plain private binding data is frozen by copy.
    if (
      b.managed_workers !== undefined &&
      !(b.managed_workers instanceof NativeManagedWorkerRegistry)
    )
      throw new Error("voice managed worker authority must be concrete");
    const { service_observations, managed_workers, ...data } = b;
    this.#b = Object.freeze({
      ...structuredClone(data),
      ...(service_observations ? { service_observations } : {}),
      ...(managed_workers ? { managed_workers } : {}),
    });
    Object.freeze(this);
  }
  /** Attach the canonical runtime after bootstrap WITHOUT recreating file-verification stamps. */
  bindManagedWorkers(registry: NativeManagedWorkerRegistry): void {
    if (
      !(registry instanceof NativeManagedWorkerRegistry) ||
      (this.#managed !== undefined && this.#managed !== registry)
    )
      throw new Error("voice managed registry binding drift");
    this.#managed = registry;
  }
  requireBinding(
    ref: ArtifactRef,
    profile: VoiceStudioProfileV1,
    isolation: "trusted_tls" | "isolated_loopback"
  ): void {
    if (
      canonicalJson(ref) !== canonicalJson(this.#b.profile_ref) ||
      canonicalJson(profile) !== canonicalJson(this.#b.profile) ||
      isolation !== this.#b.isolation
    )
      throw new Error("voice process observer binding drift");
  }
  private stamp(file: string): string {
    if (realpathSync(file) !== file) throw new Error("voice pinned file path changed");
    const s = lstatSync(file, { bigint: true });
    if (!s.isFile()) throw new Error("voice pinned file disappeared");
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  }
  private native() {
    for (const [file, stamp] of this.#stamps)
      if (this.stamp(file) !== stamp)
        throw new Error("voice pinned file changed; reverify binding");
    const process = observeVoiceHostProcess(this.#b.process),
      gpu = observeVoiceHostGpus(this.#b.gpu);
    return { process, gpu };
  }
  inspect() {
    const facts = this.native(),
      b = this.#b,
      reasons: string[] = [];
    for (const uuid of b.gpu_uuids)
      if (!facts.gpu.uuids.includes(uuid)) reasons.push("pinned_gpu_missing");
    if (this.#managed) {
      try {
        this.#managed.requireWorker(
          b.profile.process_worker_id,
          facts.process.process_epoch,
          b.gpu_uuids
        );
        this.#managed.requireInventory(facts.gpu, b.gpu_uuids);
      } catch (error) {
        reasons.push(
          `managed_gpu_admission_unproven: ${error instanceof Error ? error.message : "observation refused"}`
        );
      }
    } else if (
      facts.gpu.applications.some((p) => b.gpu_uuids.includes(p.uuid) && p.pid !== b.process.pid)
    )
      reasons.push("external_gpu_process_present");
    if (!b.service_observations)
      return {
        facts,
        reasons: [...reasons, "service_runtime_instrumentation_required"],
        service: null,
      };
    const service = validateSkillSchema(
      VoiceHostServiceObservationSchema,
      b.service_observations.read(),
      "voice service private observation"
    );
    const now = Date.now();
    if (service.observed_at_ms > now || service.observed_at_ms + b.max_snapshot_age_ms <= now)
      reasons.push("service_snapshot_stale_refresh_required");
    if (
      service.process_epoch !== facts.process.process_epoch ||
      service.service_build_sha256 !== b.profile.service_build_ref.content_digest ||
      service.model_sha256 !== b.profile.model_sha256 ||
      service.engine !== b.profile.engine
    )
      reasons.push("service_process_build_model_identity_drift");
    if (canonicalJson([...service.gpu_uuids].sort()) !== canonicalJson([...b.gpu_uuids].sort()))
      reasons.push("loaded_device_binding_drift");
    if (!service.model_identity_verified) reasons.push("loaded_model_identity_unverified");
    if (!service.models_loaded) reasons.push("models_unloaded_authorized_load_required");
    if (
      service.admission.mode !== "host_exclusive" ||
      service.admission.backend_binding_id !== b.profile.backend_binding_id ||
      service.admission.active_unmanaged_calls !== 0
    )
      reasons.push("exclusive_service_admission_not_established");
    return { facts, reasons, service };
  }
  assertCurrentReady(readiness: VoiceStudioReadinessV1, owned_job_ids: readonly string[]): void {
    const current = this.inspect();
    if (current.reasons.length || !current.service)
      throw new VoiceStudioNotReadyError(current.reasons);
    if (
      current.facts.process.process_epoch !== readiness.process_epoch ||
      current.service.admission.active_job_ids.some((id) => !owned_job_ids.includes(id))
    )
      throw new VoiceStudioNotReadyError(["process_epoch_or_active_job_ownership_drift"]);
  }
  snapshot(input?: VoiceStudioObservedJobInputV1) {
    const observed = this.inspect(),
      b = this.#b,
      s = observed.service;
    if (observed.reasons.length || !s) throw new VoiceStudioNotReadyError(observed.reasons);
    const c = input?.correlation;
    if (s.admission.active_job_ids.some((id) => id !== c?.job_id))
      throw new VoiceStudioNotReadyError(["another_service_job_active"]);
    const readiness = validateSkillSchema(
      VoiceStudioReadinessV1Schema,
      {
        schema_id: "penny.videogen-voice-studio-readiness.v1",
        schema_version: 1,
        profile_sha256: b.profile_ref.content_digest,
        service_build_ref: b.profile.service_build_ref,
        model_sha256: b.profile.model_sha256,
        process_worker_id: b.profile.process_worker_id,
        process_epoch: observed.facts.process.process_epoch,
        engine: s.engine,
        observed_at_ms: s.observed_at_ms,
        expires_at_ms: s.observed_at_ms + b.max_snapshot_age_ms,
        isolation: b.isolation,
        external_work: "excluded",
        synthesis: "model_loaded_and_verified",
      },
      "host observed voice readiness"
    );
    const coverage = [];
    if (input) {
      const { correlation: c, request: r, narration: n, plan } = input;
      const matches = s.jobs.filter(
          (j) => j.job_id === c.job_id && j.narration_item_id === c.narration_item_id
        ),
        job = matches[0];
      if (
        !job ||
        matches.length !== 1 ||
        job.status !== "completed" ||
        c.process_epoch !== readiness.process_epoch ||
        c.profile_sha256 !== b.profile_ref.content_digest ||
        c.request_sha256 !== sha256(canonicalJson(r)) ||
        job.narration_sha256 !== sha256(canonicalJson(n)) ||
        n.id !== c.narration_item_id ||
        n.voice_profile_id !== b.profile.voice_id ||
        n.source_text !== plan.source_text ||
        r.voice_id !== b.profile.voice_id ||
        canonicalJson(r.profile_ref) !== canonicalJson(b.profile_ref) ||
        canonicalJson(plan.script_ref) !== canonicalJson(r.script_ref) ||
        n.chunk_count !== plan.chunks.length ||
        job.chunks.length !== plan.chunks.length ||
        canonicalJson(r.expected_chunk_ids) !== canonicalJson(plan.chunks.map((p) => p.chunk_id)) ||
        new Set(job.chunks.map((p) => p.segment_id)).size !== job.chunks.length
      )
        throw new VoiceStudioNotReadyError(["completed_job_correlation_or_chunk_state_missing"]);
      coverage.push(
        validateSkillSchema(
          VoiceStudioCoverageV1Schema,
          {
            schema_id: "penny.videogen-voice-studio-coverage.v1",
            schema_version: 1,
            correlation: c,
            script_ref: r.script_ref,
            chunk_plan_ref: r.chunk_plan_ref,
            voice_id: r.voice_id,
            observed_at_ms: s.observed_at_ms,
            narration_sha256: job.narration_sha256,
            chunks: job.chunks.map((chunk, i) => {
              const expected = plan.chunks[i];
              if (
                !expected ||
                chunk.ordinal !== i ||
                chunk.text_sha256 !== sha256(expected.text) ||
                chunk.voice_id !== b.profile.voice_id ||
                chunk.resolved_voice_sha256 !== b.profile.voice_sha256 ||
                chunk.fallback_used ||
                chunk.status !== "completed" ||
                chunk.error_present
              )
                throw new VoiceStudioNotReadyError([
                  "resolved_voice_or_exact_chunk_coverage_unproven",
                ]);
              return {
                chunk_id: expected.chunk_id,
                segment_id: chunk.segment_id,
                text_sha256: chunk.text_sha256,
                voice_id: chunk.voice_id,
                resolved_voice_sha256: chunk.resolved_voice_sha256,
                fallback_used: false,
                status: "completed",
                error: null,
              };
            }),
          },
          "host observed voice coverage"
        )
      );
    }
    const { observed_at_ms: _time, ...serviceFacts } = s;
    return {
      raw: { readiness, coverage },
      fingerprint: sha256(canonicalJson({ facts: observed.facts, service: serviceFacts })),
    };
  }
}
Object.freeze(VoiceStudioProcessObserver.prototype);
Object.freeze(VoiceStudioProcessObserver);
