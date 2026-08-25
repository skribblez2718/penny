import { requireValue } from "./helpers/narrowing.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { canonicalJson, sha256, Checkpointer } from "../src/checkpointer.js";
import type {
  ArtifactRef,
  JsonValue,
  OutputArtifactMetadata,
  RunIdentity,
} from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import {
  canonicalAssistantText,
  createWorkerResourceLoader,
  parseSsotTools,
  type InlineExtension,
  type ModelClient,
} from "../src/model-client.js";
import { WorkerExecutor } from "../src/worker.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-orch-safety-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function identity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: "safety-session",
    playbook: "research",
    engine_owner: "typescript",
  };
}

function startRequest(
  root: string,
  runIdentity: RunIdentity,
  constraints: Record<string, JsonValue> = { mode: "quick" }
): unknown {
  return {
    schema_version: 2,
    action: "start",
    identity: runIdentity,
    goal: "safety test goal",
    constraints,
    project_root: root,
    trust_profile: "hardened-untrusted",
  };
}

function metadata(
  runId: string,
  version = 1,
  parent: ArtifactRef | null = null
): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: runId,
    phase: "researching",
    branch_id: null,
    kind: "agent-output",
    operation_id: "agent-operation:safety",
    version,
    producer: "agent:echo",
    media_type: "text/plain; charset=utf-8",
    parent_ref: parent,
    upstream_refs: [],
  };
}

const completeResearchClient: ModelClient = {
  async runAgent() {
    return {
      text: "cited findings",
      confidence: "PROBABLE",
      details: { explore_complete: true },
    };
  },
};

const planningResearchClient: ModelClient = {
  async runAgent(invocation) {
    if (invocation.stateId === "planning") {
      return {
        text: "plan",
        confidence: "CERTAIN",
        details: {
          plan_steps: ["first sub-query", "second sub-query"],
          plan_complete: true,
        },
      };
    }
    return {
      text: `findings for ${invocation.task}`,
      confidence: "PROBABLE",
      details: { explore_complete: true },
    };
  },
};

describe("artifact and receipt safety", () => {
  it("keeps an immutable manifest with idempotence, revision CAS, and direct reads", () => {
    const root = temporaryRoot();
    using store = new ArtifactStore(path.join(root, "artifacts"));
    const firstMetadata = metadata("manifest-run");
    const first = store.persist({
      metadata: firstMetadata,
      content: "first exact bytes",
    });
    expect(store.persist({ metadata: firstMetadata, content: "first exact bytes" })).toEqual(first);
    expect(() => store.persist({ metadata: firstMetadata, content: "divergent bytes" })).toThrow(
      "diverged"
    );
    store.select(first);
    expect(store.selected("manifest-run", "researching", null)).toEqual(first);
    expect(store.read(first).toString("utf8")).toBe("first exact bytes");
    expect(store.readById(first.artifact_id).toString("utf8")).toBe("first exact bytes");

    const secondMetadata = metadata("manifest-run", 2, first);
    const second = store.persist({
      metadata: secondMetadata,
      content: "second exact bytes",
    });
    store.select(second);
    expect(store.selected("manifest-run", "researching", null)).toEqual(second);
    expect(() => store.select(first)).toThrow("first revision");
  });

  it("continues an orphaned revision chain instead of diverging (crash between persist and accept)", async () => {
    const root = temporaryRoot();
    using store = new ArtifactStore(path.join(root, "artifacts"));
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const runIdentity = identity("orphan-revision-run");
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
      artifactRevisions: store,
    });
    // Simulate a prior fan round whose branch output was persisted by a worker
    // that was interrupted before the engine accepted the result (crash window):
    // the immutable ledger holds v1, but the checkpoint has no selection for it.
    const orphanOperation = `agent-operation:${sha256(
      canonicalJson({
        branch_id: "sq2",
        kind: "agent-output",
        run_id: runIdentity.run_id,
        state: "researching",
      })
    )}`;
    const orphan = store.persist({
      metadata: {
        schema_version: 2,
        run_id: runIdentity.run_id,
        phase: "researching",
        branch_id: "sq2",
        kind: "agent-output",
        operation_id: orphanOperation,
        version: 1,
        producer: "agent:echo",
        media_type: "text/plain; charset=utf-8",
        parent_ref: null,
        upstream_refs: [],
      },
      content: "orphaned interrupted output",
    });

    const fanClient: ModelClient = {
      async runAgent(invocation) {
        if (invocation.stateId === "planning") {
          return {
            text: "plan",
            confidence: "CERTAIN",
            details: {
              plan_steps: ["first sub-query", "second sub-query"],
              plan_complete: true,
              mode: "standard",
            },
          };
        }
        return {
          text: `findings for ${invocation.task}`,
          confidence: "PROBABLE",
          details: { explore_complete: true },
        };
      },
    };
    const workers = new WorkerExecutor(fanClient, store, {
      projectRoot: root,
      parallelConcurrency: 2,
    });
    workers.setReceiptAuthority(engine.receiptAuthority);

    const planning = engine.handle(startRequest(root, runIdentity, { mode: "standard" }));
    if (planning.action !== "invoke_agent") {
      throw new Error("expected a planning directive");
    }
    const fan = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: requireValue(
        (await workers.execute(planning))[0],
        "apps/orchestration/tests/safety.test.ts:215"
      ),
    });
    if (fan.action !== "invoke_agents_parallel") {
      throw new Error("expected a research fan");
    }
    const sq1 = fan.branches.find((branch) => branch.branch_id === "sq1");
    const sq2 = fan.branches.find((branch) => branch.branch_id === "sq2");
    if (sq1 === undefined || sq2 === undefined) {
      throw new Error("fan must contain sq1 and sq2");
    }
    // The branch that owns the orphan continues the ledger chain; the clean
    // branch starts at v1 exactly as before.
    expect(sq2.output_artifact.version).toBe(2);
    expect(sq2.output_artifact.parent_ref?.artifact_id).toBe(orphan.artifact_id);
    expect(sq1.output_artifact.version).toBe(1);
    expect(sq1.output_artifact.parent_ref).toBeNull();

    // Persisting the new attempt for sq2 must not diverge from the orphan,
    // and the engine must accept both branch results (with the selection
    // store seeded from the ledger for the interrupted slot).
    const results = await workers.execute(fan);
    for (const result of results) {
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result,
      });
      workers.acceptArtifact(result);
    }
    const selectedSq2 = store.selected(runIdentity.run_id, "researching", "sq2");
    const selectedSq1 = store.selected(runIdentity.run_id, "researching", "sq1");
    if (selectedSq2 === undefined || selectedSq1 === undefined) {
      throw new Error("accepted fan artifacts were not selected");
    }
    expect(selectedSq2.version).toBe(2);
    expect(selectedSq1.version).toBe(1);
    checkpointer.close();
  });

  it("fails closed on a non-contiguous parent for an interrupted slot", () => {
    const root = temporaryRoot();
    using store = new ArtifactStore(path.join(root, "artifacts"));
    const runId = "stale-seed-run";
    const orphanV1 = store.persist({
      metadata: metadata(runId, 1, null),
      content: "orphaned v1",
    });
    const orphanV2 = store.persist({
      metadata: metadata(runId, 2, orphanV1),
      content: "orphaned v2",
    });
    // A stale revision pointing at orphanV1 while claiming v3 breaks the
    // contiguous parent chain and is rejected before persistence.
    expect(() =>
      store.persist({ metadata: metadata(runId, 3, orphanV1), content: "stale" })
    ).toThrow("parent_ref");
    // A true continuation of the ledger top is still admitted.
    const ok = store.persist({
      metadata: metadata(runId, 3, orphanV2),
      content: "ledger-top continuation",
    });
    expect(ok.version).toBe(3);
  });

  it("rebinds a saved pending directive to the ledger top on recovery", async () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration-v2.db");
    const checkpointer = new Checkpointer(dbPath);
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const wiredEngine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
      artifactRevisions: artifacts,
    });
    const workers = new WorkerExecutor(planningResearchClient, artifacts, {
      projectRoot: root,
      parallelConcurrency: 2,
    });
    workers.setReceiptAuthority(wiredEngine.receiptAuthority);
    const runIdentity = identity("rebind-run");
    const planning = wiredEngine.handle(startRequest(root, runIdentity, { mode: "standard" }));
    const planned = requireValue(
      (await workers.execute(planning))[0],
      "apps/orchestration/tests/safety.test.ts:297"
    );
    const fan = wiredEngine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: planned,
    });
    if (fan.action !== "invoke_agents_parallel") {
      throw new Error(`expected parallel fan directive, received ${fan.action}`);
    }
    const branch = requireValue(fan.branches[1], "apps/orchestration/tests/safety.test.ts:304");
    expect(branch.output_artifact.version).toBe(1);
    expect(branch.output_artifact.parent_ref).toBeNull();
    // A worker for this branch crashed between persist and accept: an
    // orphaned v1 for the same operation now occupies the ledger.
    const orphan = artifacts.persist({
      metadata: branch.output_artifact,
      content: "orphaned by the crashed worker",
    });
    const recovered = wiredEngine.handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    if (recovered.action !== "invoke_agents_parallel") {
      throw new Error(`expected recovered parallel directive, received ${recovered.action}`);
    }
    const rebound = requireValue(
      recovered.branches[1],
      "apps/orchestration/tests/safety.test.ts:318"
    );
    expect(rebound.output_artifact.version).toBe(2);
    expect(rebound.output_artifact.parent_ref?.artifact_id).toBe(orphan.artifact_id);
    expect(rebound.output_artifact.parent_ref?.version).toBe(1);
    // Unaffected branches keep their first-revision spec.
    expect(
      requireValue(recovered.branches[0], "apps/orchestration/tests/safety.test.ts:323")
        .output_artifact.version
    ).toBe(1);
    expect(
      requireValue(recovered.branches[0], "apps/orchestration/tests/safety.test.ts:324")
        .output_artifact.parent_ref
    ).toBeNull();
    checkpointer.close();
  });

  it("rejects receipt-signature and artifact-ref tampering without advancing", async () => {
    const root = temporaryRoot();
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
    });
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const workers = new WorkerExecutor(completeResearchClient, artifacts, {
      projectRoot: root,
      parallelConcurrency: 1,
    });
    workers.setReceiptAuthority(engine.receiptAuthority);
    const runIdentity = identity("tamper-run");
    const pending = engine.handle(startRequest(root, runIdentity));
    const valid = requireValue(
      (await workers.execute(pending))[0],
      "apps/orchestration/tests/safety.test.ts:343"
    );
    const signature = valid.worker_receipt.signature;
    const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result: {
          ...valid,
          worker_receipt: {
            ...valid.worker_receipt,
            signature: tamperedSignature,
          },
        },
      })
    ).toThrow("invalid signature");

    const changedDigest = "f".repeat(64);
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result: {
          ...valid,
          output_artifact: {
            ...valid.output_artifact,
            content_digest: changedDigest,
            store_ref: `artifact://sha256/${changedDigest}`,
          },
        },
      })
    ).toThrow("output artifact mismatch");
    expect(
      engine.handle({
        schema_version: 2,
        action: "recover",
        identity: runIdentity,
      })
    ).toEqual(pending);
    checkpointer.close();
  });

  it("persists exact output but never parses prose into routing control", async () => {
    const root = temporaryRoot();
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
    });
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const malformedText = "complete findings\nSUMMARY: not-json";
    const client: ModelClient = {
      async runAgent() {
        return { text: malformedText };
      },
    };
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: root,
      parallelConcurrency: 1,
    });
    workers.setReceiptAuthority(engine.receiptAuthority);
    const pending = engine.handle(startRequest(root, identity("persist-before-parse")));
    if (pending.action !== "invoke_agent") {
      throw new Error("expected invoke directive");
    }
    const malformedResult = requireValue(
      (await workers.execute(pending))[0],
      "apps/orchestration/tests/safety.test.ts:410"
    );
    expect(malformedResult.details).toEqual({});
    const retry = engine.handle({
      schema_version: 2,
      action: "step",
      identity: pending.identity,
      result: malformedResult,
    });
    expect(retry.action).toBe("invoke_agent");
    if (retry.action === "invoke_agent") {
      expect(retry.output_artifact.version).toBe(2);
      expect(retry.output_artifact.parent_ref).toEqual(malformedResult.output_artifact);
    }
    workers.acceptArtifact(malformedResult);
    expect(
      artifacts.read(malformedResult.output_artifact, "state:researching").toString("utf8")
    ).toBe(malformedText);
    checkpointer.close();
  });
});

describe("dispatch and worker isolation", () => {
  it("pauses fail-closed without checkpoint mutation and resumes exact work", async () => {
    const root = temporaryRoot();
    let mode = "active";
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
      dispatchMode: () => mode,
    });
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const workers = new WorkerExecutor(completeResearchClient, artifacts, {
      projectRoot: root,
      parallelConcurrency: 1,
    });
    workers.setReceiptAuthority(engine.receiptAuthority);
    const runIdentity = identity("pause-run");
    const pending = engine.handle(startRequest(root, runIdentity));
    const workerResult = requireValue(
      (await workers.execute(pending))[0],
      "apps/orchestration/tests/safety.test.ts:449"
    );
    const before = checkpointer.loadRun(runIdentity).snapshot();
    const eventsBefore = checkpointer.events(runIdentity.run_id);
    mode = "paused";
    expect(
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result: workerResult,
      }).action
    ).toBe("paused");
    expect(checkpointer.loadRun(runIdentity).snapshot()).toEqual(before);
    expect(checkpointer.events(runIdentity.run_id)).toEqual(eventsBefore);
    mode = "invalid-value";
    const invalid = engine.handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    expect(invalid.action).toBe("paused");
    if (invalid.action === "paused") {
      expect(invalid.code).toBe("DISPATCH_MODE_INVALID");
    }
    mode = "active";
    expect(
      engine.handle({
        schema_version: 2,
        action: "recover",
        identity: runIdentity,
      })
    ).toEqual(pending);
    checkpointer.close();
  });

  it("uses canonical no-separator final assistant text", () => {
    expect(
      canonicalAssistantText([
        { role: "assistant", content: [{ type: "text", text: "old" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "alpha " },
            { type: "thinking", thinking: "secret" },
            { type: "text", text: "beta" },
          ],
        },
      ])
    ).toBe("alpha beta");
  });

  it("loads every provider extension before applying the exact YAML allowlist", async () => {
    const projectRoot = path.resolve("../..");
    const loader = await createWorkerResourceLoader(projectRoot);
    const paths = loader.getExtensions().extensions.map((extension) => extension.resolvedPath);
    expect(paths.some((extensionPath) => extensionPath.includes("/memory/"))).toBe(true);
    expect(paths.some((extensionPath) => extensionPath.includes("/artifacts/"))).toBe(true);
    expect(paths.some((extensionPath) => extensionPath.includes("/playwright/"))).toBe(true);
  });

  it("loads an owner-supplied extension factory (the seam is extension-agnostic)", async () => {
    const projectRoot = path.resolve("../..");
    // The app is extension-agnostic: it loads the extension factories the
    // execution owner supplies. A stand-in factory proves the seam without
    // coupling the app (or its tests) to any specific extension package.
    const factory: ExtensionFactory = (pi) => {
      void pi;
    };
    const inline: InlineExtension = { name: "stub-read", factory, hidden: true };

    const base = await createWorkerResourceLoader(projectRoot);
    const baseCount = base.getExtensions().extensions.length;

    // the owner-supplied inline extension loads (exactly one extra extension) ...
    const owner = await createWorkerResourceLoader(projectRoot, [inline]);
    expect(owner.getExtensions().extensions.length).toBe(baseCount + 1);
    // ... while the complete provider catalog remains available for YAML selection.
    const ownerPaths = owner
      .getExtensions()
      .extensions.map((extension) => extension.resolvedPath ?? "");
    expect(ownerPaths.some((p) => p.includes("/memory/"))).toBe(true);
  });

  describe("SSOT tool authority (.pi/agents/<agent>.md is the control plane)", () => {
    it("derives the worker allow-list from the agent's declared tools:", () => {
      const projectRoot = path.resolve("../..");
      const doc = readFileSync(path.join(projectRoot, ".pi", "agents", "echo.md"), "utf8");
      const tools = parseSsotTools(doc, "echo");
      // The SSOT for echo is honored wholesale — no private table overrides it.
      expect(tools).toContain("artifact_read");
      expect(tools).toContain("web_search");
      expect(tools).toContain("youtube_transcript");
      expect(tools).toContain("memory_smart_search");
      expect(tools).toContain("bash");
      // echo declares a large authority set (browser+web+memory+shell); the
      // parser must not truncate it.
      expect(tools.length).toBeGreaterThanOrEqual(30);
    });

    it("fails loudly when the SSOT is missing or empty (no silent bypass)", () => {
      expect(() => parseSsotTools("", "echo")).toThrow(/no definition/);
      expect(() => parseSsotTools("---\nname: echo\n---\nbody", "echo")).toThrow(
        /no top-level 'tools:'/
      );
      expect(() => parseSsotTools("---\ntools:\n---\nbody", "echo")).toThrow(/empty tools: entry/);
    });
  });
});
