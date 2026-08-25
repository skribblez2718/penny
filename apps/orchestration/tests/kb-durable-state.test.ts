import { parseJson, requireRecord, requireString, requireValue } from "./helpers/narrowing.js";
/**
 * KB durable state and recovery (§6.2 step 3).
 *
 * Step 3 is that `status` and `resume` inherit the engine's checkpointer instead of a
 * private KB-side run store. The proof is not "the playbook stores things in
 * playbookData" (step 1 already does that) but "a run checkpointed at any phase
 * boundary can be loaded from the checkpointer, its pending directive re-bound, and
 * its metadata read back — exactly the path `engine.recover()` takes."
 *
 * These tests drive the playbook through its surface, snapshot the RunContext the way
 * the checkpointer does (canonicalJson of snapshot()), reload it the way the
 * checkpointer does (RunContext.fromSnapshot), and exercise `rebindPendingDirective`
 * — the method `engine.recover()` calls to re-present a pending directive after a
 * crash.
 *
 * They do NOT go through `engine.handle("step")`, which requires a full execution
 * receipt. That protocol belongs to step 4 (the executor wiring). This step proves the
 * durable-state half independently.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Checkpointer, canonicalJson } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import type { GateState } from "../src/kb/gate.js";
import type { KbIngestPlaneV1 } from "../src/kb/ingest-plane.js";
import { evaluateCompletionGate } from "../src/playbooks/playbook.js";
import {
  KNOWLEDGE_BASE_SKILL_CONTRACT,
  KnowledgeBasePlaybook,
} from "../src/playbooks/knowledge-base.js";
import type { Confidence, Directive, JsonValue } from "../src/contracts.js";

const PROJECT_ROOT = "/tmp/penny-kb-durable";
const TEST_ROOT_RESOLVER = (projectRoot: string, profileId: string): string =>
  `${projectRoot}/.penny/kb/${profileId}`;

function database(file: string) {
  const sqlite = process.getBuiltinModule("node:sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (sqlite === undefined) throw new Error("node:sqlite unavailable");
  return new sqlite.DatabaseSync(file);
}

function newContext(constraints: Record<string, JsonValue> = {}): RunContext {
  return RunContext.create({
    identity: {
      schema_version: 2,
      run_id: `run_${Math.random().toString(16).slice(2, 10)}`,
      session_id: "sess_kb_durable",
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "ingest two admitted sources",
    constraints: {
      action: "ingest",
      kb_profile_id: "kbp_test",
      source_capability_ids: ["cap_a", "cap_b"],
      max_iterations: 3,
      parent_identity: { provider: "ollama", model: "qwen327b:latest" },
      ...constraints,
    },
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 40,
  });
}

const DETAILS: Record<string, Record<string, JsonValue>> = {
  ingest: {
    kb_artifact_id: "art_ingest",
    artifact_kind: "claims",
    complete: true,
    claim_count: 3,
    source_ids: ["cap_a", "cap_b"],
  },
  compose: {
    kb_artifact_id: "art_compose",
    artifact_kind: "page_draft",
    complete: true,
    claim_count: 3,
    page_id: "page_1",
    revision_id: "rev_1",
  },
  lint: {
    kb_artifact_id: "art_lint",
    artifact_kind: "lint_report",
    complete: true,
    finding_count: 1,
    blocking_count: 0,
    candidate_conflict_count: 0,
  },
  verify: {
    kb_artifact_id: "art_verify",
    artifact_kind: "verification_report",
    complete: true,
    supported: 3,
    partially_supported: 0,
    unsupported: 0,
  },
};

interface FakePlaneCalls {
  claims: string[];
  seals: string[][];
  gates: string[];
  approvals: string[];
  denials: string[];
}

function fakePlane(calls: FakePlaneCalls): KbIngestPlaneV1 {
  return {
    admitRun() {
      // §5.3 admission; this suite asserts durable state, not the policy matrix.
      return { policy_sha256: "a".repeat(64), kb_id: "kb_test" };
    },
    recheckPolicy() {},
    claim(i: { runId: string; capabilityIds: readonly string[] }) {
      calls.claims.push(i.runId);
      return i.capabilityIds.map((_, index) => `src_restart_${index + 1}`);
    },
    admit() {
      // Deterministic host step; this test asserts claim→seal→gate ordering.
    },
    seal(i: { runId: string; artifactIds: readonly string[] }) {
      calls.seals.push([...i.artifactIds]);
    },
    prepareContentReview(i: {
      runId: string;
      sessionId: string;
      challengeId: string;
      profileId: string;
      action: "ingest" | "save";
      queryRunId?: string;
      sourceIds: readonly string[];
      policySha256: string;
    }) {
      calls.gates.push(i.runId);
      const issuedAt = new Date().toISOString();
      const handles = [
        { artifact_id: "art_compose", artifact_kind: "page_draft" as const },
        { artifact_id: "art_lint", artifact_kind: "lint_report" as const },
        { artifact_id: "art_verify", artifact_kind: "verification_report" as const },
      ].map((artifact) => ({
        schema_version: 1 as const,
        ...artifact,
        sha256: "b".repeat(64),
        media_type: "application/json" as const,
        byte_length: 2,
      }));
      return {
        schema_version: 1 as const,
        run_id: i.runId,
        session_id: i.sessionId,
        challenge_id: i.challengeId,
        kb_profile_id: i.profileId,
        kb_id: "kb_test",
        action: i.action,
        base_generation_id: "gen_base",
        base_selector_sha256: "c".repeat(64),
        ...(i.action === "save"
          ? {
              query_run_id: requireValue(
                i.queryRunId,
                "apps/orchestration/tests/kb-durable-state.test.ts:167"
              ),
            }
          : {}),
        candidate_artifacts: handles,
        candidate_artifact_digests: Object.fromEntries(
          handles.map((artifact) => [artifact.artifact_id, artifact.sha256])
        ),
        candidate_source_record_digests:
          i.action === "ingest"
            ? Object.fromEntries(i.sourceIds.map((sourceId) => [sourceId, "d".repeat(64)]))
            : {},
        candidate_conflict_allocations: [],
        policy_sha256: i.policySha256,
        issued_at: issuedAt,
        expires_at: new Date(new Date(issuedAt).getTime() + 3_600_000).toISOString(),
      };
    },
    persistGate(i: { runId: string; artifactIds: readonly string[] }): GateState {
      const issuedAt = new Date().toISOString();
      return {
        schema_version: 1,
        gate_id: "gate_fake01",
        run_id: i.runId,
        kb_profile_id: "kbp_test",
        action: "ingest",
        status: "awaiting",
        issued_at: issuedAt,
        expires_at: new Date(new Date(issuedAt).getTime() + 3_600_000).toISOString(),
        base_generation_id: "gen_base",
        base_catalog_sha256: "c".repeat(64),
        source_capability_ids: ["cap_a", "cap_b"],
        source_ids: ["src_restart_1", "src_restart_2"],
        artifacts: i.artifactIds.map((artifactId) => ({
          schema_version: 1,
          artifact_id: artifactId,
          artifact_kind: "test_artifact",
          sha256: "b".repeat(64),
          media_type: "application/json",
          byte_length: 2,
        })),
        packet_sha256: "d".repeat(64),
      };
    },
    approve(i: { runId: string }) {
      calls.approvals.push(i.runId);
      return { generationId: "gen_published", counts: { pages: 1 } };
    },
    deny(i: { runId: string }) {
      calls.denials.push(i.runId);
    },
    claimSave() {
      throw new Error("durable ingest fixture does not support save claims");
    },
    settleSave() {
      throw new Error("durable ingest fixture does not support save settlement");
    },
    verifyPromotion() {
      throw new Error("durable ingest fixture does not support promotion verification");
    },
  } satisfies KbIngestPlaneV1;
}

/** Drive to a target state, returning the last directive. */
function driveTo(playbook: KnowledgeBasePlaybook, context: RunContext, stop: string): Directive {
  let next = playbook.initialize(context);
  let guard = 0;
  while (context.stateId !== stop && guard++ < 20) {
    const details = DETAILS[context.stateId];
    if (details === undefined) break;
    playbook.validateDetails(context.stateId, details);
    next = playbook.acceptSummary(context, details, "PROBABLE" as Confidence);
  }
  return next;
}

/** Simulate what the checkpointer does: serialize → reload. */
function checkpointRoundTrip(context: RunContext): RunContext {
  const json = canonicalJson(context.snapshot());
  const snapshot: unknown = JSON.parse(json);
  return RunContext.fromSnapshot(snapshot);
}

describe("KB durable state — checkpoint round trip at every phase boundary", () => {
  for (const phase of ["ingest", "compose", "lint", "verify", "awaiting_review"] as const) {
    it(`survives a checkpoint round trip after ${phase}`, () => {
      const calls: FakePlaneCalls = {
        claims: [],
        seals: [],
        gates: [],
        approvals: [],
        denials: [],
      };
      const playbook = new KnowledgeBasePlaybook(undefined, fakePlane(calls), TEST_ROOT_RESOLVER);
      const context = newContext();
      driveTo(playbook, context, phase);

      const restored = checkpointRoundTrip(context);
      expect(restored.stateId).toBe(context.stateId);
      expect(restored.status).toBe(context.status);
      expect(restored.identity.run_id).toBe(context.identity.run_id);
      expect(restored.playbookData.action).toBe("ingest");
      expect(restored.playbookData.source_capability_ids).toEqual(["cap_a", "cap_b"]);
      expect(restored.playbookData.source_ids).toEqual(["src_restart_1", "src_restart_2"]);

      // Phase metadata survived (phases before the current one are recorded)
      const allPhases = ["ingest", "compose", "lint", "verify"];
      const phaseIndex = allPhases.indexOf(phase);
      const restoredPhases = restored.knowledgeBaseData.phases;
      if (phaseIndex === 0) {
        expect(restoredPhases).toBeUndefined();
      } else {
        const phases = requireValue(restoredPhases, "restored knowledge-base phases");
        for (let i = 0; i < phaseIndex; i++) {
          const p = requireValue(
            allPhases[i],
            "apps/orchestration/tests/kb-durable-state.test.ts:274"
          );
          const phaseRecord = requireValue(phases[p], `restored phase ${p}`);
          expect(phaseRecord.artifact_kind).toBeDefined();
        }
      }
    });
  }
});

describe("KB durable state — rebindPendingDirective (the recover path)", () => {
  it("re-binds an invoke_agent directive with a fresh output_artifact version", () => {
    const calls: FakePlaneCalls = {
      claims: [],
      seals: [],
      gates: [],
      approvals: [],
      denials: [],
    };
    const playbook = new KnowledgeBasePlaybook(undefined, fakePlane(calls), TEST_ROOT_RESOLVER);
    const context = newContext();
    const original = playbook.initialize(context) as Directive;
    expect(original.action).toBe("invoke_agent");

    // Simulate a crash: the context was checkpointed with the pending directive.
    const restored = checkpointRoundTrip(context);
    const rebound = playbook.rebindPendingDirective(restored);
    if (rebound === null || rebound.action !== "invoke_agent") {
      throw new Error("recovery did not re-bind an invoke_agent directive");
    }
    // The re-bound directive must target the same agent and state.
    expect(rebound.agent).toBe("echo");
    expect(rebound.state_id).toBe("ingest");
    // The output artifact must be a valid metadata object with version >= 1.
    expect(rebound.output_artifact.version).toBeGreaterThanOrEqual(1);
    expect(rebound.output_artifact.phase).toBe("ingest");
  });

  it("re-presents an await_user directive unchanged on recovery", () => {
    const calls: FakePlaneCalls = {
      claims: [],
      seals: [],
      gates: [],
      approvals: [],
      denials: [],
    };
    const playbook = new KnowledgeBasePlaybook(undefined, fakePlane(calls), TEST_ROOT_RESOLVER);
    const context = newContext();
    const directive = driveTo(playbook, context, "awaiting_review");
    if (directive.action !== "await_user") {
      throw new Error("playbook did not reach the awaiting review directive");
    }

    const restored = checkpointRoundTrip(context);
    const rebound = playbook.rebindPendingDirective(restored);
    if (rebound === null || rebound.action !== "await_user") {
      throw new Error("recovery did not re-present the await_user directive");
    }
    // The gate_id and challenge must be preserved so the host can answer it.
    expect(rebound.gate_id).toBe(directive.gate_id);
    expect(rebound.challenge).toBe(directive.challenge);
    expect(rebound.payload_digest).toBe(directive.payload_digest);
  });

  it("a terminal run returns its terminal directive, not a re-bind", () => {
    const calls: FakePlaneCalls = {
      claims: [],
      seals: [],
      gates: [],
      approvals: [],
      denials: [],
    };
    const playbook = new KnowledgeBasePlaybook(undefined, fakePlane(calls), TEST_ROOT_RESOLVER);
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    playbook.resume(context, "approve");
    // The engine checks terminalDirective first and returns it without calling
    // rebindPendingDirective. Prove the terminal directive survived the round trip.
    expect(context.terminalDirective).not.toBeNull();
    const restored = checkpointRoundTrip(context);
    expect(restored.terminalDirective).not.toBeNull();
    expect(
      requireValue(
        restored.terminalDirective,
        "apps/orchestration/tests/kb-durable-state.test.ts:353"
      ).action
    ).toBe("complete");
    // rebindPendingDirective on a terminal context returns the terminal directive
    // (it is not an invoke_agent, so it passes through). The engine never calls
    // this in practice — it returns terminalDirective first — but the behaviour
    // is defined and should not throw.
    const rebound = playbook.rebindPendingDirective(restored);
    expect(rebound).not.toBeNull();
    expect(
      requireValue(rebound, "apps/orchestration/tests/kb-durable-state.test.ts:360").action
    ).toBe("complete");
  });

  it("passes through an await_user directive unchanged (no re-binding needed)", () => {
    const calls: FakePlaneCalls = {
      claims: [],
      seals: [],
      gates: [],
      approvals: [],
      denials: [],
    };
    const playbook = new KnowledgeBasePlaybook(undefined, fakePlane(calls), TEST_ROOT_RESOLVER);
    const context = newContext();
    const directive = driveTo(playbook, context, "awaiting_review");
    expect(directive.action).toBe("await_user");
    // An await_user directive is not an invoke_agent, so rebind passes it through
    // unchanged. This is the correct behaviour: the gate is already issued and
    // does not need a new output-artifact version.
    const rebound = playbook.rebindPendingDirective(context);
    expect(rebound).not.toBeNull();
    expect(rebound).toBe(context.pendingDirective);
  });
});

describe("KB durable state — status projection", () => {
  it("the terminal result carries the published generation and review decision", () => {
    const calls: FakePlaneCalls = {
      claims: [],
      seals: [],
      gates: [],
      approvals: [],
      denials: [],
    };
    const playbook = new KnowledgeBasePlaybook(undefined, fakePlane(calls), TEST_ROOT_RESOLVER);
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    const terminal = playbook.resume(context, "approve");
    expect(terminal.action).toBe("complete");
    if (terminal.action !== "complete") throw new Error("unreachable");
    const result = terminal.result as Record<string, JsonValue>;
    expect(result.published_generation_id).toBe("gen_published");
    expect(result.review_decision).toBe("approve");
    expect(result.source_count).toBe(2);
    expect(result.met).toBe(true);

    // A recovered terminal context returns the terminal directive, not a re-bind.
    const restored = checkpointRoundTrip(context);
    expect(restored.terminalDirective).not.toBeNull();
    expect(
      requireValue(
        restored.terminalDirective,
        "apps/orchestration/tests/kb-durable-state.test.ts:408"
      ).action
    ).toBe("complete");
  });

  it("the completion gate admits the approved terminal from publishing", () => {
    const gate = KNOWLEDGE_BASE_SKILL_CONTRACT.completion_gate;
    expect(
      evaluateCompletionGate({
        gate,
        terminalStatus: "complete",
        met: true,
        fromState: "publishing",
        unresolvedCount: 0,
      })
    ).toBeNull();
  });

  it("a denied terminal is honest (incomplete, not error) and not gated", () => {
    const calls: FakePlaneCalls = {
      claims: [],
      seals: [],
      gates: [],
      approvals: [],
      denials: [],
    };
    const playbook = new KnowledgeBasePlaybook(undefined, fakePlane(calls), TEST_ROOT_RESOLVER);
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    const terminal = playbook.resume(context, "deny");
    expect(terminal.action).toBe("incomplete");
    expect(context.met).toBe(false);
    // Denial is not a met terminal, so the completion gate does not even fire.
    const gate = KNOWLEDGE_BASE_SKILL_CONTRACT.completion_gate;
    expect(
      evaluateCompletionGate({
        gate,
        terminalStatus: "incomplete",
        met: false,
        fromState: "awaiting_review",
        unresolvedCount: 1,
      })
    ).toBeNull();
  });
});

describe("KB closed durable projection", () => {
  it("validates every save/load and persists no absolute project/root path", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-kb-durable-projection-"));
    const dbPath = path.join(projectRoot, "control.db");
    const checkpointer = new Checkpointer(dbPath);
    try {
      const context = RunContext.create({
        identity: {
          schema_version: 2,
          run_id: "run_closed_projection",
          session_id: "session_closed_projection",
          playbook: "knowledge-base",
          engine_owner: "typescript",
        },
        goal: "Synthetic path-free KB control projection.",
        constraints: { action: "ingest", kb_profile_id: "profile_projection" },
        projectRoot,
        trustProfile: "hardened-untrusted",
        maxSteps: 8,
      });
      context.playbookData.action = "ingest";
      context.playbookData.profile_id = "profile_projection";
      context.playbookData.admitted_policy_sha256 = "a".repeat(64);
      checkpointer.createRun(context, "projection_created", {});
      context.playbookData.kb_id = "kb_projection";
      checkpointer.saveRun(context, "projection_saved", { run_id: context.identity.run_id });

      const raw = database(dbPath);
      const row = requireRecord(
        raw.prepare("SELECT context_json FROM runs WHERE run_id=?").get(context.identity.run_id),
        "closed durable projection row"
      );
      const contextJson = requireString(row["context_json"], "closed durable projection context");
      expect(contextJson).not.toContain(projectRoot);
      const projection = requireRecord(parseJson(contextJson), "closed durable projection context");
      expect(projection.durable_schema_version).toBe(1);
      expect(projection).not.toHaveProperty("project_root");
      expect(checkpointer.loadRunById(context.identity.run_id)?.projectRoot).toBe(projectRoot);

      raw
        .prepare("UPDATE runs SET context_json=? WHERE run_id=?")
        .run(
          canonicalJson({ ...projection, project_root: "/forbidden/root" }),
          context.identity.run_id
        );
      raw.close();
      expect(() => checkpointer.loadRunById(context.identity.run_id)).toThrow(
        /durable projection/i
      );
    } finally {
      checkpointer.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("KB durable state — revision chain integrity across recovery", () => {
  it("a re-bound output_artifact has a stable operation_id and version 1 on first bind", () => {
    const calls: FakePlaneCalls = {
      claims: [],
      seals: [],
      gates: [],
      approvals: [],
      denials: [],
    };
    const playbook = new KnowledgeBasePlaybook(undefined, fakePlane(calls), TEST_ROOT_RESOLVER);
    const context = newContext();
    playbook.initialize(context);
    const first = playbook.rebindPendingDirective(context);
    const second = playbook.rebindPendingDirective(context);
    if (first === null || first.action !== "invoke_agent") {
      throw new Error("first re-bind did not produce an invoke_agent directive");
    }
    if (second === null || second.action !== "invoke_agent") {
      throw new Error("second re-bind did not produce an invoke_agent directive");
    }
    // Same run, same phase, same branch → same operation_id. No artifact was
    // captured yet, so both re-binds produce version 1 (the next version past
    // the empty ledger).
    expect(second.output_artifact.operation_id).toBe(first.output_artifact.operation_id);
    expect(second.output_artifact.version).toBe(first.output_artifact.version);
    expect(second.output_artifact.phase).toBe("ingest");
    expect(second.output_artifact.producer).toBe("agent:echo");
  });
});
