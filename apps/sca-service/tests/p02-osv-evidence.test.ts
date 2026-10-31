import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { scaDependencyCoordinateIdV2 } from "../src/adapters/dependency-inventory-v2.js";
import { planScaOsvV2, type ScaOsvV2TransportRequest } from "../src/adapters/osv-v2.js";

const state = vi.hoisted(() => ({
  shows: 0,
  mode: "normal" as
    | "normal"
    | "connect_fail"
    | "connect_abort"
    | "connect_timeout"
    | "peer_fail"
    | "port_fail"
    | "fd_absent"
    | "canary_fail"
    | "receipt_fail"
    | "post_go_abort"
    | "policy_drift"
    | "forged_receipt"
    | "pre_go_abort",
  controller: null as AbortController | null,
  scopeExit: null as (() => void) | null,
  socketClosed: false,
  gates: [] as string[],
  sends: 0,
  cleanupFails: false,
  injectWorkspacePath: false,
  pinFailsAt: 0,
  pinChecks: 0,
  responseInvalid: false,
  work: "",
  unit: "",
  limits: { memory_bytes: 67108864, tasks: 4 },
  samples: [] as string[],
  receipts: [] as { request: string; receipt: string; response: string; bytes: number }[],
}));
const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
vi.mock("../src/p02-osv-pin.js", () => ({
  verifyP02OsvPin: vi.fn(async () => ({ size: 1 })),
  verifyP02OsvPinSet: vi.fn(async (specs: { pin: { path: string } }[]) => {
    state.pinChecks++;
    if (state.pinChecks === state.pinFailsAt) throw Error("simulated_pin_drift");
    return new Map(specs.map(({ pin }) => [pin.path, { source: pin.path, size: 1 }]));
  }),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: async (file: string) => {
      if (file.startsWith("/run/user/") || file === state.work)
        return {
          isSocket: () => file.endsWith("/bus"),
          isDirectory: () => !file.endsWith("/bus"),
          isSymbolicLink: () => false,
          uid: 1000,
          mode: 0o700,
        };
      if (file.startsWith("/opt/")) return { mode: 0o755 };
      return fs.lstat(file);
    },
    mkdtemp: async (prefix: string) => {
      const work = await fs.mkdtemp(prefix);
      if (prefix.endsWith("p02-osv-")) state.work = work;
      return work;
    },
    chmod: async () => undefined,
    copyFile: async (_from: string, to: string) => fs.writeFile(to, "pinned"),
    writeFile: async (file: string, bytes: string | Uint8Array, options?: object) => {
      await fs.writeFile(file, bytes, options);
      if (file.endsWith("/control/go") || file.endsWith("/control/finish")) {
        state.gates.push(path.basename(file));
        if (file.endsWith("/control/finish")) state.scopeExit?.();
        if (file.endsWith("/control/go")) await writeSimulatedReceipt();
        if (file.endsWith("/control/go") && state.mode === "post_go_abort")
          state.controller?.abort();
      }
      if (file.endsWith("/control/policy") && state.mode === "pre_go_abort")
        state.controller?.abort();
      if (file.endsWith("/control/policy") && state.mode !== "canary_fail") {
        const request = await fs.readFile(path.join(state.work, "request.json"));
        await fs.writeFile(path.join(state.work, "control/canary"), `${sha256(request)}\n`, {
          mode: 0o600,
        });
      }
    },
    rm: async (file: string, options: { recursive?: boolean; force?: boolean }) => {
      if (file === state.work && state.cleanupFails) throw Error("simulated_cleanup_failure");
      return fs.rm(file, options);
    },
  };
});
vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  connect: () => {
    const socket = new EventEmitter();
    Object.assign(socket, {
      remoteAddress: state.mode === "peer_fail" ? "1.1.1.1" : "8.8.8.8",
      remotePort: state.mode === "port_fail" ? 80 : 443,
      pause: () => undefined,
      destroy: () => {
        state.socketClosed = true;
      },
    });
    queueMicrotask(() => {
      if (state.mode === "connect_abort") state.controller?.abort();
      else if (state.mode !== "connect_timeout")
        socket.emit(state.mode === "connect_fail" ? "error" : "connect", Error("connect_failed"));
    });
    return socket;
  },
}));
async function writeSimulatedReceipt() {
  if (state.mode !== "receipt_fail") {
    const input = await realFs.readFile(path.join(state.work, "request.json"));
    const payload: unknown = JSON.parse(input.toString("utf8"));
    if (typeof payload !== "object" || payload === null || !("unit" in payload))
      throw Error("mock payload");
    const p = payload as Record<string, unknown>;
    const body =
      p.method === "POST"
        ? { results: [{ vulns: [{ id: "OSV-1", detail: "raw-response-sentinel" }] }] }
        : { id: "OSV-1", detail: "raw-response-sentinel" };
    const response = Buffer.from(state.responseInvalid ? "not-json" : JSON.stringify(body));
    const receipt = {
      nonce: p.nonce,
      unit: p.unit,
      request_sha256: sha256(input),
      body_sha256: p.body_sha256,
      plan_sha256: p.plan_sha256,
      mapping_sha256: p.mapping_sha256,
      worker_sha256: p.worker_sha256,
      deployment_sha256: p.deployment_sha256,
      runtime_sha256: p.runtime_sha256,
      ca_sha256: p.ca_sha256,
      scratch_launcher_sha256: p.scratch_launcher_sha256,
      scratch_bytes: p.scratch_bytes,
      scratch_capacity_bytes: p.scratch_bytes,
      worker_caps_zero: true,
      no_new_privileges: true,
      ip: p.ip,
      kernel_peer_ip: state.mode === "forged_receipt" ? "1.1.1.1" : p.ip,
      kernel_peer_port: 443,
      network_namespace_denied: true,
      canary_ip: p.canary_ip,
      canary_denied: true,
      canary_error_code: "ENETUNREACH",
      phase: "completed",
      code: "none",
      status: 200,
      response_sha256: sha256(response),
      response_base64: response.toString("base64"),
    };
    const receiptBytes = canonicalJson(receipt) + "\n";
    state.receipts.push({
      request: sha256(input),
      receipt: sha256(receiptBytes),
      response: sha256(response),
      bytes: response.length,
    });
    await realFs.writeFile(path.join(state.work, "control/receipt.json"), receiptBytes, {
      mode: 0o600,
    });
  }
}
vi.mock("node:child_process", () => ({
  spawn: (_exe: string, args: string[], options: { stdio: unknown[] }) => {
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr, kill: () => undefined });
    if (args.includes("--scope")) {
      if (options.stdio.length !== 3 || !options.stdio[0] || state.mode === "fd_absent")
        throw Error("missing stdin socket");
      state.sends++;
      state.unit = args.find((arg) => arg.startsWith("--unit="))?.slice(7) ?? "";
      state.scopeExit = () => child.emit("close", 0);
      queueMicrotask(() => child.emit("spawn"));
    } else
      queueMicrotask(() => {
        void (async () => {
          if (args.includes("show") && args.some((arg) => arg.startsWith("--property=Id,"))) {
            state.shows++;
            const n = state.shows - (state.sends - 1) * 3;
            const stopped = state.gates.filter((gate) => gate === "finish").length === state.sends;
            const sample =
              [
                `Id=${state.unit}`,
                `ActiveState=${stopped ? "inactive" : "active"}`,
                `SubState=${stopped ? "dead" : "running"}`,
                `ControlGroup=/user.slice/${state.unit}`,
                `TasksCurrent=${stopped ? 0 : n === 1 ? 1 : 2}`,
                `MemoryMax=${state.limits.memory_bytes}`,
                `TasksMax=${state.mode === "policy_drift" && n === 2 ? 100 : state.limits.tasks}`,
                "CPUQuotaPerSecUSec=500000us",
              ].join("\n") + "\n";
            const observed = state.injectWorkspacePath
              ? sample.replace(
                  "ControlGroup=/user.slice/",
                  `ControlGroup=/user.slice${state.work}/`
                )
              : sample;
            state.samples.push(observed);
            stdout.emit("data", Buffer.from(observed));
          } else if (args.includes("show")) {
            stdout.emit(
              "data",
              Buffer.from(
                "LoadState=not-found\nActiveState=inactive\nSubState=dead\nTasksCurrent=0\n"
              )
            );
          }
          child.emit("close", 0);
        })().catch((error: unknown) => child.emit("error", error));
      });
    return child;
  },
}));

import {
  createP02OsvExternalTransport,
  p02OsvProfileDigest,
  readP02OsvTransportEvidenceV1,
} from "../src/p02-osv-host.js";

const H = "a".repeat(64);
const workerPath = new URL("../src/p02-osv-worker.mjs", import.meta.url);
const originalUid = process.getuid;
let workspace = "";
afterEach(async () => {
  process.getuid = originalUid;
  state.cleanupFails = false;
  state.injectWorkspacePath = false;
  state.pinFailsAt = 0;
  state.responseInvalid = false;
  state.mode = "normal";
  state.controller = null;
  state.scopeExit = null;
  if (workspace) await realFs.rm(workspace, { recursive: true, force: true });
});
async function setup() {
  workspace = await mkdtemp(path.join(os.tmpdir(), "p02-evidence-test-"));
  state.work = "";
  state.shows = 0;
  state.sends = 0;
  state.pinChecks = 0;
  state.samples = [];
  state.receipts = [];
  state.gates = [];
  state.socketClosed = false;
  process.getuid = () => 1000;
  const coordinate_id = scaDependencyCoordinateIdV2("npm", "private-coordinate-sentinel", "1.0.0");
  const component_request = {
    schema_id: "penny.sca-osv-request.v2" as const,
    schema_version: 2 as const,
    source_snapshot_sha256: H,
    dependency_inventory_sha256: H,
    coordinates: [
      {
        coordinate_id,
        ecosystem: "npm" as const,
        name: "private-coordinate-sentinel",
        version: "1.0.0",
      },
    ],
    coordinate_occurrences: [{ coordinate_id, occurrence_ids: [`depocc_${H}`] }],
    network_policy: "fixed_osv_origin_authorized" as const,
    ip_confinement: "external_worker_required" as const,
    inactivity_timeout_ms: 2000,
    max_response_bytes: 1024,
    concurrency: 2 as const,
    max_advisory_requests: 4,
    max_age_seconds: 60,
  };
  const c = {
    component_request,
    transport_id: "fixed",
    profile_id: "p02",
    profile_sha256: H,
    deployment: { path: "/opt/osv/deployment", sha256: H },
    runtime: { path: "/opt/node/bin/node", sha256: H },
    closure: [],
    ca: { path: "/opt/osv/ca.pem", sha256: H },
    controls: { bwrap: H, systemd_run: H, systemctl: H, scratch_launcher: H, mount: H, setpriv: H },
    workspace_parent: workspace,
    ips: ["8.8.8.8", "2606:4700:4700::1111"],
    canary_ip: "9.9.9.9",
    limits: {
      scratch_bytes: 1048576,
      ...state.limits,
      cpu_percent: 50,
      runtime_ms: 5000,
      output_bytes: 4096,
    },
  };
  c.profile_sha256 = p02OsvProfileDigest(c, sha256(await readFile(workerPath)));
  const transport = createP02OsvExternalTransport(c);
  const batch = planScaOsvV2(component_request).batches[0];
  if (!batch) throw Error("missing batch");
  state.controller = new AbortController();
  const signal = state.controller.signal;
  const query: ScaOsvV2TransportRequest = {
    url: batch.url,
    method: "POST",
    body: batch.request_body,
    signal,
    inactivity_timeout_ms: 2000,
    max_response_bytes: 1024,
  };
  const advisory: ScaOsvV2TransportRequest = {
    ...query,
    method: "GET",
    url: "https://api.osv.dev/v1/vulns/OSV-1",
    body: null,
  };
  return { transport, query, advisory, c };
}

describe("factory OSV containment evidence (offline simulated host)", () => {
  it("rejects forged readers and stays empty until a completed send", async () => {
    const { transport, query } = await setup();
    expect(readP02OsvTransportEvidenceV1(transport)).toEqual([]);
    expect(() => readP02OsvTransportEvidenceV1({ ...transport })).toThrow("unissued_transport");
    expect(() => readP02OsvTransportEvidenceV1(null)).toThrow("unissued_transport");
    await expect(transport.send({ ...query, body: "{}" })).rejects.toThrow();
    expect(state.sends).toBe(0);
    expect(readP02OsvTransportEvidenceV1(transport)).toEqual([]);
  });
  it("binds exact bounded fields, current policy samples and ordering without raw response or coordinates", async () => {
    const { transport, query, advisory, c } = await setup();
    await transport.send(query);
    const first = readP02OsvTransportEvidenceV1(transport);
    expect(first).toHaveLength(1);
    await transport.send(advisory);
    const records = readP02OsvTransportEvidenceV1(transport);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(first[0]);
    expect(records.map((r) => [r.method, r.url])).toEqual([
      ["POST", query.url],
      ["GET", advisory.url],
    ]);
    for (const [index, record] of records.entries()) {
      const { evidence_sha256, ...unsigned } = record;
      expect(evidence_sha256).toBe(sha256(canonicalJson(unsigned)));
      expect(Object.keys(record).sort()).toEqual(
        [
          "schema_version",
          "unit_id",
          "method",
          "url",
          "request_sha256",
          "body_sha256",
          "plan_sha256",
          "mapping_sha256",
          "profile_sha256",
          "deployment_sha256",
          "worker_sha256",
          "runtime_sha256",
          "ca_sha256",
          "allowed_ips",
          "selected_ip",
          "kernel_peer_ip",
          "kernel_peer_port",
          "network_namespace_denied",
          "isolation",
          "canary_ip",
          "canary_denied",
          "canary_error_code",
          "running_properties",
          "terminal_properties",
          "worker_receipt_sha256",
          "response_sha256",
          "response_byte_count",
          "started_at",
          "completed_at",
          "duration_ms",
          "terminal_phase",
          "terminal_status",
          "cleanup_verified",
          "evidence_sha256",
        ].sort()
      );
      expect(record.schema_version).toBe(1);
      expect(record.unit_id).toMatch(/^p02-osv-[a-f0-9]{32}\.scope$/);
      expect(record.body_sha256).toBe(sha256(index === 0 ? (query.body ?? "") : ""));
      expect(record.plan_sha256).toBe(planScaOsvV2(c.component_request).plan_sha256);
      expect(record.mapping_sha256).toBe(
        sha256(canonicalJson(c.component_request.coordinate_occurrences))
      );
      expect(record.profile_sha256).toBe(c.profile_sha256);
      expect(record.deployment_sha256).toBe(c.deployment.sha256);
      expect(record.runtime_sha256).toBe(c.runtime.sha256);
      expect(record.ca_sha256).toBe(c.ca.sha256);
      expect(record.worker_sha256).toBe(sha256(await readFile(workerPath)));
      expect(record.allowed_ips).toEqual(c.ips);
      expect(record.selected_ip).toBe(c.ips[0]);
      expect(record.kernel_peer_ip).toBe(c.ips[0]);
      expect(record.kernel_peer_port).toBe(443);
      expect(record.network_namespace_denied).toBe(true);
      expect(record.isolation).toBe("preconnected-socket-object-capability-bwrap-netns-v1");
      expect(record.canary_ip).toBe(c.canary_ip);
      expect(record.canary_denied).toBe(true);
      expect(record.canary_error_code).toBe("ENETUNREACH");
      expect(record.cleanup_verified).toBe(true);
      expect(record.terminal_phase).toBe("completed");
      expect(record.terminal_status).toBe(200);
      const sent = state.receipts[index];
      if (!sent) throw Error("missing simulated receipt");
      expect(record.request_sha256).toBe(sent.request);
      expect(record.worker_receipt_sha256).toBe(sent.receipt);
      expect(record.response_sha256).toBe(sent.response);
      expect(record.response_byte_count).toBe(sent.bytes);
      expect(record.running_properties).toBe(
        `${state.samples[index * 3 + 1]}\n${state.samples[index * 3 + 2]}`
      );
      expect(record.terminal_properties).toContain("ActiveState=inactive");
      expect(record.running_properties).toContain("SubState=running");
      expect(record.running_properties).toContain("TasksCurrent=2");
      expect(record.running_properties).not.toContain("TasksCurrent=1");
      expect(record.terminal_properties).toContain("SubState=dead");
      expect(record.response_byte_count).toBeGreaterThan(0);
      expect(record.duration_ms).toBeGreaterThanOrEqual(0);
      expect(Date.parse(record.completed_at)).toBeGreaterThanOrEqual(Date.parse(record.started_at));
      const json = canonicalJson(record);
      for (const forbidden of [
        "private-coordinate-sentinel",
        "1.0.0",
        "response_base64",
        "results",
        "raw-response-sentinel",
        workspace,
      ])
        expect(json).not.toContain(forbidden);
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.allowed_ips)).toBe(true);
    }
    expect(Object.isFrozen(records)).toBe(true);
    expect(first).toHaveLength(1);
    expect(state.sends).toBe(2);
    expect(state.socketClosed).toBe(true);
    expect(state.gates).toEqual(["go", "finish", "go", "finish"]);
  });
  it("rejects verified-looking policy text containing the workspace path before the gate", async () => {
    const { transport, query } = await setup();
    state.injectWorkspacePath = true;
    await expect(transport.send(query)).rejects.toThrow("evidence_properties");
    expect(readP02OsvTransportEvidenceV1(transport)).toEqual([]);
    expect(state.receipts).toEqual([]);
  });
  it("retains earlier evidence, but not an uncertain later advisory", async () => {
    const { transport, query, advisory } = await setup();
    await transport.send(query);
    const prior = readP02OsvTransportEvidenceV1(transport);
    state.cleanupFails = true;
    await expect(transport.send(advisory)).rejects.toThrow();
    expect(readP02OsvTransportEvidenceV1(transport)).toEqual(prior);
  });
  it.each(["connect_fail", "connect_abort", "peer_fail", "port_fail", "fd_absent"] as const)(
    "closes a failed %s socket without creating a scope",
    async (mode) => {
      const { transport, query } = await setup();
      state.mode = mode;
      await expect(transport.send(query)).rejects.toThrow();
      expect(state.socketClosed).toBe(true);
      expect(state.sends).toBe(0);
      expect(state.gates).toEqual([]);
      expect(readP02OsvTransportEvidenceV1(transport)).toEqual([]);
    }
  );
  it("bounds an unresponsive TCP connect and closes it before any scope", async () => {
    const { transport, query } = await setup();
    state.mode = "connect_timeout";
    await expect(transport.send(query)).rejects.toThrow("connect_timeout");
    expect(state.socketClosed).toBe(true);
    expect(state.sends).toBe(0);
  }, 10000);
  it.each(["pre_go_abort", "post_go_abort", "policy_drift", "forged_receipt"] as const)(
    "denies %s with scope cleanup, no evidence and no replay",
    async (mode) => {
      const { transport, query } = await setup();
      state.mode = mode;
      await expect(transport.send(query)).rejects.toThrow();
      expect(state.socketClosed).toBe(true);
      expect(state.sends).toBe(1);
      expect(state.gates.includes("finish")).toBe(false);
      expect(readP02OsvTransportEvidenceV1(transport)).toEqual([]);
      await expect(transport.send(query)).rejects.toThrow(
        mode.includes("abort") ? "p02_osv_request" : "duplicate_send"
      );
    }
  );
  it("times out without a post-go receipt and never opens finish or emits evidence", async () => {
    const { transport, query } = await setup();
    state.mode = "receipt_fail";
    await expect(transport.send(query)).rejects.toThrow("post_send_uncertain");
    expect(state.gates).toEqual(["go"]);
    expect(readP02OsvTransportEvidenceV1(transport)).toEqual([]);
  }, 10000);
  it("rejects a failed fresh-netns canary before go", async () => {
    const { transport, query } = await setup();
    state.mode = "canary_fail";
    await expect(transport.send(query)).rejects.toThrow();
    expect(state.gates).toEqual([]);
    expect(readP02OsvTransportEvidenceV1(transport)).toEqual([]);
  }, 10000);
  it.each(["cleanup", "final pin", "response"] as const)(
    "does not publish success on %s failure",
    async (failure) => {
      const { transport, query } = await setup();
      if (failure === "cleanup") state.cleanupFails = true;
      if (failure === "final pin") state.pinFailsAt = 4;
      if (failure === "response") state.responseInvalid = true;
      await expect(transport.send(query)).rejects.toThrow();
      expect(readP02OsvTransportEvidenceV1(transport)).toEqual([]);
      await expect(transport.send(query)).rejects.toThrow("duplicate_send");
      expect(state.sends).toBe(1);
    }
  );
});
