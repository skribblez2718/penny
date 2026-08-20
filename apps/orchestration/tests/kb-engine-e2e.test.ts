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
import { findGateForRun, mintSourceCapability } from "../src/kb/gate.js";
import { readSelectedGeneration } from "../src/kb/generations.js";
import { CapabilityStore } from "../src/kb/capabilities.js";
import { KbWorkerClient } from "../src/kb/kb-worker-client.js";
import { Checkpointer } from "../src/checkpointer.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { OrchestrationEngine } from "../src/engine.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";
import type { KbPhaseInvocation } from "../src/kb/session-tools.js";
import type { Directive } from "../src/contracts.js";

const PROFILE = "kbp_e2e";

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
function seedSources(kbRoot: string): string[] {
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
    kbRoot,
    kbProfileId: PROFILE,
    absolutePath: path.join(srcDir, "source-a.md"),
    title: "Quorum note",
    authors: ["Ada Lovelace"],
    sourceType: "manual",
    mediaType: "text/markdown",
  });
  const capB = mintSourceCapability({
    kbRoot,
    kbProfileId: PROFILE,
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
        claim_id: "clm_e2e_1",
        text: "Two of three acknowledgements satisfy quorum when the chair abstains.",
        kind: "fact",
        state: "supported",
        confidence: "PROBABLE",
        evidence: [{ source_id: capA }],
        contradicts_claim_ids: [],
        canonical_verification_refs: [],
      },
      {
        claim_id: "clm_e2e_2",
        text: "A sealed candidate set is the smallest unit of publication review.",
        kind: "fact",
        state: "supported",
        confidence: "PROBABLE",
        evidence: [{ source_id: capB }],
        contradicts_claim_ids: [],
        canonical_verification_refs: [],
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
            },
            {
              claim_id: "clm_e2e_2",
              text: "A sealed candidate set is the smallest unit of publication review.",
              kind: "fact",
              state: "supported",
              confidence: "PROBABLE",
              evidence: [{ source_id: capB, locator: "line 1" }],
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
        claim_ref: { page_id: "page_e2e", revision_id: "rev_e2e", claim_id: "clm_e2e_1" },
        verdict: "supported",
        notes: "cited to the admitted quorum note",
      },
      {
        claim_ref: { page_id: "page_e2e", revision_id: "rev_e2e", claim_id: "clm_e2e_2" },
        verdict: "supported",
        notes: "cited to the admitted sealing note",
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
  const kbRoot = path.join(projectRoot, ".penny", "kb", PROFILE);
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
  const worker = new KbWorkerClient({
    projectRoot,
    kbRoot,
    runId,
    profileId: PROFILE,
    sourceCapabilityIds: capIds,
    agentRunner: (async (inv: KbPhaseInvocation) => {
      const body = bodies[inv.stateId];
      if (body === undefined) throw new Error(`e2e: no body for ${inv.stateId}`);
      return body;
    }) as never,
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
  return runner.runUntilBoundary(
    stack.engine.handle({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: stack.runId,
        session_id: "sess_e2e",
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "Ingest the admitted sources and produce a reviewable candidate page set.",
      constraints: {
        action: "ingest",
        kb_profile_id: PROFILE,
        source_capability_ids: [...capIds],
        // §5.3: host-supplied active parent identity. Admission denies without it.
        parent_identity: { ...E2E_PARENT },
      },
      project_root: stack.projectRoot,
      trust_profile: "hardened-untrusted",
    }),
    undefined
  );
}

/** The host decision path, exactly as the CLI drives it (engine respond). */
function respond(stack: Stack, response: "approve" | "deny"): Directive {
  const run = stack.checkpointer.loadRunById(stack.runId);
  if (run === undefined) throw new Error("e2e: run missing");
  const pending = run.pendingDirective;
  if (pending?.action !== "await_user") throw new Error("e2e: not at the gate");
  return stack.engine.handle({
    schema_version: 2,
    action: "respond",
    identity: run.identity,
    gate_id: pending.gate_id,
    challenge: pending.challenge,
    response,
  });
}

describe("KB through the engine (step 4)", () => {
  it("runs all four phases, stops at the review gate, and approves host-side", async () => {
    const projectRoot = tmpRoot();
    const kbRoot = path.join(projectRoot, ".penny", "kb", PROFILE);
    initKb({ kbRoot, profileId: PROFILE, runId: "kb-init-e2e" }, "E2E KB");
    installTestPolicy(kbRoot);
    const capIds = seedSources(kbRoot);
    const stack = buildStack(projectRoot, capIds, fakeBodies(capIds));

    const directive = await driveToGate(stack, capIds);

    // The run stopped exactly at the human content-review gate.
    expect(directive.action).toBe("await_user");
    const run = stack.checkpointer.loadRunById(stack.runId);
    expect(run?.status).toBe("awaiting_user");

    // The gate row is pending, bound to the four sealed candidate artifacts and
    // to the admitted capability ids.
    const gate = findGateForRun(kbRoot, stack.runId);
    expect(gate?.status).toBe("awaiting");
    expect(gate?.artifacts).toHaveLength(4);
    expect(gate?.source_capability_ids).toEqual(capIds);

    // Admitted source objects exist (the plane admitted before any agent work).
    expect(existsSync(path.join(kbRoot, "sources", "objects"))).toBe(true);

    // Capability leases are still claimed (approval has not happened).
    const capStore = new CapabilityStore(kbRoot);
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
    const q = queryKb({ kbRoot, profileId: PROFILE, runId: "kb-e2e-q" }, "quorum acknowledgement");
    expect(q.met).toBe(true);

    const capStore2 = new CapabilityStore(kbRoot);
    try {
      for (const capId of capIds) {
        expect(capStore2.lease(capId)?.state).toBe("consumed");
      }
    } finally {
      capStore2.close();
    }
    expect(findGateForRun(kbRoot, stack.runId)?.status).toBe("approved");

    // A second decision on the same run is refused (terminal, gate decided).
    expect(() => respond(stack, "approve")).toThrow();

    stack.worker.close();
    stack.checkpointer.close();
  });

  it("denies host-side: no publication, leases invalidated, honest incomplete terminal", async () => {
    const projectRoot = tmpRoot();
    const kbRoot = path.join(projectRoot, ".penny", "kb", PROFILE);
    initKb({ kbRoot, profileId: PROFILE, runId: "kb-init-e2e" }, "E2E KB deny");
    installTestPolicy(kbRoot);
    const capIds = seedSources(kbRoot);
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

    const capStore = new CapabilityStore(kbRoot);
    try {
      for (const capId of capIds) {
        expect(capStore.lease(capId)?.state).toBe("invalidated");
      }
    } finally {
      capStore.close();
    }
    expect(findGateForRun(kbRoot, stack.runId)?.status).toBe("denied");

    // A late approval of a denied run is refused.
    expect(() => respond(stack, "approve")).toThrow();

    stack.worker.close();
    stack.checkpointer.close();
  });
});
