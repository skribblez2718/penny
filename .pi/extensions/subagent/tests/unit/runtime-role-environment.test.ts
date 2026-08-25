import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, operation: () => unknown) => operation()),
}));

import { isolatedAgentEnvironment } from "../../agent-runner.js";

describe("worker environment", () => {
  it("strips owner secrets and memory-write configuration", () => {
    const environment = isolatedAgentEnvironment({
      PENNY_RECEIPT_HMAC_KEY: "receipt",
      PENNY_APPROVAL_HMAC_KEY: "approval",
      PENNY_MEMORY_WRITE_MODE: "enabled",
      PENNY_MEMORY_LOGSTREAM_MODE: "primary-advisory",
      PENNY_MEMORY_MCP_ENDPOINT: "http://memory.invalid",
    });
    expect(environment.PENNY_RUNTIME_ROLE).toBe("worker");
    expect(environment.PENNY_RECEIPT_HMAC_KEY).toBeUndefined();
    expect(environment.PENNY_APPROVAL_HMAC_KEY).toBeUndefined();
    expect(environment.PENNY_MEMORY_WRITE_MODE).toBeUndefined();
    expect(environment.PENNY_MEMORY_LOGSTREAM_MODE).toBeUndefined();
  });

  it("uses worker-read posture when YAML declares memory tools", () => {
    const environment = isolatedAgentEnvironment(
      {
        PENNY_MEMORY_MCP_ENDPOINT: "http://memory.invalid",
        PENNY_MEMORY_MCP_TOKEN_FILE: "/tmp/token",
        PENNY_MEMORY_PALACE_ID: "palace",
        PENNY_MEMORY_WRITE_MODE: "enabled",
      },
      { memoryReadAccess: true }
    );
    expect(environment.PENNY_RUNTIME_ROLE).toBe("worker-read");
    expect(environment.PENNY_MEMORY_MCP_ENDPOINT).toBe("http://memory.invalid");
    expect(environment.PENNY_MEMORY_MCP_TOKEN_FILE).toBe("/tmp/token");
    expect(environment.PENNY_MEMORY_WRITE_MODE).toBeUndefined();
  });
});
