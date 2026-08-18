/**
 * Owner-held artifact grants for the unmarked primary runtime.
 *
 * Workers receive grants as a per-spawn invocation snapshot in their process
 * environment (`handoff.ts`). The primary runtime has no spawn boundary, so its
 * grants are recorded in an owner-only grant book under the artifact root and
 * resolved by exact artifact ID at read time.
 *
 * Properties this file preserves:
 * - The model never writes the book. Registration happens in owner code only,
 *   after an execution owner has already persisted and verified exact bytes.
 * - No enumeration is exposed. Resolution is by exact artifact ID; an ID absent
 *   from the book is `ARTIFACT_NOT_GRANTED`, exactly as for workers.
 * - `consumer_scope` is authorization, not identity: `canonicalArtifactId()`
 *   hashes only (run_id, phase, branch_id, kind, operation_id, version), so the
 *   owner adding itself as a consumer cannot alter artifact identity or content
 *   binding (digest, byte length, store ref are untouched and still verified).
 * - Cross-session isolation: the book path is derived from the session ID.
 *
 * The book lives in its own state root, NOT under `PENNY_ARTIFACT_ROOT`. Both
 * artifact stores claim the artifact root exclusively and refuse to operate if
 * it contains any entry outside their managed set (`artifacts.py`
 * `_assert_safe_root_contents`), so placing owner state there would break all
 * artifact persistence. This mirrors the sibling `skill-chains` state root.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { artifactRefFromEnvelope, compareUnicode, parseArtifactRef } from "./artifact-runtime.js";
import { ArtifactReadError, type ArtifactInvocation, type ArtifactRef } from "./types.js";

export const OWNER_GRANT_SCHEMA_VERSION = 1 as const;

/**
 * The consumer identity the primary runtime presents. It is deliberately
 * distinct from every worker consumer vocabulary (`state:*`,
 * `subagent-chain:*`) so an owner grant can never be confused with, or satisfy,
 * a worker's scope check.
 */
export const OWNER_CONSUMER_REF = "penny-primary:owner";

/** Owner grants outlive a worker's 15-minute handoff: Penny reads on demand,
 * often long after the delegation that produced the artifact returned. */
export const DEFAULT_OWNER_GRANT_TTL_MS = 24 * 60 * 60 * 1_000;

/** Bounds the book so a long session cannot grow it without limit. */
export const MAX_OWNER_GRANTS = 512;

/** Stale book files are pruned opportunistically on write. */
const BOOK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const OWNER_GRANT_DIRECTORY = "artifact-grants";

/**
 * Resolve the owner grant state root. Deliberately independent of
 * `PENNY_ARTIFACT_ROOT`: the artifact root is exclusively the artifact store's.
 */
export function resolveOwnerGrantRoot(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const explicit = env.PENNY_ARTIFACT_GRANT_ROOT?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) bookError("PENNY_ARTIFACT_GRANT_ROOT must be absolute");
    return resolve(explicit);
  }
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) {
    if (!isAbsolute(xdgStateHome)) bookError("XDG_STATE_HOME must be absolute");
    return join(xdgStateHome, "penny", OWNER_GRANT_DIRECTORY);
  }
  const home = env.HOME?.trim() || homedir();
  if (!home || !isAbsolute(home)) bookError("No absolute owner grant state root is available");
  return join(home, ".local", "state", "penny", OWNER_GRANT_DIRECTORY);
}

export interface OwnerGrantEntry {
  artifact: ArtifactRef;
  expires_at: string;
}

export interface OwnerGrantBook {
  schema_version: typeof OWNER_GRANT_SCHEMA_VERSION;
  invocation_id: string;
  updated_at: string;
  grants: OwnerGrantEntry[];
}

function bookError(message: string): never {
  throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", message);
}

/** Session IDs are hashed, never interpolated, so no session value can shape a path. */
export function ownerGrantBookPath(
  sessionId: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const trimmed = sessionId.trim();
  if (!trimmed) bookError("owner grant session id is required");
  const name = createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 32);
  return join(resolveOwnerGrantRoot(env), `${name}.json`);
}

function assertOwnerOnly(path: string, type: "file" | "directory"): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) bookError("owner grant book cannot be a symbolic link");
  if ((type === "file" && !stats.isFile()) || (type === "directory" && !stats.isDirectory())) {
    bookError("owner grant book has the wrong type");
  }
  if ((stats.mode & 0o077) !== 0) bookError("owner grant book must be owner-only");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    bookError("owner grant book has the wrong owner");
  }
}

/**
 * Add the owner consumer without disturbing identity-bearing or content fields.
 *
 * `consumer_scope` is validated as a canonically sorted, duplicate-free array,
 * so the owner entry is merged into sort order rather than appended.
 */
export function withOwnerConsumer(ref: ArtifactRef): ArtifactRef {
  if (ref.consumer_scope.includes(OWNER_CONSUMER_REF)) return artifactRefFromEnvelope(ref);
  return artifactRefFromEnvelope({
    ...ref,
    consumer_scope: [...ref.consumer_scope, OWNER_CONSUMER_REF].sort(compareUnicode),
  });
}

function parseBook(raw: string): OwnerGrantBook {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    bookError("owner grant book is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    bookError("owner grant book must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== OWNER_GRANT_SCHEMA_VERSION) {
    bookError("unsupported owner grant book schema");
  }
  const invocationId = record.invocation_id;
  if (typeof invocationId !== "string" || !invocationId.trim()) {
    bookError("owner grant book invocation id is invalid");
  }
  if (!Array.isArray(record.grants)) bookError("owner grant book grants are invalid");
  const grants = record.grants.map((entry, index): OwnerGrantEntry => {
    if (typeof entry !== "object" || entry === null) {
      bookError(`owner grant book grants[${index}] is invalid`);
    }
    const grant = entry as Record<string, unknown>;
    const expiresAt = grant.expires_at;
    if (typeof expiresAt !== "string" || !expiresAt.trim()) {
      bookError(`owner grant book grants[${index}].expires_at is invalid`);
    }
    return {
      artifact: parseArtifactRef(grant.artifact, `owner grant book grants[${index}].artifact`),
      expires_at: expiresAt,
    };
  });
  return {
    schema_version: OWNER_GRANT_SCHEMA_VERSION,
    invocation_id: invocationId,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : "",
    grants,
  };
}

/** Absence is normal (no delegation yet) and is distinct from corruption. */
export function readOwnerGrantBook(path: string): OwnerGrantBook | undefined {
  let raw: string;
  try {
    assertOwnerOnly(path, "file");
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseBook(raw);
}

/**
 * Resolve one exact artifact ID to a single-grant invocation.
 *
 * The caller run is taken from the granted ref itself, so the run check in
 * `validateGrant` stays exact while the owner reads across the many runs one
 * session may have delegated.
 */
export function resolveOwnerInvocation(
  book: OwnerGrantBook | undefined,
  artifactId: string
): ArtifactInvocation | undefined {
  if (!book) return undefined;
  const grant = book.grants.find((entry) => entry.artifact.artifact_id === artifactId);
  if (!grant) return undefined;
  return {
    schema_version: 1,
    caller: {
      run_id: grant.artifact.run_id,
      consumer_ref: OWNER_CONSUMER_REF,
      invocation_id: book.invocation_id,
    },
    grants: [{ artifact: grant.artifact, expires_at: grant.expires_at }],
  };
}

function pruneStaleBooks(directory: string, now: number): void {
  try {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const candidate = join(directory, name);
      try {
        if (now - statSync(candidate).mtimeMs > BOOK_RETENTION_MS) {
          rmSync(candidate, { force: true });
        }
      } catch {
        // A book that cannot be inspected is left untouched.
      }
    }
  } catch {
    // Pruning is opportunistic and never blocks registration.
  }
}

/**
 * Record owner grants for exact refs an execution owner already verified.
 *
 * Returns the refs as granted (owner consumer included) so callers surface the
 * same bytes the book holds; `validateGrant` compares a model-supplied ref for
 * exact equality against the grant.
 */
export function registerOwnerArtifactGrants(options: {
  sessionId: string;
  refs: readonly ArtifactRef[];
  env?: Readonly<Record<string, string | undefined>>;
  now?: number;
  ttlMs?: number;
}): ArtifactRef[] {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_OWNER_GRANT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) bookError("owner grant ttl must be positive");

  const granted = options.refs.map((ref) => withOwnerConsumer(parseArtifactRef(ref)));
  if (granted.length === 0) return [];

  const destination = ownerGrantBookPath(options.sessionId, env);
  const directory = resolveOwnerGrantRoot(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  assertOwnerOnly(directory, "directory");

  const existing = readOwnerGrantBook(destination);
  const expiresAt = new Date(now + ttlMs).toISOString();
  const merged = new Map<string, OwnerGrantEntry>();
  for (const entry of existing?.grants ?? []) {
    if (Date.parse(entry.expires_at) > now) merged.set(entry.artifact.artifact_id, entry);
  }
  for (const ref of granted) {
    merged.set(ref.artifact_id, { artifact: ref, expires_at: expiresAt });
  }

  // Newest grants win when the bound is reached.
  const entries = [...merged.values()].slice(-MAX_OWNER_GRANTS);
  const book: OwnerGrantBook = {
    schema_version: OWNER_GRANT_SCHEMA_VERSION,
    invocation_id: existing?.invocation_id ?? `penny-owner-${randomUUID()}`,
    updated_at: new Date(now).toISOString(),
    grants: entries,
  };

  const temporary = join(
    directory,
    `.owner-grants.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(book, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporary, 0o600);
    const fileDescriptor = openSync(temporary, "r");
    try {
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    rmSync(temporary, { force: true });
  }

  pruneStaleBooks(directory, now);
  return granted;
}
