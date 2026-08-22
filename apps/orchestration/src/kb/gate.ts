/**
 * Legacy KB-root gate projection.
 *
 * G8 ingest/save content-review authority now lives in the orchestration
 * control DB behind `ContentReviewService`; the host CLI calls that facade and
 * generic/model-visible requests remain decision-free. This module is retained
 * for capability mint/resolution plus prepare-only promotion and standalone
 * legacy workflow compatibility. Its JSON rows are not authoritative
 * ingest/save callback receipts.
 *
 * Gate row (owner-only JSON, CAS-transitioned):
 *   awaiting → claimed → approved
 *     awaiting → denied | invalidated
 *
 * Invariants:
 * - Sealed candidate set: the exact artifact handles are JCS-digest bound
 *   (`packet_sha256`) before the gate is presented.
 * - Drift invalidates: approval requires the selected generation still to
 *   equal the gate's base; otherwise the gate is invalidated, not republished.
 * - Expiry invalidates: a gate past `expires_at` cannot be approved.
 * - Single approval: the `awaiting → claimed` reservation is optimistic-CAS
 *   (content-hash compare before write), so a second approver loses before
 *   any publication.
 * - Capability lifecycle: claimed source capabilities are `consumed` on
 *   approval and `invalidated` on denial (when capability IDs are bound).
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { canonicalJson, sha256Hex, type SourceType } from "./contracts.js";
import { readCurrent } from "./filesystem.js";
import { readSelectedGeneration } from "./generations.js";
import { approveIngest, type IngestSource, type PendingIngest } from "./ingest.js";
import {
  envelopeDigest,
  validateClaimedCapability,
  validateEnvelopeCrossField,
  type CapabilityBinding,
  type CapabilityEnvelope,
  type SourceAdmissionRecord,
} from "./capabilities.js";
import type { Checkpointer } from "../checkpointer.js";
import { type KbResult } from "./workflows.js";
import { CapabilityStore, CapabilityError } from "./capabilities.js";

export type GateStatus = "awaiting" | "claimed" | "approved" | "denied" | "invalidated";

export interface GateState {
  schema_version: 1;
  gate_id: string;
  run_id: string;
  kb_profile_id: string;
  action: "ingest";
  status: GateStatus;
  issued_at: string;
  expires_at: string;
  base_generation_id: string;
  base_catalog_sha256: string;
  source_capability_ids: string[];
  source_ids: string[];
  artifacts: Array<{
    schema_version: 1;
    artifact_id: string;
    artifact_kind: string;
    sha256: string;
    media_type: string;
    byte_length: number;
  }>;
  packet_sha256: string;
  terminal_at?: string;
  terminal_reason?: string;
  published_generation_id?: string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ── Storage (owner-only, CAS by content hash) ───────────────────────────────

function gatesDir(root: string): string {
  return path.join(root, ".kb", "gates");
}

function gatePath(root: string, gateId: string): string {
  return path.join(gatesDir(root), `${gateId}.json`);
}

function assertSafe(filePath: string, label: string): void {
  const st = lstatSync(filePath);
  if (st.isSymbolicLink()) throw new GateStorageError(`${label} is a symlink`);
  if (!st.isFile()) throw new GateStorageError(`${label} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new GateStorageError(`${label} is not owner-only`);
}

export class GateStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateStorageError";
  }
}

/** Atomically write the gate row only if the current file still equals `expectedContent`. */
function casWrite(root: string, gate: GateState, expectedContent: string | undefined): void {
  const dir = gatesDir(root);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const p = gatePath(root, gate.gate_id);
  if (expectedContent !== undefined && existsSync(p)) {
    if (readFileSync(p, "utf8") !== expectedContent) {
      throw new GateStorageError(
        "gate changed underneath us (lost CAS race); refusing to write — re-read and retry"
      );
    }
  }
  const payload = canonicalJson(gate);
  // A gate row that cannot be read back is worse than a write failure: every reader
  // here skips unparseable rows, so a malformed gate silently becomes "no gate" and
  // an ingest run looks like it never reached review. Fail at the write instead.
  try {
    JSON.parse(payload);
  } catch {
    throw new GateStorageError(
      `refusing to write gate '${gate.gate_id}': serialized row is not valid JSON (a field is undefined)`
    );
  }
  const tmp = `${p}.tmp${process.pid}`;
  writeFileSync(tmp, payload, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

// ── Public API ──────────────────────────────────────────────────────────────

function artifactRecords(
  handles: readonly {
    schema_version: 1;
    artifact_id: string;
    artifact_kind: string;
    sha256: string;
    media_type: string;
    byte_length: number;
  }[]
): GateState["artifacts"] {
  return handles.map((h) => ({
    schema_version: 1,
    artifact_id: h.artifact_id,
    artifact_kind: h.artifact_kind,
    sha256: h.sha256,
    media_type: h.media_type,
    byte_length: h.byte_length,
  }));
}

/**
 * Persist a new `awaiting` gate for a run (called by the host after the
 * pipeline seals its candidate set). The packet digest seals the EXACT
 * artifact set presented to the reviewer.
 */
export function persistIngestGate(
  root: string,
  profileId: string,
  runId: string,
  artifacts: readonly Record<string, unknown>[],
  sourceIds: readonly string[],
  sourceCapabilityIds: readonly string[] = []
): GateState {
  const current = readCurrent(root);
  if (current === undefined) {
    throw new GateStorageError("no KB selector exists; cannot bind a gate to a base generation");
  }
  const now = new Date().toISOString();
  const gate: GateState = {
    schema_version: 1,
    gate_id: `gate_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    run_id: runId,
    kb_profile_id: profileId,
    action: "ingest",
    status: "awaiting",
    issued_at: now,
    expires_at: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
    base_generation_id: current.generation_id,
    base_catalog_sha256: current.catalog_sha256,
    source_capability_ids: [...sourceCapabilityIds],
    source_ids: [...sourceIds],
    artifacts: artifactRecords((artifacts ?? []) as GateState["artifacts"]),
    packet_sha256: "",
  };
  gate.packet_sha256 = gatePacketDigest(gate);
  const gateRow = gate;
  const payload = canonicalJson(gateRow);
  const dir = gatesDir(root);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const p = gatePath(root, gateRow.gate_id);
  writeFileSync(p, payload, { mode: 0o600 });
  chmodSync(p, 0o600);
  return gateRow;
}

function gatePacketDigest(gate: GateState): string {
  return sha256Hex(
    canonicalJson({
      run_id: gate.run_id,
      source_ids: [...gate.source_ids].sort(),
      artifacts: [...gate.artifacts]
        .sort((a, b) => (a.artifact_id < b.artifact_id ? -1 : 1))
        .map((a) => ({
          artifact_id: a.artifact_id,
          artifact_kind: a.artifact_kind,
          sha256: a.sha256,
          byte_length: a.byte_length,
        })),
    })
  );
}

export function readGate(root: string, gateId: string): GateState | undefined {
  const p = gatePath(root, gateId);
  if (!existsSync(p)) return undefined;
  assertSafe(p, "gate row");
  return JSON.parse(readFileSync(p, "utf8")) as GateState;
}

/** Find the gate row for a run (gates are keyed by a minted gate_id; index by run here). */
export function findGateForRun(root: string, runId: string): GateState | undefined {
  const dir = gatesDir(root);
  if (!existsSync(dir)) return undefined;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = path.join(dir, f);
      const g = JSON.parse(readFileSync(p, "utf8")) as GateState;
      if (g.run_id === runId) return g;
    } catch {
      // skip unreadable rows
    }
  }
  return undefined;
}

export function listGates(root: string): GateState[] {
  const dir = gatesDir(root);
  if (!existsSync(dir)) return [];
  const gates: GateState[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = path.join(dir, f);
      gates.push(JSON.parse(readFileSync(p, "utf8")) as GateState);
    } catch {
      // skip
    }
  }
  gates.sort((a, b) => (a.issued_at < b.issued_at ? -1 : a.issued_at > b.issued_at ? 1 : 0));
  return gates;
}

export function latestPendingGate(root: string): GateState | undefined {
  const pending = listGates(root)
    .filter((g) => g.status === "awaiting")
    .filter((g) => !isExpired(g));
  return pending[pending.length - 1];
}

function isExpired(gate: GateState, now: string = new Date().toISOString()): boolean {
  return gate.expires_at <= now;
}

function transition(root: string, gate: GateState, status: GateStatus, reason?: string): GateState {
  const updated: GateState = { ...gate, status };
  if (reason !== undefined) {
    updated.terminal_at = new Date().toISOString();
    updated.terminal_reason = reason;
  }
  const expected = existsSync(gatePath(root, gate.gate_id))
    ? readFileSync(gatePath(root, gate.gate_id), "utf8")
    : undefined;
  casWrite(root, updated, expected);
  return updated;
}

function buildPending(gate: GateState): PendingIngest {
  const byKind = (kind: string): string => {
    const a = gate.artifacts.find((x) => x.artifact_kind === kind);
    if (a === undefined) throw new GateStorageError(`gate has no '${kind}' artifact`);
    return a.artifact_id;
  };
  // `claims` exists only for an ingest: a save composes from a claimed query
  // answer rather than extracting from sources, so its sealed set has no claims
  // artifact. Publication does not read it either way.
  const claims = gate.artifacts.find((x) => x.artifact_kind === "claims")?.artifact_id;
  return {
    runId: gate.run_id,
    sourceIds: [...gate.source_ids],
    ...(claims !== undefined ? { claimsArtifactId: claims } : {}),
    pageDraftArtifactId: byKind("page_draft"),
    lintReportArtifactId: byKind("lint_report"),
    verificationArtifactId: byKind("verification_report"),
  };
}

// ── Operator decisions (host-authenticated) ─────────────────────────────────

/**
 * Approve a pending gate: verify liveness, base-generation drift, and the
 * sealed packet, then publish (via approveIngest) and finalize the gate.
 */
export function approveGate(
  root: string,
  sources: readonly IngestSource[],
  runId?: string,
  projectRoot?: string,
  checkpointer?: Checkpointer
): { gate: GateState; result: KbResult } {
  const gate = (runId !== undefined && findGateForRun(root, runId)) || latestPendingGate(root);
  if (gate === undefined) {
    throw new GateStorageError("no pending content-review gate to approve");
  }
  if (gate.status !== "awaiting") {
    throw new GateStorageError(`gate is '${gate.status}', not awaiting; nothing to approve`);
  }

  // Expiry invalidates BEFORE any publication attempt.
  if (isExpired(gate)) {
    transition(root, gate, "invalidated", "expired");
    throw new GateStorageError("gate expired; invalidated and nothing published");
  }

  // Drift invalidates: the base generation must still be selected.
  const selected = readSelectedGeneration(root);
  if (
    selected === undefined ||
    selected.selector.generation_id !== gate.base_generation_id ||
    selected.selector.catalog_sha256 !== gate.base_catalog_sha256
  ) {
    transition(root, gate, "invalidated", "base_generation_drift");
    throw new GateStorageError(
      "base generation drifted since the gate was presented; invalidated and nothing published"
    );
  }

  // Packet digest must re-verify against the sealed artifact set.
  const recomputed = gatePacketDigest(gate);
  if (recomputed !== gate.packet_sha256) {
    transition(root, gate, "invalidated", "packet_digest_mismatch");
    throw new GateStorageError("gate packet digest mismatch; invalidated and nothing published");
  }

  // Reserve the gate (awaiting → claimed) with an optimistic CAS so a second
  // approver loses BEFORE any publication.
  const claimed = transition(root, gate, "claimed");

  try {
    const pending = buildPending(claimed);
    const result = approveIngest(
      {
        kbRoot: root,
        profileId: claimed.kb_profile_id,
        runId: claimed.run_id,
        ...(checkpointer !== undefined ? { checkpointer } : {}),
      },
      sources,
      pending
    );
    if (result.status !== "complete" || !result.met) {
      // Reversible: release the reservation back to awaiting for a retry.
      const released = transition(root, claimed, "awaiting", "approval_refused_released");
      return { gate: released, result };
    }

    // Legacy standalone gates require the explicit owner authority root; they
    // never infer it from the KB publication tree.
    if (claimed.source_capability_ids.length > 0) {
      if (projectRoot === undefined) {
        throw new GateStorageError("legacy gate approval requires explicit projectRoot authority");
      }
      consumeCapabilities(projectRoot, claimed.source_capability_ids);
    }

    const publishedGenerationId = result.ids.find((id) => id.startsWith("gen_")) ?? "unknown";
    const approved: GateState = {
      ...claimed,
      status: "approved",
      terminal_at: new Date().toISOString(),
      published_generation_id: publishedGenerationId,
    };
    const expected = readFileSync(gatePath(root, claimed.gate_id), "utf8");
    casWrite(root, approved, expected);
    return { gate: approved, result };
  } catch (err) {
    // Release the reservation (only if still claimed) so the gate can be retried.
    try {
      const current = readGate(root, claimed.gate_id);
      if (current !== undefined && current.status === "claimed") {
        transition(
          root,
          current,
          "awaiting",
          `approval_failed_released: ${(err as Error).message.slice(0, 200)}`
        );
      }
    } catch {
      // best effort
    }
    throw err;
  }
}

/** Deny a pending gate (publishes nothing). */
export function denyGate(root: string, runId?: string, projectRoot?: string): GateState {
  const gate = (runId !== undefined && findGateForRun(root, runId)) || latestPendingGate(root);
  if (gate === undefined) throw new GateStorageError("no pending gate to deny");
  if (gate.status !== "awaiting") {
    throw new GateStorageError(`gate is '${gate.status}', not awaiting; cannot deny`);
  }
  const denied = transition(root, gate, "denied", "operator_denied");

  if (gate.source_capability_ids.length > 0) {
    if (projectRoot === undefined) {
      throw new GateStorageError("legacy gate denial requires explicit projectRoot authority");
    }
    invalidateCapabilities(projectRoot, gate.source_capability_ids);
  }
  return denied;
}

// ── Host capability resolution and immutable source snapshots ──────────────

function currentUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

function assertNoSymlinkComponents(candidate: string, label: string): void {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!existsSync(cursor)) throw new GateStorageError(`${label} does not exist: ${cursor}`);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new GateStorageError(`${label} has a symlink component: ${cursor}`);
    }
  }
}

function assertOwnerDirectory(directory: string, label: string): void {
  assertNoSymlinkComponents(directory, label);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new GateStorageError(`${label} is not a non-symlink directory`);
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new GateStorageError(`${label} mode must be exactly 0700`);
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new GateStorageError(`${label} has the wrong owner`);
  }
}

function assertOwnerSnapshot(file: string, label: string): number {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const uid = currentUid();
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      (uid !== undefined && opened.uid !== uid)
    ) {
      throw new GateStorageError(`${label} is not an owner-only regular single-link file`);
    }
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  return descriptor;
}

function readCapabilityFile(file: string, label: string): Buffer {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) {
    throw new GateStorageError(`${label} path is not absolute and normalized`);
  }
  assertNoSymlinkComponents(file, label);
  if (realpathSync.native(file) !== file) {
    throw new GateStorageError(`${label} path does not resolve exactly to its envelope path`);
  }
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new GateStorageError(`${label} is not a regular non-symlink single-link file`);
  }
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new GateStorageError(`${label} changed during its no-follow open`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function verifyCanonicalTargetPathAndHash(env: CapabilityEnvelope): Buffer {
  const authorityRoot = env.authority_root;
  if (authorityRoot === undefined) {
    throw new GateStorageError(`capability '${env.capability_id}' has no authority root`);
  }
  assertNoSymlinkComponents(authorityRoot, "canonical authority root");
  if (realpathSync.native(authorityRoot) !== authorityRoot) {
    throw new GateStorageError("canonical authority root does not resolve exactly");
  }
  const relative = path.relative(authorityRoot, env.resolved_path);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new GateStorageError(`capability '${env.capability_id}' escapes its authority root`);
  }
  const bytes = readCapabilityFile(env.resolved_path, "canonical target");
  const actual = capabilitySha256Of(bytes);
  if (actual !== env.expected_sha256) {
    throw new GateStorageError(
      `canonical target drifted: capability '${env.capability_id}' expected ${env.expected_sha256}, got ${actual}`
    );
  }
  return bytes;
}

/** Load one complete authoritative envelope from the owner-only SQLite store. */
export function loadEnvelope(projectRoot: string, capabilityId: string): CapabilityEnvelope {
  using store = new CapabilityStore(projectRoot);
  const envelope = store.envelope(capabilityId);
  if (envelope === undefined) {
    throw new GateStorageError(`capability '${capabilityId}' not found in owner authority store`);
  }
  return envelope;
}

export function capabilitySha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface MintSourceCapabilityOptions {
  readonly projectRoot: string;
  readonly kbProfileId: string;
  readonly sessionId: string;
  readonly allowedOperation: "ingest";
  readonly absolutePath: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly sourceType?: "file" | "url_snapshot" | "research_artifact" | "manual";
  readonly mediaType?: "text/plain" | "text/markdown" | "application/json";
  readonly capturedAt?: string;
  readonly expiresHours?: number;
}

/** Mint one source capability into owner authority; no KB-root envelope file exists. */
export function mintSourceCapability(options: MintSourceCapabilityOptions): CapabilityEnvelope {
  const { projectRoot, kbProfileId, absolutePath, title, authors } = options;
  if (title.length === 0) throw new GateStorageError("capability title is required");
  if (options.sessionId.length === 0 || options.allowedOperation !== "ingest") {
    throw new GateStorageError(
      "source capability requires an explicit session and ingest operation"
    );
  }
  const sourceType = options.sourceType ?? "manual";
  const mediaType = options.mediaType ?? "text/plain";
  const expiresHours = options.expiresHours ?? 72;
  if (!Number.isFinite(expiresHours) || expiresHours <= 0) {
    throw new GateStorageError("expires-hours must be > 0");
  }
  const bytes = readCapabilityFile(absolutePath, "source capability file");
  // Minting proves the supplied file is UTF-8. Admission will independently
  // stream the same expected bytes through one no-follow open.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GateStorageError("source capability file is not valid UTF-8");
  }
  const now = new Date().toISOString();
  const envelope: CapabilityEnvelope = {
    schema_version: 1,
    capability_id: `cap_${randomUUID().replace(/-/g, "")}`,
    kind: "source_read",
    session_id: options.sessionId,
    kb_profile_id: kbProfileId,
    resolved_path: absolutePath,
    expected_sha256: capabilitySha256Of(bytes),
    media_type: mediaType,
    source_metadata: {
      source_type: sourceType,
      captured_at: options.capturedAt ?? now,
      title,
      authors: [...authors],
    },
    allowed_operation: "ingest",
    issued_at: now,
    expires_at: new Date(Date.now() + expiresHours * 3_600_000).toISOString(),
  };
  const validatedEnvelope = validateEnvelopeCrossField(envelope);
  using store = new CapabilityStore(projectRoot);
  store.register(validatedEnvelope);
  return validatedEnvelope;
}

export type SourceAdmissionBoundary =
  | "after_preindex"
  | "after_claim"
  | "after_source_open"
  | "after_temp_fsync"
  | "after_rename"
  | "after_admitted";

/** Test-only process-death signal: exact rows/files remain for restart recovery. */
export class SimulatedSourceAdmissionCrash extends Error {
  constructor(readonly boundary: SourceAdmissionBoundary) {
    super(`simulated source-admission crash at ${boundary}`);
    this.name = "SimulatedSourceAdmissionCrash";
  }
}

export interface CapabilityClaimInput extends CapabilityBinding {
  readonly projectRoot: string;
  readonly kbRoot: string;
  readonly capabilityIds: readonly string[];
  readonly transactionId?: string;
  readonly maxSourceBytes?: number;
  readonly onSourceBoundary?: (boundary: SourceAdmissionBoundary, sourceId?: string) => void;
}

function fireBoundary(
  input: CapabilityClaimInput,
  boundary: SourceAdmissionBoundary,
  sourceId?: string
): void {
  input.onSourceBoundary?.(boundary, sourceId);
}

function snapshotDirectory(kbRoot: string, runId: string): string {
  return path.join(path.resolve(kbRoot), "work", runId, "transaction", "sources");
}

function ensureSnapshotDirectory(kbRoot: string, runId: string): string {
  const root = path.resolve(kbRoot);
  const work = path.join(root, "work");
  const run = path.join(work, runId);
  const transaction = path.join(run, "transaction");
  const sources = path.join(transaction, "sources");
  for (const directory of [work, run, transaction, sources]) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    assertOwnerDirectory(directory, "source snapshot directory");
  }
  return sources;
}

function absoluteAdmissionKey(kbRoot: string, key: string, expected: string): string {
  if (key !== expected || path.posix.isAbsolute(key) || key.includes("\\")) {
    throw new GateStorageError("source admission storage key is not the exact preindexed key");
  }
  const root = path.resolve(kbRoot);
  const candidate = path.resolve(root, ...key.split("/"));
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new GateStorageError("source admission storage key escapes the KB root");
  }
  return candidate;
}

function expectedAdmissionKeys(record: SourceAdmissionRecord): {
  final: string;
  temporary: string;
} {
  return {
    final: path.posix.join("work", record.run_id, "transaction", "sources", record.source_id),
    temporary: path.posix.join(
      "work",
      record.run_id,
      "transaction",
      "sources",
      `.${record.source_id}.${record.transaction_id}.tmp`
    ),
  };
}

function readSnapshotBytes(kbRoot: string, record: SourceAdmissionRecord): Buffer {
  const keys = expectedAdmissionKeys(record);
  const file = absoluteAdmissionKey(kbRoot, record.storage_key, keys.final);
  assertNoSymlinkComponents(file, "source snapshot");
  assertOwnerDirectory(path.dirname(file), "source snapshot directory");
  const descriptor = assertOwnerSnapshot(file, "source snapshot");
  try {
    const bytes = readFileSync(descriptor);
    if (capabilitySha256Of(bytes) !== record.sha256) {
      throw new GateStorageError(`source snapshot '${record.source_id}' hash changed`);
    }
    if (record.state !== "preparing" && bytes.length !== record.byte_length) {
      throw new GateStorageError(`source snapshot '${record.source_id}' length changed`);
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GateStorageError(`source snapshot '${record.source_id}' is not valid UTF-8`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
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

function streamSourceToTemporary(input: {
  envelope: CapabilityEnvelope;
  temporaryPath: string;
  maxBytes: number;
  boundary: () => void;
}): number {
  assertNoSymlinkComponents(input.envelope.resolved_path, "source capability file");
  if (realpathSync.native(input.envelope.resolved_path) !== input.envelope.resolved_path) {
    throw new GateStorageError("source capability path no longer resolves exactly");
  }
  const before = lstatSync(input.envelope.resolved_path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new GateStorageError("source capability path is not a regular single-link file");
  }
  const temporaryDescriptor = openSync(
    input.temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  let sourceDescriptor: number | undefined;
  try {
    sourceDescriptor = openSync(
      input.envelope.resolved_path,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    const opened = fstatSync(sourceDescriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new GateStorageError("source capability file changed during its one no-follow open");
    }
    input.boundary();
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const count = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > input.maxBytes)
        throw new GateStorageError("source snapshot exceeds reader limit");
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      decoder.decode(chunk, { stream: true });
      let written = 0;
      while (written < count) {
        written += writeSync(temporaryDescriptor, chunk, written, count - written);
      }
    }
    decoder.decode();
    const digest = hash.digest("hex");
    if (digest !== input.envelope.expected_sha256) {
      throw new GateStorageError(
        `source file drifted before snapshot: capability '${input.envelope.capability_id}' expected ${input.envelope.expected_sha256}, got ${digest}`
      );
    }
    fsyncSync(temporaryDescriptor);
    return total;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new GateStorageError("source capability file is not valid UTF-8");
    }
    throw error;
  } finally {
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
    closeSync(temporaryDescriptor);
  }
}

function recoverOrCreateSnapshot(
  store: CapabilityStore,
  kbRoot: string,
  envelope: CapabilityEnvelope,
  record: SourceAdmissionRecord,
  input: CapabilityClaimInput
): void {
  const keys = expectedAdmissionKeys(record);
  const directory = ensureSnapshotDirectory(kbRoot, record.run_id);
  const expectedDirectory = snapshotDirectory(kbRoot, record.run_id);
  if (directory !== expectedDirectory) throw new GateStorageError("source snapshot root changed");
  const finalPath = absoluteAdmissionKey(kbRoot, record.storage_key, keys.final);
  const temporaryKey = record.temporary_storage_key ?? keys.temporary;
  const temporaryPath = absoluteAdmissionKey(kbRoot, temporaryKey, keys.temporary);

  if (record.state === "admitted" || record.state === "published") {
    void readSnapshotBytes(kbRoot, record);
    return;
  }
  if (record.state !== "preparing") {
    throw new GateStorageError(`source admission '${record.source_id}' is ${record.state}`);
  }

  if (existsSync(finalPath)) {
    const bytes = readSnapshotBytes(kbRoot, record);
    store.admitSource(record.source_id, bytes.length);
    fireBoundary(input, "after_admitted", record.source_id);
    return;
  }
  if (existsSync(temporaryPath)) {
    const descriptor = assertOwnerSnapshot(temporaryPath, "source snapshot temporary file");
    let bytes: Buffer;
    try {
      bytes = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (capabilitySha256Of(bytes) !== record.sha256) {
      throw new GateStorageError(`source snapshot temporary '${record.source_id}' is partial`);
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GateStorageError(`source snapshot temporary '${record.source_id}' is not UTF-8`);
    }
    renameSync(temporaryPath, finalPath);
    fsyncDirectory(directory);
    fireBoundary(input, "after_rename", record.source_id);
    store.admitSource(record.source_id, bytes.length);
    fireBoundary(input, "after_admitted", record.source_id);
    return;
  }

  const maxBytes = input.maxSourceBytes ?? 1_048_576;
  const byteLength = streamSourceToTemporary({
    envelope,
    temporaryPath,
    maxBytes,
    boundary: () => fireBoundary(input, "after_source_open", record.source_id),
  });
  fireBoundary(input, "after_temp_fsync", record.source_id);
  renameSync(temporaryPath, finalPath);
  fsyncDirectory(directory);
  fireBoundary(input, "after_rename", record.source_id);
  store.admitSource(record.source_id, byteLength);
  fireBoundary(input, "after_admitted", record.source_id);
}

function removeExactAdmissionFiles(kbRoot: string, record: SourceAdmissionRecord): void {
  const keys = expectedAdmissionKeys(record);
  const finalPath = absoluteAdmissionKey(kbRoot, record.storage_key, keys.final);
  const temporaryPath = absoluteAdmissionKey(
    kbRoot,
    record.temporary_storage_key ?? keys.temporary,
    keys.temporary
  );
  for (const file of [temporaryPath, finalPath]) {
    if (!existsSync(file)) continue;
    const stat = lstatSync(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new GateStorageError("indexed source cleanup found a non-file exact key");
    }
    unlinkSync(file);
  }
  const directory = snapshotDirectory(kbRoot, record.run_id);
  if (existsSync(directory)) fsyncDirectory(directory);
}

/** Indexed cleanup only; no scan or adoption is used. */
export function discardSourceAdmissions(input: {
  projectRoot: string;
  kbRoot: string;
  runId: string;
  transactionId?: string;
  capabilityIds: readonly string[];
  invalidateClaims: boolean;
}): void {
  const transactionId = input.transactionId ?? input.runId;
  using store = new CapabilityStore(input.projectRoot);
  const records = store.admissionsForTransaction(input.runId, transactionId);
  store.beginDiscardAdmissions(input.runId, transactionId);
  for (const initial of records) {
    const current = store.admission(initial.source_id) ?? initial;
    if (current.state !== "discarding" && current.state !== "discarded") continue;
    if (current.state === "discarding") {
      removeExactAdmissionFiles(input.kbRoot, current);
      store.finishDiscardAdmission(current.source_id);
    }
  }
  if (input.invalidateClaims && input.capabilityIds.length > 0) {
    store.invalidateClaimedAll({
      capabilityIds: input.capabilityIds,
      runId: input.runId,
      transactionId,
    });
  }
}

/** Resolve, preindex, claim all-or-none, and snapshot source capabilities once. */
export function claimCapabilities(input: CapabilityClaimInput): string[] {
  if (input.capabilityIds.length === 0) return [];
  if (new Set(input.capabilityIds).size !== input.capabilityIds.length) {
    throw new GateStorageError("capability claim ids must be unique");
  }
  const transactionId = input.transactionId ?? input.runId;
  using store = new CapabilityStore(input.projectRoot);
  const envelopes = input.capabilityIds.map((id) => {
    const envelope = store.envelope(id);
    if (envelope === undefined) throw new GateStorageError(`capability '${id}' not found`);
    return envelope;
  });

  let admissions: SourceAdmissionRecord[] = [];
  if (input.kind === "source_read") {
    // PREINDEX before both claim and source I/O.
    admissions = store.prepareSourceAdmissions({
      envelopes,
      runId: input.runId,
      transactionId,
    });
    fireBoundary(input, "after_preindex");
  }

  try {
    store.claimAll(envelopes, {
      runId: input.runId,
      transactionId,
      sessionId: input.sessionId,
      profileId: input.profileId,
      kind: input.kind,
      operation: input.operation,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    fireBoundary(input, "after_claim");
    if (input.kind === "source_read") {
      for (const admission of admissions) {
        const envelope = envelopes.find(
          (candidate) => candidate.capability_id === admission.capability_id
        );
        if (envelope === undefined)
          throw new GateStorageError("source admission lost its envelope");
        recoverOrCreateSnapshot(store, input.kbRoot, envelope, admission, input);
      }
    }
  } catch (error) {
    if (error instanceof SimulatedSourceAdmissionCrash) throw error;
    const anyClaimed = envelopes.some((envelope) => {
      const lease = store.lease(envelope.capability_id);
      return (
        lease?.state === "claimed" &&
        lease.run_id === input.runId &&
        lease.transaction_id === transactionId
      );
    });
    if (admissions.length > 0) {
      // Close this store first only through method calls; cleanup opens its own
      // exact authority handle after this function unwinds.
      store.beginDiscardAdmissions(input.runId, transactionId);
      for (const admission of admissions) {
        const current = store.admission(admission.source_id) ?? admission;
        if (current.state === "discarding") {
          removeExactAdmissionFiles(input.kbRoot, current);
          store.finishDiscardAdmission(current.source_id);
        }
      }
    }
    if (anyClaimed) {
      store.invalidateClaimedAll({
        capabilityIds: input.capabilityIds,
        runId: input.runId,
        transactionId,
      });
    }
    throw error;
  }
  return store
    .admissionsForTransaction(input.runId, transactionId)
    .map((record) => record.source_id);
}

/** Read only exact immutable same-run snapshots; external paths are never reopened. */
export function sourcesFromAdmissions(
  projectRoot: string,
  kbRoot: string,
  sourceIds: readonly string[],
  binding: Omit<CapabilityBinding, "kind" | "operation"> & { transactionId?: string }
): IngestSource[] {
  using store = new CapabilityStore(projectRoot);
  const transactionId = binding.transactionId ?? binding.runId;
  return sourceIds.map((sourceId) => {
    const admission = store.admission(sourceId);
    if (
      admission === undefined ||
      admission.state !== "admitted" ||
      admission.run_id !== binding.runId ||
      admission.transaction_id !== transactionId
    ) {
      throw new GateStorageError(`source '${sourceId}' is not an admitted same-run snapshot`);
    }
    const envelope = store.envelope(admission.capability_id);
    if (envelope === undefined)
      throw new GateStorageError(`source '${sourceId}' lost its envelope`);
    validateClaimedCapability(envelope, store.lease(admission.capability_id), {
      ...binding,
      transactionId,
      kind: "source_read",
      operation: "ingest",
    });
    if (
      admission.envelope_sha256 !== envelopeDigest(envelope) ||
      admission.sha256 !== envelope.expected_sha256 ||
      admission.media_type !== envelope.media_type
    ) {
      throw new GateStorageError(`source '${sourceId}' admission metadata drifted`);
    }
    const metadata = envelope.source_metadata;
    if (metadata === undefined) throw new GateStorageError(`source '${sourceId}' lost metadata`);
    const bytes = readSnapshotBytes(kbRoot, admission);
    return {
      sourceId,
      capabilityDigest: admission.envelope_sha256,
      title: metadata.title,
      authors: metadata.authors,
      content: bytes.toString("utf8"),
      mediaType: admission.media_type,
      sourceType: metadata.source_type as SourceType,
      capturedAt: metadata.captured_at,
      ...(metadata.published_at !== undefined ? { publishedAt: metadata.published_at } : {}),
      ...(metadata.redacted_locator !== undefined
        ? { redactedLocator: metadata.redacted_locator }
        : {}),
    };
  });
}

/** Compatibility name; despite the old name this reads snapshots, never capabilities paths. */
export const sourcesFromCapabilities = sourcesFromAdmissions;

export interface ClaimedCanonicalTarget {
  readonly envelope: CapabilityEnvelope;
  readonly bytes: Buffer;
  readonly sha256: string;
}

/** G9 behavior: canonical targets remain live preimage-checked claimed capabilities. */
export function readClaimedCanonicalTarget(input: {
  projectRoot: string;
  capabilityId: string;
  runId: string;
  sessionId: string;
  profileId: string;
  transactionId?: string;
  now?: string;
}): ClaimedCanonicalTarget {
  using store = new CapabilityStore(input.projectRoot);
  const envelope = store.envelope(input.capabilityId);
  if (envelope === undefined)
    throw new GateStorageError(`capability '${input.capabilityId}' absent`);
  validateClaimedCapability(envelope, store.lease(input.capabilityId), {
    runId: input.runId,
    transactionId: input.transactionId ?? input.runId,
    sessionId: input.sessionId,
    profileId: input.profileId,
    kind: "canonical_target",
    operation: "promote",
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const bytes = verifyCanonicalTargetPathAndHash(envelope);
  return { envelope, bytes, sha256: capabilitySha256Of(bytes) };
}

export function invalidateCapabilities(
  projectRoot: string,
  capabilityIds: readonly string[],
  binding?: { runId: string; transactionId?: string }
): void {
  if (capabilityIds.length === 0) return;
  using store = new CapabilityStore(projectRoot);
  try {
    if (binding !== undefined) {
      store.invalidateClaimedAll({
        capabilityIds,
        runId: binding.runId,
        transactionId: binding.transactionId ?? binding.runId,
      });
    } else {
      for (const id of capabilityIds) store.invalidate(id);
    }
  } catch (error) {
    if (error instanceof CapabilityError) throw new GateStorageError(error.message);
    throw error;
  }
}

export function consumeCapabilities(projectRoot: string, capabilityIds: readonly string[]): void {
  if (capabilityIds.length === 0) return;
  using store = new CapabilityStore(projectRoot);
  try {
    for (const id of capabilityIds) store.consume(id);
  } catch (error) {
    if (error instanceof CapabilityError) throw new GateStorageError(error.message);
    throw error;
  }
}
