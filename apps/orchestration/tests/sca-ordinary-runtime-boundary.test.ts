/** Offline regressions: real admission/engine/owner, scripted cognition, no native dispatch. */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { validateContract } from "../dist/contracts.js";
import { OrchestrationService } from "../dist/service.js";
import { ScaReportProductSchema } from "../dist/sca/ordinary-report.js";
import {
  OrdinaryApplicationContainerConfigSchema,
  OrdinaryApplicationVmConfigSchema,
} from "../dist/sca/ordinary-advanced-contracts.js";
import { createOrdinaryApplicationTestRuntime } from "../../sca-service/src/ordinary-application-tests.js";
import {
  environment,
  fixtureAdapters,
  PROJECT_ROOT,
  roots,
  ScriptedScaClient,
  sourceRoot,
  start,
} from "./helpers/sca-local-workflow.js";
import { AdvancedScriptedClient, advancedFixture } from "./helpers/sca-advanced-workflow.js";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function isolatedEnvironment() {
  const env = environment();
  // Never consume ambient operator configs in these regressions.
  for (const key of Object.keys(env)) if (key.startsWith("PENNY_SCA_ORDINARY_")) delete env[key];
  return env;
}
function options(env: NodeJS.ProcessEnv, client = new ScriptedScaClient()) {
  return {
    projectRoot: PROJECT_ROOT,
    playbookName: "sca",
    env,
    modelClient: client,
    hostOperationAdapters: fixtureAdapters("noalert"),
  };
}
function product(service: OrchestrationService, runId: string) {
  const ref = service.checkpointer
    .loadRunById(runId)
    ?.selectedArtifacts.find((entry) => entry.kind === "semantic-core");
  if (ref === undefined) throw new Error("Missing exact report");
  return validateContract(
    ScaReportProductSchema,
    JSON.parse(service.artifacts.readById(ref.artifact_id).toString("utf8")),
    "VM-free report"
  );
}
function hostConfigs() {
  const root = path.dirname(sourceRoot);
  // Valid typed operands, intentionally absent native assets: construction must not preflight them.
  const pin = {
    path: path.join(root, "absent-legacy-asset"),
    sha256: "a".repeat(64),
    size_bytes: 1,
  };
  const vm = validateContract(
    OrdinaryApplicationVmConfigSchema,
    {
      workspace_parent: root,
      global_lock: path.join(root, "absent-legacy-lock"),
      ...Object.fromEntries(
        [
          "run_job",
          "run_guest",
          "output_protocol",
          "python",
          "genisoimage",
          "cp",
          "qemu",
          "bwrap",
          "systemctl",
          "template",
          "bridge",
          "guest",
        ].map((key) => [key, pin])
      ),
    },
    "Legacy configuration operand"
  );
  const docker = validateContract(
    OrdinaryApplicationContainerConfigSchema,
    {
      schema_id: "penny.sca-ordinary-application-container-config.v1",
      schema_version: 1,
      kind: "docker",
      isolation: "container",
      profile: "docker-local-no-network-v1",
      workspace_parent: root,
      docker: pin,
      daemon_socket: path.join(root, "absent-docker.sock"),
      images: { node: `sha256:${"b".repeat(64)}`, php: null },
    },
    "Docker configuration operand"
  );
  return { vm, docker };
}

describe("current ordinary SCA has no VM prerequisite", () => {
  it.each(["static_only", "propose_stronger_evidence"])(
    "can COMPLETE %s with no application runtime, VM config, assets or qualification",
    async (execution_mode) => {
      const env = isolatedEnvironment();
      const client = new ScriptedScaClient("noalert");
      using service = new OrchestrationService(options(env, client));
      client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const runId = `no-vm-${execution_mode}`;
      const request = start(runId);
      expect(
        await service.execute({
          ...request,
          constraints: { ...request.constraints, execution_mode },
        })
      ).toMatchObject({ action: "complete" });
      expect(product(service, runId)).toMatchObject({
        status: "COMPLETE",
        reproduction: "NOT RUN",
        target_executed: false,
      });
      expect(
        service.checkpointer.hostOperationCallsForRun(runId).map((entry) => entry.operation_kind)
      ).toEqual(["sca.preparation.v1", "sca.evidence.v1"]);
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("Missing ordinary checkpoint");
      expect(
        context.selectedArtifacts.some((ref) =>
          /qualification|bootstrap|activation|execution-plan|execution-policy/u.test(ref.kind)
        )
      ).toBe(false);
      expect(client.invocations.at(-1)?.stateId).toBe("verifying_final_product");
    }
  );

  it.each([false, true])(
    "missing runtime refuses only requested execution (application action=%s)",
    async (application) => {
      const env = isolatedEnvironment();
      const fixture = advancedFixture("completed", false, false);
      const client = new AdvancedScriptedClient(application, false);
      const nativeRunner = vi.fn(() => {
        throw new Error("VM transport must never dispatch");
      });
      const dockerRunner = vi.fn(() => {
        throw new Error("Docker transport must never dispatch");
      });
      const applicationFactory = vi.fn(
        (authority: Parameters<typeof createOrdinaryApplicationTestRuntime>[0]["authority"]) =>
          createOrdinaryApplicationTestRuntime({
            authority,
            runner: { run: nativeRunner },
            dockerRunner,
          })
      );
      using service = new OrchestrationService({
        ...options(env, client),
        scaAdvanced: { applicationFactory },
      });
      client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const runId = `missing-runtime-${application}`;
      const request = start(runId);
      const terminal = await service.execute({
        ...request,
        constraints: {
          ...request.constraints,
          execution_mode: "propose_stronger_evidence",
          advanced: { ...fixture.advanced, learning: [] },
        },
      });
      expect(terminal.action).toBe(application ? "incomplete" : "complete");
      const report = product(service, runId);
      expect(report.reproduction).toBe("NOT RUN");
      expect(report.target_executed).toBe(false);
      const calls = service.checkpointer
        .hostOperationCallsForRun(runId)
        .filter((entry) => entry.operation_kind === "sca.application.v1");
      expect(calls).toHaveLength(application ? 1 : 0);
      expect(applicationFactory).toHaveBeenCalledTimes(application ? 1 : 0);
      if (application) {
        expect(
          report.advanced?.operations.find((entry) => entry.stage === "application")
        ).toMatchObject({
          status: "unsupported",
          execution: "NOT RUN",
          cleanup: "not_needed",
          quarantine_required: false,
        });
        // Owner-local admission is not a native submission or execution acknowledgement.
        expect(calls[0]?.remote_correlation_id).toMatch(/^local-admission:[a-f0-9]{64}$/u);
      }
      expect(nativeRunner).not.toHaveBeenCalled();
      expect(dockerRunner).not.toHaveBeenCalled();
      expect(fixture.counts()).toEqual({ applications: 0, processes: 0 });
    }
  );

  it("rejects both environment aliases before analysis, rather than selecting a backend", () => {
    const env = isolatedEnvironment();
    const { vm, docker } = hostConfigs();
    const root = path.dirname(sourceRoot);
    const vmPath = path.join(root, "legacy.json");
    const dockerPath = path.join(root, "container.json");
    writeFileSync(vmPath, JSON.stringify(vm));
    writeFileSync(dockerPath, JSON.stringify(docker));
    const client = new ScriptedScaClient();
    // Each alias alone is accepted without opening any native asset.
    for (const configured of [
      { PENNY_SCA_ORDINARY_APPLICATION_CONFIG: dockerPath },
      { PENNY_SCA_ORDINARY_APPLICATION_VM_CONFIG: vmPath },
    ]) {
      using service = new OrchestrationService(options({ ...env, ...configured }, client));
      expect(service).toBeInstanceOf(OrchestrationService);
    }
    expect(
      () =>
        new OrchestrationService(
          options(
            {
              ...env,
              PENNY_SCA_ORDINARY_APPLICATION_CONFIG: dockerPath,
              PENNY_SCA_ORDINARY_APPLICATION_VM_CONFIG: vmPath,
            },
            client
          )
        )
    ).toThrow("Ambiguous application runtime and legacy VM configuration");
    expect(client.invocations).toEqual([]);
  });

  it("rejects dual embedding operands and invalid explicit configuration, not VM absence", () => {
    const env = isolatedEnvironment();
    const { vm, docker } = hostConfigs();
    const client = new ScriptedScaClient();
    for (const scaAdvanced of [{ applicationRuntime: docker }, { applicationVm: vm }]) {
      using service = new OrchestrationService({ ...options(env, client), scaAdvanced });
      expect(service).toBeInstanceOf(OrchestrationService);
    }
    expect(
      () =>
        new OrchestrationService({
          ...options(env, client),
          scaAdvanced: { applicationRuntime: docker, applicationVm: vm },
        })
    ).toThrow("Ambiguous application runtime and legacy VM configuration");
    for (const applicationRuntime of [
      { ...docker, kind: "unknown" },
      { ...docker, images: { node: "mutable:tag", php: null } },
    ])
      expect(
        () =>
          new OrchestrationService({ ...options(env, client), scaAdvanced: { applicationRuntime } })
      ).toThrow("Application runtime config");
    expect(client.invocations).toEqual([]);
  });
});

function documentationIssues(text: string) {
  const issues: string[] = [];
  if (
    !/require no KVM access, VM image, guest assets, VM configuration or VM qualification/u.test(
      text
    )
  )
    issues.push("VM-free scope missing");
  if (!text.includes("Docker is the current supported application-test containment path"))
    issues.push("current Docker support missing");
  if (
    !/optional legacy VM (?:backend is compatibility|compatibility is not a prerequisite)/iu.test(
      text
    )
  )
    issues.push("optional compatibility missing");
  for (const paragraph of text.split(/\n\s*\n/u))
    if (
      /Docker|CONTAINER/u.test(paragraph) &&
      /\btemporary\b|\binterim\b|\bexception\b/iu.test(paragraph)
    )
      issues.push("Docker demoted to exception");
  return issues;
}
describe("current documentation, separate from legacy qualification", () => {
  it("pins current overview/maintained prose and detects restored VM/temporary-Docker wording", () => {
    const read = (relative: string) => readFileSync(path.join(PROJECT_ROOT, relative), "utf8");
    for (const file of ["README.md", "resources/reference.md", "SKILL.md"]) {
      const document = read(`.pi/skills/sca/${file}`).replace(
        /<!-- PENNY:GENERATED-INVOCATION:START -->[\s\S]*?<!-- PENNY:GENERATED-INVOCATION:END -->/u,
        ""
      );
      expect(documentationIssues(document)).toEqual([]);
      expect(
        documentationIssues(document.replace("require no KVM access", "require KVM access"))
      ).toContain("VM-free scope missing");
      expect(
        documentationIssues(
          document.replace(
            "Docker is the current supported",
            "Temporary Docker is the current supported"
          )
        )
      ).toContain("Docker demoted to exception");
    }
    const flow = read(".pi/skills/sca/resources/flow.html");
    const literal = /const N = (.*);/u.exec(flow)?.[1];
    if (literal === undefined) throw new Error("Missing flow nodes");
    const nodes = validateContract(
      Type.Record(
        Type.String(),
        Type.Object({ desc: Type.String() }, { additionalProperties: true })
      ),
      JSON.parse(literal),
      "Flow descriptions"
    );
    const application = nodes.running_application_tests;
    if (application === undefined) throw new Error("Missing application node");
    expect(application.desc).toContain(
      "explicit Docker CONTAINER (shared kernel), optional legacy VM"
    );
    expect(application.desc).not.toMatch(/temporary|exception/iu);
    expect(flow).toContain("Ordinary analysis and readiness require no VM, KVM or guest assets");
    expect(read("scripts/setup/CONTROLLED-HOST.md")).toContain("Legacy deployment scope only");
    expect(read("scripts/sca-vm/README.md")).toContain(
      "Optional legacy tooling, not ordinary SCA setup"
    );
  });
});
