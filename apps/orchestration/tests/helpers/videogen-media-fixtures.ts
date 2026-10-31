import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { ArtifactStore } from "../../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { Checkpointer } from "../../dist/checkpointer.js";
import { RunContext } from "../../dist/context.js";
import type {
  ArtifactRef,
  Directive,
  InvokeHostOperationDirectiveV1,
  JsonValue,
} from "../../dist/contracts.js";
import { OrchestrationEngine } from "../../dist/engine.js";
import {
  ConfinedMediaRunner,
  type ConfinedMediaBindingsV1,
} from "../../dist/host-operations/confined-media-runner.js";
import {
  hostOperationLeaseProfileSha256,
  hostOperationPolicyBinding,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
} from "../../dist/host-operations/contracts.js";
import { HostOperationLeaseAuthority } from "../../dist/host-operations/lease-authority.js";
import {
  HostOperationRuntimeOwner,
  type HostOperationRuntimeOwnerOptions,
} from "../../dist/host-operations/owner.js";
import type { Playbook } from "../../dist/playbooks/playbook.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistration,
} from "../../dist/playbooks/registry.js";
import { ReceiptAuthority } from "../../dist/receipts.js";
import { validateSkillSchema } from "../../dist/skill-contracts/common.js";
import { ProjectCatalog } from "../../dist/state/catalog.js";
import type { FoundationLimitsV1 } from "../../dist/videogen/bounds.js";
import {
  MEDIA_FRAME_CONTRACT,
  MEDIA_PCM_CONTRACT,
  RAW_MEDIA_REQUEST_CONTRACT,
  RAW_MEDIA_RESULT_CONTRACT,
  type MediaDecodePolicyV1,
  type MediaFrameSelectionV1,
  type RawMediaDecodeRequestV1,
  type RawMediaDecodeResultV1,
} from "../../dist/videogen/media-contracts.js";
import {
  canonicalPcmWav,
  createRawMediaDecodeAdapter,
  measurePcm16,
} from "../../dist/videogen/media-decode.js";
import { MediaEvidenceCustody } from "../../dist/videogen/media-evidence.js";

export function required<T>(v: T | null | undefined): T {
  if (v === undefined || v === null) throw new Error("test expected value missing");
  return v;
}
export const MEDIA_LIMITS: FoundationLimitsV1 = {
  schema_id: "penny.videogen-foundation-limits.v1",
  schema_version: 1,
  max_json_bytes: 1_048_576,
  max_text_bytes: 65536,
  max_collection_items: 2048,
  max_depth: 32,
  max_nodes: 100000,
  max_integer: Number.MAX_SAFE_INTEGER,
};
export const MEDIA_POLICY: MediaDecodePolicyV1 = {
  schema_id: "penny.videogen-media-decode-policy.v1",
  schema_version: 1,
  max_input_bytes: 4_194_304,
  max_output_bytes: 4_194_304,
  max_probe_bytes: 1_048_576,
  max_diagnostic_bytes: 1_048_576,
  max_width: 128,
  max_height: 128,
  max_pixels: 16384,
  max_frames: 32,
  max_samples: 32000,
  max_sample_rate: 16000,
  max_duration: { numerator: 2, denominator: 1 },
  max_spans: 4,
  max_selected_frames: 16,
  max_boxes: 256,
  max_decoded_bytes: 4_194_304,
  max_elapsed_ms: 20000,
  inactivity_ms: 10000,
  cpu_seconds: 5,
  address_space_bytes: 2_147_483_648,
  max_processes: 16,
  max_open_files: 64,
  metadata_policy: "baseline_avc_or_pcm_no_unapproved_metadata_v1",
};
export const MEDIA_SELECTION: MediaFrameSelectionV1 = {
  schema_id: "penny.videogen-media-frame-selection.v1",
  schema_version: 1,
  selection_rule_id: "span-boundaries-and-nearest-even-v1",
  timepoints: [],
  midpoint_count: 1,
};
export function pcmAsset(silent = false): Buffer {
  const data = Buffer.alloc(16000);
  for (let i = 0; i < 8000; i++)
    data.writeInt16LE(silent ? 0 : Math.round(12000 * Math.sin((i * Math.PI) / 8)), i * 2);
  return canonicalPcmWav(data, 1, 8000);
}
const pinned = Type.Object(
  { path: Type.String({ minLength: 1 }), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false }
);
const runtime = Type.Object(
  {
    source: Type.String({ minLength: 1 }),
    target: Type.String({ minLength: 1 }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false }
);
const cpuBindings = Type.Object(
  {
    bubblewrap: pinned,
    prlimit: pinned,
    ffmpeg: runtime,
    ffprobe: runtime,
    runtime_files: Type.Array(runtime, { maxItems: 256 }),
    max_runtime_bytes: Type.Integer({ minimum: 1, maximum: 1073741824 }),
    security_probe: pinned,
    // Trusted synthetic generation only; never admitted to the decoder sandbox bindings.
    fixture_ffmpeg: pinned,
  },
  { additionalProperties: false }
);
/** Tests fail (never silently skip) when explicit caller executable/runtime bindings are absent. */
export function suppliedCpuBindings(scratch: string): {
  readonly bindings: ConfinedMediaBindingsV1;
  readonly security_probe: string;
  readonly fixture_ffmpeg: { readonly path: string; readonly sha256: string };
} {
  const text = process.env["VIDEOGEN_MEDIA_TEST_BINDINGS"];
  if (text === undefined)
    throw new Error(
      "CPU test requires explicit VIDEOGEN_MEDIA_TEST_BINDINGS; no executable discovery/install/skip"
    );
  const unknown: unknown = JSON.parse(text);
  const parsed = validateSkillSchema(cpuBindings, unknown, "test CPU bindings");
  const { security_probe, fixture_ffmpeg, ...bindings } = parsed;
  for (const pin of [security_probe, fixture_ffmpeg])
    if (realpathSync(pin.path) !== pin.path || sha256(readFileSync(pin.path)) !== pin.sha256)
      throw new Error("test tool pin drift");
  if (security_probe.sha256 === bindings.ffprobe.sha256)
    throw new Error("adversarial probe must not be the decoder");
  return {
    bindings: { ...bindings, scratch_root: scratch },
    security_probe: security_probe.path,
    fixture_ffmpeg,
  };
}
export function syntheticVideo(
  ffmpeg: { readonly path: string; readonly sha256: string },
  output: string,
  withAudio = false,
  format = { width: 32, height: 24, fps: 8, duration: 1 }
): Buffer {
  if (
    realpathSync(ffmpeg.path) !== ffmpeg.path ||
    sha256(readFileSync(ffmpeg.path)) !== ffmpeg.sha256
  )
    throw new Error("fixture encoder pin drift");
  execFileSync(
    ffmpeg.path,
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${format.width}x${format.height}:rate=${format.fps}:duration=${format.duration}`,
      ...(withAudio
        ? ["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono:d=1", "-c:a", "aac"]
        : ["-an"]),
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-profile:v",
      "baseline",
      "-bf",
      "0",
      "-g",
      "8",
      "-pix_fmt",
      "yuv420p",
      "-bsf:v",
      "filter_units=remove_types=6",
      "-use_editlist",
      "0",
      "-map_metadata",
      "-1",
      "-fflags",
      "+bitexact",
      "-flags:v",
      "+bitexact",
      "-f",
      "mp4",
      output,
    ],
    { env: {}, timeout: 15000, maxBuffer: 1048576 }
  );
  // ffmpeg emits encoder/compressor metadata even with map_metadata=-1. Test-only scrub of this
  // disposable fixture, with moov after mdat: no media offsets change. Runtime NEVER rewrites input.
  const bytes = readFileSync(output);
  const scrub = (start: number, end: number, kind: string): Buffer => {
    const parts: Buffer[] = [];
    for (let cursor = start; cursor < end; ) {
      const size = bytes.readUInt32BE(cursor);
      const name = bytes.toString("ascii", cursor + 4, cursor + 8);
      if (name !== "udta") {
        let body: Buffer = Buffer.from(bytes.subarray(cursor + 8, cursor + size));
        if (["moov", "trak", "mdia", "minf", "stbl"].includes(name))
          body = scrub(cursor + 8, cursor + size, name);
        if (name === "stsd" && body.toString("ascii", 12, 16) === "avc1") {
          const compressor = 8 + 8 + 42;
          body.fill(0, compressor, compressor + 32);
        }
        const header = Buffer.alloc(8);
        header.writeUInt32BE(body.length + 8);
        header.write(name, 4);
        parts.push(header, body);
      }
      if (size < 8) throw new Error(`invalid synthetic ${kind}`);
      cursor += size;
    }
    return Buffer.concat(parts);
  };
  return scrub(0, bytes.length, "root");
}
class MediaConsumer implements Playbook {
  initialize(c: RunContext): Directive {
    return this.dispatch(c);
  }
  dispatch(c: RunContext): Directive {
    if (c.pendingDirective !== null) return c.pendingDirective;
    const receipt = required(c.selectedArtifacts.find((x) => x.kind === "host-operation-receipt"));
    const d: Directive = {
      schema_version: 2,
      action: "await_user",
      identity: c.identity,
      state_id: c.stateId,
      gate_id: "fixture-complete",
      challenge: "fixture-ack",
      payload_digest: receipt.content_digest,
      questions: [{ id: "ack", prompt: "Acknowledge raw fixture result (not production)." }],
    };
    c.status = "awaiting_user";
    c.pendingDirective = d;
    return d;
  }
  resume(c: RunContext, _r: JsonValue): Directive {
    return this.dispatch(c);
  }
  cancel(c: RunContext, _r: string): Directive {
    return this.dispatch(c);
  }
  acceptSummary(c: RunContext, _r: Record<string, JsonValue>): Directive {
    return this.dispatch(c);
  }
  rebindPendingDirective(c: RunContext): Directive | null {
    return c.pendingDirective;
  }
}
export class MediaFixture implements Disposable {
  readonly root = mkdtempSync(path.join(tmpdir(), "penny-videogen-media-"));
  readonly state_root = path.join(this.root, "state");
  readonly project_id: string;
  readonly run_id = "run-media";
  readonly store: ArtifactStore;
  readonly checkpointer: Checkpointer;
  readonly leases: HostOperationLeaseAuthority;
  readonly declaration: HostOperationDeclarationV1;
  readonly registration: PlaybookRegistration;
  readonly engine: OrchestrationEngine;
  readonly backend = sha256("media-fixture-worker");
  readonly policy_ref: ArtifactRef;
  readonly selection_ref: ArtifactRef;
  private sequence = 0;
  constructor(readonly policy: MediaDecodePolicyV1 = MEDIA_POLICY) {
    chmodSync(this.root, 0o700);
    using catalog = new ProjectCatalog(this.state_root, { create: true });
    this.project_id = catalog.registerProject(this.root).projectId;
    this.store = ArtifactStore.provision(path.join(this.root, "artifacts"), {
      projectId: this.project_id,
    });
    this.checkpointer = Checkpointer.provision(path.join(this.root, "control.db"), undefined, {
      projectId: this.project_id,
    });
    this.leases = new HostOperationLeaseAuthority(this.state_root);
    const lp = {
      profile_id: "media-fixture-lease",
      profile_version: 1 as const,
      duration_ms: 60000,
      renew_after_ms: 10000,
      queue_inactivity_ms: 30000,
    };
    this.declaration = {
      schema_version: 1,
      operation_kind: "media_decode_extract",
      adapter_id: "raw-media-fixture",
      request: RAW_MEDIA_REQUEST_CONTRACT,
      result: RAW_MEDIA_RESULT_CONTRACT,
      backend_binding_id: "media-fixture",
      capability_classes: ["artifact_store"],
      lease_profile: { ...lp, profile_sha256: hostOperationLeaseProfileSha256(lp) },
      operation_inactivity_ms: 60000,
      max_request_bytes: 16384,
      max_input_artifacts: 3,
      max_input_bytes: policy.max_input_bytes + 65536,
      output_contracts: [MEDIA_FRAME_CONTRACT, MEDIA_PCM_CONTRACT],
      max_output_artifacts: 32,
      max_output_bytes: policy.max_output_bytes,
      max_progress_events: 16,
      max_pre_acceptance_retries: 0,
      recovery_semantics: "disposable_v1",
      cancellation_semantics: "local_abort_only_v1",
    };
    const base = required(resolvePlaybook("research"));
    this.registration = {
      ...base,
      host_states: [...(base.host_states ?? []), "media-fixture"],
      host_operations: {
        schema_version: 1,
        max_active_per_run: 1,
        declarations: [this.declaration],
      },
      construct: () => new MediaConsumer(),
    };
    this.engine = new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.root,
      maxSteps: 20,
      receiptAuthority: ReceiptAuthority.provision(path.join(this.root, "receipt.key")),
      artifactStore: this.store,
      artifactReader: this.store,
      artifactRevisions: this.store,
      playbookRegistration: this.registration,
    });
    this.policy_ref = this.json(policy, policy.schema_id);
    this.selection_ref = this.json(MEDIA_SELECTION, MEDIA_SELECTION.schema_id);
  }
  raw(
    bytes: Uint8Array | string,
    mediaType: string,
    schemaId?: string,
    kind = "videogen-media-fixture"
  ): ArtifactRef {
    return this.store.persist({
      metadata: {
        schema_version: 2,
        run_id: this.run_id,
        phase: "media-fixture",
        branch_id: null,
        kind,
        operation_id: `fixture-${++this.sequence}`,
        version: 1,
        producer: "host:media-fixture",
        media_type: mediaType,
        parent_ref: null,
        upstream_refs: [],
        ...(schemaId === undefined
          ? {}
          : { content_schema: { schema_id: schemaId, schema_version: 1 } }),
      },
      content: bytes,
    });
  }
  json(value: unknown, schemaId: string, kind?: string): ArtifactRef {
    return this.raw(canonicalJson(value), "application/json", schemaId, kind);
  }
  request(
    bytes: Buffer,
    mediaType = "audio/wav",
    spans: RawMediaDecodeRequestV1["required_spans"] = [
      { start: { numerator: 0, denominator: 1 }, end: { numerator: 1, denominator: 1 } },
    ]
  ): RawMediaDecodeRequestV1 {
    return {
      schema_id: "penny.videogen-raw-media-decode-request.v1",
      schema_version: 1,
      operation_id: "media-operation",
      media_ref: this.raw(bytes, mediaType),
      decode_policy_ref: this.policy_ref,
      required_spans: spans,
      frame_selection_ref: this.selection_ref,
      audio_policy: mediaType === "audio/wav" ? "measure_pcm" : "forbid",
    };
  }
  prepare(request: RawMediaDecodeRequestV1): InvokeHostOperationDirectiveV1 {
    const ref = this.json(request, request.schema_id, RAW_MEDIA_REQUEST_CONTRACT.artifact_kind);
    const identity = {
      schema_version: 2 as const,
      run_id: this.run_id,
      session_id: "session-media",
      playbook: "research",
      engine_owner: "typescript" as const,
    };
    const d: InvokeHostOperationDirectiveV1 = {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity,
      state_id: "media-fixture",
      attempt: 1,
      operation_id: request.operation_id,
      operation_kind: "media_decode_extract",
      registration_sha256: runtimeRegistrationSha256(this.registration),
      request_ref: ref,
      request_sha256: ref.content_digest,
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "media", ref: request.media_ref },
          { slot: "decode-policy", ref: request.decode_policy_ref },
          { slot: "frame-selection", ref: request.frame_selection_ref },
        ],
      },
      expected_result: RAW_MEDIA_RESULT_CONTRACT,
      policy_binding: hostOperationPolicyBinding(this.declaration, this.backend),
    };
    const context = RunContext.create({
      identity,
      goal: "raw media owner protocol fixture",
      constraints: {},
      projectRoot: this.root,
      trustProfile: "trusted-interactive",
      maxSteps: 20,
      registrationContractBinding: {
        schema_version: 1,
        registration_name: this.registration.name,
        contract_sha256: skillContractSha256(this.registration.contract),
        registration_sha256: runtimeRegistrationSha256(this.registration),
      },
      initialArtifacts: [ref, ...d.input_artifacts.artifacts.map((x) => x.ref)],
    });
    context.transition(d.state_id);
    context.pendingDirective = d;
    this.checkpointer.createRun(context, "media_fixture_started", {});
    this.engine.liveness.bindPolicy(context);
    return d;
  }
  adapter(runner: ConfinedMediaRunner): HostOperationAdapterV1 {
    return createRawMediaDecodeAdapter({
      adapter_id: this.declaration.adapter_id,
      backend_binding_id: this.declaration.backend_binding_id,
      backend_key_sha256: this.backend,
      policy_ref: this.policy_ref,
      policy: this.policy,
      runner,
      limits: MEDIA_LIMITS,
    });
  }
  owner(
    adapter: HostOperationAdapterV1,
    fault?: HostOperationRuntimeOwnerOptions["fault"]
  ): HostOperationRuntimeOwner {
    return new HostOperationRuntimeOwner({
      projectId: this.project_id,
      checkpointer: this.checkpointer,
      artifacts: this.store,
      leaseAuthority: this.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
      ...(fault === undefined ? {} : { fault }),
    });
  }
  evidence(store = this.store, checkpointer = this.checkpointer): MediaEvidenceCustody {
    return new MediaEvidenceCustody({
      project_id: this.project_id,
      store,
      checkpointer,
      leases: this.leases,
      limits: MEDIA_LIMITS,
      declaration: this.declaration,
      registration_sha256: runtimeRegistrationSha256(this.registration),
      backend_key_sha256: this.backend,
      policy_ref: this.policy_ref,
    });
  }
  [Symbol.dispose](): void {
    this.leases.close();
    this.store.close();
    this.checkpointer.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
/** Deterministic owner-protocol fixture. Constructed PCM is NOT claimed as a decoder execution. */
export function protocolPcmAdapter(
  f: MediaFixture,
  request: RawMediaDecodeRequestV1,
  calls: { count: number }
): HostOperationAdapterV1 {
  return {
    adapter_id: f.declaration.adapter_id,
    inspectRequest: () => ({
      schema_version: 1,
      operation_kind: "media_decode_extract",
      adapter_id: f.declaration.adapter_id,
      backend_binding_id: f.declaration.backend_binding_id,
      backend_key_sha256: f.backend,
    }),
    async run(c) {
      calls.count++;
      c.beginSubmission();
      const wav = f.store.read(request.media_ref);
      const output = wav;
      const result: RawMediaDecodeResultV1 = {
        schema_id: "penny.videogen-raw-media-decode-result.v1",
        schema_version: 1,
        operation_id: request.operation_id,
        source_ref: request.media_ref,
        request_sha256: c.directive.request_sha256,
        policy_sha256: f.policy_ref.content_digest,
        selection_sha256: f.selection_ref.content_digest,
        required_spans: request.required_spans,
        decode_scope: "entire_source_including_preroll",
        container_policy: f.policy.metadata_policy,
        video: null,
        audio: {
          codec: "canonical_pcm",
          channels: "mono",
          sample_rate: 8000,
          decoded_sample_count: 8000,
          duration: { numerator: 1, denominator: 1 },
          spans: [
            { start_sample: 0, end_sample: 8000, slot: "pcm-0", ...measurePcm16(wav.subarray(44)) },
          ],
        },
        outputs: [
          {
            slot: "pcm-0",
            media_type: "audio/wav",
            sha256: sha256(output),
            byte_length: output.length,
          },
        ],
        qualification: "raw_decode_only_not_playback_or_production",
      };
      const content = canonicalJson(result);
      c.recordFetched({
        schema_version: 1,
        content_sha256: sha256(content),
        byte_length: Buffer.byteLength(content),
        item_count: 1,
        poll_count: 0,
      });
      const disposition = {
        outcome: "completed",
        remote_disposition: "proven_terminal",
        lease_disposition: "released",
        retryable: false,
        reason_code: null,
      } as const;
      const persisted = c.persist({
        disposition,
        operation_result: {
          contract: RAW_MEDIA_RESULT_CONTRACT,
          media_type: "application/json",
          content,
        },
        outputs: [{ contract: MEDIA_PCM_CONTRACT, media_type: "audio/wav", content: output }],
      });
      return { disposition, ...persisted };
    },
  };
}
export function canonicalExecutable(source: string): { path: string; sha256: string } {
  const resolved = realpathSync(source);
  return { path: resolved, sha256: sha256(readFileSync(resolved)) };
}
