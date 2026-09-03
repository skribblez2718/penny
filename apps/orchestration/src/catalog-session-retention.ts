import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { Type } from "typebox";

import { type Checkpointer } from "./checkpointer.js";
import { validateContract } from "./contracts.js";
import {
  CATALOG_AGENT_NAME_PATTERN,
  CATALOG_WORKER_SESSION_METADATA,
  CatalogWorkerSessionMetadataV1Schema,
  validateCatalogWorkerSessionMetadata,
  type CatalogWorkerSessionMetadataV1,
} from "./model-client.js";
import { assertOwnerDirectory, fsyncDirectory, OWNER_FILE_MODE } from "./state/custody.js";

const MAX_CATALOG_SESSION_METADATA_PREFIX_BYTES = 64 * 1_024;
/** Current JSONL header emitted by the package-pinned Pi SessionManager. */
const CURRENT_CATALOG_SESSION_VERSION = 3 as const;
const SessionEntryIdSchema = Type.String({ minLength: 1, maxLength: 256 });
const CurrentCatalogSessionHeaderSchema = Type.Object(
  {
    type: Type.Literal("session"),
    version: Type.Literal(CURRENT_CATALOG_SESSION_VERSION),
    id: SessionEntryIdSchema,
    timestamp: Type.String({ minLength: 20, maxLength: 40 }),
    cwd: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
const CurrentCatalogSessionMetadataEntrySchema = Type.Object(
  {
    type: Type.Literal("custom"),
    customType: Type.Literal(CATALOG_WORKER_SESSION_METADATA),
    data: CatalogWorkerSessionMetadataV1Schema,
    id: SessionEntryIdSchema,
    parentId: Type.Null(),
    timestamp: Type.String({ minLength: 20, maxLength: 40 }),
  },
  { additionalProperties: false }
);

export const CATALOG_SESSION_RETENTION_REASON_CODES = [
  "session_root_not_absolute",
  "session_root_unsafe",
  "session_root_unreadable",
  "agent_directory_unsafe",
  "agent_directory_unreadable",
  "session_open_failed",
  "session_custody_invalid",
  "metadata_prefix_too_large",
  "metadata_prefix_malformed",
  "metadata_project_mismatch",
  "metadata_agent_mismatch",
  "run_reconciliation_failed",
  "session_identity_changed",
  "session_unlink_failed",
  "agent_directory_fsync_failed",
  "session_close_failed",
  "session_processing_failed",
] as const;
export type CatalogSessionRetentionReasonCode =
  (typeof CATALOG_SESSION_RETENTION_REASON_CODES)[number];

const PRESERVE_AND_SKIP_REASON_CODES: ReadonlySet<CatalogSessionRetentionReasonCode> = new Set([
  "session_open_failed",
  "session_custody_invalid",
  "metadata_prefix_too_large",
  "metadata_prefix_malformed",
  "metadata_project_mismatch",
  "metadata_agent_mismatch",
  "session_identity_changed",
]);

export interface CatalogSessionRetentionIssue {
  readonly relative_path: string;
  readonly reason_code: CatalogSessionRetentionReasonCode;
}

export interface ProjectRetentionResult {
  readonly evictedRunIds: readonly string[];
  readonly removedSessionFiles: number;
}

export class CatalogSessionRetentionError extends Error {
  readonly evictedRunIds: readonly string[];
  readonly removedSessionFiles: number;
  readonly issues: readonly CatalogSessionRetentionIssue[];

  constructor(input: {
    readonly evictedRunIds: readonly string[];
    readonly removedSessionFiles: number;
    readonly issues: readonly CatalogSessionRetentionIssue[];
  }) {
    const details = input.issues
      .map((issue) => `${JSON.stringify(issue.relative_path)}:${issue.reason_code}`)
      .join(", ");
    super(`catalog session retention failed: ${details}`);
    this.name = "CatalogSessionRetentionError";
    this.evictedRunIds = [...input.evictedRunIds];
    this.removedSessionFiles = input.removedSessionFiles;
    this.issues = input.issues.map((issue) => ({ ...issue }));
  }
}

class CatalogSessionCandidateError extends Error {
  constructor(
    readonly reasonCode: CatalogSessionRetentionReasonCode,
    readonly removed = false
  ) {
    super(reasonCode);
    this.name = "CatalogSessionCandidateError";
  }
}

function candidateFailure(reasonCode: CatalogSessionRetentionReasonCode, removed = false): never {
  throw new CatalogSessionCandidateError(reasonCode, removed);
}

function currentUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

function hasOwnerFileCustody(stat: Stats): boolean {
  const uid = currentUid();
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    (stat.mode & 0o777) === OWNER_FILE_MODE &&
    (uid === undefined || stat.uid === uid)
  );
}

function exactJsonLine(line: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    candidateFailure("metadata_prefix_malformed");
  }
  if (JSON.stringify(value) !== line) candidateFailure("metadata_prefix_malformed");
  return value;
}

function metadataPrefix(descriptor: number, fileSize: number): readonly [string, string] {
  const buffer = Buffer.alloc(MAX_CATALOG_SESSION_METADATA_PREFIX_BYTES + 1);
  const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
  let firstNewline = -1;
  let secondNewline = -1;
  for (let index = 0; index < bytesRead; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    if (firstNewline === -1) firstNewline = index;
    else {
      secondNewline = index;
      break;
    }
  }
  if (secondNewline < 0 || secondNewline + 1 > MAX_CATALOG_SESSION_METADATA_PREFIX_BYTES) {
    if (fileSize > MAX_CATALOG_SESSION_METADATA_PREFIX_BYTES) {
      candidateFailure("metadata_prefix_too_large");
    }
    candidateFailure("metadata_prefix_malformed");
  }
  if (firstNewline <= 0 || secondNewline <= firstNewline + 1) {
    candidateFailure("metadata_prefix_malformed");
  }
  const prefix = buffer.subarray(0, secondNewline + 1);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
  } catch {
    candidateFailure("metadata_prefix_malformed");
  }
  const lines = text.slice(0, -1).split("\n");
  const header = lines[0];
  const metadata = lines[1];
  if (lines.length !== 2 || header === undefined || metadata === undefined) {
    candidateFailure("metadata_prefix_malformed");
  }
  return [header, metadata];
}

function parseCatalogSessionMetadata(
  descriptor: number,
  opened: Stats
): CatalogWorkerSessionMetadataV1 {
  const [headerLine, metadataLine] = metadataPrefix(descriptor, opened.size);
  let entry: { readonly data: unknown };
  try {
    validateContract(
      CurrentCatalogSessionHeaderSchema,
      exactJsonLine(headerLine),
      "catalog session header"
    );
    entry = validateContract(
      CurrentCatalogSessionMetadataEntrySchema,
      exactJsonLine(metadataLine),
      "catalog session metadata entry"
    );
  } catch (error) {
    if (error instanceof CatalogSessionCandidateError) throw error;
    candidateFailure("metadata_prefix_malformed");
  }
  try {
    return validateCatalogWorkerSessionMetadata(entry.data);
  } catch {
    candidateFailure("metadata_prefix_malformed");
  }
}

function relativeSessionPath(agent: string, file: string): string {
  return `${agent}/${file}`;
}

function inspectAndMaybeRemove(input: {
  readonly checkpointer: Checkpointer;
  readonly projectId: string;
  readonly agent: string;
  readonly agentDirectory: string;
  readonly filePath: string;
}): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(input.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    candidateFailure("session_open_failed");
  }
  let removed = false;
  try {
    const opened = fstatSync(descriptor);
    if (!hasOwnerFileCustody(opened)) candidateFailure("session_custody_invalid");
    const metadata = parseCatalogSessionMetadata(descriptor, opened);
    if (metadata.project_id !== input.projectId) candidateFailure("metadata_project_mismatch");
    if (metadata.agent !== input.agent) candidateFailure("metadata_agent_mismatch");

    let retainedRun: boolean;
    try {
      retainedRun = input.checkpointer.hasRunById(metadata.run_id);
    } catch {
      candidateFailure("run_reconciliation_failed");
    }
    if (retainedRun) return false;

    const finalOpened = fstatSync(descriptor);
    let finalPath: Stats;
    try {
      finalPath = lstatSync(input.filePath);
    } catch {
      candidateFailure("session_identity_changed");
    }
    if (
      !hasOwnerFileCustody(finalOpened) ||
      !hasOwnerFileCustody(finalPath) ||
      finalOpened.dev !== opened.dev ||
      finalOpened.ino !== opened.ino ||
      finalPath.dev !== finalOpened.dev ||
      finalPath.ino !== finalOpened.ino
    ) {
      candidateFailure("session_identity_changed");
    }
    try {
      unlinkSync(input.filePath);
      removed = true;
    } catch {
      candidateFailure("session_unlink_failed");
    }
    try {
      fsyncDirectory(input.agentDirectory);
    } catch {
      candidateFailure("agent_directory_fsync_failed", true);
    }
    return true;
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      candidateFailure("session_close_failed", removed);
    }
  }
}

function sweepCatalogSessions(input: {
  readonly checkpointer: Checkpointer;
  readonly projectId: string;
  readonly sessionRoot: string;
  readonly evictedRunIds: readonly string[];
}): ProjectRetentionResult {
  const fatalIssues: CatalogSessionRetentionIssue[] = [];
  let removedSessionFiles = 0;
  const fail = (
    relativePath: string,
    reasonCode: CatalogSessionRetentionReasonCode
  ): ProjectRetentionResult => {
    fatalIssues.push({ relative_path: relativePath, reason_code: reasonCode });
    throw new CatalogSessionRetentionError({
      evictedRunIds: input.evictedRunIds,
      removedSessionFiles,
      issues: fatalIssues,
    });
  };

  if (!path.isAbsolute(input.sessionRoot)) return fail(".", "session_root_not_absolute");
  try {
    assertOwnerDirectory(input.sessionRoot, "catalog session root");
  } catch {
    return fail(".", "session_root_unsafe");
  }

  let agentNames: string[];
  try {
    agentNames = readdirSync(input.sessionRoot).sort();
  } catch {
    return fail(".", "session_root_unreadable");
  }
  for (const agent of agentNames) {
    if (!CATALOG_AGENT_NAME_PATTERN.test(agent)) continue;
    const agentDirectory = path.join(input.sessionRoot, agent);
    try {
      assertOwnerDirectory(agentDirectory, `catalog session directory for '${agent}'`);
    } catch {
      fatalIssues.push({ relative_path: agent, reason_code: "agent_directory_unsafe" });
      continue;
    }
    let fileNames: string[];
    try {
      fileNames = readdirSync(agentDirectory).sort();
    } catch {
      fatalIssues.push({ relative_path: agent, reason_code: "agent_directory_unreadable" });
      continue;
    }
    for (const file of fileNames) {
      if (!file.endsWith(".jsonl")) continue;
      const relativePath = relativeSessionPath(agent, file);
      let removed = false;
      try {
        removed = inspectAndMaybeRemove({
          checkpointer: input.checkpointer,
          projectId: input.projectId,
          agent,
          agentDirectory,
          filePath: path.join(agentDirectory, file),
        });
      } catch (error) {
        if (error instanceof CatalogSessionCandidateError) {
          if (error.removed) removedSessionFiles += 1;
          if (!PRESERVE_AND_SKIP_REASON_CODES.has(error.reasonCode)) {
            fatalIssues.push({ relative_path: relativePath, reason_code: error.reasonCode });
          }
        } else {
          fatalIssues.push({
            relative_path: relativePath,
            reason_code: "session_processing_failed",
          });
        }
        continue;
      }
      if (removed) removedSessionFiles += 1;
    }
  }

  if (fatalIssues.length > 0) {
    throw new CatalogSessionRetentionError({
      evictedRunIds: input.evictedRunIds,
      removedSessionFiles,
      issues: fatalIssues,
    });
  }
  return { evictedRunIds: [...input.evictedRunIds], removedSessionFiles };
}

/** Owns the ordered DB-then-JSONL retention transaction for one existing project partition. */
export class ProjectRetentionOwner {
  constructor(
    private readonly checkpointer: Checkpointer,
    private readonly input: {
      readonly projectId: string;
      readonly sessionRoot: string;
    }
  ) {}

  run(): ProjectRetentionResult {
    const evictedRunIds = this.checkpointer.pruneTerminalRuns();
    return sweepCatalogSessions({
      checkpointer: this.checkpointer,
      projectId: this.input.projectId,
      sessionRoot: this.input.sessionRoot,
      evictedRunIds,
    });
  }
}
