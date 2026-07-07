import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies so index.ts can load in the test environment
vi.mock("@mariozechner/pi-ai", () => ({
  StringEnum: (values: readonly string[], _opts?: any) => ({
    anyOf: values.map((v: string) => ({ type: "string", const: v })),
  }),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getMarkdownTheme: () => ({}),
  parseFrontmatter: <T extends Record<string, string>>(content: string) => {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { frontmatter: {} as T, body: content };
    const fm: Record<string, string> = {};
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) fm[m[1]] = m[2].trim();
    }
    return { frontmatter: fm as T, body: content.replace(/^---\n[\s\S]*?\n---\n?/, "") };
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

// Capture the tool definition when registerTool is called
let registeredTool: Record<string, unknown> | undefined;

function createMockPi(): any {
  registeredTool = undefined;
  return {
    registerTool: (def: Record<string, unknown>) => {
      registeredTool = def;
    },
  };
}

describe("subagent tool registration", () => {
  beforeEach(() => {
    vi.resetModules();
    registeredTool = undefined;
  });

  it("registers with promptSnippet containing discovered agent names", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    expect(registeredTool).toBeDefined();
    const snippet = registeredTool!.promptSnippet as string;
    expect(snippet).toContain("echo");
    expect(snippet).toContain("skribble");
    expect(snippet).toContain("piper");
    expect(snippet).toContain("carren");
    expect(snippet).toContain("vera");
    expect(snippet).toContain("synthia");
    expect(snippet).toContain("tabitha");
    expect(snippet).toContain("skribble");
  });

  it("registers with promptGuidelines containing routing and anti-pattern guidance", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    expect(registeredTool).toBeDefined();
    const guidelines = registeredTool!.promptGuidelines as string[];
    expect(guidelines.length).toBeGreaterThanOrEqual(5);
    expect(guidelines.some((g) => g.toLowerCase().includes("anti-pattern"))).toBe(true);
    expect(guidelines.some((g) => g.toLowerCase().includes("skill tool"))).toBe(true);
  });

  it("agent parameter schema references discovered agent names", async () => {
    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    expect(registeredTool).toBeDefined();
    const params = registeredTool!.parameters as any;
    const agentProp = params?.properties?.agent;
    expect(agentProp).toBeDefined();

    // StringEnum produces an anyOf array of const schemas in our mock.
    // Verify the real agent names appear in the schema.
    const schemaText = JSON.stringify(agentProp);
    expect(schemaText).toContain("echo");
    expect(schemaText).toContain("skribble");
    expect(schemaText).toContain("piper");
  });
});

describe("subagent tool registration with empty agent discovery", () => {
  beforeEach(() => {
    vi.resetModules();
    registeredTool = undefined;
  });

  it("falls back to safe enum when no agents are discovered", async () => {
    // Mock agent-runner to return empty agents
    vi.doMock("../../agent-runner.js", async () => {
      const actual =
        await vi.importActual<typeof import("../../agent-runner.js")>("../../agent-runner.js");
      return {
        ...actual,
        discoverAgents: vi.fn(() => ({ agents: [], projectAgentsDir: null })),
      };
    });

    const mod = await import("../../index.js");
    const pi = createMockPi();
    mod.default(pi);

    expect(registeredTool).toBeDefined();
    const snippet = registeredTool!.promptSnippet as string;
    expect(snippet).toContain("no agents discovered");

    const params = registeredTool!.parameters as any;
    const agentProp = params?.properties?.agent;
    const schemaText = JSON.stringify(agentProp);
    expect(schemaText).toContain("no-agents-found");

    vi.doUnmock("../../agent-runner.js");
  });
});
