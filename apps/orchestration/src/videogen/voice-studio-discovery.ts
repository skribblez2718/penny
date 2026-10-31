import { Type } from "typebox";
import type { ArtifactRef } from "../contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import {
  VoiceStudioHealthV1Schema,
  VoiceStudioVoiceV1Schema,
  VoiceStudioProfileV1Schema,
  type VoiceStudioHealthV1,
  type VoiceStudioVoiceV1,
  type VoiceStudioProfileV1,
  type VoiceStudioLimitsV1,
  type VoiceStudioTransportV1,
} from "./voice-studio-contracts.js";
import { VoiceStudioTransport } from "./voice-studio-transport.js";

export interface VoiceStudioSavedVoiceInspectionV1 {
  readonly health: VoiceStudioHealthV1;
  readonly voice: VoiceStudioVoiceV1;
  readonly voice_sha256: string;
  readonly sample_sha256: string;
  readonly sample_bytes: number;
}
/** Four bounded GETs through the production TLS/JSON boundary. No text/audio logging,
 * generation, model loading, persistence, readiness claim, or newest-voice guessing. */
export async function inspectVoiceStudioSavedVoice(
  transport: VoiceStudioTransportV1,
  limits: VoiceStudioLimitsV1,
  voice_id: string,
  signal: AbortSignal
): Promise<VoiceStudioSavedVoiceInspectionV1> {
  validateSkillSchema(VoiceStudioVoiceV1Schema.properties.id, voice_id, "saved voice ID");
  const client = new VoiceStudioTransport(transport, limits);
  const health = validateSkillSchema(
    VoiceStudioHealthV1Schema,
    await client.json("GET", "/api/system/health", signal),
    "voice health"
  );
  const voices = validateSkillSchema(
    Type.Array(VoiceStudioVoiceV1Schema, { maxItems: 1000 }),
    await client.json("GET", "/api/voices", signal),
    "voice discovery"
  );
  const selected = voices.filter((v) => v.id === voice_id);
  if (selected.length !== 1 || new Set(voices.map((v) => v.id)).size !== voices.length)
    throw new Error("exact saved voice missing/duplicate");
  const voice = validateSkillSchema(
    VoiceStudioVoiceV1Schema,
    await client.json("GET", `/api/voices/${voice_id}`, signal),
    "saved voice detail"
  );
  if (canonicalJson(voice) !== canonicalJson(selected[0]))
    throw new Error("saved voice list/detail drift");
  const sample = await client.wav(`/api/voices/${voice_id}/sample`, signal, true);
  if (
    sample.length < 12 ||
    sample.toString("ascii", 0, 4) !== "RIFF" ||
    sample.readUInt32LE(4) !== sample.length - 8 ||
    sample.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("saved voice sample is not a complete RIFF/WAVE");
  return {
    health,
    voice,
    voice_sha256: sha256(canonicalJson(voice)),
    sample_sha256: sha256(sample),
    sample_bytes: sample.length,
  };
}
export interface VoiceStudioProfileInputsV1 {
  readonly profile_id: string;
  readonly backend_binding_id: string;
  readonly process_worker_id: string;
  readonly gpu_resource_ids: string[];
  readonly service_build_ref: ArtifactRef;
  readonly model_sha256: string;
  readonly media_policy_ref: ArtifactRef;
  readonly limits: VoiceStudioLimitsV1;
}
/** Bootstrap the actual saved record, without inventing build/model/policy refs or readiness. */
export function createVoiceStudioProfileFromSavedVoice(
  input: VoiceStudioProfileInputsV1,
  observed: VoiceStudioSavedVoiceInspectionV1
): VoiceStudioProfileV1 {
  validateSkillSchema(VoiceStudioVoiceV1Schema, observed.voice, "saved voice");
  validateSkillSchema(VoiceStudioHealthV1Schema, observed.health, "voice health");
  if (sha256(canonicalJson(observed.voice)) !== observed.voice_sha256 || observed.sample_bytes < 12)
    throw new Error("saved voice inspection drift");
  return validateSkillSchema(
    VoiceStudioProfileV1Schema,
    {
      schema_id: "penny.videogen-voice-studio-profile.v1",
      schema_version: 1,
      ...input,
      voice_id: observed.voice.id,
      voice_sha256: observed.voice_sha256,
      sample_sha256: observed.sample_sha256,
      engine: observed.health.engine,
    },
    "saved voice profile"
  );
}
