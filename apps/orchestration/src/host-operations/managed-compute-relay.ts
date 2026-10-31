import type { HostOperationExecutionContextV1 } from "./contracts.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import {
  validateVideoGenerationOperationRequest,
  validateVideoSubmittedGraph,
} from "../videogen/contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { ManagedLeaseClient, publishManagedLeaseFile } from "./managed-lease-client.js";
import { HostOperationCapacityAuthority } from "./capacity-authority.js";
import { nativeFileSha256, observeNativeProcess, type NativeProcessPin } from "./native-process.js";

const closed = { additionalProperties: false } as const;
const amount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullable = Type.Union([Type.String(), Type.Null()]);
const ObservationSchema = Type.Object(
  {
    mode: Type.Union([
      Type.Literal("manual"),
      Type.Literal("draining"),
      Type.Literal("closed"),
      Type.Literal("executing"),
    ]),
    sequence: amount,
    active_calls: amount,
    grant_sha256: nullable,
    prompt_id: nullable,
    graph_sha256: nullable,
    terminal: Type.Boolean(),
    uncertain: Type.Boolean(),
    ipc_tx_bytes: amount,
    ipc_rx_bytes: amount,
    http_tx_bytes: amount,
    http_rx_bytes: amount,
    observed_at_ms: amount,
  },
  closed
);
export type ManagedComputeObservation = Static<typeof ObservationSchema>;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("relay frame object required");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("relay frame string required");
  return value;
}

export function managedComputePackageSha256(helperPath: string): string {
  if (
    basename(helperPath) !== "peer_transport.py" ||
    basename(dirname(helperPath)) !== "penny_compute_gate"
  )
    throw new Error("private transport package location invalid");
  const root = dirname(helperPath);
  const files = readdirSync(root)
    .filter((name) => name.endsWith(".py"))
    .sort();
  return sha256(
    canonicalJson(
      Object.fromEntries(files.map((name) => [name, nativeFileSha256(join(root, name))]))
    )
  );
}

/** Host-only transport into the actual service gate. This class never opens a second
 * catalog, installs policy, issues grants, submits public HTTP graphs or authorizes a PID.
 * Its helper only supplies kernel peer identity and transports bounded private frames. */
export class ManagedComputeRelay {
  readonly #client: ManagedLeaseClient;
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    string,
    { resolve: (o: ManagedComputeObservation) => void; reject: (e: Error) => void }
  >();
  #buffer = Buffer.alloc(0);
  #failed: Error | undefined;
  #nativePeer = false;
  #claimed = false;
  #challenge: string | undefined;
  #helloResolve: (() => void) | undefined;
  #helloReject: ((error: Error) => void) | undefined;
  readonly #hello: Promise<void>;
  #graphSha: string | undefined;
  #operationId: string | undefined;
  #promptId: string | undefined;
  #httpSent = 0;
  #httpReceived = 0;
  #httpOutstanding = 0;
  #inactivity: NodeJS.Timeout | undefined;
  #context: HostOperationExecutionContextV1 | undefined;
  #ipc = 0;
  #window = false;
  #closed = false;
  #refresh: NodeJS.Timeout | undefined;
  #commandTail: Promise<void> = Promise.resolve();
  #scheduled = 0;

  constructor(
    readonly options: {
      readonly authority: HostOperationCapacityAuthority;
      readonly worker_id: string;
      readonly backend: NativeProcessPin;
      readonly backend_uid: number;
      readonly gate_build_sha256: string;
      readonly socket_path: string;
      readonly python: { readonly path: string; readonly sha256: string };
      readonly helper: {
        readonly path: string;
        readonly sha256: string;
        readonly package_sha256: string;
      };
      readonly refresh_ms?: number;
      readonly state_file: string;
      readonly counter_file: string;
    }
  ) {
    if (
      !(options.authority instanceof HostOperationCapacityAuthority) ||
      options.counter_file.split("{operation_record_id}").length !== 2
    )
      throw new Error("relay requires current global catalog authority and exact counter binding");
    const observed = observeNativeProcess(options.backend, nativeFileSha256);
    if (
      nativeFileSha256(options.python.path) !== options.python.sha256 ||
      nativeFileSha256(options.helper.path) !== options.helper.sha256 ||
      managedComputePackageSha256(options.helper.path) !== options.helper.package_sha256
    )
      throw new Error("private relay helper build drift");
    this.#client = new ManagedLeaseClient(options.authority, {
      worker_id: options.worker_id,
      process_epoch: observed.process_epoch,
    });
    this.#hello = new Promise((resolve, reject) => {
      this.#helloResolve = resolve;
      this.#helloReject = reject;
    });
    // Run the helper as a package; its sibling package files are pinned by the
    // installed gate build. No shell, env credentials, service launch or server.
    this.#process = spawn(
      options.python.path,
      [
        "-I",
        "-B",
        "-c",
        "import sys,runpy;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('penny_compute_gate.peer_transport',run_name='__main__')",
        dirname(dirname(options.helper.path)),
        "--socket",
        options.socket_path,
        "--peer-uid",
        String(options.backend_uid),
        "--peer-pid",
        String(options.backend.pid),
        "--peer-start-ticks",
        options.backend.start_ticks,
      ],
      { stdio: "pipe" }
    );
    void this.#hello.catch(() => undefined);
    this.renewInactivity();
    this.#process.stdout.on("data", (chunk: Buffer) => {
      try {
        this.receive(chunk);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("relay invalid frame"));
      }
    });
    this.#process.stderr.on("data", () => {
      /* Never echo service paths or payloads into model logs. */
    });
    this.#refresh = setInterval(() => {
      if (!this.#closed || this.#scheduled || this.#failed) return;
      void (async () => {
        try {
          if (this.#window) await this.sample();
          else this.publish(await this.command("status"));
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error("managed refresh failed"));
        }
      })();
    }, options.refresh_ms ?? 2000);
    this.#refresh.unref();
    this.#process.on("error", (error) => this.fail(error));
    this.#process.on("exit", () =>
      this.fail(new Error("private gate disconnected; owned work requires drain proof"))
    );
  }
  private renewInactivity(): void {
    clearTimeout(this.#inactivity);
    this.#inactivity = setTimeout(
      () => this.fail(new Error("private gate transport inactive")),
      10000
    );
    this.#inactivity.unref();
  }
  private fail(error: Error): void {
    clearTimeout(this.#inactivity);
    clearInterval(this.#refresh);
    this.#failed ??= error;
    try {
      this.invalidateState();
    } catch {
      // Missing or unsafe exports cannot qualify in the native registry.
    }
    this.#helloReject?.(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#process.stdin.end();
  }
  private send(value: unknown): void {
    if (this.#failed) throw this.#failed;
    const bytes = Buffer.from(canonicalJson(value) + "\n");
    if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("relay frame byte limit");
    this.#process.stdin.write(bytes);
  }
  private receive(chunk: Buffer): void {
    this.renewInactivity();
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.byteLength > 4 * 1024 * 1024) throw new Error("relay frame byte limit");
    let end: number;
    while ((end = this.#buffer.indexOf(10)) >= 0) {
      const value: unknown = JSON.parse(this.#buffer.subarray(0, end).toString("utf8"));
      this.#buffer = this.#buffer.subarray(end + 1);
      this.frame(object(value));
    }
  }
  private frame(frame: Record<string, unknown>): void {
    const type = frame["type"];
    if (type === "native_peer") {
      if (this.#nativePeer) throw new Error("duplicate native peer");
      const credentials = object(frame["credentials"]),
        identity = object(frame["identity"]);
      if (
        credentials["pid"] !== this.options.backend.pid ||
        credentials["uid"] !== this.options.backend_uid ||
        identity["process_epoch"] !==
          observeNativeProcess(this.options.backend, nativeFileSha256).process_epoch
      )
        throw new Error("kernel peer epoch mismatch");
      this.#nativePeer = true;
    } else if (type === "hello") {
      if (
        !this.#nativePeer ||
        this.#challenge ||
        frame["protocol"] !== "penny.compute-gate.v1" ||
        frame["gate_build_sha256"] !== this.options.gate_build_sha256
      )
        throw new Error("gate protocol/build mismatch");
      const service = object(frame["service"]);
      if (
        service["process_epoch"] !==
          observeNativeProcess(this.options.backend, nativeFileSha256).process_epoch ||
        service["worker_id"] !== this.options.worker_id
      )
        throw new Error("gate process/worker mismatch");
      this.#challenge = randomBytes(32).toString("hex");
      this.send({
        type: "claim",
        challenge: string(frame["challenge"]),
        owner_challenge: this.#challenge,
      });
    } else if (type === "claimed") {
      if (!this.#challenge || this.#claimed || frame["owner_challenge"] !== this.#challenge)
        throw new Error("owner connection challenge mismatch");
      this.#claimed = true;
      this.#helloResolve?.();
    } else if (type === "check") {
      if (!this.#claimed) throw new Error("check before owner claim");
      let digest: string | null = null;
      try {
        const grant = this.#client.requireCurrent();
        const current = sha256(canonicalJson(grant));
        if (current === frame["grant_sha256"]) digest = current;
      } catch {
        /* Explicit denial: no cached permit and no lease extension. */
      }
      this.send({ type: "current", id: string(frame["id"]), grant_sha256: digest });
    } else if (type === "result") {
      const id = string(frame["id"]),
        pending = this.#pending.get(id);
      if (!pending) throw new Error("late/replayed command response");
      this.#pending.delete(id);
      if (frame["ok"] !== true) {
        pending.reject(new Error("actual service gate refused"));
        return;
      }
      pending.resolve(
        validateSkillSchema(
          ObservationSchema,
          frame["observation"],
          "actual managed gate observation"
        )
      );
    } else throw new Error("unknown relay frame");
  }
  private async command(
    op: string,
    fields: Readonly<Record<string, string>> = {}
  ): Promise<ManagedComputeObservation> {
    if (++this.#scheduled > 16) {
      this.#scheduled--;
      throw new Error("managed command queue limit");
    }
    const result = this.#commandTail.then(async () => await this.exchange(op, fields));
    this.#commandTail = result.then(
      () => undefined,
      () => undefined
    );
    try {
      return await result;
    } finally {
      this.#scheduled--;
    }
  }
  private async exchange(
    op: string,
    fields: Readonly<Record<string, string>>
  ): Promise<ManagedComputeObservation> {
    await this.#hello;
    if (this.#pending.size) throw new Error("concurrent gate command");
    const id = randomUUID();
    return await new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.send({ type: "command", id, op, ...fields });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("relay write failed"));
      }
    });
  }
  private publish(observation: ManagedComputeObservation): void {
    const state = this.#client.state({
      gate_build_sha256: this.options.gate_build_sha256,
      observed_at_ms: observation.observed_at_ms,
    });
    if (
      observation.uncertain ||
      observation.sequence !== state.sequence ||
      observation.mode !== state.state.kind ||
      (observation.mode === "closed" && observation.active_calls !== 0) ||
      observation.grant_sha256 !== state.state.grant_sha256
    )
      throw new Error("actual gate/client state mismatch; cannot publish closed");
    publishManagedLeaseFile(this.options.state_file, state);
  }
  private invalidateState(): void {
    const stat = lstatSync(this.options.state_file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("unsafe managed state target");
    unlinkSync(this.options.state_file);
  }
  /** Close and drain BEFORE native baseline/admission. Manual/initial state is never exported CLOSED. */
  async close(): Promise<void> {
    this.publish(await this.command("close"));
    this.#closed = true;
  }
  /** Real held operation baseline before readiness HTTP or guarded grant issuance. */
  async prepare(context: HostOperationExecutionContextV1): Promise<void> {
    if (context.journal.lifecycle !== "lease_acquired")
      throw new Error("managed recovery requires independent drain/reconciliation");
    await this.close();
    this.#context = context;
    this.#operationId = context.journal.operation_record_id;
    this.#httpSent = this.#httpReceived = this.#ipc = 0;
    this.publishCounter();
  }
  private counterIdentity() {
    if (!this.#context) return this.#client.meterIdentity();
    const j = this.#context.journal;
    const held = this.options.authority.inspect(j.operation_record_id);
    if (!held || held.state !== "held" || canonicalJson(held.lease) !== canonicalJson(j.lease))
      throw new Error("managed transfer current hold/fence absent");
    this.options.authority.requireHeld(j.operation_record_id, held.revision);
    return {
      operation_record_id: j.operation_record_id,
      operation_request_sha256: j.request_sha256,
      capacity_request_sha256: sha256(canonicalJson(held.request)),
      lease: held.lease,
    };
  }
  private publishCounter(): void {
    const identity = this.counterIdentity();
    publishManagedLeaseFile(
      this.options.counter_file.replaceAll("{operation_record_id}", identity.operation_record_id),
      {
        schema_id: "penny.native-transfer-counter.v1",
        schema_version: 1,
        ...identity,
        egress_bytes: this.#ipc + this.#httpSent + this.#httpReceived,
      }
    );
  }
  /** Host passes the exact prepared artifact graph bytes, not a public caller's digest.
   * The domain adapter must first run its existing prepared-graph/profile checks. */
  async open(input: {
    readonly grant_file: string;
    readonly operation_request_bytes: Uint8Array;
    readonly submitted_graph_bytes: Uint8Array;
  }): Promise<string> {
    const requestText = new TextDecoder("utf-8", { fatal: true }).decode(
      input.operation_request_bytes
    );
    const artifactText = new TextDecoder("utf-8", { fatal: true }).decode(
      input.submitted_graph_bytes
    );
    const rawRequest: unknown = JSON.parse(requestText),
      rawArtifact: unknown = JSON.parse(artifactText);
    const request = validateVideoGenerationOperationRequest(rawRequest);
    const artifact = validateVideoSubmittedGraph(rawArtifact);
    if (
      canonicalJson(rawRequest) !== requestText ||
      canonicalJson(rawArtifact) !== artifactText ||
      sha256(input.submitted_graph_bytes) !== request.submitted_graph_sha256 ||
      request.submitted_graph_ref.content_digest !== request.submitted_graph_sha256 ||
      request.submitted_graph_ref.byte_length !== input.submitted_graph_bytes.byteLength ||
      request.submitted_graph_ref.content_schema?.schema_id !== "penny.video-submitted-graph.v1" ||
      request.profile_sha256 !== artifact.profile_sha256 ||
      request.profile_id !== artifact.profile_id ||
      request.run_id !== artifact.run_id ||
      request.shot_id !== artifact.shot_id ||
      request.mode !== artifact.mode ||
      request.frame_count !== artifact.frame_count ||
      request.fps !== artifact.fps ||
      canonicalJson(request.dimensions) !== canonicalJson(artifact.dimensions) ||
      canonicalJson(request.profile_snapshot_ref) !== canonicalJson(artifact.profile_snapshot_ref)
    )
      throw new Error("exact prepared request/artifact binding conflict");
    const graphJson = canonicalJson(artifact.graph);
    this.invalidateState();
    if (!this.#context) this.#httpSent = this.#httpReceived = 0;
    const grant = this.#client.enter(input.grant_file, sha256(input.operation_request_bytes));
    this.#window = true;
    this.#operationId = grant.operation_record_id;
    this.#graphSha = sha256(graphJson);
    this.#promptId = randomUUID();
    const observation = await this.command("open", {
      grant_json: canonicalJson(grant),
      graph_json: graphJson,
      prompt_id: this.#promptId,
    });
    this.assertJob(observation);
    this.publish(observation);
    this.exportCounter(observation);
    return this.#promptId;
  }
  private assertJob(observation: ManagedComputeObservation): void {
    if (observation.prompt_id !== this.#promptId || observation.graph_sha256 !== this.#graphSha)
      throw new Error("owned job/graph correlation mismatch");
  }
  async submit(): Promise<void> {
    const o = await this.command("submit");
    this.assertJob(o);
    this.exportCounter(o);
  }
  async cancelOwned(): Promise<void> {
    const o = await this.command("cancel");
    this.assertJob(o);
    this.exportCounter(o);
  }
  async sample(): Promise<ManagedComputeObservation> {
    const o = await this.command("status");
    this.assertJob(o);
    this.publish(o);
    this.exportCounter(o);
    return o;
  }
  beginSocket(): (bytesWritten: number, bytesRead: number) => void {
    this.counterIdentity();
    this.#httpOutstanding += 1;
    let completed = false;
    return (written, read) => {
      if (completed) {
        this.fail(new Error("duplicate HTTP socket meter"));
        return;
      }
      completed = true;
      this.#httpOutstanding -= 1;
      try {
        this.recordHttpSocket(written, read);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("HTTP meter failed"));
      }
    };
  }
  /** Accepts actual one-use HTTP socket counters; never inferred body sizes. */
  recordHttpSocket(bytesWritten: number, bytesRead: number): void {
    this.counterIdentity();
    for (const n of [bytesWritten, bytesRead])
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("HTTP wire counter invalid");
    this.#httpSent += bytesWritten;
    this.#httpReceived += bytesRead;
    this.publishCounter();
  }
  private exportCounter(observation: ManagedComputeObservation): void {
    this.#ipc = observation.ipc_tx_bytes + observation.ipc_rx_bytes;
    this.publishCounter();
  }

  async finish(): Promise<void> {
    if (this.#httpOutstanding) throw new Error("HTTP sockets not drained");
    const before = await this.command("status");
    this.assertJob(before);
    this.exportCounter(before);
    const drained = await this.command("finish");
    // The service result includes its own exact AF_UNIX response bytes.
    this.exportCounter(drained);
    this.#client.leave();
    this.#window = false;
    this.publish(drained);
  }
  /** Safety-only cleanup remains available after compute authority expires.
   * Invalidate the old cumulative counter so missing final accounting cannot
   * masquerade as a complete settlement. No new execution authority is granted. */
  async drainOwned(): Promise<ManagedComputeObservation> {
    if (!this.#operationId) throw new Error("no adopted owned window");
    const counter = this.options.counter_file.replaceAll(
      "{operation_record_id}",
      this.#operationId
    );
    if (existsSync(counter)) {
      const stat = lstatSync(counter);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error("unsafe cleanup meter target");
      unlinkSync(counter);
    }
    await this.command("cancel");
    const drained = await this.command("finish");
    this.#client.leave();
    this.#window = false;
    this.publish(drained);
    return drained;
  }
  async reopenManual(): Promise<void> {
    this.#closed = false;
    this.invalidateState();
    await this.command("manual");
  }
  disconnect(): void {
    clearTimeout(this.#inactivity);
    clearInterval(this.#refresh);
    this.#process.stdin.end();
  }
}
