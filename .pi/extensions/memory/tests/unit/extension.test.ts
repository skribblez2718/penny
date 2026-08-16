import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createMemoryExtension } from "../../index.js";
import { extensionEnv } from "../fixtures.js";

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("production adapter source guard", () => {
  it("contains no Python process, raw storage, or legacy fallback path", () => {
    const production = readdirSync(extensionRoot)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(extensionRoot, name), "utf8"))
      .join("\n");
    expect(production).not.toMatch(/child_process|\bspawn\s*\(|memory_bridge\.py/i);
    expect(production).not.toMatch(/PersistentClient|\bchromadb\b|smart_retriever\.py/i);
    expect(production).not.toMatch(/legacy\s*\|\s*shadow|direct\/prefer fallback/i);
  });

  it("fails closed without hub configuration instead of blocking Pi startup", () => {
    const registerTool = vi.fn();
    const on = vi.fn();
    expect(() =>
      createMemoryExtension({ env: {}, fetch: vi.fn() as typeof fetch })({
        registerTool,
        registerCommand: vi.fn(),
        on,
      } as any)
    ).not.toThrow();
    expect(registerTool).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });

  it("does not register unconditional startup search/taxonomy or universal diary guidelines", () => {
    const tools: any[] = [];
    const handlers: string[] = [];
    createMemoryExtension({ env: extensionEnv(), fetch: vi.fn() as typeof fetch })({
      registerTool(tool: unknown) {
        tools.push(tool);
      },
      registerCommand: vi.fn(),
      on(event: string) {
        handlers.push(event);
      },
    } as any);

    expect(handlers).toEqual(["session_start", "session_shutdown"]);
    for (const tool of tools) {
      expect(tool.promptGuidelines).toBeUndefined();
      expect(tool.promptSnippet).toBeUndefined();
      expect(String(tool.description)).not.toMatch(/always search|at start of every session/i);
    }
  });
});
