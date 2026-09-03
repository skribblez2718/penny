/** Production-mode matrix for exact catalog-agent tool visibility. */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createWorkerResourceLoader,
  initializePennyState,
  parseSsotTools,
} from "@penny/orchestration/source";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

interface SpawnCapture {
  readonly mode: "single" | "parallel" | "chain";
  readonly agent: string;
  readonly tools: readonly string[];
  readonly cwd: string;
}

const { mockSpawn, spawnCaptures } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  spawnCaptures: [] as SpawnCapture[],
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
}));

import { registerTool } from "../../../../lib/pi-tool-registration.js";
import {
  createTestExtensionApi,
  createTestToolInfos,
  isRecord,
} from "../../../../lib/tests/test-narrowers.js";
import subagentExtension from "../../index.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const AGENTS_DIR = path.join(PROJECT_ROOT, ".pi", "agents");

type ProductionMode = SpawnCapture["mode"];

interface RegisteredSubagentTool {
  readonly name: "subagent";
  readonly execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown
  ) => Promise<{ details: { mode: ProductionMode; results: unknown[] }; isError?: boolean }>;
}

function isRegisteredSubagentTool(value: unknown): value is RegisteredSubagentTool {
  return isRecord(value) && value.name === "subagent" && typeof value.execute === "function";
}

function agentNames(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.replace(/\.md$/u, ""))
    .sort();
}

function argValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined) throw new Error(`spawn omitted ${flag}`);
  return value;
}

function fakeProcess(agent: string) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const processDouble = {
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      if (event === "close") {
        queueMicrotask(() => {
          stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: `deterministic ${agent} output` }],
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { total: 0 },
                  },
                  stopReason: "stop",
                },
              })}\n`
            )
          );
          callback(0);
        });
      }
      return processDouble;
    }),
  };
  return processDouble;
}

function unavailableMemoryExtension(names: readonly string[]) {
  return (pi: ExtensionAPI): void => {
    for (const name of names) {
      registerTool(pi, {
        name,
        label: name,
        description: "Typed unavailable optional-service test provider",
        parameters: Type.Object({}, { additionalProperties: true }),
        async execute() {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: { code: "MEMPALACE_UNAVAILABLE", retryable: true },
                }),
              },
            ],
            details: {},
          };
        },
      });
    }
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("subagent production-mode exact tool surfaces", () => {
  it("executes every catalog agent through single, parallel, and chain with the real SDK-visible YAML set", async () => {
    const agents = agentNames();
    const declaredByAgent = new Map(
      agents.map((agent) => {
        const document = readFileSync(path.join(AGENTS_DIR, `${agent}.md`), "utf8");
        return [agent, [...parseSsotTools(document, agent)]] as const;
      })
    );
    const memoryNames = [
      ...new Set([...declaredByAgent.values()].flat().filter((name) => name.startsWith("memory_"))),
    ];
    expect(memoryNames.length).toBeGreaterThan(0);

    const resourceLoader = await createWorkerResourceLoader(PROJECT_ROOT, [
      unavailableMemoryExtension(memoryNames),
    ]);
    const activeByAgent = new Map<string, readonly string[]>();
    for (const agent of agents) {
      const declared = declaredByAgent.get(agent);
      if (declared === undefined) throw new Error(`missing YAML tools for '${agent}'`);
      const { session } = await createAgentSession({
        cwd: PROJECT_ROOT,
        sessionManager: SessionManager.inMemory(PROJECT_ROOT),
        resourceLoader,
        tools: [...declared],
      });
      try {
        activeByAgent.set(agent, [...session.getActiveToolNames()]);
      } finally {
        session.dispose();
      }
    }

    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "penny-subagent-tool-matrix-"));
    const externalTarget = path.join(temporaryRoot, "untrusted-target");
    mkdirSync(externalTarget, { mode: 0o700 });
    const priorStateRoot = process.env.PENNY_STATE_ROOT;
    const priorPiDirectory = process.env.PI_DIRECTORY;
    const priorProjectRoot = process.env.PROJECT_ROOT;
    process.env.PENNY_STATE_ROOT = path.join(temporaryRoot, "state");
    process.env.PI_DIRECTORY = path.join(PROJECT_ROOT, ".pi");
    process.env.PROJECT_ROOT = PROJECT_ROOT;
    initializePennyState(PROJECT_ROOT, { env: process.env });

    spawnCaptures.length = 0;
    let currentMode: ProductionMode = "single";
    mockSpawn.mockImplementation(
      (_command: string, args: string[], options: Record<string, unknown>) => {
        const sessionDirectory = argValue(args, "--session-dir");
        const agent = path.basename(sessionDirectory);
        const cwd = options.cwd;
        if (typeof cwd !== "string") throw new Error("spawn omitted its working directory");
        spawnCaptures.push({
          mode: currentMode,
          agent,
          tools: argValue(args, "--tools").split(","),
          cwd,
        });
        return fakeProcess(agent);
      }
    );

    let registered: RegisteredSubagentTool | undefined;
    const providerNames = [...new Set([...declaredByAgent.values()].flat())];
    subagentExtension(
      createTestExtensionApi({
        getAllTools: () => createTestToolInfos(providerNames),
        onRegisterTool(tool) {
          if (isRegisteredSubagentTool(tool)) registered = tool;
        },
      })
    );
    if (registered === undefined) throw new Error("subagent tool was not registered");
    const tool: RegisteredSubagentTool = registered;
    const context = {
      cwd: PROJECT_ROOT,
      hasUI: false,
      sessionManager: { getSessionId: () => "tool-surface-parent" },
    };

    const assertMode = (mode: ProductionMode, start: number): void => {
      const captures = spawnCaptures.slice(start);
      expect(captures, mode).toHaveLength(agents.length);
      for (const agent of agents) {
        const matches = captures.filter((capture) => capture.agent === agent);
        expect(matches, `${mode}/${agent} invocation count`).toHaveLength(1);
        const capture = matches[0];
        const declared = declaredByAgent.get(agent);
        const active = activeByAgent.get(agent);
        if (capture === undefined || declared === undefined || active === undefined) {
          throw new Error(`incomplete tool-surface oracle for ${mode}/${agent}`);
        }
        expect(capture.tools, `${mode}/${agent} selected`).toEqual(declared);
        expect([...active].sort(), `${mode}/${agent} model-visible`).toEqual([...declared].sort());
        expect([...capture.tools].sort(), `${mode}/${agent} selected versus active`).toEqual(
          [...active].sort()
        );
        expect(active, `${mode}/${agent} unavailable optional service`).toEqual(
          expect.arrayContaining(declared.filter((name) => name.startsWith("memory_")))
        );
        expect(capture.cwd, `${mode}/${agent} external target`).toBe(externalTarget);
      }
    };

    try {
      currentMode = "single";
      let start = spawnCaptures.length;
      for (const agent of agents) {
        const result = await tool.execute(
          `single-${agent}`,
          { agent, task: "verify exact tools", cwd: externalTarget },
          undefined,
          undefined,
          context
        );
        expect(result.isError, `single/${agent}`).not.toBe(true);
        expect(result.details.mode).toBe("single");
      }
      assertMode("single", start);

      currentMode = "parallel";
      start = spawnCaptures.length;
      const parallel = await tool.execute(
        "parallel-matrix",
        {
          tasks: agents.map((agent) => ({
            agent,
            task: "verify exact tools",
            cwd: externalTarget,
          })),
          maxConcurrency: agents.length,
        },
        undefined,
        undefined,
        context
      );
      expect(parallel.isError).not.toBe(true);
      expect(parallel.details.mode).toBe("parallel");
      assertMode("parallel", start);

      currentMode = "chain";
      start = spawnCaptures.length;
      const chain = await tool.execute(
        "chain-matrix",
        {
          chain: agents.map((agent, index) => ({
            agent,
            task: index === 0 ? "verify exact tools" : "verify exact tools using {previous}",
            cwd: externalTarget,
          })),
        },
        undefined,
        undefined,
        context
      );
      expect(chain.isError).not.toBe(true);
      expect(chain.details.mode).toBe("chain");
      assertMode("chain", start);

      expect(spawnCaptures).toHaveLength(agents.length * 3);
    } finally {
      mockSpawn.mockReset();
      restoreEnvironment("PENNY_STATE_ROOT", priorStateRoot);
      restoreEnvironment("PI_DIRECTORY", priorPiDirectory);
      restoreEnvironment("PROJECT_ROOT", priorProjectRoot);
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
