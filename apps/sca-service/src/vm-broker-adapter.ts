import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getuid } from "node:process";

import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import PHP from "tree-sitter-php";
import TypeScript from "tree-sitter-typescript";
import { Type, type Static, type TSchema } from "typebox";

import { PROJECT_ID_PATTERN } from "../../orchestration/dist/state/paths.js";
import { ArtifactStore, currentArtifactRef } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import {
  validateScaCampaignSourceSnapshotV2,
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  validateScaP01SourceMaterialV1,
  SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS,
} from "../../orchestration/dist/sca/p01-contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../../orchestration/dist/skill-contracts/common.js";
import type {
  ScaAdapterRegistry,
  ScaAdapterTerminalResult,
  ScaJobExecutionContext,
  ScaOperationAdapter,
} from "./adapters.js";
import {
  SCA_BROKER_CONTRACT_LIMITS_V1,
  SCA_TOOL_OPERATION_MAP,
  validateScaBrokerCapabilityRequestV1,
  validateScaBrokerExecuteRequestV1,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerOperationKind,
} from "./contracts.js";

const MAX_CONTROL = 1_048_576;
const MAX_SOURCE = 16 * 1_048_576;
const MAX_FILE = 2 * 1_048_576;
const MAX_RUNNER_OUTPUT = 65_536;
const MAX_TOOL = 256 * 1_048_576;
const MAX_TEMPLATE = 32 * 1_073_741_824;
const GUEST_PATH = /^[A-Za-z0-9._@+/-]+$/u;
const TestId = Type.Union([Type.Literal("php.syntax.v1"), Type.Literal("jssrc.parse.v1")]);
const Operation = Type.Union([
  Type.Literal("source_query"),
  Type.Literal("graph_query"),
  Type.Literal("application_test"),
]);
const SourcePath = Type.String({ minLength: 1, maxLength: 1024, pattern: "^[A-Za-z0-9._@+/-]+$" });

/** Only declarative policy is admitted; no command, argument, environment or program field. */
export const VmBrokerConfigSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-vm-broker-config.v1"),
    schema_version: Type.Literal(1),
    project_id: OpaqueIdSchema,
    enabled_operations: Type.Array(Operation, { minItems: 1, maxItems: 3 }),
    allowed_source_roots: Type.Array(SourcePath, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false }
);
export const VmBrokerPlanSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-vm-test-plan.v1"),
    schema_version: Type.Literal(1),
    snapshot_id: OpaqueIdSchema,
    test_id: TestId,
    source_paths: Type.Array(SourcePath, { minItems: 1, maxItems: 32 }),
  },
  { additionalProperties: false }
);
export const VmBrokerGraphBindingSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-vm-graph-binding.v1"),
    schema_version: Type.Literal(1),
    source_snapshot_artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
    source_snapshot_sha256: Sha256Schema,
    source_tree_sha256: Sha256Schema,
    graph_sha256: Sha256Schema,
    graph_byte_length: Type.Integer({ minimum: 1, maximum: 256 * 1_048_576 }),
    graph_build_job_sha256: Sha256Schema,
    graph_build_receipt_sha256: Sha256Schema,
    source_files: Type.Array(
      Type.Object(
        {
          path: SourcePath,
          byte_count: Type.Integer({ minimum: 0, maximum: MAX_FILE }),
          content_sha256: Sha256Schema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 100_000 }
    ),
  },
  { additionalProperties: false }
);
const VmGraphBuildJobSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-vm-job.v1"),
    schema_version: Type.Literal(1),
    operation: Type.Literal("graph_build"),
    limits: Type.Object(
      {
        max_output_bytes: Type.Integer({ minimum: 1, maximum: 256 * 1_048_576 }),
        max_result_items: Type.Integer({ minimum: 1, maximum: 10_000 }),
      },
      { additionalProperties: false }
    ),
    payload: Type.Object(
      {
        files: Type.Array(
          Type.Object(
            {
              path: SourcePath,
              asset_path: SourcePath,
              byte_length: Type.Integer({ minimum: 0, maximum: MAX_FILE }),
              content_sha256: Sha256Schema,
            },
            { additionalProperties: false }
          ),
          { minItems: 1, maxItems: 100_000 }
        ),
        language: Type.Union([Type.Literal("jssrc"), Type.Literal("php")]),
        max_num_def: Type.Integer({ minimum: 1, maximum: 100_000 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
const VmGraphBuildMetadataSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-graph-build-metadata.v1"),
    schema_version: Type.Literal(1),
    byte_length: Type.Integer({ minimum: 1, maximum: 256 * 1_048_576 }),
    content_sha256: Sha256Schema,
    file_count: Type.Integer({ minimum: 1, maximum: 100_000 }),
    language: Type.Union([Type.Literal("jssrc"), Type.Literal("php")]),
  },
  { additionalProperties: false }
);
const VmGraphBuildReceiptSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-vm-host-result.v1"),
    schema_version: Type.Literal(1),
    status: Type.Literal("succeeded"),
    error_code: Type.Null(),
    execution_duration_ms: Type.Integer({ minimum: 0, maximum: 1_260_000 }),
    job_sha256: Sha256Schema,
    run_directory: Type.String({ minLength: 1, maxLength: 4096 }),
    logical_result_items: Type.Literal(1),
    outputs: Type.Array(
      Type.Object(
        {
          name: Type.Union([Type.Literal("graph.cpg.bin"), Type.Literal("metadata.json")]),
          path: Type.String({ minLength: 1, maxLength: 4096 }),
          schema_id: Type.Union([
            Type.Literal("penny.sca-joern-cpg.v1"),
            Type.Literal("penny.sca-graph-build-metadata.v1"),
          ]),
          media_type: Type.Union([
            Type.Literal("application/vnd.penny.joern-cpg"),
            Type.Literal("application/json"),
          ]),
          byte_length: Type.Integer({ minimum: 1, maximum: 256 * 1_048_576 }),
          content_sha256: Sha256Schema,
        },
        { additionalProperties: false }
      ),
      { minItems: 2, maxItems: 2 }
    ),
  },
  { additionalProperties: false }
);

export const VmBrokerPolicySchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-vm-test-policy.v1"),
    schema_version: Type.Literal(1),
    project_id: OpaqueIdSchema,
    allowed_test_ids: Type.Array(TestId, { minItems: 1, maxItems: 2 }),
  },
  { additionalProperties: false }
);

const OutputSchema = Type.Object(
  {
    name: Type.Literal("result.json"),
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    schema_id: Type.Union([
      Type.Literal("penny.sca-source-query-result.v1"),
      Type.Literal("penny.sca-graph-query-result.v1"),
      Type.Literal("penny.sca-application-test-result.v1"),
    ]),
    media_type: Type.Literal("application/json"),
    byte_length: Type.Integer({
      minimum: 1,
      maximum: SCA_BROKER_CONTRACT_LIMITS_V1.max_output_bytes,
    }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
const CancellationResultSchema = Type.Object(
  {
    containment_proved: Type.Literal(true),
    job_sha256: Sha256Schema,
    run_media_removed: Type.Literal(true),
    schema_id: Type.Literal("penny.sca-vm-cancellation.v1"),
    schema_version: Type.Literal(1),
    status: Type.Literal("cancelled"),
    unit: Type.String({
      pattern: "^penny-guest-[a-f0-9]{32}\\.service$",
      minLength: 52,
      maxLength: 52,
    }),
    unit_observed: Type.Literal(true),
  },
  { additionalProperties: false }
);
const HostResultSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-vm-host-result.v1"),
    schema_version: Type.Literal(1),
    status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
    error_code: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    execution_duration_ms: Type.Integer({ minimum: 0, maximum: 1_260_000 }),
    job_sha256: Sha256Schema,
    run_directory: Type.String({ minLength: 1, maxLength: 4096 }),
    logical_result_items: Type.Integer({ minimum: 0, maximum: 10_000 }),
    outputs: Type.Array(OutputSchema, { maxItems: 1 }),
  },
  { additionalProperties: false }
);

export interface PinnedVmFile {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}
export interface VmBrokerAdapterOptions {
  readonly artifactStore: ArtifactStore;
  readonly projectId: string;
  readonly workspaceParent: string;
  /** One deployment-wide lock shared by every workspace and producer. */
  readonly globalLock: string;
  readonly authorization: Readonly<{
    configProducers: readonly string[];
    configDigests: readonly string[];
    executionPlanProducers: readonly string[];
    graphBindingProducers: readonly string[];
    graphProducers: readonly string[];
    policyProducers: readonly string[];
    policyDigests: readonly string[];
  }>;
  readonly runJob: PinnedVmFile;
  readonly runGuest: PinnedVmFile;
  readonly outputProtocol: PinnedVmFile;
  readonly python: PinnedVmFile;
  readonly genisoimage: PinnedVmFile;
  readonly cp: PinnedVmFile;
  readonly qemu: PinnedVmFile;
  readonly bwrap: PinnedVmFile;
  readonly systemctl: PinnedVmFile;
  readonly template: PinnedVmFile;
  /** A runner seam must prove child termination; test doubles never launch a VM. */
  readonly runner?: VmBrokerRunner;
}
export interface VmBrokerRunner {
  run(
    executable: string,
    args: readonly string[],
    signal: AbortSignal,
    observedAlive: () => void
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly terminated: boolean }>;
}
export interface VmGraphBuildRequest {
  readonly options: VmBrokerAdapterOptions;
  readonly sourceSnapshotRef: ScaBrokerExecuteRequestV1["source_snapshot_ref"];
  readonly runId: string;
  readonly operationId: string;
  readonly language: "jssrc" | "php";
  readonly maxNumDef: number;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
  readonly reportWorkMilestone?: () => void;
}

function safePath(value: string): boolean {
  return (
    GUEST_PATH.test(value) &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    Buffer.byteLength(value) <= 1024
  );
}
function sourceAuthorized(value: string, roots: readonly string[]): boolean {
  return roots.some((root) => value === root || value.startsWith(`${root}/`));
}
function syntaxGrammar(testId: Static<typeof TestId>, file: string): unknown {
  if (testId === "php.syntax.v1") return file.endsWith(".php") ? PHP.php : null;
  if (/\.(?:js|mjs|cjs)$/u.test(file)) return JavaScript;
  if (file.endsWith(".jsx")) return JavaScript;
  if (file.endsWith(".ts")) return TypeScript.typescript;
  if (file.endsWith(".tsx")) return TypeScript.tsx;
  return null;
}
function hostSyntaxPass(testId: Static<typeof TestId>, file: string, bytes: Buffer): boolean {
  const grammar = syntaxGrammar(testId, file);
  if (grammar === null) return false;
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return false;
  }
  try {
    const parser = new Parser();
    parser.setLanguage(grammar);
    parser.setTimeoutMicros(5_000_000);
    const tree = parser.parse(source);
    const stack: Array<{ readonly node: Parser.SyntaxNode; readonly depth: number }> = [
      { node: tree.rootNode, depth: 0 },
    ];
    let visited = 0;
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || ++visited > 2_000_000 || current.depth > 100_000) return false;
      if (current.node.isError || current.node.isMissing) return false;
      for (let index = current.node.childCount - 1; index >= 0; index -= 1) {
        const child = current.node.child(index);
        if (child !== null) stack.push({ node: child, depth: current.depth + 1 });
      }
    }
    return true;
  } catch {
    return false;
  }
}
function canonicalAbsolute(value: string): boolean {
  return (
    isAbsolute(value) && resolve(value) === value && !value.includes("\0") && !value.includes("$")
  );
}
function pinned(file: PinnedVmFile, maximum: number, mode?: number): void {
  if (
    !canonicalAbsolute(file.path) ||
    !/^[a-f0-9]{64}$/u.test(file.sha256) ||
    !Number.isSafeInteger(file.size_bytes) ||
    file.size_bytes < (mode === undefined ? 1 : 65_536) ||
    file.size_bytes > maximum ||
    realpathSync(file.path) !== file.path
  )
    throw new Error("invalid VM file configuration");
  const details = lstatSync(file.path);
  if (
    !details.isFile() ||
    details.nlink !== 1 ||
    details.size !== file.size_bytes ||
    (details.mode & 0o022) !== 0 ||
    (mode !== undefined && (details.mode & 0o777) !== mode)
  )
    throw new Error("VM file identity mismatch");
  const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (before.ino !== details.ino || before.dev !== details.dev || before.size !== details.size)
      throw new Error("VM file replaced before pinning");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1_048_576);
    let count = 0;
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (size === 0) break;
      count += size;
      if (count > maximum) throw new Error("VM file grew while pinning");
      hash.update(buffer.subarray(0, size));
    }
    const after = fstatSync(fd);
    if (
      count !== file.size_bytes ||
      after.size !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      hash.digest("hex") !== file.sha256
    )
      throw new Error("VM file digest mismatch");
  } finally {
    closeSync(fd);
  }
}
function assertWorkspace(parent: string): void {
  if (!canonicalAbsolute(parent) || realpathSync(parent) !== parent || getuid === undefined)
    throw new Error("invalid private workspace");
  const details = lstatSync(parent);
  if (!details.isDirectory() || details.uid !== getuid() || (details.mode & 0o777) !== 0o700)
    throw new Error("workspace is not private");
}
function validatedGlobalLock(lock: string): string {
  if (!canonicalAbsolute(lock) || realpathSync(lock) !== lock)
    throw new Error("VM global lock is not canonical");
  const details = lstatSync(lock);
  if (
    !details.isFile() ||
    details.uid !== getuid?.() ||
    details.nlink !== 1 ||
    details.size !== 0 ||
    (details.mode & 0o777) !== 0o600
  )
    throw new Error("VM global lock is unsafe");
  return lock;
}
function exactArtifact(
  store: ArtifactStore,
  ref: ScaBrokerExecuteRequestV1["config_ref"],
  max: number
): Buffer {
  const canonical = currentArtifactRef(ref);
  if (
    canonical.byte_length > max ||
    canonical.run_id !== ref.run_id ||
    canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(canonical)
  )
    throw new Error("artifact ref mismatch");
  const bytes = store.readById(ref.artifact_id);
  if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
    throw new Error("artifact bytes mismatch");
  return bytes;
}
function jsonBytes<S extends TSchema>(
  bytes: Buffer,
  schema: S,
  label: string,
  maximum = MAX_CONTROL
): Static<S> {
  if (bytes.length > maximum) throw new Error(`${label} exceeds control limit`);
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (Buffer.from(canonicalJson(parsed)).equals(bytes) === false)
    throw new Error(`${label} is not canonical JSON`);
  return validateContract(schema, parsed, label);
}
function canonicalDocument<T>(
  bytes: Buffer,
  validate: (value: unknown) => T,
  maximum = MAX_CONTROL
): T {
  if (bytes.length > maximum) throw new Error("source document exceeds its byte limit");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Buffer.from(canonicalJson(value)).equals(bytes))
    throw new Error("source document is not canonical JSON");
  return validate(value);
}
interface VmGraphBuildAdmission {
  readonly artifactStore: ArtifactStore;
  readonly sourceSnapshotRef: ScaBrokerExecuteRequestV1["source_snapshot_ref"];
  readonly graphBuildJob: Buffer;
  readonly graphBuildReceipt: Buffer;
  readonly graphBytes: Buffer;
  readonly runId: string;
  readonly operationId: string;
}

/** Admit a CPG only through a host-verified build job/receipt bound to the full P01 manifest. */
function persistVerifiedVmGraph(input: VmGraphBuildAdmission) {
  const store = input.artifactStore;
  assertP01Ref(
    input.sourceSnapshotRef,
    "source-snapshot",
    "penny.sca-campaign-source-snapshot.v2",
    2
  );
  const snapshot = canonicalDocument(
    exactArtifact(store, input.sourceSnapshotRef, MAX_CONTROL),
    validateScaCampaignSourceSnapshotV2
  );
  assertP01Ref(
    snapshot.file_manifest_ref,
    "sca-p01-source-file-manifest",
    "penny.sca-p01-source-file-manifest.v1",
    1
  );
  const manifest = canonicalDocument(
    exactArtifact(store, snapshot.file_manifest_ref, 8 * MAX_CONTROL),
    validateScaP01SourceFileManifestV1,
    8 * MAX_CONTROL
  );
  const job = jsonBytes(input.graphBuildJob, VmGraphBuildJobSchema, "VM graph build job");
  const receipt = jsonBytes(
    input.graphBuildReceipt,
    VmGraphBuildReceiptSchema,
    "VM graph build receipt"
  );
  const expectedFiles = manifest.files.map((file) => ({
    path: file.path,
    asset_path: `source/${file.path}`,
    byte_length: file.byte_count,
    content_sha256: file.content_sha256,
  }));
  const graphOutput = receipt.outputs.find((output) => output.name === "graph.cpg.bin");
  const metadataOutput = receipt.outputs.find((output) => output.name === "metadata.json");
  if (
    canonicalJson(job.payload.files) !== canonicalJson(expectedFiles) ||
    receipt.job_sha256 !== sha256(input.graphBuildJob) ||
    graphOutput === undefined ||
    graphOutput.schema_id !== "penny.sca-joern-cpg.v1" ||
    graphOutput.media_type !== "application/vnd.penny.joern-cpg" ||
    graphOutput.byte_length !== input.graphBytes.length ||
    graphOutput.content_sha256 !== sha256(input.graphBytes) ||
    metadataOutput === undefined ||
    metadataOutput.schema_id !== "penny.sca-graph-build-metadata.v1" ||
    metadataOutput.media_type !== "application/json"
  )
    throw new Error("graph build evidence mismatch");
  const bindingContent = {
    schema_id: "penny.sca-vm-graph-binding.v1" as const,
    schema_version: 1 as const,
    source_snapshot_artifact_id: input.sourceSnapshotRef.artifact_id,
    source_snapshot_sha256: input.sourceSnapshotRef.content_digest,
    source_tree_sha256: snapshot.tree_sha256,
    graph_sha256: graphOutput.content_sha256,
    graph_byte_length: graphOutput.byte_length,
    graph_build_job_sha256: receipt.job_sha256,
    graph_build_receipt_sha256: sha256(input.graphBuildReceipt),
    source_files: manifest.files,
  };
  const bindingOperation = `${input.operationId}-binding`;
  const bindingVersion =
    store.lastVersion(
      input.runId,
      "SCA-VM-graph-binding",
      null,
      "sca-vm-graph-binding",
      bindingOperation
    ) + 1;
  const binding = store.persist({
    metadata: {
      schema_version: 2,
      run_id: input.runId,
      phase: "SCA-VM-graph-binding",
      branch_id: null,
      kind: "sca-vm-graph-binding",
      operation_id: bindingOperation,
      version: bindingVersion,
      producer: "host:sca-vm-graph-builder",
      media_type: "application/json",
      content_schema: { schema_id: bindingContent.schema_id, schema_version: 1 },
      parent_ref:
        bindingVersion === 1
          ? null
          : store.refFor(
              input.runId,
              "SCA-VM-graph-binding",
              null,
              "sca-vm-graph-binding",
              bindingOperation,
              bindingVersion - 1
            ),
      upstream_refs: [input.sourceSnapshotRef],
    },
    content: canonicalJson(bindingContent),
  });
  const graphVersion =
    store.lastVersion(input.runId, "SCA-VM-input", null, "sca-graph", input.operationId) + 1;
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: input.runId,
      phase: "SCA-VM-input",
      branch_id: null,
      kind: "sca-graph",
      operation_id: input.operationId,
      version: graphVersion,
      producer: "host:sca-vm-graph-builder",
      media_type: "application/vnd.penny.joern-cpg",
      parent_ref:
        graphVersion === 1
          ? null
          : store.refFor(
              input.runId,
              "SCA-VM-input",
              null,
              "sca-graph",
              input.operationId,
              graphVersion - 1
            ),
      upstream_refs: [input.sourceSnapshotRef, binding].sort((a, b) =>
        a.artifact_id.localeCompare(b.artifact_id)
      ),
    },
    content: input.graphBytes,
  });
}

async function exclusiveFile(path: string, bytes: Buffer): Promise<void> {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}
async function exactOutput(path: string, expectedSize: number, digest: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== expectedSize ||
      (before.mode & 0o077) !== 0 ||
      before.uid !== getuid?.()
    )
      throw new Error("output identity mismatch");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      bytes.length !== expectedSize ||
      sha256(bytes) !== digest
    )
      throw new Error("output changed");
    return bytes;
  } finally {
    await handle.close();
  }
}
function failure(
  code: "failed" | "cancelled",
  message = "SCA VM job did not complete"
): ScaAdapterTerminalResult {
  return {
    terminal_status: code === "cancelled" ? "cancelled" : "failed",
    failure: { code, message },
    output_refs: [],
    result_item_count: 0,
    partial: false,
    truncated: false,
  };
}

/** The real runner has no shell, no inherited environment, bounded pipes and a verified process group exit. */
const vmBrokerRunnerWithGrace = (grace: number): VmBrokerRunner => ({
  run(executable, args, signal, observedProgress) {
    return new Promise((resolveRun, reject) => {
      if (signal.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      const child = spawn(executable, [...args], {
        shell: false,
        detached: true,
        env: { HOME: "/var/tmp", LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const phases = [
        "validated",
        "media_ready",
        "disk_ready",
        "guest_started",
        "guest_finished",
        "output_verified",
      ];
      let phaseIndex = 0;
      let activeSequence = 0;
      let stderr = "";
      let stdout = "";
      let size = 0;
      let overflow = false;
      let childError: Error | null = null;
      let escalation: NodeJS.Timeout | undefined;
      const groupAlive = (): boolean => {
        if (child.pid === undefined) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          return !(error instanceof Error && "code" in error && error.code === "ESRCH");
        }
      };
      const signalGroup = (name: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, name);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            childError ??=
              error instanceof Error ? error : new Error("process group signal failed");
          }
        }
      };
      const stop = (): void => {
        signalGroup("SIGTERM");
        escalation ??= setTimeout(() => signalGroup("SIGKILL"), grace);
      };
      const consumeProgress = (): void => {
        for (;;) {
          const end = stderr.indexOf("\n");
          if (end < 0) return;
          const line = stderr.slice(0, end);
          stderr = stderr.slice(end + 1);
          const expected = phases[phaseIndex];
          const active = /^PENNY_SCA_VM_PROGRESS:guest_active:([1-9][0-9]*)$/u.exec(line);
          const authenticatedActive =
            phaseIndex === 4 && active !== null && Number(active[1]) === activeSequence + 1;
          if (
            authenticatedActive ||
            (expected !== undefined && line === `PENNY_SCA_VM_PROGRESS:${expected}`)
          ) {
            if (authenticatedActive) activeSequence += 1;
            else phaseIndex += 1;
            try {
              observedProgress();
            } catch {
              stop();
            }
          }
        }
      };
      const absorb = (chunk: Buffer, stream: "stdout" | "stderr") => {
        if (overflow) return;
        size += chunk.length;
        if (size > MAX_RUNNER_OUTPUT) {
          overflow = true;
          stop();
          return;
        }
        if (stream === "stdout") stdout += chunk.toString("utf8");
        else {
          stderr += chunk.toString("utf8");
          consumeProgress();
        }
      };
      child.stdout.on("data", (chunk: Buffer) => absorb(chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => absorb(chunk, "stderr"));
      const cancel = () => {
        stop();
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) stop();
      child.on("error", (error) => {
        childError ??= error;
        stop();
      });
      child.on("close", (code) => {
        if (escalation !== undefined) clearTimeout(escalation);
        signal.removeEventListener("abort", cancel);
        const finish = (attempt: number): void => {
          if (groupAlive() && attempt < 50) {
            signalGroup("SIGKILL");
            setTimeout(() => finish(attempt + 1), 100);
            return;
          }
          if (childError !== null && child.pid === undefined) {
            reject(childError);
            return;
          }
          resolveRun({
            exitCode: overflow || childError !== null ? 1 : (code ?? 1),
            stdout,
            terminated: !groupAlive(),
          });
        };
        finish(0);
      });
    });
  },
});

/** Host-only cancellation grace lets a bridge finish its bounded VM-stop/cleanup proof. */
export function createVmBrokerProcessRunner(terminationGraceMs: number): VmBrokerRunner {
  const grace = validateContract(
    Type.Integer({ minimum: 100, maximum: 60_000 }),
    terminationGraceMs,
    "VM bridge termination grace"
  );
  return vmBrokerRunnerWithGrace(grace);
}

/** The default broker runner retains its existing five-second escalation policy. */
export const vmBrokerProcessRunner = createVmBrokerProcessRunner(5000);

/** Explicit opt-in factory. Does not mutate SCA_ADAPTER_REGISTRY or startup. */
export function createVmBrokerAdapterRegistry(input: VmBrokerAdapterOptions): ScaAdapterRegistry {
  // Copy pins: caller mutation after construction cannot change the eventual argv.
  const options = Object.freeze({
    ...input,
    runJob: Object.freeze({ ...input.runJob }),
    runGuest: Object.freeze({ ...input.runGuest }),
    outputProtocol: Object.freeze({ ...input.outputProtocol }),
    python: Object.freeze({ ...input.python }),
    genisoimage: Object.freeze({ ...input.genisoimage }),
    cp: Object.freeze({ ...input.cp }),
    qemu: Object.freeze({ ...input.qemu }),
    bwrap: Object.freeze({ ...input.bwrap }),
    systemctl: Object.freeze({ ...input.systemctl }),
    template: Object.freeze({ ...input.template }),
    authorization: Object.freeze({
      configProducers: Object.freeze([...input.authorization.configProducers]),
      configDigests: Object.freeze([...input.authorization.configDigests]),
      executionPlanProducers: Object.freeze([...input.authorization.executionPlanProducers]),
      graphBindingProducers: Object.freeze([...input.authorization.graphBindingProducers]),
      graphProducers: Object.freeze([...input.authorization.graphProducers]),
      policyProducers: Object.freeze([...input.authorization.policyProducers]),
      policyDigests: Object.freeze([...input.authorization.policyDigests]),
    }),
  });
  if (
    !PROJECT_ID_PATTERN.test(options.projectId) ||
    !(options.artifactStore instanceof ArtifactStore)
  )
    throw new Error("invalid VM adapter authority");
  const authorities = [
    options.authorization.configProducers,
    options.authorization.configDigests,
    options.authorization.executionPlanProducers,
    options.authorization.graphBindingProducers,
    options.authorization.graphProducers,
    options.authorization.policyProducers,
    options.authorization.policyDigests,
  ];
  if (
    authorities.some((values) => values.length === 0 || new Set(values).size !== values.length) ||
    [...options.authorization.configDigests, ...options.authorization.policyDigests].some(
      (value) => !/^[a-f0-9]{64}$/u.test(value)
    ) ||
    [
      ...options.authorization.configProducers,
      ...options.authorization.executionPlanProducers,
      ...options.authorization.graphBindingProducers,
      ...options.authorization.graphProducers,
      ...options.authorization.policyProducers,
    ].some((value) => value.length === 0 || value.length > 256 || /[\0\r\n]/u.test(value))
  )
    throw new Error("invalid VM policy authority");
  assertWorkspace(options.workspaceParent);
  const globalLock = validatedGlobalLock(options.globalLock);
  ArtifactStore.verifyExisting(options.artifactStore.root, { projectId: options.projectId });
  const tools = [
    options.runJob,
    options.runGuest,
    options.outputProtocol,
    options.python,
    options.genisoimage,
    options.cp,
    options.qemu,
    options.bwrap,
    options.systemctl,
  ];
  for (const file of tools) pinned(file, MAX_TOOL);
  pinned(options.template, MAX_TEMPLATE, 0o400);
  // The Python import is part of the bridge TCB and must carry its reviewed static pin.
  const protocolPath = join(dirname(options.runJob.path), "output_protocol.py");
  if (options.outputProtocol.path !== protocolPath)
    throw new Error("bridge import is not canonical");
  const protocolPin = options.outputProtocol;
  const runner = options.runner ?? vmBrokerProcessRunner;
  const adapter = (operation: ScaBrokerOperationKind) => ({
    capability: async (request: Parameters<ScaOperationAdapter["capability"]>[0]) => {
      validateScaBrokerCapabilityRequestV1(request);
      const allowed =
        request.project_id === options.projectId &&
        request.operation === operation &&
        SCA_TOOL_OPERATION_MAP[request.tool_name] === operation &&
        request.timeout_ms <= SCA_BROKER_CONTRACT_LIMITS_V1.max_timeout_ms;
      return {
        schema_id: "penny.sca-broker-capability-result.v1" as const,
        schema_version: 1 as const,
        tenant_id: request.tenant_id,
        project_id: request.project_id,
        run_id: request.run_id,
        request_id: request.request_id,
        tool_name: request.tool_name,
        operation: request.operation,
        status: allowed ? ("available" as const) : ("unavailable" as const),
        limits: allowed
          ? {
              max_request_bytes: SCA_BROKER_CONTRACT_LIMITS_V1.max_request_bytes,
              max_input_refs: SCA_BROKER_CONTRACT_LIMITS_V1.max_input_refs,
              max_output_refs: 1,
              max_selectors: SCA_BROKER_CONTRACT_LIMITS_V1.max_selectors,
              max_parameters: 1,
              max_timeout_ms: SCA_BROKER_CONTRACT_LIMITS_V1.max_timeout_ms,
              max_output_bytes: SCA_BROKER_CONTRACT_LIMITS_V1.max_output_bytes,
              max_result_items: SCA_BROKER_CONTRACT_LIMITS_V1.max_result_items,
            }
          : null,
        error: allowed
          ? null
          : {
              code:
                request.project_id !== options.projectId
                  ? ("unauthorized" as const)
                  : ("unsupported_operation" as const),
              message: "VM operation unavailable",
            },
        observed_at: new Date(
          Math.max(
            Date.parse(request.requested_at),
            Math.min(Date.now(), Date.parse(request.deadline_at))
          )
        ).toISOString(),
      };
    },
    run: async (
      request: ScaBrokerExecuteRequestV1,
      context: ScaJobExecutionContext
    ): Promise<ScaAdapterTerminalResult> => {
      let work: string | undefined;
      let cleanupApproved = true;
      let terminationProved = true;
      let outcome: ScaAdapterTerminalResult = failure("failed");
      try {
        validateScaBrokerExecuteRequestV1(request);
        if (
          request.project_id !== options.projectId ||
          request.operation !== operation ||
          SCA_TOOL_OPERATION_MAP[request.tool_name] !== operation
        )
          throw new Error("VM authority mismatch");
        if (context.signal.aborted) return failure("cancelled");
        assertWorkspace(options.workspaceParent);
        pinned(options.runJob, MAX_TOOL);
        pinned(protocolPin, MAX_TOOL);
        const store = options.artifactStore;
        assertP01Ref(
          request.source_snapshot_ref,
          "source-snapshot",
          "penny.sca-campaign-source-snapshot.v2",
          2
        );
        const snapshot = canonicalDocument(
          exactArtifact(store, request.source_snapshot_ref, MAX_CONTROL),
          validateScaCampaignSourceSnapshotV2
        );
        assertP01Ref(
          snapshot.file_manifest_ref,
          "sca-p01-source-file-manifest",
          "penny.sca-p01-source-file-manifest.v1",
          1
        );
        assertP01Ref(
          snapshot.custody_ref,
          "sca-p01-source-custody-corpus",
          "penny.sca-p01-source-custody-corpus.v1",
          1
        );
        const manifest = canonicalDocument(
          exactArtifact(store, snapshot.file_manifest_ref, 8 * MAX_CONTROL),
          validateScaP01SourceFileManifestV1,
          8 * MAX_CONTROL
        );
        const custody = canonicalDocument(
          exactArtifact(store, snapshot.custody_ref, 64 * 1_048_576),
          validateScaP01SourceCustodyCorpusV1,
          64 * 1_048_576
        );
        validateScaP01SourceMaterialV1({
          snapshot,
          file_manifest_ref: snapshot.file_manifest_ref,
          file_manifest: manifest,
          custody_ref: snapshot.custody_ref,
          custody,
        });
        if (
          canonicalJson(store.metadata(snapshot.file_manifest_ref).upstream_refs) !== "[]" ||
          canonicalJson(store.metadata(snapshot.custody_ref).upstream_refs) !==
            canonicalJson([snapshot.file_manifest_ref]) ||
          canonicalJson(store.metadata(request.source_snapshot_ref).upstream_refs) !==
            canonicalJson(
              [snapshot.file_manifest_ref, snapshot.custody_ref].sort((a, b) =>
                a.artifact_id.localeCompare(b.artifact_id)
              )
            )
        )
          throw new Error("source lineage mismatch");
        assertAuthorizedRef(request.config_ref, {
          kind: "sca-vm-broker-config",
          schemaId: "penny.sca-vm-broker-config.v1",
          producers: options.authorization.configProducers,
          digests: options.authorization.configDigests,
        });
        const config = jsonBytes(
          exactArtifact(store, request.config_ref, MAX_CONTROL),
          VmBrokerConfigSchema,
          "VM config"
        );
        if (
          config.project_id !== options.projectId ||
          new Set(config.enabled_operations).size !== config.enabled_operations.length ||
          !config.enabled_operations.includes(operation) ||
          new Set(config.allowed_source_roots).size !== config.allowed_source_roots.length ||
          config.allowed_source_roots.some((root) => !safePath(root))
        )
          throw new Error("VM config denies operation");
        const input = request.operation_input;
        let selected: readonly string[] = [];
        let payload: object;
        let testId: Static<typeof TestId> | null = null;
        if (input.kind === "source_query") {
          if (request.input_refs.length !== 0) throw new Error("unexpected source inputs");
          assertSupportedParameters(input.parameters);
          selected = [...new Set(input.selectors.map((s) => s.path))];
          payload = { query: queryPayload(input), files: [] };
        } else if (input.kind === "graph_query") {
          assertSupportedParameters(input.parameters);
          if (
            request.input_refs.length !== 1 ||
            input.graph_ref.artifact_id !== request.input_refs[0]?.artifact_id
          )
            throw new Error("unexpected graph inputs");
          if (!options.authorization.graphProducers.includes(input.graph_ref.producer))
            throw new Error("graph producer is not authorized");
          const graphMetadata = store.metadata(input.graph_ref);
          const bindingRef = graphMetadata.upstream_refs.find(
            (ref) => ref.kind === "sca-vm-graph-binding"
          );
          if (bindingRef === undefined) throw new Error("graph binding is absent");
          assertAuthorizedRef(bindingRef, {
            kind: "sca-vm-graph-binding",
            schemaId: "penny.sca-vm-graph-binding.v1",
            producers: options.authorization.graphBindingProducers,
          });
          const binding = jsonBytes(
            exactArtifact(store, bindingRef, 8 * MAX_CONTROL),
            VmBrokerGraphBindingSchema,
            "VM graph binding",
            8 * MAX_CONTROL
          );
          const expectedGraphUpstreams = [request.source_snapshot_ref, bindingRef].sort((a, b) =>
            a.artifact_id.localeCompare(b.artifact_id)
          );
          if (
            binding.source_snapshot_artifact_id !== request.source_snapshot_ref.artifact_id ||
            binding.source_snapshot_sha256 !== request.source_snapshot_ref.content_digest ||
            binding.source_tree_sha256 !== snapshot.tree_sha256 ||
            binding.graph_sha256 !== input.graph_ref.content_digest ||
            binding.graph_byte_length !== input.graph_ref.byte_length ||
            canonicalJson(binding.source_files) !== canonicalJson(manifest.files) ||
            canonicalJson(store.metadata(bindingRef).upstream_refs) !==
              canonicalJson([request.source_snapshot_ref]) ||
            canonicalJson(graphMetadata.upstream_refs) !== canonicalJson(expectedGraphUpstreams)
          )
            throw new Error("graph source lineage mismatch");
          selected = [...new Set(input.selectors.map((selector) => selector.path))];
          payload = {
            query: queryPayload(input),
            graph: {
              path: "graph.cpg.bin",
              asset_path: "assets/graph.cpg.bin",
              byte_length: input.graph_ref.byte_length,
              content_sha256: input.graph_ref.content_digest,
            },
          };
        } else {
          assertAuthorizedRef(input.execution_plan_ref, {
            kind: "sca-execution-plan",
            schemaId: "penny.sca-vm-test-plan.v1",
            producers: options.authorization.executionPlanProducers,
          });
          assertAuthorizedRef(input.policy_ref, {
            kind: "sca-execution-policy",
            schemaId: "penny.sca-vm-test-policy.v1",
            producers: options.authorization.policyProducers,
            digests: options.authorization.policyDigests,
          });
          const plan = jsonBytes(
            exactArtifact(store, input.execution_plan_ref, MAX_CONTROL),
            VmBrokerPlanSchema,
            "VM plan"
          );
          const policy = jsonBytes(
            exactArtifact(store, input.policy_ref, MAX_CONTROL),
            VmBrokerPolicySchema,
            "VM policy"
          );
          if (
            plan.snapshot_id !== snapshot.snapshot_id ||
            policy.project_id !== options.projectId ||
            new Set(policy.allowed_test_ids).size !== policy.allowed_test_ids.length ||
            !policy.allowed_test_ids.includes(plan.test_id) ||
            new Set(plan.source_paths).size !== plan.source_paths.length ||
            plan.source_paths.some((p) => !safePath(p) || !matchesTest(p, plan.test_id))
          )
            throw new Error("test plan or policy denied");
          testId = plan.test_id;
          selected = plan.source_paths;
          payload = { test: { test_id: plan.test_id }, files: [] };
        }
        if (
          selected.length === 0 ||
          selected.length > 32 ||
          selected.some((path) => !sourceAuthorized(path, config.allowed_source_roots))
        )
          throw new Error("invalid source selection");
        const byPath = new Map(custody.files.map((f) => [f.path, f]));
        const stagedSources = new Map<string, Buffer>();
        let sourceBytes = 0;
        const declarations: Array<{
          path: string;
          asset_path: string;
          byte_length: number;
          content_sha256: string;
        }> = [];
        for (const path of selected) {
          if (!safePath(path)) throw new Error("source path cannot be staged");
          const file = byPath.get(path);
          if (
            file === undefined ||
            file.byte_count > MAX_FILE ||
            (sourceBytes += file.byte_count) > MAX_SOURCE
          )
            throw new Error("source selection exceeds guest contract");
          declarations.push({
            path,
            asset_path: `assets/source/${path}`,
            byte_length: file.byte_count,
            content_sha256: file.content_sha256,
          });
        }
        work = await mkdtemp(join(options.workspaceParent, "sca-broker-"));
        const jobDir = join(work, "job");
        const runParent = join(work, "runs");
        await mkdir(jobDir, { mode: 0o700 });
        await mkdir(runParent, { mode: 0o700 });
        await mkdir(join(jobDir, "assets"), { mode: 0o700 });
        if (input.kind === "graph_query") {
          const bytes = exactArtifact(store, input.graph_ref, 256 * 1_048_576);
          await exclusiveFile(join(jobDir, "assets/graph.cpg.bin"), bytes);
        } else {
          for (const declaration of declarations) {
            const file = byPath.get(declaration.path);
            if (file === undefined) throw new Error("source vanished");
            const target = join(jobDir, declaration.asset_path);
            const bytes = Buffer.from(file.content_base64, "base64");
            if (bytes.length !== file.byte_count || sha256(bytes) !== file.content_sha256)
              throw new Error("source custody mismatch");
            stagedSources.set(declaration.path, bytes);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await exclusiveFile(target, bytes);
          }
          payload = { ...payload, files: declarations };
        }
        const job = {
          schema_id: "penny.sca-vm-job.v1",
          schema_version: 1,
          operation,
          limits: {
            max_output_bytes: request.limits.max_output_bytes,
            max_result_items: request.limits.max_result_items,
          },
          payload,
        };
        const jobBytes = Buffer.from(canonicalJson(job));
        if (jobBytes.length > MAX_CONTROL) throw new Error("job control too large");
        await exclusiveFile(join(jobDir, "job.json"), jobBytes);
        if (context.signal.aborted) throw new Error("cancelled");
        const args = [
          options.runJob.path,
          "--job-dir",
          jobDir,
          "--output-parent",
          runParent,
          ...toolArgs("template", options.template, true),
          ...toolArgs("launcher", options.runGuest),
          ...toolArgs("python", options.python),
          ...toolArgs("genisoimage", options.genisoimage),
          ...toolArgs("copy", options.cp),
          ...toolArgs("qemu", options.qemu),
          ...toolArgs("bwrap", options.bwrap),
          ...toolArgs("systemctl", options.systemctl),
          "--lock-file",
          globalLock,
          "--max-output-bytes",
          String(request.limits.max_output_bytes),
          // Broker timeout is renewable inactivity, not the guest's fixed VM runtime cap.
          "--timeout",
          "1200",
        ];
        terminationProved = false;
        cleanupApproved = false;
        const result = await runner.run(options.python.path, args, context.signal, () =>
          context.reportWorkMilestone()
        );
        terminationProved = result.terminated;
        if (!terminationProved) throw new Error("child termination uncertain");
        if (Buffer.byteLength(result.stdout) > MAX_RUNNER_OUTPUT)
          throw new Error("bridge output overflow");
        if (!result.stdout.endsWith("\n") || result.stdout.endsWith("\n\n"))
          throw new Error("bridge must emit one JSON line");
        if (result.exitCode === 130) {
          const cancellation = jsonBytes(
            Buffer.from(result.stdout.slice(0, -1)),
            CancellationResultSchema,
            "VM cancellation result"
          );
          if (cancellation.job_sha256 !== sha256(jobBytes))
            throw new Error("cancellation identity mismatch");
          cleanupApproved = true;
          throw new Error("cancelled");
        }
        const receipt = jsonBytes(
          Buffer.from(result.stdout.slice(0, -1)),
          HostResultSchema,
          "VM host result"
        );
        const runDirectory = receipt.run_directory;
        if (
          dirname(runDirectory) !== runParent ||
          !/^sca-vm-job-[A-Za-z0-9_]+$/u.test(runDirectory.slice(runParent.length + 1)) ||
          receipt.job_sha256 !== sha256(jobBytes)
        )
          throw new Error("bridge identity mismatch");
        for (const directory of [runDirectory, join(runDirectory, "results")]) {
          const details = lstatSync(directory);
          if (
            realpathSync(directory) !== directory ||
            !details.isDirectory() ||
            details.uid !== getuid?.() ||
            (details.mode & 0o777) !== 0o700
          )
            throw new Error("bridge directory changed");
        }
        cleanupApproved = true;
        if (receipt.status !== "succeeded" || result.exitCode !== 0) {
          if (
            receipt.outputs.length !== 0 ||
            receipt.logical_result_items !== 0 ||
            result.exitCode === 0
          )
            throw new Error("inconsistent bridge failure");
          throw new Error("guest job failed");
        }
        if (
          receipt.error_code !== null ||
          receipt.outputs.length !== 1 ||
          receipt.logical_result_items > request.limits.max_result_items
        )
          throw new Error("invalid successful receipt");
        const output = receipt.outputs[0];
        if (
          output === undefined ||
          output.schema_id !== resultSchema(operation) ||
          output.path !== join(runDirectory, "results", "result.json") ||
          output.byte_length > request.limits.max_output_bytes
        )
          throw new Error("unexpected output identity");
        const bytes = await exactOutput(output.path, output.byte_length, output.content_sha256);
        const body = jsonBytes(bytes, ResultSchema, "VM result", request.limits.max_output_bytes);
        if (body.schema_id === "penny.sca-source-query-result.v1") {
          if (
            input.kind !== "source_query" ||
            canonicalJson(body.items) !== canonicalJson(expectedSourceItems(input, custody.files))
          )
            throw new Error("source result does not match sealed custody");
        }
        if (
          body.schema_id === "penny.sca-graph-query-result.v1" &&
          (input.kind !== "graph_query" ||
            body.items.some(
              (item) => !input.selectors.some((selector) => graphItemMatches(selector, item))
            ))
        )
          throw new Error("graph result escaped selection");
        if (body.schema_id === "penny.sca-application-test-result.v1") {
          const actual = body.items.map((item) => item.path).sort();
          const expected = [...selected].sort();
          if (
            input.kind !== "application_test" ||
            body.test_id !== testId ||
            new Set(actual).size !== actual.length ||
            canonicalJson(actual) !== canonicalJson(expected) ||
            testId === null ||
            selected.some((path) => {
              const source = stagedSources.get(path);
              return source === undefined || !hostSyntaxPass(testId, path, source);
            })
          )
            throw new Error("application test result does not match its plan");
        }
        if (
          body.schema_id !== output.schema_id ||
          body.items.length !== receipt.logical_result_items ||
          body.items.length > request.limits.max_result_items ||
          ("query_id" in body &&
            (input.kind === "application_test" || body.query_id !== input.query_id))
        )
          throw new Error("result semantics mismatch");
        if (context.signal.aborted) throw new Error("cancelled");
        const verifiedBody = {
          ...body,
          authority:
            body.schema_id === "penny.sca-source-query-result.v1"
              ? ("host_verified_excerpt" as const)
              : body.schema_id === "penny.sca-application-test-result.v1"
                ? ("host_verified_syntax" as const)
                : ("scanner_observation" as const),
        };
        const verifiedBytes = Buffer.from(canonicalJson(verifiedBody));
        if (verifiedBytes.length > request.limits.max_output_bytes)
          throw new Error("verified result exceeds output limit");
        const phase = "SCA-VM";
        const kind = "sca-vm-result";
        const operationId = `${request.job_id}-${request.attempt}`;
        const version = store.lastVersion(request.run_id, phase, null, kind, operationId) + 1;
        const ref = store.persist({
          metadata: {
            schema_version: 2,
            run_id: request.run_id,
            phase,
            branch_id: null,
            kind,
            operation_id: operationId,
            version,
            producer: "sca-vm-broker",
            media_type: output.media_type,
            content_schema: { schema_id: output.schema_id, schema_version: 1 },
            parent_ref:
              version === 1
                ? null
                : store.refFor(request.run_id, phase, null, kind, operationId, version - 1),
            upstream_refs: [
              request.source_snapshot_ref,
              request.config_ref,
              ...request.input_refs,
            ].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
          },
          content: verifiedBytes,
        });
        if (
          ref.content_digest !== sha256(verifiedBytes) ||
          ref.byte_length !== verifiedBytes.length
        )
          throw new Error("persisted output mismatch");
        context.reportPersistedOutput(ref.byte_length, body.items.length);
        outcome = {
          terminal_status: "succeeded",
          failure: null,
          partial: false,
          truncated: false,
          output_refs: [ref].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
          result_item_count: body.items.length,
        };
      } catch (error) {
        outcome = failure(
          context.signal.aborted || (error instanceof Error && error.message === "cancelled")
            ? "cancelled"
            : "failed"
        );
      }
      if (work !== undefined && terminationProved && cleanupApproved) {
        try {
          if (realpathSync(work) !== work) throw new Error("workspace substituted");
          await rm(work, { recursive: true, force: false });
          try {
            await lstat(work);
            throw new Error("workspace still exists");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
        } catch {
          context.reportContainmentUnverified?.();
          outcome = failure("failed", "SCA VM cleanup unverified; private work retained");
        }
      } else if (!terminationProved || !cleanupApproved) {
        context.reportContainmentUnverified?.();
        outcome = failure("failed", "SCA VM containment unverified; private work retained");
      }
      return outcome;
    },
  });
  return Object.freeze({
    source_query: adapter("source_query"),
    graph_query: adapter("graph_query"),
    application_test: adapter("application_test"),
  });
}

/**
 * Build and admit a CPG through the configured pinned bridge. Untrusted callers cannot supply
 * graph bytes or a receipt; both are read back from this invocation's private run directory.
 */
export async function buildVerifiedVmGraph(input: VmGraphBuildRequest) {
  const options = Object.freeze({
    ...input.options,
    runJob: Object.freeze({ ...input.options.runJob }),
    runGuest: Object.freeze({ ...input.options.runGuest }),
    outputProtocol: Object.freeze({ ...input.options.outputProtocol }),
    python: Object.freeze({ ...input.options.python }),
    genisoimage: Object.freeze({ ...input.options.genisoimage }),
    cp: Object.freeze({ ...input.options.cp }),
    qemu: Object.freeze({ ...input.options.qemu }),
    bwrap: Object.freeze({ ...input.options.bwrap }),
    systemctl: Object.freeze({ ...input.options.systemctl }),
    template: Object.freeze({ ...input.options.template }),
    authorization: Object.freeze({
      configProducers: Object.freeze([...input.options.authorization.configProducers]),
      configDigests: Object.freeze([...input.options.authorization.configDigests]),
      executionPlanProducers: Object.freeze([
        ...input.options.authorization.executionPlanProducers,
      ]),
      graphBindingProducers: Object.freeze([...input.options.authorization.graphBindingProducers]),
      graphProducers: Object.freeze([...input.options.authorization.graphProducers]),
      policyProducers: Object.freeze([...input.options.authorization.policyProducers]),
      policyDigests: Object.freeze([...input.options.authorization.policyDigests]),
    }),
  });
  // Reuse the production adapter's complete authority, path, pin, store and lock validation.
  createVmBrokerAdapterRegistry(options);
  if (
    !Number.isSafeInteger(input.maxNumDef) ||
    input.maxNumDef < 1 ||
    input.maxNumDef > 100_000 ||
    !Number.isSafeInteger(input.maxOutputBytes) ||
    input.maxOutputBytes < 1 ||
    input.maxOutputBytes > 256 * 1_048_576 ||
    input.signal.aborted
  )
    throw new Error("invalid VM graph build request");
  const store = options.artifactStore;
  assertP01Ref(
    input.sourceSnapshotRef,
    "source-snapshot",
    "penny.sca-campaign-source-snapshot.v2",
    2
  );
  const snapshot = canonicalDocument(
    exactArtifact(store, input.sourceSnapshotRef, MAX_CONTROL),
    validateScaCampaignSourceSnapshotV2
  );
  assertP01Ref(
    snapshot.file_manifest_ref,
    "sca-p01-source-file-manifest",
    "penny.sca-p01-source-file-manifest.v1",
    1
  );
  assertP01Ref(
    snapshot.custody_ref,
    "sca-p01-source-custody-corpus",
    "penny.sca-p01-source-custody-corpus.v1",
    1
  );
  const manifest = canonicalDocument(
    exactArtifact(store, snapshot.file_manifest_ref, 8 * MAX_CONTROL),
    validateScaP01SourceFileManifestV1,
    8 * MAX_CONTROL
  );
  const custody = canonicalDocument(
    exactArtifact(store, snapshot.custody_ref, 64 * 1_048_576),
    validateScaP01SourceCustodyCorpusV1,
    64 * 1_048_576
  );
  validateScaP01SourceMaterialV1({
    snapshot,
    file_manifest_ref: snapshot.file_manifest_ref,
    file_manifest: manifest,
    custody_ref: snapshot.custody_ref,
    custody,
  });
  if (
    canonicalJson(store.metadata(snapshot.file_manifest_ref).upstream_refs) !== "[]" ||
    canonicalJson(store.metadata(snapshot.custody_ref).upstream_refs) !==
      canonicalJson([snapshot.file_manifest_ref]) ||
    canonicalJson(store.metadata(input.sourceSnapshotRef).upstream_refs) !==
      canonicalJson(
        [snapshot.file_manifest_ref, snapshot.custody_ref].sort((a, b) =>
          a.artifact_id.localeCompare(b.artifact_id)
        )
      )
  )
    throw new Error("source lineage mismatch");
  if (
    manifest.files.length !== custody.files.length ||
    manifest.files.some((file) => !safePath(file.path) || file.byte_count > MAX_FILE) ||
    manifest.byte_count > MAX_SOURCE
  )
    throw new Error("graph build source exceeds guest contract");
  const custodyByPath = new Map(custody.files.map((file) => [file.path, file]));
  const declarations = manifest.files.map((file) => ({
    path: file.path,
    asset_path: `source/${file.path}`,
    byte_length: file.byte_count,
    content_sha256: file.content_sha256,
  }));
  let work: string | undefined;
  let terminationProved = true;
  let cleanupApproved = true;
  let admitted: ReturnType<typeof persistVerifiedVmGraph> | undefined;
  let failureError: unknown;
  try {
    pinned(options.runJob, MAX_TOOL);
    pinned(options.outputProtocol, MAX_TOOL);
    work = await mkdtemp(join(options.workspaceParent, "sca-graph-build-"));
    const jobDir = join(work, "job");
    const runParent = join(work, "runs");
    await mkdir(jobDir, { mode: 0o700 });
    await mkdir(runParent, { mode: 0o700 });
    for (const declaration of declarations) {
      const file = custodyByPath.get(declaration.path);
      if (file === undefined) throw new Error("source vanished");
      const bytes = Buffer.from(file.content_base64, "base64");
      if (bytes.length !== declaration.byte_length || sha256(bytes) !== declaration.content_sha256)
        throw new Error("source custody mismatch");
      const target = join(jobDir, declaration.asset_path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await exclusiveFile(target, bytes);
    }
    const job = {
      schema_id: "penny.sca-vm-job.v1" as const,
      schema_version: 1 as const,
      operation: "graph_build" as const,
      limits: { max_output_bytes: input.maxOutputBytes, max_result_items: 16 },
      payload: {
        files: declarations,
        language: input.language,
        max_num_def: input.maxNumDef,
      },
    };
    const jobBytes = Buffer.from(canonicalJson(job));
    jsonBytes(jobBytes, VmGraphBuildJobSchema, "VM graph build job");
    await exclusiveFile(join(jobDir, "job.json"), jobBytes);
    if (input.signal.aborted) throw new Error("cancelled");
    const args = [
      options.runJob.path,
      "--job-dir",
      jobDir,
      "--output-parent",
      runParent,
      ...toolArgs("template", options.template, true),
      ...toolArgs("launcher", options.runGuest),
      ...toolArgs("python", options.python),
      ...toolArgs("genisoimage", options.genisoimage),
      ...toolArgs("copy", options.cp),
      ...toolArgs("qemu", options.qemu),
      ...toolArgs("bwrap", options.bwrap),
      ...toolArgs("systemctl", options.systemctl),
      "--lock-file",
      validatedGlobalLock(options.globalLock),
      "--max-output-bytes",
      String(input.maxOutputBytes),
      "--timeout",
      "1200",
    ];
    terminationProved = false;
    cleanupApproved = false;
    const result = await (options.runner ?? vmBrokerProcessRunner).run(
      options.python.path,
      args,
      input.signal,
      input.reportWorkMilestone ?? (() => undefined)
    );
    terminationProved = result.terminated;
    if (!terminationProved) throw new Error("child termination uncertain");
    if (Buffer.byteLength(result.stdout) > MAX_RUNNER_OUTPUT)
      throw new Error("bridge output overflow");
    if (!result.stdout.endsWith("\n") || result.stdout.endsWith("\n\n"))
      throw new Error("bridge must emit one JSON line");
    if (result.exitCode === 130) {
      const cancellation = jsonBytes(
        Buffer.from(result.stdout.slice(0, -1)),
        CancellationResultSchema,
        "VM cancellation result"
      );
      if (cancellation.job_sha256 !== sha256(jobBytes))
        throw new Error("cancellation identity mismatch");
      cleanupApproved = true;
      throw new Error("cancelled");
    }
    if (result.exitCode !== 0) throw new Error("graph build failed");
    const receiptBytes = Buffer.from(result.stdout.slice(0, -1));
    const receipt = jsonBytes(receiptBytes, VmGraphBuildReceiptSchema, "VM graph build receipt");
    const runDirectory = receipt.run_directory;
    if (
      dirname(runDirectory) !== runParent ||
      !/^sca-vm-job-[A-Za-z0-9_]+$/u.test(runDirectory.slice(runParent.length + 1)) ||
      receipt.job_sha256 !== sha256(jobBytes)
    )
      throw new Error("bridge identity mismatch");
    for (const directory of [runDirectory, join(runDirectory, "results")]) {
      const details = lstatSync(directory);
      if (
        realpathSync(directory) !== directory ||
        !details.isDirectory() ||
        details.uid !== getuid?.() ||
        (details.mode & 0o777) !== 0o700
      )
        throw new Error("bridge directory changed");
    }
    cleanupApproved = true;
    const graphOutput = receipt.outputs.find((output) => output.name === "graph.cpg.bin");
    const metadataOutput = receipt.outputs.find((output) => output.name === "metadata.json");
    if (
      graphOutput === undefined ||
      metadataOutput === undefined ||
      graphOutput.path !== join(runDirectory, "results", "graph.cpg.bin") ||
      metadataOutput.path !== join(runDirectory, "results", "metadata.json") ||
      graphOutput.byte_length > input.maxOutputBytes ||
      graphOutput.byte_length + metadataOutput.byte_length > input.maxOutputBytes
    )
      throw new Error("unexpected graph output identity");
    const graphBytes = await exactOutput(
      graphOutput.path,
      graphOutput.byte_length,
      graphOutput.content_sha256
    );
    const metadataBytes = await exactOutput(
      metadataOutput.path,
      metadataOutput.byte_length,
      metadataOutput.content_sha256
    );
    const metadata = jsonBytes(
      metadataBytes,
      VmGraphBuildMetadataSchema,
      "VM graph build metadata"
    );
    if (
      metadata.byte_length !== graphBytes.length ||
      metadata.content_sha256 !== sha256(graphBytes) ||
      metadata.file_count !== manifest.file_count ||
      metadata.language !== input.language
    )
      throw new Error("graph metadata mismatch");
    if (input.signal.aborted) throw new Error("cancelled");
    admitted = persistVerifiedVmGraph({
      artifactStore: store,
      sourceSnapshotRef: input.sourceSnapshotRef,
      graphBuildJob: jobBytes,
      graphBuildReceipt: receiptBytes,
      graphBytes,
      runId: input.runId,
      operationId: input.operationId,
    });
  } catch (error) {
    failureError = error;
  }
  if (work !== undefined && terminationProved && cleanupApproved) {
    try {
      if (realpathSync(work) !== work) throw new Error("workspace substituted");
      await rm(work, { recursive: true, force: false });
      try {
        await lstat(work);
        throw new Error("workspace still exists");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    } catch (error) {
      failureError = error;
    }
  }
  if (failureError !== undefined) throw failureError;
  if (admitted === undefined) throw new Error("graph build produced no admitted graph");
  return admitted;
}

function toolArgs(name: string, file: PinnedVmFile, includeSize = false): string[] {
  return [
    `--${name}`,
    file.path,
    `--${name}-sha256`,
    file.sha256,
    ...(includeSize ? ["--template-size-bytes", String(file.size_bytes)] : []),
  ];
}
function assertSupportedParameters(
  parameters: Extract<
    ScaBrokerExecuteRequestV1["operation_input"],
    { kind: "source_query" | "graph_query" }
  >["parameters"]
): void {
  if (parameters.length === 0) return;
  if (
    parameters.length !== 1 ||
    parameters[0]?.name !== "case_sensitive" ||
    parameters[0].value.kind !== "boolean" ||
    parameters[0].value.value !== true
  )
    throw new Error("query parameter is unsupported");
}

type CustodySourceFile = Readonly<{
  path: string;
  content_base64: string;
  content_sha256: string;
  byte_count: number;
}>;

function sourceLines(text: string): string[] {
  const trailingNewline = text.endsWith("\n");
  const parts = text.split("\n");
  if (trailingNewline) parts.pop();
  return parts.map((line, index) =>
    index < parts.length - 1 || trailingNewline ? `${line}\n` : line
  );
}

function expectedSourceItems(
  input: Extract<ScaBrokerExecuteRequestV1["operation_input"], { kind: "source_query" }>,
  files: readonly CustodySourceFile[]
): readonly Readonly<{
  content_sha256: string;
  end_line_exclusive: number;
  path: string;
  start_line: number;
  text: string;
}>[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const items = [];
  for (const selector of input.selectors) {
    const file = byPath.get(selector.path);
    if (file === undefined) throw new Error("selector source is absent from custody");
    const bytes = Buffer.from(file.content_base64, "base64");
    if (
      bytes.toString("base64") !== file.content_base64 ||
      bytes.length !== file.byte_count ||
      sha256(bytes) !== file.content_sha256
    )
      throw new Error("selector source custody is invalid");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const lines = sourceLines(text);
    const first = selector.line_range?.start_line ?? 1;
    const last = Math.min(
      (selector.line_range?.end_line_exclusive ?? lines.length + 1) - 1,
      lines.length
    );
    if (selector.symbol !== null) {
      for (let index = first; index <= last; index += 1) {
        const line = lines[index - 1];
        if (line !== undefined && line.includes(selector.symbol))
          items.push({
            content_sha256: file.content_sha256,
            end_line_exclusive: index + 1,
            path: selector.path,
            start_line: index,
            text: line,
          });
      }
    } else {
      const selected = lines.slice(first - 1, last).join("");
      if (selected.length > 0)
        items.push({
          content_sha256: file.content_sha256,
          end_line_exclusive: last + 1,
          path: selector.path,
          start_line: first,
          text: selected,
        });
    }
  }
  return items;
}

function graphItemMatches(
  selector: Extract<
    ScaBrokerExecuteRequestV1["operation_input"],
    { kind: "graph_query" }
  >["selectors"][number],
  item: Readonly<{
    file_name: string;
    full_name: string;
    line_number: number | null;
    name: string;
  }>
): boolean {
  if (selector.path !== item.file_name) return false;
  if (
    selector.line_range !== null &&
    (item.line_number === null ||
      item.line_number < selector.line_range.start_line ||
      item.line_number >= selector.line_range.end_line_exclusive)
  )
    return false;
  return (
    selector.symbol === null ||
    item.name.includes(selector.symbol) ||
    item.full_name.includes(selector.symbol)
  );
}

function queryPayload(
  input: Extract<
    ScaBrokerExecuteRequestV1["operation_input"],
    { kind: "source_query" | "graph_query" }
  >
): object {
  return {
    query_id: input.query_id,
    parameters: input.parameters,
    selectors: input.selectors.map((s) => ({
      path: s.path,
      symbol: s.symbol,
      start_line: s.line_range?.start_line ?? null,
      end_line_exclusive: s.line_range?.end_line_exclusive ?? null,
    })),
  };
}
function matchesTest(path: string, id: "php.syntax.v1" | "jssrc.parse.v1"): boolean {
  return id === "php.syntax.v1" ? path.endsWith(".php") : /\.(js|jsx|mjs|ts|tsx)$/u.test(path);
}
function resultSchema(operation: ScaBrokerOperationKind): string {
  return operation === "source_query"
    ? "penny.sca-source-query-result.v1"
    : operation === "graph_query"
      ? "penny.sca-graph-query-result.v1"
      : "penny.sca-application-test-result.v1";
}
const ResultSchema = Type.Union([
  Type.Object(
    {
      schema_id: Type.Literal("penny.sca-source-query-result.v1"),
      schema_version: Type.Literal(1),
      complete: Type.Literal(true),
      authority: Type.Literal("guest_claim"),
      query_id: OpaqueIdSchema,
      items: Type.Array(
        Type.Object(
          {
            content_sha256: Sha256Schema,
            path: SourcePath,
            start_line: Type.Integer({ minimum: 1 }),
            end_line_exclusive: Type.Integer({ minimum: 1 }),
            text: Type.String({ maxLength: MAX_FILE }),
          },
          { additionalProperties: false }
        ),
        { maxItems: 10_000 }
      ),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      schema_id: Type.Literal("penny.sca-graph-query-result.v1"),
      schema_version: Type.Literal(1),
      complete: Type.Literal(true),
      authority: Type.Literal("guest_claim"),
      query_id: OpaqueIdSchema,
      items: Type.Array(
        Type.Object(
          {
            file_name: SourcePath,
            full_name: Type.String({ maxLength: 4096 }),
            label: Type.String({ maxLength: 256 }),
            line_number: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
            name: Type.String({ maxLength: 4096 }),
            node_id: Type.String({ pattern: "^[0-9]+$", maxLength: 32 }),
          },
          { additionalProperties: false }
        ),
        { maxItems: 10_000 }
      ),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      schema_id: Type.Literal("penny.sca-application-test-result.v1"),
      schema_version: Type.Literal(1),
      complete: Type.Literal(true),
      authority: Type.Literal("guest_claim"),
      passed: Type.Literal(true),
      test_id: TestId,
      items: Type.Array(
        Type.Object(
          { path: SourcePath, passed: Type.Literal(true) },
          { additionalProperties: false }
        ),
        { minItems: 1, maxItems: 32 }
      ),
    },
    { additionalProperties: false }
  ),
]);

function assertAuthorizedRef(
  ref: ScaBrokerExecuteRequestV1["config_ref"],
  expected: Readonly<{
    kind: string;
    schemaId: string;
    producers: readonly string[];
    digests?: readonly string[];
  }>
): void {
  if (
    ref.kind !== expected.kind ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== expected.schemaId ||
    ref.content_schema.schema_version !== 1 ||
    !expected.producers.includes(ref.producer) ||
    (expected.digests !== undefined && !expected.digests.includes(ref.content_digest))
  )
    throw new Error("artifact does not have authorized VM policy provenance");
}

function assertP01Ref(
  ref: ScaBrokerExecuteRequestV1["config_ref"],
  kind: string,
  schemaId: string,
  version: number
): void {
  if (
    ref.kind !== kind ||
    ref.phase !== "SCA-P01-source" ||
    ref.producer !== SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== schemaId ||
    ref.content_schema.schema_version !== version
  )
    throw new Error("source material does not have canonical P01 provenance");
}
