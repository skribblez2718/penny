import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { OpaqueIdSchema, Sha256Schema, validateSkillSchema } from "../skill-contracts/common.js";
import { ComfyOutputDescriptorV1Schema } from "./contracts.js";

const CancelBindingSchema = Type.Object(
  {
    profile_id: OpaqueIdSchema,
    profile_schema_version: Type.Literal(1),
    profile_sha256: Sha256Schema,
    backend_key_sha256: Sha256Schema,
    endpoint: Type.Object(
      {
        scheme: Type.Literal("http"),
        host: Type.Union([Type.Literal("127.0.0.1"), Type.Literal("::1")]),
        port: Type.Integer({ minimum: 1, maximum: 65_535 }),
      },
      { additionalProperties: false }
    ),
    deployed_version_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

/** Host-reviewed observations, not an issuer or a live backend attestation. The host must
 * independently approve the exact canonical evidence digest and current deployed build.
 * A 2xx response, an asserted boolean, or a model/caller callback is not this contract.
 */
export const VideogenPromptCancellationEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-prompt-cancellation-evidence.v1"),
    schema_version: Type.Literal(1),
    binding: CancelBindingSchema,
    interrupt_protocol: Type.Literal("POST /interrupt:exact_prompt_id"),
    terminal_protocol: Type.Literal("GET /history/{prompt_id}:completed=true"),
    target_prompt_sha256: Sha256Schema,
    unrelated_prompt_sha256: Sha256Schema,
    target_terminal: Type.Object(
      {
        prompt_sha256: Sha256Schema,
        completed: Type.Literal(true),
        history_sha256: Sha256Schema,
      },
      { additionalProperties: false }
    ),
    unrelated_running_before_sha256: Sha256Schema,
    unrelated_running_after_sha256: Sha256Schema,
    unknown_target_noop: Type.Object(
      {
        prompt_sha256: Sha256Schema,
        running_before_sha256: Sha256Schema,
        running_after_sha256: Sha256Schema,
        transcript_sha256: Sha256Schema,
      },
      { additionalProperties: false }
    ),
    transcript_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type VideogenPromptCancellationEvidenceV1 = Static<
  typeof VideogenPromptCancellationEvidenceV1Schema
>;

const AuthoritySchema = Type.Object(
  {
    current_bindings: Type.Array(CancelBindingSchema, { minItems: 1, maxItems: 64 }),
    registrations: Type.Array(
      Type.Object(
        {
          binding: CancelBindingSchema,
          approved_evidence_sha256: Sha256Schema,
          evidence_json: Type.String({ minLength: 1, maxLength: 16_384 }),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 64 }
    ),
  },
  { additionalProperties: false }
);

// Membership is never inferred from a prototype, instanceof, or a virtual method.
const validatedCancellationEvidence = new WeakSet<object>();

/** Retained host-reviewed construction evidence, NOT live deployment authority.
 * No concrete current deployed-version/attestation selection exists in this render path.
 * Even a validated instance therefore cannot enable interrupts. Constructor pins cannot
 * establish that a server is unchanged or that approval has not been revoked at use time.
 */
export class VideogenPromptCancellationAuthorityV1 {
  constructor(input: unknown) {
    if (new.target !== VideogenPromptCancellationAuthorityV1)
      throw new Error("video cancellation evidence cannot be subclassed");
    const value = validateSkillSchema(
      AuthoritySchema,
      input,
      "VideogenPromptCancellationAuthorityV1"
    );
    const current = new Map<string, string>();
    for (const binding of value.current_bindings) {
      if (current.has(binding.profile_id))
        throw new Error("duplicate current cancellation profile");
      current.set(binding.profile_id, canonicalJson(binding));
    }
    const registered = new Set<string>();
    for (const registration of value.registrations) {
      const binding = registration.binding;
      if (registered.has(binding.profile_id))
        throw new Error("duplicate cancellation registration");
      registered.add(binding.profile_id);
      const text = registration.evidence_json;
      if (Buffer.byteLength(text, "utf8") > 16_384)
        throw new Error("cancellation evidence oversized");
      const parsed: unknown = JSON.parse(text);
      const evidence = validateSkillSchema(
        VideogenPromptCancellationEvidenceV1Schema,
        parsed,
        "VideogenPromptCancellationEvidenceV1"
      );
      if (
        canonicalJson(evidence) !== text ||
        sha256(text) !== registration.approved_evidence_sha256 ||
        canonicalJson(evidence.binding) !== canonicalJson(binding) ||
        current.get(binding.profile_id) !== canonicalJson(binding) ||
        evidence.target_prompt_sha256 === evidence.unrelated_prompt_sha256 ||
        evidence.target_terminal.prompt_sha256 !== evidence.target_prompt_sha256 ||
        evidence.unrelated_running_before_sha256 !== evidence.unrelated_running_after_sha256 ||
        evidence.unknown_target_noop.prompt_sha256 === evidence.target_prompt_sha256 ||
        evidence.unknown_target_noop.prompt_sha256 === evidence.unrelated_prompt_sha256 ||
        evidence.unknown_target_noop.running_before_sha256 !==
          evidence.unknown_target_noop.running_after_sha256
      ) {
        throw new Error("cancellation authorization/evidence identity drifted");
      }
    }
    validatedCancellationEvidence.add(this);
    Object.freeze(this);
  }
}
Object.freeze(VideogenPromptCancellationAuthorityV1.prototype);
Object.freeze(VideogenPromptCancellationAuthorityV1);

/** Concrete construction identity only; this does not grant permission to interrupt. */
export function isConcreteVideogenPromptCancellationAuthorityV1(
  value: unknown
): value is VideogenPromptCancellationAuthorityV1 {
  return typeof value === "object" && value !== null && validatedCancellationEvidence.has(value);
}

// Four-byte header length + bounded canonical UTF-8 metadata + original media bytes.
// 4096 covers the closed header (including the descriptor's 255/512-character maxima).
const MAX_FETCH_HEADER_BYTES = 4096;
const MAX_RESULT_CACHE_BYTES = 4_294_967_296;
const FetchHeaderSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-fetched-cache.v1"),
    schema_version: Type.Literal(1),
    operation_record_id: OpaqueIdSchema,
    directive_sha256: Sha256Schema,
    request_sha256: Sha256Schema,
    prompt_id_sha256: Sha256Schema,
    remote_descriptor: ComfyOutputDescriptorV1Schema,
    media_type: Type.Union([Type.Literal("video/mp4"), Type.Literal("invalid")]),
    video_sha256: Sha256Schema,
    video_byte_length: Type.Integer({ minimum: 0, maximum: MAX_RESULT_CACHE_BYTES }),
  },
  { additionalProperties: false }
);
export type VideogenFetchedCacheHeaderV1 = Static<typeof FetchHeaderSchema>;

/** One cache publication commits descriptor custody and bytes to the same fetched milestone. */
export function encodeVideogenFetchedCache(
  header: VideogenFetchedCacheHeaderV1,
  video: Uint8Array,
  maxBytes: number
): Uint8Array {
  const valid = validateSkillSchema(FetchHeaderSchema, header, "VideogenFetchedCacheHeaderV1");
  const encoded = Buffer.from(canonicalJson(valid), "utf8");
  const size = 4 + encoded.byteLength + video.byteLength;
  if (
    encoded.byteLength > MAX_FETCH_HEADER_BYTES ||
    size > Math.min(maxBytes, MAX_RESULT_CACHE_BYTES) ||
    valid.video_byte_length !== video.byteLength ||
    valid.video_sha256 !== sha256(video)
  )
    throw new Error("video fetched cache exceeds exact bounds or differs from its bytes");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(encoded.byteLength);
  return Buffer.concat([prefix, encoded, video], size);
}

export function decodeVideogenFetchedCache(
  bytes: Uint8Array,
  maxBytes: number
): {
  readonly header: VideogenFetchedCacheHeaderV1;
  readonly video: Uint8Array;
} {
  if (bytes.byteLength < 4 || bytes.byteLength > Math.min(maxBytes, MAX_RESULT_CACHE_BYTES))
    throw new Error("video fetched cache length is invalid");
  const buffer = Buffer.from(bytes);
  const length = buffer.readUInt32BE(0);
  if (length === 0 || length > MAX_FETCH_HEADER_BYTES || 4 + length > buffer.byteLength)
    throw new Error("video fetched cache header length is invalid");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4, 4 + length));
  const parsed: unknown = JSON.parse(text);
  const header = validateSkillSchema(FetchHeaderSchema, parsed, "VideogenFetchedCacheHeaderV1");
  const video = buffer.subarray(4 + length);
  if (
    canonicalJson(header) !== text ||
    header.video_byte_length !== video.byteLength ||
    header.video_sha256 !== sha256(video)
  )
    throw new Error("video fetched cache is noncanonical or corrupt");
  return { header, video };
}
