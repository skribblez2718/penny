import {
  VoiceApiCoverageSchema,
  VoiceApiCorrelationSchema,
  VoiceApiProfileSchema,
  VoiceApiRawResultSchema,
} from "./voice-api-contracts.js";
import type { TSchema } from "typebox";
import type { ArtifactStore } from "../artifact-store.js";
import { canonicalJson } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { readExact, validateFoundationLimits, type FoundationLimitsV1 } from "./bounds.js";
import {
  VideoRequestV1Schema,
  ProjectEnvelopeV1Schema,
  ScriptV1Schema,
  StoryCanonV1Schema,
  AssetIntentV1Schema,
  LookVoiceSelectionV1Schema,
  LookVoiceTemplateV1Schema,
  validateVideoRequest,
  validateProjectEnvelope,
  validateScript,
  validateScriptDraft,
  validateStoryCanon,
  validateAssetIntent,
} from "./foundation-contracts.js";
import {
  GatePacketV1Schema,
  GateDecisionV1Schema,
  validateGatePacket,
  validateGateDecision,
} from "./gates.js";
import {
  CrossRunEdgeV1Schema,
  DependencyLedgerV1Schema,
  validateDependencyLedger,
} from "./rights-ledger.js";
import { AudioSourceV1Schema, validateAudioSource } from "./audio-sources.js";
import { VideoEvidenceV1Schema } from "./media-contracts.js";
import { EditDecisionV1Schema, PortableManifestV1Schema } from "./edit-contracts.js";
import { NativeBuildRequestV1Schema, NativeBuildTemplateV1Schema } from "./native-contracts.js";
import { DeliveryIntentV1Schema } from "./delivery.js";
import { VIDEOGEN_WORKERS, validateVideogenWorker, workerState } from "./workers.js";
import {
  AudioEvidenceV1Schema,
  PlaybackReviewV1Schema,
  ShotMediaV1Schema,
  ShotResultV1Schema,
  AnimaticV1Schema,
  AdmittedAssetLedgerV1Schema,
  NativeBuildResultV1Schema,
  MasterReviewV1Schema,
  PackageReviewV1Schema,
  DeliveryReceiptV1Schema,
  VideogenTerminalV1Schema,
  ReviewBindingV1Schema,
  ReviewPacketV1Schema,
  PromotionProofV1Schema,
  RecoveryProofV1Schema,
  ShotRouteV1Schema,
  PreparedGraphV1Schema,
  HostStageResultV1Schema,
  OperationOutcomeV1Schema,
} from "./stage-contracts.js";
import { validateVideogenStageSemantics } from "./stage-validation.js";
import { validateEditDecision } from "./edit-decision.js";
import { parseVoiceWireJson } from "./voice-json.js";
const schemas: readonly [string, TSchema][] = [
  ["voice-api-coverage", VoiceApiCoverageSchema],
  ["voice-api-correlation", VoiceApiCorrelationSchema],
  ["voice-api-profile", VoiceApiProfileSchema],
  ["voice-api-raw-result", VoiceApiRawResultSchema],
  ["request", VideoRequestV1Schema],
  ["envelope", ProjectEnvelopeV1Schema],
  ["script", ScriptV1Schema],
  ["story-canon", StoryCanonV1Schema],
  ["asset-intent", AssetIntentV1Schema],
  ["look-voice", LookVoiceSelectionV1Schema],
  ["look-voice-template", LookVoiceTemplateV1Schema],
  ["gate-packet", GatePacketV1Schema],
  ["gate-decision", GateDecisionV1Schema],
  ["dependency-ledger", DependencyLedgerV1Schema],
  ["cross-run-edge", CrossRunEdgeV1Schema],
  ["audio-source", AudioSourceV1Schema],
  ["video-evidence", VideoEvidenceV1Schema],
  ["edit-decision", EditDecisionV1Schema],
  ["portable-package", PortableManifestV1Schema],
  ["native-build-request", NativeBuildRequestV1Schema],
  ["native-build-template", NativeBuildTemplateV1Schema],
  ["delivery-intent", DeliveryIntentV1Schema],
  ["audio-evidence", AudioEvidenceV1Schema],
  ["playback-review", PlaybackReviewV1Schema],
  ["shot-media", ShotMediaV1Schema],
  ["shot-result", ShotResultV1Schema],
  ["animatic", AnimaticV1Schema],
  ["admitted-asset-ledger", AdmittedAssetLedgerV1Schema],
  ["native-build-result", NativeBuildResultV1Schema],
  ["master-review", MasterReviewV1Schema],
  ["package-review", PackageReviewV1Schema],
  ["delivery-receipt", DeliveryReceiptV1Schema],
  ["terminal", VideogenTerminalV1Schema],
  ["review-binding", ReviewBindingV1Schema],
  ["review-packet", ReviewPacketV1Schema],
  ["promotion-proof", PromotionProofV1Schema],
  ["recovery-proof", RecoveryProofV1Schema],
  ["shot-route", ShotRouteV1Schema],
  ["prepared-graph", PreparedGraphV1Schema],
  ["host-stage-result", HostStageResultV1Schema],
  ["operation-outcome", OperationOutcomeV1Schema],
];
/** A fixed parser catalog, not extension-supplied validators and not a qualification authority. */
const catalog: ReadonlyMap<string, TSchema> = new Map([
  ...schemas.map(
    ([name, schema]) => [`penny.videogen-${name}.v1`, schema] satisfies [string, TSchema]
  ),
  ...Object.values(VIDEOGEN_WORKERS).map(
    (worker) =>
      [worker.schema.properties.schema_id.const, worker.schema] satisfies [string, TSchema]
  ),
]);
const productValidators: ReadonlyMap<
  string,
  (value: unknown, limits: FoundationLimitsV1) => unknown
> = new Map<string, (value: unknown, limits: FoundationLimitsV1) => unknown>([
  ["penny.videogen-request.v1", validateVideoRequest],
  ["penny.videogen-envelope.v1", validateProjectEnvelope],
  ["penny.videogen-script.v1", validateScript],
  ["penny.videogen-script-draft.v1", validateScriptDraft],
  ["penny.videogen-story-canon.v1", validateStoryCanon],
  ["penny.videogen-asset-intent.v1", validateAssetIntent],
  ["penny.videogen-gate-packet.v1", validateGatePacket],
  ["penny.videogen-gate-decision.v1", validateGateDecision],
  ["penny.videogen-dependency-ledger.v1", validateDependencyLedger],
  ["penny.videogen-audio-source.v1", validateAudioSource],
  ["penny.videogen-edit-decision.v1", validateEditDecision],
]);
function stageObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function videogenSemanticSchema(id: string): TSchema {
  const schema = catalog.get(id);
  if (schema === undefined) throw new Error(`videogen missing fixed semantic validator: ${id}`);
  return schema;
}
/** Reuse the bounded, duplicate-key rejecting JSON parser. Stage policy can only lower its bounds.
 * Unlike foundation integer-only documents, audio loudness/peak measurements legitimately use decimals.
 */
export function parseVideogenStageJson(
  bytes: Uint8Array,
  schema: TSchema,
  limits: FoundationLimitsV1
): unknown {
  validateFoundationLimits(limits);
  if (bytes.byteLength === 0 || bytes.byteLength > limits.max_json_bytes)
    throw new Error("videogen stage JSON byte limit");
  const value = parseVoiceWireJson(bytes);
  let nodes = 0;
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > limits.max_nodes || depth > limits.max_depth)
      throw new Error("videogen stage JSON complexity limit");
    if (
      typeof item === "string" &&
      (Buffer.byteLength(item, "utf8") > limits.max_text_bytes ||
        Buffer.from(item, "utf8").toString("utf8") !== item)
    )
      throw new Error("videogen stage text limit");
    if (typeof item === "number" && (!Number.isFinite(item) || Math.abs(item) > limits.max_integer))
      throw new Error("videogen stage numeric limit");
    if (item !== null && typeof item === "object") {
      if (Array.isArray(item)) {
        if (item.length > limits.max_collection_items)
          throw new Error("videogen stage collection limit");
        for (const child of item) walk(child, depth + 1);
      } else if (stageObject(item)) {
        const entries = Object.entries(item);
        if (entries.length > limits.max_collection_items)
          throw new Error("videogen stage collection limit");
        for (const [key, child] of entries) {
          walk(key, depth + 1);
          walk(child, depth + 1);
        }
      } else throw new Error("videogen stage JSON object expected");
    }
  };
  walk(value, 0);
  if (canonicalJson(value) !== Buffer.from(bytes).toString("utf8"))
    throw new Error("videogen stage requires canonical JSON");
  return validateSkillSchema(schema, value, "videogen stage product");
}
export function readVideogenStageProduct(input: {
  readonly artifacts: ArtifactStore;
  readonly project_id: string;
  readonly ref: ArtifactRef;
  readonly schema_id: string;
  readonly limits: FoundationLimitsV1;
}): unknown {
  if (
    input.ref.media_type !== "application/json" ||
    input.ref.content_schema?.schema_id !== input.schema_id ||
    input.ref.content_schema.schema_version !== 1
  )
    throw new Error("videogen semantic schema binding mismatch");
  const value = parseVideogenStageJson(
    readExact(input.artifacts, input.project_id, input.ref, input.limits.max_json_bytes),
    videogenSemanticSchema(input.schema_id),
    input.limits
  );
  productValidators.get(input.schema_id)?.(value, input.limits);
  const worker = Object.entries(VIDEOGEN_WORKERS).find(
    ([, item]) => item.schema.properties.schema_id.const === input.schema_id
  );
  if (worker !== undefined && workerState(worker[0])) validateVideogenWorker(worker[0], value);
  validateVideogenStageSemantics(input.schema_id, value);
  return value;
}
