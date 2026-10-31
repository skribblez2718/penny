import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateSkillSchema, Sha256Schema } from "../skill-contracts/common.js";
export const NATIVE_VERBS = [
  "open_save_normalize",
  "close_reopen_readback",
  "relocate_reopen_readback",
  "render_compare",
] as const;
export type NativeVerb = (typeof NATIVE_VERBS)[number];
export const NativeVerbSchema = Type.Union([
  Type.Literal("open_save_normalize"),
  Type.Literal("close_reopen_readback"),
  Type.Literal("relocate_reopen_readback"),
  Type.Literal("render_compare"),
]);
const closed = { additionalProperties: false } as const;
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const NATIVE_DRIVER_PROTOCOL = "kdenlive-dbus-mlt-v1";
// Updated only with reviewed driver source; checked against packaged source in tests.
export const PACKAGED_NATIVE_DRIVER_SHA256 =
  "148f963b22e89c3eb16766abd14e3dab18c5e0116d4facbc32a06d5be862de21";
const ProcessSchema = Type.Object(
  {
    role: Type.Union([Type.Literal("editor"), Type.Literal("renderer")]),
    pid: positive,
    start_ticks: positive,
    cpu_ids: Type.Array(Type.Integer({ minimum: 0, maximum: 1048576 }), {
      minItems: 1,
      maxItems: 1,
    }),
    executable_sha256: Sha256Schema,
    argv: Type.Array(Type.String({ maxLength: 1024 }), { minItems: 1, maxItems: 64 }),
    namespaces: Type.Object(
      {
        pid: Type.String({ maxLength: 64 }),
        mnt: Type.String({ maxLength: 64 }),
        net: Type.String({ maxLength: 64 }),
      },
      closed
    ),
    plugins: Type.Array(
      Type.Object(
        { target: Type.String({ minLength: 1, maxLength: 1024 }), sha256: Sha256Schema },
        closed
      ),
      { minItems: 1, maxItems: 128 }
    ),
    exit_code: Type.Literal(0),
  },
  closed
);
export const NativePhaseHeaderSchema = Type.Object(
  {
    protocol: Type.Literal(NATIVE_DRIVER_PROTOCOL),
    nonce: Sha256Schema,
    verb: NativeVerbSchema,
    inputs_sha256: Sha256Schema,
    runtime_sha256: Sha256Schema,
    caption: Type.Union([
      Type.Null(),
      Type.Object(
        {
          relative_path: Type.String({ minLength: 1, maxLength: 512 }),
          sha256: Sha256Schema,
          sidecar_sha256: Sha256Schema,
        },
        closed
      ),
    ]),
    fonts: Type.Array(
      Type.Object(
        {
          relative_path: Type.String({ minLength: 1, maxLength: 512 }),
          sha256: Sha256Schema,
          family: Type.String({ pattern: "^[A-Za-z0-9 -]{1,64}$" }),
        },
        closed
      ),
      { maxItems: 1 }
    ),
    processes: Type.Array(ProcessSchema, { minItems: 1, maxItems: 2 }),
    actions: Type.Array(Type.String({ maxLength: 64 }), { minItems: 1, maxItems: 16 }),
    payload_sha256: Sha256Schema,
    payload_bytes: positive,
    control_sha256: Sha256Schema,
    control: Type.Array(
      Type.Object(
        {
          argv: Type.Array(Type.String({ maxLength: 1024 }), { minItems: 1, maxItems: 64 }),
          exit_code: Type.Integer({ minimum: -128, maximum: 255 }),
          stdout_sha256: Sha256Schema,
          stderr_sha256: Sha256Schema,
        },
        closed
      ),
      { minItems: 1, maxItems: 512 }
    ),
  },
  closed
);
export type NativePhaseHeader = Static<typeof NativePhaseHeaderSchema>;
export interface NativePhaseObservation {
  readonly header: NativePhaseHeader;
  readonly bytes: Buffer;
  readonly driver_sha256: string;
  readonly elapsed_ms: number;
}
export function nativeInputDigest(
  files: readonly { relative_path: string; bytes: Uint8Array }[]
): string {
  return sha256(
    canonicalJson(
      files.map((f) => ({
        relative_path: f.relative_path,
        sha256: sha256(f.bytes),
        bytes: f.bytes.byteLength,
      }))
    )
  );
}
export function decodeNativePhase(input: {
  readonly output: Buffer;
  readonly verb: NativeVerb;
  readonly nonce: string;
  readonly inputs_sha256: string;
  readonly runtime_sha256: string;
  readonly editor_sha256: string;
  readonly renderer_sha256: string;
  readonly files: readonly { relative_path: string; bytes: Uint8Array }[];
  readonly runtime_files: readonly { target: string; sha256: string }[];
}): { header: NativePhaseHeader; bytes: Buffer } {
  const o = input.output;
  if (o.length < 5) throw new Error("native phase: absent envelope");
  const length = o.readUInt32BE(0);
  if (length < 1 || length > 65536 || 4 + length >= o.length)
    throw new Error("native phase: header bound");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(o.subarray(4, 4 + length));
  const value: unknown = JSON.parse(text);
  const h = validateSkillSchema(NativePhaseHeaderSchema, value, "native phase");
  const bytes = o.subarray(4 + length);
  if (
    canonicalJson(h) !== text ||
    h.nonce !== input.nonce ||
    h.verb !== input.verb ||
    h.inputs_sha256 !== input.inputs_sha256 ||
    h.runtime_sha256 !== input.runtime_sha256 ||
    h.payload_bytes !== bytes.length ||
    h.payload_sha256 !== sha256(bytes) ||
    h.control_sha256 !== sha256(canonicalJson(h.control)) ||
    h.control.some((c) => !input.runtime_files.some((f) => f.target === c.argv[0]))
  )
    throw new Error("native phase: correlation/input/output drift");
  if (
    h.caption !== null &&
    (!input.files.some(
      (f) => f.relative_path === h.caption?.relative_path && sha256(f.bytes) === h.caption.sha256
    ) ||
      h.caption.sha256 !== h.caption.sidecar_sha256)
  )
    throw new Error("native phase: active caption binding drift");
  const fonts = input.files.filter((f) => /\.(?:ttf|otf)$/u.test(f.relative_path));
  if (
    fonts.length !== h.fonts.length ||
    h.fonts.some(
      (f) => !fonts.some((x) => x.relative_path === f.relative_path && sha256(x.bytes) === f.sha256)
    )
  )
    throw new Error("native phase: active font binding drift");
  const render = input.verb === "render_compare";
  const actions = render
    ? ["render_job_written", "renderer_observed", "renderer_exited", "render_readback"]
    : input.verb === "close_reopen_readback"
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
          input.verb === "relocate_reopen_readback" ? "original_unavailable" : "input_copied",
          "editor_opened",
          "save_as",
          "editor_exited",
          "saved_readback",
        ];
  if (
    canonicalJson(h.actions) !== canonicalJson(actions) ||
    h.processes.length !== (input.verb === "close_reopen_readback" ? 2 : 1)
  )
    throw new Error("native phase: missing/reordered actual actions");
  for (const p of h.processes) {
    if (
      new Set(p.plugins.map((x) => x.target)).size !== p.plugins.length ||
      p.plugins.some(
        (x) => !input.runtime_files.some((f) => f.target === x.target && f.sha256 === x.sha256)
      )
    )
      throw new Error("native phase: unpinned loaded plugin");
    if (
      p.role !== (render ? "renderer" : "editor") ||
      p.executable_sha256 !== (render ? input.renderer_sha256 : input.editor_sha256) ||
      !input.runtime_files.some(
        (f) => f.target === p.argv[0] && f.sha256 === p.executable_sha256
      ) ||
      Object.entries(p.namespaces).some(([k, n]) => !new RegExp(`^${k}:\\[[0-9]+\\]$`, "u").test(n))
    )
      throw new Error("native phase: runtime/process identity drift");
  }
  if (new Set(h.processes.map((p) => `${p.pid}:${p.start_ticks}`)).size !== h.processes.length)
    throw new Error("native phase: reused process");
  return { header: h, bytes };
}
