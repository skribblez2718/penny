import { AsyncLocalStorage } from "node:async_hooks";
import { Type } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import {
  validateHostOperationDeclaration,
  type HostOperationAdapterV1,
  type HostOperationDispositionV1,
  type HostOperationExecutionContextV1,
} from "../host-operations/contracts.js";
import {
  isCanonicalHostOperationExecutionContextV1,
  HostOperationSimulatedCrashError,
} from "../host-operations/owner.js";
import { VoiceStudioAuthority } from "./voice-studio-authority.js";
import { createVoiceStudioDeclaration, voiceStudioFailure } from "./voice-studio-adapter.js";
import { VoiceApiObservationCollector } from "./voice-api-observations.js";
import {
  VoiceApiCorrelationSchema,
  VoiceApiRawResultSchema,
  VOICE_API_ADAPTER_ID,
  VOICE_API_RAW_RESULT,
  type VoiceApiCorrelation,
} from "./voice-api-contracts.js";
import {
  VoiceStudioJobV1Schema,
  VoiceStudioNarrationV1Schema,
  VOICE_STUDIO_WAV,
  type VoiceStudioJobV1,
  type VoiceStudioJobRequestV1,
} from "./voice-studio-contracts.js";
import { inspectCanonicalPcmWav, measurePcm16 } from "./media-decode.js";
import { parseVoiceStoredJson } from "./voice-json.js";
import { rationalTime } from "./rational-time.js";
export function createVoiceApiDeclaration(p: Parameters<typeof createVoiceStudioDeclaration>[0]) {
  return validateHostOperationDeclaration({
    ...createVoiceStudioDeclaration(p),
    adapter_id: VOICE_API_ADAPTER_ID,
    result: VOICE_API_RAW_RESULT,
  });
}
const Accepted = Type.Pick(VoiceStudioJobV1Schema, ["job_id", "narration_item_id", "status"]);
const Cache = Type.Object(
  { raw: VoiceApiRawResultSchema, wav_base64: Type.String({ maxLength: 357913944 }) },
  { additionalProperties: false }
);
const complete: HostOperationDispositionV1 = {
  outcome: "completed",
  remote_disposition: "proven_terminal",
  lease_disposition: "released",
  retryable: false,
  reason_code: null,
};
function terminal(j: VoiceStudioJobV1) {
  return !["running", "queued"].includes(j.status);
}
async function pause(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Voice API aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** Fixed normal API path. API terminal state is a trusted producer fact, NOT a GPU drain proof. */
export class VoiceApiAdapter implements HostOperationAdapterV1 {
  readonly adapter_id = VOICE_API_ADAPTER_ID;
  readonly observations: VoiceApiObservationCollector;
  constructor(readonly authority: VoiceStudioAuthority) {
    if (authority.bindings.assurance !== "trusted_local_api")
      throw new Error("explicit Voice API assurance required");
    this.observations = VoiceApiObservationCollector.require(
      authority.bindings.observations,
      authority.bindings.owner,
      authority.bindings.profile_ref,
      authority.transport
    );
  }
  inspectRequest(input: Parameters<HostOperationAdapterV1["inspectRequest"]>[0]) {
    const r = this.authority.parseRequest(input.request_bytes);
    this.authority.validateRequest(r, input.directive);
    const p = this.authority.profile;
    if (
      input.declaration.adapter_id !== VOICE_API_ADAPTER_ID ||
      input.declaration.backend_binding_id !== p.backend_binding_id ||
      canonicalJson(input.declaration.result) !== canonicalJson(VOICE_API_RAW_RESULT) ||
      input.declaration.operation_inactivity_ms !==
        r.policy_refs.inactivity_policy_ref.active_inactivity_ms ||
      input.declaration.lease_profile.queue_inactivity_ms !==
        r.policy_refs.queue_policy_ref.max_wait_ms ||
      p.limits.silence_ms !== r.policy_refs.inactivity_policy_ref.transport_silence_ms
    )
      throw new Error("Voice API declaration/policy mismatch");
    return {
      schema_version: 1 as const,
      operation_kind: "voice_job",
      adapter_id: this.adapter_id,
      backend_binding_id: p.backend_binding_id,
      backend_key_sha256: this.authority.backend_key_sha256,
    };
  }
  private async job(c: VoiceApiCorrelation, signal: AbortSignal) {
    const j = validateContract(
      VoiceStudioJobV1Schema,
      await this.observations.json("GET", `/api/tts/jobs/${c.job_id}`, signal),
      "Voice API exact job"
    );
    if (
      j.job_id !== c.job_id ||
      j.narration_item_id !== c.narration_item_id ||
      j.completed + j.errored > j.total_chunks
    )
      throw new Error("Voice API job identity/counters mismatch");
    return j;
  }
  private async cancel(c: VoiceApiCorrelation, signal: AbortSignal) {
    try {
      let j = await this.job(c, signal);
      if (!terminal(j)) {
        await this.observations.json("POST", `/api/tts/cancel/${c.job_id}`, signal);
        for (let i = 0; i < this.authority.profile.limits.cancel_observations; i++) {
          j = await this.job(c, signal);
          if (terminal(j)) break;
          await pause(signal, this.authority.profile.limits.poll_ms);
        }
      }
      // Cooperative cancellation alone does not establish that the running compute has stopped.
      if (terminal(j) && j.status !== "cancelled")
        return {
          remote_disposition: "proven_terminal" as const,
          reason_code: "trusted_api_exact_job_terminal",
        };
    } catch {
      /* Keep the same hold for ambiguous cleanup. */
    }
    return {
      remote_disposition: "may_continue" as const,
      reason_code: "trusted_api_cancel_unproven",
    };
  }
  private checkNarration(
    n: import("./voice-studio-contracts.js").VoiceStudioNarrationV1,
    r: VoiceStudioJobRequestV1,
    plan: ReturnType<VoiceStudioAuthority["validateRequest"]>["plan"]
  ) {
    if (
      n.source_text !== plan.source_text ||
      n.voice_profile_id !== r.voice_id ||
      n.chunk_count !== plan.chunks.length ||
      n.char_count !== Array.from(plan.source_text).length
    )
      throw new Error("Voice API exact narration request/readback mismatch");
  }
  async run(ctx: HostOperationExecutionContextV1) {
    if (!isCanonicalHostOperationExecutionContextV1(ctx))
      throw new Error("real Voice API host context required");
    const a = this.authority,
      o = this.observations,
      r = a.parseRequest(ctx.request_bytes);
    const { plan, policy, voice } = a.validateRequest(r, ctx.directive);
    a.held(ctx.journal);
    let remote: "proven_not_accepted" | "proven_terminal" | "may_continue" =
      ctx.journal.lifecycle === "lease_acquired" ? "proven_not_accepted" : "may_continue";
    let c: VoiceApiCorrelation | undefined;
    let cancellation: ReturnType<VoiceApiAdapter["cancel"]> | undefined;
    const cancelOnce = (correlation: VoiceApiCorrelation, cleanupSignal: AbortSignal) =>
      (cancellation ??= this.cancel(correlation, cleanupSignal));
    const controller = new AbortController(),
      abort = () => controller.abort();
    ctx.signal.addEventListener("abort", abort, { once: true });
    if (ctx.signal.aborted) abort();
    const remaining =
      r.limits.max_elapsed_ms === undefined
        ? undefined
        : Date.parse(ctx.journal.started_at) + r.limits.max_elapsed_ms - Date.now();
    const timer = remaining === undefined ? undefined : setTimeout(abort, Math.max(0, remaining));
    const signal = controller.signal;
    const active = () => {
      signal.throwIfAborted();
      a.validateRequest(r, ctx.directive);
      a.held(ctx.journal);
      ctx.reportActivity("voice_api_observation", 1);
    };
    try {
      if (ctx.journal.remote_correlation_id !== null)
        c = parseVoiceStoredJson(
          VoiceApiCorrelationSchema,
          Buffer.from(ctx.journal.remote_correlation_id),
          a.bindings.limits
        );
      const cached = await ctx.readCachedResult();
      let raw: import("./voice-api-contracts.js").VoiceApiRawResult, wav: Buffer;
      if (cached) {
        if (
          !c ||
          ctx.journal.lifecycle !== "fetched" ||
          cached.content_sha256 !== ctx.journal.fetched?.content_sha256
        )
          throw new Error("Voice API cache without original fetched milestone");
        const envelope = parseVoiceStoredJson(Cache, cached.bytes, {
          ...a.bindings.limits,
          max_json_bytes: ctx.declaration.max_output_bytes,
          max_text_bytes: ctx.declaration.max_output_bytes,
        });
        raw = envelope.raw;
        wav = Buffer.from(envelope.wav_base64, "base64");
        if (
          wav.toString("base64") !== envelope.wav_base64 ||
          canonicalJson(raw.correlation) !== canonicalJson(c) ||
          raw.operation_id !== r.operation_id ||
          raw.request_sha256 !== ctx.directive.request_sha256 ||
          sha256(wav) !== raw.wav_sha256 ||
          wav.length !== raw.wav_bytes
        )
          throw new Error("Voice API original capture drift");
        if (
          o.persistCoverage(raw.coverage, r.operation_id).artifact_id !==
          raw.coverage_ref.artifact_id
        )
          throw new Error("Voice API coverage drift");
        remote = "proven_terminal";
      } else {
        if (["submitting", "fetched"].includes(ctx.journal.lifecycle))
          throw new Error("Voice API missing original milestone");
        await o.inspect(signal);
        active();
        if (
          c &&
          (c.request_sha256 !== ctx.directive.request_sha256 ||
            c.profile_sha256 !== r.profile_ref.content_digest ||
            c.backend_binding_id !== a.profile.backend_binding_id)
        )
          throw new Error("Voice API accepted identity mismatch");
        if (!c) {
          if (ctx.journal.lifecycle !== "lease_acquired")
            throw new Error("Voice API submission not repeatable");
          ctx.beginSubmission();
          remote = "may_continue";
          const created = validateContract(
            VoiceStudioNarrationV1Schema,
            await o.json("POST", "/api/narrations", signal, {
              source_text: plan.source_text,
              voice_profile_id: r.voice_id,
            }),
            "Voice API created narration"
          );
          active();
          this.checkNarration(created, r, plan);
          const readback = validateContract(
            VoiceStudioNarrationV1Schema,
            await o.json("GET", `/api/narrations/${created.id}`, signal),
            "Voice API narration readback"
          );
          if (canonicalJson(readback) !== canonicalJson(created))
            throw new Error("Voice API changed narration");
          active();
          const accepted = validateContract(
            Accepted,
            await o.json("POST", "/api/tts/generate", signal, {
              narration_item_id: created.id,
              voice_profile_id: r.voice_id,
            }),
            "Voice API acceptance"
          );
          if (accepted.narration_item_id !== created.id)
            throw new Error("Voice API wrong accepted narration");
          c = {
            schema_id: "penny.videogen-voice-api-correlation.v1",
            schema_version: 1,
            assurance: "trusted_local_api",
            request_sha256: ctx.directive.request_sha256,
            profile_sha256: r.profile_ref.content_digest,
            backend_binding_id: a.profile.backend_binding_id,
            job_id: accepted.job_id,
            narration_item_id: created.id,
          };
          o.checkpointResponses(r.operation_id);
          ctx.recordRemoteAccepted(canonicalJson(c));
        } else o.adoptResponses(r.operation_id);
        const exact = c;
        ctx.registerRemoteCancellation(
          AsyncLocalStorage.bind((s: AbortSignal) => cancelOnce(exact, s))
        );
        let job = await this.job(exact, signal);
        while (!terminal(job)) {
          active();
          await pause(signal, a.profile.limits.poll_ms);
          job = await this.job(exact, signal);
        }
        if (job.status !== "cancelled") remote = "proven_terminal";
        active();
        if (
          job.status !== "completed" ||
          job.errored !== 0 ||
          job.completed !== job.total_chunks ||
          job.total_chunks !== r.expected_chunk_ids.length ||
          job.percent !== 100
        )
          throw new Error("Voice API incomplete/errored job");
        const narration = validateContract(
          VoiceStudioNarrationV1Schema,
          await o.json("GET", `/api/narrations/${exact.narration_item_id}`, signal),
          "Voice API completed narration"
        );
        this.checkNarration(narration, r, plan);
        active();
        wav = await o.client.wav(`/api/tts/result/${exact.narration_item_id}.wav`, signal);
        active();
        const pcm = inspectCanonicalPcmWav(wav, policy),
          measurement = measurePcm16(pcm.data);
        if (measurement.peak_abs_s16 === 0) throw new Error("Voice API silent capture");
        const coverage = {
          schema_id: "penny.videogen-voice-api-coverage.v1",
          schema_version: 1,
          assurance: "trusted_local_api",
          correlation: exact,
          script_ref: r.script_ref,
          chunk_plan_ref: r.chunk_plan_ref,
          selected_saved_voice: voice,
          request_text: plan.source_text,
          expected_chunk_ids: r.expected_chunk_ids,
          narration,
          job,
          resolved_runtime_voice: "unknown",
          per_chunk_execution: "unknown",
          fallback_used: "unknown",
          external_work_exclusion: "unknown",
          raw_responses: o.responses,
        };
        const coverage_ref = o.persistCoverage(coverage, r.operation_id);
        raw = validateContract(
          VoiceApiRawResultSchema,
          {
            schema_id: "penny.videogen-voice-api-raw-result.v1",
            schema_version: 1,
            operation_id: r.operation_id,
            request_sha256: ctx.directive.request_sha256,
            correlation: exact,
            coverage_ref,
            coverage,
            narration,
            job,
            wav_sha256: sha256(wav),
            wav_bytes: wav.length,
            sample_rate: { numerator: pcm.sample_rate, denominator: 1 },
            channels: pcm.channels === 1 ? "mono" : "stereo",
            samples: pcm.samples,
            duration: rationalTime(BigInt(pcm.samples), BigInt(pcm.sample_rate)),
            ...measurement,
          },
          "Voice API raw result"
        );
        const captured = await ctx.cacheResult(
          Buffer.from(canonicalJson({ raw, wav_base64: wav.toString("base64") }))
        );
        ctx.recordFetched({
          content_sha256: captured.content_sha256,
          byte_length: captured.byte_length,
          schema_version: 1,
          item_count: r.expected_chunk_ids.length,
          poll_count: o.responses.filter((x) => x.route.startsWith("/api/tts/jobs/")).length,
        });
      }
      const pcm = inspectCanonicalPcmWav(wav, policy);
      if (
        pcm.samples !== raw.samples ||
        pcm.sample_rate !== raw.sample_rate.numerator ||
        raw.sample_rate.denominator !== 1 ||
        (pcm.channels === 1 ? "mono" : "stereo") !== raw.channels ||
        canonicalJson(measurePcm16(pcm.data)) !==
          canonicalJson({ peak_abs_s16: raw.peak_abs_s16, sum_squares: raw.sum_squares })
      )
        throw new Error("Voice API PCM mismatch");
      active();
      return {
        disposition: complete,
        ...ctx.persist({
          disposition: complete,
          operation_result: {
            contract: VOICE_API_RAW_RESULT,
            media_type: "application/json",
            content: canonicalJson(raw),
          },
          outputs: [{ contract: VOICE_STUDIO_WAV, media_type: "audio/wav", content: wav }],
        }),
      };
    } catch (error) {
      if (error instanceof HostOperationSimulatedCrashError) throw error;
      if (remote === "may_continue" && c) {
        const result = await cancelOnce(
          c,
          AbortSignal.timeout(r.policy_refs.cleanup_policy_ref.cancel_grace_ms)
        );
        if (result.remote_disposition === "proven_terminal") remote = "proven_terminal";
      }
      return {
        disposition: voiceStudioFailure(remote),
        operation_result_ref: null,
        output_artifacts: [],
      };
    } finally {
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", abort);
    }
  }
}
