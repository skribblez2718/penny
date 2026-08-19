/**
 * KB playbook FSM tests (§6.2 step 1).
 *
 * These exercise the playbook through its `PlaybookCoreV1` surface — the surface the
 * engine actually calls — rather than through a private KB entry point. That is the
 * whole point of the refactor: if the KB only worked when driven by its own code, it
 * would still be running beside the engine.
 */

import { describe, expect, it } from "vitest";

import { RunContext } from "../src/context.js";
import { evaluateCompletionGate, hasGapClassification } from "../src/playbooks/playbook.js";
import {
  KB_AGENT_PHASES,
  KB_STATES,
  KNOWLEDGE_BASE_SKILL_CONTRACT,
  KnowledgeBasePlaybook,
} from "../src/playbooks/knowledge-base.js";
import { PLAYBOOK_REGISTRY, validateRegistrationContract } from "../src/playbooks/registry.js";
import type { Confidence, Directive, JsonValue } from "../src/contracts.js";

const PROJECT_ROOT = "/tmp/penny-kb-playbook";

function newContext(constraints: Record<string, JsonValue> = {}): RunContext {
  return RunContext.create({
    identity: {
      schema_version: 2,
      run_id: `run_${Math.random().toString(16).slice(2, 10)}`,
      session_id: "sess_kb",
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "ingest two admitted sources",
    constraints: {
      action: "ingest",
      kb_profile_id: "kbp_test",
      source_ids: ["cap_a", "cap_b"],
      ...constraints,
    },
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 40,
  });
}

const DETAILS: Record<string, Record<string, JsonValue>> = {
  ingest: {
    artifact_kind: "claims",
    complete: true,
    claim_count: 3,
    source_ids: ["cap_a", "cap_b"],
  },
  compose: {
    artifact_kind: "page_draft",
    complete: true,
    claim_count: 3,
    page_id: "page_1",
    revision_id: "rev_1",
  },
  lint: {
    artifact_kind: "lint_report",
    complete: true,
    finding_count: 1,
    error_count: 0,
    candidate_conflict_count: 0,
  },
  verify: {
    artifact_kind: "verification_report",
    complete: true,
    supported: 3,
    partially_supported: 0,
    unsupported: 0,
  },
};

/** Drive the machine the way the engine does, to just before the given state. */
function driveTo(
  playbook: KnowledgeBasePlaybook,
  context: RunContext,
  stop: string,
  overrides: Record<string, Record<string, JsonValue>> = {}
): Directive {
  let next = playbook.initialize(context);
  let guard = 0;
  while (context.stateId !== stop && guard++ < 20) {
    const state = context.stateId;
    const details = overrides[state] ?? DETAILS[state];
    if (details === undefined) break;
    playbook.validateDetails(state, details);
    next = playbook.acceptSummary(context, details, "PROBABLE" as Confidence);
  }
  return next;
}

describe("KB playbook — state vocabulary", () => {
  it("declares the ingest machine's states in order", () => {
    expect([...KB_AGENT_PHASES]).toEqual(["ingest", "compose", "lint", "verify"]);
    expect([...KB_STATES]).toEqual([
      "ingest",
      "compose",
      "lint",
      "verify",
      "awaiting_review",
      "publishing",
    ]);
  });

  it("is constructed through the registry with a valid contract", () => {
    const registration = PLAYBOOK_REGISTRY.get("knowledge-base");
    expect(registration).toBeDefined();
    const contract = validateRegistrationContract(registration!);
    expect(contract.name).toBe("knowledge-base");
    expect(registration!.construct({})).toBeInstanceOf(KnowledgeBasePlaybook);
  });

  it("implements the typed-feedback capability", () => {
    expect(hasGapClassification(new KnowledgeBasePlaybook())).toBe(true);
  });
});

describe("KB playbook — dispatch", () => {
  it("initializes into the first agent phase and dispatches its agent", () => {
    const context = newContext();
    const directive = new KnowledgeBasePlaybook().initialize(context);
    expect(context.stateId).toBe("ingest");
    expect(directive.action).toBe("invoke_agent");
    if (directive.action !== "invoke_agent") throw new Error("unreachable");
    expect(directive.agent).toBe("echo");
    expect(directive.output_artifact.phase).toBe("ingest");
    expect(directive.output_artifact.version).toBe(1);
  });

  it("dispatches each phase to its declared agent", () => {
    const playbook = new KnowledgeBasePlaybook();
    const context = newContext();
    const seen: Array<[string, string]> = [];
    let directive = playbook.initialize(context);
    for (let i = 0; i < KB_AGENT_PHASES.length; i += 1) {
      if (directive.action !== "invoke_agent") break;
      seen.push([directive.state_id, directive.agent]);
      const details = DETAILS[context.stateId]!;
      directive = playbook.acceptSummary(context, details, "PROBABLE" as Confidence);
    }
    expect(seen).toEqual([
      ["ingest", "echo"],
      ["compose", "synthia"],
      ["lint", "carren"],
      ["verify", "vera"],
    ]);
  });

  it("refuses an unimplemented action rather than running the ingest machine", () => {
    const context = newContext({ action: "promote" });
    expect(() => new KnowledgeBasePlaybook().initialize(context)).toThrow(/not implemented/);
  });

  it("refuses an ingest run with no admitted sources", () => {
    const context = newContext({ source_ids: [] });
    expect(() => new KnowledgeBasePlaybook().initialize(context)).toThrow(/at least one admitted/);
  });

  it("refuses to run under another playbook's identity", () => {
    const context = newContext();
    const foreign = RunContext.fromSnapshot({
      ...context.snapshot(),
      identity: { ...context.identity, playbook: "research" },
    });
    expect(() => new KnowledgeBasePlaybook().initialize(foreign)).toThrow(/cannot run playbook/);
  });
});

describe("KB playbook — result contracts", () => {
  it("rejects a phase result carrying the wrong artifact kind", () => {
    const playbook = new KnowledgeBasePlaybook();
    expect(() => playbook.validateDetails("ingest", { artifact_kind: "page_draft" })).toThrow(
      /must return artifact_kind 'claims'/
    );
  });

  it("requires compose to identify the page revision it produced", () => {
    const playbook = new KnowledgeBasePlaybook();
    expect(() =>
      playbook.validateDetails("compose", {
        artifact_kind: "page_draft",
        complete: true,
        page_id: "page_1",
      })
    ).toThrow(/non-empty 'revision_id'/);
  });

  it("rejects an agent result for a non-agent state", () => {
    const playbook = new KnowledgeBasePlaybook();
    expect(() => playbook.validateDetails("awaiting_review", DETAILS.ingest!)).toThrow(
      /does not accept an agent result/
    );
  });
});

describe("KB playbook — typed feedback routing (W5)", () => {
  it("routes error-severity lint findings back to compose", () => {
    const playbook = new KnowledgeBasePlaybook();
    const context = newContext();
    driveTo(playbook, context, "lint");
    const failing = { ...DETAILS.lint!, error_count: 2 };
    const gap = playbook.classifyGap(context, "lint", failing);
    expect(gap?.kind).toBe("synthesis_gap");
    expect(gap?.target_state).toBe("compose");
    playbook.acceptSummary(context, failing, "PROBABLE" as Confidence);
    expect(context.stateId).toBe("compose");
  });

  it("routes unsupported claims back to compose as a validation gap", () => {
    const playbook = new KnowledgeBasePlaybook();
    const context = newContext();
    driveTo(playbook, context, "verify");
    const failing = { ...DETAILS.verify!, unsupported: 2, supported: 1 };
    const gap = playbook.classifyGap(context, "verify", failing);
    expect(gap?.kind).toBe("validation_gap");
    playbook.acceptSummary(context, failing, "PROBABLE" as Confidence);
    expect(context.stateId).toBe("compose");
  });

  it("proceeds honestly when the repair budget is exhausted, carrying the finding", () => {
    const playbook = new KnowledgeBasePlaybook();
    const context = newContext({ max_iterations: 1 });
    driveTo(playbook, context, "verify");
    context.iteration = context.maxIterations; // budget already spent
    const failing = { ...DETAILS.verify!, unsupported: 2, supported: 1 };
    playbook.acceptSummary(context, failing, "PROBABLE" as Confidence);
    // It advances rather than looping, and the unresolved finding is preserved.
    expect(context.stateId).toBe("awaiting_review");
    expect(JSON.stringify(context.playbookData.unresolved)).toMatch(/not supported/);
  });
});

describe("KB playbook — review gate and terminal truth", () => {
  it("reaches a review gate that binds the exact candidate set", () => {
    const playbook = new KnowledgeBasePlaybook();
    const context = newContext();
    const directive = driveTo(playbook, context, "awaiting_review");
    expect(context.stateId).toBe("awaiting_review");
    expect(directive.action).toBe("await_user");
    if (directive.action !== "await_user") throw new Error("unreachable");
    expect(directive.payload_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(context.status).toBe("awaiting_user");
  });

  it("publishes only after approval, and reports met from publishing", () => {
    const playbook = new KnowledgeBasePlaybook();
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    const terminal = playbook.resume(context, "approve");
    expect(terminal.action).toBe("complete");
    expect(context.previousState).toBe("publishing");
    expect(context.met).toBe(true);
  });

  it("denial publishes nothing and terminates incomplete, not errored", () => {
    const playbook = new KnowledgeBasePlaybook();
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    const terminal = playbook.resume(context, "deny");
    expect(terminal.action).toBe("incomplete");
    expect(context.met).toBe(false);
    expect(terminal.action === "incomplete" && terminal.unresolved.join(" ")).toMatch(/denied/);
  });

  it("refinement returns to compose instead of publishing", () => {
    const playbook = new KnowledgeBasePlaybook();
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    playbook.resume(context, { decision: "refine" });
    expect(context.stateId).toBe("compose");
  });

  it("refuses an unreadable review decision", () => {
    const playbook = new KnowledgeBasePlaybook();
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    expect(() => playbook.resume(context, "maybe")).toThrow(/must be approve, deny, or refine/);
  });

  it("the completion gate forbids a met terminal that skipped publishing", () => {
    const gate = KNOWLEDGE_BASE_SKILL_CONTRACT.completion_gate;
    expect(
      evaluateCompletionGate({
        gate,
        terminalStatus: "complete",
        met: true,
        fromState: "verify",
        unresolvedCount: 0,
      })
    ).toMatch(/requires terminating from/);
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
});

describe("KB playbook — durable state", () => {
  it("keeps phase metadata in playbook_data and survives a snapshot round trip", () => {
    const playbook = new KnowledgeBasePlaybook();
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    const restored = RunContext.fromSnapshot(context.snapshot());
    const phases = restored.playbookData.phases as Record<string, { artifact_kind: string }>;
    expect(Object.keys(phases).sort()).toEqual(["compose", "ingest", "lint", "verify"]);
    expect(phases.verify!.artifact_kind).toBe("verification_report");
  });

  it("carries no private body into control state", () => {
    const playbook = new KnowledgeBasePlaybook();
    const context = newContext();
    driveTo(playbook, context, "awaiting_review", {
      compose: { ...DETAILS.compose!, page_id: "page_1", revision_id: "rev_1" },
    });
    const serialized = JSON.stringify(context.snapshot());
    // Only counts, ids, kinds, and verdicts are retained; nothing body-shaped.
    expect(serialized).not.toMatch(/markdown/i);
    expect(serialized).not.toMatch(/## Synthesis/);
  });
});
