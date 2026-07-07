import { describe, it, expect, vi } from "vitest";
import { detectPendingState } from "../../pending.js";

// No diary escalation available — force the message-scanning path
vi.mock("../../bridge.js", () => ({
  queryDiaryEscalation: vi.fn(async () => []),
}));

describe("detectPendingState (message scanning)", () => {
  it("detects questionnaire tool results as awaiting_clarification", async () => {
    const pending = await detectPendingState(
      [
        { role: "assistant", content: "Please answer this question:" },
        {
          role: "toolResult",
          toolName: "questionnaire",
          content: '{"answers": [{"id": "q1", "value": "confirm"}]}',
          id: "turn-1",
        },
      ],
      "sess-1"
    );
    expect(pending).not.toBeNull();
    expect(pending!.state).toBe("awaiting_clarification");
    expect(pending!.turn_id).toBe("turn-1");
  });

  it("detects verification language in assistant messages", async () => {
    const pending = await detectPendingState(
      [
        {
          role: "assistant",
          content:
            "⏸️ plan awaiting user input. Verification needed for: A high-stakes action is pending confirmation.",
          id: "turn-2",
        },
      ],
      "sess-1"
    );
    expect(pending).not.toBeNull();
    expect(pending!.state).toBe("verification_required");
  });

  it("detects UNKNOWN_STATE language in assistant messages", async () => {
    const pending = await detectPendingState(
      [
        {
          role: "assistant",
          content: "The plan has entered UNKNOWN_STATE. Need your input to proceed.",
          id: "turn-3",
        },
      ],
      "sess-1"
    );
    expect(pending).not.toBeNull();
    expect(pending!.state).toBe("UNKNOWN_STATE");
  });

  it("returns null when no escalation signals present", async () => {
    const pending = await detectPendingState(
      [
        { role: "user", content: "Let's implement the redesign" },
        { role: "assistant", content: "Starting on that now." },
      ],
      "sess-1"
    );
    expect(pending).toBeNull();
  });
});
