/**
 * Worker runtime-role environment tests.
 *
 * All direct, parallel, chain, and skill-invoked agent paths converge on the
 * shared execution owner in agent-runner.ts. These tests prove each spawned
 * child receives the owner-set worker classification and no authority secret.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn, mockPersistArtifactOutput } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockPersistArtifactOutput: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("../../../artifacts/owner-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../artifacts/owner-client.js")>();
  mockPersistArtifactOutput.mockImplementation(
    async (input: { metadata: unknown; output: string | Buffer }) =>
      actual.expectedArtifactRef(input.metadata, input.output)
  );
  return { ...actual, persistArtifactOutput: mockPersistArtifactOutput };
});

vi.mock("@mariozechner/pi-ai", () => ({
  StringEnum: (values: readonly string[], options?: Record<string, unknown>) => ({
    anyOf: values.map((value) => ({ type: "string", const: value })),
    ...options,
  }),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getMarkdownTheme: () => ({}),
  withFileMutationQueue: vi.fn((_path: string, fn: () => unknown) => fn()),
  parseFrontmatter: <T extends Record<string, string>>(content: string) => {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { frontmatter: {} as T, body: content };
    const frontmatter: Record<string, string> = {};
    for (const line of fmMatch[1].split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) frontmatter[match[1]] = match[2].trim();
    }
    return {
      frontmatter: frontmatter as T,
      body: content.replace(/^---\n[\s\S]*?\n---\n?/, ""),
    };
  },
}));

vi.mock("@mariozechner/pi-tui", () => ({
  Container: class ContainerMock {
    addChild() {}
  },
  Markdown: class MarkdownMock {},
  Spacer: class SpacerMock {},
  Text: class TextMock {
    constructor(_text: string, _x: number, _y: number) {}
  },
}));

import { PlatformMemoryClientV1 } from "../../../../../apps/platform-memory/src/index.js";

import subagentExtension from "../../index.js";
import { isolatedAgentEnvironment, runSingleAgent, type SingleResult } from "../../agent-runner.js";
import type { AgentConfig } from "../../agents.js";

const AUTHORITY_ENV_NAMES = ["PENNY_RECEIPT_HMAC_KEY", "PENNY_APPROVAL_HMAC_KEY"] as const;
const ARTIFACT_INVOCATION_ENV_NAMES = [
  "PENNY_ARTIFACT_INVOCATION_JSON",
  "PENNY_ARTIFACT_INVOCATION_FILE",
  "PENNY_ARTIFACT_CURSOR_HMAC_KEY",
] as const;
const DYNAMIC_MEMORY_CREDENTIAL_NAME = "WORKER_MEMORY_BEARER";
const MEMORY_ENV_NAMES = [
  "PENNY_MEMORY_MODE",
  "PENNY_MEMORY_LOGSTREAM_MODE",
  "PENNY_MEMORY_LOGSTREAM_STREAM",
  "PENNY_MEMORY_LOGSTREAM_ROOMS",
  "PENNY_MEMORY_MCP_ENDPOINT",
  "PENNY_MEMORY_MCP_TOKEN_ENV",
  "PENNY_MEMORY_MCP_TOKEN_FILE",
  "PENNY_MEMORY_FUTURE_SELECTOR",
  "MEMPALACE_MCP_HTTP_TOKEN",
  "MEMPALACE_FUTURE_SECRET",
  "MEMPALACE_PALACE_PATH",
  "MEMPAL_PALACE_PATH",
  "PI_MEMORY_BRIDGE",
  DYNAMIC_MEMORY_CREDENTIAL_NAME,
] as const;
const originalEnv = new Map<string, string | undefined>();

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function createSuccessfulProcess(): MockChild {
  const proc = new EventEmitter() as MockChild;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  queueMicrotask(() => {
    proc.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { total: 0 },
            },
          },
        })}\n`
      )
    );
    proc.emit("close", 0);
  });
  return proc;
}

function makeDetails(results: SingleResult[]) {
  return {
    mode: "single" as const,
    agentScope: "project" as const,
    projectAgentsDir: "/fixture/.pi/agents",
    results,
  };
}

const fixtureAgent: AgentConfig = {
  name: "fixture-worker",
  description: "Runtime role fixture",
  tools: ["read"],
  systemPrompt: "Fixture worker prompt.",
  source: "project",
  filePath: "/fixture/.pi/agents/fixture-worker.md",
};

async function runFixtureWorker(options?: {
  skillContext?: string;
  signal?: AbortSignal;
  ownerEnvironment?: NodeJS.ProcessEnv;
}): Promise<SingleResult> {
  return runSingleAgent(
    process.cwd(),
    [fixtureAgent],
    fixtureAgent.name,
    "Exercise the worker environment",
    undefined,
    undefined,
    options?.signal,
    undefined,
    makeDetails,
    options?.skillContext,
    undefined,
    undefined,
    options?.ownerEnvironment
  );
}

function registeredSubagentTool(): {
  execute: (...args: any[]) => Promise<any>;
} {
  let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
  subagentExtension({
    registerTool: (definition: { name: string; execute: (...args: any[]) => Promise<any> }) => {
      if (definition.name === "subagent") tool = definition;
    },
    on: () => {},
  } as never);
  if (!tool) throw new Error("subagent tool was not registered");
  return tool;
}

async function executeMode(params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  return registeredSubagentTool().execute("runtime-role-test", params, signal, undefined, {
    cwd: process.cwd(),
    hasUI: false,
    ui: { confirm: vi.fn() },
  });
}

function spawnedEnvironments(): NodeJS.ProcessEnv[] {
  return mockSpawn.mock.calls.map((call) => (call[2] as { env: NodeJS.ProcessEnv }).env);
}

/** Env vars that worker-read mode re-adds (read-only subset). */
const WORKER_READ_MEMORY_PASSTHROUGH = [
  "PENNY_MEMORY_MCP_ENDPOINT",
  "PENNY_MEMORY_MCP_TOKEN_FILE",
  "PENNY_MEMORY_PALACE_ID",
  "PENNY_MEMORY_PRINCIPAL_ID",
  "PENNY_MEMORY_TRUST_MODE",
  "PENNY_MEMORY_ISOLATION_BOUNDARY_ID",
  "PENNY_MEMORY_DATA_ROOT_ID",
  "PENNY_MEMORY_MAX_RESPONSE_BYTES",
  "PENNY_MEMORY_REQUEST_TIMEOUT_MS",
] as const;

/** Env vars that must always be stripped, even in worker-read mode. */
const MEMORY_ALWAYS_STRIPPED = [
  "PENNY_MEMORY_MODE",
  "PENNY_MEMORY_WRITE_MODE",
  "PENNY_MEMORY_LOGSTREAM_MODE",
  "PENNY_MEMORY_LOGSTREAM_STREAM",
  "PENNY_MEMORY_LOGSTREAM_ROOMS",
  "PENNY_MEMORY_MCP_TOKEN_ENV",
  "PENNY_MEMORY_FUTURE_SELECTOR",
  "MEMPALACE_MCP_HTTP_TOKEN",
  "MEMPALACE_FUTURE_SECRET",
  "MEMPALACE_PALACE_PATH",
  "MEMPAL_PALACE_PATH",
  "PI_MEMORY_BRIDGE",
  DYNAMIC_MEMORY_CREDENTIAL_NAME,
] as const;

function expectWorkerEnvironment(environment: NodeJS.ProcessEnv): void {
  // The role could be "worker" (no memory access, direct isolatedAgentEnvironment
  // call without memoryReadAccess) or "worker-read" (read-only memory access,
  // when the agent spawning code detects a configured memory hub in process.env).
  const role = environment.PENNY_RUNTIME_ROLE;
  expect(role === "worker" || role === "worker-read").toBe(true);

  // Authority secrets are always stripped
  for (const name of AUTHORITY_ENV_NAMES) expect(environment[name]).toBeUndefined();
  for (const name of ARTIFACT_INVOCATION_ENV_NAMES) expect(environment[name]).toBeUndefined();

  // Write/logstream/legacy memory env vars are always stripped, even in worker-read mode
  for (const name of MEMORY_ALWAYS_STRIPPED) expect(environment[name]).toBeUndefined();

  expect(environment.PENNY_TEST_SAFE_VALUE).toBe("retained");
}

beforeEach(() => {
  for (const name of [
    ...AUTHORITY_ENV_NAMES,
    ...ARTIFACT_INVOCATION_ENV_NAMES,
    "PENNY_RUNTIME_ROLE",
    "PENNY_TEST_SAFE_VALUE",
    ...MEMORY_ENV_NAMES,
    "PENNY_MEMORY_PALACE_ID",
    "PENNY_MEMORY_PRINCIPAL_ID",
    "PENNY_MEMORY_TRUST_MODE",
    "PENNY_MEMORY_ISOLATION_BOUNDARY_ID",
    "PENNY_MEMORY_DATA_ROOT_ID",
  ] as const) {
    originalEnv.set(name, process.env[name]);
  }
  process.env.PENNY_RECEIPT_HMAC_KEY = "receipt-secret";
  process.env.PENNY_APPROVAL_HMAC_KEY = "approval-secret";
  process.env.PENNY_RUNTIME_ROLE = "primary";
  process.env.PENNY_TEST_SAFE_VALUE = "retained";
  process.env.PENNY_ARTIFACT_INVOCATION_JSON = '{"stale":true}';
  process.env.PENNY_ARTIFACT_INVOCATION_FILE = "/stale/invocation.json";
  process.env.PENNY_ARTIFACT_CURSOR_HMAC_KEY = "stale-cursor-key";
  process.env.PENNY_MEMORY_MODE = "hub";
  process.env.PENNY_MEMORY_LOGSTREAM_MODE = "primary-advisory";
  process.env.PENNY_MEMORY_LOGSTREAM_STREAM = "project/advisory";
  process.env.PENNY_MEMORY_LOGSTREAM_ROOMS = "status";
  process.env.PENNY_MEMORY_MCP_ENDPOINT = "http://127.0.0.1:8765/mcp";
  process.env.PENNY_MEMORY_MCP_TOKEN_ENV = DYNAMIC_MEMORY_CREDENTIAL_NAME;
  process.env.PENNY_MEMORY_MCP_TOKEN_FILE = "/owner/private/memory-token";
  process.env.PENNY_MEMORY_PALACE_ID = "penny-primary";
  process.env.PENNY_MEMORY_PRINCIPAL_ID = "penny-primary";
  process.env.PENNY_MEMORY_TRUST_MODE = "isolated";
  process.env.PENNY_MEMORY_ISOLATION_BOUNDARY_ID = "penny-primary-local";
  process.env.PENNY_MEMORY_FUTURE_SELECTOR = "future-config";
  process.env[DYNAMIC_MEMORY_CREDENTIAL_NAME] = "m".repeat(64);
  process.env.MEMPALACE_MCP_HTTP_TOKEN = "upstream-memory-token";
  process.env.MEMPALACE_FUTURE_SECRET = "future-secret";
  process.env.MEMPALACE_PALACE_PATH = "/owner/private/palace";
  process.env.MEMPAL_PALACE_PATH = "/owner/private/legacy-palace";
  process.env.PI_MEMORY_BRIDGE = "/owner/private/memory-bridge.py";
  mockSpawn.mockReset();
  mockPersistArtifactOutput.mockClear();
  mockSpawn.mockImplementation(() => createSuccessfulProcess());
});

afterEach(() => {
  vi.useRealTimers();
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
  mockSpawn.mockReset();
});

describe("isolatedAgentEnvironment", () => {
  it("copies normal environment values, strips authority secrets, and overwrites inherited role claims", () => {
    const parent: NodeJS.ProcessEnv = {
      PENNY_RECEIPT_HMAC_KEY: "receipt-secret",
      PENNY_APPROVAL_HMAC_KEY: "approval-secret",
      PENNY_RUNTIME_ROLE: "primary",
      PENNY_TEST_SAFE_VALUE: "retained",
      PENNY_MEMORY_MODE: "hub",
      PENNY_MEMORY_LOGSTREAM_MODE: "primary-advisory",
      PENNY_MEMORY_LOGSTREAM_STREAM: "project/advisory",
      PENNY_MEMORY_LOGSTREAM_ROOMS: "status",
      PENNY_MEMORY_MCP_ENDPOINT: "http://127.0.0.1:8765/mcp",
      PENNY_MEMORY_MCP_TOKEN_ENV: DYNAMIC_MEMORY_CREDENTIAL_NAME,
      PENNY_MEMORY_MCP_TOKEN_FILE: "/owner/private/memory-token",
      PENNY_MEMORY_FUTURE_SELECTOR: "future-config",
      [DYNAMIC_MEMORY_CREDENTIAL_NAME]: "m".repeat(64),
      MEMPALACE_MCP_HTTP_TOKEN: "upstream-memory-token",
      MEMPALACE_FUTURE_SECRET: "future-secret",
      MEMPALACE_PALACE_PATH: "/owner/private/palace",
      MEMPAL_PALACE_PATH: "/owner/private/legacy-palace",
      PI_MEMORY_BRIDGE: "/owner/private/memory-bridge.py",
    };

    const worker = isolatedAgentEnvironment(parent);

    expectWorkerEnvironment(worker);
    expect(parent.PENNY_RUNTIME_ROLE).toBe("primary");
    expect(parent.PENNY_RECEIPT_HMAC_KEY).toBe("receipt-secret");
    expect(parent.PENNY_APPROVAL_HMAC_KEY).toBe("approval-secret");
    expect(parent.PENNY_MEMORY_MCP_ENDPOINT).toBe("http://127.0.0.1:8765/mcp");
    expect(parent[DYNAMIC_MEMORY_CREDENTIAL_NAME]).toBe("m".repeat(64));
  });

  it("cannot rebuild memory config or resolve a direct HTTP credential from the worker environment", async () => {
    const worker = isolatedAgentEnvironment({
      PENNY_MEMORY_MODE: "hub",
      PENNY_MEMORY_LOGSTREAM_MODE: "primary-advisory",
      PENNY_MEMORY_LOGSTREAM_STREAM: "project/advisory",
      PENNY_MEMORY_LOGSTREAM_ROOMS: "status",
      PENNY_MEMORY_MCP_ENDPOINT: "http://127.0.0.1:8765/mcp",
      PENNY_MEMORY_MCP_TOKEN_ENV: DYNAMIC_MEMORY_CREDENTIAL_NAME,
      PENNY_MEMORY_MCP_TOKEN_FILE: "/owner/private/memory-token",
      PENNY_MEMORY_FUTURE_SELECTOR: "future-config",
      [DYNAMIC_MEMORY_CREDENTIAL_NAME]: "m".repeat(64),
      MEMPALACE_MCP_HTTP_TOKEN: "upstream-memory-token",
      MEMPALACE_FUTURE_SECRET: "future-secret",
      PI_MEMORY_BRIDGE: "/owner/private/memory-bridge.py",
    });

    expect(worker.PENNY_MEMORY_MODE).toBeUndefined();
    expect(worker.PENNY_MEMORY_LOGSTREAM_MODE).toBeUndefined();
    expect(worker.PENNY_MEMORY_LOGSTREAM_STREAM).toBeUndefined();
    expect(worker.PENNY_MEMORY_LOGSTREAM_ROOMS).toBeUndefined();
    expect(worker.PENNY_MEMORY_MCP_ENDPOINT).toBeUndefined();
    expect(worker.PENNY_MEMORY_MCP_TOKEN_ENV).toBeUndefined();
    expect(worker.PENNY_MEMORY_MCP_TOKEN_FILE).toBeUndefined();
    expect(worker[DYNAMIC_MEMORY_CREDENTIAL_NAME]).toBeUndefined();

    const fetchSpy = vi.fn();
    const directClient = new PlatformMemoryClientV1(
      {
        contractVersion: 1,
        mode: "isolated",
        principalId: "worker-bypass-test",
        target: {
          endpoint: "http://127.0.0.1:8765/mcp",
          palaceId: "test-palace",
          dataRootId: "test-data-root",
        },
        credential: { kind: "environment", name: DYNAMIC_MEMORY_CREDENTIAL_NAME },
        trust: { kind: "isolated", isolationBoundaryId: "test-boundary" },
        custody: {
          ownerId: "test-owner",
          backupPolicyRef: "policy:test-backup",
          migrationPolicyRef: "policy:test-migration",
          retentionPolicyRef: "policy:test-retention",
          uninstallDisposition: "preserve",
        },
        capabilities: ["recall-read"],
      },
      { env: worker, fetch: fetchSpy as typeof fetch }
    );

    await expect(directClient.invoke("search", { query: "bypass" })).rejects.toMatchObject({
      code: "MEMORY_CONFIG_INVALID",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("worker role propagation", () => {
  it("marks a direct subagent child, removes stale artifact grants, and excludes artifact_read", async () => {
    await runFixtureWorker();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expectWorkerEnvironment(spawnedEnvironments()[0]);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(
      args.slice(args.indexOf("--exclude-tools"), args.indexOf("--exclude-tools") + 2)
    ).toEqual(["--exclude-tools", "artifact_read"]);
    // Memory tools are now declared in agent frontmatter, not injected.
    // The fixture agent declares only "read", so --tools is just "read".
    expect(args[args.indexOf("--tools") + 1]).toBe("read");
  });

  it("marks every parallel subagent child", async () => {
    await executeMode({
      tasks: [
        { agent: "echo", task: "parallel one" },
        { agent: "echo", task: "parallel two" },
      ],
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    for (const environment of spawnedEnvironments()) expectWorkerEnvironment(environment);
  });

  it("grants only the exact prior chain ref and preserves the final user-facing output", async () => {
    const response = await executeMode({
      chain: [
        { agent: "echo", task: "chain one" },
        { agent: "echo", task: "continue from {previous}" },
      ],
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const [first, second] = spawnedEnvironments();
    expectWorkerEnvironment(first);
    expect(second.PENNY_RUNTIME_ROLE).toBe("worker-read");
    expect(second.PENNY_RECEIPT_HMAC_KEY).toBeUndefined();
    expect(second.PENNY_APPROVAL_HMAC_KEY).toBeUndefined();
    expect(second.PENNY_ARTIFACT_INVOCATION_JSON).toBeTruthy();
    const invocation = JSON.parse(second.PENNY_ARTIFACT_INVOCATION_JSON as string);
    expect(invocation.grants).toHaveLength(1);
    expect(invocation.grants[0].artifact.artifact_id).toBe(
      response.details.outputArtifactRefs[0].artifact_id
    );
    expect(response.content[0].text).toBe("ok");
    expect(response.details.finalOutputArtifactRef).toEqual(response.details.outputArtifactRefs[1]);
    expect(mockPersistArtifactOutput).toHaveBeenCalledTimes(2);
  });

  it("merges an owner artifact environment, adds artifact_read, and still forces worker isolation", async () => {
    const ownerEnvironment: NodeJS.ProcessEnv = {
      PENNY_ARTIFACT_INVOCATION_JSON: JSON.stringify({
        schema_version: 1,
        caller: { run_id: "run-1", consumer_ref: "state:framing", invocation_id: "invoke-1" },
        grants: [{ artifact: { artifact_id: "exact-ref" } }],
      }),
      PENNY_ARTIFACT_INVOCATION_FILE: undefined,
      PENNY_ARTIFACT_CURSOR_HMAC_KEY: "ab".repeat(32),
      PENNY_RUNTIME_ROLE: "primary",
      PENNY_RECEIPT_HMAC_KEY: "owner-must-not-leak",
      PENNY_MEMORY_MCP_ENDPOINT: "http://127.0.0.1:9999/mcp",
      PENNY_MEMORY_MCP_TOKEN_ENV: "OWNER_MEMORY_BEARER",
      PENNY_MEMORY_MCP_TOKEN_FILE: "/owner/private/alternate-token",
      OWNER_MEMORY_BEARER: "o".repeat(64),
      MEMPALACE_MCP_HTTP_TOKEN: "owner-upstream-token",
      PI_MEMORY_BRIDGE: "/owner/private/alternate-bridge.py",
    };

    await runFixtureWorker({
      skillContext: "Skill-owned domain guidance.",
      ownerEnvironment,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const environment = spawnedEnvironments()[0];
    expect(environment.PENNY_RUNTIME_ROLE).toBe("worker-read");
    expect(environment.PENNY_RECEIPT_HMAC_KEY).toBeUndefined();
    expect(environment.PENNY_APPROVAL_HMAC_KEY).toBeUndefined();
    for (const name of MEMORY_ALWAYS_STRIPPED) expect(environment[name]).toBeUndefined();
    expect(environment.OWNER_MEMORY_BEARER).toBeUndefined();
    expect(environment.PENNY_ARTIFACT_INVOCATION_JSON).toBe(
      ownerEnvironment.PENNY_ARTIFACT_INVOCATION_JSON
    );
    expect(environment.PENNY_ARTIFACT_INVOCATION_FILE).toBeUndefined();
    expect(environment.PENNY_ARTIFACT_CURSOR_HMAC_KEY).toBe(
      ownerEnvironment.PENNY_ARTIFACT_CURSOR_HMAC_KEY
    );
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--append-system-prompt");
    // Memory tools are now declared in agent frontmatter, not injected.
    // The fixture agent declares only "read", so --tools is "read,artifact_read".
    expect(args[args.indexOf("--tools") + 1]).toBe("read,artifact_read");
    expect(args).not.toContain("--exclude-tools");
  });

  it("keeps the worker marker and stripped secrets on an aborted child", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    await expect(runFixtureWorker({ signal: controller.signal })).rejects.toThrow(
      "Agent was aborted"
    );
    vi.runAllTimers();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expectWorkerEnvironment(spawnedEnvironments()[0]);
    const proc = mockSpawn.mock.results[0].value as MockChild;
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
