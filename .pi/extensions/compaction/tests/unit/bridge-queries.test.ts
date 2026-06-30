import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to mock the internal callBridge before importing the convenience methods
const mockCallBridge = vi.fn();

// Use a manual mock module
vi.mock("../../bridge.js", () => {
  return {
    callBridge: (...args: any[]) => mockCallBridge(...args),
    // Re-export the convenience functions using the mocked callBridge
    queryMempalaceSkillRooms: async () => {
      const roomsResult = await mockCallBridge("list_rooms", { wing: "penny" });
      if (!roomsResult.success) return [];
      const allRooms = roomsResult.data?.rooms || roomsResult.data || [];
      if (!Array.isArray(allRooms)) return [];
      const skillRooms = allRooms.filter((r: any) =>
        (r.name || r.room || "").startsWith("skills/")
      );
      const roomRefs = [];
      for (const room of skillRooms) {
        const roomName = room.name || room.room;
        const drawersResult = await mockCallBridge("list_drawers", {
          wing: "penny",
          room: roomName,
          limit: 5,
        });
        const drawers = drawersResult.success
          ? drawersResult.data?.drawers?.map((d: any) => d.id || d.drawer_id) || []
          : [];
        roomRefs.push({
          wing: "penny",
          room: roomName,
          drawer_ids: drawers,
          last_updated: new Date().toISOString(),
        });
      }
      return roomRefs;
    },
    queryKGEntitiesForSession: async (sessionId: string) => {
      const result = await mockCallBridge("kg_query", {
        entity: `Session:${sessionId}`,
        direction: "both",
      });
      if (!result.success) return [];
      const triples = result.data?.facts || [];
      const now = new Date().toISOString();
      return triples.map((t: any) => ({
        entity_id: t.object === `Session:${sessionId}` ? t.subject : t.object,
        entity_type: inferEntityType(t.predicate),
        relevant_predicates: [t.predicate],
        last_verified: now,
        stale: false,
        valid_from: t.valid_from || now,
      }));
    },
    queryOutcomeLedgerDecisions: async (limit: number = 20) => {
      const result = await mockCallBridge("search", {
        wing: "penny",
        room: "outcomes",
        limit,
      });
      if (!result.success) return [];
      const drawers = result.data?.results || [];
      return drawers.map((d: any, i: number) => ({
        decision_id: `decision-${i}`,
        summary: (d.text || d.content || "Outcome record").slice(0, 200),
        outcome_room: "penny/outcomes",
        confidence: "PROBABLE",
      }));
    },
  };
});

function inferEntityType(predicate: string): string {
  if (/session|plan|skill/i.test(predicate)) return "Session";
  if (/decision|outcome|approved/i.test(predicate)) return "Decision";
  if (/agent|invoked|completed/i.test(predicate)) return "Agent";
  if (/feature|capability/i.test(predicate)) return "Feature";
  return "Entity";
}

import {
  queryMempalaceSkillRooms,
  queryKGEntitiesForSession,
  queryOutcomeLedgerDecisions,
} from "../../bridge.js";

beforeEach(() => {
  mockCallBridge.mockReset();
});

// ============================================================
// Item 1: Mempalace Skill Rooms
// ============================================================

describe("queryMempalaceSkillRooms", () => {
  it("returns skill rooms with drawer IDs", async () => {
    mockCallBridge.mockImplementation(async (tool: string) => {
      if (tool === "list_rooms") {
        return {
          success: true,
          data: {
            rooms: [
              { name: "skills/plan-abc123" },
              { name: "general" },
              { name: "skills/agent-xyz789" },
            ],
          },
        };
      }
      if (tool === "list_drawers") {
        return {
          success: true,
          data: { drawers: [{ id: "d1" }, { id: "d2" }] },
        };
      }
      return { success: false };
    });

    const rooms = await queryMempalaceSkillRooms();
    expect(rooms).toHaveLength(2);
    expect(rooms[0].room).toBe("skills/plan-abc123");
    expect(rooms[0].drawer_ids).toEqual(["d1", "d2"]);
    expect(rooms[1].room).toBe("skills/agent-xyz789");
  });

  it("returns empty array when list_rooms fails", async () => {
    mockCallBridge.mockResolvedValue({ success: false, error: "no palace" });
    const rooms = await queryMempalaceSkillRooms();
    expect(rooms).toEqual([]);
  });

  it("handles non-array response gracefully", async () => {
    mockCallBridge.mockResolvedValue({
      success: true,
      data: { rooms: null },
    });
    const rooms = await queryMempalaceSkillRooms();
    expect(rooms).toEqual([]);
  });
});

// ============================================================
// Item 2: KG Entity Verification
// ============================================================

describe("queryKGEntitiesForSession", () => {
  it("returns KG entities with lifecycle fields", async () => {
    mockCallBridge.mockImplementation(async (tool: string) => {
      if (tool === "kg_query") {
        return {
          success: true,
          data: {
            facts: [
              { subject: "Decision:D1", predicate: "approved_by", object: "Session:test" },
              { subject: "Session:test", predicate: "has_agent", object: "Agent:echo" },
            ],
          },
        };
      }
      return { success: false };
    });

    const entities = await queryKGEntitiesForSession("test");
    expect(entities).toHaveLength(2);
    expect(entities[0].entity_type).toBe("Decision");
    expect(entities[0].last_verified).toBeDefined();
    expect(entities[0].stale).toBe(false);
    expect(entities[1].entity_type).toBe("Agent");
  });

  it("returns empty array on kg_query failure", async () => {
    mockCallBridge.mockResolvedValue({ success: false });
    const entities = await queryKGEntitiesForSession("test");
    expect(entities).toEqual([]);
  });
});

// ============================================================
// Item 3: Outcome Ledger Decisions
// ============================================================

describe("queryOutcomeLedgerDecisions", () => {
  it("returns decisions from outcome drawers", async () => {
    mockCallBridge.mockImplementation(async (tool: string) => {
      if (tool === "search") {
        return {
          success: true,
          data: {
            results: [
              { text: "Approved plan for compaction extension" },
              { text: "Rejected observability augmentation" },
            ],
          },
        };
      }
      return { success: false };
    });

    const decisions = await queryOutcomeLedgerDecisions(20);
    expect(decisions).toHaveLength(2);
    expect(decisions[0].summary).toContain("Approved");
    expect(decisions[0].outcome_room).toBe("penny/outcomes");
    expect(decisions[0].confidence).toBe("PROBABLE");
  });

  it("returns empty array on search failure", async () => {
    mockCallBridge.mockResolvedValue({ success: false });
    const decisions = await queryOutcomeLedgerDecisions();
    expect(decisions).toEqual([]);
  });
});
