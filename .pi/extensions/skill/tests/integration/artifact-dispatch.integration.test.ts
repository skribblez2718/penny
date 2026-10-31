import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ArtifactStore,
  canonicalJson,
  Checkpointer,
  initializePennyState,
  OrchestrationEngine,
  ReceiptAuthority,
  resolvePennyRuntimeState,
  RunContext,
  type RunIdentity,
} from "@penny/orchestration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import skillExtension from "../../index.js";
import type { SkillResult, SkillToolDetails } from "../../skill-utils.js";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord, requireFunction } from "../../../../lib/tests/test-narrowers.js";

const GOAL = "Exercise the real TypeScript dispatch boundary.";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);

interface ProgressUpdate {
  content: Array<{ type: string; text: string }>;
  details: SkillToolDetails | undefined;
}

interface RegisteredSkillTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: ProgressUpdate) => void) | undefined,
    context: unknown
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: SkillResult }>;
  renderResult?: (
    result: ProgressUpdate,
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown,
    context: unknown
  ) => unknown;
}

let temporaryRoot = "";
let projectRoot = "";
let registeredTool: RegisteredSkillTool | undefined;
const previousEnvironment = new Map<string, string | undefined>();

function rememberEnvironment(name: string): void {
  if (!previousEnvironment.has(name)) previousEnvironment.set(name, process.env[name]);
}

function setEnvironment(name: string, value: string | undefined): void {
  rememberEnvironment(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function isRegisteredSkillTool(value: unknown): value is RegisteredSkillTool {
  return isRecord(value) && value["name"] === "skill" && typeof value["execute"] === "function";
}

function context(): Record<string, unknown> {
  return {
    cwd: projectRoot,
    isProjectTrusted: () => true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: () => undefined,
    },
  };
}

function tool(): RegisteredSkillTool {
  if (registeredTool === undefined) throw new Error("skill tool was not registered");
  return registeredTool;
}

function render(result: {
  content: Array<{ type: string; text: string }>;
  details: SkillResult;
}): string {
  const component = tool().renderResult?.(
    result,
    { expanded: false, isPartial: false },
    { fg: (_color: string, text: string) => text },
    context()
  );
  if (!isRecord(component)) {
    throw new Error("skill renderer did not return a renderable component");
  }
  const rendered = requireFunction(component["render"]).call(component, 180);
  if (!Array.isArray(rendered) || !rendered.every((line) => typeof line === "string")) {
    throw new Error("skill renderer did not return text lines");
  }
  return rendered.join("\n");
}

function identity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: runId,
    playbook: "research",
    engine_owner: "typescript",
  };
}

function openCheckpointer(): Checkpointer {
  const state = resolvePennyRuntimeState(projectRoot, { env: process.env });
  return Checkpointer.openExisting(state.paths.orchestration.database, undefined, {
    projectId: state.projectId,
  });
}

function createAdmissionRow(runId: string): void {
  const checkpointer = openCheckpointer();
  const admitted = RunContext.create({
    identity: identity(runId),
    goal: GOAL,
    constraints: { mode: "quick" },
    projectRoot,
    trustProfile: "trusted-interactive",
    maxSteps: 96,
  });
  checkpointer.createRun(admitted, "integration_admitted_fixture", { fixture: true });
  checkpointer.close();
}

function createLegacySavedRun(runId: string): string {
  const checkpointer = openCheckpointer();
  const legacy = RunContext.create({
    identity: identity(runId),
    goal: GOAL,
    constraints: { mode: "quick" },
    projectRoot,
    trustProfile: "trusted-interactive",
    maxSteps: 96,
  });
  legacy.transition("researching");
  checkpointer.createRun(legacy, "integration_legacy_fixture", { fixture: true });
  const bytes = canonicalJson(checkpointer.loadRun(identity(runId)).snapshot());
  checkpointer.close();
  return bytes;
}

function createCurrentSavedRun(runId: string): string {
  const state = resolvePennyRuntimeState(projectRoot, { env: process.env });
  const checkpointer = Checkpointer.openExisting(state.paths.orchestration.database, undefined, {
    projectId: state.projectId,
  });
  const artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
    projectId: state.projectId,
  });
  const owner = new OrchestrationEngine(checkpointer, {
    projectRoot,
    maxSteps: 96,
    dispatchMode: () => "active",
    receiptAuthority: ReceiptAuthority.loadExisting(state.paths.orchestration.receiptKey),
    artifactStore: artifacts,
    artifactReader: artifacts,
    artifactRevisions: artifacts,
  });
  owner.handle({
    schema_version: 2,
    action: "start",
    identity: identity(runId),
    goal: GOAL,
    constraints: { mode: "quick" },
    project_root: projectRoot,
    trust_profile: "trusted-interactive",
  });
  const bytes = canonicalJson(checkpointer.loadRun(identity(runId)).snapshot());
  checkpointer.close();
  artifacts.close();
  return bytes;
}

function createTerminalRun(runId: string): void {
  const state = resolvePennyRuntimeState(projectRoot, { env: process.env });
  const checkpointer = Checkpointer.openExisting(state.paths.orchestration.database, undefined, {
    projectId: state.projectId,
  });
  const artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
    projectId: state.projectId,
  });
  const owner = new OrchestrationEngine(checkpointer, {
    projectRoot,
    maxSteps: 96,
    dispatchMode: () => "active",
    receiptAuthority: ReceiptAuthority.loadExisting(state.paths.orchestration.receiptKey),
    artifactStore: artifacts,
    artifactReader: artifacts,
    artifactRevisions: artifacts,
  });
  owner.handle({
    schema_version: 2,
    action: "start",
    identity: identity(runId),
    goal: GOAL,
    constraints: { mode: "quick" },
    project_root: projectRoot,
    trust_profile: "trusted-interactive",
  });
  owner.handle({
    schema_version: 2,
    action: "cancel",
    identity: identity(runId),
    reason: "integration terminal fixture",
  });
  checkpointer.close();
  artifacts.close();
}

async function invokeSingle(runId: string): Promise<{
  content: Array<{ type: string; text: string }>;
  details: SkillResult;
}> {
  return tool().execute(
    `call-${runId}`,
    {
      skill_name: "research",
      goal: GOAL,
      session_id: runId,
      constraints: { mode: "quick" },
    },
    undefined,
    undefined,
    context()
  );
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), "penny-skill-dispatch-integration-"));
  projectRoot = path.join(temporaryRoot, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  setEnvironment("PENNY_STATE_ROOT", path.join(temporaryRoot, "state"));
  setEnvironment("PENNY_SKILLS_DIR", path.join(REPOSITORY_ROOT, ".pi", "skills"));
  setEnvironment("PROJECT_ROOT", REPOSITORY_ROOT);
  setEnvironment("PENNY_SKILL_CHAIN_STATE_ROOT", undefined);
  setEnvironment("PENNY_ARTIFACT_ROOT", undefined);
  setEnvironment("PENNY_ARTIFACT_DISPATCH_MODE", "paused");
  initializePennyState(projectRoot, { env: process.env });

  registeredTool = undefined;
  skillExtension(
    createTestExtensionApi({
      onRegisterTool(definition) {
        if (isRegisteredSkillTool(definition)) registeredTool = definition;
      },
    })
  );
});

afterEach(() => {
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previousEnvironment.clear();
  registeredTool = undefined;
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("real engine to skill adapter dispatch recovery", () => {
  it.each([
    ["paused", "DISPATCH_PAUSED"],
    ["", "DISPATCH_MODE_INVALID"],
    [" ", "DISPATCH_MODE_INVALID"],
    [" paused", "DISPATCH_MODE_INVALID"],
    ["paused ", "DISPATCH_MODE_INVALID"],
    ["PAUSED", "DISPATCH_MODE_INVALID"],
    ["ACTIVE", "DISPATCH_MODE_INVALID"],
    ["unknown", "DISPATCH_MODE_INVALID"],
  ])("fails closed for %p and renders a checkpointless start/retry", async (setting, code) => {
    setEnvironment("PENNY_ARTIFACT_DISPATCH_MODE", setting);
    const runId = `integration-fresh-${Buffer.from(setting).toString("hex") || "blank"}`;
    const result = await invokeSingle(runId);

    expect(result.details).toMatchObject({
      success: false,
      session_id: runId,
      skill_name: "research",
      state: "intake",
      retriable: true,
      dispatch_pause: {
        pause_schema_version: 1,
        code,
        identity: identity(runId),
        recovery: {
          kind: "start_retry",
          action: "retry_start",
          checkpoint_exists: false,
          checkpoint_preserved: false,
          resumable: false,
        },
      },
    });
    expect(result.details.agents_invoked).toEqual([]);
    const checkpointer = openCheckpointer();
    expect(checkpointer.runExists(runId)).toBe(false);
    checkpointer.close();
    const rendered = render(result);
    expect(rendered).toContain(`Run: ${runId}`);
    expect(rendered).toContain("Checkpoint exists: false; resumable: false");
    expect(rendered).toContain("retry the original research start");
    expect(rendered).not.toContain("then recover run");
  });

  it.each([undefined, "active"])(
    "treats %p as active when replaying an existing terminal without dispatch",
    async (setting) => {
      setEnvironment("PENNY_ARTIFACT_DISPATCH_MODE", setting);
      const runId = setting === undefined ? "integration-unset-active" : "integration-exact-active";
      createTerminalRun(runId);
      const result = await invokeSingle(runId);
      expect(result.details.dispatch_pause).toBeUndefined();
      expect(result.details.state).toBe("cancelled");
      expect(render(result)).not.toContain("dispatch paused");
    }
  );

  it("refuses a synthetic admission row missing its immutable native request without mutation", async () => {
    const runId = "integration-admitted-row";
    createAdmissionRow(runId);
    const checkpointer = openCheckpointer();
    const before = canonicalJson(checkpointer.loadRun(identity(runId)).snapshot());
    checkpointer.close();
    await expect(invokeSingle(runId)).resolves.toMatchObject({
      details: { success: false, state: "refused", errors: ["SKILL_RECOVERY_BINDING_INVALID"] },
    });
    const reopened = openCheckpointer();
    expect(canonicalJson(reopened.loadRun(identity(runId)).snapshot())).toBe(before);
    reopened.close();
  });

  it("passes through exact recoverable saved-run facts and preserves checkpoint bytes", async () => {
    const runId = "integration-current-saved";
    const before = createCurrentSavedRun(runId);
    const result = await invokeSingle(runId);

    expect(result.details.dispatch_pause).toMatchObject({
      identity: identity(runId),
      state_id: "researching",
      recovery: {
        kind: "recoverable_checkpoint",
        action: "recover",
        identity: identity(runId),
        state_id: "researching",
        checkpoint_exists: true,
        checkpoint_preserved: true,
        resumable: true,
      },
    });
    const checkpointer = openCheckpointer();
    expect(canonicalJson(checkpointer.loadRun(identity(runId)).snapshot())).toBe(before);
    checkpointer.close();
    const rendered = render(result);
    expect(rendered).toContain(`recover run ${runId}`);
    expect(rendered).toContain(`session ${runId}`);
    expect(rendered).toContain("from state researching");
  });

  it("refuses legacy state without reconstructing missing request custody or mutating its checkpoint", async () => {
    const runId = "integration-legacy-saved";
    const before = createLegacySavedRun(runId);
    // Current admission must not invent a request from a retained context row, even
    // when dispatch is paused. Historical recovery is not a compatibility guarantee.
    await expect(invokeSingle(runId)).resolves.toMatchObject({
      details: { success: false, state: "refused", errors: ["SKILL_RECOVERY_BINDING_INVALID"] },
    });
    const checkpointer = openCheckpointer();
    expect(canonicalJson(checkpointer.loadRun(identity(runId)).snapshot())).toBe(before);
    checkpointer.close();
  });

  it("keeps checkpointless chain steps resumable only through exact chain retry guidance", async () => {
    const first = await tool().execute(
      "chain-paused",
      {
        chain: [{ skill_name: "research", goal: "Paused chain step" }],
      },
      undefined,
      undefined,
      context()
    );
    const chainSessionId = first.details.chain_session_id;
    if (chainSessionId === undefined) throw new Error("paused chain has no chain session identity");
    expect(first.details).toMatchObject({
      mode: "chain",
      state: "paused",
      resumable: true,
      retriable: true,
      dispatch_pause: {
        recovery: {
          kind: "start_retry",
          checkpoint_exists: false,
          resumable: false,
        },
      },
    });
    const firstIdentity = first.details.dispatch_pause?.identity;
    const rendered = render(first);
    expect(rendered).toContain(`resume chain ${chainSessionId}`);
    expect(rendered).not.toContain("then recover run");

    const resumed = await tool().execute(
      "chain-resume-paused",
      { resume_chain: chainSessionId },
      undefined,
      undefined,
      context()
    );
    expect(resumed.details.dispatch_pause?.identity).toEqual(firstIdentity);
    expect(resumed.details.dispatch_pause?.recovery.kind).toBe("start_retry");
    expect(resumed.details.resumable).toBe(true);
  });

  it("returns only paused child results for parallel mode and renders pause, not failure", async () => {
    const response = await tool().execute(
      "parallel-paused",
      {
        skills: [
          { skill_name: "research", goal: "First paused run", session_id: "parallel-paused-1" },
          { skill_name: "research", goal: "Second paused run", session_id: "parallel-paused-2" },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(response.details.parallel_results).toHaveLength(2);
    expect(response.details.parallel_results?.every((item) => item.dispatch_pause)).toBe(true);
    expect(response.details.agents_invoked).toEqual([]);
    const rendered = render(response);
    expect(rendered).toContain("2/2 dispatch paused");
    expect(rendered).not.toContain("✗");
  });
});
