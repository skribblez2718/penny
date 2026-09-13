import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  GENERIC_CHILD_WORKFLOW_NAMES,
  PLAYBOOK_REGISTRY,
  assertGenericChildAuthorityProjection,
  bindGenericChildYamlAuthority,
  isGenericChildWorkflowEligible,
  runtimeRegistrationSha256,
  validateGenericChildProviderRequest,
  validateRegistrationContract,
  type GenericChildWorkflowName,
  type PlaybookRegistrationV1,
} from "../src/playbooks/registry.js";
import { canonicalizePlanRequest } from "../src/skill-contracts/plan.js";
import { canonicalizeResearchRequest } from "../src/skill-contracts/research.js";
import type { ChildWorkflowRequestV1 } from "../src/child-workflows/contracts.js";
import type { JsonValue, LeaseBoundInvokeChildWorkflowDirectiveV1 } from "../src/contracts.js";
import { assertWorkerExecutableDirective } from "../src/worker.js";
import { decisionRequest } from "./fixtures/decision-fixtures.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Pin the approved operator decision independently of the exported implementation constant. */
const EXPECTED_GENERIC_CHILD_WORKFLOW_NAMES = [
  "assess",
  "decide",
  "diagnose",
  "plan",
  "produce",
  "research",
] as const satisfies readonly GenericChildWorkflowName[];

const ACTIVE_PLAYBOOK_REGISTRY = new Map(
  [...PLAYBOOK_REGISTRY].map(
    ([name, value]) => [name, bindGenericChildYamlAuthority(value, PROJECT_ROOT)] as const
  )
);

function registration(name: string): PlaybookRegistrationV1 {
  const value = ACTIVE_PLAYBOOK_REGISTRY.get(name);
  if (value === undefined) throw new Error(`missing registration '${name}'`);
  return value;
}

function readAgentTools(agent: string): readonly string[] {
  const text = readFileSync(`${PROJECT_ROOT}/.pi/agents/${agent}.md`, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";
  const declaration = frontmatter.split(/\r?\n/u).find((line) => line.startsWith("tools:"));
  if (declaration === undefined) throw new Error(`agent '${agent}' declares no tools`);
  const tools = declaration
    .slice("tools:".length)
    .split(",")
    .map((tool) => tool.trim());
  if (tools.length === 0 || tools.some((tool) => tool.length === 0)) {
    throw new Error(`agent '${agent}' has an invalid tool declaration`);
  }
  return tools;
}

const NATIVE_REQUESTS: Readonly<Record<GenericChildWorkflowName, JsonValue>> = {
  assess: {
    schema_version: 1,
    assessment_purpose: "Assess the bounded target.",
    target: "The target is internally consistent.",
    criteria: [{ statement: "The target is consistent.", importance: "required" }],
    supplied_evidence: [{ statement: "The supplied target has no contradiction." }],
    hard_constraints: [],
    non_goals: [],
    known_uncertainties: [],
  },
  decide: decisionRequest(),
  diagnose: {
    schema_version: 1,
    problem_statement: "Why does the fixture report an unexpected value?",
    symptoms: [{ statement: "The fixture reports an unexpected value." }],
    supplied_observations: [{ statement: "The input and output values differ." }],
    environment_facts: [{ statement: "The fixture is deterministic." }],
    hard_constraints: [{ statement: "Use supplied evidence only." }],
    non_goals: [],
    known_uncertainties: [],
    permitted_test_boundary: { mode: "none" },
  },
  plan: canonicalizePlanRequest({
    goal: "Plan the bounded fixture.",
    constraints: {
      schema_version: 1,
      desired_outcomes: ["The fixture has an ordered plan."],
      current_state: { status: "provided", facts: ["The input is complete."] },
      hard_constraints: [],
      non_goals: [],
      known_uncertainties: [],
      prior_decisions: [],
    },
    exactInputArtifactIds: [],
  }),
  produce: {
    schema_version: 1,
    purpose_statement: "Create one bounded text artifact.",
    output_name: "bounded-output.txt",
    artifact_kind: "text",
    specification: [{ statement: "State the supplied fact exactly once." }],
    source_material: [{ statement: "The fixture is bounded." }],
    acceptance_criteria: [{ statement: "The artifact is non-empty." }],
    hard_constraints: [{ statement: "Do not add unsupported facts." }],
    non_goals: [],
    known_uncertainties: [],
  },
  research: canonicalizeResearchRequest({
    question: "What does the bounded fixture establish?",
    constraints: {},
  }),
};

function childRequest(
  parentName: GenericChildWorkflowName,
  childName: GenericChildWorkflowName,
  providerRequest: JsonValue = NATIVE_REQUESTS[childName]
): ChildWorkflowRequestV1 {
  const child = registration(childName);
  const provider = child.generic_child?.provider;
  if (provider === undefined) throw new Error(`missing provider '${childName}'`);
  return {
    schema_id: "penny.child-workflow-request.v1",
    schema_version: 1,
    child_name: childName,
    provider_request_schema_id: provider.native_request.port.schema_id,
    provider_request_schema_version: provider.native_request.port.schema_version_required,
    provider_request: providerRequest,
    policy_binding: {
      schema_version: 1,
      project_id: "project-child-authority",
      principal_id: `parent-${parentName}`,
      scope_id: "ordinary-test",
      source_policy_id: "operator-generic-child-universal-v1",
      destination_policy_id: "registered-provider-destination-v1",
    },
  };
}

function invokeDirective(
  request: ChildWorkflowRequestV1
): LeaseBoundInvokeChildWorkflowDirectiveV1 {
  const contentDigest = "a".repeat(64);
  const provider = registration(request.child_name).generic_child?.provider;
  if (provider === undefined) throw new Error(`missing provider '${request.child_name}'`);
  const target = registration("assess").generic_child?.parent_policy.targets.find(
    (candidate) => candidate.child_name === request.child_name
  );
  if (target === undefined || target.schema_version !== 2) {
    throw new Error(`missing lease-bound target '${request.child_name}'`);
  }
  return {
    schema_version: 3,
    action: "invoke_child_workflow",
    identity: {
      schema_version: 2,
      run_id: "parent-run",
      session_id: "parent-session",
      playbook: "assess",
      engine_owner: "typescript",
    },
    state_id: "compose",
    call_key: "call-assess-assess",
    child_name: request.child_name,
    request_ref: {
      schema_version: 2,
      artifact_id: `art_${"b".repeat(64)}`,
      run_id: "parent-run",
      phase: "compose",
      branch_id: null,
      kind: "child-request",
      operation_id: "child-request-write",
      version: 1,
      producer: "host:child-owner",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.child-workflow-request.v1",
        schema_version: 1,
      },
      byte_length: 2,
      content_digest: contentDigest,
      store_ref: `artifact://sha256/${contentDigest}`,
    },
    input_artifacts: { schema_version: 2, artifacts: [] },
    expected_output: provider.expected_output,
    policy_binding: request.policy_binding,
    progress_lease: target.progress_lease,
  };
}

describe("active generic-child runtime authority projection", () => {
  it("projects exact all-six parent/provider authority and default-denies everything else", () => {
    expect(GENERIC_CHILD_WORKFLOW_NAMES).toEqual(EXPECTED_GENERIC_CHILD_WORKFLOW_NAMES);
    expect(() =>
      assertGenericChildAuthorityProjection(ACTIVE_PLAYBOOK_REGISTRY, PROJECT_ROOT)
    ).not.toThrow();

    for (const parentName of GENERIC_CHILD_WORKFLOW_NAMES) {
      const authority = registration(parentName).generic_child;
      expect(authority).toBeDefined();
      if (authority === undefined) throw new Error(`missing authority '${parentName}'`);
      expect(authority.parent_policy.targets.map((target) => target.child_name)).toEqual(
        GENERIC_CHILD_WORKFLOW_NAMES
      );
      expect(authority.parent_policy).toMatchObject({
        max_nesting_depth: 1,
        max_active_children: 1,
        max_calls: 1,
        project_concurrency_limit: 1,
      });
      expect(authority.parent_policy).not.toHaveProperty("aggregate_budget");
      expect(authority.parent_policy).not.toHaveProperty("parent_sealing_reserve");
      for (const target of authority.parent_policy.targets) {
        expect(target).not.toHaveProperty("budget");
        expect(target).toHaveProperty("progress_lease.operation_class", "child_execution");
      }
      expect(Object.isFrozen(authority.parent_policy)).toBe(true);
      expect(Object.isFrozen(authority.provider)).toBe(true);
      expect(authority.parent_policy).not.toHaveProperty("destination_policy");
      expect(authority.provider.availability).toBe("active_internal_runtime");
      expect(authority.provider.operator_authorization).toBe("explicit_static");
      expect(authority.provider.dispatch_capability).toBe("depth_one");
      expect(authority.provider.qualification).toEqual({
        gate_id: "gate_2_live_provider",
        status: "not_run",
        evidence: null,
      });
      for (const childName of GENERIC_CHILD_WORKFLOW_NAMES) {
        expect(
          isGenericChildWorkflowEligible(
            parentName,
            childName,
            ACTIVE_PLAYBOOK_REGISTRY,
            PROJECT_ROOT
          )
        ).toBe(true);
      }
    }

    expect(
      isGenericChildWorkflowEligible("missing", "assess", ACTIVE_PLAYBOOK_REGISTRY, PROJECT_ROOT)
    ).toBe(false);
    expect(
      isGenericChildWorkflowEligible("assess", "missing", ACTIVE_PLAYBOOK_REGISTRY, PROJECT_ROOT)
    ).toBe(false);
    expect(
      isGenericChildWorkflowEligible(
        "knowledge-base",
        "assess",
        ACTIVE_PLAYBOOK_REGISTRY,
        PROJECT_ROOT
      )
    ).toBe(false);
    expect(
      isGenericChildWorkflowEligible(
        "assess",
        "knowledge-base",
        ACTIVE_PLAYBOOK_REGISTRY,
        PROJECT_ROOT
      )
    ).toBe(false);
    const bareDecide = { ...registration("decide") };
    delete bareDecide.generic_child;
    expect(
      isGenericChildWorkflowEligible(
        "assess",
        "decide",
        new Map([
          ["assess", registration("assess")],
          ["decide", bareDecide],
        ]),
        PROJECT_ROOT
      )
    ).toBe(false);
  });

  it("binds native request/output schemas and the fixed worker tool/destination carrier", () => {
    for (const name of GENERIC_CHILD_WORKFLOW_NAMES) {
      const current = registration(name);
      const provider = current.generic_child?.provider;
      if (provider === undefined) throw new Error(`missing provider '${name}'`);
      if (current.worker.kind !== "catalog-agent") {
        throw new Error(`provider '${name}' does not use a catalog agent worker`);
      }
      expect(provider.native_request.port).toEqual(current.contract.io.request);
      expect(provider.input_ports).toEqual(current.contract.io.input_ports);
      expect(provider.terminal_output_port).toEqual(current.contract.io.active_output_ports[0]);
      expect(provider.expected_output).toMatchObject({
        port_name: current.contract.io.active_output_ports[0]?.name,
        schema_id: current.contract.io.active_output_ports[0]?.schema_id,
        schema_version_required:
          current.contract.io.active_output_ports[0]?.schema_version_required,
        artifact_kind: current.contract.io.active_output_ports[0]?.artifact_kind,
      });
      expect(provider.availability).toBe("active_internal_runtime");
      expect(provider).not.toHaveProperty("qualification_manifest");

      for (const projected of provider.phases) {
        const phase = current.worker.phases.get(projected.state_id);
        if (phase === undefined) throw new Error(`missing phase '${name}:${projected.state_id}'`);
        const yamlTools = readAgentTools(phase.agent);
        const expectedTools = phase.allowed_tools ?? yamlTools;
        expect(projected.agent).toBe(phase.agent);
        expect(projected.result_schema_id).toBe(phase.result_schema_id);
        expect(projected.result_schema_version).toBe(phase.result_schema_version);
        expect(projected.result_schema).toEqual(phase.schema);
        expect(projected.browser_network_allowlist).toEqual(
          phase.browser_network_allowlist ?? null
        );
        expect(projected.tool_authority.allowed_tools).toEqual(expectedTools);
        if (phase.allowed_tools === undefined) {
          expect(projected.tool_authority).toEqual({
            carrier: "catalog_agent_yaml_maximum",
            allowed_tools: yamlTools,
          });
        }
        expect(projected).not.toHaveProperty("tools_sha256");
        expect(projected).not.toHaveProperty("destination_policy_sha256");
      }
    }
  });

  it("validates each provider payload with the provider's native request validator", () => {
    for (const childName of GENERIC_CHILD_WORKFLOW_NAMES) {
      const request = childRequest("assess", childName);
      expect(
        validateGenericChildProviderRequest(
          "assess",
          request,
          ACTIVE_PLAYBOOK_REGISTRY,
          PROJECT_ROOT
        )
      ).toEqual(NATIVE_REQUESTS[childName]);
      expect(() =>
        validateGenericChildProviderRequest(
          "assess",
          {
            ...request,
            provider_request_schema_id: "penny.other-request.v1",
          },
          ACTIVE_PLAYBOOK_REGISTRY,
          PROJECT_ROOT
        )
      ).toThrow(/non-native request contract/u);
    }

    const destinationVariant = childRequest("assess", "decide");
    const beforeDigest = runtimeRegistrationSha256(registration("decide"));
    expect(
      validateGenericChildProviderRequest(
        "assess",
        {
          ...destinationVariant,
          policy_binding: {
            ...destinationVariant.policy_binding,
            destination_policy_id: "caller-cannot-select-provider-network-authority",
          },
        },
        ACTIVE_PLAYBOOK_REGISTRY,
        PROJECT_ROOT
      )
    ).toEqual(NATIVE_REQUESTS.decide);
    expect(runtimeRegistrationSha256(registration("decide"))).toBe(beforeDigest);

    const request = childRequest("assess", "decide", {
      ...decisionRequest(),
      allowed_tools: ["bash"],
    });
    expect(() =>
      validateGenericChildProviderRequest("assess", request, ACTIVE_PLAYBOOK_REGISTRY, PROJECT_ROOT)
    ).toThrow(/DecisionRequestV1 failed validation/u);
  });

  it("binds actual caller YAML maxima into the runtime digest and refuses later drift", () => {
    const sourceAgents = path.join(PROJECT_ROOT, ".pi", "agents");
    const callerProjectRoot = mkdtempSync(path.join(tmpdir(), "penny-child-authority-"));
    const callerAgents = path.join(callerProjectRoot, ".pi", "agents");
    try {
      mkdirSync(callerAgents, { recursive: true });
      for (const name of readdirSync(sourceAgents)) {
        copyFileSync(path.join(sourceAgents, name), path.join(callerAgents, name));
      }
      const template = PLAYBOOK_REGISTRY.get("decide");
      if (template === undefined) throw new Error("decide registration is missing");
      const activeBeforeDrift = bindGenericChildYamlAuthority(template, callerProjectRoot);
      const beforeDigest = runtimeRegistrationSha256(activeBeforeDrift);
      const activePhase = activeBeforeDrift.generic_child?.provider.phases.find(
        (phase) => phase.tool_authority.carrier === "catalog_agent_yaml_maximum"
      );
      if (activePhase === undefined || activePhase.tool_authority.allowed_tools === null) {
        throw new Error("missing active YAML-maximum provider phase");
      }
      const agent = activePhase.agent;
      const original = readFileSync(path.join(callerAgents, `${agent}.md`), "utf8");
      const changedTools = activePhase.tool_authority.allowed_tools.slice(1);
      if (changedTools.length === 0) throw new Error("test needs a non-singleton YAML maximum");
      writeFileSync(
        path.join(callerAgents, `${agent}.md`),
        original.replace(/^tools:.*$/mu, `tools: ${changedTools.join(", ")}`),
        "utf8"
      );

      expect(() => validateRegistrationContract(activeBeforeDrift, callerProjectRoot)).toThrow(
        /generic child/u
      );
      const activeAfterDrift = bindGenericChildYamlAuthority(template, callerProjectRoot);
      expect(runtimeRegistrationSha256(activeAfterDrift)).not.toBe(beforeDigest);
    } finally {
      rmSync(callerProjectRoot, { recursive: true, force: true });
    }
  });

  it("rejects a tampered YAML-derived maximum tool authority", () => {
    const decide = registration("decide");
    const decideAuthority = decide.generic_child;
    if (decideAuthority === undefined) throw new Error("missing decide authority");
    const yamlMaximum = decideAuthority.provider.phases.find(
      (phase) => phase.tool_authority.carrier === "catalog_agent_yaml_maximum"
    );
    if (yamlMaximum === undefined || yamlMaximum.tool_authority.allowed_tools === null) {
      throw new Error("missing active YAML-maximum provider phase");
    }
    const changedMaximum = yamlMaximum.tool_authority.allowed_tools.slice(1);
    if (changedMaximum.length === 0) throw new Error("test needs a non-singleton YAML maximum");
    const yamlAuthorityVariant: PlaybookRegistrationV1 = {
      ...decide,
      generic_child: {
        ...decideAuthority,
        provider: {
          ...decideAuthority.provider,
          phases: decideAuthority.provider.phases.map((phase) =>
            phase === yamlMaximum
              ? {
                  ...phase,
                  tool_authority: {
                    carrier: "catalog_agent_yaml_maximum",
                    allowed_tools: changedMaximum,
                  },
                }
              : phase
          ),
        },
      },
    };
    expect(runtimeRegistrationSha256(yamlAuthorityVariant)).not.toBe(
      runtimeRegistrationSha256(decide)
    );
    expect(() => validateRegistrationContract(yamlAuthorityVariant, PROJECT_ROOT)).toThrow(
      /generic child/u
    );
  });

  it("binds parent policy, native provider contract, output, and phase authority into the runtime digest", () => {
    const current = registration("assess");
    const authority = current.generic_child;
    if (authority === undefined || authority.schema_version !== 2) {
      throw new Error("missing lease-bound assess authority");
    }
    const originalDigest = runtimeRegistrationSha256(current);
    const firstPhase = authority.provider.phases[0];
    if (firstPhase === undefined) throw new Error("missing assess phase");

    const variants: readonly PlaybookRegistrationV1[] = [
      {
        ...current,
        generic_child: {
          ...authority,
          parent_policy: {
            ...authority.parent_policy,
            targets: authority.parent_policy.targets.map((target, index) =>
              index === 0
                ? {
                    ...target,
                    native_request: {
                      ...target.native_request,
                      schema_id: `${target.native_request.schema_id}.changed`,
                    },
                  }
                : target
            ),
          },
        },
      },
      {
        ...current,
        generic_child: {
          ...authority,
          provider: {
            ...authority.provider,
            native_request: {
              ...authority.provider.native_request,
              validator_id: "penny.changed-request.validator",
            },
          },
        },
      },
      {
        ...current,
        generic_child: {
          ...authority,
          provider: {
            ...authority.provider,
            expected_output: {
              ...authority.provider.expected_output,
              port_name: "changed_output",
            },
          },
        },
      },
      {
        ...current,
        generic_child: {
          ...authority,
          provider: {
            ...authority.provider,
            phases: [
              {
                ...firstPhase,
                tool_authority: {
                  carrier: "registration_strict_subset",
                  allowed_tools: ["artifact_read"],
                },
              },
              ...authority.provider.phases.slice(1),
            ],
          },
        },
      },
    ];

    for (const variant of variants) {
      expect(runtimeRegistrationSha256(variant)).not.toBe(originalDigest);
      expect(() => validateRegistrationContract(variant, PROJECT_ROOT)).toThrow(/generic child/u);
    }
  });

  it("keeps knowledge-base on dedicated ingress and worker child execution refused", () => {
    const knowledgeBase = registration("knowledge-base");
    expect(knowledgeBase.ingress).toBe("dedicated_tool");
    expect(knowledgeBase.worker.kind).toBe("host-private");
    expect(knowledgeBase.generic_child).toBeUndefined();
    expect(() =>
      validateGenericChildProviderRequest(
        "knowledge-base",
        childRequest("assess", "assess"),
        ACTIVE_PLAYBOOK_REGISTRY,
        PROJECT_ROOT
      )
    ).toThrow(/not statically authorized/u);
    expect(() =>
      assertWorkerExecutableDirective(invokeDirective(childRequest("assess", "assess")))
    ).toThrow(/not executable by a worker/u);
  });
});
