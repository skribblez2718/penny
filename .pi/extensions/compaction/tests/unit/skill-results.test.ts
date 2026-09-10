import { artifactDispatchRecoveryV1, parseArtifactDispatchMode } from "@penny/orchestration/source";
import { describe, expect, it } from "vitest";

import { detectDominantSkill, deriveWorkContext, extractResultData } from "../../index.js";
import { parseSkillResultDetails } from "../../skill-results.js";
import type { SessionMessage } from "../../pi-messages.js";

/**
 * Verbatim data fixture from the `SkillResult` example in
 * 12e8c32922bae2db0da7cc706322d10b2eccb81d:.pi/extensions/skill/tests/unit/modes.test.ts.
 */
const AUTHENTIC_ARCHIVED_SKILL_RESULT: Record<string, unknown> = {
  success: true,
  session_id: "test-123",
  skill_name: "plan",
  state: "complete",
  requires_approval: false,
  steps_total: 3,
  agents_invoked: ["echo", "piper"],
  errors: [],
  plan: { plan_summary: "Three authentication patterns found." },
};

/** Current engine-era history fixture matching the present `SkillResult` source. */
const AUTHENTIC_CURRENT_SKILL_RESULT: Record<string, unknown> = {
  success: true,
  session_id: "code-current-1",
  skill_name: "code",
  state: "complete",
  requires_approval: false,
  steps_total: 2,
  agents_invoked: ["coder", "reviewer"],
  errors: [],
  result: { met: true, terminal_reason: null },
};

function currentDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...AUTHENTIC_CURRENT_SKILL_RESULT, ...overrides };
}

function withoutField(value: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

function resultMessage(details: unknown, overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    role: "toolResult",
    toolName: "skill",
    toolCallId: "skill-call-1",
    content: "Untrusted prose representation",
    details,
    ...overrides,
  };
}

function skillCall(id = "skill-call-1"): SessionMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name: "skill",
        arguments: { skill_name: "code", goal: "Implement the boundary" },
      },
    ],
  };
}

describe("structured skill-result parsing", () => {
  it("parses the current result boundary before prose", () => {
    const parsed = extractResultData(
      resultMessage(currentDetails(), {
        content: '{"success":false,"session_id":"prose-lie"}',
      })
    );
    expect(parsed).toMatchObject({
      status: "success",
      success: true,
      session_id: "code-current-1",
    });
    expect(parsed.parsed?.format).toBe("current");
  });

  it("parses the authentic archived pre-engine SkillResult fixture", () => {
    const parsed = parseSkillResultDetails(AUTHENTIC_ARCHIVED_SKILL_RESULT);
    expect(parsed).toMatchObject({
      format: "legacy",
      status: "success",
      sessionId: "test-123",
      skillName: "plan",
    });
  });

  it("rejects the archived fixture when mandatory requires_approval is missing", () => {
    const malformed = withoutField(AUTHENTIC_ARCHIVED_SKILL_RESULT, "requires_approval");
    expect(Object.prototype.hasOwnProperty.call(malformed, "requires_approval")).toBe(false);
    expect(parseSkillResultDetails(malformed)).toBeNull();
    expect(extractResultData(resultMessage(malformed))).toEqual({
      status: "unknown",
      success: false,
    });
  });

  it("fails closed on Vera's malformed current-like non-string error counterexample", () => {
    const malformed = currentDetails({ result: undefined, errors: [42] });
    expect(Object.prototype.hasOwnProperty.call(malformed, "result")).toBe(true);
    expect(parseSkillResultDetails(malformed)).toBeNull();
    expect(extractResultData(resultMessage(malformed))).toEqual({
      status: "unknown",
      success: false,
    });
  });

  it.each([
    ["requires_approval type", { requires_approval: "false" }],
    ["plan type", { plan: [] }],
    ["plan_steps element type", { plan_steps: [{ step: 1 }, "not-a-record"] }],
    ["mode enum", { mode: "resume" }],
    ["agents_invoked element type", { agents_invoked: ["echo", 7] }],
    ["errors element type", { errors: [{ code: "NOT_AN_AUTHENTIC_LEGACY_ERROR" }] }],
    [
      "nested legacy result",
      {
        chain_results: [withoutField(AUTHENTIC_ARCHIVED_SKILL_RESULT, "requires_approval")],
      },
    ],
    [
      "unknown escalation question field",
      {
        escalation: {
          questions: [
            {
              id: "approval",
              label: "Approve",
              prompt: "Continue?",
              invented_question_field: "not-authentic-history",
            },
          ],
        },
      },
    ],
    ["unknown top-level field", { invented_legacy_field: true }],
  ])("rejects malformed archived legacy %s without yielding success", (_label, override) => {
    const malformed = { ...AUTHENTIC_ARCHIVED_SKILL_RESULT, ...override };
    expect(parseSkillResultDetails(malformed)).toBeNull();
    expect(extractResultData(resultMessage(malformed))).toEqual({
      status: "unknown",
      success: false,
    });
  });

  it("keeps current-only escalation question fields on the current path", () => {
    const parsed = parseSkillResultDetails(
      currentDetails({
        escalation: {
          questions: [{ approval_run_id: "current-run-id" }],
        },
      })
    );
    expect(parsed).toMatchObject({ format: "current", status: "success" });
  });

  it("represents every supported honest status", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["success", currentDetails()],
      [
        "failure",
        currentDetails({
          success: false,
          state: "error",
          errors: ["execution failed"],
          result: { met: false },
        }),
      ],
      [
        "incomplete",
        currentDetails({
          success: false,
          state: "incomplete",
          result: { met: false, terminal_reason: "budget_exhausted" },
        }),
      ],
      [
        "paused",
        currentDetails({
          success: false,
          state: "executing",
          result: undefined,
          dispatch_pause: {
            schema_version: 1,
            action: "paused",
            code: "ARTIFACT_DISPATCH_PAUSED",
            reason: "dispatch is paused",
            retryable: true,
            dispatch_mode: "paused",
            run_status: "running",
            state_id: "executing",
            session_id: "code-current-1",
            run_id: "run-current-1",
            recovery: {
              action: "recover",
              run_id: "run-current-1",
              requires_dispatch_mode: "active",
              checkpoint_preserved: true,
            },
          },
        }),
      ],
      ["cancelled", currentDetails({ success: false, state: "cancelled", result: { met: false } })],
      ["unknown", currentDetails({ success: false, state: "executing", result: undefined })],
    ];

    for (const [expected, details] of cases) {
      expect(extractResultData(resultMessage(details)).status).toBe(expected);
    }
  });

  it("parses current engine-owned pause facts through the shared validator", () => {
    const identity = {
      schema_version: 2 as const,
      run_id: "run-current-pause",
      session_id: "session-current-pause",
      playbook: "code",
      engine_owner: "typescript" as const,
    };
    const dispatch = parseArtifactDispatchMode("paused");
    const dispatchPause = {
      schema_version: 2 as const,
      pause_schema_version: 1 as const,
      action: "paused" as const,
      identity,
      status: "running" as const,
      state_id: "executing",
      code: "DISPATCH_PAUSED" as const,
      reason: dispatch.reason,
      retryable: true,
      dispatch,
      recovery: artifactDispatchRecoveryV1({
        identity,
        stateId: "executing",
        reason: dispatch.reason,
        kind: "recoverable_checkpoint",
        checkpointExists: true,
      }),
    };
    expect(
      extractResultData(
        resultMessage(
          currentDetails({
            success: false,
            state: "executing",
            result: undefined,
            dispatch_pause: dispatchPause,
            recovery: dispatchPause.recovery,
            retriable: true,
          })
        )
      )
    ).toMatchObject({ status: "paused", success: false });
  });

  it("fails closed on unknown versions", () => {
    const topVersion = extractResultData(resultMessage(currentDetails({ schema_version: 99 })));
    const nestedVersion = extractResultData(
      resultMessage(currentDetails({ result: { schema_version: 99, met: true } }))
    );
    expect(topVersion).toEqual({ status: "unknown", success: false });
    expect(nestedVersion).toEqual({ status: "unknown", success: false });
  });

  it("does not replace malformed modern details with prose-derived claims", () => {
    const parsed = extractResultData(
      resultMessage(
        {
          ...currentDetails(),
          success: "true",
        },
        {
          content: JSON.stringify({
            success: true,
            session_id: "invented-from-prose",
            skill_name: "code",
            state: "complete",
          }),
        }
      )
    );
    expect(parsed).toEqual({ status: "unknown", success: false });
  });

  it("does not turn unknown or malformed status into active unfinished work", () => {
    expect(
      deriveWorkContext({
        dominantSkill: {
          skill_name: "code",
          goal: "Ambiguous work",
          completed: false,
          result_status: "unknown",
        },
        engineRuns: [],
        pending: null,
        goal: "Ambiguous work",
      })
    ).toEqual({});
  });

  it("keeps an explicit tool transport error as failure without parsing prose", () => {
    expect(
      extractResultData(
        resultMessage(undefined, {
          isError: true,
          content: '{"success":true,"session_id":"prose-lie"}',
        })
      )
    ).toEqual({ status: "failure", success: false });
  });
});

describe("exact skill call/result correlation", () => {
  it("uses one exact call/result ID pair", () => {
    const dominant = detectDominantSkill([skillCall(), resultMessage(currentDetails())]);
    expect(dominant).toMatchObject({
      session_id: "code-current-1",
      result_status: "success",
      completed: true,
    });
  });

  it("does not borrow a result with a different ID", () => {
    const dominant = detectDominantSkill([
      skillCall("wanted"),
      resultMessage(currentDetails(), { toolCallId: "other" }),
    ]);
    expect(dominant).toMatchObject({ result_status: "unknown", completed: false });
    expect(dominant?.session_id).toBeUndefined();
  });

  it("fails closed on duplicate ambiguous result IDs", () => {
    const dominant = detectDominantSkill([
      skillCall(),
      resultMessage(currentDetails()),
      resultMessage(currentDetails({ session_id: "second-session" })),
    ]);
    expect(dominant).toMatchObject({ result_status: "unknown", completed: false });
    expect(dominant?.session_id).toBeUndefined();
  });
});
