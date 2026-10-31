import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { canonicalJson } from "../canonical-json.js";
import { Sha256Schema, OpaqueIdSchema, validateSkillSchema } from "../skill-contracts/common.js";
import { ManagedWorkerPinSchema } from "../host-operations/native-capacity-contracts.js";
import {
  NativeProcessPinSchema,
  nativeFileSha256,
  observeNativeProcess,
} from "../host-operations/native-process.js";
import { parseVoiceWireJson } from "./voice-json.js";
import { VoiceHostServiceObservationSchema, VoiceHostFilePinSchema } from "./voice-host-process.js";
import { VoiceStudioNarrationV1Schema } from "./voice-studio-contracts.js";
const closed = { additionalProperties: false } as const;
const filename = Type.String({ minLength: 1, maxLength: 4096 });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const VoicePrivateBindingSchema = Type.Object(
  {
    socket_path: filename,
    checker_socket_path: filename,
    python: VoiceHostFilePinSchema,
    helper_sha256: Sha256Schema,
    worker: ManagedWorkerPinSchema,
    transfer_counter_file: filename,
    refresh_ms: Type.Integer({ minimum: 100, maximum: 1000 }),
  },
  closed
);
export type VoicePrivateBinding = Static<typeof VoicePrivateBindingSchema>;
export const VoicePrivateObservationSchema = Type.Object(
  {
    ...VoiceHostServiceObservationSchema.properties,
    // Drain/bootstrap observations must remain readable BEFORE real CUDA residency exists.
    gpu_uuids: Type.Array(OpaqueIdSchema, { maxItems: 16, uniqueItems: true }),
  },
  closed
);
const Hello = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("hello"),
    process_epoch: Sha256Schema,
    challenge: Sha256Schema,
    pid: NativeProcessPinSchema.properties.pid,
    boot_id: NativeProcessPinSchema.properties.boot_id,
    start_ticks: NativeProcessPinSchema.properties.start_ticks,
    executable: VoiceHostFilePinSchema,
    backend_binding_id: OpaqueIdSchema,
    lease_idle_ms: Type.Integer({ minimum: 1000, maximum: 300000 }),
  },
  closed
);
export const VoicePrivateCommandSchema = Type.Union([
  Type.Object(
    { op: Type.Literal("acquire"), owner_id: OpaqueIdSchema, backend_binding_id: OpaqueIdSchema },
    closed
  ),
  Type.Object(
    {
      op: Type.Literal("bind_capacity"),
      socket_path: filename,
      process: NativeProcessPinSchema,
      challenge: Sha256Schema,
    },
    closed
  ),
  Type.Object(
    { op: Type.Union([Type.Literal("renew"), Type.Literal("snapshot"), Type.Literal("release")]) },
    closed
  ),
  Type.Object(
    {
      op: Type.Literal("create_narration"),
      source_text: Type.String({ minLength: 1, maxLength: 500000 }),
      voice_id: Type.String({ pattern: "^[a-f0-9]{12}$" }),
    },
    closed
  ),
  Type.Object(
    {
      op: Type.Literal("generate"),
      narration_item_id: OpaqueIdSchema,
      voice_id: Type.String({ pattern: "^[a-f0-9]{12}$" }),
    },
    closed
  ),
  Type.Object({ op: Type.Literal("cancel"), job_id: OpaqueIdSchema }, closed),
  Type.Object({ op: Type.Literal("preload") }, closed),
]);
export type VoicePrivateCommand = Static<typeof VoicePrivateCommandSchema>;
const Reply = Type.Union([
  Type.Object(
    {
      schema_version: Type.Literal(1),
      kind: Type.Literal("ack"),
      seq: count,
      op: Type.String({
        enum: ["acquire", "bind_capacity", "renew", "release", "cancel", "preload"],
      }),
    },
    closed
  ),
  Type.Object(
    {
      schema_version: Type.Literal(1),
      kind: Type.Literal("created"),
      seq: count,
      narration: VoiceStudioNarrationV1Schema,
    },
    closed
  ),
  Type.Object(
    {
      schema_version: Type.Literal(1),
      kind: Type.Literal("accepted"),
      seq: count,
      job_id: OpaqueIdSchema,
      narration_item_id: OpaqueIdSchema,
      status: OpaqueIdSchema,
    },
    closed
  ),
  Type.Object(
    {
      schema_version: Type.Literal(1),
      kind: Type.Literal("observation"),
      seq: count,
      observation: VoicePrivateObservationSchema,
    },
    closed
  ),
  Type.Object(
    {
      schema_version: Type.Literal(1),
      kind: Type.Literal("error"),
      seq: count,
      code: Type.String({
        enum: ["invalid_request", "busy", "not_owner", "identity_drift", "operation_failed"],
      }),
    },
    closed
  ),
]);
const Packet = Type.Object(
  { frame: Type.String({ maxLength: 24_000_000 }), received: count, sent: count },
  closed
);
/** Fixed compiled helper, not an arbitrary module/command selected by configuration. */
export const voicePeerHelperPath = fileURLToPath(
  new URL("./voice-private-peer.py", import.meta.url)
);
export class VoicePeer {
  readonly child: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #frames: Buffer[] = [];
  #pending:
    | {
        resolve: (value: Buffer) => void;
        reject: (reason: Error) => void;
        timer: ReturnType<typeof setTimeout> | undefined;
      }
    | undefined;
  #error: Error | undefined;
  readonly bytes = { sent: 0, received: 0 };
  constructor(
    readonly binding: VoicePrivateBinding,
    mode: "connect" | "listen"
  ) {
    if (
      nativeFileSha256(binding.python.path) !== binding.python.sha256 ||
      nativeFileSha256(voicePeerHelperPath) !== binding.helper_sha256
    )
      throw new Error("voice private helper pin drift");
    const pin = binding.worker.process;
    observeNativeProcess(pin, nativeFileSha256);
    this.child = spawn(
      binding.python.path,
      [
        "-I",
        "-u",
        voicePeerHelperPath,
        mode,
        mode === "connect" ? binding.socket_path : binding.checker_socket_path,
        String(pin.pid),
      ],
      {
        shell: false,
        env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const fail = (): void => {
      this.#error = new Error("voice private peer disconnected");
      if (this.#pending) {
        clearTimeout(this.#pending.timer);
        this.#pending.reject(this.#error);
        this.#pending = undefined;
      }
    };
    this.child.on("error", fail);
    this.child.on("exit", fail);
    this.child.stdin.on("error", fail);
    this.child.stdout.on("error", fail);
    this.child.stderr.on("error", fail);
    this.child.stderr.on("data", () => {
      /* No raw helper diagnostics/transcripts cross the owner boundary. */
    });
    this.child.stdout.on("data", (bytes: Buffer) => {
      try {
        this.#buffer = Buffer.concat([this.#buffer, bytes]);
        if (this.#buffer.length > 24_000_256) throw new Error("voice peer frame limit");
        let index: number;
        while ((index = this.#buffer.indexOf(10)) >= 0) {
          const packet = validateSkillSchema(
            Packet,
            parseVoiceWireJson(this.#buffer.subarray(0, index)),
            "voice peer packet"
          );
          this.#buffer = this.#buffer.subarray(index + 1);
          const frame = Buffer.from(packet.frame, "base64");
          if (
            frame.toString("base64") !== packet.frame ||
            frame.length !== packet.received ||
            frame.length > 16777216
          )
            throw new Error("voice peer frame mismatch");
          this.bytes.sent += packet.sent;
          this.bytes.received += packet.received;
          if (!Number.isSafeInteger(this.bytes.sent + this.bytes.received))
            throw new Error("voice peer counter overflow");
          if (this.#pending) {
            clearTimeout(this.#pending.timer);
            this.#pending.resolve(frame);
            this.#pending = undefined;
          } else {
            if (this.#frames.length >= 8) throw new Error("voice peer queue limit");
            this.#frames.push(frame);
          }
        }
      } catch {
        fail();
        this.child.kill();
      }
    });
  }
  next(timeout = 10000): Promise<Buffer> {
    if (this.#error) return Promise.reject(this.#error);
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve(frame);
    if (this.#pending) return Promise.reject(new Error("voice peer concurrent read"));
    return new Promise((resolve, reject) => {
      const timer =
        timeout === 0
          ? undefined
          : setTimeout(() => {
              this.#pending = undefined;
              this.#error = new Error("voice peer inactivity");
              this.child.kill();
              reject(this.#error);
            }, timeout);
      this.#pending = { resolve, reject, timer };
    });
  }
  send(value: unknown): void {
    const frame = Buffer.from(canonicalJson(value) + "\n");
    if (this.#error || frame.length > 2097152 || !this.child.stdin.writable)
      throw new Error("voice peer unavailable/limit");
    this.child.stdin.write(frame);
  }
  close(): void {
    this.child.stdin.end();
    // EOF lets the fixed listener unlink its own socket; never remove a foreign/stale path.
    const cleanup = setTimeout(() => this.child.kill(), 1000);
    cleanup.unref();
    this.child.once("exit", () => clearTimeout(cleanup));
  }
}
export class VoicePrivateClient {
  readonly peer: VoicePeer;
  readonly hello: Static<typeof Hello>;
  #seq = 0;
  #tail: Promise<unknown> = Promise.resolve();
  private constructor(peer: VoicePeer, hello: Static<typeof Hello>) {
    this.peer = peer;
    this.hello = hello;
  }
  static async connect(binding: VoicePrivateBinding, backend: string): Promise<VoicePrivateClient> {
    const peer = new VoicePeer(binding, "connect");
    try {
      const hello = validateSkillSchema(
        Hello,
        parseVoiceWireJson(await peer.next()),
        "voice private hello"
      );
      const actual = observeNativeProcess(binding.worker.process, nativeFileSha256);
      const pin = binding.worker.process;
      if (
        hello.pid !== pin.pid ||
        hello.boot_id !== pin.boot_id ||
        hello.start_ticks !== pin.start_ticks ||
        canonicalJson(hello.executable) !== canonicalJson(pin.executable) ||
        hello.process_epoch !== actual.process_epoch ||
        hello.backend_binding_id !== backend
      )
        throw new Error("voice private hello/native process mismatch");
      return new VoicePrivateClient(peer, hello);
    } catch (error) {
      peer.close();
      throw error;
    }
  }
  command(command: VoicePrivateCommand, timeout_ms = 10000) {
    if (!Number.isSafeInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 1800000)
      throw new Error("voice private command timeout bound");
    const run = async () => {
      validateSkillSchema(VoicePrivateCommandSchema, command, "voice private command");
      observeNativeProcess(this.peer.binding.worker.process, nativeFileSha256);
      const seq = ++this.#seq;
      this.peer.send({
        schema_version: 1,
        process_epoch: this.hello.process_epoch,
        challenge: this.hello.challenge,
        seq,
        command,
      });
      const reply = validateSkillSchema(
        Reply,
        parseVoiceWireJson(await this.peer.next(timeout_ms)),
        "voice private reply"
      );
      if (reply.seq !== seq || (reply.kind === "ack" && reply.op !== command.op))
        throw new Error("voice private sequence/op mismatch");
      if (reply.kind === "error") throw new Error(`voice private command refused: ${reply.code}`);
      return reply;
    };
    const result = this.#tail.then(run);
    this.#tail = result.catch(() => undefined);
    return result;
  }
  async snapshot() {
    const reply = await this.command({ op: "snapshot" });
    if (
      reply.kind !== "observation" ||
      reply.observation.process_epoch !== this.hello.process_epoch
    )
      throw new Error("voice snapshot identity");
    return reply.observation;
  }
  close(): void {
    this.peer.close();
  }
}
