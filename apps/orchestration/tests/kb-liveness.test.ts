import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, Checkpointer } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { validateDirective } from "../src/contracts.js";
import { kbLivenessPolicy, LivenessController, LivenessExhaustedError } from "../src/liveness.js";
import type { KbIngestPlaneV1 } from "../src/kb/ingest-plane.js";
import { operationEventForResult, replayableResultFromRun } from "../src/kb/operation-receipts.js";
import { KnowledgeBasePlaybook } from "../src/playbooks/knowledge-base.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "penny-kb-liveness-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function context(runId: string, playbook = "research"): RunContext {
  return RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: "kb-liveness-session",
      playbook,
      engine_owner: "typescript",
    },
    goal: "Synthetic private KB liveness fixture",
    constraints: playbook === "knowledge-base" ? { action: "query", kb_profile_id: "profile" } : {},
    projectRoot: "/synthetic/project",
    trustProfile: "hardened-untrusted",
    maxSteps: 96,
  });
}

const SAFE_HANDLE = {
  schema_version: 1 as const,
  artifact_id: "artifact_partial",
  artifact_kind: "query_answer",
  sha256: "a".repeat(64),
  media_type: "application/json",
  byte_length: 123,
};

describe("KB liveness and negative delivery", () => {
  it("expands the approved per-phase and per-action ceilings exactly", () => {
    expect(kbLivenessPolicy({ action: "ingest", readerMaxCallsPerPhase: 16 })).toMatchObject({
      preset: "kb-ingest",
      total_phase_repair_invocations: 8,
      tool_calls_per_worker: 22,
      model_turns_per_worker: 24,
      tool_calls_per_run: 176,
      model_turns_per_run: 192,
      external_calls_per_worker: 0,
      external_calls_per_run: 0,
      worker_wall_clock_ms: 900_000,
      run_wall_clock_ms: 5_400_000,
    });
    expect(kbLivenessPolicy({ action: "save", readerMaxCallsPerPhase: 100 })).toMatchObject({
      total_phase_repair_invocations: 7,
      tool_calls_per_worker: 70,
      model_turns_per_worker: 72,
      tool_calls_per_run: 490,
      model_turns_per_run: 504,
      run_wall_clock_ms: 5_400_000,
    });
    expect(kbLivenessPolicy({ action: "query", readerMaxCallsPerPhase: 1 })).toMatchObject({
      total_phase_repair_invocations: 5,
      tool_calls_per_worker: 7,
      model_turns_per_worker: 9,
      run_wall_clock_ms: 2_700_000,
    });
    expect(kbLivenessPolicy({ action: "promote", readerMaxCallsPerPhase: 64 })).toMatchObject({
      total_phase_repair_invocations: 5,
      tool_calls_per_worker: 70,
      model_turns_per_worker: 72,
      run_wall_clock_ms: 2_700_000,
    });
  });

  it("aborts on a second identical content-free KB protocol digest", () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const run = context("kb-protocol-run");
    checkpointer.createRun(run, "run_started", { fixture: true });
    const liveness = new LivenessController(checkpointer, () => 1_000);
    liveness.setPolicyResolver(() =>
      kbLivenessPolicy({ action: "query", readerMaxCallsPerPhase: 16 })
    );
    liveness.bindPolicy(run);
    liveness.admitInvocation({
      runId: run.identity.run_id,
      stateId: "query",
      branchId: null,
      attempt: 1,
      purpose: "phase",
    });
    liveness.startWorker({
      runId: run.identity.run_id,
      workerId: "kb-worker",
      stateId: "query",
      branchId: null,
      purpose: "phase",
    });
    const sink = liveness.sessionSink({
      runId: run.identity.run_id,
      workerId: "kb-worker",
      stateId: "query",
    });
    sink({ kind: "protocol_error", tool_name: "read_phase_brief", error_code: "schema_invalid" });
    expect(() =>
      sink({
        kind: "protocol_error",
        tool_name: "read_phase_brief",
        error_code: "schema_invalid",
      })
    ).toThrowError(new LivenessExhaustedError("identical_error_stall"));
    expect(liveness.snapshot(run.identity.run_id).protocol_errors).toBe(2);
    expect(canonicalJson(checkpointer.events(run.identity.run_id))).not.toContain(
      "PRIVATE_SENTINEL_BODY"
    );
    checkpointer.close();
  });

  it("settles action-specific KB claims before returning cancelled", () => {
    const denials: string[] = [];
    const saveSettlements: string[] = [];
    const plane: KbIngestPlaneV1 = {
      admitRun() {
        throw new Error("not used");
      },
      recheckPolicy() {},
      claim() {
        return [];
      },
      admit() {},
      seal() {},
      prepareContentReview() {
        throw new Error("not used");
      },
      persistGate() {
        throw new Error("not used");
      },
      approve() {
        throw new Error("not used");
      },
      deny(input) {
        denials.push(String(input.action));
      },
      claimSave() {
        throw new Error("not used");
      },
      settleSave(input) {
        saveSettlements.push(input.outcome);
      },
      verifyPromotion() {
        throw new Error("not used");
      },
    };
    const playbook = new KnowledgeBasePlaybook(undefined, plane, () => "/synthetic/private-kb");
    for (const action of ["ingest", "query", "save", "promote"] as const) {
      const run = context(`kb-cancel-${action}`, "knowledge-base");
      run.knowledgeBaseData.action = action;
      run.knowledgeBaseData.profile_id = "profile";
      run.knowledgeBaseData.source_capability_ids = ["source-capability"];
      run.knowledgeBaseData.target_capability_ids = ["target-capability"];
      run.knowledgeBaseData.query_run_id = "query-run";
      const terminal = playbook.cancel(run, "caller cancellation");
      expect(terminal.action).toBe("cancelled");
      if (terminal.action === "cancelled") {
        expect(terminal.result.public_status).toBe("cancelled");
        expect(terminal.met).toBe(false);
      }
    }
    expect(denials).toEqual(["ingest", "promote"]);
    expect(saveSettlements).toEqual(["released"]);
  });

  it("projects exhaustion and cancellation with only path-free handles", () => {
    for (const outcome of ["exhausted", "cancelled"] as const) {
      const run = context(`kb-${outcome}`, "knowledge-base");
      run.knowledgeBaseData.action = "query";
      run.knowledgeBaseData.profile_id = "profile";
      run.knowledgeBaseData.public_status = outcome;
      run.status = outcome === "cancelled" ? "cancelled" : "incomplete";
      run.stateId = outcome === "cancelled" ? "cancelled" : "complete";
      run.terminalDirective = validateDirective({
        schema_version: 2,
        action: outcome === "cancelled" ? "cancelled" : "incomplete",
        identity: run.identity,
        status: outcome === "cancelled" ? "cancelled" : "incomplete",
        met: false,
        result: {
          action: "query",
          public_status: outcome,
          best_partial_artifact_handles: [SAFE_HANDLE],
          terminal_reason: outcome === "exhausted" ? "model_turn_budget_exhausted" : null,
        },
        artifacts: [],
        unresolved: [],
      });
      run.pendingDirective = run.terminalDirective;
      const projected = replayableResultFromRun({ action: "query", run });
      expect(projected.status).toBe(outcome);
      expect(projected.met).toBe(false);
      expect(projected.artifacts).toEqual([SAFE_HANDLE]);
      expect(projected.next).toBe("none");
      expect(canonicalJson(projected)).not.toMatch(/storage_key|path|locator|PRIVATE_SENTINEL/u);
      expect(
        operationEventForResult({
          result: projected,
          transaction_id: `transaction-${outcome}`,
        })
      ).toBe("incomplete");
    }
  });
});
