import { Type, type Static } from "typebox";
import { ArtifactRefSchema } from "../contracts.js";
import {
  OpaqueIdSchema as Id,
  Rfc3339UtcSchema,
  assertRfc3339Utc,
  assertUnique,
} from "../skill-contracts/common.js";
import {
  readExact,
  readSemantic,
  sameRef,
  validateFoundation,
  type FoundationLimitsV1,
} from "./bounds.js";
import {
  RationalRateSchema,
  RationalTimeSchema,
  compareTime,
  validateRationalRate,
  validateRationalTime,
} from "./rational-time.js";
import {
  CurrentRightsV1Schema,
  ProvenanceBindingV1Schema,
  RightsBindingV1Schema,
  RightsUseSchema,
  assertAuthorizedOrigin,
  type RightsHostV1,
  type RightsUse,
} from "./rights-ledger.js";
import type { AudioSourceV1, AudioSourceDecodeCustody } from "./audio-sources.js";

const closed = { additionalProperties: false } as const;
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const AudioStemRoleSchema = Type.Union([
  Type.Literal("dialogue"),
  Type.Literal("narration"),
  Type.Literal("music"),
  Type.Literal("sfx"),
  Type.Literal("ambience"),
]);
/** Dedicated general-audio rights, not a widened WP-003 rights schema. Selection still uses
 * exactly the existing host-current rights index and explicit authorized cross-run edges.
 * Voice/performer subjects continue through checkRights, unchanged. Performed/cloned content
 * can occur in music/SFX too; role labels never waive consent. This is host-authored, not ingress. */
export const AudioRightsBindingV1Schema = Type.Object(
  {
    ...RightsBindingV1Schema.properties,
    schema_id: Type.Literal("penny.videogen-audio-rights-binding.v1"),
    subject_kind: Type.Literal("audio"),
    allowed_roles: Type.Array(AudioStemRoleSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
    voice_use: Type.Union([
      Type.Literal("none"),
      Type.Literal("performed"),
      Type.Literal("cloned"),
    ]),
  },
  closed
);
export type AudioRightsBindingV1 = Static<typeof AudioRightsBindingV1Schema>;

/** Separately host-selected, immutable artifact-only provider contract. It approves exact
 * captured outputs, NOT future jobs, URLs, callbacks, tools, or a generator service. Captures
 * must be selected again in a new contract when bytes/provenance change. The sole meter is
 * captured stored_bytes, measured from exact media bytes; no GPU/cost/spend claim is invented. */
export const AudioProviderContractV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-audio-provider-contract.v1"),
    schema_version: Type.Literal(1),
    provider_id: Id,
    media_producer: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^host:[A-Za-z0-9][A-Za-z0-9._:-]*$",
    }),
    allowed_roles: Type.Array(AudioStemRoleSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
    allowed_uses: Type.Array(RightsUseSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
    media_type: Type.Literal("audio/wav"),
    codec: Type.Literal("canonical_pcm"),
    channels: Type.Array(Type.Union([Type.Literal("mono"), Type.Literal("stereo")]), {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    }),
    sample_rates: Type.Array(RationalRateSchema, { minItems: 1, maxItems: 16, uniqueItems: true }),
    max_samples: positive,
    max_duration: RationalTimeSchema,
    capture_meter: Type.Object(
      { meter: Type.Literal("stored_bytes"), unit: Type.Literal("byte"), limit: positive },
      closed
    ),
    captured_outputs: Type.Array(
      Type.Object({ media_ref: ArtifactRefSchema, provenance_ref: ArtifactRefSchema }, closed),
      { minItems: 1, maxItems: 128 }
    ),
    valid_from_utc: Rfc3339UtcSchema,
    expires_at_utc: Rfc3339UtcSchema,
  },
  closed
);
export type AudioProviderContractV1 = Static<typeof AudioProviderContractV1Schema>;
const ProviderSelectionsSchema = Type.Array(
  Type.Object({ provider_id: Id, contract_ref: ArtifactRefSchema }, closed),
  { maxItems: 128 }
);
export type AudioProviderSelectionV1 = Static<typeof ProviderSelectionsSchema>[number];
export interface AudioSourceHostV1 extends RightsHostV1 {
  /** Construction-time trusted host dependencies, never copied from a request or worker. */
  readonly current_audio_provider_contracts?: readonly AudioProviderSelectionV1[];
  readonly audio_decode_custody?: AudioSourceDecodeCustody;
}
function currentLifetime(start: string, end: string, now: string): void {
  assertRfc3339Utc(start, "audio authority start");
  assertRfc3339Utc(end, "audio authority expiry");
  assertRfc3339Utc(now, "host clock");
  if (
    Date.parse(start) >= Date.parse(end) ||
    Date.parse(now) < Date.parse(start) ||
    Date.parse(now) >= Date.parse(end)
  )
    throw new Error("audio authority lifetime");
}
export function checkAudioRights(
  host: RightsHostV1,
  source: AudioSourceV1,
  use: RightsUse
): AudioRightsBindingV1 {
  const current = validateFoundation(
    Type.Array(CurrentRightsV1Schema),
    host.current_rights,
    host.limits
  );
  assertUnique(
    current.map((r) => r.subject_ref.artifact_id),
    "current rights subjects"
  );
  const selected = current.find((r) => sameRef(r.subject_ref, source.media_ref));
  if (
    !selected ||
    selected.status !== "cleared" ||
    !sameRef(selected.rights_ref, source.rights_ref)
  )
    throw new Error("audio rights missing, stale or revoked");
  const rights = readSemantic({
    ...host,
    ref: source.rights_ref,
    schema: AudioRightsBindingV1Schema,
    schema_id: "penny.videogen-audio-rights-binding.v1",
  });
  currentLifetime(rights.valid_from_utc, rights.expires_at_utc, host.now_utc);
  const consent = source.consent_ref;
  if (
    !sameRef(rights.subject_ref, source.media_ref) ||
    rights.revision !== selected.revision ||
    !rights.allowed_uses.includes(use) ||
    !rights.territories.includes(host.territory) ||
    !rights.allowed_roles.includes(source.role) ||
    !sameRef(rights.provenance_ref, source.provenance_ref) ||
    ((source.role === "dialogue" || source.role === "narration") && rights.voice_use === "none") ||
    (rights.voice_use !== "none" && (consent === undefined || rights.consent_refs.length === 0)) ||
    (consent !== undefined && !rights.consent_refs.some((r) => sameRef(r, consent)))
  )
    throw new Error("audio rights role/use/consent mismatch");
  assertUnique(
    rights.consent_refs.map((r) => r.artifact_id),
    "consent refs"
  );
  const provenance = readSemantic({
    ...host,
    ref: rights.provenance_ref,
    schema: ProvenanceBindingV1Schema,
    schema_id: "penny.videogen-provenance-binding.v1",
  });
  if (!sameRef(provenance.subject_ref, source.media_ref))
    throw new Error("audio provenance subject");
  for (const ref of [
    source.media_ref,
    rights.license_ref,
    ...rights.consent_refs,
    ...provenance.source_refs,
    provenance.producer_receipt_ref,
  ])
    readExact(host.store, host.project_id, ref, host.limits.max_integer);
  assertAuthorizedOrigin(host, source.media_ref, source.rights_ref, source.provenance_ref);
  return rights;
}
export function validateAudioProviderContract(
  value: unknown,
  limits: FoundationLimitsV1
): AudioProviderContractV1 {
  const c = validateFoundation(AudioProviderContractV1Schema, value, limits);
  assertRfc3339Utc(c.valid_from_utc, "provider contract start");
  assertRfc3339Utc(c.expires_at_utc, "provider contract expiry");
  if (Date.parse(c.valid_from_utc) >= Date.parse(c.expires_at_utc))
    throw new Error("provider contract lifetime");
  validateRationalTime(c.max_duration);
  if (c.max_duration.numerator <= 0) throw new Error("provider duration");
  for (const rate of c.sample_rates) validateRationalRate(rate);
  assertUnique(
    c.captured_outputs.map((o) => o.media_ref.artifact_id),
    "provider captured outputs"
  );
  return c;
}
export function checkAudioProviderContract(
  host: AudioSourceHostV1,
  source: AudioSourceV1,
  use: RightsUse
): void {
  if (source.source_kind !== "registered_generator") return;
  const selections = validateFoundation(
    ProviderSelectionsSchema,
    host.current_audio_provider_contracts ?? [],
    host.limits
  );
  assertUnique(
    selections.map((s) => s.provider_id),
    "current audio providers"
  );
  const selected = selections.find((s) => s.provider_id === source.registered_provider_id);
  if (!selected) throw new Error("missing separately approved provider contract");
  const contract = validateAudioProviderContract(
    readSemantic({
      ...host,
      ref: selected.contract_ref,
      schema: AudioProviderContractV1Schema,
      schema_id: "penny.videogen-audio-provider-contract.v1",
    }),
    host.limits
  );
  currentLifetime(contract.valid_from_utc, contract.expires_at_utc, host.now_utc);
  if (
    contract.provider_id !== source.registered_provider_id ||
    source.media_ref.producer !== contract.media_producer ||
    !contract.allowed_roles.includes(source.role) ||
    !contract.allowed_uses.includes(use) ||
    !contract.channels.includes(source.channels) ||
    !contract.sample_rates.some(
      (r) =>
        r.numerator === source.sample_rate.numerator &&
        r.denominator === source.sample_rate.denominator
    ) ||
    source.media_ref.media_type !== contract.media_type ||
    source.codec !== contract.codec ||
    source.media_ref.byte_length > contract.capture_meter.limit ||
    compareTime(source.duration, contract.max_duration) > 0 ||
    BigInt(source.duration.numerator) * BigInt(source.sample_rate.numerator) >
      BigInt(contract.max_samples) *
        BigInt(source.duration.denominator) *
        BigInt(source.sample_rate.denominator) ||
    !contract.captured_outputs.some(
      (o) =>
        sameRef(o.media_ref, source.media_ref) && sameRef(o.provenance_ref, source.provenance_ref)
    )
  )
    throw new Error("provider contract capture/role/format/meter mismatch");
}
