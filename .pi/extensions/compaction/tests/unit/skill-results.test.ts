import { artifactDispatchRecoveryV1, parseArtifactDispatchMode } from "@penny/orchestration";
import { describe, expect, it } from "vitest";

import { detectDominantSkill, deriveWorkContext, extractResultData } from "../../index.js";
import { collectValidatedSkillResultNodes, parseSkillResultDetails } from "../../skill-results.js";
import type { SessionMessage } from "../../pi-messages.js";
import type { SkillResult } from "@penny/orchestration";

/** Mirrors the current producer's terminal projection; type comes from the shared schema. */
const CURRENT_SKILL_RESULT: SkillResult = {
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
  return { ...CURRENT_SKILL_RESULT, ...overrides };
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

function pause() {
  const identity = {
    schema_version: 2 as const,
    run_id: "run-current-pause",
    session_id: "code-current-1",
    playbook: "code",
    engine_owner: "typescript" as const,
  };
  const dispatch = parseArtifactDispatchMode("paused");
  return {
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
}

function clarification(native = false): Record<string, unknown> {
  return currentDetails({
    success: false,
    state: "clarifying",
    result: undefined,
    continuation: {
      kind: "clarification",
      identity: {
        schema_version: 2,
        engine_owner: "typescript",
        run_id: "exact-clarification-run",
        session_id: "code-current-1",
        playbook: "code",
      },
      gate_id: "gate-1",
      challenge: "challenge-1",
    },
    escalation: {
      questions: [
        {
          id: "scope",
          label: "Clarification 1",
          prompt: "Which scope?",
          options: [],
          allowOther: true,
        },
      ],
      ...(native ? { trustedTransportCapability: "fixture-native-capability" } : {}),
    },
  });
}

describe("structured current skill-result parsing", () => {
  it("uses the shared current contract before prose", () => {
    expect(
      extractResultData(
        resultMessage(currentDetails(), { content: '{"success":false,"session_id":"prose-lie"}' })
      )
    ).toMatchObject({
      status: "success",
      success: true,
      session_id: "code-current-1",
      parsed: { format: "current" },
    });
  });

  it("needs no marker guessing for current wrapper errors and resumed chain previews", () => {
    expect(
      parseSkillResultDetails(
        currentDetails({
          result: undefined,
          success: false,
          state: "refused",
          errors: ["SPECIFICATION_ASSURANCE_REQUIRED"],
        })
      )
    ).toMatchObject({ format: "current", status: "failure" });
    expect(
      parseSkillResultDetails(
        currentDetails({ result: undefined, plan: { plan_summary: "Verified prior step" } })
      )
    ).toMatchObject({ format: "current", status: "success", summary: "Verified prior step" });
  });

  it.each([
    ["requires_approval missing", { requires_approval: undefined }],
    ["requires_approval type", { requires_approval: "false" }],
    ["plan type", { plan: [] }],
    ["plan_steps element", { plan_steps: [{ step: 1 }, "not-a-record"] }],
    ["mode enum", { mode: "resume" }],
    ["agents_invoked element", { agents_invoked: ["echo", 7] }],
    ["errors element", { errors: [42] }],
    ["unknown outer field", { invented_field: true }],
    ["unknown outer version", { schema_version: 99 }],
    ["unknown result version", { result: { schema_version: 99, met: true } }],
    ["unknown child field", { chain_results: [currentDetails({ unexpected: true })] }],
    ["unknown child version", { parallel_results: [currentDetails({ schema_version: 99 })] }],
  ])("rejects malformed current %s without prose fallback", (_label, overrides) => {
    const details = currentDetails(overrides);
    expect(parseSkillResultDetails(details)).toBeNull();
    expect(
      extractResultData(resultMessage(details, { content: JSON.stringify(CURRENT_SKILL_RESULT) }))
    ).toEqual({ status: "unknown", success: false });
  });

  it("retires pre-engine workflow-state and extension pause-adapter execution semantics", () => {
    // Structurally overlapping historical data may satisfy today's schema, but
    // historical workflow-state success inference and pause normalization are gone.
    expect(
      parseSkillResultDetails(currentDetails({ state: "report", result: undefined }))
    ).toMatchObject({ format: "current", status: "unknown" });
    expect(
      parseSkillResultDetails(
        currentDetails({
          success: false,
          result: undefined,
          state: "executing",
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
            run_id: "retired-run",
            recovery: {
              action: "recover",
              run_id: "retired-run",
              requires_dispatch_mode: "active",
              checkpoint_preserved: true,
            },
          },
        })
      )
    ).toBeNull();
  });

  it.each([false, true])(
    "recognizes canonical clarification without typed approval-question heuristics, native=%s",
    (native) => {
      expect(parseSkillResultDetails(clarification(native))).toMatchObject({
        format: "current",
        status: "paused",
        details: { continuation: { identity: { run_id: "exact-clarification-run" } } },
      });
      expect(
        parseSkillResultDetails({ ...clarification(native), continuation: undefined })
      ).toBeNull();
    }
  );

  it("represents honest statuses and never upgrades inconsistent terminal truth", () => {
    const dispatchPause = pause();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["success", currentDetails()],
      [
        "failure",
        currentDetails({
          success: false,
          state: "error",
          result: { met: false },
          errors: ["execution failed"],
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
          dispatch_pause: dispatchPause,
          recovery: dispatchPause.recovery,
          retriable: true,
        }),
      ],
      ["cancelled", currentDetails({ success: false, state: "cancelled", result: { met: false } })],
      ["unknown", currentDetails({ success: false, state: "executing", result: undefined })],
      ["unknown", currentDetails({ success: true, state: "complete", result: { met: false } })],
      ["unknown", currentDetails({ success: true, state: "incomplete", result: { met: true } })],
    ];
    for (const [expected, details] of cases)
      expect(extractResultData(resultMessage(details)).status).toBe(expected);
    expect(
      parseSkillResultDetails(
        currentDetails({
          success: false,
          state: "executing",
          result: undefined,
          dispatch_pause: { ...dispatchPause, retryable: false },
        })
      )
    ).toBeNull();
  });

  it("traverses every validated mixed-mode child with >128 invocation entries", () => {
    const single = currentDetails({ agents_invoked: Array.from({ length: 257 }, () => "echo") });
    const chain = currentDetails({
      skill_name: "chain",
      mode: "chain",
      result: undefined,
      chain_results: [single],
    });
    const parsed = parseSkillResultDetails(
      currentDetails({
        skill_name: "parallel",
        mode: "parallel",
        result: undefined,
        parallel_results: [chain, single],
      })
    );
    if (parsed === null) throw new Error("Expected a valid current aggregate");
    expect(collectValidatedSkillResultNodes(parsed).map((node) => node.skillName)).toEqual([
      "parallel",
      "chain",
      "code",
      "code",
    ]);
  });

  it("does not turn unknown status into unfinished work", () => {
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

  it("keeps an explicit transport error as failure and refuses transport success contradictions", () => {
    expect(
      extractResultData(resultMessage(undefined, { isError: true, content: '{"success":true}' }))
    ).toEqual({ status: "failure", success: false });
    expect(extractResultData(resultMessage(currentDetails(), { isError: true }))).toMatchObject({
      status: "unknown",
      success: false,
    });
  });
});

describe("exact skill call/result correlation", () => {
  it("uses one exact call/result ID pair", () => {
    expect(detectDominantSkill([skillCall(), resultMessage(currentDetails())])).toMatchObject({
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
