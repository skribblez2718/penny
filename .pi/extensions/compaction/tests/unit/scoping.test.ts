import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  collectExactRunIds,
  collectExplicitRunIds,
  deriveErrorRefs,
  parsePriorMemoryIds,
  parsePriorRunIds,
  parseResumeRefs,
} from "../../index.js";
import type { SessionMessage } from "../../pi-messages.js";

function artifactRef(runId: string, operationId: string) {
  const identity = {
    branch_id: null,
    kind: "agent-output",
    operation_id: operationId,
    phase: "finalizing",
    run_id: runId,
    version: 1,
  };
  const digest = "a".repeat(64);
  return {
    schema_version: 2,
    artifact_id: `art_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    ...identity,
    producer: "agent:fixture",
    media_type: "text/markdown; charset=utf-8",
    byte_length: 12,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function skillExchange(id: string, overrides: Record<string, unknown> = {}): SessionMessage[] {
  const details = {
    success: true,
    session_id: `session-${id}`,
    skill_name: "code",
    state: "complete",
    requires_approval: false,
    steps_total: 1,
    agents_invoked: ["fixture-agent"],
    errors: [],
    ...overrides,
  };
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id,
          name: "skill",
          arguments: { skill_name: "code", goal: `Goal ${id}` },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "skill",
      toolCallId: id,
      content: "Structured skill result",
      details,
    },
  ];
}

describe("exact run-id collection", () => {
  it("collects only explicit run IDs from validated, exactly paired skill fields", () => {
    const firstRef = artifactRef("run-one", "final-1");
    const secondRef = artifactRef("run-two", "partial-1");
    const ids = collectExplicitRunIds([
      ...skillExchange("tc-1", {
        result: {
          met: true,
          output_artifact_ref: firstRef,
          best_partial_artifact_refs: [secondRef],
        },
        output_artifact_ref: firstRef,
        best_partial_artifact_refs: [secondRef],
      }),
      ...skillExchange("tc-2", {
        success: false,
        state: "awaiting_clarification",
        continuation: {
          kind: "clarification",
          identity: {
            schema_version: 2,
            engine_owner: "typescript",
            run_id: "run-three",
            session_id: "session-tc-2",
            playbook: "code",
          },
          gate_id: "gate-three",
          challenge: "challenge-three",
        },
        escalation: { questions: [{ id: "q", label: "Q1", prompt: "Scope?" }] },
      }),
      {
        role: "toolResult",
        toolName: "read",
        content: JSON.stringify({ run_id: "untrusted-tool" }),
      },
    ]);
    expect(ids.sort()).toEqual(["run-one", "run-three", "run-two"]);
  });

  it.each([false, true])(
    "collects canonical single and chain clarification addresses, native=%s",
    (native) => {
      const paused = {
        success: false,
        session_id: "step-session",
        skill_name: "code",
        state: "clarifying",
        requires_approval: false,
        steps_total: 257,
        agents_invoked: Array.from({ length: 257 }, () => "echo"),
        errors: [],
        continuation: {
          kind: "clarification",
          identity: {
            schema_version: 2,
            engine_owner: "typescript",
            run_id: "paused-step-run",
            session_id: "step-session",
            playbook: "code",
          },
          gate_id: "gate-step",
          challenge: "challenge-step",
        },
        escalation: {
          questions: [
            {
              id: "q",
              label: "Q1",
              prompt: "Scope?",
            },
          ],
          ...(native ? { trustedTransportCapability: "fixture-native-capability" } : {}),
        },
      };
      expect(collectExplicitRunIds(skillExchange("single-pause", paused))).toEqual([
        "paused-step-run",
      ]);
      expect(
        collectExplicitRunIds(
          skillExchange("obsolete-question-address", {
            ...paused,
            escalation: {
              questions: [
                {
                  id: "q",
                  label: "Q1",
                  prompt: "Scope?",
                  approval_run_id: "not-a-continuation-source",
                },
              ],
            },
          })
        )
      ).toEqual([]);
      expect(
        collectExplicitRunIds(
          skillExchange("chain-pause", {
            ...paused,
            skill_name: "chain",
            mode: "chain",
            state: "awaiting_clarification",
            session_id: "chain-session",
            chain_session_id: "chain-session",
            chain_total: 2,
            steps_total: 2,
            chain_error_step: 0,
            chain_step: 0,
            resumable: true,
            chain_results: [],
          })
        )
      ).toEqual(["paused-step-run"]);
      expect(
        collectExplicitRunIds(
          skillExchange("parallel-pause", {
            success: false,
            state: "partial",
            skill_name: "parallel",
            mode: "parallel",
            parallel_results: [paused],
          })
        )
      ).toEqual(["paused-step-run"]);
    }
  );

  it("collects output/partial refs from mixed nested aggregates with long invocation history", () => {
    const output = artifactRef("nested-terminal-run", "output");
    const partial = artifactRef("nested-partial-run", "partial");
    const child = {
      success: false,
      session_id: "nested-session",
      skill_name: "code",
      state: "incomplete",
      requires_approval: false,
      steps_total: 300,
      agents_invoked: Array.from({ length: 300 }, () => "echo"),
      errors: [],
      result: { met: false },
      output_artifact_ref: output,
      best_partial_artifact_refs: [partial],
      repair_diagnostics: {
        origin_state: "reviewing",
        feedback_kind: "evidence_gap",
        budget: { used: 1, limit: null },
        feedback_report_refs: [],
      },
    };
    const messages = skillExchange("nested", {
      skill_name: "parallel",
      mode: "parallel",
      parallel_results: [{ ...child, skill_name: "chain", mode: "chain", chain_results: [child] }],
    });
    expect(collectExplicitRunIds(messages)).toEqual(["nested-terminal-run", "nested-partial-run"]);
    const malformed = skillExchange("malformed-child", {
      result: { met: true },
      output_artifact_ref: artifactRef("must-not-leak", "outer"),
      chain_results: [{ ...child, unknown: true }],
    });
    expect(collectExplicitRunIds(malformed)).toEqual([]);
  });

  it("does not infer a run from session IDs or malformed prose", () => {
    expect(
      collectExplicitRunIds([
        ...skillExchange("tc-1"),
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-2",
              name: "skill",
              arguments: { skill_name: "code", goal: "Malformed result" },
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "skill",
          toolCallId: "tc-2",
          content: JSON.stringify({ run_id: "prose-only-run" }),
        },
      ])
    ).toEqual([]);
  });

  it("carries exact run IDs through a strict v2 refs block", () => {
    const prior = [
      "## Goal",
      "Continue",
      "[RESUME-REFS v2]",
      "run:run-prior",
      `artifact:art_${"a".repeat(64)}@sha256:${"b".repeat(64)}`,
      "memory:drawer-explicit-1",
      "[/RESUME-REFS]",
    ].join("\n");
    expect(parsePriorRunIds(prior)).toEqual(["run-prior"]);
    expect(parsePriorMemoryIds(prior)).toEqual(["drawer-explicit-1"]);
    const currentRef = artifactRef("run-new", "final-current");
    expect(
      collectExactRunIds(
        skillExchange("tc-current", {
          result: { met: true, output_artifact_ref: currentRef },
          output_artifact_ref: currentRef,
        }),
        prior
      ).sort()
    ).toEqual(["run-new", "run-prior"]);
  });
});

describe("strict resume-ref parsing", () => {
  it("rejects unsupported versions, unknown lines, invalid refs, and duplicates", () => {
    expect(() => parseResumeRefs("[RESUME-REFS v1]\nrun:x\n[/RESUME-REFS]")).toThrow("unsupported");
    expect(() => parseResumeRefs("[RESUME-REFS v2]\nroom:x\n[/RESUME-REFS]")).toThrow("invalid");
    expect(() =>
      parseResumeRefs("[RESUME-REFS v2]\nartifact:art_bad@sha256:nope\n[/RESUME-REFS]")
    ).toThrow("invalid");
    expect(() => parseResumeRefs("[RESUME-REFS v2]\nrun:x\nrun:x\n[/RESUME-REFS]")).toThrow(
      "duplicate"
    );
  });
});

describe("deriveErrorRefs", () => {
  const errorResult = (tool: string, message: string) => ({
    role: "toolResult",
    toolName: tool,
    isError: true,
    content: message,
  });
  const okResult = (tool: string) => ({
    role: "toolResult",
    toolName: tool,
    isError: false,
    content: "ok",
  });

  it("marks an error unresolved when no later same-tool success follows", () => {
    const refs = deriveErrorRefs([errorResult("bash", "command failed: boom")]);
    expect(refs).toEqual([
      {
        error_type: "bash",
        message: "command failed: boom",
        turn_id: "unknown",
        resolved: false,
      },
    ]);
  });

  it("marks an error resolved when a later same-tool call succeeds", () => {
    const refs = deriveErrorRefs([errorResult("edit", "validation failed"), okResult("edit")]);
    expect(refs[0].resolved).toBe(true);
  });
});
