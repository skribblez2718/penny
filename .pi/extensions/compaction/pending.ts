/**
 * Pending-state detection from the compacted conversation only.
 *
 * Recovery never depends on durable memory availability. The authoritative
 * awaiting-user state still comes from an exact orchestration checkpoint;
 * this scanner preserves conversational escalation signals for prose fallback.
 */

import type { SessionMessage } from "./pi-messages.js";
import type { PendingState } from "./schema.js";

interface EscalationSignal {
  state: "UNKNOWN_STATE" | "awaiting_clarification" | "verification_required";
  question_summary: string;
  turn_id?: string;
}

function extractQuestionSummary(text: string): string | null {
  for (const sentence of text.split(/[.!?\n]/)) {
    const trimmed = sentence.trim();
    if (trimmed.endsWith("?")) return trimmed.slice(0, 200);
    if (/verify|confirm|proceed with|reject|escalate/i.test(trimmed)) {
      return trimmed.slice(0, 200);
    }
  }
  return null;
}

function extractText(message: SessionMessage | undefined): string | null {
  if (!message) return null;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text ?? "")
      .join(" ");
  }
  return null;
}

function scanMessagesForEscalation(messages: SessionMessage[]): EscalationSignal | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const content = extractText(message);
    if (!content) continue;
    const lower = content.toLowerCase();

    if (message.role === "toolResult" && message.toolName === "questionnaire") {
      return {
        state: "awaiting_clarification",
        question_summary: "User responded to questionnaire",
        turn_id: message.id,
      };
    }
    if (message.role === "assistant") {
      if (/verification needed|awaiting user input|⏸️ .*awaiting/i.test(lower)) {
        return {
          state: "verification_required",
          question_summary: extractQuestionSummary(content) || "Verification pending",
          turn_id: message.id,
        };
      }
      if (/unknown_state|escalation needed|need your input/i.test(lower)) {
        return {
          state: "UNKNOWN_STATE",
          question_summary: extractQuestionSummary(content) || "Clarification needed",
          turn_id: message.id,
        };
      }
    }
    if (message.role === "user" && index > 0) {
      const previous = messages[index - 1];
      if (
        previous?.role === "assistant" &&
        /questionnaire|verify|clarify/i.test(extractText(previous) || "")
      ) {
        return {
          state: "awaiting_clarification",
          question_summary: "User provided clarification",
          turn_id: message.id,
        };
      }
    }
  }
  return null;
}

export async function detectPendingState(messages: SessionMessage[]): Promise<PendingState | null> {
  const signal = scanMessagesForEscalation(messages);
  if (!signal) return null;
  return {
    state: signal.state,
    previous_state: "unknown",
    question_summary: signal.question_summary,
    turn_id: signal.turn_id || "unknown",
  };
}
