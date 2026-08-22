/**
 * G8 §5.1 authenticated content-review host facade.
 *
 * The model-visible KB request union has no decision field. A trusted host
 * caller obtains the packet from the orchestration control DB, constructs one
 * complete receipt by copying every authority binding from that packet, and
 * submits the receipt here. The control DB is the canonical packet/decision
 * store; legacy `<kb>/.kb/gates/*.json` rows are not consulted by this service.
 */

import { userInfo } from "node:os";
import { randomUUID as cryptoRandomUUID } from "node:crypto";
import path from "node:path";

import type { Directive, JsonValue } from "../contracts.js";
import type { Checkpointer } from "../checkpointer.js";
import type { OrchestrationEngine } from "../engine.js";
import { settleRunInput } from "../private-inputs.js";
import {
  CandidateConflictAllocationSchema,
  ConflictRecordSchema,
  ContentReviewDecisionReceiptSchema,
  ContentReviewGatePacketSchema,
  canonicalJson,
  sha256Hex,
  validateKbContract,
  type CandidateConflictAllocation,
  type ContentReviewDecisionReceipt,
  type ContentReviewGatePacket,
  type KbArtifactHandle,
} from "./contracts.js";
import { readCurrent, readManifest, readPageRevision, readPolicy } from "./filesystem.js";
import { sourcesFromAdmissions } from "./gate.js";
import { sourceRecordFor } from "./ingest.js";
import { readSelectedGeneration } from "./generations.js";
import {
  OperationReceiptStore,
  contentReviewOperationSourceIdentity,
  replayableResultFromRun,
  type OperationCompletion,
} from "./operation-receipts.js";
import { RunArtifactStore } from "./run-artifacts.js";
import { resolveGrantedProfile } from "./profile-registry.js";
import { SaveQueryClaimStore, saveClaimStoreDir } from "./save-claim.js";

const REVIEW_TTL_MS = 24 * 60 * 60 * 1_000;
const RECEIPT_BINDING_KEYS = [
  "run_id",
  "session_id",
  "challenge_id",
  "kb_profile_id",
  "kb_id",
  "action",
  "base_generation_id",
  "base_selector_sha256",
  "candidate_artifact_digests",
  "candidate_source_record_digests",
  "candidate_conflict_allocations",
  "policy_sha256",
  "expires_at",
] as const;

export class ContentReviewError extends Error {
  constructor(
    readonly code:
      | "content_review_corrupt"
      | "content_review_expired"
      | "content_review_drift"
      | "content_review_conflict"
      | "content_review_not_pending",
    message: string
  ) {
    super(message);
    this.name = "ContentReviewError";
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function exactKeys(
  record: Readonly<Record<string, string>>,
  handles: readonly KbArtifactHandle[]
): void {
  const expected = handles.map((handle) => handle.artifact_id).sort();
  const actual = Object.keys(record).sort();
  if (!jsonEqual(actual, expected)) {
    throw new ContentReviewError(
      "content_review_corrupt",
      "candidate_artifact_digests is not the exact artifact-id projection"
    );
  }
  for (const handle of handles) {
    if (record[handle.artifact_id] !== handle.sha256) {
      throw new ContentReviewError(
        "content_review_corrupt",
        `candidate artifact '${handle.artifact_id}' has a mismatched packet digest`
      );
    }
  }
}

/** Closed-schema plus §5.1 action/order/projection refinements. */
export function validateContentReviewPacket(value: unknown): ContentReviewGatePacket {
  const packet = validateKbContract(
    ContentReviewGatePacketSchema,
    value,
    "content-review gate packet"
  );
  const kinds = packet.candidate_artifacts.map((artifact) => artifact.artifact_kind);
  if (!jsonEqual(kinds, ["page_draft", "lint_report", "verification_report"])) {
    throw new ContentReviewError(
      "content_review_corrupt",
      "content-review artifacts must be exactly page_draft, lint_report, verification_report"
    );
  }
  if (new Set(packet.candidate_artifacts.map((artifact) => artifact.artifact_id)).size !== 3) {
    throw new ContentReviewError("content_review_corrupt", "candidate artifact ids are not unique");
  }
  exactKeys(packet.candidate_artifact_digests, packet.candidate_artifacts);
  if (packet.action === "ingest") {
    if (packet.query_run_id !== undefined) {
      throw new ContentReviewError("content_review_corrupt", "ingest packet carries query_run_id");
    }
    if (Object.keys(packet.candidate_source_record_digests).length === 0) {
      throw new ContentReviewError("content_review_corrupt", "ingest packet has no source records");
    }
  } else {
    if (packet.query_run_id === undefined) {
      throw new ContentReviewError("content_review_corrupt", "save packet has no query_run_id");
    }
    if (Object.keys(packet.candidate_source_record_digests).length !== 0) {
      throw new ContentReviewError("content_review_corrupt", "save packet carries source records");
    }
  }
  const allocationIds = packet.candidate_conflict_allocations.map(
    (allocation) => allocation.candidate_conflict_id
  );
  if (new Set(allocationIds).size !== allocationIds.length) {
    throw new ContentReviewError("content_review_corrupt", "conflict allocations are not unique");
  }
  if (!jsonEqual(allocationIds, [...allocationIds].sort())) {
    throw new ContentReviewError("content_review_corrupt", "conflict allocations are not sorted");
  }
  if (packet.expires_at <= packet.issued_at) {
    throw new ContentReviewError(
      "content_review_corrupt",
      "content-review expiry is not after issue"
    );
  }
  return packet;
}

export function packetJcs(packet: ContentReviewGatePacket): string {
  return canonicalJson(validateContentReviewPacket(packet));
}

export function packetDigest(packet: ContentReviewGatePacket): string {
  return sha256Hex(packetJcs(packet));
}

interface RawCandidateConflict {
  candidate_conflict_id?: unknown;
  claim_refs?: unknown;
  summary?: unknown;
  evidence_refs?: unknown;
}

interface PageClaimScope {
  readonly refs: ReadonlySet<string>;
}

function refKey(value: { page_id: string; revision_id: string; claim_id: string }): string {
  return `${value.page_id}\u0000${value.revision_id}\u0000${value.claim_id}`;
}

function candidateClaimScope(pageDocument: unknown): PageClaimScope {
  const refs = new Set<string>();
  const pages = (pageDocument as { pages?: unknown })?.pages;
  if (!Array.isArray(pages)) return { refs };
  for (const rawPage of pages) {
    const page = rawPage as Record<string, unknown>;
    const frontmatter = (page.frontmatter ?? {}) as Record<string, unknown>;
    const claims = ((page.claims ?? {}) as { claims?: unknown }).claims;
    if (!Array.isArray(claims)) continue;
    for (const rawClaim of claims) {
      const claim = rawClaim as Record<string, unknown>;
      if (
        typeof frontmatter.page_id === "string" &&
        typeof frontmatter.revision_id === "string" &&
        typeof claim.claim_id === "string"
      ) {
        refs.add(
          refKey({
            page_id: frontmatter.page_id,
            revision_id: frontmatter.revision_id,
            claim_id: claim.claim_id,
          })
        );
      }
    }
  }
  return { refs };
}

function baseClaimScope(kbRoot: string): PageClaimScope {
  const refs = new Set<string>();
  const selected = readSelectedGeneration(kbRoot);
  if (selected === undefined) return { refs };
  for (const [pageId, entry] of Object.entries(selected.catalog.pages)) {
    const revision = readPageRevision(kbRoot, pageId, entry.revision_id, {
      pageSha256: entry.page_sha256,
      claimsSha256: entry.claims_sha256,
    });
    for (const claim of revision.claims.claims) {
      refs.add(
        refKey({ page_id: pageId, revision_id: entry.revision_id, claim_id: claim.claim_id })
      );
    }
  }
  return { refs };
}

function evidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry !== null && typeof entry === "object") {
      const id = (entry as { evidence_id?: unknown }).evidence_id;
      return typeof id === "string" ? [id] : [];
    }
    return [];
  });
  return [...new Set(ids)].sort().slice(0, 32);
}

/** Reconstruct the exact conflict bytes bound by one packet allocation. */
export function conflictRecordForAllocation(input: {
  candidate: RawCandidateConflict;
  allocation: CandidateConflictAllocation;
  issuedAt: string;
  allowedClaimRefs: ReadonlySet<string>;
}): Record<string, JsonValue> {
  const rawRefs = Array.isArray(input.candidate.claim_refs)
    ? (input.candidate.claim_refs as unknown[])
    : [];
  const claimRefs = rawRefs.map((raw) => {
    const ref = raw as Record<string, unknown>;
    if (
      typeof ref.page_id !== "string" ||
      typeof ref.revision_id !== "string" ||
      typeof ref.claim_id !== "string"
    ) {
      throw new ContentReviewError(
        "content_review_corrupt",
        "candidate conflict has a malformed claim ref"
      );
    }
    const normalized = {
      page_id: ref.page_id,
      revision_id: ref.revision_id,
      claim_id: ref.claim_id,
    };
    if (!input.allowedClaimRefs.has(refKey(normalized))) {
      throw new ContentReviewError(
        "content_review_corrupt",
        "candidate conflict refers outside the base or candidate page revisions"
      );
    }
    return normalized;
  });
  const summary =
    typeof input.candidate.summary === "string" && input.candidate.summary.trim().length > 0
      ? input.candidate.summary.slice(0, 4096)
      : "Candidate conflict";
  const record = {
    schema_version: 1 as const,
    conflict_record_id: input.allocation.conflict_record_id,
    claim_refs: claimRefs,
    state: "open" as const,
    summary,
    evidence_refs: evidenceIds(input.candidate.evidence_refs),
    created_at: input.issuedAt,
  };
  return validateKbContract(
    ConflictRecordSchema,
    record,
    "allocated conflict record"
  ) as unknown as Record<string, JsonValue>;
}

function readCandidateDocuments(
  kbRoot: string,
  runId: string,
  handles: readonly KbArtifactHandle[],
  checkpointer: Checkpointer
) {
  const store = new RunArtifactStore(kbRoot, runId, checkpointer);
  try {
    const documents = new Map<string, unknown>();
    for (const handle of handles) {
      const actual = store.read(handle.artifact_id);
      if (!jsonEqual(actual.handle, handle)) {
        throw new ContentReviewError(
          "content_review_drift",
          `candidate artifact '${handle.artifact_id}' no longer matches its packet handle`
        );
      }
      documents.set(handle.artifact_kind, JSON.parse(actual.content) as unknown);
    }
    return documents;
  } finally {
    store.close();
  }
}

function conflictCandidates(lintDocument: unknown): RawCandidateConflict[] {
  const raw = (lintDocument as { candidate_conflicts?: unknown })?.candidate_conflicts;
  if (!Array.isArray(raw)) return [];
  const candidates = raw.map((candidate) => candidate as RawCandidateConflict);
  for (const candidate of candidates) {
    if (
      typeof candidate.candidate_conflict_id !== "string" ||
      candidate.candidate_conflict_id.length === 0
    ) {
      throw new ContentReviewError(
        "content_review_corrupt",
        "candidate conflict has no stable candidate_conflict_id"
      );
    }
  }
  candidates.sort((left, right) =>
    String(left.candidate_conflict_id).localeCompare(String(right.candidate_conflict_id))
  );
  const ids = candidates.map((candidate) => String(candidate.candidate_conflict_id));
  if (new Set(ids).size !== ids.length) {
    throw new ContentReviewError("content_review_corrupt", "candidate conflict ids are not unique");
  }
  return candidates;
}

function allocateConflicts(input: {
  kbRoot: string;
  pageDocument: unknown;
  lintDocument: unknown;
  issuedAt: string;
}): CandidateConflictAllocation[] {
  const allowed = new Set([
    ...candidateClaimScope(input.pageDocument).refs,
    ...baseClaimScope(input.kbRoot).refs,
  ]);
  return conflictCandidates(input.lintDocument).map((candidate) => {
    const candidateId = String(candidate.candidate_conflict_id);
    const allocation = validateKbContract(
      CandidateConflictAllocationSchema,
      {
        candidate_conflict_id: candidateId,
        conflict_record_id: `conf_${cryptoRandomUUID().replace(/-/g, "")}`,
        conflict_record_sha256: "0".repeat(64),
      },
      "candidate conflict allocation"
    );
    const record = conflictRecordForAllocation({
      candidate,
      allocation,
      issuedAt: input.issuedAt,
      allowedClaimRefs: allowed,
    });
    return { ...allocation, conflict_record_sha256: sha256Hex(canonicalJson(record)) };
  });
}

/** Build the canonical packet before the engine makes `await_user` durable. */
export function buildContentReviewPacket(input: {
  kbRoot: string;
  runId: string;
  sessionId: string;
  challengeId: string;
  profileId: string;
  action: "ingest" | "save";
  queryRunId?: string;
  artifactIds: readonly string[];
  sourceRecordDigests: Readonly<Record<string, string>>;
  policySha256: string;
  checkpointer: Checkpointer;
  now?: Date;
}): ContentReviewGatePacket {
  const current = readCurrent(input.kbRoot);
  if (current === undefined) {
    throw new ContentReviewError("content_review_corrupt", "no selector exists for content review");
  }
  const manifest = readManifest(input.kbRoot);
  const store = new RunArtifactStore(input.kbRoot, input.runId, input.checkpointer);
  let allHandles: KbArtifactHandle[];
  try {
    allHandles = input.artifactIds.map((artifactId) => store.read(artifactId).handle);
  } finally {
    store.close();
  }
  const requiredKinds = ["page_draft", "lint_report", "verification_report"] as const;
  const candidateArtifacts = requiredKinds.map((kind) => {
    const matches = allHandles.filter((handle) => handle.artifact_kind === kind);
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new ContentReviewError(
        "content_review_corrupt",
        `content review requires exactly one '${kind}' artifact`
      );
    }
    return matches[0];
  });
  const documents = readCandidateDocuments(
    input.kbRoot,
    input.runId,
    candidateArtifacts,
    input.checkpointer
  );
  const issuedAt = (input.now ?? new Date()).toISOString();
  const sourceDigests: Record<string, string> = {};
  if (input.action === "ingest") {
    for (const sourceId of Object.keys(input.sourceRecordDigests).sort()) {
      const digest = input.sourceRecordDigests[sourceId];
      if (digest === undefined || !/^[a-f0-9]{64}$/.test(digest)) {
        throw new ContentReviewError(
          "content_review_corrupt",
          `candidate source '${sourceId}' has no exact record digest`
        );
      }
      sourceDigests[sourceId] = digest;
    }
  } else if (Object.keys(input.sourceRecordDigests).length > 0) {
    throw new ContentReviewError("content_review_corrupt", "save packet carries source digests");
  }
  const packet: ContentReviewGatePacket = {
    schema_version: 1,
    run_id: input.runId,
    session_id: input.sessionId,
    challenge_id: input.challengeId,
    kb_profile_id: input.profileId,
    kb_id: manifest.kb_id,
    action: input.action,
    base_generation_id: current.generation_id,
    base_selector_sha256: sha256Hex(canonicalJson(current)),
    ...(input.action === "save" && input.queryRunId !== undefined
      ? { query_run_id: input.queryRunId }
      : {}),
    candidate_artifacts: candidateArtifacts,
    candidate_artifact_digests: Object.fromEntries(
      candidateArtifacts.map((artifact) => [artifact.artifact_id, artifact.sha256])
    ),
    candidate_source_record_digests: sourceDigests,
    candidate_conflict_allocations: allocateConflicts({
      kbRoot: input.kbRoot,
      pageDocument: documents.get("page_draft"),
      lintDocument: documents.get("lint_report"),
      issuedAt,
    }),
    policy_sha256: input.policySha256,
    issued_at: issuedAt,
    expires_at: new Date(new Date(issuedAt).getTime() + REVIEW_TTL_MS).toISOString(),
  };
  return validateContentReviewPacket(packet);
}

/** Exact packet-to-receipt binding check used at DB and host boundaries. */
export function validateContentReviewReceipt(
  value: unknown,
  packet: ContentReviewGatePacket,
  expectedPacketSha256: string
): ContentReviewDecisionReceipt {
  const receipt = validateKbContract(
    ContentReviewDecisionReceiptSchema,
    value,
    "content-review decision receipt"
  );
  for (const key of RECEIPT_BINDING_KEYS) {
    if (!jsonEqual(receipt[key], packet[key])) {
      throw new ContentReviewError(
        "content_review_conflict",
        `decision receipt '${key}' does not match the stored packet`
      );
    }
  }
  if (receipt.packet_sha256 !== expectedPacketSha256) {
    throw new ContentReviewError(
      "content_review_conflict",
      "decision receipt packet digest does not match the stored packet"
    );
  }
  if (receipt.decided_at < packet.issued_at) {
    throw new ContentReviewError(
      "content_review_conflict",
      "decision predates the stored content-review packet"
    );
  }
  if (receipt.decided_at > receipt.expires_at) {
    throw new ContentReviewError("content_review_expired", "decision was made after packet expiry");
  }
  return receipt;
}

/** Re-resolve every packet binding immediately before callback/resume. */
export function verifyLiveContentReviewBindings(input: {
  projectRoot: string;
  packet: ContentReviewGatePacket;
  checkpointer: Checkpointer;
  now?: Date;
}): string {
  const packet = validateContentReviewPacket(input.packet);
  const now = (input.now ?? new Date()).toISOString();
  if (packet.expires_at <= now) {
    throw new ContentReviewError("content_review_expired", "content-review packet expired");
  }
  const kbRoot = resolveGrantedProfile({
    profileId: packet.kb_profile_id,
    sessionId: packet.session_id,
    registryPath: path.join(input.projectRoot, ".penny", "kb-profiles.json"),
    grantStoreDir: path.join(input.projectRoot, ".penny", "kb-host-grants"),
  }).resolvedRoot;
  const manifest = readManifest(kbRoot);
  if (manifest.kb_id !== packet.kb_id) {
    throw new ContentReviewError("content_review_drift", "KB identity changed after review");
  }
  const current = readCurrent(kbRoot);
  if (
    current === undefined ||
    current.generation_id !== packet.base_generation_id ||
    sha256Hex(canonicalJson(current)) !== packet.base_selector_sha256
  ) {
    throw new ContentReviewError("content_review_drift", "base selector changed after review");
  }
  if (sha256Hex(canonicalJson(readPolicy(kbRoot))) !== packet.policy_sha256) {
    throw new ContentReviewError("content_review_drift", "policy changed after review");
  }
  if (packet.action === "save") {
    const claim = new SaveQueryClaimStore(
      saveClaimStoreDir(input.projectRoot, packet.kb_profile_id)
    ).load(packet.query_run_id!);
    if (
      claim.kb_profile_id !== packet.kb_profile_id ||
      claim.kb_id !== packet.kb_id ||
      claim.save_run_id !== packet.run_id ||
      (claim.state !== "claimed" && claim.state !== "commit_reserved")
    ) {
      throw new ContentReviewError(
        "content_review_drift",
        "save query claim no longer matches the reviewed run"
      );
    }
  }
  const documents = readCandidateDocuments(
    kbRoot,
    packet.run_id,
    packet.candidate_artifacts,
    input.checkpointer
  );
  if (packet.action === "ingest") {
    let snapshots;
    try {
      snapshots = sourcesFromAdmissions(
        input.projectRoot,
        kbRoot,
        Object.keys(packet.candidate_source_record_digests),
        {
          runId: packet.run_id,
          transactionId: packet.run_id,
          sessionId: packet.session_id,
          profileId: packet.kb_profile_id,
        }
      );
    } catch {
      throw new ContentReviewError(
        "content_review_drift",
        "candidate source snapshot authority changed after review"
      );
    }
    for (const source of snapshots) {
      const expected = packet.candidate_source_record_digests[source.sourceId];
      if (sha256Hex(canonicalJson(sourceRecordFor(source, packet.run_id))) !== expected) {
        throw new ContentReviewError(
          "content_review_drift",
          `candidate source record '${source.sourceId}' changed after review`
        );
      }
    }
  }
  const candidates = conflictCandidates(documents.get("lint_report"));
  if (candidates.length !== packet.candidate_conflict_allocations.length) {
    throw new ContentReviewError(
      "content_review_drift",
      "candidate conflict population changed after review"
    );
  }
  const allowed = new Set([
    ...candidateClaimScope(documents.get("page_draft")).refs,
    ...baseClaimScope(kbRoot).refs,
  ]);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const allocation = packet.candidate_conflict_allocations[index];
    if (candidate === undefined || allocation === undefined) {
      throw new ContentReviewError(
        "content_review_drift",
        "candidate conflict allocation is incomplete"
      );
    }
    if (String(candidate.candidate_conflict_id) !== allocation.candidate_conflict_id) {
      throw new ContentReviewError("content_review_drift", "candidate conflict allocation changed");
    }
    const record = conflictRecordForAllocation({
      candidate,
      allocation,
      issuedAt: packet.issued_at,
      allowedClaimRefs: allowed,
    });
    if (sha256Hex(canonicalJson(record)) !== allocation.conflict_record_sha256) {
      throw new ContentReviewError("content_review_drift", "allocated conflict digest changed");
    }
  }
  return kbRoot;
}

const reviewerBrand: unique symbol = Symbol("authenticated-content-reviewer");
export interface AuthenticatedContentReviewer {
  readonly subjectId: string;
  readonly [reviewerBrand]: true;
}

/** Authenticate the callback caller by the local OS process identity. */
export function authenticateLocalContentReviewer(): AuthenticatedContentReviewer {
  const identity =
    typeof process.geteuid === "function"
      ? `uid:${process.geteuid()}`
      : `user:${userInfo().username}`;
  return Object.freeze({
    subjectId: `local_os:${sha256Hex(identity).slice(0, 32)}`,
    [reviewerBrand]: true as const,
  });
}

export interface ContentReviewServiceOptions {
  readonly projectRoot: string;
  readonly checkpointer: Checkpointer;
  readonly engine: OrchestrationEngine;
  readonly reviewer: AuthenticatedContentReviewer;
  readonly now?: () => Date;
  /** Focused crash injection after the decision transaction, before internal resume. */
  readonly afterDecisionStored?: () => void;
}

/**
 * Host service facade. The CLI is one caller; tests and an eventual UI can call
 * the same receipt-preserving API without gaining a model-visible decision path.
 */
export class ContentReviewService {
  private readonly now: () => Date;

  constructor(private readonly options: ContentReviewServiceOptions) {
    if (options.reviewer[reviewerBrand] !== true) {
      throw new ContentReviewError(
        "content_review_conflict",
        "content-review caller is not authenticated by the host"
      );
    }
    this.now = options.now ?? (() => new Date());
  }

  list(profileId?: string) {
    return this.options.checkpointer
      .listContentReviews()
      .filter((record) => profileId === undefined || record.packet.kb_profile_id === profileId);
  }

  /** Build a complete receipt; every authority field is copied from stored packet bytes. */
  prepareDecision(input: {
    runId: string;
    decision: "approve" | "refine" | "deny";
  }): ContentReviewDecisionReceipt {
    const record = this.options.checkpointer.contentReviewForRun(input.runId);
    if (record === undefined || record.state !== "awaiting") {
      throw new ContentReviewError(
        "content_review_not_pending",
        `run '${input.runId}' has no awaiting content-review packet`
      );
    }
    const packet = record.packet;
    try {
      verifyLiveContentReviewBindings({
        projectRoot: this.options.projectRoot,
        packet,
        checkpointer: this.options.checkpointer,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof ContentReviewError) {
        this.options.engine.invalidateContentReviewedRun({
          runId: input.runId,
          reason: error.code,
          state: error.code === "content_review_expired" ? "expired" : "invalidated",
        });
      }
      throw error;
    }
    return validateContentReviewReceipt(
      {
        schema_version: 1,
        receipt_id: `crr_${cryptoRandomUUID().replace(/-/g, "")}`,
        decision: input.decision,
        run_id: packet.run_id,
        session_id: packet.session_id,
        challenge_id: packet.challenge_id,
        kb_profile_id: packet.kb_profile_id,
        kb_id: packet.kb_id,
        action: packet.action,
        base_generation_id: packet.base_generation_id,
        base_selector_sha256: packet.base_selector_sha256,
        packet_sha256: record.packet_sha256,
        candidate_artifact_digests: packet.candidate_artifact_digests,
        candidate_source_record_digests: packet.candidate_source_record_digests,
        candidate_conflict_allocations: packet.candidate_conflict_allocations,
        policy_sha256: packet.policy_sha256,
        reviewer_subject_id: this.options.reviewer.subjectId,
        decided_at: this.now().toISOString(),
        expires_at: packet.expires_at,
      },
      packet,
      record.packet_sha256
    );
  }

  /**
   * Accept exact receipt bytes, atomically persist their digest with the run's
   * gate binding, then internally resume. An exact duplicate is idempotent; a
   * second receipt — even for the same decision — is a conflict.
   */
  submit(receiptValue: unknown): Directive {
    const provisional = validateKbContract(
      ContentReviewDecisionReceiptSchema,
      receiptValue,
      "content-review decision receipt"
    );
    const record = this.options.checkpointer.contentReviewForRun(provisional.run_id);
    if (record === undefined) {
      throw new ContentReviewError("content_review_not_pending", "content-review packet is absent");
    }
    const receipt = validateContentReviewReceipt(provisional, record.packet, record.packet_sha256);
    const receiptJcs = canonicalJson(receipt);
    const receiptSha256 = sha256Hex(receiptJcs);
    if (record.decision_receipt_sha256 !== undefined) {
      if (record.decision_receipt_sha256 !== receiptSha256) {
        throw new ContentReviewError(
          "content_review_conflict",
          `content-review challenge '${record.challenge_id}' already has a different receipt digest`
        );
      }
      if (
        record.transaction_id !== undefined &&
        (record.state === "consumed" || record.state === "refined" || record.state === "denied")
      ) {
        return this.completeRecordedOperation(
          record,
          currentDirective(this.options.checkpointer, receipt.run_id)
        ).directive;
      }
    }
    try {
      verifyLiveContentReviewBindings({
        projectRoot: this.options.projectRoot,
        packet: record.packet,
        checkpointer: this.options.checkpointer,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof ContentReviewError) {
        this.options.engine.invalidateContentReviewedRun({
          runId: receipt.run_id,
          receiptSha256: sha256Hex(canonicalJson(receipt)),
          reason: error.code,
          state: error.code === "content_review_expired" ? "expired" : "invalidated",
        });
      }
      throw error;
    }
    const accepted = this.options.checkpointer.recordContentReviewDecision({
      receipt,
      receiptJcs,
      receiptSha256,
    });
    if (accepted.kind === "duplicate" && accepted.finalized) {
      return this.completeRecordedOperation(
        this.options.checkpointer.contentReviewForRun(receipt.run_id)!,
        currentDirective(this.options.checkpointer, receipt.run_id)
      ).directive;
    }
    this.options.afterDecisionStored?.();
    return this.resume(receipt.run_id);
  }

  decide(input: { runId: string; decision: "approve" | "refine" | "deny" }): Directive {
    return this.submit(this.prepareDecision(input));
  }

  /** Reconcile a callback that committed before its process returned or resumed the run. */
  resume(runId: string): Directive {
    const record = this.options.checkpointer.contentReviewForRun(runId);
    if (record === undefined || record.decision_receipt === undefined) {
      throw new ContentReviewError(
        "content_review_not_pending",
        `run '${runId}' has no recorded content-review decision`
      );
    }
    if (["consumed", "refined", "denied"].includes(record.state) && record.transaction_id) {
      return this.completeRecordedOperation(
        record,
        currentDirective(this.options.checkpointer, runId)
      ).directive;
    }
    const transactionId = record.transaction_id ?? record.receipt_id;
    if (transactionId === undefined) {
      throw new ContentReviewError(
        "content_review_corrupt",
        `run '${runId}' has no durable decision transaction identity`
      );
    }
    // Once this exact transaction's candidate selector is authoritative, base
    // drift and expiry checks are no longer legal: recovery is finalize-only.
    const publication = this.options.checkpointer.kbPublication(transactionId);
    let selectorCommitted = false;
    if (
      record.decision_receipt.decision === "approve" &&
      publication?.run_id === runId &&
      publication.selector_jcs !== undefined &&
      publication.selector_sha256 !== undefined
    ) {
      const kbRoot = resolveGrantedProfile({
        profileId: record.packet.kb_profile_id,
        sessionId: record.packet.session_id,
        registryPath: path.join(this.options.projectRoot, ".penny", "kb-profiles.json"),
        grantStoreDir: path.join(this.options.projectRoot, ".penny", "kb-host-grants"),
      }).resolvedRoot;
      const selected = readCurrent(kbRoot);
      selectorCommitted =
        selected?.generation_id === publication.candidate_generation_id &&
        canonicalJson(selected) === publication.selector_jcs &&
        sha256Hex(canonicalJson(selected)) === publication.selector_sha256;
    }
    try {
      if (!selectorCommitted) {
        verifyLiveContentReviewBindings({
          projectRoot: this.options.projectRoot,
          packet: record.packet,
          checkpointer: this.options.checkpointer,
          now: this.now(),
        });
      }
    } catch (error) {
      if (error instanceof ContentReviewError) {
        this.options.engine.invalidateContentReviewedRun({
          runId,
          receiptSha256: record.decision_receipt_sha256!,
          reason: error.code,
          state: error.code === "content_review_expired" ? "expired" : "invalidated",
        });
      }
      throw error;
    }
    const directive = this.options.engine.resumeContentReviewedRun({
      runId,
      receiptSha256: record.decision_receipt_sha256!,
      transactionId,
    });
    const finalized = this.options.checkpointer.contentReviewForRun(runId);
    if (finalized === undefined) {
      throw new ContentReviewError(
        "content_review_corrupt",
        `run '${runId}' lost its content-review record during resume`
      );
    }
    return this.completeRecordedOperation(finalized, directive).directive;
  }

  /** Exact internal replay/receipt for host callback idempotency tests and UI reconciliation. */
  operation(runId: string): OperationCompletion | undefined {
    const record = this.options.checkpointer.contentReviewForRun(runId);
    if (record?.decision_receipt_sha256 === undefined) return undefined;
    const sourceIdentity = contentReviewOperationSourceIdentity({
      packet_sha256: record.packet_sha256,
      decision_receipt_sha256: record.decision_receipt_sha256,
    });
    return new OperationReceiptStore({
      projectRoot: this.options.projectRoot,
      checkpointer: this.options.checkpointer,
    }).committedBySource("content_review_decision", sourceIdentity);
  }

  private completeRecordedOperation(
    record: NonNullable<ReturnType<Checkpointer["contentReviewForRun"]>>,
    directive: Directive
  ): { directive: Directive; operation: OperationCompletion } {
    if (record.decision_receipt_sha256 === undefined) {
      throw new ContentReviewError(
        "content_review_corrupt",
        "content-review decision has no receipt digest for its operation group"
      );
    }
    const sourceIdentity = contentReviewOperationSourceIdentity({
      packet_sha256: record.packet_sha256,
      decision_receipt_sha256: record.decision_receipt_sha256,
    });
    const group = this.options.checkpointer.operationEventGroupBySource(
      "content_review_decision",
      sourceIdentity
    );
    if (group === undefined) {
      throw new ContentReviewError(
        "content_review_corrupt",
        "content-review decision has no reserved operation event group"
      );
    }
    const run = this.options.checkpointer.loadRunById(record.run_id);
    if (run === undefined) {
      throw new ContentReviewError("content_review_corrupt", "content-review run is absent");
    }
    const result = replayableResultFromRun({
      action: record.packet.action,
      run,
      checkpointer: this.options.checkpointer,
    });
    const candidateGenerationId = String(run.playbookData.published_generation_id ?? "");
    let selectorEvidence:
      | {
          transaction_id: string;
          candidate_generation_id: string;
          selector_sha256: string;
        }
      | undefined;
    if (result.status === "complete" && result.met && candidateGenerationId.length > 0) {
      if (record.transaction_id !== group.transaction_id) {
        throw new ContentReviewError(
          "content_review_corrupt",
          "published content review is not owned by its operation transaction"
        );
      }
      const kbRoot = resolveGrantedProfile({
        profileId: record.packet.kb_profile_id,
        sessionId: record.packet.session_id,
        registryPath: path.join(this.options.projectRoot, ".penny", "kb-profiles.json"),
        grantStoreDir: path.join(this.options.projectRoot, ".penny", "kb-host-grants"),
      }).resolvedRoot;
      const selected = readCurrent(kbRoot);
      let publication;
      try {
        publication = this.options.checkpointer.kbPublicationSelectorEvidence({
          transaction_id: group.transaction_id,
          run_id: run.identity.run_id,
          candidate_generation_id: candidateGenerationId,
        });
      } catch (error) {
        throw new ContentReviewError(
          "content_review_corrupt",
          `published run lacks same-transaction selector evidence: ${(error as Error).message}`
        );
      }
      if (
        selected?.generation_id !== candidateGenerationId ||
        sha256Hex(canonicalJson(selected)) !== publication.selector_sha256
      ) {
        throw new ContentReviewError(
          "content_review_corrupt",
          "published run lacks matching durable selector evidence"
        );
      }
      selectorEvidence = {
        transaction_id: group.transaction_id,
        candidate_generation_id: candidateGenerationId,
        selector_sha256: publication.selector_sha256!,
      };
    }
    const operation = new OperationReceiptStore({
      projectRoot: this.options.projectRoot,
      checkpointer: this.options.checkpointer,
    }).complete({
      request_event_group_id: group.request_event_group_id,
      kb_profile_id: record.packet.kb_profile_id,
      kb_id: record.packet.kb_id,
      result,
      input_digests: [record.packet_sha256, record.decision_receipt_sha256],
      output_refs: record.receipt_id === undefined ? [] : [record.receipt_id],
      base_generation_id: record.packet.base_generation_id,
      ...(candidateGenerationId.length > 0
        ? { candidate_generation_id: candidateGenerationId }
        : {}),
      policy_sha256: record.packet.policy_sha256,
      safe_metrics: result.counts,
      ...(selectorEvidence !== undefined ? { selector_evidence: selectorEvidence } : {}),
    });
    if (
      operation.replay_result.status !== "running" &&
      operation.replay_result.status !== "awaiting_user"
    ) {
      const terminal = this.options.checkpointer.terminalResult(record.run_id);
      const admission = this.options.checkpointer.getStartAdmission(record.run_id);
      if (terminal !== undefined && admission !== undefined) {
        this.options.checkpointer.settleStartAdmission(record.run_id, {
          terminal_result_id: terminal.terminal_result_id,
          terminal_result_sha256: terminal.result_sha256,
        });
      }
      settleRunInput({
        projectRoot: this.options.projectRoot,
        checkpointer: this.options.checkpointer,
        runId: record.run_id,
      });
    }
    return { directive, operation };
  }
}

function currentDirective(checkpointer: Checkpointer, runId: string): Directive {
  const run = checkpointer.loadRunById(runId);
  if (run === undefined) {
    throw new ContentReviewError("content_review_corrupt", `run '${runId}' is absent`);
  }
  const directive = run.terminalDirective ?? run.pendingDirective;
  if (directive === null) {
    throw new ContentReviewError(
      "content_review_corrupt",
      `run '${runId}' has no durable directive after content review`
    );
  }
  return directive;
}
