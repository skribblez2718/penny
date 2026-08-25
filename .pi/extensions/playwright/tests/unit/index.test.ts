import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import playwrightExtension from "../../index.js";
import {
  createTestExtensionApi,
  isRecord,
  requireFunction,
} from "../../../../lib/tests/test-narrowers.js";
import { BrowserManager } from "../../browser.js";

type SessionStartHandler = (
  event: unknown,
  context: { cwd: string; sessionManager?: { getSessionId?: () => string } }
) => Promise<void>;

class FakePi {
  readonly registeredTools: string[] = [];
  readonly handlers = new Map<string, SessionStartHandler>();
  activeTools: string[] = [];

  registerTool(definition: { name: string }): void {
    this.registeredTools.push(definition.name);
  }

  on(event: string, handler: SessionStartHandler): void {
    this.handlers.set(event, handler);
  }

  getActiveTools(): string[] {
    return this.activeTools;
  }

  setActiveTools(names: string[]): void {
    this.activeTools = names;
  }
}

function extensionApi(fake: FakePi) {
  return createTestExtensionApi({
    onRegisterTool(tool) {
      if (!isRecord(tool) || typeof tool.name !== "string") {
        throw new Error("Playwright registered an invalid tool fixture");
      }
      fake.registerTool({ name: tool.name });
    },
    onEvent(event, handler) {
      const registered = requireFunction(
        handler,
        `Playwright registered an invalid ${event} handler`
      );
      fake.on(event, async (eventValue, context) => {
        await registered(eventValue, context);
      });
    },
    getActiveTools: () => fake.getActiveTools(),
    onSetActiveTools: (names) => fake.setActiveTools(names),
  });
}

const CONFIG_ENVIRONMENT_NAMES = ["PLAYWRIGHT_ENABLE_NETWORK", "PENNY_RUNTIME_ROLE"] as const;

const originalEnvironment = new Map(
  CONFIG_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]])
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const name of CONFIG_ENVIRONMENT_NAMES) {
    const original = originalEnvironment.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  BrowserManager.reset();
});

describe("Playwright extension session startup", () => {
  it("reloads the session config without mutating a frozen config snapshot", async () => {
    delete process.env.PLAYWRIGHT_ENABLE_NETWORK;
    delete process.env.PENNY_RUNTIME_ROLE;
    const sessionRoot = mkdtempSync(path.join(tmpdir(), "penny-playwright-session-"));
    temporaryRoots.push(sessionRoot);
    writeFileSync(path.join(sessionRoot, ".env"), "PLAYWRIGHT_ENABLE_NETWORK=1\n");

    const pi = new FakePi();
    playwrightExtension(extensionApi(pi));
    pi.activeTools = [...pi.registeredTools];

    const sessionStart = pi.handlers.get("session_start");
    if (sessionStart === undefined) throw new Error("session_start handler was not registered");

    await expect(sessionStart({}, { cwd: sessionRoot })).resolves.toBeUndefined();
    expect(pi.activeTools).toContain("playwright_route");
    expect(pi.activeTools).not.toContain("playwright_click");
  });
});
