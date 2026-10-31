// Fixed P02 offline child. Only Node built-ins here; inventory imports one pinned, read-only bundle at a fixed sandbox path.
import { verifyCurrentIdentity, verifyBoundedScratch } from "./p02-scratch-launcher.mjs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, createReadStream, mkdirSync, rmSync } from "node:fs";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { open, readFile, lstat, writeFile, stat, unlink, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve4 } from "node:dns/promises";

const canon = (value) =>
  JSON.stringify(value, (_key, child) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b)))
      : child
  );
const hash = (value) => createHash("sha256").update(value).digest("hex");
const hashFile = async (filename, maxBytes) => {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename, { highWaterMark: 65536 })) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Error("file bounds");
    digest.update(chunk);
  }
  return { sha256: digest.digest("hex"), bytes };
};
const hex = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const keys = (value, expected) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === expected.sort().join("|");
const denial = async (file) => {
  try {
    const fd = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
    await fd.close();
    return false;
  } catch (e) {
    return ["EROFS", "EACCES", "EPERM"].includes(e?.code);
  }
};
const absent = async (file) => {
  try {
    await lstat(file);
    return false;
  } catch (e) {
    return e?.code === "ENOENT";
  }
};
const tcpDenied = () =>
  new Promise((resolve) => {
    const socket = connect({ host: "198.51.100.1", port: 443 });
    let done = false;
    const finish = (blocked) => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve(blocked);
      }
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (error) =>
      finish(["ENETUNREACH", "EHOSTUNREACH", "EACCES", "EPERM"].includes(error.code))
    );
    socket.setTimeout(500, () => finish(false));
  });
const dnsDenied = async () => {
  try {
    await Promise.race([
      resolve4("example.invalid"),
      new Promise((_, reject) => setTimeout(() => reject(Error("timeout")), 500)),
    ]);
    return false;
  } catch (error) {
    return (
      error?.code === "ECONNREFUSED" ||
      error?.code === "ENETUNREACH" ||
      error?.code === "EACCES" ||
      error?.code === "ETIMEOUT"
    );
  }
};
// A bounded, one-shot handshake; neither a missing nor a forged go file authorizes work.
const gateFile = async (file, expected) => {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await fd.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size !== Buffer.byteLength(expected) ||
      (await fd.readFile("utf8")) !== expected
    )
      throw Error("gate_file");
    const after = await fd.stat();
    const named = await lstat(file);
    if (
      after.ino !== info.ino ||
      after.dev !== info.dev ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.nlink !== 1 ||
      named.ino !== info.ino ||
      named.dev !== info.dev ||
      !named.isFile() ||
      named.size !== info.size ||
      named.mtimeMs !== info.mtimeMs ||
      named.nlink !== 1 ||
      (named.mode & 0o777) !== 0o600
    )
      throw Error("gate_file");
  } finally {
    await fd.close();
  }
};
export const waitForGo = async (ms, control = "/p02/control") => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await gateFile(`${control}/go`, "ok\n");
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error("gate_timeout");
};
const childBounded = () =>
  new Promise((resolve) => {
    const marker = "/scratch/child-canary";
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        `require('node:fs').writeFileSync('${marker}','p02-fixed-canary',{flag:'wx',mode:0o600})`,
      ],
      { shell: false, env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" }
    );
    let done = false;
    const finish = async (passed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const content = await readFile(marker, "utf8").catch(() => "");
      await unlink(marker).catch(() => {});
      resolve(passed && content === "p02-fixed-canary");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      void finish(false);
    }, 1_000);
    child.on("error", () => void finish(false));
    child.on("close", (code) => void finish(code === 0));
  });

// The only scanner grammar. No request-supplied argv, env, cwd, URL, or configuration path.
export function scannerArguments(kind) {
  if (kind === "gitleaks")
    return [
      "dir",
      ".",
      "--config",
      "/input/rule",
      "--no-banner",
      "--redact",
      "--report-format",
      "json",
      "--report-path",
      "-",
      "--exit-code",
      "1",
    ];
  if (kind === "semgrep_php" || kind === "semgrep_js_ts")
    return [
      "scan",
      "--json",
      "--error",
      "--metrics=off",
      "--disable-version-check",
      "--no-git-ignore",
      "--x-ignore-semgrepignore-files",
      "--no-rewrite-rule-ids",
      "--config",
      "/input/rule",
      "--",
      ".",
    ];
  throw Error("scanner kind");
}
const runScanner = (req) =>
  new Promise((resolve) => {
    const isSemgrep = req.kind !== "gitleaks";
    const scannerScratch = "/scratch/scanner";
    const scannerHome = `${scannerScratch}/home`;
    const scannerTmp = `${scannerScratch}/tmp`;
    mkdirSync(scannerHome, { recursive: true, mode: 0o700 });
    mkdirSync(scannerTmp, { recursive: true, mode: 0o700 });
    const env = isSemgrep
      ? {
          HOME: scannerHome,
          PATH: "/usr/bin:/bin",
          SEMGREP_ENABLE_VERSION_CHECK: "0",
          SEMGREP_SEND_METRICS: "off",
          TMPDIR: scannerTmp,
          LC_ALL: "C",
        }
      : {
          HOME: "/nonexistent",
          PATH: "/usr/bin:/bin",
          TMPDIR: scannerTmp,
          LC_ALL: "C",
          GOMAXPROCS: "1",
        };
    const out = [Buffer.alloc(0), Buffer.alloc(0)];
    const truncated = [false, false];
    let forced = null;
    let closed = false;
    const child = spawn(req.tool_path, scannerArguments(req.kind), {
      cwd: "/input/source",
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminate = (why) => {
      if (forced === null) forced = why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => terminate("timed_out"), req.process_timeout_ms);
    for (const [i, stream] of [child.stdout, child.stderr].entries())
      stream.on("data", (chunk) => {
        const remaining = 4096 - out[i].length;
        out[i] = Buffer.concat([out[i], chunk.subarray(0, Math.max(0, remaining))]);
        if (chunk.length > remaining) {
          truncated[i] = true;
          terminate("output_limit");
        }
      });
    const finish = (code, sig) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      const status =
        forced ?? (code === 0 ? "succeeded" : code === null ? "spawn_failed" : "nonzero_exit");
      const failure = status === "succeeded" ? "none" : status === "timed_out" ? "timeout" : status;
      // Invalid UTF-8 or a truncated multi-byte character cannot be represented in the text process protocol.
      let stdout, stderr;
      try {
        stdout = new TextDecoder("utf-8", { fatal: true }).decode(out[0]);
        stderr = new TextDecoder("utf-8", { fatal: true }).decode(out[1]);
      } catch {
        stdout = "";
        stderr = "";
        truncated[0] = true;
        truncated[1] = true;
      }
      rmSync(scannerScratch, { recursive: true, force: true });
      resolve({
        schema_id: "penny.sca-process-result.v1",
        schema_version: 1,
        request_sha256: hash(
          canon({ plan_sha256: req.plan_sha256, nonce: req.nonce, kind: req.kind })
        ),
        status: truncated.some(Boolean) ? "output_limit" : status,
        exit_code: code,
        signal: sig,
        stdout,
        stderr,
        stdout_sha256: hash(stdout),
        stderr_sha256: hash(stderr),
        stdout_bytes: Buffer.byteLength(stdout),
        stderr_bytes: Buffer.byteLength(stderr),
        stdout_truncated: truncated[0],
        stderr_truncated: truncated[1],
        failure_code: truncated.some(Boolean) ? "output_limit" : failure,
      });
    };
    child.once("error", () => finish(null, null));
    child.once("close", finish);
  });

let stage = "start";
const mark = async (value) => {
  stage = value;
  await writeFile("/p02/control/stage", value, { flag: "w", mode: 0o600 });
};
const main = async () => {
  verifyCurrentIdentity();
  await mark("request");
  const unit = process.argv[2];
  if (process.argv.length !== 3 || process.execArgv.join("|") !== "--no-warnings")
    throw Error("worker invocation");
  const bytes = await readFile("/p02/request.json");
  if (bytes.length > 4096) throw Error("request bounds");
  const req = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !keys(req, [
      "version",
      "kind",
      "nonce",
      "unit",
      "worker_sha256",
      "launcher_sha256",
      "profile_sha256",
      "deployment_sha256",
      "source_sha256",
      "rule_sha256",
      "request_sha256",
      "plan_sha256",
      "tool_sha256",
      "runtime_sha256",
      "tool_path",
      "process_timeout_ms",
      "scratch_bytes",
      "scratch_launcher_sha256",
      "mount_sha256",
      "setpriv_sha256",
      "node_path",
      "node_sha256",
    ]) ||
    canon(req) + "\n" !== bytes.toString() ||
    req.version !== 1 ||
    req.unit !== unit ||
    !/^p02-[a-f0-9]{32}\.service$/.test(unit) ||
    !["canary", "canary_hold", "inventory", "semgrep_php", "semgrep_js_ts", "gitleaks"].includes(
      req.kind
    ) ||
    ![
      req.nonce,
      req.worker_sha256,
      req.launcher_sha256,
      req.profile_sha256,
      req.deployment_sha256,
      req.source_sha256,
      req.rule_sha256,
      req.request_sha256,
      req.plan_sha256,
      req.tool_sha256,
      req.runtime_sha256,
      req.scratch_launcher_sha256,
      req.mount_sha256,
      req.setpriv_sha256,
      req.node_sha256,
    ].every(hex)
  )
    throw Error("request");
  if (
    !Number.isInteger(req.process_timeout_ms) ||
    req.process_timeout_ms < 500 ||
    req.process_timeout_ms > 120000 ||
    typeof req.tool_path !== "string" ||
    !req.tool_path.startsWith("/") ||
    req.tool_path.includes("..") ||
    req.tool_path.includes("\0")
  )
    throw Error("request");
  verifyBoundedScratch(req.scratch_bytes);
  if (process.execPath !== req.node_path) throw Error("node drift");
  await mark("binding");
  const { request_sha256, ...payload } = req;
  if (
    hash(canon(payload)) !== request_sha256 ||
    (await hashFile("/p02/p02-host-worker.mjs", 134217728)).sha256 !== req.worker_sha256 ||
    (await hashFile("/p02/launcher", 134217728)).sha256 !== req.launcher_sha256 ||
    (await hashFile("/p02/deployment", 134217728)).sha256 !== req.deployment_sha256 ||
    (await hashFile("/p02/p02-scratch-launcher.mjs", 134217728)).sha256 !==
      req.scratch_launcher_sha256 ||
    (await hashFile(process.execPath, 134217728)).sha256 !== req.node_sha256
  )
    throw Error("binding");
  await mark("checks");
  const checks = {
    input: false,
    readonly: false,
    scratch: false,
    forbidden: false,
    network: false,
    namespace: false,
    identity: false,
  };
  const treeBytes = await readFile("/p02/tree.json");
  if (treeBytes.length > 32768) throw Error("tree bounds");
  const tree = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(treeBytes));
  if (
    canon(tree) + "\n" !== treeBytes.toString() ||
    tree.root !== "/input/source" ||
    !Array.isArray(tree.files) ||
    tree.files.length < 1 ||
    tree.files.length > 256 ||
    hash(canon(tree.files)) !== req.source_sha256 ||
    tree.tree_sha256 !== req.source_sha256
  )
    throw Error("tree");
  const verifyInput = async () => {
    const files = new Set();
    const dirs = new Set();
    let total = 0;
    for (const item of tree.files) {
      if (
        typeof item.path !== "string" ||
        item.path.startsWith("/") ||
        item.path.split("/").some((x) => !x || x === "." || x === "..")
      )
        return false;
      files.add(item.path);
      const parts = item.path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      if (!Number.isInteger(item.bytes) || item.bytes < 0 || item.bytes > 16777216) return false;
      const measured = await hashFile(`/input/source/${item.path}`, item.bytes);
      if (measured.bytes !== item.bytes || measured.sha256 !== item.sha256) return false;
      total += measured.bytes;
    }
    const walk = async (rel) => {
      for (const entry of await readdir(`/input/source/${rel}`, { withFileTypes: true })) {
        const name = rel ? `${rel}/${entry.name}` : entry.name;
        if (dirs.has(name) && entry.isDirectory()) {
          if (!(await walk(name))) return false;
        } else if (!files.has(name) || !entry.isFile()) return false;
      }
      return true;
    };
    return total === tree.total_bytes && files.size === tree.files.length && (await walk(""));
  };
  checks.input =
    (await verifyInput()) &&
    (await hashFile("/input/rule", 134217728)).sha256 === req.rule_sha256 &&
    (await hashFile(req.tool_path, 536870912)).sha256 === req.tool_sha256;
  checks.readonly =
    (await denial(`/input/source/${tree.files[0].path}`)) &&
    (await denial(req.tool_path)) &&
    (await denial("/input/rule")) &&
    (await denial("/p02/request.json")) &&
    (await denial("/p02/tree.json")) &&
    (await denial("/p02/p02-host-worker.mjs")) &&
    (await denial("/p02/launcher")) &&
    (await denial("/p02/deployment")) &&
    (req.kind !== "inventory" ||
      ((await denial("/opt/p02-inventory/worker.mjs")) &&
        (await denial("/p02/indexer-source")) &&
        (await denial("/opt/p02-inventory/node_modules/tree-sitter/package.json"))));
  checks.forbidden = (
    await Promise.all(
      ["/run/user", "/var/lib", "/sys", "/workspace", "/root", "/etc/passwd"].map(absent)
    )
  ).every(Boolean);
  const status = await readFile("/proc/self/status", "utf8");
  const cgroup = await readFile("/proc/self/cgroup", "utf8");
  const uidMap = await readFile("/proc/self/uid_map", "utf8");
  const uid = process.getuid();
  const uidMapFields = uidMap.trim().split(/\s+/u).map(Number);
  checks.identity =
    Number.isSafeInteger(uid) &&
    uid >= 0 &&
    process.pid >= 1 &&
    new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, "m").test(status) &&
    /^NoNewPrivs:\s+1$/m.test(status) &&
    /^CapEff:\s+0{16}$/m.test(status) &&
    new RegExp(`^NSpid:\\s+${process.pid}$`, "m").test(status) &&
    uidMapFields.length === 3 &&
    uidMapFields[0] === uid &&
    Number.isSafeInteger(uidMapFields[1]) &&
    uidMapFields[1] >= 0 &&
    uidMapFields[2] === 1;
  // Cgroup namespace intentionally hides the host unit path. Host verifies ControlGroup independently.
  const ipv4 = await readFile("/proc/net/route", "utf8");
  const devices = await readFile("/proc/net/dev", "utf8");
  const interfaces = devices
    .split("\n")
    .slice(2)
    .map((line) => line.split(":", 1)[0]?.trim())
    .filter(Boolean);
  checks.namespace =
    cgroup.trim() === "0::/" &&
    interfaces.length === 1 &&
    interfaces[0] === "lo" &&
    ipv4
      .split("\n")
      .slice(1)
      .every((line) => !/\s00000000\s/.test(line));
  await mark("network");
  checks.network = (await tcpDenied()) && (await dnsDenied());
  if (
    ![
      checks.input,
      checks.readonly,
      checks.forbidden,
      checks.identity,
      checks.namespace,
      checks.network,
    ].every(Boolean)
  )
    throw Error("containment");
  await mark("gate");
  await writeFile("/p02/control/ready", `${req.request_sha256}\n`, { flag: "wx", mode: 0o600 });
  await waitForGo(req.process_timeout_ms + 500);
  await gateFile("/p02/control/ready", `${req.request_sha256}\n`);
  await unlink("/p02/control/ready");
  await unlink("/p02/control/go");
  // Qualification-only fixed delay to exercise real cancellation and RuntimeMaxSec.
  if (req.kind === "canary_hold") await new Promise((resolve) => setTimeout(resolve, 60_000));
  await mark("child");
  const canary = req.kind === "canary" ? await childBounded() : true;
  await writeFile("/scratch/probe", "p02-scratch", { flag: "wx", mode: 0o600 });
  checks.scratch =
    verifyBoundedScratch(req.scratch_bytes) === req.scratch_bytes &&
    (await readFile("/scratch/probe", "utf8")) === "p02-scratch" &&
    (await stat("/scratch")).isDirectory();
  if (checks.scratch)
    await writeFile("/p02/control/probe", "p02-scratch", { flag: "wx", mode: 0o600 });
  if (req.kind === "inventory" && Object.values(checks).every(Boolean)) {
    const envelopeBytes = await readFile("/input/rule");
    if (envelopeBytes.length > 90_000_000 || hash(envelopeBytes) !== req.rule_sha256)
      throw Error("inventory input");
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelopeBytes));
    if (
      canon(envelope) + "\n" !== envelopeBytes.toString() ||
      !hex(envelope.operation_request_sha256) ||
      !hex(envelope.source_manifest_sha256) ||
      !hex(envelope.source_tree_sha256) ||
      !Array.isArray(envelope.input?.files) ||
      hash(
        canon(
          tree.files.map((f) => ({ path: f.path, byte_count: f.bytes, content_sha256: f.sha256 }))
        )
      ) !== envelope.source_tree_sha256 ||
      envelope.input.files.some(
        (f) =>
          !tree.files.some(
            (item) =>
              item.path === f.path &&
              item.sha256 === f.source_sha256 &&
              item.bytes === f.byte_count &&
              Buffer.from(f.content_base64, "base64").toString("base64") === f.content_base64 &&
              hash(Buffer.from(f.content_base64, "base64")) === f.source_sha256
          )
      )
    )
      throw Error("inventory custody");
    const { runP02InventoryWorker } = await import("/opt/p02-inventory/worker.mjs");
    await runP02InventoryWorker();
  }
  const inventoryResultSha =
    req.kind === "inventory" ? (await hashFile("/p02/control/inventory.json", 65536)).sha256 : null;
  const processResult =
    ["semgrep_php", "semgrep_js_ts", "gitleaks"].includes(req.kind) &&
    Object.values(checks).every(Boolean)
      ? await runScanner(req)
      : null;
  verifyCurrentIdentity();
  verifyBoundedScratch(req.scratch_bytes);
  checks.input &&= await verifyInput();
  checks.input &&=
    (await hashFile("/input/rule", 134217728)).sha256 === req.rule_sha256 &&
    (await hashFile(req.tool_path, 536870912)).sha256 === req.tool_sha256;
  const statusCode =
    req.kind !== "canary_hold" &&
    Object.values(checks).every(Boolean) &&
    canary &&
    (processResult === null || processResult.status !== "spawn_failed")
      ? "passed"
      : "failed";
  const output_sha256 = hash(
    canon({
      status: statusCode,
      checks,
      nonce: req.nonce,
      process: processResult,
      inventory_result_sha256: inventoryResultSha,
    })
  );
  const receipt = {
    ...Object.fromEntries(
      Object.entries(req).filter(
        ([key]) =>
          ![
            "tool_path",
            "process_timeout_ms",
            "scratch_launcher_sha256",
            "mount_sha256",
            "setpriv_sha256",
            "node_path",
            "node_sha256",
          ].includes(key)
      )
    ),
    status: statusCode,
    checks,
    process: processResult,
    inventory_result_sha256: inventoryResultSha,
    output_sha256,
  };
  await writeFile("/p02/control/receipt.json", canon(receipt) + "\n", { flag: "wx", mode: 0o600 });
  await mark("complete");
  await unlink("/p02/control/stage");
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(async () => {
    await writeFile("/p02/control/failure.json", canon({ status: "failed", stage }) + "\n", {
      flag: "wx",
      mode: 0o600,
    }).catch(() => {});
    process.exitCode = 1;
  });
