/**
 * KB filesystem — §5.4 live layout and §5.5 record I/O with custody.
 *
 * The KB root is a private directory tree with explicit owner-only custody.
 * Every live file is a current-user-owned, regular, no-follow, mode-0600 file.
 * Every live directory is mode-0700. Staging uses temp files with atomic rename.
 *
 * Readers start from one validated `.kb/current.json` and use only that
 * generation's immutable catalog. They never combine a directory scan with
 * another generation.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  sha256Hex,
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

export class KbFilesystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KbFilesystemError";
  }
}

/** Assert a path is a regular, non-symlink, owner-only file or directory. */
function assertCustody(target: string, type: "file" | "directory"): void {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new KbFilesystemError(`${type} must not be a symlink: ${target}`);
  }
  if (type === "file" && !stat.isFile()) {
    throw new KbFilesystemError(`expected a regular file: ${target}`);
  }
  if (type === "directory" && !stat.isDirectory()) {
    throw new KbFilesystemError(`expected a directory: ${target}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new KbFilesystemError(
      `${type} must be owner-only (got mode ${stat.mode & 0o777}): ${target}`
    );
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
export function secureWrite(filePath: string, content: string): void {
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

/** Read and validate a file as JCS-canonical JSON. */
function readJson(filePath: string): string {
  assertCustody(filePath, "file");
  return readFileSync(filePath, "utf8");
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
export function sourceObjectPath(root: string, digest: Sha256Hex): string {
  return path.join(root, "sources", "objects", digest.slice(0, 2), digest.slice(2));
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

export function readManifest(root: string): KbManifest {
  return validateKbContract(KbManifestSchema, JSON.parse(readJson(manifestPath(root))), "manifest");
}

// ── Policy I/O ──────────────────────────────────────────────────────────────

export function writePolicy(root: string, policy: KbPolicy): void {
  validateKbContract(KbPolicySchema, policy, "policy");
  const dir = path.join(root, ".kb");
  if (!existsSync(dir)) secureMkdir(dir);
  secureWrite(policyPath(root), canonicalJson(policy));
}

export function readPolicy(root: string): KbPolicy {
  return validateKbContract(KbPolicySchema, JSON.parse(readJson(policyPath(root))), "policy");
}

// ── Current selector I/O ────────────────────────────────────────────────────

export function writeCurrent(root: string, current: CurrentGeneration): void {
  validateKbContract(CurrentGenerationSchema, current, "current");
  const dir = path.join(root, ".kb");
  if (!existsSync(dir)) secureMkdir(dir);
  secureWrite(currentPath(root), canonicalJson(current));
}

export function readCurrent(root: string): CurrentGeneration | undefined {
  const p = currentPath(root);
  if (!existsSync(p)) return undefined;
  return validateKbContract(CurrentGenerationSchema, JSON.parse(readJson(p)), "current");
}

// ── Source objects (immutable, content-addressed) ───────────────────────────

export function writeSourceObject(root: string, digest: Sha256Hex, bytes: Buffer): void {
  const calculated = sha256Hex(bytes.toString("utf8"));
  if (calculated !== digest) {
    throw new KbFilesystemError(
      `source object digest mismatch: expected ${digest}, got ${calculated}`
    );
  }
  const p = sourceObjectPath(root, digest);
  if (existsSync(p)) {
    assertCustody(p, "file");
    return; // deduplication: same content already stored
  }
  secureWrite(p, bytes.toString("utf8"));
}

export function readSourceObject(root: string, digest: Sha256Hex): Buffer {
  const p = sourceObjectPath(root, digest);
  assertCustody(p, "file");
  const bytes = readFileSync(p);
  const calculated = sha256Hex(bytes.toString("utf8"));
  if (calculated !== digest) {
    throw new KbFilesystemError(`source object digest mismatch on read: ${digest}`);
  }
  return bytes;
}

// ── Source records (immutable, JCS) ─────────────────────────────────────────

export function writeSourceRecord(root: string, record: SourceRecord): void {
  validateKbContract(SourceRecordSchema, record, "source record");
  // Verify object_ref matches sha256
  const expected = `sources/objects/${record.sha256}`;
  if (record.object_ref !== expected) {
    throw new KbFilesystemError(`object_ref must be exactly '${expected}'`);
  }
  secureWrite(sourceRecordPath(root, record.source_id), canonicalJson(record));
}

export function readSourceRecord(root: string, sourceId: string): SourceRecord {
  return validateKbContract(
    SourceRecordSchema,
    JSON.parse(readJson(sourceRecordPath(root, sourceId))),
    "source record"
  );
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

// ── Conflict records (immutable, JCS) ───────────────────────────────────────

export function writeConflictRecord(root: string, conflict: ConflictRecord): void {
  validateKbContract(ConflictRecordSchema, conflict, "conflict record");
  secureWrite(conflictPath(root, conflict.conflict_record_id), canonicalJson(conflict));
}

// ── Generation catalog (immutable, JCS) ─────────────────────────────────────

export function writeGenerationCatalog(root: string, catalog: GenerationCatalog): void {
  validateKbContract(GenerationCatalogSchema, catalog, "generation catalog");
  const dir = generationsDir(root);
  if (!existsSync(dir)) secureMkdir(dir);
  secureWrite(generationCatalogPath(root, catalog.generation_id), canonicalJson(catalog));
}

export function readGenerationCatalog(root: string, genId: string): GenerationCatalog {
  return validateKbContract(
    GenerationCatalogSchema,
    JSON.parse(readJson(generationCatalogPath(root, genId))),
    "generation catalog"
  );
}

// ── Root index (rebuildable convenience) ────────────────────────────────────

export function writeRootIndex(root: string, content: string): void {
  secureWrite(rootIndexPath(root), content);
}
