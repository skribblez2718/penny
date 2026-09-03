import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  initializePennyState,
  resolvePlaybook,
  skillContractSha256,
} from "@penny/orchestration/source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { artifactIdFor, type ArtifactRef } from "../../artifact-client.js";
import type { SkillResult } from "../../skill-utils.js";
import { createTestExtensionApi, isRecord } from "../../../../lib/tests/test-narrowers.js";

interface RegisteredSkillTool {
  readonly name: "skill";
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown
  ): Promise<{ details: SkillResult }>;
}

interface EngineRequest {
  readonly action: string;
  readonly identity: { readonly run_id: string; readonly playbook: string };
}

const { executeMock, loadRunMock, readArtifactMock, persistHandoffMock } = vi.hoisted(() => ({
  executeMock: vi.fn<(request: EngineRequest) => Promise<unknown>>(),
  loadRunMock: vi.fn<() => unknown>(() => undefined),
  readArtifactMock: vi.fn(async () => Buffer.from("exact")),
  persistHandoffMock: vi.fn(async (options: { targetRunId: string }) =>
    artifactRef(options.targetRunId, "chain-input")
  ),
}));

vi.mock("@penny/orchestration/source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@penny/orchestration/source")>()),
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

function terminal(request: EngineRequest, action: "complete" | "cancelled" = "complete") {
  const ref = artifactRef(request.identity.run_id);
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
    result: { output_artifact_ref: ref, best_partial_artifact_refs: met ? [] : [ref] },
    artifacts: [ref],
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
    ui: { theme: { fg: () => "" }, notify: vi.fn() },
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
  if (production === undefined || production.worker.kind !== "catalog-agent") {
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
      skillIngressResolver: ({ name }) =>
        name === fixtureName
          ? {
              ok: true,
              registration: fixture,
              release_status: "production",
              contract_sha256: skillContractSha256(fixture.contract),
            }
          : { ok: false, code: "SKILL_NOT_REGISTERED", message: "fixture only" },
    }
  );
});

afterEach(() => {
  delete process.env.PROJECT_ROOT;
  delete process.env.PENNY_STATE_ROOT;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("generic skill ingress E2E", () => {
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

    loadRunMock.mockReturnValue({ previousState: "planning", pendingDirective: null });
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
