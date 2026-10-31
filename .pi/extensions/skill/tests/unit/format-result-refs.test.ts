/**
 * `formatResult` builds the ONLY model-visible text the skill tool returns.
 * `details.output_artifact_ref` reaches renderers but never a provider, so the
 * terminal artifact id has to appear in this string or it cannot be read back.
 */

import { describe, expect, it } from "vitest";

import {
  artifactDispatchRecoveryV1,
  parseArtifactDispatchMode,
  parseArtifactDispatchPause,
  type ArtifactDispatchPauseV1,
  type ArtifactDispatchRecoveryV1,
} from "@penny/orchestration";
import { artifactIdFor } from "../../artifact-client.js";
import {
  formatResult,
  parseRepairDiagnostics,
  parseSealDiagnostics,
  type SkillResult,
} from "../../skill-utils.js";

const plain = (_color: string, text: string) => text;
const ARTIFACT_ID = `art_${"c".repeat(64)}`;

function ref(id: string) {
  return {
    schema_version: 2,
    artifact_id: id,
    run_id: "run-1",
    phase: "complete",
    branch_id: null,
    kind: "agent-output",
    operation_id: "op-1",
    version: 1,
    producer: "agent:skribble",
    media_type: "text/markdown; charset=utf-8",
    byte_length: 42,
    content_digest: "d".repeat(64),
    store_ref: `artifact://sha256/${"d".repeat(64)}`,
  } as SkillResult["output_artifact_ref"];
}

function baseResult(overrides: Partial<SkillResult> = {}): SkillResult {
  return {
    success: true,
    session_id: "sess-1",
    skill_name: "research",
    state: "complete",
    requires_approval: false,
    steps_total: 3,
    agents_invoked: ["echo", "synthia", "skribble"],
    errors: [],
    ...overrides,
  } as SkillResult;
}

function pause(
  kind: ArtifactDispatchRecoveryV1["kind"],
  checkpointExists: boolean,
  configured: "paused" | "invalid" = "paused"
): ArtifactDispatchPauseV1 {
  const identity = {
    schema_version: 2 as const,
    run_id: `run-${kind}`,
    session_id: `session-${kind}`,
    playbook: "research",
    engine_owner: "typescript" as const,
  };
  const dispatch = parseArtifactDispatchMode(
    kind === "saved_but_ineligible" ? "active" : configured === "invalid" ? " padded " : "paused"
  );
  const legacyReason = "active legacy run has no durable liveness policy; recovery is paused";
  const reason = kind === "saved_but_ineligible" ? legacyReason : dispatch.reason;
  const stateId = kind === "start_retry" ? "intake" : "researching";
  const recovery =
    kind === "saved_but_ineligible"
      ? artifactDispatchRecoveryV1({
          identity,
          stateId,
          reason,
          kind,
          checkpointExists,
          ineligibilityCode: "LEGACY_UNMETERED",
        })
      : artifactDispatchRecoveryV1({
          identity,
          stateId,
          reason,
          kind,
          checkpointExists,
        });
  return {
    schema_version: 2,
    pause_schema_version: 1,
    action: "paused",
    identity,
    status: "running",
    state_id: stateId,
    code:
      kind === "saved_but_ineligible"
        ? "LEGACY_UNMETERED"
        : configured === "invalid"
          ? "DISPATCH_MODE_INVALID"
          : "DISPATCH_PAUSED",
    reason,
    retryable: kind !== "saved_but_ineligible",
    dispatch,
    recovery,
  };
}

function historicalPause(checkpointPreserved: boolean): ArtifactDispatchPauseV1 {
  return parseArtifactDispatchPause({
    schema_version: 2,
    action: "paused",
    identity: {
      schema_version: 2,
      run_id: "run-historical-pause",
      session_id: "session-historical-pause",
      playbook: "research",
      engine_owner: "typescript",
    },
    status: "running",
    state_id: "researching",
    code: "DISPATCH_PAUSED",
    reason: "historical dispatch pause",
    retryable: true,
    recovery: {
      action: "recover",
      run_id: "run-historical-pause",
      checkpoint_preserved: checkpointPreserved,
    },
  });
}

function sealProjection(runId = "run-1") {
  const draft = ref(ARTIFACT_ID);
  if (draft === undefined) throw new Error("missing draft ref");
  const rejected = { ...draft, run_id: runId, kind: "specification-draft" };
  rejected.artifact_id = artifactIdFor(rejected);
  const latest = { ...draft, run_id: runId, kind: "seal-diagnostic" };
  latest.artifact_id = artifactIdFor(latest);
  return {
    latest_diagnostic_ref: latest,
    rejected_draft_ref: rejected,
    epoch_anchor_ref: null,
    corrections_used: 1,
    correction_limit: 1,
    disposition: "exhausted" as const,
  };
}

describe("seal diagnostic presentation", () => {
  it("parses and renders unspecified allowances without inventing exhaustion", () => {
    const projection = {
      ...sealProjection(),
      correction_limit: null,
      corrections_used: 20,
      disposition: "correction_offered",
    };
    expect(parseSealDiagnostics(projection)).toEqual(projection);
    expect(() => parseSealDiagnostics({ ...projection, disposition: "exhausted" })).toThrow();
    const repair = {
      origin_state: "verifying",
      feedback_kind: "product_gap",
      budget: { used: 20, limit: null },
      feedback_report_refs: [],
    };
    expect(parseRepairDiagnostics(repair)).toEqual(repair);
    const text = formatResult(
      baseResult({
        success: false,
        seal_diagnostics: parseSealDiagnostics(projection),
        repair_diagnostics: parseRepairDiagnostics(repair),
      }),
      plain
    );
    expect(text).toContain("Corrections used 20/unlimited");
    expect(text).toContain("budget used 20/unlimited");
    expect(text).not.toContain("allowance exhausted");
  });

  it("parses only structured refs and refuses invalid ref/counter bindings", () => {
    const projection = sealProjection();
    expect(parseSealDiagnostics(projection)).toEqual(projection);
    expect(() =>
      parseSealDiagnostics({ ...projection, latest_diagnostic_ref: projection.rejected_draft_ref })
    ).toThrow();
    expect(() =>
      parseSealDiagnostics({
        ...projection,
        rejected_draft_ref: { ...projection.rejected_draft_ref, artifact_id: "forged" },
      })
    ).toThrow();
    expect(() => parseSealDiagnostics({ ...projection, corrections_used: 2 })).toThrow();
    expect(() =>
      parseSealDiagnostics({
        ...projection,
        epoch_anchor_ref: { ...projection.rejected_draft_ref, run_id: "other-run" },
      })
    ).toThrow();
  });

  it("distinguishes a rejected draft, prior accepted product and semantic repair evidence", () => {
    const projection = sealProjection();
    const prior = { ...projection.rejected_draft_ref, kind: "semantic-core", version: 2 };
    prior.artifact_id = artifactIdFor(prior);
    const text = formatResult(
      baseResult({
        success: false,
        state: "incomplete",
        result: { met: false, output_kind: "rejected_draft_best_partial", payload: "PRIVATE BODY" },
        errors: [],
        output_artifact_ref: projection.rejected_draft_ref,
        best_partial_artifact_refs: [projection.rejected_draft_ref],
        seal_diagnostics: { ...projection, epoch_anchor_ref: prior },
        repair_diagnostics: {
          origin_state: "verifying",
          feedback_kind: "product_gap",
          budget: { used: 2, limit: 2 },
          feedback_report_refs: [],
        },
      }),
      plain
    );
    expect(text).toContain(
      `rejected draft — not an accepted product): ${projection.rejected_draft_ref.artifact_id}`
    );
    expect(text).toContain(`Prior accepted product: ${prior.artifact_id}`);
    expect(text).toContain(`diagnostic: ${projection.latest_diagnostic_ref.artifact_id}`);
    expect(text).toContain(
      "Seal diagnostics (research): Draft rejected by deterministic seal; correction allowance exhausted."
    );
    expect(text).toContain("Corrections used 1/1");
    expect(text).toContain("Repair diagnostics (research): verifying:product_gap");
    expect(text).not.toContain("PRIVATE BODY");
  });

  it("labels first-epoch rejection without implying any canonical product", () => {
    const projection = sealProjection();
    const text = formatResult(
      baseResult({
        success: false,
        result: { met: false, output_kind: "rejected_draft" },
        output_artifact_ref: projection.rejected_draft_ref,
        seal_diagnostics: projection,
      }),
      plain
    );
    expect(text).toContain("No accepted sealed product in this run.");
    expect(text).not.toContain("Prior accepted product:");
  });

  it("renders nested parallel/chain failures without promoting a rejected draft on the aggregate", () => {
    const projection = sealProjection();
    const failed = baseResult({
      success: false,
      state: "incomplete",
      result: { met: false, output_kind: "rejected_draft" },
      output_artifact_ref: projection.rejected_draft_ref,
      seal_diagnostics: projection,
    });
    const text = formatResult(
      baseResult({
        success: false,
        output_artifact_ref: projection.rejected_draft_ref,
        chain_results: [failed],
        parallel_results: [failed],
      }),
      plain
    );
    expect(text).toContain(`Seal diagnostics (parallel 1: research):`);
    expect(text).toContain(`Seal diagnostics (chain step 1: research):`);
    expect(text).toContain("rejected draft — not an accepted product");
    expect(text).not.toContain(
      `Exact output artifact: ${projection.rejected_draft_ref.artifact_id}`
    );
  });
});

describe("repair diagnostic presentation", () => {
  it("parses exact refs and refuses malformed or oversized projections", () => {
    const template = ref(ARTIFACT_ID);
    if (template === undefined) throw new Error("missing report ref");
    const report = { ...template, artifact_id: artifactIdFor(template) };
    const diagnostic = {
      origin_state: "verifying",
      feedback_kind: "product_gap",
      budget: { used: 1, limit: 2 },
      feedback_report_refs: [report],
    };
    expect(parseRepairDiagnostics(diagnostic).feedback_report_refs).toEqual([report]);
    expect(() =>
      parseRepairDiagnostics({
        ...diagnostic,
        feedback_report_refs: [{ ...report, artifact_id: "forged" }],
      })
    ).toThrow();
    expect(() =>
      parseRepairDiagnostics({ ...diagnostic, feedback_report_refs: Array(129).fill(report) })
    ).toThrow();
  });
  it("shows exact feedback separately for nested parallel and chain results", () => {
    const report = ref(ARTIFACT_ID);
    if (report === undefined) throw new Error("missing report ref");
    const child = baseResult({
      success: false,
      state: "incomplete",
      result: { met: false },
      repair_diagnostics: {
        origin_state: "verifying",
        feedback_kind: "product_gap",
        budget: { used: 2, limit: 2 },
        feedback_report_refs: [report],
      },
    });
    const text = formatResult(
      baseResult({
        success: false,
        chain_results: [baseResult({ success: false, parallel_results: [child] })],
      }),
      plain
    );
    expect(text).toContain(
      "Repair diagnostics (parallel 1: research): verifying:product_gap; budget used 2/2"
    );
    expect(text).toContain(`Feedback report artifact: ${ARTIFACT_ID}`);
    expect(text).toContain(`artifact_read({"artifact":"${ARTIFACT_ID}"})`);
    expect(text).not.toContain("Exact output artifact (best partial)");
  });

  it("says when an exhausted receipt has no feedback report; success has no diagnostics", () => {
    const negative = baseResult({
      success: false,
      result: { met: false },
      repair_diagnostics: {
        origin_state: "verifying",
        feedback_kind: "evidence_gap",
        budget: { used: 1, limit: 1 },
        feedback_report_refs: [],
      },
    });
    expect(formatResult(negative, plain)).toContain(
      "Feedback report: not available for this receipt."
    );
    expect(formatResult(baseResult(), plain)).not.toContain("Repair diagnostics");
  });
});

describe("formatResult exact-artifact visibility", () => {
  it("reports actual input assurance without claiming output or ancestor certification", () => {
    const original = ref(`art_${"a".repeat(64)}`);
    if (original === undefined) throw new Error("missing assurance fixture ref");
    const assuranceRef = { ...original, kind: "composition-assurance" };
    const text = formatResult(
      baseResult({
        skill_name: "plan",
        output_artifact_ref: ref(ARTIFACT_ID),
        input_assurance: {
          mode: "semantic_only",
          specification_artifact_id: `art_${"b".repeat(64)}`,
          assurance_ref: assuranceRef,
        },
      }),
      plain
    );
    expect(text).toContain("plan input specification assurance: semantic_only");
    expect(text).toContain(assuranceRef.artifact_id);
    expect(text).toContain("does not certify the output or its earlier ancestors");
    expect(text).not.toContain("reviewed_definition");
  });

  it("names the terminal artifact id on success", () => {
    const text = formatResult(baseResult({ output_artifact_ref: ref(ARTIFACT_ID) }), plain);
    expect(text).toContain(ARTIFACT_ID);
    expect(text).toContain(`artifact_read({"artifact":"${ARTIFACT_ID}"})`);
  });

  it("names the plan artifact id when approval is required", () => {
    const text = formatResult(
      baseResult({
        requires_approval: true,
        plan_steps: [{ step: 1, title: "Gather sources" }],
        output_artifact_ref: ref(ARTIFACT_ID),
      }),
      plain
    );
    // Approval guidance must include the exact plan ID; a name-only pointer is unactionable.
    expect(text).toContain("artifact_read");
    expect(text).toContain(ARTIFACT_ID);
  });

  it("prints every parallel and chain-step output ID", () => {
    const parallelId = `art_${"a".repeat(64)}`;
    const chainId = `art_${"b".repeat(64)}`;
    const text = formatResult(
      baseResult({
        parallel_results: [
          baseResult({ skill_name: "research-a", output_artifact_ref: ref(parallelId) }),
        ],
        chain_results: [
          baseResult({
            skill_name: "research-b",
            chain_step: 1,
            output_artifact_ref: ref(chainId),
          }),
        ],
      }),
      plain
    );
    expect(text).toContain(parallelId);
    expect(text).toContain(chainId);
    expect(text).toContain("parallel 1");
    expect(text).toContain("chain step 2");
  });

  it("names every best partial on an honest negative terminal", () => {
    const first = `art_${"e".repeat(64)}`;
    const second = `art_${"f".repeat(64)}`;
    const text = formatResult(
      baseResult({
        success: false,
        state: "cancelled",
        result: { met: false },
        best_partial_artifact_refs: [ref(first), ref(second)].filter(
          (value): value is NonNullable<SkillResult["output_artifact_ref"]> => value !== undefined
        ),
      }),
      plain
    );
    expect(text).toContain(first);
    expect(text).toContain(second);
    expect(text).toContain("best partial 1");
    expect(text).toContain("best partial 2");
  });

  it("renders explicit unknown-effect limitations and bounded-scope notices", () => {
    const text = formatResult(
      baseResult({
        result: {
          met: true,
          effect_assurance: "unknown",
          effect_limitation:
            "Effect status is unknown; completion does not establish full confinement.",
          effect_scope_notice:
            "Evidence is bounded to worker/run/phase scope and does not establish full filesystem or process confinement.",
        },
      }),
      plain
    );
    expect(text).toContain("Effect limitation: Effect status is unknown");
    expect(text).toContain("Effect scope: Evidence is bounded");
    expect(text).toContain("does not establish full filesystem or process confinement");
  });

  it("adds nothing when the run produced no artifact", () => {
    const text = formatResult(baseResult(), plain);
    expect(text).not.toContain("Exact output artifact");
    expect(text).not.toContain("art_");
  });

  it("stays bounded: two short lines per result", () => {
    const withRef = formatResult(baseResult({ output_artifact_ref: ref(ARTIFACT_ID) }), plain);
    const without = formatResult(baseResult(), plain);
    expect(withRef.length - without.length).toBeLessThan(220);
  });
});

describe("formatResult dispatch recovery facts", () => {
  it("renders a checkpointless start as retry, never recovery", () => {
    const dispatchPause = pause("start_retry", false, "invalid");
    const text = formatResult(
      baseResult({
        success: false,
        state: "intake",
        dispatch_pause: dispatchPause,
        recovery: dispatchPause.recovery,
        retriable: true,
      }),
      plain
    );
    expect(text).toContain(`Run: ${dispatchPause.identity.run_id}`);
    expect(text).toContain(`Session: ${dispatchPause.identity.session_id}`);
    expect(text).toContain("Checkpoint exists: false; resumable: false");
    expect(text).toContain("No engine checkpoint exists for this attempted start");
    expect(text).toContain("retry the original research start");
    expect(text).toContain("invalid (fails closed as paused)");
    expect(text).not.toContain("then recover run");
  });

  it("distinguishes an admission row from a resumable checkpoint", () => {
    const dispatchPause = pause("start_retry", true);
    const text = formatResult(
      baseResult({
        success: false,
        state: "intake",
        dispatch_pause: dispatchPause,
        recovery: dispatchPause.recovery,
        retriable: true,
      }),
      plain
    );
    expect(text).toContain("Checkpoint exists: true; resumable: false");
    expect(text).toContain("An admission checkpoint row exists");
    expect(text).not.toContain("then recover run");
  });

  it("renders the exact recoverable run, session, and state", () => {
    const dispatchPause = pause("recoverable_checkpoint", true);
    const text = formatResult(
      baseResult({
        success: false,
        state: "researching",
        dispatch_pause: dispatchPause,
        recovery: dispatchPause.recovery,
        retriable: true,
      }),
      plain
    );
    expect(text).toContain("Checkpoint exists: true; resumable: true");
    expect(text).toContain(`recover run ${dispatchPause.identity.run_id}`);
    expect(text).toContain(`session ${dispatchPause.identity.session_id}`);
    expect(text).toContain("from state researching");
  });

  it("renders LEGACY_UNMETERED as saved but ineligible with status/cancel only", () => {
    const dispatchPause = pause("saved_but_ineligible", true);
    const text = formatResult(
      baseResult({
        success: false,
        state: "researching",
        dispatch_pause: dispatchPause,
        recovery: dispatchPause.recovery,
        retriable: false,
      }),
      plain
    );
    expect(text).toContain("LEGACY_UNMETERED");
    expect(text).toContain("Checkpoint exists: true; resumable: false");
    expect(text).toContain("not eligible to resume");
    expect(text).toContain("use status or cancel");
    expect(text).not.toContain("then recover run");
  });

  it.each([true, false])(
    "renders a historical checkpoint_preserved=%s claim as unverified status/cancel only",
    (checkpointPreserved) => {
      const dispatchPause = historicalPause(checkpointPreserved);
      const text = formatResult(
        baseResult({
          success: false,
          state: "researching",
          dispatch_pause: dispatchPause,
          recovery: dispatchPause.recovery,
          retriable: false,
        }),
        plain
      );
      expect(text).toContain("LEGACY_CHECKPOINT_UNVERIFIED");
      expect(text).toContain("Checkpoint exists: unverified; resumable: false");
      expect(text).toContain(
        `Historical checkpoint_preserved claim: ${String(checkpointPreserved)}`
      );
      expect(text).toContain("use status or cancel");
      expect(text).not.toContain("recover run");
      expect(text).not.toContain("Checkpoint exists: true");
    }
  );
});
