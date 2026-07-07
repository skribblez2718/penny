/**
 * Memory Extension Integration Tests
 *
 * Tests the full stack including Python bridge:
 * - Actual tool execution against live MemPalace
 * - Error handling from Python layer
 * - End-to-end data flow
 *
 * Run with: vitest run tests/test-integration.test.ts
 *
 * Prerequisites:
 * - MemPalace initialized (.mempalace directory exists)
 * - Python venv with mempalace installed
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";

const CONFIG = {
  venvPython:
    process.env.PI_VENV_PYTHON || `${process.env.PROJECT_ROOT || process.cwd()}/.venv/bin/python`,
  bridgePath:
    process.env.PI_MEMORY_BRIDGE ||
    `${process.env.PROJECT_ROOT || process.cwd()}/scripts/system/bridge/memory_bridge.py`,
};

// Test data cleanup tracking
const testDrawerIds: string[] = [];
const testKgTriples: Array<{ subject: string; predicate: string; object: string }> = [];

/**
 * Call the Python bridge directly
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
        reject(new Error(`Bridge exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Failed to parse bridge output: ${stdout}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
    proc.stdin.write(request);
    proc.stdin.end();
  });
}

describe("Palace Read Tools (Integration)", () => {
  describe("memory_status", () => {
    it("should return palace overview", async () => {
      const result = await callBridge("status");

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("total_drawers");
      expect(result).toHaveProperty("wings");
      expect(result).toHaveProperty("rooms");
      expect(result).toHaveProperty("palace_path");
    });

    it("should return wings as object with counts", async () => {
      const result = await callBridge("status");
      const wings = result.wings as Record<string, number>;

      expect(typeof wings).toBe("object");
      // All wing values should be numbers
      Object.values(wings).forEach((count) => {
        expect(typeof count).toBe("number");
        expect(count).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe("memory_list_wings", () => {
    it("should list all wings with drawer counts", async () => {
      const result = await callBridge("list_wings");

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("wings");
    });
  });

  describe("memory_list_rooms", () => {
    it("should list all rooms when no wing specified", async () => {
      const result = await callBridge("list_rooms", {});

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("rooms");
    });

    it("should list rooms for specific wing", async () => {
      // First get a wing that exists
      const status = await callBridge("status");
      const wings = Object.keys(status.wings as Record<string, number>);

      if (wings.length > 0) {
        const result = await callBridge("list_rooms", { wing: wings[0] });
        expect(result.success).toBe(true);
      }
    });
  });

  describe("memory_get_taxonomy", () => {
    it("should return complete hierarchy", async () => {
      const result = await callBridge("get_taxonomy");

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("taxonomy");
    });
  });

  describe("memory_search", () => {
    it("should search and return results with similarity", async () => {
      const result = await callBridge("search", { query: "test", limit: 5 });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("results");
    });

    it("should respect limit parameter", async () => {
      const result = await callBridge("search", { query: "memory", limit: 2 });
      const results = result.results as { results: unknown[] };

      if (results && results.results) {
        expect((results.results as unknown[]).length).toBeLessThanOrEqual(2);
      }
    });

    it("should filter by wing when specified", async () => {
      const result = await callBridge("search", {
        query: "test",
        wing: "wing_penny",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("memory_check_duplicate", () => {
    it("should check for duplicates", async () => {
      const result = await callBridge("check_duplicate", {
        content: "unique test content that doesn't exist",
      });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("is_duplicate");
    });

    it("should respect threshold parameter", async () => {
      const result = await callBridge("check_duplicate", {
        content: "test",
        threshold: 0.95,
      });

      expect(result.success).toBe(true);
    });
  });

  describe("memory_get_aaak_spec", () => {
    it("should return AAAK format specification", async () => {
      const result = await callBridge("get_aaak_spec");

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("aaak_spec");
    });
  });
});

describe("Palace Write Tools (Integration)", () => {
  const testContent = `Test drawer ${Date.now()} - integration test`;

  afterAll(async () => {
    // Cleanup: delete test drawers
    for (const drawerId of testDrawerIds) {
      try {
        await callBridge("delete_drawer", { drawer_id: drawerId });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe("memory_add_drawer", () => {
    it("should add content to palace", async () => {
      const result = await callBridge("add_drawer", {
        wing: "wing_penny",
        room: "test",
        content: testContent,
        added_by: "integration-test",
      });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("drawer_id");

      // Track for cleanup
      if (result.drawer_id) {
        testDrawerIds.push(result.drawer_id as string);
      }
    });

    it("should include source_file when provided", async () => {
      const result = await callBridge("add_drawer", {
        wing: "wing_penny",
        room: "test",
        content: `${testContent} with source`,
        source_file: "test-file.ts",
        added_by: "integration-test",
      });

      expect(result.success).toBe(true);

      if (result.drawer_id) {
        testDrawerIds.push(result.drawer_id as string);
      }
    });
  });

  describe("memory_delete_drawer", () => {
    it("should delete existing drawer", async () => {
      // First add a drawer
      const addResult = await callBridge("add_drawer", {
        wing: "wing_penny",
        room: "test",
        content: "Drawer to be deleted",
        added_by: "integration-test",
      });

      expect(addResult.success).toBe(true);
      const drawerId = addResult.drawer_id as string;

      // Then delete it
      const deleteResult = await callBridge("delete_drawer", {
        drawer_id: drawerId,
      });

      expect(deleteResult.success).toBe(true);
    });

    it("should handle non-existent drawer", async () => {
      const result = await callBridge("delete_drawer", {
        drawer_id: "non-existent-id-12345",
      });

      // Should return success=false or error for non-existent
      expect(result).toHaveProperty("error");
    });
  });
});

describe("Knowledge Graph Tools (Integration)", () => {
  const testSubject = `TestEntity_${Date.now()}`;

  afterAll(async () => {
    // Cleanup: invalidate test facts
    for (const triple of testKgTriples) {
      try {
        await callBridge("kg_invalidate", {
          subject: triple.subject,
          predicate: triple.predicate,
          object: triple.object,
        });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe("memory_kg_add", () => {
    it("should add fact to knowledge graph", async () => {
      const result = await callBridge("kg_add", {
        subject: testSubject,
        predicate: "uses",
        object: "TestTool",
        valid_from: "2026-04-08",
      });

      expect(result.success).toBe(true);

      testKgTriples.push({ subject: testSubject, predicate: "uses", object: "TestTool" });
    });

    it("should include valid_from date", async () => {
      const result = await callBridge("kg_add", {
        subject: `${testSubject}_v2`,
        predicate: "works_on",
        object: "TestProject",
        valid_from: "2026-04-08",
      });

      expect(result.success).toBe(true);

      testKgTriples.push({
        subject: `${testSubject}_v2`,
        predicate: "works_on",
        object: "TestProject",
      });
    });
  });

  describe("memory_kg_query", () => {
    it("should query entity relationships", async () => {
      // First add a fact
      await callBridge("kg_add", {
        subject: testSubject,
        predicate: "uses",
        object: "TestTool",
      });

      // Then query it
      const result = await callBridge("kg_query", {
        entity: testSubject,
      });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("facts");
    });

    it("should support direction parameter", async () => {
      const result = await callBridge("kg_query", {
        entity: testSubject,
        direction: "outgoing",
      });

      expect(result.success).toBe(true);
    });

    it("should support as_of date filter", async () => {
      const result = await callBridge("kg_query", {
        entity: testSubject,
        as_of: "2026-04-08",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("memory_kg_invalidate", () => {
    it("should mark fact as ended", async () => {
      // Add a fact
      await callBridge("kg_add", {
        subject: `${testSubject}_temp`,
        predicate: "uses",
        object: "TempTool",
      });

      // Invalidate it
      const result = await callBridge("kg_invalidate", {
        subject: `${testSubject}_temp`,
        predicate: "uses",
        object: "TempTool",
        ended: "2026-04-08",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("memory_kg_timeline", () => {
    it("should return chronological timeline", async () => {
      const result = await callBridge("kg_timeline", {
        entity: testSubject,
      });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("timeline");
    });

    it("should return all entities timeline when no entity specified", async () => {
      const result = await callBridge("kg_timeline", {});

      expect(result.success).toBe(true);
    });
  });

  describe("memory_kg_stats", () => {
    it("should return knowledge graph statistics", async () => {
      const result = await callBridge("kg_stats");

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("stats");
      const stats = result.stats as Record<string, unknown>;
      expect(stats).toHaveProperty("entities");
      expect(stats).toHaveProperty("triples");
    });
  });
});

describe("Navigation Tools (Integration)", () => {
  describe("memory_traverse", () => {
    it("should traverse from a room", async () => {
      // Get a room that exists
      const status = await callBridge("status");
      const rooms = Object.keys(status.rooms as Record<string, number>);

      if (rooms.length > 0) {
        const result = await callBridge("traverse", {
          start_room: rooms[0],
          max_hops: 2,
        });

        expect(result.success).toBe(true);
      }
    });
  });

  describe("memory_find_tunnels", () => {
    it("should find tunnels between wings", async () => {
      const result = await callBridge("find_tunnels", {});

      expect(result.success).toBe(true);
    });
  });

  describe("memory_graph_stats", () => {
    it("should return palace graph statistics", async () => {
      const result = await callBridge("graph_stats");

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("stats");
      const stats = result.stats as Record<string, unknown>;
      expect(stats).toHaveProperty("total_rooms");
      expect(stats).toHaveProperty("tunnel_rooms");
    });
  });
});

describe("Agent Diary Tools (Integration)", () => {
  const testAgent = `test-agent-${Date.now()}`;

  afterAll(async () => {
    // Note: Diary entries can't be deleted in current implementation
    // They will remain as test entries
  });

  describe("memory_diary_write", () => {
    it("should write diary entry", async () => {
      const result = await callBridge("diary_write", {
        agent_name: testAgent,
        entry: `SESSION:2026-04-08|integration.test|test.entry|★★★`,
        topic: "test",
      });

      expect(result.success).toBe(true);
    });

    it("should default topic to general", async () => {
      const result = await callBridge("diary_write", {
        agent_name: testAgent,
        entry: "SESSION:2026-04-08|test|testing|★★",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("memory_diary_read", () => {
    it("should read recent diary entries", async () => {
      // First write an entry
      await callBridge("diary_write", {
        agent_name: testAgent,
        entry: "SESSION:2026-04-08|test.read|read.test|★★",
      });

      // Then read it
      const result = await callBridge("diary_read", {
        agent_name: testAgent,
        last_n: 5,
      });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty("entries");
    });

    it("should respect last_n parameter", async () => {
      const result = await callBridge("diary_read", {
        agent_name: testAgent,
        last_n: 1,
      });

      expect(result.success).toBe(true);
      const entries = result.entries as unknown[];
      expect(entries.length).toBeLessThanOrEqual(1);
    });
  });
});

describe("Bulk Tools (Integration)", () => {
  describe("memory_list_drawers", () => {
    it("should list drawers with wing and room filter", async () => {
      const result = await callBridge("list_drawers", { wing: "penny", room: "decisions" });
      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("count");
      expect(result).toHaveProperty("drawers");
    });

    it("should return empty for nonexistent room", async () => {
      const result = await callBridge("list_drawers", {
        wing: "penny",
        room: "nonexistent_ts_test",
      });
      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("count", 0);
    });

    it("should list drawers with wing only", async () => {
      const result = await callBridge("list_drawers", { wing: "penny" });
      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("count");
    });
  });

  describe("memory_delete_drawers_by_room", () => {
    it("should require both wing and room", async () => {
      const result = await callBridge("delete_drawers_by_room", { wing: "penny" });
      expect(result).toHaveProperty("error");

      const result2 = await callBridge("delete_drawers_by_room", { room: "decisions" });
      expect(result2).toHaveProperty("error");
    });

    it("should return 0 deleted for nonexistent room", async () => {
      const result = await callBridge("delete_drawers_by_room", {
        wing: "penny",
        room: "nonexistent_ts_test",
      });
      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("deleted_count", 0);
    });

    it("should bulk delete drawers in a room", async () => {
      // Create test drawers
      const testRoom = "test_ts_bulk_delete";
      const addResult = await callBridge("add_drawer", {
        wing: "penny",
        room: testRoom,
        content: `TS bulk delete test ${Date.now()} unique`,
        added_by: "vitest",
      });
      if (addResult.success) testDrawerIds.push(addResult.drawer_id as string);

      // Verify drawer exists
      const listResult = await callBridge("list_drawers", { wing: "penny", room: testRoom });
      expect(listResult.count).toBeGreaterThanOrEqual(1);

      // Delete
      const deleteResult = await callBridge("delete_drawers_by_room", {
        wing: "penny",
        room: testRoom,
      });
      expect(deleteResult).toHaveProperty("success", true);
      expect(deleteResult).toHaveProperty("deleted_count");
      expect(deleteResult.deleted_count as number).toBeGreaterThanOrEqual(1);

      // Verify room is empty
      const listAfter = await callBridge("list_drawers", { wing: "penny", room: testRoom });
      expect(listAfter).toHaveProperty("count", 0);
    });
  });
});

describe("Error Handling (Integration)", () => {
  it("should handle invalid tool name", async () => {
    const result = await callBridge("nonexistent_tool", {});
    expect(result).toHaveProperty("error");
  });

  it("should handle missing required parameters", async () => {
    const result = await callBridge("search", {});
    expect(result).toHaveProperty("error");
  });

  it("should handle invalid parameter types", async () => {
    const result = await callBridge("search", {
      limit: "not-a-number",
    });
    expect(result).toHaveProperty("error");
  });
});
