import { ConfinedMediaRunner } from "../host-operations/confined-media-runner.js";
import type { MediaDecodePolicyV1 } from "./media-contracts.js";
import { compareNativeMedia, type NativeMediaComparisonV1 } from "./native-media-comparison.js";
import type { NativePhaseHeader } from "./native-phase-protocol.js";
import { MeasuredEditSourceV1Schema } from "./edit-contracts.js";
import { verifyHostEffectBinding } from "../host-operations/effect-protocol.js";
import {
  currentAdapterHost,
  assertAdapterOwnerBinding,
  assertNativeG4Lineage,
} from "./native-owner-authority.js";
import type { VideogenOwnerSelection } from "./owner-selection.js";
import type { HostOperationUseValidatorV1 } from "../host-operations/owner.js";
import { checkGateApproval } from "./gates.js";
import { BudgetReservationV1Schema, validateBudgetReservation } from "./foundation-contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { HostOperationAdapterV1 } from "../host-operations/contracts.js";
import {
  ConfinedNativeRunner,
  NATIVE_VERBS,
  type NativeProcessPolicy,
} from "../host-operations/confined-native-runner.js";
import { parseMediaJson } from "./media-contracts.js";
import { readExact, readSemantic, sameRef, validateFoundation } from "./bounds.js";
import { inspectEditDecision, type EditHostV1 } from "./edit-decision.js";
import { inspectCapturedAudioSource } from "./audio-sources.js";
import { quantizeBoundary } from "./rational-time.js";
import {
  NativeBuildRequestV1Schema,
  type NativeBuildRequestV1,
  NativeRawResultV1Schema,
  NativeOperationRequestSchema,
  NATIVE_REQUEST_CONTRACT,
  NATIVE_RESULT_CONTRACT,
  NATIVE_PROJECT_CONTRACT,
  NATIVE_RENDER_CONTRACT,
} from "./native-contracts.js";
import { KdenliveFixtureRegistry } from "./kdenlive-registry.js";
import {
  writeNativeProject,
  verifyNormalizedNative,
  normalizeObservedNative,
} from "./kdenlive-writer.js";
import { nativeRefuse } from "./native-xml.js";

export interface NativeAdapterBinding {
  readonly adapter_id: string;
  readonly backend_binding_id: string;
  readonly backend_key_sha256: string;
  readonly registry: KdenliveFixtureRegistry;
  readonly runner: ConfinedNativeRunner;
  readonly process_policy: NativeProcessPolicy;
  readonly comparison?: {
    readonly runner: ConfinedMediaRunner;
    readonly policy: MediaDecodePolicyV1;
  };
  readonly owner: VideogenOwnerSelection;
  readonly host: EditHostV1;
  readonly output_root_selector: string;
}
/** Collects live native and full-decode evidence; owner alone journals/persists receipts.
 * NativeProductProducer materializes domain products only from exact settled custody.
 * Interrupted native work is never replayed; accepted ambiguity remains owner-quarantined. */
export function createKdenliveAdapter(
  binding: NativeAdapterBinding
): HostOperationAdapterV1 & HostOperationUseValidatorV1 {
  if (
    !ConfinedNativeRunner.isTrusted(binding.runner) ||
    !(binding.registry instanceof KdenliveFixtureRegistry)
  )
    nativeRefuse("concrete registry/runner required");
  if (
    !binding.runner.hasRuntimeDigest(binding.registry.editor_build_digest) ||
    !binding.runner.hasRuntimeDigest(binding.registry.mlt_build_digest)
  )
    nativeRefuse("editor/MLT build pins absent from actual runner snapshots");
  const b = {
    ...binding,
    host: { ...binding.host, edit_policy: structuredClone(binding.host.edit_policy) },
    process_policy: structuredClone(binding.process_policy),
  };
  assertAdapterOwnerBinding(b.owner, b.host);
  if (b.comparison !== undefined && !ConfinedMediaRunner.isTrusted(b.comparison.runner))
    nativeRefuse("concrete CPU comparison runner required");
  const validateCurrent = (
    d: Parameters<HostOperationAdapterV1["inspectRequest"]>[0]["directive"],
    request: NativeBuildRequestV1
  ) => {
    const current = currentAdapterHost(b.owner, b.host),
      h = current.host;
    const effect = verifyHostEffectBinding(h.store, h.project_id, d);
    if (
      effect === undefined ||
      !d.effect_identity ||
      !sameRef(d.effect_identity.predecessor_ref, request.edit_ref)
    )
      nativeRefuse("native request/intent pair required");
    const approved = checkGateApproval(h, "G4", effect.gate_decision_ref);
    assertNativeG4Lineage(b.owner, request.edit_ref, approved.packet, effect.gate_decision_ref);
    if (approved.packet.kind !== "approval") nativeRefuse("current G4 native scope required");
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
      budget.operation_kind !== "kdenlive_build_verify" ||
      budget.state !== "held" ||
      Date.parse(budget.created_at_utc) > Date.parse(h.now_utc) ||
      !sameRef(budget.scope_gate_ref, effect.gate_decision_ref) ||
      Date.parse(budget.expires_at_utc) <= Date.parse(h.now_utc) ||
      !approved.packet.effect_scope.subject_ids.includes(budget.subject_id)
    )
      nativeRefuse("current held native reservation/scope required");
    for (const ref of Object.values(budget.policy_refs)) h.store.read(ref);
    current.requireSelected([
      request.edit_ref,
      ...(request.accepted_master_ref === undefined ? [] : [request.accepted_master_ref]),
      effect.budget_reservation_ref,
      ...request.assets.map((a) => a.source_ref),
    ]);
    const attempt = budget.meters.find((m) => m.meter === "attempts");
    const storage = budget.meters.find((m) => m.meter === "stored_bytes");
    if (
      !attempt ||
      attempt.reserved - attempt.consumed < 1 ||
      !storage ||
      BigInt(storage.reserved - storage.consumed) <
        BigInt(b.process_policy.max_output_bytes) * 4n + BigInt(h.limits.max_json_bytes)
    )
      nativeRefuse("native attempt/storage allowance insufficient");
    const closure = inspectEditDecision(h, request.edit_ref);
    if (!sameRef(closure.edit.source_dependency_ledger_ref, current.ledger_ref))
      nativeRefuse("selected native ledger drift");
    current.assertUnchanged();
    return { ...current, closure };
  };
  const inspect: HostOperationAdapterV1["inspectRequest"] = (input) => {
    const current = currentAdapterHost(b.owner, b.host),
      h = current.host;
    const request = parseMediaJson(NativeOperationRequestSchema, input.request_bytes, h.limits),
      d = input.directive;
    if (
      d.operation_kind !== "kdenlive_build_verify" ||
      d.identity.run_id !== h.run_id ||
      d.operation_id !== request.operation_id ||
      canonicalJson(d.expected_result) !== canonicalJson(NATIVE_RESULT_CONTRACT) ||
      canonicalJson(input.declaration.request) !== canonicalJson(NATIVE_REQUEST_CONTRACT) ||
      !d.input_artifacts.artifacts.some(
        (i) =>
          i.slot === "native-build" &&
          canonicalJson(i.ref) === canonicalJson(request.native_build_request_ref)
      )
    )
      nativeRefuse("operation/request/registration binding");
    const build = readSemantic({
      ...h,
      ref: request.native_build_request_ref,
      schema: NativeBuildRequestV1Schema,
      schema_id: "penny.videogen-native-build-request.v1",
    });
    if (request.native_build_request_ref.run_id !== h.run_id)
      nativeRefuse("native build parent mismatch");
    current.requireSelected([request.native_build_request_ref]);
    if (
      build.assets.length > build.limits.max_assets ||
      build.editor_build_digest !== b.registry.editor_build_digest ||
      build.mlt_build_digest !== b.registry.mlt_build_digest ||
      build.feature_subset_digest !== b.registry.digest ||
      build.output_root_selector !== b.output_root_selector ||
      build.limits.max_xml_bytes > b.registry.limits.max_bytes
    )
      nativeRefuse("current native build/feature/selector/limit drift");
    const expected = [
      { slot: "native-build", ref: request.native_build_request_ref },
      ...(build.accepted_master_ref === undefined
        ? []
        : [{ slot: "master", ref: build.accepted_master_ref }]),
      ...build.assets.map((a, i) => ({ slot: `asset-${i}`, ref: a.source_ref })),
    ];
    if (canonicalJson(expected) !== canonicalJson(d.input_artifacts.artifacts))
      nativeRefuse("exact native input slots");
    validateCurrent(d, build);
    current.assertUnchanged();
    return {
      schema_version: 1,
      operation_kind: "kdenlive_build_verify",
      adapter_id: b.adapter_id,
      backend_binding_id: b.backend_binding_id,
      backend_key_sha256: b.backend_key_sha256,
    };
  };
  return {
    adapter_id: b.adapter_id,
    inspectRequest: inspect,
    validateUse(input) {
      input.signal.throwIfAborted();
      inspect({ ...input, input_artifacts: input.directive.input_artifacts });
    },
    async run(context) {
      const { isCanonicalHostOperationExecutionContextV1 } =
        await import("../host-operations/owner.js");
      if (!isCanonicalHostOperationExecutionContextV1(context))
        nativeRefuse("owner context required");
      inspect({
        directive: context.directive,
        declaration: context.declaration,
        request_bytes: context.request_bytes,
        input_artifacts: context.directive.input_artifacts,
      });
      if (context.journal.lifecycle !== "lease_acquired")
        nativeRefuse("interrupted native effect cannot be replayed");
      const request = parseMediaJson(
        NativeBuildRequestV1Schema,
        context.readInput("native-build").bytes,
        currentAdapterHost(b.owner, b.host).host.limits
      );
      if (
        request.assets.length > request.limits.max_assets ||
        request.editor_build_digest !== b.registry.editor_build_digest ||
        request.mlt_build_digest !== b.registry.mlt_build_digest ||
        request.feature_subset_digest !== b.registry.digest ||
        request.output_root_selector !== b.output_root_selector ||
        request.assets.length > request.limits.max_assets ||
        request.limits.max_xml_bytes > b.registry.limits.max_bytes
      )
        nativeRefuse("current build/feature/selector/limit drift");
      const expected = [
        { slot: "native-build", ref: context.readInput("native-build").ref },
        ...(request.accepted_master_ref === undefined
          ? []
          : [{ slot: "master", ref: request.accepted_master_ref }]),
        ...request.assets.map((a, i) => ({ slot: `asset-${i}`, ref: a.source_ref })),
      ];
      if (canonicalJson(expected) !== canonicalJson(context.directive.input_artifacts.artifacts))
        nativeRefuse("exact native input slots");
      const current = validateCurrent(context.directive, request),
        h = current.host,
        closure = current.closure;
      const edit = closure.edit;
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
        if (checked.status !== "protocol_checked") nativeRefuse("current audio source unavailable");
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
        assets: request.assets.map((a) => {
          const i = request.assets.indexOf(a);
          return {
            source_ref: a.source_ref,
            relative_path: a.relative_path,
            bytes: context.readInput(`asset-${i}`).bytes,
            duration_frames: durations.get(a.source_ref.content_digest) ?? 0,
          };
        }),
        limits: h.limits,
        max_frames: request.limits.max_duration_frames,
      });
      if (written.bytes.length > request.limits.max_xml_bytes) nativeRefuse("generated XML limit");
      const files = [
        { relative_path: "project.kdenlive", bytes: written.bytes },
        ...request.assets.map((a) => ({
          relative_path: a.relative_path,
          bytes: context.readInput(`asset-${request.assets.indexOf(a)}`).bytes,
        })),
      ];
      if (
        BigInt(b.process_policy.max_output_bytes) * 4n + BigInt(h.limits.max_json_bytes) >
        BigInt(context.declaration.max_output_bytes)
      )
        nativeRefuse("native aggregate output reservation too small");
      const outputs: { verb: string; bytes: Buffer }[] = [];
      const phases: NativePhaseHeader[] = [];
      let comparison: NativeMediaComparisonV1 | undefined;
      current.assertUnchanged();
      validateCurrent(context.directive, request);
      context.beginSubmission();
      let closed = false;
      context.registerRemoteCancellation(async () =>
        closed
          ? { remote_disposition: "proven_terminal", reason_code: "native_process_closed" }
          : { remote_disposition: "may_continue", reason_code: "native_cleanup_pending" }
      );
      try {
        for (const verb of NATIVE_VERBS) {
          current.assertUnchanged();
          validateCurrent(context.directive, request);
          const call = {
            verb,
            files,
            policy: {
              ...b.process_policy,
              max_elapsed_ms: Math.min(
                b.process_policy.max_elapsed_ms ?? request.limits.max_normalize_ms,
                request.limits.max_normalize_ms
              ),
            },
            signal: context.signal,
          };
          const observed = b.runner.supportsPhaseEvidence
            ? await b.runner.runObserved(call)
            : undefined;
          let bytes = observed?.bytes ?? (await b.runner.run(call));
          if (observed !== undefined) phases.push(observed.header);
          current.assertUnchanged();
          validateCurrent(context.directive, request);
          if (verb !== "render_compare") {
            if (bytes.length > request.limits.max_xml_bytes)
              nativeRefuse("normalized XML request limit");
            if (observed !== undefined)
              bytes = normalizeObservedNative(written, observed, b.registry);
            else verifyNormalizedNative(written, bytes, b.registry);
            files[0] = {
              relative_path: "project.kdenlive",
              bytes:
                verb === "relocate_reopen_readback" && observed !== undefined
                  ? observed.bytes
                  : bytes,
            };
          }
          outputs.push({ verb, bytes });
          context.reportActivity(`native_${verb}`, 1);
        }
        if (
          phases.length === 4 &&
          request.accepted_master_ref !== undefined &&
          b.comparison !== undefined
        ) {
          if (
            request.accepted_master_ref.media_type !== "video/mp4" ||
            request.accepted_master_ref.run_id !== h.run_id ||
            !sameRef(context.readInput("master").ref, request.accepted_master_ref)
          )
            nativeRefuse("exact current master input required");
          const render = outputs[3];
          if (render?.verb !== "render_compare") nativeRefuse("native render output required");
          comparison = await compareNativeMedia({
            runner: b.comparison.runner,
            policy: b.comparison.policy,
            limits: h.limits,
            master: readExact(
              h.store,
              h.project_id,
              request.accepted_master_ref,
              b.comparison.policy.max_input_bytes
            ),
            render: render.bytes,
            width: written.readback.canvas.width,
            height: written.readback.canvas.height,
            frame_rate: edit.canvas.fps,
            duration_frames: written.readback.duration_frames,
            signal: context.signal,
          });
          current.assertUnchanged();
          validateCurrent(context.directive, request);
          context.reportActivity("native_full_decode_comparison", 1);
        }
      } finally {
        closed = true;
      }
      const result = canonicalJson(
        validateFoundation(
          NativeRawResultV1Schema,
          {
            schema_id: "penny.videogen-native-raw-result.v1",
            schema_version: 1,
            operation_id: context.directive.operation_id,
            request_sha256: context.directive.request_sha256,
            registry_digest: b.registry.digest,
            outputs: outputs.map((o) => ({
              verb: o.verb,
              sha256: sha256(o.bytes),
              bytes: o.bytes.length,
            })),
            ...(comparison !== undefined
              ? {
                  status: "qualified",
                  phases,
                  comparison,
                  accepted_master_ref: request.accepted_master_ref,
                }
              : phases.length === 4
                ? {
                    status: "observed",
                    phases,
                    unverified: ["full_decode_native_render_comparison"],
                  }
                : {
                    status: "constructed_unqualified",
                    unverified: [
                      "actual_editor_automation_qualification",
                      "full_decode_native_render_comparison",
                      "relocated_font_fidelity",
                      "manual_trim_gain_caption_edit",
                    ],
                  }),
          },
          h.limits
        )
      );
      current.assertUnchanged();
      validateCurrent(context.directive, request);
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256(result),
        byte_length: Buffer.byteLength(result),
        item_count: outputs.length,
        poll_count: 0,
      });
      const disposition = {
        outcome: "completed",
        remote_disposition: "proven_terminal",
        lease_disposition: "released",
        retryable: false,
        reason_code: null,
      } as const;
      const persisted = context.persist({
        disposition,
        operation_result: {
          contract: NATIVE_RESULT_CONTRACT,
          media_type: "application/json",
          content: result,
        },
        outputs: outputs.map((o) => ({
          contract: o.verb === "render_compare" ? NATIVE_RENDER_CONTRACT : NATIVE_PROJECT_CONTRACT,
          media_type:
            o.verb === "render_compare" && phases.length === 4
              ? "video/mp4"
              : o.verb === "render_compare"
                ? "application/octet-stream"
                : "application/x-kdenlive",
          content: o.bytes,
        })),
      });
      return { disposition, ...persisted };
    },
  };
}
