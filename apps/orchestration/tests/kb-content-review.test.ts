import { requireValue } from "./helpers/narrowing.js";
/**
 * G8 §5.1 authenticated content-review callback service.
 *
 * Focus: canonical control-DB packet/receipt custody, generic-response refusal,
 * exact-digest duplicate semantics, and restart after the callback transaction
 * commits but before internal deny resume.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { validateDirective } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import {
  ContentReviewError,
  ContentReviewService,
  authenticateLocalContentReviewer,
  conflictRecordForAllocation,
  packetDigest,
  packetJcs,
} from "../src/kb/content-review.js";
import { CapabilityStore } from "../src/kb/capabilities.js";
import { canonicalJson, sha256Hex } from "../src/kb/contracts.js";
import { readPolicy, writePolicy } from "../src/kb/filesystem.js";
import { mintSourceCapability } from "../src/kb/gate.js";
import { defaultKbIngestPlane } from "../src/kb/ingest-plane.js";
import { readSelectedGeneration } from "../src/kb/generations.js";
import { allocateComposeAuthority } from "../src/kb/composition-authority.js";
import { admitOperationStart } from "../src/kb/operation-starts.js";
import { RunArtifactStore } from "../src/kb/run-artifacts.js";
import { initKb } from "../src/kb/workflows.js";
import { installGrantedProfile } from "./fixtures/kb-profile-fixture.js";

const PROFILE = "kbp_callback";
const SESSION = "sess_callback";
const PARENT = { provider: "ollama", model: "qwen327b:latest" };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface CallbackFixture {
  projectRoot: string;
  kbRoot: string;
  dbPath: string;
  runId: string;
  capabilityId: string;
  sourceId: string;
  checkpointer: Checkpointer;
  engine: OrchestrationEngine;
}

function fixture(label: string): CallbackFixture {
  const projectRoot = mkdtempSync(path.join(tmpdir(), `penny-content-review-${label}-`));
  roots.push(projectRoot);
  const kbRoot = path.join(projectRoot, "private-kb");
  const runId = `run_${label}`;
  installGrantedProfile({ projectRoot, kbRoot, profileId: PROFILE, sessionId: SESSION });
  initKb({ kbRoot, profileId: PROFILE, runId: `init_${label}` }, "Callback KB");
  const policy = readPolicy(kbRoot);
  writePolicy(kbRoot, {
    ...policy,
    allowed_parent_models: [{ ...PARENT, locality: "local" }],
    allowed_child_models: [{ ...PARENT, locality: "local" }],
  });

  const sourceDir = path.join(projectRoot, "source");
  mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  const sourcePath = path.join(sourceDir, "source.md");
  writeFileSync(sourcePath, "Authenticated callbacks bind one sealed candidate set.", {
    mode: 0o600,
  });
  const capability = mintSourceCapability({
    projectRoot,
    kbProfileId: PROFILE,
    absolutePath: sourcePath,
    title: "Callback source",
    authors: ["Host Operator"],
    sourceType: "manual",
    mediaType: "text/markdown",
    sessionId: SESSION,
    allowedOperation: "ingest",
  });
  const dbPath = path.join(projectRoot, ".penny", "orchestration-v2.db");
  const checkpointer = new Checkpointer(dbPath);
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: SESSION,
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "hold one content-review callback packet",
    constraints: {
      action: "ingest",
      kb_profile_id: PROFILE,
      source_capability_ids: [capability.capability_id],
      parent_identity: PARENT,
    },
    projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 40,
  });
  const request = {
    schema_version: 1,
    action: "ingest",
    kb_profile_id: PROFILE,
    source_capability_ids: [capability.capability_id],
  };
  const admittedStart = admitOperationStart({
    projectRoot,
    checkpointer,
    context,
    session_id: SESSION,
    invocation_id: `call_${label}`,
    action: "ingest",
    profile_id: PROFILE,
    request,
  });
  const plane = defaultKbIngestPlane(checkpointer);
  const sourceIds = plane.claim({
    projectRoot,
    kbRoot,
    capabilityIds: [capability.capability_id],
    runId,
    sessionId: SESSION,
    profileId: PROFILE,
    operation: "ingest",
  });
  plane.admit({
    projectRoot,
    kbRoot,
    sourceIds,
    runId,
    sessionId: SESSION,
    profileId: PROFILE,
    operation: "ingest",
  });

  const artifacts = new RunArtifactStore(kbRoot, runId, checkpointer);
  const claims = artifacts.stage({
    state_id: "ingest",
    kb_profile_id: PROFILE,
    artifact_kind: "claims",
    content: JSON.stringify({
      schema_version: 1,
      artifact_kind: "claims",
      source_ids: [...sourceIds],
      claims: [],
    }),
  });
  artifacts.seal([claims.artifact_id]);
  const selectedBase = requireValue(
    readSelectedGeneration(kbRoot),
    "apps/orchestration/tests/kb-content-review.test.ts:161"
  );
  const currentPolicySha256 = sha256Hex(canonicalJson(readPolicy(kbRoot)));
  const authority = allocateComposeAuthority({
    runId,
    operation: "ingest",
    kbId: selectedBase.catalog.kb_id,
    baseGenerationId: selectedBase.selector.generation_id,
    baseCatalogSha256: selectedBase.selector.catalog_sha256,
    privateInputSha256: admittedStart.request_sha256,
    baseCatalog: selectedBase.catalog,
    candidates: [
      {
        candidate_ref: `cmp_${label}`,
        source_ids: sourceIds,
        claim_candidate_refs: [],
      },
    ],
  });
  Object.assign(context.knowledgeBaseData, {
    action: "ingest",
    profile_id: PROFILE,
    source_capability_ids: [capability.capability_id],
    source_ids: [...sourceIds],
    kb_id: selectedBase.catalog.kb_id,
    admitted_policy_sha256: currentPolicySha256,
  });
  checkpointer.saveRun(context, "content_review_fixture_allocating", { run_id: runId });
  artifacts.bindPhaseOperands({
    schema_version: 1,
    run_id: runId,
    state_id: "compose",
    session_id: SESSION,
    kb_profile_id: PROFILE,
    operation: "ingest",
    agent: "synthia",
    expected_artifact_kind: "page_draft",
    expected_media_type: "application/json",
    source_ids: [...sourceIds],
    prior_state_ids: ["ingest"],
    allowed_prior_artifacts: [{ run_id: runId, state_id: "ingest", handle: claims }],
    allowed_selected_pages: authority.selected_pages,
    private_input_sha256: admittedStart.request_sha256,
    admitted_policy_sha256: currentPolicySha256,
    compose_authority: authority,
  });
  const allocation = requireValue(
    authority.allocations[0],
    "apps/orchestration/tests/kb-content-review.test.ts:206"
  );
  const page = artifacts.stage({
    state_id: "compose",
    kb_profile_id: PROFILE,
    artifact_kind: "page_draft",
    content: JSON.stringify({
      schema_version: 1,
      artifact_kind: "page_draft",
      pages: [
        {
          frontmatter: {
            schema_version: 1,
            page_id: allocation.page_id,
            revision_id: allocation.revision_id,
            kind: "synthesis",
            title: "Authenticated callbacks",
            summary: "One exact callback receipt binds one packet.",
            authority: "advisory",
            lifecycle: allocation.lifecycle,
            created_at: "2026-08-20T00:00:00Z",
            derived_from: [...sourceIds],
            related_page_ids: [],
          },
          markdown:
            "## Synthesis\nThe host binds one exact packet.\n" +
            "## Evidence\n- One admitted source.\n" +
            "## Tensions and unknowns\n- None.\n" +
            "## Related\n- None.\n",
          claims: {
            schema_version: 1,
            page_id: allocation.page_id,
            revision_id: allocation.revision_id,
            claims: [],
          },
        },
      ],
    }),
  });
  artifacts.sealWithPhaseResult({
    state_id: "compose",
    kb_profile_id: PROFILE,
    result: {
      schema_version: 1,
      run_id: runId,
      state_id: "compose",
      agent: "synthia",
      result_kind: "page_composition",
      page_ids: [allocation.page_id],
      page_revision_artifact: page,
    },
    handles: [page],
  });
  const lint = artifacts.stage({
    state_id: "lint",
    kb_profile_id: PROFILE,
    artifact_kind: "lint_report",
    content: JSON.stringify({
      schema_version: 1,
      artifact_kind: "lint_report",
      findings: [],
      candidate_conflicts: [],
    }),
  });
  const verify = artifacts.stage({
    state_id: "verify",
    kb_profile_id: PROFILE,
    artifact_kind: "verification_report",
    content: JSON.stringify({
      schema_version: 1,
      artifact_kind: "verification_report",
      verified_artifact_ids: [page.artifact_id],
      claim_findings: [],
    }),
  });
  artifacts.seal([lint.artifact_id, verify.artifact_id]);
  artifacts.close();

  const challengeId = `review_${label}`;
  const packet = plane.prepareContentReview({
    projectRoot,
    kbRoot,
    runId,
    sessionId: SESSION,
    challengeId,
    profileId: PROFILE,
    action: "ingest",
    artifactIds: [page.artifact_id, lint.artifact_id, verify.artifact_id],
    sourceIds,
    capabilityIds: [capability.capability_id],
    policySha256: sha256Hex(canonicalJson(readPolicy(kbRoot))),
  });
  Object.assign(context.knowledgeBaseData, {
    action: "ingest",
    profile_id: PROFILE,
    source_capability_ids: [capability.capability_id],
    source_ids: [...sourceIds],
    kb_id: packet.kb_id,
    admitted_policy_sha256: packet.policy_sha256,
    content_review_challenge_id: challengeId,
    content_review_packet_jcs: packetJcs(packet),
    content_review_packet_sha256: packetDigest(packet),
    gate_id: challengeId,
    base_generation_id: packet.base_generation_id,
  });
  context.transition("awaiting_review");
  context.status = "awaiting_user";
  context.pendingDirective = validateDirective({
    schema_version: 2,
    action: "await_user",
    identity: context.identity,
    state_id: "awaiting_review",
    gate_id: challengeId,
    challenge: `secret_${label}`,
    payload_digest: packetDigest(packet),
    questions: [{ id: "content-review-1", prompt: "approve, refine, or deny" }],
  });

  checkpointer.saveRun(context, "content_review_fixture_waiting", { run_id: runId });
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot,
    maxSteps: 40,
    playbookName: "knowledge-base",
  });
  return {
    projectRoot,
    kbRoot,
    dbPath,
    runId,
    capabilityId: capability.capability_id,
    sourceId: requireValue(sourceIds[0], "apps/orchestration/tests/kb-content-review.test.ts:335"),
    checkpointer,
    engine,
  };
}

function host(input: CallbackFixture, afterDecisionStored?: () => void): ContentReviewService {
  return new ContentReviewService({
    projectRoot: input.projectRoot,
    checkpointer: input.checkpointer,
    engine: input.engine,
    reviewer: authenticateLocalContentReviewer(),
    ...(afterDecisionStored !== undefined ? { afterDecisionStored } : {}),
  });
}

describe("allocated conflict contract", () => {
  const allocation = {
    candidate_conflict_id: "cfl_boundary_01",
    conflict_record_id: "conf_boundary_01",
    conflict_record_sha256: "0".repeat(64),
  };
  const issuedAt = "2026-08-24T12:00:00Z";
  const claimRef = {
    page_id: "page_boundary_01",
    revision_id: "rev_boundary_01",
    claim_id: "clm_boundary_01",
  };

  it("normalizes loose candidate fields to exact validated conflict bytes", () => {
    const candidate = {
      candidate_conflict_id: allocation.candidate_conflict_id,
      claim_refs: [{ ...claimRef, ignored_ref_field: "not serialized" }],
      summary: "A bounded conflict summary.",
      evidence_refs: [
        { evidence_id: "evidence_boundary_01", ignored_evidence_field: "not serialized" },
      ],
      ignored_candidate_field: "not serialized",
    };

    const record = conflictRecordForAllocation({
      candidate,
      allocation,
      issuedAt,
      allowedClaimRefs: new Set([
        `${claimRef.page_id}\u0000${claimRef.revision_id}\u0000${claimRef.claim_id}`,
      ]),
    });

    expect(record).toEqual({
      schema_version: 1,
      conflict_record_id: allocation.conflict_record_id,
      claim_refs: [claimRef],
      state: "open",
      summary: candidate.summary,
      evidence_refs: ["evidence_boundary_01"],
      created_at: issuedAt,
    });
    expect(canonicalJson(record)).not.toContain("ignored_");
  });

  it("preserves the content-review error contract for malformed claim references", () => {
    let caught: unknown;
    try {
      conflictRecordForAllocation({
        candidate: {
          candidate_conflict_id: allocation.candidate_conflict_id,
          claim_refs: [{ ...claimRef, claim_id: 42 }],
          summary: "Malformed reference",
          evidence_refs: [],
        },
        allocation,
        issuedAt,
        allowedClaimRefs: new Set(),
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof ContentReviewError)) {
      throw new Error("malformed claim reference did not raise ContentReviewError");
    }
    expect(caught.code).toBe("content_review_corrupt");
    expect(caught.message).toBe("candidate conflict has a malformed claim ref");
  });
});

describe("authenticated content-review callback", () => {
  it("stores the canonical packet with the waiting run and constructs complete exact receipt metadata", () => {
    const input = fixture("metadata");
    const stored = requireValue(
      input.checkpointer.contentReviewForRun(input.runId),
      "apps/orchestration/tests/kb-content-review.test.ts:424"
    );
    expect(stored.state).toBe("awaiting");
    expect(stored.packet.action).toBe("ingest");
    expect(stored.packet.candidate_artifacts.map((artifact) => artifact.artifact_kind)).toEqual([
      "page_draft",
      "lint_report",
      "verification_report",
    ]);
    expect(stored.packet.candidate_artifact_digests).toEqual(
      Object.fromEntries(
        stored.packet.candidate_artifacts.map((artifact) => [artifact.artifact_id, artifact.sha256])
      )
    );
    expect(Object.keys(stored.packet.candidate_source_record_digests)).toEqual([input.sourceId]);
    expect(input.sourceId).not.toBe(input.capabilityId);

    const receipt = host(input).prepareDecision({ runId: input.runId, decision: "deny" });
    expect(receipt).toMatchObject({
      run_id: stored.packet.run_id,
      session_id: stored.packet.session_id,
      challenge_id: stored.packet.challenge_id,
      kb_profile_id: stored.packet.kb_profile_id,
      kb_id: stored.packet.kb_id,
      action: stored.packet.action,
      base_generation_id: stored.packet.base_generation_id,
      base_selector_sha256: stored.packet.base_selector_sha256,
      packet_sha256: stored.packet_sha256,
      policy_sha256: stored.packet.policy_sha256,
      expires_at: stored.packet.expires_at,
    });
    expect(receipt.candidate_artifact_digests).toEqual(stored.packet.candidate_artifact_digests);
    input.checkpointer.close();
  });

  it("blocks generic engine respond so model-visible requests remain decision-free", () => {
    const input = fixture("decision_free");
    const run = requireValue(
      input.checkpointer.loadRunById(input.runId),
      "apps/orchestration/tests/kb-content-review.test.ts:460"
    );
    const pending = requireValue(
      run.pendingDirective,
      "apps/orchestration/tests/kb-content-review.test.ts:461"
    );
    expect(pending.action).toBe("await_user");
    expect(() =>
      input.engine.handle({
        schema_version: 2,
        action: "respond",
        identity: run.identity,
        gate_id: pending.action === "await_user" ? pending.gate_id : "none",
        challenge: pending.action === "await_user" ? pending.challenge : "none",
        response: "deny",
      })
    ).toThrow(/authenticated host callback service/);
    input.checkpointer.close();
  });

  it("is idempotent only for the exact same receipt digest", () => {
    const input = fixture("duplicate");
    const service = host(input);
    const receipt = service.prepareDecision({ runId: input.runId, decision: "deny" });
    const first = service.submit(receipt);
    expect(first.action).toBe("incomplete");
    expect(input.checkpointer.contentReviewForRun(input.runId)?.state).toBe("denied");
    const firstOperation = requireValue(
      service.operation(input.runId),
      "apps/orchestration/tests/kb-content-review.test.ts:483"
    );
    expect(firstOperation.group).toMatchObject({
      source_kind: "content_review_decision",
      event_sequence: 1,
      state: "committed",
    });
    expect(firstOperation.receipt).toMatchObject({ event: "completed", state: "published" });

    const duplicate = service.submit(receipt);
    expect(duplicate.action).toBe("incomplete");
    const duplicateOperation = requireValue(
      service.operation(input.runId),
      "apps/orchestration/tests/kb-content-review.test.ts:493"
    );
    expect(duplicateOperation.receipt.receipt_id).toBe(firstOperation.receipt.receipt_id);
    expect(duplicateOperation.replay_result).toEqual(firstOperation.replay_result);
    expect(input.checkpointer.operationReceipts(input.runId)).toHaveLength(1);
    expect(() =>
      service.submit({
        ...receipt,
        receipt_id: `crr_${"a".repeat(32)}`,
      })
    ).toThrow(/different receipt digest/);
    input.checkpointer.close();
  });

  it("returns an exact duplicate approval after selector commit without republishing", () => {
    const input = fixture("duplicate_approve");
    const service = host(input);
    const receipt = service.prepareDecision({ runId: input.runId, decision: "approve" });
    const first = service.submit(receipt);
    expect(first.action).toBe("complete");
    const selectedAfterFirst = requireValue(
      readSelectedGeneration(input.kbRoot),
      "apps/orchestration/tests/kb-content-review.test.ts:512"
    ).selector.generation_id;
    expect(input.checkpointer.contentReviewForRun(input.runId)?.state).toBe("consumed");
    const operation = requireValue(
      service.operation(input.runId),
      "apps/orchestration/tests/kb-content-review.test.ts:514"
    );
    expect(operation.receipt).toMatchObject({
      event: "published",
      transaction_id: receipt.receipt_id,
    });
    expect(JSON.parse(operation.receipt.receipt_jcs)).toMatchObject({
      event: "published",
      candidate_generation_id: selectedAfterFirst,
      transaction_id: receipt.receipt_id,
    });
    const publication = requireValue(
      input.checkpointer.kbPublication(receipt.receipt_id),
      "apps/orchestration/tests/kb-content-review.test.ts:524"
    );
    expect(publication).toMatchObject({
      run_id: input.runId,
      candidate_generation_id: selectedAfterFirst,
      lifecycle: "complete",
    });
    expect(publication.files.every((file) => file.state === "published")).toBe(true);
    using capabilities = new CapabilityStore(input.projectRoot);
    expect(capabilities.lease(input.capabilityId)).toMatchObject({
      state: "consumed",
      run_id: input.runId,
      transaction_id: receipt.receipt_id,
    });
    const duplicate = service.submit(receipt);
    expect(duplicate.action).toBe("complete");
    expect(
      requireValue(
        readSelectedGeneration(input.kbRoot),
        "apps/orchestration/tests/kb-content-review.test.ts:539"
      ).selector.generation_id
    ).toBe(selectedAfterFirst);
    expect(input.checkpointer.contentReviewForRun(input.runId)?.state).toBe("consumed");
    input.checkpointer.close();
  });

  it("reconciles after a crash between decision commit and internal resume", () => {
    const input = fixture("crash");
    const receipt = host(input, () => {
      throw new Error("injected crash after decision transaction");
    }).prepareDecision({ runId: input.runId, decision: "deny" });
    expect(() =>
      host(input, () => {
        throw new Error("injected crash after decision transaction");
      }).submit(receipt)
    ).toThrow(/injected crash/);
    const decided = requireValue(
      input.checkpointer.contentReviewForRun(input.runId),
      "apps/orchestration/tests/kb-content-review.test.ts:554"
    );
    expect(decided.state).toBe("denied");
    expect(decided.transaction_id).toBeUndefined();
    expect(decided.decision_receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(input.checkpointer.loadRunById(input.runId)).toMatchObject({
      status: "running",
      playbookData: {
        review_decision: "deny",
        review_receipt_sha256: decided.decision_receipt_sha256,
      },
    });
    input.checkpointer.close();

    const reopened = new Checkpointer(input.dbPath);
    const engine = new OrchestrationEngine(reopened, {
      projectRoot: input.projectRoot,
      maxSteps: 40,
      playbookName: "knowledge-base",
    });
    const terminal = new ContentReviewService({
      projectRoot: input.projectRoot,
      checkpointer: reopened,
      engine,
      reviewer: authenticateLocalContentReviewer(),
    }).resume(input.runId);
    expect(terminal.action).toBe("incomplete");
    const reconciled = requireValue(
      reopened.contentReviewForRun(input.runId),
      "apps/orchestration/tests/kb-content-review.test.ts:580"
    );
    expect(reconciled.state).toBe("denied");
    expect(reconciled.transaction_id).toBe(receipt.receipt_id);
    expect(reopened.loadRunById(input.runId)?.status).toBe("incomplete");
    reopened.close();
  });

  it("reconciles the same transaction after a crash with the decision already claimed", () => {
    const input = fixture("claimed_crash");
    const service = host(input);
    const receipt = service.prepareDecision({ runId: input.runId, decision: "deny" });
    const receiptJcs = canonicalJson(receipt);
    const receiptSha256 = sha256Hex(receiptJcs);
    input.checkpointer.recordContentReviewDecision({ receipt, receiptJcs, receiptSha256 });
    input.checkpointer.claimContentReview({
      runId: input.runId,
      receiptSha256,
      transactionId: receipt.receipt_id,
    });
    input.checkpointer.close();

    const reopened = new Checkpointer(input.dbPath);
    const engine = new OrchestrationEngine(reopened, {
      projectRoot: input.projectRoot,
      maxSteps: 40,
      playbookName: "knowledge-base",
    });
    const terminal = new ContentReviewService({
      projectRoot: input.projectRoot,
      checkpointer: reopened,
      engine,
      reviewer: authenticateLocalContentReviewer(),
    }).resume(input.runId);
    expect(terminal.action).toBe("incomplete");
    expect(reopened.contentReviewForRun(input.runId)).toMatchObject({
      state: "denied",
      transaction_id: receipt.receipt_id,
    });
    reopened.close();
  });

  it("expires and invalidates before accepting a callback", () => {
    const input = fixture("expiry");
    const expiredHost = new ContentReviewService({
      projectRoot: input.projectRoot,
      checkpointer: input.checkpointer,
      engine: input.engine,
      reviewer: authenticateLocalContentReviewer(),
      now: () => new Date(Date.now() + 48 * 60 * 60 * 1_000),
    });
    expect(() => expiredHost.prepareDecision({ runId: input.runId, decision: "approve" })).toThrow(
      ContentReviewError
    );
    expect(input.checkpointer.contentReviewForRun(input.runId)?.state).toBe("expired");
    expect(input.checkpointer.loadRunById(input.runId)?.status).toBe("incomplete");
    input.checkpointer.close();
  });
});
