import { Type } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  type HostOperationArtifactContractV1,
} from "../contracts.js";
import { OpaqueIdSchema } from "../skill-contracts/common.js";
import { isCanonicalHostOperationExecutionContextV1 } from "../host-operations/owner.js";
import type { HostOperationAdapterV1 } from "../host-operations/contracts.js";
import { verifyHostEffectBinding } from "../host-operations/effect-protocol.js";
import { ConfinedNativeRunner } from "../host-operations/confined-native-runner.js";
import { validateMp4Video } from "../mp4-media.js";
import { compareNativeMedia } from "./native-media-comparison.js";
import type { NativeAdapterBinding } from "./kdenlive-adapter.js";
import { NativeBuildRequestV1Schema } from "./native-contracts.js";
import { currentAdapterHost, assertAdapterOwnerBinding } from "./native-owner-authority.js";
import { writeNativeProject } from "./kdenlive-writer.js";
import { checkGateApproval } from "./gates.js";
import { readSemantic } from "./bounds.js";
import { inspectEditDecision } from "./edit-decision.js";
import { MeasuredEditSourceV1Schema } from "./edit-contracts.js";
import { inspectCapturedAudioSource } from "./audio-sources.js";
import { quantizeBoundary } from "./rational-time.js";
import { BudgetReservationV1Schema, validateBudgetReservation } from "./foundation-contracts.js";

const closed = { additionalProperties: false } as const;
const contract = (name: string): HostOperationArtifactContractV1 => ({
  schema_version: 1,
  port_name: name,
  artifact_kind: name,
  schema_id: `penny.${name}.v1`,
  schema_version_required: 1,
});
export const TIMELINE_MASTER_REQUEST = contract("timeline-master-request");
export const TIMELINE_MASTER_RESULT = contract("timeline-master-result");
export const TIMELINE_MASTER_VIDEO = contract("timeline-master-video");
export const TimelineMasterRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.timeline-master-request.v1"),
    schema_version: Type.Literal(1),
    operation_id: OpaqueIdSchema,
    native_build_request_ref: ArtifactRefSchema,
  },
  closed
);
/** A real, bounded timeline renderer through the same pinned native four-verb driver, not a
 * user function or invented editor CLI. Rendering never issues native/open/playback qualification. */
export function createTimelineMasterAdapter(b: NativeAdapterBinding): HostOperationAdapterV1 {
  if (!ConfinedNativeRunner.isTrusted(b.runner)) throw new Error("VIDEOGEN_MASTER_RUNNER_MISSING");
  if (
    !b.runner.hasRuntimeDigest(b.registry.editor_build_digest) ||
    !b.runner.hasRuntimeDigest(b.registry.mlt_build_digest)
  )
    throw new Error("VIDEOGEN_MASTER_BUILD_PINS_MISSING");
  assertAdapterOwnerBinding(b.owner, b.host);
  const inspect: HostOperationAdapterV1["inspectRequest"] = (input) => {
    const current = currentAdapterHost(b.owner, b.host),
      h = current.host;
    const r = validateContract(
      TimelineMasterRequestSchema,
      JSON.parse(Buffer.from(input.request_bytes).toString()),
      "timeline master request"
    );
    const d = input.directive,
      effect = verifyHostEffectBinding(h.store, h.project_id, d);
    if (
      d.operation_kind !== "timeline_master" ||
      r.operation_id !== d.operation_id ||
      canonicalJson(d.expected_result) !== canonicalJson(TIMELINE_MASTER_RESULT) ||
      canonicalJson(input.declaration.request) !== canonicalJson(TIMELINE_MASTER_REQUEST) ||
      effect === undefined
    )
      throw new Error("VIDEOGEN_MASTER_REQUEST_BINDING");
    const gate = checkGateApproval(
      h,
      d.state_id === "rough_build" ? "G3" : "G4",
      effect.gate_decision_ref
    );
    if (
      gate.packet.kind !== "approval" ||
      !gate.packet.effect_scope.kinds.includes("timeline_master")
    )
      throw new Error("VIDEOGEN_MASTER_GATE_SCOPE");
    const request = readSemantic({
      ...h,
      ref: r.native_build_request_ref,
      schema: NativeBuildRequestV1Schema,
      schema_id: "penny.videogen-native-build-request.v1",
    });
    current.requireSelected([
      r.native_build_request_ref,
      request.edit_ref,
      effect.budget_reservation_ref,
      ...request.assets.map((a) => a.source_ref),
    ]);
    if (
      r.native_build_request_ref.run_id !== h.run_id ||
      request.output_root_selector !== b.output_root_selector ||
      request.editor_build_digest !== b.registry.editor_build_digest ||
      request.mlt_build_digest !== b.registry.mlt_build_digest ||
      request.feature_subset_digest !== b.registry.digest
    )
      throw new Error("VIDEOGEN_MASTER_NATIVE_BINDING_DRIFT");
    const budget = validateBudgetReservation(
      readSemantic({
        ...h,
        ref: effect.budget_reservation_ref,
        schema: BudgetReservationV1Schema,
        schema_id: "penny.videogen-budget-reservation.v1",
      }),
      h.limits
    );
    if (
      budget.operation_kind !== "timeline_master" ||
      budget.state !== "held" ||
      canonicalJson(budget.scope_gate_ref) !== canonicalJson(effect.gate_decision_ref) ||
      Date.parse(budget.created_at_utc) > Date.parse(h.now_utc) ||
      Date.parse(budget.expires_at_utc) <= Date.parse(h.now_utc) ||
      !budget.meters.some((m) => m.meter === "attempts" && m.reserved - m.consumed >= 1) ||
      !budget.meters.some(
        (m) =>
          m.meter === "stored_bytes" && m.reserved - m.consumed >= b.process_policy.max_output_bytes
      )
    )
      throw new Error("VIDEOGEN_MASTER_ALLOWANCE_MISSING");
    if (
      canonicalJson(d.input_artifacts.artifacts) !==
      canonicalJson([
        { slot: "native-build", ref: r.native_build_request_ref },
        ...request.assets.map((a, i) => ({ slot: `asset-${i}`, ref: a.source_ref })),
      ])
    )
      throw new Error("VIDEOGEN_MASTER_EXACT_INPUTS");
    inspectEditDecision(h, request.edit_ref);
    current.assertUnchanged();
    return {
      schema_version: 1,
      operation_kind: "timeline_master",
      adapter_id: b.adapter_id,
      backend_binding_id: b.backend_binding_id,
      backend_key_sha256: b.backend_key_sha256,
    };
  };
  return {
    adapter_id: b.adapter_id,
    inspectRequest: inspect,
    async run(ctx) {
      if (!isCanonicalHostOperationExecutionContextV1(ctx))
        throw new Error("timeline master owner custody required");
      const validate = () =>
        inspect({
          directive: ctx.directive,
          declaration: ctx.declaration,
          request_bytes: ctx.request_bytes,
          input_artifacts: ctx.directive.input_artifacts,
        });
      validate();
      if (ctx.journal.lifecycle !== "lease_acquired")
        throw new Error(
          "interrupted timeline master requires exact settled recovery, never rerender"
        );
      const current = currentAdapterHost(b.owner, b.host),
        h = current.host;
      const request = validateContract(
        NativeBuildRequestV1Schema,
        JSON.parse(Buffer.from(ctx.readInput("native-build").bytes).toString()),
        "timeline native build"
      );
      const edit = inspectEditDecision(h, request.edit_ref).edit;
      const durations = new Map<string, number>();
      for (const ref of h.measured_source_refs) {
        const m = readSemantic({
          ...h,
          ref,
          schema: MeasuredEditSourceV1Schema,
          schema_id: "penny.videogen-edit-source.v1",
        });
        durations.set(
          m.source_ref.content_digest,
          quantizeBoundary(m.decoded_duration, edit.canvas.fps, request.limits.max_duration_frames)
            .index
        );
      }
      for (const a of h.audio_sources) {
        const checked = inspectCapturedAudioSource({ host: h, ...a, use: "edit" });
        if (checked.status !== "protocol_checked")
          throw new Error("timeline audio source unavailable");
        durations.set(
          checked.source.media_ref.content_digest,
          quantizeBoundary(
            checked.source.duration,
            edit.canvas.fps,
            request.limits.max_duration_frames
          ).index
        );
      }
      const written = writeNativeProject({
        registry: b.registry,
        fixture_digest: request.fixture_digest,
        edit,
        assets: request.assets.map((a, i) => ({
          source_ref: a.source_ref,
          relative_path: a.relative_path,
          bytes: ctx.readInput(`asset-${i}`).bytes,
          duration_frames: durations.get(a.source_ref.content_digest) ?? 0,
        })),
        limits: h.limits,
        max_frames: request.limits.max_duration_frames,
      });
      if (written.bytes.length > request.limits.max_xml_bytes)
        throw new Error("timeline XML byte limit");
      current.assertUnchanged();
      validate();
      ctx.beginSubmission();
      let closed = false;
      ctx.registerRemoteCancellation(async () =>
        closed
          ? { remote_disposition: "proven_terminal", reason_code: "master_process_closed" }
          : { remote_disposition: "may_continue", reason_code: "master_cleanup_pending" }
      );
      try {
        const bytes = await b.runner.run({
          verb: "render_compare",
          files: [
            { relative_path: "project.kdenlive", bytes: written.bytes },
            ...request.assets.map((a, i) => ({
              relative_path: a.relative_path,
              bytes: ctx.readInput(`asset-${i}`).bytes,
            })),
          ],
          policy: b.process_policy,
          signal: ctx.signal,
        });
        validate();
        if (b.comparison !== undefined) {
          // Native-owned output may contain AAC. Keep imported-video admission unchanged;
          // validate this separate output with complete bounded native AV clocks and CPU decoding.
          await compareNativeMedia({
            runner: b.comparison.runner,
            policy: b.comparison.policy,
            limits: h.limits,
            master: bytes,
            render: bytes,
            width: edit.canvas.width,
            height: edit.canvas.height,
            frame_rate: edit.canvas.fps,
            duration_frames: quantizeBoundary(
              edit.end_time,
              edit.canvas.fps,
              request.limits.max_duration_frames
            ).index,
            signal: ctx.signal,
          });
        } else {
          const inspected = validateMp4Video(bytes, {
            width: edit.canvas.width,
            height: edit.canvas.height,
            frame_count: quantizeBoundary(
              edit.end_time,
              edit.canvas.fps,
              request.limits.max_duration_frames
            ).index,
            fps: edit.canvas.fps.numerator / edit.canvas.fps.denominator,
            max_bytes: b.process_policy.max_output_bytes,
          });
          if (inspected.status !== "valid") throw new Error("VIDEOGEN_MASTER_INVALID_MP4");
        }
        ctx.recordFetched({
          schema_version: 1,
          content_sha256: sha256(bytes),
          byte_length: bytes.length,
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
        const persisted = ctx.persist({
          disposition,
          operation_result: {
            contract: TIMELINE_MASTER_RESULT,
            media_type: "application/json",
            content: canonicalJson({
              schema_id: TIMELINE_MASTER_RESULT.schema_id,
              schema_version: 1,
              operation_id: ctx.directive.operation_id,
              edit_ref: request.edit_ref,
              sha256: sha256(bytes),
              byte_length: bytes.length,
              qualification: "not_assessed",
            }),
          },
          outputs: [{ contract: TIMELINE_MASTER_VIDEO, media_type: "video/mp4", content: bytes }],
        });
        return { disposition, ...persisted };
      } finally {
        closed = true;
      }
    },
  };
}
