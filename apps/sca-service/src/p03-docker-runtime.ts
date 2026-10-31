import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HostOperationExecutionContextV1 } from "../../orchestration/dist/host-operations/contracts.js";
import {
  ScaP03InitialAuthorizationV1,
  type ScaP03InitialProposalV1,
  type ScaP03InitialGateBindingV1,
  type ScaP03InitialResourcesV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import { constants } from "node:fs";
import { ScaP03InitialNativeHostV1 } from "./p03-initial-host.js";
import {
  ScaP03SealedBootstrapInputsV1Schema,
  type ScaP03PreLiveInputsV1,
  type ScaP03SealedBootstrapInputsV1,
} from "./p03-initial-live.js";
import { ArtifactStore, type ArtifactHostStore } from "../../orchestration/dist/artifact-store.js";
import type { ScaP03BootstrapEnvironmentMeasurementV1 } from "./p03-bootstrap-measure.js";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ScaP03HostWitnessSinkV1 } from "./p03-bootstrap-witness.js";
import {
  assertScaP03JoernLauncherProbeV1,
  parseScaP03JoernPackageListingV1,
} from "./p03-toolchain-version.js";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { isRevalidatedP03SourceOracleReceipt } from "./p03-oracle-authority.js";
import { validateContract, type ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  verifyScaP03DeterministicTestProofV2,
  type ScaP03BootstrapArtifactReaderV1,
  type ScaP03BootstrapHostAuthorityV1,
  type ScaP03FrozenProductionBindingsV1,
  readP03ProductionInputs,
} from "./p03-bootstrap.js";
import {
  verifyScaP03BootstrapProofV3,
  verifyScaP03ProductionProofV1,
  ScaP03ClosedHostAuthorityV3,
} from "./p03-bootstrap-host.js";
import { isCanonicalHostOperationExecutionContextV1 } from "../../orchestration/dist/host-operations/owner.js";
import { createScaP03BoundVerificationReaderV1 } from "./p03-verification-reader.js";
import { createScaP03OwnedDockerTransportV1 } from "./p03-live-transport.js";
import {
  validateScaP03HostIsolationAttestationV1,
  SCA_P03_QUERY_IDS,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  validateScaP03QueryPlanV2,
  validateScaP03OperationRequestV1,
  validateScaP03RequestV2,
  type ScaP03QueryCandidateV2,
  makeScaP03QueryCandidateV2,
  validateScaP03QueryCandidateV2,
  scaP03QualificationObservationSha256V2,
  scaP03QualificationAssertionsMatchV2,
  projectScaP03OracleTargetObservationsV2,
  scaP03FrontendLanguageV1,
  type ScaP03QualificationCaseV2,
  type ScaP03QualificationFixtureCorpusV2,
  type ScaP03QualificationBlockerCodeV2,
  SCA_P03_MAX_PATH_HOPS,
  SCA_P03_QUALIFICATION_DATAFLOW_MAX_HOPS,
  SCA_P03_MAX_QUALIFICATION_CASE_BYTES,
  SCA_P03_MAX_QUALIFICATION_TOTAL_BYTES,
  type ScaP03QueryId,
  type ScaP03OracleAssertionV2,
  type SourceOracleValidationReceipt,
  parseSourceOracleValidationReceiptBytes,
} from "../../orchestration/dist/sca/p03-contracts.js";
import type {
  ScaP03FrozenQueryReleaseV1,
  ScaP03JoernRuntimeV1,
  ScaP03RuntimeGraphOutputV1,
} from "./p03-operations.js";

const IMAGE = /^([a-z0-9][a-z0-9._/-]*\/)?[a-z0-9][a-z0-9._/-]*@sha256:([a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const MAX_CONTROL_OUTPUT = 1024 * 1024;
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const verifiedHostRuntimes = new WeakMap<object, { proofHash: string; brand: string }>();
function liveRuntimeBrand(runtime: object, proofHash: string): string {
  const r = record(runtime);
  if (
    r === null ||
    r.runtime_kind !== "host_qualified_joern" ||
    r.qualification_scope !== "live_qualified"
  )
    throw new Error("p03_host_runtime_brand_invalid");
  return sha256(
    canonicalJson({
      proofHash,
      runtime_id: r.runtime_id,
      isolation_id: r.isolation_id,
      runtime_tree_sha256: r.runtime_tree_sha256,
      implementation_identity_sha256: r.implementation_identity_sha256,
      deployment_identity_sha256: r.deployment_identity_sha256,
      runtime_kind: r.runtime_kind,
      qualification_scope: r.qualification_scope,
      host_attestation_ref: r.host_attestation_ref,
      source_oracle_ref: r.source_oracle_ref,
      source_oracle_validation_ref: r.source_oracle_validation_ref,
      parser_identity_sha256: r.parser_identity_sha256,
    })
  );
}

/** Only exact adapter-owned failure names can leave the catch boundary. No exception text or stdout. */
function fixtureBlockerCode(
  error: unknown,
  stage: "parse" | "inventory" | "query" | "setup"
): ScaP03QualificationBlockerCodeV2 {
  const message = error instanceof Error ? error.message : null;
  switch (message) {
    case "p03_graph_frontend_mismatch":
    case "p03_fixture_not_in_graph":
    case "p03_fixture_nodes_absent":
    case "p03_fixture_observations_absent":
    case "p03_inventory_invalid":
    case "p03_inventory_encoding":
    case "p03_inventory_graph_invalid":
    case "p03_inventory_limit":
    case "p03_query_release_invalid":
    case "p03_query_binding_invalid":
    case "p03_query_semantics_unsupported":
    case "p03_plan_unsupported":
    case "p03_plan_unbounded":
    case "p03_trace_invalid":
    case "p03_graph_edge_invalid":
    case "p03_query_limit_reached":
    case "p03_traversal_limit_reached":
    case "p03_output_invalid":
    case "p03_output_encoding_invalid":
    case "p03_workspace_limit":
    case "docker_timeout":
    case "docker_output_limit":
      return message;
    default:
      // Docker exit status is not stable across versions; the controlled call site is.
      if (message !== null && /^docker_container_exec_exit_[0-9]{1,3}$/.test(message)) {
        if (stage === "parse") return "p03_fixture_parse_failed";
        if (stage === "inventory") return "p03_fixture_inventory_failed";
      }
      return "p03_qualification_runtime_failed";
  }
}
/** Adapter-side check; a structural cast or a candidate object is not host authority. */
export function isVerifiedScaP03DockerHostRuntimeV1(value: object): boolean {
  const proof = verifiedHostRuntimes.get(value);
  if (proof === undefined) return false;
  try {
    return liveRuntimeBrand(value, proof.proofHash) === proof.brand;
  } catch {
    return false;
  }
}

/**
 * The candidate configuration has no attestation authority.
 * deployment_identity_sha256 binds canonical JSON of docker_executable_sha256,
 * docker_client_version, docker_server_version, image_id (sha256:...), and joern_version.
 * The image must already be local; the runtime never pulls one.
 */
export interface ScaP03DockerCandidateConfigV1 {
  readonly docker_executable: string;
  readonly image_ref: string;
  readonly expected_joern_version: string;
  readonly expected_docker_executable_sha256: string;
  readonly expected_docker_client_version: string;
  readonly expected_docker_server_version: string;
  readonly runtime_id: string;
  readonly isolation_id: string;
  readonly isolation_profile_sha256: string;
  readonly implementation_identity_sha256: string;
  readonly deployment_identity_sha256: string;
  readonly staging_parent: string;
  readonly memory_bytes: number;
  readonly cpus: number;
  readonly pids: number;
  /** Hard per-container /work tmpfs ceiling; staging holds only admitted inputs and validated readback. */
  readonly max_workspace_bytes: number;
  readonly max_num_def: number;
  readonly max_command_output_bytes: number;
  readonly timeout_ms: number;
}

/** The qualified constructor accepts only a reviewed V1 attestation via its separate proof input. */
export type ScaP03DockerRuntimeConfigV1 = ScaP03DockerCandidateConfigV1;

export interface DockerCommandV1 {
  readonly argv: readonly string[];
  readonly signal: AbortSignal;
  readonly timeout_ms: number;
  readonly output_bytes: number;
  readonly docker_config: string;
}
export type DockerRunnerV1 = (command: DockerCommandV1) => Promise<string>;

/** No shell, stdin, ambient Docker config, or inherited credentials. The CLI is not the sandbox. */
export function dockerCommandV1(executable: string): DockerRunnerV1 {
  return ({ argv, signal, timeout_ms, output_bytes, docker_config }) =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("docker_cancelled"));
        return;
      }
      const child = spawn(executable, [...argv], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", DOCKER_CONFIG: docker_config },
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | null = null;
      const stop = (error: Error): void => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const abort = (): void => stop(new Error("docker_cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      let timer = setTimeout(() => stop(new Error("docker_timeout")), timeout_ms);
      const renew = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stop(new Error("docker_timeout")), timeout_ms);
      };
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > output_bytes) stop(new Error("docker_output_limit"));
          else {
            chunks.push(chunk);
            if (chunk.byteLength > 0 && failure === null) renew();
          }
        });
      }
      child.on("error", (error) => {
        failure ??= error;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (failure !== null) reject(failure);
        else if (code !== 0)
          reject(
            new Error(`docker_${argv[0] ?? "unknown"}_${argv[1] ?? "unknown"}_exit_${String(code)}`)
          );
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
}

export function verifyScaP03DockerConfigV1(config: ScaP03DockerRuntimeConfigV1): void {
  if (
    !IMAGE.test(config.image_ref) ||
    config.image_ref.includes("//") ||
    !path.isAbsolute(config.docker_executable) ||
    !path.isAbsolute(config.staging_parent) ||
    /[,\r\n\0]/.test(config.staging_parent) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(config.expected_joern_version) ||
    ![
      config.expected_docker_executable_sha256,
      config.isolation_profile_sha256,
      config.implementation_identity_sha256,
      config.deployment_identity_sha256,
    ].every((v) => DIGEST.test(v)) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(config.expected_docker_client_version) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(config.expected_docker_server_version) ||
    !Number.isSafeInteger(config.memory_bytes) ||
    config.memory_bytes < 256 * 1024 * 1024 ||
    !Number.isFinite(config.cpus) ||
    config.cpus <= 0 ||
    config.cpus > 64 ||
    !Number.isSafeInteger(config.pids) ||
    config.pids < 16 ||
    config.pids > 4096 ||
    !Number.isSafeInteger(config.max_workspace_bytes) ||
    config.max_workspace_bytes < 1 ||
    config.max_workspace_bytes > 128 * 1024 * 1024 ||
    config.max_workspace_bytes > config.memory_bytes / 4 ||
    !Number.isSafeInteger(config.max_num_def) ||
    config.max_num_def < 1 ||
    config.max_num_def > 1_000_000 ||
    !Number.isSafeInteger(config.max_command_output_bytes) ||
    config.max_command_output_bytes < 1 ||
    config.max_command_output_bytes > MAX_CONTROL_OUTPUT ||
    !Number.isSafeInteger(config.timeout_ms) ||
    config.timeout_ms < 1 ||
    config.timeout_ms > 300_000 ||
    process.getuid === undefined ||
    process.getgid === undefined ||
    process.getuid?.() === 0 ||
    process.getgid?.() === 0
  ) {
    throw new Error("p03_docker_config_invalid");
  }
}

async function privateParent(config: ScaP03DockerRuntimeConfigV1): Promise<string> {
  const parent = await realpath(config.staging_parent);
  if (parent !== config.staging_parent || !(await lstat(parent)).isDirectory()) {
    throw new Error("p03_staging_parent_invalid");
  }
  const executable = await lstat(config.docker_executable);
  if (
    !executable.isFile() ||
    executable.size > 256 * 1024 * 1024 ||
    (executable.mode & constants.S_IXUSR) === 0
  ) {
    throw new Error("p03_docker_executable_invalid");
  }
  return parent;
}

// This script is code shipped with the adapter, NOT text from a release or source tree.
// Joern's native zstd library requires an executable private /tmp; all container mounts
// remain isolated. Only the owner-created read-only /scripts, /source and /input bind mounts reach the host.
// Data is written to a size-limited tmpfs. A missing FILE entry is not evidence of parsing.
const READBACK_SCRIPT = `import base64, os, stat, sys
name, limit = sys.argv[1], int(sys.argv[2])
if name not in ('graph.cpg.bin', 'inventory.tsv') or limit < 1:
    raise SystemExit(1)
root = os.open('/work', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    if os.listdir(root) != [name]:
        raise SystemExit(2)
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size < 1 or before.st_size > limit:
            raise SystemExit(3)
        chunks = []
        remaining = before.st_size + 1
        while remaining:
            part = os.read(fd, min(1048576, remaining))
            if not part:
                break
            chunks.append(part)
            remaining -= len(part)
        data = b''.join(chunks)
        after = os.fstat(fd)
        path_stat = os.stat(name, dir_fd=root, follow_symlinks=False)
        if (len(data) != before.st_size or after.st_size != before.st_size or
            after.st_ino != before.st_ino or path_stat.st_ino != before.st_ino or
            not stat.S_ISREG(path_stat.st_mode) or os.listdir(root) != [name]):
            raise SystemExit(4)
        sys.stdout.write(base64.b64encode(data).decode('ascii'))
    finally:
        os.close(fd)
finally:
    os.close(root)
`;
const INVENTORY_SCRIPT = `import io.shiftleft.semanticcpg.language.*
import java.nio.file.{Files, Paths}
import java.nio.charset.StandardCharsets
import java.util.Base64
@main def exec(cpgFile: String, outFile: String) = {
  importCpg(cpgFile)
  val enc = Base64.getEncoder
  def b(s: String): String = enc.encodeToString(s.getBytes(StandardCharsets.UTF_8))
  val lines = scala.collection.mutable.ArrayBuffer.empty[String]
  cpg.metaData.language.l.foreach(n => lines += ("META\\t" + b(n)))
  cpg.file.name.l.foreach(n => lines += ("FILE\\t" + b(n)))
  cpg.graph.allNodes.foreach { n =>
    def prop(k: String): String = Option(n.propertiesMap.get(k)).map(_.toString).getOrElse("")
    lines += ("NODE\\t" + n.id.toString + "\\t" + b(n.label) + "\\t" + b(prop("FILENAME")) + "\\t" +
      b(prop("LINE_NUMBER")) + "\\t" + b(prop("NAME")) + "\\t" + b(prop("FULL_NAME")) + "\\t" + b(prop("CODE")))
    if (lines.size > 1000000) throw new IllegalStateException("inventory node limit")
  }
  cpg.graph.allEdges.foreach { e =>
    lines += ("EDGE\\t" + e.src.id.toString + "\\t" + e.dst.id.toString + "\\t" + b(e.label))
    if (lines.size > 2000000) throw new IllegalStateException("inventory edge limit")
  }
  Files.write(Paths.get(outFile), lines.mkString("\\n").getBytes(StandardCharsets.UTF_8))
}
`;

type InventoryNode = Readonly<{
  node_id: string;
  node_class: string;
  file_name: string;
  line_number: string;
  name: string;
  full_name: string;
  code: string;
}>;
type Inventory = Readonly<{
  frontend_languages: readonly string[];
  files: ReadonlySet<string>;
  nodes: readonly InventoryNode[];
  edges: readonly Readonly<{ src: string; dst: string; label: string }>[];
}>;
function inventory(bytes: Uint8Array): Inventory {
  if (bytes.byteLength > MAX_INVENTORY_BYTES) throw new Error("p03_inventory_limit");
  const files = new Set<string>();
  const frontend_languages: string[] = [];
  const nodes: InventoryNode[] = [];
  const edges: { src: string; dst: string; label: string }[] = [];
  const text = Buffer.from(bytes).toString("utf8");
  if (Buffer.from(text, "utf8").byteLength !== bytes.byteLength)
    throw new Error("p03_inventory_encoding");
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  if (rows.length > 2_000_000) throw new Error("p03_inventory_limit");
  for (const row of rows) {
    if (row === "") throw new Error("p03_inventory_invalid");
    const fields = row.split("\t");
    const decode = (value: string | undefined): string => {
      if (
        value === undefined ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
      )
        throw new Error("p03_inventory_invalid");
      const buffer = Buffer.from(value, "base64");
      const textValue = buffer.toString("utf8");
      if (
        buffer.toString("base64") !== value ||
        Buffer.from(textValue).byteLength !== buffer.byteLength
      )
        throw new Error("p03_inventory_invalid");
      return textValue;
    };
    if (fields[0] === "META" && fields.length === 2) {
      frontend_languages.push(decode(fields[1]));
    } else if (fields[0] === "FILE" && fields.length === 2) {
      const file = decode(fields[1]);
      files.add(file.startsWith("/source/") ? file.slice(8) : file);
    } else if (fields[0] === "NODE" && fields.length === 8 && fields[1] !== undefined) {
      if (!/^[0-9]+$/.test(fields[1])) throw new Error("p03_inventory_invalid");
      const file = decode(fields[3]);
      nodes.push({
        node_id: fields[1],
        node_class: decode(fields[2]).toLowerCase(),
        file_name: file.startsWith("/source/") ? file.slice(8) : file,
        line_number: decode(fields[4]),
        name: decode(fields[5]),
        full_name: decode(fields[6]),
        code: decode(fields[7]),
      });
    } else if (
      fields[0] === "EDGE" &&
      fields.length === 4 &&
      fields[1] !== undefined &&
      fields[2] !== undefined &&
      /^[0-9]+$/.test(fields[1]) &&
      /^[0-9]+$/.test(fields[2])
    ) {
      edges.push({ src: fields[1], dst: fields[2], label: decode(fields[3]).toLowerCase() });
    } else throw new Error("p03_inventory_invalid");
    if (nodes.length > 1_000_000 || edges.length > 1_000_000 || files.size > 100_000)
      throw new Error("p03_inventory_limit");
  }
  const nodeIds = new Set(nodes.map((node) => node.node_id));
  if (
    nodeIds.size !== nodes.length ||
    edges.some((edge) => !nodeIds.has(edge.src) || !nodeIds.has(edge.dst))
  )
    throw new Error("p03_inventory_graph_invalid");
  return { frontend_languages, files, nodes, edges };
}

function assertFrontend(data: Inventory, expected: "PHP" | "JSSRC"): void {
  // The pinned Joern CLI can fall back from JsSrcCpgGenerator to JsCpgGenerator.
  // The requested argv alone is not proof of which frontend produced the CPG.
  if (data.frontend_languages.length !== 1 || data.frontend_languages[0] !== expected)
    throw new Error("p03_graph_frontend_mismatch");
}

function sameRef(
  receipt: SourceOracleValidationReceipt | undefined,
  ref: ArtifactRef,
  expected: ScaP03QualificationFixtureCorpusV2["expected_cases"]
): boolean {
  if (receipt === undefined || !isRevalidatedP03SourceOracleReceipt(receipt)) return false;
  try {
    parseSourceOracleValidationReceiptBytes(Buffer.from(canonicalJson(receipt)));
  } catch {
    return false;
  }
  return (
    ref.kind === "sca-p03-source-oracle-validation" &&
    ref.phase === "SCA-P03" &&
    ref.run_id === receipt.oracle_ref.run_id &&
    ref.branch_id === null &&
    ref.producer === SCA_P03_SOURCE_ORACLE_VALIDATOR &&
    ref.content_schema?.schema_id === SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA &&
    ref.content_schema.schema_version === 1 &&
    ref.media_type === "application/json" &&
    ref.content_digest === sha256(canonicalJson(receipt)) &&
    ref.store_ref === `artifact://sha256/${ref.content_digest}` &&
    ref.byte_length === Buffer.byteLength(canonicalJson(receipt)) &&
    canonicalJson(receipt.expected_cases) === canonicalJson(expected)
  );
}

function guardCondition(code: string): string | null {
  if (!code.startsWith("if (")) return null;
  let depth = 1;
  let quote: string | null = null;
  for (let i = 4; i < code.length; i++) {
    const char = code[i];
    if (quote !== null) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return code.slice(4, i).trim();
  }
  return null;
}

function sourceHasName(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w$])${escaped}(?![\\w$])`, "u").test(source);
}

function sourceSpelling(node: InventoryNode, spelling: string): boolean {
  // PHP NAME drops the dollar sign. CODE retains it; never strip it from the selector.
  return (
    node.code === spelling ||
    (node.name === spelling &&
      (node.code === "" ||
        node.code === spelling ||
        (node.node_class === "method_parameter_in" && node.code.startsWith(`${spelling}:`))))
  );
}

function reviewedAnchor(
  node: InventoryNode,
  selector: NonNullable<ScaP03OracleAssertionV2["start"]>,
  queryId: ScaP03QueryId,
  cpgLine: number,
  sourceLine: string
): boolean {
  const name = selector.name;
  if (name === null) return false;
  const code = node.code.trim();
  const source = sourceLine.trim();
  if (selector.role === "guard")
    return (
      node.node_class === "control_structure" &&
      cpgLine === selector.line &&
      guardCondition(code) === name &&
      guardCondition(source) === name
    );
  if (selector.role === "registration") {
    if (
      node.node_class !== "call" ||
      cpgLine !== selector.line ||
      node.name.startsWith("<operator>")
    )
      return false;
    const reviewedCall = (name === "@Get" ? source.slice(1) : source)
      .replace(/;$/, "")
      .replace(/'/g, '"');
    if (code !== reviewedCall) return false;
    if (name === "router.get") return node.name === "get" && code.startsWith("router.get(");
    if (name === "add_action") return node.name === name && code.startsWith("add_action(");
    if (name === "@Get") return node.name === "Get" && code.startsWith("Get(");
    return false;
  }
  if (selector.role === "handler") {
    if (node.node_class !== "method" || node.name !== name || cpgLine > selector.line) return false;
    if (cpgLine === selector.line) {
      const declaration = code.split("\n")[0]?.trim();
      return (
        declaration === source ||
        (declaration !== undefined &&
          source.startsWith(declaration) &&
          /^\s*\{/.test(source.slice(declaration.length)))
      );
    }
    // Decorator-inclusive method start: only an exact declaration line within CODE
    // may account for the reviewed declaration, not a generic one-line tolerance.
    const lines = code.split("\n");
    return (
      lines[selector.line - cpgLine]?.trim() === source &&
      lines.slice(0, selector.line - cpgLine).every((line) => line.trim().startsWith("@"))
    );
  }
  if (queryId === "p03.dataflow-source-sink.v2" && selector.role === "source") {
    const declaration = /\b(?:function\s+\w+|\w+)\s*\(/.test(source) && sourceHasName(source, name);
    const label = declaration ? "method_parameter_in" : "identifier";
    return (
      cpgLine === selector.line &&
      node.node_class === label &&
      sourceSpelling(node, name) &&
      sourceHasName(source, name)
    );
  }
  return (
    cpgLine === selector.line &&
    node.node_class === "identifier" &&
    sourceSpelling(node, name) &&
    sourceHasName(source, name)
  );
}

/** Source-reviewed semantics plus independently located CPG vertices; no graph edge is promoted. */
function complementCandidate(
  assertion: ScaP03OracleAssertionV2,
  data: Inventory,
  parsed: ReadonlySet<string>,
  locationOf: (node: InventoryNode) => {
    path: string | null;
    line: number | null;
    location_provenance: "direct" | "containing_method" | "external_unaccounted";
    location_owner_node_id: string | null;
    location_evidence: ScaP03QueryCandidateV2["vertices"][number]["location_evidence"];
  },
  parameterOwner: (
    node: InventoryNode,
    selector: NonNullable<ScaP03OracleAssertionV2["start"]>,
    sourceLine: string,
    maxDepth: number,
    maxNodes: number
  ) => boolean,
  maxAstDepth: number,
  maxAstNodes: number,
  identity: { graph_component_sha256: string; source_snapshot_sha256: string },
  queryId: ScaP03QueryId,
  releaseSha256: string,
  ref: ArtifactRef,
  sourceLines: readonly string[]
): ScaP03QueryCandidateV2 | null {
  if (
    assertion.expectation !== "present" ||
    assertion.disposition !== "supported" ||
    assertion.edge?.provenance !== "qualified_complement" ||
    assertion.start === undefined ||
    assertion.end === undefined ||
    !["p03.control-guard.v2", "p03.framework-dispatch.v2", "p03.dataflow-source-sink.v2"].includes(
      queryId
    )
  )
    return null;
  const edge = assertion.edge;
  const selectors = [assertion.start, ...(assertion.via ?? []), assertion.end];
  if (
    selectors.length > SCA_P03_MAX_PATH_HOPS + 1 ||
    selectors.some(
      (selector) =>
        selector.name === null ||
        !parsed.has(selector.path) ||
        sourceLines[selector.line - 1] === undefined
    )
  )
    return null;
  const vertices = selectors.map((selector) => {
    const matches = data.nodes.filter((node) => {
      const location = locationOf(node);
      const sourceLine = sourceLines[selector.line - 1];
      if (sourceLine === undefined) return false;
      const parameterSource =
        queryId === "p03.dataflow-source-sink.v2" &&
        selector.role === "source" &&
        node.node_class === "method_parameter_in" &&
        node.file_name === "";
      // Only a reviewed parameter anchor may use its own CPG line with an AST
      // method owner instead of the normal observed location. Even a CONTAINS
      // location must pass the parameter's exact declaration/owner check.
      const path = parameterSource && location.path === null ? selector.path : location.path;
      const line = parameterSource && location.line === null ? selector.line : location.line;
      return (
        path === selector.path &&
        line !== null &&
        (parameterSource || location.location_provenance !== "external_unaccounted") &&
        reviewedAnchor(node, selector, queryId, line, sourceLine) &&
        (!parameterSource || parameterOwner(node, selector, sourceLine, maxAstDepth, maxAstNodes))
      );
    });
    if (matches.length !== 1) return null;
    const node = matches[0];
    if (node === undefined) return null;
    return {
      node_id: node.node_id,
      role: selector.role,
      label: node.node_class,
      name: selector.name,
      full_name: node.full_name || null,
      path: selector.path,
      line: selector.line,
      column: null,
      location_provenance: "qualified_source_oracle" as const,
      source_location_ref: ref,
      cpg_line: Number(node.line_number),
      location_owner_node_id: null,
      location_evidence: null,
    };
  });
  if (vertices.some((vertex) => vertex === null)) return null;
  const located = vertices.filter((vertex) => vertex !== null);
  if (new Set(located.map((vertex) => vertex.node_id)).size !== located.length) return null;
  const edges = located.slice(1).map((vertex, index) => ({
    src_index: index,
    dst_index: index + 1,
    src_node_id: located[index]?.node_id ?? "",
    dst_node_id: vertex.node_id,
    kind: edge.kind,
    direction: "forward" as const,
    provenance: "qualified_complement" as const,
    branch_orientation: edge.branch_orientation,
    complement_ref: ref,
  }));
  const start = located[0];
  if (start === undefined) return null;
  return makeScaP03QueryCandidateV2({
    candidate_kind: assertion.candidate_kind,
    query_id: queryId,
    claim: assertion.claim,
    disposition: "supported",
    reason_code: null,
    source_selector: assertion.source_selector ?? null,
    sink_selector: assertion.sink_selector ?? null,
    framework: assertion.framework ?? null,
    registration_form: assertion.registration_form ?? null,
    callback_resolution: assertion.callback_resolution ?? null,
    assumptions: [],
    ...identity,
    query_release_sha256: releaseSha256,
    vertices: located,
    edges,
    hop_count: edges.length,
    truncated: false,
    path: start.path,
    line: start.line,
    stable_locator:
      `${queryId}:${start.path}:${located.map((vertex) => vertex.node_id).join("-")}`.slice(
        0,
        1024
      ),
    summary: `${queryId}: source-oracle reviewed relationship (qualified complement)`,
  });
}

function queryCandidates(
  release: ScaP03FrozenQueryReleaseV1,
  data: Inventory,
  files: readonly { path: string; disposition: string }[],
  maxItems: number,
  identity: { graph_component_sha256: string; source_snapshot_sha256: string },
  qualificationCases?: ScaP03QualificationFixtureCorpusV2["expected_cases"],
  complementRef?: ArtifactRef,
  sourceLines?: readonly string[]
): ReadonlyMap<ScaP03QueryId, readonly ScaP03QueryCandidateV2[]> {
  if (
    release.queries.length !== SCA_P03_QUERY_IDS.length ||
    release.queries.some(
      (q, i) =>
        q.query_id !== SCA_P03_QUERY_IDS[i] ||
        q.binding.plan_sha256 !== q.plan.plan_sha256 ||
        q.binding.query_id !== q.query_id ||
        q.binding.release_id !== release.release_id
    )
  )
    throw new Error("p03_query_release_invalid");
  const parsed = new Set(
    files
      .filter((f) => f.disposition === "parsed" || f.disposition === "contextual")
      .map((f) => f.path)
  );
  const nodesById = new Map(data.nodes.map((node) => [node.node_id, node]));
  const containing = new Map<string, Set<string>>();
  for (const edge of data.edges) {
    if (edge.label !== "contains") continue;
    const owners = containing.get(edge.dst) ?? new Set<string>();
    owners.add(edge.src);
    containing.set(edge.dst, owners);
  }
  const accountedFile = (node: InventoryNode): string | null => {
    const file = node.node_class === "file" ? node.file_name || node.name : node.file_name;
    return parsed.has(file) ? file : null;
  };
  const lineOf = (node: InventoryNode): number | null => {
    const value = Number(node.line_number);
    return /^[1-9][0-9]*$/.test(node.line_number) &&
      Number.isSafeInteger(value) &&
      value <= 100_000_000
      ? value
      : null;
  };
  const reverseAst = new Map<string, string[]>();
  for (const edge of data.edges) {
    if (edge.label !== "ast") continue;
    const parents = reverseAst.get(edge.dst) ?? [];
    parents.push(edge.src);
    reverseAst.set(edge.dst, parents);
  }
  const parameterOwner = (
    node: InventoryNode,
    selector: NonNullable<ScaP03OracleAssertionV2["start"]>,
    sourceLine: string,
    maxDepth: number,
    maxNodes: number
  ): boolean => {
    if (node.file_name !== "" || selector.name === null || maxDepth < 1 || maxNodes < 1)
      return false;
    const line = lineOf(node);
    const spelling = selector.name;
    if (line !== selector.line || node.name !== spelling.replace(/^\$/, "")) return false;
    // The parameter CODE must be the entire source-declaration parameter, not
    // merely a name substring in the method body or a differently typed token.
    const args = sourceLine.slice(sourceLine.indexOf("(") + 1, sourceLine.indexOf(")"));
    if (
      sourceLine.indexOf("(") < 0 ||
      sourceLine.indexOf(")") < sourceLine.indexOf("(") ||
      !args.split(",").some((arg) => arg.trim() === node.code)
    )
      return false;
    const declarationName = sourceLine
      .trim()
      .match(
        /^(?:(?:public|protected|private|static|async|final|abstract|function)\s+)*([A-Za-z_$][\w$]*)\s*\(/u
      )?.[1];
    if (declarationName === undefined) return false;
    const owners = new Set<string>();
    let visits = 0;
    const walk = (id: string, depth: number, seen: ReadonlySet<string>): boolean => {
      if (depth > maxDepth || seen.has(id) || ++visits > maxNodes) return false;
      const parent = nodesById.get(id);
      if (
        parent === undefined ||
        (parent.file_name !== "" && accountedFile(parent) !== selector.path)
      )
        return false;
      if (parent.node_class === "method") {
        const start = lineOf(parent);
        const lines = parent.code.split("\n");
        if (
          accountedFile(parent) !== selector.path ||
          start === null ||
          start > selector.line ||
          selector.line >= start + lines.length ||
          !(
            lines[selector.line - start]?.trim() === sourceLine.trim() ||
            (sourceLine.trim().startsWith(lines[selector.line - start]?.trim() ?? "") &&
              /^\s*\{/.test(
                sourceLine.trim().slice(lines[selector.line - start]?.trim().length ?? 0)
              ))
          ) ||
          // The reviewed declaration itself must name this METHOD, not a
          // decoy method or an unrelated occurrence of the parameter spelling.
          parent.name !== declarationName
        )
          return false;
        owners.add(id);
        return true;
      }
      const parents = reverseAst.get(id);
      if (parents === undefined || parents.length === 0) return false;
      const next = new Set(seen);
      next.add(id);
      return parents.every((parentId) => walk(parentId, depth + 1, next));
    };
    // An observed direct parameter-owner CONTAINS is also admissible; generic
    // transitive CONTAINS is not. All observed ownership routes must agree.
    const directOwners = [...(containing.get(node.node_id) ?? [])];
    const astParents = reverseAst.get(node.node_id) ?? [];
    if (directOwners.length + astParents.length === 0) return false;
    return (
      [...directOwners, ...astParents].every((id) => walk(id, 1, new Set([node.node_id]))) &&
      owners.size === 1
    );
  };
  const locationOf = (node: InventoryNode) => {
    const direct = accountedFile(node);
    if (direct !== null) {
      return {
        path: direct,
        line: lineOf(node),
        location_provenance: "direct" as const,
        location_owner_node_id: null,
        location_evidence: null,
      };
    }
    // A nonempty foreign FILENAME is explicit contrary evidence, not a missing location.
    const owners = containing.get(node.node_id);
    if (node.file_name === "" && owners?.size === 1) {
      const ownerId = [...owners][0];
      const owner = ownerId === undefined ? undefined : nodesById.get(ownerId);
      if (
        owner !== undefined &&
        (owner.node_class === "method" ||
          owner.node_class === "type" ||
          owner.node_class === "file")
      ) {
        const ownerPath = accountedFile(owner);
        if (ownerPath !== null) {
          return {
            path: ownerPath,
            // CONTAINS establishes a file, not a source line. A child line is only its own.
            line: lineOf(node),
            location_provenance: "containing_method" as const,
            location_owner_node_id: owner.node_id,
            location_evidence: {
              owner_node_id: owner.node_id,
              owner_label:
                owner.node_class === "method"
                  ? ("method" as const)
                  : owner.node_class === "type"
                    ? ("type" as const)
                    : ("file" as const),
              owner_path: ownerPath,
              edge_kind: "contains" as const,
              edge_src_node_id: owner.node_id,
              edge_dst_node_id: node.node_id,
            },
          };
        }
      }
    }
    return {
      path: null,
      line: null,
      location_provenance: "external_unaccounted" as const,
      location_owner_node_id: null,
      location_evidence: null,
    };
  };
  type Trace = {
    readonly nodes: readonly InventoryNode[];
    readonly edges: readonly Inventory["edges"][number][];
  };
  const result = new Map<ScaP03QueryId, readonly ScaP03QueryCandidateV2[]>();
  for (const query of release.queries) {
    validateScaP03QueryPlanV2(query.plan);
    if (
      query.binding.plan_id !== query.plan.plan_id ||
      query.binding.executor_id !== query.query_id
    )
      throw new Error("p03_query_binding_invalid");
    const requiredEdge =
      query.query_id === "p03.control-guard.v2"
        ? "cfg"
        : query.query_id === "p03.dataflow-source-sink.v2"
          ? "reaching_def"
          : query.query_id === "p03.call-resolution.v2" ||
              query.query_id === "p03.framework-dispatch.v2"
            ? "call"
            : null;
    if (
      requiredEdge !== null &&
      !query.plan.steps.some((step) => step.kind === "traverse_edge" && step.edge === requiredEdge)
    )
      throw new Error("p03_query_semantics_unsupported");
    const caseOracle = qualificationCases?.find((entry) => entry.query_id === query.query_id);
    if (qualificationCases !== undefined && caseOracle === undefined)
      throw new Error("p03_query_binding_invalid");
    const starts = caseOracle?.oracle_assertions
      .filter((assertion) => assertion.expectation === "present")
      .map((assertion) => assertion.start);
    if (
      starts !== undefined &&
      (starts.length === 0 || starts.some((start) => start === undefined))
    )
      throw new Error("p03_query_binding_invalid");
    if (starts !== undefined && query.query_id === "p03.dataflow-source-sink.v2") {
      const traversals = query.plan.steps.filter((step) => step.kind === "traverse_edge");
      if (
        traversals.length !== 1 ||
        traversals[0]?.edge !== "reaching_def" ||
        traversals[0].max_hops !== SCA_P03_QUALIFICATION_DATAFLOW_MAX_HOPS
      )
        throw new Error("p03_query_semantics_unsupported");
    }
    const startRole =
      query.query_id === "p03.call-resolution.v2"
        ? "call_site"
        : query.query_id === "p03.control-guard.v2"
          ? "guard"
          : query.query_id === "p03.dataflow-source-sink.v2"
            ? "source"
            : query.query_id === "p03.framework-dispatch.v2"
              ? "registration"
              : "symbol";
    const startSpelling = (node: InventoryNode): string =>
      startRole === "guard" && node.code !== ""
        ? (guardCondition(node.code) ?? "")
        : startRole === "registration" && node.code !== ""
          ? node.name === "Get" && node.code.startsWith("Get(")
            ? "@Get"
            : (node.code.trim().split("(", 1)[0]?.trim() ?? "")
          : startRole === "source" && /^\$[a-zA-Z_][a-zA-Z_0-9]*$/.test(node.code)
            ? node.code
            : node.name;
    const matchesStart = (node: InventoryNode): boolean => {
      if (starts === undefined) return true; // Baseline has no oracle authority.
      const location = locationOf(node);
      return starts.some((selector) => {
        if (
          selector === undefined ||
          selector.role !== startRole ||
          selector.name === null ||
          selector.path !== location.path ||
          selector.line !== location.line
        )
          return false;
        // Joern NAME identifies methods, calls and identifiers. CODE carries the
        // exact source spelling of conditions and decorated/qualified registrations.
        return (
          startSpelling(node) === selector.name ||
          (startRole === "source" && node.code === selector.name) ||
          (startRole === "registration" && node.name === selector.name)
        );
      });
    };
    let traces: Trace[] = [];
    let selectedOnce = false;
    let limited = false;
    let projected: readonly string[] | null = null;
    let lastEdge: string | null = null;
    for (const step of query.plan.steps) {
      if (step.kind === "select_node") {
        if (selectedOnce || limited) throw new Error("p03_plan_unsupported");
        selectedOnce = true;
        traces = data.nodes
          .filter((node) => node.node_class === step.node_class && matchesStart(node))
          .map((node) => ({ nodes: [node], edges: [] }));
        if (traces.length > maxItems || traces.length > query.plan.max_ast_nodes)
          throw new Error("p03_query_limit_reached");
      } else if (step.kind === "filter_property") {
        const key =
          step.property === "name"
            ? "name"
            : step.property === "full_name"
              ? "full_name"
              : step.property === "file_name"
                ? "file_name"
                : "line_number";
        traces = traces.filter((trace) => {
          const node = trace.nodes.at(-1);
          if (node === undefined) throw new Error("p03_trace_invalid");
          // FILE_NAME predicates may select a CALL by its unique observed container;
          // never silently discard it because the CALL itself omits FILENAME.
          const value = key === "file_name" ? (locationOf(node).path ?? node.file_name) : node[key];
          return step.operator === "present" ? value !== "" : value === step.value;
        });
      } else if (step.kind === "traverse_edge") {
        if (
          !selectedOnce ||
          limited ||
          step.max_hops > SCA_P03_MAX_PATH_HOPS ||
          (step.edge === "ast" && step.max_hops > query.plan.max_ast_depth)
        )
          throw new Error("p03_plan_unsupported");
        const outgoing = new Map<string, Inventory["edges"][number][]>();
        for (const edge of data.edges) {
          if (edge.label !== step.edge) continue;
          const list = outgoing.get(edge.src) ?? [];
          list.push(edge);
          outgoing.set(edge.src, list);
        }
        const qualificationFlow =
          starts !== undefined && query.query_id === "p03.dataflow-source-sink.v2";
        const sinkSelectors =
          caseOracle?.oracle_assertions.flatMap((assertion) =>
            assertion.end?.role === "sink" ? [assertion.end] : []
          ) ?? [];
        let frontier = traces;
        const reached: Trace[] = [];
        const complete: Trace[] = [];
        for (let hop = 0; hop < step.max_hops; hop++) {
          const next: Trace[] = [];
          for (const trace of frontier) {
            const origin = trace.nodes.at(-1);
            if (origin === undefined) throw new Error("p03_trace_invalid");
            for (const edge of outgoing.get(origin.node_id) ?? []) {
              const target = nodesById.get(edge.dst);
              if (target === undefined) throw new Error("p03_graph_edge_invalid");
              if (trace.nodes.some((node) => node.node_id === target.node_id)) continue;
              const candidate = { nodes: [...trace.nodes, target], edges: [...trace.edges, edge] };
              next.push(candidate);
              reached.push(candidate);
              if (reached.length > maxItems || reached.length > query.plan.max_ast_nodes)
                throw new Error("p03_traversal_limit_reached");
              if (qualificationFlow) {
                const location = locationOf(target);
                const assertedSink = sinkSelectors.some(
                  (selector) =>
                    selector.path === location.path &&
                    selector.line === location.line &&
                    selector.name === target.name
                );
                const successors = (outgoing.get(target.node_id) ?? []).filter(
                  (successor) => !candidate.nodes.some((node) => node.node_id === successor.dst)
                );
                // A source-level sink may itself feed later CPG nodes. Keep its raw
                // prefix as an endpoint, but keep exploring every reachable branch.
                if (assertedSink || successors.length === 0) complete.push(candidate);
                if (hop === step.max_hops - 1 && successors.length > 0)
                  throw new Error("p03_traversal_limit_reached");
              }
            }
          }
          frontier = next;
          if (frontier.length === 0) break;
        }
        // Intermediate prefixes consume the work budget, never masquerade as sinks.
        // Leaf paths and exact asserted endpoints retain all raw vertices and edges.
        traces = qualificationFlow ? complete : reached;
        lastEdge = step.edge;
      } else if (step.kind === "limit") {
        if (!selectedOnce || limited || traces.length > step.max_items || traces.length > maxItems)
          throw new Error("p03_query_limit_reached");
        limited = true;
      } else if (step.kind === "project") {
        if (
          !selectedOnce ||
          projected !== null ||
          (step.fields.includes("edge_kind") && lastEdge === null)
        )
          throw new Error("p03_plan_unsupported");
        projected = step.fields;
      }
    }
    if (!limited || !selectedOnce || traces.length > maxItems)
      throw new Error("p03_plan_unbounded");
    const kinds: Record<ScaP03QueryId, ScaP03QueryCandidateV2["candidate_kind"]> = {
      "p03.graph-integrity.v2": "symbol_or_entrypoint",
      "p03.symbol-entrypoint-index.v2": "symbol_or_entrypoint",
      "p03.call-resolution.v2": "call_or_unresolved_call",
      "p03.control-guard.v2": "guard_or_control_relationship",
      "p03.dataflow-source-sink.v2": "source_to_sink_flow",
      "p03.framework-dispatch.v2": "route_or_framework_surface",
      "p03.unsupported-surface.v2": "unsupported_or_unresolved_surface",
    };
    const items = traces.map((trace) => {
      // Joern can traverse generated/external nodes without a repository location. Keep
      // every trace (and edge) in the bounded result, but never turn such a path into proof.
      const locations = trace.nodes.map(locationOf);
      const unlocated = locations.some((location) => location.path === null);
      const first = trace.nodes[0];
      const last = trace.nodes.at(-1);
      if (first === undefined || last === undefined) throw new Error("p03_trace_invalid");
      // Selection predicates were applied to the start before traversal. A path is
      // supportable only when *every* observed vertex is accounted and every edge
      // has the query's declared meaning; no generated endpoint or ID fallback.
      const located = trace.nodes.every((node, index) => {
        const location = locations[index];
        return (
          location?.path !== null &&
          location?.path !== undefined &&
          location.line !== null &&
          node.name !== ""
        );
      });
      const isCall =
        query.query_id === "p03.call-resolution.v2" &&
        first.node_class === "call" &&
        last.node_class === "method" &&
        trace.edges.length > 0 &&
        trace.edges.every((e) => e.label === "call") &&
        located;
      const isDefinition =
        query.query_id === "p03.dataflow-source-sink.v2" &&
        first.node_class === "identifier" &&
        last.node_class === "identifier" &&
        trace.edges.length > 0 &&
        trace.edges.every((e) => e.label === "reaching_def") &&
        located;
      const isPresence =
        (query.query_id === "p03.graph-integrity.v2" ||
          query.query_id === "p03.symbol-entrypoint-index.v2") &&
        first.node_class === "method" &&
        trace.edges.length === 0 &&
        located;
      // A dynamic registration needs an independently reviewed resolver; even a CALL edge alone
      // does not prove framework callback registration semantics.
      const claim =
        query.query_id === "p03.call-resolution.v2"
          ? ("call_resolution" as const)
          : query.query_id === "p03.control-guard.v2"
            ? ("control_reachability" as const)
            : query.query_id === "p03.dataflow-source-sink.v2"
              ? ("reaching_definition" as const)
              : query.query_id === "p03.framework-dispatch.v2"
                ? ("framework_dispatch" as const)
                : query.query_id === "p03.unsupported-surface.v2"
                  ? ("unsupported_surface" as const)
                  : ("observation" as const);
      const vertices = trace.nodes.map((node, index) => {
        const location = locations[index];
        if (location === undefined) throw new Error("p03_trace_invalid");
        return {
          node_id: node.node_id,
          role:
            index === 0 && claim === "call_resolution"
              ? ("call_site" as const)
              : index === trace.nodes.length - 1 && claim === "call_resolution"
                ? ("callee" as const)
                : index === 0 && claim === "control_reachability"
                  ? ("guard" as const)
                  : index === trace.nodes.length - 1 && claim === "control_reachability"
                    ? ("action" as const)
                    : index === 0 && claim === "reaching_definition"
                      ? ("source" as const)
                      : index === trace.nodes.length - 1 && claim === "reaching_definition"
                        ? ("sink" as const)
                        : claim === "reaching_definition"
                          ? ("unknown" as const)
                          : index === 0 && claim === "framework_dispatch"
                            ? ("registration" as const)
                            : index === trace.nodes.length - 1 && claim === "framework_dispatch"
                              ? ("handler" as const)
                              : ("symbol" as const),
          label: node.node_class,
          name:
            location.path !== null ? (index === 0 ? startSpelling(node) : node.name) || null : null,
          full_name: location.path !== null ? node.full_name || null : null,
          ...location,
          column: null,
        };
      });
      const edges = trace.edges.map((edge, index) => ({
        src_index: index,
        dst_index: index + 1,
        src_node_id: edge.src,
        dst_node_id: edge.dst,
        kind:
          edge.label === "ast"
            ? ("ast" as const)
            : edge.label === "call"
              ? ("call" as const)
              : edge.label === "cfg"
                ? ("cfg" as const)
                : edge.label === "reaching_def"
                  ? ("reaching_def" as const)
                  : ("contains" as const),
        direction: "forward" as const,
        provenance: "observed_cpg" as const,
        branch_orientation: null,
        complement_ref: null,
      }));
      const core = {
        candidate_kind: kinds[query.query_id],
        query_id: query.query_id,
        claim,
        disposition:
          isCall || isDefinition || isPresence ? ("supported" as const) : ("unresolved" as const),
        reason_code: unlocated
          ? "path_location_unaccounted"
          : isCall || isDefinition || isPresence
            ? null
            : "relationship_unproven",
        source_selector:
          claim === "reaching_definition"
            ? (vertices[0]?.name ?? first.name) || first.full_name || first.node_id
            : null,
        sink_selector:
          claim === "reaching_definition"
            ? (vertices.at(-1)?.name ?? last.name) || last.full_name || last.node_id
            : null,
        framework: null,
        registration_form: null,
        callback_resolution: claim === "framework_dispatch" ? ("dynamic" as const) : null,
        assumptions: [],
        graph_component_sha256: identity.graph_component_sha256,
        source_snapshot_sha256: identity.source_snapshot_sha256,
        query_release_sha256: release.release_sha256,
        vertices,
        edges,
        hop_count: edges.length,
        truncated: false,
        path: vertices[0]?.path ?? null,
        line: vertices[0]?.line ?? null,
        stable_locator:
          `${query.query_id}:${vertices.find((vertex) => vertex.path !== null)?.path ?? "unlocated"}:${trace.nodes.map((node) => node.node_id).join("-")}`.slice(
            0,
            1024
          ),
        summary:
          `${query.query_id}: ${unlocated ? "full relationship path location unavailable" : `${projected?.join(",") ?? first.name} (${isCall ? "observed call" : isDefinition ? "observed reaching definition" : isPresence ? "observed symbol" : "relationship unproven"})`}`.slice(
            0,
            2048
          ),
      };
      return makeScaP03QueryCandidateV2(core);
    });
    // Raw CPG traces are retained unchanged. A separately reviewed source relationship
    // may add a new candidate, never rewrite a CFG/CALL trace into semantic proof.
    const graphCase = qualificationCases?.find(
      (entry) => entry.query_id === "p03.graph-integrity.v2"
    );
    const graphPassed =
      graphCase !== undefined &&
      scaP03QualificationAssertionsMatchV2(
        query.query_id === "p03.graph-integrity.v2"
          ? items
          : (result.get("p03.graph-integrity.v2") ?? []),
        graphCase.oracle_assertions
      );
    const complements =
      graphPassed &&
      complementRef !== undefined &&
      sourceLines !== undefined &&
      caseOracle !== undefined
        ? caseOracle.oracle_assertions.flatMap((assertion) => {
            const complement = complementCandidate(
              assertion,
              data,
              parsed,
              locationOf,
              parameterOwner,
              query.plan.max_ast_depth,
              query.plan.max_ast_nodes,
              identity,
              query.query_id,
              release.release_sha256,
              complementRef,
              sourceLines
            );
            return complement === null ? [] : [complement];
          })
        : [];
    const allItems = [...items, ...complements];
    if (allItems.length > maxItems || allItems.length > query.plan.max_ast_nodes)
      throw new Error("p03_query_limit_reached");
    if (new Set(allItems.map((item) => item.candidate_id)).size !== allItems.length)
      throw new Error("p03_duplicate_path");
    for (const item of allItems)
      validateScaP03QueryCandidateV2(item, {
        query_id: query.query_id,
        graph_component_sha256: identity.graph_component_sha256,
        source_snapshot_sha256: identity.source_snapshot_sha256,
        query_release_sha256: release.release_sha256,
        accounted_paths: [...parsed],
        approved_complement_ref: complementRef,
      });
    result.set(query.query_id, allItems);
  }
  return result;
}

/** Candidate authority stops at measurement and ordered fixture observations. */
export type ScaP03DockerCandidateV1 = Readonly<
  Pick<
    ScaP03MeasuredDockerRuntimeV1,
    | "runtime_id"
    | "isolation_id"
    | "runtime_tree_sha256"
    | "isolation_profile_sha256"
    | "implementation_identity_sha256"
    | "deployment_identity_sha256"
    | "measured_joern_version"
    | "max_num_def"
  > & {
    qualify(
      input: Omit<Parameters<ScaP03MeasuredDockerRuntimeV1["qualify"]>[0], "request">
    ): ReturnType<ScaP03MeasuredDockerRuntimeV1["qualify"]>;
  }
>;

type ScaP03MeasuredDockerRuntimeV1 = Pick<
  ScaP03JoernRuntimeV1,
  | "runtime_id"
  | "isolation_id"
  | "runtime_tree_sha256"
  | "isolation_profile_sha256"
  | "implementation_identity_sha256"
  | "deployment_identity_sha256"
  | "buildGraph"
  | "runBaselineQueries"
> &
  Readonly<{
    qualify(
      input: Omit<Parameters<ScaP03JoernRuntimeV1["qualify"]>[0], "request">
    ): ReturnType<ScaP03JoernRuntimeV1["qualify"]>;
    staging_parent: string;
    measured_joern_version: string;
    max_num_def: number;
    measureEnvironment(signal: AbortSignal): Promise<ScaP03BootstrapEnvironmentMeasurementV1>;
  }>;

export async function createScaP03DockerJoernCandidateV1(
  config: ScaP03DockerCandidateConfigV1,
  runner: DockerRunnerV1 = dockerCommandV1(config.docker_executable),
  witness?: ScaP03HostWitnessSinkV1
): Promise<ScaP03DockerCandidateV1> {
  // Fail closed even when a JS caller passes surplus attestation keys.
  if (
    "host_attestation_ref" in config ||
    "host_attestation_id" in config ||
    "host_attestation_sha256" in config
  )
    throw new Error("p03_candidate_attestation_forbidden");
  const measured = await createMeasuredDockerRuntime(config, runner, witness);
  return {
    runtime_id: measured.runtime_id,
    isolation_id: measured.isolation_id,
    runtime_tree_sha256: measured.runtime_tree_sha256,
    isolation_profile_sha256: measured.isolation_profile_sha256,
    implementation_identity_sha256: measured.implementation_identity_sha256,
    deployment_identity_sha256: measured.deployment_identity_sha256,
    measured_joern_version: measured.measured_joern_version,
    max_num_def: measured.max_num_def,
    qualify: (input) => measured.qualify(input),
  };
}

const ownedAttemptOrdinals = new WeakMap<HostOperationExecutionContextV1, number>();
const ownedCommandCounts = new WeakMap<HostOperationExecutionContextV1, number>();
export function chargeScaP03OwnedCommandV1(owned: ScaP03DockerOwnedExecutionV1): void {
  const count = (ownedCommandCounts.get(owned.context) ?? 0) + 1;
  if (count > owned.resources.max_commands) throw new Error("p03_owned_command_limit");
  ownedCommandCounts.set(owned.context, count);
}
export function scaP03OwnedAttemptOrdinalV1(owned: ScaP03DockerOwnedExecutionV1): number {
  const next = (ownedAttemptOrdinals.get(owned.context) ?? 0) + 1;
  if (next > owned.resources.max_commands) throw new Error("p03_owned_attempt_limit");
  ownedAttemptOrdinals.set(owned.context, next);
  return next;
}
export interface ScaP03DockerOwnedExecutionV1 {
  readonly context: HostOperationExecutionContextV1;
  readonly resources: ScaP03InitialResourcesV1;
  assertAuthority(): void;
}
/** No structural callback/boolean is an initial grant. The actual authorization and native
 * P02 owner replay run before beginSubmission and again before every work boundary. */
export async function createScaP03DockerOwnedInitialCandidateV1(
  config: ScaP03DockerCandidateConfigV1,
  runner: DockerRunnerV1,
  admitted: {
    readonly context: HostOperationExecutionContextV1;
    readonly resources: ScaP03InitialResourcesV1;
    readonly authorization: ScaP03InitialAuthorizationV1;
    readonly proposal: ScaP03InitialProposalV1;
    readonly gate: ScaP03InitialGateBindingV1;
    readonly native_host?: ScaP03InitialNativeHostV1;
    readonly pre_live: ScaP03PreLiveInputsV1;
    readonly store: ArtifactStore;
    readonly witness?: ScaP03HostWitnessSinkV1;
  }
): Promise<
  ScaP03DockerCandidateV1 & {
    measureEnvironment(signal: AbortSignal): Promise<ScaP03BootstrapEnvironmentMeasurementV1>;
  }
> {
  if (
    !(admitted.authorization instanceof ScaP03InitialAuthorizationV1) ||
    !(admitted.native_host instanceof ScaP03InitialNativeHostV1)
  )
    throw new Error("p03_initial_native_admission_required");
  const nativeHost = admitted.native_host;
  const assertAuthority = () => {
    admitted.authorization.assertEffect(admitted.context, admitted.proposal, admitted.gate);
    nativeHost.assertCapsule(admitted.proposal);
    nativeHost.assertCurrentP02(admitted.pre_live, admitted.proposal);
    nativeHost.assertPredecessorClosure(admitted.pre_live, admitted.proposal);
  };
  assertAuthority();
  if (
    canonicalJson(config) !== canonicalJson(nativeHost.capsule.config) ||
    canonicalJson(admitted.resources) !== canonicalJson(admitted.proposal.resources)
  )
    throw new Error("p03_initial_owned_config_drift");
  if (admitted.context.journal.lifecycle !== "lease_acquired")
    throw new Error("p03_initial_fresh_owner_required");
  admitted.context.beginSubmission();
  // The seed/count predeclares every exact name and label under ONE journal correlation.
  // This is recovery data, not proof that any remote work has completed.
  const seed = sha256(admitted.context.journal.operation_record_id);
  admitted.context.recordRemoteAccepted(
    canonicalJson({ schema_version: 1, seed, count: admitted.resources.max_commands, label: seed })
  );
  const owned: ScaP03DockerOwnedExecutionV1 = {
    context: admitted.context,
    resources: admitted.resources,
    assertAuthority,
  };
  const measured = await createMeasuredDockerRuntime(config, runner, admitted.witness, owned);
  return {
    runtime_id: measured.runtime_id,
    isolation_id: measured.isolation_id,
    runtime_tree_sha256: measured.runtime_tree_sha256,
    isolation_profile_sha256: measured.isolation_profile_sha256,
    implementation_identity_sha256: measured.implementation_identity_sha256,
    deployment_identity_sha256: measured.deployment_identity_sha256,
    measured_joern_version: measured.measured_joern_version,
    max_num_def: measured.max_num_def,
    measureEnvironment: (signal) => measured.measureEnvironment(signal),
    qualify: (value) => measured.qualify(value),
  };
}

/** Explicitly constructed, never registered by default. A Docker runner may be injected for isolated contract tests. */
async function createMeasuredDockerRuntime(
  config: ScaP03DockerCandidateConfigV1,
  runner: DockerRunnerV1 = dockerCommandV1(config.docker_executable),
  witness?: ScaP03HostWitnessSinkV1,
  owned?: ScaP03DockerOwnedExecutionV1
): Promise<ScaP03MeasuredDockerRuntimeV1> {
  verifyScaP03DockerConfigV1(config);
  const parent = await privateParent(config);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("p03_non_posix_host");
  const owner: { readonly uid: number; readonly gid: number } = { uid, gid };
  let attemptOrdinal = 0;
  const tmpfs = `/tmp:rw,exec,nosuid,nodev,size=${String(owned?.resources.tmp_bytes ?? 67_108_864)}`;
  async function workspaceBytes(root: string, depth = 0): Promise<number> {
    if (depth > 32) throw new Error("p03_initial_workspace_depth");
    let bytes = 0;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
        throw new Error("p03_initial_workspace_custody");
      bytes += stat.isDirectory() ? await workspaceBytes(file, depth + 1) : stat.size;
      if (owned !== undefined && bytes > owned.resources.max_host_workspace_bytes)
        throw new Error("p03_initial_workspace_byte_limit");
    }
    return bytes;
  }
  async function execute(
    args: readonly string[],
    work: string,
    signal: AbortSignal,
    limit = config.max_command_output_bytes
  ): Promise<string> {
    const cleanup = owned !== undefined && signal !== owned.context.signal;
    if (owned !== undefined) {
      chargeScaP03OwnedCommandV1(owned);
      if (!cleanup) owned.assertAuthority();
      await workspaceBytes(work);
    }
    const output = await runner({
      argv: args,
      docker_config: path.join(work, "docker-config"),
      timeout_ms: config.timeout_ms,
      output_bytes: Math.min(limit, config.max_command_output_bytes),
      signal,
    });
    if (Buffer.byteLength(output) > Math.min(limit, config.max_command_output_bytes))
      throw new Error("p03_owned_output_limit");
    if (owned !== undefined && !cleanup) {
      owned.assertAuthority();
      owned.context.reportActivity("p03_owned_command_completed", Buffer.byteLength(output) + 1);
    }
    return output;
  }
  type Container = (
    entrypoint: string,
    args: readonly string[],
    source: string | null,
    input: string | null,
    expectedOutput: "graph.cpg.bin" | "inventory.tsv" | null
  ) => Promise<string>;
  async function withWork<T>(
    signal: AbortSignal,
    task: (
      work: string,
      run: (argv: readonly string[], limit?: number) => Promise<string>,
      container: Container
    ) => Promise<T>
  ): Promise<T> {
    signal.throwIfAborted();
    owned?.assertAuthority();
    const cleanupController = new AbortController();
    const cleanupSignal = cleanupController.signal;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const beginCleanup = () => {
      cleanupTimer ??= setTimeout(
        () => cleanupController.abort(new Error("p03_cleanup_grace_expired")),
        owned?.resources.cleanup_grace_ms ?? config.timeout_ms
      );
    };
    const work = await mkdtemp(path.join(parent, "p03-"));
    const dockerConfig = path.join(work, "docker-config");
    let name: string | null = null;
    let outcome:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown };
    try {
      await chmod(work, 0o700);
      const workStat = await lstat(work);
      witness?.startWorkspace(canonicalJson({ path: work, dev: workStat.dev, ino: workStat.ino }));
      await mkdir(dockerConfig, { mode: 0o700 });
      await mkdir(path.join(work, "scripts"), { mode: 0o700 });
      await writeFile(path.join(work, "scripts", "readback.py"), READBACK_SCRIPT, {
        flag: "wx",
        mode: 0o400,
      });
      const run = (argv: readonly string[], limit?: number) => execute(argv, work, signal, limit);
      // Name is owner-created random identity: cleanup never selects by caller path, label or prefix.
      const container: Container = async (entrypoint, args, source, input, expectedOutput) => {
        signal.throwIfAborted();
        if (owned !== undefined) attemptOrdinal = scaP03OwnedAttemptOrdinalV1(owned);
        const seed = owned === undefined ? null : sha256(owned.context.journal.operation_record_id);
        const n = seed === null ? null : sha256(`${seed}:${String(attemptOrdinal)}`);
        name =
          n === null
            ? `penny-p03-${randomUUID()}`
            : `penny-p03-${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20, 32)}`;
        const currentName = name;
        const scripts = path.join(work, "scripts");
        const mounts = [
          "--mount",
          `type=bind,src=${scripts},dst=/scripts,readonly`,
          ...(source === null ? [] : ["--mount", `type=bind,src=${source},dst=/source,readonly`]),
          ...(input === null ? [] : ["--mount", `type=bind,src=${input},dst=/input,readonly`]),
        ];
        const workspaceTmpfs = `/work:rw,exec,nosuid,nodev,size=${String(config.max_workspace_bytes)},mode=0700,uid=${String(uid)},gid=${String(gid)}`;
        const createArgs = scaP03NativeCreateArgvV1({
          config,
          seed,
          attemptOrdinal,
          currentName,
          uid: owner.uid,
          gid: owner.gid,
          tmpfs,
          workspaceTmpfs,
          mounts,
          jvmHeapBytes: owned?.resources.jvm_heap_bytes ?? null,
        });
        witness?.create(currentName, createArgs);
        const id = (await run(createArgs)).trim();
        witness?.id(currentName, id);
        if (!CONTAINER_ID.test(id)) throw new Error("p03_container_id_invalid");
        const imageInspection: unknown = JSON.parse(
          await run(["image", "inspect", "--format", "{{json .}}", config.image_ref])
        );
        const imageId = dockerImageId(imageInspection, config.image_ref);
        if (imageId === null) throw new Error("p03_image_identity_drift");
        if (owned !== undefined) {
          const inspectedImage = record(imageInspection);
          const imageConfiguration = record(inspectedImage?.Config);
          const volumes = record(imageConfiguration?.Volumes);
          if (
            imageConfiguration === null ||
            (volumes !== null && Object.keys(volumes).length !== 0)
          )
            throw new Error("p03_initial_image_volumes_forbidden");
        }
        const measuredDeployment = sha256(
          canonicalJson({
            docker_executable_sha256: config.expected_docker_executable_sha256,
            docker_client_version: config.expected_docker_client_version,
            docker_server_version: config.expected_docker_server_version,
            image_id: imageId,
            joern_version: config.expected_joern_version,
          })
        );
        if (measuredDeployment !== config.deployment_identity_sha256)
          throw new Error("p03_deployment_measurement_mismatch");
        const inspected: unknown = JSON.parse(
          await run(["container", "inspect", "--format", "{{json .}}", id])
        );
        const confined = isContainer(inspected, id, imageId, currentName, {
          config,
          ...owner,
          source,
          input,
          scripts,
          workspaceTmpfs,
          tmpfs,
        });
        witness?.inspect(
          currentName,
          canonicalJson(inspected),
          confined ? confinementProjection(inspected) : null
        );
        if (seed !== null) {
          if (
            !scaP03OwnedDockerLabelsMatchV1(
              record(record(inspected)?.Config)?.Labels,
              record(record(imageInspection)?.Config)?.Labels,
              seed,
              attemptOrdinal
            )
          )
            throw new Error("p03_initial_ownership_label_drift");
        }
        if (!confined) throw new Error("p03_container_identity_drift");
        await run(["container", "start", id]);
        const after: unknown = JSON.parse(
          await run(["container", "inspect", "--format", "{{json .}}", id])
        );
        if (
          seed !== null &&
          !scaP03OwnedDockerLabelsMatchV1(
            record(record(after)?.Config)?.Labels,
            record(record(imageInspection)?.Config)?.Labels,
            seed,
            attemptOrdinal
          )
        )
          throw new Error("p03_initial_ownership_label_drift");
        const runningConfined =
          isContainer(after, id, imageId, currentName, {
            config,
            ...owner,
            source,
            input,
            scripts,
            workspaceTmpfs,
            tmpfs,
          }) && isRunning(after);
        witness?.inspect(
          currentName,
          canonicalJson(after),
          runningConfined ? confinementProjection(after) : null
        );
        if (runningConfined) witness?.startContainer(currentName);
        if (!runningConfined) throw new Error("p03_container_running_unproven");
        // Keep the tmpfs mounted until the output has been read and checked.
        const commandArgs = ["container", "exec", id, entrypoint, ...args];
        witness?.command(currentName, commandArgs, expectedOutput !== null);
        const response = await run(commandArgs);
        witness?.response(currentName, response);
        if (expectedOutput !== null) {
          // Read from the still-mounted tmpfs. The fixed script lists the entire root and
          // opens the sole regular file with O_NOFOLLOW relative to a no-follow dir fd.
          const encoded = await run(
            [
              "container",
              "exec",
              id,
              "python3",
              "/scripts/readback.py",
              expectedOutput,
              String(
                owned === undefined
                  ? config.max_workspace_bytes
                  : expectedOutput === "graph.cpg.bin"
                    ? owned.resources.max_graph_bytes
                    : owned.resources.max_query_bytes
              ),
            ],
            config.max_command_output_bytes
          );
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
            throw new Error("p03_output_encoding_invalid");
          const bytes = Buffer.from(encoded, "base64");
          if (
            bytes.byteLength === 0 ||
            bytes.byteLength > config.max_workspace_bytes ||
            bytes.toString("base64") !== encoded
          )
            throw new Error("p03_output_invalid");
          if (
            owned !== undefined &&
            (await workspaceBytes(work)) + bytes.byteLength >
              owned.resources.max_host_workspace_bytes
          )
            throw new Error("p03_initial_workspace_byte_limit");
          witness?.readback(currentName, bytes);
          await writeFile(path.join(work, "output", expectedOutput), bytes, {
            flag: "wx",
            mode: 0o600,
          });
        }
        beginCleanup();
        await execute(["container", "rm", "--force", currentName], work, cleanupSignal);
        if (
          (
            await execute(
              [
                "container",
                "ls",
                "--all",
                "--filter",
                `name=^/${currentName}$`,
                "--format",
                "{{.ID}}",
              ],
              work,
              cleanupSignal
            )
          ).trim() !== ""
        )
          throw new Error("p03_container_removal_unproven");
        witness?.removal(currentName, true);
        name = null;
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
        cleanupTimer = undefined;
        return response;
      };
      outcome = { ok: true, value: await task(work, run, container) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    let cleanupError: unknown;
    beginCleanup();
    if (name !== null) {
      try {
        // The exact name also cleans a container whose create reply was lost.
        await execute(["container", "rm", "--force", name], work, cleanupSignal);
        if (
          (
            await execute(
              ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
              work,
              cleanupSignal
            )
          ).trim() !== ""
        )
          throw new Error("p03_container_removal_unproven");
        witness?.removal(name, true);
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await rm(work, { recursive: true, force: false });
      try {
        await lstat(work);
        throw new Error("p03_workspace_removal_unproven");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      witness?.finishWorkspace(true);
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    if (cleanupError !== undefined)
      throw new Error("p03_cleanup_unproven", {
        cause: { problem: outcome.ok ? undefined : outcome.error, cleanupError },
      });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  // Replace task signature below with a typed local runner that owns the entire lifecycle.
  async function operation<T>(
    signal: AbortSignal,
    task: (work: string, container: Container) => Promise<T>
  ): Promise<T> {
    return withWork(signal, async (work, _run, container) => task(work, container));
  }
  async function measure(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (
      sha256(await readFile(config.docker_executable)) !== config.expected_docker_executable_sha256
    )
      throw new Error("p03_docker_executable_drift");
    return operation(signal, async (work, container) => {
      const dockerVersion: unknown = JSON.parse(
        await execute(["version", "--format", "{{json .}}"], work, signal)
      );
      if (
        !isDockerVersion(
          dockerVersion,
          config.expected_docker_client_version,
          config.expected_docker_server_version
        )
      )
        throw new Error("p03_docker_daemon_drift");
      const inspected: unknown = JSON.parse(
        await execute(
          ["image", "inspect", "--format", "{{json .}}", config.image_ref],
          work,
          signal
        )
      );
      const imageId = dockerImageId(inspected, config.image_ref);
      if (imageId === null) throw new Error("p03_image_identity_drift");
      const output = path.join(work, "output");
      await mkdir(output, { mode: 0o700 });
      const version = parseScaP03JoernPackageListingV1(
        await container(
          "find",
          ["/opt/joern", "-type", "f", "-name", "io.joern.joern-cli-*.jar", "-printf", "%f\\n"],
          null,
          null,
          null
        ),
        "joern-cli"
      );
      assertScaP03JoernLauncherProbeV1(
        await container("which", ["joern"], null, null, null),
        await container("joern", ["--help"], null, null, null)
      );
      if (version !== config.expected_joern_version) throw new Error("p03_joern_version_drift");
      const measuredDeployment = sha256(
        canonicalJson({
          docker_executable_sha256: config.expected_docker_executable_sha256,
          docker_client_version: config.expected_docker_client_version,
          docker_server_version: config.expected_docker_server_version,
          image_id: imageId,
          joern_version: config.expected_joern_version,
        })
      );
      if (measuredDeployment !== config.deployment_identity_sha256)
        throw new Error("p03_deployment_measurement_mismatch");
      return imageId;
    });
  }
  const imageId = await measure(owned?.context.signal ?? new AbortController().signal);
  return {
    runtime_id: config.runtime_id,
    isolation_id: config.isolation_id,
    runtime_tree_sha256: imageId.slice(7),
    isolation_profile_sha256: config.isolation_profile_sha256,
    implementation_identity_sha256: config.implementation_identity_sha256,
    deployment_identity_sha256: config.deployment_identity_sha256,
    staging_parent: parent,
    measured_joern_version: config.expected_joern_version,
    max_num_def: config.max_num_def,
    async measureEnvironment(signal) {
      if (owned === undefined) throw new Error("p03_initial_native_admission_required");
      return operation(signal, async (_work, container) => {
        const listing = async (part: "php2cpg" | "jssrc2cpg") =>
          parseScaP03JoernPackageListingV1(
            await container(
              "find",
              ["/opt/joern", "-type", "f", "-name", `io.joern.${part}-*.jar`, "-printf", "%f\\n"],
              null,
              null,
              null
            ),
            part
          );
        const version = async (tool: string) => {
          const output = await container(tool, ["--version"], null, null, null);
          const value = output
            .trim()
            .split("\n")[0]
            ?.match(/\b[0-9]+(?:\.[0-9]+){0,5}(?:[-+][A-Za-z0-9.]+)?\b/)?.[0];
          if (value === undefined || value.length > 64)
            throw new Error("p03_initial_tool_version_invalid");
          return value;
        };
        const php = await listing("php2cpg"),
          js = await listing("jssrc2cpg");
        if (php !== config.expected_joern_version || js !== config.expected_joern_version)
          throw new Error("p03_initial_frontend_drift");
        return {
          docker_executable_bytes: await readFile(config.docker_executable),
          docker_client_version: config.expected_docker_client_version,
          docker_server_version: config.expected_docker_server_version,
          image_ref: config.image_ref,
          image_id: imageId,
          joern_version: config.expected_joern_version,
          php_frontend_version: php,
          javascript_frontend_version: js,
          jvm_version: await version("java"),
          php_runtime_version: await version("php"),
          helper_version: await version("python3"),
        };
      });
    },
    async buildGraph({ request, files, signal }): Promise<ScaP03RuntimeGraphOutputV1> {
      await measure(signal);
      return operation(signal, async (work, container) => {
        const source = path.join(work, "source");
        const output = path.join(work, "output");
        await mkdir(source, { mode: 0o700 });
        await mkdir(output, { mode: 0o700 });
        if (request.max_num_def !== config.max_num_def) throw new Error("p03_num_def_policy_drift");
        if (
          files.length !== request.expected_files.length ||
          files.some((file, index) => {
            const expected = request.expected_files[index];
            return (
              expected?.path !== file.path ||
              expected?.content_sha256 !== file.content_sha256 ||
              expected?.role !== file.role
            );
          })
        )
          throw new Error("p03_source_custody_invalid");
        let inputBytes = 0;
        for (const file of files) {
          if (!safePath(file.path) || sha256(file.bytes) !== file.content_sha256)
            throw new Error("p03_source_custody_invalid");
          inputBytes += file.bytes.byteLength;
          if (
            inputBytes > config.max_workspace_bytes ||
            inputBytes + request.max_graph_bytes > config.max_workspace_bytes
          )
            throw new Error("p03_workspace_limit");
          const target = path.join(source, file.path);
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, file.bytes, { flag: "wx", mode: 0o600 });
          await chmod(target, 0o400);
        }
        await container(
          "joern-parse",
          [
            "--language",
            request.frontend_language,
            "--output",
            "/work/graph.cpg.bin",
            "--max-num-def",
            String(request.max_num_def),
            "/source",
          ],
          source,
          null,
          "graph.cpg.bin"
        );
        const graph = await regularFile(
          path.join(output, "graph.cpg.bin"),
          request.max_graph_bytes
        );
        const parsed = await inspectGraph(work, output, source, container);
        assertFrontend(parsed, request.frontend_language);
        const accounted_files = files.map((f) => ({
          path: f.path,
          content_sha256: f.content_sha256,
          disposition: parsed.files.has(f.path)
            ? f.role === "contextual"
              ? ("contextual" as const)
              : ("parsed" as const)
            : ("unsupported" as const),
          reason_code: parsed.files.has(f.path) ? null : "joern_file_absent",
        }));
        return {
          graph_bytes: graph,
          accounted_files,
          graph_opened: true,
          cleanup_evidence: {
            workspace_removed: true,
            graph_handles_closed: true,
            process_exit_observed: true,
            cleanup_sha256: sha256(
              canonicalJson({
                workspace_removed: true,
                graph_handles_closed: true,
                process_exit_observed: true,
              })
            ),
          },
        };
      });
    },
    async runBaselineQueries({ request, query_release, graph_bytes, accounted_files, signal }) {
      await measure(signal);
      if (
        sha256(graph_bytes) !== request.graph_component_sha256 ||
        graph_bytes.byteLength > config.max_workspace_bytes
      )
        throw new Error("p03_graph_custody_invalid");
      return operation(signal, async (work, container) => {
        const output = path.join(work, "output");
        await mkdir(output, { mode: 0o700 });
        await writeFile(path.join(output, "graph.cpg.bin"), graph_bytes, {
          flag: "wx",
          mode: 0o600,
        });
        const parsed = await inspectGraph(work, output, null, container);
        assertFrontend(parsed, scaP03FrontendLanguageV1(request.partition));
        if (
          accounted_files.some(
            (file) =>
              (file.disposition === "parsed" || file.disposition === "contextual") &&
              !parsed.files.has(file.path)
          )
        )
          throw new Error("p03_graph_file_accounting_drift");
        const candidates = queryCandidates(
          query_release,
          parsed,
          accounted_files,
          request.max_query_items,
          {
            graph_component_sha256: request.graph_component_sha256,
            source_snapshot_sha256: request.source_snapshot_sha256,
          }
        );
        const totalItems = [...candidates.values()].reduce((sum, items) => sum + items.length, 0);
        if (totalItems > request.max_query_items) throw new Error("p03_query_item_limit");
        const pages = SCA_P03_QUERY_IDS.flatMap((query_id) => {
          const items = candidates.get(query_id) ?? [];
          const count = Math.max(1, Math.ceil(items.length / request.max_page_items));
          if (count > request.max_pages_per_query) throw new Error("p03_query_page_limit");
          return Array.from({ length: count }, (_, index) => ({
            query_id,
            page_number: index + 1,
            items: items.slice(
              index * request.max_page_items,
              (index + 1) * request.max_page_items
            ),
            complete: index === count - 1,
          }));
        });
        return {
          executed_query_release_sha256: query_release.release_sha256,
          pages,
          fidelity_observations: request.fidelity_requirements.map((f) => ({
            requirement_id: f.requirement_id,
            support: "partial" as const,
            reason_code: "joern_fidelity_unproven",
          })),
          truncated: false,
        };
      });
    },
    async qualify({
      fixtures,
      expected_cases,
      source_oracle_validation_ref,
      source_oracle_validation_receipt,
      query_release,
      signal,
    }) {
      if (
        source_oracle_validation_ref !== undefined &&
        !sameRef(source_oracle_validation_receipt, source_oracle_validation_ref, expected_cases)
      )
        throw new Error("p03_oracle_receipt_not_validated");
      await measure(signal);
      const cases: ScaP03QualificationCaseV2[] = [];
      let totalObservationBytes = 0;
      for (const language of ["php", "javascript", "typescript"] as const) {
        const frontend_language = scaP03FrontendLanguageV1(language);
        const fixture = fixtures.find((f) => f.language === language);
        if (
          fixture === undefined ||
          !safePath(fixture.path) ||
          fixture.bytes.byteLength >
            Math.min(
              owned?.resources.max_source_bytes ?? config.max_workspace_bytes / 2,
              12 * 1024 * 1024
            ) ||
          sha256(fixture.bytes) !== fixture.content_sha256
        )
          throw new Error("p03_fixture_custody_invalid");
        // Qualification is measured from actual parsed graph and frozen plans, never the simulated hash.
        let observed: ReadonlyMap<ScaP03QueryId, readonly ScaP03QueryCandidateV2[]> | null = null;
        let blocker_code: ScaP03QualificationBlockerCodeV2 | null = null;
        let stage: "parse" | "inventory" | "query" | "setup" = "setup";
        try {
          observed = await operation(signal, async (work, container) => {
            const source = path.join(work, "source");
            const output = path.join(work, "output");
            await mkdir(source, { mode: 0o700 });
            await mkdir(output, { mode: 0o700 });
            const target = path.join(source, fixture.path);
            await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            await writeFile(target, fixture.bytes, { flag: "wx", mode: 0o400 });
            stage = "parse";
            await container(
              "joern-parse",
              [
                "--language",
                frontend_language,
                "--output",
                "/work/graph.cpg.bin",
                "--max-num-def",
                String(config.max_num_def),
                "/source",
              ],
              source,
              null,
              "graph.cpg.bin"
            );
            await regularFile(
              path.join(output, "graph.cpg.bin"),
              owned?.resources.max_graph_bytes ?? config.max_workspace_bytes
            );
            stage = "inventory";
            const data = await inspectGraph(work, output, source, container);
            assertFrontend(data, frontend_language);
            stage = "query";
            if (!data.files.has(fixture.path)) throw new Error("p03_fixture_not_in_graph");
            if (!data.nodes.some((node) => node.file_name === fixture.path))
              throw new Error("p03_fixture_nodes_absent");
            const candidates = queryCandidates(
              query_release,
              data,
              [{ path: fixture.path, disposition: "parsed" }],
              owned?.resources.max_query_items ?? 1000,
              {
                graph_component_sha256: sha256(await readFile(path.join(output, "graph.cpg.bin"))),
                source_snapshot_sha256: fixture.content_sha256,
              },
              expected_cases.filter((entry) => entry.language === language),
              source_oracle_validation_ref,
              Buffer.from(fixture.bytes).toString("utf8").split("\n")
            );
            // Enforce the qualification cache budget before publishing any case.
            // An oversized result blocks the fixture; it is never sliced to fit.
            for (const query of query_release.queries) {
              const oracle = expected_cases.find(
                (entry) => entry.language === language && entry.query_id === query.query_id
              );
              if (oracle === undefined) throw new Error("p03_query_binding_invalid");
              const observations = projectScaP03OracleTargetObservationsV2(
                candidates.get(query.query_id) ?? [],
                oracle.oracle_assertions
              );
              if (
                Buffer.byteLength(canonicalJson(observations), "utf8") >
                SCA_P03_MAX_QUALIFICATION_CASE_BYTES
              )
                throw new Error("p03_query_limit_reached");
            }
            return candidates;
          });
        } catch (error) {
          signal.throwIfAborted();
          if (
            error instanceof Error &&
            (error.message === "p03_cleanup_unproven" ||
              error.message.startsWith("p03_live_") ||
              error.message.startsWith("p03_initial_"))
          )
            throw error;
          blocker_code = fixtureBlockerCode(error, stage);
          // Keep the affected fixture's seven cases explicitly blocked. Never promote
          // a successful but empty/wrong-frontend CPG to seven passed observations.
        }
        for (const query of query_release.queries) {
          const case_id = `p03-${language}-${query.query_id.replaceAll(".", "-")}`;
          const expected = expected_cases.find(
            (entry) =>
              entry.case_id === case_id &&
              entry.language === language &&
              entry.query_id === query.query_id
          );
          // Raw start selection and all downstream limits are enforced before projection.
          // Keep other endpoints from that start for review; exact declared negatives block.
          const observations = projectScaP03OracleTargetObservationsV2(
            observed?.get(query.query_id) ?? [],
            expected?.oracle_assertions ?? []
          ).sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
          // The outer array adds two brackets and one comma for each later case.
          totalObservationBytes +=
            Buffer.byteLength(canonicalJson(observations), "utf8") + (cases.length === 0 ? 2 : 1);
          if (
            totalObservationBytes >
            Math.min(
              owned?.resources.max_evidence_bytes ?? SCA_P03_MAX_QUALIFICATION_TOTAL_BYTES,
              SCA_P03_MAX_QUALIFICATION_TOTAL_BYTES
            )
          )
            throw new Error("p03_query_limit_reached");
          const caseBlocker =
            blocker_code ??
            (expected !== undefined &&
            scaP03QualificationAssertionsMatchV2(observations, expected.oracle_assertions)
              ? null
              : "p03_oracle_assertion_mismatch");
          cases.push({
            case_id,
            language,
            query_id: query.query_id,
            frontend_language,
            status: caseBlocker === null ? "passed" : "blocked",
            blocker_code: caseBlocker,
            fixture_id: fixture.fixture_id,
            fixture_sha256: fixture.content_sha256,
            observation_count: observations.length,
            observations,
            observed_sha256: scaP03QualificationObservationSha256V2({
              fixture_id: fixture.fixture_id,
              fixture_sha256: fixture.content_sha256,
              query_id: query.query_id,
              frontend_language,
              release_sha256: query_release.release_sha256,
              blocker_code: caseBlocker,
              observations,
            }),
          });
        }
      }
      return { executed_query_release_sha256: query_release.release_sha256, cases };
    },
  };
}

/** Isolated contract-test seam: never live-qualified and never an attestation producer. */
export async function createScaP03DockerSimulatedTestRuntimeV1(
  config: ScaP03DockerCandidateConfigV1,
  runner: DockerRunnerV1
): Promise<ScaP03JoernRuntimeV1> {
  if (
    "host_attestation_ref" in config ||
    "host_attestation_id" in config ||
    "host_attestation_sha256" in config
  )
    throw new Error("p03_candidate_attestation_forbidden");
  const measured = await createMeasuredDockerRuntime(config, runner);
  return {
    ...measured,
    runtime_kind: "simulated_joern_test_runtime",
    qualification_scope: "deterministic_test_only",
    simulation_label: "simulated_joern_test_seam",
    qualify: (input) => measured.qualify(input),
  };
}

/** Never accepts a bare attestation ref. Exact persisted PASS and independent host authority are required. */
export async function createScaP03DockerJoernRuntimeV1(
  config: ScaP03DockerRuntimeConfigV1,
  proof: Readonly<{
    authority: ScaP03ClosedHostAuthorityV3;
    binding_ref: ArtifactRef;
    host_attestation_ref: ArtifactRef;
    qualification_record_ref: ArtifactRef;
    review_ref: ArtifactRef;
  }>,
  runner: DockerRunnerV1 = dockerCommandV1(config.docker_executable)
): Promise<ScaP03JoernRuntimeV1> {
  void config;
  void proof;
  void runner;
  throw new Error("p03_guarded_runtime_composition_unavailable");
}

/** Offline V3 contract fixture only. Substituted Docker observations cannot qualify a host.
 * Never use this constructor as production activation or an operational entrypoint. */
export async function createScaP03DockerBootstrapDeterministicTestOnlyRuntimeV3(
  config: ScaP03DockerRuntimeConfigV1,
  proof: Parameters<typeof createScaP03DockerJoernRuntimeV1>[1],
  runner: DockerRunnerV1
): Promise<ScaP03JoernRuntimeV1> {
  return createQualifiedRuntime(config, proof, runner, "v3_offline");
}

/** Production factory: accepted P01 roots are revalidated before every runtime use. */
export async function createScaP03ProductionDockerJoernRuntimeV1(
  config: ScaP03DockerRuntimeConfigV1,
  proof: Readonly<{
    authority: ScaP03ClosedHostAuthorityV3;
    store: ArtifactHostStore & ScaP03BootstrapArtifactReaderV1;
    production_bindings: ScaP03FrozenProductionBindingsV1;
    production_record_ref: ArtifactRef;
    owner_policy?: {
      readonly native_host: ScaP03InitialNativeHostV1;
      readonly sealed_inputs: ScaP03SealedBootstrapInputsV1;
      readonly resources: ScaP03InitialResourcesV1;
    };
    binding_ref: ArtifactRef;
    host_attestation_ref: ArtifactRef;
    qualification_record_ref: ArtifactRef;
    review_ref: ArtifactRef;
  }>,
  runner?: DockerRunnerV1
): Promise<ScaP03JoernRuntimeV1> {
  config = structuredClone(config);
  verifyScaP03DockerConfigV1(config);
  if (
    !(proof.authority instanceof ScaP03ClosedHostAuthorityV3) ||
    !(proof.owner_policy?.native_host instanceof ScaP03InitialNativeHostV1)
  )
    throw new Error("p03_production_native_proof_required");
  const ownerPolicy = proof.owner_policy;
  if (ownerPolicy === undefined || !(proof.store instanceof ArtifactStore))
    throw new Error("p03_production_native_policy_required");
  const store = proof.store;
  const selected = {
    ...proof,
    binding_ref: structuredClone(proof.binding_ref),
    host_attestation_ref: structuredClone(proof.host_attestation_ref),
    qualification_record_ref: structuredClone(proof.qualification_record_ref),
    review_ref: structuredClone(proof.review_ref),
    production_record_ref: structuredClone(proof.production_record_ref),
    production_bindings: structuredClone(proof.production_bindings),
    owner_policy: {
      ...ownerPolicy,
      sealed_inputs: structuredClone(ownerPolicy.sealed_inputs),
      resources: structuredClone(ownerPolicy.resources),
    },
  };
  const frozen = readP03ProductionInputs(proof.store, selected.production_bindings);
  const attestation = validateScaP03HostIsolationAttestationV1(
    JSON.parse(Buffer.from(store.read(selected.host_attestation_ref)).toString("utf8"))
  );
  const capsule = selected.owner_policy.native_host.capsule;
  if (
    capsule.schema_id !== "penny.sca-p03-sealed-bootstrap-capsule.v1" ||
    canonicalJson(capsule.config) !== canonicalJson(config)
  )
    throw new Error("p03_production_capsule_required");
  // Construction performs only exact immutable reads; NEVER proof callbacks or Docker.
  const runtime: ScaP03JoernRuntimeV1 = {
    runtime_kind: "host_qualified_joern",
    qualification_scope: "live_qualified",
    runtime_id: config.runtime_id,
    isolation_id: config.isolation_id,
    runtime_tree_sha256: selected.production_bindings.frozen.runtime_tree_sha256,
    isolation_profile_sha256: config.isolation_profile_sha256,
    implementation_identity_sha256: config.implementation_identity_sha256,
    deployment_identity_sha256: config.deployment_identity_sha256,
    host_attestation_id: attestation.attestation_id,
    host_attestation_sha256: selected.host_attestation_ref.content_digest,
    host_attestation_ref: selected.host_attestation_ref,
    source_oracle_ref: selected.production_bindings.frozen.source_oracle_ref,
    source_oracle_validation_ref: selected.production_bindings.frozen.source_oracle_validation_ref,
    parser_identity_sha256: frozen.parser_identity_sha256,
    staging_parent: config.staging_parent,
    measured_joern_version: config.expected_joern_version,
    max_num_def: config.max_num_def,
    async qualify(input) {
      const prepared = await prepare(input.context, input.request);
      if (
        canonicalJson(input.source_oracle_validation_ref) !==
        canonicalJson(prepared.checked.source_oracle_validation_ref)
      )
        throw new Error("p03_production_oracle_cross_splice");
      return prepared.measured.qualify(input);
    },
    async buildGraph(input) {
      return (await prepare(input.context, input.request)).measured.buildGraph(input);
    },
    async runBaselineQueries(input) {
      const prepared = await prepare(input.context, input.request);
      const binding = prepared.checked.fidelity_binding;
      if (
        canonicalJson(input.request.implementation_identity_ref) !==
          canonicalJson(binding.implementation_identity_ref) ||
        canonicalJson(input.request.qualification_profile_ref) !==
          canonicalJson(binding.qualification_profile_ref) ||
        canonicalJson(input.request.baseline_query_set_ref) !==
          canonicalJson(binding.baseline_query_set_ref) ||
        ![binding.query_release_sha256, binding.campaign_query_release_sha256].includes(
          input.query_release.release_sha256
        ) ||
        canonicalJson(input.request.fidelity_requirements) !==
          canonicalJson(
            binding.fidelity_requirements.filter(
              (entry) => entry.partition === input.request.partition
            )
          )
      )
        throw new Error("p03_production_fidelity_binding_mismatch");
      const result = await prepared.measured.runBaselineQueries(input);
      // Only the matched production proof supplies the capability evidence absent from
      // the measured runner. Unresolved, blocked and other partial observations stay unchanged.
      return {
        ...result,
        fidelity_observations: result.fidelity_observations.map((entry) =>
          entry.support === "partial" && entry.reason_code === "joern_fidelity_unproven"
            ? { ...entry, support: "supported" as const, reason_code: null }
            : entry
        ),
      };
    },
  };
  async function prepare(
    context: HostOperationExecutionContextV1 | undefined,
    request: import("../../orchestration/dist/sca/p03-contracts.js").ScaP03OperationRequestV1
  ) {
    if (
      context === undefined ||
      !isCanonicalHostOperationExecutionContextV1(context) ||
      context.journal.lifecycle !== "submitted"
    )
      throw new Error("p03_production_operation_context_required");
    const actual = validateScaP03OperationRequestV1(
      request.operation_kind,
      JSON.parse(Buffer.from(context.request_bytes).toString("utf8"))
    );
    if (
      canonicalJson(actual) !== canonicalJson(request) ||
      request.run_id !== context.directive.identity.run_id ||
      request.operation_id !== context.directive.operation_id ||
      request.backend_resource_sha256 !== context.directive.policy_binding.backend_key_sha256
    )
      throw new Error("p03_production_operation_binding_invalid");
    const { native_host, sealed_inputs, resources } = selected.owner_policy;
    const boundStore = createScaP03BoundVerificationReaderV1(context, store);
    const assertAuthority = () => {
      native_host.assertOperation(context);
      native_host.assertSealedCurrent(sealed_inputs, resources);
      readP03ProductionInputs(boundStore, selected.production_bindings);
    };
    assertAuthority();
    const parent = validateScaP03RequestV2(
      JSON.parse(Buffer.from(boundStore.read(request.p03_request_ref)).toString("utf8"))
    );
    const binding = parent.bootstrap_verification;
    if (
      binding === undefined ||
      binding.manifest_sha256 !== sealed_inputs.manifest_sha256 ||
      binding.backend_resource_sha256 !== request.backend_resource_sha256
    )
      throw new Error("p03_production_sealed_operand_binding_invalid");
    const boundSealed = validateContract(
      ScaP03SealedBootstrapInputsV1Schema,
      JSON.parse(Buffer.from(boundStore.read(binding.sealed_inputs_ref)).toString("utf8")),
      "P03 production sealed inputs"
    );
    if (canonicalJson(boundSealed) !== canonicalJson(sealed_inputs))
      throw new Error("p03_production_sealed_operand_cross_splice");
    const owned: ScaP03DockerOwnedExecutionV1 = { context, resources, assertAuthority };
    const transport =
      runner ??
      createScaP03OwnedDockerTransportV1({
        endpoint: {
          executable: config.docker_executable,
          executable_sha256: config.expected_docker_executable_sha256,
          socket: capsule.docker_socket,
          image_ref: config.image_ref,
        },
        ...owned,
      });
    const verification_context = {
      signal: context.signal,
      reportWorkMilestone: () => context.reportActivity("p03_production_proof_completed", 1),
      owned_execution: { owned, transport },
    };
    let checked: Awaited<ReturnType<typeof verifyScaP03ProductionProofV1>>;
    try {
      checked = await verifyScaP03ProductionProofV1({
        ...selected,
        store: boundStore,
        config,
        verification_context,
      });
    } catch (error) {
      throw new Error("p03_cleanup_unproven", { cause: error });
    }
    assertAuthority();
    const measured = await createMeasuredDockerRuntime(config, transport, undefined, owned);
    let after: Awaited<ReturnType<typeof verifyScaP03ProductionProofV1>>;
    try {
      after = await verifyScaP03ProductionProofV1({
        ...selected,
        store: boundStore,
        config,
        verification_context,
      });
    } catch (error) {
      throw new Error("p03_cleanup_unproven", { cause: error });
    }
    if (canonicalJson(checked) !== canonicalJson(after))
      throw new Error("p03_production_proof_drift");
    assertAuthority();
    return { measured, checked };
  }
  verifiedHostRuntimes.set(runtime, {
    proofHash: selected.qualification_record_ref.content_digest,
    brand: liveRuntimeBrand(runtime, selected.qualification_record_ref.content_digest),
  });
  return Object.freeze(runtime);
}

/** Contract-test seam: exercises the qualified constructor without granting a live runtime. */
export async function createScaP03DockerDeterministicTestQualifiedRuntimeV1(
  config: ScaP03DockerRuntimeConfigV1,
  proof: Readonly<{
    store: ScaP03BootstrapArtifactReaderV1;
    authority: ScaP03BootstrapHostAuthorityV1;
    binding_ref: ArtifactRef;
    host_attestation_ref: ArtifactRef;
    qualification_record_ref: ArtifactRef;
    review_ref: ArtifactRef;
  }>,
  runner: DockerRunnerV1
): Promise<ScaP03JoernRuntimeV1> {
  return createQualifiedRuntime(config, proof, runner, "v2_offline");
}

function liveAuthority(
  value: ScaP03ClosedHostAuthorityV3 | ScaP03BootstrapHostAuthorityV1
): ScaP03ClosedHostAuthorityV3 {
  if (!(value instanceof ScaP03ClosedHostAuthorityV3))
    throw new Error("p03_host_authority_invalid");
  return value;
}
function deterministicAuthority(
  value: ScaP03ClosedHostAuthorityV3 | ScaP03BootstrapHostAuthorityV1
): ScaP03BootstrapHostAuthorityV1 {
  if (value instanceof ScaP03ClosedHostAuthorityV3)
    throw new Error("p03_deterministic_authority_invalid");
  return value;
}
async function createQualifiedRuntime(
  config: ScaP03DockerRuntimeConfigV1,
  proof:
    | Parameters<typeof createScaP03DockerJoernRuntimeV1>[1]
    | Parameters<typeof createScaP03DockerDeterministicTestQualifiedRuntimeV1>[1],
  runner: DockerRunnerV1,
  proofClass: "v3_offline" | "v2_offline"
): Promise<ScaP03JoernRuntimeV1> {
  if (
    "host_attestation_ref" in config ||
    "host_attestation_id" in config ||
    "host_attestation_sha256" in config
  )
    throw new Error("p03_candidate_attestation_forbidden");
  const verify = () => {
    if (proofClass === "v3_offline")
      return verifyScaP03BootstrapProofV3({
        ...proof,
        config,
        authority: liveAuthority(proof.authority),
      });
    if (!("store" in proof)) throw new Error("p03_deterministic_store_missing");
    return verifyScaP03DeterministicTestProofV2({
      ...proof,
      config,
      authority: deterministicAuthority(proof.authority),
    });
  };
  const verified = await verify();
  const measured = await createMeasuredDockerRuntime(config, runner);
  // Re-read after measurement: proof replacement during a potentially long Docker probe fails closed.
  const checked = await verify();
  if (canonicalJson(verified) !== canonicalJson(checked))
    throw new Error("p03_bootstrap_proof_drift");
  const runtime: ScaP03JoernRuntimeV1 = {
    ...measured,
    runtime_kind: "simulated_joern_test_runtime",
    qualification_scope: "deterministic_test_only",
    simulation_label: "simulated_joern_test_seam",
    qualify: async (input) => {
      const current = await verify();
      if (canonicalJson(current) !== canonicalJson(checked))
        throw new Error("p03_bootstrap_proof_drift");
      if (
        input.source_oracle_validation_ref === undefined ||
        canonicalJson(input.source_oracle_validation_ref) !==
          canonicalJson(checked.source_oracle_validation_ref)
      )
        throw new Error("p03_bootstrap_oracle_receipt_cross_splice");
      return measured.qualify(input);
    },
    buildGraph: async (input) => {
      const current = await verify();
      if (canonicalJson(current) !== canonicalJson(checked))
        throw new Error("p03_bootstrap_proof_drift");
      return measured.buildGraph(input);
    },
    runBaselineQueries: async (input) => {
      const current = await verify();
      if (canonicalJson(current) !== canonicalJson(checked))
        throw new Error("p03_bootstrap_proof_drift");
      // Fidelity is qualified against the exact frozen implementation/profile/release,
      // not inferred from candidate counts. Unresolved observations remain unchanged.
      if (proofClass === "v2_offline") return measured.runBaselineQueries(input);
      if (!("fidelity_binding" in current)) throw new Error("p03_fidelity_binding_missing");
      const binding = current.fidelity_binding;
      if (
        input.request.runtime_kind !== "simulated_joern_test_runtime" ||
        input.request.qualification_scope !== "deterministic_test_only" ||
        canonicalJson(input.request.implementation_identity_ref) !==
          canonicalJson(binding.implementation_identity_ref) ||
        canonicalJson(input.request.qualification_profile_ref) !==
          canonicalJson(binding.qualification_profile_ref) ||
        canonicalJson(input.request.baseline_query_set_ref) !==
          canonicalJson(binding.baseline_query_set_ref) ||
        ![binding.query_release_sha256, binding.campaign_query_release_sha256].includes(
          input.query_release.release_sha256
        ) ||
        canonicalJson(input.request.fidelity_requirements) !==
          canonicalJson(
            binding.fidelity_requirements.filter(
              (entry) => entry.partition === input.request.partition
            )
          )
      )
        throw new Error("p03_fidelity_binding_mismatch");
      const output = await measured.runBaselineQueries(input);
      if (output.executed_query_release_sha256 !== input.query_release.release_sha256)
        throw new Error("p03_fidelity_binding_mismatch");

      return {
        ...output,
        fidelity_observations: output.fidelity_observations.map((observation) =>
          observation.support === "partial" && observation.reason_code === "joern_fidelity_unproven"
            ? { ...observation, support: "supported" as const, reason_code: null }
            : observation
        ),
      };
    },
  };
  // Offline observations must never mint a live runtime brand or formal qualification.
  return runtime;
}

function safePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.isAbsolute(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
async function regularFile(file: string, limit: number): Promise<Uint8Array> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > limit)
    throw new Error("p03_output_invalid");
  const bytes = await readFile(file, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
  if (bytes.byteLength !== stat.size) throw new Error("p03_output_changed");
  return bytes;
}
function isDockerVersion(value: unknown, client: string, server: string): boolean {
  const v = record(value);
  if (v === null) return false;
  const c = record(v.Client);
  const s = record(v.Server);
  return c?.Version === client && s?.Version === server;
}
function dockerImageId(value: unknown, ref: string): string | null {
  const image = record(value);
  return image !== null &&
    typeof image.Id === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(image.Id) &&
    Array.isArray(image.RepoDigests) &&
    image.RepoDigests.includes(ref)
    ? image.Id
    : null;
}
/** Docker inherits immutable image labels. Admit that exact measured set plus our two
 * overrides, not arbitrary extra labels or an ownership label supplied by the image. */
export function scaP03OwnedDockerLabelsMatchV1(
  containerLabels: unknown,
  imageLabels: unknown,
  seed: string,
  ordinal: number
): boolean {
  const labels = record(containerLabels);
  const inherited = imageLabels === undefined || imageLabels === null ? {} : record(imageLabels);
  if (
    labels === null ||
    inherited === null ||
    !DIGEST.test(seed) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    Object.values(labels).some((value) => typeof value !== "string") ||
    Object.values(inherited).some((value) => typeof value !== "string")
  )
    return false;
  return (
    canonicalJson(labels) ===
    canonicalJson({
      ...inherited,
      "penny.sca.p03.operation": seed,
      "penny.sca.p03.attempt": String(ordinal),
    })
  );
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
function isContainer(
  value: unknown,
  id: string,
  imageId: string,
  name: string,
  expected: {
    readonly config: Pick<ScaP03DockerRuntimeConfigV1, "pids" | "memory_bytes" | "cpus">;
    readonly uid: number;
    readonly gid: number;
    readonly source: string | null;
    readonly input: string | null;
    readonly scripts: string;
    readonly workspaceTmpfs: string;
    readonly tmpfs: string;
  }
): boolean {
  const v = record(value);
  if (v === null) return false;
  const host = record(v.HostConfig);
  const imageConfig = record(v.Config);
  if (host === null || imageConfig === null || !Array.isArray(v.Mounts)) return false;
  const mounts = v.Mounts.map(record);
  const expectedMounts = [
    { Source: expected.scripts, Destination: "/scripts", RW: false },
    ...(expected.source === null
      ? []
      : [{ Source: expected.source, Destination: "/source", RW: false }]),
    ...(expected.input === null
      ? []
      : [{ Source: expected.input, Destination: "/input", RW: false }]),
  ];
  if (
    mounts.length !== expectedMounts.length ||
    expectedMounts.some(
      (mount) =>
        !mounts.some(
          (m) =>
            m?.Type === "bind" &&
            m.Source === mount.Source &&
            m.Destination === mount.Destination &&
            m.RW === mount.RW
        )
    )
  )
    return false;
  const log = record(host.LogConfig);
  const tmpfs = record(host.Tmpfs);
  return (
    v.Id === id &&
    v.Image === imageId &&
    v.Name === `/${name}` &&
    host.NetworkMode === "none" &&
    host.PidMode !== "host" &&
    host.IpcMode !== "host" &&
    host.UTSMode !== "host" &&
    host.ReadonlyRootfs === true &&
    host.Init === true &&
    host.Privileged === false &&
    canonicalJson(host.CapDrop) === canonicalJson(["ALL"]) &&
    canonicalJson(host.SecurityOpt) === canonicalJson(["no-new-privileges"]) &&
    host.PidsLimit === expected.config.pids &&
    host.Memory === expected.config.memory_bytes &&
    host.MemorySwap === expected.config.memory_bytes &&
    host.NanoCpus === Math.round(expected.config.cpus * 1_000_000_000) &&
    log?.Type === "none" &&
    tmpfs?.["/tmp"] === expected.tmpfs.slice("/tmp:".length) &&
    tmpfs?.["/work"] === expected.workspaceTmpfs.slice("/work:".length) &&
    Object.keys(tmpfs).length === 2 &&
    imageConfig.User === `${String(expected.uid)}:${String(expected.gid)}` &&
    imageConfig.WorkingDir === "/tmp" &&
    Array.isArray(imageConfig.Env) &&
    imageConfig.Env.includes("HOME=/tmp") &&
    canonicalJson(imageConfig.Entrypoint) === canonicalJson(["sleep"]) &&
    canonicalJson(imageConfig.Cmd) === canonicalJson(["infinity"])
  );
}
/** Closed, content-free policy projection of the inspected running container. */
function confinementProjection(value: unknown): string {
  const v = record(value);
  const host = record(v?.HostConfig);
  const image = record(v?.Config);
  if (v === null || host === null || image === null || !Array.isArray(v.Mounts))
    throw new Error("p03_confinement_projection_invalid");
  const mounts = v.Mounts.map(record);
  if (mounts.some((m) => m === null || typeof m.Source !== "string"))
    throw new Error("p03_confinement_projection_invalid");
  return canonicalJson({
    image: v.Image,
    id: v.Id,
    name: v.Name,
    network: host.NetworkMode,
    pid_mode: host.PidMode,
    ipc_mode: host.IpcMode,
    uts_mode: host.UTSMode,
    readonly_root: host.ReadonlyRootfs,
    privileged: host.Privileged,
    init: host.Init,
    cap_drop: host.CapDrop,
    security_opt: host.SecurityOpt,
    pids: host.PidsLimit,
    memory: host.Memory,
    memory_swap: host.MemorySwap,
    nano_cpus: host.NanoCpus,
    log: record(host.LogConfig)?.Type,
    tmpfs: host.Tmpfs,
    user: image.User,
    workdir: image.WorkingDir,
    env: image.Env,
    entrypoint: image.Entrypoint,
    command: image.Cmd,
    mounts: mounts
      .map((m) => ({
        destination: m?.Destination,
        type: m?.Type,
        readonly: m?.RW === false,
        source_sha256: sha256(String(m?.Source)),
      }))
      .sort((a, b) => String(a.destination).localeCompare(String(b.destination))),
    running: isRunning(value),
  });
}
function isRunning(value: unknown): boolean {
  const v = record(value);
  if (v === null) return false;
  const state = record(v.State);
  return state?.Status === "running" && state.Running === true;
}
async function inspectGraph(
  work: string,
  output: string,
  source: string | null,
  container: (
    entrypoint: string,
    args: readonly string[],
    source: string | null,
    input: string | null,
    expectedOutput: "graph.cpg.bin" | "inventory.tsv" | null
  ) => Promise<string>
): Promise<Inventory> {
  const scripts = path.join(work, "scripts");
  await writeFile(path.join(scripts, "inventory.sc"), INVENTORY_SCRIPT, {
    flag: "wx",
    mode: 0o400,
  });
  await container(
    "joern",
    [
      "--script",
      "/scripts/inventory.sc",
      "--param",
      "cpgFile=/input/graph.cpg.bin",
      "--param",
      "outFile=/work/inventory.tsv",
    ],
    source,
    output,
    "inventory.tsv"
  );
  return inventory(await regularFile(path.join(output, "inventory.tsv"), MAX_INVENTORY_BYTES));
}

/** Pure native historical replay primitives; none construct a runtime or inspect the host. */
export {
  inventory as parseScaP03NativeInventoryV1,
  assertFrontend as assertScaP03NativeFrontendV1,
  queryCandidates as scaP03NativeQueryCandidatesV1,
  isDockerVersion as scaP03NativeDockerVersionMatchesV1,
  dockerImageId as scaP03NativeDockerImageIdV1,
  isContainer as scaP03NativeContainerMatchesV1,
  confinementProjection as scaP03NativeConfinementProjectionV1,
  isRunning as scaP03NativeContainerRunningV1,
};

/** The collector's exact ordered create vector, shared with historical verification. */
export function scaP03NativeCreateArgvV1(input: {
  readonly config: Pick<
    ScaP03DockerCandidateConfigV1,
    "pids" | "memory_bytes" | "cpus" | "image_ref"
  >;
  readonly seed: string | null;
  readonly attemptOrdinal: number;
  readonly currentName: string;
  readonly uid: number;
  readonly gid: number;
  readonly tmpfs: string;
  readonly workspaceTmpfs: string;
  readonly mounts: readonly string[];
  readonly jvmHeapBytes: number | null;
}): string[] {
  const {
    config,
    seed,
    attemptOrdinal,
    currentName,
    uid,
    gid,
    tmpfs,
    workspaceTmpfs,
    mounts,
    jvmHeapBytes,
  } = input;
  return [
    "container",
    "create",
    "--pull=never",
    ...(seed === null ? [] : ["--no-healthcheck"]),
    "--name",
    currentName,
    ...(seed === null
      ? []
      : [
          "--label",
          `penny.sca.p03.operation=${seed}`,
          "--label",
          `penny.sca.p03.attempt=${String(attemptOrdinal)}`,
        ]),
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(config.pids),
    "--memory",
    String(config.memory_bytes),
    "--memory-swap",
    String(config.memory_bytes),
    "--cpus",
    String(config.cpus),
    "--user",
    `${String(uid)}:${String(gid)}`,
    "--init",
    "--log-driver",
    "none",
    "--tmpfs",
    tmpfs,
    "--tmpfs",
    workspaceTmpfs,
    "--workdir",
    "/tmp",
    "--env",
    "HOME=/tmp",
    ...(seed === null ? [] : ["--env", `JAVA_TOOL_OPTIONS=-Xmx${String(jvmHeapBytes)}`]),
    ...mounts,
    "--entrypoint",
    "sleep",
    config.image_ref,
    "infinity",
  ];
}
