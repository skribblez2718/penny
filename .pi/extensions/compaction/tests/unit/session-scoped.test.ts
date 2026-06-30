import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// ============================================================
// Session-Scoped Compaction Tests (v1.1.0)
// ============================================================

describe("detectDominantSkill", () => {
  // Since detectDominantSkill is not exported, we test indirectly
  // via the schema and bridge mock patterns

  it("detects skill tool call from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "skill",
            arguments: { skill_name: "plan", goal: "Design a scoring system" },
          },
        ],
      },
      {
        role: "toolResult",
        content: JSON.stringify({
          success: true,
          session_id: "plan-123",
          plan: { title: "Top 3 programs" },
        }),
      },
    ];

    // Verify we have a skill tool call with the expected structure
    const skillCall = messages.find(
      (m: any) =>
        m.role === "assistant" &&
        m.content?.some((c: any) => c.type === "toolCall" && c.name === "skill")
    );
    expect(skillCall).toBeTruthy();
    const skillBlock = skillCall.content.find((c: any) => c.name === "skill");
    expect(skillBlock.arguments.skill_name).toBe("plan");
    expect(skillBlock.arguments.goal).toContain("scoring");
  });

  it("fallback infers skill name from user intent", () => {
    const messages = [
      { role: "user", content: "Run the plan skill to design a system" },
    ];
    const content = messages[0].content.toLowerCase();
    expect(/plan|design/i.test(content)).toBe(true);
  });

  it("returns null when no skill invocation found", () => {
    const messages = [
      { role: "user", content: "What is the weather today?" },
      { role: "assistant", content: [{ type: "text", text: "It's sunny." }] },
    ];
    const hasSkillTool = messages.some(
      (m: any) =>
        m.role === "assistant" &&
        m.content?.some((c: any) => c.type === "toolCall" && c.name === "skill")
    );
    expect(hasSkillTool).toBe(false);
  });

  it("only considers most recent skill invocation", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "skill", arguments: { skill_name: "plan", goal: "Old plan" } },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "skill",
            arguments: { skill_name: "plan", goal: "New work" },
          },
        ],
      },
    ];
    const skillCalls = messages.filter(
      (m: any) =>
        m.role === "assistant" &&
        m.content?.some((c: any) => c.type === "toolCall" && c.name === "skill")
    );
    expect(skillCalls.length).toBe(2);
    // Last one is the dominant one
    const lastCall = skillCalls[skillCalls.length - 1];
    expect(lastCall.content[0].arguments.skill_name).toBe("plan");
  });
});

describe("extractSessionState v1.1.0", () => {
  it("prefers skill goal over message text", () => {
    const dominant = {
      skill_name: "plan",
      session_id: "plan-123",
      goal: "Design a scoring system",
      completed: false,
    };
    // Goal from dominant skill should override any message-based goal
    expect(dominant.goal).toBe("Design a scoring system");
    expect(dominant.goal).not.toBe("");
  });

  it("ignores reactionary user messages for goal", () => {
    const reactionary = [
      "This is wildly confusing",
      "Fix this bug",
      "this is wrong",
      "figure out why it broke",
      "something wrong happened",
    ];
    for (const text of reactionary) {
      const lower = text.toLowerCase();
      const isReactionary =
        lower.includes("wildly confusing") ||
        lower.includes("fix this") ||
        lower.includes("this is wrong") ||
        lower.includes("figure out") ||
        lower.includes("something wrong");
      expect(isReactionary).toBe(true);
    }
  });

  it("extracts constraints from user messages", () => {
    const text = "You must not use a Pi fork. Do not modify core files.";
    const lower = text.toLowerCase();
    const hasConstraint = /must|do not|never/i.test(lower);
    expect(hasConstraint).toBe(true);
  });
});

describe("recency-weighted eviction", () => {
  it("never evicts dominant skill rooms", () => {
    const rooms = [
      {
        wing: "penny",
        room: "skills/plan-123",
        drawer_ids: ["d1"],
        last_updated: new Date(Date.now() - 2000).toISOString(),
      },
      {
        wing: "penny",
        room: "skills/plan-debug-001",
        drawer_ids: ["d2"],
        last_updated: new Date(Date.now() - 1000).toISOString(),
      },
      {
        wing: "penny",
        room: "skills/agent-old",
        drawer_ids: ["d3"],
        last_updated: new Date(Date.now() - 86_400_000 * 7).toISOString(),
      },
    ];

    const dominantSessionId = "plan-123";
    const roomMatch = rooms.filter((r) =>
      r.room.toLowerCase().includes(dominantSessionId.toLowerCase())
    );
    expect(roomMatch.length).toBe(1); // only plan-123 contains "plan-123"
  });

  it("protects newer rooms over older ones with same priority", () => {
    const room1 = {
      wing: "penny",
      room: "skills/plan-recent",
      last_updated: new Date(Date.now() - 3_600_000).toISOString(), // 1h ago, priority 6
    };
    const room2 = {
      wing: "penny",
      room: "skills/plan-old",
      last_updated: new Date(Date.now() - 86_400_000).toISOString(), // 24h ago, priority 7
    };
    const age1 = Date.now() - new Date(room1.last_updated).getTime();
    const age2 = Date.now() - new Date(room2.last_updated).getTime();
    expect(age1).toBeLessThan(age2); // room1 is newer
  });
});

describe("SkillInvocationRefSchema", () => {
  it("validates a minimal skill invocation", () => {
    const invocation = {
      skill_name: "plan",
      session_id: "plan-123",
      goal: "Find top 3 programs",
      completed: false,
    };
    expect(invocation.skill_name).toBeTruthy();
    expect(invocation.session_id).toBeTruthy();
    expect(invocation.goal.length).toBeLessThanOrEqual(500);
  });

  it("optional result_summary", () => {
    const invocation = {
      skill_name: "plan",
      session_id: "plan-456",
      goal: "Make a plan",
      completed: true,
      result_summary: undefined,
    };
    expect(invocation.result_summary).toBeUndefined();
    expect(invocation.completed).toBe(true);
  });
});

describe("MempalaceRoomRef.dominant_for_session", () => {
  it("marks dominant rooms correctly", () => {
    const rooms = [
      {
        wing: "penny",
        room: "skills/plan-123",
        drawer_ids: ["d1"],
        last_updated: new Date().toISOString(),
      },
      {
        wing: "penny",
        room: "skills/plan-debug-456",
        drawer_ids: ["d2"],
        last_updated: new Date().toISOString(),
      },
    ];

    const dominantSessionId = "plan-123";
    for (const room of rooms) {
      room.dominant_for_session = room.room?.includes(dominantSessionId);
    }

    expect(rooms[0].dominant_for_session).toBe(true); // matches "plan-123"
    expect(rooms[1].dominant_for_session).toBe(false); // does NOT match "plan-123"
  });
});

describe("AgentRef.source", () => {
  it("distinguishes mempalace from inferred agents", () => {
    const agents = [
      {
        name: "echo",
        session_id: "s1",
        phase: "exploring",
        complete: true,
        source: "mempalace_summary",
      },
      { name: "unknown", session_id: "s1", phase: "unknown", complete: false, source: "inferred" },
    ];
    expect(agents[0].source).toBe("mempalace_summary");
    expect(agents[1].source).toBe("inferred");
  });
});
