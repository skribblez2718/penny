import {
  VoiceStudioObservationCollector,
  type VoiceStudioObservationSourceV1,
} from "./voice-studio-observations.js";
import { parseVoiceStoredJson } from "./voice-json.js";
import { HOST_RECEIPTED_RESULT_CONTRACT } from "../host-operations/effect-protocol.js";
import { FileHostOperationResultCache } from "../host-operations/result-cache.js";
import { Type } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import {
  hostOperationLeaseProfileSha256,
  validateHostOperationDeclaration,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
  type HostOperationDispositionV1,
  type HostOperationExecutionContextV1,
  type HostOperationRemoteCancellationResultV1,
} from "../host-operations/contracts.js";
import {
  isCanonicalHostOperationExecutionContextV1,
  HostOperationSimulatedCrashError,
  type HostOperationRuntimeOwnerOptions,
} from "../host-operations/owner.js";
import {
  VoiceStudioAuthority,
  type VoiceStudioAuthorityBindingsV1,
} from "./voice-studio-authority.js";
import { VoiceStudioTransport } from "./voice-studio-transport.js";
import { inspectCanonicalPcmWav, measurePcm16 } from "./media-decode.js";
import { parseMediaJson } from "./media-contracts.js";
import { rationalTime } from "./rational-time.js";
import {
  VoiceStudioProfileV1Schema,
  VoiceStudioChunkPlanV1Schema,
  VoiceStudioCorrelationV1Schema,
  VoiceStudioVoiceV1Schema,
  VoiceStudioNarrationV1Schema,
  VoiceStudioJobV1Schema,
  VoiceStudioCacheV1Schema,
  VoiceStudioRawResultV1Schema,
  VOICE_STUDIO_ADAPTER_ID,
  VOICE_STUDIO_REQUEST,
  VOICE_STUDIO_RAW_RESULT,
  VOICE_STUDIO_WAV,
  type VoiceStudioCorrelationV1,
  type VoiceStudioJobV1,
  type VoiceStudioJobRequestV1,
  type VoiceStudioRawResultV1,
} from "./voice-studio-contracts.js";

const closed = { additionalProperties: false } as const;
const Accepted = Type.Object(
  {
    job_id: VoiceStudioJobV1Schema.properties.job_id,
    narration_item_id: VoiceStudioJobV1Schema.properties.narration_item_id,
    status: VoiceStudioJobV1Schema.properties.status,
  },
  closed
);
const COMPLETE: HostOperationDispositionV1 = {
  outcome: "completed",
  remote_disposition: "proven_terminal",
  lease_disposition: "released",
  retryable: false,
  reason_code: null,
};
export function voiceStudioFailure(
  remote: "proven_not_accepted" | "proven_terminal" | "may_continue"
): HostOperationDispositionV1 {
  return remote === "may_continue"
    ? {
        outcome: "remote_unknown",
        remote_disposition: remote,
        lease_disposition: "quarantined",
        retryable: false,
        reason_code: "voice_studio_unproven_remote_state",
      }
    : {
        outcome: "failed",
        remote_disposition: remote,
        lease_disposition: "released",
        retryable: false,
        reason_code: "voice_studio_refused",
      };
}
export function createVoiceStudioDeclaration(input: {
  readonly backend_binding_id: string;
  readonly lease_profile_id: string;
  readonly lease_duration_ms: number;
  readonly lease_renew_after_ms: number;
  readonly queue_inactivity_ms: number;
  readonly operation_inactivity_ms: number;
  readonly max_request_bytes: number;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
  readonly max_progress_events: number;
}): HostOperationDeclarationV1 {
  const lease = {
    profile_id: input.lease_profile_id,
    profile_version: 1 as const,
    duration_ms: input.lease_duration_ms,
    renew_after_ms: input.lease_renew_after_ms,
    queue_inactivity_ms: input.queue_inactivity_ms,
  };
  return validateHostOperationDeclaration({
    schema_version: 1,
    operation_kind: "voice_job",
    effect_protocol: "request_intent_v1",
    receipt_citing_result: HOST_RECEIPTED_RESULT_CONTRACT,
    adapter_id: VOICE_STUDIO_ADAPTER_ID,
    request: VOICE_STUDIO_REQUEST,
    result: VOICE_STUDIO_RAW_RESULT,
    backend_binding_id: input.backend_binding_id,
    capability_classes: ["artifact_store", "registered_loopback_http"],
    lease_profile: { ...lease, profile_sha256: hostOperationLeaseProfileSha256(lease) },
    operation_inactivity_ms: input.operation_inactivity_ms,
    max_request_bytes: input.max_request_bytes,
    max_input_artifacts: 16,
    max_input_bytes: input.max_input_bytes,
    output_contracts: [VOICE_STUDIO_WAV],
    result_selection_policy: "unselected",
    max_output_artifacts: 3,
    max_output_bytes: input.max_output_bytes,
    max_progress_events: input.max_progress_events,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "registered_remote_cancel_then_observe_v1",
  });
}
async function pause(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) throw new Error("voice observation aborted");
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
  if (signal.aborted) throw new Error("voice observation aborted");
}
function terminal(job: VoiceStudioJobV1): boolean {
  return !["queued", "running"].includes(job.status);
}
function exactJob(job: VoiceStudioJobV1, c: VoiceStudioCorrelationV1): void {
  if (
    job.job_id !== c.job_id ||
    job.narration_item_id !== c.narration_item_id ||
    job.completed + job.errored > job.total_chunks
  )
    throw new Error("voice job identity/counters");
}
export class VoiceStudioAdapter implements HostOperationAdapterV1 {
  readonly adapter_id = VOICE_STUDIO_ADAPTER_ID;
  private readonly client: VoiceStudioTransport;
  constructor(readonly authority: VoiceStudioAuthority) {
    if (!(authority instanceof VoiceStudioAuthority))
      throw new Error("concrete Voice Studio authority required");
    this.client = new VoiceStudioTransport(
      authority.transport,
      authority.profile.limits,
      authority.bindings.managed_relay
        ? (n) => authority.bindings.managed_relay?.countHttp(n)
        : undefined
    );
  }
  async prepare(ctx: HostOperationExecutionContextV1): Promise<void> {
    const relay = this.authority.bindings.managed_relay;
    if (!relay) return;
    const r = this.authority.parseRequest(ctx.request_bytes);
    const { plan } = this.authority.validateRequest(r, ctx.directive);
    this.authority.held(ctx.journal);
    await relay.prepare(
      ctx,
      () => {
        this.authority.validateRequest(r, ctx.directive);
        this.authority.held(ctx.journal);
      },
      { source_text: plan.source_text, voice_id: r.voice_id }
    );
  }
  close(): void {
    this.authority.bindings.managed_relay?.close();
  }
  inspectRequest(input: Parameters<HostOperationAdapterV1["inspectRequest"]>[0]) {
    const r = this.authority.parseRequest(input.request_bytes);
    this.authority.validateRequest(r, input.directive);
    const l = this.authority.profile.limits;
    if (
      input.declaration.backend_binding_id !== this.authority.profile.backend_binding_id ||
      input.declaration.max_pre_acceptance_retries !== 0 ||
      input.declaration.operation_inactivity_ms !==
        r.policy_refs.inactivity_policy_ref.active_inactivity_ms ||
      input.declaration.lease_profile.queue_inactivity_ms !==
        r.policy_refs.queue_policy_ref.max_wait_ms ||
      l.silence_ms !== r.policy_refs.inactivity_policy_ref.transport_silence_ms ||
      input.declaration.max_output_bytes <
        Math.ceil((l.max_wav_bytes * 4) / 3) + l.max_json_bytes * 2
    )
      throw new Error("Voice Studio declaration/policy/cache limits mismatch");
    return {
      schema_version: 1 as const,
      operation_kind: "voice_job",
      adapter_id: this.adapter_id,
      backend_binding_id: this.authority.profile.backend_binding_id,
      backend_key_sha256: this.authority.backend_key_sha256,
    };
  }
  private active(ctx: HostOperationExecutionContextV1, r: VoiceStudioJobRequestV1, epoch?: string) {
    this.authority.validateRequest(r, ctx.directive);
    this.authority.held(ctx.journal);
    const ready = this.authority.readiness();
    if (epoch !== undefined && ready.process_epoch !== epoch)
      throw new Error("voice process restarted");
    if (ctx.signal.aborted) throw new Error("voice operation aborted");
    return ready;
  }
  private async preflight(
    ctx: HostOperationExecutionContextV1,
    r: VoiceStudioJobRequestV1,
    signal: AbortSignal,
    epoch: string
  ): Promise<void> {
    const p = this.authority.profile;
    this.active(ctx, r, epoch);
    const list = validateSkillSchema(
      Type.Array(VoiceStudioVoiceV1Schema, { maxItems: 1000 }),
      await this.client.json("GET", "/api/voices", signal),
      "voice discovery"
    );
    if (
      new Set(list.map((v) => v.id)).size !== list.length ||
      list.filter((v) => v.id === r.voice_id).length !== 1
    )
      throw new Error("exact voice absent");
    this.active(ctx, r, epoch);
    const voice = validateSkillSchema(
      VoiceStudioVoiceV1Schema,
      await this.client.json("GET", `/api/voices/${r.voice_id}`, signal),
      "exact voice"
    );
    if (
      sha256(canonicalJson(voice)) !== p.voice_sha256 ||
      sha256(canonicalJson(list.find((v) => v.id === r.voice_id))) !== p.voice_sha256
    )
      throw new Error("voice identity drift");
    this.active(ctx, r, epoch);
    const sample = await this.client.wav(`/api/voices/${r.voice_id}/sample`, signal, true);
    this.active(ctx, r, epoch);
    if (sha256(sample) !== p.sample_sha256) throw new Error("voice sample identity drift");
  }
  private async job(c: VoiceStudioCorrelationV1, signal: AbortSignal): Promise<VoiceStudioJobV1> {
    const j = validateSkillSchema(
      VoiceStudioJobV1Schema,
      await this.client.json("GET", `/api/tts/jobs/${c.job_id}`, signal),
      "voice job"
    );
    exactJob(j, c);
    return j;
  }
  private async cancel(
    c: VoiceStudioCorrelationV1,
    signal: AbortSignal
  ): Promise<HostOperationRemoteCancellationResultV1> {
    try {
      const epoch = this.authority.readiness().process_epoch;
      if (epoch !== c.process_epoch) throw new Error("voice process restarted");
      let j = await this.job(c, signal);
      if (!terminal(j)) {
        // Source cancellation sets only a cooperative flag. Its 2xx is deliberately not stop proof.
        if (this.authority.bindings.managed_relay)
          await this.authority.bindings.managed_relay.cancel(c.job_id);
        else await this.client.json("POST", `/api/tts/cancel/${c.job_id}`, signal);
        for (let i = 0; i < this.authority.profile.limits.cancel_observations; i++) {
          j = await this.job(c, signal);
          if (terminal(j)) break;
          await pause(signal, this.authority.profile.limits.poll_ms);
        }
      }
      if (terminal(j) && (this.authority.bindings.managed_relay || j.status !== "cancelled")) {
        await this.authority.bindings.managed_relay?.drain();
        return {
          remote_disposition: "proven_terminal",
          reason_code: "voice_studio_exact_job_terminal",
        };
      }
    } catch {
      /* Ambiguous cleanup never releases a process/GPU hold. */
    }
    return { remote_disposition: "may_continue", reason_code: "voice_studio_cancel_unproven" };
  }
  async run(ctx: HostOperationExecutionContextV1) {
    if (!isCanonicalHostOperationExecutionContextV1(ctx))
      throw new Error("Voice Studio requires real host runtime context");
    const r = this.authority.parseRequest(ctx.request_bytes);
    const { policy } = this.authority.validateRequest(r, ctx.directive);
    this.authority.held(ctx.journal);
    let remote: "proven_not_accepted" | "proven_terminal" | "may_continue" =
      ctx.journal.lifecycle === "lease_acquired" ? "proven_not_accepted" : "may_continue";
    let correlation: VoiceStudioCorrelationV1 | undefined;
    let cancellation: ReturnType<VoiceStudioAdapter["cancel"]> | undefined;
    const cancelOnce = (exact: VoiceStudioCorrelationV1, cleanupSignal: AbortSignal) =>
      (cancellation ??= this.cancel(exact, cleanupSignal));
    let elapsed: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    ctx.signal.addEventListener("abort", forward, { once: true });
    if (ctx.signal.aborted) forward();
    if (r.limits.max_elapsed_ms !== undefined) {
      const remaining =
        Date.parse(ctx.journal.started_at) +
        r.limits.max_elapsed_ms -
        Date.parse(this.authority.current().rights.now_utc);
      if (remaining <= 0) controller.abort();
      else elapsed = setTimeout(() => controller.abort(), remaining);
    }
    const signal = controller.signal;
    try {
      if (ctx.journal.remote_correlation_id !== null)
        correlation = parseMediaJson(
          VoiceStudioCorrelationV1Schema,
          Buffer.from(ctx.journal.remote_correlation_id),
          this.authority.bindings.limits
        );
      const cached = await ctx.readCachedResult();
      let raw: VoiceStudioRawResultV1;
      let wav: Buffer;
      if (cached !== null) {
        if (
          !correlation ||
          ctx.journal.lifecycle !== "fetched" ||
          ctx.journal.fetched === null ||
          ctx.journal.fetched.content_sha256 !== cached.content_sha256
        )
          throw new Error("cache without exact fetched milestone");
        const limits = {
          ...this.authority.bindings.limits,
          max_json_bytes: ctx.declaration.max_output_bytes,
          max_text_bytes: ctx.declaration.max_output_bytes,
        };
        const envelope = parseVoiceStoredJson(VoiceStudioCacheV1Schema, cached.bytes, limits);
        raw = envelope.raw;
        wav = Buffer.from(envelope.wav_base64, "base64");
        if (
          wav.toString("base64") !== envelope.wav_base64 ||
          raw.request_sha256 !== ctx.directive.request_sha256 ||
          raw.operation_id !== r.operation_id ||
          canonicalJson(raw.correlation) !== canonicalJson(correlation) ||
          raw.wav_sha256 !== sha256(wav) ||
          raw.wav_bytes !== wav.length
        )
          throw new Error("cached original voice operands drift");
        if (
          this.authority.coverage(correlation, r, raw.narration).artifact_id !==
          raw.coverage_ref.artifact_id
        )
          throw new Error("cached coverage drift");
        // Durable complete WAV + original coverage permits adoption even after volatile jobs vanish.
        remote = "proven_terminal";
      } else {
        if (ctx.journal.lifecycle === "fetched" || ctx.journal.lifecycle === "submitting")
          throw new Error("missing voice milestone/cache");
        if (this.authority.bindings.managed_relay)
          await this.authority.bindings.observations.collect("readiness", signal);
        const ready = this.authority.readiness();
        if (
          correlation &&
          (correlation.request_sha256 !== ctx.directive.request_sha256 ||
            correlation.profile_sha256 !== r.profile_ref.content_digest ||
            correlation.process_epoch !== ready.process_epoch)
        )
          throw new Error("voice accepted identity/epoch drift");
        await this.preflight(ctx, r, signal, ready.process_epoch);
        this.active(ctx, r, ready.process_epoch);
        if (!correlation) {
          if (ctx.journal.lifecycle !== "lease_acquired")
            throw new Error("voice start is not repeatable");
          const plan = this.authority.validateRequest(r, ctx.directive).plan;
          ctx.beginSubmission();
          remote = "may_continue";
          this.authority.bindings.managed_relay?.enter(ctx);
          const n = validateSkillSchema(
            VoiceStudioNarrationV1Schema,
            this.authority.bindings.managed_relay
              ? await this.authority.bindings.managed_relay.create(plan.source_text, r.voice_id)
              : await this.client.json("POST", "/api/narrations", signal, {
                  source_text: plan.source_text,
                  voice_profile_id: r.voice_id,
                }),
            "created narration"
          );
          this.active(ctx, r, ready.process_epoch);
          this.checkNarration(n, r);
          // Require exact item/voice readback before the sole generation POST.
          const read = validateSkillSchema(
            VoiceStudioNarrationV1Schema,
            await this.client.json("GET", `/api/narrations/${n.id}`, signal),
            "narration readback"
          );
          this.active(ctx, r, ready.process_epoch);
          if (canonicalJson(n) !== canonicalJson(read))
            throw new Error("narration changed before start");
          const accepted = validateSkillSchema(
            Accepted,
            this.authority.bindings.managed_relay
              ? await this.authority.bindings.managed_relay.generate(n.id, r.voice_id)
              : await this.client.json("POST", "/api/tts/generate", signal, {
                  narration_item_id: n.id,
                  voice_profile_id: r.voice_id,
                }),
            "voice acceptance"
          );
          if (accepted.narration_item_id !== n.id) throw new Error("voice accepted wrong item");
          correlation = {
            schema_id: "penny.videogen-voice-studio-correlation.v1",
            schema_version: 1,
            request_sha256: ctx.directive.request_sha256,
            profile_sha256: r.profile_ref.content_digest,
            process_epoch: ready.process_epoch,
            job_id: accepted.job_id,
            narration_item_id: n.id,
          };
          ctx.recordRemoteAccepted(canonicalJson(correlation));
          this.active(ctx, r, correlation.process_epoch);
        }
        const exact = correlation;
        ctx.registerRemoteCancellation((cleanupSignal) => cancelOnce(exact, cleanupSignal));
        this.active(ctx, r, exact.process_epoch);
        let job = await this.job(exact, signal);
        // Observe terminal state before authority checks so cleanup cannot erase known completion.
        if (!this.authority.bindings.managed_relay && terminal(job) && job.status !== "cancelled")
          remote = "proven_terminal";
        this.active(ctx, r, exact.process_epoch);
        while (!terminal(job)) {
          await pause(signal, this.authority.profile.limits.poll_ms);
          this.active(ctx, r, exact.process_epoch);
          job = await this.job(exact, signal);
          if (!this.authority.bindings.managed_relay && terminal(job) && job.status !== "cancelled")
            remote = "proven_terminal";
          this.active(ctx, r, exact.process_epoch);
        }
        if (job.status === "cancelled")
          throw new Error("cooperative cancellation is not worker-stop proof");
        if (!this.authority.bindings.managed_relay) remote = "proven_terminal";
        if (
          job.status !== "completed" ||
          job.errored !== 0 ||
          job.total_chunks !== r.expected_chunk_ids.length ||
          job.completed !== job.total_chunks ||
          job.percent !== 100
        )
          throw new Error("partial voice job cannot export");
        const narration = validateSkillSchema(
          VoiceStudioNarrationV1Schema,
          await this.client.json("GET", `/api/narrations/${exact.narration_item_id}`, signal),
          "completed narration"
        );
        this.active(ctx, r, exact.process_epoch);
        this.checkNarration(narration, r);
        await this.authority.bindings.observations.collect("coverage", signal, {
          correlation: exact,
          request: r,
          narration,
        });
        this.active(ctx, r, exact.process_epoch);
        const coverageRef = this.authority.coverage(exact, r, narration);
        if (this.authority.readiness().process_epoch !== exact.process_epoch)
          throw new Error("voice process changed before export");
        wav = await this.client.wav(`/api/tts/result/${exact.narration_item_id}.wav`, signal);
        this.active(ctx, r, exact.process_epoch);
        const pcm = inspectCanonicalPcmWav(wav, policy),
          measurements = measurePcm16(pcm.data);
        if (measurements.peak_abs_s16 === 0) throw new Error("silent voice capture");
        raw = validateSkillSchema(
          VoiceStudioRawResultV1Schema,
          {
            schema_id: "penny.videogen-voice-studio-raw-result.v1",
            schema_version: 1,
            operation_id: r.operation_id,
            request_sha256: ctx.directive.request_sha256,
            correlation: exact,
            coverage_ref: coverageRef,
            narration,
            job,
            wav_sha256: sha256(wav),
            wav_bytes: wav.length,
            sample_rate: { numerator: pcm.sample_rate, denominator: 1 },
            channels: pcm.channels === 1 ? "mono" : "stereo",
            samples: pcm.samples,
            duration: rationalTime(BigInt(pcm.samples), BigInt(pcm.sample_rate)),
            ...measurements,
          },
          "raw voice result"
        );
        const envelope = Buffer.from(canonicalJson({ raw, wav_base64: wav.toString("base64") }));
        // Immediate custody: cache exact complete bytes BEFORE the owner fetched milestone.
        const captured = await ctx.cacheResult(envelope);
        this.active(ctx, r, exact.process_epoch);
        ctx.recordFetched({
          content_sha256: captured.content_sha256,
          byte_length: captured.byte_length,
          schema_version: 1,
          item_count: r.expected_chunk_ids.length,
          poll_count: 0,
        });
      }
      const pcm = inspectCanonicalPcmWav(wav, policy);
      if (
        sha256(wav) !== raw.wav_sha256 ||
        pcm.samples !== raw.samples ||
        pcm.sample_rate !== raw.sample_rate.numerator ||
        (pcm.channels === 1 ? "mono" : "stereo") !== raw.channels ||
        canonicalJson(measurePcm16(pcm.data)) !==
          canonicalJson({ peak_abs_s16: raw.peak_abs_s16, sum_squares: raw.sum_squares })
      )
        throw new Error("voice PCM facts drift");
      this.authority.validateRequest(r, ctx.directive);
      this.authority.held(ctx.journal);
      if (signal.aborted) throw new Error("voice operation aborted");
      await this.authority.bindings.managed_relay?.drain();
      if (this.authority.bindings.managed_relay) remote = "proven_terminal";
      const persisted = ctx.persist({
        disposition: COMPLETE,
        operation_result: {
          contract: VOICE_STUDIO_RAW_RESULT,
          media_type: "application/json",
          content: canonicalJson(raw),
        },
        outputs: [{ contract: VOICE_STUDIO_WAV, media_type: "audio/wav", content: wav }],
      });
      return { disposition: COMPLETE, ...persisted };
    } catch (error) {
      if (error instanceof HostOperationSimulatedCrashError) throw error;
      if (remote === "may_continue" && correlation) {
        const cleanup = await cancelOnce(
          correlation,
          AbortSignal.timeout(r.policy_refs.cleanup_policy_ref.cancel_grace_ms)
        );
        if (cleanup.remote_disposition === "proven_terminal") remote = "proven_terminal";
      }
      return {
        disposition: voiceStudioFailure(remote),
        operation_result_ref: null,
        output_artifacts: [],
      };
    } finally {
      if (elapsed !== undefined) clearTimeout(elapsed);
      ctx.signal.removeEventListener("abort", forward);
    }
  }
  private checkNarration(
    n: import("./voice-studio-contracts.js").VoiceStudioNarrationV1,
    r: VoiceStudioJobRequestV1
  ): void {
    const plan = this.authority.read(
      r.chunk_plan_ref,
      VoiceStudioChunkPlanV1Schema,
      "penny.videogen-voice-studio-chunk-plan.v1"
    );
    if (
      n.source_text !== plan.source_text ||
      n.voice_profile_id !== r.voice_id ||
      n.chunk_count !== plan.chunks.length ||
      n.char_count !== Array.from(plan.source_text).length
    )
      throw new Error("voice narration script/voice/chunk mismatch");
  }
}
/** Future registry composition: returns the fixed adapter; does not mutate PLAYBOOK_REGISTRY. */
export function createVoiceStudioAdapter(authority: VoiceStudioAuthority): VoiceStudioAdapter {
  return new VoiceStudioAdapter(authority);
}

/** Host-only ports for future playbook assembly. This does not register a route, launch a service,
 * mint approval or activate the playbook. Declaration/capacity/cache remain existing owner ports. */
export function createVoiceStudioHostBinding(
  authority: VoiceStudioAuthority,
  declaration: HostOperationDeclarationV1,
  cache: FileHostOperationResultCache
): Pick<
  HostOperationRuntimeOwnerOptions,
  "adapters" | "useValidator" | "capacityRuntime" | "resultCache"
> {
  const d = validateHostOperationDeclaration(declaration);
  if (
    !(cache instanceof FileHostOperationResultCache) ||
    d.operation_kind !== "voice_job" ||
    d.adapter_id !== VOICE_STUDIO_ADAPTER_ID ||
    d.backend_binding_id !== authority.profile.backend_binding_id ||
    canonicalJson(d.request) !== canonicalJson(VOICE_STUDIO_REQUEST) ||
    canonicalJson(d.result) !== canonicalJson(VOICE_STUDIO_RAW_RESULT) ||
    canonicalJson(d.output_contracts) !== canonicalJson([VOICE_STUDIO_WAV]) ||
    d.max_pre_acceptance_retries !== 0 ||
    d.effect_protocol !== "request_intent_v1" ||
    canonicalJson(d.receipt_citing_result) !== canonicalJson(HOST_RECEIPTED_RESULT_CONTRACT) ||
    d.recovery_semantics !== "journaled_remote_submission_v1" ||
    d.cancellation_semantics !== "registered_remote_cancel_then_observe_v1"
  )
    throw new Error("Voice Studio requires exact host declaration and durable owner cache");
  const adapter = createVoiceStudioAdapter(authority);
  return {
    adapters: new Map([[adapter.adapter_id, adapter]]),
    useValidator: authority,
    capacityRuntime: authority.bindings.capacity,
    resultCache: cache,
  };
}

export interface VoiceStudioPrivateHostBindingInputsV1 {
  readonly authority: Omit<VoiceStudioAuthorityBindingsV1, "observations">;
  readonly observation_source: VoiceStudioObservationSourceV1;
  readonly declaration: HostOperationDeclarationV1;
  readonly cache: FileHostOperationResultCache;
}
/** Single usable construction seam for the parent host. Requires its real project owners,
 * capacity, exact profile/build/policy refs, private TLS binding and actual process source.
 * No service/model launch, approval, registry edit, environment loading or ready fabrication. */
export function createVoiceStudioPrivateHostBinding(input: VoiceStudioPrivateHostBindingInputsV1) {
  const b = input.authority;
  const common = {
    owner: b.owner,
    profile_ref: b.profile_ref,
    profile: validateSkillSchema(
      VoiceStudioProfileV1Schema,
      b.profile,
      "native Voice profile required"
    ),
    transport: b.transport,
  };
  const source = input.observation_source;
  if ((source.process_observer === undefined) === (source.process_snapshot_path === undefined))
    throw new Error("exactly one voice observation source required");
  const observations = new VoiceStudioObservationCollector({ ...common, ...source });
  const authority = new VoiceStudioAuthority({ ...b, observations });
  return {
    authority,
    observations,
    ...createVoiceStudioHostBinding(authority, input.declaration, input.cache),
  };
}
