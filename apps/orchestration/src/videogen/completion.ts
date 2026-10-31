export {
  VIDEOGEN_COMPLETION_GATE,
  VIDEOGEN_COMPLETION_PREDICATE_IDS,
} from "./completion-policy.js";
import { VIDEOGEN_COMPLETION_PREDICATE_IDS } from "./completion-policy.js";
import {
  SourcePreparationRequestSchema,
  SourcePreparationResultSchema,
} from "./runtime-preparation.js";
import { VideoGenerationOperationRequestV1Schema } from "./contracts.js";
import { NativeQualifiedRawResultV1Schema } from "./native-contracts.js";
import {
  NativePhaseEvidenceV1Schema,
  NativeComparisonEvidenceV1Schema,
} from "./native-products.js";
import { validateContract } from "../contracts.js";
import type { CompletionReceiptPredicateV1 } from "../playbooks/playbook.js";

import { ArtifactStore } from "../artifact-store.js";
import { Type, type TSchema } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import { executionState, slot } from "./execution-state.js";
import { readVideogenStageProduct } from "./semantic-catalog.js";
import { FoundationLimitsV1Schema, readExact } from "./bounds.js";
import { validateGateDecision, validateGatePacket, gateScopeDigest } from "./gates.js";
import { CurrentRightsV1Schema, CrossRunEdgeV1Schema, checkRights } from "./rights-ledger.js";
import { verifyHostResultWrapper } from "../host-operations/effect-protocol.js";
import {
  VideogenTerminalV1Schema,
  ShotResultV1Schema,
  ReviewBindingV1Schema,
  PlaybackReviewV1Schema,
  MasterReviewV1Schema,
  PackageReviewV1Schema,
  NativeBuildResultV1Schema,
  DeliveryReceiptV1Schema,
  AudioEvidenceV1Schema,
} from "./stage-contracts.js";
import { StoryCanonV1Schema } from "./foundation-contracts.js";
import { VideoEvidenceV1Schema } from "./media-contracts.js";
import { validatePortableManifest } from "./portable-package.js";
import { PortableManifestV1Schema } from "./edit-contracts.js";
import type { CompletionReceiptPredicateInputV1 } from "../playbooks/playbook.js";
/** Fixed proof checks over the actual run, exact artifact store and owner journals. None accepts
 * a PASS callback or a request-provided assertion. A missing operand always refuses. */
export function evaluateVideogenCompletionProof(
  input: CompletionReceiptPredicateInputV1,
  proof: string
): boolean {
  try {
    if (!(input.artifactReader instanceof ArtifactStore)) return false;
    const artifacts = input.artifactReader,
      c = input.context,
      s = executionState(c);
    const owner = validateContract(
      Type.Object({
        project_id: Type.String(),
        territory: Type.String(),
        limits: FoundationLimitsV1Schema,
        approvals: Type.Array(
          Type.Object({
            gate_id: Type.String(),
            engine_gate_id: Type.String(),
            challenge: Type.String(),
            packet_ref: ArtifactRefSchema,
            decision_ref: ArtifactRefSchema,
          })
        ),
        rights: Type.Array(CurrentRightsV1Schema),
        cross_run_edge_refs: Type.Array(ArtifactRefSchema),
      }),
      c.playbookData.videogen_owner_selection,
      "videogen completion owner"
    );
    artifacts.assertBoundProject(owner.project_id);
    input.checkpointer.assertBoundProject(owner.project_id);
    const read = <T extends TSchema>(ref: ArtifactRef, schema: T) =>
      validateContract(
        schema,
        readVideogenStageProduct({
          artifacts,
          project_id: owner.project_id,
          ref,
          schema_id: ref.content_schema?.schema_id ?? "",
          limits: owner.limits,
        }),
        "completion product"
      );
    const selected = (name: string): ArtifactRef => {
      const ref = slot(s, name);
      if (!c.selectedArtifacts.some((x) => canonicalJson(x) === canonicalJson(ref)))
        throw new Error("unselected completion product");
      return ref;
    };
    const terminal = read(selected("terminal"), VideogenTerminalV1Schema);
    if (
      input.latestProduct.product_id !== selected("terminal").artifact_id ||
      !terminal.met ||
      terminal.status !== "delivered" ||
      terminal.unresolved_operation_ids.length !== 0
    )
      return false;
    const journals = input.checkpointer.hostOperationCallsForRun(c.identity.run_id);
    const journalFor = (ref: ArtifactRef, kind?: string) =>
      journals.find(
        (j) =>
          (kind === undefined || j.operation_kind === kind) &&
          [
            j.operation_result_ref,
            j.host_receipt_ref,
            j.result_wrapper?.ref,
            ...j.output_artifacts,
          ].some((x) => x?.artifact_id === ref.artifact_id)
      );
    const settled = (ref: ArtifactRef, kind?: string) => {
      let j = journalFor(ref, kind);
      if (
        j === undefined &&
        ((["host:videogen", "host:videogen-media-evidence"].includes(ref.producer) &&
          ref.content_schema?.schema_id === "penny.videogen-video-evidence.v1") ||
          (ref.producer === "host:videogen-native-products" &&
            [
              "penny.videogen-native-build-result.v1",
              "penny.videogen-native-phase-evidence.v1",
              "penny.videogen-native-render-comparison.v1",
            ].includes(ref.content_schema?.schema_id ?? "")))
      ) {
        const upstream = artifacts.metadata(ref).upstream_refs;
        const candidates = journals.filter(
          (row) =>
            (kind === undefined || row.operation_kind === kind) &&
            row.operation_result_ref !== null &&
            row.host_receipt_ref !== null &&
            upstream.some((x) => canonicalJson(x) === canonicalJson(row.operation_result_ref)) &&
            upstream.some((x) => canonicalJson(x) === canonicalJson(row.host_receipt_ref))
        );
        if (candidates.length === 1) j = candidates[0];
      }
      if (
        j === undefined ||
        !["settled", "consumed"].includes(j.lifecycle) ||
        j.disposition?.outcome !== "completed" ||
        j.disposition.lease_disposition !== "released" ||
        j.result_wrapper?.ref == null
      )
        return false;
      verifyHostResultWrapper(artifacts, j);
      return true;
    };
    const settledShotClip = (ref: ArtifactRef): boolean => {
      if (settled(ref, "video_render")) return true;
      const prepared = journalFor(ref, "media_decode_extract");
      if (!prepared?.operation_result_ref || !settled(ref, "media_decode_extract")) return false;
      const exact = <T extends TSchema>(artifact: ArtifactRef, schema: T) =>
        validateContract(
          schema,
          JSON.parse(
            readExact(artifacts, owner.project_id, artifact, owner.limits.max_json_bytes).toString(
              "utf8"
            )
          ),
          "completion normalization custody"
        );
      const request = exact(prepared.request_ref, SourcePreparationRequestSchema),
        raw = exact(prepared.operation_result_ref, SourcePreparationResultSchema);
      if (
        request.preparation.kind !== "avc_import" ||
        raw.preparation.kind !== "avc_import" ||
        raw.transform_receipt.transform !== "cpu_h264_baseline_lossy_reencode_metadata_removed"
      )
        return false;
      const producer = journalFor(request.media_ref, "video_render");
      if (
        !producer?.operation_result_ref ||
        !producer.host_receipt_ref ||
        !settled(request.media_ref, "video_render")
      )
        return false;
      const generation = exact(producer.request_ref, VideoGenerationOperationRequestV1Schema),
        transform = raw.transform_receipt,
        p = request.preparation;
      return (
        request.operation_id === prepared.operation_id &&
        raw.operation_id === prepared.operation_id &&
        request.subject_id === generation.shot_id &&
        canonicalJson(raw.source_ref) === canonicalJson(request.media_ref) &&
        canonicalJson(raw.source_result_ref) === canonicalJson(request.source_result_ref) &&
        canonicalJson(raw.source_receipt_ref) === canonicalJson(request.source_receipt_ref) &&
        canonicalJson(request.source_result_ref) === canonicalJson(producer.operation_result_ref) &&
        canonicalJson(request.source_receipt_ref) === canonicalJson(producer.host_receipt_ref) &&
        canonicalJson(raw.preparation) === canonicalJson(request.preparation) &&
        raw.prepared_sha256 === ref.content_digest &&
        raw.prepared_bytes === ref.byte_length &&
        transform.raw_sha256 === request.media_ref.content_digest &&
        transform.raw_bytes === request.media_ref.byte_length &&
        transform.normalized_sha256 === ref.content_digest &&
        transform.normalized_bytes === ref.byte_length &&
        transform.width === p.width &&
        transform.height === p.height &&
        transform.decoded_frame_count === p.frame_count &&
        transform.fps === p.fps &&
        generation.dimensions.width === p.width &&
        generation.dimensions.height === p.height &&
        generation.frame_count === p.frame_count &&
        generation.fps === p.fps
      );
    };
    if (proof === "videogen.gates_current.v1") {
      if (owner.approvals.length !== 5 || terminal.gate_decision_refs.length !== 5) return false;
      const ids = ["G1", "G2", "G3", "G4", "G5"];
      for (const id of ids) {
        const a = owner.approvals.find((x) => x.gate_id === id);
        if (
          a === undefined ||
          canonicalJson(selected(id)) !== canonicalJson(a.decision_ref) ||
          !c.selectedArtifacts.some((x) => x.artifact_id === a.packet_ref.artifact_id)
        )
          return false;
        const d = validateGateDecision(
          JSON.parse(
            readExact(
              artifacts,
              owner.project_id,
              a.decision_ref,
              owner.limits.max_json_bytes
            ).toString("utf8")
          ),
          owner.limits
        );
        const p = validateGatePacket(
          JSON.parse(
            readExact(
              artifacts,
              owner.project_id,
              a.packet_ref,
              owner.limits.max_json_bytes
            ).toString("utf8")
          ),
          owner.limits
        );
        const b = input.checkpointer.gateResponseBinding(c.identity.run_id, a.engine_gate_id);
        if (
          d.choice !== "approve" ||
          d.run_id !== c.identity.run_id ||
          d.challenge !== a.challenge ||
          p.challenge !== a.challenge ||
          d.resulting_scope_digest !== gateScopeDigest(p, a.packet_ref) ||
          b?.status !== "answered" ||
          b.challenge !== a.challenge ||
          b.response_digest !== sha256(canonicalJson(d)) ||
          p.presented.some(
            (x) => !c.selectedArtifacts.some((r) => r.artifact_id === x.ref.artifact_id)
          )
        )
          return false;
      }
      return true;
    }
    if (proof === "videogen.shots_current.v1") {
      const canon = read(selected("canon"), StoryCanonV1Schema);
      if (canon.shots.length !== s.shot_ids.length) return false;
      for (const shot of canon.shots) {
        const result = read(selected(`final-${shot.shot_id}`), ShotResultV1Schema),
          video = read(result.video_evidence_ref, VideoEvidenceV1Schema),
          objective = read(result.objective_binding_ref, ReviewBindingV1Schema),
          quality = read(result.quality_binding_ref, ReviewBindingV1Schema);
        if (
          result.shot_id !== shot.shot_id ||
          result.disposition !== "accepted" ||
          result.stage === "draft" ||
          !settledShotClip(result.clip_ref) ||
          video.frames.some((frame) => {
            readExact(artifacts, owner.project_id, frame.png_ref, owner.limits.max_integer);
            return false;
          }) ||
          video.source_clip_ref.artifact_id !== result.clip_ref.artifact_id ||
          video.frames.length === 0 ||
          objective.disposition !== "pass" ||
          quality.disposition !== "pass" ||
          objective.target_ref.artifact_id !== result.shot_media_ref.artifact_id ||
          quality.target_ref.artifact_id !== result.shot_media_ref.artifact_id ||
          !settled(result.video_evidence_ref, "media_decode_extract")
        )
          return false;
      }
      return true;
    }
    if (proof === "videogen.audio_playback.v1") {
      const review = read(selected("master_review"), MasterReviewV1Schema),
        p = read(review.playback_review_ref, PlaybackReviewV1Schema),
        video = read(review.decode_ref, VideoEvidenceV1Schema),
        audio = read(review.audio_evidence_ref, AudioEvidenceV1Schema);
      readExact(artifacts, owner.project_id, p.attestation_ref, owner.limits.max_json_bytes);
      return (
        review.disposition === "accepted" &&
        p.target_digest === review.master_ref.content_digest &&
        p.target_ref.artifact_id === review.master_ref.artifact_id &&
        p.complete_viewing &&
        p.heard_audio &&
        [p.motion_verdict, p.speech_verdict, p.sync_verdict, p.identity_verdict].every(
          (x) => x === "pass"
        ) &&
        p.observations.every((x) => x.verdict === "pass") &&
        video.source_clip_ref.artifact_id === review.master_ref.artifact_id &&
        audio.sample_count > 0 &&
        settled(review.decode_ref, "media_decode_extract")
      );
    }
    if (proof === "videogen.native_portable.v1") {
      const review = read(selected("package_review"), PackageReviewV1Schema),
        native = read(selected("native"), NativeBuildResultV1Schema),
        manifest = validatePortableManifest(
          read(review.manifest_ref, PortableManifestV1Schema),
          owner.limits
        );
      if (
        review.disposition !== "accepted" ||
        manifest.accepted_master.sha256 !== selected("master").content_digest ||
        manifest.native_project.sha256 !== native.normalized_project_ref.content_digest ||
        !artifacts.read(native.roundtrip_edit_ref).equals(artifacts.read(selected("final_edit"))) ||
        native.status !== "qualified" ||
        review.project_ref.artifact_id !== native.normalized_project_ref.artifact_id ||
        !settled(selected("native"), "kdenlive_build_verify")
      )
        return false;
      if (selected("native").producer === "host:videogen-native-products") {
        const upstream = artifacts.metadata(selected("native")).upstream_refs;
        const journal = journals.find(
          (j) =>
            j.operation_kind === "kdenlive_build_verify" &&
            j.operation_result_ref !== null &&
            upstream.some((x) => canonicalJson(x) === canonicalJson(j.operation_result_ref))
        );
        if (!journal?.operation_result_ref || !journal.host_receipt_ref) return false;
        const raw = validateContract(
          NativeQualifiedRawResultV1Schema,
          JSON.parse(artifacts.read(journal.operation_result_ref).toString()),
          "qualified native custody"
        );
        if (
          canonicalJson(raw.accepted_master_ref) !== canonicalJson(selected("master")) ||
          raw.comparison.master_sha256 !== selected("master").content_digest
        )
          return false;
        for (const [i, ref] of [
          native.open_save_receipt_ref,
          native.reopen_receipt_ref,
          native.relocation_receipt_ref,
        ].entries()) {
          const phase = validateContract(
            NativePhaseEvidenceV1Schema,
            JSON.parse(artifacts.read(ref).toString()),
            "native phase"
          );
          if (
            canonicalJson(phase.phase) !== canonicalJson(raw.phases[i]) ||
            canonicalJson(phase.owner_receipt_ref) !== canonicalJson(journal.host_receipt_ref) ||
            canonicalJson(phase.raw_result_ref) !== canonicalJson(journal.operation_result_ref)
          )
            return false;
        }
        const comparison = validateContract(
          NativeComparisonEvidenceV1Schema,
          JSON.parse(artifacts.read(native.render_comparison_ref).toString()),
          "native comparison"
        );
        if (canonicalJson(comparison.comparison) !== canonicalJson(raw.comparison)) return false;
      }
      for (const file of manifest.files) {
        const bytes = readExact(
          artifacts,
          owner.project_id,
          file.producer_ref,
          owner.limits.max_integer
        );
        if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) return false;
      }
      return [
        native.open_save_receipt_ref,
        native.reopen_receipt_ref,
        native.relocation_receipt_ref,
        native.render_comparison_ref,
      ].every((ref) => {
        readExact(artifacts, owner.project_id, ref, owner.limits.max_json_bytes);
        return settled(ref, "kdenlive_build_verify");
      });
    }
    if (proof === "videogen.rights_current.v1") {
      if (owner.rights.length === 0) return false;
      const host = {
        store: artifacts,
        project_id: owner.project_id,
        run_id: c.identity.run_id,
        limits: owner.limits,
        territory: owner.territory,
        now_utc: new Date().toISOString(),
        current_rights: owner.rights,
        cross_run_edges: owner.cross_run_edge_refs.map((ref) => read(ref, CrossRunEdgeV1Schema)),
      };
      for (const row of owner.rights) checkRights(host, row.subject_ref, row.rights_ref, "deliver");
      const manifest = read(selected("manifest"), PortableManifestV1Schema);
      for (const file of manifest.files.filter((x) =>
        ["source", "audio", "font", "graphic", "caption"].includes(x.role)
      )) {
        const grant = owner.rights.find(
          (x) => canonicalJson(x.subject_ref) === canonicalJson(file.producer_ref)
        );
        if (grant === undefined) return false;
        checkRights(host, file.producer_ref, grant.rights_ref, "deliver");
      }
      return true;
    }
    if (proof === "videogen.delivery_exact.v1") {
      const delivery = read(selected("delivery"), DeliveryReceiptV1Schema),
        native = read(selected("native"), NativeBuildResultV1Schema),
        g5 = owner.approvals.find((x) => x.gate_id === "G5");
      if (
        g5 === undefined ||
        delivery.outcome !== "succeeded" ||
        delivery.master_digest !== selected("master").content_digest ||
        delivery.project_digest !== native.normalized_project_ref.content_digest ||
        delivery.manifest_digest !== selected("manifest").content_digest ||
        delivery.g5_packet_digest !== g5.packet_ref.content_digest ||
        delivery.readback_refs.length === 0
      )
        return false;
      return (
        delivery.readback_refs.every((ref) => {
          readExact(artifacts, owner.project_id, ref, owner.limits.max_integer);
          return settled(ref, "local_delivery");
        }) && settled(delivery.fsync_atomicity_ref, "local_delivery")
      );
    }
    if (proof === "videogen.effects_settled.v1") {
      if (s.effects.length === 0 || journals.length === 0) return false;
      for (const j of journals) {
        if (
          !["settled", "consumed"].includes(j.lifecycle) ||
          j.disposition?.outcome !== "completed" ||
          j.disposition.lease_disposition !== "released"
        )
          return false;
        verifyHostResultWrapper(artifacts, j);
      }
      return (
        s.effects.every((e) => settled(e.wrapper_ref)) &&
        [
          "video_render",
          "media_decode_extract",
          "timeline_master",
          "kdenlive_build_verify",
          "local_delivery",
        ].every((kind) => journals.some((j) => j.operation_kind === kind))
      );
    }
    return false;
  } catch {
    return false;
  }
}
export const VIDEOGEN_COMPLETION_PREDICATES: ReadonlyMap<string, CompletionReceiptPredicateV1> =
  new Map(
    VIDEOGEN_COMPLETION_PREDICATE_IDS.map((id) => [
      id,
      (input) => ({ passed: evaluateVideogenCompletionProof(input, id), evidence_refs: [] }),
    ])
  );

/** Legacy export name; now the same fixed real proof evaluators. */
export const VIDEOGEN_UNWIRED_COMPLETION_PREDICATES = VIDEOGEN_COMPLETION_PREDICATES;
