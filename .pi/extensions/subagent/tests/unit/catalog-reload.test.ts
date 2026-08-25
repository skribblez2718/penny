/**
 * Catalog reload and drift regression tests.
 *
 * A temporary .pi/agents catalog stands in for Pi's project resources. Module
 * cache reset + re-registration models /reload without involving memory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTestExtensionApi,
  createTestToolInfos,
  isRecord,
} from "../../../../lib/tests/test-narrowers.js";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[], options?: Record<string, unknown>) => ({
    anyOf: values.map((value) => ({ type: "string", const: value })),
    ...options,
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getMarkdownTheme: () => ({}),
  withFileMutationQueue: vi.fn((_path: string, fn: () => unknown) => fn()),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class ContainerMock {
    addChild() {}
  },
  Markdown: class MarkdownMock {},
  Spacer: class SpacerMock {},
  Text: class TextMock {
    constructor(_text: string, _x: number, _y: number) {}
  },
}));

interface CatalogToolResult {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
  details: {
    error: {
      code: string;
      kind: string;
      retryable: boolean;
      registeredCatalogDigest: string;
      executionCatalogDigest: string;
    };
    results: unknown[];
  };
}

type RegisteredTool = {
  description: string;
  promptSnippet: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<CatalogToolResult>;
};

let projectRoot: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

function writeAgent(name: string, description: string): void {
  fs.writeFileSync(
    path.join(projectRoot, ".pi", "agents", `${name}.md`),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "tools: read,grep",
      "model: fixture-model",
      "---",
      `# ${name}`,
      "Fixture agent prompt.",
    ].join("\n")
  );
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
  return (
    isRecord(value) &&
    typeof value.description === "string" &&
    typeof value.promptSnippet === "string" &&
    value.parameters !== undefined &&
    typeof value.execute === "function"
  );
}

async function reloadAndRegister(): Promise<RegisteredTool> {
  vi.resetModules();
  let registered: RegisteredTool | undefined;
  const extension = await import("../../index.js");
  extension.default(
    createTestExtensionApi({
      getAllTools: () => createTestToolInfos(["read", "grep"]),
      onRegisterTool(tool) {
        if (!isRegisteredTool(tool)) throw new Error("subagent registered an invalid tool");
        registered = tool;
      },
    })
  );
  if (!registered) throw new Error("subagent tool was not registered");
  return registered;
}

function schemaText(tool: RegisteredTool): string {
  return JSON.stringify(tool.parameters);
}

beforeEach(() => {
  mockSpawn.mockReset();
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penny-agent-catalog-"));
  fs.mkdirSync(path.join(projectRoot, ".pi", "agents"), { recursive: true });
  writeAgent("alpha", "Initial alpha specialty");
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
});

afterEach(() => {
  cwdSpy.mockRestore();
  fs.rmSync(projectRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe("catalog reload and re-registration", () => {
  it("refreshes the enum, provider description, and snippet from a mutated catalog", async () => {
    const before = await reloadAndRegister();

    expect(schemaText(before)).toContain("alpha");
    expect(schemaText(before)).not.toContain("beta");
    expect(before.description).toContain("alpha: Initial alpha specialty");
    expect(before.promptSnippet).toContain("alpha");

    writeAgent("alpha", "Reloaded alpha specialty");
    writeAgent("beta", "New beta specialty");

    const after = await reloadAndRegister();

    expect(schemaText(after)).toContain("alpha");
    expect(schemaText(after)).toContain("beta");
    expect(after.description).toContain("alpha: Reloaded alpha specialty");
    expect(after.description).toContain("beta: New beta specialty");
    expect(after.description).not.toContain("Initial alpha specialty");
    expect(after.promptSnippet).toContain("alpha");
    expect(after.promptSnippet).toContain("beta");
  });

  it("returns a typed reload-required catalog-drift error before executing a newly added schema-rejected agent", async () => {
    const registered = await reloadAndRegister();
    expect(schemaText(registered)).not.toContain("beta");

    writeAgent("beta", "Added after registration");

    const result = await registered.execute(
      "tool-call-1",
      { agent: "beta", task: "Must not execute before reload" },
      undefined,
      undefined,
      {
        cwd: projectRoot,
        hasUI: false,
        ui: { confirm: vi.fn() },
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Run /reload");
    expect(result.details.error).toMatchObject({
      code: "SUBAGENT_RELOAD_REQUIRED",
      kind: "catalog_drift",
      retryable: true,
    });
    expect(result.details.error.registeredCatalogDigest).not.toBe(
      result.details.error.executionCatalogDigest
    );
    expect(result.details.results).toEqual([]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
