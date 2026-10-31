import { createVideogenRegistration } from "../dist/playbooks/videogen.js";
import {
  validateVideogenPrivateConfig,
  type VideogenRuntimeProvidersV1,
} from "../dist/videogen/runtime-config.js";
import { runtimeRegistrationSha256 } from "../dist/playbooks/runtime-registration-digest.js";
import { IMAGEGEN_PLAYBOOK_REGISTRATION } from "../dist/playbooks/imagegen.js";
import { childExecutionProgressLeaseBinding } from "../dist/liveness-profiles.js";
import { validateChildWorkflowRequest } from "../dist/child-workflows/contracts.js";
import { validateImagegenRequest } from "../dist/skill-contracts/imagegen.js";
import {
  evaluateVideogenCompletionProof,
  VIDEOGEN_COMPLETION_PREDICATE_IDS,
} from "../dist/videogen/completion.js";
import {
  videogenCapabilityStatus,
  VideogenProductionDossierV1Schema,
} from "../dist/videogen/capability-status.js";
import { saveExecution } from "../dist/videogen/execution-state.js";
import type { CompletionReceiptPredicateInputV1 } from "../dist/playbooks/playbook.js";
import { OrchestrationService } from "../dist/service.js";
import { CompleteVideogenFixture, completeFixture } from "./helpers/videogen-complete-fixture.js";
import { readFileSync } from "node:fs";
import { validateContract } from "../dist/contracts.js";
import { DeliveryIntentV1Schema } from "../dist/videogen/delivery.js";
import { setup } from "./helpers/videogen-executor-fixture.js";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { OrchestrationEngine } from "../dist/engine.js";
import { VIDEOGEN_PLAYBOOK_REGISTRATION } from "../dist/playbooks/videogen.js";
import { resolvePlaybook, validateRegistrationContract } from "../dist/playbooks/registry.js";
import { executionState, slot } from "../dist/videogen/execution-state.js";
import { constructGateDecision, validateGatePacket } from "../dist/videogen/gates.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { FoundationFixture, FOUNDATION_LIMITS } from "./helpers/videogen-foundation-fixtures.js";
import { videogenStageRequest } from "./helpers/videogen-stage-fixtures.js";
import { canonicalJson } from "../dist/canonical-json.js";
const root = path.resolve(import.meta.dirname, "../../..");

function start(f: FoundationFixture) {
  const request = videogenStageRequest();
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: {
      schema_version: 2 as const,
      run_id: f.run_id,
      session_id: f.run_id,
      playbook: "videogen",
      engine_owner: "typescript" as const,
    },
    goal: request.brief,
    constraints: request,
    project_root: root,
    trust_profile: "hardened-untrusted" as const,
  };
}
describe("registered videogen executor (isolated fixtures, not live qualification)", () => {
  it("explicit hidden registration is not a generic peer and missing config refuses before creating a run", () => {
    using f = new FoundationFixture();
    expect(resolvePlaybook("videogen")).toBe(VIDEOGEN_PLAYBOOK_REGISTRATION);
    expect(VIDEOGEN_PLAYBOOK_REGISTRATION.generic_child).toBeUndefined();
    validateRegistrationContract(VIDEOGEN_PLAYBOOK_REGISTRATION, root);
    const e = new OrchestrationEngine(f.checkpointer, {
      projectRoot: root,
      maxSteps: 100,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactStore: f.store,
      playbookName: "videogen",
    });
    expect(() => e.handle(start(f))).toThrow(/VIDEOGEN_PRIVATE_CONFIG_MISSING/);
    expect(f.checkpointer.loadRunById(f.run_id)).toBeUndefined();
  });
  it("real engine/runner captures brief, outline and actual script, seals canon, and waits at exact G1 across restart", async () => {
    using f = new FoundationFixture();
    const { engine, runner, registration } = setup(f);
    const boundary = await runner.runUntilBoundary(engine.handle(start(f)));
    expect(boundary.action).toBe("await_user");
    const c = f.checkpointer.loadRun(start(f).identity);
    expect(c.stateId).toBe("g1");
    expect(slot(executionState(c), "script").content_schema?.schema_id).toBe(
      "penny.videogen-script.v1"
    );
    const reopened = new OrchestrationEngine(f.checkpointer, {
      projectRoot: root,
      maxSteps: 200,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactStore: f.store,
      artifactReader: f.store,
      artifactRevisions: f.store,
      playbookRegistration: registration,
    });
    expect(reopened.handle({ schema_version: 2, action: "recover", identity: c.identity })).toEqual(
      boundary
    );
  });
  it("G1 denial is incomplete", async () => {
    using f = new FoundationFixture();
    const { engine, runner } = setup(f);
    const gate = await runner.runUntilBoundary(engine.handle(start(f)));
    if (gate.action !== "await_user") throw new Error(canonicalJson(gate));
    const c = f.checkpointer.loadRun(start(f).identity),
      packet = slot(executionState(c), "packet");
    const d = constructGateDecision(
      validateGatePacket(
        JSON.parse(f.store.readById(packet.artifact_id).toString("utf8")),
        FOUNDATION_LIMITS
      ),
      packet,
      "deny",
      FOUNDATION_LIMITS
    );
    const result = engine.handle({
      schema_version: 2,
      action: "respond",
      identity: c.identity,
      gate_id: gate.gate_id,
      challenge: gate.challenge,
      response: d,
    });
    expect(result.action).toBe("incomplete");
  });
});

it("drives the fixed complete executor through G1–G5 and actual isolated dual-product filesystem publication", async () => {
  using f = new CompleteVideogenFixture();
  const x = await completeFixture(f);
  try {
    using service = new OrchestrationService({
      projectRoot: f.root,
      env: { PENNY_STATE_ROOT: f.stateRoot },
      modelClient: x.client,
      playbookName: "videogen",
      videogen: x.providers,
    });
    let d = await service.execute({ ...start(f), project_root: f.root });
    const gates: string[] = [];
    for (let i = 0; i < 5; i++) {
      if (d.action !== "await_user") throw new Error(canonicalJson(d));
      const waiting = f.checkpointer.loadRun(start(f).identity),
        waitingRef = slot(executionState(waiting), "packet"),
        waitingPacket = validateGatePacket(
          JSON.parse(f.store.readById(waitingRef.artifact_id).toString()),
          FOUNDATION_LIMITS
        );
      if (waitingPacket.kind === "clarification") {
        expect(waiting.stateId).toBe("clarify");
        expect(x.posts()).toBe(2);
        service.captureVideogenPlaybackForRun(waiting.identity.run_id, x.playbackRef());
        d = await service.execute({
          schema_version: 2,
          action: "respond",
          identity: waiting.identity,
          gate_id: d.gate_id,
          challenge: d.challenge,
          response: constructGateDecision(
            waitingPacket,
            waitingRef,
            "answer",
            FOUNDATION_LIMITS,
            "Isolated synthetic playback record captured; not live AV qualification"
          ),
        });
        if (d.action !== "await_user") throw new Error(canonicalJson(d));
      }
      const c = f.checkpointer.loadRun(start(f).identity),
        ref = slot(executionState(c), "packet"),
        value: unknown = JSON.parse(f.store.readById(ref.artifact_id).toString());
      const packet = validateGatePacket(value, FOUNDATION_LIMITS);
      gates.push(packet.gate_id);
      const answer = constructGateDecision(packet, ref, "approve", FOUNDATION_LIMITS);
      d = await service.execute({
        schema_version: 2,
        action: "respond",
        identity: c.identity,
        gate_id: d.gate_id,
        challenge: d.challenge,
        response: answer,
      });
    }
    expect(gates).toEqual(["G1", "G2", "G3", "G4", "G5"]);
    if (d.action !== "complete") throw new Error(canonicalJson(d));
    expect(d.met).toBe(true);
    expect(d.result.context).toBe("isolated_fixture");
    expect(x.posts()).toBe(2);
    const c = f.checkpointer.loadRun(start(f).identity),
      intent: unknown = JSON.parse(
        f.store.readById(slot(executionState(c), "delivery_intent").artifact_id).toString()
      );
    const terminal = slot(executionState(c), "terminal");
    const proofInput: CompletionReceiptPredicateInputV1 = {
      checkpointer: f.checkpointer,
      context: c,
      terminal: d,
      originState: "completion_check",
      latestProduct: {
        selector: "terminal_artifact",
        schema_id: "penny.videogen-terminal.v1",
        product_schema_version: 1,
        product_id: terminal.artifact_id,
        sha256: terminal.content_digest,
      },
      artifactReader: f.store,
      projectRoot: f.root,
    };
    for (const proof of VIDEOGEN_COMPLETION_PREDICATE_IDS)
      expect(evaluateVideogenCompletionProof(proofInput, proof), proof).toBe(true);
    const cases: [[string, string], ...[string, string][]] = [
      ["videogen.gates_current.v1", "G1"],
      ["videogen.shots_current.v1", "final-shot1"],
      ["videogen.audio_playback.v1", "master_review"],
      ["videogen.native_portable.v1", "native"],
      ["videogen.delivery_exact.v1", "delivery"],
    ];
    for (const [proof, name] of cases) {
      const changed = f.checkpointer.loadRun(start(f).identity),
        state = executionState(changed);
      state.slots = state.slots.filter((x) => x.slot !== name);
      saveExecution(changed, state);
      expect(
        evaluateVideogenCompletionProof({ ...proofInput, context: changed }, proof),
        `missing ${name}`
      ).toBe(false);
    }
    const noEffects = f.checkpointer.loadRun(start(f).identity),
      empty = executionState(noEffects);
    empty.effects = [];
    saveExecution(noEffects, empty);
    expect(
      evaluateVideogenCompletionProof(
        { ...proofInput, context: noEffects },
        "videogen.effects_settled.v1"
      )
    ).toBe(false);
    const noRights = f.checkpointer.loadRun(start(f).identity),
      selection = noRights.playbookData.videogen_owner_selection;
    if (selection === null || typeof selection !== "object" || Array.isArray(selection))
      throw new Error("owner selection missing");
    selection.rights = [];
    expect(
      evaluateVideogenCompletionProof(
        { ...proofInput, context: noRights },
        "videogen.rights_current.v1"
      )
    ).toBe(false);
    const dossierValue = validateContract(
      VideogenProductionDossierV1Schema,
      {
        schema_id: "penny.videogen-production-dossier.v1",
        schema_version: 1,
        context: "isolated_fixture",
        route_id: "UC-01",
        run_id: c.identity.run_id,
        terminal_ref: terminal,
        manual_review_ref: slot(executionState(c), "playback"),
        qualification_refs: [slot(executionState(c), "native")],
        recorded_at_utc: new Date().toISOString(),
      },
      "fixture dossier"
    );
    const dossier = f.json(dossierValue, "penny.videogen-production-dossier.v1");
    const status = videogenCapabilityStatus({
      store: f.store,
      checkpointer: f.checkpointer,
      dossier_refs: [dossier],
    });
    expect(status.whole_skill_supported).toBe(false);
    expect(status.routes).toHaveLength(18);
    expect(status.routes[0]?.status).toBe("fixture_only");
    expect(status.routes.slice(1).every((x) => x.status === "not_run")).toBe(true);
    const replay = await service.execute({
      schema_version: 2,
      action: "recover",
      identity: c.identity,
    });
    expect(replay.action).toBe("complete");
    expect(x.posts()).toBe(2);
    const parsed = validateContract(DeliveryIntentV1Schema, intent, "delivered intent");
    expect(
      readFileSync(path.join(x.destination, parsed.exclusive_final_id, "products/master.mp4"))
        .byteLength
    ).toBeGreaterThan(0);
    expect(
      readFileSync(
        path.join(x.destination, parsed.exclusive_final_id, "products/project.kdenlive")
      ).toString()
    ).toContain("isolated-fixture");
  } finally {
    await x.close();
  }
});

it("refines G1 into a fresh script/canon/gate and refuses the old response", async () => {
  using f = new FoundationFixture();
  const x = setup(f);
  const first = await x.runner.runUntilBoundary(x.engine.handle(start(f)));
  if (first.action !== "await_user") throw new Error("G1 required");
  const c = f.checkpointer.loadRun(start(f).identity),
    packetRef = slot(executionState(c), "packet"),
    packet = validateGatePacket(
      JSON.parse(f.store.readById(packetRef.artifact_id).toString()),
      FOUNDATION_LIMITS
    );
  const refinement = constructGateDecision(
    packet,
    packetRef,
    "refine",
    FOUNDATION_LIMITS,
    "Clarify the ending while retaining scope"
  );
  const result = await x.runner.runUntilBoundary(
    x.engine.handle({
      schema_version: 2,
      action: "respond",
      identity: c.identity,
      gate_id: first.gate_id,
      challenge: first.challenge,
      response: refinement,
    })
  );
  expect(result.action).toBe("await_user");
  if (result.action !== "await_user") throw new Error(canonicalJson(result));
  expect(result.challenge).not.toBe(first.challenge);
  expect(() =>
    x.engine.handle({
      schema_version: 2,
      action: "respond",
      identity: c.identity,
      gate_id: first.gate_id,
      challenge: first.challenge,
      response: constructGateDecision(packet, packetRef, "approve", FOUNDATION_LIMITS),
    })
  ).toThrow();
  const cancelled = await x.runner.runUntilBoundary(
    x.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: c.identity,
      reason: "isolated fixture cancellation",
    })
  );
  expect(cancelled.action).toBe("cancelled");
  if (cancelled.action !== "cancelled") throw new Error("cancellation required");
  expect(cancelled.met).toBe(false);
});

it("constructs only the separate serial imagegen native child boundary after current G1", async () => {
  using f = new FoundationFixture();
  const base = setup(f).providers;
  const consent = f.opaque("synthetic fresh-story consent"),
    source = f.opaque("synthetic cleared story input", "text/plain"),
    rights = f.rights(source, "text", [consent]);
  const providers: VideogenRuntimeProvidersV1 = {
    ...base,
    config: validateVideogenPrivateConfig({
      ...base.config,
      rights: f.current_rights,
      assets: base.config.assets.map((a) => ({
        ...a,
        source: "imagegen_fresh",
        input_refs: [],
        consent_ref: consent,
        rights_ref: rights,
      })),
    }),
    imagegen_child: {
      schema_version: 1,
      authorization_id: "operator.controlled-imagegen-child.v1",
      max_nesting_depth: 1,
      max_active_children: 1,
      max_calls: 1,
      project_concurrency_limit: 1,
      asset_ids: ["image1"],
      parent_states: ["image_child"],
      provider_registration_sha256: runtimeRegistrationSha256(IMAGEGEN_PLAYBOOK_REGISTRATION),
      progress_lease: childExecutionProgressLeaseBinding(),
    },
    image_requests: new Map([
      [
        "image1",
        {
          schema_id: "penny.imagegen-request.v1",
          schema_version: 1,
          goal: "Construct isolated fixture image",
          profile_id: "private-image-fixture",
          count: 1,
          seed: 42,
          max_revision_rounds: 0,
          raw_prompt: null,
          dimensions: null,
          export: null,
        },
      ],
    ]),
  };
  const x = setup(f, providers),
    gate = await x.runner.runUntilBoundary(x.engine.handle(start(f)));
  if (gate.action !== "await_user") throw new Error("G1 required");
  const c = f.checkpointer.loadRun(start(f).identity),
    packetRef = slot(executionState(c), "packet"),
    packet = validateGatePacket(
      JSON.parse(f.store.readById(packetRef.artifact_id).toString()),
      FOUNDATION_LIMITS
    );
  const child = x.engine.handle({
    schema_version: 2,
    action: "respond",
    identity: c.identity,
    gate_id: gate.gate_id,
    challenge: gate.challenge,
    response: constructGateDecision(packet, packetRef, "approve", FOUNDATION_LIMITS),
  });
  expect(child.action).toBe("invoke_child_workflow");
  if (child.action !== "invoke_child_workflow") throw new Error(canonicalJson(child));
  expect(child.schema_version).toBe(3);
  expect(child.child_name).toBe("imagegen");
  expect(child.state_id).toBe("image_child");
  expect(x.registration.generic_child).toBeUndefined();
  const request = validateChildWorkflowRequest(
    JSON.parse(f.store.readById(child.request_ref.artifact_id).toString())
  );
  expect(request.provider_request_schema_id).toBe("penny.imagegen-request.v1");
  const current = f.checkpointer.loadRun(start(f).identity);
  const native = validateImagegenRequest(request.provider_request);
  expect(native.asset?.intent_ref).toEqual(slot(executionState(current), "proposal-image1"));
  expect(native.asset?.intent_ref).not.toEqual(slot(executionState(current), "intent-image1"));
  expect(f.checkpointer.childWorkflowCallsForParent(c.identity.run_id)).toHaveLength(0);
  const drift = createVideogenRegistration({
    ...providers,
    config: validateVideogenPrivateConfig({
      ...providers.config,
      optional: {
        ...providers.config.optional,
        alternatives: !providers.config.optional.alternatives,
      },
    }),
  });
  const reopened = new OrchestrationEngine(f.checkpointer, {
    projectRoot: root,
    maxSteps: 200,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactStore: f.store,
    playbookRegistration: drift,
  });
  expect(() =>
    reopened.handle({ schema_version: 2, action: "recover", identity: c.identity })
  ).toThrow(/DRIFT|registration/u);
});

it("reinspects a settled native result before preparing positive continuation", async () => {
  using f = new CompleteVideogenFixture();
  const x = await completeFixture(f);
  let lateChecks = 0;
  const effects = new Map(x.providers.effects),
    native = effects.get("kdenlive_build_verify");
  if (!native) throw new Error("fixture native provider missing");
  effects.set("kdenlive_build_verify", {
    ...native,
    createAdapter: (owners) => {
      const original = native.createAdapter(owners);
      return {
        adapter_id: original.adapter_id,
        run: (ctx) => original.run(ctx),
        inspectRequest: (input) => {
          const d = input.directive,
            record = owners.checkpointer.hostOperationCallForDirective(
              d.identity.run_id,
              d.state_id,
              d.attempt,
              d.operation_id
            );
          if (record?.lifecycle === "settled") {
            lateChecks++;
            throw new Error("injected native measurement revoked before consume");
          }
          return original.inspectRequest(input);
        },
      };
    },
  });
  try {
    using service = new OrchestrationService({
      projectRoot: f.root,
      env: { PENNY_STATE_ROOT: f.stateRoot },
      modelClient: x.client,
      playbookName: "videogen",
      videogen: { ...x.providers, effects },
    });
    let boundary = await service.execute({ ...start(f), project_root: f.root });
    for (let i = 0; i < 4; i++) {
      if (boundary.action !== "await_user") throw new Error(canonicalJson(boundary));
      const c = service.checkpointer.loadRun(start(f).identity),
        ref = slot(executionState(c), "packet"),
        packet = validateGatePacket(
          JSON.parse(service.artifacts.read(ref).toString()),
          FOUNDATION_LIMITS
        );
      boundary = await service.execute({
        schema_version: 2,
        action: "respond",
        identity: c.identity,
        gate_id: boundary.gate_id,
        challenge: boundary.challenge,
        response: constructGateDecision(packet, ref, "approve", FOUNDATION_LIMITS),
      });
    }
    expect(lateChecks).toBe(1);
    expect(boundary.action).toBe("incomplete");
    if (boundary.action !== "incomplete") throw new Error("expected refusal");
    expect(boundary.unresolved.join(" ")).toMatch(/measurement revoked before consume/);
    expect(
      executionState(service.checkpointer.loadRun(start(f).identity)).slots.some(
        (x) => x.slot === "G5"
      )
    ).toBe(false);
  } finally {
    await x.close();
  }
}, 60000);
