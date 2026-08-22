/** TypeScript-only skill routing: no Python process is reachable from any mode. */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSpawn,
  mockTypeScriptExecute,
  mockLoadRun,
  mockArtifactRead,
  mockServiceOptions,
  mockPersistHandoff,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockTypeScriptExecute: vi.fn(),
  mockLoadRun: vi.fn(() => undefined),
  mockArtifactRead: vi.fn(() => Buffer.from("exact")),
  mockServiceOptions: [] as Array<Record<string, unknown>>,
  mockPersistHandoff: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("child_process", () => ({ spawn: mockSpawn }));
vi.mock("@penny/orchestration/source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@penny/orchestration/source")>()),
  OrchestrationService: class {
    artifacts = { read: mockArtifactRead };
    checkpointer = {
      loadRunById: mockLoadRun,
      events: vi.fn(() => [{ payload: { agent: "echo" } }]),
    };
    execute = mockTypeScriptExecute;
    constructor(options: Record<string, unknown>) {
      mockServiceOptions.push(options);
    }
    close() {}
    [Symbol.dispose]() {
      this.close();
    }
  },
  ArtifactStore: class {},
  loadRuntimeConfig: vi.fn(),
}));
vi.mock("../../skill-chain-artifacts.js", () => ({
  persistSkillChainHandoff: mockPersistHandoff,
  validateSkillChainHandoff: vi.fn(async () => undefined),
  skillChainInput: ({ targetRunId, handoffRef }: any) => ({
    schema_version: 1,
    run_id: targetRunId,
    consumer: `skill-start:${targetRunId}`,
    artifacts: [{ slot: "previous-skill-terminal-output", ref: handoffRef }],
  }),
}));
vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, operation: () => unknown) => operation()),
  parseFrontmatter: (content: string | Buffer) => {
    const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    const frontmatter: Record<string, string> = {};
    for (const line of match?.[1]?.split("\n") ?? []) {
      const item = line.match(/^(\w+):\s*(.+)$/);
      if (item) frontmatter[item[1]] = item[2].trim();
    }
    return { frontmatter, body: text };
  },
}));
vi.mock("@mariozechner/pi-tui", () => ({
  Container: class {
    addChild() {}
  },
  Markdown: class {},
  Text: class {},
  Spacer: class {},
}));

let registeredTool: any;
function pi(): any {
  return {
    registerTool: (definition: any) => {
      if (definition.name === "skill") registeredTool = definition;
    },
    on: vi.fn(),
    registerCommand: vi.fn(),
  };
}
function context(): any {
  return {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    ui: { theme: { fg: () => "" }, notify: vi.fn() },
  };
}
function artifactRef(runId: string, phase = "report_writing") {
  const identity = {
    branch_id: null,
    kind: "agent-output",
    operation_id: `${runId}-${phase}`,
    phase,
    run_id: runId,
    version: 1,
  };
  const digest = "a".repeat(64);
  return {
    schema_version: 1,
    artifact_id: `art_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    run_id: runId,
    phase,
    branch_id: null,
    kind: "agent-output",
    operation_id: identity.operation_id,
    version: 1,
    producer: "agent:skribble",
    consumer_scope: ["state:report_writing"],
    media_type: "text/plain; charset=utf-8",
    byte_length: 5,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}
function complete(runId: string, withArtifact = false) {
  return {
    schema_version: 2,
    action: "complete",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: runId,
      playbook: "research",
      engine_owner: "typescript",
    },
    state_id: "report_writing",
    status: "complete",
    met: true,
    result: { met: true, output_artifact_ref: withArtifact ? artifactRef(runId) : null },
    artifacts: [],
    unresolved: [],
  };
}

const temporaryRoots: string[] = [];
beforeEach(async () => {
  vi.clearAllMocks();
  mockServiceOptions.length = 0;
  mockLoadRun.mockReturnValue(undefined);
  mockTypeScriptExecute.mockImplementation(async (request: any) =>
    complete(request.identity.run_id)
  );
  const directory = mkdtempSync(join(tmpdir(), "penny-ts-skill-routing-"));
  temporaryRoots.push(directory);
  process.env.PENNY_SKILL_CHAIN_STATE_ROOT = directory;
  process.env.PROJECT_ROOT = process.cwd();
  const extension = await import("../../index.js");
  extension.default(pi());
});
afterEach(() => {
  delete process.env.PENNY_SKILL_CHAIN_STATE_ROOT;
  delete process.env.PROJECT_ROOT;
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop() as string, { recursive: true, force: true });
  }
});

describe("TypeScript-only skill engine path", () => {
  it("runs single research without an engine selector or Python spawn", async () => {
    const response = await registeredTool.execute(
      "single",
      { skill_name: "research", goal: "research safely", session_id: "single-ts" },
      undefined,
      undefined,
      context()
    );
    expect(response.details).toMatchObject({ success: true, session_id: "single-ts" });
    expect(mockTypeScriptExecute).toHaveBeenCalledTimes(1);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(registeredTool.parameters.properties.engine).toBeUndefined();
  });

  it("applies a test/caller model override without mutating production process defaults", async () => {
    const before = process.env.PENNY_RESEARCH_DEFAULT_MODEL;
    await registeredTool.execute(
      "model",
      {
        skill_name: "research",
        goal: "model test",
        session_id: "model-ts",
        model: "qwen3.827b:latest",
      },
      undefined,
      undefined,
      context()
    );
    expect((mockServiceOptions[0]?.env as NodeJS.ProcessEnv).PENNY_RESEARCH_DEFAULT_MODEL).toBe(
      "qwen3.827b:latest"
    );
    expect(process.env.PENNY_RESEARCH_DEFAULT_MODEL).toBe(before);
  });

  it("runs parallel skills through independent TypeScript services", async () => {
    const response = await registeredTool.execute(
      "parallel",
      {
        skills: [
          { skill_name: "research", goal: "first", session_id: "parallel-one" },
          { skill_name: "research", goal: "second", session_id: "parallel-two" },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(response.details).toMatchObject({ success: true, mode: "parallel" });
    expect(mockTypeScriptExecute).toHaveBeenCalledTimes(2);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("runs a two-step chain through TypeScript and seeds the exact target-run handoff", async () => {
    mockTypeScriptExecute.mockImplementation(async (request: any) =>
      complete(request.identity.run_id, true)
    );
    mockPersistHandoff.mockImplementation(async (options: any) => ({
      ...artifactRef(options.targetRunId, "chain_input"),
      consumer_scope: [
        `skill-start:${options.targetRunId}`,
        "state:planning",
        "state:researching",
      ].sort(),
    }));
    const response = await registeredTool.execute(
      "chain",
      {
        chain: [
          { skill_name: "research", goal: "first", session_id: "chain-one" },
          {
            skill_name: "research",
            goal: "use {previous}",
            session_id: "chain-two",
          },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(response.details).toMatchObject({ success: true, mode: "chain" });
    expect(mockPersistHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ targetRunId: "chain-two", projectRoot: expect.any(String) })
    );
    expect(mockArtifactRead).toHaveBeenCalledTimes(1);
    expect(mockTypeScriptExecute).toHaveBeenCalledTimes(2);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("refuses an unregistered skill without falling back to Python", async () => {
    const response = await registeredTool.execute(
      "unknown",
      { skill_name: "not-registered", goal: "no fallback" },
      undefined,
      undefined,
      context()
    );
    expect(response.details.success).toBe(false);
    expect(response.details.errors).toContain(
      "TypeScript orchestration currently supports the research skill on this tool."
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
