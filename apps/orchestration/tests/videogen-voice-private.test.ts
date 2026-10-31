import { describe, expect, it } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { X509Certificate } from "node:crypto";
import { Type } from "typebox";
import { sha256 } from "../dist/canonical-json.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import {
  VoicePrivateClient,
  VoicePrivateObservationSchema,
  voicePeerHelperPath,
  type VoicePrivateBinding,
} from "../dist/videogen/voice-private-client.js";
import { VoiceStudioTransport } from "../dist/videogen/voice-studio-transport.js";
import { VoiceStudioJobV1Schema } from "../dist/videogen/voice-studio-contracts.js";
import { NativeCapacityMeter } from "../dist/host-operations/native-capacity.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
} from "../dist/host-operations/capacity-authority.js";
import { ManagedWorkerStateSchema } from "../dist/host-operations/native-capacity-contracts.js";
import { nativeFileSha256, observeNativeProcess } from "../dist/host-operations/native-process.js";
import { nativeCapacityFixture, nativeProcessPin } from "./helpers/native-capacity-fixture.js";
import { syntheticCapacityAdapter } from "./helpers/capacity-runtime-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";
import { readNativeObservationFile } from "../dist/host-operations/native-host-observation.js";

const source = process.env.PENNY_VOICE_FAKE_SOURCE_ROOT;
const python = process.env.PENNY_VOICE_FAKE_PYTHON;
const Limits = {
  max_json_bytes: 65536,
  max_wav_bytes: 1048576,
  max_sample_bytes: 1048576,
  max_request_bytes: 65536,
  max_text_bytes: 10000,
  max_chunks: 8,
  connect_ms: 2000,
  silence_ms: 5000,
  poll_ms: 10,
  cancel_observations: 4,
};
/** Explicit source/interpreter inputs are private environment only. This fixture never imports
 * real engines or uses the operator database/cert/control config. Fake remains unqualified. */
async function app(mode = "normal") {
  const root = mkdtempSync(path.join(tmpdir(), "penny-vipc-"));
  chmodSync(root, 0o700);
  const p = requireValue(python, "explicit fake Python");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(root, "key.pem"),
      "-out",
      path.join(root, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" }
  );
  const script = realpathSync(new URL("./fixtures/voice-private-fake-app.py", import.meta.url));
  const child = spawn(
    p,
    [
      "-u",
      "-c",
      "import runpy,sys; p=sys.argv.pop(1); runpy.run_path(p,run_name='__main__')",
      script,
      root,
      mode,
    ],
    {
      cwd: requireValue(source, "explicit fake source"),
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: root },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  let errors = "";
  child.stderr.on("data", (b: Buffer) => {
    errors = (errors + b.toString()).slice(-8192);
  });
  try {
    const ready = await new Promise<{ pid: number; port: number }>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(
        () => reject(new Error("fake app bootstrap inactivity: " + errors)),
        20000
      );
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("fake app exited: " + errors));
      });
      child.stdout.on("data", (b: Buffer) => {
        text += b.toString();
        if (text.length > 65536) {
          clearTimeout(timer);
          reject(new Error("fake app stdout limit"));
          return;
        }
        if (!text.endsWith("\n")) return;
        try {
          const v = validateSkillSchema(
            Type.Object(
              { pid: Type.Integer(), port: Type.Integer() },
              { additionalProperties: false }
            ),
            JSON.parse(text),
            "fake app ready"
          );
          clearTimeout(timer);
          resolve(v);
        } catch {
          /* await complete frame */
        }
      });
    });
    const pin = nativeProcessPin(ready.pid);
    const cert = readFileSync(path.join(root, "cert.pem"), "utf8");
    return {
      root,
      pin,
      p,
      errors: () => errors,
      transport: {
        mode: "trusted_tls" as const,
        origin: `https://127.0.0.1:${ready.port}`,
        servername: "localhost",
        ca_pem: cert,
        peer_cert_sha256: sha256(new X509Certificate(cert).raw),
      },
      close: async () => {
        if (child.exitCode === null) {
          child.stdin.end("stop\n");
          await once(child, "exit");
        }
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function managed(a: Awaited<ReturnType<typeof app>>) {
  const n = nativeCapacityFixture();
  const gate = path.join(requireValue(source, "source"), "api/services/voice_control.py");
  const binding: VoicePrivateBinding = {
    socket_path: path.join(a.root, "voice.sock"),
    checker_socket_path: path.join(a.root, "check.sock"),
    python: { path: realpathSync(a.p), sha256: nativeFileSha256(realpathSync(a.p)) },
    helper_sha256: nativeFileSha256(voicePeerHelperPath),
    worker: {
      worker_id: "worker-a",
      process: a.pin,
      gate_build: { path: gate, sha256: nativeFileSha256(gate) },
      state_file: path.join(a.root, "gate.json"),
      grant_file: path.join(a.root, "grant.json"),
      max_age_ms: 10000,
    },
    transfer_counter_file: path.join(a.root, "transfer-{operation_record_id}.json"),
    refresh_ms: 100,
  };
  n.config.workers.push(binding.worker);
  const meter = requireValue(
    n.config.meters.find((m) => m.binding_id === "video-a"),
    "meter"
  );
  meter.network = { counter_file: binding.transfer_counter_file };
  for (const m of n.config.meters) {
    if (
      !n.f.policy.bindings.some(
        (b) => b.binding_id === m.binding_id && b.worker_id === binding.worker.worker_id
      )
    )
      continue;
    m.network = { counter_file: binding.transfer_counter_file };
    requireValue(m.resources[0], "resource").sources.push("transfer_bytes");
  }
  const sourceMeter = new NativeCapacityMeter(n.config, n.f.policy, undefined, {
    cpu: () => ({
      boot_id: n.pin.boot_id,
      process_epoch: n.epoch,
      cgroup_identity: "controlled:1",
      cpu_usage_usec: n.counters.usec.toString(),
      monotonic_ns: n.counters.ns.toString(),
    }),
  });
  sourceMeter.registerVoice(binding, "fixture-service");
  n.f.capacity.close();
  n.f.project = new HostCapacityProjectAuthority(
    n.f.config.projectId,
    n.f.checkpointer,
    n.f.artifacts,
    sourceMeter
  );
  n.f.capacity = new HostOperationCapacityAuthority({
    stateRoot: n.f.config.stateRoot,
    policy: n.f.policy,
    projects: [n.f.project],
  });
  const original = n.f.demands;
  n.f.demands = {
    requestFor: (ctx) => {
      const r = original.requestFor(ctx);
      for (const d of r.demands) d.meters.egress_bytes = 200000;
      return r;
    },
  };
  sourceMeter.bind(n.f.capacity);
  const relay = sourceMeter.voiceRelay(binding.worker.worker_id);
  return { ...n, source: sourceMeter, relay, binding };
}

describe.skipIf(!source || !python)(
  "actual isolated Fake Voice ASGI/IPC → real Node catalog/owner/client → TLS job readback (NOT residency qualification)",
  () => {
    it("cold private preload calls actual fake engine.load only after the held submission guard; counters and epoch survive settlement", async () => {
      const a = await app("preload"),
        n = managed(a);
      using f = n.f;
      try {
        const directive = f.prepare("actual-owned-preload"),
          base = syntheticCapacityAdapter(() => undefined, f.counter);
        const adapter = {
          ...base,
          prepare: async (ctx: Parameters<typeof base.run>[0]) => {
            expect(f.capacity.inspect(ctx.journal.operation_record_id)?.state).toBe("held");
            await n.relay.prepare(ctx, () => undefined);
            expect(
              validateSkillSchema(
                VoicePrivateObservationSchema,
                readNativeObservationFile(path.join(a.root, "observation.json"), 16777216),
                "cold"
              ).models_loaded
            ).toBe(false);
            expect(existsSync(path.join(a.root, "preload-called"))).toBe(false);
          },
          run: async (ctx: Parameters<typeof base.run>[0]) => {
            ctx.beginSubmission();
            n.relay.enter(ctx);
            await n.relay.preload(5000);
            ctx.recordRemoteAccepted("actual-fake-preload");
            await n.relay.drain();
            const s = validateSkillSchema(
              VoicePrivateObservationSchema,
              readNativeObservationFile(path.join(a.root, "observation.json"), 16777216),
              "loaded"
            );
            expect(s.models_loaded).toBe(true);
            expect(s.model_identity_verified).toBe(false); // FAKE must never qualify
            expect(s.process_epoch).toBe(
              observeNativeProcess(n.binding.worker.process, nativeFileSha256).process_epoch
            );
            expect(existsSync(path.join(a.root, "preload-called"))).toBe(true);
            n.counters.usec += 1000n;
            n.counters.ns += 1000000n;
            return base.run(ctx);
          },
        };
        await f
          .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
          .dispatch(f.engine, directive);
        expect(f.capacity.inspect(f.record(directive).operation_record_id)?.state).toBe("settled");
      } finally {
        n.relay.close();
        await a.close();
      }
    }, 30000);
    it("closes real ingress before baseline, enters after guard, binds actual payload, observes chunks, drains, meters and settles", async () => {
      const a = await app();
      const n = managed(a);
      using f = n.f;
      try {
        const directive = f.prepare("voice-private-complete");
        const base = syntheticCapacityAdapter(() => undefined, f.counter);
        const http = new VoiceStudioTransport(a.transport, Limits, (bytes) =>
          n.relay.countHttp(bytes)
        );
        const adapter = {
          ...base,
          prepare: async (ctx: Parameters<typeof base.run>[0]) =>
            n.relay.prepare(
              ctx,
              () => {
                if (sha256(ctx.request_bytes) !== directive.request_sha256)
                  throw new Error("request drift");
              },
              { source_text: "Synthetic private narration.", voice_id: "abcdef123456" }
            ),
          run: async (ctx: Parameters<typeof base.run>[0]) => {
            expect(
              f.capacity.nativeEvent(ctx.journal.operation_record_id, "native_meter_start_v1")
            ).toBeDefined();
            expect(existsSync(n.binding.worker.grant_file)).toBe(false);
            ctx.beginSubmission();
            n.relay.enter(ctx);
            await expect(n.relay.create("WRONG TEXT", "abcdef123456")).rejects.toThrow("drift");
            const narration = await n.relay.create("Synthetic private narration.", "abcdef123456");
            const accepted = await n.relay.generate(narration.id, "abcdef123456");
            await expect(n.relay.generate(narration.id, "abcdef123456")).rejects.toThrow("drift");
            await expect(n.relay.cancel("wrong-job")).rejects.toThrow("mismatch");
            ctx.recordRemoteAccepted(accepted.job_id);
            let job;
            for (let i = 0; i < 100; i++) {
              job = validateSkillSchema(
                VoiceStudioJobV1Schema,
                await http.json("GET", `/api/tts/jobs/${accepted.job_id}`, ctx.signal),
                "actual job"
              );
              if (!["queued", "running"].includes(job.status)) break;
              await new Promise((r) => setTimeout(r, 20));
            }
            expect(job?.status, a.errors()).toBe("completed");
            const current = await VoicePrivateClient.connect(n.binding, "fixture-service");
            try {
              await expect(
                current.command({
                  op: "acquire",
                  owner_id: "second-owner",
                  backend_binding_id: "fixture-service",
                })
              ).rejects.toThrow();
            } finally {
              current.close();
            }
            const wav = await http.wav(`/api/tts/result/${narration.id}.wav`, ctx.signal);
            expect(wav.subarray(0, 4).toString()).toBe("RIFF");
            const observation = validateSkillSchema(
              VoicePrivateObservationSchema,
              JSON.parse(readFileSync(path.join(a.root, "observation.json"), "utf8")),
              "fake observation"
            );
            expect(observation.model_identity_verified).toBe(false);
            expect(
              requireValue(requireValue(observation.jobs[0], "job").chunks[0], "chunk").text_sha256
            ).toBe(sha256("Synthetic private narration."));
            await n.relay.drain();
            n.counters.usec += 1000n;
            n.counters.ns += 1000000n;
            return base.run(ctx);
          },
        };
        await expect(
          f
            .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
            .dispatch(f.engine, directive)
        ).resolves.toMatchObject({ action: "await_user" });
        const journal = f.record(directive);
        expect(journal.disposition?.lease_disposition).toBe("released");
        const cap = requireValue(
          f.capacity.inspect(journal.operation_record_id),
          "settled capacity"
        );
        expect(cap.state).toBe("settled");
        expect(
          requireValue(cap.snapshot, "final").readings.reduce(
            (s, r) => s + r.meters.egress_bytes,
            0
          )
        ).toBeGreaterThan(1000);
        expect(
          validateSkillSchema(
            ManagedWorkerStateSchema,
            readNativeObservationFile(n.binding.worker.state_file, 16384),
            "closed"
          ).state.kind
        ).toBe("closed");
        expect(n.relay.overhead.bytes).toBeGreaterThan(0);
      } finally {
        n.relay.close();
        await a.close();
      }
    }, 30000);
    it("rejects native epoch drift; bridge loss invalidates CLOSED and does not reopen manual admission", async () => {
      const a = await app();
      const n = managed(a);
      using _f = n.f;
      try {
        await expect(
          VoicePrivateClient.connect(
            {
              ...n.binding,
              worker: { ...n.binding.worker, process: { ...a.pin, start_ticks: "1" } },
            },
            "fixture-service"
          )
        ).rejects.toThrow();
        await n.relay.acquire();
        expect(existsSync(n.binding.worker.state_file)).toBe(true);
        n.relay.close();
        expect(existsSync(n.binding.worker.state_file)).toBe(false);
        await expect
          .poll(() => existsSync(n.binding.checker_socket_path), { timeout: 2000 })
          .toBe(false);
        await new Promise((r) => setTimeout(r, 200));
        const c = await VoicePrivateClient.connect(n.binding, "fixture-service");
        try {
          await expect(
            c.command({
              op: "acquire",
              owner_id: "after-disconnect",
              backend_binding_id: "fixture-service",
            })
          ).rejects.toThrow();
        } finally {
          c.close();
        }
      } finally {
        n.relay.close();
        await a.close();
      }
    }, 30000);
    it("refuses unmanaged retained work without publishing CLOSED; a replayed private sequence loses its lease", async () => {
      const a = await app("unmanaged");
      const n = managed(a);
      using _f = n.f;
      try {
        await expect(n.relay.acquire()).rejects.toThrow();
        expect(existsSync(n.binding.worker.state_file)).toBe(false);
        const c = await VoicePrivateClient.connect(n.binding, "fixture-service");
        try {
          await expect(
            c.command({
              op: "acquire",
              owner_id: "busy-owner",
              backend_binding_id: "fixture-service",
            })
          ).rejects.toThrow();
          c.peer.send({
            schema_version: 1,
            process_epoch: c.hello.process_epoch,
            challenge: c.hello.challenge,
            seq: 1,
            command: { op: "snapshot" },
          });
          const bytes = await c.peer.next();
          expect(bytes.toString()).toContain('"invalid_request"');
        } finally {
          c.close();
        }
      } finally {
        n.relay.close();
        await a.close();
      }
    }, 30000);
    it("cancel ack cannot close a retained engine window; disconnect keeps the real owner hold quarantined", async () => {
      const a = await app("slow");
      const n = managed(a);
      using f = n.f;
      try {
        const directive = f.prepare("voice-private-retained");
        const base = syntheticCapacityAdapter(() => undefined, f.counter);
        const adapter = {
          ...base,
          prepare: async (ctx: Parameters<typeof base.run>[0]) =>
            n.relay.prepare(ctx, () => undefined, {
              source_text: "Retained fake computation.",
              voice_id: "abcdef123456",
            }),
          run: async (ctx: Parameters<typeof base.run>[0]) => {
            ctx.beginSubmission();
            n.relay.enter(ctx);
            const item = await n.relay.create("Retained fake computation.", "abcdef123456");
            const job = await n.relay.generate(item.id, "abcdef123456");
            ctx.recordRemoteAccepted(job.job_id);
            for (let i = 0; i < 100 && !existsSync(path.join(a.root, "retained")); i++)
              await new Promise((r) => setTimeout(r, 10));
            expect(existsSync(path.join(a.root, "retained"))).toBe(true);
            await n.relay.cancel(job.job_id);
            await expect(n.relay.drain()).rejects.toThrow("drain");
            expect(
              validateSkillSchema(
                ManagedWorkerStateSchema,
                readNativeObservationFile(n.binding.worker.state_file, 16384),
                "still executing"
              ).state.kind
            ).toBe("executing");
            n.relay.close();
            expect(existsSync(n.binding.worker.state_file)).toBe(false);
            writeFileSync(path.join(a.root, "release-compute"), "release test fake");
            return {
              disposition: {
                outcome: "remote_unknown" as const,
                remote_disposition: "may_continue" as const,
                lease_disposition: "quarantined" as const,
                retryable: false as const,
                reason_code: "fake_disconnect",
              },
              operation_result_ref: null,
              output_artifacts: [],
            };
          },
        };
        await f
          .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
          .dispatch(f.engine, directive);
        expect(f.record(directive).disposition?.lease_disposition).toBe("quarantined");
        expect(f.capacity.inspect(f.record(directive).operation_record_id)?.state).toBe(
          "quarantined"
        );
        expect(
          f.capacity.nativeEvent(f.record(directive).operation_record_id, "native_meter_stop_v1")
        ).toBeUndefined();
      } finally {
        n.relay.close();
        await a.close();
      }
    }, 30000);
  }
);
