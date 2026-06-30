/**
 * Signal Lifecycle Integration Tests
 *
 * Tests the full signal lifecycle through the Python bridge:
 *   add_drawer (signal payload) → smart_search (retrieve pending)
 *   → check_duplicate (prevent rewrite) → add_drawer (acknowledged update)
 *
 * Run with: vitest run tests/integration/test_signal_lifecycle.ts
 *
 * Prerequisites:
 *   - MemPalace initialized
 *   - Python venv with mempalace installed
 *   - memory_bridge.py available
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";

const CONFIG = {
  venvPython: process.env.PI_VENV_PYTHON || `${process.env.PROJECT_ROOT || process.cwd()}/.venv/bin/python`,
  bridgePath:
    process.env.PI_MEMORY_BRIDGE ||
    `${process.env.PROJECT_ROOT || process.cwd()}/scripts/system/bridge/memory_bridge.py`,
};

const TEST_WING = "penny";
const TEST_ROOM = "signals";
const TEST_SIGNAL_ID = `signal_int_test_${Date.now()}`;

let createdDrawerId = "";

/**
 * Call the Python bridge directly — same pattern used by the TS extension.
 */
async function callBridge(
  tool: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({ tool, params });
    const proc = spawn(CONFIG.venvPython, [CONFIG.bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Bridge exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Parse failure: ${stdout}`));
      }
    });

    proc.stdin.write(request + "\n");
    proc.stdin.end();
  });
}

describe("Signal Lifecycle", () => {
  beforeAll(async () => {
    // Verify bridge is reachable
    const status = await callBridge("status", {});
    expect(status.success).toBe(true);
  });

  afterAll(async () => {
    // Cleanup: delete test drawer if created
    if (createdDrawerId) {
      try {
        await callBridge("delete_drawer", { drawer_id: createdDrawerId });
      } catch {
        // Best-effort cleanup
      }
    }
  });

  it("should write a signal to penny/signals via add_drawer", async () => {
    const signalPayload = {
      signal_id: TEST_SIGNAL_ID,
      signal_type: "METRIC",
      source: "signal_lifecycle_test",
      priority: "INFO",
      title: "Integration test signal",
      context: "Created by TS integration test",
      timestamp: new Date().toISOString(),
      expires: new Date(Date.now() + 7 * 86400000).toISOString(),
      status: "PENDING",
    };

    const fullText = `signal_id: ${TEST_SIGNAL_ID}\n${JSON.stringify(signalPayload, null, 2)}`;

    const result = await callBridge("add_drawer", {
      wing: TEST_WING,
      room: TEST_ROOM,
      content: fullText,
    });

    expect(result.success).toBe(true);
    expect(result.drawer_id).toBeDefined();
    createdDrawerId = result.drawer_id as string;
  });

  it("should retrieve the signal via smart_search with signal_id query", async () => {
    const result = await callBridge("smart_search", {
      query: TEST_SIGNAL_ID,
      wing: TEST_WING,
      room: TEST_ROOM,
      limit: 5,
      include_full: true,
    });

    expect(result.success).toBe(true);
    const results = (result.results ?? []) as Array<{ text: string }>;
    expect(results.length).toBeGreaterThan(0);

    const found = results.some((r) => r.text.includes(TEST_SIGNAL_ID));
    expect(found).toBe(true);
  });

  it("should call check_duplicate successfully", async () => {
    // Verify check_duplicate tool returns a structured result.
    // Actual dedup behavior is covered by Python unit tests.
    const result = await callBridge("check_duplicate", {
      content: `signal_id: ${TEST_SIGNAL_ID}`,
      threshold: 0.8,
    });

    expect(result.success).toBe(true);
    expect(result).toHaveProperty("is_duplicate");
    expect(result).toHaveProperty("matches");
  });

  it("should update signal status via delete + rewrite", async () => {
    // Read existing
    const searchResult = await callBridge("smart_search", {
      query: TEST_SIGNAL_ID,
      wing: TEST_WING,
      room: TEST_ROOM,
      limit: 1,
      include_full: true,
    });

    const items = (searchResult.results ?? []) as Array<{ text: string }>;
    expect(items.length).toBeGreaterThan(0);

    // Build acknowledged version
    const originalText = items[0].text;
    const acknowledgedText = originalText.replace(
      '"status": "PENDING"',
      '"status": "ACKNOWLEDGED"'
    );

    // Delete original
    await callBridge("delete_drawer", { drawer_id: createdDrawerId });

    // Write updated
    const writeResult = await callBridge("add_drawer", {
      wing: TEST_WING,
      room: TEST_ROOM,
      content: acknowledgedText,
    });

    expect(writeResult.success).toBe(true);
    createdDrawerId = writeResult.drawer_id as string;

    // Verify status updated
    const verifyResult = await callBridge("smart_search", {
      query: TEST_SIGNAL_ID,
      wing: TEST_WING,
      room: TEST_ROOM,
      limit: 1,
      include_full: true,
    });

    const updated = (verifyResult.results ?? []) as Array<{ text: string }>;
    expect(updated[0].text).toContain('"status": "ACKNOWLEDGED"');
  });
});

export {};
