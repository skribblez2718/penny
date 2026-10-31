import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../dist/canonical-json.js";
import { Type } from "typebox";
import { JsonValueSchema, validateContract } from "../dist/contracts.js";
import { setup } from "./helpers/videogen-executor-fixture.js";
import { FoundationFixture } from "./helpers/videogen-foundation-fixtures.js";
import { videogenStageRequest } from "./helpers/videogen-stage-fixtures.js";
import { executionState, slot } from "../dist/videogen/execution-state.js";
import { createVideogenRegistration } from "../dist/playbooks/videogen.js";
import {
  GENERIC_CHILD_PARENT_POLICY,
  PLAYBOOK_REGISTRY,
  validateRegistrationContract,
} from "../dist/playbooks/registry.js";
import { validateChildWorkflowRequest } from "../dist/child-workflows/contracts.js";
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
describe("videogen optional branches (isolated engine paths, not production qualification)", () => {
  for (const disposition of ["resolved", "unresolved", "repeated"] as const)
    it(`drives ${disposition} verifier contradiction through bounded synthesis`, async () => {
      using f = new FoundationFixture();
      const x = setup(f),
        original = x.client.runAgent.bind(x.client);
      let checks = 0,
        syntheses = 0;
      x.client.runAgent = async (invocation) => {
        if (invocation.stateId === "evidence_synthesis") {
          syntheses++;
          return {
            text: `SUMMARY:${canonicalJson({
              schema_id: "penny.videogen-evidence-synthesis.v1",
              schema_version: 1,
              conflicts: [
                {
                  claim_a_slot: "conflicting_evidence-0",
                  claim_b_slot: "conflicting_evidence-1",
                  resolution: "Use exact script coverage",
                  reason: "Different artifact roles, not additional authority",
                },
              ],
              unresolved: disposition === "unresolved" ? ["insufficient objective evidence"] : [],
            })}`,
          };
        }
        const result = await original(invocation);
        if (invocation.stateId !== "story_check") return result;
        checks++;
        if (checks > 1 && disposition !== "repeated") return result;
        const product = validateContract(
          Type.Record(Type.String(), JsonValueSchema),
          JSON.parse(result.text.slice("SUMMARY:".length)),
          "fixture story summary"
        );
        return {
          text: `SUMMARY:${canonicalJson({ ...product, contradiction_slots: ["outline", "script"] })}`,
        };
      };
      const boundary = await x.runner.runUntilBoundary(x.engine.handle(start(f)));
      expect(syntheses).toBe(1);
      expect(checks).toBe(disposition === "unresolved" ? 1 : 2);
      expect(boundary.action).toBe(disposition === "resolved" ? "await_user" : "incomplete");
      const c = f.checkpointer.loadRun(start(f).identity),
        s = executionState(c);
      if (disposition === "resolved") {
        expect(c.stateId).toBe("g1");
        expect(slot(s, "synthesis-story_check").content_schema?.schema_id).toBe(
          "penny.videogen-evidence-synthesis.v1"
        );
      }
      expect(s.synthesis_keys).toHaveLength(1);
      expect(f.checkpointer.childWorkflowCallsForParent(f.run_id)).toHaveLength(0);
    });
  it("emits the unchanged native informational request under separate parent-only authority", async () => {
    using f = new FoundationFixture();
    const base = setup(f).providers;
    const target = GENERIC_CHILD_PARENT_POLICY.targets.find((x) => x.child_name === "decide");
    if (!target) throw new Error("decide target absent");
    const ordinary = PLAYBOOK_REGISTRY.get("decide");
    if (!ordinary?.generic_child) throw new Error("decide provider absent");
    const authority = {
      schema_version: 1 as const,
      authorization_id: "operator.videogen-information-child.v1" as const,
      parent_states: ["child_call"] as const,
      parent_policy: {
        ...GENERIC_CHILD_PARENT_POLICY,
        authorization_id: "operator.videogen-information-child.v1" as const,
        max_calls: 1,
        targets: [target],
      },
    };
    const { decisionRequest } = await import("./fixtures/decision-fixtures.js");
    const providers = {
      ...base,
      information_child: authority,
      information_triggers: [
        {
          trigger_state: "story_plan" as const,
          child_name: "decide" as const,
          request: validateContract(JsonValueSchema, decisionRequest(), "fixture child request"),
          input_slots: ["brief_analysis"],
        },
      ],
    };
    const x = setup(f, providers);
    let directive = x.engine.handle(start(f));
    for (let i = 0; i < 20 && directive.action !== "invoke_child_workflow"; i++) {
      if (directive.action !== "invoke_agent") throw new Error(canonicalJson(directive));
      directive = x.engine.authorizeDispatch(directive);
      directive = x.engine.acceptWorkerResults(
        directive.identity,
        await x.worker.execute(directive)
      );
    }
    expect(directive.action).toBe("invoke_child_workflow");
    if (directive.action !== "invoke_child_workflow") throw new Error("no child");
    expect(directive.state_id).toBe("child_call");
    expect(directive.child_name).toBe("decide");
    const request = validateChildWorkflowRequest(
      JSON.parse(f.store.read(directive.request_ref).toString())
    );
    expect(request.provider_request).toEqual(decisionRequest());
    expect(request.provider_request_schema_id).toBe(
      ordinary.generic_child.provider.native_request.port.schema_id
    );
    expect(x.registration.generic_child).toBeUndefined();
    expect(x.registration.information_child).toEqual(authority);
    expect(GENERIC_CHILD_PARENT_POLICY.targets).toHaveLength(7);
    const corrupt = createVideogenRegistration(providers);
    const malformed: unknown = {
      ...corrupt,
      information_child: { ...authority, parent_states: ["story_plan"] },
    };
    expect(() => {
      Reflect.apply(validateRegistrationContract, undefined, [malformed, root]);
    }).toThrow();
  });
  it("consumes a real ordinary Decide child and reruns its parent worker without granting an effect", async () => {
    const { CompleteVideogenFixture } = await import("./helpers/videogen-complete-fixture.js");
    const { OrchestrationService } = await import("../dist/service.js");
    const { decisionRequest, persistedDecisionDraft } =
      await import("./fixtures/decision-fixtures.js");
    using f = new CompleteVideogenFixture();
    const base = setup(f),
      target = GENERIC_CHILD_PARENT_POLICY.targets.find((x) => x.child_name === "decide");
    if (!target) throw new Error("missing target");
    const providers = {
      ...base.providers,
      information_child: {
        schema_version: 1 as const,
        authorization_id: "operator.videogen-information-child.v1" as const,
        parent_states: ["child_call"] as const,
        parent_policy: {
          ...GENERIC_CHILD_PARENT_POLICY,
          authorization_id: "operator.videogen-information-child.v1" as const,
          max_calls: 1,
          targets: [target],
        },
      },
      information_triggers: [
        {
          trigger_state: "story_plan" as const,
          child_name: "decide" as const,
          request: decisionRequest(),
          input_slots: [],
        },
      ],
    };
    const summary = (product: object) =>
      `SUMMARY:${canonicalJson({ confidence: "PROBABLE", ...product })}`;
    const outputs = [
      summary({
        analysis_complete: true,
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        strategy_delta: "Proceed with the bounded supplied decision",
      }),
      persistedDecisionDraft(),
      summary({
        verdict: "PASS",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["Exact current fixture DecisionV2"],
        strategy_delta: "Advance to independent quality review",
      }),
      summary({
        verdict: "APPROVE",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["Exact fixture decision and objective review"],
        strategy_delta: "Approve exact product",
      }),
    ];
    let childCalls = 0,
      parentPlans = 0;
    const client = {
      async runAgent(invocation: Parameters<typeof base.client.runAgent>[0]) {
        if (invocation.registration.playbook_name !== "decide") {
          if (invocation.stateId === "story_plan") parentPlans++;
          return base.client.runAgent(invocation);
        }
        const text = outputs[childCalls++];
        if (text === undefined) throw new Error("unexpected child repair");
        return { text };
      },
    };
    using service = new OrchestrationService({
      projectRoot: f.root,
      env: { PENNY_STATE_ROOT: f.stateRoot },
      playbookName: "videogen",
      videogen: providers,
      modelClient: client,
    });
    const boundary = await service.execute({ ...start(f), project_root: f.root });
    expect(boundary.action).toBe("await_user");
    expect(childCalls).toBe(4);
    expect(parentPlans).toBe(2);
    const records = service.checkpointer.childWorkflowCallsForParent(f.run_id);
    expect(records).toHaveLength(1);
    expect(records[0]?.lifecycle).toBe("consumed");
    const state = executionState(service.checkpointer.loadRun(start(f).identity));
    expect(slot(state, "information-story_plan").content_schema?.schema_id).toBe(
      "penny.decision.v2"
    );
    expect(state.effects).toHaveLength(0);
    expect(GENERIC_CHILD_PARENT_POLICY.targets).toHaveLength(7);
  });
});
