import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  encodeCanonicalPng,
  initializePennyState,
  resolvePlaybook,
  skillContractSha256,
} from "@penny/orchestration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { artifactIdFor, type ArtifactRef } from "../../artifact-client.js";
import type { SkillResult } from "../../skill-utils.js";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord } from "../../../../lib/tests/test-narrowers.js";

type SkillToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

interface RegisteredSkillTool {
  readonly name: "skill";
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown
  ): Promise<{ readonly content: readonly SkillToolContent[]; readonly details: SkillResult }>;
}

interface EngineRequest {
  readonly action: string;
  readonly identity: { readonly run_id: string; readonly playbook: string };
  readonly constraints?: Record<string, unknown>;
  readonly goal?: string;
  readonly input_artifacts?: { readonly artifacts: readonly { readonly ref: ArtifactRef }[] };
}

interface ArtifactReadInput {
  readonly ref: ArtifactRef;
  readonly projectRoot: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const { executeMock, loadRunMock, readArtifactMock, persistHandoffMock } = vi.hoisted(() => ({
  executeMock: vi.fn<(request: EngineRequest) => Promise<unknown>>(),
  loadRunMock: vi.fn<() => unknown>(() => undefined),
  readArtifactMock: vi.fn<(input: ArtifactReadInput) => Promise<Buffer>>(async () =>
    Buffer.from("exact")
  ),
  persistHandoffMock: vi.fn(async (options: { terminalRef: ArtifactRef }) => options.terminalRef),
}));

vi.mock("@penny/orchestration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@penny/orchestration")>()),
  OrchestrationService: class {
    readonly artifacts = { read: vi.fn(() => Buffer.from("exact")) };
    readonly checkpointer = {
      loadRunById: loadRunMock,
      events: vi.fn(() => [{ payload: { agent: "piper" } }]),
    };
    readonly execute = executeMock;
    close() {}
    [Symbol.dispose]() {
      this.close();
    }
  },
}));

vi.mock("../../artifact-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../artifact-client.js")>()),
  readArtifactOutput: readArtifactMock,
  readArtifactsById: vi.fn(async () => []),
}));

vi.mock("../../skill-chain-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skill-chain-artifacts.js")>()),
  persistSkillChainHandoff: persistHandoffMock,
  validateSkillChainHandoff: vi.fn(async () => undefined),
}));

let tool: RegisteredSkillTool | undefined;
let project: string;
const roots: string[] = [];

function artifactRef(runId: string, phase = "complete"): ArtifactRef {
  const digest = createHash("sha256").update(`${runId}:${phase}`).digest("hex");
  const identity = {
    run_id: runId,
    phase,
    branch_id: null,
    kind: "agent-output",
    operation_id: `${runId}:${phase}`,
    version: 1,
  };
  return {
    schema_version: 2,
    artifact_id: artifactIdFor(identity),
    ...identity,
    producer: "agent:piper",
    media_type: "text/plain; charset=utf-8",
    byte_length: 5,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

const IMAGE_BYTES = Buffer.from(
  encodeCanonicalPng({
    width: 1,
    height: 1,
    rgba: Uint8Array.from([90, 80, 70, 255]),
  })
);

function imagegenArtifactRef(runId: string): ArtifactRef {
  const identity = {
    run_id: runId,
    phase: "generating_candidate",
    branch_id: null,
    kind: "generated-image",
    operation_id: "imagegen-slot-0-revision-0",
    version: 1,
  };
  const digest = createHash("sha256").update(IMAGE_BYTES).digest("hex");
  return {
    schema_version: 2,
    artifact_id: artifactIdFor(identity),
    ...identity,
    producer: "host:imagegen-provider-free-test",
    media_type: "image/png",
    byte_length: IMAGE_BYTES.byteLength,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function terminal(
  request: EngineRequest,
  action: "complete" | "cancelled" = "complete",
  outputRef = artifactRef(request.identity.run_id)
) {
  const met = action === "complete";
  return {
    schema_version: 2,
    action,
    identity: {
      schema_version: 2,
      run_id: request.identity.run_id,
      session_id: request.identity.run_id,
      playbook: request.identity.playbook,
      engine_owner: "typescript",
    },
    status: action,
    met,
    result: {
      met,
      output_artifact_ref: outputRef,
      ...(request.identity.playbook === "imagegen" ? { selected_image_ref: outputRef } : {}),
      best_partial_artifact_refs: met ? [] : [outputRef],
    },
    artifacts: [outputRef],
    unresolved: met ? [] : ["cancelled by caller"],
  };
}

function isRegisteredSkillTool(value: unknown): value is RegisteredSkillTool {
  return isRecord(value) && value.name === "skill" && typeof value.execute === "function";
}

function requireTool(): RegisteredSkillTool {
  if (tool === undefined) throw new Error("generic skill tool was not registered");
  return tool;
}

function context() {
  return {
    cwd: project,
    isProjectTrusted: () => true,
    ui: { theme: { fg: (_color: string, text: string) => text }, notify: vi.fn() },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  tool = undefined;
  const root = mkdtempSync(path.join(tmpdir(), "penny-generic-ingress-e2e-"));
  roots.push(root);
  project = path.join(root, "project");
  mkdirSync(project, { mode: 0o700 });
  process.env.PROJECT_ROOT = project;
  process.env.PENNY_STATE_ROOT = path.join(root, "state");
  initializePennyState(project, { env: process.env });
  executeMock.mockImplementation(async (request) => terminal(request));

  const production = resolvePlaybook("research");
  const imagegen = resolvePlaybook("imagegen");
  const define = resolvePlaybook("define");
  const plan = resolvePlaybook("plan");
  if (
    production === undefined ||
    production.worker.kind !== "catalog-agent" ||
    imagegen === undefined ||
    imagegen.worker.kind !== "catalog-agent" ||
    define === undefined ||
    plan === undefined
  ) {
    throw new Error("generic E2E fixture registration is unavailable");
  }
  const fixtureName = "generic-fixture";
  const fixture = {
    ...production,
    name: fixtureName,
    contract: { ...production.contract, name: fixtureName },
    worker: { ...production.worker, workflow_name: fixtureName },
  };
  const extension = await import("../../index.js");
  extension.default(
    createTestExtensionApi({
      onRegisterTool(definition) {
        if (isRegisteredSkillTool(definition)) tool = definition;
      },
    }),
    {
      skillIngressResolver: ({ name }) => {
        if (name === fixtureName) {
          return {
            ok: true,
            registration: fixture,
            contract_sha256: skillContractSha256(fixture.contract),
          };
        }
        if (name === "define" || name === "plan") {
          const registration = name === "define" ? define : plan;
          return {
            ok: true,
            registration,
            contract_sha256: skillContractSha256(registration.contract),
          };
        }
        if (name === "imagegen") {
          return {
            ok: true,
            registration: imagegen,
            contract_sha256: skillContractSha256(imagegen.contract),
          };
        }
        return { ok: false, code: "SKILL_NOT_REGISTERED", message: "fixture only" };
      },
    }
  );
});

afterEach(() => {
  delete process.env.PROJECT_ROOT;
  delete process.env.PENNY_STATE_ROOT;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("generic skill ingress E2E", () => {
  it("transports explicit V2 policy through single, parallel, chain and failed-step resume", async () => {
    const policy = {
      schema_version: 2,
      request: {
        schema_version: 1,
        desired_outcomes: ["Plan"],
        current_state: { status: "provided", facts: ["Known"] },
        hard_constraints: [],
        non_goals: [],
        known_uncertainties: [],
        prior_decisions: [],
      },
      specification_assurance: "reviewed_definition",
    };
    const single = await requireTool().execute(
      "policy-single",
      {
        skill_name: "plan",
        goal: "Plan",
        session_id: "policy-single",
        constraints: policy,
      },
      undefined,
      undefined,
      context()
    );
    const parallel = await requireTool().execute(
      "policy-parallel",
      {
        skills: [
          { skill_name: "plan", goal: "Plan", session_id: "policy-parallel", constraints: policy },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(single.details.success).toBe(true);
    expect(parallel.details.success).toBe(true);
    const definition = artifactRef("policy-define");
    const prior = {
      ...definition,
      kind: "specification",
      artifact_id: artifactIdFor({
        run_id: definition.run_id,
        phase: definition.phase,
        branch_id: definition.branch_id,
        kind: "specification",
        operation_id: definition.operation_id,
        version: definition.version,
      }),
      content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
    };
    executeMock.mockImplementation(async (request) => {
      if (request.identity.playbook === "define") return terminal(request, "complete", prior);
      if (
        request.identity.run_id === "policy-chain-plan" &&
        executeMock.mock.calls.filter(([call]) => call.identity.run_id === "policy-chain-plan")
          .length === 1
      )
        return terminal(request, "cancelled");
      return terminal(request);
    });
    const chain = await requireTool().execute(
      "policy-chain",
      {
        chain: [
          {
            skill_name: "define",
            goal: "Define",
            session_id: "policy-define",
            constraints: {
              schema_version: 2,
              request: { schema_version: 1, mode: "create" },
              specification_assurance: "reviewed_definition",
            },
          },
          {
            skill_name: "plan",
            goal: "Use {previous}",
            session_id: "policy-chain-plan",
            constraints: policy,
          },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(chain.details.resumable).toBe(true);
    const resumed = await requireTool().execute(
      "policy-resume",
      {
        resume_chain: chain.details.chain_session_id,
        step_overrides: {
          1: { constraints: { user_response: "Clarified without changing policy." } },
        },
      },
      undefined,
      undefined,
      context()
    );
    expect(resumed.details.success).toBe(true);
    const planCalls = executeMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.identity.playbook === "plan");
    expect(planCalls).toHaveLength(4);
    for (const call of planCalls) expect(call.constraints).toEqual(policy);
    for (const call of planCalls.slice(2)) {
      expect(call.input_artifacts?.artifacts[0]?.ref.artifact_id).toBe(prior.artifact_id);
      expect(call.goal).toBe(`Use ${prior.artifact_id}`);
    }
  });
  it("routes non-Research single and parallel invocations through their exact registration", async () => {
    const single = await requireTool().execute(
      "single",
      { skill_name: "generic-fixture", goal: "single", session_id: "generic-single" },
      undefined,
      undefined,
      context()
    );
    const parallel = await requireTool().execute(
      "parallel",
      {
        skills: [
          { skill_name: "generic-fixture", goal: "one", session_id: "generic-one" },
          { skill_name: "generic-fixture", goal: "two", session_id: "generic-two" },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(single.details).toMatchObject({ success: true, skill_name: "generic-fixture" });
    expect(parallel.details).toMatchObject({ success: true, mode: "parallel" });
    expect(executeMock.mock.calls.map((call) => call[0].identity.playbook)).toEqual([
      "generic-fixture",
      "generic-fixture",
      "generic-fixture",
    ]);
  });

  it("renders new seal diagnostics from a negative engine terminal without reading their body", async () => {
    const runId = "generic-seal";
    const draftIdentity = { ...artifactRef(runId, "authoring"), kind: "specification-draft" };
    const rejected = { ...draftIdentity, artifact_id: artifactIdFor(draftIdentity) };
    const diagnosticIdentity = { ...artifactRef(runId, "sealing"), kind: "seal-diagnostic" };
    const diagnostic = { ...diagnosticIdentity, artifact_id: artifactIdFor(diagnosticIdentity) };
    const projection = {
      latest_diagnostic_ref: diagnostic,
      rejected_draft_ref: rejected,
      epoch_anchor_ref: null,
      corrections_used: 1,
      correction_limit: 1,
      disposition: "exhausted",
    };
    executeMock.mockImplementationOnce(async (request) => ({
      ...terminal(request, "cancelled", rejected),
      action: "incomplete",
      status: "incomplete",
      result: {
        met: false,
        output_artifact_ref: rejected,
        best_partial_artifact_refs: [rejected],
        output_kind: "rejected_draft_best_partial",
        seal_diagnostics: projection,
      },
      unresolved: ["private authored text must not be repeated"],
    }));

    const response = await requireTool().execute(
      "seal",
      { skill_name: "generic-fixture", goal: "show exact seal failure", session_id: runId },
      undefined,
      undefined,
      context()
    );
    expect(response.details).toMatchObject({
      success: false,
      state: "incomplete",
      seal_diagnostics: projection,
      output_artifact_ref: rejected,
    });
    expect(response.content[0]).toMatchObject({ type: "text" });
    if (response.content[0]?.type !== "text") throw new Error("missing seal presentation");
    expect(response.content[0].text).toContain(`diagnostic: ${diagnostic.artifact_id}`);
    expect(response.content[0].text).toContain(
      `rejected draft — not an accepted product): ${rejected.artifact_id}`
    );
    expect(response.content[0].text).toContain("No accepted sealed product in this run.");
    expect(response.content[0].text).not.toContain("private authored text");
    expect(readArtifactMock.mock.calls.map(([input]) => input.ref.artifact_id)).toEqual([
      rejected.artifact_id,
    ]);
  });

  it("projects imagegen's selected PNG from its generic terminal output ref", async () => {
    executeMock.mockImplementationOnce(async (request) =>
      terminal(request, "complete", imagegenArtifactRef(request.identity.run_id))
    );
    readArtifactMock.mockResolvedValueOnce(IMAGE_BYTES);

    const response = await requireTool().execute(
      "imagegen",
      { skill_name: "imagegen", goal: "return selected PNG", session_id: "generic-imagegen" },
      undefined,
      undefined,
      context()
    );

    const outputRef = imagegenArtifactRef("generic-imagegen");
    expect(response.details).toMatchObject({
      success: true,
      skill_name: "imagegen",
      output_artifact_ref: outputRef,
      result: { output_artifact_ref: outputRef, selected_image_ref: outputRef },
    });
    expect(executeMock.mock.calls.at(-1)?.[0].identity.playbook).toBe("imagegen");
    const artifactRead = readArtifactMock.mock.calls[0]?.[0];
    if (artifactRead === undefined)
      throw new Error("generic imagegen ingress did not re-read output");
    expect(artifactRead.ref.artifact_id).toBe(outputRef.artifact_id);
    const metadata = response.content[0];
    const image = response.content[1];
    if (metadata?.type !== "text" || image?.type !== "image") {
      throw new Error("generic imagegen ingress did not produce a terminal image presentation");
    }
    expect(JSON.parse(metadata.text)).toMatchObject({
      skill_name: "imagegen",
      artifact_ref: { artifact_id: outputRef.artifact_id, kind: "generated-image" },
      content_digest: outputRef.content_digest,
    });
    expect(image).toEqual({
      type: "image",
      data: IMAGE_BYTES.toString("base64"),
      mimeType: "image/png",
    });
  });

  it("binds chain checkpoints and resumes a completed generic chain without new model work", async () => {
    const chained = await requireTool().execute(
      "chain",
      {
        chain: [
          { skill_name: "generic-fixture", goal: "first", session_id: "generic-chain-one" },
          {
            skill_name: "generic-fixture",
            goal: "use {previous}",
            session_id: "generic-chain-two",
          },
        ],
      },
      undefined,
      undefined,
      context()
    );
    const callsAfterChain = executeMock.mock.calls.length;
    const resumed = await requireTool().execute(
      "resume",
      { resume_chain: chained.details.chain_session_id },
      undefined,
      undefined,
      context()
    );
    expect(chained.details).toMatchObject({ success: true, mode: "chain" });
    expect(resumed.details).toMatchObject({ success: true, mode: "chain" });
    expect(executeMock).toHaveBeenCalledTimes(callsAfterChain);
    expect(persistHandoffMock).toHaveBeenCalledTimes(1);
  });

  it("preserves generic cancellation and recover identities", async () => {
    executeMock.mockImplementationOnce(async (request) => terminal(request, "cancelled"));
    const cancelled = await requireTool().execute(
      "cancel",
      { skill_name: "generic-fixture", goal: "cancel", session_id: "generic-cancel" },
      undefined,
      undefined,
      context()
    );
    expect(cancelled.details).toMatchObject({
      success: false,
      state: "cancelled",
      best_partial_artifact_refs: [artifactRef("generic-cancel")],
    });

    loadRunMock.mockReturnValue({
      previousState: "planning",
      pendingDirective: null,
      selectedArtifacts: [],
    });
    const recovered = await requireTool().execute(
      "recover",
      { skill_name: "generic-fixture", goal: "recover", session_id: "generic-recover" },
      undefined,
      undefined,
      context()
    );
    expect(recovered.details).toMatchObject({ success: true, session_id: "generic-recover" });
    expect(executeMock.mock.calls.at(-1)?.[0]).toMatchObject({
      action: "recover",
      identity: { playbook: "generic-fixture", run_id: "generic-recover" },
    });
  });
});
