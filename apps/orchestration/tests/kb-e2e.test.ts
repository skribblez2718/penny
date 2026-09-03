import { requireValue } from "./helpers/narrowing.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { validateDirective } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { jcsCanonicalize } from "../src/kb/approval-receipts.js";
import { CapabilityStore, mintEnvelope } from "../src/kb/capabilities.js";
import {
  KbActionSchema,
  canonicalJson,
  sha256Hex,
  validateKbContract,
} from "../src/kb/contracts.js";
import { readManifest, readPolicy, writePageRevision } from "../src/kb/filesystem.js";
import {
  buildCatalog,
  buildGenerationIndex,
  newGenerationId,
  publishGeneration,
  readSelectedGeneration,
} from "../src/kb/generations.js";
import { verifyPromotionCandidate } from "../src/kb/promote.js";
import { promotionApplyOperationSourceIdentity } from "../src/kb/operation-receipts.js";
import { PromotionApprovalStore, PromotionSimulatedCrash } from "../src/kb/promotion.js";
import { RunArtifactStore } from "../src/kb/run-artifacts.js";
import { initKb } from "../src/kb/workflows.js";
import { installTestProjectState } from "./fixtures/penny-state-fixture.js";

const PROFILE = "kbp_e2e_promotion";
const SESSION = "sess_e2e_promotion";
const RUN = "run_e2e_promotion";
const PAGE = { page_id: "page_e2e", revision_id: "rev_e2e_1" };
const PATCH_SENTINEL = ["RAW", "PATCH", "SENTINEL", "G9_E2E", randomBytes(12).toString("hex")].join(
  "_"
);
const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPatchAbsent(label: string, value: Buffer | string | unknown): void {
  const text = Buffer.isBuffer(value)
    ? value.toString("latin1")
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
  if (text.includes(PATCH_SENTINEL)) throw new Error(`raw patch sentinel escaped into ${label}`);
}

function selectedSyntheticPage(kbRoot: string): void {
  const manifest = readManifest(kbRoot);
  const policy = readPolicy(kbRoot);
  const selected = requireValue(
    readSelectedGeneration(kbRoot),
    "apps/orchestration/tests/kb-e2e.test.ts:70"
  );
  const markdown =
    "## Synthesis\nSynthetic E2E guidance.\n\n" +
    "## Evidence\n- Synthetic only.\n\n" +
    "## Tensions and unknowns\n- None.\n\n" +
    "## Related\n- None.\n";
  const frontmatter = {
    schema_version: 1 as const,
    ...PAGE,
    kind: "synthesis" as const,
    title: "Synthetic E2E promotion",
    summary: "Synthetic E2E guidance.",
    authority: "advisory" as const,
    lifecycle: "validated" as const,
    created_at: new Date().toISOString(),
    derived_from: [],
    related_page_ids: [],
  };
  writePageRevision(kbRoot, frontmatter, markdown, {
    schema_version: 1,
    ...PAGE,
    claims: [],
  });
  const revisionRoot = path.join(kbRoot, "pages", PAGE.page_id, "revisions", PAGE.revision_id);
  const pageBytes = readFileSync(path.join(revisionRoot, "page.md"), "utf8");
  const claimsBytes = readFileSync(path.join(revisionRoot, "claims.json"), "utf8");
  const generationId = newGenerationId();
  const { index_sha256 } = buildGenerationIndex(kbRoot, generationId, manifest.kb_id, [
    {
      ...PAGE,
      title: frontmatter.title,
      summary: frontmatter.summary,
      body_sha256: sha256Hex(markdown),
      body: markdown,
    },
  ]);
  publishGeneration(
    kbRoot,
    buildCatalog({
      generation_id: generationId,
      parent_generation_id: selected.selector.generation_id,
      kb_id: manifest.kb_id,
      manifest,
      policy,
      pages: [
        {
          ...PAGE,
          page_sha256: sha256Hex(pageBytes),
          claims_sha256: sha256Hex(claimsBytes),
        },
      ],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256,
    })
  );
}

describe("G9 approved apply end to end", () => {
  it("uses only the signed internal resume, finalizes all stores, and leaks no patch body to control", () => {
    const projectRoot = tempRoot("penny-kb-g9-e2e");
    const projectState = installTestProjectState(projectRoot);
    const kbRoot = path.join(projectRoot, "private-kb");
    initKb({ kbRoot, profileId: PROFILE, runId: "run_init" }, "G9 E2E");
    selectedSyntheticPage(kbRoot);

    const controlPath = path.join(projectRoot, "g9-control.db");
    const checkpointer = new Checkpointer(controlPath);
    const controlCheckpointer: Checkpointer | undefined = checkpointer;
    const context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: RUN,
        session_id: SESSION,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "Apply one synthetic signed promotion through the host-only continuation.",
      constraints: { action: "promote", kb_profile_id: PROFILE },
      projectRoot,
      trustProfile: "hardened-untrusted",
      maxSteps: 20,
    });
    checkpointer.createRun(context, "promotion_preparing", { run_id: RUN });

    const targetRoot = path.join(projectRoot, "synthetic-canonical");
    mkdirSync(targetRoot, { mode: 0o700 });
    const targetPath = path.join(targetRoot, "GUIDANCE.md");
    const preimage = Buffer.from("# Synthetic canonical\n\nOriginal.\n", "utf8");
    const replacement = `# Synthetic canonical\n\n${PATCH_SENTINEL}\n`;
    writeFileSync(targetPath, preimage, { mode: 0o600 });
    const envelope = mintEnvelope({
      kind: "canonical_target",
      session_id: SESSION,
      kb_profile_id: PROFILE,
      resolved_path: targetPath,
      authority_root: targetRoot,
      expected_sha256: sha256Hex(preimage.toString("utf8")),
      allowed_operation: "promote",
      issued_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const capabilities = new CapabilityStore(projectRoot);
    capabilities.register(envelope);
    capabilities.claimAll([envelope], {
      runId: RUN,
      transactionId: RUN,
      sessionId: SESSION,
      profileId: PROFILE,
      kind: "canonical_target",
      operation: "promote",
    });
    capabilities.close();

    const verification = verifyPromotionCandidate({
      projectRoot,
      kbRoot,
      runId: RUN,
      sessionId: SESSION,
      profileId: PROFILE,
      operation: "promote",
      pageRevisions: [PAGE],
      targetCapabilityIds: [envelope.capability_id],
    });
    expect(verification.verified).toBe(true);
    const artifacts = new RunArtifactStore(kbRoot, RUN, checkpointer);
    const plan = artifacts.stage({
      state_id: "plan",
      kb_profile_id: PROFILE,
      artifact_kind: "promotion_plan",
      content: jcsCanonicalize({
        schema_version: 1,
        artifact_kind: "promotion_plan",
        page_revisions: [PAGE],
        target_capability_ids: [envelope.capability_id],
        verification_report_artifact_ids: [],
        changes: [
          {
            target_capability_id: envelope.capability_id,
            summary: "Apply synthetic reviewed guidance.",
          },
        ],
      }),
    });
    const patch = artifacts.stage({
      state_id: "patch",
      kb_profile_id: PROFILE,
      artifact_kind: "promotion_patch",
      content: jcsCanonicalize({
        schema_version: 1,
        artifact_kind: "promotion_patch",
        targets: [
          {
            target_capability_id: envelope.capability_id,
            preimage_sha256: hash(preimage),
            postimage_sha256: hash(replacement),
            replacement_utf8: replacement,
          },
        ],
      }),
    });
    const verificationHandle = artifacts.stage({
      state_id: "promotion_verification",
      kb_profile_id: PROFILE,
      artifact_kind: "verification_report",
      content: jcsCanonicalize(verification),
    });
    artifacts.seal([plan.artifact_id, patch.artifact_id, verificationHandle.artifact_id]);
    artifacts.close();

    // Approval DB first: the complete private packet exists before any waiting
    // run/generic gate is inserted in the orchestration control store.
    let applyCrashed = false;
    const approval = new PromotionApprovalStore({
      projectRoot,
      kbRoot,
      artifactCheckpointer: checkpointer,
      controlBindingForRun: (runId) => controlCheckpointer?.promotionApprovalBinding(runId),
      reserveApplyOperation: (input) => {
        if (controlCheckpointer === undefined) {
          throw new Error("control checkpointer is absent at apply reservation");
        }
        controlCheckpointer.reserveOperationEventGroup({
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
      fault: (boundary) => {
        if (!applyCrashed && boundary === "after_capability_finalization") {
          applyCrashed = true;
          throw new PromotionSimulatedCrash(boundary);
        }
      },
    });
    approval.rotateKey();
    const challenge = "challenge_e2e_promotion";
    const gate = approval.storePreparedGate({
      runId: RUN,
      sessionId: SESSION,
      challengeId: challenge,
      profileId: PROFILE,
      pageRevisions: [PAGE],
      targetCapabilityIds: [envelope.capability_id],
      planArtifactId: plan.artifact_id,
      patchArtifactId: patch.artifact_id,
      verificationArtifactId: verificationHandle.artifact_id,
    });

    context.stateId = "awaiting_review";
    context.status = "awaiting_user";
    Object.assign(context.knowledgeBaseData, {
      action: "promote",
      profile_id: PROFILE,
      kb_id: readManifest(kbRoot).kb_id,
      admitted_policy_sha256: sha256Hex(canonicalJson(readPolicy(kbRoot))),
      promotion_challenge_id: challenge,
      promotion_packet_sha256: gate.packet_sha256,
      review_artifact_ids: [plan.artifact_id, patch.artifact_id, verificationHandle.artifact_id],
      gate_id: challenge,
    });
    context.pendingDirective = validateDirective({
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: "awaiting_review",
      gate_id: challenge,
      challenge,
      payload_digest: gate.packet_sha256,
      questions: [
        {
          id: "promotion-review",
          prompt: "Use the authenticated host promotion review surface.",
        },
      ],
    });
    checkpointer.saveRun(context, "promotion_waiting", {
      run_id: RUN,
      gate_id: challenge,
      packet_sha256: gate.packet_sha256,
    });
    const engine = new OrchestrationEngine(checkpointer, {
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      projectRoot,
      maxSteps: 20,
      playbookName: "knowledge-base",
    });

    // There is no public approve/apply action, and even generic gate respond is blocked.
    expect(() => validateKbContract(KbActionSchema, "approve", "KB action")).toThrow();
    expect(() => validateKbContract(KbActionSchema, "apply", "KB action")).toThrow();
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "respond",
        identity: context.identity,
        gate_id: challenge,
        challenge,
        response: "approve",
      })
    ).toThrow(/host-only/);
    expect(readFileSync(targetPath)).toEqual(preimage);

    const decision = approval.decide(
      approval.buildDecisionIntent({
        challengeId: challenge,
        decision: "approve",
        reviewerSubjectId: "reviewer_e2e",
      })
    );
    const decidedControl = engine.recordPromotionDecision({
      runId: RUN,
      challengeId: challenge,
      decision: "approve",
      intentSha256: requireValue(
        decision.gate.decision_intent_sha256,
        "apps/orchestration/tests/kb-e2e.test.ts:350"
      ),
      packetSha256: decision.gate.packet_sha256,
      receiptId: requireValue(decision.receipt, "apps/orchestration/tests/kb-e2e.test.ts:352")
        .receipt_id,
      receiptSha256: requireValue(
        decision.receipt_sha256,
        "apps/orchestration/tests/kb-e2e.test.ts:353"
      ),
    });
    const duplicateDecision = engine.recordPromotionDecision({
      runId: RUN,
      challengeId: challenge,
      decision: "approve",
      intentSha256: requireValue(
        decision.gate.decision_intent_sha256,
        "apps/orchestration/tests/kb-e2e.test.ts:359"
      ),
      packetSha256: decision.gate.packet_sha256,
      receiptId: requireValue(decision.receipt, "apps/orchestration/tests/kb-e2e.test.ts:361")
        .receipt_id,
      receiptSha256: requireValue(
        decision.receipt_sha256,
        "apps/orchestration/tests/kb-e2e.test.ts:362"
      ),
    });
    expect(duplicateDecision.action).toBe(decidedControl.action);
    expect(checkpointer.operationEventGroups(RUN)).toMatchObject([
      {
        event_sequence: 0,
        source_kind: "promotion_decision",
        state: "committed",
      },
    ]);
    expect(checkpointer.operationReceipts(RUN)).toMatchObject([
      { event: "prepared", state: "published" },
    ]);
    expect(() =>
      approval.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-e2e.test.ts:375")
      )
    ).toThrow(PromotionSimulatedCrash);
    expect(checkpointer.loadRunById(RUN)?.terminalDirective).toBeNull();
    const apply = approval.reconcileApprovedPromotion(RUN);

    // Approval DB + capability finalization survived the injected crash while
    // the control store remained nonterminal. Restart is finalize-only.
    checkpointer.close();
    const reopenedCheckpointer = new Checkpointer(controlPath);
    const reopenedEngine = new OrchestrationEngine(reopenedCheckpointer, {
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      projectRoot,
      maxSteps: 20,
      playbookName: "knowledge-base",
    });
    const terminal = reopenedEngine.finalizeApprovedPromotion({
      runId: RUN,
      status: apply.status,
      receiptId: apply.receipt_id,
      receiptSha256: apply.receipt_sha256,
      transactionId: apply.transaction_id,
      targetCount: apply.target_count,
      postApplyVerified: apply.post_apply_verified,
    });
    expect(terminal.action).toBe("complete");
    expect(reopenedCheckpointer.completionAdmission(RUN)).toMatchObject({
      origin_state: "awaiting_review",
      evidence_refs: [
        {
          kind: "promotion_approval",
          reference_id: apply.receipt_id,
          sha256: apply.receipt_sha256,
        },
      ],
    });
    const duplicateApply = reopenedEngine.finalizeApprovedPromotion({
      runId: RUN,
      status: apply.status,
      receiptId: apply.receipt_id,
      receiptSha256: apply.receipt_sha256,
      transactionId: apply.transaction_id,
      targetCount: apply.target_count,
      postApplyVerified: apply.post_apply_verified,
    });
    expect(duplicateApply).toEqual(terminal);
    expect(readFileSync(targetPath, "utf8")).toBe(replacement);
    expect(approval.receipt(apply.receipt_id)?.state).toBe("consumed");
    expect(approval.journal(apply.transaction_id)).toMatchObject({
      state: "complete",
      post_apply_verified: true,
    });
    const finalCapabilities = new CapabilityStore(projectRoot);
    expect(finalCapabilities.lease(envelope.capability_id)).toMatchObject({
      state: "consumed",
      transaction_id: apply.transaction_id,
    });
    finalCapabilities.close();
    expect(reopenedCheckpointer.loadRunById(RUN)?.terminalDirective?.action).toBe("complete");
    expect(reopenedCheckpointer.operationEventGroups(RUN)).toMatchObject([
      { event_sequence: 0, source_kind: "promotion_decision", state: "committed" },
      { event_sequence: 1, source_kind: "promotion_apply", state: "committed" },
    ]);
    expect(reopenedCheckpointer.operationReceipts(RUN)).toMatchObject([
      { event: "prepared", state: "published" },
      { event: "completed", state: "published" },
    ]);

    const approvalDatabase = path.join(
      projectState.paths.knowledgeBase.approval,
      "receipts.sqlite"
    );
    for (const suffix of ["", "-wal", "-shm"]) {
      const controlFile = `${controlPath}${suffix}`;
      if (existsSync(controlFile)) {
        assertPatchAbsent(
          `orchestration database ${path.basename(controlFile)}`,
          readFileSync(controlFile)
        );
      }
      const approvalFile = `${approvalDatabase}${suffix}`;
      if (existsSync(approvalFile)) {
        assertPatchAbsent(
          `approval database ${path.basename(approvalFile)}`,
          readFileSync(approvalFile)
        );
      }
    }
    assertPatchAbsent(
      "durable orchestration snapshot",
      reopenedCheckpointer.loadRunById(RUN)?.snapshot()
    );
    assertPatchAbsent("terminal parent result", terminal);

    approval.close();
    reopenedCheckpointer.close();
    assertPatchAbsent("closed orchestration database", readFileSync(controlPath));
    assertPatchAbsent("closed approval database", readFileSync(approvalDatabase));
    const publicProjection = JSON.stringify(terminal);
    expect(publicProjection).not.toContain(targetPath);

    const source = [
      readFileSync(path.resolve("src/kb/promotion.ts"), "utf8"),
      readFileSync(path.resolve("src/kb/approval-receipts.ts"), "utf8"),
    ].join("\n");
    expect(source).not.toMatch(
      /node:child_process|\bexecSync\b|\bspawnSync\b|git\s+(?:commit|push)/
    );
  });
});
