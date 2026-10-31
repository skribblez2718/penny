import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { scaDependencyCoordinateIdV2 } from "../src/adapters/dependency-inventory-v2.js";
import {
  buildP02OsvKillArgs,
  buildP02OsvSystemdArgs,
  createP02OsvExternalTransport,
  isIssuedP02OsvTransport,
  matchesIssuedP02OsvTransport,
  validateP02OsvHostConfig,
  validateP02OsvReceipt,
  verifyP02OsvCleanup,
  verifyP02OsvUnit,
  type WorkerPayload,
} from "../src/p02-osv-host.js";

const H = "a".repeat(64);
function config() {
  const coordinate_id = scaDependencyCoordinateIdV2("npm", "approved", "1.0.0");
  return {
    component_request: {
      schema_id: "penny.sca-osv-request.v2",
      schema_version: 2,
      source_snapshot_sha256: H,
      dependency_inventory_sha256: H,
      coordinates: [{ coordinate_id, ecosystem: "npm", name: "approved", version: "1.0.0" }],
      coordinate_occurrences: [{ coordinate_id, occurrence_ids: [`depocc_${H}`] }],
      network_policy: "fixed_osv_origin_authorized",
      ip_confinement: "external_worker_required",
      inactivity_timeout_ms: 2000,
      max_response_bytes: 1024,
      concurrency: 2,
      max_advisory_requests: 4,
      max_age_seconds: 60,
    },
    transport_id: "osv-fixed",
    profile_id: "p02-osv",
    profile_sha256: H,
    deployment: { path: "/opt/osv/deployment", sha256: H },
    runtime: { path: "/opt/node/bin/node", sha256: H },
    closure: [{ path: "/opt/node/lib/libnode.so", sha256: H }],
    ca: { path: "/opt/osv/ca.pem", sha256: H },
    controls: { bwrap: H, systemd_run: H, systemctl: H, scratch_launcher: H, mount: H, setpriv: H },
    workspace_parent: "/private/osv",
    ips: ["8.8.8.8", "2606:4700:4700::1111"],
    canary_ip: "9.9.9.9",
    limits: {
      scratch_bytes: 1048576,
      memory_bytes: 67108864,
      tasks: 4,
      cpu_percent: 50,
      runtime_ms: 5000,
      output_bytes: 4096,
    },
  };
}
const unit = `p02-osv-${"a".repeat(32)}.scope`;
function properties(c: { limits: { memory_bytes: number; tasks: number } }) {
  return [
    `Id=${unit}`,
    "ActiveState=active",
    "SubState=running",
    `ControlGroup=/user.slice/${unit}`,
    "TasksCurrent=2",
    `MemoryMax=${c.limits.memory_bytes}`,
    `TasksMax=${c.limits.tasks}`,
    "CPUQuotaPerSecUSec=500000us",
  ].join("\n");
}
describe("P02 externally confined OSV host static admission (offline)", () => {
  it("issues only factory-marked transport bound to plan/profile/deployment/transport ID", () => {
    const c = config();
    const transport = createP02OsvExternalTransport(c);
    expect(isIssuedP02OsvTransport(transport)).toBe(true);
    const request = {
      transport_id: c.transport_id,
      isolation_profile_id: c.profile_id,
      isolation_profile_sha256: c.profile_sha256,
      isolation_deployment_sha256: c.deployment.sha256,
      isolation_qualification_scope: "live_qualified",
    };
    expect(matchesIssuedP02OsvTransport(transport, request, c.component_request)).toBe(true);
    expect(
      matchesIssuedP02OsvTransport(
        { ip_confinement: "external_worker_enforced", send: transport.send },
        request,
        c.component_request
      )
    ).toBe(false);
    expect(
      matchesIssuedP02OsvTransport(
        transport,
        { ...request, isolation_qualification_scope: "deterministic_test_only" },
        c.component_request
      )
    ).toBe(false);
    expect(
      matchesIssuedP02OsvTransport(
        transport,
        { ...request, isolation_deployment_sha256: "b".repeat(64) },
        c.component_request
      )
    ).toBe(false);
    expect(
      matchesIssuedP02OsvTransport(transport, request, {
        ...c.component_request,
        coordinate_occurrences: [],
      })
    ).toBe(false);
  });
  it("rejects duplicate, private, metadata, loopback and link-local IPs", () => {
    for (const ips of [
      ["8.8.8.8", "8.8.8.8"],
      ["127.0.0.1"],
      ["169.254.169.254"],
      ["10.0.0.1"],
      ["192.168.1.1"],
      ["::1"],
      ["fe80::1"],
      ["::ffff:8.8.8.8"],
      ["8.8.8.8:443"],
      ["2606:4700:4700:0:0:0:0:1111", "2606:4700:4700::1111"],
    ]) {
      expect(() => validateP02OsvHostConfig({ ...config(), ips })).toThrow();
    }
    expect(() => validateP02OsvHostConfig({ ...config(), canary_ip: "8.8.8.8" })).toThrow();
  });
  it("separates staged host sources from exact sandbox runtime and closure destinations", () => {
    const nested = "/home/operator/.nvm/versions/node/v1/bin/node";
    expect(
      validateP02OsvHostConfig({ ...config(), runtime: { path: nested, sha256: H } }).runtime.path
    ).toBe(nested);
    for (const file of [
      "/home",
      "/home/operator",
      "/home/operator/node",
      "/home/operator/bin/node",
    ])
      expect(() =>
        validateP02OsvHostConfig({ ...config(), runtime: { path: file, sha256: H } })
      ).toThrow();
    for (const field of ["ca", "deployment"] as const) {
      const pin = { path: nested, sha256: H };
      expect(validateP02OsvHostConfig({ ...config(), [field]: pin })[field].path).toBe(nested);
    }
    expect(() =>
      validateP02OsvHostConfig({
        ...config(),
        closure: [{ path: nested, sha256: H }],
      })
    ).toThrow();
    expect(() =>
      validateP02OsvHostConfig({
        ...config(),
        ca: { path: "/private/osv/ca.pem", sha256: H },
      })
    ).toThrow();
    expect(() =>
      validateP02OsvHostConfig({ ...config(), workspace_parent: "/home/operator/work" })
    ).toThrow();
    expect(() =>
      validateP02OsvHostConfig({
        ...config(),
        runtime: { path: "/private/osv/node/bin/node", sha256: H },
      })
    ).toThrow();
    expect(() =>
      validateP02OsvHostConfig({
        ...config(),
        closure: [{ path: config().runtime.path, sha256: H }],
      })
    ).toThrow();
    for (const file of ["/proc/self/exe", "/run/user/node", "/osv/worker.mjs", "/scratch/node"])
      expect(() =>
        validateP02OsvHostConfig({ ...config(), closure: [{ path: file, sha256: H }] })
      ).toThrow();
  });
  it("builds only a scope with a new network namespace for the pinned launcher stdin behavior", () => {
    const c = validateP02OsvHostConfig(config());
    const args = buildP02OsvSystemdArgs(c, "/private/osv/work", unit);
    expect(args).toContain("--scope");
    expect(args).toContain("--unshare-net");
    expect(args).not.toContain("--preserve-fds");
    expect(args).toContain("--clearenv");
    expect(args.join(" ")).not.toMatch(/IPAddress|RuntimeMaxSec|Type=exec|\.service|--no-block/);
    expect(buildP02OsvKillArgs(unit)).toEqual([
      "--user",
      "kill",
      "--kill-who=all",
      "--signal=SIGKILL",
      unit,
    ]);
    expect(() => buildP02OsvKillArgs("other.service")).toThrow();
  });
  it("requires exact running scope cgroup, tasks and limits", () => {
    const c = validateP02OsvHostConfig(config());
    const good = properties(c);
    expect(verifyP02OsvUnit(good, unit, c, "running")).toBe(true);
    for (const weakened of [
      good.replace("TasksCurrent=2", "TasksCurrent=100"),
      good.replace("CPUQuotaPerSecUSec=500000us", "CPUQuotaPerSecUSec=1000000us"),
      good.replace(`ControlGroup=/user.slice/${unit}`, "ControlGroup=/other.scope"),
    ])
      expect(verifyP02OsvUnit(weakened, unit, c, "running")).toBe(false);
    const stopped = good
      .replace("ActiveState=active", "ActiveState=inactive")
      .replace("SubState=running", "SubState=dead")
      .replace("TasksCurrent=2", "TasksCurrent=0");
    expect(verifyP02OsvUnit(stopped, unit, c, "stopped")).toBe(true);
    expect(verifyP02OsvUnit(good, unit, c, "stopped")).toBe(false);
  });
  it("rejects forged cleanup text, extra keys and live tasks", () => {
    const good = "LoadState=not-found\nActiveState=inactive\nSubState=dead\nTasksCurrent=0\n";
    expect(verifyP02OsvCleanup(good)).toBe(true);
    for (const forged of [
      good.replace("TasksCurrent=0", "TasksCurrent=1"),
      good + "TasksCurrent=0\n",
      good.replace("ActiveState=inactive", "ActiveState=active"),
      good.replace("SubState=dead", "SubState=running"),
    ])
      expect(verifyP02OsvCleanup(forged)).toBe(false);
  });
  it("keeps the worker OSV transport on stdin and never uses ambient OSV DNS/TCP", async () => {
    const worker = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/p02-osv-worker.mjs", import.meta.url), "utf8")
    );
    expect(worker).toContain("new Socket({ fd: 0, readable: true, writable: true })");
    expect(worker).toContain("kernel_peer_mismatch");
    expect(worker).toContain("/proc/net/route");
    expect(worker).toContain('devices[0] === "lo"');
    expect(worker).toContain('servername: "api.osv.dev"');
    expect(worker).toContain("socket: inherited");
    expect(worker).not.toMatch(/dns\.|lookup\(|hostname: data\.ip|connect\(\{ host: data\.ip/);
  });
  it("rejects forged receipts, hashes, response overflow and post-send errors", () => {
    const c = validateP02OsvHostConfig(config());
    const payload: WorkerPayload = {
      nonce: H,
      unit,
      url: "https://api.osv.dev/v1/querybatch",
      method: "POST",
      request_body: "{}",
      advisory_id: null,
      coordinate_ids: [],
      body_sha256: sha256("{}"),
      plan_sha256: H,
      mapping_sha256: H,
      worker_sha256: H,
      deployment_sha256: H,
      runtime_sha256: H,
      ca_sha256: H,
      scratch_bytes: c.limits.scratch_bytes,
      scratch_launcher_sha256: H,
      mount_sha256: H,
      setpriv_sha256: H,
      node_path: c.runtime.path,
      node_sha256: c.runtime.sha256,
      ips: c.ips,
      ip: c.ips[0] ?? "",
      kernel_peer_port: 443,
      canary_ip: c.canary_ip,
      max_response_bytes: 200,
      timeout_ms: 2000,
    };
    const requestHash = sha256(canonicalJson(payload) + "\n");
    const raw = Buffer.from('{"results":[]}');
    const receipt = {
      nonce: H,
      unit,
      request_sha256: requestHash,
      body_sha256: payload.body_sha256,
      plan_sha256: H,
      mapping_sha256: H,
      worker_sha256: H,
      deployment_sha256: H,
      runtime_sha256: H,
      ca_sha256: H,
      scratch_bytes: c.limits.scratch_bytes,
      scratch_launcher_sha256: H,
      scratch_capacity_bytes: c.limits.scratch_bytes,
      worker_caps_zero: true,
      no_new_privileges: true,
      ip: payload.ip,
      kernel_peer_ip: payload.ip,
      kernel_peer_port: 443,
      network_namespace_denied: true,
      canary_ip: c.canary_ip,
      canary_denied: true,
      canary_error_code: "ENETUNREACH",
      phase: "completed",
      code: "none",
      status: 200,
      response_sha256: sha256(raw),
      response_base64: raw.toString("base64"),
    };
    const bytes = (value: unknown) => Buffer.from(canonicalJson(value) + "\n");
    expect(validateP02OsvReceipt(bytes(receipt), requestHash, payload, c).body).toEqual(raw);
    for (const forged of [
      { ...receipt, request_sha256: H },
      { ...receipt, canary_denied: false },
      { ...receipt, worker_caps_zero: false },
      { ...receipt, no_new_privileges: false },
      { ...receipt, scratch_bytes: 2097152 },
      { ...receipt, scratch_capacity_bytes: 2097152 },
      { ...receipt, scratch_launcher_sha256: "c".repeat(64) },
      { ...receipt, network_namespace_denied: false },
      { ...receipt, kernel_peer_port: 80 },
      { ...receipt, kernel_peer_ip: "1.1.1.1" },
      { ...receipt, response_sha256: H },
      { ...receipt, response_base64: Buffer.alloc(201).toString("base64") },
      { ...receipt, phase: "sent", code: "inactivity_timeout" },
      { ...receipt, proxy: "http://proxy.example" },
    ])
      expect(() => validateP02OsvReceipt(bytes(forged), requestHash, payload, c)).toThrow();
    expect(() =>
      validateP02OsvReceipt(Buffer.alloc(c.limits.output_bytes + 1), requestHash, payload, c)
    ).toThrow();
  });
  it("refuses methods, query URL, proxy and body drift before any launch", async () => {
    const c = config();
    const transport = createP02OsvExternalTransport(c);
    const abort = new AbortController();
    const base = {
      url: "https://api.osv.dev/v1/querybatch",
      method: "POST" as const,
      body: "{}",
      inactivity_timeout_ms: 2000,
      max_response_bytes: 100,
      signal: abort.signal,
    };
    for (const input of [
      base,
      { ...base, url: "https://evil.example/v1/querybatch" },
      { ...base, url: "https://api.osv.dev/v1/querybatch?proxy=1" },
      { ...base, body: '{"queries":[]}' },
      { ...base, max_response_bytes: 4096 },
      { ...base, method: "GET" as const, body: null, url: "https://api.osv.dev/v1/vulns/OSV-1" },
      { ...base, method: "GET" as const, url: "https://api.osv.dev/v1/vulns/OSV-1" },
      {
        ...base,
        method: "GET" as const,
        body: null,
        url: "https://api.osv.dev/v1/vulns/OSV-1?next=1",
      },
    ]) {
      await expect(transport.send(input)).rejects.toThrow();
    }
    abort.abort();
    await expect(transport.send({ ...base, body: "{}" })).rejects.toThrow();
  });
});
