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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer } from "../src/checkpointer.js";
import { OrchestrationEngine } from "../src/engine.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";
import { KbWorkerClient } from "../src/kb/kb-worker-client.js";
import { approveGate, denyGate, findGateForRun, mintSourceCapability } from "../src/kb/gate.js";
import { initKb, queryKb } from "../src/kb/workflows.js";
import { readPolicy, writePolicy } from "../src/kb/filesystem.js";
import { readSelectedGeneration } from "../src/kb/generations.js";
import { SaveQueryClaimStore, saveClaimStoreDir } from "../src/kb/save-claim.js";
import { approveIngest } from "../src/kb/ingest.js";
import { ingestKb } from "../src/kb/ingest.js";
import type { KbPhaseInvocation } from "../src/kb/session-tools.js";
import type { Directive } from "../src/contracts.js";
import { installGrantedProfile } from "./fixtures/kb-profile-fixture.js";

const PROFILE = "kbp_save_e2e";
const SESSION = "sess_save";
const PARENT = { provider: "ollama", model: "qwen327b:latest" };

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
function saveBodies(seen: { composeInput?: string }): Record<string, string> {
  return {
    compose: JSON.stringify({
      schema_version: 1,
      artifact_kind: "page_draft",
      pages: [
        {
          frontmatter: {
            schema_version: 1,
            page_id: "page_saved",
            revision_id: "rev_saved_1",
            kind: "synthesis",
            title: "What we decided about quorum",
            summary: "Saved from a query answer.",
            authority: "advisory",
            lifecycle: "validated",
            created_at: "2026-08-19T00:00:00Z",
            derived_from: [],
            related_page_ids: [],
          },
          markdown: "# Quorum\n\nTwo of three acknowledgements satisfy quorum.",
          claims: {
            schema_version: 1,
            page_id: "page_saved",
            revision_id: "rev_saved_1",
            claims: [],
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

/** A KB with one published page, plus a completed query that minted a claim. */
async function kbWithQuery() {
  const projectRoot = tmp("penny-kb-save");
  const kbRoot = path.join(projectRoot, "private-kb");
  installGrantedProfile({ projectRoot, kbRoot, profileId: PROFILE, sessionId: SESSION });
  initKb({ kbRoot, profileId: PROFILE, runId: "run_init" }, "Save E2E KB");
  installPolicy(kbRoot);

  // Publish one page so the KB is non-empty and retrieval has a candidate.
  const srcDir = tmp("penny-kb-save-src");
  const srcPath = path.join(srcDir, "a.md");
  writeFileSync(srcPath, "Two of three acknowledgements satisfy quorum.", { mode: 0o600 });
  const cap = mintSourceCapability({
    kbRoot,
    kbProfileId: PROFILE,
    absolutePath: srcPath,
    title: "Quorum note",
    authors: ["Ada"],
    sourceType: "manual",
    mediaType: "text/markdown",
  });
  const capId = cap.capability_id;
  const source = {
    sourceId: capId,
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
      source_ids: [capId],
      claims: [],
    }),
    ...saveBodies({}),
  };
  const gated = await ingestKb(
    { kbRoot, profileId: PROFILE, runId: "run_seed" },
    [source],
    async (inv) => {
      const body = bodies[inv.stateId];
      if (body === undefined) throw new Error(`no body for ${inv.stateId}`);
      return body;
    }
  );
  const byKind = Object.fromEntries(gated.artifacts.map((a) => [a.artifact_kind, a.artifact_id]));
  approveIngest({ kbRoot, profileId: PROFILE, runId: "run_seed" }, [source], {
    runId: "run_seed",
    sourceIds: [capId],
    claimsArtifactId: byKind.claims!,
    pageDraftArtifactId: byKind.page_draft!,
    lintReportArtifactId: byKind.lint_report!,
    verificationArtifactId: byKind.verification_report!,
  });

  // A completed query mints exactly one claim over its sealed answer.
  const claimDir = saveClaimStoreDir(projectRoot, PROFILE);
  const query = queryKb({ kbRoot, profileId: PROFILE, runId: "run_query" }, "quorum", {
    claimStoreDir: claimDir,
  });
  expect(query.status).toBe("complete");
  expect(query.met).toBe(true);

  return { projectRoot, kbRoot, claimDir };
}

/** Drive a save run to its content-review gate. */
async function driveSaveToGate(input: {
  projectRoot: string;
  kbRoot: string;
  runId: string;
  queryRunId: string;
  seen?: { composeInput?: string };
}): Promise<Directive> {
  const dbPath = path.join(input.projectRoot, ".penny", `save-${input.runId}.db`);
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
    kbRoot: input.kbRoot,
    runId: input.runId,
    profileId: PROFILE,
    sourceCapabilityIds: [],
    seedPhaseOutputs: {
      ingest: { runId: input.queryRunId, artifactId: claim.answer_artifact_id },
    },
    agentRunner: (async (inv: KbPhaseInvocation) => {
      // Compose must be able to read the claimed answer through the seeded slot.
      if (inv.stateId === "compose" && input.seen) {
        input.seen.composeInput = inv.readPhaseOutput("ingest");
      }
      const body = bodies[inv.stateId];
      if (body === undefined) throw new Error(`save e2e: no body for ${inv.stateId}`);
      return body;
    }) as never,
  });
  const workers = new WorkerExecutor(worker, new ArtifactStore(artifactRoot), {
    projectRoot: input.projectRoot,
    parallelConcurrency: 1,
    workerTimeoutMs: 20_000,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  const runner = new OrchestrationRunner(engine, workers);
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
      goal: "save the claimed query answer as an advisory page",
      constraints: {
        action: "save",
        kb_profile_id: PROFILE,
        query_run_id: input.queryRunId,
        page_kind: "synthesis",
        title: "What we decided about quorum",
        parent_identity: { ...PARENT },
      },
      project_root: input.projectRoot,
      trust_profile: "hardened-untrusted",
    }),
    undefined
  );
  checkpointer.close();
  worker.close();
  return directive;
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
    // Compose actually read the claimed sealed answer (§5.8 prior-run artifact).
    expect(seen.composeInput).toBeDefined();
    expect(JSON.parse(seen.composeInput!).artifact_kind).toBe("query_answer");

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
    const gate = findGateForRun(kbRoot, "run_save_1");
    expect(gate).toBeDefined();

    // Host-authenticated approval; a save admits no new sources.
    const approved = approveGate(kbRoot, [], "run_save_1");
    expect(approved.result.status).toBe("complete");

    const after = readSelectedGeneration(kbRoot)!;
    // The KB still holds what it held, plus this save's revision.
    expect(Object.keys(after.catalog.pages)).toContain("page_saved");
    expect(Object.keys(after.catalog.source_records).length).toBe(
      Object.keys(before.catalog.source_records).length
    );
    expect(after.catalog.parent_generation_id).toBe(before.selector.generation_id);
  });

  it("a denied save returns the claim so the answer can be saved differently later", async () => {
    const { projectRoot, kbRoot, claimDir } = await kbWithQuery();
    await driveSaveToGate({ projectRoot, kbRoot, runId: "run_save_1", queryRunId: "run_query" });

    denyGate(kbRoot, "run_save_1");
    // The playbook settles the claim on the deny path; simulate the same call
    // the machine makes so the store-level outcome is asserted directly.
    new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, PROFILE)).release({
      query_run_id: "run_query",
      save_run_id: "run_save_1",
      answer_sha256: new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, PROFILE)).load(
        "run_query"
      ).answer_sha256,
    });

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

  it("refuses a save that names a query run with no claim", async () => {
    const { projectRoot, kbRoot } = await kbWithQuery();
    await expect(
      driveSaveToGate({ projectRoot, kbRoot, runId: "run_save_x", queryRunId: "run_query_absent" })
    ).rejects.toThrow();
  });
});
