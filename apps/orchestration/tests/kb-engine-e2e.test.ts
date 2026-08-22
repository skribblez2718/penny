/**
 * KB engine-driven E2E — step 4 acceptance.
 *
 * The whole KB pipeline through the ORCHESTRATION ENGINE (not the workflow
 * functions): start → initialize (claim + admit sources) → four agent phases
 * (deterministic fake runner, no models) → the run stops at the human content-
 * review gate (await_user) → the HOST approves/denies through the engine's
 * respond protocol → publication (or honest denial) + consistent terminal.
 *
 * This is the acceptance criterion: the KB's state machine is driven by the
 * engine, and the approval/denial decisions reach the KB only through a
 * host-authenticated gate response.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initKb, queryKb } from "../src/kb/workflows.js";
import { readPolicy, writePolicy } from "../src/kb/filesystem.js";

/** The active parent identity these runs execute under (§5.3). */
const E2E_PARENT = { provider: "ollama", model: "qwen327b:latest" };

/**
 * The out-of-band policy install §5.3 requires.
 *
 * A freshly created KB is default-deny with empty model lists, so it cannot
 * process private content until an operator edits the ignored policy file out of
 * band. These integration tests perform exactly that host operation — they do
 * not weaken the check, they satisfy it.
 */
function installTestPolicy(kbRoot: string): void {
  const policy = readPolicy(kbRoot);
  writePolicy(kbRoot, {
    ...policy,
    processing_mode: "local_only",
    allowed_parent_models: [{ ...E2E_PARENT, locality: "local" }],
    allowed_child_models: [{ ...E2E_PARENT, locality: "local" }],
  });
}
import { mintSourceCapability } from "../src/kb/gate.js";
import {
  ContentReviewService,
  authenticateLocalContentReviewer,
} from "../src/kb/content-review.js";
import { readSelectedGeneration } from "../src/kb/generations.js";
import { CapabilityStore } from "../src/kb/capabilities.js";
import { KbWorkerClient } from "../src/kb/kb-worker-client.js";
import { Checkpointer } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { admitOperationStart } from "../src/kb/operation-starts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { OrchestrationEngine } from "../src/engine.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";
import {
  createTestOnlyArtifactBodyRunner,
  type KbPhaseInvocation,
} from "../src/kb/session-tools.js";
import type { Directive } from "../src/contracts.js";
import { kbArtifactControl } from "./fixtures/kb-artifact-control.js";
import { installGrantedProfile } from "./fixtures/kb-profile-fixture.js";

const PROFILE = "kbp_e2e";
const SESSION = "sess_e2e";

const dirs: string[] = [];
function tmpRoot(label = "penny-kb-e2e"): string {
  const d = mkdtempSync(path.join(tmpdir(), label + "-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Two admitted sources, minted under the profile (same path the CLI uses). */
function seedSources(projectRoot: string): string[] {
  const srcDir = tmpRoot("penny-kb-e2e-src");
  writeFileSync(
    path.join(srcDir, "source-a.md"),
    "Two of three acknowledgements satisfy quorum when the chair abstains.",
    { mode: 0o600 }
  );
  writeFileSync(
    path.join(srcDir, "source-b.md"),
    "A sealed candidate set is the smallest unit of publication review.",
    { mode: 0o600 }
  );
  const capA = mintSourceCapability({
    projectRoot,
    kbProfileId: PROFILE,
    sessionId: SESSION,
    allowedOperation: "ingest",
    absolutePath: path.join(srcDir, "source-a.md"),
    title: "Quorum note",
    authors: ["Ada Lovelace"],
    sourceType: "manual",
    mediaType: "text/markdown",
  });
  const capB = mintSourceCapability({
    projectRoot,
    kbProfileId: PROFILE,
    sessionId: SESSION,
    allowedOperation: "ingest",
    absolutePath: path.join(srcDir, "source-b.md"),
    title: "Sealing note",
    authors: ["Grace Hopper"],
    sourceType: "manual",
    mediaType: "text/markdown",
  });
  return [capA.capability_id, capB.capability_id];
}

/** Deterministic bodies for each phase (the fake agent). */
function fakeBodies(capIds: readonly string[]): Record<string, string> {
  const [capA, capB] = capIds;
  const claims = JSON.stringify({
    schema_version: 1,
    artifact_kind: "claims",
    source_ids: [...capIds],
    claims: [
      {
        provisional_id: "candidate_e2e_1",
        text: "Two of three acknowledgements satisfy quorum when the chair abstains.",
        kind: "fact",
        confidence: "PROBABLE",
        evidence: [{ source_id: capA, locator: "line 1" }],
      },
      {
        provisional_id: "candidate_e2e_2",
        text: "A sealed candidate set is the smallest unit of publication review.",
        kind: "fact",
        confidence: "PROBABLE",
        evidence: [{ source_id: capB, locator: "line 1" }],
      },
    ],
  });
  const page = JSON.stringify({
    schema_version: 1,
    artifact_kind: "page_draft",
    pages: [
      {
        frontmatter: {
          schema_version: 1,
          page_id: "page_e2e",
          revision_id: "rev_e2e",
          kind: "synthesis",
          title: "Quorum and sealing",
          summary: "Synthesis of the two admitted notes.",
          authority: "advisory",
          lifecycle: "validated",
          created_at: new Date().toISOString(),
          derived_from: [...capIds],
          related_page_ids: [],
        },
        markdown:
          "## Synthesis\nTwo notes converge on reviewable, sealed units.\n" +
          "## Evidence\n- Quorum note (manual).\n- Sealing note (manual).\n" +
          "## Tensions and unknowns\n- None recorded.\n## Related\n- None.\n",
        claims: {
          schema_version: 1,
          page_id: "page_e2e",
          revision_id: "rev_e2e",
          claims: [
            {
              claim_id: "clm_e2e_1",
              text: "Two of three acknowledgements satisfy quorum when the chair abstains.",
              kind: "fact",
              state: "supported",
              confidence: "PROBABLE",
              evidence: [{ source_id: capA, locator: "line 1" }],
              contradicts_claim_ids: [],
              canonical_verification_refs: [],
            },
            {
              claim_id: "clm_e2e_2",
              text: "A sealed candidate set is the smallest unit of publication review.",
              kind: "fact",
              state: "supported",
              confidence: "PROBABLE",
              evidence: [{ source_id: capB, locator: "line 1" }],
              contradicts_claim_ids: [],
              canonical_verification_refs: [],
            },
          ],
        },
      },
    ],
  });
  const lint = JSON.stringify({
    schema_version: 1,
    artifact_kind: "lint_report",
    findings: [],
    candidate_conflicts: [],
  });
  const verify = JSON.stringify({
    schema_version: 1,
    artifact_kind: "verification_report",
    verified_artifact_ids: [],
    claim_findings: [
      {
        page_id: "page_e2e",
        revision_id: "rev_e2e",
        claim_id: "clm_e2e_1",
        verdict: "supported",
        evidence: [{ evidence_id: "evidence_e2e_quorum", kind: "source", ref: capA }],
      },
      {
        page_id: "page_e2e",
        revision_id: "rev_e2e",
        claim_id: "clm_e2e_2",
        verdict: "supported",
        evidence: [{ evidence_id: "evidence_e2e_sealing", kind: "source", ref: capB }],
      },
    ],
  });
  return { ingest: claims, compose: page, lint, verify };
}

interface Stack {
  projectRoot: string;
  runId: string;
  kbRoot: string;
  checkpointer: Checkpointer;
  engine: OrchestrationEngine;
  worker: KbWorkerClient;
  artifactRoot: string;
}

/** The engine stack the extension builds for a KB run. */
function buildStack(
  projectRoot: string,
  capIds: readonly string[],
  bodies: Record<string, string>
): Stack {
  const runId = `kb-e2e-${Math.random().toString(16).slice(2, 10)}`;
  const kbRoot = path.join(projectRoot, "private-kb");
  const dbPath = path.join(projectRoot, ".penny", "orchestration-e2e.db");
  const artifactRoot = path.join(projectRoot, ".penny", "e2e-artifacts");
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });

  const checkpointer = new Checkpointer(dbPath);
  const artifacts = new ArtifactStore(artifactRoot);
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot,
    maxSteps: 40,
    artifactRevisions: artifacts,
    playbookName: "knowledge-base",
  });
  let composeAllocation:
    | {
        page_id: string;
        revision_id: string;
        lifecycle: "draft";
        claim_allocations: Array<{ claim_id: string }>;
        supersedes: null | { revision_id: string };
      }
    | undefined;
  const worker = new KbWorkerClient({
    projectRoot,
    checkpointer,
    kbRoot,
    runId,
    sessionId: SESSION,
    profileId: PROFILE,
    operation: "ingest",
    sourceCapabilityIds: capIds,
    testOnlyAgentRunner: createTestOnlyArtifactBodyRunner(async (inv: KbPhaseInvocation) => {
      const body = fakeBodies(inv.sourceAllowlist)[inv.stateId];
      if (body === undefined) throw new Error(`e2e: no body for ${inv.stateId}`);
      if (inv.stateId === "compose") {
        const brief = JSON.parse(inv.readPhaseBrief?.() ?? "{}") as {
          compose_authority?: { allocations?: Array<NonNullable<typeof composeAllocation>> };
        };
        composeAllocation = brief.compose_authority?.allocations?.[0];
        if (composeAllocation === undefined) throw new Error("e2e compose allocation is absent");
        const parsed = JSON.parse(body) as {
          pages: Array<{
            frontmatter: Record<string, unknown>;
            claims: {
              page_id: string;
              revision_id: string;
              claims: Array<Record<string, unknown>>;
            };
          }>;
        };
        const page = parsed.pages[0]!;
        page.frontmatter.page_id = composeAllocation.page_id;
        page.frontmatter.revision_id = composeAllocation.revision_id;
        page.frontmatter.lifecycle = composeAllocation.lifecycle;
        page.claims.page_id = composeAllocation.page_id;
        page.claims.revision_id = composeAllocation.revision_id;
        for (const [index, claim] of page.claims.claims.entries()) {
          claim.claim_id = composeAllocation.claim_allocations[index]!.claim_id;
        }
        return JSON.stringify(parsed);
      }
      if (inv.stateId === "verify" && composeAllocation !== undefined) {
        const parsed = JSON.parse(body) as {
          claim_findings: Array<Record<string, unknown>>;
        };
        for (const [index, finding] of parsed.claim_findings.entries()) {
          finding.page_id = composeAllocation.page_id;
          finding.revision_id = composeAllocation.revision_id;
          finding.claim_id = composeAllocation.claim_allocations[index]!.claim_id;
        }
        return JSON.stringify(parsed);
      }
      return body;
    }),
  });
  return { projectRoot, runId, kbRoot, checkpointer, engine, worker, artifactRoot };
}

/** start → (agent loop) → the review gate. Returns the awaiting directive. */
async function driveToGate(stack: Stack, capIds: readonly string[]): Promise<Directive> {
  const workers = new WorkerExecutor(stack.worker, new ArtifactStore(stack.artifactRoot), {
    projectRoot: stack.projectRoot,
    parallelConcurrency: 1,
    workerTimeoutMs: 20_000,
  });
  workers.setReceiptAuthority(stack.engine.receiptAuthority);
  const runner = new OrchestrationRunner(stack.engine, workers);
  const identity = {
    schema_version: 2 as const,
    run_id: stack.runId,
    session_id: SESSION,
    playbook: "knowledge-base",
    engine_owner: "typescript" as const,
  };
  const goal = "Ingest the admitted sources and produce a reviewable candidate page set.";
  const constraints = {
    action: "ingest",
    kb_profile_id: PROFILE,
    source_capability_ids: [...capIds],
    // §5.3: host-supplied active parent identity. Admission denies without it.
    parent_identity: { ...E2E_PARENT },
  };
  const context = RunContext.create({
    identity,
    goal,
    constraints,
    projectRoot: stack.projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 40,
  });
  context.playbookData.action = "ingest";
  context.playbookData.profile_id = PROFILE;
  admitOperationStart({
    projectRoot: stack.projectRoot,
    checkpointer: stack.checkpointer,
    context,
    session_id: SESSION,
    invocation_id: `call_${stack.runId}`,
    action: "ingest",
    profile_id: PROFILE,
    request: {
      schema_version: 1,
      action: "ingest",
      kb_profile_id: PROFILE,
      source_capability_ids: [...capIds],
    },
  });
  return runner.runUntilBoundary(
    stack.engine.handle({
      schema_version: 2,
      action: "start",
      identity,
      goal,
      constraints,
      project_root: stack.projectRoot,
      trust_profile: "hardened-untrusted",
    }),
    undefined
  );
}

/** The host decision path, exactly as the CLI drives the authenticated facade. */
function respond(stack: Stack, response: "approve" | "deny"): Directive {
  return new ContentReviewService({
    projectRoot: stack.projectRoot,
    checkpointer: stack.checkpointer,
    engine: stack.engine,
    reviewer: authenticateLocalContentReviewer(),
  }).decide({ runId: stack.runId, decision: response });
}

describe("KB through the engine (step 4)", () => {
  it("runs all four phases, stops at the review gate, and approves host-side", async () => {
    const projectRoot = tmpRoot();
    const kbRoot = path.join(projectRoot, "private-kb");
    installGrantedProfile({ projectRoot, kbRoot, profileId: PROFILE, sessionId: SESSION });
    initKb({ kbRoot, profileId: PROFILE, runId: "kb-init-e2e" }, "E2E KB");
    installTestPolicy(kbRoot);
    const capIds = seedSources(projectRoot);
    const stack = buildStack(projectRoot, capIds, fakeBodies(capIds));

    const directive = await driveToGate(stack, capIds);

    // The run stopped exactly at the human content-review gate.
    expect(directive.action).toBe("await_user");
    const run = stack.checkpointer.loadRunById(stack.runId);
    expect(run?.status).toBe("awaiting_user");

    // The canonical control-DB packet is pending and binds the exact three
    // review artifacts plus the admitted source-record map.
    const gate = stack.checkpointer.contentReviewForRun(stack.runId);
    expect(gate?.state).toBe("awaiting");
    expect(gate?.packet.candidate_artifacts).toHaveLength(3);
    const admittedSourceIds = (run?.playbookData.source_ids ?? []) as string[];
    expect(Object.keys(gate?.packet.candidate_source_record_digests ?? {})).toEqual(
      [...admittedSourceIds].sort()
    );
    for (const sourceId of admittedSourceIds) {
      expect(sourceId).toMatch(/^src_[a-f0-9]{32}$/);
      expect(capIds).not.toContain(sourceId);
    }

    // Review has work-plane snapshots only: no source publication path exists.
    expect(existsSync(path.join(kbRoot, "sources"))).toBe(false);

    // Capability leases are still claimed (approval has not happened).
    const capStore = new CapabilityStore(projectRoot);
    try {
      for (const capId of capIds) {
        expect(capStore.lease(capId)?.state).toBe("claimed");
      }
    } finally {
      capStore.close();
    }

    // HOST approval — the canonical path (engine respond protocol).
    const terminal = respond(stack, "approve");
    expect(terminal.action).toBe("complete");
    const result = ((terminal as { result?: Record<string, unknown> }).result ?? {}) as Record<
      string,
      unknown
    >;
    const genId = String(result["published_generation_id"] ?? "");
    expect(genId).toMatch(/^gen_/);
    expect(((result["published_counts"] ?? {}) as Record<string, number>)["pages"]).toBe(1);

    // Publication is real: the selector advanced; the page is queryable.
    expect(readSelectedGeneration(kbRoot)?.selector?.generation_id).toBe(genId);
    const queryControl = kbArtifactControl({
      root: projectRoot,
      runId: "kb-e2e-q",
      profileId: PROFILE,
      action: "query",
    });
    const q = queryKb(
      { kbRoot, profileId: PROFILE, runId: "kb-e2e-q", checkpointer: queryControl },
      "quorum acknowledgement"
    );
    expect(q.met).toBe(true);

    const capStore2 = new CapabilityStore(projectRoot);
    try {
      for (const capId of capIds) {
        expect(capStore2.lease(capId)?.state).toBe("consumed");
      }
    } finally {
      capStore2.close();
    }
    expect(stack.checkpointer.contentReviewForRun(stack.runId)?.state).toBe("consumed");

    // A second decision on the same run is refused (terminal, gate decided).
    expect(() => respond(stack, "approve")).toThrow();

    stack.worker.close();
    stack.checkpointer.close();
  });

  it("refuses gate continuation when the admitted policy changes", async () => {
    const projectRoot = tmpRoot();
    const kbRoot = path.join(projectRoot, "private-kb");
    installGrantedProfile({ projectRoot, kbRoot, profileId: PROFILE, sessionId: SESSION });
    initKb({ kbRoot, profileId: PROFILE, runId: "kb-init-e2e" }, "E2E KB drift");
    installTestPolicy(kbRoot);
    const capIds = seedSources(projectRoot);
    const stack = buildStack(projectRoot, capIds, fakeBodies(capIds));
    const selectorBefore = readSelectedGeneration(kbRoot)?.selector?.generation_id;
    await driveToGate(stack, capIds);

    const changed = readPolicy(kbRoot);
    writePolicy(kbRoot, {
      ...changed,
      reader_limits: { ...changed.reader_limits, max_calls_per_phase: 15 },
    });
    expect(() => respond(stack, "approve")).toThrow(/policy changed after review/);
    const terminal = stack.checkpointer.loadRunById(stack.runId)?.terminalDirective;
    expect(terminal?.action).toBe("incomplete");
    expect(terminal?.met).toBe(false);
    expect(terminal?.unresolved).toContain("content_review_drift");
    expect(readSelectedGeneration(kbRoot)?.selector?.generation_id).toBe(selectorBefore);
    stack.checkpointer.close();
  });

  it("denies host-side: no publication, leases invalidated, honest incomplete terminal", async () => {
    const projectRoot = tmpRoot();
    const kbRoot = path.join(projectRoot, "private-kb");
    installGrantedProfile({ projectRoot, kbRoot, profileId: PROFILE, sessionId: SESSION });
    initKb({ kbRoot, profileId: PROFILE, runId: "kb-init-e2e" }, "E2E KB deny");
    installTestPolicy(kbRoot);
    const capIds = seedSources(projectRoot);
    const stack = buildStack(projectRoot, capIds, fakeBodies(capIds));
    const selectorBefore = readSelectedGeneration(kbRoot)?.selector?.generation_id;

    const directive = await driveToGate(stack, capIds);
    expect(directive.action).toBe("await_user");

    const terminal = respond(stack, "deny");
    expect(terminal.action).toBe("incomplete");
    expect((terminal as { met?: boolean }).met).toBe(false);

    // Nothing published: the selector is exactly where it was before.
    expect(readSelectedGeneration(kbRoot)?.selector?.generation_id).toBe(selectorBefore);
    expect(existsSync(path.join(kbRoot, "pages"))).toBe(false);

    const capStore = new CapabilityStore(projectRoot);
    try {
      for (const capId of capIds) {
        expect(capStore.lease(capId)?.state).toBe("invalidated");
      }
    } finally {
      capStore.close();
    }
    expect(stack.checkpointer.contentReviewForRun(stack.runId)?.state).toBe("denied");

    // A late approval of a denied run is refused.
    expect(() => respond(stack, "approve")).toThrow();

    stack.worker.close();
    stack.checkpointer.close();
  });
});
