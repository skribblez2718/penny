/**
 * `save` end to end (§6.2A step 7) — claim → compose → lint → verify → gate →
 * publish, driven through the real engine, the real plane, and the real claim
 * store with deterministic agent bodies.
 *
 * The properties that make `save` different from `ingest` are the ones under
 * test here: a useful query does not authorize a save (the claim does), the
 * claim is spent exactly once, a denial returns it, and the published
 * generation ADDS the saved page instead of replacing the KB.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer } from "../src/checkpointer.js";
import { OrchestrationEngine } from "../src/engine.js";
import { RunContext } from "../src/context.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";
import { KbWorkerClient } from "../src/kb/kb-worker-client.js";
import { mintSourceCapability } from "../src/kb/gate.js";
import { envelopeDigest } from "../src/kb/capabilities.js";
import {
  ContentReviewService,
  authenticateLocalContentReviewer,
} from "../src/kb/content-review.js";
import { initKb } from "../src/kb/workflows.js";
import { readPolicy, writePolicy } from "../src/kb/filesystem.js";
import { readSelectedGeneration } from "../src/kb/generations.js";
import {
  SaveQueryClaimStore,
  saveClaimStoreDir,
  validateSaveRequest,
} from "../src/kb/save-claim.js";
import { admitOperationStart, completeOperationStart } from "../src/kb/operation-starts.js";
import { replayableResultFromRun } from "../src/kb/operation-receipts.js";
import { RunArtifactStore } from "../src/kb/run-artifacts.js";
import { defaultKbIngestPlane } from "../src/kb/ingest-plane.js";
import { validateQueryRequest } from "../src/kb/parent-delivery.js";
import { approveIngest, createTestOnlyIngestBodyRunner, ingestKb } from "../src/kb/ingest.js";
import {
  createTestOnlyArtifactBodyRunner,
  type KbPhaseInvocation,
} from "../src/kb/session-tools.js";
import type { Directive } from "../src/contracts.js";
import { sha256Hex } from "../src/kb/contracts.js";
import { installGrantedProfile } from "./fixtures/kb-profile-fixture.js";

const PROFILE = "kbp_save_e2e";
const SESSION = "sess_save";
const PARENT = { provider: "ollama", model: "qwen327b:latest" };

function saveControlPath(projectRoot: string): string {
  return path.join(projectRoot, ".penny", "save-orchestration.db");
}

function ensureArtifactRun(
  checkpointer: Checkpointer,
  projectRoot: string,
  runId: string,
  action: "ingest" | "query"
): void {
  if (checkpointer.runExists(runId)) return;
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: SESSION,
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "Save E2E artifact fixture.",
    constraints: { action, kb_profile_id: PROFILE },
    projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 16,
  });
  checkpointer.createRun(context, "save_fixture_artifact_run", {});
}

const dirs: string[] = [];
function tmp(label: string): string {
  const d = mkdtempSync(path.join(tmpdir(), `${label}-`));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function installPolicy(kbRoot: string): void {
  const policy = readPolicy(kbRoot);
  writePolicy(kbRoot, {
    ...policy,
    processing_mode: "local_only",
    allowed_parent_models: [{ ...PARENT, locality: "local" }],
    allowed_child_models: [{ ...PARENT, locality: "local" }],
  });
}

/** Deterministic bodies for a SAVE run: compose reads the claimed answer. */
function saveBodies(
  seen: { composeInput?: string },
  supportedSourceId?: string,
  revisionId = "rev_saved_2"
): Record<string, string> {
  return {
    compose: JSON.stringify({
      schema_version: 1,
      artifact_kind: "page_draft",
      pages: [
        {
          frontmatter: {
            schema_version: 1,
            page_id: "page_saved",
            revision_id: revisionId,
            kind: "synthesis",
            title: "What we decided about quorum",
            summary: "Saved from a query answer.",
            authority: "advisory",
            lifecycle: "validated",
            created_at: "2026-08-19T00:00:00Z",
            derived_from: [],
            related_page_ids: [],
          },
          markdown:
            "## Synthesis\nTwo of three acknowledgements satisfy quorum.\n\n## Evidence\nThe claimed query answer cites the quorum evidence.\n\n## Tensions and unknowns\nNo additional tension identified.\n\n## Related\nNo related page selected.",
          claims: {
            schema_version: 1,
            page_id: "page_saved",
            revision_id: revisionId,
            claims:
              supportedSourceId === undefined
                ? []
                : [
                    {
                      claim_id: "claim_quorum_seed",
                      text: "Two of three acknowledgements satisfy quorum.",
                      kind: "fact",
                      state: "supported",
                      confidence: "CERTAIN",
                      evidence: [{ source_id: supportedSourceId }],
                      contradicts_claim_ids: [],
                      canonical_verification_refs: [],
                    },
                  ],
          },
        },
      ],
    }),
    lint: JSON.stringify({
      schema_version: 1,
      artifact_kind: "lint_report",
      findings: [],
      candidate_conflicts: [],
    }),
    verify: JSON.stringify({
      schema_version: 1,
      artifact_kind: "verification_report",
      verified_artifact_ids: [],
      claim_findings: [],
    }),
  };
}

function allocatedSaveComposeBody(invocation: KbPhaseInvocation): string {
  const brief = JSON.parse(invocation.readPhaseBrief?.() ?? "{}") as {
    compose_authority?: {
      allocations?: Array<{
        page_id: string;
        revision_id: string;
        lifecycle: "draft";
        source_ids: string[];
        claim_allocations: Array<{ claim_id: string }>;
        supersedes: null | { revision_id: string };
      }>;
    };
  };
  const allocation = brief.compose_authority?.allocations?.[0];
  const claim = allocation?.claim_allocations[0];
  const sourceId = allocation?.source_ids[0];
  if (allocation === undefined || claim === undefined || sourceId === undefined) {
    throw new Error("save compose host allocation is incomplete");
  }
  return JSON.stringify({
    schema_version: 1,
    artifact_kind: "page_draft",
    pages: [
      {
        frontmatter: {
          schema_version: 1,
          page_id: allocation.page_id,
          revision_id: allocation.revision_id,
          ...(allocation.supersedes === null
            ? {}
            : { previous_revision_id: allocation.supersedes.revision_id }),
          kind: "synthesis",
          title: "What we decided about quorum",
          summary: "Saved from a query answer.",
          authority: "advisory",
          lifecycle: allocation.lifecycle,
          created_at: "2026-08-19T00:00:00Z",
          derived_from: [],
          related_page_ids: [],
        },
        markdown:
          "## Synthesis\nTwo of three acknowledgements satisfy quorum.\n\n## Evidence\nThe claimed query answer cites the quorum evidence.\n\n## Tensions and unknowns\nNo additional tension identified.\n\n## Related\nNo related page selected.",
        claims: {
          schema_version: 1,
          page_id: allocation.page_id,
          revision_id: allocation.revision_id,
          claims: [
            {
              claim_id: claim.claim_id,
              text: "Two of three acknowledgements satisfy quorum.",
              kind: "fact",
              state: "supported",
              confidence: "CERTAIN",
              evidence: [{ source_id: sourceId }],
              contradicts_claim_ids: [],
              canonical_verification_refs: [],
            },
          ],
        },
      },
    ],
  });
}

/** A KB with one published page, plus a completed query that minted a claim. */
async function kbWithQuery() {
  const projectRoot = tmp("penny-kb-save");
  const kbRoot = path.join(projectRoot, "private-kb");
  installGrantedProfile({ projectRoot, kbRoot, profileId: PROFILE, sessionId: SESSION });
  initKb({ kbRoot, profileId: PROFILE, runId: "run_init" }, "Save E2E KB");
  installPolicy(kbRoot);
  const checkpointer = new Checkpointer(saveControlPath(projectRoot));
  ensureArtifactRun(checkpointer, projectRoot, "run_seed", "ingest");

  // Publish one page so the KB is non-empty and retrieval has a candidate.
  const srcDir = tmp("penny-kb-save-src");
  const srcPath = path.join(srcDir, "a.md");
  writeFileSync(srcPath, "Two of three acknowledgements satisfy quorum.", { mode: 0o600 });
  const cap = mintSourceCapability({
    projectRoot,
    kbProfileId: PROFILE,
    sessionId: SESSION,
    allowedOperation: "ingest",
    absolutePath: srcPath,
    title: "Quorum note",
    authors: ["Ada"],
    sourceType: "manual",
    mediaType: "text/markdown",
  });
  const sourceId = "src_save_seed";
  const source = {
    sourceId,
    capabilityDigest: envelopeDigest(cap),
    title: "Quorum note",
    authors: ["Ada"],
    content: "Two of three acknowledgements satisfy quorum.",
    mediaType: "text/markdown" as const,
    sourceType: "manual" as const,
    capturedAt: "2026-08-19T00:00:00Z",
  };
  const bodies: Record<string, string> = {
    ingest: JSON.stringify({
      schema_version: 1,
      artifact_kind: "claims",
      source_ids: [sourceId],
      claims: [],
    }),
    ...saveBodies({}, sourceId, "rev_saved_1"),
  };
  const gated = await ingestKb(
    { kbRoot, profileId: PROFILE, runId: "run_seed", checkpointer },
    [source],
    createTestOnlyIngestBodyRunner(async (inv) => {
      const body = bodies[inv.stateId];
      if (body === undefined) throw new Error(`no body for ${inv.stateId}`);
      return body;
    })
  );
  const byKind = Object.fromEntries(gated.artifacts.map((a) => [a.artifact_kind, a.artifact_id]));
  approveIngest({ kbRoot, profileId: PROFILE, runId: "run_seed", checkpointer }, [source], {
    runId: "run_seed",
    sourceIds: [sourceId],
    claimsArtifactId: byKind.claims!,
    pageDraftArtifactId: byKind.page_draft!,
    lintReportArtifactId: byKind.lint_report!,
    verificationArtifactId: byKind.verification_report!,
  });

  // Seed this SAVE-focused suite through the same authority finalizer a passing
  // Synthia → Vera query uses. Query-start tests exercise the engine/session path;
  // here we need its resulting verified single-use claim as fixture input.
  const claimDir = saveClaimStoreDir(projectRoot, PROFILE);
  const queryRequest = validateQueryRequest({
    schema_version: 1,
    action: "query",
    kb_profile_id: PROFILE,
    query: "quorum",
  });
  const selectedGenerationId = readSelectedGeneration(kbRoot)!.selector.generation_id;
  ensureArtifactRun(checkpointer, projectRoot, "run_query", "query");
  const queryStore = new RunArtifactStore(kbRoot, "run_query", checkpointer);
  const citation = {
    kind: "claim" as const,
    page_id: "page_saved",
    revision_id: "rev_saved_1",
    claim_id: "claim_quorum_seed",
  };
  const answer = queryStore.stage({
    state_id: "query",
    kb_profile_id: PROFILE,
    artifact_kind: "query_answer",
    content: JSON.stringify({
      schema_version: 1,
      artifact_kind: "query_answer",
      answer: {
        authority: "advisory",
        text: "Two of three acknowledgements satisfy quorum.",
        citations: [citation],
        contradictions: [],
        unknowns: [],
        canonical_verification_required: true,
      },
    }),
  });
  const verification = queryStore.stage({
    state_id: "verify",
    kb_profile_id: PROFILE,
    artifact_kind: "verification_report",
    content: JSON.stringify({
      schema_version: 1,
      artifact_kind: "verification_report",
      passed: true,
      answer_artifact_id: answer.artifact_id,
      answer_sha256: answer.sha256,
      answer_verdict: "supported",
      citation_findings: [
        { citation, verdict: "supported", notes: "The selected source states the quorum rule." },
      ],
    }),
  });
  queryStore.close();
  const finalized = defaultKbIngestPlane(checkpointer).finalizeVerifiedQuery!({
    projectRoot,
    kbRoot,
    profileId: PROFILE,
    runId: "run_query",
    request: queryRequest,
    selectedGenerationId,
    answerArtifactId: answer.artifact_id,
    verificationArtifactId: verification.artifact_id,
  });
  expect(finalized.met).toBe(true);
  checkpointer.close();

  return { projectRoot, kbRoot, claimDir };
}

/** Drive a save run to its content-review gate. */
async function driveSaveToGate(input: {
  projectRoot: string;
  kbRoot: string;
  runId: string;
  queryRunId: string;
  seen?: { composeInput?: string };
  tamperPrivateInputAfterBrief?: boolean;
}): Promise<Directive> {
  const dbPath = saveControlPath(input.projectRoot);
  const artifactRoot = path.join(input.projectRoot, ".penny", `save-artifacts-${input.runId}`);
  const checkpointer = new Checkpointer(dbPath);
  const artifacts = new ArtifactStore(artifactRoot);
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: input.projectRoot,
    maxSteps: 40,
    artifactRevisions: artifacts,
    playbookName: "knowledge-base",
  });
  const claim = new SaveQueryClaimStore(saveClaimStoreDir(input.projectRoot, PROFILE)).load(
    input.queryRunId
  );
  const bodies = saveBodies(input.seen ?? {});
  const worker = new KbWorkerClient({
    projectRoot: input.projectRoot,
    checkpointer,
    kbRoot: input.kbRoot,
    runId: input.runId,
    sessionId: SESSION,
    profileId: PROFILE,
    operation: "save",
    sourceIds: [],
    seedPhaseOutputs: {
      ingest: { runId: input.queryRunId, artifactId: claim.answer_artifact_id },
    },
    testOnlyAgentRunner: createTestOnlyArtifactBodyRunner(async (inv: KbPhaseInvocation) => {
      // Compose reads the exact claimed answer through its path-free handle.
      if (inv.stateId === "compose" && input.seen) {
        const prior = inv.allowedPriorArtifacts?.[0];
        input.seen.composeInput =
          prior === undefined ? "" : (inv.readRunArtifact?.(prior.artifact_id) ?? "");
      }
      if (inv.stateId === "compose") {
        const body = allocatedSaveComposeBody(inv);
        if (input.tamperPrivateInputAfterBrief === true) {
          writeFileSync(
            path.join(
              input.projectRoot,
              ".penny",
              "orchestration-inputs",
              input.runId,
              "request.json"
            ),
            '{"tampered":true}',
            { mode: 0o600 }
          );
        }
        return body;
      }
      const body = bodies[inv.stateId];
      if (body === undefined) throw new Error(`save e2e: no body for ${inv.stateId}`);
      return body;
    }),
  });
  const workers = new WorkerExecutor(worker, new ArtifactStore(artifactRoot), {
    projectRoot: input.projectRoot,
    parallelConcurrency: 1,
    workerTimeoutMs: 20_000,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  const runner = new OrchestrationRunner(engine, workers);
  const request = validateSaveRequest({
    schema_version: 1,
    action: "save",
    kb_profile_id: PROFILE,
    query_run_id: input.queryRunId,
    page_kind: "synthesis",
    title: "What we decided about quorum",
  });
  const goal = "save the claimed query answer as an advisory page";
  const constraints = {
    action: "save",
    kb_profile_id: PROFILE,
    query_run_id: input.queryRunId,
    page_kind: "synthesis",
    parent_identity: { ...PARENT },
  };
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: SESSION,
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal,
    constraints,
    projectRoot: input.projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 40,
  });
  context.playbookData.action = "save";
  context.playbookData.profile_id = PROFILE;
  const admittedStart = admitOperationStart({
    projectRoot: input.projectRoot,
    checkpointer,
    context,
    session_id: SESSION,
    invocation_id: `call_${input.runId}`,
    action: "save",
    profile_id: PROFILE,
    request,
  });
  const directive = await runner.runUntilBoundary(
    engine.handle({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: input.runId,
        session_id: SESSION,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal,
      constraints,
      project_root: input.projectRoot,
      trust_profile: "hardened-untrusted",
    }),
    undefined
  );
  const durable = checkpointer.loadRunById(input.runId)!;
  const startResult = replayableResultFromRun({ action: "save", run: durable });
  completeOperationStart({
    projectRoot: input.projectRoot,
    checkpointer,
    group_id: admittedStart.group.request_event_group_id,
    profile_id: PROFILE,
    result: startResult,
    input_digests: [admittedStart.request_sha256],
    kb_id: String(durable.playbookData.kb_id),
    policy_sha256: String(durable.playbookData.admitted_policy_sha256),
    safe_metrics: startResult.counts,
  });
  checkpointer.close();
  worker.close();
  return directive;
}

function decideSave(projectRoot: string, runId: string, decision: "approve" | "deny"): Directive {
  const checkpointer = new Checkpointer(saveControlPath(projectRoot));
  try {
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot,
      maxSteps: 40,
      playbookName: "knowledge-base",
    });
    return new ContentReviewService({
      projectRoot,
      checkpointer,
      engine,
      reviewer: authenticateLocalContentReviewer(),
    }).decide({ runId, decision });
  } finally {
    checkpointer.close();
  }
}

describe("save: claim, compose, gate, publish", () => {
  it("claims the query answer, composes from it, and stops at the review gate", async () => {
    const { projectRoot, kbRoot, claimDir } = await kbWithQuery();
    const seen: { composeInput?: string } = {};

    const directive = await driveSaveToGate({
      projectRoot,
      kbRoot,
      runId: "run_save_1",
      queryRunId: "run_query",
      seen,
    });

    expect(directive.action).toBe("await_user");
    const reviewDb = new Checkpointer(saveControlPath(projectRoot));
    try {
      const review = reviewDb.contentReviewForRun("run_save_1");
      expect(review?.packet.action).toBe("save");
      expect(review?.packet.query_run_id).toBe("run_query");
      expect(review?.packet.candidate_source_record_digests).toEqual({});
      expect(review?.packet.candidate_artifacts.map((artifact) => artifact.artifact_kind)).toEqual([
        "page_draft",
        "lint_report",
        "verification_report",
      ]);
      expect(
        reviewDb.kbPhaseOperands("run_save_1", "compose")?.compose_authority?.selected_pages
      ).toMatchObject([{ page_id: "page_saved", revision_id: "rev_saved_1" }]);
    } finally {
      reviewDb.close();
    }
    // Compose actually read the claimed sealed answer (§5.8 prior-run artifact).
    expect(seen.composeInput).toBeDefined();
    expect(JSON.parse(seen.composeInput!).payload.artifact_kind).toBe("query_answer");

    // The claim is held by this save run, not yet spent.
    const claim = new SaveQueryClaimStore(claimDir).load("run_query");
    expect(claim.state).toBe("claimed");
    expect(claim.save_run_id).toBe("run_save_1");
  });

  it("approval publishes the saved page ADDITIVELY and consumes the claim once", async () => {
    const { projectRoot, kbRoot, claimDir } = await kbWithQuery();
    const before = readSelectedGeneration(kbRoot)!;
    expect(Object.keys(before.catalog.pages)).toEqual(["page_saved"]);

    await driveSaveToGate({ projectRoot, kbRoot, runId: "run_save_1", queryRunId: "run_query" });

    // Host-authenticated approval through the same facade as ingest.
    const approved = decideSave(projectRoot, "run_save_1", "approve");
    expect(approved.action).toBe("complete");

    const after = readSelectedGeneration(kbRoot)!;
    // The KB still holds what it held, plus this save's revision.
    expect(Object.keys(after.catalog.pages)).toContain("page_saved");
    expect(Object.keys(after.catalog.source_records).length).toBe(
      Object.keys(before.catalog.source_records).length
    );
    expect(after.catalog.parent_generation_id).toBe(before.selector.generation_id);

    const controlPath = saveControlPath(projectRoot);
    const control = new Checkpointer(controlPath);
    try {
      const receipts = control.operationReceipts("run_save_1");
      expect(receipts).toMatchObject([
        { action: "save", event_sequence: 0, event: "prepared", state: "published" },
        { action: "save", event_sequence: 1, event: "published", state: "published" },
      ]);
      const publicationTransactionId = receipts[1]!.transaction_id;
      expect(control.kbPublication(publicationTransactionId)).toMatchObject({
        run_id: "run_save_1",
        candidate_generation_id: after.selector.generation_id,
        lifecycle: "complete",
      });
      using claims = new SaveQueryClaimStore(claimDir);
      expect(claims.load("run_query")).toMatchObject({
        state: "consumed",
        save_run_id: "run_save_1",
        save_transaction_id: publicationTransactionId,
      });
      expect(control.getPrivateInput("run_save_1")?.state).toBe("discarded");
    } finally {
      control.close();
    }
    expect(readFileSync(controlPath).toString("utf8")).not.toContain(
      "What we decided about quorum"
    );
  });

  it("a denied save returns the claim so the answer can be saved differently later", async () => {
    const { projectRoot, kbRoot, claimDir } = await kbWithQuery();
    await driveSaveToGate({ projectRoot, kbRoot, runId: "run_save_1", queryRunId: "run_query" });

    const denied = decideSave(projectRoot, "run_save_1", "deny");
    expect(denied.action).toBe("incomplete");

    const claim = new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, PROFILE)).load(
      "run_query"
    );
    expect(claim.state).toBe("available");
    expect(claim.save_run_id).toBeUndefined();
  });

  it("refuses a second save of the same query answer", async () => {
    const { projectRoot, kbRoot } = await kbWithQuery();
    await driveSaveToGate({ projectRoot, kbRoot, runId: "run_save_1", queryRunId: "run_query" });

    // A concurrent/duplicate save cannot take a claim another run holds.
    await expect(
      driveSaveToGate({ projectRoot, kbRoot, runId: "run_save_2", queryRunId: "run_query" })
    ).rejects.toThrow(/not available|already/i);
  });

  it("persists and closes the exact compose allocation across restart so it cannot be reused", async () => {
    const { projectRoot, kbRoot } = await kbWithQuery();
    const runId = "run_save_restart_allocation";
    await driveSaveToGate({ projectRoot, kbRoot, runId, queryRunId: "run_query" });

    const control = new Checkpointer(saveControlPath(projectRoot));
    control.bindKbRuntimeProjectRoot(projectRoot);
    try {
      const record = control.kbPhaseOperandsRecord(runId, "compose");
      expect(record).toMatchObject({
        lifecycle: "closed",
        operands: {
          run_id: runId,
          state_id: "compose",
          operation: "save",
          compose_authority: { allocations: [{ supersedes: null }] },
        },
      });
      expect(record?.operands.compose_authority?.allocations).toHaveLength(1);
      expect(record?.closed_result_sha256).toBe(
        control.kbPhaseResult(runId, "compose")?.result_sha256
      );
      const store = new RunArtifactStore(kbRoot, runId, control);
      try {
        const handle = store.listByState("compose", "sealed")[0]!;
        const content = store.read(handle.artifact_id).content;
        expect(() =>
          store.stageFromTool({
            state_id: "compose",
            kb_profile_id: PROFILE,
            producer: "synthia",
            expected_producer: "synthia",
            expected_kind: "page_draft",
            expected_media_type: "application/json",
            max_bytes: 1_048_576,
            max_artifacts: 1,
            tool_input: {
              schema_version: 1,
              artifact_kind: "page_draft",
              media_type: "application/json",
              encoding: "utf8",
              content,
            },
          })
        ).toThrow(/artifact_phase_already_terminated/);
        expect(() => store.bindPhaseOperands(record!.operands)).toThrow(/phase_operands_changed/);
      } finally {
        store.close();
      }
    } finally {
      control.close();
    }
  });

  it("rejects private-input digest drift after allocation and before draft staging", async () => {
    const { projectRoot, kbRoot } = await kbWithQuery();
    await expect(
      driveSaveToGate({
        projectRoot,
        kbRoot,
        runId: "run_save_digest_drift",
        queryRunId: "run_query",
        tamperPrivateInputAfterBrief: true,
      })
    ).rejects.toThrow(/private input|digest|hash/i);
    const control = new Checkpointer(saveControlPath(projectRoot));
    try {
      expect(control.kbPhaseOperandsRecord("run_save_digest_drift", "compose")).toMatchObject({
        lifecycle: "open",
      });
      expect(control.kbPhaseResult("run_save_digest_drift", "compose")).toBeUndefined();
    } finally {
      control.close();
    }
  });

  it("refuses a save that names a query run with no claim", async () => {
    const { projectRoot, kbRoot } = await kbWithQuery();
    await expect(
      driveSaveToGate({ projectRoot, kbRoot, runId: "run_save_x", queryRunId: "run_query_absent" })
    ).rejects.toThrow();
  });
});
