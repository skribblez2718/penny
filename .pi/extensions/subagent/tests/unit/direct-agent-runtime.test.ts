import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  activeTools: undefined as readonly string[] | undefined,
  events: [] as string[],
  promptCalls: 0,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSessionFromServices: vi.fn(
      async (...args: Parameters<typeof actual.createAgentSessionFromServices>) => {
        const created = await actual.createAgentSessionFromServices(...args);
        if (harness.activeTools !== undefined) {
          vi.spyOn(created.session, "getActiveToolNames").mockReturnValue([...harness.activeTools]);
        }
        const emit = created.session.extensionRunner.emit.bind(created.session.extensionRunner);
        vi.spyOn(created.session.extensionRunner, "emit").mockImplementation(async (event) => {
          if (event.type === "session_shutdown") {
            harness.events.push(`shutdown_${event.reason}_start`);
            const result = await emit(event);
            await Promise.resolve();
            harness.events.push(`shutdown_${event.reason}_end`);
            return result;
          }
          return emit(event);
        });
        const dispose = created.session.dispose.bind(created.session);
        vi.spyOn(created.session, "dispose").mockImplementation(() => {
          harness.events.push("dispose");
          dispose();
        });
        vi.spyOn(created.session, "prompt").mockImplementation(async () => {
          harness.promptCalls += 1;
          throw new Error("provider dispatch is forbidden in admission tests");
        });
        return created;
      }
    ),
  };
});

import { createDirectAgentRuntime } from "../../direct-agent-runtime.js";

const roots: string[] = [];
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("network forbidden");
  });
});
afterEach(() => {
  harness.activeTools = undefined;
  harness.events.length = 0;
  harness.promptCalls = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(tools: string | undefined) {
  const cwd = mkdtempSync(path.join(tmpdir(), "penny-direct-tool-admission-"));
  roots.push(cwd);
  const agentDir = path.join(cwd, "agent");
  mkdirSync(agentDir);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(fauxProvider({ tokensPerSecond: 0 }).provider);
  return createDirectAgentRuntime(
    [
      "--mode",
      "json",
      "-p",
      "--no-extensions",
      "--provider",
      "faux",
      "--session-dir",
      path.join(cwd, "sessions"),
      ...(tools === undefined ? [] : ["--tools", tools]),
    ],
    { cwd, agentDir, modelRuntime, reportProgress: () => {} }
  );
}

async function expectAdmissionRefusal(tools: string | undefined, message: RegExp) {
  let admitted: Awaited<ReturnType<typeof createDirectAgentRuntime>> | undefined;
  try {
    await expect(
      fixture(tools).then((result) => {
        admitted = result;
      })
    ).rejects.toThrow(message);
  } finally {
    // Also release a wrongly admitted session when this regression is run against old code.
    await admitted?.runtime.dispose();
  }
}

describe("direct child exact tool admission", () => {
  it("refuses an unknown requested tool silently dropped by the real SDK", async () => {
    await expectAdmissionRefusal(
      "read,not_registered_fixture",
      /tool surface mismatch before model invocation/u
    );
    expect(harness.events).toEqual(["shutdown_quit_start", "shutdown_quit_end", "dispose"]);
    expect(harness.promptCalls).toBe(0);
  });

  it.each([
    { label: "removal", active: ["read"] },
    { label: "addition", active: ["read", "grep", "bash"] },
    { label: "replacement", active: ["read", "bash"] },
    { label: "case drift", active: ["read", "Grep"] },
    { label: "duplicate", active: ["read", "grep", "grep"] },
  ])("refuses active $label and awaits shutdown before dispose", async ({ active }) => {
    harness.activeTools = active;
    await expectAdmissionRefusal("read,grep", /tool surface mismatch before model invocation/u);
    expect(harness.events).toEqual(["shutdown_quit_start", "shutdown_quit_end", "dispose"]);
    expect(harness.promptCalls).toBe(0);
  });

  it.each([undefined, "", "read,read"])(
    "rejects absent, empty or duplicate requested tools: %s",
    async (tools) => {
      await expectAdmissionRefusal(tools, /requires an exact non-empty duplicate-free tool list/u);
      expect(harness.events).toEqual([]);
      expect(harness.promptCalls).toBe(0);
    }
  );

  it("accepts exactly the requested set regardless of order, without broadening tools", async () => {
    const { runtime } = await fixture("grep,read");
    try {
      expect([...runtime.session.getActiveToolNames()].sort()).toEqual(["grep", "read"]);
      expect(harness.promptCalls).toBe(0);
      await runtime.newSession();
      expect([...runtime.session.getActiveToolNames()].sort()).toEqual(["grep", "read"]);
    } finally {
      await runtime.dispose();
    }
  });
});
