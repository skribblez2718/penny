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
import type { KbIngestPlaneV1 } from "../src/kb/ingest-plane.js";

const PROJECT_ROOT = "/tmp/penny-kb-playbook";
const TEST_ROOT_RESOLVER = (projectRoot: string, profileId: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profileId)) {
    throw new Error(`kb_profile_id '${profileId}' is not a valid opaque profile id`);
  }
  return `${projectRoot}/.penny/kb/${profileId}`;
};

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
      source_capability_ids: ["cap_a", "cap_b"],
      // §5.3: host-supplied, never model-supplied. Admission denies without it.
      parent_identity: { provider: "ollama", model: "qwen327b:latest" },
      ...constraints,
    },
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 40,
  });
}

interface PlaneCalls {
  /** §5.3 admission, and the order it happened in relative to private I/O. */
  admitRuns: Array<{ parentIdentity: { provider: string; model: string } | undefined }>;
  order: string[];
  claims: Array<{ runId: string; capabilityIds: readonly string[] }>;
  admits: Array<{ runId: string; capabilityIds: readonly string[] }>;
  seals: Array<{ runId: string; artifactIds: readonly string[] }>;
  gates: Array<{ runId: string; artifacts: number }>;
  approvals: string[];
  denials: string[];
}

/**
 * A recording plane. The playbook's I/O is behind an interface precisely so the
 * machine can be driven without a filesystem; these tests assert WHAT it does and
 * WHEN, and the integration test below proves the real plane satisfies the same
 * contract.
 */
function fakePlane(options: { denyAdmission?: boolean } = {}): {
  plane: KbIngestPlaneV1;
  calls: PlaneCalls;
} {
  const calls: PlaneCalls = {
    admitRuns: [],
    order: [],
    claims: [],
    admits: [],
    seals: [],
    gates: [],
    approvals: [],
    denials: [],
  };
  const plane: KbIngestPlaneV1 = {
    admitRun(input) {
      calls.admitRuns.push({ parentIdentity: input.parentIdentity });
      calls.order.push("admitRun");
      if (options.denyAdmission === true || input.parentIdentity === undefined) {
        throw new Error("policy refusal: parent identity is not admitted");
      }
      return { policy_sha256: "a".repeat(64) };
    },
    claim(input) {
      calls.order.push("claim");
      calls.claims.push({ runId: input.runId, capabilityIds: input.capabilityIds });
    },
    admit(input) {
      calls.order.push("admit");
      calls.admits.push({ runId: input.runId, capabilityIds: input.capabilityIds });
    },
    claimSave() {
      return { answerArtifactId: "art_claimed_answer" };
    },
    reserveSave() {
      calls.order.push("reserveSave");
    },
    settleSave(input: { outcome: string }) {
      calls.order.push(`settleSave:${input.outcome}`);
    },
    verifyPromotion() {
      calls.order.push("verifyPromotion");
      return { artifactId: "art_promo_verification", verified: true };
    },
    seal(input) {
      calls.seals.push({ runId: input.runId, artifactIds: input.artifactIds });
    },
    persistGate(input) {
      calls.gates.push({ runId: input.runId, artifacts: input.artifactIds.length });
      return {
        schema_version: 1,
        gate_id: "gate_fake01",
        run_id: input.runId,
        kb_profile_id: input.profileId,
        action: "ingest",
        status: "awaiting",
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        base_generation_id: "gen_base",
        source_ids: [...input.sourceIds],
        source_capability_ids: [...input.capabilityIds],
        artifact_kinds: [],
        packet_digest: "0".repeat(64),
      } as unknown as ReturnType<KbIngestPlaneV1["persistGate"]>;
    },
    approve(input) {
      calls.approvals.push(input.runId);
      return { generationId: "gen_published", counts: { pages: 1, sources: 2 } };
    },
    deny(input) {
      calls.denials.push(input.runId);
    },
  };
  return { plane, calls };
}

function newPlaybook(plane?: KbIngestPlaneV1): KnowledgeBasePlaybook {
  return new KnowledgeBasePlaybook(undefined, plane ?? fakePlane().plane, TEST_ROOT_RESOLVER);
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
    error_count: 0,
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
  it("declares the machine's states in order, across all three actions", () => {
    // ingest: ingest→compose→lint→verify; save enters at compose;
    // promote: plan→patch. All three converge on the same review gate.
    expect([...KB_AGENT_PHASES]).toEqual(["ingest", "compose", "lint", "verify", "plan", "patch"]);
    expect([...KB_STATES]).toEqual([
      "ingest",
      "compose",
      "lint",
      "verify",
      "plan",
      "patch",
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
    expect(hasGapClassification(newPlaybook())).toBe(true);
  });
});

describe("KB playbook — §5.3 deny before session", () => {
  it("admits the run BEFORE claiming or admitting any source", () => {
    const { plane, calls } = fakePlane();
    const context = newContext();
    new KnowledgeBasePlaybook(undefined, plane, TEST_ROOT_RESOLVER).initialize(context);
    // Ordering is the guarantee: admission must precede every private read.
    expect(calls.order[0]).toBe("admitRun");
    expect(calls.order.slice(0, 3)).toEqual(["admitRun", "claim", "admit"]);
    expect(calls.admitRuns[0]?.parentIdentity).toEqual({
      provider: "ollama",
      model: "qwen327b:latest",
    });
    expect(context.playbookData.admitted_policy_sha256).toBe("a".repeat(64));
  });

  it("a denied run claims nothing, admits nothing, and dispatches no agent", () => {
    const { plane, calls } = fakePlane({ denyAdmission: true });
    const context = newContext();
    expect(() =>
      new KnowledgeBasePlaybook(undefined, plane, TEST_ROOT_RESOLVER).initialize(context)
    ).toThrow(/policy refusal/i);
    // The whole point of deny-before-session: zero private I/O on the denial path.
    expect(calls.claims).toEqual([]);
    expect(calls.admits).toEqual([]);
    expect(calls.seals).toEqual([]);
    expect(context.pendingDirective).toBeNull();
  });

  it("refuses when the host cannot establish the parent identity", () => {
    const { plane, calls } = fakePlane();
    // Host could not report a parent tuple — absence is a denial, not a pass.
    const context = newContext({ parent_identity: null });
    expect(() =>
      new KnowledgeBasePlaybook(undefined, plane, TEST_ROOT_RESOLVER).initialize(context)
    ).toThrow();
    expect(calls.claims).toEqual([]);
    expect(calls.admits).toEqual([]);
  });

  it("ignores a model-shaped parent identity that is not a proper tuple", () => {
    const { plane, calls } = fakePlane();
    const context = newContext({ parent_identity: { provider: "ollama" } });
    expect(() =>
      new KnowledgeBasePlaybook(undefined, plane, TEST_ROOT_RESOLVER).initialize(context)
    ).toThrow();
    expect(calls.admitRuns[0]?.parentIdentity).toBeUndefined();
    expect(calls.claims).toEqual([]);
  });
});

describe("KB playbook — dispatch", () => {
  it("initializes into the first agent phase and dispatches its agent", () => {
    const context = newContext();
    const directive = newPlaybook().initialize(context);
    expect(context.stateId).toBe("ingest");
    expect(directive.action).toBe("invoke_agent");
    if (directive.action !== "invoke_agent") throw new Error("unreachable");
    expect(directive.agent).toBe("echo");
    expect(directive.output_artifact.phase).toBe("ingest");
    expect(directive.output_artifact.version).toBe(1);
  });

  it("dispatches each phase to its declared agent", () => {
    const playbook = newPlaybook();
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
    // ingest, save, and promote are implemented; anything else must refuse
    // rather than silently running a machine under the wrong contract.
    const context = newContext({ action: "rebuild-everything" });
    expect(() => newPlaybook().initialize(context)).toThrow(/not implemented/);
  });

  it("refuses a promote run with no canonical target capability", () => {
    const context = newContext({ action: "promote", canonical_target_capability_ids: [] });
    expect(() => newPlaybook().initialize(context)).toThrow(/at least one canonical target/);
  });

  it("refuses to APPLY a promotion through the public gate (G9 is host-only)", () => {
    const { plane, calls } = fakePlane();
    const context = newContext({
      action: "promote",
      canonical_target_capability_ids: ["cap_target_1"],
      page_revisions: [{ page_id: "page_a", revision_id: "rev_1" }],
    });
    const playbook = new KnowledgeBasePlaybook(undefined, plane, TEST_ROOT_RESOLVER);
    playbook.initialize(context);
    expect(context.stateId).toBe("plan");

    // Drive to the gate, then try to approve: preparing is allowed, applying is not.
    context.stateId = "awaiting_review";
    playbook.dispatch(context);
    expect(() => playbook.resume(context, "approve")).toThrow(/host-only|not implemented/i);
    expect(calls.approvals).toEqual([]); // nothing published, nothing applied
  });

  it("refuses an ingest run with no admitted sources", () => {
    const context = newContext({ source_capability_ids: [] });
    expect(() => newPlaybook().initialize(context)).toThrow(/at least one admitted/);
  });

  it("refuses to run under another playbook's identity", () => {
    const context = newContext();
    const foreign = RunContext.fromSnapshot({
      ...context.snapshot(),
      identity: { ...context.identity, playbook: "research" },
    });
    expect(() => newPlaybook().initialize(foreign)).toThrow(/cannot run playbook/);
  });
});

describe("KB playbook — result contracts", () => {
  it("rejects a phase result carrying the wrong artifact kind", () => {
    const playbook = newPlaybook();
    expect(() => playbook.validateDetails("ingest", { artifact_kind: "page_draft" })).toThrow(
      /must return artifact_kind 'claims'/
    );
  });

  it("requires compose to identify the page revision it produced", () => {
    const playbook = newPlaybook();
    expect(() =>
      playbook.validateDetails("compose", {
        kb_artifact_id: "art_compose",
        artifact_kind: "page_draft",
        complete: true,
        page_id: "page_1",
      })
    ).toThrow(/non-empty 'revision_id'/);
  });

  it("rejects an agent result for a non-agent state", () => {
    const playbook = newPlaybook();
    expect(() => playbook.validateDetails("awaiting_review", DETAILS.ingest!)).toThrow(
      /does not accept an agent result/
    );
  });
});

describe("KB playbook — typed feedback routing (W5)", () => {
  it("routes error-severity lint findings back to compose", () => {
    const playbook = newPlaybook();
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
    const playbook = newPlaybook();
    const context = newContext();
    driveTo(playbook, context, "verify");
    const failing = { ...DETAILS.verify!, unsupported: 2, supported: 1 };
    const gap = playbook.classifyGap(context, "verify", failing);
    expect(gap?.kind).toBe("validation_gap");
    playbook.acceptSummary(context, failing, "PROBABLE" as Confidence);
    expect(context.stateId).toBe("compose");
  });

  it("proceeds honestly when the repair budget is exhausted, carrying the finding", () => {
    const playbook = newPlaybook();
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
    const playbook = newPlaybook();
    const context = newContext();
    const directive = driveTo(playbook, context, "awaiting_review");
    expect(context.stateId).toBe("awaiting_review");
    expect(directive.action).toBe("await_user");
    if (directive.action !== "await_user") throw new Error("unreachable");
    expect(directive.payload_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(context.status).toBe("awaiting_user");
  });

  it("publishes only after approval, and reports met from publishing", () => {
    const playbook = newPlaybook();
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    const terminal = playbook.resume(context, "approve");
    expect(terminal.action).toBe("complete");
    expect(context.previousState).toBe("publishing");
    expect(context.met).toBe(true);
  });

  it("denial publishes nothing and terminates incomplete, not errored", () => {
    const playbook = newPlaybook();
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    const terminal = playbook.resume(context, "deny");
    expect(terminal.action).toBe("incomplete");
    expect(context.met).toBe(false);
    expect(terminal.action === "incomplete" && terminal.unresolved.join(" ")).toMatch(/denied/);
  });

  it("refinement returns to compose instead of publishing", () => {
    const playbook = newPlaybook();
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    playbook.resume(context, { decision: "refine" });
    expect(context.stateId).toBe("compose");
  });

  it("refuses an unreadable review decision", () => {
    const playbook = newPlaybook();
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
    const playbook = newPlaybook();
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    const restored = RunContext.fromSnapshot(context.snapshot());
    const phases = restored.playbookData.phases as Record<string, { artifact_kind: string }>;
    expect(Object.keys(phases).sort()).toEqual(["compose", "ingest", "lint", "verify"]);
    expect(phases.verify!.artifact_kind).toBe("verification_report");
  });

  it("carries no private body into control state", () => {
    const playbook = newPlaybook();
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

describe("KB playbook — deterministic host I/O (§6.2 step 2)", () => {
  it("seals the exact candidate set and persists the gate BEFORE presenting it", () => {
    const { plane, calls } = fakePlane();
    const playbook = newPlaybook(plane);
    const context = newContext();
    expect(calls.seals).toHaveLength(0);
    driveTo(playbook, context, "awaiting_review");
    expect(calls.seals).toHaveLength(1);
    expect(calls.gates).toHaveLength(1);
    // Exactly the four phase artifacts, in phase order.
    expect(calls.seals[0]!.artifactIds).toEqual([
      "art_ingest",
      "art_compose",
      "art_lint",
      "art_verify",
    ]);
    expect(calls.gates[0]!.artifacts).toBe(4);
    expect(context.playbookData.gate_id).toBe("gate_fake01");
  });

  it("publishes on approval and reports the generation", () => {
    const { plane, calls } = fakePlane();
    const playbook = newPlaybook(plane);
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    const terminal = playbook.resume(context, "approve");
    expect(calls.approvals).toEqual([context.identity.run_id]);
    expect(context.playbookData.published_generation_id).toBe("gen_published");
    expect(terminal.action).toBe("complete");
    if (terminal.action !== "complete") throw new Error("unreachable");
    expect((terminal.result as Record<string, JsonValue>).published_generation_id).toBe(
      "gen_published"
    );
  });

  it("denial invalidates the gate and publishes nothing", () => {
    const { plane, calls } = fakePlane();
    const playbook = newPlaybook(plane);
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    playbook.resume(context, "deny");
    expect(calls.denials).toEqual([context.identity.run_id]);
    expect(calls.approvals).toEqual([]);
    expect(context.playbookData.published_generation_id).toBeUndefined();
  });

  it("refinement does not re-seal or re-gate a superseded candidate set", () => {
    const { plane, calls } = fakePlane();
    const playbook = newPlaybook(plane);
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    playbook.resume(context, "refine");
    expect(context.stateId).toBe("compose");
    // One gate exists for this run; a refined candidate set must not silently
    // stack a second gate on top of it.
    expect(calls.gates).toHaveLength(1);
  });

  it("publishing is unreachable except through an approved gate", () => {
    const playbook = newPlaybook();
    const context = newContext();
    driveTo(playbook, context, "awaiting_review");
    context.transition("publishing");
    expect(() => playbook.dispatch(context)).toThrow(/only reachable through an approved/);
  });

  it("requires each phase to name the artifact it staged", () => {
    const playbook = newPlaybook();
    const withoutHandle = { ...DETAILS.ingest! };
    delete withoutHandle.kb_artifact_id;
    expect(() => playbook.validateDetails("ingest", withoutHandle)).toThrow(
      /must return the kb_artifact_id/
    );
  });

  it("refuses a profile id that is not a valid opaque id, before any work", () => {
    const { plane, calls } = fakePlane();
    const playbook = newPlaybook(plane);
    const context = newContext({ kb_profile_id: "../../escape" });
    // The root is host-resolved from a validated id, and the refusal lands at
    // initialize — before a capability is claimed or an agent reads anything.
    expect(() => playbook.initialize(context)).toThrow(/not a valid opaque profile id/);
    expect(calls.claims).toEqual([]);
  });

  it("claims the admitted capabilities before dispatching the first phase", () => {
    const { plane, calls } = fakePlane();
    const playbook = newPlaybook(plane);
    const context = newContext();
    playbook.initialize(context);
    expect(calls.claims).toHaveLength(1);
    expect(calls.claims[0]!.capabilityIds).toEqual(["cap_a", "cap_b"]);
    expect(calls.claims[0]!.runId).toBe(context.identity.run_id);
  });

  it("admits the source objects before any phase work, bound to the run", () => {
    const { plane, calls } = fakePlane();
    const playbook = newPlaybook(plane);
    const context = newContext();
    playbook.initialize(context);
    // Admit follows claim (all-or-none first) and precedes any seal/gate — the
    // approval path publishes what this admitted, so agents must see exactly
    // what will publish.
    expect(calls.admits).toHaveLength(1);
    expect(calls.admits[0]!.capabilityIds).toEqual(["cap_a", "cap_b"]);
    expect(calls.admits[0]!.runId).toBe(context.identity.run_id);
    expect(calls.seals).toEqual([]);
    expect(calls.gates).toEqual([]);
  });
});
