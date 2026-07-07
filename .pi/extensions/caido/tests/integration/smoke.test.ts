/** Integration + E2E tests for Caido extension.
 *  Real-SDK tests are skipped unless CAIDO_PAT is configured.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import caidoExtension from "../../index.js";
import { resetClient } from "../../client.js";

const hasCaidoCreds = () => !!(process.env.CAIDO_PAT && process.env.CAIDO_URL);
const describeIf = hasCaidoCreds() ? describe : describe.skip;

// ── E2E: Extension factory ──
describe("Caido Extension E2E", () => {
  it("factory loads without CAIDO_PAT", async () => {
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const on = vi.fn();
    const pi = { registerTool, registerCommand, on } as any;

    const originalPat = process.env.CAIDO_PAT;
    delete process.env.CAIDO_PAT;
    await caidoExtension(pi);
    if (originalPat !== undefined) process.env.CAIDO_PAT = originalPat;

    expect(registerTool).toHaveBeenCalled();
    expect(registerCommand).toHaveBeenCalledWith("caido-status", expect.any(Object));
  });

  it("registers all 16 tools", async () => {
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const on = vi.fn();
    const pi = { registerTool, registerCommand, on } as any;
    await caidoExtension(pi);

    const toolNames = registerTool.mock.calls.map((c: any) => c[0].name).sort();
    expect(toolNames).toEqual(
      [
        "caido_collections",
        "caido_edit",
        "caido_files",
        "caido_filters",
        "caido_findings",
        "caido_fuzz",
        "caido_info",
        "caido_intercept",
        "caido_projects",
        "caido_request",
        "caido_scopes",
        "caido_search",
        "caido_send",
        "caido_sessions",
        "caido_tasks",
        "caido_environments",
      ].sort()
    );
  });

  it("caido-status command handler fires without CAIDO_PAT", async () => {
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const on = vi.fn();
    const notify = vi.fn();
    const pi = { registerTool, registerCommand, on } as any;

    const originalPat = process.env.CAIDO_PAT;
    delete process.env.CAIDO_PAT;
    await caidoExtension(pi);
    if (originalPat !== undefined) process.env.CAIDO_PAT = originalPat;

    const statusCmd = registerCommand.mock.calls.find((c: any) => c[0] === "caido-status")?.[1];
    expect(statusCmd).toBeDefined();
    await statusCmd.handler("", { ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Missing credentials"), "warn");
  });
});

// ── Singleton invariant ──
describe("Caido Client Singleton", () => {
  beforeEach(() => {
    resetClient();
  });

  it("resetClient resets internal state", () => {
    // This is tested in unit tests; here we verify the export works
    expect(() => resetClient()).not.toThrow();
  });
});

// ── Semaphore safety ──
describe("Semaphore safety", () => {
  it("semaphore is released after withCaidoClient error", async () => {
    const { withCaidoClient } = await import("../../client.js");
    let released = false;
    const result = await withCaidoClient(
      "test",
      { url: "http://localhost:8080", pat: "x" },
      {
        acquireSemaphore: async () => {},
        releaseSemaphore: () => {
          released = true;
        },
        logger: { error: () => {} },
      },
      async () => {
        throw new Error("fail");
      }
    );
    expect(result.isError).toBe(true);
    expect(released).toBe(true);
  });
});

// ── Real SDK integration (skipped without creds) ──
describeIf("Caido SDK Integration", () => {
  it("health endpoint returns valid structure", async () => {
    const { getClient, loadConfig } = await import("../../client.js");
    resetClient();
    const client = await getClient();
    const health = await client.health();
    expect(health).toBeDefined();
    expect(typeof health.ready).toBe("boolean");
  }, 15000);
});
