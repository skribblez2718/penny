/**
 * Engine-path tests: every skill runs on the run_id/checkpointer contract —
 * recover first, then start/step with `--run-id` and NEVER `--state` (the
 * legacy --state argv transport has been removed entirely; the durable
 * checkpointer owns all FSM state). The ONLY skill without an orchestrate.py
 * is `rez` (a content-only skill) — it hits the `hasOrchestrate` guard and
 * never spawns Python at all.
 */

import { createHash } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

const { mockSpawn, mockPersistArtifactOutput, mockParseSummaryFromOutput } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockPersistArtifactOutput: vi.fn(),
  mockParseSummaryFromOutput: vi.fn(),
}));

vi.mock("child_process", () => ({ spawn: mockSpawn }));
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("../../artifact-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../artifact-client.js")>();
  mockPersistArtifactOutput.mockImplementation(
    async (input: { metadata: unknown; output: string | Buffer }) =>
      actual.expectedArtifactRef(input.metadata, input.output)
  );
  return { ...actual, persistArtifactOutput: mockPersistArtifactOutput };
});
vi.mock("../../skill-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../skill-utils.js")>();
  mockParseSummaryFromOutput.mockImplementation(actual.parseSummaryFromOutput);
  return { ...actual, parseSummaryFromOutput: mockParseSummaryFromOutput };
});

// Toggle per test: `engine` is now cosmetic (SKILL.md metadata is no longer
// consulted for routing — every skill with an orchestrate.py runs on the
// engine substrate), `hasOrchestrate` controls whether the mocked skill has
// scripts/orchestrate.py on disk (rez does not).
const { state } = vi.hoisted(() => ({ state: { engine: true, hasOrchestrate: true } }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (p.includes("orchestrate.py")) return state.hasOrchestrate;
      if (p.includes("SKILL.md")) return true;
      if (p.includes("assets/prompts")) return false;
      if (p.includes(".pi/agents")) return true;
      if (String(p).endsWith(".md")) return true;
      return (actual.existsSync as any)(p);
    }),
    readFileSync: vi.fn((p: string, ...args: any[]) => {
      if (p.includes("SKILL.md")) {
        const eng = state.engine ? "\nmetadata:\n  penny:\n    engine: orchestration" : "";
        return `---\nname: eng-skill\ndescription: test${eng}\n---`;
      }
      if (p.includes(".pi/agents/")) return "---\nname: echo\ndescription: desc\n---\n# Prompt\n";
      return (actual.readFileSync as any)(p, ...args);
    }),
    readdirSync: vi.fn((p: string, _opts?: any) => {
      if (String(p).includes(".pi/skills"))
        return [{ name: "eng-skill", isDirectory: () => true }] as any;
      if (String(p).includes(".pi/agents"))
        return [
          {
            name: "echo.md",
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          },
        ] as any;
      return [];
    }),
    statSync: vi.fn((p: string) => ({
      isDirectory: () => String(p).includes(".pi/skills") || String(p).includes(".pi/agents"),
    })),
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_p: string, fn: () => any) => fn()),
  parseFrontmatter: (content: string | Buffer) => {
    const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return { frontmatter: {}, body: text };
    const fm: Record<string, string> = {};
    for (const line of m[1].split("\n")) {
      const mm = line.match(/^(\w+):\s*(.+)$/);
      if (mm) fm[mm[1]] = mm[2].trim();
    }
    return { frontmatter: fm, body: text.replace(/^---\n[\s\S]*?\n---\n?/, "") };
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
function createMockPi(): any {
  registeredTool = undefined;
  return {
    registerTool: (def: any) => {
      registeredTool = def;
    },
    on: vi.fn(),
    registerCommand: vi.fn(),
  };
}

function outputArtifact(runId: string, phase: string, agent: string, branchId: string | null) {
  return {
    schema_version: 1,
    run_id: runId,
    phase,
    branch_id: branchId,
    kind: "agent-output",
    operation_id: `${phase}-${branchId ?? "single"}-output-v1`,
    version: 1,
    producer: `agent:${agent}`,
    consumer_scope: ["state:next"],
    media_type: "text/plain; charset=utf-8",
    parent_ref: null,
    upstream_refs: [],
  };
}

function pausedAction(
  runId = "run-paused",
  code: "ARTIFACT_DISPATCH_PAUSED" | "ARTIFACT_DISPATCH_MODE_INVALID" = "ARTIFACT_DISPATCH_PAUSED"
) {
  return {
    schema_version: 1,
    action: "paused",
    code,
    reason: "dispatch is paused; checkpoint preserved",
    retryable: true,
    dispatch_mode: "paused",
    run_status: "running",
    state_id: "researching",
    session_id: "session-paused",
    run_id: runId,
    recovery: {
      action: "recover",
      run_id: runId,
      requires_dispatch_mode: "active",
      checkpoint_preserved: true,
    },
  };
}

function ownerBoundPayload(value: any, runId: string): any {
  const payload = structuredClone(value);
  if (payload.action === "paused") return payload;
  payload.run_id = runId;
  if (payload.action === "invoke_agent" && !payload.__omit_output_artifact) {
    payload.output_artifact = outputArtifact(
      runId,
      payload.state_id || "unknown",
      payload.agent,
      null
    );
  }
  if (payload.action === "invoke_agents_parallel" && Array.isArray(payload.tasks)) {
    payload.tasks = payload.tasks.map((task: any, index: number) => {
      const branchId = task.branch_id || `branch-${index + 1}`;
      return {
        ...task,
        branch_id: branchId,
        output_artifact: outputArtifact(runId, payload.state_id || "unknown", task.agent, branchId),
      };
    });
  }
  if (
    (payload.action === "invoke_agent" || payload.action === "invoke_agents_parallel") &&
    !payload.__omit_input_artifacts
  ) {
    payload.input_artifacts ??= {
      schema_version: 1,
      run_id: runId,
      consumer: `state:${payload.state_id || "unknown"}`,
      artifacts: [],
    };
  }
  delete payload.__omit_output_artifact;
  delete payload.__omit_input_artifacts;
  return payload;
}

const MULTIPART_FINAL_OUTPUT = 'first🙂\nsecond漢\nSUMMARY:{"complete":true}';

function multipartAgentEvents() {
  return [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "first🙂" },
          {
            type: "toolCall",
            id: "call-final",
            name: "read",
            arguments: { path: "ignored" },
          },
          { type: "text", text: "\nsecond漢" },
          { type: "thinking", thinking: "more private reasoning" },
          { type: "text", text: '\nSUMMARY:{"complete":true}' },
        ],
        stopReason: "stop",
        usage: { input: 10, output: 5, totalTokens: 15 },
      },
    },
  ];
}

function buildPythonSpawner(payloads: any[], agentEvents: any[] = [], agentExitCode = 0) {
  let idx = 0;
  return (_cmd: string, args: string[]) => {
    if (!args[0]?.includes("orchestrate.py")) {
      return {
        stdout: {
          on: vi.fn((e: string, cb: Function) => {
            if (e === "data" && agentEvents.length) {
              cb(Buffer.from(agentEvents.map((event) => JSON.stringify(event)).join("\n") + "\n"));
            }
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((e: string, cb: Function) => {
          if (e === "close") setTimeout(() => cb(agentExitCode), 0);
        }),
      };
    }
    const rawPayload = payloads[idx++];
    const runIdIndex = args.indexOf("--run-id");
    const runId = runIdIndex >= 0 ? args[runIdIndex + 1] : "run-test";
    const payload = rawPayload ? ownerBoundPayload(rawPayload, runId) : rawPayload;
    return {
      stdout: {
        on: vi.fn((e: string, cb: Function) => {
          if (e === "data" && payload) cb(Buffer.from(JSON.stringify(payload)));
        }),
      },
      stderr: { on: vi.fn() },
      on: vi.fn((e: string, cb: Function) => {
        if (e === "close") setTimeout(() => cb(0), 0);
      }),
    };
  };
}

function orchestrateCalls() {
  return mockSpawn.mock.calls.filter((c: any) => (c[1] as string[])[0]?.includes("orchestrate.py"));
}
const cmdOf = (call: any) => (call[1] as string[])[1];
const argsOf = (call: any) => call[1] as string[];

async function run(constraints?: Record<string, unknown>) {
  const mod = await import("../../index.js");
  const pi = createMockPi();
  mod.default(pi);
  const ctx = { cwd: process.cwd(), ui: { theme: { fg: () => "" }, notify: vi.fn() } };
  return registeredTool.execute(
    "t1",
    { skill_name: "eng-skill", goal: "prove it", constraints },
    undefined,
    undefined,
    ctx
  );
}

describe("skill engine path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    state.engine = true;
    state.hasOrchestrate = true;
    process.env.PROJECT_ROOT = PROJECT_ROOT;
  });
  afterEach(() => {
    delete process.env.PROJECT_ROOT;
    delete process.env.PENNY_ARTIFACT_DISPATCH_MODE;
  });

  it("handles an engine pause as non-success/retriable without agent or step dispatch", async () => {
    mockSpawn.mockImplementation(buildPythonSpawner([pausedAction()]));

    const response = await run();

    expect(response.details).toMatchObject({
      success: false,
      state: "researching",
      retriable: true,
      agents_invoked: [],
      errors: [],
      dispatch_pause: {
        action: "paused",
        code: "ARTIFACT_DISPATCH_PAUSED",
        retryable: true,
      },
      recovery: {
        action: "recover",
        run_id: "run-paused",
        checkpoint_preserved: true,
      },
    });
    expect(orchestrateCalls().map(cmdOf)).toEqual(["recover"]);
    expect(mockPersistArtifactOutput).not.toHaveBeenCalled();
  });

  it("driver defense-in-depth fails unknown mode closed before a stale invoke directive", async () => {
    process.env.PENNY_ARTIFACT_DISPATCH_MODE = "semantic-memory";
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
        {
          action: "invoke_agent",
          state_id: "researching",
          session_id: "s",
          run_id: "R",
          agent: "echo",
          task_summary: "must not run",
        },
      ])
    );

    const response = await run();

    expect(response.details).toMatchObject({
      success: false,
      retriable: true,
      agents_invoked: [],
      dispatch_pause: { code: "ARTIFACT_DISPATCH_MODE_INVALID" },
    });
    expect(orchestrateCalls().map(cmdOf)).toEqual(["recover", "start"]);
    expect(mockPersistArtifactOutput).not.toHaveBeenCalled();
  });

  it("engine skill: recover first, then start/step with --run-id and no --state", async () => {
    state.engine = true;
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" }, // recover -> none
        {
          action: "invoke_agent",
          state_id: "framing",
          session_id: "s",
          run_id: "R",
          agent: "echo",
          task_summary: "frame it",
        }, // start
        { action: "complete", state_id: "complete", session_id: "s", run_id: "R" }, // step
      ])
    );
    await run();
    const calls = orchestrateCalls();
    const cmds = calls.map(cmdOf);
    expect(cmds[0]).toBe("recover");
    expect(cmds).toContain("start");
    expect(cmds).toContain("step");
    for (const c of calls) {
      const a = argsOf(c);
      if (a[1] === "start" || a[1] === "step") {
        expect(a).toContain("--run-id");
        expect(a).not.toContain("--state");
      }
    }
  });

  it("single path persists the canonical multipart result bytes and matching ref digest", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner(
        [
          { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
          {
            action: "invoke_agent",
            state_id: "s1",
            session_id: "s",
            run_id: "R",
            agent: "echo",
            task_summary: "capture multipart output",
          },
          {
            action: "complete",
            state_id: "complete",
            session_id: "s",
            run_id: "R",
            result: { met: true },
          },
        ],
        multipartAgentEvents()
      )
    );

    const { getFinalOutput } = await import("../../../subagent/agent-runner.js");
    const normalResult = getFinalOutput(
      multipartAgentEvents().map((event) => event.message) as any
    );
    expect(normalResult).toBe(MULTIPART_FINAL_OUTPUT);

    await run();
    expect(mockPersistArtifactOutput).toHaveBeenCalledTimes(1);
    const persisted = mockPersistArtifactOutput.mock.calls[0][0] as {
      output: string;
    };
    expect(persisted.output).toBe(normalResult);

    const stepCall = orchestrateCalls().find((call) => cmdOf(call) === "step");
    const args = argsOf(stepCall);
    const wrapper = JSON.parse(args[args.indexOf("--result") + 1]);
    expect(wrapper.output_artifact_ref.byte_length).toBe(Buffer.byteLength(normalResult, "utf8"));
    expect(wrapper.output_artifact_ref.content_digest).toBe(
      createHash("sha256").update(Buffer.from(normalResult, "utf8")).digest("hex")
    );
  });

  it("parallel path persists every branch's complete multipart text sequence", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner(
        [
          { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
          {
            action: "invoke_agents_parallel",
            state_id: "fan",
            session_id: "s",
            run_id: "R",
            tasks: [
              { branch_id: "a", agent: "echo", task_summary: "branch a" },
              { branch_id: "b", agent: "echo", task_summary: "branch b" },
            ],
          },
          {
            action: "complete",
            state_id: "complete",
            session_id: "s",
            run_id: "R",
            result: { met: true },
          },
        ],
        multipartAgentEvents()
      )
    );

    await run();
    expect(mockPersistArtifactOutput).toHaveBeenCalledTimes(2);
    expect(
      mockPersistArtifactOutput.mock.calls.map((call) => (call[0] as { output: string }).output)
    ).toEqual([MULTIPART_FINAL_OUTPUT, MULTIPART_FINAL_OUTPUT]);

    const stepCall = orchestrateCalls().find((call) => cmdOf(call) === "step");
    const args = argsOf(stepCall);
    const entries = JSON.parse(args[args.indexOf("--result") + 1]);
    const expectedDigest = createHash("sha256")
      .update(Buffer.from(MULTIPART_FINAL_OUTPUT, "utf8"))
      .digest("hex");
    expect(entries.map((entry: any) => entry.branch_id)).toEqual(["a", "b"]);
    for (const entry of entries) {
      expect(entry.output_artifact_ref.byte_length).toBe(
        Buffer.byteLength(MULTIPART_FINAL_OUTPUT, "utf8")
      );
      expect(entry.output_artifact_ref.content_digest).toBe(expectedDigest);
    }
  });

  it("engine skill: missing SUMMARY passes through empty + summary_missing (no domain default synthesized)", async () => {
    state.engine = true;
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
        {
          action: "invoke_agent",
          state_id: "exploring",
          session_id: "s",
          run_id: "R",
          agent: "echo",
          task_summary: "explore",
        },
        { action: "complete", state_id: "complete", session_id: "s", run_id: "R" },
      ])
    );
    await run();
    const stepCall = orchestrateCalls().find((c) => cmdOf(c) === "step");
    expect(stepCall).toBeTruthy();
    const a = argsOf(stepCall);
    const parsed = JSON.parse(a[a.indexOf("--result") + 1]);
    expect(parsed.protocol_version).toBe(2);
    expect(parsed.run_id).toBe(parsed.output_artifact_ref.run_id);
    expect(parsed.phase).toBe("exploring");
    expect(parsed.branch_id).toBeNull();
    expect(parsed.producer).toBe("agent:echo");
    expect(parsed.operation_id).toBe(parsed.output_artifact_ref.operation_id);
    expect(parsed.execution_receipt).toEqual(parsed.receipts[0]);
    expect(parsed.execution_receipt.output_artifact_ref).toBe(
      JSON.stringify(parsed.output_artifact_ref, Object.keys(parsed.output_artifact_ref).sort())
    );
    expect(parsed.summary).toEqual({});
    expect(parsed.summary_missing).toBe(true);
    expect(mockPersistArtifactOutput).toHaveBeenCalledTimes(1);
    expect(mockParseSummaryFromOutput).toHaveBeenCalledTimes(1);
    expect(mockPersistArtifactOutput.mock.invocationCallOrder[0]).toBeLessThan(
      mockParseSummaryFromOutput.mock.invocationCallOrder[0]
    );
    // The engine path must NOT synthesize a domain-shaped default (e.g. echo's
    // explore_complete/findings_count) — the playbook's contract is the validator.
    expect(parsed.summary).not.toHaveProperty("explore_complete");
    expect(parsed.summary).not.toHaveProperty("findings_count");
  });

  it("preserves an empty-output provider error instead of reporting a malformed SUMMARY", async () => {
    state.engine = true;
    mockSpawn.mockImplementation(
      buildPythonSpawner(
        [
          { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
          {
            action: "invoke_agent",
            state_id: "exploring",
            session_id: "s",
            run_id: "R",
            agent: "echo",
            task_summary: "explore",
          },
          { action: "error", state_id: "error", session_id: "s", run_id: "R" },
        ],
        [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "provider stream failed after context exhaustion",
              usage: { input: 140000, output: 0, totalTokens: 140000 },
            },
          },
        ]
      )
    );
    await run();
    const stepCall = orchestrateCalls().find((c) => cmdOf(c) === "step");
    expect(stepCall).toBeTruthy();
    const a = argsOf(stepCall);
    const parsed = JSON.parse(a[a.indexOf("--result") + 1]);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.summary).toEqual({});
    expect(parsed.summary_missing).toBe(true);
    expect(parsed.error).toBe("provider stream failed after context exhaustion");
    expect(parsed.error).not.toContain("invalid semantic SUMMARY");
  });

  it("fails closed before agent execution and pythonStep when output_artifact is missing", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
        {
          action: "invoke_agent",
          state_id: "exploring",
          session_id: "s",
          agent: "echo",
          task_summary: "explore",
          __omit_output_artifact: true,
        },
      ])
    );

    await expect(run()).rejects.toMatchObject({ code: "ARTIFACT_CONTRACT_INVALID" });
    expect(mockPersistArtifactOutput).not.toHaveBeenCalled();
    expect(orchestrateCalls().map(cmdOf)).toEqual(["recover", "start"]);
  });

  it("fails closed before agent execution when input_artifacts is missing", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
        {
          action: "invoke_agent",
          state_id: "exploring",
          session_id: "s",
          agent: "echo",
          task_summary: "explore",
          __omit_input_artifacts: true,
        },
      ])
    );

    await expect(run()).rejects.toMatchObject({ code: "ARTIFACT_CONTRACT_INVALID" });
    expect(mockPersistArtifactOutput).not.toHaveBeenCalled();
    expect(orchestrateCalls().map(cmdOf)).toEqual(["recover", "start"]);
  });

  it("does not call pythonStep after a typed artifact persistence failure", async () => {
    const { ArtifactClientError } = await import("../../artifact-client.js");
    mockPersistArtifactOutput.mockRejectedValueOnce(
      new ArtifactClientError("ARTIFACT_PERSIST_FAILED", "manifest commit failed")
    );
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
        {
          action: "invoke_agent",
          state_id: "exploring",
          session_id: "s",
          agent: "echo",
          task_summary: "explore",
        },
      ])
    );

    await expect(run()).rejects.toMatchObject({ code: "ARTIFACT_PERSIST_FAILED" });
    expect(mockPersistArtifactOutput).toHaveBeenCalledTimes(1);
    expect(orchestrateCalls().map(cmdOf)).toEqual(["recover", "start"]);
  });

  it("surfaces a failed pending-run recovery instead of starting a second run", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        {
          action: "error",
          state_id: "error",
          session_id: "s",
          run_id: "R",
          errors: ["tool state VALIDATE failed"],
        },
      ])
    );
    const result = await run();
    expect(result.details.success).toBe(false);
    expect(result.details.errors).toContain("tool state VALIDATE failed");
    expect(orchestrateCalls().map(cmdOf)).toEqual(["recover"]);
  });

  it("preserves a structured planned-gate user_response on resume", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        {
          action: "escalate_to_user",
          state_id: "CARREN_DISPOSITION",
          session_id: "s",
          run_id: "R",
          questions: [],
        },
        { action: "complete", state_id: "complete", session_id: "s", run_id: "R" },
      ])
    );
    await run({ user_response: { action: "retry_once" } });
    const stepCall = orchestrateCalls().find((c) => cmdOf(c) === "step");
    expect(stepCall).toBeTruthy();
    const a = argsOf(stepCall);
    expect(a[a.indexOf("--agent") + 1]).toBe("user");
    const parsed = JSON.parse(a[a.indexOf("--result") + 1]);
    expect(parsed.answer).toEqual({ action: "retry_once" });
    expect(parsed.user_response).toEqual({ action: "retry_once" });
    expect(parsed.clarification).toBe('{"action":"retry_once"}');
  });

  it("preserves the complete Python result and never maps met=false to public success", async () => {
    const structuredResult = {
      schema_version: 1,
      met: false,
      terminal_reason: "incomplete-unresolved-obligations",
      selected_artifacts: { quality_floor: { artifact_id: "floor-1", version: 1 } },
      residual_risks: [{ finding_id: "ANNIE-H1", accepter: "human:reviewer" }],
      completion_failures: ["criterion:7 uncovered"],
    };
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
        {
          action: "invoke_agent",
          state_id: "verifying",
          session_id: "s",
          run_id: "R",
          agent: "echo",
          task_summary: "verify",
        },
        {
          action: "incomplete",
          state_id: "complete",
          session_id: "s",
          run_id: "R",
          result: structuredResult,
        },
      ])
    );
    const response = await run();
    expect(response.details.success).toBe(false);
    expect(response.details.result).toEqual(structuredResult);
    expect(response.details.errors).toContain("criterion:7 uncovered");
  });

  it("treats complete without structured result.met as unverified, not success", async () => {
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
        {
          action: "invoke_agent",
          state_id: "verifying",
          session_id: "s",
          run_id: "R",
          agent: "echo",
          task_summary: "verify",
        },
        { action: "complete", state_id: "complete", session_id: "s", run_id: "R" },
      ])
    );
    const response = await run();
    expect(response.details.success).toBe(false);
  });

  it("maps complete to public success only when structured result.met is true", async () => {
    const structuredResult = { schema_version: 1, met: true, terminal_reason: "verified-complete" };
    mockSpawn.mockImplementation(
      buildPythonSpawner([
        { action: "status", state: "unknown", complete: false, session_id: "s", run_id: "" },
        {
          action: "invoke_agent",
          state_id: "verifying",
          session_id: "s",
          run_id: "R",
          agent: "echo",
          task_summary: "verify",
        },
        {
          action: "complete",
          state_id: "complete",
          session_id: "s",
          run_id: "R",
          result: structuredResult,
        },
      ])
    );
    const response = await run();
    expect(response.details.success).toBe(true);
    expect(response.details.result).toEqual(structuredResult);
  });

  it("skill without orchestrate.py (matching rez): hits the hasOrchestrate guard, never spawns Python", async () => {
    // rez is a content-only skill with no scripts/orchestrate.py. The legacy
    // per-skill execution path has been removed entirely — there is no
    // fallback route for a skill lacking orchestrate.py, it simply errors.
    state.engine = false;
    state.hasOrchestrate = false;
    mockSpawn.mockImplementation(buildPythonSpawner([]));
    const result = await run();
    expect(result.details.success).toBe(false);
    expect(result.details.errors).toContain("Skill has no orchestrate.py");
    // No orchestrate.py spawns at all — not recover, not start, not step.
    expect(orchestrateCalls().length).toBe(0);
  });
});
