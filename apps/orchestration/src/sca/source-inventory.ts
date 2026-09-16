import { Type, type Static } from "typebox";

import { currentArtifactRef } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema, assertOpaqueId } from "../skill-contracts/common.js";

const MIB = 1_024 * 1_024;
const GIB = 1_024 * MIB;

export const SCA_SOURCE_ADMISSION_HARD_LIMITS = Object.freeze({
  files: 100_000,
  bytes_per_file: 16 * MIB,
  total_bytes: GIB,
  path_bytes: 4_096,
  path_depth: 64,
});

export const SCA_SOURCE_SNAPSHOT_SCHEMA = "penny.sca-source-snapshot.v1";
export const SCA_SOURCE_MANIFEST_SCHEMA = "penny.sca-source-manifest.v1";
export const SCA_SOURCE_ADMISSION_POLICY_SCHEMA = "penny.sca-source-admission-policy.v1";

export const ScaSourceHandlingV1Schema = Type.Union([
  Type.Literal("include"),
  Type.Literal("exclude"),
  Type.Literal("error"),
]);

export const ScaSourceAdmissionPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SOURCE_ADMISSION_POLICY_SCHEMA),
    schema_version: Type.Literal(1),
    max_files: Type.Integer({ minimum: 1, maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.files }),
    max_bytes_per_file: Type.Integer({
      minimum: 1,
      maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.bytes_per_file,
    }),
    max_total_bytes: Type.Integer({
      minimum: 1,
      maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.total_bytes,
    }),
    max_path_bytes: Type.Integer({
      minimum: 1,
      maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.path_bytes,
    }),
    max_path_depth: Type.Integer({
      minimum: 1,
      maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.path_depth,
    }),
    binary: ScaSourceHandlingV1Schema,
    generated: ScaSourceHandlingV1Schema,
    generated_paths: Type.Array(
      Type.String({ minLength: 1, maxLength: SCA_SOURCE_ADMISSION_HARD_LIMITS.path_bytes }),
      { maxItems: SCA_SOURCE_ADMISSION_HARD_LIMITS.files }
    ),
  },
  { additionalProperties: false }
);

export const ScaSourceFileDeclarationV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: SCA_SOURCE_ADMISSION_HARD_LIMITS.path_bytes }),
    expected_byte_length: Type.Integer({
      minimum: 0,
      maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.bytes_per_file,
    }),
    expected_sha256: Sha256Schema,
    content_kind: Type.Union([Type.Literal("text"), Type.Literal("binary")]),
    generated: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const ScaSourceInventoryStatusV1Schema = Type.Union([
  Type.Literal("included"),
  Type.Literal("excluded"),
]);

export const ScaSourceInventoryReasonV1Schema = Type.Union([
  Type.Literal("included_by_policy"),
  Type.Literal("excluded_binary"),
  Type.Literal("excluded_generated"),
  Type.Literal("excluded_binary_and_generated"),
]);

export const ScaSourceInventoryEntryV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: SCA_SOURCE_ADMISSION_HARD_LIMITS.path_bytes }),
    byte_length: Type.Integer({
      minimum: 0,
      maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.bytes_per_file,
    }),
    sha256: Sha256Schema,
    content_kind: Type.Union([Type.Literal("text"), Type.Literal("binary")]),
    generated: Type.Boolean(),
    status: ScaSourceInventoryStatusV1Schema,
    reason: ScaSourceInventoryReasonV1Schema,
  },
  { additionalProperties: false }
);

export const ScaSourceAdmissionResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SOURCE_MANIFEST_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_ref: ArtifactRefSchema,
    policy: ScaSourceAdmissionPolicyV1Schema,
    entries: Type.Array(ScaSourceInventoryEntryV1Schema, {
      minItems: 1,
      maxItems: SCA_SOURCE_ADMISSION_HARD_LIMITS.files,
    }),
    counts: Type.Object(
      {
        declared: Type.Integer({ minimum: 1, maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.files }),
        included: Type.Integer({ minimum: 0, maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.files }),
        excluded: Type.Integer({ minimum: 0, maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.files }),
      },
      { additionalProperties: false }
    ),
    bytes: Type.Object(
      {
        declared: Type.Integer({
          minimum: 0,
          maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.total_bytes,
        }),
        included: Type.Integer({
          minimum: 0,
          maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.total_bytes,
        }),
        excluded: Type.Integer({
          minimum: 0,
          maximum: SCA_SOURCE_ADMISSION_HARD_LIMITS.total_bytes,
        }),
      },
      { additionalProperties: false }
    ),
    tree_sha256: Sha256Schema,
    inventory_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaSourceAdmissionPolicyV1 = Static<typeof ScaSourceAdmissionPolicyV1Schema>;
export type ScaSourceFileDeclarationV1 = Static<typeof ScaSourceFileDeclarationV1Schema>;
export type ScaSourceInventoryEntryV1 = Static<typeof ScaSourceInventoryEntryV1Schema>;
export type ScaSourceAdmissionResultV1 = Static<typeof ScaSourceAdmissionResultV1Schema>;

export interface ScaSourceAdmissionBindingV1 {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly source_snapshot_ref: ArtifactRef;
}

export class ScaSourceManifestError extends Error {
  constructor(
    readonly code:
      | "invalid_inventory"
      | "invalid_policy"
      | "unsafe_path"
      | "path_collision"
      | "quota_exceeded"
      | "binding_mismatch"
      | "digest_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaSourceManifestError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

function fail(code: ScaSourceManifestError["code"], message: string): never {
  throw new ScaSourceManifestError(code, message);
}

export function validateScaSourceAdmissionPolicy(value: unknown): ScaSourceAdmissionPolicyV1 {
  let policy: ScaSourceAdmissionPolicyV1;
  try {
    policy = validateContract(
      ScaSourceAdmissionPolicyV1Schema,
      value,
      "SCA source admission policy"
    );
  } catch (error) {
    fail("invalid_policy", error instanceof Error ? error.message : "invalid policy");
  }
  if (policy.max_bytes_per_file > policy.max_total_bytes) {
    fail("invalid_policy", "max_bytes_per_file must not exceed max_total_bytes");
  }
  if (policy.generated_paths.length > policy.max_files) {
    fail("invalid_policy", "generated_paths must not exceed max_files");
  }
  validateScaPathSet(policy.generated_paths, policy);
  return policy;
}

/** Validate one canonical repository-relative declaration path. */
export function validateScaDeclaredPath(
  declaredPath: string,
  policy: ScaSourceAdmissionPolicyV1
): readonly string[] {
  if (declaredPath.includes("\0")) {
    fail("unsafe_path", "declared paths must not contain NUL");
  }
  if (declaredPath.includes("\\")) {
    fail("unsafe_path", `declared path '${declaredPath}' must use '/' separators`);
  }
  if (declaredPath !== declaredPath.normalize("NFC")) {
    fail("unsafe_path", `declared path '${declaredPath}' must be NFC-normalized`);
  }
  if (hasControlCharacter(declaredPath)) {
    fail("unsafe_path", "declared paths must not contain control characters");
  }
  if (declaredPath.startsWith("/") || /^[A-Za-z]:/u.test(declaredPath)) {
    fail("unsafe_path", `declared path '${declaredPath}' must be repository-relative`);
  }

  const segments = declaredPath.split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    segments.join("/") !== declaredPath
  ) {
    fail("unsafe_path", `declared path '${declaredPath}' is not canonical`);
  }
  if (segments.length > policy.max_path_depth) {
    fail("quota_exceeded", `declared path '${declaredPath}' exceeds max_path_depth`);
  }
  if (byteLength(declaredPath) > policy.max_path_bytes) {
    fail("quota_exceeded", `declared path '${declaredPath}' exceeds max_path_bytes`);
  }
  return segments;
}

/** Reject exact, canonical-alias, case-fold, and Unicode-compatibility collisions. */
export function validateScaPathSet(
  paths: readonly string[],
  policy: ScaSourceAdmissionPolicyV1
): void {
  const exact = new Set<string>();
  const canonicalAliases = new Map<string, string>();
  const folded = new Map<string, string>();

  for (const declaredPath of paths) {
    const segments = validateScaDeclaredPath(declaredPath, policy);
    if (exact.has(declaredPath)) {
      fail("path_collision", `duplicate declared path '${declaredPath}'`);
    }
    exact.add(declaredPath);

    const aliasKey = segments.join("/");
    const priorAlias = canonicalAliases.get(aliasKey);
    if (priorAlias !== undefined) {
      fail("path_collision", `declared paths '${priorAlias}' and '${declaredPath}' alias`);
    }
    canonicalAliases.set(aliasKey, declaredPath);

    const foldedKey = segments
      .map((segment) => segment.normalize("NFKC").toUpperCase().toLowerCase())
      .join("/");
    const priorFolded = folded.get(foldedKey);
    if (priorFolded !== undefined) {
      fail(
        "path_collision",
        `declared paths '${priorFolded}' and '${declaredPath}' collide after case/Unicode folding`
      );
    }
    folded.set(foldedKey, declaredPath);
  }
}

export function dispositionForScaSource(
  contentKind: "text" | "binary",
  generated: boolean,
  policy: ScaSourceAdmissionPolicyV1
): Pick<ScaSourceInventoryEntryV1, "status" | "reason"> {
  if (contentKind === "binary" && policy.binary === "error") {
    fail("invalid_policy", "binary declaration refused by admission policy");
  }
  if (generated && policy.generated === "error") {
    fail("invalid_policy", "generated declaration refused by admission policy");
  }

  const binaryExcluded = contentKind === "binary" && policy.binary === "exclude";
  const generatedExcluded = generated && policy.generated === "exclude";
  if (binaryExcluded && generatedExcluded) {
    return { status: "excluded", reason: "excluded_binary_and_generated" };
  }
  if (binaryExcluded) {
    return { status: "excluded", reason: "excluded_binary" };
  }
  if (generatedExcluded) {
    return { status: "excluded", reason: "excluded_generated" };
  }
  return { status: "included", reason: "included_by_policy" };
}

export interface ScaSourceTreeFileV1 {
  readonly path: string;
  readonly byte_length: number;
  readonly sha256: string;
}

/** Canonical bytes of the exact path/size/content-digest source snapshot. */
export function canonicalScaSourceSnapshotV1(files: readonly ScaSourceTreeFileV1[]): string {
  const projected = files
    .map((file) => ({
      path: file.path,
      byte_length: file.byte_length,
      sha256: file.sha256,
    }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  return canonicalJson({
    schema_id: SCA_SOURCE_SNAPSHOT_SCHEMA,
    schema_version: 1,
    files: projected,
  });
}

/** Canonical digest of the exact path/size/content-digest source tree. */
export function computeScaSourceTreeSha256(files: readonly ScaSourceTreeFileV1[]): string {
  return sha256(canonicalScaSourceSnapshotV1(files));
}

function inventoryDigest(value: Omit<ScaSourceAdmissionResultV1, "inventory_sha256">): string {
  return sha256(canonicalJson(value));
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalSnapshotRef(value: unknown, runId: string): ArtifactRef {
  let ref: ArtifactRef;
  try {
    ref = currentArtifactRef(value, "SCA source snapshot reference");
  } catch (error) {
    fail(
      "binding_mismatch",
      error instanceof Error ? error.message : "invalid source snapshot reference"
    );
  }
  if (ref.run_id !== runId) {
    fail("binding_mismatch", "source snapshot run_id does not match inventory run_id");
  }
  if (
    ref.kind !== "source-snapshot" ||
    ref.content_schema?.schema_id !== SCA_SOURCE_SNAPSHOT_SCHEMA ||
    ref.content_schema.schema_version !== 1
  ) {
    fail("binding_mismatch", "source snapshot reference has the wrong kind or content schema");
  }
  return ref;
}

function checkedTotal(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      fail("quota_exceeded", `${label} is not a safe integer`);
    }
  }
  return total;
}

export function buildScaSourceAdmissionResultV1(
  binding: ScaSourceAdmissionBindingV1,
  policyValue: ScaSourceAdmissionPolicyV1,
  entryValues: readonly ScaSourceInventoryEntryV1[]
): ScaSourceAdmissionResultV1 {
  const policy = validateScaSourceAdmissionPolicy(policyValue);
  const entries = [...entryValues].sort((left, right) => compareUtf8(left.path, right.path));
  const declaredBytes = checkedTotal(
    entries.map((entry) => entry.byte_length),
    "declared byte total"
  );
  const included = entries.filter((entry) => entry.status === "included");
  const excluded = entries.filter((entry) => entry.status === "excluded");
  const treeSha256 = computeScaSourceTreeSha256(entries);

  const unsigned: Omit<ScaSourceAdmissionResultV1, "inventory_sha256"> = {
    schema_id: SCA_SOURCE_MANIFEST_SCHEMA,
    schema_version: 1,
    tenant_id: binding.tenant_id,
    project_id: binding.project_id,
    run_id: binding.run_id,
    source_snapshot_ref: binding.source_snapshot_ref,
    policy,
    entries,
    counts: {
      declared: entries.length,
      included: included.length,
      excluded: excluded.length,
    },
    bytes: {
      declared: declaredBytes,
      included: checkedTotal(
        included.map((entry) => entry.byte_length),
        "included byte total"
      ),
      excluded: checkedTotal(
        excluded.map((entry) => entry.byte_length),
        "excluded byte total"
      ),
    },
    tree_sha256: treeSha256,
  };

  const inventory: ScaSourceAdmissionResultV1 = {
    ...unsigned,
    inventory_sha256: inventoryDigest(unsigned),
  };
  return validateScaSourceAdmissionResultV1(inventory, binding);
}

/**
 * Validate both the closed wire shape and every derivable inventory invariant.
 * Pass `expected` at trust boundaries to bind the result to authoritative
 * tenant/project/run/snapshot context rather than merely to its own fields.
 */
export function validateScaSourceAdmissionResultV1(
  value: unknown,
  expected?: ScaSourceAdmissionBindingV1
): ScaSourceAdmissionResultV1 {
  let inventory: ScaSourceAdmissionResultV1;
  try {
    inventory = validateContract(ScaSourceAdmissionResultV1Schema, value, "SCA source inventory");
  } catch (error) {
    fail("invalid_inventory", error instanceof Error ? error.message : "invalid source inventory");
  }

  try {
    assertOpaqueId(inventory.tenant_id, "tenant_id");
    assertOpaqueId(inventory.project_id, "project_id");
    assertOpaqueId(inventory.run_id, "run_id");
  } catch (error) {
    fail("binding_mismatch", error instanceof Error ? error.message : "invalid inventory identity");
  }

  const policy = validateScaSourceAdmissionPolicy(inventory.policy);
  const snapshotRef = canonicalSnapshotRef(inventory.source_snapshot_ref, inventory.run_id);
  validateScaPathSet(
    inventory.entries.map((entry) => entry.path),
    policy
  );

  if (inventory.entries.length > policy.max_files) {
    fail("quota_exceeded", "inventory exceeds max_files");
  }

  const generatedPaths = new Set(policy.generated_paths);
  const inventoryPaths = new Set(inventory.entries.map((entry) => entry.path));
  for (const generatedPath of generatedPaths) {
    if (!inventoryPaths.has(generatedPath)) {
      fail(
        "invalid_inventory",
        `generated policy path '${generatedPath}' is not present in the inventory`
      );
    }
  }

  for (let index = 0; index < inventory.entries.length; index += 1) {
    const entry = inventory.entries[index];
    if (entry === undefined) {
      fail("invalid_inventory", "inventory entry is missing");
    }
    if (entry.byte_length > policy.max_bytes_per_file) {
      fail("quota_exceeded", `inventory entry '${entry.path}' exceeds max_bytes_per_file`);
    }
    const prior = index > 0 ? inventory.entries[index - 1] : undefined;
    if (prior !== undefined && compareUtf8(prior.path, entry.path) >= 0) {
      fail("invalid_inventory", "inventory entries are not in strict UTF-8 path order");
    }
    const generated = generatedPaths.has(entry.path);
    if (entry.generated !== generated) {
      fail(
        "invalid_inventory",
        `inventory entry '${entry.path}' generated classification does not match policy`
      );
    }
    const disposition = dispositionForScaSource(entry.content_kind, generated, policy);
    if (entry.status !== disposition.status || entry.reason !== disposition.reason) {
      fail("invalid_inventory", `inventory entry '${entry.path}' has an invalid status/reason`);
    }
  }

  const included = inventory.entries.filter((entry) => entry.status === "included");
  const excluded = inventory.entries.filter((entry) => entry.status === "excluded");
  const declaredBytes = checkedTotal(
    inventory.entries.map((entry) => entry.byte_length),
    "declared byte total"
  );
  const includedBytes = checkedTotal(
    included.map((entry) => entry.byte_length),
    "included byte total"
  );
  const excludedBytes = checkedTotal(
    excluded.map((entry) => entry.byte_length),
    "excluded byte total"
  );

  if (declaredBytes > policy.max_total_bytes) {
    fail("quota_exceeded", "inventory exceeds max_total_bytes");
  }
  if (
    inventory.counts.declared !== inventory.entries.length ||
    inventory.counts.included !== included.length ||
    inventory.counts.excluded !== excluded.length ||
    inventory.counts.included + inventory.counts.excluded !== inventory.counts.declared
  ) {
    fail("invalid_inventory", "inventory counts do not match entries");
  }
  if (
    inventory.bytes.declared !== declaredBytes ||
    inventory.bytes.included !== includedBytes ||
    inventory.bytes.excluded !== excludedBytes ||
    inventory.bytes.included + inventory.bytes.excluded !== inventory.bytes.declared
  ) {
    fail("invalid_inventory", "inventory byte totals do not match entries");
  }

  const expectedTree = computeScaSourceTreeSha256(inventory.entries);
  if (inventory.tree_sha256 !== expectedTree) {
    fail("digest_mismatch", "inventory tree_sha256 does not match entries");
  }
  if (snapshotRef.content_digest !== expectedTree) {
    fail("binding_mismatch", "source snapshot content digest does not match the declared tree");
  }
  if (
    snapshotRef.byte_length !==
    Buffer.byteLength(canonicalScaSourceSnapshotV1(inventory.entries), "utf8")
  ) {
    fail("binding_mismatch", "source snapshot byte length does not match its canonical tree");
  }

  const { inventory_sha256: claimedInventoryDigest, ...unsigned } = inventory;
  if (claimedInventoryDigest !== inventoryDigest(unsigned)) {
    fail("digest_mismatch", "inventory_sha256 does not match canonical inventory content");
  }

  if (expected !== undefined) {
    if (
      inventory.tenant_id !== expected.tenant_id ||
      inventory.project_id !== expected.project_id ||
      inventory.run_id !== expected.run_id
    ) {
      fail("binding_mismatch", "inventory identity does not match the expected binding");
    }
    const expectedRef = canonicalSnapshotRef(expected.source_snapshot_ref, expected.run_id);
    if (!sameArtifactRef(snapshotRef, expectedRef)) {
      fail("binding_mismatch", "inventory source snapshot does not match the expected binding");
    }
  }

  return inventory;
}
