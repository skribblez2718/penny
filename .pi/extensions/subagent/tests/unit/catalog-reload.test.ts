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

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

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
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { frontmatter: {} as T, body: content };
    const frontmatter: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const field = line.match(/^(\w+):\s*(.+)$/);
      if (field) frontmatter[field[1]] = field[2].trim();
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

type RegisteredTool = {
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: unknown;
  execute: (...args: any[]) => Promise<any>;
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

async function reloadAndRegister(): Promise<RegisteredTool> {
  vi.resetModules();
  let registered: RegisteredTool | undefined;
  const extension = await import("../../index.js");
  extension.default({
    registerTool: (tool: RegisteredTool) => {
      registered = tool;
    },
  } as never);
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
  it("refreshes enum, provider description, snippet, and guidelines from a mutated catalog", async () => {
    const before = await reloadAndRegister();

    expect(schemaText(before)).toContain("alpha");
    expect(schemaText(before)).not.toContain("beta");
    expect(before.description).toContain("alpha: Initial alpha specialty");
    expect(before.promptSnippet).toContain("alpha");
    expect(before.promptGuidelines.join("\n")).toContain("alpha: Initial alpha specialty");

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
    expect(after.promptGuidelines.join("\n")).toContain("alpha: Reloaded alpha specialty");
    expect(after.promptGuidelines.join("\n")).toContain("beta: New beta specialty");
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
