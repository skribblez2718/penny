import { Type } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { JsonValueSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { readVideogenOwnerSelection, type VideogenOwnerSelection } from "./owner-selection.js";
import { sameRef } from "./bounds.js";
import { VoiceStudioTransport } from "./voice-studio-transport.js";
import {
  VoiceStudioHealthV1Schema,
  VoiceStudioVoiceV1Schema,
  type VoiceStudioCorrelationV1,
  type VoiceStudioJobRequestV1,
  type VoiceStudioNarrationV1,
} from "./voice-studio-contracts.js";
import { VoiceApiCoverageSchema, type VoiceApiProfile } from "./voice-api-contracts.js";
import type { LocalApiOperationMeter } from "../host-operations/local-api-meter.js";
const concrete = new WeakSet<object>();
/** Separate concrete alternative to native snapshot collection. It cannot issue native readiness,
 * resolved voice, fallback=false or per-chunk traces. Raw API responses are retained verbatim JSON. */
export class VoiceApiObservationCollector {
  readonly client: VoiceStudioTransport;
  private responseBytes = 0;
  readonly responses: {
    method: "GET" | "POST";
    route: string;
    body: import("../contracts.js").JsonValue;
  }[] = [];
  constructor(
    readonly b: {
      owner: VideogenOwnerSelection;
      profile_ref: ArtifactRef;
      profile: VoiceApiProfile;
      transport: unknown;
      wire_meter?: LocalApiOperationMeter;
    }
  ) {
    this.client = new VoiceStudioTransport(b.transport, b.profile.limits, undefined, b.wire_meter);
    readVideogenOwnerSelection(b.owner);
    concrete.add(this);
  }
  static require(
    value: unknown,
    owner: VideogenOwnerSelection,
    ref: ArtifactRef,
    transport: unknown
  ): VoiceApiObservationCollector {
    if (
      !(value instanceof VoiceApiObservationCollector) ||
      !concrete.has(value) ||
      value.b.owner !== owner ||
      !sameRef(value.b.profile_ref, ref) ||
      canonicalJson(value.client.config) !== canonicalJson(transport)
    )
      throw new Error("same concrete API observation collector/owner required");
    return value;
  }
  rebindOwner(owner: VideogenOwnerSelection): VoiceApiObservationCollector {
    const old = readVideogenOwnerSelection(this.b.owner),
      next = readVideogenOwnerSelection(owner);
    if (old.gate.run_id !== next.gate.run_id || old.gate.project_id !== next.gate.project_id)
      throw new Error("API observation owner drift");
    return new VoiceApiObservationCollector({ ...this.b, owner });
  }
  selected(_kind: "readiness" | "coverage", _correlation?: VoiceStudioCorrelationV1): ArtifactRef {
    throw new Error("trusted API observations are not native snapshot evidence");
  }
  async collect(
    _kind: "readiness" | "coverage",
    _signal: AbortSignal,
    _input?: {
      correlation: VoiceStudioCorrelationV1;
      request: VoiceStudioJobRequestV1;
      narration: VoiceStudioNarrationV1;
    }
  ): Promise<ArtifactRef> {
    throw new Error("trusted API observations cannot collect native process evidence");
  }
  async json(
    method: "GET" | "POST",
    route: string,
    signal: AbortSignal,
    body?: unknown
  ): Promise<unknown> {
    const response = await this.client.json(method, route, signal, body);
    this.responseBytes += Buffer.byteLength(canonicalJson(response));
    if (this.responseBytes > this.b.profile.limits.max_json_bytes)
      throw new Error("Voice API aggregate response byte limit");
    if (this.responses.length >= 10000) throw new Error("voice API response limit");
    this.responses.push({
      method,
      route,
      body: validateContract(JsonValueSchema, response, "raw voice API response"),
    });
    return response;
  }
  async inspect(signal: AbortSignal): Promise<void> {
    const p = this.b.profile;
    const schema = validateContract(
      Type.Object({
        openapi: Type.String({ minLength: 1, maxLength: 64 }),
        paths: Type.Record(Type.String(), JsonValueSchema),
      }),
      await this.json("GET", "/openapi.json", signal),
      "Voice API schema"
    );
    for (const [route, method] of [
      ["/api/narrations", "post"],
      ["/api/narrations/{item_id}", "get"],
      ["/api/tts/generate", "post"],
      ["/api/tts/jobs/{job_id}", "get"],
      ["/api/tts/result/{item_id}.wav", "get"],
    ]) {
      const operation = route === undefined ? undefined : schema.paths[route];
      if (
        operation === null ||
        typeof operation !== "object" ||
        Array.isArray(operation) ||
        method === undefined ||
        !(method in operation)
      )
        throw new Error("Voice API required job operation unsupported");
    }
    const health = validateContract(
      VoiceStudioHealthV1Schema,
      await this.json("GET", "/api/system/health", signal),
      "Voice API health"
    );
    // VoiceBase may support saved voices without all models loaded. The actual job is authoritative.
    if (health.status !== "ok" || health.engine !== p.engine)
      throw new Error("Voice API unavailable/engine drift");
    const voices = validateContract(
      Type.Array(VoiceStudioVoiceV1Schema, { maxItems: 1000 }),
      await this.json("GET", "/api/voices", signal),
      "Voice API voices"
    );
    const selected = voices.filter((v) => v.id === p.voice_id);
    const voice = validateContract(
      VoiceStudioVoiceV1Schema,
      await this.json("GET", `/api/voices/${p.voice_id}`, signal),
      "Voice API selected voice"
    );
    if (
      selected.length !== 1 ||
      new Set(voices.map((v) => v.id)).size !== voices.length ||
      canonicalJson(selected[0]) !== canonicalJson(voice) ||
      sha256(canonicalJson(voice)) !== p.voice_sha256
    )
      throw new Error("Voice API exact saved voice missing/drift");
    const sample = await this.client.wav(`/api/voices/${p.voice_id}/sample`, signal, true);
    if (sha256(sample) !== p.sample_sha256) throw new Error("Voice API sample drift");
  }
  checkpointResponses(operationId: string): void {
    const h = readVideogenOwnerSelection(this.b.owner),
      kind = "voice-api-accepted-responses";
    const bytes = canonicalJson(this.responses);
    const prior = h.gate.store.refFor(
      h.gate.run_id,
      "voice-api-observation",
      null,
      kind,
      operationId,
      1
    );
    if (prior) {
      if (h.gate.store.read(prior).toString() !== bytes)
        throw new Error("Voice API acceptance transcript conflict");
      return;
    }
    const ref = h.gate.store.persist({
      metadata: {
        schema_version: 2,
        run_id: h.gate.run_id,
        phase: "voice-api-observation",
        branch_id: null,
        kind,
        operation_id: operationId,
        version: 1,
        producer: "host:videogen-voice-api-observer",
        media_type: "application/json",
        parent_ref: null,
        upstream_refs: [this.b.profile_ref],
      },
      content: bytes,
    });
    this.b.wire_meter?.recordArtifact(ref);
  }
  adoptResponses(operationId: string): void {
    const h = readVideogenOwnerSelection(this.b.owner);
    const ref = h.gate.store.refFor(
      h.gate.run_id,
      "voice-api-observation",
      null,
      "voice-api-accepted-responses",
      operationId,
      1
    );
    if (!ref) throw new Error("Voice API original acceptance transcript missing");
    const responses = validateContract(
      VoiceApiCoverageSchema.properties.raw_responses,
      JSON.parse(h.gate.store.read(ref).toString()),
      "Voice API original responses"
    );
    this.responses.unshift(...responses);
  }
  persistCoverage(value: unknown, operationId: string): ArtifactRef {
    const v = validateContract(VoiceApiCoverageSchema, value, "Voice API coverage"),
      h = readVideogenOwnerSelection(this.b.owner);
    const bytes = canonicalJson(v);
    if (Buffer.byteLength(bytes) > this.b.profile.limits.max_json_bytes)
      throw new Error("Voice API coverage byte limit");
    const kind = "videogen-voice-api-coverage";
    const prior = h.gate.store.refFor(
      h.gate.run_id,
      "voice-api-observation",
      null,
      kind,
      operationId,
      1
    );
    if (prior) {
      if (h.gate.store.read(prior).toString() !== bytes)
        throw new Error("Voice API original coverage conflict");
      return prior;
    }
    const ref = h.gate.store.persist({
      metadata: {
        schema_version: 2,
        run_id: h.gate.run_id,
        phase: "voice-api-observation",
        branch_id: null,
        kind,
        operation_id: operationId,
        version: 1,
        producer: "host:videogen-voice-api-observer",
        media_type: "application/json",
        content_schema: { schema_id: v.schema_id, schema_version: 1 },
        parent_ref: null,
        upstream_refs: [this.b.profile_ref, v.script_ref, v.chunk_plan_ref],
      },
      content: bytes,
    });
    if (h.gate.store.read(ref).toString() !== bytes) throw new Error("Voice API coverage readback");
    this.b.wire_meter?.recordArtifact(ref);
    return ref;
  }
}
