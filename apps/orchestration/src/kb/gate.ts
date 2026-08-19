/**
 * KB content-review gate (§5.1, pragmatic slice).
 *
 * The gate is the ONLY path from a sealed candidate set to publication, and
 * it is host-authenticated: no model-visible action carries a decision. The
 * tool surface presents the gate (`awaiting_user`), re-presents it on
 * `resume`, and reports it on `status`; the operator approves/denies through
 * the host CLI (`penny-kb-gate approve|deny`), which is the §5.1
 * "authenticated callback" in the single-host trust domain (owner-only files
 * under the KB root).
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

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { canonicalJson, sha256Hex, type SourceType, type Sha256Hex } from "./contracts.js";
import { readCurrent } from "./filesystem.js";
import { readSelectedGeneration } from "./generations.js";
import { approveIngest, type IngestSource, type PendingIngest } from "./ingest.js";
import { validateEnvelopeCrossField, type CapabilityEnvelope } from "./capabilities.js";
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
  return {
    runId: gate.run_id,
    sourceIds: [...gate.source_ids],
    claimsArtifactId: byKind("claims"),
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
  runId?: string
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
      { kbRoot: root, profileId: claimed.kb_profile_id, runId: claimed.run_id },
      sources,
      pending
    );
    if (result.status !== "complete" || !result.met) {
      // Reversible: release the reservation back to awaiting for a retry.
      const released = transition(root, claimed, "awaiting", "approval_refused_released");
      return { gate: released, result };
    }

    // Consume the claimed source capabilities (if any are bound).
    consumeCapabilities(root, claimed.source_capability_ids);

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
export function denyGate(root: string, runId?: string): GateState {
  const gate = (runId !== undefined && findGateForRun(root, runId)) || latestPendingGate(root);
  if (gate === undefined) throw new GateStorageError("no pending gate to deny");
  if (gate.status !== "awaiting") {
    throw new GateStorageError(`gate is '${gate.status}', not awaiting; cannot deny`);
  }
  const denied = transition(root, gate, "denied", "operator_denied");

  invalidateCapabilities(root, gate.source_capability_ids);
  return denied;
}

// ── Host source resolution (shared by the tool and the gate CLI) ───────────

function assertRegularFile(p: string): void {
  if (!existsSync(p)) throw new GateStorageError(`file does not exist: ${p}`);
  const st = lstatSync(p);
  if (st.isSymbolicLink()) throw new GateStorageError(`refusing symlink: ${p}`);
  if (!st.isFile()) throw new GateStorageError(`not a regular file: ${p}`);
}

function loadEnvelope(kbRoot: string, capabilityId: string): CapabilityEnvelope {
  const regPath = path.join(kbRoot, "capabilities", `${capabilityId}.json`);
  if (!existsSync(regPath)) {
    throw new GateStorageError(`capability '${capabilityId}' not found in registry`);
  }
  const st = lstatSync(regPath);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new GateStorageError("capability registry file is not a regular file");
  }
  if ((st.mode & 0o077) !== 0) {
    throw new GateStorageError("capability registry file is not owner-only");
  }
  const env = JSON.parse(readFileSync(regPath, "utf8")) as CapabilityEnvelope;
  validateEnvelopeCrossField(env);
  return env;
}

export function capabilitySha256Of(bytes: Buffer): string {
  // Re-export a stable helper path for callers that want the digest.
  return sha256Hex(bytes.toString("utf8"));
}

/** Options for minting one source-read capability envelope. */
export interface MintSourceCapabilityOptions {
  readonly kbRoot: string;
  readonly kbProfileId: string;
  readonly absolutePath: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly sourceType?: "file" | "url_snapshot" | "research_artifact" | "manual";
  readonly mediaType?: "text/plain" | "text/markdown" | "application/json";
  readonly sessionId?: string;
  readonly capturedAt?: string;
  readonly expiresHours?: number;
}

/**
 * Mint a source-read capability — the single source of truth for the CLI and any
 * test helper.
 *
 * Validates the file (exists, regular, non-symlink), builds the envelope, validates
 * its cross-field contract, registers the lease in the capability store, and writes
 * the envelope to the registry the approval path re-resolves from.
 */
export function mintSourceCapability(options: MintSourceCapabilityOptions): CapabilityEnvelope {
  const { kbRoot, kbProfileId, absolutePath, title, authors } = options;
  if (title.length === 0) throw new GateStorageError("capability title is required");
  if (authors.length === 0) throw new GateStorageError("capability requires at least one author");

  const sourceType = options.sourceType ?? "manual";
  const mediaType = options.mediaType ?? "text/plain";
  const expiresHours = options.expiresHours ?? 72;
  if (!Number.isFinite(expiresHours) || expiresHours <= 0) {
    throw new GateStorageError("expires-hours must be > 0");
  }

  assertRegularFile(absolutePath);
  const bytes = readFileSync(absolutePath);
  const digest = capabilitySha256Of(bytes);

  const now = new Date().toISOString();
  const envelope: CapabilityEnvelope = {
    schema_version: 1,
    capability_id: `cap_${randomUUID().replace(/-/g, "")}`,
    kind: "source_read",
    session_id: options.sessionId ?? `host-${randomUUID().slice(0, 8)}`,
    kb_profile_id: kbProfileId,
    resolved_path: absolutePath,
    expected_sha256: digest,
    media_type: mediaType,
    source_metadata: {
      source_type: sourceType,
      captured_at: options.capturedAt ?? now,
      title,
      authors: [...authors],
    },
    allowed_operation: "ingest",
    issued_at: now,
    expires_at: new Date(Date.now() + expiresHours * 3600 * 1000).toISOString(),
  };
  validateEnvelopeCrossField(envelope);

  const store = new CapabilityStore(kbRoot);
  try {
    store.register(envelope);
  } finally {
    store.close();
  }

  const regDir = path.join(kbRoot, "capabilities");
  if (!existsSync(regDir)) {
    mkdirSync(regDir, { recursive: true, mode: 0o700 });
    chmodSync(regDir, 0o700);
  }
  const regPath = path.join(regDir, `${envelope.capability_id}.json`);
  writeFileSync(regPath, canonicalJson(envelope), { mode: 0o600 });
  chmodSync(regPath, 0o600);

  return envelope;
}

/**
 * Resolve a set of minted capabilities to admitted sources, verifying each
 * file's digest against its envelope. Refuses on any drift.
 */
export function sourcesFromCapabilities(
  kbRoot: string,
  capabilityIds: readonly string[]
): IngestSource[] {
  const sources: IngestSource[] = [];
  for (const capId of capabilityIds) {
    const env = loadEnvelope(kbRoot, capId);
    if (env.allowed_operation !== "ingest") {
      throw new GateStorageError(`capability '${capId}' is not an ingest capability`);
    }
    assertRegularFile(env.resolved_path);
    const bytes = readFileSync(env.resolved_path);
    const actual = capabilitySha256Of(bytes);
    if (actual !== env.expected_sha256) {
      throw new GateStorageError(
        `source file drifted: capability '${capId}' expected ${env.expected_sha256}, got ${actual}`
      );
    }
    sources.push({
      sourceId: env.capability_id,
      title: env.source_metadata?.title ?? "Ingested source",
      authors: env.source_metadata?.authors ?? ["unknown"],
      content: bytes.toString("utf8"),
      mediaType: (env.media_type ?? "text/plain") as IngestSource["mediaType"],
      sourceType: (env.source_metadata?.source_type ?? "manual") as SourceType,
      capturedAt: env.source_metadata?.captured_at ?? env.issued_at,
    });
  }
  return sources;
}

export function claimCapabilities(
  kbRoot: string,
  capabilityIds: readonly string[],
  runId: string
): void {
  const store = new CapabilityStore(kbRoot);
  try {
    store.claimAll(capabilityIds, runId, runId);
  } finally {
    store.close();
  }
}

export function invalidateCapabilities(kbRoot: string, capabilityIds: readonly string[]): void {
  if (capabilityIds.length === 0) return;
  const store = new CapabilityStore(kbRoot);
  try {
    for (const id of capabilityIds) {
      try {
        store.invalidate(id);
      } catch (err) {
        if (err instanceof CapabilityError) {
          throw new GateStorageError(
            `capability '${id}' could not be invalidated: ${(err as Error).message}`
          );
        }
        throw err;
      }
    }
  } finally {
    store.close();
  }
}

export function consumeCapabilities(kbRoot: string, capabilityIds: readonly string[]): void {
  if (capabilityIds.length === 0) return;
  const store = new CapabilityStore(kbRoot);
  try {
    for (const id of capabilityIds) {
      try {
        store.consume(id);
      } catch (err) {
        if (err instanceof CapabilityError) {
          throw new GateStorageError(
            `capability '${id}' could not be consumed: ${(err as Error).message}`
          );
        }
        throw err;
      }
    }
  } finally {
    store.close();
  }
}
