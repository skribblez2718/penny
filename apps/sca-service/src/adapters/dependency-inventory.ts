import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../../orchestration/src/canonical-json.js";
import { validateContract } from "../../../orchestration/src/contracts.js";
import { Sha256Schema } from "../../../orchestration/src/skill-contracts/common.js";

const MAX_MANIFESTS = 32;
const MAX_CONTENT_BYTES = 16_777_216;
const MAX_COORDINATES = 100_000;
const MAX_TEXT = 4_096;
const MAX_DEPENDENCY_DEPTH = 32;

export const SCA_DEPENDENCY_INVENTORY_INPUT_SCHEMA = "penny.sca-dependency-inventory-input.v1";
export const SCA_DEPENDENCY_INVENTORY_RESULT_SCHEMA = "penny.sca-dependency-inventory-result.v1";

const ScaDependencyManifestV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    sha256: Sha256Schema,
    content: Type.String({ minLength: 1, maxLength: MAX_CONTENT_BYTES }),
  },
  { additionalProperties: false }
);

export const ScaDependencyInventoryInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_DEPENDENCY_INVENTORY_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    manifests: Type.Array(ScaDependencyManifestV1Schema, {
      minItems: 1,
      maxItems: MAX_MANIFESTS,
    }),
  },
  { additionalProperties: false }
);

const ScaDependencyCoordinateV1Schema = Type.Object(
  {
    ecosystem: Type.Union([Type.Literal("npm"), Type.Literal("Packagist")]),
    name: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    version: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    scope: Type.Union([
      Type.Literal("runtime"),
      Type.Literal("development"),
      Type.Literal("unknown"),
    ]),
    manifest_path: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    manifest_sha256: Sha256Schema,
    purl: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);

const ScaDependencyManifestResultV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    sha256: Sha256Schema,
    format: Type.Union([
      Type.Literal("npm-package-lock"),
      Type.Literal("composer-lock"),
      Type.Literal("unsupported"),
      Type.Literal("invalid"),
    ]),
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("unsupported"),
      Type.Literal("failed"),
    ]),
    coordinate_count: Type.Integer({ minimum: 0, maximum: MAX_COORDINATES }),
    error_code: Type.Union([
      Type.Literal("none"),
      Type.Literal("unsupported_manifest"),
      Type.Literal("invalid_json"),
      Type.Literal("invalid_lockfile"),
      Type.Literal("quota_exceeded"),
    ]),
  },
  { additionalProperties: false }
);

export const ScaDependencyInventoryResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_DEPENDENCY_INVENTORY_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("partial"),
      Type.Literal("unsupported"),
      Type.Literal("failed"),
    ]),
    manifests: Type.Array(ScaDependencyManifestResultV1Schema, {
      minItems: 1,
      maxItems: MAX_MANIFESTS,
    }),
    coordinates: Type.Array(ScaDependencyCoordinateV1Schema, { maxItems: MAX_COORDINATES }),
    inventory_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaDependencyInventoryInputV1 = Static<typeof ScaDependencyInventoryInputV1Schema>;
export type ScaDependencyCoordinateV1 = Static<typeof ScaDependencyCoordinateV1Schema>;
export type ScaDependencyInventoryResultV1 = Static<typeof ScaDependencyInventoryResultV1Schema>;

type Manifest = ScaDependencyInventoryInputV1["manifests"][number];
type ManifestResult = ScaDependencyInventoryResultV1["manifests"][number];
type UnsignedResult = Omit<ScaDependencyInventoryResultV1, "inventory_sha256">;

export class ScaDependencyInventoryError extends Error {
  constructor(
    readonly code: "invalid_input" | "unsafe_path" | "path_collision" | "digest_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaDependencyInventoryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validatePath(candidate: string): void {
  const segments = candidate.split("/");
  if (
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/u.test(candidate) ||
    candidate !== candidate.normalize("NFC") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ScaDependencyInventoryError("unsafe_path", "manifest path is not canonical");
  }
}

function encodePurlName(name: string): string {
  return name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function coordinate(
  ecosystem: "npm" | "Packagist",
  name: string,
  version: string,
  scope: ScaDependencyCoordinateV1["scope"],
  manifest: Manifest
): ScaDependencyCoordinateV1 {
  const packageType = ecosystem === "npm" ? "npm" : "composer";
  return {
    ecosystem,
    name,
    version,
    scope,
    manifest_path: manifest.path,
    manifest_sha256: manifest.sha256,
    purl: `pkg:${packageType}/${encodePurlName(name)}@${encodeURIComponent(version)}`,
  };
}

function npmNameFromPackagePath(packagePath: string): string | null {
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  if (index < 0) return null;
  const suffix = packagePath.slice(index + marker.length);
  if (suffix.length === 0) return null;
  const segments = suffix.split("/");
  if (segments[0]?.startsWith("@")) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  }
  return segments[0] ?? null;
}

function npmPackagesCoordinates(
  value: unknown,
  manifest: Manifest
): ScaDependencyCoordinateV1[] | null {
  if (!isRecord(value)) return null;
  const packages = value.packages;
  if (!isRecord(packages)) return null;
  const output: ScaDependencyCoordinateV1[] = [];
  for (const [packagePath, packageValue] of Object.entries(packages)) {
    if (packagePath.length === 0) continue;
    if (!isRecord(packageValue) || typeof packageValue.version !== "string") return null;
    const name =
      typeof packageValue.name === "string"
        ? packageValue.name
        : npmNameFromPackagePath(packagePath);
    if (name === null || name.length === 0) return null;
    output.push(
      coordinate(
        "npm",
        name,
        packageValue.version,
        packageValue.dev === true ? "development" : "runtime",
        manifest
      )
    );
    if (output.length > MAX_COORDINATES) return null;
  }
  return output;
}

function walkNpmDependencies(
  value: unknown,
  manifest: Manifest,
  output: ScaDependencyCoordinateV1[],
  depth: number
): boolean {
  if (!isRecord(value) || depth > MAX_DEPENDENCY_DEPTH) return false;
  for (const [name, dependencyValue] of Object.entries(value)) {
    if (!isRecord(dependencyValue) || typeof dependencyValue.version !== "string") return false;
    output.push(
      coordinate(
        "npm",
        name,
        dependencyValue.version,
        dependencyValue.dev === true ? "development" : "runtime",
        manifest
      )
    );
    if (output.length > MAX_COORDINATES) return false;
    if (
      dependencyValue.dependencies !== undefined &&
      !walkNpmDependencies(dependencyValue.dependencies, manifest, output, depth + 1)
    ) {
      return false;
    }
  }
  return true;
}

function npmCoordinates(value: unknown, manifest: Manifest): ScaDependencyCoordinateV1[] | null {
  if (!isRecord(value) || typeof value.lockfileVersion !== "number") return null;
  const packages = npmPackagesCoordinates(value, manifest);
  if (packages !== null) return packages;
  const output: ScaDependencyCoordinateV1[] = [];
  return walkNpmDependencies(value.dependencies, manifest, output, 0) ? output : null;
}

function composerCoordinates(
  value: unknown,
  manifest: Manifest
): ScaDependencyCoordinateV1[] | null {
  if (!isRecord(value)) return null;
  const output: ScaDependencyCoordinateV1[] = [];
  for (const [field, scope] of [
    ["packages", "runtime"],
    ["packages-dev", "development"],
  ] as const) {
    const packages = value[field];
    if (!Array.isArray(packages)) return null;
    for (const packageValue of packages) {
      if (
        !isRecord(packageValue) ||
        typeof packageValue.name !== "string" ||
        typeof packageValue.version !== "string"
      ) {
        return null;
      }
      output.push(
        coordinate("Packagist", packageValue.name, packageValue.version, scope, manifest)
      );
      if (output.length > MAX_COORDINATES) return null;
    }
  }
  return output;
}

function parseManifest(manifest: Manifest): {
  readonly result: ManifestResult;
  readonly coordinates: readonly ScaDependencyCoordinateV1[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.content);
  } catch {
    return {
      result: {
        path: manifest.path,
        sha256: manifest.sha256,
        format: "invalid",
        status: "failed",
        coordinate_count: 0,
        error_code: "invalid_json",
      },
      coordinates: [],
    };
  }

  const basename = manifest.path.slice(manifest.path.lastIndexOf("/") + 1);
  const format =
    basename === "package-lock.json"
      ? "npm-package-lock"
      : basename === "composer.lock"
        ? "composer-lock"
        : null;
  if (format === null) {
    return {
      result: {
        path: manifest.path,
        sha256: manifest.sha256,
        format: "unsupported",
        status: "unsupported",
        coordinate_count: 0,
        error_code: "unsupported_manifest",
      },
      coordinates: [],
    };
  }
  const coordinates =
    format === "npm-package-lock"
      ? npmCoordinates(parsed, manifest)
      : composerCoordinates(parsed, manifest);
  if (coordinates === null) {
    return {
      result: {
        path: manifest.path,
        sha256: manifest.sha256,
        format,
        status: "failed",
        coordinate_count: 0,
        error_code: "invalid_lockfile",
      },
      coordinates: [],
    };
  }
  return {
    result: {
      path: manifest.path,
      sha256: manifest.sha256,
      format,
      status: "succeeded",
      coordinate_count: coordinates.length,
      error_code: "none",
    },
    coordinates,
  };
}

function inventoryStatus(
  manifests: readonly ManifestResult[]
): ScaDependencyInventoryResultV1["status"] {
  if (manifests.every((manifest) => manifest.status === "unsupported")) return "unsupported";
  if (manifests.every((manifest) => manifest.status === "failed")) return "failed";
  if (manifests.every((manifest) => manifest.status === "succeeded")) return "succeeded";
  return "partial";
}

function digestInventory(value: UnsignedResult): string {
  return sha256(canonicalJson(value));
}

export function buildScaDependencyInventoryV1(value: unknown): ScaDependencyInventoryResultV1 {
  let input: ScaDependencyInventoryInputV1;
  try {
    input = validateContract(
      ScaDependencyInventoryInputV1Schema,
      value,
      "SCA dependency inventory input"
    );
  } catch (error) {
    throw new ScaDependencyInventoryError(
      "invalid_input",
      error instanceof Error ? error.message : "dependency inventory input is invalid"
    );
  }

  const exactPaths = new Set<string>();
  const foldedPaths = new Set<string>();
  for (const manifest of input.manifests) {
    validatePath(manifest.path);
    if (Buffer.byteLength(manifest.content, "utf8") > MAX_CONTENT_BYTES) {
      throw new ScaDependencyInventoryError(
        "invalid_input",
        "manifest content exceeds its byte limit"
      );
    }
    if (sha256(manifest.content) !== manifest.sha256) {
      throw new ScaDependencyInventoryError(
        "digest_mismatch",
        "manifest content digest does not match"
      );
    }
    const folded = manifest.path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (exactPaths.has(manifest.path) || foldedPaths.has(folded)) {
      throw new ScaDependencyInventoryError("path_collision", "manifest paths collide");
    }
    exactPaths.add(manifest.path);
    foldedPaths.add(folded);
  }

  const parsed = input.manifests
    .map(parseManifest)
    .sort((left, right) => compareUtf8(left.result.path, right.result.path));
  const coordinateByIdentity = new Map<string, ScaDependencyCoordinateV1>();
  for (const entry of parsed) {
    for (const dependency of entry.coordinates) {
      const key = canonicalJson({
        ecosystem: dependency.ecosystem,
        name: dependency.name,
        version: dependency.version,
        scope: dependency.scope,
      });
      if (!coordinateByIdentity.has(key)) coordinateByIdentity.set(key, dependency);
    }
  }
  const coordinates = [...coordinateByIdentity.values()].sort((left, right) =>
    compareUtf8(
      `${left.ecosystem}\0${left.name}\0${left.version}\0${left.scope}`,
      `${right.ecosystem}\0${right.name}\0${right.version}\0${right.scope}`
    )
  );
  if (coordinates.length > MAX_COORDINATES) {
    throw new ScaDependencyInventoryError("invalid_input", "dependency coordinate limit exceeded");
  }

  const unsigned: UnsignedResult = {
    schema_id: SCA_DEPENDENCY_INVENTORY_RESULT_SCHEMA,
    schema_version: 1,
    source_snapshot_sha256: input.source_snapshot_sha256,
    status: inventoryStatus(parsed.map((entry) => entry.result)),
    manifests: parsed.map((entry) => entry.result),
    coordinates,
  };
  return validateContract(
    ScaDependencyInventoryResultV1Schema,
    { ...unsigned, inventory_sha256: digestInventory(unsigned) },
    "SCA dependency inventory result"
  );
}

export function validateScaDependencyInventoryResultV1(
  value: unknown
): ScaDependencyInventoryResultV1 {
  const result = validateContract(
    ScaDependencyInventoryResultV1Schema,
    value,
    "SCA dependency inventory result"
  );
  const { inventory_sha256: observedDigest, ...unsigned } = result;
  if (digestInventory(unsigned) !== observedDigest) {
    throw new ScaDependencyInventoryError("invalid_input", "dependency inventory digest mismatch");
  }
  return result;
}
