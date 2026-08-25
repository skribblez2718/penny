#!/usr/bin/env node
/**
 * penny-kb-gate — HOST-ONLY surface for KB capabilities and the
 * content-review gate.
 *
 * The model-facing `knowledge_base` tool CANNOT approve or deny; decisions
 * reach the KB only through the authenticated host service facade. This CLI
 * is one local-OS-authenticated caller of that facade; canonical packet and
 * complete receipt bytes live in the orchestration control DB.
 *
 * Commands:
 *   capability-mint    Mint a source_read capability envelope (operator action)
 *   capability-list    List capability leases for a profile
 *   gate-list          List content-review gates for a profile (safe projection)
 *   approve            Approve a pending gate (host decision; publishes)
 *   deny               Deny a pending gate (host decision; publishes nothing)
 *   refine             Request a refinement round (host decision; re-enters compose, re-gates)
 *   parent-grant-mint  Mint a single-use derived-answer grant (§5.1; operator action)
 *   parent-grant-list  List parent-delivery grants (safe projection; no bodies)
 *   promotion-list     Present stored promotion packets from the approval DB
 *   promotion-key-rotate  Create/activate one raw 32-byte signing key
 *   promotion-approve Record signed host approval (never a public tool action)
 *   promotion-refine  Close the challenge and resume planning with the same targets
 *   promotion-deny    Close the challenge and invalidate its target claims
 *   promotion-apply   Internally resume one signed receipt and journaled apply
 *
 * Conventions:
 *   --project-root  Defaults to cwd. Permanent KB roots come from the owner-only
 *                   profile registry; there is no project-local KB publication default.
 *   Grant authority Catalog-bound project kb/host-grants/grants.sqlite (WAL/FULL).
 *   Capability DB   Catalog-bound project kb/capabilities/capabilities.sqlite.
 *   No command prints any source or page body to stdout.
 */

import path from "node:path";

import { Checkpointer } from "./checkpointer.js";
import { OrchestrationEngine } from "./engine.js";
import { loadRuntimeConfig } from "./config.js";
import type { Directive, JsonValue } from "./contracts.js";
import { canonicalJson, sha256Hex } from "./kb/contracts.js";
import { envelopeDigest, CapabilityStore } from "./kb/capabilities.js";
import {
  ParentDeliveryGrantStore,
  mintParentDeliveryGrant,
  validateQueryRequest,
} from "./kb/parent-delivery.js";
import { hostGrantAuthorityDir, kbProfileRegistryPath } from "./kb/host-state.js";
import { KbSessionProfileGrantStore } from "./kb/profile-grants.js";
import { readPolicy } from "./kb/filesystem.js";
import { resolveRegisteredProfile } from "./kb/profile-registry.js";
import { resolveKbRoot } from "./kb/ingest-plane.js";
import { recheckAdmittedPolicy } from "./kb/workflows.js";
import {
  PromotionApprovalStore,
  type PromotionApplyOutcome,
  type PromotionDecisionOutcome,
} from "./kb/promotion.js";
import { mintSourceCapability } from "./kb/gate.js";
import { ContentReviewService, authenticateLocalContentReviewer } from "./kb/content-review.js";
import { promotionApplyOperationSourceIdentity } from "./kb/operation-receipts.js";

type ArgValue = string | boolean | readonly string[];
type SourceType = "file" | "url_snapshot" | "research_artifact" | "manual";
type SourceMediaType = "text/plain" | "text/markdown" | "application/json";

interface Args {
  readonly projectRoot: string;
  readonly profile: string;
  readonly [key: string]: ArgValue | undefined;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function stringListArg(args: Args, key: string): readonly string[] {
  const value = args[key];
  if (value === undefined) return [];
  if (!isStringArray(value)) throw new Error(`--${key} must be supplied as a repeatable value`);
  return value;
}

function sourceTypeArg(value: ArgValue | undefined): SourceType | undefined {
  if (value === undefined) return undefined;
  if (
    value === "file" ||
    value === "url_snapshot" ||
    value === "research_artifact" ||
    value === "manual"
  ) {
    return value;
  }
  throw new Error("--source-type is invalid");
}

function sourceMediaTypeArg(value: ArgValue | undefined): SourceMediaType | undefined {
  if (value === undefined) return undefined;
  if (value === "text/plain" || value === "text/markdown" || value === "application/json") {
    return value;
  }
  throw new Error("--media-type is invalid");
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

function parseArgs(argv: string[]): Args {
  const multi = new Set(["author", "grant-profile"]);
  const out: Record<string, ArgValue> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) throw new Error("unexpected end of argv");
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    if (multi.has(key)) {
      const current = out[key];
      if (current !== undefined && !isStringArray(current)) {
        throw new Error(`--${key} cannot mix flag and value forms`);
      }
      out[key] = [...(current ?? []), next];
    } else {
      out[key] = next;
    }
    i += 1;
  }
  return {
    ...out,
    projectRoot: String(out["project-root"] ?? process.cwd()),
    profile: String(out["profile"] ?? ""),
  };
}

function kbRootFor(args: Args): string {
  if (args.profile.length === 0) throw new Error("--profile is required");
  const projectRoot = path.resolve(args.projectRoot);
  return resolveRegisteredProfile({
    profileId: args.profile,
    registryPath: kbProfileRegistryPath(projectRoot),
  }).resolvedRoot;
}

function fail(message: string): never {
  process.stderr.write(`kb-gate: ${message}\n`);
  process.exit(1);
}

// ── capability-mint ─────────────────────────────────────────────────────────

function grantStoreDir(args: Args): string {
  return hostGrantAuthorityDir(args.projectRoot);
}

function cmdProfileGrantMint(args: Args): void {
  const sessionId = String(args["session"] ?? "");
  const grantedProfiles = stringListArg(args, "grant-profile");
  const profileIds =
    grantedProfiles.length > 0 ? grantedProfiles : args.profile.length > 0 ? [args.profile] : [];
  const ttlMinutes = Number(args["ttl-minutes"] ?? 60);
  if (sessionId.length === 0 || profileIds.length === 0) {
    fail("profile-grant-mint requires --session and --profile or --grant-profile");
  }
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 10080) {
    fail("--ttl-minutes must be an integer from 1 to 10080");
  }
  for (const profileId of profileIds) {
    resolveRegisteredProfile({
      profileId,
      registryPath: kbProfileRegistryPath(path.resolve(args.projectRoot)),
    });
  }
  const now = new Date();
  const store = new KbSessionProfileGrantStore(grantStoreDir(args));
  try {
    const grants = profileIds.map((profileId) =>
      store.mint({
        session_id: sessionId,
        kb_profile_id: profileId,
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
      })
    );
    process.stdout.write(JSON.stringify({ schema_version: 1, grants }, null, 2) + "\n");
  } finally {
    store.close();
  }
}

function cmdProfileGrantList(args: Args): void {
  const store = new KbSessionProfileGrantStore(grantStoreDir(args));
  try {
    const { grants, skipped_malformed } = store.list();
    process.stdout.write(
      JSON.stringify({ schema_version: 1, grants, skipped_malformed }, null, 2) + "\n"
    );
  } finally {
    store.close();
  }
}

function cmdProfileGrantState(args: Args, operation: "revoke" | "expire"): void {
  const grantId = String(args["grant"] ?? "");
  if (grantId.length === 0) fail(`profile-grant-${operation} requires --grant GRANT_ID`);
  const store = new KbSessionProfileGrantStore(grantStoreDir(args));
  try {
    const document = operation === "revoke" ? store.revoke(grantId) : store.expire(grantId);
    process.stdout.write(
      JSON.stringify(
        {
          schema_version: 1,
          grant_id: document.grant.grant_id,
          state: document.record.state,
          session_id: document.grant.session_id,
          kb_profile_id: document.grant.kb_profile_id,
          updated_at: document.record.updated_at,
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    store.close();
  }
}

function cmdParentGrantMint(args: Args): void {
  const sessionId = String(args["session"] ?? "");
  const invocationId = String(args["invocation"] ?? "");
  const requestJson = String(args["request"] ?? "");
  if (sessionId.length === 0 || invocationId.length === 0 || requestJson.length === 0) {
    fail("parent-grant-mint requires --session, --invocation, and --request '<json>'");
  }
  let rawRequest: unknown;
  try {
    rawRequest = JSON.parse(requestJson);
  } catch {
    fail("--request must be a JSON object (the exact QueryKbRequestV1 to run)");
    return;
  }
  const request = validateQueryRequest(rawRequest);
  if (request.kb_profile_id !== args.profile) {
    fail(
      `--profile is ${args.profile} but the request names ${request.kb_profile_id}; they must match`
    );
  }
  if (request.answer_delivery !== "parent_tool_result") {
    fail("a grant request must explicitly use answer_delivery: parent_tool_result");
  }
  const parentProvider = String(args["parent-provider"] ?? "");
  const parentModel = String(args["parent-model"] ?? "");
  const maxBytes = Number(args["max-bytes"] ?? 16384);
  const ttlMinutes = Number(args["ttl-minutes"] ?? 15);
  if (parentProvider.length === 0 || parentModel.length === 0) {
    fail("parent-grant-mint requires --parent-provider and --parent-model");
  }
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 32768 ||
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < 1 ||
    ttlMinutes > 10080
  ) {
    fail("--max-bytes must be an integer 1–32768 and --ttl-minutes an integer 1–10080");
  }
  const policy = readPolicy(kbRootFor(args));
  const now = new Date();
  const grant = mintParentDeliveryGrant({
    session_id: sessionId,
    invocation_id: invocationId,
    request,
    policy_sha256: sha256Hex(canonicalJson(policy)),
    parent_provider: parentProvider,
    parent_model: parentModel,
    max_utf8_bytes: maxBytes,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
  });
  const store = new ParentDeliveryGrantStore(grantStoreDir(args));
  try {
    store.mint(grant);
    process.stdout.write(
      JSON.stringify(
        {
          schema_version: 1,
          grant_id: grant.grant_id,
          kb_profile_id: grant.kb_profile_id,
          request_sha256: grant.request_sha256,
          policy_sha256: grant.policy_sha256,
          parent_provider: grant.parent_provider,
          parent_model: grant.parent_model,
          max_utf8_bytes: grant.max_utf8_bytes,
          issued_at: grant.issued_at,
          expires_at: grant.expires_at,
          note: "single-use; consumed atomically by the exact matching invocation and run.",
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    store.close();
  }
}

function cmdParentGrantList(args: Args): void {
  const store = new ParentDeliveryGrantStore(grantStoreDir(args));
  try {
    const { grants, skipped_malformed } = store.list();
    process.stdout.write(
      JSON.stringify({ schema_version: 1, grants, skipped_malformed }, null, 2) + "\n"
    );
  } finally {
    store.close();
  }
}

function cmdParentGrantState(args: Args, operation: "revoke" | "expire"): void {
  const grantId = String(args["grant"] ?? "");
  if (grantId.length === 0) fail(`parent-grant-${operation} requires --grant GRANT_ID`);
  const store = new ParentDeliveryGrantStore(grantStoreDir(args));
  try {
    const document = operation === "revoke" ? store.invalidate(grantId) : store.expire(grantId);
    process.stdout.write(
      JSON.stringify(
        {
          schema_version: 1,
          grant_id: document.grant.grant_id,
          state: document.record.state,
          run_id: document.record.run_id ?? null,
          updated_at: document.record.updated_at,
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    store.close();
  }
}

function cmdCapabilityMint(args: Args): void {
  void kbRootFor(args);
  const filePath = String(args["path"] ?? "");
  const title = String(args["title"] ?? "");
  const authors = stringListArg(args, "author");
  const sessionId = String(args["session"] ?? "");
  const operation = String(args["operation"] ?? "");
  if (
    filePath.length === 0 ||
    title.length === 0 ||
    authors.length === 0 ||
    sessionId.length === 0 ||
    operation !== "ingest"
  ) {
    fail(
      "capability-mint requires --path, --title, at least one --author, --session, and --operation ingest"
    );
  }
  const absolute = path.resolve(args.projectRoot, filePath);
  const sourceType = sourceTypeArg(args["source-type"]);
  const mediaType = sourceMediaTypeArg(args["media-type"]);

  const envelope = mintSourceCapability({
    projectRoot: path.resolve(args.projectRoot),
    kbProfileId: args.profile,
    absolutePath: absolute,
    sessionId,
    allowedOperation: "ingest",
    title,
    authors,
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(args["captured-at"] !== undefined ? { capturedAt: String(args["captured-at"]) } : {}),
    ...(args["expires-hours"] !== undefined ? { expiresHours: Number(args["expires-hours"]) } : {}),
  });

  process.stdout.write(
    JSON.stringify({
      schema_version: 1,
      capability_id: envelope.capability_id,
      envelope_sha256: envelopeDigest(envelope),
      expected_sha256: envelope.expected_sha256,
      expires_at: envelope.expires_at,
      note: "capability registered; reference it in knowledge_base ingest (source_capability_ids)",
    }) + "\n"
  );
}

// ── listings (safe projections; no bodies) ──────────────────────────────────

function cmdCapabilityList(args: Args): void {
  void kbRootFor(args);
  using store = new CapabilityStore(path.resolve(args.projectRoot));
  const out = store.list(args.profile).map(({ envelope, lease }) => ({
    capability_id: envelope.capability_id,
    kind: envelope.kind,
    lease,
  }));
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

function withContentReviewHost<T>(args: Args, operation: (host: ContentReviewService) => T): T {
  // Resolve the configured profile first; the control DB never supplies a root.
  void kbRootFor(args);
  const config = loadRuntimeConfig(args.projectRoot, process.env);
  const checkpointer = new Checkpointer(config.dbPath, undefined, {
    projectId: config.projectId,
  });
  try {
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: config.projectRoot,
      maxSteps: config.maxSteps,
      receiptKeyPath: config.receiptKeyPath,
      playbookName: "knowledge-base",
    });
    return operation(
      new ContentReviewService({
        projectRoot: config.projectRoot,
        checkpointer,
        engine,
        reviewer: authenticateLocalContentReviewer(),
      })
    );
  } finally {
    checkpointer.close();
  }
}

function cmdGateList(args: Args): void {
  const output = withContentReviewHost(args, (host) =>
    host.list(args.profile).map((record) => ({
      gate_id: record.challenge_id,
      run_id: record.run_id,
      action: record.packet.action,
      status: record.state,
      issued_at: record.packet.issued_at,
      expires_at: record.packet.expires_at,
      packet_sha256: record.packet_sha256,
      source_ids: Object.keys(record.packet.candidate_source_record_digests),
      query_run_id: record.packet.query_run_id ?? null,
      artifact_kinds: record.packet.candidate_artifacts.map((artifact) => artifact.artifact_kind),
      receipt_id: record.receipt_id ?? null,
      receipt_sha256: record.decision_receipt_sha256 ?? null,
    }))
  );
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

// ── operator decisions ──────────────────────────────────────────────────────

function cmdDecision(args: Args, decision: "approve" | "deny" | "refine"): void {
  const projected = withContentReviewHost(args, (host) => {
    const runArg = args["run"] !== undefined ? String(args["run"]) : undefined;
    const candidates = host
      .list(args.profile)
      .filter((record) => runArg === undefined || record.run_id === runArg);
    const selected =
      [...candidates].reverse().find((record) => record.state === "awaiting") ?? candidates.at(-1);
    if (selected === undefined) throw new Error("no content-review packet for this profile/run");

    // A command retry after a crash reconciles the already-stored exact receipt;
    // it does not synthesize a second callback. A contrary decision conflicts.
    let next: Directive;
    if (selected.decision_receipt !== undefined) {
      if (selected.decision_receipt.decision !== decision) {
        throw new Error(
          `content review already recorded '${selected.decision_receipt.decision}', not '${decision}'`
        );
      }
      next = host.resume(selected.run_id);
    } else {
      next = host.decide({ runId: selected.run_id, decision });
    }
    const final = host.list(args.profile).find((record) => record.run_id === selected.run_id);
    return terminalProjection(next, {
      run_id: selected.run_id,
      gate_id: selected.challenge_id,
      receipt_id: final?.receipt_id ?? null,
      receipt_sha256: final?.decision_receipt_sha256 ?? null,
    });
  });
  process.stdout.write(JSON.stringify(projected, null, 2) + "\n");
}

function cmdApprove(args: Args): void {
  cmdDecision(args, "approve");
}

function cmdDeny(args: Args): void {
  cmdDecision(args, "deny");
}

function cmdRefine(args: Args): void {
  cmdDecision(args, "refine");
}

// ── signed promotion approval/apply (host-only; never Pi tool actions) ───────

function withPromotionHost<T>(
  args: Args,
  operation: (input: {
    store: PromotionApprovalStore;
    engine: OrchestrationEngine;
    checkpointer: Checkpointer;
    kbRoot: string;
  }) => T
): T {
  const kbRoot = kbRootFor(args);
  const config = loadRuntimeConfig(args.projectRoot, process.env);
  const checkpointer = new Checkpointer(config.dbPath, undefined, {
    projectId: config.projectId,
  });
  const store = new PromotionApprovalStore({
    projectRoot: config.projectRoot,
    kbRoot,
    controlBindingForRun: (runId) => checkpointer.promotionApprovalBinding(runId),
    reserveApplyOperation: (input) => {
      checkpointer.reserveOperationEventGroup({
        run_id: input.runId,
        session_id: input.sessionId,
        transaction_id: input.transactionId,
        action: "promote",
        source_kind: "promotion_apply",
        source_identity_sha256: promotionApplyOperationSourceIdentity({
          approval_receipt_sha256: input.receiptSha256,
          transaction_id: input.transactionId,
        }),
      });
    },
  });
  try {
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: config.projectRoot,
      maxSteps: config.maxSteps,
      receiptKeyPath: config.receiptKeyPath,
      playbookName: "knowledge-base",
    });
    return operation({ store, engine, checkpointer, kbRoot });
  } finally {
    store.close();
    checkpointer.close();
  }
}

function selectPromotionGate(
  store: PromotionApprovalStore,
  profileId: string,
  runArg: string | undefined
) {
  const candidates = store
    .listGates(profileId)
    .filter((record) => runArg === undefined || record.run_id === runArg);
  const selected = candidates.at(-1);
  if (selected === undefined) throw new Error("no stored promotion packet for this profile/run");
  return selected;
}

function cmdPromotionKeyRotate(args: Args): void {
  const output = withPromotionHost(args, ({ store }) => {
    const keyId = store.rotateKey();
    return { schema_version: 1, key_id: keyId, state: "active" };
  });
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function cmdPromotionList(args: Args): void {
  const output = withPromotionHost(args, ({ store }) =>
    store.listGates(args.profile).map((record) => ({
      schema_version: 1,
      run_id: record.run_id,
      challenge_id: record.challenge_id,
      state: record.state,
      packet_sha256: record.packet_sha256,
      page_revisions: record.packet.page_revisions,
      target_presentations: record.packet.target_presentations,
      issued_at: record.packet.issued_at,
      expires_at: record.packet.expires_at,
      decision_or_receipt_id: record.decision_or_receipt_id ?? null,
    }))
  );
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function cmdPromotionDecision(args: Args, decision: "approve" | "refine" | "deny"): void {
  const output = withPromotionHost(args, ({ store, engine, checkpointer, kbRoot }) => {
    const runArg = args["run"] !== undefined ? String(args["run"]) : undefined;
    const gate = selectPromotionGate(store, args.profile, runArg);
    const resolved = resolveKbRoot(
      path.resolve(args.projectRoot),
      gate.packet.kb_profile_id,
      gate.packet.session_id
    );
    if (path.resolve(resolved) !== path.resolve(kbRoot)) {
      throw new Error("promotion profile/session resolved to a different KB root");
    }
    const run = checkpointer.loadRunById(gate.run_id);
    if (run === undefined) {
      store.invalidateOrphanedGate(gate.challenge_id);
      throw new Error("promotion packet is orphaned from its control run and was invalidated");
    }
    recheckAdmittedPolicy({
      kbRoot,
      admittedPolicySha256: String(run.knowledgeBaseData.admitted_policy_sha256 ?? ""),
    });
    let decided: PromotionDecisionOutcome;
    if (gate.decision_intent !== undefined) {
      if (gate.decision_intent.decision !== decision) {
        throw new Error(
          `promotion already recorded '${gate.decision_intent.decision}', not '${decision}'`
        );
      }
      decided = store.decide(gate.decision_intent);
    } else {
      const ttlMinutes = Number(args["ttl-minutes"] ?? 10);
      if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 60) {
        throw new Error("--ttl-minutes must be an integer from 1 to 60");
      }
      decided = store.decide(
        store.buildDecisionIntent({
          challengeId: gate.challenge_id,
          decision,
          reviewerSubjectId: authenticateLocalContentReviewer().subjectId,
          ...(decision === "approve" ? { ttlMs: ttlMinutes * 60_000 } : {}),
        })
      );
    }
    const intentSha = decided.gate.decision_intent_sha256;
    if (intentSha === undefined) throw new Error("promotion decision has no durable intent digest");
    const receiptSha256 = decided.receipt_sha256;
    if (decided.receipt !== undefined && receiptSha256 === undefined) {
      throw new Error("promotion decision receipt has no durable digest");
    }
    const next = engine.recordPromotionDecision({
      runId: decided.gate.run_id,
      challengeId: decided.gate.challenge_id,
      decision,
      intentSha256: intentSha,
      packetSha256: decided.gate.packet_sha256,
      ...(decided.receipt !== undefined
        ? {
            receiptId: decided.receipt.receipt_id,
            receiptSha256,
          }
        : {}),
    });
    return {
      schema_version: 1,
      run_id: decided.gate.run_id,
      challenge_id: decided.gate.challenge_id,
      decision,
      state: decided.gate.state,
      intent_sha256: intentSha,
      receipt_id: decided.receipt?.receipt_id ?? null,
      receipt_sha256: decided.receipt_sha256 ?? null,
      control_action: next.action,
    };
  });
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function reconcilePromotionApply(
  store: PromotionApprovalStore,
  runId: string
): PromotionApplyOutcome {
  return store.reconcileApprovedPromotion(runId);
}

function cmdPromotionApply(args: Args): void {
  const output = withPromotionHost(args, ({ store, engine }) => {
    const runId = String(args["run"] ?? "");
    if (runId.length === 0) throw new Error("promotion-apply requires --run RUN_ID");
    const outcome = reconcilePromotionApply(store, runId);
    const terminal = engine.finalizeApprovedPromotion({
      runId: outcome.run_id,
      status: outcome.status,
      receiptId: outcome.receipt_id,
      receiptSha256: outcome.receipt_sha256,
      transactionId: outcome.transaction_id,
      targetCount: outcome.target_count,
      postApplyVerified: outcome.post_apply_verified,
    });
    return {
      schema_version: 1,
      run_id: outcome.run_id,
      apply_status: outcome.status,
      post_apply_verified: outcome.post_apply_verified,
      target_count: outcome.target_count,
      control_action: terminal.action,
    };
  });
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

/** Safe terminal projection for stdout: status, generation id, counts — no bodies. */
function terminalProjection(
  terminal: Directive,
  fallback: Record<string, JsonValue>
): Record<string, JsonValue> {
  const isTerminal =
    terminal.action === "complete" ||
    terminal.action === "incomplete" ||
    terminal.action === "error" ||
    terminal.action === "cancelled";
  const result = isTerminal ? terminal.result : {};
  const publishedCounts = result["published_counts"];
  const counts = isJsonObject(publishedCounts) ? publishedCounts : {};
  const generationId = String(result["published_generation_id"] ?? "");
  return {
    schema_version: 1,
    gate_status: isTerminal ? terminal.status : terminal.action,
    published: terminal.action === "complete",
    published_generation_id: generationId.length > 0 ? generationId : null,
    counts,
    ...fallback,
  };
}

// ── main ────────────────────────────────────────────────────────────────────

function main(argv: string[]): void {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(
      [
        "Usage: penny-kb-gate <command> --profile <id> [--project-root PATH] [opts]",
        "",
        "Commands:",
        "  capability-mint --path FILE --title T --author A --session S --operation ingest [--author B] [--source-type manual] [--media-type text/plain] [--expires-hours 72] [--captured-at ISO]",
        "  capability-list",
        "  gate-list",
        "  approve [--run RUN_ID]",
        "  deny [--run RUN_ID]",
        "  refine [--run RUN_ID]",
        "  profile-grant-mint --session S (--profile P | --grant-profile P ...) [--ttl-minutes 60]",
        "  profile-grant-list",
        "  profile-grant-revoke --grant GRANT_ID",
        "  profile-grant-expire --grant GRANT_ID",
        "  parent-grant-mint --profile P --session S --invocation I --parent-provider P --parent-model M --request '<json>' [--max-bytes 16384] [--ttl-minutes 15]",
        "  parent-grant-list",
        "  parent-grant-revoke --grant GRANT_ID",
        "  parent-grant-expire --grant GRANT_ID",
        "  promotion-list --profile P",
        "  promotion-key-rotate --profile P",
        "  promotion-approve --profile P [--run RUN_ID] [--ttl-minutes 10]",
        "  promotion-refine --profile P [--run RUN_ID]",
        "  promotion-deny --profile P [--run RUN_ID]",
        "  promotion-apply --profile P --run RUN_ID",
        "",
      ].join("\n")
    );
    return;
  }
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  try {
    switch (cmd) {
      case "capability-mint":
        cmdCapabilityMint(args);
        break;
      case "capability-list":
        cmdCapabilityList(args);
        break;
      case "gate-list":
        cmdGateList(args);
        break;
      case "approve":
        cmdApprove(args);
        break;
      case "deny":
        cmdDeny(args);
        break;
      case "refine":
        cmdRefine(args);
        break;
      case "profile-grant-mint":
        cmdProfileGrantMint(args);
        break;
      case "profile-grant-list":
        cmdProfileGrantList(args);
        break;
      case "profile-grant-revoke":
        cmdProfileGrantState(args, "revoke");
        break;
      case "profile-grant-expire":
        cmdProfileGrantState(args, "expire");
        break;
      case "parent-grant-mint":
        cmdParentGrantMint(args);
        break;
      case "parent-grant-list":
        cmdParentGrantList(args);
        break;
      case "parent-grant-revoke":
        cmdParentGrantState(args, "revoke");
        break;
      case "parent-grant-expire":
        cmdParentGrantState(args, "expire");
        break;
      case "promotion-list":
        cmdPromotionList(args);
        break;
      case "promotion-key-rotate":
        cmdPromotionKeyRotate(args);
        break;
      case "promotion-approve":
        cmdPromotionDecision(args, "approve");
        break;
      case "promotion-refine":
        cmdPromotionDecision(args, "refine");
        break;
      case "promotion-deny":
        cmdPromotionDecision(args, "deny");
        break;
      case "promotion-apply":
        cmdPromotionApply(args);
        break;
      default:
        fail(`unknown command: ${cmd}`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

main(process.argv.slice(2));
