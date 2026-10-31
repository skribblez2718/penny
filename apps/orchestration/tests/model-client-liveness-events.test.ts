import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  contentFreeSessionLivenessEvent,
  createContentFreeSessionLivenessProjectionState,
} from "../dist/model-client.js";

type SessionEvent = Parameters<typeof contentFreeSessionLivenessEvent>[0];

const allowed = new Set(["artifact_read"]);
const partial = {
  role: "assistant",
  content: [],
  api: "anthropic-messages",
  provider: "liveness-fixture",
  model: "liveness-fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
} satisfies AssistantMessage;

function event(value: SessionEvent): SessionEvent {
  return value;
}

describe("content-free Pi inactivity-lease activity projection", () => {
  it("credits only non-empty assistant and thinking deltas without retaining their bodies", () => {
    const secret = "private assistant body";
    const text = contentFreeSessionLivenessEvent(
      event({
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: secret, partial },
      }),
      allowed
    );
    expect(text).toEqual({
      kind: "activity",
      activity_class: "assistant_text_delta",
      observed_units: Buffer.byteLength(secret),
    });
    expect(JSON.stringify(text)).not.toContain(secret);

    const thinking = contentFreeSessionLivenessEvent(
      event({
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "hidden reasoning",
          partial,
        },
      }),
      allowed
    );
    expect(thinking).toMatchObject({
      kind: "activity",
      activity_class: "assistant_thinking_delta",
      observed_units: 16,
    });
    expect(
      contentFreeSessionLivenessEvent(
        event({
          type: "message_update",
          message: partial,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial },
        }),
        allowed
      )
    ).toBeUndefined();
  });

  it("credits changed tool updates once and rejects repeated cumulative no-op updates", () => {
    const state = createContentFreeSessionLivenessProjectionState();
    const first = event({
      type: "tool_execution_update",
      toolCallId: "call-private",
      toolName: "artifact_read",
      args: { secret: "not retained" },
      partialResult: { content: [{ type: "text", text: "first private result" }] },
    });
    const changed = event({
      type: "tool_execution_update",
      toolCallId: "call-private",
      toolName: "artifact_read",
      args: { secret: "not retained" },
      partialResult: { content: [{ type: "text", text: "second private result" }] },
    });

    expect(
      contentFreeSessionLivenessEvent(
        event({
          type: "tool_execution_update",
          toolCallId: "empty-call",
          toolName: "artifact_read",
          args: {},
          partialResult: undefined,
        }),
        allowed,
        state
      )
    ).toBeUndefined();
    expect(contentFreeSessionLivenessEvent(first, allowed, state)).toMatchObject({
      kind: "activity",
      activity_class: "tool_execution_updated",
    });
    expect(contentFreeSessionLivenessEvent(first, allowed, state)).toBeUndefined();
    const projection = contentFreeSessionLivenessEvent(changed, allowed, state);
    expect(projection).toMatchObject({
      kind: "activity",
      activity_class: "tool_execution_updated",
    });
    expect(JSON.stringify(projection)).not.toContain("private result");
  });

  it("keeps model-turn accounting separate from lease-renewing lifecycle activity", () => {
    expect(contentFreeSessionLivenessEvent(event({ type: "turn_start" }), allowed)).toEqual({
      kind: "model_turn",
      source: "turn_start",
    });
    expect(
      contentFreeSessionLivenessEvent(
        event({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "artifact_read",
          args: {},
        }),
        allowed
      )
    ).toEqual({
      kind: "tool_call",
      tool_name: "artifact_read",
      progress: { activity_class: "tool_execution_started", observed_units: 1 },
    });
    expect(
      contentFreeSessionLivenessEvent(
        event({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "artifact_read",
          result: { content: [] },
          isError: false,
        }),
        allowed
      )
    ).toEqual({
      kind: "activity",
      activity_class: "tool_execution_completed",
      observed_units: 1,
    });
  });
});
