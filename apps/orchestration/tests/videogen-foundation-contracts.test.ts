import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ArtifactRefSchema } from "../dist/contracts.js";
import { canonicalJson } from "../dist/canonical-json.js";
import {
  assertBoundedJson,
  exactRef,
  readSemantic,
  validateFoundation,
} from "../dist/videogen/bounds.js";
import {
  VideoRequestV1Schema,
  validateVideoRequest,
  validateAssetIntent,
  validateBudgetReservation,
  validateProjectEnvelope,
  type VideoRequestV1,
  type BudgetReservationV1,
} from "../dist/videogen/foundation-contracts.js";
import { reconcileBudget } from "../dist/videogen/budget.js";
import {
  bindScriptDraft,
  prepareVideoAdmission,
  type VideogenAdmissionHostV1,
  type AdmissionConfigV1,
  type CapabilitySnapshotV1,
  type AdmissionCapacityV1,
} from "../dist/videogen/admission.js";
import {
  FoundationFixture,
  FOUNDATION_LIMITS as limits,
} from "./helpers/videogen-foundation-fixtures.js";
export function request(): VideoRequestV1 {
  return {
    schema_id: "penny.videogen-request.v1",
    schema_version: 1,
    brief: "A caller-supplied voice-only story",
    source_refs: [],
    destination_id: "local-output",
    format_intent: {
      container: "mp4",
      video_codec: "h264",
      audio_codec: "aac",
      width: 640,
      height: 360,
      fps: { numerator: 24, denominator: 1 },
      audio_rate: { numerator: 48000, denominator: 1 },
      channels: "mono",
      captions_required: false,
    },
    unresolved: [],
    constraints: {
      duration: { numerator: 2, denominator: 1 },
      max_scenes: 2,
      max_shots: 3,
      max_storage_bytes: 1000,
      max_cost_units: 10,
      max_attempts: 2,
    },
    requested_routes: ["UC-02"],
    delegated_decisions: ["camera"],
    must_haves: ["captured voice"],
    dislikes: [],
  };
}
function admission(f: FoundationFixture, req: unknown = request()) {
  const request_ref = f.json(req, "penny.videogen-request.v1");
  const digest = "b".repeat(64);
  const queue = f.opaque("queue");
  const inactivity = f.opaque("inactivity");
  const cleanup = f.opaque("cleanup");
  const rights = f.opaque("host rights scope");
  const policy_binding_ref = f.json(
    {
      schema_id: "penny.videogen-policy-binding.v1",
      schema_version: 1,
      queue_policy_ref: { ref: queue, max_wait_ms: 1000, discipline: "FIFO" },
      inactivity_policy_ref: {
        ref: inactivity,
        active_inactivity_ms: 2000,
        transport_silence_ms: 3000,
        renewal_source: "trusted_host_milestone",
      },
      cleanup_policy_ref: {
        ref: cleanup,
        cancel_grace_ms: 1000,
        retention_ms: 5000,
        quarantine_requires_operator_proof: true,
      },
    },
    "penny.videogen-policy-binding.v1"
  );
  const capability: CapabilitySnapshotV1 = {
    schema_id: "penny.videogen-capability-snapshot.v1",
    schema_version: 1,
    private_config_digest: digest,
    routes: [
      {
        route_id: "UC-02",
        profile_snapshot_ref: f.opaque("profile"),
        qualification_ref: f.opaque("fixture qualification"),
        output_contract_ref: f.opaque("output contract"),
      },
    ],
    formats: [{ container: "mp4", video_codec: "h264", audio_codec: "aac", channels: "mono" }],
    max_width: 640,
    max_height: 360,
    max_duration_seconds: 10,
  };
  const config: AdmissionConfigV1 = {
    schema_id: "penny.videogen-admission-config.v1",
    schema_version: 1,
    private_config_digest: digest,
    capability_snapshot_ref: f.json(capability, capability.schema_id),
    rights_scope_ref: rights,
    policy_binding_ref,
    limits_ref: f.json(limits, limits.schema_id),
    local_destination_ids: ["local-output"],
    microcredits_per_cost_unit: 10,
  };
  const capacity: AdmissionCapacityV1 = {
    schema_id: "penny.videogen-admission-capacity.v1",
    schema_version: 1,
    request_ref,
    consumer_run_id: f.run_id,
    owner_snapshot_ref: f.opaque("capacity owner"),
    storage_bytes_held: 2000,
    cost_microcredits_held: 200,
    engine_steps_held: 20,
    finish_bytes_held: 100,
    finish_microcredits_held: 10,
    finish_steps_held: 2,
    spent_microcredits: 0,
    used_storage_bytes: 0,
  };
  const current_capacity_ref = f.json(capacity, capacity.schema_id);
  const envelope = {
    schema_id: "penny.videogen-envelope.v1",
    schema_version: 1,
    request_ref,
    private_config_digest: digest,
    capability_snapshot_ref: config.capability_snapshot_ref,
    rights_scope_ref: rights,
    storage_reservation_ref: current_capacity_ref,
    max_scenes: 2,
    max_shots: 3,
    max_frames: 48,
    max_source_bytes: 2000,
    max_output_bytes: 2000,
    max_storage_bytes: 2000,
    max_active_jobs: 1,
    max_attempts: 2,
    max_cost_units: 20,
    finish_reserve_bytes: 100,
    finish_reserve_cost_units: 1,
    finish_reserve_steps: 2,
    queue_policy_ref: queue,
    inactivity_policy_ref: inactivity,
    cleanup_policy_ref: cleanup,
  };
  const host: VideogenAdmissionHostV1 = {
    ...f.host(),
    current_config_ref: f.json(config, config.schema_id),
    private_config_digest: digest,
    current_capacity_ref,
    current_qualified_routes: capability.routes,
    admitted_destination_id: "local-output",
  };
  return {
    host,
    request_ref,
    envelope_ref: f.json(envelope, envelope.schema_id),
    envelope,
    capacity,
  };
}
describe("WP002 closed bounded foundation", () => {
  it("uses the exact platform schema; rejects unsafe ref/semantic identities", () => {
    expect(VideoRequestV1Schema.properties.source_refs.items.properties.ref).toEqual(
      ArtifactRefSchema
    );
    using f = new FoundationFixture();
    const ref = f.opaque("x");
    expect(exactRef(ref)).toEqual(ref);
    expect(() => exactRef({ ...ref, store_ref: `artifact://sha256/${"c".repeat(64)}` })).toThrow();
    expect(() =>
      validateVideoRequest(
        {
          ...request(),
          source_refs: [
            {
              ref: { ...ref, store_ref: `artifact://sha256/${"c".repeat(64)}` },
              role: "image",
              rights_ref: ref,
            },
          ],
        },
        limits
      )
    ).toThrow();
    const product = f.json(request(), "penny.videogen-request.v1");
    expect(
      readSemantic({
        store: f.store,
        project_id: f.project_id,
        ref: product,
        schema: VideoRequestV1Schema,
        schema_id: request().schema_id,
        limits,
      })
    ).toEqual(request());
    expect(() =>
      readSemantic({
        store: f.store,
        project_id: `prj_${"2".repeat(32)}`,
        ref: product,
        schema: VideoRequestV1Schema,
        schema_id: request().schema_id,
        limits,
      })
    ).toThrow();
    for (const bytes of [
      canonicalJson(request()).replace(
        '"schema_id":"penny.videogen-request.v1"',
        '"schema_id":"penny.videogen-request.v1","schema_id":"penny.videogen-request.v1"'
      ),
      canonicalJson(request()) + " ",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonicalJson(request()))]),
      Buffer.from([0xff]),
    ]) {
      const invalid = f.raw(bytes, "application/json", request().schema_id);
      expect(() =>
        readSemantic({
          store: f.store,
          project_id: f.project_id,
          ref: invalid,
          schema: VideoRequestV1Schema,
          schema_id: request().schema_id,
          limits,
        })
      ).toThrow();
    }
  });
  it.each(["extra", "route", "fraction", "overflow", "unreduced", "oversized", "duplicate"])(
    "rejects %s at ingress",
    (kind) => {
      const r = request();
      const value =
        kind === "extra"
          ? { ...r, graph: {} }
          : kind === "route"
            ? { ...r, requested_routes: ["UC-99"] }
            : kind === "fraction"
              ? { ...r, constraints: { ...r.constraints, max_attempts: 1.5 } }
              : kind === "overflow"
                ? {
                    ...r,
                    constraints: { ...r.constraints, max_cost_units: Number.MAX_SAFE_INTEGER + 1 },
                  }
                : kind === "unreduced"
                  ? {
                      ...r,
                      format_intent: { ...r.format_intent, fps: { numerator: 48, denominator: 2 } },
                    }
                  : kind === "oversized"
                    ? { ...r, brief: "x".repeat(limits.max_text_bytes + 1) }
                    : { ...r, requested_routes: ["UC-02", "UC-02"] };
      expect(() => validateVideoRequest(value, limits)).toThrow();
    }
  );
  it("rejects complexity, non-JSON values, accessors and malformed Unicode", () => {
    const cycle: { child?: unknown } = {};
    cycle.child = cycle;
    for (const value of [
      cycle,
      new Date(),
      { x: undefined },
      { x: "\ud800" },
      { x: NaN },
      { x: Infinity },
      {
        get x() {
          throw new Error("accessor must not execute");
        },
      },
    ])
      expect(() => assertBoundedJson(value, limits)).toThrow();
    let evaluated = false;
    const accessorArray = [1];
    Object.defineProperty(accessorArray, "0", {
      get: () => {
        evaluated = true;
        return 1;
      },
    });
    expect(() => assertBoundedJson(accessorArray, limits)).toThrow(/array/);
    expect(evaluated).toBe(false);
    const extraArray = [1];
    Object.defineProperty(extraArray, "toJSON", {
      value: () => {
        evaluated = true;
        return [];
      },
    });
    expect(() => assertBoundedJson(extraArray, limits)).toThrow(/array/);
    expect(evaluated).toBe(false);
    expect(() => assertBoundedJson([1, 2], { ...limits, max_collection_items: 1 })).toThrow();
    expect(() => assertBoundedJson({ a: { b: 1 } }, { ...limits, max_depth: 1 })).toThrow();
    expect(() =>
      validateFoundation(
        Type.Object({ x: Type.String() }),
        { x: "valid" },
        { ...limits, max_json_bytes: 2 }
      )
    ).toThrow();
  });
  it("prepares from injected bindings without creating a run or giving effect permission", () => {
    using f = new FoundationFixture();
    const input = admission(f);
    expect(prepareVideoAdmission(input)).toMatchObject({
      status: "prepared",
      effect_permission: "none",
    });
    expect(f.checkpointer.runExists(f.run_id)).toBe(false);
    expect(
      prepareVideoAdmission({ request_ref: input.request_ref, envelope_ref: input.envelope_ref })
    ).toMatchObject({ status: "refused", reason: "missing_host" });
    expect(
      prepareVideoAdmission({ ...input, host: { ...input.host, current_qualified_routes: [] } })
    ).toMatchObject({ status: "refused" });
    expect(
      prepareVideoAdmission({
        ...input,
        host: { ...input.host, admitted_destination_id: "changed" },
      })
    ).toMatchObject({ status: "refused" });
    expect(
      prepareVideoAdmission({
        ...input,
        host: {
          ...input.host,
          current_capacity_ref: f.json(
            { ...input.capacity, storage_bytes_held: 100 },
            input.capacity.schema_id
          ),
        },
      })
    ).toMatchObject({ status: "refused" });
    expect(() =>
      validateProjectEnvelope(
        { ...input.envelope, finish_reserve_bytes: input.envelope.max_storage_bytes },
        limits
      )
    ).toThrow();
  });
  it("asks only unresolved or absent consequential fields, never granting compute", () => {
    using f = new FoundationFixture();
    expect(
      prepareVideoAdmission(admission(f, { ...request(), unresolved: ["voice-identity"] }))
    ).toMatchObject({
      status: "needs_clarification",
      fields: ["voice-identity"],
      effect_permission: "none",
    });
    const { destination_id: _missing, ...partial } = request();
    expect(prepareVideoAdmission(admission(f, partial))).toMatchObject({
      status: "needs_clarification",
      fields: ["destination_id"],
      effect_permission: "none",
    });
    expect(prepareVideoAdmission(admission(f, { ...partial, graph: {} }))).toMatchObject({
      status: "refused",
    });
    expect(f.checkpointer.runExists(f.run_id)).toBe(false);
  });
  it("refuses source without current rights or with wrong role", () => {
    using f = new FoundationFixture();
    const png = f.opaque("fixture PNG", "image/png");
    const rights = f.rights(png);
    const r = { ...request(), source_refs: [{ ref: png, role: "image", rights_ref: rights }] };
    expect(prepareVideoAdmission(admission(f, r))).toMatchObject({ status: "prepared" });
    f.current_rights.splice(0);
    expect(prepareVideoAdmission(admission(f, r))).toMatchObject({ status: "refused" });
    expect(
      prepareVideoAdmission(
        admission(f, { ...r, source_refs: [{ ...r.source_refs[0], role: "video" }] })
      )
    ).toMatchObject({ status: "refused" });
  });
  it("binds worker script-draft to exact outline; no worker ref authorship", () => {
    using f = new FoundationFixture();
    const outline = {
      schema_id: "penny.videogen-story-outline.v1",
      schema_version: 1,
      scenes: [{ scene_id: "scene1", order: 1, beat: "Arrival" }],
      shots: [
        {
          shot_id: "shot1",
          scene_id: "scene1",
          order: 1,
          intent: "Introduce",
          action: "Enter",
          observable_end: "Stopped",
          camera: "Wide",
          coverage: "Entrance",
          continuity_depends_on: [],
          spoken_line_ids: ["line1"],
        },
      ],
      script_brief: {
        language: "en",
        scene_line_intents: [
          { scene_id: "scene1", speaker_id: "speaker1", text_intent: "Greeting" },
        ],
      },
      acceptance_criteria: ["Voice greeting"],
    };
    const draft = {
      schema_id: "penny.videogen-script-draft.v1",
      schema_version: 1,
      scenes: [
        {
          scene_id: "scene1",
          ordered_lines: [
            { line_id: "line1", speaker_id: "speaker1", text: "Hello", delivery_intent: "Warm" },
          ],
        },
      ],
      narration_lines: [],
      language: "en",
      coverage_shot_ids: ["shot1"],
    };
    const outline_ref = f.json(outline, outline.schema_id);
    const draft_ref = f.json(draft, draft.schema_id);
    expect(
      bindScriptDraft({ store: f.store, project_id: f.project_id, outline_ref, draft_ref, limits })
    ).toMatchObject({ schema_id: "penny.videogen-script.v1", story_outline_ref: outline_ref });
    for (const value of [
      { ...outline, needs_clarification: true, clarifying_questions: ["Resolve story"] },
      {
        ...outline,
        script_brief: {
          ...outline.script_brief,
          scene_line_intents: [
            { scene_id: "missing", speaker_id: "speaker1", text_intent: "Greeting" },
          ],
        },
      },
    ])
      expect(() =>
        bindScriptDraft({
          store: f.store,
          project_id: f.project_id,
          outline_ref: f.json(value, outline.schema_id),
          draft_ref,
          limits,
        })
      ).toThrow();
    for (const value of [
      { ...draft, story_outline_ref: outline_ref },
      { ...draft, coverage_shot_ids: ["invented"] },
      { ...draft, language: "fr" },
      { ...draft, needs_clarification: true },
    ])
      expect(() =>
        bindScriptDraft({
          store: f.store,
          project_id: f.project_id,
          outline_ref,
          draft_ref: f.json(value, draft.schema_id),
          limits,
        })
      ).toThrow();
  });
  it("keeps proposed intents effect-free; rejects forged gate, meter pairings and revisions", () => {
    using f = new FoundationFixture();
    const ref = f.opaque("fixture");
    const intent = {
      schema_id: "penny.videogen-asset-intent.v1",
      schema_version: 1,
      asset_id: "asset1",
      purpose: "first_frame",
      story_ref: ref,
      source: "imagegen_fresh",
      input_refs: [],
      allowed_change: "Create",
      preserve_criteria: ["Intent"],
      consent_ref: ref,
      rights_ref: ref,
      estimated_meters: [{ meter: "attempts", reserved: 1 }],
      attempt_limit: 1,
      scope_status: "proposed",
    };
    expect(validateAssetIntent(intent, limits).scope_status).toBe("proposed");
    for (const value of [
      { ...intent, gate_scope_ref: ref },
      { ...intent, scope_status: "approved" },
      { ...intent, source: "imagegen_revision" },
    ])
      expect(() => validateAssetIntent(value, limits)).toThrow();
    const reservation = budget(f);
    expect(() =>
      validateBudgetReservation(
        { ...reservation, meters: [{ meter: "attempts", reserved: 2, consumed: 0, unit: "byte" }] },
        limits
      )
    ).toThrow();
    expect(() =>
      validateBudgetReservation(
        {
          ...reservation,
          meters: [{ meter: "attempts", reserved: 2, consumed: 3, unit: "count" }],
        },
        limits
      )
    ).toThrow();
  });
});
function budget(f: FoundationFixture): BudgetReservationV1 {
  const ref = f.opaque("budget gate/policy");
  return {
    schema_id: "penny.videogen-budget-reservation.v1",
    schema_version: 1,
    reservation_id: "reservation1",
    scope_gate_ref: ref,
    subject_id: "shot1",
    operation_kind: "video_render",
    meters: [{ meter: "attempts", reserved: 2, consumed: 0, unit: "count" }],
    created_at_utc: "2026-10-12T00:00:00Z",
    expires_at_utc: "2026-10-12T00:10:00Z",
    policy_refs: { queue: ref, inactivity: ref, cleanup: ref },
    state: "held",
    reason: "prepared",
  };
}
describe("WP002 budget projection, not WP008 atomic reserve", () => {
  it("counts cumulative actual spend once and releases unused only on proof", () => {
    using f = new FoundationFixture();
    const reservation = budget(f);
    const reservation_ref = f.json(reservation, reservation.schema_id);
    const measurement = {
      operation_id: "op1",
      reservation_ref,
      journal_ref: f.opaque("journal"),
      readings: [{ meter: "attempts", consumed: 1 }],
      submission: "submitted",
      disposition: "terminal_proven",
    };
    const settled = reconcileBudget({
      reservation,
      reservation_ref,
      operation_id: "op1",
      measurement,
      limits,
    });
    expect(settled.reservation).toMatchObject({
      state: "settled",
      meters: [{ consumed: 1, reserved: 2 }],
    });
    expect(settled.unused_released).toEqual([{ meter: "attempts", amount: 1 }]);
    expect(
      reconcileBudget({
        reservation: settled.reservation,
        reservation_ref,
        operation_id: "op1",
        measurement,
        limits,
      }).unused_released
    ).toEqual([]);
    for (const bad of [
      { ...measurement, disposition: "queue_expired" },
      { ...measurement, operation_id: "other" },
      { ...measurement, readings: [{ meter: "attempts", consumed: 3 }] },
      { ...measurement, readings: [{ meter: "attempts", consumed: 1.5 }] },
    ])
      expect(() =>
        reconcileBudget({
          reservation,
          reservation_ref,
          operation_id: "op1",
          measurement: bad,
          limits,
        })
      ).toThrow();
    const quarantined = reconcileBudget({
      reservation,
      reservation_ref,
      operation_id: "op1",
      measurement: { ...measurement, submission: "unknown", disposition: "remote_unknown" },
      limits,
    });
    expect(quarantined.reservation.state).toBe("quarantined");
    expect(quarantined.unused_released).toEqual([]);
    expect(() =>
      reconcileBudget({
        reservation: quarantined.reservation,
        reservation_ref,
        operation_id: "op1",
        measurement: {
          ...measurement,
          submission: "never_submitted",
          disposition: "queue_expired",
          readings: [{ meter: "attempts", consumed: 0 }],
        },
        limits,
      })
    ).toThrow();
  });
});
