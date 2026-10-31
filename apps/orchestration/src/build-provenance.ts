/** Shipping identity, not a signed supply-chain attestation. Source-only tests do not use dist. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const RelativePath = Type.String({
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[A-Za-z0-9_.@/-]+$",
});
const FileDigests = Type.Record(RelativePath, Digest);
export const ShippingBuildProvenanceSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    inputs: FileDigests,
    outputs: FileDigests,
    source_files: Type.Array(RelativePath),
    helper_inputs: Type.Array(RelativePath),
    tools: Type.Object(
      { node: Type.String(), bun: Type.String(), typescript: Type.String() },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type ShippingBuildProvenance = Static<typeof ShippingBuildProvenanceSchema>;
export interface ShippingBuildIdentity {
  readonly generation: string;
  readonly provenance: ShippingBuildProvenance;
}

function refuse(): never {
  throw new Error(
    "ORCHESTRATION_BUILD_STALE: missing, changed or mixed shipping generation; " +
      "run bun run build:orchestration, then start a fresh Pi/service process"
  );
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function regularBytes(file: string): Buffer {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse();
  return readFileSync(file);
}
function filesUnder(directory: string, prefix = ""): string[] {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) refuse();
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const name = prefix + entry.name;
      return entry.isDirectory()
        ? filesUnder(path.join(directory, entry.name), name + "/")
        : [name];
    })
    .sort();
}

let loadedGeneration: string | undefined;
/** Rechecks bytes, including the bundled worker and matching declarations, without opening state. */
export function assertCurrentShippingBuild(): ShippingBuildIdentity | undefined {
  const moduleFile = fileURLToPath(import.meta.url);
  // Internal source modules remain normal source modules in deliberately source-only tests.
  if (moduleFile.endsWith(".ts")) return undefined;
  const outputRoot = path.dirname(moduleFile);
  const workspace = path.resolve(outputRoot, "../../..");
  try {
    const bytes = regularBytes(path.join(outputRoot, "build-provenance.json"));
    const generation = digest(bytes);
    if (loadedGeneration !== undefined && generation !== loadedGeneration) refuse();
    const candidate: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Value.Check(ShippingBuildProvenanceSchema, candidate)) refuse();
    const provenance = candidate;
    const sourceFiles = filesUnder(path.join(workspace, "apps/orchestration/src"));
    if (JSON.stringify(sourceFiles) !== JSON.stringify(provenance.source_files)) refuse();
    const outputFiles = filesUnder(outputRoot).filter((file) => file !== "build-provenance.json");
    if (JSON.stringify(outputFiles) !== JSON.stringify(Object.keys(provenance.outputs).sort()))
      refuse();
    if (
      provenance.inputs["apps/orchestration/src/build-provenance.ts"] === undefined ||
      provenance.outputs["artifact-worker.js"] === undefined ||
      provenance.outputs["index.d.ts"] === undefined ||
      provenance.helper_inputs.length === 0 ||
      provenance.helper_inputs.some((file) => provenance.inputs[file] === undefined)
    )
      refuse();
    for (const [file, expected] of Object.entries(provenance.inputs)) {
      if (digest(regularBytes(path.join(workspace, file))) !== expected) refuse();
    }
    for (const [file, expected] of Object.entries(provenance.outputs)) {
      if (digest(regularBytes(path.join(outputRoot, file))) !== expected) refuse();
    }
    loadedGeneration = generation;
    return { generation, provenance };
  } catch {
    refuse();
  }
}
