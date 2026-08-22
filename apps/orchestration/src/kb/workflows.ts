/**
 * KB workflows — §5.6 the eight public actions.
 *
 * This module implements the stateful workflows that tie together the G7 core
 * modules (contracts, profile-registry, capabilities, policy, filesystem,
 * generations, retrieval, lint) and the G8 artifact content plane (run-artifacts).
 *
 * Each action returns a `KbResult` — a safe, path-free projection. No raw body
 * ever appears in a result.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Checkpointer } from "../checkpointer.js";
import { PolicyRefusal, checkParentModelIdentity } from "./policy.js";
import type { JsonValue } from "../contracts.js";
import {
  canonicalJson,
  defaultDenyPolicy,
  sha256Hex,
  type KbAction,
  type KbManifest,
  type KbPolicy,
  type KnowledgeBaseResult,
  type RunStatus,
  type Sha256Hex,
} from "./contracts.js";
import { readManifest, readPolicy, readCurrent } from "./filesystem.js";
import {
  buildCatalog,
  generationIndexDigest,
  openStandalonePublicationCheckpointer,
  publishGenerationTransaction,
  readSelectedGeneration,
  standalonePublicationTransactionId,
} from "./generations.js";
import { lintDeterministic } from "./lint.js";
import { selectQueryCandidates } from "./query-reader.js";
import { RunArtifactStore } from "./run-artifacts.js";

// ── Result type (§5.6) ──────────────────────────────────────────────────────

export type KbStatus = RunStatus;
export type KbResult = KnowledgeBaseResult;

// ── Workflow context ────────────────────────────────────────────────────────

export interface KbWorkflowContext {
  readonly kbRoot: string;
  readonly profileId: string;
  readonly runId: string;
  /** Required by actions that create or read KB work-plane artifacts. */
  readonly checkpointer?: Checkpointer;
}

function artifactControl(ctx: KbWorkflowContext): Checkpointer {
  if (ctx.checkpointer === undefined) {
    throw new Error("KB artifact work requires the orchestration control DB");
  }
  return ctx.checkpointer;
}

function result(
  action: KbAction,
  runId: string,
  status: KbStatus,
  met: boolean,
  next: "resume" | "review" | "none",
  extra?: Partial<KbResult>
): KbResult {
  return {
    schema_version: 1,
    action,
    run_id: runId,
    status,
    met,
    ids: [],
    counts: {},
    artifacts: [],
    evidence: [],
    warnings: [],
    unresolved: [],
    next,
    ...extra,
  };
}

// ── init (§5.6) ─────────────────────────────────────────────────────────────

/**
 * Initialize a KB: validate the profile, create the manifest + default-deny
 * policy + layout, and publish the first empty generation.
 */
export function initKb(
  ctx: KbWorkflowContext,
  title: string,
  planned?: {
    kb_id: string;
    generation_id: string;
    created_at: string;
    transaction_id?: string;
    checkpointer?: Checkpointer;
    request_sha256?: Sha256Hex;
    profile_commitment_sha256?: Sha256Hex;
  }
): KbResult {
  const root = ctx.kbRoot;

  // Check if already initialized. A transaction with a durable base-none
  // reservation must always re-enter the same publisher, even after a remap or
  // a crash-after-link; an unrelated ordinary init only validates the selected
  // KB and creates no reservation/generation.
  const existing = readCurrent(root);
  const recoveringPublication =
    planned?.checkpointer !== undefined && planned.transaction_id !== undefined
      ? planned.checkpointer.kbPublication(planned.transaction_id)
      : undefined;
  const recoveringReservation =
    planned?.checkpointer !== undefined && planned.transaction_id !== undefined
      ? planned.checkpointer.kbInitReservationByTransaction(planned.transaction_id)
      : undefined;
  if (
    existing !== undefined &&
    recoveringPublication === undefined &&
    recoveringReservation === undefined
  ) {
    const existingManifest = readManifest(root);
    return result("init", ctx.runId, "complete", true, "none", {
      kb_id: existingManifest.kb_id,
      counts: { generations: 1 },
      warnings: ["KB already initialized; validated existing state"],
    });
  }
  if (
    recoveringReservation !== undefined &&
    (recoveringPublication === undefined || recoveringPublication.run_id !== ctx.runId)
  ) {
    throw new Error("base-none init reservation lost its exact publication transaction");
  }

  let ownedCheckpointer: Checkpointer | undefined;
  const transactionId =
    planned?.transaction_id ?? standalonePublicationTransactionId(ctx.runId, "init");
  const checkpointer =
    planned?.checkpointer ??
    (ownedCheckpointer = openStandalonePublicationCheckpointer({
      root,
      runId: ctx.runId,
      profileId: ctx.profileId,
      action: "init",
    }));
  const priorPublication = checkpointer.kbPublication(transactionId);
  const priorReservation = checkpointer.kbInitReservationByTransaction(transactionId);
  if (
    planned !== undefined &&
    priorReservation !== undefined &&
    (planned.kb_id !== priorReservation.kb_id ||
      planned.generation_id !== priorReservation.generation_id)
  ) {
    ownedCheckpointer?.close();
    throw new Error("base-none init KB/generation identity changed across recovery");
  }

  // Create the layout from the transaction's already-frozen identities on
  // recovery; no timestamp/id is silently regenerated.
  const kbId =
    priorReservation?.kb_id ??
    priorPublication?.kb_id ??
    planned?.kb_id ??
    `kb_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = priorPublication?.created_at ?? planned?.created_at ?? new Date().toISOString();

  const manifest: KbManifest = {
    schema_version: 1,
    kb_id: kbId,
    title,
    authority: "advisory",
    paths: {
      policy: ".kb/policy.json",
      source_records: "sources/records",
      source_objects: "sources/objects",
      pages: "pages",
      conflicts: "conflicts",
      work: "work",
      lock: ".kb/lock",
      generations: ".kb/generations",
      generation_catalog_filename: "catalog.json",
      generation_index_filename: "index.sqlite",
      current: ".kb/current.json",
      root_index: "index.md",
    },
    created_at: now,
  };
  const policy = defaultDenyPolicy(kbId);

  // Publish the first empty generation through the same transaction-owned path
  // for host actions and standalone workflow fixtures.
  const genId =
    priorReservation?.generation_id ??
    priorPublication?.candidate_generation_id ??
    planned?.generation_id ??
    `gen_${sha256Hex(transactionId).slice(0, 40)}`;
  const index_sha256 = generationIndexDigest(genId, kbId, []);
  const catalog = buildCatalog({
    generation_id: genId,
    kb_id: kbId,
    manifest,
    policy,
    pages: [],
    source_records: [],
    source_objects: [],
    conflicts: [],
    index_sha256,
    created_at: now,
  });
  const requestSha256 =
    planned?.request_sha256 ??
    priorReservation?.request_sha256 ??
    sha256Hex(
      canonicalJson({
        schema_version: 1,
        action: "init",
        kb_profile_id: ctx.profileId,
        create: true,
        title,
      })
    );
  const profileCommitmentSha256 =
    planned?.profile_commitment_sha256 ??
    priorReservation?.profile_commitment_sha256 ??
    sha256Hex(
      canonicalJson({
        schema_version: 1,
        kb_profile_id: ctx.profileId,
        kb_root: path.resolve(root),
        repository_admission: { mode: "standalone_fixture" },
      })
    );
  try {
    publishGenerationTransaction({
      root,
      checkpointer,
      run_id: ctx.runId,
      transaction_id: transactionId,
      kb_profile_id: ctx.profileId,
      action: "init",
      base_generation_id: null,
      base_selector_sha256: null,
      catalog,
      index_pages: [],
      immutable_files: [
        { role: "manifest", final_key: "manifest.json", bytes: canonicalJson(manifest) },
        { role: "policy", final_key: ".kb/policy.json", bytes: canonicalJson(policy) },
      ],
      published_at: now,
      init_reservation: {
        request_sha256: requestSha256,
        profile_commitment_sha256: profileCommitmentSha256,
      },
      await_operation_receipt: planned?.checkpointer !== undefined,
    });
  } finally {
    ownedCheckpointer?.close();
  }

  return result("init", ctx.runId, "complete", true, "none", {
    kb_id: kbId,
    counts: { generations: 1, pages: 0, sources: 0 },
  });
}

// ── query (§5.6) ────────────────────────────────────────────────────────────

/**
 * Query the selected generation: deterministic retrieval against the current
 * catalog, returning ranked candidates. The result is advisory and cited.
 *
 * No publication-plane change occurs. The query may produce a same-run answer
 * artifact under `work/<run_id>/`, but it never publishes a source, page, claim,
 * conflict, generation, or root index.
 */
export function queryKb(
  ctx: KbWorkflowContext,
  query: string,
  options?: {
    maxCandidates?: number;
    /** §5.6 `page_ids` — restrict retrieval to these pages of the selected generation. */
    pageIds?: readonly string[];
    /** §5.6 `source_ids` — restrict retrieval to pages citing at least one of these sources. */
    sourceIds?: readonly string[];
    /** Explicitly false on the deterministic path. No direct workflow call verifies grounding. */
    verifyGrounding?: boolean;
  }
): KbResult {
  const request = {
    schema_version: 1 as const,
    action: "query" as const,
    kb_profile_id: ctx.profileId,
    query,
    ...(options?.maxCandidates !== undefined ? { max_candidates: options.maxCandidates } : {}),
    ...(options?.pageIds !== undefined ? { page_ids: [...options.pageIds] } : {}),
    ...(options?.sourceIds !== undefined ? { source_ids: [...options.sourceIds] } : {}),
    verify_grounding: false,
  };
  const selection = selectQueryCandidates({ kbRoot: ctx.kbRoot, request });
  if (selection === undefined) {
    return result("query", ctx.runId, "refused", false, "none", {
      warnings: ["No KB is initialized at this profile"],
    });
  }

  const candidates = selection.candidates;
  using store = new RunArtifactStore(ctx.kbRoot, ctx.runId, artifactControl(ctx));
  const answerContent = JSON.stringify({
    schema_version: 1,
    artifact_kind: "query_answer",
    answer: {
      authority: "advisory" as const,
      text:
        candidates.length > 0
          ? `Found ${candidates.length} candidate(s) with supported claims.`
          : "No supported claim matched the request.",
      citations: candidates.slice(0, 5).flatMap((candidate) =>
        (selection.pages.get(candidate.page_id)?.supported_claims ?? [])
          .slice(0, 1)
          .map((claim) => ({
            kind: "claim" as const,
            page_id: candidate.page_id,
            revision_id: candidate.revision_id,
            claim_id: claim.claim_id,
          }))
      ),
      contradictions: [],
      unknowns: candidates.length === 0 ? ["No matching pages found"] : [],
      canonical_verification_required: true as const,
    },
  });
  const handle = store.stage({
    state_id: "query",
    kb_profile_id: ctx.profileId,
    artifact_kind: "query_answer",
    content: answerContent,
  });
  store.seal([handle.artifact_id]);

  return result("query", ctx.runId, "complete", candidates.length > 0, "none", {
    kb_id: selection.kbId,
    ids: candidates.map((candidate) => candidate.page_id),
    counts: { candidates: candidates.length },
    artifacts: [handle],
    warnings: [
      ...(candidates.length === 0 ? ["No supported matching claims found"] : []),
      // Deterministic retrieval is intentionally retained for an explicit
      // `verify_grounding:false` request, but it has no save or delivery
      // authority and must always name that fact.
      "grounding_not_verified",
    ],
    unresolved: [
      ...selection.unresolved,
      ...(candidates.length === 0 ? ["empty supported result set"] : []),
    ],
  });
}

// ── §5.3 run admission (deny before session) ─────────────────────────────

/**
 * Admit a run before it may read a private body or create a child session.
 *
 * §5.3 fixes the ORDER, and the order is the guarantee:
 *   profile grant → root/repository admission → manifest/policy metadata only
 *   → current parent tuple → every selected child tuple → only then private I/O.
 *
 * This function owns the middle of that chain: it reads and validates only the
 * policy, verifies the ACTIVE parent identity against the allowlist, and returns
 * the digest the run binds as `admitted_policy_sha256`. Child tuples are
 * verified later, at the one moment their identity actually exists — after the
 * runtime resolves the agent's alias and before the session is created.
 *
 * Callers must invoke this BEFORE claiming capabilities, admitting sources, or
 * dispatching any phase. It throws `PolicyRefusal` on denial.
 */
export function admitKbRun(input: {
  kbRoot: string;
  parentIdentity: { provider: string; model: string } | undefined;
}): { policy: KbPolicy; policy_sha256: string; kb_id: string } {
  const policy = readPolicy(input.kbRoot);
  if (input.parentIdentity === undefined) {
    throw new PolicyRefusal(
      "parent_model_denied",
      "the host could not establish the active parent identity — denied by default"
    );
  }
  checkParentModelIdentity(policy, input.parentIdentity);
  return {
    policy,
    policy_sha256: sha256Hex(canonicalJson(policy as unknown as JsonValue)),
    kb_id: policy.kb_id,
  };
}

/**
 * Recheck that the policy a run was admitted under is still exactly current.
 *
 * §5.3: every child creation, gate, publish step, status, and resume rechecks
 * exact equality; a mid-run change is `policy_changed` and needs a new run.
 */
export function recheckAdmittedPolicy(input: {
  kbRoot: string;
  admittedPolicySha256: string;
}): KbPolicy {
  const policy = readPolicy(input.kbRoot);
  const current = sha256Hex(canonicalJson(policy as unknown as JsonValue));
  if (current !== input.admittedPolicySha256) {
    throw new PolicyRefusal(
      "policy_changed",
      "the KB policy changed mid-run; this run is invalid and a new run is required"
    );
  }
  return policy;
}

// ── parent delivery support (§5.6) ───────────────────────────────────────────

/**
 * Read the sealed `query_answer` artifact for this run and return exactly its
 * `answer` sub-object (raw unknown; the caller validates it against the closed
 * §5.6 shape before anything is delivered). Returns `null` when the artifact
 * cannot be read — delivery then fails closed; it never falls back to content.
 */
export function readSealedAnswer(
  root: string,
  runId: string,
  handle: { artifact_id: string },
  checkpointer: Checkpointer
): unknown {
  using store = new RunArtifactStore(root, runId, checkpointer);
  try {
    const { content } = store.read(handle.artifact_id);
    const doc = JSON.parse(content) as { artifact_kind?: unknown; answer?: unknown };
    if (doc.artifact_kind !== "query_answer" || doc.answer === undefined) return null;
    return doc.answer;
  } catch {
    return null;
  }
}

/**
 * Read the one sealed same-run Vera report for an answer. The parent decision
 * re-validates the pair; this reader only refuses ambiguity, wrong lifecycle,
 * wrong kind, and unreadable bytes.
 */
export function readSealedQueryVerification(
  root: string,
  runId: string,
  answerHandle: { artifact_id: string },
  checkpointer: Checkpointer
): unknown {
  using store = new RunArtifactStore(root, runId, checkpointer);
  try {
    const answer = store.read(answerHandle.artifact_id);
    if (answer.handle.artifact_kind !== "query_answer") return null;
    const reports = store.listByState("verify", "sealed");
    if (reports.length !== 1 || reports[0]?.artifact_kind !== "verification_report") return null;
    return JSON.parse(store.read(reports[0].artifact_id).content) as unknown;
  } catch {
    return null;
  }
}

// ── lint (§5.6) ─────────────────────────────────────────────────────────────

/**
 * Run the deterministic lint floor. May produce a same-run lint-report artifact
 * containing candidate conflicts, but publishes nothing.
 */
export function lintKb(ctx: KbWorkflowContext): KbResult {
  const root = ctx.kbRoot;
  const findings = lintDeterministic(root);
  const blocking = findings.filter((f) => f.severity === "blocking");
  const warnings = findings.filter((f) => f.severity === "warning");

  if (blocking.length > 0) {
    return result("lint", ctx.runId, "refused", false, "none", {
      warnings: blocking.map((f) => f.summary),
      unresolved: blocking.map((f) => f.finding_id),
      counts: { blocking: blocking.length, warnings: warnings.length },
    });
  }

  // Produce a same-run lint-report artifact (work plane only). A process death
  // after staging but before the control checkpoint reuses the exact indexed
  // artifact on retry; it never creates a second report for the same run.
  using store = new RunArtifactStore(root, ctx.runId, artifactControl(ctx));
  const reportContent = canonicalJson({
    schema_version: 1,
    artifact_kind: "lint_report",
    findings: findings.map((f) => ({
      finding_id: f.finding_id,
      severity: f.severity,
      summary: f.summary,
      evidence: f.evidence,
    })),
    candidate_conflicts: [],
  });
  const existing = store.listByState("lint");
  if (existing.length > 1) {
    throw new Error("lint run has more than one indexed report artifact");
  }
  const prior = existing[0];
  const handle =
    prior === undefined
      ? store.stage({
          state_id: "lint",
          kb_profile_id: ctx.profileId,
          artifact_kind: "lint_report",
          content: reportContent,
        })
      : store.read(prior.artifact_id).content === reportContent
        ? prior
        : (() => {
            throw new Error("lint run report bytes changed across recovery");
          })();

  return result("lint", ctx.runId, "complete", true, "none", {
    counts: { findings: findings.length, warnings: warnings.length, blocking: 0 },
    artifacts: [handle],
    warnings: warnings.map((f) => f.summary),
  });
}

// ── status (§5.6) ────────────────────────────────────────────────────────────

/**
 * Return a safe projection of the KB state. Never reveals roots or bodies.
 */
export function statusKb(ctx: KbWorkflowContext): KbResult {
  const root = ctx.kbRoot;
  const selected = readSelectedGeneration(root);
  if (selected === undefined) {
    return result("status", ctx.runId, "complete", false, "none", {
      warnings: ["No KB is initialized"],
    });
  }

  const { catalog, selector } = selected;
  return result("status", ctx.runId, "complete", true, "none", {
    kb_id: catalog.kb_id,
    ids: [selector.generation_id],
    counts: {
      pages: Object.keys(catalog.pages).length,
      sources: Object.keys(catalog.source_records).length,
      conflicts: Object.keys(catalog.conflict_records).length,
    },
  });
}
