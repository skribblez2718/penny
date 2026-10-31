import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, InputArtifacts, StartRequest } from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { isProviderOpeningGuardId } from "../dist/provider-opening-guard.js";
import {
  SCA_P10_CANDIDATE_PLAYBOOK_NAME,
  SCA_P10_CANDIDATE_REGISTRATION,
} from "../dist/sca/p10-playbook.js";
import {
  SCA_P10_DISCLOSURE_ADMISSION_SCHEMA,
  SCA_P10_PROVIDER_OPENING_GUARD,
  SCA_P10_PROPOSING_STATE,
  SCA_P10_PROPOSER_AGENT,
  validateScaP10DisclosureAdmissionV1,
  validateScaP10DisclosureScopeV1,
  withP10Digest,
} from "../dist/sca/p10-contracts.js";
import {
  SCA_P10_PROVIDER_OPENING_ADAPTER,
  authorizeScaP10SerializedOpening,
  buildScaP10InlineOpeningAppendix,
} from "../dist/sca/p10-dispatch-guard.js";
import { buildScaP09Lineage } from "./sca-p09-lineage.js";
import { buildScaP10Lineage, driveScaP09 } from "./sca-p10-lineage.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const TASK = "Propose rule candidates.";
const COMPLETE = "Return the complete stage output in assistant text.";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p10-guard-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}
function readJson(artifacts: ArtifactStore, ref: ArtifactRef): unknown {
  return JSON.parse(artifacts.readById(ref.artifact_id).toString("utf8"));
}
function persistJson(
  artifacts: ArtifactStore,
  input: {
    readonly runId: string;
    readonly phase: string;
    readonly kind: string;
    readonly operationId: string;
    readonly schemaId: string;
    readonly value: unknown;
    readonly upstream?: readonly ArtifactRef[];
  }
): ArtifactRef {
  return artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: input.runId,
      phase: input.phase,
      branch_id: null,
      kind: input.kind,
      operation_id: input.operationId,
      version: 1,
      producer: "host:p10-guard-test",
      media_type: "application/json",
      content_schema: { schema_id: input.schemaId, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [...(input.upstream ?? [])],
    },
    content: canonicalJson(input.value),
  });
}

const COVERAGE_FULL: NonNullable<Parameters<typeof buildScaP09Lineage>[0]["coverage"]> = {
  entries: [
    { surface_kind: "normalized_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "graph_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "p04_selected_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "omitted_surface", coverage_state: "omitted", reason: "no omission candidate" },
  ],
};

interface Started {
  readonly artifacts: ArtifactStore;
  readonly run: RunContext;
  readonly payloadRef: ArtifactRef;
  readonly disclosureRef: ArtifactRef;
}

function start(runId: string): Started {
  const artifacts = store();
  const p09 = buildScaP09Lineage({
    store: artifacts,
    run_id: runId,
    kinds: ["source_query"],
    completed_indices: [0],
    disposition_for: () => "confirmed",
    repository_location_for: () => ({ path: "src/example.php", line_start: 10, line_end: 12 }),
    resolutions: "all_due" as const,
    coverage: COVERAGE_FULL,
  });
  const result = driveScaP09({ store: artifacts, p09 });
  const lineage = buildScaP10Lineage({
    store: artifacts,
    p09,
    p09_result: result,
    baseline_languages: ["php"],
  });
  const registration = SCA_P10_CANDIDATE_REGISTRATION;
  const startAdmission = required(registration.start_admission, "P10 start admission");
  const constraints = lineage.constraints;
  const slots: { slot: string; ref: ArtifactRef }[] = [];
  const push = (slot: string, ref: ArtifactRef | null | undefined): void => {
    if (ref !== null && ref !== undefined) slots.push({ slot, ref });
  };
  push("p09_terminal", constraints.p09_terminal_ref);
  push("p09_transition", constraints.p09_transition_ref);
  push("p09_reconciliation_ledger", constraints.p09_reconciliation_ledger_ref);
  push("p09_gate", constraints.p09_gate_ref);
  push("p09_admission", constraints.p09_admission_ref);
  push("p08_terminal", constraints.p08_terminal_ref);
  push("p08_transition", constraints.p08_transition_ref);
  push("p08_evidence_ledger", constraints.p08_evidence_ledger_ref);
  push("p08_gate", constraints.p08_gate_ref);
  push("p08_admission", constraints.p08_admission_ref);
  push("p08_item_universe", constraints.p08_item_universe_ref);
  push("p01_obligation_ledger", constraints.p01_obligation_ledger_ref);
  push("p09_coverage_input", constraints.p09_coverage_input_ref);
  constraints.p09_phase_evidence_refs.forEach((ref, index) => {
    push(`p09_phase_evidence_${String(index).padStart(4, "0")}`, ref);
  });
  push("p09_obligation_resolution", constraints.p09_obligation_resolution_ref);
  push("baseline_evidence", constraints.baseline_evidence_ref);
  push("disclosure_scope", constraints.disclosure_scope_ref);
  push("promotion_authority", constraints.promotion_authority_ref);
  const request: StartRequest = {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: SCA_P10_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise the inactive P10 opening guard.",
    constraints,
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted",
    input_artifacts: { schema_version: 2, artifacts: slots },
  };
  const prepared = startAdmission.prepare(request, {});
  const refs = startAdmission.materialize(prepared, {
    run_id: runId,
    artifactStore: artifacts,
    trustedClock: () => new Date("2026-09-26T00:00:06.000Z"),
  });
  const run = RunContext.create({
    identity: request.identity,
    goal: request.goal,
    constraints: {},
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 6,
    initialArtifacts: refs,
  });
  const playbook = required(
    registration.construct,
    "P10 construct"
  )({
    artifactStore: artifacts,
    trustedClock: () => new Date("2026-09-26T00:00:06.000Z"),
  });
  const directive = playbook.initialize(run);
  if (directive.action !== "invoke_agent") {
    throw new Error("expected the inactive P10 proposal directive");
  }
  return {
    artifacts,
    run,
    payloadRef: required(directive.input_artifacts.artifacts[0]?.ref, "payload ref"),
    disclosureRef: required(directive.input_artifacts.artifacts[1]?.ref, "disclosure ref"),
  };
}

function assignment(
  runId: string,
  payloadRef: ArtifactRef,
  disclosureRef: ArtifactRef
): {
  readonly registration_name: string;
  readonly run_id: string;
  readonly state_id: string;
  readonly branch_id: null;
  readonly agent: string;
  readonly task: string;
  readonly input_artifacts: InputArtifacts;
} {
  return {
    registration_name: SCA_P10_CANDIDATE_PLAYBOOK_NAME,
    run_id: runId,
    state_id: SCA_P10_PROPOSING_STATE,
    branch_id: null,
    agent: SCA_P10_PROPOSER_AGENT,
    task: TASK,
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "cognitive_payload", ref: payloadRef },
        { slot: "disclosure_admission", ref: disclosureRef },
      ],
    },
  };
}

/**
 * Mirrors the worker order: materialize the appendix, serialize the complete opening, authorize
 * it, and only then count a provider prompt. A denied authorization proves zero provider calls.
 */
function dispatchOpening(input: {
  readonly artifacts: ArtifactStore;
  readonly bound: ReturnType<typeof assignment>;
  readonly opening: string;
  readonly counter: { calls: number };
}): void {
  authorizeScaP10SerializedOpening({
    store: input.artifacts,
    assignment: input.bound,
    opening: input.opening,
  });
  input.counter.calls += 1;
}

describe("SCA P10 provider opening disclosure guard", () => {
  it("authorizes the exact host-projected serialized opening and rejects a substituted envelope", () => {
    using artifacts = store();
    const started = start("run-p10-guard-allow");
    const bound = assignment(
      started.run.identity.run_id,
      started.payloadRef,
      started.disclosureRef
    );
    const appendix = buildScaP10InlineOpeningAppendix({
      store: started.artifacts,
      assignment: bound,
    });
    const opening = `TASK:\n\n${TASK}\n\n${appendix}\n\n${COMPLETE}`;
    const authorization = authorizeScaP10SerializedOpening({
      store: started.artifacts,
      assignment: bound,
      opening,
    });
    expect(authorization.payload_ref.artifact_id).toBe(started.payloadRef.artifact_id);
    expect(authorization.disclosure_ref.artifact_id).toBe(started.disclosureRef.artifact_id);

    const tampered = opening.replace(
      `"agent":"${SCA_P10_PROPOSER_AGENT}"`,
      '"agent":"someone-else"'
    );
    expect(tampered).not.toBe(opening);
    expect(() =>
      authorizeScaP10SerializedOpening({
        store: started.artifacts,
        assignment: bound,
        opening: tampered,
      })
    ).toThrow();
    expect(
      SCA_P10_PROVIDER_OPENING_ADAPTER.matches(
        SCA_P10_CANDIDATE_PLAYBOOK_NAME,
        SCA_P10_PROPOSING_STATE,
        SCA_P10_PROPOSER_AGENT
      )
    ).toBe(true);
    expect(
      SCA_P10_PROVIDER_OPENING_ADAPTER.matches(
        SCA_P10_CANDIDATE_PLAYBOOK_NAME,
        SCA_P10_PROPOSING_STATE,
        "someone-else"
      )
    ).toBe(false);
    void artifacts;
  });

  it("makes zero provider calls for a denied disclosure, a mismatched binding, and an oversized opening", () => {
    using artifacts = store();
    const started = start("run-p10-guard-zero-call");
    const bound = assignment(
      started.run.identity.run_id,
      started.payloadRef,
      started.disclosureRef
    );
    const appendix = buildScaP10InlineOpeningAppendix({
      store: started.artifacts,
      assignment: bound,
    });
    const opening = `TASK:\n\n${TASK}\n\n${appendix}\n\n${COMPLETE}`;
    const counter = { calls: 0 };

    // A denied disclosure admission is refused before dispatch: zero provider calls.
    const allow = validateScaP10DisclosureAdmissionV1(
      readJson(started.artifacts, started.disclosureRef)
    );
    const { admission_sha256: _dropped, ...allowRest } = allow;
    void _dropped;
    const denied = withP10Digest(
      {
        ...allowRest,
        decision: "deny" as const,
        blocker_codes: ["p10_disclosure_scope_denied"],
      },
      "admission_sha256"
    );
    const deniedRef = persistJson(started.artifacts, {
      runId: started.run.identity.run_id,
      phase: SCA_P10_PROPOSING_STATE,
      kind: "sca-p10-disclosure-admission",
      operationId: "sca-p10-disclosure-admission-denied",
      schemaId: SCA_P10_DISCLOSURE_ADMISSION_SCHEMA,
      value: denied,
      upstream: [started.disclosureRef],
    });
    expect(() =>
      dispatchOpening({
        artifacts: started.artifacts,
        bound: assignment(started.run.identity.run_id, started.payloadRef, deniedRef),
        opening,
        counter,
      })
    ).toThrow();

    // A mismatched state/agent binding is refused before dispatch: zero provider calls.
    expect(() =>
      dispatchOpening({
        artifacts: started.artifacts,
        bound: { ...bound, agent: "someone-else" },
        opening,
        counter,
      })
    ).toThrow();

    // A serialized opening beyond the admitted per-call byte limit is refused: zero provider calls.
    const oversized = `${opening}${"x".repeat(900_000)}`;
    expect(() =>
      dispatchOpening({
        artifacts: started.artifacts,
        bound,
        opening: oversized,
        counter,
      })
    ).toThrow();

    expect(counter.calls).toBe(0);
    // The exact untampered opening still authorizes, so the refusals are policy, not a broken guard.
    dispatchOpening({ artifacts: started.artifacts, bound, opening, counter });
    expect(counter.calls).toBe(1);
    void artifacts;
  });

  it("refuses an unknown or non-uniquely bound provider opening guard literal", () => {
    expect(isProviderOpeningGuardId("sca_p99_payload_disclosure_v1")).toBe(false);
    expect(isProviderOpeningGuardId(SCA_P10_PROVIDER_OPENING_GUARD)).toBe(true);
    expect(SCA_P10_PROVIDER_OPENING_ADAPTER.id).toBe(SCA_P10_PROVIDER_OPENING_GUARD);
  });

  it("binds the guard to the disclosed payload and its admitted disclosure scope", () => {
    using artifacts = store();
    const started = start("run-p10-guard-scope");
    const disclosure = validateScaP10DisclosureAdmissionV1(
      readJson(started.artifacts, started.disclosureRef)
    );
    expect(disclosure.decision).toBe("allow");
    expect(disclosure.payload_ref.artifact_id).toBe(started.payloadRef.artifact_id);
    const scope = validateScaP10DisclosureScopeV1(
      readJson(started.artifacts, disclosure.disclosure_scope_ref)
    );
    expect(scope.decision).toBe("allow");
    expect(scope.max_payload_bytes_per_call).toBe(786_432);
    expect(scope.required_model.override).toBe("ollama/deepseek-v4.1-flash:cloud");
    void artifacts;
  });
});
