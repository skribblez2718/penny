import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import observabilityExtension from "../../index.js";
import {
  createTestExtensionApi,
  isRecord,
  requireArrayElement,
  requireDefined,
  requireFunction,
  type UnknownFunction,
} from "../../../../lib/tests/test-narrowers.js";

interface RegisteredTool {
  readonly name: string;
  execute(
    toolCallId: string,
    parameters: Record<string, unknown>
  ): Promise<{ readonly content: ReadonlyArray<{ readonly text: string }> }>;
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
  return isRecord(value) && typeof value.name === "string" && typeof value.execute === "function";
}

describe("target-only observability extension", () => {
  const events = new Map<string, UnknownFunction[]>();
  const tools = new Map<string, RegisteredTool>();
  let priorAutoStart: string | undefined;

  beforeAll(() => {
    priorAutoStart = process.env.PI_OBSERVABILITY_AUTO_START;
    process.env.PI_OBSERVABILITY_AUTO_START = "false";
    const pi = createTestExtensionApi({
      onEvent(event, handler) {
        const registeredHandler = requireFunction(handler, `invalid ${event} handler`);
        events.set(event, [...(events.get(event) ?? []), registeredHandler]);
      },
      onRegisterTool(tool) {
        if (!isRegisteredTool(tool)) throw new Error("observability registered an invalid tool");
        tools.set(tool.name, tool);
      },
    });
    observabilityExtension(pi);
  });

  afterAll(() => {
    if (priorAutoStart === undefined) delete process.env.PI_OBSERVABILITY_AUTO_START;
    else process.env.PI_OBSERVABILITY_AUTO_START = priorAutoStart;
  });

  it("records lifecycle metadata but never registers transcript-ingest handlers", () => {
    expect([...events.keys()]).toEqual([
      "session_start",
      "agent_start",
      "agent_end",
      "session_compact",
    ]);
    expect(events.has("message_end")).toBe(false);
    expect(events.has("tool_execution_start")).toBe(false);
    expect(events.has("tool_result")).toBe(false);
  });

  it("registers structured-log and direct-history tools", () => {
    expect([...tools.keys()]).toEqual(["observability_query_logs", "observability_query_history"]);
  });

  it("reads full Pi JSONL entries while the observability service is unavailable", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-observability-history-"));
    const cwd = path.join(root, "project");
    const sessionDirectory = path.join(root, "sessions");
    mkdirSync(cwd, { mode: 0o700 });
    mkdirSync(sessionDirectory, { mode: 0o700 });
    const manager = SessionManager.create(cwd, sessionDirectory);
    manager.appendMessage({ role: "user", content: "offline history", timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "available without the service" }],
      api: "anthropic-messages",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(existsSync(manager.getSessionFile() ?? "")).toBe(true));
    const infos = await SessionManager.list(cwd, sessionDirectory);
    expect(infos).toHaveLength(1);
    vi.spyOn(SessionManager, "listAll").mockResolvedValue(infos);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("service down"));

    const sessionStart = requireFunction(
      events.get("session_start")?.[0],
      "session_start handler was not registered"
    );
    await sessionStart(
      {},
      {
        cwd,
        sessionManager: {
          getSessionId: () => manager.getSessionId(),
          getEntries: () => manager.getEntries(),
        },
      }
    );
    const tool = requireDefined(
      tools.get("observability_query_history"),
      "observability history tool was not registered"
    );
    const result = await tool.execute("call", { session_id: manager.getSessionId() });
    const content = requireArrayElement(result.content, 0, "history tool returned no content");
    expect(content.text).toContain("offline history");
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
});
