import { validateSkillSchema, assertUnique, assertRfc3339Utc } from "../skill-contracts/common.js";
import { sameRef } from "./bounds.js";
import {
  compareTime,
  rationalTime,
  validateRationalTime,
  validateRationalRate,
} from "./rational-time.js";
import {
  AudioEvidenceV1Schema,
  PlaybackReviewV1Schema,
  AdmittedAssetLedgerV1Schema,
  AnimaticV1Schema,
  DeliveryReceiptV1Schema,
  VideogenTerminalV1Schema,
  ShotRouteV1Schema,
  PreparedGraphV1Schema,
} from "./stage-contracts.js";
/** Cross-field consistency only. A well-shaped assertion never proves an effect or a review. */
export function validateVideogenStageSemantics(id: string, value: unknown): void {
  if (id === "penny.videogen-audio-evidence.v1") {
    const audio = validateSkillSchema(AudioEvidenceV1Schema, value, "audio evidence");
    validateRationalRate(audio.sample_rate);
    validateRationalTime(audio.decoded_duration);
    const measured = rationalTime(
      BigInt(audio.sample_count) * BigInt(audio.sample_rate.denominator),
      BigInt(audio.sample_rate.numerator)
    );
    if (compareTime(measured, audio.decoded_duration) !== 0)
      throw new Error("audio sample count/rate/duration mismatch");
    let end = { numerator: 0, denominator: 1 };
    for (const interval of audio.speech_intervals) {
      validateRationalTime(interval.start);
      validateRationalTime(interval.end);
      if (
        compareTime(interval.start, end) < 0 ||
        compareTime(interval.start, interval.end) >= 0 ||
        compareTime(interval.end, audio.decoded_duration) > 0
      )
        throw new Error("audio speech interval bounds/order");
      end = interval.end;
    }
    assertUnique(
      audio.sync_offsets.map((x) => x.line_id),
      "audio line offsets"
    );
    for (const offset of audio.sync_offsets) validateRationalTime(offset.offset);
  }
  if (id === "penny.videogen-playback-review.v1") {
    const review = validateSkillSchema(PlaybackReviewV1Schema, value, "playback review");
    assertRfc3339Utc(review.recorded_at_utc, "playback time");
    if (
      review.target_ref.content_digest !== review.target_digest ||
      (review.reviewer_kind === "qualified_av" && review.capability_receipt_ref === undefined)
    )
      throw new Error("playback target/capability mismatch");
    for (const point of review.observations)
      if (validateRationalTime(point.time).numerator < 0)
        throw new Error("negative playback observation time");
  }
  if (id === "penny.videogen-admitted-asset-ledger.v1") {
    const ledger = validateSkillSchema(AdmittedAssetLedgerV1Schema, value, "asset queue");
    assertUnique(
      ledger.intents.map((x) => x.asset_id),
      "asset queue IDs"
    );
    assertUnique(
      [...ledger.required_image_ids, ...ledger.required_voice_ids],
      "required asset roles"
    );
    if (
      [...ledger.required_image_ids, ...ledger.required_voice_ids].some(
        (id) => !ledger.intents.some((x) => x.asset_id === id)
      )
    )
      throw new Error("required asset missing from queue");
    for (const intent of ledger.intents) {
      if (intent.state === "pending_image" && !ledger.required_image_ids.includes(intent.asset_id))
        throw new Error("pending image outside required queue");
      if (intent.state === "pending_voice" && !ledger.required_voice_ids.includes(intent.asset_id))
        throw new Error("pending voice outside required queue");
      if (
        intent.state === "captured" &&
        intent.source_ref === undefined &&
        intent.capture_ref === undefined
      )
        throw new Error("captured asset lacks exact bytes");
      if (
        intent.state === "captured" &&
        ledger.required_voice_ids.includes(intent.asset_id) &&
        intent.audio_evidence_ref === undefined
      )
        throw new Error("captured voice lacks audio evidence");
    }
    const pending = ledger.intents.filter((x) => x.state !== "captured");
    const next =
      ledger.next_asset_id === undefined
        ? undefined
        : pending.find((x) => x.asset_id === ledger.next_asset_id);
    if (
      (pending.length > 0 && next === undefined) ||
      (pending.length === 0 && ledger.next_asset_id !== undefined)
    )
      throw new Error("asset queue next selection mismatch");
    if (pending.some((x) => x.state === "pending_image") && next?.state !== "pending_image")
      throw new Error("image queue must precede pending voice");
  }
  if (id === "penny.videogen-animatic.v1") {
    const a = validateSkillSchema(AnimaticV1Schema, value, "animatic");
    assertUnique(
      a.boards.map((x) => x.shot_id),
      "animatic shots"
    );
    let end = { numerator: 0, denominator: 1 };
    for (const board of a.boards) {
      validateRationalTime(board.start);
      validateRationalTime(board.duration);
      if (compareTime(board.start, end) < 0 || board.duration.numerator <= 0)
        throw new Error("animatic board time/order");
      end = rationalTime(
        BigInt(board.start.numerator) * BigInt(board.duration.denominator) +
          BigInt(board.duration.numerator) * BigInt(board.start.denominator),
        BigInt(board.start.denominator) * BigInt(board.duration.denominator)
      );
    }
    if (a.voice_status === "actual_approved" && a.voice_ref === undefined)
      throw new Error("animatic actual voice missing");
  }
  if (id === "penny.videogen-shot-route.v1") {
    const route = validateSkillSchema(ShotRouteV1Schema, value, "shot route");
    if (
      route.shot_id !== route.mode.shot_id ||
      !sameRef(route.qualified_profile_snapshot_ref, route.mode.profile_snapshot_ref) ||
      validateRationalTime(route.timing_target).numerator <= 0 ||
      compareTime(route.timing_target, route.mode.target.duration) !== 0
    )
      throw new Error("shot route identity/time/profile mismatch");
    assertUnique(
      route.estimated_meters.map((x) => x.meter),
      "route meters"
    );
  }
  if (id === "penny.videogen-prepared-graph.v1") {
    const graph = validateSkillSchema(PreparedGraphV1Schema, value, "prepared graph");
    assertUnique(
      graph.allowed_mutations.map((x) => `${x.node_id}:${x.input_name}`),
      "graph mutation addresses"
    );
    assertUnique(
      graph.port_bindings.map((x) => `${x.mutation_node}:${x.mutation_input}`),
      "graph port addresses"
    );
    assertUnique(
      graph.port_bindings.map((x) => x.port_id),
      "graph port IDs"
    );
    if (graph.source_graph_ref.content_digest !== graph.source_digest)
      throw new Error("prepared source graph digest mismatch");
  }
  if (id === "penny.videogen-delivery-receipt.v1") {
    const receipt = validateSkillSchema(DeliveryReceiptV1Schema, value, "delivery receipt");
    if (receipt.outcome === "succeeded" && receipt.readback_refs.length === 0)
      throw new Error("delivery success without readback refs");
  }
  if (id === "penny.videogen-terminal.v1") {
    const terminal = validateSkillSchema(VideogenTerminalV1Schema, value, "videogen terminal");
    if (terminal.met !== (terminal.status === "delivered"))
      throw new Error("videogen terminal status/met mismatch");
    if (
      terminal.met &&
      (terminal.master_ref === undefined ||
        terminal.package_manifest_ref === undefined ||
        terminal.delivery_ref === undefined ||
        terminal.rights_evidence_ref === undefined ||
        terminal.master_review_ref === undefined ||
        terminal.package_review_ref === undefined ||
        terminal.gate_decision_refs.length !== 5 ||
        terminal.unresolved_operation_ids.length !== 0)
    )
      throw new Error("delivered terminal lacks dual-product/gate/evidence closure");
  }
}
