import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import {
  buildP02HostArgv,
  P02_HOST_REQUEST_SCHEMA,
  p02HostProfileDigest,
  verifyP02ReadyFile,
  verifyP02FinalControl,
  validateP02HostReceipt,
  type P02HostRequest,
} from "../src/p02-host-harness.js";
import {
  buildP02OsvSystemdArgs,
  P02_OSV_HOST_SCHEMA,
  p02OsvProfileDigest,
  validateP02OsvHostConfig,
} from "../src/p02-osv-host.js";
import { scaDependencyCoordinateIdV2 } from "../src/adapters/dependency-inventory-v2.js";
import {
  validateScratchBytes,
  verifyNamespaceIdentity,
  scratchMountRecord,
  verifyScratchCapacity,
} from "../src/p02-scratch-launcher.mjs";

const H = "a".repeat(64);
const unit = `p02-${"b".repeat(32)}.service`;
const osvUnit = `p02-osv-${"b".repeat(32)}.scope`;
const launcher = fileURLToPath(new URL("../src/p02-scratch-launcher.mjs", import.meta.url));
const hostWorker = fileURLToPath(new URL("../src/p02-host-worker.mjs", import.meta.url));
const capFields = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
const sourceFiles = [{ path: "sample.txt", bytes: 6, sha256: sha256("source") }];
const controls = {
  bwrap: H,
  systemd_run: H,
  systemctl: H,
  scratch_launcher: sha256(readFileSync(launcher)),
  mount: H,
  setpriv: H,
};
const hostConfig = (): P02HostRequest => ({
  kind: "canary",
  source: {
    root: "/data/source",
    files: sourceFiles,
    total_bytes: 6,
    tree_sha256: sha256(canonicalJson(sourceFiles)),
  },
  tool_runtime: { kind: "static", executable: { path: "/opt/p02-tool", sha256: H } },
  rule: { path: "/data/rule", sha256: H },
  runtime: { path: process.execPath, sha256: H },
  closure: [],
  deployment: { path: "/data/deployment", sha256: H },
  controls: { ...controls },
  profile_sha256: H,
  workspace_parent: "/private/work",
  protected_roots: ["/private/state"],
  limits: {
    memory_bytes: 67108864,
    scratch_bytes: 1048576,
    tasks: 16,
    cpu_percent: 50,
    runtime_ms: 5000,
    output_bytes: 65536,
  },
});
const osvConfig = () => {
  const coordinate_id = scaDependencyCoordinateIdV2("npm", "approved", "1.0.0");
  return validateP02OsvHostConfig({
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
    transport_id: "offline",
    profile_id: "offline",
    profile_sha256: H,
    runtime: { path: process.execPath, sha256: H },
    closure: [],
    deployment: { path: "/data/deployment", sha256: H },
    ca: { path: "/data/ca", sha256: H },
    controls: { ...controls },
    workspace_parent: "/private/work",
    ips: ["8.8.8.8"],
    canary_ip: "9.9.9.9",
    limits: hostConfig().limits,
  });
};
const status = (privileged: boolean) =>
  [
    "Uid:\t0\t0\t0\t0",
    "Gid:\t0\t0\t0\t0",
    "NSpid:\t2",
    "NoNewPrivs:\t1",
    ...capFields.map(
      (field) => `${field}:\t${privileged ? "0000000000200100" : "0000000000000000"}`
    ),
  ].join("\n");
const mountinfo = "10 1 0:2 / /scratch rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=1024k\n";

describe("P02 scratch fail-closed contracts", () => {
  it("requires positive safe aligned limits and all three new pins in both contracts", () => {
    for (const [schema, config] of [
      [P02_HOST_REQUEST_SCHEMA, hostConfig()],
      [P02_OSV_HOST_SCHEMA, osvConfig()],
    ] as const) {
      for (const limit of [
        undefined,
        null,
        0,
        -4096,
        0.5,
        4097,
        "1048576",
        2147487744,
        Number.MAX_SAFE_INTEGER,
        NaN,
        Infinity,
      ])
        expect(() =>
          validateContract(
            schema,
            { ...config, limits: { ...config.limits, scratch_bytes: limit } },
            "scratch negative"
          )
        ).toThrow();
      for (const key of ["scratch_launcher", "mount", "setpriv"]) {
        const pins: Record<string, string> = { ...config.controls };
        delete pins[key];
        expect(() =>
          validateContract(schema, { ...config, controls: pins }, "missing pin")
        ).toThrow();
        expect(() =>
          validateContract(
            schema,
            { ...config, controls: { ...config.controls, [key]: "bad" } },
            "bad pin"
          )
        ).toThrow();
      }
    }
    for (const limit of [4096, 1048576, 2147483648])
      expect(validateScratchBytes(limit)).toBe(limit);
    for (const limit of [undefined, 0, "4096", 4097, Number.MAX_SAFE_INTEGER])
      expect(() => validateScratchBytes(limit)).toThrow();
  });
  it("binds limits and control pins through existing profile digests", () => {
    const host = hostConfig(),
      osv = osvConfig();
    const hostHash = p02HostProfileDigest(host, H, H),
      osvHash = p02OsvProfileDigest(osv, H);
    for (const key of ["scratch_launcher", "mount", "setpriv"] as const) {
      expect(
        p02HostProfileDigest(
          { ...host, controls: { ...host.controls, [key]: "c".repeat(64) } },
          H,
          H
        )
      ).not.toBe(hostHash);
      expect(
        p02OsvProfileDigest({ ...osv, controls: { ...osv.controls, [key]: "c".repeat(64) } }, H)
      ).not.toBe(osvHash);
    }
    expect(
      p02HostProfileDigest({ ...host, limits: { ...host.limits, scratch_bytes: 2097152 } }, H, H)
    ).not.toBe(hostHash);
    expect(
      p02OsvProfileDigest({ ...osv, limits: { ...osv.limits, scratch_bytes: 2097152 } }, H)
    ).not.toBe(osvHash);
  });
  it("builds only fixed privilege setup, adjacent worker, control bind and private scratch tmpfs", () => {
    for (const [root, args] of [
      ["p02", buildP02HostArgv(hostConfig(), "/private/work/job", unit)],
      ["osv", buildP02OsvSystemdArgs(osvConfig(), "/private/work/job", osvUnit)],
    ] as const) {
      expect(args.slice(args.indexOf("--uid"), args.indexOf("--uid") + 4)).toEqual([
        "--uid",
        "0",
        "--gid",
        "0",
      ]);
      expect(args.filter((_, i) => args[i - 1] === "--cap-add")).toEqual([
        "CAP_SYS_ADMIN",
        "CAP_SETPCAP",
      ]);
      expect(args.slice(args.indexOf("--bind"), args.indexOf("--bind") + 3)).toEqual([
        "--bind",
        "/private/work/job/control",
        `/${root}/control`,
      ]);
      expect(args.slice(args.indexOf("--tmpfs"), args.indexOf("--tmpfs") + 2)).toEqual([
        "--tmpfs",
        "/scratch",
      ]);
      expect(args).not.toContain("/private/work/job/scratch");
      expect(args.slice(-9)).toEqual([
        process.execPath,
        "--no-warnings",
        `/${root}/p02-scratch-launcher.mjs`,
        "1048576",
        process.execPath,
        H,
        controls.scratch_launcher,
        H,
        H,
      ]);
      expect(args).toContain("/usr/bin/mount");
      expect(args).toContain("/usr/bin/setpriv");
    }
    for (const file of ["/usr/bin/mount", "/usr/bin/setpriv"])
      expect(() =>
        buildP02HostArgv(
          { ...hostConfig(), closure: [{ path: file, sha256: H }] },
          "/private/work/job",
          unit
        )
      ).toThrow("control_collision");
  });
  it("rejects host root, wrong namespaces, excessive or missing setup caps, and any worker caps", () => {
    for (const privileged of [true, false]) {
      const good = status(privileged);
      expect(() =>
        verifyNamespaceIdentity(good, "0 1000 1", "0 1000 1", 0, 0, 2, privileged)
      ).not.toThrow();
      for (const map of ["0 0 4294967295", "0 0 1", "0 1000 2", "0 1000 1\n1 1001 1"])
        expect(() => verifyNamespaceIdentity(good, map, "0 1000 1", 0, 0, 2, privileged)).toThrow();
      for (const field of capFields)
        expect(() =>
          verifyNamespaceIdentity(
            good.replace(new RegExp(`${field}:\\t[0-9a-f]+`), `${field}:\t0000000000200101`),
            "0 1000 1",
            "0 1000 1",
            0,
            0,
            2,
            privileged
          )
        ).toThrow();
      expect(() =>
        verifyNamespaceIdentity(good, "0 1000 1", "0 0 1", 0, 0, 2, privileged)
      ).toThrow();
      expect(() =>
        verifyNamespaceIdentity(
          good.replace("NSpid:\t2", "NSpid:\t1000\t2"),
          "0 1000 1",
          "0 1000 1",
          0,
          0,
          2,
          privileged
        )
      ).toThrow();
    }
    expect(() =>
      verifyNamespaceIdentity(
        status(false).replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
        "0 1000 1",
        "0 1000 1",
        0,
        0,
        2,
        false
      )
    ).toThrow();
  });
  it("rejects fake tmpfs, incorrect capacity, extra scratch mounts and missing hardening flags", () => {
    expect(scratchMountRecord(mountinfo)).toEqual({ id: "10", device: "0:2" });
    for (const forged of [
      mountinfo.replace("tmpfs tmpfs", "ext4 /dev/sda"),
      mountinfo + mountinfo,
      mountinfo + mountinfo.replace("/scratch", "/scratch/nested"),
      ...["nosuid", "nodev", "noexec"].map((flag) => mountinfo.replace(`,${flag}`, "")),
    ])
      expect(() => scratchMountRecord(forged)).toThrow();
    const info = { type: 0x01021994n, bsize: 4096n, blocks: 256n, bavail: 256n };
    expect(verifyScratchCapacity(1048576, info)).toBe(1048576);
    for (const forged of [
      { ...info, blocks: 257n },
      { ...info, blocks: 255n },
      { ...info, type: 0n },
      { ...info, bsize: 0n },
      { ...info, bavail: 257n },
    ])
      expect(() => verifyScratchCapacity(1048576, forged)).toThrow();
  });
});

// Only local, disposable namespaces. No network endpoint, systemd service or application effect.
const probe =
  process.platform === "linux" && process.getuid?.() !== 0 && existsSync("/usr/bin/bwrap")
    ? spawnSync(
        "/usr/bin/bwrap",
        [
          "--unshare-user",
          "--uid",
          "0",
          "--gid",
          "0",
          "--unshare-pid",
          "--unshare-net",
          "--ro-bind",
          "/usr",
          "/usr",
          "--symlink",
          "usr/lib",
          "/lib",
          "--symlink",
          "usr/lib64",
          "/lib64",
          "/usr/bin/true",
        ],
        { encoding: "utf8" }
      )
    : null;
const sandboxAvailable = probe?.status === 0;
const workspaces: string[] = [];
afterEach(async () => {
  for (const work of workspaces.splice(0)) {
    await chmod(path.join(work, "source"), 0o700);
    await rm(work, { recursive: true, force: true });
  }
});
async function readonlyFile(
  work: string,
  name: string,
  content: string | Buffer,
  executable = false
) {
  const file = path.join(work, "pins", name);
  await writeFile(file, content, { mode: executable ? 0o555 : 0o444 });
  await chmod(file, executable ? 0o555 : 0o444);
  return file;
}
async function binary(work: string, name: string, source: string) {
  const file = path.join(work, "pins", name);
  await copyFile(source, file);
  await chmod(file, 0o555);
  return file;
}
function closurePaths() {
  const files = new Set<string>();
  for (const executable of [process.execPath, "/usr/bin/mount", "/usr/bin/setpriv"]) {
    const result = spawnSync("/usr/bin/ldd", [executable], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    if (result.status !== 0) throw Error(`ELF closure inspection failed: ${result.stderr}`);
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/(?:=>\s+)?(\/[^\s]+)\s+\(/);
      if (match?.[1]) files.add(match[1]);
    }
  }
  return [...files].sort();
}
const allocationProbe = (root: string) => `
import { Buffer } from 'node:buffer';
import { openSync, closeSync, readFileSync, writeFileSync, writeSync, unlinkSync, statfsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { verifyCurrentIdentity, verifyBoundedScratch } from '/${root}/p02-scratch-launcher.mjs';
verifyCurrentIdentity();
const data=JSON.parse(readFileSync('/${root}/request.json','utf8'));
verifyBoundedScratch(data.scratch_bytes);
const size=Number(statfsSync('/scratch').bsize), block=Buffer.alloc(size,42);
let bytes=0, error=null;
const fd=openSync('/scratch/allocation','wx',0o600);
try { while(bytes <= data.scratch_bytes) bytes+=writeSync(fd,block); } catch(e) {error=e.code;} finally {closeSync(fd);}
if(error !== 'ENOSPC' || bytes > data.scratch_bytes || bytes < data.scratch_bytes / 2) throw Error('allocation_not_bounded');
unlinkSync('/scratch/allocation');
writeFileSync('/scratch/under-limit',block,{flag:'wx',mode:0o600});
if(readFileSync('/scratch/under-limit').length !== size) throw Error('under_limit');
unlinkSync('/scratch/under-limit');
const enlarge=spawnSync('/usr/bin/mount',['-n','-o','remount,size=2097152','/scratch'],{stdio:'ignore'});
if(enlarge.status===0) throw Error('worker_can_remount');
verifyBoundedScratch(data.scratch_bytes);
writeFileSync('/scratch/noexec','#!/usr/bin/node\\n',{flag:'wx',mode:0o700});
if(spawnSync('/scratch/noexec').error?.code !== 'EACCES') throw Error('noexec');
unlinkSync('/scratch/noexec');
const report={capacity:data.scratch_bytes,allocated:bytes,error,under_limit:true,caps_zero:true,no_new_privileges:true};
${root === "osv" ? "report.stdin=readFileSync(0,'utf8');" : ""}
${root === "p02" ? "process.stdout.write(JSON.stringify(report));" : "writeFileSync('/osv/control/allocation.json',JSON.stringify(report),{flag:'wx',mode:0o600});"}
`;
async function sandbox(root: "p02" | "osv", actualHost = false) {
  const work = await mkdtemp(path.join(tmpdir(), "penny-scratch-test-"));
  workspaces.push(work);
  await mkdir(path.join(work, "pins"), { mode: 0o700 });
  await mkdir(path.join(work, "control"), { mode: 0o700 });
  const libs = closurePaths();
  const runtimeFiles = [process.execPath, "/usr/bin/mount", "/usr/bin/setpriv", ...libs];
  for (const [index, file] of runtimeFiles.entries()) await binary(work, String(index), file);
  const workerName = root === "p02" ? "p02-host-worker.mjs" : "p02-osv-worker.mjs";
  await readonlyFile(work, "scratch-launcher", await readFile(launcher));
  const worker = await readonlyFile(
    work,
    "worker",
    actualHost ? await readFile(hostWorker) : allocationProbe(root)
  );
  const tool = await readonlyFile(
    work,
    String(runtimeFiles.length),
    `#!${process.execPath}\n${allocationProbe("p02")}`,
    true
  );
  await readonlyFile(work, "launcher", "harness");
  await readonlyFile(work, "deployment", "deployment");
  await readonlyFile(work, "rule", "rule");
  await readonlyFile(work, "ca", "ca");
  await mkdir(path.join(work, "source"), { mode: 0o700 });
  await writeFile(path.join(work, "source/sample.txt"), "source", { mode: 0o444 });
  await chmod(path.join(work, "source"), 0o555);
  await writeFile(
    path.join(work, "tree.json"),
    canonicalJson({ ...hostConfig().source, root: "/input/source" }) + "\n",
    { mode: 0o444 }
  );
  const c = {
    ...controls,
    mount: sha256(await readFile("/usr/bin/mount")),
    setpriv: sha256(await readFile("/usr/bin/setpriv")),
  };
  const nodeSha = sha256(await readFile(process.execPath)),
    workerSha = sha256(await readFile(worker));
  const setup = {
    scratch_bytes: 1048576,
    scratch_launcher_sha256: c.scratch_launcher,
    mount_sha256: c.mount,
    setpriv_sha256: c.setpriv,
    node_path: process.execPath,
    node_sha256: nodeSha,
  };
  const payload = {
    version: 1 as const,
    kind: "gitleaks",
    nonce: H,
    unit: root === "p02" ? unit : osvUnit,
    plan_sha256: H,
    worker_sha256: workerSha,
    launcher_sha256: sha256("harness"),
    profile_sha256: H,
    deployment_sha256: sha256("deployment"),
    source_sha256: hostConfig().source.tree_sha256,
    tool_sha256: sha256(await readFile(tool)),
    runtime_sha256: H,
    tool_path: "/opt/p02-tool",
    process_timeout_ms: 4500,
    rule_sha256: sha256("rule"),
    ...setup,
  };
  const data = { ...payload, request_sha256: sha256(canonicalJson(payload)) };
  await writeFile(path.join(work, "request.json"), canonicalJson(data) + "\n", { mode: 0o444 });
  let args: string[];
  if (root === "p02") {
    const config = {
      ...hostConfig(),
      kind: "gitleaks",
      runtime: { path: process.execPath, sha256: nodeSha },
      controls: c,
      closure: libs.map((file) => ({ path: file, sha256: H })),
    };
    const full = buildP02HostArgv(config, work, unit);
    args = full.slice(full.indexOf("/usr/bin/bwrap") + 1);
  } else {
    const config = {
      ...osvConfig(),
      runtime: { path: process.execPath, sha256: nodeSha },
      controls: c,
      closure: libs.map((file) => ({ path: file, sha256: H })),
    };
    const full = buildP02OsvSystemdArgs(config, work, osvUnit);
    args = full.slice(full.indexOf("/usr/bin/bwrap") + 1);
  }
  return { work, args, data, workerName };
}
function runSync(args: string[], fd?: number) {
  return spawnSync("/usr/bin/bwrap", args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 8000,
    stdio: fd === undefined ? ["ignore", "pipe", "pipe"] : [fd, "pipe", "pipe"],
  });
}

describe.skipIf(!sandboxAvailable)(
  "kernel-enforced scratch capacity (offline rootless bwrap)",
  () => {
    it("runs the real P02 host worker with zero caps, ENOSPC allocation, under-limit success and parent-visible gate/receipt", async () => {
      const { work, args, data } = await sandbox("p02", true);
      const child = spawn("/usr/bin/bwrap", args, {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      const exit = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      const kill = setTimeout(() => child.kill("SIGKILL"), 8000);
      try {
        for (let attempts = 0; attempts < 200; attempts++) {
          if (await verifyP02ReadyFile(path.join(work, "control/ready"), data.request_sha256))
            break;
          if (child.exitCode !== null)
            throw Error(
              `worker exited before ready: ${errors} ${await readFile(path.join(work, "control/failure.json"), "utf8").catch(() => "")}`
            );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(
          await verifyP02ReadyFile(path.join(work, "control/ready"), data.request_sha256)
        ).toBe(true);
        await writeFile(path.join(work, "control/go"), "ok\n", { flag: "wx", mode: 0o600 });
        expect(await exit, errors).toBe(0);
        await verifyP02FinalControl(path.join(work, "control"), "gitleaks");
        const bytes = await readFile(path.join(work, "control/receipt.json"));
        const receipt = validateP02HostReceipt(bytes, 65536, {
          kind: "gitleaks",
          version: data.version,
          nonce: data.nonce,
          unit: data.unit,
          plan_sha256: data.plan_sha256,
          worker_sha256: data.worker_sha256,
          launcher_sha256: data.launcher_sha256,
          profile_sha256: data.profile_sha256,
          deployment_sha256: data.deployment_sha256,
          source_sha256: data.source_sha256,
          tool_sha256: data.tool_sha256,
          runtime_sha256: data.runtime_sha256,
          rule_sha256: data.rule_sha256,
          scratch_bytes: data.scratch_bytes,
          request_sha256: data.request_sha256,
        });
        expect(receipt.status).toBe("passed");
        expect(receipt.checks.identity).toBe(true);
        expect(receipt.checks.scratch).toBe(true);
        expect(receipt.process?.exit_code).toBe(0);
        expect(JSON.parse(receipt.process?.stdout ?? "null")).toMatchObject({
          capacity: 1048576,
          error: "ENOSPC",
          under_limit: true,
          caps_zero: true,
        });
        expect(existsSync(path.join(work, "scratch"))).toBe(false);
      } finally {
        clearTimeout(kill);
        child.kill("SIGKILL");
        await exit;
      }
    }, 12000);
    it("uses the OSV adjacent-worker path, retains the stdin descriptor grant through exec/setpriv and keeps control parent-visible", async () => {
      const { work, args } = await sandbox("osv");
      const fdPath = path.join(work, "stdin");
      await writeFile(fdPath, "offline-stdin");
      const fd = await open(fdPath);
      try {
        const result = runSync(args, fd.fd);
        expect(result.status, result.stderr).toBe(0);
        const report: unknown = JSON.parse(
          await readFile(path.join(work, "control/allocation.json"), "utf8")
        );
        expect(report).toMatchObject({
          capacity: 1048576,
          allocated: 1048576,
          error: "ENOSPC",
          under_limit: true,
          caps_zero: true,
          no_new_privileges: true,
          stdin: "offline-stdin",
        });
        expect(existsSync(path.join(work, "scratch"))).toBe(false);
      } finally {
        await fd.close();
      }
    });
    it.each([
      "scratch_bytes",
      "scratch_launcher_sha256",
      "mount_sha256",
      "setpriv_sha256",
      "node_sha256",
      "worker_sha256",
    ] as const)("rejects drifted %s before worker execution", async (field) => {
      const { work, args, data } = await sandbox("osv");
      const changed = { ...data, [field]: field === "scratch_bytes" ? 2097152 : "c".repeat(64) };
      await chmod(path.join(work, "request.json"), 0o600);
      await writeFile(path.join(work, "request.json"), canonicalJson(changed) + "\n");
      await chmod(path.join(work, "request.json"), 0o444);
      const result = runSync(args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/scratch_(request_binding|pin_drift)/);
      expect(existsSync(path.join(work, "control/allocation.json"))).toBe(false);
    });
    it.each([
      "scratch_bytes",
      "mount_sha256",
      "setpriv_sha256",
      "scratch_launcher_sha256",
    ] as const)("rejects missing %s before worker execution", async (field) => {
      const { work, args, data } = await sandbox("osv");
      const changed: Record<string, unknown> = { ...data };
      delete changed[field];
      await chmod(path.join(work, "request.json"), 0o600);
      await writeFile(path.join(work, "request.json"), canonicalJson(changed) + "\n");
      await chmod(path.join(work, "request.json"), 0o444);
      const result = runSync(args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("scratch_request_binding");
      expect(existsSync(path.join(work, "control/allocation.json"))).toBe(false);
    });
    it.each(["scratch-launcher", "1", "2"])(
      "rejects actual staged %s bytes drifting from the pinned digest",
      async (name) => {
        const { work, args } = await sandbox("osv");
        const file = path.join(work, "pins", name);
        await chmod(file, 0o644);
        await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("\n")]));
        await chmod(file, 0o555);
        const result = runSync(args);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("scratch_pin_drift");
        expect(existsSync(path.join(work, "control/allocation.json"))).toBe(false);
      }
    );
    it("refuses a renamed adjacent worker instead of finding or substituting another script", async () => {
      const { work, args } = await sandbox("osv");
      const renamed = args.map((arg) =>
        arg === "/osv/p02-osv-worker.mjs" ? "/osv/worker.mjs" : arg
      );
      const result = runSync(renamed);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("scratch_setup_failed");
      expect(existsSync(path.join(work, "control/allocation.json"))).toBe(false);
    });
    it("rejects non-tmpfs scratch and extra capabilities rather than launching a worker", async () => {
      const { work, args } = await sandbox("osv");
      const index = args.indexOf("--tmpfs");
      const notTmpfs = [...args];
      notTmpfs.splice(index, 2, "--bind", path.join(work, "control"), "/scratch");
      const result = runSync(notTmpfs);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("scratch_tmpfs");
      const excessive = [...args];
      excessive.splice(excessive.indexOf("--clearenv"), 0, "--cap-add", "CAP_NET_ADMIN");
      const extra = runSync(excessive);
      expect(extra.status).not.toBe(0);
      expect(extra.stderr).toContain("scratch_capabilities");
      expect(existsSync(path.join(work, "control/allocation.json"))).toBe(false);
    });
    it("rejects arbitrary command arguments, wrong Node selection and drifted worker bytes", async () => {
      const { work, args } = await sandbox("osv");
      const arbitrary = runSync([...args, "/usr/bin/true"]);
      expect(arbitrary.status).not.toBe(0);
      expect(arbitrary.stderr).toContain("scratch_invocation");
      const changedNode = [...args];
      changedNode[changedNode.length - 5] = "/not-the-current-node";
      const drifted = runSync(changedNode);
      expect(drifted.status).not.toBe(0);
      expect(drifted.stderr).toContain("scratch_node_drift");
      await chmod(path.join(work, "pins/worker"), 0o644);
      await writeFile(path.join(work, "pins/worker"), "// drift\n");
      await chmod(path.join(work, "pins/worker"), 0o444);
      const missing = runSync(args);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("scratch_pin_drift");
      expect(existsSync(path.join(work, "control/allocation.json"))).toBe(false);
    });
  }
);
