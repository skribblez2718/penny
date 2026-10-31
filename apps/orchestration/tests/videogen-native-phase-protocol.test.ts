import { RunnerFixture, NATIVE_TEST_POLICY } from "./helpers/videogen-native-runner.js";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import {
  ConfinedNativeBindingsSchema,
  ConfinedNativeRunner,
} from "../dist/host-operations/confined-native-runner.js";
import {
  decodeNativePhase,
  nativeInputDigest,
  NATIVE_DRIVER_PROTOCOL,
  PACKAGED_NATIVE_DRIVER_SHA256,
  type NativePhaseHeader,
  type NativeVerb,
} from "../dist/videogen/native-phase-protocol.js";

const nonce = sha256("invocation"),
  editor = sha256("editor"),
  renderer = sha256("renderer"),
  runtime = sha256("runtime");
const files = [
  {
    relative_path: "project.kdenlive",
    bytes: Buffer.from("synthetic parser fixture, not native evidence"),
  },
  { relative_path: "captions.ass", bytes: Buffer.from("synthetic ASS") },
  { relative_path: "fonts/active.ttf", bytes: Buffer.from("synthetic font") },
];
const runtimeFiles = [
  { target: "/tools/editor", sha256: editor },
  { target: "/tools/renderer", sha256: renderer },
  { target: "/tools/gdbus", sha256: sha256("bus tool") },
  { target: "/plugins/xml.so", sha256: sha256("plugin") },
];
function header(verb: NativeVerb = "open_save_normalize"): NativePhaseHeader {
  const render = verb === "render_compare";
  const control = [
    {
      argv: ["/tools/gdbus", "introspect"],
      exit_code: 0,
      stdout_sha256: sha256("synthetic control output"),
      stderr_sha256: sha256(""),
    },
  ];
  const process = {
    role: render ? ("renderer" as const) : ("editor" as const),
    pid: 12,
    start_ticks: 100,
    cpu_ids: [2],
    executable_sha256: render ? renderer : editor,
    argv: [render ? "/tools/renderer" : "/tools/editor"],
    namespaces: { pid: "pid:[123]", mnt: "mnt:[234]", net: "net:[345]" },
    plugins: [{ target: "/plugins/xml.so", sha256: sha256("plugin") }],
    exit_code: 0 as const,
  };
  return {
    protocol: NATIVE_DRIVER_PROTOCOL,
    nonce,
    verb,
    inputs_sha256: nativeInputDigest(files),
    runtime_sha256: runtime,
    caption: {
      relative_path: "captions.ass",
      sha256: sha256("synthetic ASS"),
      sidecar_sha256: sha256("synthetic ASS"),
    },
    fonts: [
      {
        relative_path: "fonts/active.ttf",
        sha256: sha256("synthetic font"),
        family: "Synthetic Font",
      },
    ],
    processes:
      verb === "close_reopen_readback"
        ? [process, { ...process, pid: 13, start_ticks: 101 }]
        : [process],
    actions: render
      ? ["render_job_written", "renderer_observed", "renderer_exited", "render_readback"]
      : verb === "close_reopen_readback"
        ? [
            "editor_opened",
            "save_as",
            "editor_exited",
            "editor_opened",
            "save_as",
            "editor_exited",
            "saved_readback",
          ]
        : [
            verb === "relocate_reopen_readback" ? "original_unavailable" : "input_copied",
            "editor_opened",
            "save_as",
            "editor_exited",
            "saved_readback",
          ],
    payload_sha256: sha256("payload"),
    payload_bytes: 7,
    control,
    control_sha256: sha256(canonicalJson(control)),
  };
}
function envelope(value: unknown, text?: string): Buffer {
  const encoded = Buffer.from(text ?? canonicalJson(value));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  return Buffer.concat([length, encoded, Buffer.from("payload")]);
}
function decode(value: unknown, verb: NativeVerb = "open_save_normalize", text?: string) {
  return decodeNativePhase({
    output: envelope(value, text),
    verb,
    nonce,
    inputs_sha256: nativeInputDigest(files),
    runtime_sha256: runtime,
    editor_sha256: editor,
    renderer_sha256: renderer,
    files,
    runtime_files: runtimeFiles,
  });
}

describe("native phase wire parsing (synthetic parser fixtures never qualify a native result)", () => {
  it("binds the packaged and built runtime to the reviewed generic driver source", () =>
    expect(
      sha256(readFileSync(new URL("../src/videogen/kdenlive-driver.py", import.meta.url)))
    ).toBe(PACKAGED_NATIVE_DRIVER_SHA256));
  it.each([
    "open_save_normalize",
    "close_reopen_readback",
    "relocate_reopen_readback",
    "render_compare",
  ] as const)("accepts a correlated closed %s envelope but cannot brand it", (verb) => {
    const parsed = decode(header(verb), verb);
    expect(parsed.bytes.toString()).toBe("payload");
    expect(ConfinedNativeRunner.isObserved(parsed)).toBe(false);
    expect(ConfinedNativeRunner.isTrusted({ supportsPhaseEvidence: true })).toBe(false);
  });
  it.each([
    "nonce",
    "inputs_sha256",
    "runtime_sha256",
    "payload_sha256",
    "control_sha256",
  ] as const)("rejects %s drift", (field) =>
    expect(() => decode({ ...header(), [field]: sha256("drift") })).toThrow()
  );
  it("rejects alternate verb, byte length, unknown PASS and canonical/duplicate JSON changes", () => {
    const h = header();
    for (const bad of [
      { ...h, verb: "render_compare" },
      { ...h, payload_bytes: 6 },
      { ...h, qualified: true },
    ])
      expect(() => decode(bad)).toThrow();
    expect(() => decode(h, undefined, JSON.stringify(h, null, 2))).toThrow();
    expect(() =>
      decode(h, undefined, canonicalJson(h).replace('"nonce":', `"nonce":"${nonce}","nonce":`))
    ).toThrow();
  });
  it("rejects absent, truncated and oversized envelopes", () => {
    const input = {
      verb: "render_compare" as const,
      nonce,
      inputs_sha256: "",
      runtime_sha256: runtime,
      editor_sha256: editor,
      renderer_sha256: renderer,
      files,
      runtime_files: runtimeFiles,
    };
    for (const output of [
      Buffer.alloc(0),
      Buffer.alloc(4),
      Buffer.from([0, 1, 0, 1, 123]),
      envelope(header()).subarray(0, 32),
    ])
      expect(() => decodeNativePhase({ ...input, output })).toThrow();
  });
  it("rejects missing/reordered actions, nonexistent executables, empty/unpinned plugins and malformed namespaces", () => {
    const h = header(),
      p = h.processes[0];
    if (!p) throw new Error("process fixture missing");
    for (const bad of [
      { ...h, actions: h.actions.slice(1) },
      { ...h, actions: [...h.actions].reverse() },
      { ...h, processes: [{ ...p, role: "renderer" }] },
      { ...h, processes: [{ ...p, exit_code: 1 }] },
      { ...h, processes: [{ ...p, argv: ["/unbound/editor"] }] },
      { ...h, processes: [{ ...p, executable_sha256: renderer }] },
      { ...h, processes: [{ ...p, plugins: [] }] },
      {
        ...h,
        processes: [
          { ...p, plugins: [{ target: "/unbound/plugin.so", sha256: sha256("plugin") }] },
        ],
      },
      { ...h, processes: [{ ...p, plugins: [...p.plugins, ...p.plugins] }] },
      { ...h, processes: [{ ...p, namespaces: { ...p.namespaces, pid: "host" } }] },
      { ...h, processes: [{ ...p, cpu_ids: [2, 3] }] },
    ])
      expect(() => decode(bad)).toThrow();
  });
  it("rejects the same process reused for close/reopen", () => {
    const h = header("close_reopen_readback"),
      p = h.processes[0];
    if (!p) throw new Error("process fixture missing");
    expect(() => decode({ ...h, processes: [p, p] }, "close_reopen_readback")).toThrow(/reused/);
  });
  it("rejects caption changes, fallback fonts and unpinned control tools", () => {
    const h = header(),
      c = h.control[0];
    if (!c) throw new Error("control fixture missing");
    const control = [{ ...c, argv: ["/unbound/tool"] }];
    for (const bad of [
      { ...h, caption: { ...h.caption, sidecar_sha256: sha256("changed caption") } },
      { ...h, fonts: [] },
      {
        ...h,
        fonts: [
          {
            relative_path: "fonts/fallback.ttf",
            sha256: sha256("synthetic font"),
            family: "Fallback",
          },
        ],
      },
      { ...h, control, control_sha256: sha256(canonicalJson(control)) },
    ])
      expect(() => decode(bad)).toThrow();
  });
  it("refuses live byte-only static fixture drivers at the observation boundary", async () => {
    using fixture = new RunnerFixture();
    expect(fixture.runner.supportsPhaseEvidence).toBe(false);
    await expect(
      fixture.runner.runObserved({
        verb: "render_compare",
        files: [{ relative_path: "project.kdenlive", bytes: Buffer.from("fixture") }],
        policy: NATIVE_TEST_POLICY,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/packaged phase evidence/);
  });
  it("makes evidence-mode bindings closed: no callback, approval list or positive flag", () => {
    const pin = { source: "/unused", target: "/runtime/driver", sha256: sha256("pin") };
    const b = {
      prlimit: { path: "/unused", sha256: pin.sha256 },
      unshare: { path: "/unused", sha256: pin.sha256 },
      mount: { path: "/unused", sha256: pin.sha256 },
      shell: { path: "/unused", sha256: pin.sha256 },
      bubblewrap: { path: "/unused", sha256: pin.sha256 },
      max_runtime_bytes: 1,
      driver: pin,
      runtime_files: [],
      scratch_root: "/unused",
      evidence_protocol: {
        protocol: NATIVE_DRIVER_PROTOCOL,
        editor_target: "/tools/editor",
        renderer_target: "/tools/renderer",
      },
    };
    expect(() =>
      validateSkillSchema(ConfinedNativeBindingsSchema, b, "parser fixture")
    ).not.toThrow();
    for (const bad of [
      { ...b, approval_indices: [0, 1, 2, 3] },
      { ...b, qualify: () => true },
      { ...b, evidence_protocol: { ...b.evidence_protocol, passed: true } },
    ])
      expect(() =>
        validateSkillSchema(ConfinedNativeBindingsSchema, bad, "parser fixture")
      ).toThrow();
  });
});
