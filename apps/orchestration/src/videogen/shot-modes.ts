import { Type, type Static } from "typebox";
import type { Checkpointer } from "../checkpointer.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import { canonicalJson } from "../canonical-json.js";
import { OpaqueIdSchema as Id, assertUnique } from "../skill-contracts/common.js";
import {
  readExact,
  readSemantic,
  sameRef,
  validateFoundation,
  type FoundationLimitsV1,
} from "./bounds.js";
import { LookVoiceSelectionV1Schema } from "./foundation-contracts.js";
import {
  RationalRateSchema,
  RationalTimeSchema,
  validateRationalRate,
  validateRationalTime,
  quantizeBoundary,
} from "./rational-time.js";
import { checkGateApproval, type GateBindingHostV1 } from "./gates.js";
import { checkRights, type RightsHostV1 } from "./rights-ledger.js";
const closed = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const refs = Type.Array(ArtifactRefSchema, { minItems: 1, uniqueItems: true });
const common = {
  shot_id: Id,
  profile_snapshot_ref: ArtifactRefSchema,
  settings_ref: ArtifactRefSchema,
  rights_refs: refs,
  prompt_ref: ArtifactRefSchema,
  expected_output_contract_ref: ArtifactRefSchema,
  target: Type.Object(
    {
      width: count,
      height: count,
      frame_count: count,
      fps: RationalRateSchema,
      duration: RationalTimeSchema,
    },
    closed
  ),
};
export const ShotModeV1Schema = Type.Union([
  Type.Object({ ...common, mode: Type.Literal("t2v") }, closed),
  Type.Object({ ...common, mode: Type.Literal("i2v"), first_png: ArtifactRefSchema }, closed),
  Type.Object(
    {
      ...common,
      mode: Type.Literal("flf2v"),
      first_png: ArtifactRefSchema,
      last_png: ArtifactRefSchema,
    },
    closed
  ),
  Type.Object(
    {
      ...common,
      mode: Type.Literal("controlled"),
      basis_ref: ArtifactRefSchema,
      controls: Type.Array(
        Type.Object(
          {
            kind: Type.Union([
              Type.Literal("pose"),
              Type.Literal("depth"),
              Type.Literal("edge"),
              Type.Literal("line"),
              Type.Literal("performer"),
            ]),
            media_ref: ArtifactRefSchema,
            frame_rate: RationalRateSchema,
            alignment_ref: ArtifactRefSchema,
            consent_ref: Type.Optional(ArtifactRefSchema),
          },
          closed
        ),
        { minItems: 1 }
      ),
      mask_png: Type.Optional(ArtifactRefSchema),
    },
    closed
  ),
  Type.Object(
    {
      ...common,
      mode: Type.Literal("camera"),
      basis_ref: ArtifactRefSchema,
      trajectory_ref: ArtifactRefSchema,
    },
    closed
  ),
  Type.Object(
    {
      ...common,
      mode: Type.Literal("speech_conditioned"),
      performance_audio_ref: ArtifactRefSchema,
      timing_ref: ArtifactRefSchema,
      look_inputs: refs,
      consent_ref: ArtifactRefSchema,
      sync_target: Id,
    },
    closed
  ),
  Type.Object(
    {
      ...common,
      mode: Type.Literal("specialty"),
      specialty_kind: Type.Union([
        Type.Literal("animatediff"),
        Type.Literal("deforum"),
        Type.Literal("performer_transfer"),
      ]),
      registered_schema_ref: ArtifactRefSchema,
      registered_profile_ref: ArtifactRefSchema,
      rights_ref: ArtifactRefSchema,
    },
    closed
  ),
]);
export type ShotModeV1 = Static<typeof ShotModeV1Schema>;
export const ShotPortV1Schema = Type.Object(
  {
    port_id: Id,
    semantic_role: Id,
    ref: ArtifactRefSchema,
    byte_limit: count,
    media_type: ArtifactRefSchema.properties.media_type,
    codec: Type.Optional(Id),
    mutation_node: Id,
    mutation_input: Id,
    upload_operation_id: Id,
  },
  closed
);
export type ShotPortV1 = Static<typeof ShotPortV1Schema>;
/** Host-internal qualified schema/profile/port binding, never arbitrary graph JSON. */
export const ShotCapabilityV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-shot-capability.v1"),
    schema_version: Type.Literal(1),
    profile_snapshot_ref: ArtifactRefSchema,
    settings_ref: ArtifactRefSchema,
    expected_output_contract_ref: ArtifactRefSchema,
    qualification_ref: ArtifactRefSchema,
    mode: Type.Union([
      Type.Literal("t2v"),
      Type.Literal("i2v"),
      Type.Literal("flf2v"),
      Type.Literal("controlled"),
      Type.Literal("camera"),
      Type.Literal("speech_conditioned"),
      Type.Literal("specialty"),
    ]),
    specialty_kind: Type.Optional(
      Type.Union([
        Type.Literal("animatediff"),
        Type.Literal("deforum"),
        Type.Literal("performer_transfer"),
      ])
    ),
    registered_schema_ref: Type.Optional(ArtifactRefSchema),
    registered_profile_ref: Type.Optional(ArtifactRefSchema),
    output_field: Id,
    max_width: count,
    max_height: count,
    max_frames: count,
    max_duration: RationalTimeSchema,
    ports: Type.Array(
      Type.Object(
        {
          port_id: Id,
          semantic_role: Id,
          media_type: ArtifactRefSchema.properties.media_type,
          codec: Type.Optional(Id),
          byte_limit: count,
          mutation_node: Id,
          mutation_input: Id,
        },
        closed
      )
    ),
  },
  closed
);
export type ShotCapabilityV1 = Static<typeof ShotCapabilityV1Schema>;
export const TimingEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-timing.v1"),
    schema_version: Type.Literal(1),
    performance_ref: ArtifactRefSchema,
    script_ref: ArtifactRefSchema,
    source_sample_rate: RationalRateSchema,
    measured_samples: count,
    utterances: Type.Array(
      Type.Object(
        {
          line_id: Id,
          start_sample: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
          end_sample: count,
          alignment_method: Type.Union([
            Type.Literal("qualified_alignment"),
            Type.Literal("human_review"),
          ]),
          review_ref: ArtifactRefSchema,
        },
        closed
      ),
      { minItems: 1 }
    ),
    uncertain_line_ids: Type.Array(Id, { uniqueItems: true }),
  },
  closed
);
export type TimingEvidenceV1 = Static<typeof TimingEvidenceV1Schema>;
/** Current host decode/alignment binding. No PASS boolean and no evidence callback. */
export const SpeechBindingV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-speech-preflight-binding.v1"),
    schema_version: Type.Literal(1),
    g2_decision_ref: ArtifactRefSchema,
    look_selection_ref: ArtifactRefSchema,
    playback_confirmation_ref: ArtifactRefSchema,
    performance_ref: ArtifactRefSchema,
    timing_ref: ArtifactRefSchema,
    script_ref: ArtifactRefSchema,
    audio_evidence_ref: ArtifactRefSchema,
    decode_receipt_ref: ArtifactRefSchema,
    alignment_review_refs: refs,
  },
  closed
);
export type SpeechBindingV1 = Static<typeof SpeechBindingV1Schema>;
export function validateShotMode(value: unknown, limits: FoundationLimitsV1): ShotModeV1 {
  const v = validateFoundation(ShotModeV1Schema, value, limits);
  validateRationalRate(v.target.fps);
  validateRationalTime(v.target.duration);
  if (
    v.target.duration.numerator <= 0 ||
    quantizeBoundary(v.target.duration, v.target.fps, v.target.frame_count).index !==
      v.target.frame_count
  )
    throw new Error("target duration/frame mismatch");
  if (v.mode === "i2v" && v.first_png.media_type !== "image/png")
    throw new Error("first PNG required");
  if (
    v.mode === "flf2v" &&
    (v.first_png.media_type !== "image/png" ||
      v.last_png.media_type !== "image/png" ||
      v.first_png.artifact_id === v.last_png.artifact_id)
  )
    throw new Error("two distinct endpoint PNGs required");
  if (v.mode === "controlled") {
    assertUnique(
      v.controls.map((x) => x.media_ref.artifact_id),
      "control refs"
    );
    for (const control of v.controls) {
      validateRationalRate(control.frame_rate);
      if (
        canonicalJson(control.frame_rate) !== canonicalJson(v.target.fps) ||
        (control.kind === "performer" && control.consent_ref === undefined)
      )
        throw new Error("control timebase/consent");
    }
    if (v.mask_png !== undefined && v.mask_png.media_type !== "image/png")
      throw new Error("mask must be PNG");
  }
  if (v.mode === "speech_conditioned" && v.performance_audio_ref.media_type !== "audio/wav")
    throw new Error("actual captured WAV required");
  return v;
}
type ShotOperandV1 = {
  role: string;
  ref: ArtifactRef;
  consent_binding?: {
    subject_kind: "performer" | "voice";
    ref: ArtifactRef | undefined;
  };
};
function modeInputs(v: ShotModeV1): ShotOperandV1[] {
  switch (v.mode) {
    case "t2v":
      return [];
    case "i2v":
      return [{ role: "first_png", ref: v.first_png }];
    case "flf2v":
      return [
        { role: "first_png", ref: v.first_png },
        { role: "last_png", ref: v.last_png },
      ];
    case "controlled":
      return [
        { role: "basis", ref: v.basis_ref },
        ...v.controls.map((x, i) => ({
          role: `control-${x.kind}-${i}`,
          ref: x.media_ref,
          ...(x.kind === "performer"
            ? { consent_binding: { subject_kind: "performer" as const, ref: x.consent_ref } }
            : {}),
        })),
        ...(v.mask_png === undefined ? [] : [{ role: "mask_png", ref: v.mask_png }]),
      ];
    case "camera":
      return [
        { role: "basis", ref: v.basis_ref },
        { role: "trajectory", ref: v.trajectory_ref },
      ];
    case "speech_conditioned":
      return [
        {
          role: "performance",
          ref: v.performance_audio_ref,
          consent_binding: { subject_kind: "voice", ref: v.consent_ref },
        },
        { role: "timing", ref: v.timing_ref },
        ...v.look_inputs.map((ref, i) => ({ role: `look-${i}`, ref })),
      ];
    case "specialty":
      return []; // A fixed registered schema/profile is mandatory, never a generic specialty escape.
  }
}
export interface ShotPreflightHostV1 extends RightsHostV1 {
  readonly checkpointer: Checkpointer;
  readonly gate_host: GateBindingHostV1;
  readonly current_capability: ShotCapabilityV1;
  readonly supported_output_fields: readonly string[];
  readonly current_speech_binding_ref?: ArtifactRef;
}
export function preflightShotMode(input: {
  host: ShotPreflightHostV1;
  mode: unknown;
  ports: unknown;
  output_field: string;
}): ShotModeV1 {
  const host = input.host;
  const mode = validateShotMode(input.mode, host.limits);
  const cap = validateFoundation(ShotCapabilityV1Schema, host.current_capability, host.limits);
  validateRationalTime(cap.max_duration);
  if (
    cap.mode !== mode.mode ||
    !sameRef(cap.profile_snapshot_ref, mode.profile_snapshot_ref) ||
    !sameRef(cap.settings_ref, mode.settings_ref) ||
    !sameRef(cap.expected_output_contract_ref, mode.expected_output_contract_ref) ||
    cap.output_field !== input.output_field ||
    !host.supported_output_fields.includes(input.output_field) ||
    mode.target.width > cap.max_width ||
    mode.target.height > cap.max_height ||
    mode.target.frame_count > cap.max_frames ||
    BigInt(mode.target.duration.numerator) * BigInt(cap.max_duration.denominator) >
      BigInt(cap.max_duration.numerator) * BigInt(mode.target.duration.denominator)
  )
    throw new Error("unsupported mode/output/current capability");
  if (
    mode.mode === "specialty" &&
    (cap.specialty_kind !== mode.specialty_kind ||
      cap.registered_schema_ref === undefined ||
      cap.registered_profile_ref === undefined ||
      !sameRef(mode.registered_schema_ref, cap.registered_schema_ref) ||
      !sameRef(mode.registered_profile_ref, cap.registered_profile_ref))
  )
    throw new Error("unsupported specialty schema/profile");
  if (
    mode.mode !== "specialty" &&
    (cap.specialty_kind !== undefined ||
      cap.registered_schema_ref !== undefined ||
      cap.registered_profile_ref !== undefined)
  )
    throw new Error("extra specialty capability");
  const ports = validateFoundation(Type.Array(ShotPortV1Schema), input.ports, host.limits);
  assertUnique(
    ports.map((x) => x.port_id),
    "ports"
  );
  assertUnique(
    ports.map((x) => x.semantic_role),
    "port roles"
  );
  assertUnique(
    ports.map((x) => `${x.mutation_node}/${x.mutation_input}`),
    "aliased mutation addresses"
  );
  assertUnique(
    ports.map((x) => x.upload_operation_id),
    "upload operations"
  );
  assertUnique(
    cap.ports.map((x) => x.port_id),
    "capability ports"
  );
  assertUnique(
    cap.ports.map((x) => x.semantic_role),
    "capability port roles"
  );
  assertUnique(
    cap.ports.map((x) => `${x.mutation_node}/${x.mutation_input}`),
    "capability aliases"
  );
  const expected = modeInputs(mode);
  if (ports.length !== cap.ports.length || ports.length !== expected.length)
    throw new Error("incorrect/extra mode ports");
  // Registry and caller ports must follow the mode's exact ordered operand roles.
  for (const [index, port] of ports.entries()) {
    const admitted = cap.ports[index];
    const operand = expected[index];
    if (
      admitted === undefined ||
      operand === undefined ||
      admitted.port_id !== port.port_id ||
      operand.role !== port.semantic_role ||
      !sameRef(operand.ref, port.ref) ||
      admitted.semantic_role !== port.semantic_role ||
      admitted.media_type !== port.media_type ||
      port.ref.media_type !== port.media_type ||
      admitted.codec !== port.codec ||
      admitted.byte_limit !== port.byte_limit ||
      admitted.mutation_node !== port.mutation_node ||
      admitted.mutation_input !== port.mutation_input
    )
      throw new Error("mode port binding mismatch");
    readExact(host.store, host.project_id, port.ref, port.byte_limit);
  }
  for (const ref of [
    mode.profile_snapshot_ref,
    mode.settings_ref,
    mode.expected_output_contract_ref,
    mode.prompt_ref,
    cap.qualification_ref,
  ])
    readExact(host.store, host.project_id, ref, host.limits.max_json_bytes);
  if (mode.mode === "specialty")
    for (const ref of [mode.registered_profile_ref, mode.registered_schema_ref])
      readExact(host.store, host.project_id, ref, host.limits.max_json_bytes);
  if (mode.mode === "controlled")
    for (const control of mode.controls)
      for (const ref of [
        control.alignment_ref,
        ...(control.consent_ref === undefined ? [] : [control.consent_ref]),
      ])
        readExact(host.store, host.project_id, ref, host.limits.max_json_bytes);
  const modelRights = host.current_rights.find((x) =>
    sameRef(x.subject_ref, mode.profile_snapshot_ref)
  );
  if (
    modelRights === undefined ||
    !mode.rights_refs.some((x) => sameRef(x, modelRights.rights_ref))
  )
    throw new Error("profile/model rights required");
  checkRights(host, mode.profile_snapshot_ref, modelRights.rights_ref, "motion");
  if (mode.mode === "specialty") {
    const specialtyRights = host.current_rights.find((x) =>
      sameRef(x.subject_ref, mode.registered_profile_ref)
    );
    if (specialtyRights === undefined || !sameRef(specialtyRights.rights_ref, mode.rights_ref))
      throw new Error("specialty rights binding");
    checkRights(host, mode.registered_profile_ref, mode.rights_ref, "motion");
  }
  for (const operand of expected) {
    const selected = host.current_rights.find((x) => sameRef(x.subject_ref, operand.ref));
    if (selected === undefined || !mode.rights_refs.some((x) => sameRef(x, selected.rights_ref)))
      throw new Error("mode operand rights binding");
    const rights = checkRights(host, operand.ref, selected.rights_ref, "motion");
    if (operand.consent_binding !== undefined) {
      const { subject_kind, ref: consentRef } = operand.consent_binding;
      if (
        consentRef === undefined ||
        rights.subject_kind !== subject_kind ||
        !rights.consent_refs.some((ref) => sameRef(ref, consentRef))
      )
        throw new Error("mode operand current rights/consent binding mismatch");
    }
  }
  for (const ref of mode.rights_refs)
    readExact(host.store, host.project_id, ref, host.limits.max_json_bytes);
  if (mode.mode === "speech_conditioned") checkSpeechPreflight(host, mode);
  return mode;
}
function checkSpeechPreflight(
  host: ShotPreflightHostV1,
  mode: Extract<ShotModeV1, { mode: "speech_conditioned" }>
): void {
  if (host.current_speech_binding_ref === undefined)
    throw new Error("current actual G2 performance/timing proof required");
  const binding = readSemantic({
    store: host.store,
    project_id: host.project_id,
    ref: host.current_speech_binding_ref,
    schema: SpeechBindingV1Schema,
    schema_id: "penny.videogen-speech-preflight-binding.v1",
    limits: host.limits,
  });
  if (
    !sameRef(binding.performance_ref, mode.performance_audio_ref) ||
    !sameRef(binding.timing_ref, mode.timing_ref)
  )
    throw new Error("changed speech performance/timing");
  const look = readSemantic({
    store: host.store,
    project_id: host.project_id,
    ref: binding.look_selection_ref,
    schema: LookVoiceSelectionV1Schema,
    schema_id: "penny.videogen-look-voice.v1",
    limits: host.limits,
  });
  if (
    !sameRef(look.performance_ref, binding.performance_ref) ||
    !sameRef(look.timing_ref, binding.timing_ref) ||
    !sameRef(look.audio_evidence_ref, binding.audio_evidence_ref) ||
    !sameRef(look.voice_identity.consent_ref, mode.consent_ref)
  )
    throw new Error("changed G2 look/voice selection");
  if (!mode.look_inputs.every((ref) => look.approved_pngs.some((x) => sameRef(x.png_ref, ref))))
    throw new Error("speech look input not selected at G2");
  const timing = readSemantic({
    store: host.store,
    project_id: host.project_id,
    ref: binding.timing_ref,
    schema: TimingEvidenceV1Schema,
    schema_id: "penny.videogen-timing.v1",
    limits: host.limits,
  });
  validateRationalRate(timing.source_sample_rate);
  assertUnique(
    timing.utterances.map((x) => x.line_id),
    "timing lines"
  );
  if (
    timing.uncertain_line_ids.length !== 0 ||
    !sameRef(timing.performance_ref, binding.performance_ref) ||
    !sameRef(timing.script_ref, binding.script_ref)
  )
    throw new Error("provisional or wrong timing");
  let prior = 0;
  for (const line of timing.utterances) {
    if (
      line.start_sample < prior ||
      line.start_sample >= line.end_sample ||
      line.end_sample > timing.measured_samples ||
      !binding.alignment_review_refs.some((x) => sameRef(x, line.review_ref))
    )
      throw new Error("invalid actual alignment");
    prior = line.end_sample;
  }
  if (
    host.checkpointer !== host.gate_host.checkpointer ||
    host.run_id !== host.gate_host.run_id ||
    host.project_id !== host.gate_host.project_id ||
    host.store !== host.gate_host.store
  )
    throw new Error("speech gate host authority mismatch");
  const { packet } = checkGateApproval(host.gate_host, "G2", binding.g2_decision_ref);
  if (
    !packet.presented.some(
      (x) => x.role === "look-voice" && sameRef(x.ref, binding.look_selection_ref)
    ) ||
    ![binding.performance_ref, binding.timing_ref, ...mode.look_inputs].every((ref) =>
      packet.presented.some((x) => sameRef(x.ref, ref))
    )
  )
    throw new Error("G2 exact speech versions not presented");
  for (const ref of [
    mode.consent_ref,
    binding.script_ref,
    binding.audio_evidence_ref,
    binding.decode_receipt_ref,
    binding.playback_confirmation_ref,
    ...binding.alignment_review_refs,
  ])
    readExact(host.store, host.project_id, ref, host.limits.max_json_bytes);
}
