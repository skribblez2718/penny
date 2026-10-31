import { createHash } from "node:crypto";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MAX_SKILL_RESULT_BYTES,
  MAX_SKILL_RESULT_DEPTH,
  MAX_SKILL_RESULT_JSON_DEPTH,
  MAX_SKILL_RESULT_NODES,
  parseCurrentSkillResult,
  skillResultNodes,
  type SkillResult,
} from "../../../apps/orchestration/dist/index.js";
import type { SkillResult as ProducerSkillResult } from "../../extensions/skill/skill-utils.js";

function current(overrides: Partial<SkillResult> = {}): SkillResult {
  return {
    success: true,
    session_id: "run-current",
    skill_name: "define",
    state: "complete",
    requires_approval: false,
    steps_total: 1,
    agents_invoked: ["annie"],
    errors: [],
    result: { met: true, terminal_reason: null },
    ...overrides,
  };
}

function ref(kind: string, operationId = kind) {
  const identity = {
    branch_id: null,
    kind,
    operation_id: operationId,
    phase: "finalizing",
    run_id: "run-current",
    version: 1,
  };
  const digest = "a".repeat(64);
  return {
    schema_version: 2 as const,
    artifact_id: `art_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    ...identity,
    producer: "host:define",
    media_type: "application/json",
    content_digest: digest,
    byte_length: 1,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function clarification(native = false): SkillResult {
  return current({
    success: false,
    state: "clarifying_definition",
    result: undefined,
    continuation: {
      kind: "clarification",
      identity: {
        schema_version: 2,
        engine_owner: "typescript",
        run_id: "exact-run-not-inferred-from-session",
        session_id: "run-current",
        playbook: "define",
      },
      gate_id: "gate-current",
      challenge: "challenge-current",
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

function chainClarification(step = 1, native = false): SkillResult {
  const value = clarification(native);
  return current({
    skill_name: "chain",
    session_id: "chain-session",
    success: false,
    state: "awaiting_clarification",
    mode: "chain",
    result: undefined,
    continuation: value.continuation,
    escalation: value.escalation,
    chain_session_id: "chain-session",
    chain_step: step,
    chain_error_step: step,
    chain_total: 3,
    steps_total: 3,
    resumable: true,
    chain_results: Array.from({ length: step }, (_, index) =>
      current({
        session_id: `completed-${index}`,
        mode: "chain",
        chain_step: index,
        chain_total: 3,
        chain_session_id: "chain-session",
      })
    ),
  });
}

function repair(): NonNullable<SkillResult["repair_diagnostics"]> {
  return {
    origin_state: "reviewing",
    feedback_kind: "evidence_gap",
    budget: { used: 2, limit: null },
    feedback_report_refs: [ref("feedback-report")],
  };
}

function seal(): NonNullable<SkillResult["seal_diagnostics"]> {
  return {
    latest_diagnostic_ref: ref("seal-diagnostic"),
    rejected_draft_ref: ref("definition-draft"),
    epoch_anchor_ref: null,
    corrections_used: 2,
    correction_limit: 2,
    disposition: "exhausted",
  };
}

describe("shared current skill-result contract", () => {
  it("is the schema-derived producer type and preserves current results without reconstruction", () => {
    expectTypeOf<ProducerSkillResult>().toEqualTypeOf<SkillResult>();
    const value = current({
      input_assurance: {
        mode: "reviewed_definition",
        specification_artifact_id: ref("specification").artifact_id,
        assurance_ref: ref("composition-assurance"),
      },
      output_artifact_ref: ref("specification"),
    });
    expect(parseCurrentSkillResult(value)).toBe(value);
    const stateFailure = current({
      success: false,
      state: "error",
      result: undefined,
      errors: ["STATE_SCHEMA_INCOMPATIBLE"],
      state_failure: {
        code: "STATE_SCHEMA_INCOMPATIBLE",
        details: {
          component: "orchestration",
          actualSchemaVersion: 1,
          requiredSchemaVersion: 2,
          upgradeSupported: false,
          recoveryAction: "start from explicit inputs",
        },
      },
    });
    expect(parseCurrentSkillResult(stateFailure)).toBe(stateFailure);
    const negative = current({
      success: false,
      state: "incomplete",
      result: { met: false },
      repair_diagnostics: repair(),
      seal_diagnostics: seal(),
      output_artifact_ref: ref("definition-draft"),
      best_partial_artifact_refs: [ref("specification")],
    });
    expect(parseCurrentSkillResult(negative)).toBe(negative);
  });

  it.each([false, true])("preserves canonical clarification identity, native=%s", (native) => {
    const value = clarification(native);
    expect(parseCurrentSkillResult(value)).toBe(value);
    const chain = chainClarification(1, native);
    expect(parseCurrentSkillResult(chain)).toBe(chain);
    const first = chainClarification(0, native);
    expect(parseCurrentSkillResult(first)).toBe(first);
    const only = { ...first, chain_total: 1, steps_total: 1 };
    expect(parseCurrentSkillResult(only)).toBe(only);
    const last = chainClarification(2, native);
    expect(parseCurrentSkillResult(last)).toBe(last);
  });

  it.each([
    ["missing mode", { mode: undefined }],
    ["wrong mode", { mode: "single" }],
    ["spoofed wrapper skill", { skill_name: "define", session_id: "run-current" }],
    ["unclean session", { session_id: "chain\nsession", chain_session_id: "chain\nsession" }],
    ["missing chain session", { chain_session_id: undefined }],
    ["mismatched chain session", { chain_session_id: "other-chain" }],
    ["blank chain session", { session_id: "", chain_session_id: "" }],
    ["missing paused step", { chain_error_step: undefined }],
    ["out of range paused step", { chain_error_step: 3, chain_step: 3 }],
    ["negative paused step", { chain_error_step: -1, chain_step: -1 }],
    ["one-based/mismatched current step", { chain_step: 2 }],
    ["missing current step", { chain_step: undefined }],
    ["missing total", { chain_total: undefined }],
    ["empty chain", { chain_total: 0 }],
    ["inconsistent total", { steps_total: 4 }],
    ["not resumable", { resumable: false }],
    ["missing resumability", { resumable: undefined }],
    ["wrong state", { state: "complete" }],
    ["approval mixed with clarification", { requires_approval: true }],
    ["parallel children on a chain wait", { parallel_results: [current()] }],
    ["missing prefix", { chain_results: undefined }],
    ["short prefix", { chain_results: [] }],
    ["paused step included in prefix", { chain_results: [current(), clarification()] }],
    ["failed prefix", { chain_results: [current({ success: false })] }],
    [
      "negative terminal prefix",
      { chain_results: [current({ session_id: "prior", result: { met: false } })] },
    ],
    ["wrong prefix position", { chain_results: [current({ chain_step: 1 })] }],
    ["wrong prefix total", { chain_results: [current({ chain_total: 4 })] }],
    ["wrong prefix chain", { chain_results: [current({ chain_session_id: "other-chain" })] }],
    ["paused session reused in prefix", { chain_results: [current()] }],
    [
      "wrapper session reused in prefix",
      { chain_results: [current({ session_id: "chain-session" })] },
    ],
    [
      "duplicate prefix session",
      {
        chain_error_step: 2,
        chain_step: 2,
        chain_results: [current({ session_id: "prior" }), current({ session_id: "prior" })],
      },
    ],
  ])("rejects malformed chain clarification: %s", (_label, override) => {
    expect(() => parseCurrentSkillResult({ ...chainClarification(), ...override })).toThrow();
  });

  it.each([
    { session_id: "chain-session" },
    { run_id: "chain-session" },
    { playbook: "chain" },
    { playbook: "parallel" },
  ])("rejects a chain wrapper continuation identity %j", (identity) => {
    const chain = chainClarification();
    expect(() =>
      parseCurrentSkillResult({
        ...chain,
        continuation: {
          ...chain.continuation,
          identity: { ...chain.continuation?.identity, ...identity },
        },
      })
    ).toThrow();
  });

  it("preserves exact retry data as data, but refuses wrong identity and stale answers", () => {
    const value = clarification();
    const continuation = value.continuation;
    if (continuation === undefined) throw new Error("clarification fixture missing");
    const invocation = {
      skill_name: "define",
      session_id: value.session_id,
      goal: "Keep this exact goal",
      constraints: { mode: "create" },
      input_artifacts: [ref("input").artifact_id],
      model: "fixture/model",
    };
    value.continuation = { ...continuation, resume_invocation: invocation };
    expect(parseCurrentSkillResult(value)).toBe(value);
    for (const override of [
      { skill_name: "research" },
      { session_id: "other" },
      { constraints: { user_response: "forged answer" } },
    ])
      expect(() =>
        parseCurrentSkillResult({
          ...value,
          continuation: {
            ...value.continuation,
            resume_invocation: { ...invocation, ...override },
          },
        })
      ).toThrow();
  });

  it("accepts more than 128 invocations per leaf and concatenated aggregate, including mixed nesting", () => {
    const single = current({
      agents_invoked: Array.from({ length: 1025 }, () => "annie"),
      steps_total: 1025,
    });
    const chain = current({
      skill_name: "chain",
      mode: "chain",
      result: undefined,
      chain_results: [single, single],
      agents_invoked: [...single.agents_invoked, ...single.agents_invoked],
    });
    const parallel = current({
      skill_name: "parallel",
      mode: "parallel",
      result: undefined,
      parallel_results: [chain, single],
      agents_invoked: [...chain.agents_invoked, ...single.agents_invoked],
    });
    expect(parseCurrentSkillResult(parallel)).toBe(parallel);
    expect(skillResultNodes(parallel)).toHaveLength(5);
    expect(parseCurrentSkillResult(parallel).agents_invoked).toHaveLength(3075);
  });

  it.each([
    ["top-level", { unexpected: "sentinel" }],
    ["unknown top-level version", { schema_version: 99 }],
    ["unknown domain envelope version", { result: { schema_version: 99, met: true } }],
    ["domain met type", { result: { met: "true" } }],
    ["unknown mode", { mode: "resume" }],
    ["malformed history entry", { agents_invoked: [42] }],
    ["malformed error", { errors: [42] }],
    ["malformed display plan", { plan: [] }],
    [
      "malformed state failure",
      {
        state_failure: {
          code: "STATE_SCHEMA_INCOMPATIBLE",
          details: { component: "state", unknown: true },
        },
      },
    ],
    [
      "malformed assurance",
      {
        input_assurance: {
          mode: "semantic_only",
          specification_artifact_id: null,
          assurance_ref: ref("composition-assurance"),
        },
      },
    ],
    [
      "unknown assurance field",
      {
        input_assurance: {
          mode: "not_applicable",
          specification_artifact_id: null,
          assurance_ref: ref("composition-assurance"),
          certify_output: true,
        },
      },
    ],
    [
      "malformed repair",
      { success: false, repair_diagnostics: { ...repair(), budget: { used: -1, limit: null } } },
    ],
    [
      "unknown repair field",
      { success: false, repair_diagnostics: { ...repair(), diagnostic_body: "sentinel" } },
    ],
    ["malformed seal", { success: false, seal_diagnostics: { ...seal(), corrections_used: 3 } }],
    [
      "unknown seal field",
      { success: false, seal_diagnostics: { ...seal(), diagnostic_body: "sentinel" } },
    ],
    [
      "noncanonical artifact",
      { output_artifact_ref: { ...ref("specification"), artifact_id: `art_${"b".repeat(64)}` } },
    ],
    [
      "unknown artifact version",
      { output_artifact_ref: { ...ref("specification"), schema_version: 1, consumer_scope: [] } },
    ],
    ["malformed nested current", { chain_results: [{ ...current(), unexpected: true }] }],
    ["unknown nested version", { parallel_results: [{ ...current(), schema_version: 99 }] }],
    ["legacy workflow-state success", { state: "report", requires_approval: undefined }],
  ])("rejects %s without stripping fields", (_label, override) => {
    expect(() => parseCurrentSkillResult({ ...current(), ...override })).toThrow();
  });

  it.each([
    ["missing discriminator and run address", { continuation: undefined }],
    [
      "unknown continuation field",
      { continuation: { ...clarification().continuation, run_id: "invented" } },
    ],
    [
      "unknown continuation kind",
      { continuation: { ...clarification().continuation, kind: "native" } },
    ],
    [
      "unknown identity version",
      {
        continuation: {
          ...clarification().continuation,
          identity: { ...clarification().continuation?.identity, schema_version: 99 },
        },
      },
    ],
    ["wrong skill binding", { skill_name: "research" }],
    ["wrong session binding", { session_id: "other-session" }],
    [
      "unknown question field",
      {
        escalation: {
          questions: [{ id: "scope", label: "scope", prompt: "Scope?", unknown: true }],
        },
      },
    ],
  ])("rejects clarification %s", (_label, override) => {
    expect(() => parseCurrentSkillResult({ ...clarification(true), ...override })).toThrow();
  });

  it("bounds aggregate depth and total nodes instead of silently losing tail references", () => {
    let root = current();
    for (let depth = 0; depth < MAX_SKILL_RESULT_DEPTH; depth++)
      root = current({ chain_results: [root] });
    expect(parseCurrentSkillResult(root)).toBe(root);
    expect(() => parseCurrentSkillResult(current({ chain_results: [root] }))).toThrow();
    const atLimit = current({
      parallel_results: Array.from({ length: MAX_SKILL_RESULT_NODES - 1 }, () => current()),
    });
    expect(skillResultNodes(parseCurrentSkillResult(atLimit))).toHaveLength(MAX_SKILL_RESULT_NODES);
    expect(() =>
      parseCurrentSkillResult(
        current({ parallel_results: [...(atLimit.parallel_results ?? []), current()] })
      )
    ).toThrow();
  });

  it("uses a serialized-byte boundary for invocation history, not an invocation-count policy", () => {
    const value = current({ agents_invoked: Array.from({ length: 4070 }, () => "a".repeat(1024)) });
    value.agents_invoked.push("");
    const room = MAX_SKILL_RESULT_BYTES - Buffer.byteLength(JSON.stringify(value), "utf8");
    if (room <= 0 || room > 32_768) throw new Error("Invalid byte-boundary fixture");
    value.agents_invoked[value.agents_invoked.length - 1] = "a".repeat(room);
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBe(MAX_SKILL_RESULT_BYTES);
    expect(parseCurrentSkillResult(value)).toBe(value);
    value.agents_invoked[value.agents_invoked.length - 1] += "a";
    expect(() => parseCurrentSkillResult(value)).toThrow();
  });

  it("rejects cycles, deep domain JSON, non-JSON/accessors and oversized serialized histories before recursive validation", () => {
    const cyclic = current();
    cyclic.chain_results = [cyclic];
    expect(() => parseCurrentSkillResult(cyclic)).toThrow();
    let deep: unknown = null;
    for (let i = 0; i <= MAX_SKILL_RESULT_JSON_DEPTH; i++) deep = { nested: deep };
    expect(() => parseCurrentSkillResult({ ...current(), plan: { deep } })).toThrow();
    expect(() =>
      parseCurrentSkillResult({ ...current(), result: { met: true, bad: Number.NaN } })
    ).toThrow();
    expect(() =>
      parseCurrentSkillResult({ ...current(), result: { met: true, bad: () => "never execute" } })
    ).toThrow();
    let invoked = false;
    const accessor = Object.defineProperty({}, "met", {
      enumerable: true,
      get: () => {
        invoked = true;
        return true;
      },
    });
    expect(() => parseCurrentSkillResult({ ...current(), result: accessor })).toThrow();
    expect(invoked).toBe(false);
    expect(() =>
      parseCurrentSkillResult(
        current({
          agents_invoked: Array.from({ length: Math.ceil(MAX_SKILL_RESULT_BYTES / 1024) }, () =>
            "a".repeat(1024)
          ),
        })
      )
    ).toThrow();
  });
});
