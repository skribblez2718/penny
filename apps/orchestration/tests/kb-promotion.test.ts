import { requireValue } from "./helpers/narrowing.js";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Checkpointer } from "../src/checkpointer.js";
import {
  jcsCanonicalize,
  parsePromotionReceipt,
  readRawPromotionKeyFile,
  receiptJcs,
  signPromotionReceipt,
  strictParseJson,
} from "../src/kb/approval-receipts.js";
import { CapabilityStore, mintEnvelope } from "../src/kb/capabilities.js";
import {
  PromotionApplyJournalSchema,
  PromotionApprovalStoreEnvelopeV1Schema,
  PromotionApprovalStoreRecordV1Schema,
  PromotionControlApprovalBindingV1Schema,
  PromotionGatePacketSchema,
  PromotionGateStoreEnvelopeV1Schema,
  PromotionGateStoreRecordV1Schema,
  validateKbContract,
  sha256Hex,
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
import {
  PromotionApprovalStore,
  PromotionSimulatedCrash,
  approvalRootFor,
  type PromotionControlApprovalBinding,
} from "../src/kb/promotion.js";
import { RunArtifactStore } from "../src/kb/run-artifacts.js";
import { closeKbArtifactControls, kbArtifactControl } from "./fixtures/kb-artifact-control.js";
import { installTestProjectState } from "./fixtures/penny-state-fixture.js";
import { initKb } from "../src/kb/workflows.js";

const PROFILE = "kbp_promotion";
const SESSION = "sess_promotion";
const RUN = "run_promotion";
const PAGE = { page_id: "page_promotion", revision_id: "rev_promotion_1" };
const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  closeKbArtifactControls();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Fixture {
  projectRoot: string;
  kbRoot: string;
  targetPaths: string[];
  targetIds: string[];
  original: Buffer[];
  artifactCheckpointer: Checkpointer;
  store: PromotionApprovalStore;
  gateChallenge: string;
  controlBindingForRun: (runId: string) => PromotionControlApprovalBinding | undefined;
  setControlBinding: (binding: PromotionControlApprovalBinding) => void;
}

function fixture(targetCount = 1, fault?: (boundary: string) => void): Fixture {
  const projectRoot = tempRoot("penny-promotion");
  installTestProjectState(projectRoot);
  const kbRoot = path.join(projectRoot, "private-kb");
  initKb({ kbRoot, profileId: PROFILE, runId: "run_init" }, "Promotion test KB");

  const manifest = readManifest(kbRoot);
  const policy = readPolicy(kbRoot);
  const selected = requireValue(
    readSelectedGeneration(kbRoot),
    "apps/orchestration/tests/kb-promotion.test.ts:102"
  );
  const markdown =
    "## Synthesis\nSynthetic promotion guidance.\n\n" +
    "## Evidence\n- Synthetic evidence.\n\n" +
    "## Tensions and unknowns\n- None.\n\n" +
    "## Related\n- None.\n";
  const frontmatter = {
    schema_version: 1 as const,
    page_id: PAGE.page_id,
    revision_id: PAGE.revision_id,
    kind: "synthesis" as const,
    title: "Synthetic promotion",
    summary: "Synthetic promotion guidance.",
    authority: "advisory" as const,
    lifecycle: "validated" as const,
    created_at: new Date().toISOString(),
    derived_from: [],
    related_page_ids: [],
  };
  const claims = {
    schema_version: 1 as const,
    page_id: PAGE.page_id,
    revision_id: PAGE.revision_id,
    claims: [],
  };
  writePageRevision(kbRoot, frontmatter, markdown, claims);
  const pagePath = path.join(kbRoot, "pages", PAGE.page_id, "revisions", PAGE.revision_id);
  const pageBytes = readFileSync(path.join(pagePath, "page.md"));
  const claimsBytes = readFileSync(path.join(pagePath, "claims.json"));
  const generationId = newGenerationId();
  const index = buildGenerationIndex(kbRoot, generationId, manifest.kb_id, [
    {
      page_id: PAGE.page_id,
      revision_id: PAGE.revision_id,
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
          page_id: PAGE.page_id,
          revision_id: PAGE.revision_id,
          page_sha256: sha256Hex(pageBytes.toString("utf8")),
          claims_sha256: sha256Hex(claimsBytes.toString("utf8")),
        },
      ],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: index.index_sha256,
    })
  );

  const targetRoot = path.join(projectRoot, "canonical");
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const targets: Array<{
    id: string;
    path: string;
    original: Buffer;
    envelope: ReturnType<typeof mintEnvelope>;
  }> = [];
  for (let index = 0; index < targetCount; index += 1) {
    const targetPath = path.join(targetRoot, `TARGET-${index}.md`);
    const original = Buffer.from(`# Canonical ${index}\n\nOriginal synthetic guidance.\n`, "utf8");
    writeFileSync(targetPath, original, { mode: 0o600 });
    const envelope = mintEnvelope({
      kind: "canonical_target",
      session_id: SESSION,
      kb_profile_id: PROFILE,
      resolved_path: targetPath,
      authority_root: targetRoot,
      expected_sha256: sha256Hex(original.toString("utf8")),
      allowed_operation: "promote",
      issued_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    targets.push({ id: envelope.capability_id, path: targetPath, original, envelope });
  }
  targets.sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
  const capabilities = new CapabilityStore(projectRoot);
  try {
    for (const target of targets) {
      capabilities.register(target.envelope);
    }
    capabilities.claimAll(
      targets.map((target) => target.envelope),
      {
        runId: RUN,
        transactionId: RUN,
        sessionId: SESSION,
        profileId: PROFILE,
        kind: "canonical_target",
        operation: "promote",
      }
    );
  } finally {
    capabilities.close();
  }

  const verification = verifyPromotionCandidate({
    projectRoot,
    kbRoot,
    runId: RUN,
    sessionId: SESSION,
    profileId: PROFILE,
    operation: "promote",
    pageRevisions: [PAGE],
    targetCapabilityIds: targets.map((target) => target.id),
  });
  expect(verification.verified).toBe(true);
  const checkpointer = kbArtifactControl({
    root: projectRoot,
    runId: RUN,
    profileId: PROFILE,
    action: "promote",
    sessionId: SESSION,
  });
  const artifactStore = new RunArtifactStore(kbRoot, RUN, checkpointer);
  const replacements = targets.map(
    (target, index) => `${target.original.toString("utf8").trimEnd()}\nApplied ${index}.\n`
  );
  const plan = {
    schema_version: 1,
    artifact_kind: "promotion_plan",
    page_revisions: [PAGE],
    target_capability_ids: targets.map((target) => target.id),
    verification_report_artifact_ids: [],
    changes: targets.map((target) => ({
      target_capability_id: target.id,
      summary: "Apply the reviewed synthetic guidance.",
    })),
  };
  const patch = {
    schema_version: 1,
    artifact_kind: "promotion_patch",
    targets: targets.map((target, index) => ({
      target_capability_id: target.id,
      preimage_sha256: hash(target.original),
      postimage_sha256: hash(
        Buffer.from(
          requireValue(replacements[index], "apps/orchestration/tests/kb-promotion.test.ts:250"),
          "utf8"
        )
      ),
      replacement_utf8: requireValue(
        replacements[index],
        "apps/orchestration/tests/kb-promotion.test.ts:251"
      ),
    })),
  };
  const planHandle = artifactStore.stage({
    state_id: "plan",
    kb_profile_id: PROFILE,
    artifact_kind: "promotion_plan",
    content: jcsCanonicalize(plan),
  });
  const patchHandle = artifactStore.stage({
    state_id: "patch",
    kb_profile_id: PROFILE,
    artifact_kind: "promotion_patch",
    content: jcsCanonicalize(patch),
  });
  const verificationHandle = artifactStore.stage({
    state_id: "promotion_verification",
    kb_profile_id: PROFILE,
    artifact_kind: "verification_report",
    content: jcsCanonicalize(verification),
  });
  artifactStore.seal([
    planHandle.artifact_id,
    patchHandle.artifact_id,
    verificationHandle.artifact_id,
  ]);
  artifactStore.close();

  let controlBinding: PromotionControlApprovalBinding | undefined;
  const controlBindingForRun = (runId: string) =>
    controlBinding?.run_id === runId ? controlBinding : undefined;
  const store = new PromotionApprovalStore({
    projectRoot,
    kbRoot,
    artifactCheckpointer: checkpointer,
    ...(fault ? { fault } : {}),
    controlBindingForRun,
  });
  const challenge = "challenge_promotion_1";
  store.storePreparedGate({
    runId: RUN,
    sessionId: SESSION,
    challengeId: challenge,
    profileId: PROFILE,
    pageRevisions: [PAGE],
    targetCapabilityIds: targets.map((target) => target.id),
    planArtifactId: planHandle.artifact_id,
    patchArtifactId: patchHandle.artifact_id,
    verificationArtifactId: verificationHandle.artifact_id,
  });
  return {
    projectRoot,
    kbRoot,
    targetPaths: targets.map((target) => target.path),
    targetIds: targets.map((target) => target.id),
    original: targets.map((target) => target.original),
    artifactCheckpointer: checkpointer,
    store,
    gateChallenge: challenge,
    controlBindingForRun,
    setControlBinding(binding) {
      controlBinding = binding;
    },
  };
}

function approve(input: Fixture) {
  if (input.store.keyStates().length === 0) input.store.rotateKey();
  const outcome = input.store.decide(
    input.store.buildDecisionIntent({
      challengeId: input.gateChallenge,
      decision: "approve",
      reviewerSubjectId: "reviewer_synthetic",
    })
  );
  input.setControlBinding({
    run_id: outcome.gate.run_id,
    challenge_id: outcome.gate.challenge_id,
    packet_sha256: outcome.gate.packet_sha256,
    decision: "approve",
    decision_intent_sha256: requireValue(
      outcome.gate.decision_intent_sha256,
      "apps/orchestration/tests/kb-promotion.test.ts:331"
    ),
    receipt_id: requireValue(outcome.receipt, "apps/orchestration/tests/kb-promotion.test.ts:332")
      .receipt_id,
    receipt_sha256: requireValue(
      outcome.receipt_sha256,
      "apps/orchestration/tests/kb-promotion.test.ts:333"
    ),
  });
  return outcome;
}

describe("G9 signed host-only promotion", () => {
  it("stores the approval packet first, signs exact JCS, applies once, and rotates keys", () => {
    const input = fixture(2);
    try {
      const gate = requireValue(
        input.store.gate(input.gateChallenge),
        "apps/orchestration/tests/kb-promotion.test.ts:342"
      );
      expect(gate.state).toBe("awaiting");
      expect(gate.packet.target_capability_ids).toEqual(input.targetIds);
      expect(gate.packet.target_presentations.map((target) => target.canonical_target)).toEqual(
        input.targetPaths
      );
      expect(gate.packet_jcs).toBe(jcsCanonicalize(gate.packet));
      expect(statSync(approvalRootFor(input.projectRoot)).mode & 0o777).toBe(0o700);
      expect(
        statSync(path.join(approvalRootFor(input.projectRoot), "receipts.sqlite")).mode & 0o777
      ).toBe(0o600);
      expect(
        statSync(path.join(approvalRootFor(input.projectRoot), "promotion-apply.mutex")).mode &
          0o777
      ).toBe(0o600);

      const firstKey = input.store.rotateKey();
      const decision = approve(input);
      expect(decision.gate.state).toBe("approved");
      expect(decision.receipt?.key_id).toBe(firstKey);
      expect(decision.receipt?.signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decision.receipt?.signature).not.toContain("=");
      expect(
        receiptJcs(
          requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:364")
        )
      ).toBe(decision.receipt_jcs);
      const secondKey = input.store.rotateKey();
      expect(input.store.keyStates()).toEqual([
        { key_id: firstKey, state: "verification_only" },
        { key_id: secondKey, state: "active" },
      ]);
      expect(statSync(path.join(approvalRootFor(input.projectRoot), `${firstKey}.key`)).size).toBe(
        32
      );
      expect(
        statSync(path.join(approvalRootFor(input.projectRoot), `${firstKey}.key`)).mode & 0o777
      ).toBe(0o600);

      const outcome = input.store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:377")
      );
      expect(outcome).toMatchObject({
        status: "complete",
        post_apply_verified: true,
        target_count: 2,
      });
      for (const targetPath of input.targetPaths) {
        expect(readFileSync(targetPath, "utf8")).toContain("Applied");
      }
      for (const targetId of input.targetIds) {
        const capabilities = new CapabilityStore(input.projectRoot);
        try {
          expect(capabilities.lease(targetId)).toMatchObject({
            state: "consumed",
            transaction_id: outcome.transaction_id,
          });
        } finally {
          capabilities.close();
        }
      }
      expect(input.store.journal(outcome.transaction_id)).toMatchObject({
        state: "complete",
        post_apply_verified: true,
        targets: [{ state: "verified" }, { state: "verified" }],
      });
      expect(() =>
        input.store.resumeApprovedPromotion(
          requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:402")
        )
      ).toThrow(/not available|consumed/);
    } finally {
      input.store.close();
    }
  });

  it("validates exact closed packet/store/journal projections and keeps preimage_mode", () => {
    const input = fixture();
    try {
      const gate = requireValue(
        input.store.gate(input.gateChallenge),
        "apps/orchestration/tests/kb-promotion.test.ts:413"
      );
      const { packet, ...gateRecord } = gate;
      expect(() =>
        validateKbContract(
          PromotionGateStoreRecordV1Schema,
          gateRecord,
          "test promotion gate record"
        )
      ).not.toThrow();
      expect(() =>
        validateKbContract(PromotionGateStoreEnvelopeV1Schema, gate, "test promotion gate envelope")
      ).not.toThrow();
      expect(() =>
        validateKbContract(
          PromotionGateStoreRecordV1Schema,
          { ...gateRecord, packet },
          "test promotion gate record with private packet"
        )
      ).toThrow();
      expect(() =>
        validateKbContract(
          PromotionGatePacketSchema,
          { ...packet, verification_evidence: [] },
          "test empty promotion evidence"
        )
      ).toThrow();

      const decision = approve(input);
      const storedReceipt = requireValue(
        input.store.receipt(
          requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:441")
            .receipt_id
        ),
        "apps/orchestration/tests/kb-promotion.test.ts:441"
      );
      const {
        challenge_id: _challengeId,
        receipt_jcs: _receiptJcs,
        signed_jcs: _signedJcs,
        receipt: _receipt,
        ...receiptRecord
      } = storedReceipt;
      expect(() =>
        validateKbContract(
          PromotionApprovalStoreRecordV1Schema,
          receiptRecord,
          "test approval store record"
        )
      ).not.toThrow();
      expect(() =>
        validateKbContract(
          PromotionApprovalStoreEnvelopeV1Schema,
          storedReceipt,
          "test approval store envelope"
        )
      ).not.toThrow();

      const outcome = input.store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:464")
      );
      const journal = requireValue(
        input.store.journal(outcome.transaction_id),
        "apps/orchestration/tests/kb-promotion.test.ts:465"
      );
      expect(() =>
        validateKbContract(PromotionApplyJournalSchema, journal, "test apply journal")
      ).not.toThrow();
      expect(
        requireValue(journal.targets[0], "apps/orchestration/tests/kb-promotion.test.ts:469")
          .preimage_mode
      ).toBe(0o600);
      expect(() =>
        validateKbContract(
          PromotionApplyJournalSchema,
          {
            ...journal,
            targets: journal.targets.map(({ preimage_mode: _mode, ...target }) => target),
          },
          "test journal without ratified preimage_mode"
        )
      ).toThrow();
    } finally {
      input.store.close();
    }
  });

  it("admits additional bound verification evidence but never an empty evidence set", () => {
    const input = fixture();
    try {
      const stored = requireValue(
        input.store.gate(input.gateChallenge),
        "apps/orchestration/tests/kb-promotion.test.ts:488"
      );
      const verificationEvidence = [
        ...stored.packet.verification_evidence,
        {
          evidence_id: "promotion_test_evidence",
          kind: "test" as const,
          ref: "promotion_test_evidence",
          sha256: "d".repeat(64),
        },
      ];
      const packet = validateKbContract(
        PromotionGatePacketSchema,
        {
          ...stored.packet,
          verification_evidence: verificationEvidence,
          verification_evidence_digest: hash(jcsCanonicalize(verificationEvidence)),
        },
        "test multi-evidence promotion packet"
      );
      const packetJcs = jcsCanonicalize(packet);
      const sqlite = process.getBuiltinModule("node:sqlite");
      const db = new sqlite.DatabaseSync(
        path.join(approvalRootFor(input.projectRoot), "receipts.sqlite")
      );
      try {
        db.prepare(
          "UPDATE promotion_gates SET packet_jcs = ?, packet_sha256 = ? WHERE challenge_id = ?"
        ).run(packetJcs, hash(packetJcs), input.gateChallenge);
      } finally {
        db.close();
      }

      const decision = approve(input);
      expect(
        input.store.resumeApprovedPromotion(
          requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:521")
        )
      ).toMatchObject({
        status: "complete",
        post_apply_verified: true,
      });
    } finally {
      input.store.close();
    }
  });

  it("keeps canonical targets and private packet/receipt bodies out of control projection", () => {
    const input = fixture();
    try {
      approve(input);
      const binding = requireValue(
        input.controlBindingForRun(RUN),
        "apps/orchestration/tests/kb-promotion.test.ts:534"
      );
      expect(() =>
        validateKbContract(
          PromotionControlApprovalBindingV1Schema,
          binding,
          "test promotion control binding"
        )
      ).not.toThrow();
      expect(JSON.stringify(binding)).not.toContain(
        requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:542")
      );
      expect(JSON.stringify(binding)).not.toContain("packet_jcs");
      expect(JSON.stringify(binding)).not.toContain("receipt_jcs");
      expect(() =>
        validateKbContract(
          PromotionControlApprovalBindingV1Schema,
          { ...binding, canonical_target: input.targetPaths[0] },
          "test path-bearing promotion control binding"
        )
      ).toThrow();
    } finally {
      input.store.close();
    }
  });

  it("rejects duplicate/unknown fields, padding, bad MACs, and unsafe keys", () => {
    const input = fixture();
    try {
      const decision = approve(input);
      const receipt = requireValue(
        decision.receipt,
        "apps/orchestration/tests/kb-promotion.test.ts:561"
      );
      const raw = requireValue(
        decision.receipt_jcs,
        "apps/orchestration/tests/kb-promotion.test.ts:562"
      );
      expect(() =>
        strictParseJson(
          raw
            .replace('{"approver_subject_id"', '{"nonce":"x","approver_subject_id"')
            .replace('"nonce":"x"', '"nonce":"x","nonce":"y"')
        )
      ).toThrow(/duplicate/);
      expect(() => parsePromotionReceipt(raw.replace(/}$/, ',"extra":true}'))).toThrow();
      expect(() =>
        input.store.parseAndVerifyReceipt(raw.replace(receipt.signature, `${receipt.signature}=`))
      ).toThrow();
      const replacement = `${receipt.signature.startsWith("A") ? "B" : "A"}${receipt.signature.slice(1)}`;
      expect(() =>
        input.store.parseAndVerifyReceipt(raw.replace(receipt.signature, replacement))
      ).toThrow(/HMAC/);

      expect(() =>
        readRawPromotionKeyFile(approvalRootFor(input.projectRoot), "../../traversal")
      ).toThrow(/key_id/);
      const keyPath = path.join(approvalRootFor(input.projectRoot), `${receipt.key_id}.key`);
      chmodSync(keyPath, 0o640);
      expect(() => input.store.parseAndVerifyReceipt(raw)).toThrow(/0600/);
      chmodSync(keyPath, 0o600);
      writeFileSync(keyPath, Buffer.alloc(31), { mode: 0o600 });
      expect(() => input.store.parseAndVerifyReceipt(raw)).toThrow(/32 raw bytes/);
      rmSync(keyPath);
      const decoyKey = path.join(input.projectRoot, "decoy-promotion.key");
      writeFileSync(decoyKey, Buffer.alloc(32), { mode: 0o600 });
      symlinkSync(decoyKey, keyPath);
      expect(() => input.store.parseAndVerifyReceipt(raw)).toThrow(/regular|symlink/);
    } finally {
      input.store.close();
    }
  });

  it("fails closed on broadened approval custody and a symlinked receipt store", () => {
    const broadened = fixture();
    broadened.store.close();
    const approvalRoot = approvalRootFor(broadened.projectRoot);
    chmodSync(approvalRoot, 0o750);
    expect(
      () =>
        new PromotionApprovalStore({
          projectRoot: broadened.projectRoot,
          kbRoot: broadened.kbRoot,
        })
    ).toThrow(/0700/);
    chmodSync(approvalRoot, 0o700);

    const database = path.join(approvalRoot, "receipts.sqlite");
    for (const suffix of ["-wal", "-shm", ""]) rmSync(`${database}${suffix}`, { force: true });
    const decoy = path.join(broadened.projectRoot, "decoy.sqlite");
    writeFileSync(decoy, "not a receipt database", { mode: 0o600 });
    symlinkSync(decoy, database);
    expect(
      () =>
        new PromotionApprovalStore({
          projectRoot: broadened.projectRoot,
          kbRoot: broadened.kbRoot,
        })
    ).toThrow(/non-symlink/);
  });

  it("rejects symlinked or broadened approval ancestors and detects live DB/mutex drift", () => {
    const symlinkProject = tempRoot("penny-approval-ancestor");
    const symlinkState = installTestProjectState(symlinkProject);
    const decoyApproval = tempRoot("penny-approval-decoy");
    rmSync(symlinkState.paths.knowledgeBase.approval, { recursive: true, force: true });
    symlinkSync(decoyApproval, symlinkState.paths.knowledgeBase.approval);
    expect(
      () =>
        new PromotionApprovalStore({
          projectRoot: symlinkProject,
          kbRoot: path.join(symlinkProject, "private-kb"),
        })
    ).toThrow(/symlink|directory component|non-symlink/);

    const ancestor = fixture();
    ancestor.store.close();
    const kbStateRoot = path.dirname(approvalRootFor(ancestor.projectRoot));
    chmodSync(kbStateRoot, 0o750);
    expect(
      () =>
        new PromotionApprovalStore({
          projectRoot: ancestor.projectRoot,
          kbRoot: ancestor.kbRoot,
        })
    ).toThrow(/0700/);
    chmodSync(kbStateRoot, 0o700);

    const live = fixture();
    const approvalRoot = approvalRootFor(live.projectRoot);
    chmodSync(path.join(approvalRoot, "promotion-apply.mutex"), 0o640);
    expect(() => live.store.keyStates()).toThrow(/mutex mode.*0600/);
    chmodSync(path.join(approvalRoot, "promotion-apply.mutex"), 0o600);
    chmodSync(path.join(approvalRoot, "receipts.sqlite"), 0o640);
    expect(() => live.store.listGates()).toThrow(/database mode.*0600/);
    chmodSync(path.join(approvalRoot, "receipts.sqlite"), 0o600);
    const mutexPath = path.join(approvalRoot, "promotion-apply.mutex");
    rmSync(mutexPath);
    const decoyMutex = path.join(live.projectRoot, "decoy-promotion.mutex");
    writeFileSync(decoyMutex, "", { mode: 0o600 });
    symlinkSync(decoyMutex, mutexPath);
    expect(() => live.store.keyStates()).toThrow(/regular|symlink/);
    live.store.close();
  });

  it("rejects valid-HMAC receipts with any changed authority binding or key id", () => {
    const input = fixture(2);
    try {
      const decision = approve(input);
      const receipt = requireValue(
        decision.receipt,
        "apps/orchestration/tests/kb-promotion.test.ts:674"
      );
      const key = readRawPromotionKeyFile(approvalRootFor(input.projectRoot), receipt.key_id);
      const { signature: _signature, ...unsigned } = receipt;
      const mutations = [
        { ...unsigned, receipt_id: "receipt_other_decision" },
        { ...unsigned, approver_subject_id: "reviewer_other" },
        { ...unsigned, nonce: "nonce_other_valid_value" },
        {
          ...unsigned,
          issued_at: new Date(Date.parse(unsigned.issued_at) - 1_000).toISOString(),
        },
        {
          ...unsigned,
          expires_at: new Date(Date.parse(unsigned.expires_at) - 1_000).toISOString(),
        },
        { ...unsigned, run_id: "run_other" },
        { ...unsigned, session_id: "sess_other" },
        { ...unsigned, challenge_id: "challenge_other" },
        { ...unsigned, kb_profile_id: "kbp_other" },
        { ...unsigned, kb_id: "kb_other" },
        { ...unsigned, gate_packet_sha256: "a".repeat(64) },
        { ...unsigned, page_revisions: [{ page_id: "page_other", revision_id: "rev_other" }] },
        { ...unsigned, target_capability_ids: [...unsigned.target_capability_ids].reverse() },
        { ...unsigned, canonical_targets: [...unsigned.canonical_targets].reverse() },
        {
          ...unsigned,
          preimage_digests: {
            [requireValue(
              unsigned.target_capability_ids[0],
              "apps/orchestration/tests/kb-promotion.test.ts:698"
            )]: "b".repeat(64),
          },
        },
        { ...unsigned, patch_digest: "c".repeat(64) },
        { ...unsigned, verification_evidence_digest: "d".repeat(64) },
      ];
      for (const mutation of mutations) {
        const forged = signPromotionReceipt(mutation, key);
        expect(() => input.store.resumeApprovedPromotion(receiptJcs(forged))).toThrow();
      }
      const unknownKeyReceipt = signPromotionReceipt(
        { ...unsigned, key_id: "key_unknown_1234567890" },
        key
      );
      expect(() => input.store.parseAndVerifyReceipt(receiptJcs(unknownKeyReceipt))).toThrow(
        /unknown key_id/
      );
      expect(input.store.receipt(receipt.receipt_id)?.state).toBe("available");
    } finally {
      input.store.close();
    }
  });

  it("requires the exact durable control-side approved decision and receipt before mutation", () => {
    const input = fixture();
    try {
      const decision = approve(input);
      const binding = requireValue(
        input.controlBindingForRun(RUN),
        "apps/orchestration/tests/kb-promotion.test.ts:723"
      );
      input.setControlBinding({ ...binding, receipt_sha256: "a".repeat(64) });
      expect(() =>
        input.store.resumeApprovedPromotion(
          requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:725")
        )
      ).toThrow(/exact control-side approved decision\/receipt binding/);
      expect(
        input.store.receipt(
          requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:728")
            .receipt_id
        )?.state
      ).toBe("available");
      expect(
        readFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:729")
        )
      ).toEqual(input.original[0]);
    } finally {
      input.store.close();
    }
  });

  it("rechecks the control binding at the mutation reservation cliff", () => {
    const input: Fixture = fixture(1, (boundary) => {
      if (boundary === "after_preimage_0") {
        const binding = requireValue(
          input.controlBindingForRun(RUN),
          "apps/orchestration/tests/kb-promotion.test.ts:739"
        );
        input.setControlBinding({ ...binding, decision_intent_sha256: "b".repeat(64) });
      }
    });
    try {
      const decision = approve(input);
      expect(() =>
        input.store.resumeApprovedPromotion(
          requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:745")
        )
      ).toThrow(/exact control-side approved decision\/receipt binding/);
      expect(
        readFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:748")
        )
      ).toEqual(input.original[0]);
      const receipt = requireValue(
        input.store.receipt(
          requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:749")
            .receipt_id
        ),
        "apps/orchestration/tests/kb-promotion.test.ts:749"
      );
      expect(
        input.store.journal(
          requireValue(receipt.transaction_id, "apps/orchestration/tests/kb-promotion.test.ts:750")
        )?.state
      ).toBe("failed");
    } finally {
      input.store.close();
    }
  });

  it("invalidates expired or preimage-drifted approvals before any mutation", () => {
    const expired = fixture();
    const expiredDecision = approve(expired);
    expired.store.close();
    const afterExpiry = new PromotionApprovalStore({
      projectRoot: expired.projectRoot,
      kbRoot: expired.kbRoot,
      artifactCheckpointer: expired.artifactCheckpointer,
      now: () => new Date(Date.now() + 3_600_000),
      controlBindingForRun: expired.controlBindingForRun,
    });
    try {
      expect(
        afterExpiry.resumeApprovedPromotion(
          requireValue(
            expiredDecision.receipt_jcs,
            "apps/orchestration/tests/kb-promotion.test.ts:768"
          )
        )
      ).toMatchObject({
        status: "failed",
        post_apply_verified: false,
      });
      expect(
        afterExpiry.receipt(
          requireValue(expiredDecision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:772")
            .receipt_id
        )?.state
      ).toBe("expired");
      const capabilities = new CapabilityStore(expired.projectRoot);
      try {
        expect(
          capabilities.lease(
            requireValue(expired.targetIds[0], "apps/orchestration/tests/kb-promotion.test.ts:775")
          )?.state
        ).toBe("invalidated");
      } finally {
        capabilities.close();
      }
      expect(
        readFileSync(
          requireValue(expired.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:779")
        )
      ).toEqual(expired.original[0]);
    } finally {
      afterExpiry.close();
    }

    const drifted = fixture();
    try {
      const driftDecision = approve(drifted);
      const thirdParty = Buffer.from("# drift before apply\n", "utf8");
      writeFileSync(
        requireValue(drifted.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:788"),
        thirdParty,
        { mode: 0o600 }
      );
      expect(
        drifted.store.resumeApprovedPromotion(
          requireValue(
            driftDecision.receipt_jcs,
            "apps/orchestration/tests/kb-promotion.test.ts:789"
          )
        )
      ).toMatchObject({
        status: "failed",
        post_apply_verified: false,
      });
      expect(
        drifted.store.receipt(
          requireValue(driftDecision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:793")
            .receipt_id
        )?.state
      ).toBe("invalidated");
      expect(
        readFileSync(
          requireValue(drifted.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:794")
        )
      ).toEqual(thirdParty);
    } finally {
      drifted.store.close();
    }
  });

  it("persists refine/deny intent exactly and never creates an apply receipt", () => {
    for (const decision of ["refine", "deny"] as const) {
      const input = fixture();
      try {
        const intent = input.store.buildDecisionIntent({
          challengeId: input.gateChallenge,
          decision,
          reviewerSubjectId: "reviewer_synthetic",
        });
        expect(intent.approval_nonce).toBeUndefined();
        const outcome = input.store.decide(intent);
        expect(outcome.gate.state).toBe(decision === "refine" ? "refined" : "denied");
        expect(outcome.decision_record?.decision).toBe(decision);
        expect(outcome.receipt).toBeUndefined();
        expect(outcome.gate.decision_intent_jcs).toBe(jcsCanonicalize(intent));
        expect(() =>
          input.store.decide({ ...intent, decision: decision === "deny" ? "refine" : "deny" })
        ).toThrow();
      } finally {
        input.store.close();
      }
    }
  });

  it("recovers crash-after-rename by hash classification without repeating the write", () => {
    let crashed = false;
    const input = fixture(1, (boundary) => {
      if (!crashed && boundary === "after_rename_before_journal_0") {
        crashed = true;
        throw new PromotionSimulatedCrash(boundary);
      }
    });
    const decision = approve(input);
    expect(() =>
      input.store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:833")
      )
    ).toThrow(PromotionSimulatedCrash);
    const receipt = requireValue(
      input.store.receipt(
        requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:836")
          .receipt_id
      ),
      "apps/orchestration/tests/kb-promotion.test.ts:836"
    );
    const transactionId = requireValue(
      receipt.transaction_id,
      "apps/orchestration/tests/kb-promotion.test.ts:837"
    );
    expect(
      readFileSync(
        requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:838"),
        "utf8"
      )
    ).toContain("Applied");
    input.store.close();

    const recovered = new PromotionApprovalStore({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      artifactCheckpointer: input.artifactCheckpointer,
      controlBindingForRun: input.controlBindingForRun,
    });
    try {
      expect(recovered.recoverApply(transactionId)).toMatchObject({
        status: "complete",
        post_apply_verified: true,
      });
    } finally {
      recovered.close();
    }
  });

  it("recovers a crash while the no-clobber target name is absent", () => {
    let crashed = false;
    const input = fixture(1, (boundary) => {
      if (!crashed && boundary === "after_target_displaced_0_postimage") {
        crashed = true;
        throw new PromotionSimulatedCrash(boundary);
      }
    });
    const decision = approve(input);
    expect(() =>
      input.store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:866")
      )
    ).toThrow(PromotionSimulatedCrash);
    const transactionId = requireValue(
      requireValue(
        input.store.receipt(
          requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:869")
            .receipt_id
        ),
        "apps/orchestration/tests/kb-promotion.test.ts:869"
      ).transaction_id,
      "apps/orchestration/tests/kb-promotion.test.ts:869"
    );
    expect(() =>
      statSync(
        requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:870")
      )
    ).toThrow();
    input.store.close();

    const recovered = new PromotionApprovalStore({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      artifactCheckpointer: input.artifactCheckpointer,
      controlBindingForRun: input.controlBindingForRun,
    });
    try {
      expect(recovered.recoverApply(transactionId)).toMatchObject({
        status: "complete",
        post_apply_verified: true,
      });
      expect(
        statSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:884")
        ).nlink
      ).toBe(1);
      expect(
        readFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:885"),
          "utf8"
        )
      ).toContain("Applied");
    } finally {
      recovered.close();
    }
  });

  it("recovers a crash during the transient no-clobber hard-link interval", () => {
    let crashed = false;
    const input = fixture(1, (boundary) => {
      if (!crashed && boundary === "after_target_linked_0_postimage") {
        crashed = true;
        throw new PromotionSimulatedCrash(boundary);
      }
    });
    const decision = approve(input);
    expect(() =>
      input.store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:900")
      )
    ).toThrow(PromotionSimulatedCrash);
    const transactionId = requireValue(
      requireValue(
        input.store.receipt(
          requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:903")
            .receipt_id
        ),
        "apps/orchestration/tests/kb-promotion.test.ts:903"
      ).transaction_id,
      "apps/orchestration/tests/kb-promotion.test.ts:903"
    );
    expect(
      statSync(
        requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:904")
      ).nlink
    ).toBe(2);
    input.store.close();

    const recovered = new PromotionApprovalStore({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      artifactCheckpointer: input.artifactCheckpointer,
      controlBindingForRun: input.controlBindingForRun,
    });
    try {
      expect(recovered.recoverApply(transactionId).status).toBe("complete");
      expect(
        statSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:915")
        ).nlink
      ).toBe(1);
    } finally {
      recovered.close();
    }
  });

  it("recovers a crash while a no-clobber restore has displaced the postimage", () => {
    let restoreCrash = false;
    const input = fixture(1, (boundary) => {
      if (boundary === "after_written_0") throw new Error("force restore");
      if (!restoreCrash && boundary === "after_target_displaced_0_restore") {
        restoreCrash = true;
        throw new PromotionSimulatedCrash(boundary);
      }
    });
    const decision = approve(input);
    expect(() =>
      input.store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:931")
      )
    ).toThrow(PromotionSimulatedCrash);
    const transactionId = requireValue(
      requireValue(
        input.store.receipt(
          requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:934")
            .receipt_id
        ),
        "apps/orchestration/tests/kb-promotion.test.ts:934"
      ).transaction_id,
      "apps/orchestration/tests/kb-promotion.test.ts:934"
    );
    expect(() =>
      statSync(
        requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:935")
      )
    ).toThrow();
    input.store.close();

    const recovered = new PromotionApprovalStore({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      artifactCheckpointer: input.artifactCheckpointer,
      controlBindingForRun: input.controlBindingForRun,
    });
    try {
      expect(recovered.recoverApply(transactionId).status).toBe("failed");
      expect(
        readFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:946")
        )
      ).toEqual(input.original[0]);
      expect(
        statSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:947")
        ).nlink
      ).toBe(1);
    } finally {
      recovered.close();
    }
  });

  it("finalizes capability consumption after approval-store success without restoring", () => {
    let crashed = false;
    const input = fixture(1, (boundary) => {
      if (!crashed && boundary === "after_approval_complete") {
        crashed = true;
        throw new PromotionSimulatedCrash(boundary);
      }
    });
    const decision = approve(input);
    expect(() =>
      input.store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:962")
      )
    ).toThrow(PromotionSimulatedCrash);
    const receipt = requireValue(
      input.store.receipt(
        requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:965")
          .receipt_id
      ),
      "apps/orchestration/tests/kb-promotion.test.ts:965"
    );
    const transactionId = requireValue(
      receipt.transaction_id,
      "apps/orchestration/tests/kb-promotion.test.ts:966"
    );
    expect(receipt.state).toBe("consumed");
    expect(input.store.journal(transactionId)?.state).toBe("complete");
    expect(
      readFileSync(
        requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:969"),
        "utf8"
      )
    ).toContain("Applied");
    input.store.close();

    // Synthetic legacy split: terminal journal committed while the receipt row
    // still reads apply_reserved. Recovery must repair the approval pair before
    // settling the capability store.
    const sqlite = process.getBuiltinModule("node:sqlite");
    const splitDb = new sqlite.DatabaseSync(
      path.join(approvalRootFor(input.projectRoot), "receipts.sqlite")
    );
    splitDb
      .prepare("UPDATE promotion_receipts SET state = 'apply_reserved' WHERE receipt_id = ?")
      .run(
        requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:981")
          .receipt_id
      );
    splitDb.close();

    const recovered = new PromotionApprovalStore({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      artifactCheckpointer: input.artifactCheckpointer,
      controlBindingForRun: input.controlBindingForRun,
    });
    try {
      expect(recovered.recoverApply(transactionId).status).toBe("complete");
      expect(
        recovered.receipt(
          requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:992")
            .receipt_id
        )?.state
      ).toBe("consumed");
      const capabilities = new CapabilityStore(input.projectRoot);
      try {
        expect(
          capabilities.lease(
            requireValue(input.targetIds[0], "apps/orchestration/tests/kb-promotion.test.ts:995")
          )
        ).toMatchObject({
          state: "consumed",
          transaction_id: transactionId,
        });
      } finally {
        capabilities.close();
      }
    } finally {
      recovered.close();
    }
  });

  it("restores owned postimages in reverse order on failure", () => {
    const restored: number[] = [];
    const input = fixture(2, (boundary) => {
      if (boundary.startsWith("after_restore_")) restored.push(Number(boundary.split("_").at(-1)));
      if (boundary === "after_written_1") throw new Error("owned synthetic failure");
    });
    try {
      const decision = approve(input);
      const outcome = input.store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:1015")
      );
      expect(outcome.status).toBe("failed");
      expect(restored).toEqual([1, 0]);
      input.targetPaths.forEach((targetPath, index) => {
        expect(readFileSync(targetPath)).toEqual(input.original[index]);
      });
    } finally {
      input.store.close();
    }
  });

  it("safely blocks and never overwrites third-party drift", () => {
    const drift = Buffer.from("# Third-party drift\n", "utf8");
    let crashed = false;
    const input = fixture(1, (boundary) => {
      if (!crashed && boundary === "after_rename_before_journal_0") {
        crashed = true;
        writeFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1032"),
          drift,
          { mode: 0o600 }
        );
        throw new PromotionSimulatedCrash(boundary);
      }
    });
    const decision = approve(input);
    expect(() =>
      input.store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:1037")
      )
    ).toThrow(PromotionSimulatedCrash);
    const transactionId = requireValue(
      requireValue(
        input.store.receipt(
          requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:1040")
            .receipt_id
        ),
        "apps/orchestration/tests/kb-promotion.test.ts:1040"
      ).transaction_id,
      "apps/orchestration/tests/kb-promotion.test.ts:1040"
    );
    input.store.close();
    const recovered = new PromotionApprovalStore({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      artifactCheckpointer: input.artifactCheckpointer,
      controlBindingForRun: input.controlBindingForRun,
    });
    try {
      expect(recovered.recoverApply(transactionId).status).toBe("blocked_external_drift");
      expect(
        readFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1050")
        )
      ).toEqual(drift);
      const capabilities = new CapabilityStore(input.projectRoot);
      try {
        expect(
          capabilities.lease(
            requireValue(input.targetIds[0], "apps/orchestration/tests/kb-promotion.test.ts:1053")
          )?.state
        ).toBe("invalidated");
      } finally {
        capabilities.close();
      }
    } finally {
      recovered.close();
    }
  });

  it("recovers pre-claim drift terminalized without an apply journal", () => {
    let crashed = false;
    const input = fixture(1, (boundary) => {
      if (!crashed && boundary === "after_preclaim_approval_terminal") {
        crashed = true;
        throw new PromotionSimulatedCrash(boundary);
      }
    });
    const decision = approve(input);
    const drift = Buffer.from("# drift before pre-claim validation\n", "utf8");
    writeFileSync(
      requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1072"),
      drift,
      { mode: 0o600 }
    );
    expect(() =>
      input.store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:1073")
      )
    ).toThrow(PromotionSimulatedCrash);
    const receipt = requireValue(
      input.store.receipt(
        requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:1076")
          .receipt_id
      ),
      "apps/orchestration/tests/kb-promotion.test.ts:1076"
    );
    expect(receipt.state).toBe("invalidated");
    expect(
      input.store.journal(
        requireValue(receipt.transaction_id, "apps/orchestration/tests/kb-promotion.test.ts:1078")
      )
    ).toBeUndefined();
    const beforeRecovery = new CapabilityStore(input.projectRoot);
    expect(
      beforeRecovery.lease(
        requireValue(input.targetIds[0], "apps/orchestration/tests/kb-promotion.test.ts:1080")
      )?.state
    ).toBe("claimed");
    beforeRecovery.close();
    input.store.close();

    const recovered = new PromotionApprovalStore({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      artifactCheckpointer: input.artifactCheckpointer,
      controlBindingForRun: input.controlBindingForRun,
    });
    try {
      expect(recovered.reconcileApprovedPromotion(RUN)).toMatchObject({
        status: "failed",
        transaction_id: receipt.transaction_id,
      });
      const capabilities = new CapabilityStore(input.projectRoot);
      expect(
        capabilities.lease(
          requireValue(input.targetIds[0], "apps/orchestration/tests/kb-promotion.test.ts:1096")
        )
      ).toMatchObject({
        state: "invalidated",
        transaction_id: receipt.transaction_id,
      });
      capabilities.close();
      expect(
        readFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1101")
        )
      ).toEqual(drift);
    } finally {
      recovered.close();
    }
  });

  it("atomically terminalizes failed journal+receipt before capability recovery", () => {
    let terminalCrash = false;
    const input = fixture(1, (boundary) => {
      if (boundary === "after_written_0") throw new Error("force owned restore");
      if (!terminalCrash && boundary === "after_failure_approval_terminal") {
        terminalCrash = true;
        throw new PromotionSimulatedCrash(boundary);
      }
    });
    const decision = approve(input);
    expect(() =>
      input.store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:1117")
      )
    ).toThrow(PromotionSimulatedCrash);
    const receipt = requireValue(
      input.store.receipt(
        requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:1120")
          .receipt_id
      ),
      "apps/orchestration/tests/kb-promotion.test.ts:1120"
    );
    const journal = requireValue(
      input.store.journal(
        requireValue(receipt.transaction_id, "apps/orchestration/tests/kb-promotion.test.ts:1121")
      ),
      "apps/orchestration/tests/kb-promotion.test.ts:1121"
    );
    expect(receipt.state).toBe("invalidated");
    expect(journal.state).toBe("failed");
    const beforeRecovery = new CapabilityStore(input.projectRoot);
    expect(
      beforeRecovery.lease(
        requireValue(input.targetIds[0], "apps/orchestration/tests/kb-promotion.test.ts:1125")
      )?.state
    ).toBe("apply_reserved");
    beforeRecovery.close();
    input.store.close();

    const recovered = new PromotionApprovalStore({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      artifactCheckpointer: input.artifactCheckpointer,
      controlBindingForRun: input.controlBindingForRun,
    });
    try {
      expect(recovered.recoverApply(journal.transaction_id).status).toBe("failed");
      const capabilities = new CapabilityStore(input.projectRoot);
      expect(
        capabilities.lease(
          requireValue(input.targetIds[0], "apps/orchestration/tests/kb-promotion.test.ts:1138")
        )?.state
      ).toBe("invalidated");
      capabilities.close();
      expect(
        readFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1140")
        )
      ).toEqual(input.original[0]);
    } finally {
      recovered.close();
    }
  });

  it("rejects symlinked canonical parent components before mutation", () => {
    const input = fixture();
    try {
      const decision = approve(input);
      const targetRoot = path.dirname(
        requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1150")
      );
      const movedRoot = `${targetRoot}-moved`;
      renameSync(targetRoot, movedRoot);
      symlinkSync(movedRoot, targetRoot);
      expect(
        input.store.resumeApprovedPromotion(
          requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:1154")
        )
      ).toMatchObject({
        status: "failed",
        post_apply_verified: false,
      });
      expect(
        readFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1158")
        )
      ).toEqual(input.original[0]);
    } finally {
      input.store.close();
    }
  });

  it("never overwrites drift introduced after the final check but before commit", () => {
    const drift = Buffer.from("# Drift in the check-to-commit window\n", "utf8");
    const input: Fixture = fixture(1, (boundary) => {
      if (boundary === "before_replace_commit_0") {
        writeFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1169"),
          drift,
          { mode: 0o600 }
        );
      }
    });
    try {
      const decision = approve(input);
      expect(
        input.store.resumeApprovedPromotion(
          requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:1174")
        )
      ).toMatchObject({
        status: "blocked_external_drift",
        post_apply_verified: false,
      });
      expect(
        readFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1178")
        )
      ).toEqual(drift);
    } finally {
      input.store.close();
    }
  });

  it("preserves the complete required target mode bits", () => {
    const input = fixture();
    try {
      chmodSync(
        requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1187"),
        0o4750
      );
      const requiredMode =
        statSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1188")
        ).mode & 0o7777;
      const decision = approve(input);
      expect(
        input.store.resumeApprovedPromotion(
          requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:1190")
        ).status
      ).toBe("complete");
      expect(
        statSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1191")
        ).mode & 0o7777
      ).toBe(requiredMode);
    } finally {
      input.store.close();
    }
  });

  it("hash- and custody-checks a saved preimage immediately before restore", () => {
    const input: Fixture = fixture(1, (boundary) => {
      if (boundary === "after_written_0") {
        const receipt = requireValue(
          input.store.receiptForRun(RUN),
          "apps/orchestration/tests/kb-promotion.test.ts:1201"
        );
        const journal = requireValue(
          input.store.journal(
            requireValue(
              receipt.transaction_id,
              "apps/orchestration/tests/kb-promotion.test.ts:1202"
            )
          ),
          "apps/orchestration/tests/kb-promotion.test.ts:1202"
        );
        const preimage = path.join(
          input.kbRoot,
          ...requireValue(
            journal.targets[0],
            "apps/orchestration/tests/kb-promotion.test.ts:1205"
          ).preimage_storage_key.split("/")
        );
        writeFileSync(preimage, "tampered saved preimage", { mode: 0o600 });
        throw new Error("force restore after saved-preimage tamper");
      }
    });
    try {
      const decision = approve(input);
      expect(
        input.store.resumeApprovedPromotion(
          requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:1213")
        )
      ).toMatchObject({
        status: "blocked_external_drift",
        post_apply_verified: false,
      });
      expect(
        input.store.journal(
          requireValue(
            requireValue(
              input.store.receiptForRun(RUN),
              "apps/orchestration/tests/kb-promotion.test.ts:1217"
            ).transaction_id,
            "apps/orchestration/tests/kb-promotion.test.ts:1217"
          )
        )?.state
      ).toBe("blocked_external_drift");
      expect(
        readFileSync(
          requireValue(input.targetPaths[0], "apps/orchestration/tests/kb-promotion.test.ts:1220"),
          "utf8"
        )
      ).toContain("Applied");
    } finally {
      input.store.close();
    }
  });

  it("treats expiry after the receipt reservation cliff as finalize-only", () => {
    let now = Date.now();
    let crashed = false;
    const input = fixture(1);
    input.store.close();
    const store = new PromotionApprovalStore({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      artifactCheckpointer: input.artifactCheckpointer,
      now: () => new Date(now),
      controlBindingForRun: input.controlBindingForRun,
      fault: (boundary) => {
        if (!crashed && boundary === "after_receipt_reservation") {
          crashed = true;
          now += 86_400_000;
          throw new PromotionSimulatedCrash(boundary);
        }
      },
    });
    input.store = store;
    const decision = approve(input);
    expect(() =>
      store.resumeApprovedPromotion(
        requireValue(decision.receipt_jcs, "apps/orchestration/tests/kb-promotion.test.ts:1247")
      )
    ).toThrow(PromotionSimulatedCrash);
    const transactionId = requireValue(
      requireValue(
        store.receipt(
          requireValue(decision.receipt, "apps/orchestration/tests/kb-promotion.test.ts:1250")
            .receipt_id
        ),
        "apps/orchestration/tests/kb-promotion.test.ts:1250"
      ).transaction_id,
      "apps/orchestration/tests/kb-promotion.test.ts:1250"
    );
    store.close();
    const recovered = new PromotionApprovalStore({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      artifactCheckpointer: input.artifactCheckpointer,
      now: () => new Date(now),
      controlBindingForRun: input.controlBindingForRun,
    });
    try {
      expect(recovered.recoverApply(transactionId).status).toBe("complete");
    } finally {
      recovered.close();
    }
  });
});
