// Standalone Node built-ins-only OSV worker. This file is copied byte-for-byte by the build.
import {
  verifyCurrentIdentity,
  verifyBoundedScratch,
  verifyPinnedFile,
} from "./p02-scratch-launcher.mjs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { request as httpsRequest, Agent } from "node:https";
import { connect, isIP, Socket } from "node:net";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { connect as tlsConnect } from "node:tls";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Receipts use a fixed flat shape; request JSON is already canonicalized and hashed by the parent.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (file, ms, expected) => {
  const end = Date.now() + ms;
  for (;;) {
    let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(fd);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 ||
        before.size !== Buffer.byteLength(expected) ||
        readFileSync(fd, "utf8") !== expected
      )
        throw Error("gate_binding");
      const named = lstatSync(file);
      if (
        named.ino !== before.ino ||
        named.dev !== before.dev ||
        named.size !== before.size ||
        named.mtimeMs !== before.mtimeMs ||
        named.nlink !== 1 ||
        !named.isFile() ||
        (named.mode & 0o777) !== 0o600
      )
        throw Error("gate_drift");
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (Date.now() >= end) throw Error("gate_timeout");
    await pause(20);
  }
};
verifyCurrentIdentity();
if (process.argv.length !== 2 || process.execArgv.join("|") !== "--no-warnings")
  throw Error("worker_invocation");
const input = readFileSync("/osv/request.json");
const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
const expectedKeys = [
  "nonce",
  "unit",
  "url",
  "method",
  "request_body",
  "advisory_id",
  "coordinate_ids",
  "body_sha256",
  "plan_sha256",
  "mapping_sha256",
  "worker_sha256",
  "deployment_sha256",
  "runtime_sha256",
  "ca_sha256",
  "ips",
  "ip",
  "kernel_peer_port",
  "canary_ip",
  "max_response_bytes",
  "timeout_ms",
  "scratch_bytes",
  "scratch_launcher_sha256",
  "mount_sha256",
  "setpriv_sha256",
  "node_path",
  "node_sha256",
];
if (
  input.length > 16777216 ||
  !data ||
  Object.keys(data).sort().join("|") !== expectedKeys.sort().join("|") ||
  process.execPath !== data.node_path ||
  !/^p02-osv-[a-f0-9]{32}\.scope$/.test(data.unit)
)
  throw Error("invalid_worker_request");
const scratchCapacity = verifyBoundedScratch(data.scratch_bytes);
const osvId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const coordinateId = /^depcoord_[a-f0-9]{64}$/;
let queries = null;
if (data.method === "POST") {
  const parsed = JSON.parse(data.request_body);
  queries = parsed.queries;
  if (
    Object.keys(parsed).join() !== "queries" ||
    !Array.isArray(queries) ||
    queries.length < 1 ||
    queries.length > 128 ||
    !Array.isArray(data.coordinate_ids) ||
    data.coordinate_ids.length !== queries.length ||
    data.coordinate_ids.some((id) => !coordinateId.test(id)) ||
    queries.some(
      (query) =>
        !query ||
        Object.keys(query).join() !== "package,version" ||
        !query.package ||
        Object.keys(query.package).join() !== "ecosystem,name" ||
        !["npm", "Packagist"].includes(query.package.ecosystem) ||
        typeof query.package.name !== "string" ||
        query.package.name.length < 1 ||
        query.package.name.length > 4096 ||
        typeof query.version !== "string" ||
        query.version.length < 1 ||
        query.version.length > 4096
    ) ||
    JSON.stringify({ queries }) !== data.request_body ||
    Buffer.byteLength(data.request_body) > 8388608
  )
    throw Error("invalid_worker_request");
} else if (
  data.method === "GET" &&
  (!osvId.test(data.advisory_id) ||
    !Array.isArray(data.coordinate_ids) ||
    data.coordinate_ids.length !== 0)
)
  throw Error("invalid_worker_request");
if (
  hash(Buffer.from(data.request_body ?? "", "utf8")) !== data.body_sha256 ||
  data.url !==
    (data.method === "POST"
      ? "https://api.osv.dev/v1/querybatch"
      : `https://api.osv.dev/v1/vulns/${encodeURIComponent(data.advisory_id)}`) ||
  !["POST", "GET"].includes(data.method) ||
  (data.method === "GET" && data.request_body !== null) ||
  !Array.isArray(data.ips) ||
  data.ips.length < 1 ||
  data.ips.length > 8 ||
  data.ips[0] !== data.ip ||
  data.kernel_peer_port !== 443 ||
  !isIP(data.ip) ||
  !isIP(data.canary_ip) ||
  data.ips.includes(data.canary_ip) ||
  !Number.isSafeInteger(data.max_response_bytes) ||
  data.max_response_bytes < 1 ||
  data.max_response_bytes > 134217728 ||
  !Number.isSafeInteger(data.timeout_ms) ||
  data.timeout_ms < 1 ||
  data.timeout_ms > 300000
)
  throw Error("invalid_worker_request");
const ca = readFileSync("/osv/ca.pem");
if (hash(ca) !== data.ca_sha256) throw Error("ca_drift");
const worker = readFileSync("/osv/p02-osv-worker.mjs");
if (
  hash(worker) !== data.worker_sha256 ||
  hash(readFileSync("/osv/p02-scratch-launcher.mjs")) !== data.scratch_launcher_sha256 ||
  hash(readFileSync("/osv/deployment")) !== data.deployment_sha256
)
  throw Error("worker_drift");
verifyPinnedFile(process.execPath, data.node_sha256);
let phase = "pre_send";
let code = "none";
let status = null;
let body = null;
const deniedCanary = () =>
  new Promise((resolve) => {
    const socket = connect({ host: data.canary_ip, port: 443, timeout: 1500 });
    socket.once("error", (error) => {
      socket.destroy();
      resolve({
        denied: ["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "EACCES", "EPERM"].includes(
          error.code
        ),
        code: error.code ?? "UNKNOWN",
      });
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve({ denied: false, code: "CONNECTED" });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ denied: false, code: "TIMEOUT" });
    });
  });
// A fresh bwrap netns exposes only lo; reject any non-loopback device or default route.
const netnsIsolated = () => {
  const devices = readFileSync("/proc/net/dev", "utf8")
    .split("\n")
    .slice(2)
    .map((line) => line.split(":")[0]?.trim())
    .filter(Boolean);
  const route = readFileSync("/proc/net/route", "utf8").split("\n").slice(1);
  return (
    devices.length === 1 &&
    devices[0] === "lo" &&
    !route.some((line) => line.trim() && line.split(/\s+/)[1] === "00000000")
  );
};
let inherited;
let kernelPeerIp = null;
let kernelPeerPort = null;
let networkNamespaceDenied = false;
let canaryErrorCode = null;
try {
  await wait("/osv/control/policy", data.timeout_ms, "ok\n");
  const canary = await deniedCanary();
  canaryErrorCode = canary.code;
  if (!netnsIsolated() || !canary.denied) throw Error("canary_not_denied");
  networkNamespaceDenied = true;
  // Stdin is the only OSV socket; opening it cannot create a connection.
  inherited = new Socket({ fd: 0, readable: true, writable: true });
  inherited.pause();
  kernelPeerIp = inherited.remoteAddress;
  kernelPeerPort = inherited.remotePort;
  if (kernelPeerIp !== data.ip || kernelPeerPort !== 443) throw Error("kernel_peer_mismatch");
  writeFileSync("/osv/control/canary", hash(input) + "\n", { flag: "wx", mode: 0o600 });
  await wait("/osv/control/go", data.timeout_ms, "ok\n");
  // The agent has exactly one inherited connected socket; it never resolves or dials OSV.
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  let wrapped = false;
  agent.createConnection = () => {
    if (wrapped) throw Error("socket_already_consumed");
    wrapped = true;
    return tlsConnect({
      socket: inherited,
      ca,
      servername: "api.osv.dev",
      rejectUnauthorized: true,
    });
  };
  const response = await new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const fail = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.destroy();
      reject(error);
    };
    const renew = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(Error("inactivity_timeout")), data.timeout_ms);
    };
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: "api.osv.dev",
        port: 443,
        path: new URL(data.url).pathname,
        method: data.method,
        servername: "api.osv.dev",
        rejectUnauthorized: true,
        ca,
        agent,
        headers:
          data.method === "POST"
            ? {
                Host: "api.osv.dev",
                Accept: "application/json",
                "Accept-Encoding": "identity",
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data.request_body),
                Connection: "close",
              }
            : {
                Host: "api.osv.dev",
                Accept: "application/json",
                "Accept-Encoding": "identity",
                Connection: "close",
              },
      },
      (res) => {
        status = res.statusCode ?? null;
        if (status !== null && status >= 300 && status < 400) {
          fail(Error("redirect_refused"));
          return;
        }
        if (
          status !== 200 ||
          res.headers["content-encoding"] !== undefined ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(res.headers["content-type"] ?? "") ||
          res.headers.location !== undefined
        ) {
          fail(Error("invalid_http_response"));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > data.max_response_bytes) {
            fail(Error("response_too_large"));
            return;
          }
          chunks.push(chunk);
          renew();
        });
        res.on("end", () => {
          if (!res.complete || finished) {
            fail(Error("incomplete_response"));
            return;
          }
          finished = true;
          clearTimeout(timer);
          resolve(Buffer.concat(chunks, size));
        });
        res.on("error", fail);
        res.on("aborted", () => fail(Error("incomplete_response")));
      }
    );
    req.on("error", fail);
    renew();
    phase = "sent"; // Conservative: failures after this point are never safe to replay.
    req.end(data.request_body ?? undefined);
  });
  // Strict UTF-8, exact index cardinality and advisory identity before publishing bytes.
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response));
  if (data.method === "POST") {
    if (
      !Array.isArray(parsed.results) ||
      parsed.results.length !== data.coordinate_ids.length ||
      parsed.results.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          (entry.vulns !== undefined &&
            (!Array.isArray(entry.vulns) ||
              entry.vulns.length > 4096 ||
              entry.vulns.some(
                (vuln) => !vuln || typeof vuln.id !== "string" || !osvId.test(vuln.id)
              )))
      )
    )
      throw Error("mapping_drift");
  } else if (parsed.id !== data.advisory_id) throw Error("mapping_drift");
  body = response.toString("base64");
  phase = "completed";
} catch (error) {
  code =
    error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "transport_failed";
}
inherited?.destroy();
verifyCurrentIdentity();
verifyBoundedScratch(data.scratch_bytes);
const receipt = {
  nonce: data.nonce,
  unit: data.unit,
  request_sha256: hash(input),
  body_sha256: data.body_sha256,
  plan_sha256: data.plan_sha256,
  mapping_sha256: data.mapping_sha256,
  worker_sha256: data.worker_sha256,
  deployment_sha256: data.deployment_sha256,
  runtime_sha256: data.runtime_sha256,
  ca_sha256: data.ca_sha256,
  scratch_launcher_sha256: data.scratch_launcher_sha256,
  scratch_bytes: data.scratch_bytes,
  scratch_capacity_bytes: scratchCapacity,
  worker_caps_zero: true,
  no_new_privileges: true,
  ip: data.ip,
  kernel_peer_ip: kernelPeerIp,
  kernel_peer_port: kernelPeerPort,
  network_namespace_denied: networkNamespaceDenied,
  canary_ip: data.canary_ip,
  canary_denied: existsSync("/osv/control/canary"),
  canary_error_code: canaryErrorCode,
  phase,
  code,
  status,
  response_sha256: body === null ? null : hash(Buffer.from(body, "base64")),
  response_base64: body,
};
writeFileSync(
  "/osv/control/receipt.tmp",
  JSON.stringify(
    Object.fromEntries(Object.entries(receipt).sort(([a], [b]) => a.localeCompare(b)))
  ) + "\n",
  { flag: "wx", mode: 0o600 }
);
renameSync("/osv/control/receipt.tmp", "/osv/control/receipt.json");
try {
  await wait("/osv/control/finish", data.timeout_ms, hash(input) + "\n");
  if (readFileSync("/osv/control/finish", "utf8") !== hash(input) + "\n")
    throw Error("finish_binding");
} catch {
  process.exitCode = 1;
}
if (code !== "none") process.exitCode = 1;
