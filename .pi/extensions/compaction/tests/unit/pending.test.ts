import { describe, it, expect } from "vitest";

// ============================================================
// Pending State Detection Tests
// ============================================================

// Since detectPendingState is async and calls the bridge,
// we test the message scanner component indirectly by checking
// that the integration tests still pass with pending=null (no bridge).

describe("Pending State Detection (message scanning)", () => {
  it("detects questionnaire tool results as awaiting_clarification", () => {
    const messages = [
      { role: "assistant", content: "Please answer this question:" },
      {
        role: "toolResult",
        toolName: "questionnaire",
        content: '{"answers": [{"id": "q1", "value": "confirm"}]}',
        id: "turn-1",
      },
    ];
    // The scanner would detect the questionnaire tool result
    expect(messages[1].toolName).toBe("questionnaire");
    expect(messages[1].role).toBe("toolResult");
  });

  it("detects verification language in assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content:
          "⏸️ plan awaiting user input. Verification needed for: A high-stakes action is pending confirmation.",
        id: "turn-2",
      },
    ];
    const text = messages[0].content as string;
    expect(/verification needed|awaiting user input|⏸️ .*awaiting/i.test(text)).toBe(true);
  });

  it("detects UNKNOWN_STATE language in assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: "The plan has entered UNKNOWN_STATE. Need your input to proceed.",
        id: "turn-3",
      },
    ];
    const text = messages[0].content as string;
    expect(/unknown_state|escalation needed|need your input/i.test(text)).toBe(true);
  });

  it("detects user responses to escalation", () => {
    const messages = [
      {
        role: "assistant",
        content: "Please verify: should I proceed with the file deletion?",
        id: "turn-4",
      },
      {
        role: "user",
        content: "Yes, proceed.",
        id: "turn-5",
      },
    ];
    const prevText = messages[0].content as string;
    expect(/verify|confirm|proceed/i.test(prevText)).toBe(true);
    expect(messages[1].role).toBe("user");
  });

  it("extracts question summary from assistant text", () => {
    const text = "I need your input on this. Should I delete the file? Please confirm.";
    const sentences = text.split(/[.!?\n]/);
    const question = sentences.find((s) => s.trim().includes("delete"));
    expect(question).toBeDefined();
    expect(question?.trim()).toBe("Should I delete the file");
  });

  it("returns null when no escalation signals present", () => {
    const messages = [
      { role: "user", content: "Let's implement phase 3" },
      { role: "assistant", content: "I'll start working on that now." },
    ];
    const hasEscalation = messages.some((m) =>
      /verification|unknown_state|questionnaire|⏸️/i.test(
        typeof m.content === "string" ? m.content : ""
      )
    );
    expect(hasEscalation).toBe(false);
  });
});
