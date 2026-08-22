/**
 * KB filesystem — §5.4 live layout and §5.5 record I/O with custody.
 *
 * The KB live tree has explicit owner-only custody below its already-admitted
 * root. An exact public scaffold root may retain non-writable mode 0755; every
 * live descendant directory is mode-0700. Every live file is current-user-owned,
 * regular, no-follow, mode-0600, and single-link. Staging uses atomic rename.
 *
 * Readers start from one validated `.kb/current.json` and use only that
 * generation's immutable catalog. They never combine a directory scan with
 * another generation.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  validateKbContract,
  KbManifestSchema,
  KbPolicySchema,
  CurrentGenerationSchema,
  GenerationCatalogSchema,
  SourceRecordSchema,
  ClaimsSidecarSchema,
  PageRevisionFrontmatterSchema,
  ConflictRecordSchema,
  type KbManifest,
  type KbPolicy,
  type CurrentGeneration,
  type GenerationCatalog,
  type SourceRecord,
  type ClaimsSidecar,
  type PageRevisionFrontmatter,
  type ConflictRecord,
  type Sha256Hex,
} from "./contracts.js";
import { KbCoreReadError, readContainedKbFile, tryReadContainedKbFile } from "./core-read.js";

export class KbFilesystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KbFilesystemError";
  }
}

/** Create a directory with explicit mode 0700. */
function secureMkdir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Write a file atomically: write to a temp file, fsync, rename, fsync parent.
 * The result is a mode-0600 regular no-follow file.
 */
export function secureWrite(filePath: string, content: string | Buffer): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) secureMkdir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
  // fsync the temp file
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, filePath);
  chmodSync(filePath, 0o600);
}

function filesystemRead(
  root: string,
  filePath: string,
  label: string,
  expectedSha256?: Sha256Hex
): Buffer {
  try {
    return readContainedKbFile(root, filePath, {
      label,
      ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
    });
  } catch (error) {
    if (error instanceof KbCoreReadError) {
      throw new KbFilesystemError(error.message);
    }
    throw error;
  }
}

function tryFilesystemRead(root: string, filePath: string, label: string): Buffer | undefined {
  try {
    return tryReadContainedKbFile(root, filePath, { label });
  } catch (error) {
    if (error instanceof KbCoreReadError) {
      throw new KbFilesystemError(error.message);
    }
    throw error;
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new KbFilesystemError(`${label} is not valid JSON`);
  }
}

function assertCanonicalJson(value: unknown, bytes: Buffer, label: string): void {
  if (canonicalJson(value) !== bytes.toString("utf8")) {
    throw new KbFilesystemError(`${label} is not exact canonical JSON`);
  }
}

function bytesDigest(bytes: Buffer): Sha256Hex {
  return createHash("sha256").update(bytes).digest("hex") as Sha256Hex;
}

// ── Layout paths (§5.4, singular) ───────────────────────────────────────────

export function manifestPath(root: string): string {
  return path.join(root, "manifest.json");
}
export function policyPath(root: string): string {
  return path.join(root, ".kb", "policy.json");
}
export function currentPath(root: string): string {
  return path.join(root, ".kb", "current.json");
}
export function lockPath(root: string): string {
  return path.join(root, ".kb", "lock");
}
export function generationsDir(root: string): string {
  return path.join(root, ".kb", "generations");
}
export function generationCatalogPath(root: string, genId: string): string {
  return path.join(generationsDir(root), genId, "catalog.json");
}
export function generationIndexPath(root: string, genId: string): string {
  return path.join(generationsDir(root), genId, "index.sqlite");
}
export function sourceObjectRef(digest: Sha256Hex): string {
  return `sources/objects/${digest}`;
}
export function sourceObjectPath(root: string, digest: Sha256Hex): string {
  return path.join(root, ...sourceObjectRef(digest).split("/"));
}
export function sourceRecordPath(root: string, sourceId: string): string {
  return path.join(root, "sources", "records", `${sourceId}.json`);
}
export function pageDir(root: string, pageId: string, revId: string): string {
  return path.join(root, "pages", pageId, "revisions", revId);
}
export function pageMarkdownPath(root: string, pageId: string, revId: string): string {
  return path.join(pageDir(root, pageId, revId), "page.md");
}
export function pageClaimsPath(root: string, pageId: string, revId: string): string {
  return path.join(pageDir(root, pageId, revId), "claims.json");
}
export function conflictPath(root: string, conflictId: string): string {
  return path.join(root, "conflicts", `${conflictId}.json`);
}
export function rootIndexPath(root: string): string {
  return path.join(root, "index.md");
}

// ── Manifest I/O ────────────────────────────────────────────────────────────

export function writeManifest(root: string, manifest: KbManifest): void {
  validateKbContract(KbManifestSchema, manifest, "manifest");
  secureWrite(manifestPath(root), canonicalJson(manifest));
}

export function readManifest(root: string, expectedSha256?: Sha256Hex): KbManifest {
  const bytes = filesystemRead(root, manifestPath(root), "manifest", expectedSha256);
  const manifest = validateKbContract(KbManifestSchema, parseJson(bytes, "manifest"), "manifest");
  assertCanonicalJson(manifest, bytes, "manifest");
  return manifest;
}

// ── Policy I/O ──────────────────────────────────────────────────────────────

export function writePolicy(root: string, policy: KbPolicy): void {
  validateKbContract(KbPolicySchema, policy, "policy");
  const dir = path.join(root, ".kb");
  if (!existsSync(dir)) secureMkdir(dir);
  secureWrite(policyPath(root), canonicalJson(policy));
}

export function readPolicy(root: string, expectedSha256?: Sha256Hex): KbPolicy {
  const bytes = filesystemRead(root, policyPath(root), "policy", expectedSha256);
  const policy = validateKbContract(KbPolicySchema, parseJson(bytes, "policy"), "policy");
  assertCanonicalJson(policy, bytes, "policy");
  return policy;
}

// ── Current selector I/O ────────────────────────────────────────────────────

export function writeCurrent(root: string, current: CurrentGeneration): void {
  validateKbContract(CurrentGenerationSchema, current, "current");
  const dir = path.join(root, ".kb");
  if (!existsSync(dir)) secureMkdir(dir);
  secureWrite(currentPath(root), canonicalJson(current));
}

export function readCurrent(
  root: string,
  expectedSha256?: Sha256Hex
): CurrentGeneration | undefined {
  let bytes: Buffer | undefined;
  if (expectedSha256 === undefined) {
    bytes = tryFilesystemRead(root, currentPath(root), "current selector");
  } else {
    bytes = filesystemRead(root, currentPath(root), "current selector", expectedSha256);
  }
  if (bytes === undefined) return undefined;
  const current = validateKbContract(
    CurrentGenerationSchema,
    parseJson(bytes, "current selector"),
    "current"
  );
  assertCanonicalJson(current, bytes, "current selector");
  return current;
}

// ── Source objects (immutable, content-addressed) ───────────────────────────

export function writeSourceObject(root: string, digest: Sha256Hex, bytes: Buffer): void {
  const calculated = bytesDigest(bytes);
  if (calculated !== digest) {
    throw new KbFilesystemError(
      `source object digest mismatch: expected ${digest}, got ${calculated}`
    );
  }
  const p = sourceObjectPath(root, digest);
  if (existsSync(p)) {
    void readSourceObject(root, digest);
    return; // deduplication: exact content already stored
  }
  secureWrite(p, bytes);
}

export function readSourceObject(root: string, digest: Sha256Hex): Buffer {
  return filesystemRead(root, sourceObjectPath(root, digest), "source object", digest);
}

// ── Source records (immutable, JCS) ─────────────────────────────────────────

function assertSourceObjectRef(record: SourceRecord): void {
  const expected = sourceObjectRef(record.sha256);
  if (record.object_ref !== expected) {
    throw new KbFilesystemError(`object_ref must be exactly '${expected}'`);
  }
}

function assertSourceObjectLink(root: string, record: SourceRecord): void {
  assertSourceObjectRef(record);
  void readSourceObject(root, record.sha256);
}

export function writeSourceRecord(root: string, record: SourceRecord): void {
  assertSourceObjectRef(record);
  validateKbContract(SourceRecordSchema, record, "source record");
  void readSourceObject(root, record.sha256);
  secureWrite(sourceRecordPath(root, record.source_id), canonicalJson(record));
}

export function readSourceRecord(
  root: string,
  sourceId: string,
  expectedSha256?: Sha256Hex
): SourceRecord {
  const bytes = filesystemRead(
    root,
    sourceRecordPath(root, sourceId),
    "source record",
    expectedSha256
  );
  const record = validateKbContract(
    SourceRecordSchema,
    parseJson(bytes, "source record"),
    "source record"
  );
  assertCanonicalJson(record, bytes, "source record");
  if (record.source_id !== sourceId) {
    throw new KbFilesystemError("source record identity does not match its immutable path");
  }
  assertSourceObjectLink(root, record);
  return record;
}

// ── Page revision pairs (immutable, JCS) ────────────────────────────────────

export function writePageRevision(
  root: string,
  frontmatter: PageRevisionFrontmatter,
  markdown: string,
  claims: ClaimsSidecar
): void {
  validateKbContract(PageRevisionFrontmatterSchema, frontmatter, "frontmatter");
  validateKbContract(ClaimsSidecarSchema, claims, "claims sidecar");
  if (frontmatter.page_id !== claims.page_id || frontmatter.revision_id !== claims.revision_id) {
    throw new KbFilesystemError("frontmatter and claims must share page_id and revision_id");
  }
  // Published page.md is exactly: ---\n + JCS(frontmatter) + \n---\n\n + markdown
  const pageContent = `---\n${canonicalJson(frontmatter)}\n---\n\n${markdown}`;
  secureWrite(pageMarkdownPath(root, frontmatter.page_id, frontmatter.revision_id), pageContent);
  secureWrite(
    pageClaimsPath(root, frontmatter.page_id, frontmatter.revision_id),
    canonicalJson(claims)
  );
}

/** Read one exact immutable page revision pair with the normal custody checks. */
export function readPageRevision(
  root: string,
  pageId: string,
  revisionId: string,
  expected?: { readonly pageSha256: Sha256Hex; readonly claimsSha256: Sha256Hex }
): { page_markdown: string; claims: ClaimsSidecar } {
  const pageBytes = filesystemRead(
    root,
    pageMarkdownPath(root, pageId, revisionId),
    "page revision",
    expected?.pageSha256
  );
  const claimsBytes = filesystemRead(
    root,
    pageClaimsPath(root, pageId, revisionId),
    "claims sidecar",
    expected?.claimsSha256
  );
  const pageMarkdown = pageBytes.toString("utf8");
  const frontmatterMatch = pageMarkdown.match(/^---\n([^\n]+)\n---\n\n/u);
  if (frontmatterMatch?.[1] === undefined) {
    throw new KbFilesystemError("page revision does not have the canonical page framing");
  }
  const frontmatterBytes = Buffer.from(frontmatterMatch[1], "utf8");
  const frontmatter = validateKbContract(
    PageRevisionFrontmatterSchema,
    parseJson(frontmatterBytes, "page frontmatter"),
    "page frontmatter"
  );
  assertCanonicalJson(frontmatter, frontmatterBytes, "page frontmatter");
  if (frontmatter.page_id !== pageId || frontmatter.revision_id !== revisionId) {
    throw new KbFilesystemError("page frontmatter identity does not match its immutable path");
  }
  const claims = validateKbContract(
    ClaimsSidecarSchema,
    parseJson(claimsBytes, "claims sidecar"),
    "claims sidecar"
  );
  assertCanonicalJson(claims, claimsBytes, "claims sidecar");
  if (claims.page_id !== pageId || claims.revision_id !== revisionId) {
    throw new KbFilesystemError("selected page revision and claims identity do not match");
  }
  return { page_markdown: pageMarkdown, claims };
}

// ── Conflict records (immutable, JCS) ───────────────────────────────────────

export function writeConflictRecord(root: string, conflict: ConflictRecord): void {
  validateKbContract(ConflictRecordSchema, conflict, "conflict record");
  secureWrite(conflictPath(root, conflict.conflict_record_id), canonicalJson(conflict));
}

export function readConflictRecord(
  root: string,
  conflictId: string,
  expectedSha256?: Sha256Hex
): ConflictRecord {
  const bytes = filesystemRead(
    root,
    conflictPath(root, conflictId),
    "conflict record",
    expectedSha256
  );
  const conflict = validateKbContract(
    ConflictRecordSchema,
    parseJson(bytes, "conflict record"),
    "conflict record"
  );
  assertCanonicalJson(conflict, bytes, "conflict record");
  if (conflict.conflict_record_id !== conflictId) {
    throw new KbFilesystemError("conflict record identity does not match its immutable path");
  }
  return conflict;
}

// ── Generation catalog (immutable, JCS) ─────────────────────────────────────

export function writeGenerationCatalog(root: string, catalog: GenerationCatalog): void {
  validateKbContract(GenerationCatalogSchema, catalog, "generation catalog");
  const dir = generationsDir(root);
  if (!existsSync(dir)) secureMkdir(dir);
  secureWrite(generationCatalogPath(root, catalog.generation_id), canonicalJson(catalog));
}

export function readGenerationCatalog(
  root: string,
  genId: string,
  expectedSha256?: Sha256Hex
): GenerationCatalog {
  const bytes = filesystemRead(
    root,
    generationCatalogPath(root, genId),
    "generation catalog",
    expectedSha256
  );
  const catalog = validateKbContract(
    GenerationCatalogSchema,
    parseJson(bytes, "generation catalog"),
    "generation catalog"
  );
  assertCanonicalJson(catalog, bytes, "generation catalog");
  if (catalog.generation_id !== genId) {
    throw new KbFilesystemError("generation catalog identity does not match its immutable path");
  }
  return catalog;
}

// ── Root index (rebuildable convenience) ────────────────────────────────────

export function writeRootIndex(root: string, content: string): void {
  secureWrite(rootIndexPath(root), content);
}

export function readRootIndex(root: string): string {
  return filesystemRead(root, rootIndexPath(root), "root index").toString("utf8");
}
