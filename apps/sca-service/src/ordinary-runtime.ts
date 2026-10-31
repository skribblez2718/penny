/** Ordinary source-only runtime. Uses existing scanner/process/dependency APIs, never phase activation. */
import { mkdtemp, mkdir, writeFile, rm, open } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { ScaOsvResultV1Schema } from "./adapters/osv.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { parseSealedScaSourceCorpusV1 } from "../../orchestration/dist/sca/active-compliance.js";
import { repositoryPath, resolveRange } from "../../orchestration/dist/sca/ordinary-artifacts.js";
import {
  ScaLeadSchema,
  ScaPreparationSchema,
  ScaEvidenceSchema,
  type ScaCapability,
  type ScaLead,
} from "../../orchestration/dist/sca/ordinary-contracts.js";
import {
  ScaSemanticQuerySchema,
  sourceOnlyEvidence,
  unavailablePreparation,
  type ScaGraphData,
  type ScaHostRequest,
  type ScaOrdinaryRuntime,
  type ScaRuntimeControl,
} from "../../orchestration/dist/sca/ordinary-host.js";
import {
  redactScaP11Sensitive,
  scaP11HasSensitiveContent,
} from "../../orchestration/dist/sca/p11-redaction.js";
import { ordinaryJoernBinding, type OrdinaryJoernManifest } from "./ordinary-joern.js";
export { ordinaryJoernQueryScript } from "./ordinary-joern.js";
export type { OrdinaryJoernQueryOptions } from "./ordinary-joern.js";
import { runScaSemgrepV1 } from "./adapters/semgrep.js";
import { runScaGitleaksV1 } from "./adapters/gitleaks.js";
import {
  buildScaDependencyInventoryV2,
  type ScaDependencyInventoryInputV2,
} from "./adapters/dependency-inventory-v2.js";
import {
  runBoundedScaProcess,
  type ScaProcessRunnerV1,
  type ScaProcessRequestV1,
  type ScaProcessResultV1,
} from "./process.js";

/** Raw, bounded private evidence. The caller owns retention; never send these streams to a model. */
export interface ScaOrdinaryProcessObservation {
  source_snapshot_sha256: string;
  source_corpus_sha256: string;
  tools: ScaHostRequest["tools"];
  started_at: string;
  finished_at: string;
  request: ScaProcessRequestV1;
  result: ScaProcessResultV1;
  /** Private exact graph invocation provenance; absent for non-graph processes. */
  graph?: ReturnType<typeof ordinaryJoernBinding>;
}
export interface ScaOrdinaryDeterministicObservation {
  kind: "dependencies" | "advisories";
  source_snapshot_sha256: string;
  source_corpus_sha256: string;
  input: unknown;
  result: unknown;
}
export interface ScaOrdinaryRuntimeOptions {
  recordProcess?(observation: ScaOrdinaryProcessObservation): Promise<void>;
  recordDeterministic?(observation: ScaOrdinaryDeterministicObservation): Promise<void>;
}
async function recordDeterministic(
  options: ScaOrdinaryRuntimeOptions,
  observation: ScaOrdinaryDeterministicObservation
): Promise<void> {
  try {
    await options.recordDeterministic?.(observation);
  } catch (error) {
    throw new RuntimeInterrupted("Private deterministic evidence capture failed", { cause: error });
  }
}
class RuntimeInterrupted extends Error {}
function rethrowInterruption(error: unknown, control: ScaRuntimeControl): void {
  control.signal.throwIfAborted();
  if (error instanceof RuntimeInterrupted) throw error;
}
function processRunner(
  request: ScaHostRequest,
  corpus: Buffer,
  control: ScaRuntimeControl,
  options: ScaOrdinaryRuntimeOptions,
  graph?: ReturnType<typeof ordinaryJoernBinding>
): ScaProcessRunnerV1 {
  return {
    async run(value, signal) {
      control.signal.throwIfAborted();
      if (
        value.arguments[0] === "scan" &&
        value.executable === request.tools.semgrep?.tool.executable
      ) {
        value = {
          ...value,
          arguments: [
            "scan",
            "--jobs",
            String(SEMGREP_WORKERS),
            "--max-memory",
            String(SEMGREP_MAX_MEMORY_MB),
            ...value.arguments.slice(1),
          ],
        };
      }
      const started_at = new Date().toISOString();
      const result = await runBoundedScaProcess(value, signal ?? control.signal, control.activity);
      try {
        await options.recordProcess?.({
          source_snapshot_sha256: request.source_snapshot_sha256,
          source_corpus_sha256: sha256(corpus),
          tools: request.tools,
          started_at,
          finished_at: new Date().toISOString(),
          request: value,
          result,
          ...(graph === undefined ? {} : { graph }),
        });
      } catch (error) {
        throw new RuntimeInterrupted("Private process evidence capture failed", { cause: error });
      }
      control.signal.throwIfAborted();
      if (result.status === "cancelled") throw new RuntimeInterrupted("Analyzer process cancelled");
      return result;
    },
  };
}

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const GRAPH_LIMIT = 32 * 1024 * 1024;
const INACTIVITY_MS = 300_000;
// Native CLI controls, not an OS sandbox or a total wall-clock deadline.
const SEMGREP_WORKERS = 1;
const SEMGREP_MAX_MEMORY_MB = 512;
const ScannerRecordSchema = Type.Object(
  {
    check_id: Type.String(),
    path: Type.String(),
    start: Type.Object({ line: Type.Integer({ minimum: 1 }) }, { additionalProperties: true }),
    end: Type.Object({ line: Type.Integer({ minimum: 1 }) }, { additionalProperties: true }),
  },
  { additionalProperties: true }
);
const LeakRecordSchema = Type.Object(
  {
    RuleID: Type.String(),
    File: Type.String(),
    StartLine: Type.Integer({ minimum: 1 }),
    EndLine: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: true }
);
function parse(text: string): unknown {
  return JSON.parse(text);
}
function runtime(tool: { executable: string; sha256: string; version: string }) {
  return {
    state: "available" as const,
    executable: tool.executable,
    executable_sha256: tool.sha256,
    fixed_arguments: [],
    tool_version: tool.version,
    runtime_identity: "caller-selected-source-analyzer",
    runtime_sha256: tool.sha256,
  };
}
async function boundedFile(file: string, maximum: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum)
      throw new Error("Analyzer file missing, linked or oversized");
    // Do not let concurrent growth turn a bounded capture into an unbounded allocation.
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    if (
      bytes.length > maximum ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      throw new Error("Analyzer file changed during capture");
    return bytes;
  } finally {
    await handle.close();
  }
}
async function verifiedFile(file: string, digest: string): Promise<Buffer> {
  const bytes = await boundedFile(file, OUTPUT_LIMIT);
  if (sha256(bytes) !== digest) throw new Error("Caller-selected tool/rule/script identity drift");
  return bytes;
}
/** Capture once, then only hand the analyzer this private read-only copy, never caller paths. */
async function materializeVerifiedFile(
  file: string,
  digest: string,
  directory: string,
  name: string
): Promise<string> {
  const bytes = await verifiedFile(file, digest);
  const captured = path.join(directory, name);
  await writeFile(captured, bytes, { flag: "wx", mode: 0o400 });
  return captured;
}
async function stage(corpusBytes: Buffer, control: ScaRuntimeControl) {
  control.signal.throwIfAborted();
  const corpus = parseSealedScaSourceCorpusV1(corpusBytes);
  const root = await mkdtemp(path.join(tmpdir(), "penny-sca-ordinary-"));
  const source = path.join(root, "source");
  const scratch = path.join(root, "scratch");
  try {
    await mkdir(source);
    await mkdir(scratch);
    for (const file of corpus.files.values()) {
      control.signal.throwIfAborted();
      if (!repositoryPath(file.path)) throw new Error("SCA staged path escape");
      const target = path.join(source, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { flag: "wx", mode: 0o600 });
    }
    return { root, source, scratch, corpus };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
function capability(
  id: string,
  status: ScaCapability["status"],
  detail: string,
  version: string | null = null,
  config: string | null = null,
  evidence: string | null = null
): ScaCapability {
  return { id, status, detail, version, configuration_sha256: config, evidence_sha256: evidence };
}
function lead(
  origin: ScaLead["origin"],
  title: string,
  records: unknown,
  locations: ScaLead["locations"]
): ScaLead {
  const evidence_sha256 = sha256(canonicalJson(records));
  return validateContract(
    ScaLeadSchema,
    {
      id: `${origin}:${evidence_sha256}`,
      origin,
      title: redactScaP11Sensitive(title),
      locations,
      evidence_sha256,
    },
    "SCA deterministic lead"
  );
}
function scannerPath(value: string, sourceRoot: string): string {
  const relative = path.isAbsolute(value)
    ? path.relative(sourceRoot, value).split(path.sep).join("/")
    : value.replace(/^\.\//u, "");
  if (!repositoryPath(relative))
    throw new Error("Scanner output path escaped the exact source tree");
  return relative;
}
async function runTool(
  tool: { executable: string; sha256: string },
  args: string[],
  cwd: string,
  control: ScaRuntimeControl,
  runner: ScaProcessRunnerV1
) {
  const result = await runner.run(
    {
      schema_id: "penny.sca-process-request.v1",
      schema_version: 1,
      executable: tool.executable,
      executable_sha256: tool.sha256,
      arguments: args,
      cwd,
      environment: [
        { name: "HOME", value: cwd },
        { name: "PATH", value: "/usr/bin:/bin" },
      ],
      timeout_ms: INACTIVITY_MS,
      max_stdout_bytes: OUTPUT_LIMIT,
      max_stderr_bytes: OUTPUT_LIMIT,
    },
    control.signal
  );
  if (result.status !== "succeeded" || result.stdout_truncated || result.stderr_truncated)
    throw new Error(`Analyzer process ${result.status}`);
  return result;
}
async function graphQuery(input: {
  request: ScaHostRequest;
  graph: ScaGraphData;
  queryId: string;
  directory: string;
  control: ScaRuntimeControl;
  corpus: Buffer;
  files: OrdinaryJoernManifest["files"];
  options: ScaOrdinaryRuntimeOptions;
}) {
  const config = input.request.tools.graph;
  const query = config?.queries.find((entry) => entry.id === input.queryId);
  if (config === undefined || query === undefined)
    throw new Error("Graph query ID was not caller-selected");
  const queryDirectory = await mkdtemp(path.join(input.directory, "query-"));
  const scriptPath = await materializeVerifiedFile(
    query.script_path,
    query.sha256,
    queryDirectory,
    "query.sc"
  );
  const graphPath = path.join(queryDirectory, `${input.graph.language}.cpg`);
  const bytes = Buffer.from(input.graph.bytes_base64, "base64");
  if (sha256(bytes) !== input.graph.graph_sha256) throw new Error("Graph bytes mismatch");
  if (bytes.toString("base64") !== input.graph.bytes_base64 || bytes.length > GRAPH_LIMIT)
    throw new Error("Graph encoding or byte limit invalid");
  await writeFile(graphPath, bytes, { flag: "wx", mode: 0o400 });
  const manifest: OrdinaryJoernManifest = {
    schema_version: 1,
    language: input.graph.language,
    source_snapshot_sha256: input.request.source_snapshot_sha256,
    source_corpus_sha256: sha256(input.corpus),
    files: input.files.map(({ path, content_sha256 }) => ({ path, content_sha256 })),
  };
  await writeFile(`${graphPath}.manifest.json`, canonicalJson(manifest), {
    flag: "wx",
    mode: 0o400,
  });
  const binding = ordinaryJoernBinding({
    manifest,
    graph: input.graph,
    config,
    queryId: input.queryId,
  });
  // Joern 4 CLI uses singular --param. No shell or log/JSON scraping fallback.
  const result = await runTool(
    config.joern,
    ["--script", scriptPath, "--param", `cpgFile=${graphPath}`],
    queryDirectory,
    input.control,
    processRunner(input.request, input.corpus, input.control, input.options, binding)
  );
  const observation = validateContract(
    ScaSemanticQuerySchema,
    parse(result.stdout),
    "SCA semantic graph coverage/rows"
  );
  const expected = new Map(input.files.map((file) => [file.path, file.content_sha256]));
  const seen = new Set<string>();
  for (const file of observation.files) {
    if (
      !repositoryPath(file.path) ||
      seen.has(file.path) ||
      expected.get(file.path) !== file.content_sha256
    )
      throw new Error("Graph query reported foreign, duplicate or misbound source coverage");
    seen.add(file.path);
  }
  if (observation.rows.some((row) => !repositoryPath(row.path) || !expected.has(row.path)))
    throw new Error("Graph row escaped its language source scope");
  return {
    ...observation,
    digest: result.stdout_sha256,
    binding_sha256: sha256(canonicalJson(binding)),
  };
}
function supportedCoverage(
  observed: {
    complete: boolean;
    files: { path: string; content_sha256: string; status: string }[];
  },
  files: { path: string; content_sha256: string }[]
): boolean {
  const expected = new Map(files.map((file) => [file.path, file.content_sha256]));
  return (
    observed.complete &&
    observed.files.length === files.length &&
    new Set(observed.files.map((file) => file.path)).size === files.length &&
    observed.files.every(
      (file) => file.status === "supported" && expected.get(file.path) === file.content_sha256
    )
  );
}
export function createOrdinaryScaRuntime(
  options: ScaOrdinaryRuntimeOptions = {}
): ScaOrdinaryRuntime {
  return {
    async prepare({ request, corpus: bytes, control }) {
      const staged = await stage(bytes, control);
      try {
        const result = unavailablePreparation(
          bytes,
          "Analyzer not configured by caller; not a clean result."
        );
        const capabilities: ScaCapability[] = [];
        const leads: ScaLead[] = [];
        const graphs: ScaGraphData[] = [];
        result.gaps = [...staged.corpus.excluded_paths].map(
          (file) => `Non-text source excluded: ${file}`
        );
        if (staged.corpus.source_snapshot_sha256 !== request.source_snapshot_sha256)
          throw new Error("SCA runtime source snapshot mismatch");
        const runner = processRunner(request, bytes, control, options);
        const documents: ScaDependencyInventoryInputV2["documents"] = [];
        for (const file of staged.corpus.files.values()) {
          const name = path.posix.basename(file.path);
          if (
            !["package.json", "package-lock.json", "composer.json", "composer.lock"].includes(name)
          )
            continue;
          documents.push({
            ecosystem: name.startsWith("composer") ? "Packagist" : "npm",
            project_path: path.posix.dirname(file.path),
            role: name === "package.json" || name === "composer.json" ? "manifest" : "lockfile",
            path: file.path,
            sha256: file.content_sha256,
            content: file.text,
          });
        }
        let dependencyDigest: string | undefined;
        let dependencyComplete = false;
        let dependencyCoordinates: {
          ecosystem: "npm" | "Packagist";
          name: string;
          version: string;
        }[] = [];
        const dependencyInput: ScaDependencyInventoryInputV2 = {
          schema_id: "penny.sca-dependency-inventory-input.v2",
          schema_version: 2,
          source_snapshot_sha256: request.source_snapshot_sha256,
          ecosystems: ["npm", "Packagist"],
          documents,
        };
        const record = (
          kind: ScaOrdinaryDeterministicObservation["kind"],
          input: unknown,
          result: unknown
        ) =>
          recordDeterministic(options, {
            kind,
            source_snapshot_sha256: request.source_snapshot_sha256,
            source_corpus_sha256: sha256(bytes),
            input,
            result,
          });
        try {
          let dependencies: ReturnType<typeof buildScaDependencyInventoryV2>;
          try {
            dependencies = buildScaDependencyInventoryV2(dependencyInput);
          } catch (error) {
            await record("dependencies", dependencyInput, { status: "failed" });
            throw error;
          }
          await record("dependencies", dependencyInput, dependencies);
          dependencyDigest = dependencies.inventory_sha256;
          dependencyComplete = dependencies.status === "succeeded";
          dependencyCoordinates = dependencies.coordinates;
          capabilities.push(
            capability(
              "dependencies",
              dependencies.status === "succeeded" ? "completed" : dependencies.status,
              `npm/Composer exact lockfile extraction: ${dependencies.occurrences.length} occurrences; ${dependencies.edges.length} dependency edges. Ecosystems: ${dependencies.ecosystems.map((entry) => `${entry.ecosystem}=${entry.state}`).join(", ")}.`,
              "dependency-inventory-v2",
              null,
              dependencies.inventory_sha256
            )
          );
          for (const occurrence of dependencies.occurrences.filter(
            (entry) => entry.relationship === "dependency"
          )) {
            leads.push(
              lead(
                "dependency",
                `Dependency exposure: ${occurrence.ecosystem} ${occurrence.name ?? "unresolved"}@${occurrence.version ?? "unresolved"}; not an advisory or exploitability finding.`,
                occurrence,
                [{ path: occurrence.lockfile_path, start_line: 1, end_line: 1 }]
              )
            );
          }
        } catch (error) {
          rethrowInterruption(error, control);
          capabilities.push(
            capability(
              "dependencies",
              "failed",
              "Dependency inventory malformed, unsupported or over limit; no package install was attempted."
            )
          );
        }
        if (
          dependencyDigest !== undefined &&
          dependencyComplete &&
          dependencyCoordinates.length === 0
        ) {
          await record(
            "advisories",
            { dependency_inventory_sha256: dependencyDigest },
            {
              status: "succeeded",
              coordinates_queried: 0,
              network_request: "not_run",
            }
          );
          capabilities.push(
            capability(
              "advisories",
              "completed",
              "Exact dependency inventory contains no resolved external coordinates to match; no OSV network request made.",
              "offline-osv-result-v1",
              null,
              dependencyDigest
            )
          );
        } else if (request.tools.advisory_results !== undefined && dependencyDigest !== undefined) {
          try {
            const config = request.tools.advisory_results;
            let captured: Buffer;
            try {
              captured = await boundedFile(config.path, OUTPUT_LIMIT);
            } catch (error) {
              await record("advisories", config, { status: "capture_failed" });
              throw error;
            }
            // Retain even malformed/stale/misbound responses before interpretation.
            await record("advisories", config, {
              content_base64: captured.toString("base64"),
              content_sha256: sha256(captured),
            });
            if (sha256(captured) !== config.sha256)
              throw new Error("Offline advisory identity drift");
            const advisories = validateContract(
              ScaOsvResultV1Schema,
              parse(captured.toString("utf8")),
              "Offline advisory result"
            );
            const { result_sha256, ...unsigned } = advisories;
            if (
              sha256(canonicalJson(unsigned)) !== result_sha256 ||
              advisories.source_snapshot_sha256 !== request.source_snapshot_sha256 ||
              advisories.dependency_inventory_sha256 !== dependencyDigest ||
              advisories.coordinates_queried !== dependencyCoordinates.length ||
              Date.parse(advisories.queried_at) > Date.now() ||
              Date.now() - Date.parse(advisories.queried_at) > 86_400_000
            )
              throw new Error("Advisory snapshot stale or misbound");
            const complete = advisories.status === "succeeded" && advisories.pagination_complete;
            capabilities.push(
              capability(
                "advisories",
                complete ? "completed" : "partial",
                "Caller-selected offline OSV result, bound to this exact dependency inventory; advisory matching does not prove reachability/exploitability. No network request made by this run.",
                "offline-osv-result-v1",
                config.sha256,
                result_sha256
              )
            );
            for (const advisory of advisories.advisories) {
              const locations = documents
                .filter((document) => document.role === "lockfile")
                .map((document) => ({ path: document.path, start_line: 1, end_line: 1 }));
              if (locations.length > 0)
                leads.push(
                  lead(
                    "advisory",
                    `Advisory ${advisory.id}; reachability/exploitability unresolved.`,
                    advisory,
                    locations.slice(0, 32)
                  )
                );
            }
          } catch (error) {
            rethrowInterruption(error, control);
            capabilities.push(
              capability(
                "advisories",
                "failed",
                "Offline advisory result invalid, stale, incomplete or not bound to this exact dependency inventory."
              )
            );
          }
        } else
          capabilities.push(
            capability(
              "advisories",
              "unavailable",
              "No offline advisory result admitted. No OSV network request made; dependency inventory is not vulnerability matching."
            )
          );
        for (const kind of ["semgrep", "gitleaks"] as const) {
          const config = request.tools[kind];
          if (config === undefined) {
            capabilities.push(
              capability(
                kind,
                "unavailable",
                "Caller did not select an installed tool and rule file."
              )
            );
            continue;
          }
          try {
            const rulesPath = await materializeVerifiedFile(
              config.rules_path,
              config.rules_sha256,
              staged.root,
              kind === "semgrep" ? "semgrep.yml" : "gitleaks.toml"
            );
            const output =
              kind === "semgrep"
                ? await runScaSemgrepV1(
                    {
                      schema_id: "penny.sca-semgrep-request.v1",
                      schema_version: 1,
                      source_snapshot_sha256: request.source_snapshot_sha256,
                      source_root: staged.source,
                      scratch_root: staged.scratch,
                      rule_config: rulesPath,
                      rule_config_sha256: config.rules_sha256,
                      runtime: runtime(config.tool),
                      timeout_ms: INACTIVITY_MS,
                      max_output_bytes: OUTPUT_LIMIT,
                    },
                    control.signal,
                    runner
                  )
                : await runScaGitleaksV1(
                    {
                      schema_id: "penny.sca-gitleaks-request.v1",
                      schema_version: 1,
                      source_snapshot_sha256: request.source_snapshot_sha256,
                      source_root: staged.source,
                      configuration_path: rulesPath,
                      configuration_sha256: config.rules_sha256,
                      runtime: runtime(config.tool),
                      timeout_ms: INACTIVITY_MS,
                      max_output_bytes: OUTPUT_LIMIT,
                    },
                    control.signal,
                    runner
                  );
            const good =
              (output.status === "succeeded" || output.status === "findings") &&
              output.error_code === "none" &&
              !output.truncated &&
              output.exit_code === (output.finding_count > 0 ? 1 : 0);
            if (!good) {
              capabilities.push(
                capability(
                  kind,
                  "failed",
                  `Scanner ${output.status}/${output.error_code} or contradictory exit; no clean-result claim.`,
                  config.tool.version,
                  config.rules_sha256,
                  output.raw_stdout_sha256
                )
              );
            } else {
              const scannerLeads: ScaLead[] = [];
              let complete = true;
              if (kind === "semgrep") {
                const envelope = validateContract(
                  Type.Object(
                    {
                      results: Type.Array(ScannerRecordSchema, { maxItems: 512 }),
                      errors: Type.Array(Type.Unknown(), { maxItems: 512 }),
                      paths: Type.Optional(
                        Type.Object(
                          {
                            scanned: Type.Array(Type.String(), { maxItems: 100_000 }),
                            skipped: Type.Optional(
                              Type.Array(Type.Unknown(), { maxItems: 100_000 })
                            ),
                          },
                          { additionalProperties: true }
                        )
                      ),
                      skipped_rules: Type.Optional(
                        Type.Array(Type.Unknown(), { maxItems: 100_000 })
                      ),
                    },
                    { additionalProperties: true }
                  ),
                  parse(output.raw_stdout),
                  "Semgrep records"
                );
                const scanned = envelope.paths?.scanned.map((file) =>
                  scannerPath(file, staged.source)
                );
                if (scanned?.some((file) => !staged.corpus.files.has(file)))
                  throw new Error("Semgrep reported foreign source coverage");
                const scannedSet = new Set(scanned);
                complete =
                  envelope.errors.length === 0 &&
                  scanned !== undefined &&
                  scannedSet.size === scanned.length &&
                  result.files
                    .filter((file) => file.language !== "context")
                    .every((file) => scannedSet.has(file.path)) &&
                  (envelope.paths?.skipped?.length ?? 0) === 0 &&
                  envelope.skipped_rules !== undefined &&
                  envelope.skipped_rules.length === 0;
                for (const record of envelope.results)
                  scannerLeads.push(
                    lead(kind, record.check_id, record, [
                      {
                        path: scannerPath(record.path, staged.source),
                        start_line: record.start.line,
                        end_line: record.end.line,
                      },
                    ])
                  );
              } else {
                const records = validateContract(
                  Type.Array(LeakRecordSchema, { maxItems: 512 }),
                  parse(output.raw_stdout),
                  "Gitleaks records"
                );
                for (const record of records)
                  scannerLeads.push(
                    lead(kind, record.RuleID, record, [
                      {
                        path: scannerPath(record.File, staged.source),
                        start_line: record.StartLine,
                        end_line: record.EndLine,
                      },
                    ])
                  );
              }
              for (const entry of scannerLeads)
                for (const location of entry.locations) resolveRange(staged.corpus, location);
              leads.push(...scannerLeads);
              capabilities.push(
                capability(
                  kind,
                  complete ? "completed" : "partial",
                  `Source-only scanner returned ${output.finding_count} validated records; ${complete ? "invocation complete" : "source/rule coverage missing or skipped"}. Scanner silence is not a safety verdict.`,
                  config.tool.version,
                  config.rules_sha256,
                  output.raw_stdout_sha256
                )
              );
            }
          } catch (error) {
            rethrowInterruption(error, control);
            capabilities.push(
              capability(
                kind,
                "failed",
                "Configured scanner output or tool/rule identity invalid; records unavailable, never a clean scan.",
                config.tool.version,
                config.rules_sha256
              )
            );
          }
          control.activity();
        }
        for (const language of ["php", "javascript_typescript"] as const) {
          const files = result.files.filter((file) => file.language === language);
          if (files.length === 0) {
            capabilities.push(
              capability(
                `graph_${language}`,
                "completed",
                "No source units for this language in admitted scope; graph not needed."
              )
            );
            continue;
          }
          const config = request.tools.graph;
          const frontend = language === "php" ? config?.php_frontend : config?.js_frontend;
          if (config === undefined || frontend === undefined) {
            capabilities.push(
              capability(
                `graph_${language}`,
                "unavailable",
                "No caller-selected semantic CPG frontend. Syntax is not a semantic graph."
              )
            );
            continue;
          }
          try {
            const graphPath = path.join(staged.scratch, `${language}.cpg`);
            await runTool(
              frontend,
              [staged.source, "--enable-file-content", "--output", graphPath],
              staged.scratch,
              control,
              runner
            );
            const graphBytes = await boundedFile(graphPath, GRAPH_LIMIT);
            if (graphBytes.length === 0) throw new Error("Empty graph");
            const graph: ScaGraphData = {
              schema_version: 1,
              language,
              source_snapshot_sha256: request.source_snapshot_sha256,
              format: "joern-cpg",
              bytes_base64: graphBytes.toString("base64"),
              graph_sha256: sha256(graphBytes),
              tool_version: frontend.version,
              query_observations: [],
            };
            const graphLeads: ScaLead[] = [];
            let supported = true;
            for (const query of config.queries) {
              const observed = await graphQuery({
                request,
                graph,
                queryId: query.id,
                directory: staged.scratch,
                control,
                corpus: bytes,
                files,
                options,
              });
              const observation = validateContract(
                ScaSemanticQuerySchema,
                {
                  schema_version: observed.schema_version,
                  complete: observed.complete,
                  files: observed.files,
                  rows: observed.rows,
                },
                "Semantic observation"
              );
              graph.query_observations.push({
                query_id: query.id,
                raw_stdout_sha256: observed.digest,
                observation_sha256: sha256(canonicalJson(observation)),
                observation,
              });
              if (!supportedCoverage(observed, files)) supported = false;
              for (const row of observed.rows) {
                resolveRange(staged.corpus, row);
                graphLeads.push(
                  lead("graph", `${query.id}: ${row.title}`, row, [
                    { path: row.path, start_line: row.start_line, end_line: row.end_line },
                  ])
                );
              }
            }
            graphs.push(graph);
            leads.push(...graphLeads);
            // Build/query success alone cannot attest that the frontend represented every file/edge.
            capabilities.push(
              capability(
                `graph_${language}`,
                supported ? "completed" : "partial",
                `Semantic CPG built and ${config.queries.length} caller-selected queries executed. Exact per-file snapshot/support accounting ${supported ? "complete" : "partial or unsupported"}; query observations are retained. This accounts for frontend support, not an independent proof of semantic fidelity or vulnerability absence.`,
                frontend.version,
                sha256(canonicalJson(config)),
                graph.graph_sha256
              )
            );
          } catch (error) {
            rethrowInterruption(error, control);
            capabilities.push(
              capability(
                `graph_${language}`,
                "failed",
                "Semantic graph build/query failed or output unsupported; no syntax fallback and no safe result."
              )
            );
          }
          control.activity();
        }
        for (const entry of leads)
          for (const location of entry.locations) resolveRange(staged.corpus, location);
        result.leads = leads;
        result.capabilities = capabilities;
        for (const file of result.files.filter((entry) => entry.language === "context")) {
          if (!documents.some((document) => document.path === file.path))
            result.gaps.push(`Context-only/unsupported source region: ${file.path}`);
        }
        if (leads.length > 512) {
          result.gaps.push(
            `Lead output bound exceeded: ${leads.length} observed; first 512 retained, remaining leads not investigated. Assessment INCOMPLETE.`
          );
          result.leads = leads.slice(0, 512);
        }
        control.signal.throwIfAborted();
        return {
          preparation: validateContract(ScaPreparationSchema, result, "SCA runtime preparation"),
          graphs,
        };
      } finally {
        await rm(staged.root, { recursive: true, force: true });
      }
    },
    async gather({ request, corpus, actions, graphs, control }) {
      control.signal.throwIfAborted();
      const parsedCorpus = parseSealedScaSourceCorpusV1(corpus);
      if (parsedCorpus.source_snapshot_sha256 !== request.source_snapshot_sha256)
        throw new Error("SCA runtime source snapshot mismatch");
      const result = await sourceOnlyEvidence({ corpus, actions });
      const sourceFiles = unavailablePreparation(corpus, "Coverage accounting").files;
      const directory = await mkdtemp(path.join(tmpdir(), "penny-sca-query-"));
      try {
        for (const action of actions.actions.filter((entry) => entry.kind === "graph")) {
          const record = result.results.find((entry) => entry.action_id === action.id);
          if (record === undefined) throw new Error("Evidence action not accounted");
          if (graphs.length === 0 || action.query_id === null) continue;
          try {
            const observations = [];
            for (const graph of graphs) {
              if (graph.source_snapshot_sha256 !== request.source_snapshot_sha256)
                throw new Error("Graph source snapshot mismatch");
              const files = sourceFiles.filter((file) => file.language === graph.language);
              const observed = await graphQuery({
                request,
                graph,
                queryId: action.query_id,
                directory,
                control,
                corpus,
                files,
                options,
              });
              if (!supportedCoverage(observed, files))
                throw new Error("Partial graph source support");
              observations.push(observed);
            }
            const pointers = observations.flatMap((observed) =>
              observed.rows.map((row) =>
                resolveRange(parsedCorpus, {
                  path: row.path,
                  start_line: row.start_line,
                  end_line: row.end_line,
                })
              )
            );
            if (pointers.length > 64)
              throw new Error("Graph evidence range bound exceeded; query must be focused");
            if (pointers.some((pointer) => scaP11HasSensitiveContent(pointer.exact_quote)))
              throw new Error("Sensitive graph source quotation withheld");
            const observed = canonicalJson(observations);
            if (observed.length > 1_048_576)
              throw new Error("Graph observation output limit exceeded");
            if (scaP11HasSensitiveContent(observed))
              throw new Error("Sensitive graph observation withheld before model disclosure");
            if (observations.some((entry) => !entry.complete))
              throw new Error("Partial graph query observation");
            record.status = "completed";
            record.detail =
              "Exact semantic CPG query observation; not target execution or vulnerability proof.";
            record.pointers = pointers;
            record.observation = observed;
            record.evidence_sha256 = sha256(record.observation);
          } catch (error) {
            rethrowInterruption(error, control);
            record.status = "failed";
            record.detail = "Configured semantic CPG query failed; unresolved evidence obligation.";
          }
        }
        control.signal.throwIfAborted();
        return validateContract(ScaEvidenceSchema, result, "SCA runtime evidence");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
export const ordinaryScaRuntime = createOrdinaryScaRuntime();
