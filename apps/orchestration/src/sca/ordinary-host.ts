import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  FileHostOperationResultCache,
  type HostOperationResultCacheV1,
  type HostOperationCachedResultV1,
} from "../host-operations/result-cache.js";
import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract, type HostOperationArtifactContractV1 } from "../contracts.js";
import {
  hostOperationLeaseProfileSha256,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
  type HostOperationExecutionContextV1,
} from "../host-operations/contracts.js";
import {
  ScaActionsSchema,
  ScaAnalysisToolsSchema,
  ScaEvidenceSchema,
  ScaPreparationSchema,
  type ScaActions,
  type ScaEvidence,
  type ScaPreparation,
} from "./ordinary-contracts.js";
import { scaStructuralParserCapability } from "./active-symbol-resolution.js";
import { parseSealedScaSourceCorpusV1 } from "./active-compliance.js";
import { scaP11HasSensitiveContent } from "./p11-redaction.js";
import { resolveRange } from "./ordinary-artifacts.js";

export const SCA_HOST_ADAPTER_ID = "sca-ordinary-analysis-v1";
export type ScaHostStage = "preparation" | "evidence";
export const ScaHostRequestSchema = Type.Object(
  {
    run_id: Type.String({ minLength: 1, maxLength: 256 }),
    input_bindings: Type.Array(
      Type.Object(
        {
          slot: Type.String({ minLength: 1 }),
          content_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 8 }
    ),
    schema_version: Type.Literal(1),
    stage: Type.Union([Type.Literal("preparation"), Type.Literal("evidence")]),
    source_snapshot_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    tools: ScaAnalysisToolsSchema,
  },
  { additionalProperties: false }
);
export type ScaHostRequest = Static<typeof ScaHostRequestSchema>;
export const ScaSemanticQuerySchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    complete: Type.Boolean(),
    files: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          content_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          status: Type.Union([
            Type.Literal("supported"),
            Type.Literal("unsupported"),
            Type.Literal("failed"),
          ]),
          detail: Type.String({ minLength: 1, maxLength: 16_384 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 100_000 }
    ),
    rows: Type.Array(
      Type.Object(
        {
          title: Type.String({ minLength: 1, maxLength: 16_384 }),
          path: Type.String({ minLength: 1 }),
          start_line: Type.Integer({ minimum: 1 }),
          end_line: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 512 }
    ),
  },
  { additionalProperties: false }
);
export const ScaGraphDataSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    language: Type.Union([Type.Literal("php"), Type.Literal("javascript_typescript")]),
    source_snapshot_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    format: Type.Literal("joern-cpg"),
    bytes_base64: Type.String({ minLength: 4, maxLength: 44_739_244 }),
    graph_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    tool_version: Type.String({ minLength: 1, maxLength: 256 }),
    query_observations: Type.Array(
      Type.Object(
        {
          query_id: Type.String({ minLength: 1 }),
          raw_stdout_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          observation_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          observation: ScaSemanticQuerySchema,
        },
        { additionalProperties: false }
      ),
      { maxItems: 16 }
    ),
  },
  { additionalProperties: false }
);
export type ScaGraphData = Static<typeof ScaGraphDataSchema>;
export function scaHostContract(
  stage: ScaHostStage,
  direction: "request" | "result"
): HostOperationArtifactContractV1 {
  return {
    schema_version: 1,
    port_name: `sca_${stage}_${direction}`,
    artifact_kind: `sca-${stage}-${direction}`,
    schema_id: `penny.sca-${stage}-${direction}.v1`,
    schema_version_required: 1,
  };
}
export function scaGraphContract(
  language: ScaGraphData["language"]
): HostOperationArtifactContractV1 {
  return {
    schema_version: 1,
    port_name: `graph_${language}`,
    artifact_kind: `sca-graph-${language.replaceAll("_", "-")}`,
    schema_id: "penny.sca-ordinary-graph.v1",
    schema_version_required: 1,
  };
}
/** Private host outputs only: never part of preparation/evidence cognitive inputs. */
export const SCA_RAW_RECORD_BYTES = 32 * 1024 * 1024;
export const SCA_RAW_TOTAL_BYTES = 64 * 1024 * 1024;
export const SCA_RAW_RECORD_COUNT = 128;
export const ScaRawEvidenceSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    records: Type.Array(
      Type.Object(
        {
          kind: Type.Union([
            Type.Literal("process"),
            Type.Literal("dependencies"),
            Type.Literal("advisories"),
          ]),
          byte_length: Type.Integer({ minimum: 0, maximum: SCA_RAW_RECORD_BYTES }),
          content_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          content_base64: Type.String({ maxLength: Math.ceil(SCA_RAW_RECORD_BYTES / 3) * 4 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: SCA_RAW_RECORD_COUNT }
    ),
  },
  { additionalProperties: false }
);
export type ScaRawEvidence = Static<typeof ScaRawEvidenceSchema>;
export function scaRawEvidenceContract(): HostOperationArtifactContractV1 {
  return {
    schema_version: 1,
    port_name: "raw_evidence",
    artifact_kind: "sca-private-raw-evidence",
    schema_id: "penny.sca-private-raw-evidence.v1",
    schema_version_required: 1,
  };
}
export function validateScaRawEvidence(value: unknown): ScaRawEvidence {
  const raw = validateContract(ScaRawEvidenceSchema, value, "SCA private raw evidence");
  let total = 0;
  for (const record of raw.records) {
    const bytes = Buffer.from(record.content_base64, "base64");
    total += bytes.length;
    if (
      bytes.length !== record.byte_length ||
      bytes.toString("base64") !== record.content_base64 ||
      sha256(bytes) !== record.content_sha256 ||
      total > SCA_RAW_TOTAL_BYTES
    )
      throw new Error("SCA private raw evidence exact binding/aggregate limit failed");
  }
  return raw;
}
const lease = {
  profile_id: "sca-ordinary-operation-lease-v1",
  profile_version: 1 as const,
  duration_ms: 60_000,
  renew_after_ms: 10_000,
  queue_inactivity_ms: 300_000,
};
export function scaHostDeclaration(stage: ScaHostStage): HostOperationDeclarationV1 {
  return {
    schema_version: 1,
    operation_kind: `sca.${stage}.v1`,
    adapter_id: SCA_HOST_ADAPTER_ID,
    request: scaHostContract(stage, "request"),
    result: scaHostContract(stage, "result"),
    backend_binding_id: "sca-ordinary-local-analysis-v1",
    capability_classes: ["artifact_store"],
    lease_profile: { ...lease, profile_sha256: hostOperationLeaseProfileSha256(lease) },
    operation_inactivity_ms: 300_000,
    max_request_bytes: 131_072,
    max_input_artifacts: 8,
    max_input_bytes: 256 * 1024 * 1024,
    output_contracts: [
      ...(stage === "preparation"
        ? [scaGraphContract("php"), scaGraphContract("javascript_typescript")]
        : []),
      scaRawEvidenceContract(),
    ],
    max_output_artifacts: 4,
    // Two base64 CPGs plus the bounded base64 raw bundle and the typed result.
    max_output_bytes: 256 * 1024 * 1024,
    max_progress_events: 65_536,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "disposable_v1",
    cancellation_semantics: "local_abort_only_v1",
  };
}
export interface ScaRuntimeControl {
  readonly signal: AbortSignal;
  activity(): void;
}
export interface ScaOrdinaryRuntime {
  prepare(input: {
    request: ScaHostRequest;
    corpus: Buffer;
    control: ScaRuntimeControl;
  }): Promise<{ preparation: ScaPreparation; graphs: readonly ScaGraphData[] }>;
  gather(input: {
    request: ScaHostRequest;
    corpus: Buffer;
    actions: ScaActions;
    graphs: readonly ScaGraphData[];
    control: ScaRuntimeControl;
  }): Promise<ScaEvidence>;
}
function isRuntime(value: unknown): value is ScaOrdinaryRuntime {
  return (
    value !== null &&
    typeof value === "object" &&
    "prepare" in value &&
    typeof value.prepare === "function" &&
    "gather" in value &&
    typeof value.gather === "function"
  );
}
interface InstalledRuntimeOptions {
  recordProcess(observation: unknown): Promise<void>;
  recordDeterministic(observation: { kind: "dependencies" | "advisories" }): Promise<void>;
}
function isRuntimeFactory(value: unknown): value is {
  createOrdinaryScaRuntime(options: InstalledRuntimeOptions): unknown;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    "createOrdinaryScaRuntime" in value &&
    typeof value.createOrdinaryScaRuntime === "function"
  );
}
async function installedRuntime(
  options: InstalledRuntimeOptions
): Promise<ScaOrdinaryRuntime | undefined> {
  // Fixed sibling-package build entry, independent of workspace install/link hoisting.
  // src/sca and dist/sca have the same depth. Never accept a caller-selected module.
  const moduleUrl = new URL("../../../sca-service/dist/ordinary-runtime.js", import.meta.url).href;
  try {
    const module: unknown = await import(moduleUrl);
    if (isRuntimeFactory(module)) {
      const runtime = module.createOrdinaryScaRuntime(options);
      if (isRuntime(runtime)) return runtime;
    }
  } catch {
    /* Missing/broken installed capability is reported, not a safe scan. */
  }
  return undefined;
}
export function unavailablePreparation(corpusBytes: Buffer, detail: string): ScaPreparation {
  const corpus = parseSealedScaSourceCorpusV1(corpusBytes);
  return validateContract(
    ScaPreparationSchema,
    {
      schema_version: 1,
      source_snapshot_sha256: corpus.source_snapshot_sha256,
      files: [...corpus.files.values()].map((file) => {
        const parser = scaStructuralParserCapability(file.path);
        return {
          path: file.path,
          content_sha256: file.content_sha256,
          lines: file.text.split(/\r?\n/u).length,
          language:
            parser.status !== "available"
              ? "context"
              : parser.language === "php"
                ? "php"
                : "javascript_typescript",
        };
      }),
      capabilities: [
        "semgrep",
        "gitleaks",
        "dependencies",
        "advisories",
        "graph_php",
        "graph_javascript_typescript",
      ].map((id) => ({
        id,
        status: "unavailable",
        detail,
        version: null,
        configuration_sha256: null,
        evidence_sha256: null,
      })),
      leads: [],
      gaps: [
        detail,
        ...[...corpus.excluded_paths].map((path) => `Non-text source excluded: ${path}`),
      ],
    },
    "SCA unavailable preparation"
  );
}
function exactInput(context: HostOperationExecutionContextV1, slot: string): Buffer {
  const input = context.readInput(slot);
  const bytes = Buffer.from(input.bytes);
  if (sha256(bytes) !== input.ref.content_digest || bytes.length !== input.ref.byte_length)
    throw new Error("SCA runtime input digest drift");
  return bytes;
}
function json(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString("utf8"));
}
export async function sourceOnlyEvidence(input: {
  corpus: Buffer;
  actions: ScaActions;
}): Promise<ScaEvidence> {
  const corpus = parseSealedScaSourceCorpusV1(input.corpus);
  return validateContract(
    ScaEvidenceSchema,
    {
      schema_version: 1,
      results: input.actions.actions.map((action) => {
        const captured =
          action.kind === "source" ? action.ranges.map((range) => resolveRange(corpus, range)) : [];
        const withheld = captured.some((pointer) => scaP11HasSensitiveContent(pointer.exact_quote));
        const pointers = withheld ? [] : captured;
        const status =
          action.kind === "source" && pointers.length > 0
            ? "completed"
            : action.kind === "defer"
              ? "deferred"
              : "unavailable";
        const detail = withheld
          ? "Sensitive source material withheld before model disclosure; exact quotation unavailable, evidence INCOMPLETE."
          : status === "completed"
            ? "Exact immutable source slices; no target execution."
            : action.kind === "application_test"
              ? "NOT RUN: no separately admitted bounded broker execution plan/policy supplied; host execution forbidden."
              : `Evidence action ${action.kind} ${status}.`;
        return {
          action_id: action.id,
          hypothesis_id: action.hypothesis_id,
          status,
          detail,
          pointers,
          observation: "",
          evidence_sha256: sha256(canonicalJson(pointers)),
          execution: "NOT RUN",
          receipt_refs: [],
        };
      }),
      gaps: [],
    },
    "SCA evidence"
  );
}
async function finishOperation(
  context: HostOperationExecutionContextV1,
  request: ScaHostRequest,
  result: ScaPreparation | ScaEvidence,
  graphs: readonly ScaGraphData[],
  raw: ScaRawEvidence,
  cached?: HostOperationCachedResultV1
) {
  context.signal.throwIfAborted();
  for (const graph of graphs) {
    if (
      graph.source_snapshot_sha256 !== request.source_snapshot_sha256 ||
      sha256(Buffer.from(graph.bytes_base64, "base64")) !== graph.graph_sha256
    )
      throw new Error("SCA semantic graph exact binding mismatch");
  }
  validateScaRawEvidence(raw);
  const captured =
    cached ?? (await context.cacheResult(Buffer.from(canonicalJson({ result, graphs, raw }))));
  if (context.journal.lifecycle !== "persisting")
    context.recordFetched({
      schema_version: 1,
      content_sha256: captured.content_sha256,
      byte_length: captured.byte_length,
      item_count: 2 + graphs.length,
      poll_count: 0,
    });
  const disposition = {
    outcome: "completed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: null,
  } as const;
  const persisted = context.persist({
    disposition,
    operation_result: {
      contract: context.declaration.result,
      media_type: "application/json",
      content: canonicalJson(result),
    },
    outputs: [
      ...graphs.map((graph) => ({
        contract: scaGraphContract(graph.language),
        media_type: "application/json",
        content: canonicalJson(graph),
      })),
      {
        contract: scaRawEvidenceContract(),
        media_type: "application/json",
        content: canonicalJson(raw),
      },
    ],
  });
  return { disposition, ...persisted };
}
export function createScaOrdinaryHostAdapters(
  runtime?: ScaOrdinaryRuntime
): ReadonlyMap<string, HostOperationAdapterV1> {
  const adapter: HostOperationAdapterV1 = {
    adapter_id: SCA_HOST_ADAPTER_ID,
    inspectRequest(input) {
      const request = validateContract(
        ScaHostRequestSchema,
        json(Buffer.from(input.request_bytes)),
        "SCA host request"
      );
      if (input.directive.operation_kind !== `sca.${request.stage}.v1`)
        throw new Error("SCA host stage substitution");
      return {
        schema_version: 1,
        operation_kind: input.directive.operation_kind,
        adapter_id: SCA_HOST_ADAPTER_ID,
        backend_binding_id: input.declaration.backend_binding_id,
        backend_key_sha256: sha256("penny:sca:ordinary-local-analysis:v1"),
      };
    },
    async run(context) {
      const request = validateContract(
        ScaHostRequestSchema,
        json(Buffer.from(context.request_bytes)),
        "SCA host request"
      );
      if (
        request.run_id !== context.directive.identity.run_id ||
        canonicalJson(request.input_bindings) !==
          canonicalJson(
            context.directive.input_artifacts.artifacts.map((entry) => ({
              slot: entry.slot,
              content_digest: entry.ref.content_digest,
            }))
          )
      )
        throw new Error("SCA request exact input/run binding mismatch");
      const corpus = exactInput(context, "corpus");
      if (
        parseSealedScaSourceCorpusV1(corpus).source_snapshot_sha256 !==
        request.source_snapshot_sha256
      )
        throw new Error("SCA host source snapshot substitution");
      const cached = await context.readCachedResult();
      if (cached !== null) {
        const bundle = validateContract(
          Type.Object(
            {
              result: request.stage === "preparation" ? ScaPreparationSchema : ScaEvidenceSchema,
              graphs: Type.Array(ScaGraphDataSchema, { maxItems: 2 }),
              raw: ScaRawEvidenceSchema,
            },
            { additionalProperties: false }
          ),
          json(Buffer.from(cached.bytes)),
          "SCA exact cached operation"
        );
        if (context.journal.lifecycle === "lease_acquired") {
          context.beginSubmission();
          context.recordRemoteAccepted(`local-sca:${context.directive.request_sha256}`);
        }
        return finishOperation(
          context,
          request,
          bundle.result,
          bundle.graphs,
          validateScaRawEvidence(bundle.raw),
          cached
        );
      }
      if (context.journal.lifecycle !== "lease_acquired") {
        // A crashed local process is not proof of completion or permission to silently replay.
        return {
          disposition: {
            outcome: "remote_unknown",
            remote_disposition: "may_continue",
            lease_disposition: "quarantined",
            retryable: false,
            reason_code: "local_analysis_restart_without_exact_cache",
          },
          operation_result_ref: null,
          output_artifacts: [],
        };
      }
      context.beginSubmission();
      context.recordRemoteAccepted(`local-sca:${context.directive.request_sha256}`);
      const control: ScaRuntimeControl = {
        signal: context.signal,
        activity: () => context.reportActivity("analysis_progress", 1),
      };
      const raw: ScaRawEvidence = { schema_version: 1, records: [] };
      let rawBytes = 0;
      let captureFailure: Error | undefined;
      const capture = async (kind: ScaRawEvidence["records"][number]["kind"], value: unknown) => {
        try {
          const bytes = Buffer.from(canonicalJson(value));
          if (
            bytes.length > SCA_RAW_RECORD_BYTES ||
            rawBytes + bytes.length > SCA_RAW_TOTAL_BYTES ||
            raw.records.length >= SCA_RAW_RECORD_COUNT
          )
            throw new Error("SCA private raw evidence retention limit exceeded");
          raw.records.push({
            kind,
            byte_length: bytes.length,
            content_sha256: sha256(bytes),
            content_base64: bytes.toString("base64"),
          });
          rawBytes += bytes.length;
        } catch (error) {
          captureFailure = new Error("SCA private raw evidence retention failed", { cause: error });
          throw captureFailure;
        }
      };
      const active =
        runtime ??
        (await installedRuntime({
          recordProcess: (observation) => capture("process", observation),
          recordDeterministic: (observation) => capture(observation.kind, observation),
        }));
      let result: ScaPreparation | ScaEvidence;
      let graphs: readonly ScaGraphData[] = [];
      if (request.stage === "preparation") {
        if (active === undefined)
          result = unavailablePreparation(
            corpus,
            "Installed scanner/dependency/semantic graph adapter unavailable; no successful scan is claimed."
          );
        else {
          try {
            const prepared = await active.prepare({ request, corpus, control });
            result = validateContract(
              ScaPreparationSchema,
              prepared.preparation,
              "SCA preparation"
            );
            graphs = prepared.graphs.map((graph) =>
              validateContract(ScaGraphDataSchema, graph, "SCA graph")
            );
          } catch (error) {
            if (context.signal.aborted) throw error;
            result = unavailablePreparation(
              corpus,
              "Scanner/graph preparation failed; configured capabilities are not clean results."
            );
          }
        }
        if (result.source_snapshot_sha256 !== request.source_snapshot_sha256)
          throw new Error("SCA runtime preparation snapshot drift");
        if (result.capabilities.length === 0)
          throw new Error("Empty scanner capability list is not success");
      } else {
        const actions = validateContract(
          ScaActionsSchema,
          json(exactInput(context, "actions")),
          "SCA actions"
        );
        const graphInputs = context.directive.input_artifacts.artifacts.filter((binding) =>
          binding.slot.startsWith("graph-")
        );
        const suppliedGraphs = graphInputs.map((binding) =>
          validateContract(ScaGraphDataSchema, json(exactInput(context, binding.slot)), "SCA graph")
        );
        try {
          result =
            active === undefined
              ? await sourceOnlyEvidence({ corpus, actions })
              : validateContract(
                  ScaEvidenceSchema,
                  await active.gather({
                    request,
                    corpus,
                    actions,
                    graphs: suppliedGraphs,
                    control,
                  }),
                  "SCA gathered evidence"
                );
        } catch (error) {
          if (context.signal.aborted) throw error;
          result = await sourceOnlyEvidence({ corpus, actions });
          result.gaps.push(
            "Configured evidence adapter failed; only exact source observations retained."
          );
        }
      }
      // Runtime fallback must never turn an evidence-sink failure into a successful operation.
      if (captureFailure !== undefined) throw captureFailure;
      if (
        runtime === undefined &&
        active !== undefined &&
        request.stage === "preparation" &&
        !raw.records.some((record) => record.kind === "dependencies")
      )
        throw new Error("Installed SCA runtime omitted private deterministic evidence");
      control.activity();
      return finishOperation(context, request, result, graphs, raw);
    },
  };
  return new Map([[adapter.adapter_id, adapter]]);
}

/** Lazy project-scoped host cache; provisioning is not a prerequisite or caller handshake. */
export function createScaOrdinaryResultCache(
  projectDatabasePath: string
): HostOperationResultCacheV1 {
  let cache: Promise<FileHostOperationResultCache> | undefined;
  const owner = () =>
    (cache ??= (async () => {
      const root = path.join(path.dirname(projectDatabasePath), "sca-host-result-cache");
      try {
        await mkdir(root, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error) || Reflect.get(error, "code") !== "EEXIST") throw error;
      }
      // Existing paths are verified, never chmod-repaired by ordinary execution.
      return FileHostOperationResultCache.openExisting(root);
    })());
  return {
    async read(key) {
      return (await owner()).read(key);
    },
    async write(key, bytes) {
      return (await owner()).write(key, bytes);
    },
  };
}
