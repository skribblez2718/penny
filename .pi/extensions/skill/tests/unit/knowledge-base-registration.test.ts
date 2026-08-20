import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";

const { mockResolveProfile, mockLoadRun, mockFindGate, mockExecute } = vi.hoisted(() => ({
  mockResolveProfile: vi.fn<(input: unknown) => unknown>(() => {
    throw new Error("host session identity is unavailable");
  }),
  mockLoadRun: vi.fn(),
  mockFindGate: vi.fn(),
  mockExecute: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, operation: () => unknown) => operation()),
  parseFrontmatter: vi.fn(() => ({ frontmatter: {}, body: "" })),
}));
vi.mock("@mariozechner/pi-tui", () => ({
  Container: class {},
  Spacer: class {},
  Text: class {},
}));
vi.mock("@penny/orchestration/source", () => ({
  OrchestrationService: class {
    checkpointer = { loadRunById: mockLoadRun };
    execute = mockExecute;
    close() {}
  },
  KbWorkerClient: class {},
  admitKbRun: vi.fn(() => ({ policy_sha256: "a".repeat(64) })),
  resolveGrantedProfile: mockResolveProfile,
  readCurrent: vi.fn(() => ({ generation_id: "gen_1" })),
  readManifest: vi.fn(() => ({ kb_id: "kb_1" })),
  findGateForRun: mockFindGate,
}));

interface RegisteredTool {
  name: string;
  parameters: Parameters<typeof Value.Check>[0];
  execute: (...args: unknown[]) => Promise<{ details?: unknown }>;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  mockResolveProfile.mockReset().mockImplementation(() => {
    throw new Error("host session identity is unavailable");
  });
  mockLoadRun.mockReset();
  mockFindGate.mockReset();
  mockExecute.mockReset();
});

async function loadTools(sessionId?: string): Promise<RegisteredTool[]> {
  const tools: RegisteredTool[] = [];
  const extension = (await import("../../index.js")).default;
  extension({
    registerTool(tool: unknown) {
      tools.push(tool as RegisteredTool);
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === "session_start" && sessionId !== undefined) {
        void handler(
          {},
          {
            sessionManager: { getSessionId: () => sessionId },
            model: { provider: "ollama", id: "qwen3.8:latest" },
          }
        );
      }
    },
    registerCommand() {},
  } as never);
  return tools;
}

describe("knowledge_base registration and closed authority surface", () => {
  it("registers exactly one typed knowledge_base alongside skill", async () => {
    const tools = await loadTools();
    expect(tools.filter((tool) => tool.name === "knowledge_base")).toHaveLength(1);
    expect(tools.filter((tool) => tool.name === "skill")).toHaveLength(1);
    const kb = tools.find((tool) => tool.name === "knowledge_base");
    expect(kb?.parameters).toBeDefined();
  });

  it("accepts the eight closed request variants and rejects authority-shaped extras", async () => {
    const kb = (await loadTools()).find((tool) => tool.name === "knowledge_base");
    if (kb === undefined) throw new Error("knowledge_base not registered");
    const profile = { schema_version: 1, kb_profile_id: "kbp_demo" };
    const valid = [
      { ...profile, action: "init", create: true, title: "Demo" },
      { ...profile, action: "ingest", source_capability_ids: ["cap_1"] },
      { ...profile, action: "query", query: "what changed?" },
      { ...profile, action: "save", query_run_id: "run_1", page_kind: "synthesis", title: "T" },
      { ...profile, action: "lint", mode: "deterministic" },
      {
        ...profile,
        action: "promote",
        page_revisions: [{ page_id: "page_1", revision_id: "rev_1" }],
        canonical_target_capability_ids: ["target_1"],
      },
      { ...profile, action: "status", run_id: "run_1" },
      { ...profile, action: "resume", run_id: "run_1" },
    ];
    for (const request of valid)
      expect(Value.Check(kb.parameters, request), request.action).toBe(true);
    expect(Value.Check(kb.parameters, { ...valid[2], root: "/private" })).toBe(false);
    expect(Value.Check(kb.parameters, { ...valid[5], decision: "approve" })).toBe(false);
    expect(Value.Check(kb.parameters, { ...profile, action: "resume" })).toBe(false);
    expect(
      Value.Check(kb.parameters, { ...profile, action: "query", query: "q", model: "x" })
    ).toBe(false);
  });

  it("stamps engine starts with the authenticated Pi session identity", async () => {
    const sessionId = "sess_owner";
    mockResolveProfile.mockReturnValue({
      resolvedRoot: "/tmp/private-kb",
      profile: { kb_profile_id: "kbp_demo", allow_create: false },
    });
    mockExecute.mockResolvedValue({ action: "await_user" });
    mockFindGate.mockReturnValue({ status: "awaiting", artifacts: [] });
    mockLoadRun.mockReturnValue({ playbookData: { profile_id: "kbp_demo", phases: {} } });
    const kb = (await loadTools(sessionId)).find((tool) => tool.name === "knowledge_base");
    if (kb === undefined) throw new Error("knowledge_base not registered");
    const result = await kb.execute(
      "call_ingest",
      {
        schema_version: 1,
        action: "ingest",
        kb_profile_id: "kbp_demo",
        source_capability_ids: ["cap_1"],
      },
      undefined,
      undefined,
      { cwd: "/tmp/project" }
    );
    expect(result.details).toMatchObject({ status: "waiting_for_review" });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0]?.[0]).toMatchObject({
      identity: { session_id: sessionId, playbook: "knowledge-base" },
    });
  });

  it("binds status and resume to the exact run, active session, and profile", async () => {
    const sessionId = "sess_owner";
    mockResolveProfile.mockReturnValue({
      resolvedRoot: "/tmp/private-kb",
      profile: { kb_profile_id: "kbp_demo", allow_create: false },
    });
    mockLoadRun.mockReturnValue({
      identity: { run_id: "run_exact", session_id: sessionId, playbook: "knowledge-base" },
      playbookData: { profile_id: "kbp_demo" },
      status: "awaiting_user",
      met: false,
    });
    mockFindGate.mockReturnValue({
      run_id: "run_exact",
      status: "awaiting",
      artifacts: [{ artifact_id: "art_1", artifact_kind: "page_draft" }],
    });
    const kb = (await loadTools(sessionId)).find((tool) => tool.name === "knowledge_base");
    if (kb === undefined) throw new Error("knowledge_base not registered");
    const context = { cwd: "/tmp/project" };
    const status = await kb.execute(
      "call_status",
      { schema_version: 1, action: "status", kb_profile_id: "kbp_demo", run_id: "run_exact" },
      undefined,
      undefined,
      context
    );
    expect(status.details).toMatchObject({
      run_id: "run_exact",
      status: "awaiting_user",
      next: "review",
    });
    const resume = await kb.execute(
      "call_resume",
      { schema_version: 1, action: "resume", kb_profile_id: "kbp_demo", run_id: "run_exact" },
      undefined,
      undefined,
      context
    );
    expect(resume.details).toMatchObject({
      run_id: "run_exact",
      status: "awaiting_user",
      next: "review",
    });
    expect(mockFindGate).toHaveBeenCalledWith("/tmp/private-kb", "run_exact");

    mockLoadRun.mockReturnValue({
      identity: { run_id: "run_exact", session_id: "sess_other", playbook: "knowledge-base" },
      playbookData: { profile_id: "kbp_demo" },
      status: "awaiting_user",
      met: false,
    });
    const refused = await kb.execute(
      "call_cross_session",
      { schema_version: 1, action: "resume", kb_profile_id: "kbp_demo", run_id: "run_exact" },
      undefined,
      undefined,
      context
    );
    expect(refused.details).toMatchObject({
      status: "refused",
      warnings: ["run_not_available_for_session_profile"],
    });
  });

  it("fails closed before filesystem access when no authenticated session grant exists", async () => {
    const kb = (await loadTools()).find((tool) => tool.name === "knowledge_base");
    if (kb === undefined) throw new Error("knowledge_base not registered");
    const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-kb-tool-"));
    roots.push(projectRoot);
    const prior = process.env.PROJECT_ROOT;
    delete process.env.PROJECT_ROOT;
    try {
      const result = await kb.execute(
        "call_1",
        { schema_version: 1, action: "status", kb_profile_id: "kbp_demo", run_id: "run_1" },
        undefined,
        undefined,
        { cwd: projectRoot }
      );
      expect(result.details).toMatchObject({
        status: "refused",
        warnings: ["profile_not_authorized"],
      });
    } finally {
      if (prior === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = prior;
    }
  });
});
