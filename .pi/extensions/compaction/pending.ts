/**
 * Pending State Detection
 *
 * Detects if the session is in an escalation state (UNKNOWN_STATE,
 * awaiting_clarification, or verification_required) by:
 *   1. Scanning recent messages for escalation signals
 *   2. Querying mempalace diary for recent escalation entries
 *
 * Returns a PendingState object if active, null otherwise.
 */

import { queryDiaryEscalation } from "./bridge.js";
import type { PendingState } from "./schema.js";
import type { SessionMessage } from "./pi-messages.js";

// ============================================================
// Message-Based Detection
// ============================================================

interface EscalationSignal {
  state: "UNKNOWN_STATE" | "awaiting_clarification" | "verification_required";
  question_summary: string;
  turn_id?: string;
}

/**
 * Scan messages for escalation signals.
 *
 * Detects:
 *   - questionnaire tool calls → awaiting_clarification
 *   - "Verification needed" / "verify" in assistant text → verification_required
 *   - "UNKNOWN_STATE" / "escalate" in text → UNKNOWN_STATE
 */
function scanMessagesForEscalation(messages: SessionMessage[]): EscalationSignal | null {
  // Scan from newest to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content = extractText(msg);
    if (!content) continue;

    const lower = content.toLowerCase();

    // Detect questionnaire tool results (user responded to escalation)
    if (msg.role === "toolResult" && msg.toolName === "questionnaire") {
      return {
        state: "awaiting_clarification",
        question_summary: "User responded to questionnaire",
        turn_id: msg.id,
      };
    }

    // Detect verification language in assistant messages
    if (msg.role === "assistant") {
      if (/verification needed|awaiting user input|⏸️ .*awaiting/i.test(lower)) {
        return {
          state: "verification_required",
          question_summary: extractQuestionSummary(content) || "Verification pending",
          turn_id: msg.id,
        };
      }
      if (/unknown_state|escalation needed|need your input/i.test(lower)) {
        return {
          state: "UNKNOWN_STATE",
          question_summary: extractQuestionSummary(content) || "Clarification needed",
          turn_id: msg.id,
        };
      }
    }

    // Detect user messages that look like escalation responses
    if (msg.role === "user" && i > 0) {
      const prevMsg = messages[i - 1];
      if (
        prevMsg?.role === "assistant" &&
        /questionnaire|verify|clarify/i.test(extractText(prevMsg) || "")
      ) {
        return {
          state: "awaiting_clarification",
          question_summary: "User provided clarification",
          turn_id: msg.id,
        };
      }
    }
  }

  return null;
}

/**
 * Extract a one-line question summary from assistant text.
 */
function extractQuestionSummary(text: string): string | null {
  // Look for the first sentence that ends with ? or contains "verify"/"confirm"
  const sentences = text.split(/[.!?\n]/);
  for (const s of sentences) {
    const trimmed = s.trim();
    if (trimmed.endsWith("?")) return trimmed.slice(0, 200);
    if (/verify|confirm|proceed with|reject|escalate/i.test(trimmed)) {
      return trimmed.slice(0, 200);
    }
  }
  return null;
}

function extractText(msg: SessionMessage | undefined): string | null {
  if (!msg) return null;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join(" ");
  }
  return null;
}

// ============================================================
// Bridge-Based Detection
// ============================================================

/**
 * Query mempalace diary for recent escalation entries.
 */
async function detectEscalationFromDiary(): Promise<EscalationSignal | null> {
  try {
    const entries = await queryDiaryEscalation("penny", 3);
    if (entries.length === 0) return null;

    const latest = entries[0];
    const text = latest.text || "";

    if (/verification/i.test(text)) {
      return {
        state: "verification_required",
        question_summary: "Verification state detected from diary",
      };
    }
    if (/unknown_state|escalation|clarification/i.test(text)) {
      return {
        state: "UNKNOWN_STATE",
        question_summary: "UNKNOWN_STATE detected from diary",
      };
    }
    return {
      state: "awaiting_clarification",
      question_summary: "Pending clarification detected from diary",
    };
  } catch {
    return null;
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Detect pending state for the compact artifact.
 *
 * Strategy:
 *   1. Fast path: scan messages (no bridge call needed)
 *   2. Fallback: query diary via bridge
 *   3. If found, return PendingState with mempalace reference
 */
export async function detectPendingState(
  messages: SessionMessage[],
  sessionId: string
): Promise<PendingState | null> {
  // Fast path: message scanning
  const signal = scanMessagesForEscalation(messages);
  if (!signal) {
    // Fallback: bridge query
    const diarySignal = await detectEscalationFromDiary();
    if (!diarySignal) return null;
    // Merge diary signal
    return {
      state: diarySignal.state,
      previous_state: "unknown", // Can't determine from diary alone
      mempalace_drawer_id: "pending-diary", // Phase 3+ will use real drawer ID
      question_summary: diarySignal.question_summary,
      turn_id: "unknown",
    };
  }

  return {
    state: signal.state,
    previous_state: "unknown", // Phase 3+: query orchestrator state
    mempalace_drawer_id: `pending-${sessionId}`, // Phase 3+: real drawer ID
    question_summary: signal.question_summary,
    turn_id: signal.turn_id || "unknown",
  };
}
