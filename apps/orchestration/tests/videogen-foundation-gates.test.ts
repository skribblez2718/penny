import { describe, expect, it } from "vitest";
import { Checkpointer } from "../dist/checkpointer.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  validateDirective,
  type ArtifactRef,
  type Directive,
  type JsonValue,
  type RunIdentity,
  type CompletionGate,
} from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { OrchestrationEngine } from "../dist/engine.js";
import type { PlaybookCore } from "../dist/playbooks/playbook.js";
import {
  PLAYBOOK_REGISTRY,
  validateRegistrationContract,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import { RESEARCH_SKILL_CONTRACT } from "../dist/playbooks/research.js";
import {
  checkGatePacket,
  checkGateApproval,
  constructGateDecision,
  respondToGate,
  validateGatePacket,
  type GatePacketV1,
  type GateBindingHostV1,
  type CurrentGateApprovalV1,
  type VideogenGateId,
} from "../dist/videogen/gates.js";
import {
  VIDEOGEN_COMPLETION_GATE,
  VIDEOGEN_COMPLETION_PREDICATE_IDS,
  VIDEOGEN_UNWIRED_COMPLETION_PREDICATES,
} from "../dist/videogen/completion.js";
import {
  preflightShotMode,
  type ShotPreflightHostV1,
  type ShotCapabilityV1,
  type ShotPortV1,
} from "../dist/videogen/shot-modes.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import {
  FoundationFixture,
  FOUNDATION_LIMITS as limits,
} from "./helpers/videogen-foundation-fixtures.js";
const NAME = "videogen-foundation-fixture";
const ORDER: readonly VideogenGateId[] = ["G1", "G2", "G3", "G4", "G5"];
type PacketFixture = { packet: GatePacketV1; packet_ref: ArtifactRef };
function packetFixture(
  f: FoundationFixture,
  gate: VideogenGateId | "clarify",
  prior_decisions: ArtifactRef[]
): PacketFixture {
  const producers = {
    G1: "story_plan",
    G2: "asset_prepare",
    G3: "animatic_plan",
    G4: "rough_build",
    G5: "finish_prepare",
    clarify: "admit",
  };
  const roles = {
    G1: ["story"],
    G2: ["look-voice", "performance"],
    G3: ["animatic", "voice-route"],
    G4: ["rough-cut"],
    G5: ["master", "package"],
    clarify: ["request"],
  };
  const presented = roles[gate].map((role) => ({
    role,
    ref: f.opaque(`${role} fixture; no media proof`),
    revision: 1,
  }));
  if (gate === "G1") {
    const story = presented.find((x) => x.role === "story");
    if (story === undefined) throw new Error("fixture story missing");
    const ref = f.opaque("host consent/rights");
    const intent = {
      schema_id: "penny.videogen-asset-intent.v1",
      schema_version: 1,
      asset_id: "asset1",
      purpose: "first_frame",
      story_ref: story.ref,
      source: "imagegen_fresh",
      input_refs: [],
      allowed_change: "Create preview",
      preserve_criteria: ["Story"],
      consent_ref: ref,
      rights_ref: ref,
      estimated_meters: [{ meter: "attempts", reserved: 1 }],
      attempt_limit: 1,
      scope_status: "proposed",
    };
    presented.push({ role: "asset-intent", ref: f.json(intent, intent.schema_id), revision: 1 });
  }
  const common = {
    schema_id: "penny.videogen-gate-packet.v1",
    schema_version: 1,
    run_id: f.run_id,
    challenge: `challenge_${gate}`,
    producer_state: producers[gate],
    presented,
    prior_decisions,
    change_summary: "Exact current fixture versions",
    affected_shot_ids: ["shot1"],
    limitations: ["Provider-free protocol fixture only"],
    rights_refs: [],
    review_evidence_refs: [],
    questions: ["Accept this exact scope?"],
  };
  const value =
    gate === "clarify"
      ? { ...common, kind: "clarification", gate_id: "clarify", choices: ["answer", "cancel"] }
      : {
          ...common,
          kind: "approval",
          gate_id: gate,
          effect_scope: {
            kinds:
              gate === "G1"
                ? ["child_imagegen"]
                : gate === "G3" || gate === "G4"
                  ? ["video_render"]
                  : [],
            subject_ids:
              gate === "G1" ? ["asset1"] : gate === "G3" || gate === "G4" ? ["shot1"] : [],
            meters: ["G1", "G3", "G4"].includes(gate) ? [{ meter: "attempts", limit: 1 }] : [],
            ...(gate === "G5" ? { destination_id: "local-output" } : {}),
          },
          choices: ["approve", "refine", "deny"],
        };
  const packet = validateGatePacket(value, limits);
  return { packet, packet_ref: f.json(packet, packet.schema_id) };
}
function stop(
  context: RunContext,
  action: "incomplete" | "cancelled" = "incomplete",
  result: Record<string, JsonValue> = {}
): Directive {
  context.transition(action);
  context.status = action;
  context.met = false;
  const next = validateDirective({
    schema_version: 2,
    action,
    identity: context.identity,
    status: action,
    met: false,
    result,
    artifacts: context.selectedArtifacts,
    unresolved: [],
  });
  context.pendingDirective = next;
  context.terminalDirective = next;
  return next;
}
/** Test-only sequential prerequisites. No production flow, effect or completion claim. */
class GateFixturePlaybook implements PlaybookCore {
  constructor(
    readonly packets: readonly PacketFixture[],
    readonly host: GateBindingHostV1
  ) {}
  private present(context: RunContext, item: PacketFixture): Directive {
    const { packet, packet_ref } = item;
    checkGatePacket(this.host, packet);
    context.transition(packet.gate_id === "clarify" ? "clarify" : packet.gate_id.toLowerCase());
    context.status = "awaiting_user";
    context.selectedArtifacts = [packet_ref];
    const next = validateDirective({
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: context.stateId,
      gate_id: `engine_${packet.gate_id}`,
      challenge: packet.challenge,
      payload_digest: packet_ref.content_digest,
      questions: [{ id: "decision", prompt: "Exact fixture packet only" }],
    });
    context.pendingDirective = next;
    return next;
  }
  initialize(context: RunContext): Directive {
    const first = this.packets[0];
    if (first === undefined) throw new Error("fixture packet missing");
    return this.present(context, first);
  }
  dispatch(context: RunContext): Directive {
    if (context.pendingDirective === null) throw new Error("fixture pending missing");
    return context.pendingDirective;
  }
  resume(context: RunContext, response: JsonValue): Directive {
    const pending = context.pendingDirective;
    if (pending?.action !== "await_user") throw new Error("fixture wait missing");
    const index = this.packets.findIndex((x) => x.packet.challenge === pending.challenge);
    const item = this.packets[index];
    if (item === undefined) throw new Error("fixture packet missing");
    const outcome = respondToGate({ host: this.host, packet_ref: item.packet_ref, response });
    const next = this.packets[index + 1];
    if (outcome.action === "approved" && next !== undefined) {
      // The next gate is presented on dispatch AFTER engine commitment and owner selection.
      context.status = "running";
      context.pendingDirective = null;
      context.transition("prerequisite_committed");
      const paused = validateDirective({
        schema_version: 2,
        action: "status",
        identity: context.identity,
        status: context.status,
        state_id: context.stateId,
        terminal: false,
        met: false,
      });
      context.pendingDirective = paused;
      return paused;
    }
    return stop(context, outcome.action === "cancel" ? "cancelled" : "incomplete", {
      gate_action: outcome.action,
      effect_scope_class: outcome.effect_authority,
      ...(outcome.action === "refine" || outcome.action === "clarification_answer"
        ? { producer_state: outcome.producer_state }
        : {}),
    });
  }
  cancel(context: RunContext): Directive {
    return stop(context, "cancelled");
  }
  acceptSummary(): Directive {
    throw new Error("fixture never invokes workers");
  }
  rebindPendingDirective(context: RunContext): Directive | null {
    if (context.stateId !== "prerequisite_committed") return context.pendingDirective;
    const lastGate = this.packets.findIndex(
      (x) => x.packet.gate_id.toLowerCase() === context.previousState
    );
    const next = this.packets[lastGate + 1];
    if (context.stateId !== "prerequisite_committed" || next === undefined)
      throw new Error("fixture continuation missing");
    return this.present(context, next);
  }
}
function registration(
  core: PlaybookCore,
  completion: CompletionGate = { ...VIDEOGEN_COMPLETION_GATE, required_receipt_predicates: [] }
): PlaybookRegistration {
  const contract = {
    ...RESEARCH_SKILL_CONTRACT,
    name: NAME,
    repair_routing: { schema_version: 1 as const, routes: [] },
    completion_gate: completion,
  };
  return {
    name: NAME,
    contract,
    ingress: "dedicated_tool",
    liveness: {
      resolver_id: contract.budget_policy.resolver_id,
      resolve: () => undefined,
      thinking_policy: "agent_ssot",
    },
    worker: {
      kind: "none",
      workflow_name: NAME,
      guidance: contract.guidance,
      guidance_required: true,
      result_transport: "host_typed",
      opening_policy: "none",
      model_policy: "none",
      phases: new Map<string, never>(),
    },
    completionReceiptPredicates: VIDEOGEN_UNWIRED_COMPLETION_PREDICATES,
    construct: () => core,
  };
}
function engine(f: FoundationFixture, active: PlaybookRegistration, checkpointer = f.checkpointer) {
  return new OrchestrationEngine(checkpointer, {
    projectRoot: f.root,
    maxSteps: 200,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    playbookRegistry: new Map([[NAME, active]]),
    playbookName: NAME,
    artifactStore: f.store,
    artifactReader: f.store,
  });
}
function identity(f: FoundationFixture): RunIdentity {
  return {
    schema_version: 2,
    run_id: f.run_id,
    session_id: "session_foundation_gate",
    playbook: NAME,
    engine_owner: "typescript",
  };
}
function start(f: FoundationFixture, runtime: OrchestrationEngine) {
  const next = runtime.handle({
    schema_version: 2,
    action: "start",
    identity: identity(f),
    goal: "isolated protocol fixture",
    constraints: {},
    project_root: f.root,
    trust_profile: "trusted-interactive",
  });
  if (next.action !== "await_user" || next.gate_id !== "completion_checkpoint") return next;
  return runtime.handle({
    schema_version: 2,
    action: "respond",
    identity: identity(f),
    gate_id: next.gate_id,
    challenge: next.challenge,
    response: "continue synthetic history",
  });
}
function gateFixture(
  f: FoundationFixture,
  gate: VideogenGateId | "clarify",
  transform: (packet: GatePacketV1, chain: readonly PacketFixture[]) => GatePacketV1 = (packet) =>
    packet
) {
  const gates = gate === "clarify" ? ["clarify" as const] : ORDER.slice(0, ORDER.indexOf(gate) + 1);
  const chain: PacketFixture[] = [];
  const planned: CurrentGateApprovalV1[] = [];
  for (const id of gates) {
    let item = packetFixture(
      f,
      id,
      planned.map((x) => x.decision_ref)
    );
    if (id === gate) {
      const packet = transform(item.packet, chain);
      item = { packet, packet_ref: f.json(packet, packet.schema_id) };
    }
    chain.push(item);
    if (id !== "clarify") {
      const decision = constructGateDecision(item.packet, item.packet_ref, "approve", limits);
      planned.push({
        gate_id: id,
        engine_gate_id: `engine_${id}`,
        challenge: item.packet.challenge,
        packet_ref: item.packet_ref,
        decision_ref: f.json(decision, decision.schema_id),
      });
    }
  }
  const current_approvals: CurrentGateApprovalV1[] = [];
  const host: GateBindingHostV1 = {
    store: f.store,
    checkpointer: f.checkpointer,
    project_id: f.project_id,
    run_id: f.run_id,
    limits,
    admitted_destination_id: "local-output",
    current_presented: chain.flatMap((x) => x.packet.presented),
    current_approvals,
  };
  const active = registration(new GateFixturePlaybook(chain, host));
  const runtime = engine(f, active);
  start(f, runtime);
  for (const item of chain.slice(0, -1)) {
    const selected = planned.find((x) => x.gate_id === item.packet.gate_id);
    if (selected === undefined) throw new Error("fixture approval missing");
    runtime.handle({
      schema_version: 2,
      action: "respond",
      identity: identity(f),
      gate_id: selected.engine_gate_id,
      challenge: selected.challenge,
      response: constructGateDecision(item.packet, item.packet_ref, "approve", limits),
    });
    const committed = f.checkpointer.gateResponseBinding(f.run_id, selected.engine_gate_id);
    expect(committed).toMatchObject({ status: "answered", challenge: selected.challenge });
    current_approvals.push(selected);
    runtime.handle({ schema_version: 2, action: "recover", identity: identity(f) });
  }
  const item = chain.at(-1);
  if (item === undefined) throw new Error("fixture target missing");
  return { ...item, host, chain, active, runtime, planned };
}
function reply(
  f: FoundationFixture,
  x: ReturnType<typeof gateFixture>,
  choice: "approve" | "refine" | "deny" | "answer" | "cancel"
) {
  return {
    schema_version: 2 as const,
    action: "respond" as const,
    identity: identity(f),
    gate_id: `engine_${x.packet.gate_id}`,
    challenge: x.packet.challenge,
    response: constructGateDecision(x.packet, x.packet_ref, choice, limits, "Current typed reply"),
  };
}
describe("WP004 exact current approval closure and story binding", () => {
  it.each(ORDER)("%s approves only with committed exact prerequisites", (gate) => {
    using f = new FoundationFixture();
    const x = gateFixture(f, gate);
    expect(x.host.current_approvals.map((s) => s.gate_id)).toEqual(
      ORDER.slice(0, ORDER.indexOf(gate))
    );
    expect(checkGatePacket(x.host, x.packet)).toEqual(x.packet);
    const request = reply(f, x, "approve");
    const next = x.runtime.handle(request);
    expect(next).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        gate_action: "approved",
        effect_scope_class:
          gate === "G1" ? "preview" : gate === "G3" ? "draft" : gate === "G4" ? "final" : "none",
      },
    });
    const selected = x.planned.find((s) => s.gate_id === gate);
    if (selected === undefined) throw new Error("fixture approval missing");
    // Canonical reply includes no refinement text for approve, exactly matching planned bytes.
    const host = { ...x.host, current_approvals: [...x.host.current_approvals, selected] };
    expect(checkGateApproval(host, gate, selected.decision_ref).decision).toEqual(request.response);
    expect(() =>
      respondToGate({ host, packet_ref: x.packet_ref, response: request.response })
    ).toThrow(/replay/);
  });
  it.each(ORDER.flatMap((gate) => ["refine", "deny"].map((choice) => ({ gate, choice }))))(
    "$gate $choice remains non-positive and durable",
    ({ gate, choice }) => {
      if (choice !== "refine" && choice !== "deny") throw new Error("fixture choice missing");
      using f = new FoundationFixture();
      const x = gateFixture(f, gate);
      const request = reply(f, x, choice);
      const next = x.runtime.handle(request);
      expect(next).toMatchObject({
        action: "incomplete",
        met: false,
        result: { gate_action: choice, effect_scope_class: "none" },
      });
      expect(
        x.runtime.handle({ schema_version: 2, action: "recover", identity: identity(f) })
      ).toEqual(next);
    }
  );
  it.each(["G2", "G3", "G4", "G5"] as const)(
    "%s refuses missing, extra, duplicate, reordered and stale predecessor refs",
    (gate) => {
      using f = new FoundationFixture();
      const x = gateFixture(f, gate);
      const first = x.packet.prior_decisions[0];
      if (first === undefined) throw new Error("fixture prior missing");
      const changedRef = { ...first, version: first.version + 1 };
      const arrays = [
        [],
        x.packet.prior_decisions.slice(1),
        [...x.packet.prior_decisions, f.opaque("extra")],
        [...x.packet.prior_decisions, first],
        [changedRef, ...x.packet.prior_decisions.slice(1)],
      ];
      if (x.packet.prior_decisions.length > 1) arrays.push([...x.packet.prior_decisions].reverse());
      for (const prior_decisions of arrays)
        expect(() => checkGatePacket(x.host, { ...x.packet, prior_decisions })).toThrow();
      expect(() => checkGatePacket({ ...x.host, current_approvals: [] }, x.packet)).toThrow();
      const selected = x.host.current_approvals[0];
      if (selected === undefined) throw new Error("fixture current approval missing");
      expect(() =>
        checkGatePacket(
          { ...x.host, current_approvals: [...x.host.current_approvals, selected] },
          x.packet
        )
      ).toThrow();
    }
  );
  it("G1 rejects any extra approval, and helpers reject unstarted callers", () => {
    using f = new FoundationFixture();
    const raw = packetFixture(f, "G1", []);
    const host: GateBindingHostV1 = {
      store: f.store,
      checkpointer: f.checkpointer,
      project_id: f.project_id,
      run_id: f.run_id,
      limits,
      admitted_destination_id: "local-output",
      current_approvals: [],
      current_presented: raw.packet.presented,
    };
    expect(() =>
      respondToGate({
        host,
        packet_ref: raw.packet_ref,
        response: constructGateDecision(raw.packet, raw.packet_ref, "approve", limits),
      })
    ).toThrow(/pending/);
    expect(() =>
      checkGatePacket(host, { ...raw.packet, prior_decisions: [f.opaque("extra")] })
    ).toThrow();
  });
  it.each([
    "bytes",
    "nondecision-json",
    "open-decision",
    "ref-schema",
    "ref-run",
    "run",
    "gate",
    "challenge",
    "scope",
    "packet",
    "packet-run",
    "packet-schema",
    "packet-challenge",
    "packet-gate",
    "packet-scope",
    "uncommitted",
    "pending",
    "response-digest",
    "engine-gate",
    "engine-challenge",
    "index-packet",
    "index-challenge",
  ])("refuses owner-selected %s counterfeit predecessor, not just ref mismatch", (kind) => {
    using f = new FoundationFixture();
    const x = gateFixture(f, "G3");
    const original = x.host.current_approvals.find((s) => s.gate_id === "G2");
    if (original === undefined) throw new Error("G2 fixture missing");
    const { packet, decision } = checkGateApproval(x.host, "G2", original.decision_ref);
    const selected = { ...original };
    let bad: unknown = decision;
    switch (kind) {
      case "bytes":
        selected.decision_ref = f.opaque("arbitrary readable bytes");
        break;
      case "nondecision-json":
        selected.decision_ref = f.json({ approved: true }, decision.schema_id);
        break;
      case "open-decision":
        bad = { ...decision, extra: true };
        break;
      case "ref-schema":
        selected.decision_ref = f.json(decision, "penny.videogen-timing.v1");
        break;
      case "ref-run":
        selected.decision_ref = f.json(decision, decision.schema_id, "other-run");
        break;
      case "run":
        bad = { ...decision, run_id: "other-run" };
        break;
      case "gate":
        bad = { ...decision, gate_id: "G1" };
        break;
      case "challenge":
        bad = { ...decision, challenge: "wrong" };
        break;
      case "scope":
        bad = { ...decision, resulting_scope_digest: "f".repeat(64) };
        break;
      case "packet":
        bad = { ...decision, packet_ref: f.opaque("other packet") };
        break;
      case "packet-run":
        selected.packet_ref = f.json(packet, packet.schema_id, "other-run");
        break;
      case "packet-schema":
        selected.packet_ref = f.json(packet, "penny.videogen-timing.v1");
        break;
      case "packet-challenge":
        selected.packet_ref = f.json({ ...packet, challenge: "wrong" }, packet.schema_id);
        break;
      case "packet-gate":
        selected.packet_ref = f.json(
          { ...packet, gate_id: "G5", producer_state: "finish_prepare" },
          packet.schema_id
        );
        break;
      case "packet-scope":
        selected.packet_ref = f.json(
          {
            ...packet,
            effect_scope: {
              kinds: ["video_render"],
              subject_ids: ["shot1"],
              meters: [{ meter: "attempts", limit: 1 }],
            },
          },
          packet.schema_id
        );
        break;
      case "uncommitted": {
        const freshPacket = validateGatePacket(
          { ...packet, challenge: "fresh_uncommitted" },
          limits
        );
        selected.packet_ref = f.json(freshPacket, packet.schema_id);
        selected.challenge = freshPacket.challenge;
        selected.engine_gate_id = "engine_uncommitted";
        bad = constructGateDecision(freshPacket, selected.packet_ref, "approve", limits);
        break;
      }
      case "pending": {
        const freshPacket = validateGatePacket({ ...packet, challenge: "challenge_G3" }, limits);
        selected.packet_ref = f.json(freshPacket, packet.schema_id);
        selected.challenge = freshPacket.challenge;
        selected.engine_gate_id = "engine_G3";
        bad = constructGateDecision(freshPacket, selected.packet_ref, "approve", limits);
        break;
      }
      case "response-digest": {
        // Current packet/ref/scope all match, but the engine committed different exact refs.
        selected.packet_ref = f.json(packet, packet.schema_id);
        bad = constructGateDecision(packet, selected.packet_ref, "approve", limits);
        break;
      }
      case "engine-gate":
        selected.engine_gate_id = "engine_wrong";
        break;
      case "engine-challenge":
        selected.engine_gate_id = "engine_G3";
        break;
      case "index-packet":
        selected.packet_ref = f.json(packet, packet.schema_id);
        break;
      case "index-challenge":
        selected.challenge = "wrong";
        break;
      default:
        throw new Error("unknown test case");
    }
    if (kind.startsWith("packet-")) bad = { ...decision, packet_ref: selected.packet_ref };
    if (bad !== decision) selected.decision_ref = f.json(bad, decision.schema_id);
    const host = {
      ...x.host,
      current_approvals: x.host.current_approvals.map((s) => (s.gate_id === "G2" ? selected : s)),
    };
    const prior_decisions = x.packet.prior_decisions.map((ref) =>
      ref.artifact_id === original.decision_ref.artifact_id ? selected.decision_ref : ref
    );
    expect(() => checkGatePacket(host, { ...x.packet, prior_decisions })).toThrow();
  });
  it("same decision bytes under another ref cannot replace the current owner approval", () => {
    using f = new FoundationFixture();
    const x = gateFixture(f, "G3");
    const slot = x.host.current_approvals.find((s) => s.gate_id === "G2");
    if (slot === undefined) throw new Error("G2 missing");
    const { decision } = checkGateApproval(x.host, "G2", slot.decision_ref);
    const other = f.json(decision, decision.schema_id);
    expect(other.content_digest).toBe(slot.decision_ref.content_digest);
    expect(() =>
      checkGatePacket(x.host, {
        ...x.packet,
        prior_decisions: [x.packet.prior_decisions[0], other],
      })
    ).toThrow(/owner/);
  });
  it.each(["G3", "G4", "G5"] as const)(
    "%s rechecks earlier current canon, look, performance and route revisions",
    (gate) => {
      using f = new FoundationFixture();
      const x = gateFixture(f, gate);
      for (const role of [
        "story",
        "look-voice",
        "performance",
        ...(gate === "G3" ? [] : ["voice-route"]),
      ]) {
        for (const change of ["replace", "revision", "remove"] as const) {
          const current_presented = x.host.current_presented.flatMap((p) =>
            p.role !== role
              ? [p]
              : change === "remove"
                ? []
                : [
                    {
                      ...p,
                      ...(change === "replace"
                        ? { ref: f.opaque(`changed ${role}`) }
                        : { revision: p.revision + 1 }),
                    },
                  ]
          );
          expect(() => checkGatePacket({ ...x.host, current_presented }, x.packet)).toThrow(
            /stale/
          );
        }
      }
    }
  );
  it("earlier packet cannot omit its own predecessors, add a cycle or authorize changed scope", () => {
    using f = new FoundationFixture();
    const x = gateFixture(f, "G5");
    const slot = x.host.current_approvals.find((s) => s.gate_id === "G3");
    if (slot === undefined) throw new Error("G3 missing");
    const { packet } = checkGateApproval(x.host, "G3", slot.decision_ref);
    if (packet.kind !== "approval") throw new Error("approval missing");
    for (const value of [
      { ...packet, prior_decisions: [] },
      { ...packet, prior_decisions: [slot.decision_ref] },
      { ...packet, effect_scope: { ...packet.effect_scope, subject_ids: ["new-shot"] } },
    ]) {
      const packet_ref = f.json(value, packet.schema_id);
      const decision = constructGateDecision(
        validateGatePacket(value, limits),
        packet_ref,
        "approve",
        limits
      );
      const decision_ref = f.json(decision, decision.schema_id);
      const host = {
        ...x.host,
        current_approvals: x.host.current_approvals.map((s) =>
          s.gate_id === "G3" ? { ...s, packet_ref, decision_ref } : s
        ),
      };
      expect(() =>
        checkGatePacket(host, {
          ...x.packet,
          prior_decisions: x.packet.prior_decisions.map((ref) =>
            ref.artifact_id === slot.decision_ref.artifact_id ? decision_ref : ref
          ),
        })
      ).toThrow();
    }
  });
  it.each(["refine", "deny", "answer", "cancel"] as const)(
    "committed %s cannot occupy an approval slot",
    (choice) => {
      using f = new FoundationFixture();
      const x = gateFixture(f, choice === "answer" || choice === "cancel" ? "clarify" : "G1");
      const request = reply(f, x, choice);
      x.runtime.handle(request);
      expect(f.checkpointer.gateResponseBinding(f.run_id, request.gate_id)?.status).toBe(
        "answered"
      );
      const decision_ref = f.json(request.response, request.response.schema_id);
      const g2 = packetFixture(f, "G2", [decision_ref]);
      const host = {
        ...x.host,
        current_presented: [...x.host.current_presented, ...g2.packet.presented],
        current_approvals: [
          {
            gate_id: "G1" as const,
            engine_gate_id: request.gate_id,
            challenge: x.packet.challenge,
            packet_ref: x.packet_ref,
            decision_ref,
          },
        ],
      };
      expect(() => checkGatePacket(host, g2.packet)).toThrow(/identity\/choice/);
    }
  );
  it.each(["answer", "cancel"] as const)("clarification %s never grants effect scope", (choice) => {
    using f = new FoundationFixture();
    const x = gateFixture(f, "clarify");
    const next = x.runtime.handle(reply(f, x, choice));
    expect(next).toMatchObject({
      action: choice === "cancel" ? "cancelled" : "incomplete",
      met: false,
      result: {
        gate_action: choice === "answer" ? "clarification_answer" : "cancel",
        effect_scope_class: "none",
      },
    });
  });
  it.each([
    "duplicate-story",
    "other-story",
    "other-run-story",
    "other-run-presentation",
    "unknown-asset",
    "approved-intent",
    "overspend",
    "no-story",
  ])("G1 refuses %s even when refs are readable/current", (kind) => {
    using f = new FoundationFixture();
    const x = gateFixture(f, "G1");
    if (x.packet.kind !== "approval") throw new Error("G1 missing");
    let presented = [...x.packet.presented];
    const story = presented.find((p) => p.role === "story");
    const item = presented.find((p) => p.role === "asset-intent");
    if (story === undefined || item === undefined) throw new Error("fixture operand missing");
    const raw: unknown = JSON.parse(f.store.read(item.ref).toString());
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("fixture intent missing");
    switch (kind) {
      case "duplicate-story":
        presented.push({ role: "story", ref: f.opaque("duplicate story"), revision: 1 });
        break;
      case "no-story":
        presented = presented.filter((p) => p.role !== "story");
        break;
      case "other-run-presentation": {
        const ref = f.opaque("other run canon", "application/json", "other-run");
        presented = presented.map((p) => (p.role === "story" ? { ...p, ref } : p));
        const intentRef = f.json({ ...raw, story_ref: ref }, "penny.videogen-asset-intent.v1");
        presented = presented.map((p) =>
          p.role === "asset-intent" ? { ...p, ref: intentRef } : p
        );
        break;
      }
      default: {
        const patch =
          kind === "other-story"
            ? { story_ref: f.opaque("unpresented story") }
            : kind === "other-run-story"
              ? { story_ref: f.opaque("other run canon", "application/json", "other-run") }
              : kind === "unknown-asset"
                ? { asset_id: "asset2" }
                : kind === "approved-intent"
                  ? { scope_status: "approved", gate_scope_ref: x.packet_ref }
                  : { estimated_meters: [{ meter: "attempts", reserved: 2 }] };
        const ref = f.json({ ...raw, ...patch }, "penny.videogen-asset-intent.v1");
        presented = presented.map((p) => (p.role === "asset-intent" ? { ...p, ref } : p));
      }
    }
    expect(() =>
      checkGatePacket({ ...x.host, current_presented: presented }, { ...x.packet, presented })
    ).toThrow();
  });
  it("empty campaigns, version-only effects and unadmitted destinations remain refused", () => {
    using f = new FoundationFixture();
    const x = gateFixture(f, "G5");
    if (x.packet.kind !== "approval") throw new Error("G5 missing");
    const scope = x.packet.effect_scope;
    expect(() =>
      checkGatePacket(x.host, { ...x.packet, effect_scope: { ...scope, destination_id: "other" } })
    ).toThrow();
    for (const gate of ORDER) {
      const packet = packetFixture(f, gate, []).packet;
      if (packet.kind !== "approval") throw new Error("approval missing");
      if (gate === "G1" || gate === "G3" || gate === "G4")
        expect(() =>
          validateGatePacket(
            { ...packet, effect_scope: { kinds: [], subject_ids: [], meters: [] } },
            limits
          )
        ).toThrow();
      else expect(validateGatePacket(packet, limits)).toEqual(packet);
      if (gate === "G2" || gate === "G5")
        expect(() =>
          validateGatePacket(
            {
              ...packet,
              effect_scope: {
                kinds: ["video_render"],
                subject_ids: ["shot1"],
                meters: [{ meter: "attempts", limit: 1 }],
              },
            },
            limits
          )
        ).toThrow();
    }
  });
  it.each(["approve", "refine", "deny", "answer", "cancel"] as const)(
    "%s preserves exact engine duplicate/legacy replay and restart",
    (choice) => {
      using f = new FoundationFixture();
      const x = gateFixture(f, choice === "answer" || choice === "cancel" ? "clarify" : "G3");
      const request = reply(f, x, choice);
      for (const bad of [
        { ...request, challenge: "wrong" },
        { ...request, gate_id: "wrong" },
        { ...request, response: { ...request.response, run_id: "other" } },
        { ...request, response: { ...request.response, packet_ref: f.opaque("other") } },
        { ...request, response: { ...request.response, challenge: "wrong" } },
      ])
        expect(() => x.runtime.handle(bad)).toThrow();
      const next = x.runtime.handle(request);
      expect(f.checkpointer.gateResponseBinding(f.run_id, request.gate_id)).toMatchObject({
        status: "answered",
        challenge: request.challenge,
        response_digest: sha256(canonicalJson(request.response)),
      });
      using reopened = Checkpointer.openExisting(f.checkpointer.dbPath, undefined, {
        projectId: f.project_id,
      });
      const resumed = engine(f, x.active, reopened);
      // An exact engine duplicate remains a replay even when owner operands later become stale.
      const originalIndex = x.host.current_presented;
      const staleHost = {
        ...x.host,
        current_presented: originalIndex.map((p) => ({ ...p, revision: p.revision + 1 })),
      };
      expect(() => checkGatePacket(staleHost, x.packet)).toThrow(/stale/);
      expect(resumed.handle(request)).toEqual(next);
      expect(
        resumed.handle({ schema_version: 2, action: "recover", identity: identity(f) })
      ).toEqual(next);
      expect(() => resumed.handle({ ...request, response: { changed: true } })).toThrow(
        /differently/
      );
    }
  );
  it("pending responses cannot change gate, scope, packet or current presented revisions", () => {
    using f = new FoundationFixture();
    const x = gateFixture(f, "G3");
    const request = reply(f, x, "approve");
    for (const response of [
      { ...request.response, gate_id: "G4" },
      { ...request.response, resulting_scope_digest: "f".repeat(64) },
      { ...request.response, packet_ref: f.json(x.packet, x.packet.schema_id) },
    ])
      expect(() => x.runtime.handle({ ...request, response })).toThrow();
    expect(() =>
      respondToGate({
        host: {
          ...x.host,
          current_presented: x.host.current_presented.map((p) => ({
            ...p,
            revision: p.revision + 1,
          })),
        },
        packet_ref: x.packet_ref,
        response: request.response,
      })
    ).toThrow(/stale/);
    expect(f.checkpointer.gateResponseBinding(f.run_id, request.gate_id)?.status).toBe("pending");
  });
  it("silence remains pending, exact cancel durable and wrong run cannot consume", () => {
    using f = new FoundationFixture();
    const x = gateFixture(f, "G4");
    const pending = x.runtime.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(f),
    });
    expect(pending.action).toBe("await_user");
    expect(() =>
      x.runtime.handle({ ...reply(f, x, "approve"), identity: { ...identity(f), run_id: "other" } })
    ).toThrow();
    const cancelled = x.runtime.handle({
      schema_version: 2,
      action: "cancel",
      identity: identity(f),
      reason: "explicit fixture cancellation",
    });
    expect(cancelled).toMatchObject({ action: "cancelled", met: false });
    expect(
      x.runtime.handle({ schema_version: 2, action: "recover", identity: identity(f) })
    ).toEqual(cancelled);
  });
});
describe("WP005 G2 speech binding preflight (synthetic host projections only)", () => {
  it("checks committed exact G2, selected look, captured bytes and actual alignment; changed/provisional inputs refuse", () => {
    using f = new FoundationFixture();
    const profile = f.opaque("profile");
    const settings = f.opaque("settings");
    const output = f.opaque("output");
    const consent = f.opaque("fixture consent");
    const wav = f.opaque("captured fixture bytes, not speech qualification", "audio/wav");
    const png = f.opaque("selected look fixture", "image/png");
    const script = f.opaque("fixture actual script");
    const review = f.opaque("host alignment review fixture");
    const timingValue = {
      schema_id: "penny.videogen-timing.v1",
      schema_version: 1,
      performance_ref: wav,
      script_ref: script,
      source_sample_rate: { numerator: 48000, denominator: 1 },
      measured_samples: 96000,
      utterances: [
        {
          line_id: "line1",
          start_sample: 0,
          end_sample: 96000,
          alignment_method: "human_review",
          review_ref: review,
        },
      ],
      uncertain_line_ids: [],
    };
    const timing = f.json(timingValue, timingValue.schema_id);
    const audio = f.opaque("fixture audio evidence");
    let look = f.json(
      {
        schema_id: "penny.videogen-look-voice.v1",
        schema_version: 1,
        story_ref: f.opaque("story"),
        approved_pngs: [{ asset_id: "look1", role: "first_frame", revision: 1, png_ref: png }],
        style_sheet_ref: f.opaque("style"),
        voice_identity: {
          voice_id: "voice1",
          source: "supplied",
          language: "en",
          consent_ref: consent,
        },
        performance_ref: wav,
        audio_evidence_ref: audio,
        timing_ref: timing,
        license_refs: [],
        preview_receipts: [],
        known_limits: ["synthetic host projection"],
      },
      "penny.videogen-look-voice.v1"
    );
    const x = gateFixture(f, "G2", (original, chain) => {
      const story = chain[0]?.packet.presented.find((p) => p.role === "story");
      if (story === undefined) throw new Error("fixture story missing");
      const lookValue: unknown = JSON.parse(f.store.read(look).toString());
      if (lookValue === null || typeof lookValue !== "object" || Array.isArray(lookValue))
        throw new Error("fixture look missing");
      look = f.json({ ...lookValue, story_ref: story.ref }, "penny.videogen-look-voice.v1");
      return validateGatePacket(
        {
          ...original,
          presented: [
            { role: "look-voice", ref: look, revision: 1 },
            { role: "performance", ref: wav, revision: 1 },
            { role: "timing", ref: timing, revision: 1 },
            { role: "look", ref: png, revision: 1 },
          ],
        },
        limits
      );
    });
    const { packet, packet_ref, host: gate_host, runtime } = x;
    const decision = constructGateDecision(packet, packet_ref, "approve", limits);
    runtime.handle({ ...reply(f, x, "approve"), response: decision });
    const g2 = f.json(decision, decision.schema_id);
    const g2Selected = {
      gate_id: "G2" as const,
      engine_gate_id: "engine_G2",
      challenge: packet.challenge,
      packet_ref,
      decision_ref: g2,
    };
    const currentGateHost = {
      ...gate_host,
      current_approvals: [...gate_host.current_approvals, g2Selected],
    };
    const rights = [
      f.rights(profile, "model"),
      f.rights(wav, "voice", [consent]),
      f.rights(png),
      f.rights(timing, "text"),
    ];
    const mode = {
      mode: "speech_conditioned",
      shot_id: "shot1",
      profile_snapshot_ref: profile,
      settings_ref: settings,
      rights_refs: rights,
      prompt_ref: f.opaque("prompt"),
      expected_output_contract_ref: output,
      target: {
        width: 640,
        height: 360,
        frame_count: 48,
        fps: { numerator: 24, denominator: 1 },
        duration: { numerator: 2, denominator: 1 },
      },
      performance_audio_ref: wav,
      timing_ref: timing,
      look_inputs: [png],
      consent_ref: consent,
      sync_target: "line1",
    };
    const ports: ShotPortV1[] = [
      {
        port_id: "audio",
        semantic_role: "performance",
        ref: wav,
        media_type: "audio/wav",
        byte_limit: 10000,
        mutation_node: "audio",
        mutation_input: "audio",
        upload_operation_id: "upload_audio",
      },
      {
        port_id: "timing",
        semantic_role: "timing",
        ref: timing,
        media_type: "application/json",
        byte_limit: 10000,
        mutation_node: "timing",
        mutation_input: "timing",
        upload_operation_id: "upload_timing",
      },
      {
        port_id: "look",
        semantic_role: "look-0",
        ref: png,
        media_type: "image/png",
        byte_limit: 10000,
        mutation_node: "look",
        mutation_input: "image",
        upload_operation_id: "upload_look",
      },
    ];
    const capability: ShotCapabilityV1 = {
      schema_id: "penny.videogen-shot-capability.v1",
      schema_version: 1,
      profile_snapshot_ref: profile,
      settings_ref: settings,
      expected_output_contract_ref: output,
      qualification_ref: f.opaque("host qualification fixture"),
      mode: "speech_conditioned",
      output_field: "images",
      max_width: 640,
      max_height: 360,
      max_frames: 48,
      max_duration: { numerator: 2, denominator: 1 },
      ports: ports.map(({ ref: _ref, upload_operation_id: _op, ...p }) => p),
    };
    const binding = {
      schema_id: "penny.videogen-speech-preflight-binding.v1",
      schema_version: 1,
      g2_decision_ref: g2,
      look_selection_ref: look,
      playback_confirmation_ref: f.opaque("host playback projection"),
      performance_ref: wav,
      timing_ref: timing,
      script_ref: script,
      audio_evidence_ref: audio,
      decode_receipt_ref: f.opaque("fixture decoder receipt"),
      alignment_review_refs: [review],
    };
    const current_speech_binding_ref = f.json(binding, binding.schema_id);
    const host: ShotPreflightHostV1 = {
      ...f.host(),
      checkpointer: f.checkpointer,
      gate_host: currentGateHost,
      current_capability: capability,
      supported_output_fields: ["images"],
      current_speech_binding_ref,
    };
    expect(preflightShotMode({ host, mode, ports, output_field: "images" }).mode).toBe(
      "speech_conditioned"
    );
    const { current_speech_binding_ref: _absent, ...unbound } = host;
    expect(() => preflightShotMode({ host: unbound, mode, ports, output_field: "images" })).toThrow(
      /G2/
    );
    expect(() =>
      preflightShotMode({
        host: { ...host, gate_host: { ...currentGateHost, current_presented: [] } },
        mode,
        ports,
        output_field: "images",
      })
    ).toThrow(/stale/);
    for (const role of ["story", "asset-intent"]) {
      const current_presented = currentGateHost.current_presented.map((p) =>
        p.role === role ? { ...p, revision: p.revision + 1 } : p
      );
      expect(() =>
        preflightShotMode({
          host: { ...host, gate_host: { ...currentGateHost, current_presented } },
          mode,
          ports,
          output_field: "images",
        })
      ).toThrow(/stale/);
    }
    expect(() =>
      preflightShotMode({
        host: { ...host, gate_host: { ...currentGateHost, current_approvals: [] } },
        mode,
        ports,
        output_field: "images",
      })
    ).toThrow(/current/);
    const changedTiming = f.json(
      { ...timingValue, uncertain_line_ids: ["line1"] },
      timingValue.schema_id
    );
    const changedLook = f.json(
      { schema_id: "penny.videogen-look-voice.v1", schema_version: 1 },
      "penny.videogen-look-voice.v1"
    );
    for (const replacement of [
      { ...binding, timing_ref: changedTiming },
      { ...binding, performance_ref: f.opaque("re-performance", "audio/wav") },
      { ...binding, look_selection_ref: changedLook },
      {
        ...binding,
        g2_decision_ref: f.json({ ...decision, challenge: "uncommitted" }, decision.schema_id),
      },
    ])
      expect(() =>
        preflightShotMode({
          host: { ...host, current_speech_binding_ref: f.json(replacement, binding.schema_id) },
          mode,
          ports,
          output_field: "images",
        })
      ).toThrow();
  });
});
/** Synthetic candidate with correct origin/history, not actual media or final workflow encoding. */
class CompletionFixturePlaybook implements PlaybookCore {
  constructor(readonly f: FoundationFixture) {}
  initialize(context: RunContext): Directive {
    for (const state of VIDEOGEN_COMPLETION_GATE.required_visited_states.slice(0, 16))
      context.transition(state);
    context.status = "awaiting_user";
    const next = validateDirective({
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: context.stateId,
      gate_id: "completion_checkpoint",
      challenge: "completion_checkpoint",
      payload_digest: "0".repeat(64),
      questions: [
        { id: "continue", prompt: "Checkpoint synthetic visits, never a production approval" },
      ],
    });
    context.pendingDirective = next;
    return next;
  }
  private candidate(context: RunContext): Directive {
    for (const state of VIDEOGEN_COMPLETION_GATE.required_visited_states.slice(16))
      context.transition(state);
    const product = this.f.json(
      {
        schema_id: "penny.videogen-terminal.v1",
        schema_version: 1,
        status: "delivered",
        met: true,
        unresolved_operation_ids: [],
        fixture_only: true,
      },
      "penny.videogen-terminal.v1",
      context.identity.run_id,
      "completion_check",
      "videogen-terminal"
    );
    context.selectedArtifacts = [product];
    context.transition("delivered");
    context.status = "complete";
    context.met = true;
    const next = validateDirective({
      schema_version: 2,
      action: "complete",
      identity: context.identity,
      status: "complete",
      met: true,
      result: { met: true },
      artifacts: [product],
      unresolved: [],
    });
    context.pendingDirective = next;
    context.terminalDirective = next;
    return next;
  }
  dispatch(context: RunContext): Directive {
    if (context.terminalDirective === null) throw new Error("missing terminal");
    return context.terminalDirective;
  }
  resume(context: RunContext): Directive {
    return this.candidate(context);
  }
  cancel(context: RunContext): Directive {
    return stop(context, "cancelled");
  }
  acceptSummary(): Directive {
    throw new Error("no workers");
  }
  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
}
describe("CompletionGate v2 keeps missing proof non-positive", () => {
  it("keeps exact seven predicate IDs with hidden fail-closed videogen registration", () => {
    expect(VIDEOGEN_COMPLETION_PREDICATE_IDS).toHaveLength(7);
    expect(VIDEOGEN_COMPLETION_GATE.required_receipt_predicates).toEqual([
      ...VIDEOGEN_COMPLETION_PREDICATE_IDS,
    ]);
    expect(PLAYBOOK_REGISTRY.has("videogen")).toBe(true);
  });
  it.each(VIDEOGEN_COMPLETION_PREDICATE_IDS)(
    "missing %s independently refuses a synthetic positive durably",
    (predicate) => {
      using f = new FoundationFixture();
      const active = registration(new CompletionFixturePlaybook(f), {
        ...VIDEOGEN_COMPLETION_GATE,
        required_receipt_predicates: [predicate],
      });
      const runtime = engine(f, active);
      const next = start(f, runtime);
      expect(next).toMatchObject({ action: "incomplete", met: false });
      expect(canonicalJson(next)).toContain("RECEIPT_PREDICATE_FAILED");
      using reopened = Checkpointer.openExisting(f.checkpointer.dbPath, undefined, {
        projectId: f.project_id,
      });
      expect(
        engine(f, active, reopened).handle({
          schema_version: 2,
          action: "recover",
          identity: identity(f),
        })
      ).toEqual(next);
    }
  );
  it("doesn't register an unknown/missing predicate or accept worker PASS as production proof", () => {
    using f = new FoundationFixture();
    const active = registration(new CompletionFixturePlaybook(f), {
      ...VIDEOGEN_COMPLETION_GATE,
      required_receipt_predicates: ["videogen.missing.v1"],
    });
    expect(() => validateRegistrationContract(active)).toThrow(/UNKNOWN/);
    const next = start(
      f,
      engine(f, registration(new CompletionFixturePlaybook(f), VIDEOGEN_COMPLETION_GATE))
    );
    expect(next).toMatchObject({ action: "incomplete", met: false });
  });
});
