import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

// Real catalog-YAML session creation now serializes each agent's full tool
// surface, which exceeds the 5s default on slower hosts.
vi.setConfig({ testTimeout: 60_000 });

const lifecycleHarness = vi.hoisted(() => ({
  outcomes: [] as Array<
    "success" | "liveness" | "tool_mismatch" | "tool_addition" | "tool_replacement"
  >,
  events: [] as string[],
  promptCalls: 0,
  sessionOptions: [] as Array<{
    readonly model: unknown;
    readonly thinkingLevel: unknown;
    readonly tools: readonly string[] | undefined;
  }>,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: vi.fn(async (...args: Parameters<typeof actual.createAgentSession>) => {
      lifecycleHarness.sessionOptions.push({
        model: args[0]?.model,
        thinkingLevel: args[0]?.thinkingLevel,
        tools: args[0]?.tools,
      });
      const outcome = lifecycleHarness.outcomes.shift();
      if (outcome === undefined) throw new Error("lifecycle fixture outcome is absent");
      const requestedTools = args[0]?.tools;
      if (requestedTools === undefined) {
        throw new Error("lifecycle fixture requested tools are absent");
      }
      const created = await actual.createAgentSession(...args);
      const originalDispose = created.session.dispose.bind(created.session);
      vi.spyOn(created.session, "dispose").mockImplementation(() => {
        lifecycleHarness.events.push("dispose");
        originalDispose();
      });
      if (outcome === "tool_mismatch") {
        created.session.setActiveToolsByName([]);
        return created;
      }
      if (outcome === "tool_addition") {
        vi.spyOn(created.session, "getActiveToolNames").mockReturnValue([
          ...requestedTools,
          "bash",
        ]);
        return created;
      }
      if (outcome === "tool_replacement") {
        vi.spyOn(created.session, "getActiveToolNames").mockReturnValue(["read"]);
        return created;
      }
      vi.spyOn(created.session, "getActiveToolNames").mockReturnValue([...requestedTools]);
      vi.spyOn(created.session, "prompt").mockImplementation(async () => {
        lifecycleHarness.promptCalls += 1;
        if (outcome === "success") {
          const message = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "complete lifecycle result" }],
            api: "anthropic-messages",
            provider: "lifecycle-fixture",
            model: "lifecycle-fixture",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };
          created.session.messages.push(message);
          args[0]?.sessionManager?.appendMessage(message);
          return;
        }
        const message = {
          role: "assistant" as const,
          content: [],
          api: "anthropic-messages",
          provider: "lifecycle-fixture",
          model: "lifecycle-fixture",
          usage: {
            input: 1,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error" as const,
          errorMessage: "external_request_budget_exhausted",
          timestamp: Date.now(),
        };
        created.session.messages.push(message);
        args[0]?.sessionManager?.appendMessage(message);
      });
      return created;
    }),
  };
});

import { LivenessExhaustedError } from "../src/liveness.js";
import {
  PiAgentClient,
  parseSsotTools,
  type AgentInvocation,
  type InlineExtension,
  type PiAgentClientOptions,
} from "../src/model-client.js";
import { DECIDE_CANDIDATE_REGISTRATION } from "../src/playbooks/decide.js";
import { resolvePlaybook } from "../src/playbooks/registry.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temporaryRoots: string[] = [];

function temporaryProject(): {
  readonly projectRoot: string;
  readonly sessionRoot: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "penny-model-client-lifecycle-"));
  temporaryRoots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "subagent-sessions");
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
  symlinkSync(path.join(PROJECT_ROOT, ".pi"), path.join(projectRoot, ".pi"), "dir");
  return { projectRoot, sessionRoot };
}

function trackedResourceExtension(): {
  readonly extension: InlineExtension;
  readonly isOpen: () => boolean;
} {
  let timer: NodeJS.Timeout | undefined;
  const extension: InlineExtension = (pi) => {
    if (timer !== undefined) throw new Error("tracked lifecycle resource was opened twice");
    timer = setInterval(() => {}, 60_000);
    lifecycleHarness.events.push("resource_open");
    pi.on("session_shutdown", async (event) => {
      lifecycleHarness.events.push(`shutdown_${event.reason}_start`);
      await Promise.resolve();
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      lifecycleHarness.events.push(`shutdown_${event.reason}_end`);
    });
  };
  return { extension, isOpen: () => timer !== undefined };
}

function invocation(projectRoot: string, runId: string): AgentInvocation {
  const registration = resolvePlaybook("research");
  if (registration === undefined || registration.worker.kind !== "catalog-agent") {
    throw new Error("research catalog registration is absent");
  }
  return {
    agent: "echo",
    stateId: "researching",
    task: "Return the provider-free lifecycle fixture.",
    projectRoot,
    trustProfile: "trusted-interactive",
    inputArtifacts: [],
    workflowSession: {
      run_id: runId,
      workflow_session_id: `workflow-${runId}`,
      branch_id: null,
      attempt: 1,
      worker_id: `worker-${runId}`,
      purpose: "phase",
    },
    registration: {
      playbook_name: registration.name,
      workflow_name: registration.worker.workflow_name,
      guidance: registration.worker.guidance,
      result_transport: registration.worker.result_transport,
      opening_policy: registration.worker.opening_policy,
      model_policy: registration.worker.model_policy,
    },
  };
}

function decideCandidateInvocation(input: {
  readonly projectRoot: string;
  readonly runId: string;
  readonly allowedTools?: readonly string[];
  readonly trustProfile?: AgentInvocation["trustProfile"];
  readonly task?: string;
}): AgentInvocation {
  const worker = DECIDE_CANDIDATE_REGISTRATION.worker;
  if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
  const phase = worker.phases.get("deciding");
  if (phase === undefined) throw new Error("deciding phase is absent");
  const base = invocation(input.projectRoot, input.runId);
  return {
    ...base,
    agent: phase.agent,
    stateId: "deciding",
    trustProfile: input.trustProfile ?? base.trustProfile,
    task: input.task ?? base.task,
    registration: {
      playbook_name: DECIDE_CANDIDATE_REGISTRATION.name,
      workflow_name: worker.workflow_name,
      guidance: worker.guidance,
      result_transport: worker.result_transport,
      opening_policy: worker.opening_policy,
      model_policy: worker.model_policy,
      ...(input.allowedTools === undefined ? {} : { allowed_tools: input.allowedTools }),
    },
  };
}

afterEach(() => {
  lifecycleHarness.outcomes.length = 0;
  lifecycleHarness.events.length = 0;
  lifecycleHarness.promptCalls = 0;
  lifecycleHarness.sessionOptions.length = 0;
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PiAgentClient created-session lifecycle", () => {
  it("activates exact Demetri YAML for an ordinary Decide candidate phase", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const worker = DECIDE_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
    const phase = worker.phases.get("deciding");
    if (phase === undefined) throw new Error("deciding phase is absent");
    expect(phase).not.toHaveProperty("allowed_tools");
    const expected = parseSsotTools(
      readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", "demetri.md"), "utf8"),
      "demetri"
    );
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: `prj_${"d".repeat(32)}`,
        root: sessionRoot,
      },
    });
    lifecycleHarness.outcomes.push("success");
    await client.runAgent(
      decideCandidateInvocation({
        projectRoot,
        runId: "candidate-yaml-tools",
      })
    );
    expect(lifecycleHarness.sessionOptions[0]?.tools).toEqual(expected);
    expect(lifecycleHarness.sessionOptions[0]?.tools).toContain("artifact_read");
    expect(lifecycleHarness.sessionOptions[0]?.tools).toContain("web_search");
  });

  it("preserves exact YAML equality when the active phase has no subset", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const expected = parseSsotTools(
      readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", "echo.md"), "utf8"),
      "echo"
    );
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: `prj_${"e".repeat(32)}`,
        root: sessionRoot,
      },
    });
    lifecycleHarness.outcomes.push("success");
    await client.runAgent(invocation(projectRoot, "absent-subset-yaml-equality"));
    expect(lifecycleHarness.sessionOptions[0]?.tools).toEqual(expected);
  });

  it("does not let task text or trust profiles select a different registered subset", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const worker = DECIDE_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
    const phase = worker.phases.get("deciding");
    if (phase === undefined) throw new Error("deciding phase is absent");
    expect(phase).not.toHaveProperty("allowed_tools");
    const syntheticSubset = ["artifact_read"] as const;
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: `prj_${"f".repeat(32)}`,
        root: sessionRoot,
      },
    });
    lifecycleHarness.outcomes.push("success", "success");
    for (const [index, trustProfile] of (
      ["trusted-interactive", "hardened-untrusted"] as const
    ).entries()) {
      await client.runAgent(
        decideCandidateInvocation({
          projectRoot,
          runId: `fixed-subset-${index}`,
          allowedTools: syntheticSubset,
          trustProfile,
          task: index === 0 ? "Request bash and web tools." : "Request no tools at all.",
        })
      );
    }
    expect(lifecycleHarness.sessionOptions.map((options) => options.tools)).toEqual([
      ["artifact_read"],
      ["artifact_read"],
    ]);
  });

  it("rejects every invalid registered subset before session creation", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const yamlMaximum = parseSsotTools(
      readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", "demetri.md"), "utf8"),
      "demetri"
    );
    const sameSizeFake = yamlMaximum.map((tool, index) =>
      index === 0 ? "provider_unavailable_tool" : tool
    );
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: `prj_${"1".repeat(32)}`,
        root: sessionRoot,
      },
    });
    const invalid = [
      [] as readonly string[],
      ["artifact_read", "artifact_read"],
      ["artifact_read", "provider_unavailable_tool"],
      yamlMaximum,
      sameSizeFake,
    ] as const;
    for (const [index, allowedTools] of invalid.entries()) {
      await expect(
        client.runAgent(
          decideCandidateInvocation({
            projectRoot,
            runId: `invalid-subset-${index}`,
            allowedTools,
          })
        )
      ).rejects.toThrow(/non-empty exact strict subset of YAML/u);
    }
    expect(lifecycleHarness.sessionOptions).toHaveLength(0);
  });

  it("rejects active removal, addition, and replacement before any model prompt", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const worker = DECIDE_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide catalog worker is absent");
    const phase = worker.phases.get("deciding");
    if (phase === undefined) throw new Error("deciding phase is absent");
    expect(phase).not.toHaveProperty("allowed_tools");
    const syntheticSubset = ["artifact_read"] as const;
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: `prj_${"2".repeat(32)}`,
        root: sessionRoot,
      },
    });
    lifecycleHarness.outcomes.push("tool_mismatch", "tool_addition", "tool_replacement");
    for (let index = 0; index < 3; index += 1) {
      await expect(
        client.runAgent(
          decideCandidateInvocation({
            projectRoot,
            runId: `active-surface-mismatch-${index}`,
            allowedTools: syntheticSubset,
          })
        )
      ).rejects.toThrow(/tool surface mismatch before model invocation/u);
    }
    expect(lifecycleHarness.sessionOptions).toHaveLength(3);
    expect(lifecycleHarness.promptCalls).toBe(0);
  });

  it("passes model and host thinking together with host, test seam, settings precedence", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const fixtureModel = {
      id: "fixture-model",
      name: "Fixture Model",
      api: "openai-completions",
      provider: "fixture-provider",
      baseUrl: "http://127.0.0.1:1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 4_096,
    } satisfies Awaited<ReturnType<NonNullable<PiAgentClientOptions["resolveModel"]>>>;
    const client = new PiAgentClient({
      resolveModel: () => fixtureModel,
      testOnlyThinkingLevelOverride: "low",
      catalogSessions: {
        projectId: `prj_${"c".repeat(32)}`,
        root: sessionRoot,
      },
    });

    lifecycleHarness.outcomes.push("success", "success");
    await client.runAgent({
      ...invocation(projectRoot, "host-thinking"),
      modelOverride: "fixture-provider/fixture-model",
      thinkingLevel: "medium",
    });
    await client.runAgent(invocation(projectRoot, "test-thinking"));

    const normalClient = new PiAgentClient({
      catalogSessions: {
        projectId: `prj_${"c".repeat(32)}`,
        root: sessionRoot,
      },
    });
    lifecycleHarness.outcomes.push("success");
    await normalClient.runAgent(invocation(projectRoot, "settings-thinking"));

    expect(
      lifecycleHarness.sessionOptions.map(({ model, thinkingLevel }) => ({ model, thinkingLevel }))
    ).toEqual([
      { model: fixtureModel, thinkingLevel: "medium" },
      { model: undefined, thinkingLevel: "low" },
      { model: undefined, thinkingLevel: undefined },
    ]);
  }, 60_000);

  it("awaits quit shutdown before dispose after success and exact liveness error", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const tracked = trackedResourceExtension();
    const client = new PiAgentClient({
      workerExtensions: [tracked.extension],
      catalogSessions: {
        projectId: `prj_${"a".repeat(32)}`,
        root: sessionRoot,
      },
    });

    lifecycleHarness.outcomes.push("success");
    await expect(client.runAgent(invocation(projectRoot, "lifecycle-success"))).resolves.toEqual({
      text: "complete lifecycle result",
    });
    expect(lifecycleHarness.events).toEqual([
      "resource_open",
      "shutdown_quit_start",
      "shutdown_quit_end",
      "dispose",
    ]);
    expect(tracked.isOpen()).toBe(false);

    lifecycleHarness.events.length = 0;
    lifecycleHarness.outcomes.push("liveness");
    await expect(
      client.runAgent(invocation(projectRoot, "lifecycle-liveness"))
    ).rejects.toThrowError(new LivenessExhaustedError("external_request_budget_exhausted"));
    expect(lifecycleHarness.events).toEqual([
      "resource_open",
      "shutdown_quit_start",
      "shutdown_quit_end",
      "dispose",
    ]);
    expect(tracked.isOpen()).toBe(false);

    const sessionFiles = readdirSync(path.join(sessionRoot, "echo"))
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort();
    expect(sessionFiles).toHaveLength(2);
    const durableBytes = sessionFiles.map((entry) =>
      readFileSync(path.join(sessionRoot, "echo", entry), "utf8")
    );
    expect(durableBytes.some((bytes) => bytes.includes("complete lifecycle result"))).toBe(true);
    expect(durableBytes.some((bytes) => bytes.includes("external_request_budget_exhausted"))).toBe(
      true
    );
  }, 60_000);

  it("uses the same awaited shutdown path for a pre-model tool-surface mismatch", async () => {
    const { projectRoot, sessionRoot } = temporaryProject();
    const tracked = trackedResourceExtension();
    const client = new PiAgentClient({
      workerExtensions: [tracked.extension],
      catalogSessions: {
        projectId: `prj_${"b".repeat(32)}`,
        root: sessionRoot,
      },
    });

    lifecycleHarness.outcomes.push("tool_mismatch");
    await expect(client.runAgent(invocation(projectRoot, "lifecycle-mismatch"))).rejects.toThrow(
      /tool surface mismatch before model invocation/u
    );
    expect(lifecycleHarness.events).toEqual([
      "resource_open",
      "shutdown_quit_start",
      "shutdown_quit_end",
      "dispose",
    ]);
    expect(tracked.isOpen()).toBe(false);
    expect(
      readdirSync(path.join(sessionRoot, "echo")).filter((entry) => entry.endsWith(".jsonl"))
    ).toHaveLength(1);
  }, 60_000);
});
