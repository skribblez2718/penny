import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import PHP from "tree-sitter-php";
import TypeScript from "tree-sitter-typescript";
import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../../orchestration/dist/contracts.js";
import { Sha256Schema } from "../../../orchestration/dist/skill-contracts/common.js";

const MAX_FILES = 100_000;
const MAX_PATH_BYTES = 4_096;
const MAX_SOURCE_BYTES = 1_073_741_824;
const MAX_NODES = 10_000_000;
const MAX_DEPTH = 100_000;
const MAX_DIAGNOSTICS = 1_024;
const MAX_SYMBOLS = 1_000_000;
const MAX_NAME_BYTES = 4_096;
const MAX_TEXT_BYTES = 4_096;
const MAX_TIMEOUT_MICROS = 300_000_000;
const MAX_QUERY_MATCH_LIMIT = 1_000_000;

const TREE_SITTER_VERSION = "0.21.1";
const GRAMMAR_VERSIONS = Object.freeze({
  javascript: "0.23.1",
  php: "0.23.11",
  typescript: "0.23.2",
});

/**
 * This v2 index slice is inactive and unreleased. Its schemas, producers, validators, exports, and
 * tests are updated atomically, so the existing v2 IDs are intentionally retained until activation.
 */
export const SCA_TREE_SITTER_INDEX_INPUT_V2_SCHEMA = "penny.sca-tree-sitter-index-input.v2";
export const SCA_TREE_SITTER_INDEX_RESULT_V2_SCHEMA = "penny.sca-tree-sitter-index-result.v2";

const SUPPORTED_LANGUAGES = Object.freeze([
  "php",
  "javascript",
  "jsx",
  "typescript",
  "tsx",
] as const);

type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const COMMON_ECMASCRIPT_QUERY = `(function_declaration name: (identifier) @definition.function)
(method_definition name: (property_identifier) @definition.method)
(variable_declarator name: (identifier) @definition.variable)
(variable_declarator name: (object_pattern (pair_pattern value: (identifier) @definition.variable)))
(variable_declarator name: (object_pattern (shorthand_property_identifier_pattern) @definition.variable))
(variable_declarator name: (array_pattern (identifier) @definition.variable))
(import_clause (identifier) @definition.import)
(import_specifier name: (identifier) @reference.import alias: (identifier) @definition.import)
(import_specifier name: (identifier) @definition.import !alias)
(call_expression function: (identifier) @reference.call)
(new_expression constructor: (identifier) @reference.construct)
(member_expression property: (property_identifier) @reference.member)`;

const JAVASCRIPT_QUERY = `${COMMON_ECMASCRIPT_QUERY}
(class_declaration name: (identifier) @definition.class)`;

const JSX_QUERY = `(jsx_opening_element name: (identifier) @reference.component)
(jsx_self_closing_element name: (identifier) @reference.component)`;

const TYPESCRIPT_QUERY = `${COMMON_ECMASCRIPT_QUERY}
(class_declaration name: (type_identifier) @definition.class)
(interface_declaration name: (type_identifier) @definition.interface)
(type_alias_declaration name: (type_identifier) @definition.type)
(enum_declaration name: (identifier) @definition.enum)
(extends_type_clause type: (type_identifier) @reference.type)
(implements_clause (type_identifier) @reference.type)
(type_alias_declaration value: (type_identifier) @reference.type)
(type_annotation (type_identifier) @reference.type)
(generic_type name: (type_identifier) @reference.type)
(type_arguments (type_identifier) @reference.type)`;

const PHP_QUERY = `(function_definition name: (name) @definition.function)
(class_declaration name: (name) @definition.class)
(interface_declaration name: (name) @definition.interface)
(trait_declaration name: (name) @definition.trait)
(method_declaration name: (name) @definition.method)
(namespace_use_clause (qualified_name) @reference.import alias: (name) @definition.import)
(namespace_use_clause (qualified_name) @definition.import !alias)
(function_call_expression function: [(name) (qualified_name)] @reference.call)
(object_creation_expression [(name) (qualified_name)] @reference.construct)
(member_call_expression name: (name) @reference.member)
(member_access_expression name: (name) @reference.member)
(scoped_call_expression scope: [(name) (qualified_name)] @reference.type name: (name) @reference.member)
(base_clause [(name) (qualified_name)] @reference.type)
(class_interface_clause [(name) (qualified_name)] @reference.type)
(named_type [(name) (qualified_name)] @reference.type)`;

const CAPTURE_COVERAGE = Object.freeze([
  "declarations:function,class,interface,trait,method,type,enum,variable",
  "imports:default,named,aliased,and-php-namespace-use",
  "references:direct-call,constructor,member,component,and-contextual-type",
  "destructuring:direct-object-pair,object-shorthand,and-array-identifier-bindings",
  "php:qualified-call,construct,inheritance,type,and-static-scope-names",
] as const);
const CAPTURE_LIMITATIONS = Object.freeze([
  "syntactic-index-only:no-cross-file-or-runtime-binding-resolution",
  "computed-or-dynamic-call-and-member-names-are-not-captured",
  "nested-or-rest-destructuring-beyond-direct-identifier-leaves-is-not-complete",
  "complex-php-group-use-and-dynamic-class-name-forms-are-not-complete",
] as const);
const CAPTURE_PROFILE_ID = "tree-sitter-contextual-captures-v1";

const SourceRangeV2Schema = Type.Object(
  {
    start_byte: Type.Integer({ minimum: 0, maximum: MAX_SOURCE_BYTES }),
    end_byte: Type.Integer({ minimum: 0, maximum: MAX_SOURCE_BYTES }),
    start_line: Type.Integer({ minimum: 1 }),
    start_column_utf16: Type.Integer({ minimum: 1 }),
    end_line: Type.Integer({ minimum: 1 }),
    end_column_utf16: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);

const InstalledPackageIdentityV2Schema = Type.Object(
  {
    package_name: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    package_json_sha256: Sha256Schema,
    javascript_entrypoint_sha256: Sha256Schema,
    native_binding_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const GrammarIdentityV2Schema = Type.Object(
  {
    language: Type.Union([
      Type.Literal("php"),
      Type.Literal("javascript"),
      Type.Literal("jsx"),
      Type.Literal("typescript"),
      Type.Literal("tsx"),
    ]),
    package_name: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    package_json_sha256: Sha256Schema,
    javascript_entrypoint_sha256: Sha256Schema,
    native_binding_sha256: Sha256Schema,
    query_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const CaptureProfileV2Schema = Type.Object(
  {
    profile_id: Type.Literal(CAPTURE_PROFILE_ID),
    coverage: Type.Array(Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }), {
      minItems: CAPTURE_COVERAGE.length,
      maxItems: CAPTURE_COVERAGE.length,
    }),
    limitations: Type.Array(Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }), {
      minItems: CAPTURE_LIMITATIONS.length,
      maxItems: CAPTURE_LIMITATIONS.length,
    }),
    profile_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaTreeSitterToolIdentityV2Schema = Type.Object(
  {
    runtime: InstalledPackageIdentityV2Schema,
    grammars: Type.Array(GrammarIdentityV2Schema, {
      minItems: SUPPORTED_LANGUAGES.length,
      maxItems: SUPPORTED_LANGUAGES.length,
    }),
    implementation_sha256: Sha256Schema,
    capture_profile_sha256: Sha256Schema,
    indexer_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ScaTreeSitterSourceV2Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    encoding: Type.Literal("base64"),
    content_base64: Type.String({ maxLength: Math.ceil((MAX_SOURCE_BYTES * 4) / 3) + 4 }),
    byte_count: Type.Integer({ minimum: 0, maximum: MAX_SOURCE_BYTES }),
    source_sha256: Sha256Schema,
    admitted_language: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9_-]*$",
    }),
  },
  { additionalProperties: false }
);

const ScaTreeSitterLimitsV2Schema = Type.Object(
  {
    max_files: Type.Integer({ minimum: 1, maximum: MAX_FILES }),
    max_source_bytes_per_file: Type.Integer({ minimum: 1, maximum: MAX_SOURCE_BYTES }),
    max_total_source_bytes: Type.Integer({ minimum: 1, maximum: MAX_SOURCE_BYTES }),
    max_nodes_per_file: Type.Integer({ minimum: 1, maximum: MAX_NODES }),
    max_depth: Type.Integer({ minimum: 1, maximum: MAX_DEPTH }),
    max_diagnostics_per_file: Type.Integer({ minimum: 1, maximum: MAX_DIAGNOSTICS }),
    max_symbols_per_file: Type.Integer({ minimum: 1, maximum: MAX_SYMBOLS }),
    parse_timeout_micros: Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MICROS }),
    query_match_limit: Type.Integer({ minimum: 1, maximum: MAX_QUERY_MATCH_LIMIT }),
  },
  { additionalProperties: false }
);

export const ScaTreeSitterIndexInputV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_TREE_SITTER_INDEX_INPUT_V2_SCHEMA),
    schema_version: Type.Literal(2),
    source_snapshot_sha256: Sha256Schema,
    tool: ScaTreeSitterToolIdentityV2Schema,
    limits: ScaTreeSitterLimitsV2Schema,
    files: Type.Array(ScaTreeSitterSourceV2Schema, { maxItems: MAX_FILES }),
  },
  { additionalProperties: false }
);

const ScaTreeSitterDiagnosticV2Schema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_]*$" }),
    message: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
    range: Type.Union([SourceRangeV2Schema, Type.Null()]),
  },
  { additionalProperties: false }
);

const ScaTreeSitterSymbolV2Schema = Type.Object(
  {
    record_id: Type.String({ pattern: "^(sym|ref)_[a-f0-9]{64}$" }),
    record_kind: Type.Union([Type.Literal("definition"), Type.Literal("reference")]),
    symbol_kind: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" }),
    name: Type.String({ minLength: 1, maxLength: MAX_NAME_BYTES }),
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    source_sha256: Sha256Schema,
    range: SourceRangeV2Schema,
  },
  { additionalProperties: false }
);

const ScaTreeSitterFileV2Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    source_sha256: Sha256Schema,
    byte_count: Type.Integer({ minimum: 0, maximum: MAX_SOURCE_BYTES }),
    admitted_language: Type.String({ minLength: 1, maxLength: 64 }),
    status: Type.Union([
      Type.Literal("parsed"),
      Type.Literal("parse_gap"),
      Type.Literal("unsupported"),
      Type.Literal("malformed"),
      Type.Literal("limit_exceeded"),
      Type.Literal("failed"),
    ]),
    named_nodes: Type.Integer({ minimum: 0, maximum: MAX_NODES }),
    error_nodes: Type.Integer({ minimum: 0, maximum: MAX_NODES }),
    missing_nodes: Type.Integer({ minimum: 0, maximum: MAX_NODES }),
    max_depth: Type.Integer({ minimum: 0, maximum: MAX_DEPTH }),
    truncated: Type.Boolean(),
    diagnostics: Type.Array(ScaTreeSitterDiagnosticV2Schema, { maxItems: MAX_DIAGNOSTICS }),
    symbols: Type.Array(ScaTreeSitterSymbolV2Schema, { maxItems: MAX_SYMBOLS }),
  },
  { additionalProperties: false }
);

export const ScaTreeSitterIndexResultV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_TREE_SITTER_INDEX_RESULT_V2_SCHEMA),
    schema_version: Type.Literal(2),
    source_snapshot_sha256: Sha256Schema,
    tool: ScaTreeSitterToolIdentityV2Schema,
    capture_profile: CaptureProfileV2Schema,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("partial"),
      Type.Literal("unsupported"),
      Type.Literal("failed"),
    ]),
    files: Type.Array(ScaTreeSitterFileV2Schema, { maxItems: MAX_FILES }),
    counts: Type.Object(
      {
        observed: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        parsed: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        parse_gap: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        unsupported: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        malformed: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        limit_exceeded: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        failed: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        truncated: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        named_nodes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        error_nodes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        missing_nodes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        definitions: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        references: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: false }
    ),
    index_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaTreeSitterToolIdentityV2 = Static<typeof ScaTreeSitterToolIdentityV2Schema>;
export type ScaTreeSitterIndexInputV2 = Static<typeof ScaTreeSitterIndexInputV2Schema>;
export type ScaTreeSitterIndexResultV2 = Static<typeof ScaTreeSitterIndexResultV2Schema>;

type SourceFile = ScaTreeSitterIndexInputV2["files"][number];
type FileResult = ScaTreeSitterIndexResultV2["files"][number];
type SymbolRecord = FileResult["symbols"][number];
type SourceRange = SymbolRecord["range"];
type CaptureProfile = ScaTreeSitterIndexResultV2["capture_profile"];
type UnsignedResult = Omit<ScaTreeSitterIndexResultV2, "index_sha256">;

export class ScaTreeSitterIndexError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unsafe_path"
      | "path_collision"
      | "source_mismatch"
      | "tool_identity_mismatch"
      | "limit_exceeded"
      | "semantic_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaTreeSitterIndexError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validateCanonicalPath(candidate: string): void {
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
    throw new ScaTreeSitterIndexError("unsafe_path", "source path is not canonical");
  }
}

function queryFor(language: SupportedLanguage): string {
  switch (language) {
    case "php":
      return PHP_QUERY;
    case "javascript":
      return JAVASCRIPT_QUERY;
    case "jsx":
      return `${JAVASCRIPT_QUERY}\n${JSX_QUERY}`;
    case "typescript":
      return TYPESCRIPT_QUERY;
    case "tsx":
      return `${TYPESCRIPT_QUERY}\n${JSX_QUERY}`;
  }
}

function languageIsSupported(value: string): value is SupportedLanguage {
  return SUPPORTED_LANGUAGES.some((language) => language === value);
}

function grammarFor(language: SupportedLanguage): unknown {
  switch (language) {
    case "php":
      return PHP.php;
    case "javascript":
    case "jsx":
      return JavaScript;
    case "typescript":
      return TypeScript.typescript;
    case "tsx":
      return TypeScript.tsx;
  }
}

function packageNameFor(language: SupportedLanguage): string {
  switch (language) {
    case "php":
      return "tree-sitter-php";
    case "javascript":
    case "jsx":
      return "tree-sitter-javascript";
    case "typescript":
    case "tsx":
      return "tree-sitter-typescript";
  }
}

function expectedGrammarVersion(language: SupportedLanguage): string {
  switch (language) {
    case "php":
      return GRAMMAR_VERSIONS.php;
    case "javascript":
    case "jsx":
      return GRAMMAR_VERSIONS.javascript;
    case "typescript":
    case "tsx":
      return GRAMMAR_VERSIONS.typescript;
  }
}

const require = createRequire(import.meta.url);

function packageRoot(packageName: string): { readonly root: string; readonly packageJson: Buffer } {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const root = realpathSync(dirname(packageJsonPath));
  const packageJson = readFileSync(packageJsonPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson.toString("utf8"));
  } catch {
    throw new ScaTreeSitterIndexError(
      "tool_identity_mismatch",
      "installed package metadata is invalid"
    );
  }
  if (!isRecord(parsed) || parsed.name !== packageName || typeof parsed.version !== "string") {
    throw new ScaTreeSitterIndexError(
      "tool_identity_mismatch",
      "installed package metadata is inconsistent"
    );
  }
  return { root, packageJson };
}

function containedFile(root: string, candidate: string, label: string): Buffer {
  const selected = realpathSync(candidate);
  const relativePath = relative(root, selected);
  if (
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath) ||
    resolve(root, relativePath) !== selected ||
    !statSync(selected).isFile()
  ) {
    throw new ScaTreeSitterIndexError(
      "tool_identity_mismatch",
      `${label} escaped its installed package`
    );
  }
  return readFileSync(selected);
}

function javascriptEntrypoint(root: string, packageName: string): Buffer {
  return containedFile(root, require.resolve(packageName), "JavaScript entrypoint");
}

function nativeBinding(root: string): Buffer {
  const prebuildDirectory = join(root, "prebuilds", `${process.platform}-${process.arch}`);
  let candidates: string[] = [];
  try {
    candidates = readdirSync(prebuildDirectory)
      .filter((entry) => entry.endsWith(".node"))
      .map((entry) => join(prebuildDirectory, entry));
  } catch {
    candidates = [];
  }
  for (const fallback of [
    join(root, "build", "Release", "tree_sitter_runtime_binding.node"),
    join(root, "build", "Release", "tree_sitter_binding.node"),
  ]) {
    try {
      if (statSync(fallback).isFile()) candidates.push(fallback);
    } catch {
      // A package using prebuilds does not have local build output.
    }
  }
  const unique = [...new Set(candidates.map((candidate) => realpathSync(candidate)))];
  if (unique.length !== 1) {
    throw new ScaTreeSitterIndexError(
      "tool_identity_mismatch",
      "installed package must resolve exactly one native binding"
    );
  }
  const selected = unique[0];
  if (selected === undefined) {
    throw new ScaTreeSitterIndexError("tool_identity_mismatch", "native binding is unavailable");
  }
  return containedFile(root, selected, "native binding");
}

function installedPackageIdentity(packageName: string, expectedVersion: string) {
  const installed = packageRoot(packageName);
  const parsed: unknown = JSON.parse(installed.packageJson.toString("utf8"));
  if (!isRecord(parsed) || parsed.version !== expectedVersion) {
    throw new ScaTreeSitterIndexError(
      "tool_identity_mismatch",
      `${packageName} does not match the pinned compatible version`
    );
  }
  return {
    package_name: packageName,
    version: expectedVersion,
    package_json_sha256: sha256(installed.packageJson),
    javascript_entrypoint_sha256: sha256(javascriptEntrypoint(installed.root, packageName)),
    native_binding_sha256: sha256(nativeBinding(installed.root)),
  };
}

function captureProfile(): CaptureProfile {
  const unsigned = {
    profile_id: CAPTURE_PROFILE_ID,
    coverage: [...CAPTURE_COVERAGE],
    limitations: [...CAPTURE_LIMITATIONS],
  };
  return validateContract(
    CaptureProfileV2Schema,
    { ...unsigned, profile_sha256: sha256(canonicalJson(unsigned)) },
    "Tree-sitter capture profile"
  );
}

function indexerDigest(value: Omit<ScaTreeSitterToolIdentityV2, "indexer_sha256">): string {
  return sha256(canonicalJson(value));
}

export function inspectInstalledTreeSitterIdentitiesV2(
  implementationSourcePath = fileURLToPath(import.meta.url)
): ScaTreeSitterToolIdentityV2 {
  const runtime = installedPackageIdentity("tree-sitter", TREE_SITTER_VERSION);
  const packageIdentities = new Map<string, ReturnType<typeof installedPackageIdentity>>();
  const grammars = SUPPORTED_LANGUAGES.map((language) => {
    const packageName = packageNameFor(language);
    let packageIdentity = packageIdentities.get(packageName);
    if (packageIdentity === undefined) {
      packageIdentity = installedPackageIdentity(packageName, expectedGrammarVersion(language));
      packageIdentities.set(packageName, packageIdentity);
    }
    return {
      language,
      ...packageIdentity,
      query_sha256: sha256(Buffer.from(queryFor(language), "utf8")),
    };
  });
  const profile = captureProfile();
  const unsigned = {
    runtime,
    grammars,
    implementation_sha256: sha256(readFileSync(implementationSourcePath)),
    capture_profile_sha256: profile.profile_sha256,
  };
  return validateContract(
    ScaTreeSitterToolIdentityV2Schema,
    { ...unsigned, indexer_sha256: indexerDigest(unsigned) },
    "installed Tree-sitter identity"
  );
}

function exactBase64(file: SourceFile): Buffer {
  const bytes = Buffer.from(file.content_base64, "base64");
  if (
    bytes.toString("base64") !== file.content_base64 ||
    bytes.byteLength !== file.byte_count ||
    sha256(bytes) !== file.source_sha256
  ) {
    throw new ScaTreeSitterIndexError(
      "source_mismatch",
      `source bytes are not exact for '${file.path}'`
    );
  }
  return bytes;
}

function rangeFor(source: string, node: Parser.SyntaxNode): SourceRange {
  return {
    start_byte: Buffer.byteLength(source.slice(0, node.startIndex), "utf8"),
    end_byte: Buffer.byteLength(source.slice(0, node.endIndex), "utf8"),
    start_line: node.startPosition.row + 1,
    start_column_utf16: node.startPosition.column + 1,
    end_line: node.endPosition.row + 1,
    end_column_utf16: node.endPosition.column + 1,
  };
}

function diagnostic(
  code: string,
  message: string,
  range: SourceRange | null
): FileResult["diagnostics"][number] {
  return { code, message, range };
}

function emptyFileResult(
  file: SourceFile,
  status: "unsupported" | "malformed" | "failed",
  code: string,
  message: string
): FileResult {
  return {
    path: file.path,
    source_sha256: file.source_sha256,
    byte_count: file.byte_count,
    admitted_language: file.admitted_language,
    status,
    named_nodes: 0,
    error_nodes: 0,
    missing_nodes: 0,
    max_depth: 0,
    truncated: false,
    diagnostics: [diagnostic(code, message, null)],
    symbols: [],
  };
}

function symbolRecordId(
  sourceSnapshotSha256: string,
  record: Omit<SymbolRecord, "record_id">
): string {
  const prefix = record.record_kind === "definition" ? "sym" : "ref";
  return `${prefix}_${sha256(
    canonicalJson({
      source_snapshot_sha256: sourceSnapshotSha256,
      record_kind: record.record_kind,
      symbol_kind: record.symbol_kind,
      name: record.name,
      path: record.path,
      source_sha256: record.source_sha256,
      range: record.range,
    })
  )}`;
}

function symbolRecords(
  input: ScaTreeSitterIndexInputV2,
  file: SourceFile,
  language: SupportedLanguage,
  source: string,
  root: Parser.SyntaxNode
): { readonly records: SymbolRecord[]; readonly truncated: boolean } {
  const query = new Parser.Query(grammarFor(language), queryFor(language));
  const captures = query.captures(root, { matchLimit: input.limits.query_match_limit });
  const records: SymbolRecord[] = [];
  let truncated = query.didExceedMatchLimit();
  for (const capture of captures) {
    if (records.length >= input.limits.max_symbols_per_file) {
      truncated = true;
      break;
    }
    const separatorIndex = capture.name.indexOf(".");
    if (separatorIndex < 1 || separatorIndex === capture.name.length - 1) continue;
    const recordKind = capture.name.slice(0, separatorIndex);
    if (recordKind !== "definition" && recordKind !== "reference") continue;
    const name = capture.node.text;
    if (name.length === 0 || Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) {
      truncated = true;
      continue;
    }
    const unsigned: Omit<SymbolRecord, "record_id"> = {
      record_kind: recordKind,
      symbol_kind: capture.name.slice(separatorIndex + 1).replaceAll(".", "_"),
      name,
      path: file.path,
      source_sha256: file.source_sha256,
      range: rangeFor(source, capture.node),
    };
    records.push({
      record_id: symbolRecordId(input.source_snapshot_sha256, unsigned),
      ...unsigned,
    });
  }
  records.sort((left, right) =>
    compareUtf8(
      `${left.range.start_byte.toString().padStart(12, "0")}\0${left.record_id}`,
      `${right.range.start_byte.toString().padStart(12, "0")}\0${right.record_id}`
    )
  );
  return { records, truncated };
}

function parseFile(input: ScaTreeSitterIndexInputV2, file: SourceFile, bytes: Buffer): FileResult {
  if (!languageIsSupported(file.admitted_language)) {
    return emptyFileResult(
      file,
      "unsupported",
      "unsupported_language",
      "the admitted language has no configured grammar"
    );
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return emptyFileResult(file, "malformed", "invalid_utf8", "source is not strict UTF-8");
  }

  const parser = new Parser();
  parser.setLanguage(grammarFor(file.admitted_language));
  parser.setTimeoutMicros(input.limits.parse_timeout_micros);
  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch {
    return emptyFileResult(
      file,
      "failed",
      "parser_failed",
      "Tree-sitter could not parse the source"
    );
  }

  const diagnostics: FileResult["diagnostics"][number][] = [];
  const stack: Array<{ readonly node: Parser.SyntaxNode; readonly depth: number }> = [
    { node: tree.rootNode, depth: 0 },
  ];
  let visited = 0;
  let namedNodes = 0;
  let errorNodes = 0;
  let missingNodes = 0;
  let maxDepth = 0;
  let truncated = false;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (visited >= input.limits.max_nodes_per_file) {
      truncated = true;
      break;
    }
    visited += 1;
    if (current.node.isNamed) namedNodes += 1;
    if (current.node.isError) errorNodes += 1;
    if (current.node.isMissing) missingNodes += 1;
    if (current.depth > maxDepth) maxDepth = current.depth;
    if (
      (current.node.isError || current.node.isMissing) &&
      diagnostics.length < input.limits.max_diagnostics_per_file
    ) {
      diagnostics.push(
        diagnostic(
          current.node.isMissing ? "missing_node" : "parse_error",
          current.node.isMissing
            ? "Tree-sitter reported a missing node"
            : "Tree-sitter reported an error node",
          rangeFor(source, current.node)
        )
      );
    }
    if (current.depth >= input.limits.max_depth) {
      if (current.node.childCount > 0) truncated = true;
      continue;
    }
    for (let index = current.node.childCount - 1; index >= 0; index -= 1) {
      const child = current.node.child(index);
      if (child !== null) stack.push({ node: child, depth: current.depth + 1 });
    }
  }
  if (
    errorNodes + missingNodes > diagnostics.length &&
    diagnostics.length >= input.limits.max_diagnostics_per_file
  ) {
    truncated = true;
  }

  let symbols: SymbolRecord[] = [];
  if (!truncated) {
    try {
      const indexed = symbolRecords(input, file, file.admitted_language, source, tree.rootNode);
      symbols = indexed.records;
      truncated = indexed.truncated;
    } catch {
      diagnostics.push(
        diagnostic("query_failed", "the capture query could not be completed", null)
      );
      return {
        path: file.path,
        source_sha256: file.source_sha256,
        byte_count: file.byte_count,
        admitted_language: file.admitted_language,
        status: "failed",
        named_nodes: namedNodes,
        error_nodes: errorNodes,
        missing_nodes: missingNodes,
        max_depth: maxDepth,
        truncated: false,
        diagnostics,
        symbols: [],
      };
    }
  }
  if (truncated && diagnostics.length < input.limits.max_diagnostics_per_file) {
    diagnostics.push(
      diagnostic("index_limit", "syntax or symbol indexing reached an admitted limit", null)
    );
  }

  return {
    path: file.path,
    source_sha256: file.source_sha256,
    byte_count: file.byte_count,
    admitted_language: file.admitted_language,
    status: truncated
      ? "limit_exceeded"
      : errorNodes > 0 || missingNodes > 0
        ? "parse_gap"
        : "parsed",
    named_nodes: namedNodes,
    error_nodes: errorNodes,
    missing_nodes: missingNodes,
    max_depth: maxDepth,
    truncated,
    diagnostics,
    symbols,
  };
}

function checkedTotal(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new ScaTreeSitterIndexError("limit_exceeded", `${label} is not a safe integer`);
    }
  }
  return total;
}

function resultStatus(files: readonly FileResult[]): ScaTreeSitterIndexResultV2["status"] {
  if (files.length === 0) return "succeeded";
  if (files.every((file) => file.status === "unsupported")) return "unsupported";
  if (files.every((file) => file.status === "failed" || file.status === "malformed")) {
    return "failed";
  }
  if (files.every((file) => file.status === "parsed")) return "succeeded";
  return "partial";
}

function resultCounts(files: readonly FileResult[]): ScaTreeSitterIndexResultV2["counts"] {
  return {
    observed: files.length,
    parsed: files.filter((file) => file.status === "parsed").length,
    parse_gap: files.filter((file) => file.status === "parse_gap").length,
    unsupported: files.filter((file) => file.status === "unsupported").length,
    malformed: files.filter((file) => file.status === "malformed").length,
    limit_exceeded: files.filter((file) => file.status === "limit_exceeded").length,
    failed: files.filter((file) => file.status === "failed").length,
    truncated: files.filter((file) => file.truncated).length,
    named_nodes: checkedTotal(
      files.map((file) => file.named_nodes),
      "named-node count"
    ),
    error_nodes: checkedTotal(
      files.map((file) => file.error_nodes),
      "error-node count"
    ),
    missing_nodes: checkedTotal(
      files.map((file) => file.missing_nodes),
      "missing-node count"
    ),
    definitions: checkedTotal(
      files.map(
        (file) => file.symbols.filter((symbol) => symbol.record_kind === "definition").length
      ),
      "definition count"
    ),
    references: checkedTotal(
      files.map(
        (file) => file.symbols.filter((symbol) => symbol.record_kind === "reference").length
      ),
      "reference count"
    ),
  };
}

function digestResult(value: UnsignedResult): string {
  return sha256(canonicalJson(value));
}

export function buildScaTreeSitterIndexV2(
  value: unknown,
  implementationSourcePath?: string
): ScaTreeSitterIndexResultV2 {
  let input: ScaTreeSitterIndexInputV2;
  try {
    input = validateContract(ScaTreeSitterIndexInputV2Schema, value, "SCA Tree-sitter index input");
  } catch (error) {
    throw new ScaTreeSitterIndexError(
      "invalid_input",
      error instanceof Error ? error.message : "Tree-sitter index input is invalid"
    );
  }
  if (input.files.length > input.limits.max_files) {
    throw new ScaTreeSitterIndexError(
      "limit_exceeded",
      "source file count exceeds the admitted limit"
    );
  }
  const installedIdentity = inspectInstalledTreeSitterIdentitiesV2(implementationSourcePath);
  if (canonicalJson(input.tool) !== canonicalJson(installedIdentity)) {
    throw new ScaTreeSitterIndexError(
      "tool_identity_mismatch",
      "caller-supplied Tree-sitter identity does not match installed implementation and package bytes"
    );
  }

  const exactPaths = new Set<string>();
  const collisionKeys = new Set<string>();
  const decoded = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const file of input.files) {
    validateCanonicalPath(file.path);
    const collisionKey = file.path.normalize("NFKC").toLowerCase();
    if (exactPaths.has(file.path) || collisionKeys.has(collisionKey)) {
      throw new ScaTreeSitterIndexError("path_collision", "source paths collide");
    }
    exactPaths.add(file.path);
    collisionKeys.add(collisionKey);
    const bytes = exactBase64(file);
    if (bytes.byteLength > input.limits.max_source_bytes_per_file) {
      throw new ScaTreeSitterIndexError(
        "limit_exceeded",
        "source file exceeds the admitted byte limit"
      );
    }
    totalBytes += bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > input.limits.max_total_source_bytes) {
      throw new ScaTreeSitterIndexError(
        "limit_exceeded",
        "source corpus exceeds the admitted byte limit"
      );
    }
    decoded.set(file.path, bytes);
  }

  const files = [...input.files]
    .sort((left, right) => compareUtf8(left.path, right.path))
    .map((file) => {
      const bytes = decoded.get(file.path);
      if (bytes === undefined) {
        throw new ScaTreeSitterIndexError(
          "source_mismatch",
          "validated source bytes are unavailable"
        );
      }
      return parseFile(input, file, bytes);
    });
  const profile = captureProfile();
  const unsigned: UnsignedResult = {
    schema_id: SCA_TREE_SITTER_INDEX_RESULT_V2_SCHEMA,
    schema_version: 2,
    source_snapshot_sha256: input.source_snapshot_sha256,
    tool: installedIdentity,
    capture_profile: profile,
    status: resultStatus(files),
    files,
    counts: resultCounts(files),
  };
  return validateContract(
    ScaTreeSitterIndexResultV2Schema,
    { ...unsigned, index_sha256: digestResult(unsigned) },
    "SCA Tree-sitter index result"
  );
}

function semanticFailure(message: string): never {
  throw new ScaTreeSitterIndexError("semantic_mismatch", message);
}

function validateToolSemantics(tool: ScaTreeSitterToolIdentityV2, profile: CaptureProfile): void {
  const expectedProfile = captureProfile();
  if (canonicalJson(profile) !== canonicalJson(expectedProfile)) {
    semanticFailure("Tree-sitter capture profile mismatch");
  }
  if (tool.capture_profile_sha256 !== profile.profile_sha256) {
    semanticFailure("Tree-sitter tool identity does not bind the capture profile");
  }
  if (
    tool.grammars.map((grammar) => grammar.language).join("\0") !== SUPPORTED_LANGUAGES.join("\0")
  ) {
    semanticFailure("Tree-sitter grammar identities are not complete and ordered");
  }
  for (const grammar of tool.grammars) {
    if (grammar.query_sha256 !== sha256(Buffer.from(queryFor(grammar.language), "utf8"))) {
      semanticFailure("Tree-sitter grammar identity query digest mismatch");
    }
  }
  const { indexer_sha256: observed, ...unsigned } = tool;
  if (observed !== indexerDigest(unsigned)) {
    semanticFailure("Tree-sitter indexer identity digest mismatch");
  }
}

function validRange(range: SourceRange, byteCount: number): boolean {
  return (
    range.start_byte <= range.end_byte &&
    range.end_byte <= byteCount &&
    (range.start_line < range.end_line ||
      (range.start_line === range.end_line && range.start_column_utf16 <= range.end_column_utf16))
  );
}

export function validateScaTreeSitterIndexResultV2(
  value: unknown,
  admittedInputValue: unknown,
  options: Readonly<{ deterministic_rebuild?: boolean }> = {}
): ScaTreeSitterIndexResultV2 {
  const result = validateContract(
    ScaTreeSitterIndexResultV2Schema,
    value,
    "SCA Tree-sitter index result"
  );
  const { index_sha256: observedDigest, ...unsigned } = result;
  if (digestResult(unsigned) !== observedDigest) {
    throw new ScaTreeSitterIndexError("invalid_input", "Tree-sitter index digest mismatch");
  }
  validateToolSemantics(result.tool, result.capture_profile);
  const input = validateContract(
    ScaTreeSitterIndexInputV2Schema,
    admittedInputValue,
    "admitted Tree-sitter input"
  );
  if (
    result.source_snapshot_sha256 !== input.source_snapshot_sha256 ||
    canonicalJson(result.tool) !== canonicalJson(input.tool) ||
    result.files.length !== input.files.length ||
    result.files.some((file, index) => {
      const source = [...input.files].sort((a, b) => compareUtf8(a.path, b.path))[index];
      return (
        source === undefined ||
        file.path !== source.path ||
        file.source_sha256 !== source.source_sha256 ||
        file.byte_count !== source.byte_count ||
        file.admitted_language !== source.admitted_language
      );
    }) ||
    result.files.some(
      (file) =>
        file.named_nodes > input.limits.max_nodes_per_file ||
        file.max_depth > input.limits.max_depth ||
        file.diagnostics.length > input.limits.max_diagnostics_per_file ||
        file.symbols.length > input.limits.max_symbols_per_file
    )
  )
    semanticFailure("Tree-sitter result does not bind the admitted source, tool and limits");
  const paths = result.files.map((file) => file.path);
  if (
    new Set(paths).size !== paths.length ||
    canonicalJson(paths) !== canonicalJson([...paths].sort(compareUtf8))
  ) {
    semanticFailure("Tree-sitter file results are not uniquely ordered");
  }
  const recordIds = new Set<string>();
  for (const file of result.files) {
    validateCanonicalPath(file.path);
    if (
      (file.status === "parsed" &&
        (file.error_nodes !== 0 || file.missing_nodes !== 0 || file.truncated)) ||
      (file.status === "parse_gap" && file.error_nodes + file.missing_nodes === 0) ||
      (file.status === "limit_exceeded" && !file.truncated) ||
      ((file.status === "unsupported" || file.status === "malformed") &&
        (file.named_nodes !== 0 ||
          file.error_nodes !== 0 ||
          file.missing_nodes !== 0 ||
          file.symbols.length !== 0))
    ) {
      semanticFailure("Tree-sitter file status does not match its semantic fields");
    }
    const expectedOrder = [...file.symbols].sort((left, right) =>
      compareUtf8(
        `${left.range.start_byte.toString().padStart(12, "0")}\0${left.record_id}`,
        `${right.range.start_byte.toString().padStart(12, "0")}\0${right.record_id}`
      )
    );
    if (canonicalJson(file.symbols) !== canonicalJson(expectedOrder)) {
      semanticFailure("Tree-sitter symbols are not ordered");
    }
    const rangeKinds = new Set<string>();
    for (const symbol of file.symbols) {
      const { record_id: observedRecordId, ...record } = symbol;
      if (
        observedRecordId !== symbolRecordId(result.source_snapshot_sha256, record) ||
        recordIds.has(observedRecordId) ||
        symbol.path !== file.path ||
        symbol.source_sha256 !== file.source_sha256 ||
        !validRange(symbol.range, file.byte_count)
      ) {
        semanticFailure("Tree-sitter symbol identity, source mapping, or range mismatch");
      }
      recordIds.add(observedRecordId);
      const semanticRange = `${symbol.name}\0${symbol.range.start_byte}\0${symbol.range.end_byte}`;
      const opposite = `${semanticRange}\0${symbol.record_kind === "definition" ? "reference" : "definition"}`;
      if (rangeKinds.has(opposite)) {
        semanticFailure("Tree-sitter range is both a declaration and a reference");
      }
      rangeKinds.add(`${semanticRange}\0${symbol.record_kind}`);
    }
    for (const diagnostic of file.diagnostics) {
      if (diagnostic.range !== null && !validRange(diagnostic.range, file.byte_count)) {
        semanticFailure("Tree-sitter diagnostic range exceeds its source");
      }
    }
  }
  if (canonicalJson(result.counts) !== canonicalJson(resultCounts(result.files))) {
    semanticFailure("Tree-sitter aggregate counts mismatch");
  }
  if (result.status !== resultStatus(result.files)) {
    semanticFailure("Tree-sitter aggregate status mismatch");
  }
  if (options.deterministic_rebuild !== false) {
    const rebuilt = buildScaTreeSitterIndexV2(admittedInputValue);
    if (canonicalJson(result) !== canonicalJson(rebuilt)) {
      semanticFailure("Tree-sitter index does not equal the deterministic admitted-input rebuild");
    }
  }
  return result;
}
