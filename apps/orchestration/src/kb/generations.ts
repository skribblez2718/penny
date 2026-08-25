/**
 * KB generations — §5.10 immutable generation publication and crash recovery.
 *
 * A generation is a complete, immutable snapshot. Publication has exactly one
 * commit point: the atomic replacement of `.kb/current.json`. Everything before
 * it is staging that can be discarded; everything after it is finalization.
 *
 * This module implements:
 * - Building and validating a candidate generation catalog
 * - The atomic selector replacement (the single commit point)
 * - Reading the selected generation
 * - Root index rebuild (convenience, never authority)
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { Static, TSchema } from "typebox";

import { Checkpointer } from "../checkpointer.js";
import { RunContext } from "../context.js";

import {
  canonicalJson,
  sha256Hex,
  validateKbContract,
  ClaimsSidecarSchema,
  ConflictRecordSchema,
  CurrentGenerationSchema,
  GenerationCatalogSchema,
  KbManifestSchema,
  KbPolicySchema,
  PageRevisionFrontmatterSchema,
  SourceRecordSchema,
  type CurrentGeneration,
  type GenerationCatalog,
  type InitReservation,
  type KbManifest,
  type KbPolicy,
  type PageRevisionFrontmatter,
  type PublicationFileRecord,
  type PublicationFileRole,
  type Sha256Hex,
} from "./contracts.js";
import {
  conflictPath,
  generationsDir,
  currentPath,
  generationCatalogPath,
  generationIndexPath,
  lockPath,
  manifestPath,
  pageClaimsPath,
  pageMarkdownPath,
  policyPath,
  readCurrent,
  readGenerationCatalog,
  rootIndexPath,
  sourceObjectPath,
  sourceObjectRef,
  sourceRecordPath,
  secureWrite,
  writeCurrent,
  writeRootIndex,
} from "./filesystem.js";
import {
  KbCoreReadError,
  readContainedKbFile,
  tryReadContainedKbFile,
  withContainedKbFile,
} from "./core-read.js";

export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

function requiredGenerationValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new GenerationError(`${label} is absent`);
  }
  return value;
}

const GROUP_OR_OTHER_WRITE_MASK = 0o022;

/** Generate a new opaque generation ID. */
export function newGenerationId(): string {
  return `gen_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Build a generation catalog from the current KB state.
 *
 * The catalog records the digest of every selected source record, source object,
 * page revision pair, and conflict record, plus the manifest and policy digests.
 */
export function buildCatalog(input: {
  generation_id: string;
  kb_id: string;
  parent_generation_id?: string;
  manifest: KbManifest;
  policy: KbPolicy;
  pages: ReadonlyArray<{
    page_id: string;
    revision_id: string;
    page_sha256: Sha256Hex;
    claims_sha256: Sha256Hex;
  }>;
  source_records: ReadonlyArray<{ source_id: string; record_sha256: Sha256Hex }>;
  source_objects: readonly Sha256Hex[];
  conflicts: ReadonlyArray<{ conflict_id: string; conflict_sha256: Sha256Hex }>;
  index_sha256: Sha256Hex;
  created_at?: string;
}): GenerationCatalog {
  const manifestDigest = sha256Hex(canonicalJson(input.manifest));
  const policyDigest = sha256Hex(canonicalJson(input.policy));

  const pages: Record<
    string,
    { revision_id: string; page_sha256: Sha256Hex; claims_sha256: Sha256Hex }
  > = {};
  for (const p of input.pages) {
    pages[p.page_id] = {
      revision_id: p.revision_id,
      page_sha256: p.page_sha256,
      claims_sha256: p.claims_sha256,
    };
  }

  const sourceRecordsMap: Record<string, Sha256Hex> = {};
  for (const s of input.source_records) {
    sourceRecordsMap[s.source_id] = s.record_sha256;
  }

  const conflictRecordsMap: Record<string, Sha256Hex> = {};
  for (const c of input.conflicts) {
    conflictRecordsMap[c.conflict_id] = c.conflict_sha256;
  }

  const catalog: GenerationCatalog = {
    schema_version: 1,
    generation_id: input.generation_id,
    kb_id: input.kb_id,
    manifest_sha256: manifestDigest,
    policy_sha256: policyDigest,
    pages,
    source_records: sourceRecordsMap,
    source_objects: [...input.source_objects],
    conflict_records: conflictRecordsMap,
    index_sha256: input.index_sha256,
    created_at: input.created_at ?? new Date().toISOString(),
    ...(input.parent_generation_id ? { parent_generation_id: input.parent_generation_id } : {}),
  };

  return validateKbContract(GenerationCatalogSchema, catalog, "generation catalog");
}

/**
 * Generation index — §5.10 `index.sqlite`.
 *
 * The manifest contract names the generation index `index.sqlite`; it is a
 * derived, verifiable artifact: the `index_sha256` recorded in the catalog and
 * selector is the SHA-256 of the index's CANONICAL CONTENT (JCS payload over
 * the sorted page rows), not of the SQLite file bytes (which are not a stable
 * digest target). Verification re-reads the rows and re-computes that payload,
 * so a tampered or corrupt index is detected at read time.
 */

interface IndexRow {
  page_id: string;
  revision_id: string;
  title: string;
  summary: string;
  body_sha256: Sha256Hex;
  body: string;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonValue(source: string): unknown {
  const value: unknown = JSON.parse(source);
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSqliteModule(value: unknown): value is typeof import("node:sqlite") {
  return (
    value !== null &&
    typeof value === "object" &&
    "DatabaseSync" in value &&
    typeof value.DatabaseSync === "function"
  );
}

function sqliteModule(): typeof import("node:sqlite") {
  const mod: unknown = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(mod)) {
    throw new GenerationError("Node.js runtime does not provide node:sqlite");
  }
  return mod;
}

function sqliteText(row: unknown, field: string, label: string): string {
  if (!isUnknownRecord(row) || typeof row[field] !== "string") {
    throw new GenerationError(`${label} is malformed`);
  }
  return row[field];
}

/** One indexable page (content as published). */
export interface IndexPageEntry {
  readonly page_id: string;
  readonly revision_id: string;
  readonly title: string;
  readonly summary: string;
  readonly body_sha256: Sha256Hex;
  readonly body: string;
}

function indexPathFor(root: string, generationId: string): string {
  return path.join(generationsDir(root), generationId, "index.sqlite");
}

function indexPayload(generationId: string, kbId: string, rows: readonly IndexRow[]) {
  const sorted = [...rows].sort((a, b) =>
    a.page_id !== b.page_id
      ? a.page_id < b.page_id
        ? -1
        : 1
      : a.revision_id !== b.revision_id
        ? a.revision_id < b.revision_id
          ? -1
          : 1
        : 0
  );
  return {
    schema_version: 1,
    generation_id: generationId,
    kb_id: kbId,
    pages: sorted.map((r) => ({
      page_id: r.page_id,
      revision_id: r.revision_id,
      title: r.title,
      summary: r.summary,
      body_sha256: r.body_sha256,
      body: r.body,
    })),
  };
}

/**
 * Build the generation's `index.sqlite` deterministically from the published
 * page set and return its canonical-content digest. Idempotent for the same
 * inputs (rows re-inserted in sorted order; file rebuilt from scratch).
 */
export function buildGenerationIndex(
  root: string,
  generationId: string,
  kbId: string,
  pages: readonly IndexPageEntry[]
): { index_path: string; index_sha256: Sha256Hex } {
  const rows: IndexRow[] = pages.map((p) => ({
    page_id: p.page_id,
    revision_id: p.revision_id,
    title: p.title,
    summary: p.summary,
    body_sha256: p.body_sha256,
    body: p.body,
  }));

  const genDir = path.join(generationsDir(root), generationId);
  if (!existsSync(genDir)) {
    mkdirSync(genDir, { recursive: true, mode: 0o700 });
    chmodSync(genDir, 0o700);
  }
  const indexPath = path.join(genDir, "index.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path.join(genDir, `index.sqlite${suffix}`);
    if (existsSync(f)) {
      const st = lstatSync(f);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new GenerationError(`index location is not a regular file: suffix '${suffix}'`);
      }
      if ((st.mode & 0o077) !== 0) {
        throw new GenerationError("index location is not owner-only; refusing to rebuild");
      }
    }
  }

  const index_sha256 = sha256Hex(canonicalJson(indexPayload(generationId, kbId, rows)));

  const { DatabaseSync } = sqliteModule();
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(indexPath, { readOnly: false, enableForeignKeyConstraints: false });
    db.exec("PRAGMA journal_mode=OFF;");
    db.exec("DROP TABLE IF EXISTS pages;");
    db.exec(
      `CREATE TABLE pages (
         page_id TEXT PRIMARY KEY,
         revision_id TEXT NOT NULL,
         title TEXT NOT NULL,
         summary TEXT NOT NULL,
         body_sha256 TEXT NOT NULL,
         body TEXT NOT NULL
       );`
    );
    const ins = db.prepare(
      "INSERT INTO pages (page_id, revision_id, title, summary, body_sha256, body) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const sorted = [...rows].sort((a, b) =>
      a.page_id !== b.page_id
        ? a.page_id < b.page_id
          ? -1
          : 1
        : a.revision_id < b.revision_id
          ? -1
          : 1
    );
    for (const r of sorted) {
      ins.run(r.page_id, r.revision_id, r.title, r.summary, r.body_sha256, r.body);
    }
    const check = db.prepare("PRAGMA integrity_check;").get();
    if (sqliteText(check, "integrity_check", "index integrity result") !== "ok") {
      throw new GenerationError("index.sqlite failed integrity check");
    }
  } finally {
    db?.close();
  }
  chmodSync(indexPath, 0o600);
  return { index_path: indexPath, index_sha256 };
}

/** Compute the selector/catalog index digest without touching the publication plane. */
export function generationIndexDigest(
  generationId: string,
  kbId: string,
  pages: readonly IndexPageEntry[]
): Sha256Hex {
  return sha256Hex(
    canonicalJson(
      indexPayload(
        generationId,
        kbId,
        pages.map((page) => ({
          page_id: page.page_id,
          revision_id: page.revision_id,
          title: page.title,
          summary: page.summary,
          body_sha256: page.body_sha256,
          body: page.body,
        }))
      )
    )
  );
}

/** Build one preindexed staged `index.sqlite` at an exact transaction-owned key. */
function buildGenerationIndexAt(
  indexPath: string,
  generationId: string,
  kbId: string,
  pages: readonly IndexPageEntry[]
): void {
  const parent = path.dirname(indexPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const { DatabaseSync } = sqliteModule();
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(indexPath, { readOnly: false, enableForeignKeyConstraints: false });
    db.exec(
      `PRAGMA journal_mode=OFF;
       CREATE TABLE pages (
         page_id TEXT PRIMARY KEY,
         revision_id TEXT NOT NULL,
         title TEXT NOT NULL,
         summary TEXT NOT NULL,
         body_sha256 TEXT NOT NULL,
         body TEXT NOT NULL
       );`
    );
    const insert = db.prepare(
      "INSERT INTO pages (page_id,revision_id,title,summary,body_sha256,body) VALUES (?,?,?,?,?,?)"
    );
    for (const page of [...pages].sort((left, right) =>
      left.page_id !== right.page_id
        ? left.page_id < right.page_id
          ? -1
          : 1
        : left.revision_id < right.revision_id
          ? -1
          : 1
    )) {
      insert.run(
        page.page_id,
        page.revision_id,
        page.title,
        page.summary,
        page.body_sha256,
        page.body
      );
    }
    const check = db.prepare("PRAGMA integrity_check;").get();
    if (sqliteText(check, "integrity_check", "staged index integrity result") !== "ok")
      throw new GenerationError("staged index failed integrity check");
  } finally {
    db?.close();
  }
  chmodSync(indexPath, 0o600);
}

/**
 * Verify a published generation's index against the expected canonical-content
 * digest (from the catalog/selector). Throws on missing, unowned, tampered,
 * or corrupt index. Readers must run this before trusting any retrieval from
 * the generation.
 */
export function verifyGenerationIndex(
  root: string,
  generationId: string,
  expectedIndexSha256: Sha256Hex,
  kbId: string
): void {
  const indexPath = indexPathFor(root, generationId);
  try {
    withContainedKbFile(root, indexPath, { label: "generation index" }, ({ pinnedPath }) => {
      const { DatabaseSync } = sqliteModule();
      const db = new DatabaseSync(pinnedPath, { readOnly: true });
      try {
        const table: IndexRow[] = db
          .prepare(
            "SELECT page_id, revision_id, title, summary, body_sha256, body FROM pages ORDER BY page_id, revision_id"
          )
          .all()
          .map((row) => {
            const pageId = sqliteText(row, "page_id", "index page_id");
            const revisionId = sqliteText(row, "revision_id", "index revision_id");
            const body = sqliteText(row, "body", "index body");
            const calculatedBodySha256 = sha256Hex(body);
            if (calculatedBodySha256 !== sqliteText(row, "body_sha256", "index body_sha256")) {
              throw new GenerationError(`index row '${pageId}/${revisionId}' body digest mismatch`);
            }
            return {
              page_id: pageId,
              revision_id: revisionId,
              title: sqliteText(row, "title", "index title"),
              summary: sqliteText(row, "summary", "index summary"),
              body_sha256: calculatedBodySha256,
              body,
            };
          });
        // The payload digest embeds generation identity and kb; the caller
        // supplies kbId (the selected catalog's kb_id), so verification needs no
        // second catalog read.
        const actual = sha256Hex(
          canonicalJson(
            indexPayload(
              generationId,
              kbId,
              table.map((r) => ({
                page_id: r.page_id,
                revision_id: r.revision_id,
                title: r.title,
                summary: r.summary,
                body_sha256: r.body_sha256,
                body: r.body,
              }))
            )
          )
        );
        if (actual !== expectedIndexSha256) {
          throw new GenerationError(
            `index digest mismatch for generation '${generationId}': expected ${expectedIndexSha256}, got ${actual}`
          );
        }
      } finally {
        db.close();
      }
    });
  } catch (error) {
    if (error instanceof KbCoreReadError) {
      throw new GenerationError(error.message);
    }
    throw error;
  }
}

// ── Publication ─────────────────────────────────────────────────────────────

export type PublicationFaultHook = (boundary: string) => void;

/**
 * Durable owner for standalone workflow fixtures that do not have the host
 * control DB. Public engine/adapter actions always supply their real
 * checkpointer; this fallback still uses the same transaction/file schemas and
 * never falls back to unindexed publication bytes.
 */
export function openStandalonePublicationCheckpointer(input: {
  root: string;
  runId: string;
  profileId: string;
  action: "init" | "ingest" | "save";
}): Checkpointer {
  const database = path.join(
    input.root,
    "work",
    input.runId,
    "transaction",
    "publication-control.db"
  );
  const checkpointer = new Checkpointer(database);
  checkpointer.bindKbRuntimeProjectRoot(input.root);
  if (checkpointer.loadRunById(input.runId) === undefined) {
    const context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: input.runId,
        session_id: `standalone_${sha256Hex(input.runId).slice(0, 32)}`,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "Standalone transaction-owned KB publication.",
      constraints: { action: input.action, kb_profile_id: input.profileId },
      projectRoot: input.root,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
    });
    checkpointer.createRun(context, "standalone_publication_started", {});
  }
  return checkpointer;
}

export function standalonePublicationTransactionId(
  runId: string,
  action: "init" | "ingest" | "save"
): string {
  return `pub_${sha256Hex(`${action}\u0000${runId}`).slice(0, 40)}`;
}

export interface PublicationImmutableInput {
  readonly role: Exclude<PublicationFileRole, "catalog" | "index" | "selector">;
  /** Exact root-relative immutable final key. */
  readonly final_key: string;
  readonly bytes: string | Buffer;
}

export interface PublicationAuthorityHooks {
  /** Idempotent exact-transaction reservation immediately before selector commit. */
  readonly reserve?: (transactionId: string) => void;
  /** Idempotent selector-proven finalization; never called while the base is selected. */
  readonly finalize?: (transactionId: string) => void;
  /** Proven pre-selector abort of this transaction's claimed/reserved authority. */
  readonly abort?: (transactionId: string) => void;
}

export interface PublishGenerationTransactionInput {
  readonly root: string;
  readonly checkpointer: Checkpointer;
  readonly run_id: string;
  readonly transaction_id: string;
  readonly kb_profile_id: string;
  readonly action: "init" | "ingest" | "save";
  readonly base_generation_id: string | null;
  readonly base_selector_sha256: Sha256Hex | null;
  readonly catalog: GenerationCatalog;
  readonly index_pages: readonly IndexPageEntry[];
  readonly immutable_files: readonly PublicationImmutableInput[];
  readonly published_at: string;
  /** Required for the sole base-none transaction; omitted for ingest/save. */
  readonly init_reservation?: {
    readonly request_sha256: Sha256Hex;
    readonly profile_commitment_sha256: Sha256Hex;
  };
  readonly authority?: PublicationAuthorityHooks;
  readonly require_content_review?: boolean;
  /** Leave `finalizing` until the matching immutable operation receipt commits. */
  readonly await_operation_receipt?: boolean;
  readonly fault?: PublicationFaultHook;
}

export interface PublishedGenerationTransaction {
  readonly selector: CurrentGeneration;
  readonly selector_sha256: Sha256Hex;
  readonly transaction_id: string;
  readonly candidate_generation_id: string;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validOpaqueId(value: string): boolean {
  return OPAQUE_ID.test(value) && !value.includes("..");
}

function publicationHit(input: PublishGenerationTransactionInput, boundary: string): void {
  input.fault?.(boundary);
}

function safeRelativeKey(key: string): string {
  if (
    key.length === 0 ||
    path.isAbsolute(key) ||
    key.split(/[\\/]/u).some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GenerationError(`publication key is not a closed relative path: '${key}'`);
  }
  return key.split("/").join(path.sep);
}

function publicationPath(root: string, key: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, safeRelativeKey(key));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new GenerationError("publication key escapes the KB root");
  }
  return resolved;
}

function ensureOwnerDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function ensurePublicationParent(root: string, directory: string): void {
  if (path.resolve(directory) !== path.resolve(root)) {
    ensureOwnerDirectory(directory);
    return;
  }
  const stat = lstatSync(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & GROUP_OR_OTHER_WRITE_MASK) !== 0
  ) {
    throw new GenerationError("admitted KB root lost no-follow owner custody");
  }
  // Preserve an exact public scaffold root such as 0755; profile admission
  // still enforces private outside-worktree roots, and descendants stay 0700.
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readPublicationFile(
  root: string,
  file: string,
  input: {
    readonly label: string;
    readonly sha256?: string;
    readonly byteLength?: number;
    readonly allowedLinkCounts?: readonly (1 | 2)[];
  }
): Buffer {
  const linkCounts = input.allowedLinkCounts ?? [1];
  let custodyFailure: KbCoreReadError | undefined;
  for (const expectedLinkCount of linkCounts) {
    try {
      return readContainedKbFile(root, file, {
        label: input.label,
        expectedLinkCount,
        ...(input.sha256 === undefined ? {} : { expectedSha256: input.sha256 }),
        ...(input.byteLength === undefined ? {} : { expectedByteLength: input.byteLength }),
      });
    } catch (error) {
      if (error instanceof KbCoreReadError && error.code === "custody") {
        custodyFailure = error;
        continue;
      }
      if (
        error instanceof KbCoreReadError &&
        (error.code === "digest_mismatch" || error.code === "length_mismatch")
      ) {
        throw new GenerationError(`${input.label} bytes do not match their durable row`);
      }
      if (error instanceof KbCoreReadError) throw new GenerationError(error.message);
      throw error;
    }
  }
  throw new GenerationError(custodyFailure?.message ?? `${input.label} custody changed`);
}

function readExactFile(
  root: string,
  file: string,
  sha256: string,
  byteLength?: number,
  allowedLinkCounts: readonly (1 | 2)[] = [1]
): Buffer {
  return readPublicationFile(root, file, {
    label: "publication file",
    sha256,
    ...(byteLength === undefined ? {} : { byteLength }),
    allowedLinkCounts,
  });
}

function assertExactFile(root: string, file: string, sha256: string, byteLength: number): void {
  void readExactFile(root, file, sha256, byteLength);
}

function bytesDigest(bytes: Buffer): Sha256Hex {
  const { createHash } = process.getBuiltinModule("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex") as Sha256Hex;
}

function writeStagedFile(
  input: PublishGenerationTransactionInput,
  file: string,
  bytes: Buffer
): void {
  ensurePublicationParent(input.root, path.dirname(file));
  publicationHit(input, "before_file_write");
  const writer = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeFileSync(writer, bytes);
  } finally {
    closeSync(writer);
  }
  chmodSync(file, 0o600);
  publicationHit(input, "after_file_write");
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  publicationHit(input, "after_file_fsync");
  fsyncDirectory(path.dirname(file));
}

interface HeldWriterLock {
  readonly file: string;
  readonly token: string;
  release(): void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

/** Cross-process exclusive writer lock with dead-owner recovery. */
function acquireWriterLock(root: string, transactionId: string): HeldWriterLock {
  const file = lockPath(root);
  ensureOwnerDirectory(path.dirname(file));
  for (;;) {
    const token = randomUUID();
    const bytes = canonicalJson({
      schema_version: 1,
      pid: process.pid,
      transaction_id: transactionId,
      token,
    });
    try {
      const descriptor = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        writeFileSync(descriptor, bytes, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      chmodSync(file, 0o600);
      fsyncDirectory(path.dirname(file));
      return {
        file,
        token,
        release() {
          try {
            const stored = parseJsonValue(
              readPublicationFile(root, file, { label: "KB writer lock" }).toString("utf8")
            );
            if (!isUnknownRecord(stored) || stored["token"] !== token) {
              throw new GenerationError("KB writer lock ownership changed");
            }
            unlinkSync(file);
            fsyncDirectory(path.dirname(file));
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
        throw new GenerationError("KB writer lock has unsafe custody");
      }
      let owner: unknown;
      try {
        owner = parseJsonValue(
          readPublicationFile(root, file, { label: "KB writer lock" }).toString("utf8")
        );
      } catch {
        throw new GenerationError("KB writer lock is malformed");
      }
      if (
        !isUnknownRecord(owner) ||
        typeof owner["pid"] !== "number" ||
        !Number.isSafeInteger(owner["pid"])
      ) {
        throw new GenerationError("KB writer lock owner is malformed");
      }
      if (processAlive(owner["pid"])) throw new GenerationError("KB writer lock is held");
      unlinkSync(file);
      fsyncDirectory(path.dirname(file));
    }
  }
}

function publicationFileId(transactionId: string, role: string, finalKey: string): string {
  return `pubf_${sha256Hex(`${transactionId}\u0000${role}\u0000${finalKey}`).slice(0, 40)}`;
}

function stagedKeyFor(
  stagingRoot: string,
  transactionId: string,
  role: PublicationFileRole,
  finalKey: string
): string {
  if (role === "selector") return `.kb/.current.${transactionId}.tmp`;
  if (role === "catalog") return `${stagingRoot}/generation/catalog.json`;
  if (role === "index") return `${stagingRoot}/generation/index.sqlite`;
  return `${stagingRoot}/immutables/${role}/${sha256Hex(finalKey).slice(0, 40)}`;
}

function currentSelectorClassification(
  root: string,
  publication: ReturnType<Checkpointer["kbPublication"]>
): "base" | "candidate" | "absent" | "foreign" {
  if (publication === undefined) throw new GenerationError("publication record is absent");
  const file = currentPath(root);
  let bytes: Buffer | undefined;
  try {
    bytes = tryReadContainedKbFile(root, file, {
      label: "current selector",
      expectedLinkCount: 1,
    });
  } catch (error) {
    if (error instanceof KbCoreReadError && error.code === "custody") {
      try {
        bytes = tryReadContainedKbFile(root, file, {
          label: "current selector recovery link",
          expectedLinkCount: 2,
        });
      } catch {
        return "foreign";
      }
    } else {
      return "foreign";
    }
  }
  if (bytes === undefined) return "absent";
  const raw = bytes.toString("utf8");
  let current: CurrentGeneration;
  try {
    current = validateKbContract(CurrentGenerationSchema, JSON.parse(raw), "current selector");
  } catch {
    return "foreign";
  }
  if (canonicalJson(current) !== raw) return "foreign";
  const digest = sha256Hex(raw);
  if (
    current.generation_id === publication.candidate_generation_id &&
    raw === publication.selector_jcs &&
    digest === publication.selector_sha256
  ) {
    return "candidate";
  }
  if (
    publication.base_generation_id !== null &&
    current.generation_id === publication.base_generation_id &&
    digest === publication.base_selector_sha256
  ) {
    return "base";
  }
  return "foreign";
}

function rootIndexBytes(catalog: GenerationCatalog, publishedAt: string): string {
  const lines = [
    `# ${catalog.kb_id}`,
    "",
    `Generation: ${catalog.generation_id}`,
    `Published: ${publishedAt}`,
    "",
    "## Pages",
    "",
  ];
  for (const pageId of Object.keys(catalog.pages).sort()) {
    const entry = requiredGenerationValue(catalog.pages[pageId], "catalog page entry");
    lines.push(
      `- [${pageId}](pages/${pageId}/revisions/${entry.revision_id}/page.md): revision ${entry.revision_id}`
    );
  }
  lines.push(
    "",
    "## Sources",
    "",
    ...Object.keys(catalog.source_records)
      .sort()
      .map((id) => `- ${id}`)
  );
  if (Object.keys(catalog.conflict_records).length > 0) {
    lines.push(
      "",
      "## Conflicts",
      "",
      ...Object.keys(catalog.conflict_records)
        .sort()
        .map((id) => `- ${id}`)
    );
  }
  return `${lines.join("\n")}\n`;
}

function discardPreselectorPublication(
  input: PublishGenerationTransactionInput,
  publication: NonNullable<ReturnType<Checkpointer["kbPublication"]>>
): void {
  let current = publication;
  if (current.lifecycle !== "discarding" && current.lifecycle !== "discarded") {
    current = input.checkpointer.advanceKbPublication({
      transaction_id: current.transaction_id,
      expected: ["planned", "staged", "immutables_published", "generation_published"],
      next: "discarding",
    });
  }
  if (current.lifecycle === "discarded") return;
  const selector = current.files.find((file) => file.role === "selector");
  if (selector !== undefined) {
    const temporary = publicationPath(input.root, selector.staging_key);
    if (existsSync(temporary)) {
      const stat = lstatSync(temporary);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new GenerationError("discard selector temp has unsafe custody");
      }
      unlinkSync(temporary);
      fsyncDirectory(path.dirname(temporary));
    }
  }
  const stagingRoot = publicationPath(input.root, current.staging_root);
  if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: false });
  input.checkpointer.advanceKbPublication({
    transaction_id: current.transaction_id,
    expected: ["discarding"],
    next: "discarded",
  });
}

function rebuildRootIndexForTransaction(
  input: PublishGenerationTransactionInput,
  transactionId: string
): void {
  publicationHit(input, "before_root_index");
  const final = rootIndexPath(input.root);
  const temporary = path.join(input.root, `.index.${transactionId}.tmp`);
  if (existsSync(temporary)) {
    const stat = lstatSync(temporary);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new GenerationError("root-index recovery temp has unsafe custody");
    }
    unlinkSync(temporary);
  }
  writeStagedFile(
    input,
    temporary,
    Buffer.from(rootIndexBytes(input.catalog, input.published_at), "utf8")
  );
  renameSync(temporary, final);
  chmodSync(final, 0o600);
  fsyncDirectory(input.root);
  publicationHit(input, "after_root_index");
}

interface RequiredImmutableFile {
  readonly role: PublicationImmutableInput["role"];
  readonly final_key: string;
  readonly bytes: Buffer;
  readonly sha256: Sha256Hex;
}

interface PublicationCatalogClosure {
  readonly baseCatalog?: GenerationCatalog;
  readonly immutableFiles: readonly RequiredImmutableFile[];
  readonly indexByPage: ReadonlyMap<string, IndexPageEntry>;
}

function relativePublicationKey(root: string, absolute: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(absolute));
  const key = relative.split(path.sep).join("/");
  safeRelativeKey(key);
  return key;
}

function sameCatalogValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function requireCatalogMapIds(catalog: GenerationCatalog): void {
  for (const [kind, ids] of [
    ["page", Object.keys(catalog.pages)],
    ["source", Object.keys(catalog.source_records)],
    ["conflict", Object.keys(catalog.conflict_records)],
  ] as const) {
    for (const id of ids) {
      if (!validOpaqueId(id)) {
        throw new GenerationError(`candidate catalog has an invalid ${kind} id`);
      }
    }
  }
  if (new Set(catalog.source_objects).size !== catalog.source_objects.length) {
    throw new GenerationError("candidate catalog source-object map is not unique");
  }
}

function loadCarriedBase(input: PublishGenerationTransactionInput): GenerationCatalog | undefined {
  if (input.action === "init") {
    if (input.catalog.parent_generation_id !== undefined) {
      throw new GenerationError("base-none catalog must not name a parent generation");
    }
    return undefined;
  }
  if (
    input.base_generation_id === null ||
    input.catalog.parent_generation_id !== input.base_generation_id
  ) {
    throw new GenerationError("candidate catalog does not bind the exact carried base");
  }
  let base: GenerationCatalog;
  try {
    base = readGenerationCatalog(input.root, input.base_generation_id);
  } catch (error) {
    throw new GenerationError(`carried base catalog is unavailable: ${errorMessage(error)}`);
  }
  if (base.generation_id !== input.base_generation_id || base.kb_id !== input.catalog.kb_id) {
    throw new GenerationError("carried base catalog identity does not match the candidate");
  }
  const selected = readCurrent(input.root);
  if (selected?.generation_id === input.base_generation_id) {
    if (
      input.base_selector_sha256 === null ||
      sha256Hex(canonicalJson(selected)) !== input.base_selector_sha256
    ) {
      throw new GenerationError("carried base selector digest changed before planning");
    }
    const baseBytes = readExactFile(
      input.root,
      generationCatalogPath(input.root, input.base_generation_id),
      selected.catalog_sha256
    );
    if (canonicalJson(base) !== baseBytes.toString("utf8")) {
      throw new GenerationError("carried base catalog is not exact canonical bytes");
    }
  }
  return base;
}

function parseCanonicalRecord<T extends TSchema>(input: {
  bytes: Buffer;
  schema: T;
  label: string;
}): Static<T> {
  const raw = input.bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GenerationError(`${input.label} is not valid JSON`);
  }
  const value = validateKbContract(input.schema, parsed, input.label);
  if (canonicalJson(value) !== raw) {
    throw new GenerationError(`${input.label} is not exact canonical JSON`);
  }
  return value;
}

function parsePageMarkdownBytes(
  bytes: Buffer,
  pageId: string,
  revisionId: string
): { frontmatter: PageRevisionFrontmatter; body: string } {
  const raw = bytes.toString("utf8");
  const match = raw.match(/^---\n([^\n]+)\n---\n\n([\s\S]*)$/u);
  if (match === null) throw new GenerationError("mapped page markdown framing is invalid");
  const frontmatterJcs = requiredGenerationValue(match[1], "mapped page frontmatter");
  const body = requiredGenerationValue(match[2], "mapped page body");
  let parsed: unknown;
  try {
    parsed = JSON.parse(frontmatterJcs);
  } catch {
    throw new GenerationError("mapped page frontmatter is not valid JSON");
  }
  const frontmatter = validateKbContract(
    PageRevisionFrontmatterSchema,
    parsed,
    "mapped page frontmatter"
  );
  if (
    canonicalJson(frontmatter) !== frontmatterJcs ||
    frontmatter.page_id !== pageId ||
    frontmatter.revision_id !== revisionId
  ) {
    throw new GenerationError("mapped page frontmatter identity/canonical bytes mismatch");
  }
  return { frontmatter, body };
}

function derivePublicationCatalogClosure(
  input: PublishGenerationTransactionInput
): PublicationCatalogClosure {
  requireCatalogMapIds(input.catalog);
  const base = loadCarriedBase(input);
  if (base !== undefined) {
    for (const pageId of Object.keys(base.pages)) {
      if (!Object.hasOwn(input.catalog.pages, pageId)) {
        throw new GenerationError("candidate catalog omitted a carried page");
      }
    }
    for (const sourceId of Object.keys(base.source_records)) {
      if (!Object.hasOwn(input.catalog.source_records, sourceId)) {
        throw new GenerationError("candidate catalog omitted a carried source record");
      }
    }
    for (const conflictId of Object.keys(base.conflict_records)) {
      if (!Object.hasOwn(input.catalog.conflict_records, conflictId)) {
        throw new GenerationError("candidate catalog omitted a carried conflict");
      }
    }
    const candidateObjects = new Set(input.catalog.source_objects);
    if (base.source_objects.some((digest) => !candidateObjects.has(digest))) {
      throw new GenerationError("candidate catalog omitted a carried source object");
    }
    if (input.catalog.manifest_sha256 !== base.manifest_sha256) {
      throw new GenerationError("candidate catalog changed the static manifest binding");
    }
  }

  const expected: Array<{
    role: PublicationImmutableInput["role"];
    final_key: string;
    sha256: Sha256Hex;
  }> = [];
  if (input.action === "init") {
    if (
      Object.keys(input.catalog.pages).length !== 0 ||
      Object.keys(input.catalog.source_records).length !== 0 ||
      input.catalog.source_objects.length !== 0 ||
      Object.keys(input.catalog.conflict_records).length !== 0
    ) {
      throw new GenerationError("base-none catalog must be the empty first generation");
    }
    expected.push(
      { role: "manifest", final_key: "manifest.json", sha256: input.catalog.manifest_sha256 },
      { role: "policy", final_key: ".kb/policy.json", sha256: input.catalog.policy_sha256 }
    );
  } else {
    const carriedBase = requiredGenerationValue(base, "carried base catalog");
    for (const [pageId, entry] of Object.entries(input.catalog.pages)) {
      if (!sameCatalogValue(carriedBase.pages[pageId], entry)) {
        expected.push(
          {
            role: "page_markdown",
            final_key: relativePublicationKey(
              input.root,
              pageMarkdownPath(input.root, pageId, entry.revision_id)
            ),
            sha256: entry.page_sha256,
          },
          {
            role: "claims",
            final_key: relativePublicationKey(
              input.root,
              pageClaimsPath(input.root, pageId, entry.revision_id)
            ),
            sha256: entry.claims_sha256,
          }
        );
      }
    }
    for (const [sourceId, digest] of Object.entries(input.catalog.source_records)) {
      if (carriedBase.source_records[sourceId] !== digest) {
        expected.push({
          role: "source_record",
          final_key: relativePublicationKey(input.root, sourceRecordPath(input.root, sourceId)),
          sha256: digest,
        });
      }
    }
    const baseObjects = new Set(carriedBase.source_objects);
    for (const digest of input.catalog.source_objects) {
      if (!baseObjects.has(digest)) {
        expected.push({
          role: "source_object",
          final_key: relativePublicationKey(input.root, sourceObjectPath(input.root, digest)),
          sha256: digest,
        });
      }
    }
    for (const [conflictId, digest] of Object.entries(input.catalog.conflict_records)) {
      if (carriedBase.conflict_records[conflictId] !== digest) {
        expected.push({
          role: "conflict",
          final_key: relativePublicationKey(input.root, conflictPath(input.root, conflictId)),
          sha256: digest,
        });
      }
    }
  }

  const allocationMap = new Map<string, PublicationImmutableInput>();
  for (const allocation of input.immutable_files) {
    safeRelativeKey(allocation.final_key);
    const key = `${allocation.role}\u0000${allocation.final_key}`;
    if (allocationMap.has(key)) {
      throw new GenerationError("publication host allocations are duplicated");
    }
    allocationMap.set(key, allocation);
  }
  if (allocationMap.size !== expected.length) {
    throw new GenerationError(
      "publication host allocations are not all-and-only the catalog delta"
    );
  }
  const immutableFiles: RequiredImmutableFile[] = expected.map((required) => {
    const allocation = allocationMap.get(`${required.role}\u0000${required.final_key}`);
    if (allocation === undefined) {
      throw new GenerationError(
        "publication host allocation is absent or mapped to the wrong role/key"
      );
    }
    const bytes = Buffer.isBuffer(allocation.bytes)
      ? Buffer.from(allocation.bytes)
      : Buffer.from(allocation.bytes, "utf8");
    if (bytesDigest(bytes) !== required.sha256) {
      throw new GenerationError("publication host allocation digest does not match the catalog");
    }
    return { ...required, bytes };
  });

  const indexByPage = new Map<string, IndexPageEntry>();
  for (const page of input.index_pages) {
    if (!validOpaqueId(page.page_id) || !validOpaqueId(page.revision_id)) {
      throw new GenerationError("candidate index contains an invalid page identity");
    }
    if (indexByPage.has(page.page_id)) {
      throw new GenerationError("candidate index contains a duplicate page row");
    }
    const catalogEntry = input.catalog.pages[page.page_id];
    if (
      catalogEntry === undefined ||
      catalogEntry.revision_id !== page.revision_id ||
      page.body_sha256 !== sha256Hex(page.body)
    ) {
      throw new GenerationError(
        "candidate index row does not map exactly to the catalog/page body"
      );
    }
    indexByPage.set(page.page_id, page);
  }
  if (indexByPage.size !== Object.keys(input.catalog.pages).length) {
    throw new GenerationError("candidate index rows are not all-and-only the catalog pages");
  }

  const allocated = new Map(immutableFiles.map((file) => [file.final_key, file]));
  const requiredAllocatedFile = (finalKey: string, label: string) =>
    requiredGenerationValue(allocated.get(finalKey), label);
  if (input.action === "init") {
    const manifestFile = requiredAllocatedFile("manifest.json", "allocated init manifest");
    const policyFile = requiredAllocatedFile(".kb/policy.json", "allocated init policy");
    const manifest = parseCanonicalRecord({
      bytes: manifestFile.bytes,
      schema: KbManifestSchema,
      label: "allocated init manifest",
    });
    const policy = parseCanonicalRecord({
      bytes: policyFile.bytes,
      schema: KbPolicySchema,
      label: "allocated init policy",
    });
    if (manifest.kb_id !== input.catalog.kb_id || policy.kb_id !== input.catalog.kb_id) {
      throw new GenerationError("allocated init manifest/policy KB identity mismatch");
    }
  } else {
    const carriedBase = requiredGenerationValue(base, "carried base catalog");
    const changedPages = immutableFiles.filter((file) => file.role === "page_markdown");
    if (changedPages.length === 0) {
      throw new GenerationError("ingest/save publication has an empty approved page plan");
    }
    if (input.action === "save") {
      if (
        immutableFiles.some(
          (file) => file.role === "source_object" || file.role === "source_record"
        ) ||
        !sameCatalogValue(input.catalog.source_records, carriedBase.source_records) ||
        !sameCatalogValue(input.catalog.source_objects, carriedBase.source_objects)
      ) {
        throw new GenerationError("save publication cannot add or change source mappings");
      }
    } else if (!immutableFiles.some((file) => file.role === "source_record")) {
      throw new GenerationError("ingest publication has no admitted source-record allocation");
    }

    for (const [pageId, entry] of Object.entries(input.catalog.pages)) {
      if (sameCatalogValue(carriedBase.pages[pageId], entry)) continue;
      const pageFile = requiredAllocatedFile(
        relativePublicationKey(input.root, pageMarkdownPath(input.root, pageId, entry.revision_id)),
        "allocated page markdown"
      );
      const claimsFile = requiredAllocatedFile(
        relativePublicationKey(input.root, pageClaimsPath(input.root, pageId, entry.revision_id)),
        "allocated claims sidecar"
      );
      const page = parsePageMarkdownBytes(pageFile.bytes, pageId, entry.revision_id);
      const claims = parseCanonicalRecord({
        bytes: claimsFile.bytes,
        schema: ClaimsSidecarSchema,
        label: "allocated claims sidecar",
      });
      const index = requiredGenerationValue(indexByPage.get(pageId), "candidate index page");
      if (
        claims.page_id !== pageId ||
        claims.revision_id !== entry.revision_id ||
        index.body !== page.body ||
        index.title !== page.frontmatter.title ||
        index.summary !== page.frontmatter.summary
      ) {
        throw new GenerationError("allocated page/claims/index identities or content mismatch");
      }
    }
    for (const [sourceId, digest] of Object.entries(input.catalog.source_records)) {
      if (carriedBase.source_records[sourceId] === digest) continue;
      const file = requiredAllocatedFile(
        relativePublicationKey(input.root, sourceRecordPath(input.root, sourceId)),
        "allocated source record"
      );
      const record = parseCanonicalRecord({
        bytes: file.bytes,
        schema: SourceRecordSchema,
        label: "allocated source record",
      });
      if (
        record.source_id !== sourceId ||
        record.object_ref !== sourceObjectRef(record.sha256) ||
        !input.catalog.source_objects.includes(record.sha256)
      ) {
        throw new GenerationError("allocated source record identity/object link mismatch");
      }
    }
    for (const [conflictId, digest] of Object.entries(input.catalog.conflict_records)) {
      if (carriedBase.conflict_records[conflictId] === digest) continue;
      const file = requiredAllocatedFile(
        relativePublicationKey(input.root, conflictPath(input.root, conflictId)),
        "allocated conflict record"
      );
      const conflict = parseCanonicalRecord({
        bytes: file.bytes,
        schema: ConflictRecordSchema,
        label: "allocated conflict record",
      });
      if (conflict.conflict_record_id !== conflictId) {
        throw new GenerationError("allocated conflict record embeds another identity");
      }
    }
  }

  return {
    ...(base === undefined ? {} : { baseCatalog: base }),
    immutableFiles,
    indexByPage,
  };
}

function assertExactDurableFilePlan(
  publication: NonNullable<ReturnType<Checkpointer["kbPublication"]>>,
  expected: readonly PublicationFileRecord[]
): void {
  const project = (row: PublicationFileRecord) => ({
    publication_file_id: row.publication_file_id,
    transaction_id: row.transaction_id,
    role: row.role,
    staging_key: row.staging_key,
    final_key: row.final_key,
  });
  if (
    publication.files.length !== expected.length ||
    canonicalJson(publication.files.map(project)) !== canonicalJson(expected.map(project))
  ) {
    throw new GenerationError("durable publication rows are absent, extra, or mismatched");
  }
}

function verifyCompleteMappedPublication(input: {
  publicationInput: PublishGenerationTransactionInput;
  publication: NonNullable<ReturnType<Checkpointer["kbPublication"]>>;
  plannedFiles: readonly PublicationFileRecord[];
  closure: PublicationCatalogClosure;
  selector: CurrentGeneration;
}): void {
  const { publicationInput: request, publication, plannedFiles, selector } = input;
  assertExactDurableFilePlan(publication, plannedFiles);
  const rowsByRoleAndKey = new Map(
    publication.files.map((row) => [`${row.role}\u0000${row.final_key}`, row])
  );
  for (const row of publication.files) {
    const expectedState = row.role === "selector" ? ["staged", "published"] : ["published"];
    if (
      !expectedState.includes(row.state) ||
      row.sha256 === undefined ||
      row.byte_length === undefined
    ) {
      throw new GenerationError("publication row lacks exact published/staged byte evidence");
    }
  }
  for (const required of input.closure.immutableFiles) {
    const row = rowsByRoleAndKey.get(`${required.role}\u0000${required.final_key}`);
    if (row?.sha256 !== required.sha256 || row.byte_length !== required.bytes.length) {
      throw new GenerationError("durable publication row digest/length mismatches its catalog map");
    }
  }

  const candidateAlreadySelected =
    currentSelectorClassification(request.root, publication) === "candidate";
  const manifestBytes = readExactFile(
    request.root,
    manifestPath(request.root),
    request.catalog.manifest_sha256
  );
  const manifest = parseCanonicalRecord({
    bytes: manifestBytes,
    schema: KbManifestSchema,
    label: "mapped manifest",
  });
  if (manifest.kb_id !== request.catalog.kb_id) {
    throw new GenerationError("mapped manifest KB identity mismatch");
  }
  // Policy digests are historical after the selector commits. Before commit
  // (and always for base-none init), re-open the exact policy the catalog maps.
  if (!candidateAlreadySelected || request.action === "init") {
    const policyBytes = readExactFile(
      request.root,
      policyPath(request.root),
      request.catalog.policy_sha256
    );
    const policy = parseCanonicalRecord({
      bytes: policyBytes,
      schema: KbPolicySchema,
      label: "mapped policy",
    });
    if (policy.kb_id !== request.catalog.kb_id) {
      throw new GenerationError("mapped policy KB identity mismatch");
    }
  }

  const claimRefs = new Set<string>();
  for (const [pageId, entry] of Object.entries(request.catalog.pages)) {
    const pageBytes = readExactFile(
      request.root,
      pageMarkdownPath(request.root, pageId, entry.revision_id),
      entry.page_sha256
    );
    const claimsBytes = readExactFile(
      request.root,
      pageClaimsPath(request.root, pageId, entry.revision_id),
      entry.claims_sha256
    );
    const page = parsePageMarkdownBytes(pageBytes, pageId, entry.revision_id);
    const claims = parseCanonicalRecord({
      bytes: claimsBytes,
      schema: ClaimsSidecarSchema,
      label: "mapped claims sidecar",
    });
    const index = input.closure.indexByPage.get(pageId);
    if (
      claims.page_id !== pageId ||
      claims.revision_id !== entry.revision_id ||
      index === undefined ||
      index.revision_id !== entry.revision_id ||
      index.body !== page.body ||
      index.body_sha256 !== sha256Hex(page.body) ||
      index.title !== page.frontmatter.title ||
      index.summary !== page.frontmatter.summary
    ) {
      throw new GenerationError("mapped page/claims/index closure changed before selector commit");
    }
    for (const claim of claims.claims) {
      claimRefs.add(`${pageId}\u0000${entry.revision_id}\u0000${claim.claim_id}`);
      if (
        claim.evidence.some(
          (evidence) => !Object.hasOwn(request.catalog.source_records, evidence.source_id)
        )
      ) {
        throw new GenerationError("mapped claim cites a source outside the candidate catalog");
      }
    }
  }

  for (const digest of request.catalog.source_objects) {
    readExactFile(request.root, sourceObjectPath(request.root, digest), digest);
  }
  for (const [sourceId, digest] of Object.entries(request.catalog.source_records)) {
    const bytes = readExactFile(request.root, sourceRecordPath(request.root, sourceId), digest);
    const record = parseCanonicalRecord({
      bytes,
      schema: SourceRecordSchema,
      label: "mapped source record",
    });
    if (
      record.source_id !== sourceId ||
      record.object_ref !== sourceObjectRef(record.sha256) ||
      !request.catalog.source_objects.includes(record.sha256)
    ) {
      throw new GenerationError("mapped source record identity/object closure mismatch");
    }
  }
  for (const [conflictId, digest] of Object.entries(request.catalog.conflict_records)) {
    const bytes = readExactFile(request.root, conflictPath(request.root, conflictId), digest);
    const conflict = parseCanonicalRecord({
      bytes,
      schema: ConflictRecordSchema,
      label: "mapped conflict record",
    });
    if (
      conflict.conflict_record_id !== conflictId ||
      conflict.claim_refs.some(
        (ref) => !claimRefs.has(`${ref.page_id}\u0000${ref.revision_id}\u0000${ref.claim_id}`)
      )
    ) {
      throw new GenerationError("mapped conflict identity/claim closure mismatch");
    }
  }

  const catalogRow = rowsByRoleAndKey.get(
    `catalog\u0000${relativePublicationKey(
      request.root,
      generationCatalogPath(request.root, request.catalog.generation_id)
    )}`
  );
  const indexRow = rowsByRoleAndKey.get(
    `index\u0000${relativePublicationKey(
      request.root,
      generationIndexPath(request.root, request.catalog.generation_id)
    )}`
  );
  const selectorRow = rowsByRoleAndKey.get("selector\u0000.kb/current.json");
  if (
    catalogRow?.sha256 === undefined ||
    catalogRow.byte_length === undefined ||
    indexRow?.sha256 === undefined ||
    indexRow.byte_length === undefined ||
    selectorRow?.sha256 === undefined ||
    selectorRow.byte_length === undefined
  ) {
    throw new GenerationError("catalog/index/selector durable rows are incomplete");
  }
  const catalogBytes = readExactFile(
    request.root,
    generationCatalogPath(request.root, request.catalog.generation_id),
    catalogRow.sha256,
    catalogRow.byte_length
  );
  const storedCatalog = parseCanonicalRecord({
    bytes: catalogBytes,
    schema: GenerationCatalogSchema,
    label: "mapped candidate catalog",
  });
  if (
    canonicalJson(storedCatalog) !== canonicalJson(request.catalog) ||
    catalogRow.sha256 !== selector.catalog_sha256
  ) {
    throw new GenerationError("mapped candidate catalog does not match selector intent");
  }
  readExactFile(
    request.root,
    generationIndexPath(request.root, request.catalog.generation_id),
    indexRow.sha256,
    indexRow.byte_length
  );
  verifyGenerationIndex(
    request.root,
    request.catalog.generation_id,
    request.catalog.index_sha256,
    request.catalog.kb_id
  );

  const selectorFile =
    candidateAlreadySelected || selectorRow.state === "published"
      ? currentPath(request.root)
      : publicationPath(request.root, selectorRow.staging_key);
  if (candidateAlreadySelected || selectorRow.state === "published" || existsSync(selectorFile)) {
    readExactFile(request.root, selectorFile, selectorRow.sha256, selectorRow.byte_length, [1, 2]);
  }
}

function validatePublicationShape(input: PublishGenerationTransactionInput): void {
  if (
    !validOpaqueId(input.run_id) ||
    !validOpaqueId(input.transaction_id) ||
    !validOpaqueId(input.kb_profile_id) ||
    !validOpaqueId(input.catalog.generation_id) ||
    !validOpaqueId(input.catalog.kb_id)
  ) {
    throw new GenerationError("publication run/transaction/catalog identity is invalid");
  }
  if (
    (input.action === "init") !== (input.init_reservation !== undefined) ||
    (input.init_reservation !== undefined &&
      (!/^[0-9a-f]{64}$/.test(input.init_reservation.request_sha256) ||
        !/^[0-9a-f]{64}$/.test(input.init_reservation.profile_commitment_sha256)))
  ) {
    throw new GenerationError("base-none publication init reservation binding is invalid");
  }
  if (
    input.action === "init"
      ? input.base_generation_id !== null || input.base_selector_sha256 !== null
      : input.base_generation_id === null || input.base_selector_sha256 === null
  ) {
    throw new GenerationError("publication base generation/selector pair is invalid");
  }
  const roles = input.immutable_files.map((file) => file.role);
  const count = (role: PublicationFileRole): number =>
    roles.filter((candidate) => candidate === role).length;
  const invalidInit =
    input.action === "init" &&
    (count("manifest") !== 1 || count("policy") !== 1 || roles.length !== 2);
  const invalidMutation =
    input.action !== "init" && (roles.includes("manifest") || roles.includes("policy"));
  const invalidSave =
    input.action === "save" && (roles.includes("source_object") || roles.includes("source_record"));
  if (invalidInit || invalidMutation || invalidSave || count("page_markdown") !== count("claims")) {
    throw new GenerationError("publication immutable role cardinality is invalid");
  }
}

/**
 * Complete §5.10 transaction-owned publication. The control DB owns every ID,
 * key, digest transition, selector intent, and lifecycle state. The function is
 * retry-safe for the identical run/transaction and never adopts by scanning.
 */
export function publishGenerationTransaction(
  input: PublishGenerationTransactionInput
): PublishedGenerationTransaction {
  validateKbContract(GenerationCatalogSchema, input.catalog, "candidate generation catalog");
  validatePublicationShape(input);
  const closure = derivePublicationCatalogClosure(input);
  if (
    input.catalog.index_sha256 !==
    generationIndexDigest(input.catalog.generation_id, input.catalog.kb_id, input.index_pages)
  ) {
    throw new GenerationError("candidate catalog index digest does not match its planned rows");
  }

  const stagingRoot = `work/${input.run_id}/transaction/publication/${input.transaction_id}`;
  const generationFinalKey = `.kb/generations/${input.catalog.generation_id}`;
  const fileInputs = [
    ...closure.immutableFiles,
    {
      role: "catalog" as const,
      final_key: `${generationFinalKey}/catalog.json`,
      bytes: canonicalJson(input.catalog),
    },
  ];
  const finalKeys = [
    ...fileInputs.map((file) => file.final_key),
    `${generationFinalKey}/index.sqlite`,
    ".kb/current.json",
  ];
  if (new Set(finalKeys).size !== finalKeys.length) {
    throw new GenerationError("publication final keys are not unique");
  }
  for (const key of finalKeys) safeRelativeKey(key);

  const plannedFilesUnsorted: PublicationFileRecord[] = [
    ...fileInputs.map((file) => ({
      schema_version: 1 as const,
      publication_file_id: publicationFileId(input.transaction_id, file.role, file.final_key),
      transaction_id: input.transaction_id,
      role: file.role,
      staging_key: stagedKeyFor(stagingRoot, input.transaction_id, file.role, file.final_key),
      final_key: file.final_key,
      state: "planned" as const,
    })),
    {
      schema_version: 1,
      publication_file_id: publicationFileId(
        input.transaction_id,
        "index",
        `${generationFinalKey}/index.sqlite`
      ),
      transaction_id: input.transaction_id,
      role: "index",
      staging_key: stagedKeyFor(
        stagingRoot,
        input.transaction_id,
        "index",
        `${generationFinalKey}/index.sqlite`
      ),
      final_key: `${generationFinalKey}/index.sqlite`,
      state: "planned",
    },
    {
      schema_version: 1,
      publication_file_id: publicationFileId(input.transaction_id, "selector", ".kb/current.json"),
      transaction_id: input.transaction_id,
      role: "selector",
      staging_key: stagedKeyFor(stagingRoot, input.transaction_id, "selector", ".kb/current.json"),
      final_key: ".kb/current.json",
      state: "planned",
    },
  ];
  const plannedFiles = plannedFilesUnsorted.sort((left, right) =>
    left.role !== right.role
      ? left.role < right.role
        ? -1
        : 1
      : left.final_key < right.final_key
        ? -1
        : left.final_key > right.final_key
          ? 1
          : 0
  );
  const initReservation: InitReservation | undefined =
    input.action === "init" && input.init_reservation !== undefined
      ? {
          schema_version: 1,
          kb_profile_id: input.kb_profile_id,
          run_id: input.run_id,
          transaction_id: input.transaction_id,
          request_sha256: input.init_reservation.request_sha256,
          profile_commitment_sha256: input.init_reservation.profile_commitment_sha256,
          kb_id: input.catalog.kb_id,
          generation_id: input.catalog.generation_id,
          state: "reserved",
          updated_at: input.published_at,
        }
      : undefined;
  let publication = input.checkpointer.planKbPublication(
    {
      schema_version: 1,
      run_id: input.run_id,
      transaction_id: input.transaction_id,
      kb_profile_id: input.kb_profile_id,
      kb_id: input.catalog.kb_id,
      action: input.action,
      base_generation_id: input.base_generation_id,
      base_selector_sha256: input.base_selector_sha256,
      candidate_generation_id: input.catalog.generation_id,
      staging_root: stagingRoot,
      generation_staging_key: `${stagingRoot}/generation`,
      generation_final_key: generationFinalKey,
      lifecycle: "planned",
      files: plannedFiles,
      created_at: input.published_at,
      updated_at: input.published_at,
    },
    initReservation
  );
  assertExactDurableFilePlan(publication, plannedFiles);
  publicationHit(input, "after_publication_preindexed");

  const selector: CurrentGeneration = validateKbContract(
    CurrentGenerationSchema,
    {
      schema_version: 1,
      kb_id: input.catalog.kb_id,
      generation_id: input.catalog.generation_id,
      catalog_sha256: sha256Hex(canonicalJson(input.catalog)),
      index_sha256: input.catalog.index_sha256,
      published_at: input.published_at,
    },
    "candidate selector"
  );
  const selectorJcs = canonicalJson(selector);
  const selectorSha256 = sha256Hex(selectorJcs);
  publication = input.checkpointer.storeKbPublicationSelector({
    transaction_id: input.transaction_id,
    selector_jcs: selectorJcs,
    selector_sha256: selectorSha256,
  });
  assertExactDurableFilePlan(publication, plannedFiles);

  const held = acquireWriterLock(input.root, input.transaction_id);
  try {
    publicationHit(input, "after_writer_lock");
    if (
      ["planned", "staged", "immutables_published", "generation_published"].includes(
        publication.lifecycle
      )
    ) {
      const initialClassification = currentSelectorClassification(input.root, publication);
      const validReviewedBase =
        input.action === "init"
          ? initialClassification === "absent" || initialClassification === "candidate"
          : initialClassification === "base" || initialClassification === "candidate";
      if (!validReviewedBase) {
        input.authority?.abort?.(input.transaction_id);
        if (input.require_content_review) {
          input.checkpointer.abortContentReviewCommit(input.run_id, input.transaction_id);
        }
        discardPreselectorPublication(input, publication);
        throw new GenerationError(
          `reviewed selector is ${initialClassification}; refusing staging and silent rebase`
        );
      }
    }
    const inputByFinal = new Map(
      fileInputs.map((file) => [
        file.final_key,
        Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes, "utf8"),
      ])
    );

    // Stage every exact preindexed row. Planned partials belong only to this
    // transaction and may be rebuilt; staged rows must remain byte-exact.
    for (const row of publication.files) {
      if (row.state !== "planned") continue;
      const staging = publicationPath(input.root, row.staging_key);
      if (row.role === "index") {
        if (existsSync(staging)) {
          const stat = lstatSync(staging);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new GenerationError("planned index staging key is not a regular file");
          }
          unlinkSync(staging);
        }
        publicationHit(input, "before_index_write");
        buildGenerationIndexAt(
          staging,
          input.catalog.generation_id,
          input.catalog.kb_id,
          input.index_pages
        );
        const descriptor = openSync(staging, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        publicationHit(input, "after_index_fsync");
        fsyncDirectory(path.dirname(staging));
      } else {
        const bytes =
          row.role === "selector"
            ? Buffer.from(
                requiredGenerationValue(publication.selector_jcs, "planned selector JCS"),
                "utf8"
              )
            : inputByFinal.get(row.final_key);
        if (bytes === undefined) throw new GenerationError(`no bytes for planned ${row.role} row`);
        if (existsSync(staging)) {
          const actual = readPublicationFile(input.root, staging, {
            label: "planned publication staging file",
          });
          if (bytesDigest(actual) !== bytesDigest(bytes) || actual.length !== bytes.length) {
            const stat = lstatSync(staging);
            if (stat.isSymbolicLink() || !stat.isFile()) {
              throw new GenerationError("planned staging key is not a regular file");
            }
            unlinkSync(staging);
          }
        }
        if (!existsSync(staging)) {
          writeStagedFile(input, staging, bytes);
        } else {
          const descriptor = openSync(staging, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            fsyncSync(descriptor);
          } finally {
            closeSync(descriptor);
          }
          publicationHit(input, "after_file_fsync");
          fsyncDirectory(path.dirname(staging));
        }
      }
      const bytes = readPublicationFile(input.root, staging, {
        label: "staged publication file",
      });
      input.checkpointer.stageKbPublicationFile({
        transaction_id: input.transaction_id,
        publication_file_id: row.publication_file_id,
        sha256: bytesDigest(bytes),
        byte_length: bytes.length,
      });
      publicationHit(input, "after_file_indexed");
    }
    publication = requiredGenerationValue(
      input.checkpointer.kbPublication(input.transaction_id),
      "staged publication"
    );
    if (publication.files.some((file) => file.state === "planned")) {
      throw new GenerationError("publication has unstaged planned files");
    }
    if (publication.lifecycle === "planned") {
      publication = input.checkpointer.advanceKbPublication({
        transaction_id: input.transaction_id,
        expected: ["planned"],
        next: "staged",
      });
    }

    if (publication.lifecycle === "staged") {
      for (const row of publication.files.filter(
        (file) => !["catalog", "index", "selector"].includes(file.role)
      )) {
        if (row.state === "published") continue;
        const staging = publicationPath(input.root, row.staging_key);
        const final = publicationPath(input.root, row.final_key);
        if (row.sha256 === undefined || row.byte_length === undefined) {
          throw new GenerationError("staged immutable row lacks bytes evidence");
        }
        ensurePublicationParent(input.root, path.dirname(final));
        if (existsSync(final)) {
          if (existsSync(staging)) {
            const finalStat = lstatSync(final);
            const stagingStat = lstatSync(staging);
            if (finalStat.dev === stagingStat.dev && finalStat.ino === stagingStat.ino) {
              // Crash-after-link recovery permits the transaction's exact two
              // names only when they still identify the same two-link inode.
              if (finalStat.nlink !== 2 || stagingStat.nlink !== 2) {
                throw new GenerationError("immutable link recovery has an unexpected link count");
              }
              void readExactFile(input.root, final, row.sha256, row.byte_length, [2]);
              void readExactFile(input.root, staging, row.sha256, row.byte_length, [2]);
            } else {
              // A pre-existing immutable is accepted only by exact bytes; the
              // transaction-owned staged copy remains a distinct one-link file.
              assertExactFile(input.root, final, row.sha256, row.byte_length);
              assertExactFile(input.root, staging, row.sha256, row.byte_length);
            }
          } else {
            assertExactFile(input.root, final, row.sha256, row.byte_length);
          }
        } else {
          if (!existsSync(staging)) throw new GenerationError("staged immutable file is missing");
          assertExactFile(input.root, staging, row.sha256, row.byte_length);
          publicationHit(input, "before_immutable_link");
          try {
            linkSync(staging, final);
          } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
            assertExactFile(input.root, final, row.sha256, row.byte_length);
          }
          publicationHit(input, "after_immutable_link");
          fsyncDirectory(path.dirname(final));
          publicationHit(input, "after_immutable_fsync");
        }
        if (existsSync(staging)) {
          unlinkSync(staging);
          fsyncDirectory(path.dirname(staging));
        }
        input.checkpointer.publishKbPublicationFile(input.transaction_id, row.publication_file_id);
      }
      publication = input.checkpointer.advanceKbPublication({
        transaction_id: input.transaction_id,
        expected: ["staged"],
        next: "immutables_published",
      });
    }

    if (publication.lifecycle === "immutables_published") {
      const stagingDirectory = publicationPath(input.root, publication.generation_staging_key);
      const finalDirectory = publicationPath(input.root, publication.generation_final_key);
      ensureOwnerDirectory(path.dirname(finalDirectory));
      if (!existsSync(finalDirectory)) {
        if (!existsSync(stagingDirectory)) {
          throw new GenerationError("generation staging directory is missing");
        }
        publicationHit(input, "before_generation_rename");
        renameSync(stagingDirectory, finalDirectory);
        publicationHit(input, "after_generation_rename");
        fsyncDirectory(path.dirname(finalDirectory));
        publicationHit(input, "after_generation_fsync");
      }
      for (const role of ["catalog", "index"] as const) {
        const currentPublication = requiredGenerationValue(
          input.checkpointer.kbPublication(input.transaction_id),
          "generation publication"
        );
        const row = requiredGenerationValue(
          currentPublication.files.find((file) => file.role === role),
          `generation ${role} publication file`
        );
        if (row.sha256 === undefined || row.byte_length === undefined) {
          throw new GenerationError(`generation ${role} row lacks bytes evidence`);
        }
        assertExactFile(
          input.root,
          publicationPath(input.root, row.final_key),
          row.sha256,
          row.byte_length
        );
        if (row.state !== "published") {
          input.checkpointer.publishKbPublicationFile(
            input.transaction_id,
            row.publication_file_id
          );
        }
      }
      publication = input.checkpointer.advanceKbPublication({
        transaction_id: input.transaction_id,
        expected: ["immutables_published"],
        next: "generation_published",
      });
    }

    if (publication.lifecycle === "generation_published") {
      publication = requiredGenerationValue(
        input.checkpointer.kbPublication(input.transaction_id),
        "generation-published transaction"
      );
      const selectorJcs = requiredGenerationValue(
        publication.selector_jcs,
        "generation-published selector JCS"
      );
      const selectorSha256 = requiredGenerationValue(
        publication.selector_sha256,
        "generation-published selector digest"
      );
      const selectorRow = requiredGenerationValue(
        publication.files.find((file) => file.role === "selector"),
        "generation-published selector file"
      );
      verifyCompleteMappedPublication({
        publicationInput: input,
        publication,
        plannedFiles,
        closure,
        selector,
      });
      let classification = currentSelectorClassification(input.root, publication);
      const selectorTemp = publicationPath(input.root, selectorRow.staging_key);
      if (classification === "candidate") {
        if (existsSync(selectorTemp)) {
          void readExactFile(
            input.root,
            selectorTemp,
            selectorSha256,
            Buffer.byteLength(selectorJcs, "utf8"),
            [1, 2]
          );
        }
      } else {
        const validBase =
          input.action === "init" ? classification === "absent" : classification === "base";
        if (!validBase) {
          input.authority?.abort?.(input.transaction_id);
          if (input.require_content_review) {
            input.checkpointer.abortContentReviewCommit(input.run_id, input.transaction_id);
          }
          discardPreselectorPublication(input, publication);
          throw new GenerationError(
            `selector is ${classification}; refusing foreign/missing selector and silent rebase`
          );
        }
        if (!existsSync(selectorTemp)) {
          // The selector is the sole file whose temp may be recreated after it
          // was staged, and only from the durable transaction's exact JCS.
          writeStagedFile(input, selectorTemp, Buffer.from(selectorJcs, "utf8"));
        }
        assertExactFile(
          input.root,
          selectorTemp,
          selectorSha256,
          Buffer.byteLength(selectorJcs, "utf8")
        );
        publicationHit(input, "before_authority_reservation");
        input.authority?.reserve?.(input.transaction_id);
        if (input.require_content_review) {
          input.checkpointer.reserveContentReviewCommit(input.run_id, input.transaction_id);
        }
        publicationHit(input, "after_authority_reservation");
        classification = currentSelectorClassification(input.root, publication);
        if (input.action === "init" ? classification !== "absent" : classification !== "base") {
          input.authority?.abort?.(input.transaction_id);
          if (input.require_content_review) {
            input.checkpointer.abortContentReviewCommit(input.run_id, input.transaction_id);
          }
          discardPreselectorPublication(input, publication);
          throw new GenerationError("selector changed after reservation; refusing overwrite");
        }
        publicationHit(input, "before_selector_commit");
        // The commit decision is based on fresh no-follow opens, custody, and
        // hashes of every catalog-mapped file after the final injected boundary,
        // not on prior staging success.
        verifyCompleteMappedPublication({
          publicationInput: input,
          publication: requiredGenerationValue(
            input.checkpointer.kbPublication(input.transaction_id),
            "final selector-commit publication"
          ),
          plannedFiles,
          closure,
          selector,
        });
        classification = currentSelectorClassification(input.root, publication);
        if (input.action === "init" ? classification !== "absent" : classification !== "base") {
          input.authority?.abort?.(input.transaction_id);
          if (input.require_content_review) {
            input.checkpointer.abortContentReviewCommit(input.run_id, input.transaction_id);
          }
          discardPreselectorPublication(input, publication);
          throw new GenerationError("selector changed at the final commit recheck");
        }
        if (input.action === "init") {
          try {
            linkSync(selectorTemp, currentPath(input.root));
          } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
            throw new GenerationError("init selector already exists; no overwrite permitted");
          }
        } else {
          renameSync(selectorTemp, currentPath(input.root));
        }
        publicationHit(input, "after_selector_commit");
        fsyncDirectory(path.dirname(currentPath(input.root)));
        publicationHit(input, "after_selector_fsync");
      }
      if (currentSelectorClassification(input.root, publication) !== "candidate") {
        throw new GenerationError("candidate selector did not become authoritative");
      }
      publication = input.checkpointer.commitKbPublicationSelector(
        input.transaction_id,
        selectorRow.publication_file_id
      );
      publicationHit(input, "after_selector_record_commit");
      if (existsSync(selectorTemp)) {
        unlinkSync(selectorTemp);
        fsyncDirectory(path.dirname(selectorTemp));
      }
    }

    if (publication.lifecycle === "selector_committed") {
      const selectorRow = requiredGenerationValue(
        publication.files.find((file) => file.role === "selector"),
        "selector-committed publication file"
      );
      const selectorTemp = publicationPath(input.root, selectorRow.staging_key);
      if (existsSync(selectorTemp)) {
        if (
          currentSelectorClassification(input.root, publication) !== "candidate" ||
          selectorRow.sha256 === undefined ||
          selectorRow.byte_length === undefined
        ) {
          throw new GenerationError(
            "selector-committed temp cleanup lacks exact candidate evidence"
          );
        }
        void readExactFile(
          input.root,
          selectorTemp,
          selectorRow.sha256,
          selectorRow.byte_length,
          [2]
        );
        void readExactFile(
          input.root,
          currentPath(input.root),
          selectorRow.sha256,
          selectorRow.byte_length,
          [2]
        );
        const temporaryStat = lstatSync(selectorTemp);
        const currentStat = lstatSync(currentPath(input.root));
        if (
          temporaryStat.dev !== currentStat.dev ||
          temporaryStat.ino !== currentStat.ino ||
          temporaryStat.nlink !== 2 ||
          currentStat.nlink !== 2
        ) {
          throw new GenerationError("selector-committed temp is not the exact init hard link");
        }
        unlinkSync(selectorTemp);
        fsyncDirectory(path.dirname(selectorTemp));
      }
      publication = input.checkpointer.advanceKbPublication({
        transaction_id: input.transaction_id,
        expected: ["selector_committed"],
        next: "finalizing",
      });
    }
    if (publication.lifecycle === "finalizing") {
      if (currentSelectorClassification(input.root, publication) !== "candidate") {
        throw new GenerationError("finalization lost exact candidate selector evidence");
      }
      publicationHit(input, "before_authority_finalization");
      input.authority?.finalize?.(input.transaction_id);
      if (input.require_content_review) {
        input.checkpointer.finalizeContentReviewCommit(input.run_id, input.transaction_id);
      }
      publicationHit(input, "after_authority_finalization");
      rebuildRootIndexForTransaction(input, input.transaction_id);
      if (!input.await_operation_receipt) {
        publication = input.checkpointer.advanceKbPublication({
          transaction_id: input.transaction_id,
          expected: ["finalizing"],
          next: "complete",
        });
      }
    }
  } finally {
    held?.release();
  }

  input.checkpointer.kbPublicationSelectorEvidence({
    transaction_id: input.transaction_id,
    run_id: input.run_id,
    candidate_generation_id: input.catalog.generation_id,
  });
  return {
    selector,
    selector_sha256: selectorSha256,
    transaction_id: input.transaction_id,
    candidate_generation_id: input.catalog.generation_id,
  };
}

/**
 * Publish a generation atomically.
 *
 * The commit point is the atomic replacement of `.kb/current.json`. Before that,
 * the catalog is staged in the generations directory. After it, the generation is
 * authoritative and the old generation becomes unreachable (but is never deleted).
 *
 * This function does NOT implement the full §5.10 8-step crash-recovery protocol
 * (that requires the control DB and publication transaction records from G8).
 * For G7, publication writes are staged/off — this function stages the catalog
 * and performs the atomic selector replacement, which is the minimum needed to
 * test the "readers use current.json" invariant.
 */
export function publishGeneration(root: string, catalog: GenerationCatalog): CurrentGeneration {
  // 1. Stage the catalog in the generations directory (immutable after publication)
  const catalogDir = generationsDir(root);
  if (!existsSync(catalogDir)) {
    mkdirSync(catalogDir, { recursive: true, mode: 0o700 });
    chmodSync(catalogDir, 0o700);
  }
  const genDir = path.join(catalogDir, catalog.generation_id);
  if (!existsSync(genDir)) {
    mkdirSync(genDir, { recursive: true, mode: 0o700 });
    chmodSync(genDir, 0o700);
  }
  const catalogP = generationCatalogPath(root, catalog.generation_id);
  if (!existsSync(catalogP)) {
    secureWrite(catalogP, canonicalJson(catalog));
  }

  // 2. Build the selector
  const catalogSha = sha256Hex(canonicalJson(catalog));
  const selector: CurrentGeneration = {
    schema_version: 1,
    kb_id: catalog.kb_id,
    generation_id: catalog.generation_id,
    catalog_sha256: catalogSha,
    index_sha256: catalog.index_sha256,
    published_at: new Date().toISOString(),
  };
  validateKbContract(CurrentGenerationSchema, selector, "current selector");

  // 3. Atomic replacement: write to temp, fsync, rename over current.json
  writeCurrent(root, selector);

  // 4. Rebuild root index as convenience (never authority)
  rebuildRootIndex(root, catalog);

  return selector;
}

/**
 * Read the currently selected generation's catalog.
 *
 * Readers start from one validated selector and use only that generation.
 * They never combine a directory scan with a different generation.
 */
export function readSelectedGeneration(root: string):
  | {
      selector: CurrentGeneration;
      catalog: GenerationCatalog;
    }
  | undefined {
  const selector = readCurrent(root);
  if (selector === undefined) return undefined;
  let catalog: GenerationCatalog;
  try {
    catalog = readGenerationCatalog(root, selector.generation_id, selector.catalog_sha256);
  } catch (error) {
    throw new GenerationError(
      `selected generation catalog failed custody/schema/digest validation: ${errorMessage(error)}`
    );
  }
  if (catalog.kb_id !== selector.kb_id || catalog.index_sha256 !== selector.index_sha256) {
    throw new GenerationError(
      "selected catalog identity/index binding does not match the selector"
    );
  }
  // Verify the index the catalog anchors (detects tampering/corruption).
  verifyGenerationIndex(root, selector.generation_id, catalog.index_sha256, catalog.kb_id);
  return { selector, catalog };
}

/**
 * Rebuild the root `index.md` from the selected generation's catalog.
 *
 * This is convenience only — it may lag or be absent after a crash and is
 * rebuilt from the selected catalog. It is never authority.
 */
export function rebuildRootIndex(root: string, catalog: GenerationCatalog): void {
  const lines: string[] = [
    `# ${catalog.kb_id}`,
    "",
    `Generation: ${catalog.generation_id}`,
    `Published: ${new Date().toISOString()}`,
    "",
    "## Pages",
    "",
  ];
  for (const pageId of Object.keys(catalog.pages).sort()) {
    const entry = catalog.pages[pageId];
    if (entry === undefined) continue;
    lines.push(
      `- [${pageId}](pages/${pageId}/revisions/${entry.revision_id}/page.md): revision ${entry.revision_id}`
    );
  }
  lines.push("", "## Sources", "");
  for (const sourceId of Object.keys(catalog.source_records).sort()) {
    lines.push(`- ${sourceId}`);
  }
  if (Object.keys(catalog.conflict_records).length > 0) {
    lines.push("", "## Conflicts", "");
    for (const conflictId of Object.keys(catalog.conflict_records).sort()) {
      lines.push(`- ${conflictId}`);
    }
  }
  writeRootIndex(root, lines.join("\n") + "\n");
}
