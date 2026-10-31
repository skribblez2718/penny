import {
  constants,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  closeSync,
  fstatSync,
} from "node:fs";
import path from "node:path";

import {
  ArtifactStore,
  currentArtifactRef,
  previewArtifactRef,
  type PersistArtifactInput,
} from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import {
  SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
  SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
  SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
  SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS,
  SCA_SOURCE_PROVENANCE_V1_SCHEMA,
  scaP01SourceTreeDigest,
  validateScaCampaignSourceSnapshotV2,
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  validateScaP01SourceMaterialV1,
  validateScaSourceProvenanceV1,
  type ScaCampaignSourceSnapshotV2,
  type ScaP01SourceCustodyCorpusV1,
  type ScaP01SourceFileManifestV1,
} from "./p01-contracts.js";

export interface P01SourceIncludePolicy {
  readonly include_paths: readonly string[];
  readonly exclude_paths: readonly string[];
  readonly max_files: number;
  readonly max_total_bytes: number;
  readonly max_file_bytes: number;
  readonly max_walk_entries: number;
}

export interface P01SourceSnapshotRefs {
  readonly file_manifest_ref: ArtifactRef;
  readonly custody_ref: ArtifactRef;
  readonly snapshot_ref: ArtifactRef;
  readonly provenance_ref: ArtifactRef;
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function assertRelative(value: string): void {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > 4_096 ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("source include path is not canonical and repository-relative");
}

function inSubtree(value: string, root: string): boolean {
  return value === root || value.startsWith(`${root}/`);
}

function assertPolicy(policy: P01SourceIncludePolicy): void {
  if (
    policy.include_paths.length < 1 ||
    policy.include_paths.length > 1_024 ||
    policy.exclude_paths.length > 1_024 ||
    !Number.isSafeInteger(policy.max_files) ||
    policy.max_files < 1 ||
    policy.max_files > 1_024 ||
    !Number.isSafeInteger(policy.max_total_bytes) ||
    policy.max_total_bytes < 1 ||
    policy.max_total_bytes > 16 * 1_048_576 ||
    !Number.isSafeInteger(policy.max_file_bytes) ||
    policy.max_file_bytes < 1 ||
    policy.max_file_bytes > 2 * 1_048_576 ||
    !Number.isSafeInteger(policy.max_walk_entries) ||
    policy.max_walk_entries < 1 ||
    policy.max_walk_entries > 100_000
  )
    throw new Error("source include policy exceeds bounded limits");
  for (const paths of [policy.include_paths, policy.exclude_paths]) {
    for (const entry of paths) assertRelative(entry);
    if (
      canonicalJson(paths) !== canonicalJson([...paths].sort(utf8Compare)) ||
      new Set(paths).size !== paths.length ||
      paths.some((a, i) => paths.slice(i + 1).some((b) => inSubtree(b, a)))
    ) {
      throw new Error("source include policy paths must be ordered, distinct and nonoverlapping");
    }
  }
  for (const excluded of policy.exclude_paths) {
    if (!policy.include_paths.some((included) => excluded.startsWith(`${included}/`))) {
      throw new Error("source exclusion must be a descendant of an included directory");
    }
  }
}

function exactRead(file: string, maxBytes: number): Buffer {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > maxBytes)
      throw new Error("source file is not regular or exceeds its limit");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== before.size
    ) {
      throw new Error("source file changed during capture");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function jsonInput(
  runId: string,
  kind: string,
  schemaId: string,
  version: number,
  operation: string,
  value: unknown,
  upstreamRefs: readonly ArtifactRef[]
): PersistArtifactInput {
  return {
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "SCA-P01-source",
      branch_id: null,
      kind,
      operation_id: operation,
      version: 1,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
      media_type: "application/json",
      content_schema: { schema_id: schemaId, schema_version: version },
      parent_ref: null,
      upstream_refs: [...upstreamRefs].sort((a, b) => utf8Compare(a.artifact_id, b.artifact_id)),
    },
    content: canonicalJson(value),
  };
}

function persistPlanned(
  store: ArtifactStore,
  input: PersistArtifactInput,
  planned: ArtifactRef
): ArtifactRef {
  const ref = store.persist(input);
  const stored = store.refById(ref.artifact_id);
  if (
    stored === undefined ||
    canonicalJson(stored) !== canonicalJson(planned) ||
    canonicalJson(ref) !== canonicalJson(planned) ||
    !store.readById(ref.artifact_id).equals(Buffer.from(input.content)) ||
    canonicalJson(store.metadata(ref).upstream_refs) !== canonicalJson(input.metadata.upstream_refs)
  ) {
    throw new Error("source artifact exact ref, bytes or provenance failed readback");
  }
  return currentArtifactRef(ref);
}

/** Bounded explicit include, not whole-repository discovery or language coverage. The caller
 * must ensure a stable, owned source tree; reject links and changes rather than following them.
 * Preflight all files and schemas before the first artifact write.
 */
export function buildP01SourceSnapshotV2(input: {
  readonly source_root: string;
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly snapshot_id: string;
  readonly policy: P01SourceIncludePolicy;
}): P01SourceSnapshotRefs {
  assertPolicy(input.policy);
  if (!path.isAbsolute(input.source_root)) throw new Error("source root must be absolute");
  const root = path.resolve(input.source_root);
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) {
    throw new Error("source root must be a real directory without symlinked ancestors");
  }
  const files: Array<{ path: string; byte_count: number; content_sha256: string; bytes: Buffer }> =
    [];
  let entries = 0;
  let totalBytes = 0;
  const visit = (relative: string): void => {
    if (++entries > input.policy.max_walk_entries)
      throw new Error("source traversal entry budget exceeded");
    assertRelative(relative);
    if (input.policy.exclude_paths.some((excluded) => inSubtree(relative, excluded))) return;
    const absolute = path.join(root, ...relative.split("/"));
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error("source symlink refused");
    if (stat.isDirectory()) {
      if (realpathSync(absolute) !== absolute) throw new Error("source directory symlink refused");
      for (const name of readdirSync(absolute).sort(utf8Compare)) visit(`${relative}/${name}`);
      if (realpathSync(absolute) !== absolute)
        throw new Error("source directory changed during capture");
      return;
    }
    if (!stat.isFile()) throw new Error("source contains a non-regular file");
    if (
      files.length >= input.policy.max_files ||
      stat.size > input.policy.max_file_bytes ||
      stat.size > input.policy.max_total_bytes - totalBytes
    ) {
      throw new Error("source file count or byte budget exceeded");
    }
    if (realpathSync(path.dirname(absolute)) !== path.dirname(absolute)) {
      throw new Error("source ancestor symlink refused");
    }
    const bytes = exactRead(absolute, input.policy.max_file_bytes);
    const byteCount = bytes.byteLength;
    if (byteCount > input.policy.max_total_bytes - totalBytes)
      throw new Error("source byte budget exceeded");
    files.push({ path: relative, byte_count: byteCount, content_sha256: sha256(bytes), bytes });
    totalBytes += byteCount;
  };
  for (const included of input.policy.include_paths) {
    const parts = included.split("/");
    for (let index = 1; index < parts.length; index++) {
      const ancestor = path.join(root, ...parts.slice(0, index));
      if (!lstatSync(ancestor).isDirectory() || realpathSync(ancestor) !== ancestor)
        throw new Error("source ancestor is a link or non-directory");
    }
    visit(included);
  }
  files.sort((a, b) => utf8Compare(a.path, b.path));
  if (files.length === 0) throw new Error("source include policy selected no files");
  const identities = files.map(({ path: filePath, byte_count, content_sha256 }) => ({
    path: filePath,
    byte_count,
    content_sha256,
  }));
  const treeSha256 = scaP01SourceTreeDigest(identities);
  const scope = {
    include_paths: [...input.policy.include_paths],
    exclude_paths: [...input.policy.exclude_paths],
  };
  const manifest: ScaP01SourceFileManifestV1 = validateScaP01SourceFileManifestV1({
    schema_id: SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
    schema_version: 1,
    snapshot_id: input.snapshot_id,
    scope,
    files: identities,
    file_count: files.length,
    byte_count: totalBytes,
    tree_sha256: treeSha256,
  });
  const manifestInput = jsonInput(
    input.run_id,
    "sca-p01-source-file-manifest",
    SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
    1,
    `source-manifest:${input.snapshot_id}`,
    manifest,
    []
  );
  const manifestRef = previewArtifactRef(manifestInput);
  const custody: ScaP01SourceCustodyCorpusV1 = validateScaP01SourceCustodyCorpusV1({
    schema_id: SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
    schema_version: 1,
    custody_id: input.snapshot_id,
    snapshot_id: input.snapshot_id,
    file_manifest_ref: manifestRef,
    files: files.map((file) => ({
      path: file.path,
      encoding: "base64",
      content_base64: file.bytes.toString("base64"),
      byte_count: file.byte_count,
      content_sha256: file.content_sha256,
    })),
    file_count: files.length,
    byte_count: totalBytes,
    tree_sha256: treeSha256,
    sealed: true,
  });
  const custodyInput = jsonInput(
    input.run_id,
    "sca-p01-source-custody-corpus",
    SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
    1,
    `source-custody:${input.snapshot_id}`,
    custody,
    [manifestRef]
  );
  const custodyRef = previewArtifactRef(custodyInput);
  const snapshot: ScaCampaignSourceSnapshotV2 = validateScaCampaignSourceSnapshotV2({
    schema_id: SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
    schema_version: 2,
    snapshot_id: input.snapshot_id,
    tree_sha256: treeSha256,
    file_manifest_ref: manifestRef,
    file_manifest_sha256: manifestRef.content_digest,
    custody_ref: custodyRef,
    custody_sha256: custodyRef.content_digest,
    scope,
    file_count: files.length,
    byte_count: totalBytes,
    status: "frozen",
  });
  validateScaP01SourceMaterialV1({
    snapshot,
    file_manifest_ref: manifestRef,
    file_manifest: manifest,
    custody_ref: custodyRef,
    custody,
  });
  const snapshotInput = jsonInput(
    input.run_id,
    "source-snapshot",
    SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
    2,
    `source-snapshot:${input.snapshot_id}`,
    snapshot,
    [manifestRef, custodyRef]
  );
  const snapshotRef = previewArtifactRef(snapshotInput);
  const provenance = validateScaSourceProvenanceV1({
    schema_id: SCA_SOURCE_PROVENANCE_V1_SCHEMA,
    schema_version: 1,
    snapshot_ref: snapshotRef,
    file_manifest_ref: manifestRef,
    custody_ref: custodyRef,
    custody_sha256: custodyRef.content_digest,
    capture_method: "host-frozen",
    custody_status: "verified",
  });
  const provenanceInput = jsonInput(
    input.run_id,
    "source-provenance",
    SCA_SOURCE_PROVENANCE_V1_SCHEMA,
    1,
    `source-provenance:${input.snapshot_id}`,
    provenance,
    [snapshotRef, manifestRef, custodyRef]
  );
  const provenanceRef = previewArtifactRef(provenanceInput);
  // All four closed contracts are valid before the first publication. Each immutable object
  // is then read back exactly; a later storage failure leaves only independently valid refs.
  for (const [planned, artifactInput] of [
    [manifestRef, manifestInput],
    [custodyRef, custodyInput],
    [snapshotRef, snapshotInput],
    [provenanceRef, provenanceInput],
  ] as const)
    persistPlanned(input.store, artifactInput, planned);
  return {
    file_manifest_ref: manifestRef,
    custody_ref: custodyRef,
    snapshot_ref: snapshotRef,
    provenance_ref: provenanceRef,
  };
}
