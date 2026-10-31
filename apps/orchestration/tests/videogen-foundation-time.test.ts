import { describe, expect, it } from "vitest";
import type { ArtifactRef } from "../dist/contracts.js";
import { sameRef } from "../dist/videogen/bounds.js";
import { checkRights, type RightsBindingV1 } from "../dist/videogen/rights-ledger.js";
import {
  addTime,
  compareTime,
  measuredDuration,
  quantizeBoundary,
  rationalTime,
  subtractTime,
  validateRationalRate,
  validateRationalTime,
} from "../dist/videogen/rational-time.js";
import {
  validateTimelineTiming,
  type TimelineTimingV1,
} from "../dist/videogen/timeline-validation.js";
import {
  validateShotMode,
  preflightShotMode,
  type ShotModeV1,
  type ShotCapabilityV1,
  type ShotPreflightHostV1,
  type ShotPortV1,
} from "../dist/videogen/shot-modes.js";
import {
  FoundationFixture,
  FOUNDATION_LIMITS as limits,
} from "./helpers/videogen-foundation-fixtures.js";
describe("WP005 exact rational seconds/rates", () => {
  it("reduces exact arithmetic and rejects semantic, JSON and 128/63-bit overflow", () => {
    expect(rationalTime(4n, 6n)).toEqual({ numerator: 2, denominator: 3 });
    expect(addTime({ numerator: 1, denominator: 3 }, { numerator: 1, denominator: 6 })).toEqual({
      numerator: 1,
      denominator: 2,
    });
    expect(
      subtractTime({ numerator: 1, denominator: 3 }, { numerator: 1, denominator: 2 })
    ).toEqual({ numerator: -1, denominator: 6 });
    expect(compareTime({ numerator: 1, denominator: 2 }, { numerator: 2, denominator: 3 })).toBe(
      -1
    );
    for (const bad of [
      { numerator: 2, denominator: 2 },
      { numerator: 1, denominator: 0 },
      { numerator: 0.5, denominator: 1 },
      { numerator: 1, denominator: 1, unit: "fps" },
    ])
      expect(() => validateRationalTime(bad)).toThrow();
    expect(() => validateRationalRate({ numerator: 0, denominator: 1 })).toThrow();
    expect(() => rationalTime(1n << 128n, 1n)).toThrow(/128-bit/);
    expect(() => rationalTime(1n << 62n, 1n)).toThrow(/63-bit/);
    expect(() => rationalTime(1n << 54n, 1n)).toThrow(/JSON/);
  });
  it("quantizes absolute positive/negative boundaries nearest ties-even; rates aren't seconds", () => {
    const rate = { numerator: 24, denominator: 1 };
    for (const [numerator, index] of [
      [1, 0],
      [3, 2],
      [5, 2],
      [-1, 0],
      [-3, -2],
      [-5, -2],
    ] as const)
      expect(quantizeBoundary(rationalTime(BigInt(numerator), 48n), rate, 100).index).toBe(index);
    expect(
      quantizeBoundary(
        { numerator: 1, denominator: 1 },
        { numerator: 24000, denominator: 1001 },
        100
      ).index
    ).toBe(24);
    expect(
      quantizeBoundary(
        { numerator: 1, denominator: 96000 },
        { numerator: 48000, denominator: 1 },
        100
      ).index
    ).toBe(0);
    expect(() => quantizeBoundary({ numerator: 5, denominator: 1 }, rate, 100)).toThrow(/cap/);
    expect(measuredDuration(32, { numerator: 1, denominator: 16 })).toEqual({
      numerator: 2,
      denominator: 1,
    });
  });
  it("many-shot absolute boundary differences prevent cumulative rounding drift", () => {
    using f = new FoundationFixture();
    const frames = 240;
    const v: TimelineTimingV1 = {
      schema_id: "penny.videogen-timeline-timing.v1",
      schema_version: 1,
      fps: { numerator: 24, denominator: 1 },
      sample_rate: { numerator: 48000, denominator: 1 },
      end_time: { numerator: 10, denominator: 1 },
      sources: [
        {
          source_id: "source",
          ref: f.opaque("source", "video/mp4"),
          measured_ticks: 160,
          timebase: { numerator: 1, denominator: 16 },
          decoded_duration: { numerator: 10, denominator: 1 },
          source_frame_rate: { numerator: 16, denominator: 1 },
        },
      ],
      items: Array.from({ length: frames }, (_, i) => ({
        kind: "clip",
        item_id: `item${i}`,
        track_id: "v1",
        source_id: "source",
        source_in: rationalTime(BigInt(i), 24n),
        source_out: rationalTime(BigInt(i + 1), 24n),
        timeline_start: rationalTime(BigInt(i), 24n),
        timeline_end: rationalTime(BigInt(i + 1), 24n),
      })),
    };
    const policy = {
      max_frames: 300,
      max_samples: 480000,
      max_duration: { numerator: 10, denominator: 1 },
      sync_tolerance: { numerator: 1, denominator: 48 },
    };
    const result = validateTimelineTiming(v, limits, policy);
    expect(result.total_frames).toBe(240);
    expect(result.total_samples).toBe(480000);
    expect(result.boundaries.reduce((n, x) => n + x.frame_out - x.frame_in, 0)).toBe(240);
    const first = v.items[0];
    if (first?.kind !== "clip") throw new Error("fixture clip missing");
    for (const bad of [
      {
        ...v,
        sources: v.sources.map((x) => ({
          ...x,
          decoded_duration: { numerator: 160, denominator: 24 },
        })),
      },
      {
        ...v,
        items: [{ ...first, source_out: { numerator: 11, denominator: 1 } }, ...v.items.slice(1)],
      },
      {
        ...v,
        items: [
          { ...first, timeline_start: { numerator: 1, denominator: 48 } },
          ...v.items.slice(1),
        ],
      },
      {
        ...v,
        items: [
          {
            ...first,
            timeline_end: { numerator: 1, denominator: 96 },
            source_out: { numerator: 1, denominator: 96 },
          },
          ...v.items.slice(1),
        ],
      },
      { ...v, items: [first, { ...first, track_id: "v2" }, ...v.items.slice(1)] },
    ])
      expect(() => validateTimelineTiming(bad, limits, policy)).toThrow();
    const gap: TimelineTimingV1 = {
      ...v,
      items: [
        {
          kind: "gap",
          item_id: "gap1",
          track_id: "v1",
          timeline_start: { numerator: 0, denominator: 1 },
          timeline_end: v.end_time,
        },
      ],
    };
    expect(validateTimelineTiming(gap, limits, policy).total_frames).toBe(240);
  });
});
function shotFixture(f: FoundationFixture, mode: ShotModeV1["mode"] = "t2v") {
  const profile = f.opaque("profile");
  const settings = f.opaque("settings");
  const output = f.opaque("output");
  const profileRights = f.rights(profile, "model");
  const common = {
    shot_id: "shot1",
    profile_snapshot_ref: profile,
    settings_ref: settings,
    rights_refs: [profileRights],
    prompt_ref: f.opaque("prompt"),
    expected_output_contract_ref: output,
    target: {
      width: 640,
      height: 360,
      frame_count: 48,
      fps: { numerator: 24, denominator: 1 },
      duration: { numerator: 2, denominator: 1 },
    },
  };
  const cap: ShotCapabilityV1 = {
    schema_id: "penny.videogen-shot-capability.v1",
    schema_version: 1,
    profile_snapshot_ref: profile,
    settings_ref: settings,
    expected_output_contract_ref: output,
    qualification_ref: f.opaque("fixture qualification"),
    mode,
    output_field: "images",
    max_width: 640,
    max_height: 360,
    max_frames: 48,
    max_duration: { numerator: 2, denominator: 1 },
    ports: [],
  };
  const host: ShotPreflightHostV1 = {
    ...f.host(),
    checkpointer: f.checkpointer,
    gate_host: {
      checkpointer: f.checkpointer,
      current_approvals: [],
      store: f.store,
      project_id: f.project_id,
      run_id: f.run_id,
      limits,
      admitted_destination_id: "local-output",
      current_presented: [],
    },
    current_capability: cap,
    supported_output_fields: ["images"],
  };
  return { common, cap, host };
}
describe("WP005 closed shot modes and registered ports", () => {
  it("preflights zero-port T2V but rejects arbitrary graphs, outputs and missing rights", () => {
    using f = new FoundationFixture();
    const { common, host } = shotFixture(f);
    const mode = { ...common, mode: "t2v" };
    expect(preflightShotMode({ host, mode, ports: [], output_field: "images" }).mode).toBe("t2v");
    for (const value of [
      { ...mode, graph: {} },
      { ...mode, mode: "other_registered" },
      { ...mode, first_png: f.opaque("image", "image/png") },
      { ...mode, target: { ...mode.target, frame_count: 47 } },
    ])
      expect(() => validateShotMode(value, limits)).toThrow();
    expect(() => preflightShotMode({ host, mode, ports: [], output_field: "videos" })).toThrow();
    expect(() =>
      preflightShotMode({
        host: { ...host, current_rights: [] },
        mode,
        ports: [],
        output_field: "images",
      })
    ).toThrow(/rights/);
  });
  it("preflights two distinct endpoint refs; rejects extra, swapped, oversized and aliased ports", () => {
    using f = new FoundationFixture();
    const { common, cap, host } = shotFixture(f, "flf2v");
    const first = f.opaque("first", "image/png");
    const last = f.opaque("last", "image/png");
    const rights = [f.rights(first), f.rights(last)];
    const mode = {
      ...common,
      rights_refs: [...common.rights_refs, ...rights],
      mode: "flf2v",
      first_png: first,
      last_png: last,
    };
    const ports: ShotPortV1[] = [
      {
        port_id: "first",
        semantic_role: "first_png",
        ref: first,
        byte_limit: 100,
        media_type: "image/png",
        mutation_node: "node1",
        mutation_input: "image",
        upload_operation_id: "upload1",
      },
      {
        port_id: "last",
        semantic_role: "last_png",
        ref: last,
        byte_limit: 100,
        media_type: "image/png",
        mutation_node: "node2",
        mutation_input: "image",
        upload_operation_id: "upload2",
      },
    ];
    const bound = {
      ...host,
      current_capability: {
        ...cap,
        ports: ports.map(({ ref: _ref, upload_operation_id: _op, ...p }) => p),
      },
    };
    expect(preflightShotMode({ host: bound, mode, ports, output_field: "images" }).mode).toBe(
      "flf2v"
    );
    for (const bad of [
      ports.slice(1),
      [...ports, ports[0]],
      ports.map((x) => ({ ...x, mutation_node: "same" })),
      ports.map((x) => ({ ...x, ref: x.port_id === "first" ? last : first })),
      ports.map((x) => ({ ...x, byte_limit: 1 })),
    ])
      expect(() =>
        preflightShotMode({ host: bound, mode, ports: bad, output_field: "images" })
      ).toThrow();
    expect(() => validateShotMode({ ...mode, last_png: first }, limits)).toThrow();
  });
  it("closes controlled/camera/speech/specialty shapes; no provisional sync or specialty escape", () => {
    using f = new FoundationFixture();
    const { common, host } = shotFixture(f, "speech_conditioned");
    const ref = f.opaque("input");
    const png = f.opaque("PNG", "image/png");
    const wav = f.opaque("WAV", "audio/wav");
    const values = [
      { ...common, mode: "i2v", first_png: png },
      { ...common, mode: "camera", basis_ref: png, trajectory_ref: ref },
      {
        ...common,
        mode: "controlled",
        basis_ref: png,
        controls: [
          { kind: "pose", media_ref: ref, frame_rate: common.target.fps, alignment_ref: ref },
        ],
      },
      {
        ...common,
        mode: "speech_conditioned",
        performance_audio_ref: wav,
        timing_ref: ref,
        look_inputs: [png],
        consent_ref: ref,
        sync_target: "mouth",
      },
      {
        ...common,
        mode: "specialty",
        specialty_kind: "animatediff",
        registered_schema_ref: ref,
        registered_profile_ref: ref,
        rights_ref: ref,
      },
    ];
    for (const value of values) expect(validateShotMode(value, limits).mode).toBe(value.mode);
    expect(() =>
      validateShotMode(
        {
          ...values[2],
          controls: [
            {
              kind: "performer",
              media_ref: ref,
              frame_rate: common.target.fps,
              alignment_ref: ref,
            },
          ],
        },
        limits
      )
    ).toThrow(/consent/);
    expect(() =>
      validateShotMode({ ...values[4], specialty_kind: "other_registered" }, limits)
    ).toThrow();
    // Even matching fixed ports cannot use guessed timing without current committed G2.
    const speech = values[3];
    if (speech === undefined) throw new Error("speech fixture missing");
    expect(() =>
      preflightShotMode({ host, mode: speech, ports: [], output_field: "images" })
    ).toThrow();
  });
});

type ControlledShotV1 = Extract<ShotModeV1, { mode: "controlled" }>;
const CONTROL_KINDS = ["pose", "depth", "edge", "line", "performer"] as const;
function controlledShotFixture(f: FoundationFixture) {
  const { common, cap, host } = shotFixture(f, "controlled");
  const basis = f.opaque("control basis", "image/png");
  const consent = f.opaque("current performer consent");
  const controls: ControlledShotV1["controls"] = CONTROL_KINDS.map((kind) => ({
    kind,
    media_ref: f.opaque(`${kind} control`, "video/mp4"),
    frame_rate: common.target.fps,
    alignment_ref: f.opaque(`${kind} alignment`),
    ...(kind === "performer" ? { consent_ref: consent } : {}),
  }));
  const mode: ControlledShotV1 = {
    ...common,
    mode: "controlled",
    basis_ref: basis,
    controls,
    rights_refs: [
      ...common.rights_refs,
      f.rights(basis),
      ...controls.map((control) =>
        f.rights(
          control.media_ref,
          control.kind === "performer" ? "performer" : "control",
          control.kind === "performer" ? [consent] : []
        )
      ),
    ],
  };
  // Fixture roles encode the registered interface, not a call to the production mapper.
  const ports: ShotPortV1[] = [
    { role: "basis", ref: basis },
    ...controls.map((control, index) => ({
      role: `control-${control.kind}-${index}`,
      ref: control.media_ref,
    })),
  ].map(({ role, ref }, index) => ({
    port_id: `port-${index}`,
    semantic_role: role,
    ref,
    media_type: ref.media_type,
    byte_limit: 10000,
    mutation_node: `node-${index}`,
    mutation_input: "media",
    upload_operation_id: `upload-${index}`,
  }));
  const performer = controls.find((control) => control.kind === "performer");
  if (performer === undefined) throw new Error("performer fixture missing");
  return {
    mode,
    ports,
    consent,
    performer,
    host: {
      ...host,
      current_capability: {
        ...cap,
        ports: ports.map(({ ref: _ref, upload_operation_id: _op, ...port }) => port),
      },
    },
  };
}
function replaceShotRights(
  f: FoundationFixture,
  fixture: { host: ShotPreflightHostV1; mode: ShotModeV1 },
  subject: ArtifactRef,
  patch: Partial<RightsBindingV1>
) {
  const current = fixture.host.current_rights.find((entry) => sameRef(entry.subject_ref, subject));
  if (current === undefined) throw new Error("current fixture rights missing");
  const binding = checkRights(fixture.host, subject, current.rights_ref, "motion");
  const replacement = { ...binding, revision: binding.revision + 1, ...patch };
  const rights_ref = f.json(replacement, replacement.schema_id);
  return {
    host: {
      ...fixture.host,
      current_rights: fixture.host.current_rights.map((entry) =>
        sameRef(entry.subject_ref, subject)
          ? { ...entry, rights_ref, revision: replacement.revision }
          : entry
      ),
    },
    mode: {
      ...fixture.mode,
      rights_refs: fixture.mode.rights_refs.map((ref) =>
        sameRef(ref, current.rights_ref) ? rights_ref : ref
      ),
    },
    rights_ref,
  };
}
function speechConsentFixture(f: FoundationFixture) {
  const { common, cap, host } = shotFixture(f, "speech_conditioned");
  const consent = f.opaque("current speech consent");
  const performance = f.opaque("speech fixture, not decoded audio", "audio/wav");
  const timing = f.opaque("timing fixture");
  const look = f.opaque("look fixture", "image/png");
  const mode: Extract<ShotModeV1, { mode: "speech_conditioned" }> = {
    ...common,
    mode: "speech_conditioned",
    performance_audio_ref: performance,
    timing_ref: timing,
    look_inputs: [look],
    consent_ref: consent,
    sync_target: "line1",
    rights_refs: [
      ...common.rights_refs,
      f.rights(performance, "voice", [consent]),
      f.rights(timing, "text"),
      f.rights(look),
    ],
  };
  const ports: ShotPortV1[] = [
    { role: "performance", ref: performance },
    { role: "timing", ref: timing },
    { role: "look-0", ref: look },
  ].map(({ role, ref }, index) => ({
    port_id: `port-${index}`,
    semantic_role: role,
    ref,
    media_type: ref.media_type,
    byte_limit: 10000,
    mutation_node: `node-${index}`,
    mutation_input: "media",
    upload_operation_id: `upload-${index}`,
  }));
  return {
    mode,
    ports,
    consent,
    performance,
    host: {
      ...host,
      current_capability: {
        ...cap,
        ports: ports.map(({ ref: _ref, upload_operation_id: _op, ...port }) => port),
      },
    },
  };
}
describe("WP005 control-kind and current consent authority regressions", () => {
  it("preflights every ordered control kind with exact current performer consent", () => {
    using f = new FoundationFixture();
    const { host, mode, ports } = controlledShotFixture(f);
    expect(preflightShotMode({ host, mode, ports, output_field: "images" })).toEqual(mode);
  });
  it.each(
    CONTROL_KINDS.flatMap((from, index) =>
      CONTROL_KINDS.filter((to) => to !== from).map((to) => ({ from, to, index }))
    )
  )("refuses $from → $to under the same registered port/profile", ({ to, index }) => {
    using f = new FoundationFixture();
    const { host, mode, ports, consent } = controlledShotFixture(f);
    const changed: ControlledShotV1 = {
      ...mode,
      controls: mode.controls.map((control, position) =>
        position === index ? { ...control, kind: to, consent_ref: consent } : control
      ),
    };
    expect(validateShotMode(changed, limits)).toEqual(changed);
    expect(() => preflightShotMode({ host, mode: changed, ports, output_field: "images" })).toThrow(
      /mode port binding/
    );
  });
  it.each([
    "control order",
    "control operands",
    "port order",
    "port roles",
    "port operands",
    "capability order",
    "generic roles",
    "missing control",
    "duplicate control",
    "missing port",
    "duplicate port",
  ])("refuses %s before admitting controlled motion", (change) => {
    using f = new FoundationFixture();
    const fixture = controlledShotFixture(f);
    let { host, mode, ports } = fixture;
    const pose = mode.controls[0];
    const depth = mode.controls[1];
    if (pose === undefined || depth === undefined) throw new Error("ordered fixture missing");
    switch (change) {
      case "control order":
        mode = { ...mode, controls: [...mode.controls].reverse() };
        break;
      case "control operands":
        mode = {
          ...mode,
          controls: mode.controls.map((control, index) =>
            index === 0
              ? { ...control, media_ref: depth.media_ref }
              : index === 1
                ? { ...control, media_ref: pose.media_ref }
                : control
          ),
        };
        break;
      case "port order":
        ports = [...ports].reverse();
        break;
      case "port roles":
        ports = ports.map((port, index) => ({
          ...port,
          semantic_role:
            index === 1 ? "control-depth-1" : index === 2 ? "control-pose-0" : port.semantic_role,
        }));
        break;
      case "port operands":
        ports = ports.map((port, index) => ({
          ...port,
          ref: index === 1 ? depth.media_ref : index === 2 ? pose.media_ref : port.ref,
        }));
        break;
      case "capability order":
        host = {
          ...host,
          current_capability: {
            ...host.current_capability,
            ports: [...host.current_capability.ports].reverse(),
          },
        };
        break;
      case "generic roles":
        ports = ports.map((port, index) => ({
          ...port,
          semantic_role: index === 0 ? "basis" : `control-${index - 1}`,
        }));
        host = {
          ...host,
          current_capability: {
            ...host.current_capability,
            ports: ports.map(({ ref: _ref, upload_operation_id: _op, ...port }) => port),
          },
        };
        break;
      case "missing control":
        mode = { ...mode, controls: mode.controls.slice(1) };
        break;
      case "duplicate control":
        mode = { ...mode, controls: [pose, pose, ...mode.controls.slice(2)] };
        break;
      case "missing port":
        ports = ports.slice(1);
        break;
      case "duplicate port": {
        const first = ports[0];
        if (first === undefined) throw new Error("basis port missing");
        ports = [first, first, ...ports.slice(2)];
        break;
      }
      default:
        throw new Error("unknown negative fixture");
    }
    expect(() => preflightShotMode({ host, mode, ports, output_field: "images" })).toThrow();
  });
  it("refuses unrelated readable consent cleared for another performer", () => {
    using f = new FoundationFixture();
    const { host, mode, ports } = controlledShotFixture(f);
    const unrelated = f.opaque("other performer consent");
    const other = f.opaque("other performer footage", "video/mp4");
    const otherRights = f.rights(other, "performer", [unrelated]);
    expect(checkRights(host, other, otherRights, "motion").consent_refs).toEqual([unrelated]);
    const changed = {
      ...mode,
      controls: mode.controls.map((control) =>
        control.kind === "performer" ? { ...control, consent_ref: unrelated } : control
      ),
    };
    expect(validateShotMode(changed, limits)).toEqual(changed);
    expect(() => preflightShotMode({ host, mode: changed, ports, output_field: "images" })).toThrow(
      /consent binding/
    );
  });
  it("requires the exact consent ref, not just the same ID or byte digest", () => {
    using f = new FoundationFixture();
    const { host, mode, ports, consent } = controlledShotFixture(f);
    const sameBytes = f.raw(f.store.read(consent));
    expect(sameBytes.content_digest).toBe(consent.content_digest);
    expect(sameRef(sameBytes, consent)).toBe(false);
    for (const ref of [sameBytes, { ...consent, version: consent.version + 1 }]) {
      const changed = {
        ...mode,
        controls: mode.controls.map((control) =>
          control.kind === "performer" ? { ...control, consent_ref: ref } : control
        ),
      };
      expect(() =>
        preflightShotMode({ host, mode: changed, ports, output_field: "images" })
      ).toThrow();
    }
  });
  it.each(["image", "video", "voice", "model", "text", "control"] as const)(
    "refuses current %s rights even when they contain the supplied performer consent",
    (subject_kind) => {
      using f = new FoundationFixture();
      const fixture = controlledShotFixture(f);
      const { host, mode, rights_ref } = replaceShotRights(
        f,
        fixture,
        fixture.performer.media_ref,
        { subject_kind }
      );
      expect(
        checkRights(host, fixture.performer.media_ref, rights_ref, "motion").subject_kind
      ).toBe(subject_kind);
      expect(() =>
        preflightShotMode({ host, mode, ports: fixture.ports, output_field: "images" })
      ).toThrow(/consent binding/);
    }
  );
  it.each(["revoked", "absent", "wrong revision"])(
    "refuses %s current performer clearance with unchanged media/consent bytes",
    (change) => {
      using f = new FoundationFixture();
      const { host, mode, ports, performer } = controlledShotFixture(f);
      expect(preflightShotMode({ host, mode, ports, output_field: "images" })).toEqual(mode);
      const current_rights = host.current_rights.flatMap((entry) => {
        if (!sameRef(entry.subject_ref, performer.media_ref)) return [entry];
        if (change === "absent") return [];
        return [
          {
            ...entry,
            status: change === "revoked" ? ("revoked" as const) : entry.status,
            revision: change === "wrong revision" ? entry.revision + 1 : entry.revision,
          },
        ];
      });
      expect(() =>
        preflightShotMode({
          host: { ...host, current_rights },
          mode,
          ports,
          output_field: "images",
        })
      ).toThrow(/rights/);
    }
  );
  it("refuses stale rights and removed consent, accepting only the exact replacement consent", () => {
    using f = new FoundationFixture();
    const fixture = controlledShotFixture(f);
    const consent = f.opaque("new current performer consent");
    const updated = replaceShotRights(f, fixture, fixture.performer.media_ref, {
      consent_refs: [consent],
    });
    expect(
      checkRights(updated.host, fixture.performer.media_ref, updated.rights_ref, "motion")
        .consent_refs
    ).toEqual([consent]);
    expect(() =>
      preflightShotMode({
        host: updated.host,
        mode: fixture.mode,
        ports: fixture.ports,
        output_field: "images",
      })
    ).toThrow(/rights/);
    expect(() =>
      preflightShotMode({
        host: updated.host,
        mode: updated.mode,
        ports: fixture.ports,
        output_field: "images",
      })
    ).toThrow(/consent binding/);
    const mode: ControlledShotV1 = {
      ...fixture.mode,
      rights_refs: updated.mode.rights_refs,
      controls: fixture.mode.controls.map((control) =>
        control.kind === "performer" ? { ...control, consent_ref: consent } : control
      ),
    };
    expect(
      preflightShotMode({ host: updated.host, mode, ports: fixture.ports, output_field: "images" })
    ).toEqual(mode);
  });
  it("refuses performer consent omitted from the request or current binding", () => {
    using f = new FoundationFixture();
    const fixture = controlledShotFixture(f);
    const mode = {
      ...fixture.mode,
      controls: fixture.mode.controls.map((control) => {
        const { consent_ref: _consent, ...withoutConsent } = control;
        return withoutConsent;
      }),
    };
    expect(() =>
      preflightShotMode({ host: fixture.host, mode, ports: fixture.ports, output_field: "images" })
    ).toThrow(/consent/);
    const updated = replaceShotRights(f, fixture, fixture.performer.media_ref, {
      consent_refs: [],
    });
    expect(() =>
      preflightShotMode({
        host: updated.host,
        mode: updated.mode,
        ports: fixture.ports,
        output_field: "images",
      })
    ).toThrow(/consent/);
  });
  it("requires the same exact current consent authority for speech without bypassing its G2 binding", () => {
    using f = new FoundationFixture();
    const fixture = speechConsentFixture(f);
    const { host, mode, ports } = fixture;
    // Current voice rights alone do not replace the existing committed G2 proof.
    expect(() => preflightShotMode({ host, mode, ports, output_field: "images" })).toThrow(/G2/);
    const unrelated = f.opaque("unrelated speech consent");
    expect(() =>
      preflightShotMode({
        host,
        mode: { ...mode, consent_ref: unrelated },
        ports,
        output_field: "images",
      })
    ).toThrow(/consent binding/);
    for (const subject_kind of [
      "performer",
      "image",
      "video",
      "model",
      "text",
      "control",
    ] as const) {
      const updated = replaceShotRights(f, fixture, fixture.performance, { subject_kind });
      expect(() =>
        preflightShotMode({ host: updated.host, mode: updated.mode, ports, output_field: "images" })
      ).toThrow(/consent binding/);
    }
    const updated = replaceShotRights(f, fixture, fixture.performance, {
      consent_refs: [unrelated],
    });
    expect(() =>
      preflightShotMode({ host: updated.host, mode: updated.mode, ports, output_field: "images" })
    ).toThrow(/consent binding/);
    expect(() =>
      preflightShotMode({
        host: {
          ...host,
          current_rights: host.current_rights.map((entry) =>
            sameRef(entry.subject_ref, fixture.performance)
              ? { ...entry, status: "revoked" }
              : entry
          ),
        },
        mode,
        ports,
        output_field: "images",
      })
    ).toThrow(/revoked/);
  });
});
