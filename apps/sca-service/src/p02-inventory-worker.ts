// Dedicated P02 native-parser entry. Only the fixed staged request and output paths exist.
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { Type } from "typebox";
import { validateContract } from "../../orchestration/dist/contracts.js";
import {
  ScaTreeSitterIndexInputV2Schema,
  buildScaTreeSitterIndexV2,
  inspectInstalledTreeSitterIdentitiesV2,
} from "./adapters/tree-sitter-index.js";

const inputPath = "/input/rule";
const outputPath = "/p02/control/inventory.json";
const indexerPath = "/p02/indexer-source";
const MAX_INPUT = 90_000_000;
const MAX_OUTPUT = 60_000;

export async function runP02InventoryWorker(): Promise<void> {
  if (process.argv.length !== 3 || !/^p02-[a-f0-9]{32}\.service$/.test(process.argv[2] ?? ""))
    throw Error("inventory_invocation");
  const bytes = await readFile(inputPath);
  if (bytes.length > MAX_INPUT) throw Error("inventory_input_limit");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (canonicalJson(value) + "\n" !== bytes.toString("utf8"))
    throw Error("inventory_input_canonical");
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw Error("inventory_input");
  const envelope = validateContract(
    Type.Record(Type.String(), Type.Unknown()),
    value,
    "P02 inventory envelope"
  );
  if (
    Object.keys(envelope).sort().join("|") !==
    ["input", "operation_request_sha256", "source_manifest_sha256", "source_tree_sha256"]
      .sort()
      .join("|")
  )
    throw Error("inventory_envelope");
  for (const key of ["operation_request_sha256", "source_manifest_sha256", "source_tree_sha256"])
    if (typeof envelope[key] !== "string" || !/^[a-f0-9]{64}$/.test(envelope[key]))
      throw Error("inventory_binding");
  const input = validateContract(
    ScaTreeSitterIndexInputV2Schema,
    envelope.input,
    "inventory input"
  );
  if (
    canonicalJson(input.tool) !== canonicalJson(inspectInstalledTreeSitterIdentitiesV2(indexerPath))
  )
    throw Error("inventory_identity");
  const result = buildScaTreeSitterIndexV2(input, indexerPath);
  const output =
    canonicalJson({
      version: 1,
      input_sha256: sha256(bytes),
      operation_request_sha256: envelope.operation_request_sha256,
      source_manifest_sha256: envelope.source_manifest_sha256,
      source_tree_sha256: envelope.source_tree_sha256,
      result,
    }) + "\n";
  if (Buffer.byteLength(output) > MAX_OUTPUT) throw Error("inventory_output_limit");
  await writeFile(outputPath, output, { flag: "wx", mode: 0o600 });
}
