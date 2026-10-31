import { Type } from "typebox";
import { canonicalJson } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { readExact, readSemantic, sameRef, validateFoundation } from "./bounds.js";
import { inspectEditDecision, type EditHostV1 } from "./edit-decision.js";
import { NativeBuildResultV1Schema } from "./stage-contracts.js";
import {
  NativeBuildRequestV1Schema,
  NativeOperationRequestSchema,
  NativeQualifiedRawResultV1Schema,
  NATIVE_RESULT_CONTRACT,
} from "./native-contracts.js";
import { NativePhaseHeaderSchema, NATIVE_VERBS } from "./native-phase-protocol.js";
import { NativeMediaComparisonV1Schema } from "./native-media-comparison.js";
import {
  SettledEvidenceCustody,
  type SettledEvidenceCustodyBindingsV1,
} from "./settled-evidence-custody.js";
import { KdenliveFixtureRegistry } from "./kdenlive-registry.js";
import {
  readNativeTimeline,
  verifyNormalizedNative,
  writeNativeProject,
} from "./kdenlive-writer.js";
import { MeasuredEditSourceV1Schema } from "./edit-contracts.js";
import { inspectCapturedAudioSource } from "./audio-sources.js";
import { quantizeBoundary } from "./rational-time.js";
import type { PersistArtifactInput } from "../artifact-store.js";
import { ArtifactRefSchema } from "../contracts.js";
const closed = { additionalProperties: false } as const;
export const NativePhaseEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-native-phase-evidence.v1"),
    schema_version: Type.Literal(1),
    owner_receipt_ref: ArtifactRefSchema,
    raw_result_ref: ArtifactRefSchema,
    normalized_output_ref: ArtifactRefSchema,
    phase: NativePhaseHeaderSchema,
  },
  closed
);
export const NativeComparisonEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-native-render-comparison.v1"),
    schema_version: Type.Literal(1),
    owner_receipt_ref: ArtifactRefSchema,
    raw_result_ref: ArtifactRefSchema,
    accepted_master_ref: ArtifactRefSchema,
    render_ref: ArtifactRefSchema,
    comparison: NativeMediaComparisonV1Schema,
  },
  closed
);
export interface CustodiedNativeProducts {
  readonly edit_ref: ArtifactRef;
  readonly native_ref: ArtifactRef;
  readonly project_ref: ArtifactRef;
  readonly normalized_project_ref: ArtifactRef;
  readonly raw_ref: ArtifactRef;
  readonly receipt_ref: ArtifactRef;
  readonly accepted_master_ref: ArtifactRef;
  readonly required_assets: readonly {
    readonly source_ref: ArtifactRef;
    readonly relative_path: string;
  }[];
}
/** Materializes only a completed concrete native adapter's custodied evidence; a raw status,
 * receipt-shaped JSON, caller manifest or a conveniently current project is insufficient. */
export class NativeProductProducer {
  private readonly custody: SettledEvidenceCustody;
  constructor(
    private readonly b: SettledEvidenceCustodyBindingsV1 & {
      readonly registry: KdenliveFixtureRegistry;
    }
  ) {
    if (
      b.declaration.operation_kind !== "kdenlive_build_verify" ||
      !(b.registry instanceof KdenliveFixtureRegistry)
    )
      throw new Error("native product owner declaration/registry required");
    this.custody = new SettledEvidenceCustody(b);
  }
  get environmentPins() {
    return { editor: this.b.registry.editor_build_digest, mlt: this.b.registry.mlt_build_digest };
  }
  produce(operationRecordId: string, host: EditHostV1): CustodiedNativeProducts {
    const b = this.b;
    if (host.store !== b.store || host.project_id !== b.project_id)
      throw new Error("native product project/store drift");
    const { record, rawRef, receiptRef, plan, read } = this.custody.verifySettled(
      operationRecordId,
      NATIVE_RESULT_CONTRACT
    );
    const raw = read(
      rawRef,
      NativeQualifiedRawResultV1Schema,
      "penny.videogen-native-raw-result.v1"
    );
    const op = read(
      record.request_ref,
      NativeOperationRequestSchema,
      "penny.videogen-native-operation-request.v1"
    );
    const request = readSemantic({
      ...host,
      ref: op.native_build_request_ref,
      schema: NativeBuildRequestV1Schema,
      schema_id: "penny.videogen-native-build-request.v1",
    });
    if (
      record.identity.run_id !== host.run_id ||
      op.operation_id !== record.operation_id ||
      raw.operation_id !== record.operation_id ||
      raw.request_sha256 !== record.request_sha256 ||
      raw.registry_digest !== b.registry.digest ||
      request.feature_subset_digest !== b.registry.digest ||
      request.editor_build_digest !== b.registry.editor_build_digest ||
      request.mlt_build_digest !== b.registry.mlt_build_digest ||
      request.accepted_master_ref === undefined ||
      !sameRef(raw.accepted_master_ref, request.accepted_master_ref)
    )
      throw new Error("native raw/request/current registry drift");
    const slots = [
      { slot: "native-build", ref: op.native_build_request_ref },
      { slot: "master", ref: request.accepted_master_ref },
      ...request.assets.map((a, i) => ({ slot: `asset-${i}`, ref: a.source_ref })),
    ];
    if (
      canonicalJson(slots) !== canonicalJson(record.input_artifacts.artifacts) ||
      record.output_artifacts.length !== 4 ||
      plan.outputs.length !== 4 ||
      raw.outputs.length !== 4
    )
      throw new Error("native exact inputs/output coverage");
    if (
      rawRef.producer !== `host:${b.declaration.adapter_id}` ||
      rawRef.run_id !== host.run_id ||
      rawRef.content_digest !== plan.operation_result.content_sha256
    )
      throw new Error("native raw producer/plan drift");
    for (const [i, ref] of record.output_artifacts.entries()) {
      const output = raw.outputs[i],
        planned = plan.outputs[i],
        phase = raw.phases[i];
      if (
        !output ||
        !planned ||
        !phase ||
        output.verb !== NATIVE_VERBS[i] ||
        phase.verb !== output.verb ||
        phase.protocol !== "kdenlive-dbus-mlt-v1" ||
        phase.processes.some(
          (p) =>
            p.exit_code !== 0 ||
            (p.role === "editor" && p.executable_sha256 !== b.registry.editor_build_digest)
        ) ||
        output.sha256 !== ref.content_digest ||
        output.bytes !== ref.byte_length ||
        ref.content_digest !== planned.content_sha256 ||
        ref.byte_length !== planned.byte_length ||
        ref.operation_id !== planned.operation_id ||
        ref.version !== planned.version ||
        ref.kind !== planned.artifact_kind ||
        ref.media_type !== planned.media_type ||
        ref.content_schema?.schema_id !== planned.schema_id ||
        ref.content_schema.schema_version !== planned.schema_version_required ||
        ref.producer !== `host:${b.declaration.adapter_id}` ||
        ref.run_id !== host.run_id ||
        ref.phase !== record.state_id
      )
        throw new Error("native phase/output/persistence plan drift");
      readExact(b.store, b.project_id, ref, b.limits.max_integer);
    }
    const first = record.output_artifacts[0],
      normalized = record.output_artifacts[2],
      render = record.output_artifacts[3];
    if (
      !first ||
      !normalized ||
      !render ||
      raw.comparison.master_sha256 !== request.accepted_master_ref.content_digest ||
      raw.comparison.render_sha256 !== render.content_digest ||
      raw.phases[3]?.payload_sha256 !== render.content_digest
    )
      throw new Error("native exact master/render comparison binding");
    readExact(b.store, b.project_id, request.accepted_master_ref, b.limits.max_integer);
    const closure = inspectEditDecision(host, request.edit_ref),
      edit = closure.edit;
    const durations = new Map<string, number>();
    for (const ref of host.measured_source_refs) {
      const m = readSemantic({
        ...host,
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
    for (const a of host.audio_sources) {
      const checked = inspectCapturedAudioSource({ host, ...a, use: "edit" });
      if (checked.status !== "protocol_checked")
        throw new Error("native current audio unavailable");
      durations.set(
        checked.source.media_ref.content_digest,
        quantizeBoundary(
          checked.source.duration,
          edit.canvas.fps,
          request.limits.max_duration_frames
        ).index
      );
    }
    const expected = writeNativeProject({
      registry: b.registry,
      fixture_digest: request.fixture_digest,
      edit,
      assets: request.assets.map((a) => ({
        source_ref: a.source_ref,
        relative_path: a.relative_path,
        bytes: readExact(b.store, b.project_id, a.source_ref, b.limits.max_integer),
        duration_frames: durations.get(a.source_ref.content_digest) ?? 0,
      })),
      limits: host.limits,
      max_frames: request.limits.max_duration_frames,
    });
    for (const ref of record.output_artifacts.slice(0, 3))
      verifyNormalizedNative(
        expected,
        readExact(b.store, b.project_id, ref, b.registry.limits.max_bytes),
        b.registry
      );
    const readback = readNativeTimeline(
      readExact(b.store, b.project_id, normalized, b.registry.limits.max_bytes),
      b.registry
    );
    if (
      readback.duration_frames !== raw.comparison.video_frames ||
      readback.canvas.width !== raw.comparison.width ||
      readback.canvas.height !== raw.comparison.height
    )
      throw new Error("native decoded timeline drift");
    const metadata = (
      id: string,
      schema_id: string,
      upstream_refs: ArtifactRef[]
    ): PersistArtifactInput["metadata"] => ({
      schema_version: 2,
      run_id: host.run_id,
      phase: record.state_id,
      branch_id: rawRef.branch_id,
      kind: id,
      operation_id: `${record.operation_id}:${id}`,
      version: 1,
      producer: "host:videogen-native-products",
      media_type: "application/json",
      parent_ref: null,
      content_schema: { schema_id, schema_version: 1 },
      upstream_refs,
    });
    const persist = (id: string, schema_id: string, value: unknown, upstream: ArtifactRef[]) =>
      b.store.persist({
        metadata: metadata(id, schema_id, upstream),
        content: canonicalJson(value),
      });
    const phaseRefs = raw.phases.slice(0, 3).map((phase, i) => {
      const ref = record.output_artifacts[i];
      if (!ref) throw new Error("native phase ref absent");
      const value = validateFoundation(
        NativePhaseEvidenceV1Schema,
        {
          schema_id: "penny.videogen-native-phase-evidence.v1",
          schema_version: 1,
          owner_receipt_ref: receiptRef,
          raw_result_ref: rawRef,
          normalized_output_ref: ref,
          phase,
        },
        host.limits
      );
      return persist(`native-phase-${i}`, value.schema_id, value, [
        record.request_ref,
        receiptRef,
        rawRef,
        ref,
      ]);
    });
    const comparison = validateFoundation(
      NativeComparisonEvidenceV1Schema,
      {
        schema_id: "penny.videogen-native-render-comparison.v1",
        schema_version: 1,
        owner_receipt_ref: receiptRef,
        raw_result_ref: rawRef,
        accepted_master_ref: request.accepted_master_ref,
        render_ref: render,
        comparison: raw.comparison,
      },
      host.limits
    );
    const compareRef = persist("native-comparison", comparison.schema_id, comparison, [
      record.request_ref,
      receiptRef,
      rawRef,
      render,
      request.accepted_master_ref,
    ]);
    const roundtrip = persist("native-roundtrip-edit", edit.schema_id, edit, [
      normalized,
      ...phaseRefs,
      request.edit_ref,
    ]);
    const native = validateFoundation(
      NativeBuildResultV1Schema,
      {
        schema_id: "penny.videogen-native-build-result.v1",
        schema_version: 1,
        project_ref: first,
        normalized_project_ref: normalized,
        roundtrip_edit_ref: roundtrip,
        dependency_refs: closure.dependency_refs,
        open_save_receipt_ref: phaseRefs[0],
        reopen_receipt_ref: phaseRefs[1],
        relocation_receipt_ref: phaseRefs[2],
        render_comparison_ref: compareRef,
        diagnostics: [
          "Actual confined editor and MLT processes; exact complete CPU frame/sample/PTS comparison. Interactive manual-edit behavior and release admission are not asserted.",
        ],
        status: "qualified",
      },
      host.limits
    );
    const nativeRef = persist("native-build-result", native.schema_id, native, [
      record.request_ref,
      receiptRef,
      rawRef,
      ...record.output_artifacts,
      roundtrip,
      ...phaseRefs,
      compareRef,
    ]);
    return {
      edit_ref: request.edit_ref,
      native_ref: nativeRef,
      project_ref: first,
      normalized_project_ref: normalized,
      raw_ref: rawRef,
      receipt_ref: receiptRef,
      accepted_master_ref: request.accepted_master_ref,
      required_assets: request.assets.map((a) => ({
        source_ref: a.source_ref,
        relative_path: a.relative_path,
      })),
    };
  }
}
