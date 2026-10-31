import { randomBytes } from "node:crypto";
import { readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { Type } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateSkillSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  ManagedLeaseClient,
  publishManagedLeaseFile,
} from "../host-operations/managed-lease-client.js";
import { HostOperationCapacityAuthority } from "../host-operations/capacity-authority.js";
import {
  nativeFileSha256,
  observeNativeProcess,
  parseLinuxProcessStat,
} from "../host-operations/native-process.js";
import type { HostOperationExecutionContextV1 } from "../host-operations/contracts.js";
import { parseVoiceWireJson } from "./voice-json.js";
import {
  VoicePeer,
  VoicePrivateClient,
  VoicePrivateBindingSchema,
  type VoicePrivateBinding,
  type VoicePrivateCommand,
} from "./voice-private-client.js";
const Check = Type.Object(
  {
    schema_version: Type.Literal(1),
    challenge: Sha256Schema,
    seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false }
);
/** One actual Voice control lease backs every CLOSED publication. Loss is latched, never
 * translated into drain. The existing catalog/journal owns all resource and request authority. */
export class VoiceManagedRelay {
  readonly binding: VoicePrivateBinding;
  readonly #lease: ManagedLeaseClient;
  #client: VoicePrivateClient | undefined;
  #checker: VoicePeer | undefined;
  #fault: Error | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #context: HostOperationExecutionContextV1 | undefined;
  #validate: (() => void) | undefined;
  #active = false;
  #approved: { source_text: string; voice_id: string } | undefined;
  #narration: string | undefined;
  #job: string | undefined;
  #counterStart = 0;
  #lastTransfer = 0;
  #closed = false;
  #preparation = false;
  #preloaded = false;
  readonly overhead = { bytes: 0 };
  constructor(
    binding: VoicePrivateBinding,
    readonly authority: HostOperationCapacityAuthority,
    readonly backend: string
  ) {
    this.binding = structuredClone(
      validateSkillSchema(VoicePrivateBindingSchema, binding, "voice managed relay")
    );
    if (
      !(authority instanceof HostOperationCapacityAuthority) ||
      binding.transfer_counter_file.split("{operation_record_id}").length !== 2
    )
      throw new Error("voice relay requires exact catalog/transfer binding");
    this.#lease = new ManagedLeaseClient(authority, {
      worker_id: binding.worker.worker_id,
      process_epoch: observeNativeProcess(binding.worker.process, nativeFileSha256).process_epoch,
    });
  }
  private total(): number {
    const a = this.#client?.peer.bytes,
      b = this.#checker?.bytes;
    return (a?.sent ?? 0) + (a?.received ?? 0) + (b?.sent ?? 0) + (b?.received ?? 0);
  }
  private healthy(): VoicePrivateClient {
    if (this.#fault || this.#closed || !this.#client)
      throw this.#fault ?? new Error("voice relay not acquired");
    observeNativeProcess(this.binding.worker.process, nativeFileSha256);
    return this.#client;
  }
  private latch(error: unknown): void {
    this.#fault = error instanceof Error ? error : new Error("voice relay failed");
    if (this.#timer) clearTimeout(this.#timer);
    // Invalidate even idle CLOSED before disconnect permits manual admission.
    try {
      unlinkSync(this.binding.worker.state_file);
    } catch {
      /* Missing cannot qualify. */
    }
    // Never leave()/publish CLOSED on failure: the Python engine may still be computing.
    this.#client?.close();
    this.#checker?.close();
  }
  async acquire(): Promise<void> {
    if (this.#client) {
      this.healthy();
      return;
    }
    try {
      this.#client = await VoicePrivateClient.connect(this.binding, this.backend);
      if (2 * this.binding.refresh_ms >= this.#client.hello.lease_idle_ms)
        throw new Error("voice refresh must be below half the observed lease idle limit");
      const ack = await this.#client.command({
        op: "acquire",
        owner_id: `penny-${process.pid}`,
        backend_binding_id: this.backend,
      });
      if (ack.kind !== "ack") throw new Error("voice acquisition not acknowledged");
      this.#checker = new VoicePeer(this.binding, "listen");
      const ready: unknown = parseVoiceWireJson(await this.#checker.next());
      if (canonicalJson(ready) !== '{"ready":true}') throw new Error("voice checker did not bind");
      const pid = this.#checker.child.pid;
      if (!pid) throw new Error("voice checker PID missing");
      const executable = readlinkSync(`/proc/${pid}/exe`);
      const pin = {
        pid,
        boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        start_ticks: parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8")).start_ticks,
        executable: { path: executable, sha256: nativeFileSha256(executable) },
        cwd: readlinkSync(`/proc/${pid}/cwd`),
      };
      observeNativeProcess(pin, nativeFileSha256);
      const challenge = randomBytes(32).toString("hex");
      void this.checkLoop(challenge);
      const bound = await this.#client.command({
        op: "bind_capacity",
        socket_path: this.binding.checker_socket_path,
        process: pin,
        challenge,
      });
      if (bound.kind !== "ack") throw new Error("voice capacity checker not bound");
      await this.closedState();
      this.refresh();
    } catch (error) {
      this.latch(error);
      throw error;
    }
  }
  private async checkLoop(challenge: string): Promise<void> {
    let seq = 0;
    try {
      const checker = this.#checker;
      if (!checker) throw new Error("voice checker absent");
      while (!this.#closed) {
        const frame = await checker.next(0);
        if (frame.length === 0) continue; // actual response-byte acknowledgement
        const check = validateSkillSchema(
          Check,
          parseVoiceWireJson(frame),
          "voice engine capacity check"
        );
        if (check.challenge !== challenge || check.seq !== ++seq)
          throw new Error("voice capacity callback replay");
        let allowed = false;
        try {
          this.requireCurrent();
          allowed = true;
        } catch {
          /* Denial stops next entry; never claims opaque compute stopped. */
        }
        checker.send({ schema_version: 1, challenge, seq, allowed });
        this.flushTransfer();
      }
    } catch (error) {
      if (!this.#closed) this.latch(error);
    }
  }
  private refresh(): void {
    this.#timer = setTimeout(() => {
      void (async () => {
        try {
          const c = this.healthy();
          await c.command({ op: "renew" });
          if (this.#active) {
            this.requireCurrent();
            this.publish();
          } else await this.closedState();
          this.flushTransfer();
          this.refresh();
        } catch (error) {
          this.latch(error);
        }
      })();
    }, this.binding.refresh_ms);
    this.#timer.unref();
  }
  private publish(): void {
    publishManagedLeaseFile(
      this.binding.worker.state_file,
      this.#lease.state({
        gate_build_sha256: this.binding.worker.gate_build.sha256,
        observed_at_ms: Date.now(),
      })
    );
  }
  async closedState(): Promise<void> {
    const s = await this.healthy().snapshot();
    if (
      s.admission.mode !== "host_exclusive" ||
      s.admission.backend_binding_id !== this.backend ||
      s.admission.active_unmanaged_calls !== 0 ||
      s.admission.active_job_ids.length
    )
      throw new Error("voice exclusive drain not proven");
    if (this.#active) {
      this.#lease.leave();
      this.#active = false;
    }
    this.publish();
  }
  /** Called by the owner after its real hold, before the native baseline. */
  async prepare(
    context: HostOperationExecutionContextV1,
    validate: () => void,
    approved?: { source_text: string; voice_id: string }
  ): Promise<void> {
    await this.acquire();
    if (this.#active || !["lease_acquired", "fetched"].includes(context.journal.lifecycle))
      throw new Error("voice relay cannot adopt unknown remote work");
    validate();
    this.#context = context;
    this.#validate = validate;
    this.#approved = approved === undefined ? undefined : structuredClone(approved);
    this.#preparation = approved === undefined;
    this.#preloaded = false;
    this.#narration = undefined;
    this.#job = undefined;
    await this.closedState();
    this.overhead.bytes += this.total() - this.#counterStart;
    this.#counterStart = this.total();
    this.#lastTransfer = 0;
    this.flushTransfer();
  }
  /** Synchronous owned preload cannot share its socket with renewals. Reject a window that
   * could outlive the observed service lease; timeout/disconnect is never drain proof. */
  requirePreparationWindow(timeout_ms: number): void {
    if (timeout_ms + 2 * this.binding.refresh_ms >= this.healthy().hello.lease_idle_ms)
      throw new Error("voice preload window exceeds renewable control lease");
  }
  async preload(timeout_ms: number): Promise<void> {
    if (!this.#preparation || this.#preloaded)
      throw new Error("voice preparation not selected/replay");
    this.requirePreparationWindow(timeout_ms);
    this.requireCurrent();
    this.#preloaded = true; // a lost/failed reply must never permit a second preload
    const reply = await this.healthy().command({ op: "preload" }, timeout_ms);
    this.flushTransfer();
    if (reply.kind !== "ack") throw new Error("voice preload acknowledgement missing");
  }
  enter(context: HostOperationExecutionContextV1): void {
    if (context !== this.#context || context.journal.lifecycle !== "submitting")
      throw new Error("voice relay exact submitting context required");
    this.#validate?.();
    this.#lease.enter(this.binding.worker.grant_file, sha256(context.request_bytes));
    this.#active = true;
    this.publish();
    this.flushTransfer();
  }
  requireCurrent(): void {
    this.healthy();
    if (!this.#active || !this.#context || !this.#validate)
      throw new Error("voice compute gate closed");
    this.#validate();
    this.#lease.requireCurrent();
  }
  private async command(command: VoicePrivateCommand) {
    this.requireCurrent();
    const reply = await this.healthy().command(command);
    this.flushTransfer();
    return reply;
  }
  /** Exact payload projection is supplied only by the compiled adapter after current approval. */
  async create(source_text: string, voice_id: string) {
    if (
      source_text !== this.#approved?.source_text ||
      voice_id !== this.#approved.voice_id ||
      this.#narration
    )
      throw new Error("voice approved text/voice drift or duplicate create");
    const result = await this.command({ op: "create_narration", source_text, voice_id });
    if (result.kind !== "created") throw new Error("voice create reply mismatch");
    if (
      result.narration.source_text !== source_text ||
      result.narration.voice_profile_id !== voice_id
    )
      throw new Error("voice created payload drift");
    this.#narration = result.narration.id;
    return result.narration;
  }
  async generate(narration_item_id: string, voice_id: string) {
    if (narration_item_id !== this.#narration || voice_id !== this.#approved?.voice_id || this.#job)
      throw new Error("voice approved generation drift");
    const result = await this.command({ op: "generate", narration_item_id, voice_id });
    if (result.kind !== "accepted" || result.narration_item_id !== narration_item_id)
      throw new Error("voice generate reply mismatch");
    this.#job = result.job_id;
    return {
      job_id: result.job_id,
      narration_item_id: result.narration_item_id,
      status: result.status,
    };
  }
  async cancel(job_id: string): Promise<void> {
    if (job_id !== this.#job) throw new Error("voice cancel job mismatch");
    await this.command({ op: "cancel", job_id });
  }
  async drain(): Promise<void> {
    await this.closedState();
    this.flushTransfer();
  }
  countHttp(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("voice HTTP meter overflow");
    if (!this.#context) {
      this.overhead.bytes += bytes;
      return;
    }
    this.#lastTransfer += bytes;
    try {
      this.flushTransfer();
    } catch (error) {
      this.latch(error);
      throw error;
    }
  }
  flushTransfer(): void {
    const ctx = this.#context;
    if (!ctx) return;
    const held = this.authority.inspect(ctx.journal.operation_record_id);
    if (held?.state === "settled") {
      this.#counterStart = this.total();
      this.#context = undefined;
      return;
    }
    if (!held || held.state !== "held") throw new Error("voice transfer current hold missing");
    const egress_bytes = this.total() - this.#counterStart + this.#lastTransfer;
    publishManagedLeaseFile(
      this.binding.transfer_counter_file.replace(
        "{operation_record_id}",
        ctx.journal.operation_record_id
      ),
      {
        schema_id: "penny.native-transfer-counter.v1",
        schema_version: 1,
        operation_record_id: ctx.journal.operation_record_id,
        operation_request_sha256: sha256(ctx.request_bytes),
        capacity_request_sha256: sha256(canonicalJson(held.request)),
        lease: held.lease,
        egress_bytes,
      }
    );
  }
  /** Invalidates the export before disconnect. A bound Voice owner faults closed; not stop proof. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    try {
      unlinkSync(this.binding.worker.state_file);
    } catch {
      /* Absence/staleness cannot qualify. */
    }
    this.#client?.close();
    this.#checker?.close();
  }
}
