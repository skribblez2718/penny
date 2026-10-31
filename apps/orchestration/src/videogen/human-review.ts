import { randomBytes } from "node:crypto";
import { Type, type Static } from "typebox";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { OrchestrationService } from "../service.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  readExact,
  readSemantic,
  sameRef,
  validateFoundation,
  type FoundationLimitsV1,
} from "./bounds.js";
import { executionState, slot } from "./execution-state.js";
import { NativeBuildResultV1Schema } from "./stage-contracts.js";
import { EditDecisionV1Schema, PortableManifestV1Schema } from "./edit-contracts.js";
import { checkGateApproval, GatePacketV1Schema, validateGatePacket } from "./gates.js";
import { readVideogenOwnerSelection, VideogenOwnerSelection } from "./owner-selection.js";

const closed = { additionalProperties: false } as const;
export const HUMAN_REVIEW_LIMITS: FoundationLimitsV1 = {
  schema_id: "penny.videogen-foundation-limits.v1",
  schema_version: 1,
  max_json_bytes: 1024 * 1024,
  max_text_bytes: 16384,
  max_collection_items: 2048,
  max_depth: 20,
  max_nodes: 32768,
  max_integer: Number.MAX_SAFE_INTEGER,
};
const verdict = Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("uncertain")]);
export const HumanReviewAnswersV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-human-review-answers.v1"),
    schema_version: Type.Literal(1),
    candidate_digest: Sha256Schema,
    reviewer_id: OpaqueIdSchema,
    reviewer_role: Type.String({ minLength: 1, maxLength: 256 }),
    complete_viewing: Type.Boolean(),
    heard_audio: Type.Boolean(),
    image: verdict,
    audio: verdict,
    captions: verdict,
    overall: verdict,
    motion: verdict,
    speech: verdict,
    sync: verdict,
    identity: verdict,
    issues: Type.String({ minLength: 1, maxLength: 8192 }),
    playback_device_profile_ref: ArtifactRefSchema,
  },
  closed
);
export type HumanReviewAnswersV1 = Static<typeof HumanReviewAnswersV1Schema>;
export function parseHumanReviewAnswers(value: unknown): HumanReviewAnswersV1 {
  const a = validateFoundation(HumanReviewAnswersV1Schema, value, HUMAN_REVIEW_LIMITS);
  if (!a.reviewer_role.trim() || !a.issues.trim())
    throw new Error("review role and issues required (write none if none)");
  return a;
}
export function humanReviewPositive(a: HumanReviewAnswersV1): boolean {
  return (
    a.complete_viewing &&
    a.heard_audio &&
    [a.image, a.audio, a.captions, a.overall, a.motion, a.speech, a.sync, a.identity].every(
      (v) => v === "pass"
    )
  );
}
const captionSchema = Type.Object(
  {
    start_ms: Type.Integer({ minimum: 0 }),
    end_ms: Type.Integer({ minimum: 1 }),
    text: Type.String({ maxLength: 16384 }),
  },
  closed
);
export const HumanReviewCandidateV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-human-review-candidate.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    gate_id: OpaqueIdSchema,
    packet_ref: ArtifactRefSchema,
    master_ref: ArtifactRefSchema,
    manifest_ref: ArtifactRefSchema,
    native_project_ref: ArtifactRefSchema,
    package_id: OpaqueIdSchema,
    duration_ms: Type.Integer({ minimum: 1, maximum: 86400000 }),
    captions: Type.Array(captionSchema, { maxItems: 1024 }),
  },
  closed
);
export type HumanReviewCandidateV1 = Static<typeof HumanReviewCandidateV1Schema>;
export type HumanReviewService = Pick<OrchestrationService, "artifacts" | "checkpointer"> & {
  readonly config: Pick<OrchestrationService["config"], "projectId">;
};
/** Read-only exact current selection; no frame, audio, codec, rights or native admission is changed.
 * The package has already burnt its captions into the master. Text below is an accessible transcript,
 * not a substitute overlay, new subtitle track, or claim that the captions were reviewed. */
export function currentHumanReviewCandidate(
  service: HumanReviewService,
  runId: string
): HumanReviewCandidateV1 {
  const c = service.checkpointer.loadRunById(runId);
  const pending = c?.pendingDirective;
  if (
    c === undefined ||
    c.identity.playbook !== "videogen" ||
    c.status !== "awaiting_user" ||
    pending?.action !== "await_user"
  )
    throw new Error("current pending videogen human gate required");
  const s = executionState(c);
  if (!((c.stateId === "clarify" && s.return_state === "master_critique") || c.stateId === "g5"))
    throw new Error("final playback or G5 boundary required");
  const owner = readVideogenOwnerSelection(
    new VideogenOwnerSelection({
      store: service.artifacts,
      checkpointer: service.checkpointer,
      project_id: service.config.projectId,
      run_id: runId,
    })
  ).gate;
  const read = <T extends import("typebox").TSchema>(
    ref: ArtifactRef,
    schema: T,
    schema_id: string
  ) => readSemantic({ ...owner, ref, schema, schema_id });
  const master = slot(s, "master"),
    manifestRef = slot(s, "manifest"),
    nativeRef = slot(s, "native");
  const manifest = read(
    manifestRef,
    PortableManifestV1Schema,
    "penny.videogen-portable-package.v1"
  );
  const native = read(
    nativeRef,
    NativeBuildResultV1Schema,
    "penny.videogen-native-build-result.v1"
  );
  const project = native.normalized_project_ref;
  for (const ref of [master, manifestRef, nativeRef, project]) {
    if (!c.selectedArtifacts.some((x) => sameRef(x, ref)) && !sameRef(ref, project))
      throw new Error("unselected review candidate");
    readExact(service.artifacts, service.config.projectId, ref, 512 * 1024 * 1024);
  }
  if (
    native.status !== "qualified" ||
    master.media_type !== "video/mp4" ||
    master.content_digest !== manifest.accepted_master.sha256 ||
    master.byte_length !== manifest.accepted_master.bytes ||
    project.content_digest !== manifest.native_project.sha256 ||
    project.byte_length !== manifest.native_project.bytes ||
    !manifest.files.some(
      (f) =>
        f.role === "master" && sameRef(f.producer_ref, master) && f.sha256 === master.content_digest
    ) ||
    !manifest.files.some(
      (f) =>
        f.role === "project" &&
        sameRef(f.producer_ref, project) &&
        f.sha256 === project.content_digest
    )
  )
    throw new Error("exact native/package/master binding required");
  const packetRef = slot(s, "packet");
  if (!c.selectedArtifacts.some((ref) => sameRef(ref, packetRef)))
    throw new Error("unselected pending review packet");
  // Pending presentations are not yet in the answered-owner index. Read the actual pending
  // packet against selected refs; never install its own fields as approval authority.
  const packet = validateGatePacket(
    read(packetRef, GatePacketV1Schema, "penny.videogen-gate-packet.v1"),
    owner.limits
  );
  if (
    packet.run_id !== runId ||
    packet.presented.some(
      (p) => p.revision !== p.ref.version || !c.selectedArtifacts.some((ref) => sameRef(ref, p.ref))
    )
  )
    throw new Error("pending review presentation revision mismatch");
  const approvals = owner.current_approvals;
  if (
    packet.prior_decisions.length !== approvals.length ||
    approvals.some(
      (a, i) => !packet.prior_decisions[i] || !sameRef(a.decision_ref, packet.prior_decisions[i])
    )
  )
    throw new Error("pending review prior gate closure changed");
  const last = approvals[approvals.length - 1];
  if (last) checkGateApproval(owner, last.gate_id, last.decision_ref);
  if (c.stateId === "g5" && approvals.map((a) => a.gate_id).join(",") !== "G1,G2,G3,G4")
    throw new Error("G5 requires original G1-G4 approvals");
  if (
    pending.payload_digest !== packetRef.content_digest ||
    pending.challenge !== packet.challenge ||
    (c.stateId === "g5" &&
      (packet.gate_id !== "G5" ||
        ![master, manifestRef].every((ref) => packet.presented.some((p) => sameRef(p.ref, ref)))))
  )
    throw new Error("pending G5 same-candidate binding changed");
  const duration = manifest.accepted_master.duration;
  const durationMs = Math.ceil((duration.numerator * 1000) / duration.denominator);
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 24 * 60 * 60 * 1000)
    throw new Error("review duration bound");
  const edit = read(
    manifest.edit_decision_ref,
    EditDecisionV1Schema,
    "penny.videogen-edit-decision.v1"
  );
  const captions = edit.tracks.flatMap((t) =>
    t.items.flatMap((item) => {
      if (item.kind !== "caption") return [];
      const bytes = readExact(
        service.artifacts,
        service.config.projectId,
        item.text_source_ref,
        16384
      );
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const start_ms = Math.floor(
        (item.timeline_start.numerator * 1000) / item.timeline_start.denominator
      );
      const end_ms = Math.ceil(
        (item.timeline_end.numerator * 1000) / item.timeline_end.denominator
      );
      if (start_ms < 0 || end_ms <= start_ms || end_ms > durationMs)
        throw new Error("caption timing bound");
      return [{ start_ms, end_ms, text }];
    })
  );
  if (captions.length > 1024 || Buffer.byteLength(canonicalJson(captions)) > 262144)
    throw new Error("caption transcript bound");
  return validateFoundation(
    HumanReviewCandidateV1Schema,
    {
      schema_id: "penny.videogen-human-review-candidate.v1",
      schema_version: 1,
      run_id: runId,
      gate_id: pending.gate_id,
      packet_ref: packetRef,
      master_ref: master,
      manifest_ref: manifestRef,
      native_project_ref: project,
      package_id: manifest.package_id,
      duration_ms: durationMs,
      captions,
    },
    HUMAN_REVIEW_LIMITS
  );
}
export function candidateDigest(candidate: HumanReviewCandidateV1): string {
  return sha256(canonicalJson(candidate));
}
/** One-time binding, NOT human authority. Never export it as a model approval capability. */
export function humanReviewChallenge() {
  return randomBytes(32).toString("hex");
}
