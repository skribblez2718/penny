import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import {
  SCA_P02_OPERATION_IDS,
  validateScaP02OperationRequestV1,
  type ScaP02InventoryRequestV1,
} from "../../orchestration/dist/sca/p02-contracts.js";
import {
  ScaTreeSitterIndexInputV2Schema,
  ScaTreeSitterToolIdentityV2Schema,
  inspectInstalledTreeSitterIdentitiesV2,
  validateScaTreeSitterIndexResultV2,
  type ScaTreeSitterIndexInputV2,
  type ScaTreeSitterIndexResultV2,
  type ScaTreeSitterToolIdentityV2,
} from "./adapters/tree-sitter-index.js";
import {
  P02_HOST_REQUEST_SCHEMA,
  runP02HostCanary,
  validateHostPaths,
  verifyP02HostProfileV1,
  type P02HostReceipt,
  type P02HostRequest,
} from "./p02-host-harness.js";
import { deriveP02HostSourceManifestV1 } from "./p02-host-process-runner.js";
import { exactPath, verifyTree } from "./p02-host-tree.js";
import { validateScaSourceCustodyMaterializationInputV1 } from "./source-custody-materializer.js";
import { buildScaP02TreeSitterInputV2 } from "./p02-component-inputs.js";

export type P02InventoryContainmentEvidenceV1 = Readonly<{
  schema_version: 1;
  receipt: P02HostReceipt;
  result_sha256: string;
  cleanup_verified: true;
}>;

const issued = new WeakMap<
  object,
  Readonly<{
    staging_parent: string;
    profile_sha256: string;
    deployment_sha256: string;
    identity_sha256: string;
    source_manifest_sha256: string;
    custody_sha256: string;
  }>
>();

const completedEvidence = new WeakMap<object, P02InventoryContainmentEvidenceV1[]>();

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Completed entries only. A returned entry implies the host run and private workspace cleanup succeeded. */
export function readP02InventoryContainmentEvidenceV1(
  runner: unknown
): readonly P02InventoryContainmentEvidenceV1[] {
  if (typeof runner !== "object" || runner === null || !issued.has(runner))
    throw Error("p02_inventory_runner_not_issued");
  return Object.freeze([...(completedEvidence.get(runner) ?? [])]);
}

export interface P02ControlledInventoryRunnerV1 {
  readonly qualification: "controlled_p02_inventory_only";
  readonly profile_sha256: string;
  readonly deployment_sha256: string;
  run(
    input: Readonly<{
      request: ScaP02InventoryRequestV1;
      source_root: string;
      tree_input: ScaTreeSitterIndexInputV2;
    }>,
    signal?: AbortSignal
  ): Promise<ScaTreeSitterIndexResultV2>;
}

export function matchesP02ControlledInventoryRunnerV1(
  value: unknown,
  request: ScaP02InventoryRequestV1,
  manifestSha: string,
  custodySha: string
): value is P02ControlledInventoryRunnerV1 {
  if (typeof value !== "object" || value === null) return false;
  const binding = issued.get(value);
  return (
    binding !== undefined &&
    request.operation_kind === "inventory" &&
    request.operation_id === SCA_P02_OPERATION_IDS.inventory &&
    binding.staging_parent === request.staging_parent &&
    binding.profile_sha256 === request.isolation_profile_sha256 &&
    binding.deployment_sha256 === request.isolation_deployment_sha256 &&
    binding.identity_sha256 === request.tree_sitter_identity_sha256 &&
    binding.source_manifest_sha256 === manifestSha &&
    binding.custody_sha256 === custodySha
  );
}

export type P02InventoryRunnerFactoryConfigV1 = Omit<
  P02HostRequest,
  "kind" | "source" | "source_generation" | "rule" | "tool_runtime"
> &
  Readonly<{
    staging_parent: string;
    source_material: unknown;
    tree_sitter_identity: ScaTreeSitterToolIdentityV2;
    tool_runtime: Extract<P02HostRequest["tool_runtime"], { kind: "inventory" }>;
  }>;

/** The caller supplies custody and every runtime root. No package is installed or discovered here. */
export function createP02ControlledInventoryRunnerV1(
  value: P02InventoryRunnerFactoryConfigV1
): P02ControlledInventoryRunnerV1 {
  const config = validateContract(
    Type.Object(
      {
        ...Type.Omit(P02_HOST_REQUEST_SCHEMA, [
          "kind",
          "source",
          "source_generation",
          "rule",
          "tool_runtime",
        ]).properties,
        staging_parent: Type.String(),
        source_material: Type.Unknown(),
        tree_sitter_identity: ScaTreeSitterToolIdentityV2Schema,
        tool_runtime: Type.Extract(
          P02_HOST_REQUEST_SCHEMA.properties.tool_runtime,
          Type.Object({ kind: Type.Literal("inventory") })
        ),
      },
      { additionalProperties: false }
    ),
    JSON.parse(canonicalJson(value)),
    "P02 inventory factory configuration"
  );
  const expectedKeys = [
    "staging_parent",
    "source_material",
    "tree_sitter_identity",
    "tool_runtime",
    "runtime",
    "closure",
    "deployment",
    "controls",
    "profile_sha256",
    "workspace_parent",
    "protected_roots",
    "limits",
  ].sort();
  if (canonicalJson(Object.keys(config).sort()) !== canonicalJson(expectedKeys))
    throw Error("p02_inventory_factory_configuration");
  const { staging_parent, source_material, tree_sitter_identity, ...base } = config;
  const custody = validateScaSourceCustodyMaterializationInputV1(source_material);
  const { source_generation, ...source } = deriveP02HostSourceManifestV1(custody);
  const identity = validateContract(
    ScaTreeSitterToolIdentityV2Schema,
    tree_sitter_identity,
    "P02 inventory identity"
  );
  if (canonicalJson(identity) !== canonicalJson(inspectInstalledTreeSitterIdentitiesV2()))
    throw Error("p02_inventory_tool_identity");
  if (
    !exactPath(staging_parent) ||
    staging_parent === "/" ||
    !/^[a-f0-9]{64}$/.test(tree_sitter_identity.indexer_sha256)
  )
    throw Error("p02_inventory_factory_configuration");
  if (base.tool_runtime.indexer_source.sha256 !== tree_sitter_identity.implementation_sha256)
    throw Error("p02_inventory_indexer_identity");
  const identitySha = sha256(canonicalJson(tree_sitter_identity));
  const sample: P02HostRequest = validateContract(
    P02_HOST_REQUEST_SCHEMA,
    {
      ...base,
      kind: "inventory",
      source: { ...source, root: path.join(staging_parent, "inventory-source-" + "a".repeat(16)) },
      source_generation,
      rule: {
        path: path.join(staging_parent, "inventory-aux-" + "a".repeat(16), "input.json"),
        sha256: "a".repeat(64),
      },
    },
    "P02 inventory factory plan"
  );
  validateHostPaths(sample);
  const runner: P02ControlledInventoryRunnerV1 = Object.freeze({
    qualification: "controlled_p02_inventory_only" as const,
    profile_sha256: base.profile_sha256,
    deployment_sha256: base.deployment.sha256,
    async run(
      { request, source_root, tree_input }: Parameters<P02ControlledInventoryRunnerV1["run"]>[0],
      signal?: AbortSignal
    ) {
      const validatedRequest = validateScaP02OperationRequestV1("inventory", request);
      if (canonicalJson(validatedRequest) !== canonicalJson(request))
        throw Error("p02_inventory_request_drift");
      if (
        !matchesP02ControlledInventoryRunnerV1(
          runner,
          request,
          source_generation.file_manifest_sha256,
          source_generation.custody_sha256
        )
      )
        throw Error("p02_inventory_binding");
      const expectedRoot = path.join(
        staging_parent,
        `${request.operation_id}-${request.request_sha256.slice(0, 16)}`
      );
      if (!exactPath(source_root) || source_root !== expectedRoot || signal?.aborted)
        throw Error("p02_inventory_source_root");
      const input = validateContract(
        ScaTreeSitterIndexInputV2Schema,
        tree_input,
        "P02 inventory input"
      );
      if (
        sha256(canonicalJson(input.tool)) !== identitySha ||
        input.source_snapshot_sha256 !== request.source_snapshot_sha256 ||
        canonicalJson(input.limits) !==
          canonicalJson({
            max_files: request.tree_sitter.max_files,
            max_source_bytes_per_file: request.tree_sitter.max_file_bytes,
            max_total_source_bytes: request.tree_sitter.max_total_bytes,
            max_nodes_per_file: request.tree_sitter.max_nodes_per_file,
            max_depth: request.tree_sitter.max_depth,
            max_diagnostics_per_file: request.tree_sitter.max_diagnostics_per_file,
            max_symbols_per_file: request.tree_sitter.max_symbols_per_file,
            parse_timeout_micros: request.tree_sitter.parse_timeout_micros,
            query_match_limit: request.tree_sitter.query_match_limit,
          })
      )
        throw Error("p02_inventory_input_drift");
      if (
        canonicalJson(input) !==
        canonicalJson(buildScaP02TreeSitterInputV2(request, custody.custody))
      )
        throw Error("p02_inventory_source_drift");
      const parent = await lstat(staging_parent);
      if (
        !parent.isDirectory() ||
        parent.uid !== process.getuid?.() ||
        (parent.mode & 0o777) !== 0o700 ||
        (await realpath(staging_parent)) !== staging_parent
      )
        throw Error("p02_inventory_staging_parent");
      const tree = { ...source, root: source_root };
      await verifyTree(tree, source_generation);
      const aux = await mkdtemp(path.join(staging_parent, "inventory-aux-"));
      let completed: { result: ScaTreeSitterIndexResultV2; receipt: P02HostReceipt } | null = null;
      try {
        const rulePath = path.join(aux, "input.json");
        const envelope = {
          input,
          operation_request_sha256: request.request_sha256,
          source_manifest_sha256: source_generation.file_manifest_sha256,
          source_tree_sha256: custody.file_manifest.tree_sha256,
        };
        const bytes = canonicalJson(envelope) + "\n";
        if (Buffer.byteLength(bytes) > 90_000_000) throw Error("p02_inventory_input_limit");
        await writeFile(rulePath, bytes, { flag: "wx", mode: 0o400 });
        const fd = await open(rulePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (sha256(await fd.readFile()) !== sha256(bytes))
            throw Error("p02_inventory_input_drift");
        } finally {
          await fd.close();
        }
        const plan = validateContract(
          P02_HOST_REQUEST_SCHEMA,
          {
            ...base,
            kind: "inventory",
            source: tree,
            source_generation,
            rule: { path: rulePath, sha256: sha256(bytes) },
          },
          "P02 inventory plan"
        );
        validateHostPaths(plan);
        await verifyP02HostProfileV1(plan);
        const outcome = await runP02HostCanary(plan, signal);
        if (
          outcome.status !== "passed" ||
          outcome.receipt?.plan_sha256 !== sha256(canonicalJson(plan))
        )
          throw Error(`p02_inventory_${outcome.status}`);
        const resultEnvelope = outcome.inventory_result;
        if (
          typeof resultEnvelope !== "object" ||
          resultEnvelope === null ||
          Array.isArray(resultEnvelope)
        )
          throw Error("p02_inventory_result");
        const received = validateContract(
          Type.Record(Type.String(), Type.Unknown()),
          resultEnvelope,
          "P02 inventory result envelope"
        );
        if (
          Object.keys(received).sort().join("|") !==
            [
              "version",
              "input_sha256",
              "operation_request_sha256",
              "source_manifest_sha256",
              "source_tree_sha256",
              "result",
            ]
              .sort()
              .join("|") ||
          received.version !== 1 ||
          received.input_sha256 !== sha256(bytes) ||
          received.operation_request_sha256 !== request.request_sha256 ||
          received.source_manifest_sha256 !== source_generation.file_manifest_sha256 ||
          received.source_tree_sha256 !== envelope.source_tree_sha256
        )
          throw Error("p02_inventory_result_binding");
        const result = validateScaTreeSitterIndexResultV2(received.result, input, {
          deterministic_rebuild: false,
        });
        const receipt = outcome.receipt;
        if (receipt === null) throw Error("p02_inventory_receipt");
        completed = { result, receipt };
      } finally {
        await rm(aux, { recursive: true, force: true });
      }
      if (completed === null) throw Error("p02_inventory_result");
      const entry = deepFreeze({
        schema_version: 1 as const,
        receipt: completed.receipt,
        result_sha256: sha256(canonicalJson(completed.result)),
        cleanup_verified: true as const,
      });
      completedEvidence.get(runner)?.push(entry);
      return completed.result;
    },
  });
  completedEvidence.set(runner, []);
  issued.set(
    runner,
    Object.freeze({
      staging_parent,
      profile_sha256: base.profile_sha256,
      deployment_sha256: base.deployment.sha256,
      identity_sha256: identitySha,
      source_manifest_sha256: source_generation.file_manifest_sha256,
      custody_sha256: source_generation.custody_sha256,
    })
  );
  return runner;
}
