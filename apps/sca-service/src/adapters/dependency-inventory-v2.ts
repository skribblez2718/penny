import { basename, posix } from "node:path";

import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../../orchestration/dist/contracts.js";
import { Sha256Schema } from "../../../orchestration/dist/skill-contracts/common.js";

const MAX_DOCUMENTS = 256;
const MAX_PROJECTS = 256;
const MAX_CONTENT_BYTES = 16_777_216;
const MAX_TOTAL_CONTENT_BYTES = 134_217_728;
const MAX_OCCURRENCES = 1_000_000;
const MAX_EDGES = 1_000_000;
const MAX_CONSTRAINTS = 1_000_000;
const MAX_PATH_BYTES = 4_096;
const MAX_TEXT_BYTES = 4_096;
const MAX_NPM_DEPTH = 128;

/**
 * The v2 dependency slice is inactive and unreleased. Its producer, validator, exports, and tests
 * are changed atomically here, so the existing v2 IDs are intentionally retained until activation.
 */
export const SCA_DEPENDENCY_INVENTORY_INPUT_V2_SCHEMA = "penny.sca-dependency-inventory-input.v2";
export const SCA_DEPENDENCY_INVENTORY_RESULT_V2_SCHEMA = "penny.sca-dependency-inventory-result.v2";

const EcosystemV2Schema = Type.Union([Type.Literal("npm"), Type.Literal("Packagist")]);
const EcosystemStateV2Schema = Type.Union([
  Type.Literal("supported"),
  Type.Literal("absent"),
  Type.Literal("partial"),
  Type.Literal("malformed"),
  Type.Literal("unsupported"),
]);
const DependencyScopeV2Schema = Type.Union([
  Type.Literal("runtime"),
  Type.Literal("development"),
  Type.Literal("optional"),
  Type.Literal("peer"),
]);

const DependencyDocumentV2Schema = Type.Object(
  {
    ecosystem: EcosystemV2Schema,
    project_path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    role: Type.Union([Type.Literal("manifest"), Type.Literal("lockfile")]),
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    sha256: Sha256Schema,
    content: Type.String({ maxLength: MAX_CONTENT_BYTES }),
  },
  { additionalProperties: false }
);

export const ScaDependencyInventoryInputV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_DEPENDENCY_INVENTORY_INPUT_V2_SCHEMA),
    schema_version: Type.Literal(2),
    source_snapshot_sha256: Sha256Schema,
    ecosystems: Type.Array(EcosystemV2Schema, { minItems: 1, maxItems: 2 }),
    documents: Type.Array(DependencyDocumentV2Schema, { maxItems: MAX_DOCUMENTS }),
  },
  { additionalProperties: false }
);

const ConstraintV2Schema = Type.Object(
  {
    source_document_path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    source_json_pointer: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    constraint: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
    scope: DependencyScopeV2Schema,
  },
  { additionalProperties: false }
);

const DependencyOccurrenceV2Schema = Type.Object(
  {
    occurrence_id: Type.String({ pattern: "^depocc_[a-f0-9]{64}$" }),
    ecosystem: EcosystemV2Schema,
    project_path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    lockfile_path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    lockfile_sha256: Sha256Schema,
    lock_path: Type.String({ maxLength: MAX_PATH_BYTES }),
    source_json_pointer: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    relationship: Type.Union([Type.Literal("root"), Type.Literal("dependency")]),
    name: Type.Union([Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }), Type.Null()]),
    version: Type.Union([Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }), Type.Null()]),
    scope: Type.Union([DependencyScopeV2Schema, Type.Literal("unknown")]),
    constraints: Type.Array(ConstraintV2Schema, { maxItems: MAX_CONSTRAINTS }),
    coordinate_id: Type.Union([Type.String({ pattern: "^depcoord_[a-f0-9]{64}$" }), Type.Null()]),
    workspace_link: Type.Boolean(),
    link_resolved_path: Type.Union([
      Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
      Type.Null(),
    ]),
    link_target_occurrence_id: Type.Union([
      Type.String({ pattern: "^depocc_[a-f0-9]{64}$" }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false }
);

const DependencyEdgeLineageV2Schema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("manifest"),
      Type.Literal("lockfile_package"),
      Type.Literal("workspace_link"),
    ]),
    document_path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    source_json_pointer: Type.String({ maxLength: MAX_PATH_BYTES }),
  },
  { additionalProperties: false }
);

const DependencyEdgeV2Schema = Type.Object(
  {
    edge_id: Type.String({ pattern: "^depedge_[a-f0-9]{64}$" }),
    ecosystem: EcosystemV2Schema,
    project_path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    parent_kind: Type.Union([Type.Literal("project_root"), Type.Literal("occurrence")]),
    parent_id: Type.String({ pattern: "^(deproot|depocc)_[a-f0-9]{64}$" }),
    parent_occurrence_id: Type.Union([
      Type.String({ pattern: "^depocc_[a-f0-9]{64}$" }),
      Type.Null(),
    ]),
    child_name: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
    child_occurrence_id: Type.Union([
      Type.String({ pattern: "^depocc_[a-f0-9]{64}$" }),
      Type.Null(),
    ]),
    child_coordinate_id: Type.Union([
      Type.String({ pattern: "^depcoord_[a-f0-9]{64}$" }),
      Type.Null(),
    ]),
    workspace_link_occurrence_id: Type.Union([
      Type.String({ pattern: "^depocc_[a-f0-9]{64}$" }),
      Type.Null(),
    ]),
    candidate_occurrence_ids: Type.Array(Type.String({ pattern: "^depocc_[a-f0-9]{64}$" }), {
      maxItems: MAX_OCCURRENCES,
    }),
    constraint: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
    scope: DependencyScopeV2Schema,
    source_document_path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    source_json_pointer: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    lineage: Type.Array(DependencyEdgeLineageV2Schema, { minItems: 1, maxItems: 6 }),
    ambiguity_status: Type.Union([
      Type.Literal("unambiguous"),
      Type.Literal("ambiguous"),
      Type.Literal("unresolved"),
    ]),
    diagnostic_code: Type.Union([
      Type.Literal("none"),
      Type.Literal("ambiguous_target"),
      Type.Literal("unresolved_target"),
    ]),
  },
  { additionalProperties: false }
);

const DependencyCoordinateV2Schema = Type.Object(
  {
    coordinate_id: Type.String({ pattern: "^depcoord_[a-f0-9]{64}$" }),
    ecosystem: EcosystemV2Schema,
    name: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
    version: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
    purl: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
  },
  { additionalProperties: false }
);

const CoordinateOccurrenceMapV2Schema = Type.Object(
  {
    coordinate_id: Type.String({ pattern: "^depcoord_[a-f0-9]{64}$" }),
    occurrence_ids: Type.Array(Type.String({ pattern: "^depocc_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: MAX_OCCURRENCES,
    }),
  },
  { additionalProperties: false }
);

const DocumentResultV2Schema = Type.Object(
  {
    ecosystem: EcosystemV2Schema,
    project_path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    role: Type.Union([Type.Literal("manifest"), Type.Literal("lockfile")]),
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    sha256: Sha256Schema,
    format: Type.Union([
      Type.Literal("npm-manifest"),
      Type.Literal("npm-package-lock-v1"),
      Type.Literal("npm-package-lock-v2"),
      Type.Literal("npm-package-lock-v3"),
      Type.Literal("composer-manifest"),
      Type.Literal("composer-lock"),
      Type.Literal("unsupported"),
      Type.Literal("malformed"),
    ]),
    state: Type.Union([
      Type.Literal("supported"),
      Type.Literal("partial"),
      Type.Literal("malformed"),
      Type.Literal("unsupported"),
    ]),
    occurrence_count: Type.Integer({ minimum: 0, maximum: MAX_OCCURRENCES }),
    error_code: Type.Union([
      Type.Literal("none"),
      Type.Literal("invalid_json"),
      Type.Literal("invalid_structure"),
      Type.Literal("unsupported_lockfile_version"),
      Type.Literal("incomplete_occurrence"),
      Type.Literal("ambiguous_relationship"),
      Type.Literal("unresolved_relationship"),
    ]),
  },
  { additionalProperties: false }
);

const ProjectResultV2Schema = Type.Object(
  {
    ecosystem: EcosystemV2Schema,
    project_path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    state: EcosystemStateV2Schema,
    manifest_path: Type.Union([
      Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
      Type.Null(),
    ]),
    lockfile_path: Type.Union([
      Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
      Type.Null(),
    ]),
    occurrence_count: Type.Integer({ minimum: 0, maximum: MAX_OCCURRENCES }),
    edge_count: Type.Integer({ minimum: 0, maximum: MAX_EDGES }),
  },
  { additionalProperties: false }
);

const EcosystemResultV2Schema = Type.Object(
  {
    ecosystem: EcosystemV2Schema,
    state: EcosystemStateV2Schema,
    project_count: Type.Integer({ minimum: 0, maximum: MAX_PROJECTS }),
    occurrence_count: Type.Integer({ minimum: 0, maximum: MAX_OCCURRENCES }),
    coordinate_count: Type.Integer({ minimum: 0, maximum: MAX_OCCURRENCES }),
    edge_count: Type.Integer({ minimum: 0, maximum: MAX_EDGES }),
  },
  { additionalProperties: false }
);

export const ScaDependencyInventoryResultV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_DEPENDENCY_INVENTORY_RESULT_V2_SCHEMA),
    schema_version: Type.Literal(2),
    source_snapshot_sha256: Sha256Schema,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("partial"),
      Type.Literal("failed"),
    ]),
    ecosystems: Type.Array(EcosystemResultV2Schema, { minItems: 1, maxItems: 2 }),
    projects: Type.Array(ProjectResultV2Schema, { maxItems: MAX_PROJECTS }),
    documents: Type.Array(DocumentResultV2Schema, { maxItems: MAX_DOCUMENTS }),
    occurrences: Type.Array(DependencyOccurrenceV2Schema, { maxItems: MAX_OCCURRENCES }),
    edges: Type.Array(DependencyEdgeV2Schema, { maxItems: MAX_EDGES }),
    coordinates: Type.Array(DependencyCoordinateV2Schema, { maxItems: MAX_OCCURRENCES }),
    coordinate_occurrences: Type.Array(CoordinateOccurrenceMapV2Schema, {
      maxItems: MAX_OCCURRENCES,
    }),
    inventory_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaDependencyInventoryInputV2 = Static<typeof ScaDependencyInventoryInputV2Schema>;
export type ScaDependencyInventoryResultV2 = Static<typeof ScaDependencyInventoryResultV2Schema>;
export type ScaDependencyCoordinateV2 = ScaDependencyInventoryResultV2["coordinates"][number];

type Ecosystem = ScaDependencyInventoryInputV2["ecosystems"][number];
type Document = ScaDependencyInventoryInputV2["documents"][number];
type Occurrence = ScaDependencyInventoryResultV2["occurrences"][number];
type RawOccurrence = Omit<
  Occurrence,
  "occurrence_id" | "constraints" | "coordinate_id" | "link_target_occurrence_id"
>;
type Constraint = Occurrence["constraints"][number];
type Edge = ScaDependencyInventoryResultV2["edges"][number];
type EdgeLineage = Edge["lineage"][number];
type DocumentResult = ScaDependencyInventoryResultV2["documents"][number];
type ProjectResult = ScaDependencyInventoryResultV2["projects"][number];
type EcosystemResult = ScaDependencyInventoryResultV2["ecosystems"][number];
type UnsignedResult = Omit<ScaDependencyInventoryResultV2, "inventory_sha256">;
type Scope = Edge["scope"];

type RawDeclaration = Readonly<{
  ecosystem: Ecosystem;
  project_path: string;
  parent_lock_path: string | null;
  child_name: string;
  constraint: string;
  scope: Scope;
  source_document_path: string;
  source_json_pointer: string;
  lineage: readonly EdgeLineage[];
  exact_child_lock_path?: string;
}>;

type ParsedManifest = Readonly<{
  document: Document;
  value: Record<string, unknown> | null;
  declarations: readonly RawDeclaration[];
  result: DocumentResult;
}>;

type ParsedLock = Readonly<{
  document: Document;
  value: Record<string, unknown> | null;
  occurrences: readonly RawOccurrence[];
  declarations: readonly RawDeclaration[];
  result: DocumentResult;
}>;

export class ScaDependencyInventoryV2Error extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unsafe_path"
      | "path_collision"
      | "digest_mismatch"
      | "document_collision"
      | "limit_exceeded"
      | "semantic_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaDependencyInventoryV2Error";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalPath(candidate: string, allowRoot: boolean): void {
  if (allowRoot && candidate === ".") return;
  const segments = candidate.split("/");
  if (
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/u.test(candidate) ||
    candidate !== candidate.normalize("NFC") ||
    Buffer.byteLength(candidate, "utf8") > MAX_PATH_BYTES ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ScaDependencyInventoryV2Error(
      "unsafe_path",
      "dependency document path is not canonical"
    );
  }
}

export function scaJsonPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function projectContains(projectPath: string, documentPath: string): boolean {
  return projectPath === "." || documentPath.startsWith(`${projectPath}/`);
}

function projectContainsProject(parentProject: string, childProject: string): boolean {
  return (
    parentProject === "." ||
    childProject === parentProject ||
    childProject.startsWith(`${parentProject}/`)
  );
}

function expectedBasename(document: Document): string {
  if (document.ecosystem === "npm") {
    return document.role === "manifest" ? "package.json" : "package-lock.json";
  }
  return document.role === "manifest" ? "composer.json" : "composer.lock";
}

function documentResult(
  document: Document,
  format: DocumentResult["format"],
  state: DocumentResult["state"],
  errorCode: DocumentResult["error_code"],
  occurrenceCount = 0
): DocumentResult {
  return {
    ecosystem: document.ecosystem,
    project_path: document.project_path,
    role: document.role,
    path: document.path,
    sha256: document.sha256,
    format,
    state,
    occurrence_count: occurrenceCount,
    error_code: errorCode,
  };
}

function fieldsFor(ecosystem: Ecosystem): readonly (readonly [string, Scope])[] {
  return ecosystem === "npm"
    ? [
        ["dependencies", "runtime"],
        ["devDependencies", "development"],
        ["optionalDependencies", "optional"],
        ["peerDependencies", "peer"],
      ]
    : [
        ["require", "runtime"],
        ["require-dev", "development"],
      ];
}

function extractDeclarations(
  value: Record<string, unknown>,
  context: Omit<RawDeclaration, "child_name" | "constraint" | "scope" | "source_json_pointer">,
  basePointer: string
): readonly RawDeclaration[] | null {
  const declarations: RawDeclaration[] = [];
  const optionalNames = new Set<string>();
  if (context.ecosystem === "npm" && isRecord(value.optionalDependencies)) {
    for (const name of Object.keys(value.optionalDependencies)) optionalNames.add(name);
  }
  for (const [field, scope] of fieldsFor(context.ecosystem)) {
    const entries = value[field];
    if (entries === undefined) continue;
    if (!isRecord(entries)) return null;
    for (const [name, constraint] of Object.entries(entries)) {
      if (field === "dependencies" && optionalNames.has(name)) continue;
      if (typeof constraint !== "string" || constraint.length === 0) return null;
      declarations.push({
        ...context,
        child_name: name,
        constraint,
        scope,
        source_json_pointer: `${basePointer}/${scaJsonPointerToken(field)}/${scaJsonPointerToken(name)}`,
      });
      if (declarations.length > MAX_EDGES) {
        throw new ScaDependencyInventoryV2Error("limit_exceeded", "dependency edge limit exceeded");
      }
    }
  }
  return declarations.sort((left, right) =>
    compareUtf8(left.source_json_pointer, right.source_json_pointer)
  );
}

function parseManifest(document: Document): ParsedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document.content);
  } catch {
    return {
      document,
      value: null,
      declarations: [],
      result: documentResult(document, "malformed", "malformed", "invalid_json"),
    };
  }
  if (!isRecord(parsed)) {
    return {
      document,
      value: null,
      declarations: [],
      result: documentResult(document, "malformed", "malformed", "invalid_structure"),
    };
  }
  const declarations = extractDeclarations(
    parsed,
    {
      ecosystem: document.ecosystem,
      project_path: document.project_path,
      parent_lock_path: null,
      source_document_path: document.path,
      lineage: [
        {
          kind: "manifest",
          document_path: document.path,
          source_json_pointer: "",
        },
      ],
    },
    ""
  );
  if (declarations === null) {
    return {
      document,
      value: parsed,
      declarations: [],
      result: documentResult(document, "malformed", "malformed", "invalid_structure"),
    };
  }
  return {
    document,
    value: parsed,
    declarations,
    result: documentResult(
      document,
      document.ecosystem === "npm" ? "npm-manifest" : "composer-manifest",
      "supported",
      "none"
    ),
  };
}

function npmNameFromLockPath(lockPath: string): string | null {
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) return null;
  const suffix = lockPath.slice(index + marker.length);
  const segments = suffix.split("/");
  const first = segments[0];
  if (first === undefined || first.length === 0) return null;
  if (first.startsWith("@")) {
    const second = segments[1];
    return second === undefined || second.length === 0 ? null : `${first}/${second}`;
  }
  return first;
}

function occurrenceScope(value: Record<string, unknown>): Occurrence["scope"] {
  if (value.peer === true) return "peer";
  if (value.optional === true || value.devOptional === true) return "optional";
  if (value.dev === true) return "development";
  return "runtime";
}

function baseOccurrence(
  document: Document,
  lockPath: string,
  pointer: string,
  relationship: Occurrence["relationship"],
  name: string | null,
  version: string | null,
  scope: Occurrence["scope"],
  workspaceLink = false,
  linkResolvedPath: string | null = null
): RawOccurrence {
  return {
    ecosystem: document.ecosystem,
    project_path: document.project_path,
    lockfile_path: document.path,
    lockfile_sha256: document.sha256,
    lock_path: lockPath,
    source_json_pointer: pointer,
    relationship,
    name,
    version,
    scope,
    workspace_link: workspaceLink,
    link_resolved_path: linkResolvedPath,
  };
}

function npmLinkResolvedPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    canonicalPath(value, false);
  } catch {
    return null;
  }
  return value;
}

function parseNpmPackages(document: Document, parsed: Record<string, unknown>): ParsedLock {
  const lockfileVersion = parsed.lockfileVersion;
  if (lockfileVersion !== 2 && lockfileVersion !== 3) {
    return {
      document,
      value: parsed,
      occurrences: [],
      declarations: [],
      result: documentResult(
        document,
        "unsupported",
        "unsupported",
        "unsupported_lockfile_version"
      ),
    };
  }
  const packages = parsed.packages;
  if (!isRecord(packages)) {
    return {
      document,
      value: parsed,
      occurrences: [],
      declarations: [],
      result: documentResult(document, "malformed", "malformed", "invalid_structure"),
    };
  }
  const occurrences: RawOccurrence[] = [];
  const declarations: RawDeclaration[] = [];
  let incomplete = false;
  for (const [lockPath, packageValue] of Object.entries(packages)) {
    if (!isRecord(packageValue)) {
      return {
        document,
        value: parsed,
        occurrences: [],
        declarations: [],
        result: documentResult(document, "malformed", "malformed", "invalid_structure"),
      };
    }
    const relationship = lockPath.length === 0 ? "root" : "dependency";
    const name =
      typeof packageValue.name === "string" && packageValue.name.length > 0
        ? packageValue.name
        : relationship === "root"
          ? null
          : npmNameFromLockPath(lockPath);
    const version =
      typeof packageValue.version === "string" && packageValue.version.length > 0
        ? packageValue.version
        : null;
    const isLink = packageValue.link === true;
    const linkResolvedPath = isLink ? npmLinkResolvedPath(packageValue.resolved) : null;
    if (
      relationship === "dependency" &&
      (name === null || (version === null && !isLink) || (isLink && linkResolvedPath === null))
    ) {
      incomplete = true;
    }
    const packagePointer = `/packages/${scaJsonPointerToken(lockPath)}`;
    occurrences.push(
      baseOccurrence(
        document,
        lockPath,
        packagePointer,
        relationship,
        name,
        version,
        occurrenceScope(packageValue),
        isLink,
        linkResolvedPath
      )
    );
    const lineage: EdgeLineage[] = [
      {
        kind: "lockfile_package",
        document_path: document.path,
        source_json_pointer: packagePointer,
      },
    ];
    if (packageValue.link === true) {
      lineage.push({
        kind: "workspace_link",
        document_path: document.path,
        source_json_pointer: `${packagePointer}/link`,
      });
    }
    const extracted = extractDeclarations(
      packageValue,
      {
        ecosystem: "npm",
        project_path: document.project_path,
        parent_lock_path: lockPath,
        source_document_path: document.path,
        lineage,
      },
      packagePointer
    );
    if (extracted === null) {
      return {
        document,
        value: parsed,
        occurrences: [],
        declarations: [],
        result: documentResult(document, "malformed", "malformed", "invalid_structure"),
      };
    }
    declarations.push(...extracted);
    if (occurrences.length > MAX_OCCURRENCES || declarations.length > MAX_EDGES) {
      throw new ScaDependencyInventoryV2Error(
        "limit_exceeded",
        "dependency occurrence or edge limit exceeded"
      );
    }
  }
  return {
    document,
    value: parsed,
    occurrences,
    declarations,
    result: documentResult(
      document,
      lockfileVersion === 2 ? "npm-package-lock-v2" : "npm-package-lock-v3",
      incomplete ? "partial" : "supported",
      incomplete ? "incomplete_occurrence" : "none",
      occurrences.length
    ),
  };
}

function walkNpmV1(
  document: Document,
  dependencies: unknown,
  parentLockPath: string,
  pointer: string,
  depth: number,
  occurrences: RawOccurrence[],
  declarations: RawDeclaration[]
): boolean {
  if (!isRecord(dependencies) || depth > MAX_NPM_DEPTH) return false;
  let complete = true;
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!isRecord(dependency)) return false;
    const version =
      typeof dependency.version === "string" && dependency.version.length > 0
        ? dependency.version
        : null;
    if (version === null) complete = false;
    const lockPath = `${parentLockPath}${parentLockPath.length > 0 ? "/" : ""}node_modules/${name}`;
    const sourcePointer = `${pointer}/${scaJsonPointerToken(name)}`;
    occurrences.push(
      baseOccurrence(
        document,
        lockPath,
        sourcePointer,
        "dependency",
        name,
        version,
        occurrenceScope(dependency)
      )
    );
    if (isRecord(dependency.requires)) {
      for (const [childName, constraint] of Object.entries(dependency.requires)) {
        if (typeof constraint !== "string" || constraint.length === 0) return false;
        declarations.push({
          ecosystem: "npm",
          project_path: document.project_path,
          parent_lock_path: lockPath,
          child_name: childName,
          constraint,
          scope: "runtime",
          source_document_path: document.path,
          source_json_pointer: `${sourcePointer}/requires/${scaJsonPointerToken(childName)}`,
          lineage: [
            {
              kind: "lockfile_package",
              document_path: document.path,
              source_json_pointer: sourcePointer,
            },
          ],
        });
      }
    }
    if (occurrences.length > MAX_OCCURRENCES || declarations.length > MAX_EDGES) {
      throw new ScaDependencyInventoryV2Error(
        "limit_exceeded",
        "dependency occurrence or edge limit exceeded"
      );
    }
    if (
      dependency.dependencies !== undefined &&
      !walkNpmV1(
        document,
        dependency.dependencies,
        lockPath,
        `${sourcePointer}/dependencies`,
        depth + 1,
        occurrences,
        declarations
      )
    ) {
      complete = false;
    }
  }
  return complete;
}

function parseNpmLock(document: Document, parsed: unknown): ParsedLock {
  if (!isRecord(parsed) || typeof parsed.lockfileVersion !== "number") {
    return {
      document,
      value: null,
      occurrences: [],
      declarations: [],
      result: documentResult(document, "malformed", "malformed", "invalid_structure"),
    };
  }
  if (parsed.lockfileVersion === 2 || parsed.lockfileVersion === 3) {
    return parseNpmPackages(document, parsed);
  }
  if (parsed.lockfileVersion !== 1) {
    return {
      document,
      value: parsed,
      occurrences: [],
      declarations: [],
      result: documentResult(
        document,
        "unsupported",
        "unsupported",
        "unsupported_lockfile_version"
      ),
    };
  }
  const occurrences: RawOccurrence[] = [];
  const declarations: RawDeclaration[] = [];
  const complete = walkNpmV1(
    document,
    parsed.dependencies ?? {},
    "",
    "/dependencies",
    0,
    occurrences,
    declarations
  );
  return {
    document,
    value: parsed,
    occurrences,
    declarations,
    result: documentResult(
      document,
      "npm-package-lock-v1",
      complete ? "supported" : "partial",
      complete ? "none" : "incomplete_occurrence",
      occurrences.length
    ),
  };
}

function composerPackageName(name: string): boolean {
  return name.includes("/") && !name.startsWith("ext-") && name !== "php";
}

function parseComposerLock(document: Document, parsed: unknown): ParsedLock {
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.packages) ||
    !Array.isArray(parsed["packages-dev"])
  ) {
    return {
      document,
      value: null,
      occurrences: [],
      declarations: [],
      result: documentResult(document, "malformed", "malformed", "invalid_structure"),
    };
  }
  const occurrences: RawOccurrence[] = [];
  const declarations: RawDeclaration[] = [];
  let incomplete = false;
  for (const [field, scope] of [
    ["packages", "runtime"],
    ["packages-dev", "development"],
  ] as const) {
    const entries = parsed[field];
    if (!Array.isArray(entries)) continue;
    for (const [index, packageValue] of entries.entries()) {
      if (!isRecord(packageValue)) {
        return {
          document,
          value: parsed,
          occurrences: [],
          declarations: [],
          result: documentResult(document, "malformed", "malformed", "invalid_structure"),
        };
      }
      const name =
        typeof packageValue.name === "string" && packageValue.name.length > 0
          ? packageValue.name
          : null;
      const version =
        typeof packageValue.version === "string" && packageValue.version.length > 0
          ? packageValue.version
          : null;
      if (name === null || version === null) incomplete = true;
      const packagePointer = `/${scaJsonPointerToken(field)}/${index}`;
      const lockPath = `${field}/${index}`;
      occurrences.push(
        baseOccurrence(document, lockPath, packagePointer, "dependency", name, version, scope)
      );
      const extracted = extractDeclarations(
        packageValue,
        {
          ecosystem: "Packagist",
          project_path: document.project_path,
          parent_lock_path: lockPath,
          source_document_path: document.path,
          lineage: [
            {
              kind: "lockfile_package",
              document_path: document.path,
              source_json_pointer: packagePointer,
            },
          ],
        },
        packagePointer
      );
      if (extracted === null) {
        return {
          document,
          value: parsed,
          occurrences: [],
          declarations: [],
          result: documentResult(document, "malformed", "malformed", "invalid_structure"),
        };
      }
      declarations.push(
        ...extracted.filter((declaration) => composerPackageName(declaration.child_name))
      );
      if (occurrences.length > MAX_OCCURRENCES || declarations.length > MAX_EDGES) {
        throw new ScaDependencyInventoryV2Error(
          "limit_exceeded",
          "dependency occurrence or edge limit exceeded"
        );
      }
    }
  }
  return {
    document,
    value: parsed,
    occurrences,
    declarations,
    result: documentResult(
      document,
      "composer-lock",
      incomplete ? "partial" : "supported",
      incomplete ? "incomplete_occurrence" : "none",
      occurrences.length
    ),
  };
}

function parseLock(document: Document): ParsedLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document.content);
  } catch {
    return {
      document,
      value: null,
      occurrences: [],
      declarations: [],
      result: documentResult(document, "malformed", "malformed", "invalid_json"),
    };
  }
  return document.ecosystem === "npm"
    ? parseNpmLock(document, parsed)
    : parseComposerLock(document, parsed);
}

function occurrenceId(sourceSnapshotSha256: string, occurrence: RawOccurrence): string {
  return `depocc_${sha256(
    canonicalJson({
      source_snapshot_sha256: sourceSnapshotSha256,
      ecosystem: occurrence.ecosystem,
      project_path: occurrence.project_path,
      lockfile_path: occurrence.lockfile_path,
      lockfile_sha256: occurrence.lockfile_sha256,
      lock_path: occurrence.lock_path,
      source_json_pointer: occurrence.source_json_pointer,
      relationship: occurrence.relationship,
      name: occurrence.name,
      version: occurrence.version,
      scope: occurrence.scope,
      workspace_link: occurrence.workspace_link,
      link_resolved_path: occurrence.link_resolved_path,
    })
  )}`;
}

export function scaDependencyCoordinateIdV2(
  ecosystem: Ecosystem,
  name: string,
  version: string
): string {
  return `depcoord_${sha256(canonicalJson({ ecosystem, name, version }))}`;
}

function rootId(
  sourceSnapshotSha256: string,
  ecosystem: Ecosystem,
  projectPath: string,
  sourceDocumentPath: string
): string {
  return `deproot_${sha256(
    canonicalJson({
      source_snapshot_sha256: sourceSnapshotSha256,
      ecosystem,
      project_path: projectPath,
      source_document_path: sourceDocumentPath,
    })
  )}`;
}

function edgeId(sourceSnapshotSha256: string, edge: Omit<Edge, "edge_id">): string {
  return `depedge_${sha256(canonicalJson({ source_snapshot_sha256: sourceSnapshotSha256, ...edge }))}`;
}

function purl(ecosystem: Ecosystem, name: string, version: string): string {
  const type = ecosystem === "npm" ? "npm" : "composer";
  const encodedName = name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `pkg:${type}/${encodedName}@${encodeURIComponent(version)}`;
}

function relativeProjectPath(lockProject: string, project: string): string {
  if (lockProject === project) return "";
  return lockProject === "." ? project : project.slice(lockProject.length + 1);
}

function nearestLock(
  projectPath: string,
  ecosystem: Ecosystem,
  locks: readonly ParsedLock[]
): ParsedLock | undefined {
  return locks
    .filter(
      (lock) =>
        lock.document.ecosystem === ecosystem &&
        projectContainsProject(lock.document.project_path, projectPath)
    )
    .sort(
      (left, right) => right.document.project_path.length - left.document.project_path.length
    )[0];
}

function npmResolutionPaths(parentLockPath: string, childName: string): readonly string[] {
  const candidates: string[] = [];
  let current = parentLockPath;
  for (;;) {
    if (current.length === 0 || posix.basename(current) !== "node_modules") {
      candidates.push(
        current.length === 0 ? `node_modules/${childName}` : `${current}/node_modules/${childName}`
      );
    }
    if (current.length === 0) break;
    const next = posix.dirname(current);
    current = next === "." ? "" : next;
  }
  return [...new Set(candidates)];
}

function resolveDeclaration(
  sourceSnapshotSha256: string,
  declaration: RawDeclaration,
  lock: ParsedLock,
  occurrences: readonly Occurrence[]
): Edge {
  const lockOccurrences = occurrences.filter(
    (occurrence) => occurrence.lockfile_path === lock.document.path
  );
  let parentOccurrence: Occurrence | undefined;
  if (declaration.parent_lock_path !== null) {
    parentOccurrence = lockOccurrences.find(
      (occurrence) => occurrence.lock_path === declaration.parent_lock_path
    );
  }
  const parentKind: Edge["parent_kind"] =
    declaration.parent_lock_path === null || declaration.parent_lock_path.length === 0
      ? "project_root"
      : "occurrence";
  const parentOccurrenceId =
    parentKind === "occurrence" ? (parentOccurrence?.occurrence_id ?? null) : null;
  const parentId =
    parentKind === "project_root"
      ? rootId(
          sourceSnapshotSha256,
          declaration.ecosystem,
          declaration.project_path,
          declaration.source_document_path
        )
      : (parentOccurrenceId ??
        `depocc_${sha256(
          canonicalJson({
            unresolved_parent_lock_path: declaration.parent_lock_path,
            lockfile_path: lock.document.path,
          })
        )}`);

  let candidates: Occurrence[];
  if (parentKind === "occurrence" && parentOccurrence === undefined) {
    candidates = [];
  } else if (declaration.ecosystem === "npm") {
    const parentPath =
      declaration.parent_lock_path ??
      relativeProjectPath(lock.document.project_path, declaration.project_path);
    if (declaration.exact_child_lock_path !== undefined) {
      candidates = lockOccurrences.filter(
        (occurrence) => occurrence.lock_path === declaration.exact_child_lock_path
      );
    } else {
      candidates = [];
      for (const candidatePath of npmResolutionPaths(parentPath, declaration.child_name)) {
        const matched = lockOccurrences.filter(
          (occurrence) => occurrence.lock_path === candidatePath
        );
        if (matched.length > 0) {
          candidates = matched;
          break;
        }
      }
    }
  } else {
    candidates = lockOccurrences.filter((occurrence) => occurrence.name === declaration.child_name);
  }
  const directCandidates = candidates;
  const workspaceLinkOccurrence =
    directCandidates.length === 1 && directCandidates[0]?.workspace_link === true
      ? directCandidates[0]
      : undefined;
  const occurrenceById = new Map(
    lockOccurrences.map((occurrence) => [occurrence.occurrence_id, occurrence])
  );
  candidates = [
    ...new Map(
      directCandidates
        .map((candidate) =>
          !candidate.workspace_link
            ? candidate
            : occurrenceById.get(candidate.link_target_occurrence_id ?? "")
        )
        .filter((candidate): candidate is Occurrence => candidate !== undefined)
        .map((candidate) => [candidate.occurrence_id, candidate])
    ).values(),
  ];
  candidates.sort((left, right) => compareUtf8(left.occurrence_id, right.occurrence_id));
  const edgeLineage: EdgeLineage[] = [...declaration.lineage];
  if (workspaceLinkOccurrence !== undefined) {
    for (const field of ["link", "resolved"] as const) {
      const pointer = `/packages/${scaJsonPointerToken(workspaceLinkOccurrence.lock_path)}/${field}`;
      if (!edgeLineage.some((entry) => entry.source_json_pointer === pointer)) {
        edgeLineage.push({
          kind: "workspace_link",
          document_path: lock.document.path,
          source_json_pointer: pointer,
        });
      }
    }
  }
  const selectedCandidate = candidates.length === 1 ? candidates[0] : undefined;
  const ambiguityStatus: Edge["ambiguity_status"] =
    candidates.length === 1 ? "unambiguous" : candidates.length === 0 ? "unresolved" : "ambiguous";
  const diagnosticCode: Edge["diagnostic_code"] =
    ambiguityStatus === "unambiguous"
      ? "none"
      : ambiguityStatus === "ambiguous"
        ? "ambiguous_target"
        : "unresolved_target";
  const unsigned: Omit<Edge, "edge_id"> = {
    ecosystem: declaration.ecosystem,
    project_path: declaration.project_path,
    parent_kind: parentKind,
    parent_id: parentId,
    parent_occurrence_id: parentOccurrenceId,
    child_name: declaration.child_name,
    child_occurrence_id: selectedCandidate?.occurrence_id ?? null,
    child_coordinate_id: selectedCandidate?.coordinate_id ?? null,
    workspace_link_occurrence_id: workspaceLinkOccurrence?.occurrence_id ?? null,
    candidate_occurrence_ids: candidates.map((candidate) => candidate.occurrence_id),
    constraint: declaration.constraint,
    scope: declaration.scope,
    source_document_path: declaration.source_document_path,
    source_json_pointer: declaration.source_json_pointer,
    lineage: edgeLineage,
    ambiguity_status: ambiguityStatus,
    diagnostic_code: diagnosticCode,
  };
  return { edge_id: edgeId(sourceSnapshotSha256, unsigned), ...unsigned };
}

function aggregateProjectState(
  manifest: ParsedManifest | undefined,
  lock: ParsedLock | undefined,
  edges: readonly Edge[]
): ProjectResult["state"] {
  if (manifest?.result.state === "malformed" || lock?.result.state === "malformed")
    return "malformed";
  if (lock?.result.state === "unsupported") return "unsupported";
  if (manifest === undefined || lock === undefined) return "partial";
  if (
    manifest.result.state === "partial" ||
    lock.result.state === "partial" ||
    edges.some((edge) => edge.ambiguity_status !== "unambiguous")
  ) {
    return "partial";
  }
  return "supported";
}

function aggregateEcosystemState(
  projects: readonly ProjectResult[],
  edges: readonly Edge[]
): EcosystemResult["state"] {
  if (projects.length === 0) return "absent";
  if (projects.some((project) => project.state === "malformed")) return "malformed";
  if (projects.some((project) => project.state === "unsupported")) return "unsupported";
  if (
    projects.some((project) => project.state === "partial") ||
    edges.some((edge) => edge.ambiguity_status !== "unambiguous")
  ) {
    return "partial";
  }
  return "supported";
}

function digestInventory(value: UnsignedResult): string {
  return sha256(canonicalJson(value));
}

function validateInput(value: unknown): ScaDependencyInventoryInputV2 {
  let input: ScaDependencyInventoryInputV2;
  try {
    input = validateContract(
      ScaDependencyInventoryInputV2Schema,
      value,
      "SCA dependency inventory v2 input"
    );
  } catch (error) {
    throw new ScaDependencyInventoryV2Error(
      "invalid_input",
      error instanceof Error ? error.message : "dependency inventory v2 input is invalid"
    );
  }
  if (new Set(input.ecosystems).size !== input.ecosystems.length) {
    throw new ScaDependencyInventoryV2Error("invalid_input", "ecosystems must be unique");
  }
  let totalBytes = 0;
  const pathKeys = new Set<string>();
  const collisionKeys = new Set<string>();
  const roleKeys = new Set<string>();
  for (const document of input.documents) {
    canonicalPath(document.project_path, true);
    canonicalPath(document.path, false);
    if (!projectContains(document.project_path, document.path)) {
      throw new ScaDependencyInventoryV2Error(
        "unsafe_path",
        "document is outside its project path"
      );
    }
    if (basename(document.path) !== expectedBasename(document)) {
      throw new ScaDependencyInventoryV2Error("invalid_input", "document role and basename differ");
    }
    if (!input.ecosystems.includes(document.ecosystem)) {
      throw new ScaDependencyInventoryV2Error(
        "invalid_input",
        "document ecosystem was not admitted"
      );
    }
    const byteLength = Buffer.byteLength(document.content, "utf8");
    totalBytes += byteLength;
    if (
      byteLength > MAX_CONTENT_BYTES ||
      totalBytes > MAX_TOTAL_CONTENT_BYTES ||
      !Number.isSafeInteger(totalBytes)
    ) {
      throw new ScaDependencyInventoryV2Error(
        "limit_exceeded",
        "dependency document bytes exceed limits"
      );
    }
    if (sha256(document.content) !== document.sha256) {
      throw new ScaDependencyInventoryV2Error(
        "digest_mismatch",
        "dependency document digest mismatch"
      );
    }
    const pathKey = `${document.ecosystem}\0${document.path}`;
    const collisionKey = pathKey.normalize("NFKC").toLowerCase();
    if (pathKeys.has(pathKey) || collisionKeys.has(collisionKey)) {
      throw new ScaDependencyInventoryV2Error(
        "path_collision",
        "dependency document paths collide"
      );
    }
    pathKeys.add(pathKey);
    collisionKeys.add(collisionKey);
    const roleKey = `${document.ecosystem}\0${document.project_path}\0${document.role}`;
    if (roleKeys.has(roleKey)) {
      throw new ScaDependencyInventoryV2Error(
        "document_collision",
        "a project has more than one document for the same role"
      );
    }
    roleKeys.add(roleKey);
  }
  return input;
}

function withManifestLineage(
  declaration: RawDeclaration,
  lock: ParsedLock,
  parentLockPath: string | null
): RawDeclaration {
  const lineage: EdgeLineage[] = [...declaration.lineage];
  if (parentLockPath !== null) {
    const parentPointer = `/packages/${scaJsonPointerToken(parentLockPath)}`;
    lineage.push({
      kind: "lockfile_package",
      document_path: lock.document.path,
      source_json_pointer: parentPointer,
    });
    if (parentLockPath.length > 0 && isRecord(lock.value?.packages)) {
      const packageValue = lock.value.packages[parentLockPath];
      if (isRecord(packageValue) && packageValue.link === true) {
        lineage.push({
          kind: "workspace_link",
          document_path: lock.document.path,
          source_json_pointer: `${parentPointer}/link`,
        });
      }
    }
  }
  return { ...declaration, parent_lock_path: parentLockPath, lineage };
}

function relationshipAdjustedResult(
  result: DocumentResult,
  edges: readonly Edge[]
): DocumentResult {
  if (result.state === "malformed" || result.state === "unsupported") return result;
  if (edges.some((edge) => edge.ambiguity_status === "ambiguous")) {
    return { ...result, state: "partial", error_code: "ambiguous_relationship" };
  }
  if (edges.some((edge) => edge.ambiguity_status === "unresolved")) {
    return { ...result, state: "partial", error_code: "unresolved_relationship" };
  }
  return result;
}

export function buildScaDependencyInventoryV2(value: unknown): ScaDependencyInventoryResultV2 {
  const input = validateInput(value);
  const parsedManifests = input.documents
    .filter((document) => document.role === "manifest")
    .map(parseManifest);
  const parsedLocks = input.documents
    .filter((document) => document.role === "lockfile")
    .map(parseLock);

  const rawOccurrences = parsedLocks.flatMap((lock) => lock.occurrences);
  const occurrences: Occurrence[] = rawOccurrences.map((raw) => ({
    occurrence_id: occurrenceId(input.source_snapshot_sha256, raw),
    ...raw,
    constraints: [],
    coordinate_id:
      raw.relationship === "dependency" && raw.name !== null && raw.version !== null
        ? scaDependencyCoordinateIdV2(raw.ecosystem, raw.name, raw.version)
        : null,
    link_target_occurrence_id: null,
  }));
  occurrences.sort((left, right) => compareUtf8(left.occurrence_id, right.occurrence_id));
  if (
    new Set(occurrences.map((occurrence) => occurrence.occurrence_id)).size !== occurrences.length
  ) {
    throw new ScaDependencyInventoryV2Error(
      "document_collision",
      "dependency occurrences do not have unique source identities"
    );
  }
  const incompleteLinkLockfiles = new Set<string>();
  for (const occurrence of occurrences) {
    if (!occurrence.workspace_link) continue;
    if (occurrence.link_resolved_path === null) {
      incompleteLinkLockfiles.add(occurrence.lockfile_path);
      continue;
    }
    const targets = occurrences.filter(
      (candidate) =>
        candidate.lockfile_path === occurrence.lockfile_path &&
        candidate.lock_path === occurrence.link_resolved_path &&
        !candidate.workspace_link &&
        candidate.relationship === "dependency" &&
        candidate.name === occurrence.name &&
        candidate.version !== null &&
        candidate.coordinate_id !== null
    );
    if (targets.length === 1) {
      occurrence.link_target_occurrence_id = targets[0]?.occurrence_id ?? null;
    } else {
      incompleteLinkLockfiles.add(occurrence.lockfile_path);
    }
  }
  for (const lock of parsedLocks) {
    if (incompleteLinkLockfiles.has(lock.document.path)) {
      lock.result.state = "partial";
      lock.result.error_code = "incomplete_occurrence";
    }
  }

  const manifestDeclarations: RawDeclaration[] = [];
  for (const manifest of parsedManifests) {
    if (manifest.result.state !== "supported") continue;
    const lock = nearestLock(
      manifest.document.project_path,
      manifest.document.ecosystem,
      parsedLocks
    );
    if (
      lock === undefined ||
      lock.result.state === "malformed" ||
      lock.result.state === "unsupported"
    )
      continue;
    const relativePath = relativeProjectPath(
      lock.document.project_path,
      manifest.document.project_path
    );
    const parentLockPath =
      manifest.document.ecosystem === "npm" && relativePath.length > 0 ? relativePath : null;
    for (const declaration of manifest.declarations) {
      if (declaration.ecosystem === "Packagist" && !composerPackageName(declaration.child_name))
        continue;
      manifestDeclarations.push(withManifestLineage(declaration, lock, parentLockPath));
    }
  }

  const manifestParentKeys = new Set(
    parsedManifests.flatMap((manifest) => {
      const lock = nearestLock(
        manifest.document.project_path,
        manifest.document.ecosystem,
        parsedLocks
      );
      if (lock === undefined) return [];
      const relativePath = relativeProjectPath(
        lock.document.project_path,
        manifest.document.project_path
      );
      return [
        `${lock.document.path}\0${manifest.document.ecosystem === "npm" ? relativePath : ""}`,
      ];
    })
  );
  const lockDeclarations = parsedLocks.flatMap((lock) =>
    lock.declarations.filter(
      (declaration) =>
        !manifestParentKeys.has(`${lock.document.path}\0${declaration.parent_lock_path ?? ""}`)
    )
  );
  const declarations = [...manifestDeclarations, ...lockDeclarations];
  if (declarations.length > MAX_EDGES) {
    throw new ScaDependencyInventoryV2Error("limit_exceeded", "dependency edge limit exceeded");
  }

  const edges: Edge[] = [];
  for (const declaration of declarations) {
    const lock = nearestLock(declaration.project_path, declaration.ecosystem, parsedLocks);
    if (lock === undefined) continue;
    edges.push(resolveDeclaration(input.source_snapshot_sha256, declaration, lock, occurrences));
  }
  edges.sort((left, right) => compareUtf8(left.edge_id, right.edge_id));
  if (new Set(edges.map((edge) => edge.edge_id)).size !== edges.length) {
    throw new ScaDependencyInventoryV2Error(
      "document_collision",
      "dependency edges are not unique"
    );
  }

  const constraintsByOccurrence = new Map<string, Constraint[]>();
  for (const edge of edges) {
    if (edge.ambiguity_status !== "unambiguous" || edge.child_occurrence_id === null) continue;
    const constraints = constraintsByOccurrence.get(edge.child_occurrence_id) ?? [];
    constraints.push({
      source_document_path: edge.source_document_path,
      source_json_pointer: edge.source_json_pointer,
      constraint: edge.constraint,
      scope: edge.scope,
    });
    constraintsByOccurrence.set(edge.child_occurrence_id, constraints);
  }
  for (const occurrence of occurrences) {
    const constraints = constraintsByOccurrence.get(occurrence.occurrence_id) ?? [];
    constraints.sort((left, right) =>
      compareUtf8(
        `${left.source_document_path}\0${left.source_json_pointer}\0${left.scope}\0${left.constraint}`,
        `${right.source_document_path}\0${right.source_json_pointer}\0${right.scope}\0${right.constraint}`
      )
    );
    occurrence.constraints = constraints;
  }

  const documentResults: DocumentResult[] = [];
  for (const manifest of parsedManifests) documentResults.push(manifest.result);
  for (const lock of parsedLocks) {
    const relatedEdges = edges.filter(
      (edge) =>
        edge.ecosystem === lock.document.ecosystem &&
        projectContainsProject(lock.document.project_path, edge.project_path)
    );
    documentResults.push(relationshipAdjustedResult(lock.result, relatedEdges));
  }
  documentResults.sort((left, right) =>
    compareUtf8(`${left.ecosystem}\0${left.path}`, `${right.ecosystem}\0${right.path}`)
  );

  const projectKeys = new Set(
    input.documents.map((document) => `${document.ecosystem}\0${document.project_path}`)
  );
  const projectResults: ProjectResult[] = [...projectKeys].sort(compareUtf8).map((key) => {
    const separator = key.indexOf("\0");
    const ecosystem: Ecosystem = key.slice(0, separator) === "npm" ? "npm" : "Packagist";
    const projectPath = key.slice(separator + 1);
    const manifest = parsedManifests.find(
      (candidate) =>
        candidate.document.ecosystem === ecosystem &&
        candidate.document.project_path === projectPath
    );
    const lock = nearestLock(projectPath, ecosystem, parsedLocks);
    const projectEdges = edges.filter(
      (edge) => edge.ecosystem === ecosystem && edge.project_path === projectPath
    );
    return {
      ecosystem,
      project_path: projectPath,
      state: aggregateProjectState(manifest, lock, projectEdges),
      manifest_path: manifest?.document.path ?? null,
      lockfile_path: lock?.document.path ?? null,
      occurrence_count: occurrences.filter(
        (occurrence) =>
          occurrence.ecosystem === ecosystem && occurrence.project_path === projectPath
      ).length,
      edge_count: projectEdges.length,
    };
  });

  const coordinateById = new Map<string, ScaDependencyCoordinateV2>();
  const occurrenceIdsByCoordinate = new Map<string, string[]>();
  for (const occurrence of occurrences) {
    if (
      occurrence.coordinate_id === null ||
      occurrence.name === null ||
      occurrence.version === null
    )
      continue;
    if (!coordinateById.has(occurrence.coordinate_id)) {
      coordinateById.set(occurrence.coordinate_id, {
        coordinate_id: occurrence.coordinate_id,
        ecosystem: occurrence.ecosystem,
        name: occurrence.name,
        version: occurrence.version,
        purl: purl(occurrence.ecosystem, occurrence.name, occurrence.version),
      });
    }
    const mapped = occurrenceIdsByCoordinate.get(occurrence.coordinate_id) ?? [];
    mapped.push(occurrence.occurrence_id);
    occurrenceIdsByCoordinate.set(occurrence.coordinate_id, mapped);
  }
  const coordinates = [...coordinateById.values()].sort((left, right) =>
    compareUtf8(left.coordinate_id, right.coordinate_id)
  );
  const coordinateOccurrences = coordinates.map((coordinate) => ({
    coordinate_id: coordinate.coordinate_id,
    occurrence_ids: [...(occurrenceIdsByCoordinate.get(coordinate.coordinate_id) ?? [])].sort(
      compareUtf8
    ),
  }));

  const ecosystems: EcosystemResult[] = [...input.ecosystems].sort(compareUtf8).map((ecosystem) => {
    const projects = projectResults.filter((project) => project.ecosystem === ecosystem);
    const ecosystemOccurrences = occurrences.filter(
      (occurrence) => occurrence.ecosystem === ecosystem
    );
    const ecosystemEdges = edges.filter((edge) => edge.ecosystem === ecosystem);
    return {
      ecosystem,
      state: aggregateEcosystemState(projects, ecosystemEdges),
      project_count: projects.length,
      occurrence_count: ecosystemOccurrences.length,
      coordinate_count: coordinates.filter((coordinate) => coordinate.ecosystem === ecosystem)
        .length,
      edge_count: ecosystemEdges.length,
    };
  });
  const status: ScaDependencyInventoryResultV2["status"] = ecosystems.some(
    (ecosystem) => ecosystem.state === "malformed"
  )
    ? "failed"
    : ecosystems.some(
          (ecosystem) => ecosystem.state === "partial" || ecosystem.state === "unsupported"
        )
      ? "partial"
      : "succeeded";
  const unsigned: UnsignedResult = {
    schema_id: SCA_DEPENDENCY_INVENTORY_RESULT_V2_SCHEMA,
    schema_version: 2,
    source_snapshot_sha256: input.source_snapshot_sha256,
    status,
    ecosystems,
    projects: projectResults,
    documents: documentResults,
    occurrences,
    edges,
    coordinates,
    coordinate_occurrences: coordinateOccurrences,
  };
  return validateContract(
    ScaDependencyInventoryResultV2Schema,
    { ...unsigned, inventory_sha256: digestInventory(unsigned) },
    "SCA dependency inventory v2 result"
  );
}

function semanticFailure(message: string): never {
  throw new ScaDependencyInventoryV2Error("semantic_mismatch", message);
}

function assertSortedUnique<T>(
  values: readonly T[],
  identity: (value: T) => string,
  label: string
): void {
  const identities = values.map(identity);
  if (new Set(identities).size !== identities.length) semanticFailure(`${label} are not unique`);
  const sorted = [...identities].sort(compareUtf8);
  if (canonicalJson(identities) !== canonicalJson(sorted))
    semanticFailure(`${label} are not ordered`);
}

export function validateScaDependencyInventoryResultV2(
  value: unknown,
  admittedInputValue: unknown
): ScaDependencyInventoryResultV2 {
  const result = validateContract(
    ScaDependencyInventoryResultV2Schema,
    value,
    "SCA dependency inventory v2 result"
  );
  const { inventory_sha256: observedDigest, ...unsigned } = result;
  if (digestInventory(unsigned) !== observedDigest) {
    throw new ScaDependencyInventoryV2Error(
      "invalid_input",
      "dependency inventory v2 digest mismatch"
    );
  }

  assertSortedUnique(result.ecosystems, (ecosystem) => ecosystem.ecosystem, "ecosystem aggregates");
  assertSortedUnique(
    result.projects,
    (project) => `${project.ecosystem}\0${project.project_path}`,
    "project aggregates"
  );
  assertSortedUnique(
    result.documents,
    (document) => `${document.ecosystem}\0${document.path}`,
    "document results"
  );
  assertSortedUnique(result.occurrences, (occurrence) => occurrence.occurrence_id, "occurrences");
  assertSortedUnique(result.edges, (edge) => edge.edge_id, "edges");
  assertSortedUnique(result.coordinates, (coordinate) => coordinate.coordinate_id, "coordinates");
  assertSortedUnique(
    result.coordinate_occurrences,
    (mapping) => mapping.coordinate_id,
    "coordinate mappings"
  );
  const occurrenceById = new Map(
    result.occurrences.map((occurrence) => [occurrence.occurrence_id, occurrence])
  );
  const coordinateById = new Map(
    result.coordinates.map((coordinate) => [coordinate.coordinate_id, coordinate])
  );
  const expectedCoordinateOccurrences = new Map<string, string[]>();
  for (const occurrence of result.occurrences) {
    const raw: RawOccurrence = {
      ecosystem: occurrence.ecosystem,
      project_path: occurrence.project_path,
      lockfile_path: occurrence.lockfile_path,
      lockfile_sha256: occurrence.lockfile_sha256,
      lock_path: occurrence.lock_path,
      source_json_pointer: occurrence.source_json_pointer,
      relationship: occurrence.relationship,
      name: occurrence.name,
      version: occurrence.version,
      scope: occurrence.scope,
      workspace_link: occurrence.workspace_link,
      link_resolved_path: occurrence.link_resolved_path,
    };
    if (occurrence.occurrence_id !== occurrenceId(result.source_snapshot_sha256, raw)) {
      semanticFailure("occurrence stable identity mismatch");
    }
    const expectedCoordinate =
      occurrence.relationship === "dependency" &&
      occurrence.name !== null &&
      occurrence.version !== null
        ? scaDependencyCoordinateIdV2(occurrence.ecosystem, occurrence.name, occurrence.version)
        : null;
    if (occurrence.coordinate_id !== expectedCoordinate)
      semanticFailure("occurrence coordinate mismatch");
    if (expectedCoordinate !== null) {
      const mapped = expectedCoordinateOccurrences.get(expectedCoordinate) ?? [];
      mapped.push(occurrence.occurrence_id);
      expectedCoordinateOccurrences.set(expectedCoordinate, mapped);
    }
  }
  for (const coordinate of result.coordinates) {
    if (
      coordinate.coordinate_id !==
        scaDependencyCoordinateIdV2(coordinate.ecosystem, coordinate.name, coordinate.version) ||
      coordinate.purl !== purl(coordinate.ecosystem, coordinate.name, coordinate.version)
    ) {
      semanticFailure("coordinate stable identity or purl mismatch");
    }
  }
  if (
    new Set(expectedCoordinateOccurrences.keys()).size !== coordinateById.size ||
    [...expectedCoordinateOccurrences.keys()].some((id) => !coordinateById.has(id))
  ) {
    semanticFailure("coordinate set does not equal occurrence-derived coordinates");
  }
  for (const mapping of result.coordinate_occurrences) {
    const expected = [...(expectedCoordinateOccurrences.get(mapping.coordinate_id) ?? [])].sort(
      compareUtf8
    );
    if (canonicalJson(mapping.occurrence_ids) !== canonicalJson(expected)) {
      semanticFailure("coordinate occurrence mapping mismatch");
    }
  }

  const constraintsByOccurrence = new Map<string, Constraint[]>();
  for (const edge of result.edges) {
    const { edge_id: observedEdgeId, ...edgeUnsigned } = edge;
    if (observedEdgeId !== edgeId(result.source_snapshot_sha256, edgeUnsigned)) {
      semanticFailure("edge stable identity mismatch");
    }
    if (new Set(edge.candidate_occurrence_ids).size !== edge.candidate_occurrence_ids.length) {
      semanticFailure("edge candidates are not unique");
    }
    if (
      canonicalJson(edge.candidate_occurrence_ids) !==
      canonicalJson([...edge.candidate_occurrence_ids].sort(compareUtf8))
    ) {
      semanticFailure("edge candidates are not ordered");
    }
    if (edge.parent_kind === "occurrence") {
      if (
        edge.parent_occurrence_id === null ||
        !occurrenceById.has(edge.parent_occurrence_id) ||
        edge.parent_id !== edge.parent_occurrence_id
      ) {
        semanticFailure("edge parent occurrence mapping mismatch");
      }
    } else if (
      edge.parent_occurrence_id !== null ||
      edge.parent_id !==
        rootId(
          result.source_snapshot_sha256,
          edge.ecosystem,
          edge.project_path,
          edge.source_document_path
        )
    ) {
      semanticFailure("edge project-root identity mismatch");
    }
    const candidatesExist = edge.candidate_occurrence_ids.every((id) => occurrenceById.has(id));
    if (!candidatesExist) semanticFailure("edge candidate references an unknown occurrence");
    if (edge.ambiguity_status === "unambiguous") {
      if (
        edge.diagnostic_code !== "none" ||
        edge.candidate_occurrence_ids.length !== 1 ||
        edge.child_occurrence_id !== edge.candidate_occurrence_ids[0]
      ) {
        semanticFailure("unambiguous edge mapping mismatch");
      }
      const childId = edge.child_occurrence_id;
      if (childId === null) semanticFailure("unambiguous edge has no child");
      if (occurrenceById.get(childId)?.name !== edge.child_name) {
        semanticFailure("unambiguous edge child name mismatch");
      }
      const constraints = constraintsByOccurrence.get(childId) ?? [];
      constraints.push({
        source_document_path: edge.source_document_path,
        source_json_pointer: edge.source_json_pointer,
        constraint: edge.constraint,
        scope: edge.scope,
      });
      constraintsByOccurrence.set(childId, constraints);
    } else if (
      edge.child_occurrence_id !== null ||
      (edge.ambiguity_status === "ambiguous" &&
        (edge.diagnostic_code !== "ambiguous_target" ||
          edge.candidate_occurrence_ids.length < 2)) ||
      (edge.ambiguity_status === "unresolved" &&
        (edge.diagnostic_code !== "unresolved_target" ||
          edge.candidate_occurrence_ids.length !== 0))
    ) {
      semanticFailure("partial edge ambiguity mapping mismatch");
    }
  }
  for (const occurrence of result.occurrences) {
    const expected = constraintsByOccurrence.get(occurrence.occurrence_id) ?? [];
    expected.sort((left, right) =>
      compareUtf8(
        `${left.source_document_path}\0${left.source_json_pointer}\0${left.scope}\0${left.constraint}`,
        `${right.source_document_path}\0${right.source_json_pointer}\0${right.scope}\0${right.constraint}`
      )
    );
    if (canonicalJson(occurrence.constraints) !== canonicalJson(expected)) {
      semanticFailure("occurrence constraints do not equal resolved incoming edges");
    }
  }

  const expectedDocumentCounts = new Map<string, number>();
  for (const occurrence of result.occurrences) {
    expectedDocumentCounts.set(
      occurrence.lockfile_path,
      (expectedDocumentCounts.get(occurrence.lockfile_path) ?? 0) + 1
    );
  }
  for (const document of result.documents) {
    const expected =
      document.role === "lockfile" ? (expectedDocumentCounts.get(document.path) ?? 0) : 0;
    if (document.occurrence_count !== expected)
      semanticFailure("document occurrence count mismatch");
  }
  for (const project of result.projects) {
    const expectedOccurrences = result.occurrences.filter(
      (occurrence) =>
        occurrence.ecosystem === project.ecosystem &&
        occurrence.project_path === project.project_path
    ).length;
    const projectEdges = result.edges.filter(
      (edge) => edge.ecosystem === project.ecosystem && edge.project_path === project.project_path
    );
    const manifest =
      project.manifest_path === null
        ? undefined
        : result.documents.find(
            (document) =>
              document.ecosystem === project.ecosystem &&
              document.path === project.manifest_path &&
              document.role === "manifest"
          );
    const lock =
      project.lockfile_path === null
        ? undefined
        : result.documents.find(
            (document) =>
              document.ecosystem === project.ecosystem &&
              document.path === project.lockfile_path &&
              document.role === "lockfile"
          );
    const lockRelationshipOnlyPartial =
      lock?.error_code === "ambiguous_relationship" ||
      lock?.error_code === "unresolved_relationship";
    const expectedState: ProjectResult["state"] =
      manifest?.state === "malformed" || lock?.state === "malformed"
        ? "malformed"
        : lock?.state === "unsupported"
          ? "unsupported"
          : manifest === undefined || lock === undefined
            ? "partial"
            : manifest.state === "partial" ||
                (lock.state === "partial" && !lockRelationshipOnlyPartial) ||
                projectEdges.some((edge) => edge.ambiguity_status !== "unambiguous")
              ? "partial"
              : "supported";
    if (
      project.occurrence_count !== expectedOccurrences ||
      project.edge_count !== projectEdges.length ||
      project.state !== expectedState
    ) {
      semanticFailure("project aggregate count or state mismatch");
    }
  }
  for (const ecosystem of result.ecosystems) {
    const projects = result.projects.filter((project) => project.ecosystem === ecosystem.ecosystem);
    const occurrences = result.occurrences.filter(
      (occurrence) => occurrence.ecosystem === ecosystem.ecosystem
    );
    const coordinates = result.coordinates.filter(
      (coordinate) => coordinate.ecosystem === ecosystem.ecosystem
    );
    const edges = result.edges.filter((edge) => edge.ecosystem === ecosystem.ecosystem);
    if (
      ecosystem.project_count !== projects.length ||
      ecosystem.occurrence_count !== occurrences.length ||
      ecosystem.coordinate_count !== coordinates.length ||
      ecosystem.edge_count !== edges.length ||
      ecosystem.state !== aggregateEcosystemState(projects, edges)
    ) {
      semanticFailure("ecosystem aggregate or status mismatch");
    }
  }
  const expectedStatus: ScaDependencyInventoryResultV2["status"] = result.ecosystems.some(
    (ecosystem) => ecosystem.state === "malformed"
  )
    ? "failed"
    : result.ecosystems.some(
          (ecosystem) => ecosystem.state === "partial" || ecosystem.state === "unsupported"
        )
      ? "partial"
      : "succeeded";
  if (result.status !== expectedStatus) semanticFailure("inventory status mismatch");
  const rebuilt = buildScaDependencyInventoryV2(admittedInputValue);
  if (canonicalJson(result) !== canonicalJson(rebuilt)) {
    semanticFailure("dependency inventory does not equal the deterministic admitted-input rebuild");
  }
  return result;
}
