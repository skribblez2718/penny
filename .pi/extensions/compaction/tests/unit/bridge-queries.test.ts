import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  _internals,
  callBridge,
  queryMempalaceSkillRooms,
  queryMempalaceSkillRoomsForSession,
  queryKGEntitiesForScope,
} from "../../bridge.js";

// Substitute the bridge caller so no Python process is spawned. These tests
// exercise the REAL query functions (filtering, mapping, matching logic).
const mockCall = vi.fn();
const realCall = _internals.call;

beforeEach(() => {
  mockCall.mockReset();
  _internals.call = mockCall as unknown as typeof callBridge;
});

afterEach(() => {
  _internals.call = realCall;
});

// ============================================================
// Mempalace Skill Rooms (unscoped)
// ============================================================

describe("queryMempalaceSkillRooms", () => {
  it("returns skill rooms with drawer IDs", async () => {
    mockCall.mockImplementation(async (tool: string) => {
      if (tool === "list_rooms") {
        return {
          success: true,
          data: {
            rooms: [
              { name: "skills/plan-abc123" },
              { name: "general" },
              { name: "skills/research-xyz789" },
            ],
          },
        };
      }
      if (tool === "list_drawers") {
        return { success: true, data: { drawers: [{ id: "d1" }, { id: "d2" }] } };
      }
      return { success: false };
    });

    const rooms = await queryMempalaceSkillRooms();
    expect(rooms).toHaveLength(2);
    expect(rooms[0].room).toBe("skills/plan-abc123");
    expect(rooms[0].drawer_ids).toEqual(["d1", "d2"]);
    expect(rooms[1].room).toBe("skills/research-xyz789");
  });

  it("handles the dict-shaped list_rooms response", async () => {
    mockCall.mockImplementation(async (tool: string) => {
      if (tool === "list_rooms") {
        return { success: true, data: { "skills/code-1": 4, general: 2 } };
      }
      if (tool === "list_drawers") {
        return { success: true, data: { drawers: [{ id: "d9" }] } };
      }
      return { success: false };
    });

    const rooms = await queryMempalaceSkillRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0].room).toBe("skills/code-1");
  });

  it("returns empty array when list_rooms fails", async () => {
    mockCall.mockResolvedValue({ success: false, error: "no palace" });
    const rooms = await queryMempalaceSkillRooms();
    expect(rooms).toEqual([]);
  });
});

// ============================================================
// Session-Scoped Rooms
// ============================================================

describe("queryMempalaceSkillRoomsForSession", () => {
  const listRoomsResponse = {
    success: true,
    data: {
      rooms: [
        { name: "skills/code-1751700000000" },
        { name: "skills/plan-other", last_updated: new Date(Date.now() - 3000).toISOString() },
        { name: "skills/research-ancient", last_updated: "2020-01-01T00:00:00.000Z" },
      ],
    },
  };

  it("keeps rooms whose name contains a real session id, marked dominant", async () => {
    mockCall.mockImplementation(async (tool: string) => {
      if (tool === "list_rooms") return listRoomsResponse;
      if (tool === "list_drawers") {
        return { success: true, data: { drawers: [{ id: "d1" }] } };
      }
      return { success: false };
    });

    const rooms = await queryMempalaceSkillRoomsForSession(["code-1751700000000"], 1);
    const names = rooms.map((r: any) => r.room);
    expect(names).toContain("skills/code-1751700000000");
    expect(names).not.toContain("skills/research-ancient");
    const dominant = rooms.find((r: any) => r.room === "skills/code-1751700000000");
    expect(dominant.dominant_for_session).toBe(true);
  });

  it("keeps recently-updated rooms even without a session match", async () => {
    mockCall.mockImplementation(async (tool: string) => {
      if (tool === "list_rooms") return listRoomsResponse;
      if (tool === "list_drawers") {
        return { success: true, data: { drawers: [{ id: "d1" }] } };
      }
      return { success: false };
    });

    const rooms = await queryMempalaceSkillRoomsForSession(["nomatch"], 86_400_000);
    const names = rooms.map((r: any) => r.room);
    expect(names).toContain("skills/plan-other"); // recent
    expect(names).not.toContain("skills/research-ancient"); // old, no match
  });

  it("issues exactly one list_drawers call per matched room (no redundant searches)", async () => {
    mockCall.mockImplementation(async (tool: string) => {
      if (tool === "list_rooms") return listRoomsResponse;
      if (tool === "list_drawers") {
        return { success: true, data: { drawers: [{ id: "d1" }] } };
      }
      return { success: false };
    });

    await queryMempalaceSkillRoomsForSession(["code-1751700000000"], 1);
    const drawerCalls = mockCall.mock.calls.filter(([tool]) => tool === "list_drawers");
    expect(drawerCalls).toHaveLength(1);
    const searchCalls = mockCall.mock.calls.filter(([tool]) => tool === "search");
    expect(searchCalls).toHaveLength(0);
  });

  it("ignores empty session ids instead of matching everything", async () => {
    mockCall.mockImplementation(async (tool: string) => {
      if (tool === "list_rooms") return listRoomsResponse;
      if (tool === "list_drawers") {
        return { success: true, data: { drawers: [{ id: "d1" }] } };
      }
      return { success: false };
    });

    const rooms = await queryMempalaceSkillRoomsForSession([""], 1);
    expect(rooms).toEqual([]);
  });
});

// ============================================================
// KG Entity Verification
// ============================================================

describe("queryKGEntitiesForScope", () => {
  it("queries each scoped id and merges the related entities", async () => {
    mockCall.mockImplementation(async (tool: string, params?: any) => {
      if (tool === "kg_query" && params?.entity === "plan-1") {
        return {
          success: true,
          data: {
            facts: [
              { subject: "Decision:D1", predicate: "approved_by", object: "plan-1" },
              { subject: "plan-1", predicate: "has_agent", object: "Agent:echo" },
            ],
          },
        };
      }
      return { success: true, data: { facts: [] } };
    });

    const entities = await queryKGEntitiesForScope(["plan-1", "code-2"]);
    expect(entities).toHaveLength(2);
    expect(entities[0].entity_id).toBe("Decision:D1");
    expect(entities[0].entity_type).toBe("Decision");
    expect(entities[1].entity_id).toBe("Agent:echo");
    expect(entities[1].entity_type).toBe("Agent");
  });

  it("returns [] for an empty scope (no dead Session:<uuid> query)", async () => {
    const entities = await queryKGEntitiesForScope([]);
    expect(entities).toEqual([]);
    expect(mockCall).not.toHaveBeenCalled();
  });



});
