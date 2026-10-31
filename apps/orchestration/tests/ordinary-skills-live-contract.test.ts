import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeDecisionRequest } from "../dist/skill-contracts/decide.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, InputArtifacts } from "../dist/contracts.js";
import {
  COHORTS,
  EXPECTED_GENERATION_ENV,
  requireExpectedGeneration,
  assertExpectedGeneration,
  requireNativeSingle,
  nativeParentRequest,
  exactParentInvocation,
  inspectParentSession,
  type ParentObservation,
  LIVE_PROJECT_GUIDANCE,
  CURRENT_RESEARCH_FETCH_POLICY,
  assignedReadObservations,
  terminalOutputEvidence,
  COHORT_ENV,
  ORDINARY_SKILLS,
  NOTICE,
  PUBLIC_RESEARCH_URL,
  buildCohort,
  parseCohortSelection,
  validateLiveStep,
  publicResultMatches,
  requiredLivePhase,
  producedNoticeMatches,
  diagnosisMatches,
  specificationMatches,
  strategyMatches,
  researchMatches,
  publicFetchMatches,
  exactHandoffMatches,
  reviewedAssuranceMatches,
  exactQualityChecks,
  atomicBytes,
  firstCohort,
  completeAssignedReads,
  noticeCoverageMatches,
  inspectSession,
  safeError,
  FAN_IN_ARRIVAL,
  FAN_IN_VENUE,
  fanInConsumerParams,
  fanInProducerRefs,
  contextualProductMatches,
  contextualHandoffMatches,
  CONTEXT_CONSUMER_PHASES,
  type ProductScenario,
  type LiveStep,
} from "../smoke/ordinary-skills-live-contract.js";

import {
  canonicalizeDefinitionRequest,
  canonicalizeDefinitionFrameV2,
  definitionSourceManifest,
} from "../dist/skill-contracts/define.js";
import {
  evidenceAdmissionV2Id,
  type EvidenceAdmissionV2,
} from "../dist/skill-contracts/evidence-admission.js";
import {
  canonicalizeProduceRequest,
  sealProducedArtifactV2,
  type ProducedArtifactDraftV2,
} from "../dist/skill-contracts/produce.js";
import {
  unknownEffectEvidenceGraph,
  PRODUCE_EFFECT_PHASES,
} from "../dist/skill-contracts/effects.js";
import { isRecord } from "../../../.pi/lib/tests/test-narrowers.js";

function unitRunIds() {
  let next = 0;
  return (skill: string) => `unit-${skill}-${++next}`;
}
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixtureSession(
  provider: string,
  model: string,
  responses = true,
  tool = "artifact_read",
  metadata: Record<string, string> = {},
  extra: readonly unknown[] = []
) {
  const root = mkdtempSync(path.join(tmpdir(), "penny-live-oracle-unit-"));
  roots.push(root);
  const file = path.join(root, "session.jsonl");
  const records: unknown[] = [
    {
      type: "custom",
      customType: "penny.orchestration.worker-session",
      data: {
        run_id: "owned",
        state_id: "deciding",
        agent: "demetri",
        purpose: "phase",
        worker_id: "worker",
        ...metadata,
      },
    },
    { type: "model_change", provider, modelId: model },
    ...(responses
      ? [{ type: "message", message: { role: "assistant", provider, model, stopReason: "stop" } }]
      : []),
    { type: "message", message: { role: "toolResult", toolName: tool } },
    ...extra,
  ];
  atomicBytes(file, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`);
  return file;
}
const roles = [
  { agent: "demetri", alias: "alias", provider: "expected-provider", model: "expected-model" },
];

/** Offline parser fixtures only, not accepted owner terminals or live model outputs. */
function nativeProducedFixture(step: LiveStep, content: unknown) {
  const request = canonicalizeProduceRequest({ goal: step.goal, constraints: step.constraints });
  const draft: ProducedArtifactDraftV2 = {
    schema_version: 2,
    disposition: "produced",
    output_name: request.output_name,
    artifact_kind: "json",
    media_type: "application/json",
    content: canonicalJson(content),
    rationale: "Offline native parser fixture, not model understanding or owner admission.",
    assumptions: [],
    uncertainties: [],
    confidence: "CERTAIN",
    request_coverage: {
      purpose_statement_covered: true,
      specification_indexes: request.specification.map((_item, index) => index),
      source_material_indexes: request.source_material.map((_item, index) => index),
      acceptance_criterion_indexes: request.acceptance_criteria.map((_item, index) => index),
      hard_constraint_indexes: request.hard_constraints.map((_item, index) => index),
      non_goal_indexes: request.non_goals.map((_item, index) => index),
      known_uncertainty_indexes: request.known_uncertainties.map((_item, index) => index),
    },
  };
  function ref(
    kind: string,
    phase: string,
    producer: string,
    value: unknown,
    schema_id?: string,
    schema_version = 1
  ): ArtifactRef {
    const bytes = Buffer.from(canonicalJson(value));
    const digest = sha256(bytes);
    return {
      schema_version: 2,
      artifact_id: `art_${sha256(`${step.session_id}/${kind}/${digest}`)}`,
      run_id: step.session_id,
      phase,
      branch_id: null,
      kind,
      operation_id: kind,
      version: 1,
      producer,
      media_type: "application/json",
      byte_length: bytes.length,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
      ...(schema_id === undefined ? {} : { content_schema: { schema_id, schema_version } }),
    };
  }
  const product = sealProducedArtifactV2({
    request,
    draft,
    requestRef: ref("produce-request", "intake", "host:request-admission", request),
    approachRef: ref(
      "artifact-approach",
      "exploring_artifact_approaches",
      "agent:ida",
      { fixture: "approach" },
      "penny.artifact-approach.v1"
    ),
    decisionRef: ref(
      "artifact-approach-decision",
      "selecting_artifact_approach",
      "agent:demetri",
      { fixture: "decision" },
      "penny.artifact-approach-decision.v1"
    ),
    draftRef: ref(
      "produced-artifact-draft",
      "materializing_artifact",
      "agent:skribble",
      draft,
      "penny.produced-artifact-draft.v2",
      2
    ),
    effectEvidence: unknownEffectEvidenceGraph({
      runId: step.session_id,
      phases: PRODUCE_EFFECT_PHASES,
    }),
  });
  return {
    product,
    bytes: Buffer.from(canonicalJson(product)),
    ref: ref(
      "semantic-core",
      "sealing_artifact",
      "host:artifact-sealer",
      product,
      "penny.produced-artifact.v2",
      2
    ),
  };
}
function fanInFixture() {
  const cohort = buildCohort("two-source-fan-in", unitRunIds());
  const [arrival, venue, consumer] = cohort.steps;
  if (arrival === undefined || venue === undefined || consumer === undefined)
    throw new Error("Missing fan-in fixture steps");
  const sources = [
    nativeProducedFixture(arrival, FAN_IN_ARRIVAL),
    nativeProducedFixture(venue, FAN_IN_VENUE),
  ];
  const refs = sources.map((source) => source.ref);
  const provenance = refs.map((ref) => ({
    artifact_id: ref.artifact_id,
    run_id: ref.run_id,
    kind: "semantic-core",
    schema_id: "penny.produced-artifact.v2",
    schema_version: 2,
    designation: "context",
    authority: "nonbinding",
  }));
  const content = { arrival: FAN_IN_ARRIVAL, venue: FAN_IN_VENUE, provenance };
  const scenario: ProductScenario = {
    selection: "two-source-fan-in",
    step_index: 2,
    context_refs: refs,
  };
  return { cohort, consumer, sources, refs, content, scenario };
}

/** Closed observations only; native product/admission and semantic checks remain separate. */
function contextualHandoffFixture() {
  const { refs, consumer, content, sources } = fanInFixture();
  const expected: InputArtifacts = {
    schema_version: 2,
    artifacts: refs.map((ref, index) => ({
      slot: `context-input-${String(index + 1).padStart(4, "0")}`,
      designation: "context",
      ref,
    })),
  };
  // A real native parser fixture product belongs in the completed consumer's selection,
  // unlike its separately admitted nonbinding contexts. This is not owner admission evidence.
  const selected = [nativeProducedFixture(consumer, content).ref];
  const sessions = CONTEXT_CONSUMER_PHASES.map((state) => ({
    run_id: consumer.session_id,
    state,
    purpose: "phase",
    input_refs: refs,
    task: expected.artifacts
      .map(
        (binding) =>
          `NONBINDING context slot ${JSON.stringify(binding.slot)}: ${canonicalJson(binding.ref)}`
      )
      .join("\n"),
    assigned_reads: refs.map(
      (ref) =>
        ({
          artifact_id: ref.artifact_id,
          complete: true,
          requirement: "mandatory",
          reason: "Exact fixture byte read",
        }) as const
    ),
  }));
  const matches = (
    actualSessions: Parameters<typeof contextualHandoffMatches>[4] = sessions,
    admitted: InputArtifacts | undefined = expected,
    nativeSelected: readonly ArtifactRef[] = selected
  ) =>
    contextualHandoffMatches(
      expected,
      consumer.session_id,
      admitted,
      nativeSelected,
      actualSessions
    );
  return { refs, sources, consumer, expected, selected, sessions, matches };
}

type ContextSessionEvidence = Parameters<typeof contextualHandoffMatches>[4][number];
function contextInvocationMutations(
  session: ContextSessionEvidence,
  expected: InputArtifacts
): { name: string; session: ContextSessionEvidence }[] {
  return [
    { name: "foreign consumer", session: { ...session, run_id: "other-consumer" } },
    { name: "unexpected purpose", session: { ...session, purpose: "host_operation" } },
    { name: "unexpected state", session: { ...session, state: "intake" } },
    ...expected.artifacts.flatMap(({ ref, slot }) => [
      {
        name: `${slot} missing input`,
        session: {
          ...session,
          input_refs: session.input_refs.filter((input) => input.artifact_id !== ref.artifact_id),
        },
      },
      {
        name: `${slot} substituted full input ref`,
        session: {
          ...session,
          input_refs: session.input_refs.map((input) =>
            input.artifact_id === ref.artifact_id ? { ...input, version: input.version + 1 } : input
          ),
        },
      },
      {
        name: `${slot} changed task slot`,
        session: { ...session, task: session.task.replace(JSON.stringify(slot), '"other-slot"') },
      },
      {
        name: `${slot} changed task ref`,
        session: {
          ...session,
          task: session.task.replace(
            canonicalJson(ref),
            canonicalJson({ ...ref, version: ref.version + 1 })
          ),
        },
      },
      {
        name: `${slot} missing read`,
        session: {
          ...session,
          assigned_reads: session.assigned_reads.filter(
            (read) => read.artifact_id !== ref.artifact_id
          ),
        },
      },
      {
        name: `${slot} incomplete read`,
        session: {
          ...session,
          assigned_reads: session.assigned_reads.map((read) =>
            read.artifact_id === ref.artifact_id ? { ...read, complete: false } : read
          ),
        },
      },
      {
        name: `${slot} exempted read`,
        session: {
          ...session,
          assigned_reads: session.assigned_reads.map((read) =>
            read.artifact_id === ref.artifact_id
              ? { ...read, requirement: "redundant_host_metadata" as const }
              : read
          ),
        },
      },
    ]),
  ];
}

describe("ordinary live harness oracles (provider execution NOT RUN)", () => {
  it("validates native closed synthetic requests before production dispatch", () => {
    const cohort = firstCohort("decision", "assessment");
    expect(cohort.skills.map((step) => step.skill_name)).toEqual(["decide", "assess"]);
    const decision = cohort.skills[0];
    if (decision === undefined) throw new Error("Missing decision request");
    expect(() =>
      canonicalizeDecisionRequest({
        goal: decision.goal,
        constraints: { ...decision.constraints, invented: true },
      })
    ).toThrow();
    expect(JSON.stringify(cohort)).not.toContain('"model":');
    expect(JSON.stringify(cohort)).not.toContain("{previous}");
  });
  it("uses native required-criterion semantics rather than a permissive partial disposition", () => {
    const criterion_outcomes = [
      {
        criterion_index: 0,
        verdict: "met",
        rationale: "Times stated",
        supporting_evidence_indexes: [0],
        contradicting_evidence_indexes: [],
      },
      {
        criterion_index: 1,
        verdict: "not_met",
        rationale: "Capacity absent",
        supporting_evidence_indexes: [],
        contradicting_evidence_indexes: [0],
      },
    ] as const;
    const outcomes = criterion_outcomes.map((item) => ({
      ...item,
      supporting_evidence_indexes: [...item.supporting_evidence_indexes],
      contradicting_evidence_indexes: [...item.contradicting_evidence_indexes],
    }));
    expect(
      noticeCoverageMatches({ disposition: "does_not_meet", criterion_outcomes: outcomes })
    ).toBe(true);
    expect(
      noticeCoverageMatches({ disposition: "partially_meets", criterion_outcomes: outcomes })
    ).toBe(false);
  });
  it("requires every assigned byte and digest, not an artifact-shaped partial read", () => {
    const digest = sha256("public");
    const ref: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${digest}`,
      run_id: "unit",
      phase: "intake",
      branch_id: null,
      kind: "agent-output",
      operation_id: "unit",
      version: 1,
      producer: "agent:annie",
      media_type: "text/plain",
      byte_length: 6,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    };
    const message = (start: number, end: number, content: string) => ({
      role: "toolResult",
      toolName: "artifact_read",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            artifact_ref: ref,
            content_digest: digest,
            returned_range: { start, end },
            content,
          }),
        },
      ],
    });
    expect(completeAssignedReads([message(0, 3, "pub")], [ref])[0]?.passed).toBe(false);
    expect(
      completeAssignedReads([message(0, 3, "pub"), message(3, 6, "lic")], [ref])[0]?.passed
    ).toBe(true);
    expect(completeAssignedReads([message(0, 6, "wrong!")], [ref])[0]?.passed).toBe(false);
    const substituted = {
      role: "toolResult",
      toolName: "artifact_read",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            artifact_ref: { ...ref, run_id: "substituted-provenance" },
            content_digest: digest,
            returned_range: { start: 0, end: 6 },
            content: "public",
          }),
        },
      ],
    };
    expect(completeAssignedReads([substituted], [ref])[0]?.passed).toBe(false);
  });
  it("exempts only proven redundant initial Define carriers, not required semantics, imported lineage or repairs", () => {
    const step = buildCohort("define-single", (skill) => skill).steps[0];
    if (step === undefined || !isRecord(step.constraints.request))
      throw new Error("Missing Define fixture request");
    const request = canonicalizeDefinitionRequest({
      goal: step.goal,
      constraints: step.constraints.request,
      exactInputArtifactIds: [],
    });
    const bodies = new Map<string, Buffer>();
    const refFor = (
      kind: string,
      producer: string,
      value: unknown,
      phase = "intake"
    ): ArtifactRef => {
      const bytes = Buffer.from(canonicalJson(value));
      const digest = sha256(bytes);
      const ref: ArtifactRef = {
        schema_version: 2,
        artifact_id: `art_${digest}`,
        run_id: "define",
        phase,
        branch_id: null,
        kind,
        operation_id: kind,
        version: 1,
        producer,
        media_type: "application/json",
        byte_length: bytes.length,
        content_digest: digest,
        store_ref: `artifact://sha256/${digest}`,
        ...(isRecord(value) &&
        typeof value.schema_id === "string" &&
        typeof value.schema_version === "number"
          ? { content_schema: { schema_id: value.schema_id, schema_version: value.schema_version } }
          : {}),
      };
      bodies.set(ref.artifact_id, bytes);
      return ref;
    };
    const requestRef = {
      ...refFor("definition-request", "host:request-admission", request),
      content_schema: { schema_id: "penny.definition-request.v1", schema_version: 1 },
    };
    const manifestRef = refFor(
      "definition-source-manifest",
      "host:request-admission",
      definitionSourceManifest(request, requestRef)
    );
    const raw = refFor(
      "agent-output",
      "agent:piper",
      { note: "Raw frame carrier, not a semantic authorship operand." },
      "framing_definition"
    );
    const frame = canonicalizeDefinitionFrameV2({
      request,
      requestRef,
      orientationRef: raw,
      selectedProfileId: "generic",
      profileSelectionBasis: "Explicit caller profile.",
      route: "author",
      routeReason: "All facts supplied.",
      discoveredQuestions: [],
    });
    const frameRef = {
      ...refFor("definition-frame", "host:definition-framer", frame),
      content_schema: { schema_id: "penny.definition-frame.v2", schema_version: 2 },
    };
    const body = {
      schema_id: "penny.evidence-admission.v2",
      schema_version: 2,
      run_id: "define",
      domain: "specification",
      origin_state: "framing_definition",
      source_artifact_ref: raw,
      frame_ref: frameRef,
      routing_result_sha256: sha256("routing"),
      source_execution_receipt_ids: ["receipt"],
      classification: "basis_sufficient",
      evidence_required: false,
      support_slots: [],
      minted_by: "host:evidence-gate",
    } satisfies Omit<EvidenceAdmissionV2, "admission_id">;
    const admissionRef = refFor("evidence-admission", "host:evidence-gate", {
      ...body,
      admission_id: evidenceAdmissionV2Id(body),
    });
    const assurance = {
      schema_id: "penny.composition-assurance.v1",
      schema_version: 1,
      mode: "not_applicable",
      consumer: {
        run_id: "define",
        registration_name: "define",
        contract_sha256: sha256("contract"),
        registration_sha256: sha256("registration"),
      },
      invocation_sha256: sha256("invocation"),
      request_ref: {
        ...requestRef,
        kind: "composition-request",
        producer: "host:composition-assurance",
      },
      specification_ref: null,
      producer: null,
      immediate_parent: null,
      checked_artifact_count: 0,
      checked_artifact_bytes: 0,
      checked_artifacts: [],
      scope: ["no_specification_input"],
    };
    const assuranceRef = refFor("composition-assurance", "host:composition-assurance", {
      ...assurance,
      binding_sha256: sha256(canonicalJson(assurance)),
    });
    const required = [requestRef, manifestRef, frameRef, admissionRef];
    const refs = [...required, raw, assuranceRef];
    const reader = (ref: ArtifactRef) => {
      const bytes = bodies.get(ref.artifact_id);
      if (bytes === undefined) throw new Error("Missing exact fixture bytes");
      return bytes;
    };
    const messages = required.map((ref) => ({
      role: "toolResult",
      toolName: "artifact_read",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            artifact_ref: ref,
            content_digest: ref.content_digest,
            returned_range: { start: 0, end: ref.byte_length },
            content: reader(ref).toString("utf8"),
          }),
        },
      ],
    }));
    const session = {
      run_id: "define",
      agent: "rhea",
      state: "authoring_specification",
      purpose: "phase",
    };
    const observations = assignedReadObservations(messages, refs, session, reader);
    expect(
      observations
        .filter((read) => read.requirement === "redundant_host_metadata")
        .map((read) => [read.artifact_id, read.complete])
    ).toEqual([
      [raw.artifact_id, false],
      [assuranceRef.artifact_id, false],
    ]);
    expect(
      observations.filter((read) => read.requirement === "mandatory").every((read) => read.complete)
    ).toBe(true);
    for (const [index, ref] of required.entries()) {
      const missing = messages.filter((_message, messageIndex) => messageIndex !== index);
      const reads = assignedReadObservations(missing, refs, session, reader);
      expect(reads.find((read) => read.artifact_id === ref.artifact_id)?.complete).toBe(false);
      expect(reads.every((read) => read.requirement === "mandatory")).toBe(true);
    }
    expect(
      assignedReadObservations(messages, refs, session).every(
        (read) => read.requirement === "mandatory"
      )
    ).toBe(true);
    expect(
      assignedReadObservations(
        messages,
        refs,
        { ...session, state: "verifying_specification" },
        reader
      ).every((read) => read.requirement === "mandatory")
    ).toBe(true);
    const imported = refFor("semantic-core", "host:specification-sealer", {
      prior: "specification",
    });
    expect(
      assignedReadObservations(messages, [...refs, imported], session, reader).every(
        (read) => read.requirement === "mandatory"
      )
    ).toBe(true);
    const repair = refFor("seal-diagnostic", "host:sealer", { defect: "missing criterion" });
    expect(
      assignedReadObservations(messages, [...refs, repair], session, reader).every(
        (read) => read.requirement === "mandatory"
      )
    ).toBe(true);
    const foreign = { ...assurance, request_ref: { ...assurance.request_ref, run_id: "foreign" } };
    const foreignRef = refFor("composition-assurance", "host:composition-assurance", {
      ...foreign,
      binding_sha256: sha256(canonicalJson(foreign)),
    });
    expect(
      assignedReadObservations(messages, [...required, raw, foreignRef], session, reader).every(
        (read) => read.requirement === "mandatory"
      )
    ).toBe(true);
    const partialFrame = messages.map((message, index) =>
      index !== 2
        ? message
        : {
            ...message,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  artifact_ref: frameRef,
                  content_digest: frameRef.content_digest,
                  returned_range: { start: 0, end: 1 },
                  content: "{",
                }),
              },
            ],
          }
    );
    expect(
      assignedReadObservations(partialFrame, refs, session, reader).every(
        (read) => read.requirement === "mandatory"
      )
    ).toBe(true);
    bodies.set(assuranceRef.artifact_id, Buffer.from("corrupt"));
    expect(
      assignedReadObservations(messages, refs, session, reader).every(
        (read) => read.requirement === "mandatory"
      )
    ).toBe(true);
  });
  it("rejects identity drift rather than accepting a model-shaped response", () => {
    const evidence = inspectSession(fixtureSession("wrong", "wrong"), roles, ["owned"]);
    expect(evidence.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "SDK persisted resolved catalog identity",
      "real assistant response identity",
    ]);
  });
  it("requires an actual assistant response and forbids out-of-task tool execution", () => {
    const evidence = inspectSession(
      fixtureSession("expected-provider", "expected-model", false, "memory_search"),
      roles,
      ["owned"]
    );
    expect(evidence.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "real assistant response identity",
      "no out-of-task tool execution",
    ]);
  });
  it("refuses sessions outside the exact fresh run set", () => {
    expect(() =>
      inspectSession(fixtureSession("expected-provider", "expected-model"), roles, ["other"])
    ).toThrow("outside this fresh cohort");
  });
  it("redacts credential-shaped error material without serializing config or causes", () => {
    const message = safeError(
      new Error(
        "dispatch blocked Bearer example-secret https://example.invalid/?token=hidden sk-not-a-real-key"
      )
    );
    expect(message).toContain("dispatch blocked");
    expect(message).not.toContain("example-secret");
    expect(message).not.toContain("token=hidden");
    expect(message).not.toContain("sk-not-a-real-key");
  });
  it("requires one explicit known cohort and never defaults to every expensive cohort", () => {
    for (const invalid of [
      undefined,
      null,
      "",
      "all",
      "produce,diagnose",
      "PRODUCE-SINGLE",
      {},
      ["produce-single"],
    ])
      expect(() => parseCohortSelection(invalid)).toThrow(COHORT_ENV);
    expect(COHORTS.map(parseCohortSelection)).toEqual(COHORTS);
  });
  it.each(COHORTS)(
    "builds runnable native constraints for %s, without model or liveness overrides",
    (selection) => {
      const cohort = buildCohort(selection, unitRunIds());
      expect(cohort.steps.length).toBe(
        cohort.mode === "single" ? 1 : cohort.mode === "fan-in" ? 3 : 2
      );
      for (const step of cohort.steps) expect(() => validateLiveStep(step)).not.toThrow();
      const serialized = JSON.stringify(cohort.params);
      for (const forbidden of [
        '"model":',
        "verification_model_override",
        "validate_model",
        "max_steps",
        "max_iterations",
        "total_research_rounds",
      ])
        expect(serialized).not.toContain(forbidden);
      expect(
        Object.keys(cohort.params).filter((key) => ["skills", "chain", "skill_name"].includes(key))
      ).toHaveLength(1);
      expect(serialized.includes("{previous}")).toBe(cohort.mode === "chain");
    }
  );
  it("covers all seven and preserves explicit strict Define-to-Plan assurance", () => {
    const seen = new Set(
      COHORTS.flatMap((selection) =>
        buildCohort(selection, unitRunIds()).steps.map((step) => step.skill_name)
      )
    );
    expect([...seen].sort()).toEqual([...ORDINARY_SKILLS].sort());
    const chain = buildCohort("define-plan-chain", (skill) => skill);
    expect(chain.steps.map((step) => step.skill_name)).toEqual(["define", "plan"]);
    expect(chain.steps[1]?.constraints.specification_assurance).toBe("reviewed_definition");
    expect(chain.steps[1]?.goal).toContain("{previous}");
    const researchChain = buildCohort("research-decide-chain", (skill) => skill);
    expect(researchChain.steps[0]?.goal).toContain(PUBLIC_RESEARCH_URL);
    expect(researchChain.steps[1]?.goal).toContain("basis_ids_used");
    expect(researchChain.steps[1]?.constraints.evidence).toEqual([]);
  });
  it("keeps the positive Define-to-Plan fixture free of the observed planning prohibition", () => {
    const chain = buildCohort("define-plan-chain", (skill) => skill);
    const producer = chain.steps.find((step) => step.skill_name === "define");
    if (producer === undefined) throw new Error("Missing Define producer");
    expect(producer.goal).toContain("including requirements and observable acceptance criteria");
    expect(producer.goal).not.toContain("not a strategy or tasks");
    expect(producer.goal).toContain("Do not write files, run tests, execute changes");
  });
  it("states scoped product constraints and admitted-evidence review in active guidance", () => {
    const prompt = (skill: string, file: string) =>
      readFileSync(
        path.resolve(import.meta.dirname, "../../../.pi/skills", skill, "assets/prompts", file),
        "utf8"
      );
    const definition = prompt("define", "rhea-authoring_specification.md");
    expect(definition).toContain("instructions for producing this specification");
    expect(definition).toContain("Preserve any restriction the caller actually makes project-wide");
    const definitionReview = prompt("define", "vera-verifying_specification.md");
    expect(definitionReview).toContain("Piper's complete framing report");
    expect(definitionReview).toContain("not a lossless replacement");
    const review = prompt("decide", "vera-verifying_decision.md");
    expect(review).toContain("within the caller's evidence scope");
    expect(review).toContain("not permission to retrieve it");
    expect(review).toContain("declared `evidence_gap` route");
  });
  it("rejects malformed constraints for every native single request before dispatch", () => {
    for (const skill of ORDINARY_SKILLS) {
      const step = buildCohort(parseCohortSelection(`${skill}-single`), (name) => name).steps[0];
      if (step === undefined) throw new Error("Missing single operand");
      expect(() =>
        validateLiveStep({ ...step, constraints: { ...step.constraints, injected: true } })
      ).toThrow();
    }
  });
  it("checks public single/parallel/chain results against exact selected runs, not just success flags", () => {
    for (const selection of COHORTS) {
      const cohort = buildCohort(selection, unitRunIds());
      const branch = (step: (typeof cohort.steps)[number]) => ({
        success: true,
        skill_name: step.skill_name,
        session_id: step.session_id,
      });
      const details =
        cohort.mode === "single"
          ? branch(
              cohort.steps[0] ??
                (() => {
                  throw new Error("Missing step");
                })()
            )
          : {
              success: true,
              mode: cohort.mode,
              [cohort.mode === "parallel" ? "parallel_results" : "chain_results"]:
                cohort.steps.map(branch),
            };
      const result =
        cohort.mode === "fan-in"
          ? {
              invocations: [
                {
                  details: {
                    success: true,
                    mode: "parallel",
                    parallel_results: cohort.steps.slice(0, 2).map(branch),
                  },
                },
                {
                  details: branch(
                    cohort.steps[2] ??
                      (() => {
                        throw new Error("Missing consumer");
                      })()
                  ),
                },
              ],
            }
          : { details };
      expect(publicResultMatches(result, cohort)).toBe(true);
      expect(publicResultMatches({ details: { ...details, success: false } }, cohort)).toBe(false);
      expect(
        publicResultMatches(
          {
            details: {
              success: true,
              mode: cohort.mode,
              skill_name: "produce",
              session_id: "foreign",
            },
          },
          cohort
        )
      ).toBe(false);
    }
  });
  it("does not mistake conditional or host-only phases for required live sessions", () => {
    expect(requiredLivePhase("define", "gathering_definition_evidence")).toBe(false);
    expect(requiredLivePhase("plan", "gathering_strategy_evidence")).toBe(false);
    expect(requiredLivePhase("research", "planning")).toBe(false);
    expect(requiredLivePhase("research", "researching")).toBe(true);
    expect(requiredLivePhase("research", "validating")).toBe(true);
    expect(requiredLivePhase("produce", "verifying_artifact")).toBe(true);
  });
  it("requires the exact requested JSON notice, not merely a produced/schema-shaped artifact", () => {
    const core = {
      disposition: "produced",
      content: JSON.stringify(NOTICE),
      output_name: "notice.json",
      artifact_kind: "json",
    } satisfies Parameters<typeof producedNoticeMatches>[0];
    expect(producedNoticeMatches(core)).toBe(true);
    for (const content of [
      "{}",
      "not JSON",
      JSON.stringify({ ...NOTICE, start: "19:00" }),
      JSON.stringify({ ...NOTICE, invented: true }),
    ])
      expect(producedNoticeMatches({ ...core, content })).toBe(false);
    expect(producedNoticeMatches({ ...core, disposition: "not_applicable" })).toBe(false);
  });
  it("requires a supported causal diagnosis tied to both controlled observations with no new tests", () => {
    const hypothesis = {
      hypothesis_id: "cable",
      rank: 1,
      statement: "The power cable was disconnected.",
      status: "supported",
      symptom_indexes: [0],
      supporting_observation_indexes: [0, 1],
      contradicting_observation_indexes: [],
      supporting_environment_fact_indexes: [0],
      contradicting_environment_fact_indexes: [],
      hard_constraint_indexes: [0],
      reasoning: "Reconnecting the same cable restored light without any other change.",
    } satisfies Parameters<typeof diagnosisMatches>[0]["hypotheses"][number];
    const core = {
      disposition: "supported",
      hypotheses: [hypothesis],
      primary_supported_hypothesis_id: "cable",
      tests_executed: false,
      remediation_started: false,
      proposed_discriminating_checks: [],
    } satisfies Parameters<typeof diagnosisMatches>[0];
    expect(diagnosisMatches(core)).toBe(true);
    expect(
      diagnosisMatches({ ...core, hypotheses: [{ ...hypothesis, statement: "The bulb failed." }] })
    ).toBe(false);
    expect(
      diagnosisMatches({
        ...core,
        hypotheses: [{ ...hypothesis, supporting_observation_indexes: [0] }],
      })
    ).toBe(false);
    expect(
      diagnosisMatches({
        ...core,
        disposition: "inconclusive",
        primary_supported_hypothesis_id: null,
      })
    ).toBe(false);
  });
  it("independently requires notice meaning, exact protected constraints and readiness in Define", () => {
    const core = {
      disposition: "ready",
      planning_handoff: { planning_ready: true },
      requirements: [{ statement: "Notice: 18:00 doors, 18:30 talk, free entry." }],
      acceptance_criteria: [
        {
          statement: "A visitor can read 18:00 doors, 18:30 talk and free entry.",
          observation: "Inspect the complete proposed notice.",
        },
      ],
      constraints: [{ statement: "Preserve the exact times 18:00 and 18:30 and free entry." }],
      non_goals: [
        { statement: "Do not publish the notice or create an implementation task list." },
      ],
      planning_started: false,
      taskification_started: false,
      execution_started: false,
    } satisfies Parameters<typeof specificationMatches>[0];
    expect(specificationMatches(core)).toBe(true);
    expect(
      specificationMatches({ ...core, requirements: [{ statement: "A notice exists." }] })
    ).toBe(false);
    expect(
      specificationMatches({
        ...core,
        acceptance_criteria: [
          {
            statement: "All three required facts are present with their correct meanings.",
            observation:
              "Inspection finds door opening at 18:00, talk start at 18:30, and entry is free.",
          },
        ],
      })
    ).toBe(true);
    expect(
      specificationMatches({
        ...core,
        acceptance_criteria: [{ statement: "Looks good.", observation: "No facts observed." }],
      })
    ).toBe(false);
    expect(
      specificationMatches({
        ...core,
        acceptance_criteria: [
          { statement: "All facts present.", observation: "Doors 19:00; talk 19:30; paid entry." },
        ],
      })
    ).toBe(false);
    expect(specificationMatches({ ...core, constraints: [] })).toBe(false);
    expect(specificationMatches({ ...core, planning_handoff: { planning_ready: false } })).toBe(
      false
    );
    expect(specificationMatches({ ...core, taskification_started: true })).toBe(false);
  });
  it("independently requires substantive notice outcomes and no execution in Plan", () => {
    const core = {
      disposition: "ready",
      outcomes: [
        {
          statement: "Notice communicates 18:00 doors, 18:30 talk, free entry.",
          success_signal: "All visitors can read the three approved facts.",
        },
      ],
      execution_started: false,
      blockers: [],
    } satisfies Parameters<typeof strategyMatches>[0];
    expect(strategyMatches(core)).toBe(true);
    expect(
      strategyMatches({
        ...core,
        outcomes: [{ statement: "Prepare notice.", success_signal: "Done." }],
      })
    ).toBe(false);
    expect(strategyMatches({ ...core, execution_started: true })).toBe(false);
    expect(strategyMatches({ ...core, disposition: "blocked", blockers: ["unknown"] })).toBe(false);
  });
  it("rejects fabricated/irrelevant/unsupported Research success and requires both sourced findings", () => {
    const claim = {
      claim_id: "claim-0001",
      statement: "Comma-containing fields are double-quoted.",
      claim_kind: "fact",
      support_status: "supported",
      confidence: 0.9,
      evidence_ids: ["evidence-0001"],
      qualifications: [],
    } satisfies Parameters<typeof researchMatches>[0]["claims"][number];
    const core = {
      sources: [
        {
          source_id: "source-0001",
          source_kind: "primary",
          role: "evidentiary",
          tier: 1,
          title: "RFC 4180",
          locator: PUBLIC_RESEARCH_URL,
        },
      ],
      evidence: [
        {
          evidence_id: "evidence-0001",
          source_id: "source-0001",
          locator: "section 2",
          excerpt_sha256: "a".repeat(64),
          evidence_artifact_id: `art_${"a".repeat(64)}`,
          relation: "supports",
        },
      ],
      claims: [
        claim,
        { ...claim, claim_id: "claim-0002", statement: "The header record is optional." },
      ],
      unresolved_gaps: [],
    } satisfies Parameters<typeof researchMatches>[0];
    expect(researchMatches(core)).toBe(true);
    const qualified = {
      ...claim,
      statement:
        "RFC 4180 represents a field containing a comma by enclosing the field in double quotes; its grammar permits a comma within such an escaped field.",
      support_status: "qualified",
      qualifications: [
        "RFC 4180 uses “should be enclosed,” not “must be enclosed,” for fields containing commas.",
      ],
    } satisfies Parameters<typeof researchMatches>[0]["claims"][number];
    for (const statement of [
      "Comma-containing fields should be enclosed in double-quotes.",
      "A comma is not a delimiter inside double quotes.",
      "Comma-containing fields use double quotes, not single quotes.",
    ])
      expect(
        researchMatches({ ...core, claims: [{ ...claim, statement }, core.claims[1] ?? claim] }),
        statement
      ).toBe(true);
    for (const statement of [
      "The header record is optional, not mandatory.",
      "The header line is not required.",
      "A header record need not be present.",
    ])
      expect(researchMatches({ ...core, claims: [qualified, { ...claim, statement }] })).toBe(true);
    expect(
      researchMatches({
        ...core,
        claims: [{ ...qualified, qualifications: [] }, core.claims[1] ?? claim],
      })
    ).toBe(false);
    for (const statement of [
      "Comma-containing fields should not be double-quoted.",
      "Comma-containing fields need not be double-quoted.",
      "For comma-containing fields, double quotes are optional.",
      "RFC 4180 does not require comma-containing fields to be enclosed in double quotes.",
      "Comma fields use double quotes but split on every comma.",
      "Comma-containing fields are single-quoted, not double-quoted.",
      "Comma-containing fields use a backslash rather than double quotes.",
      "A comma in an unquoted field is represented by double quotes elsewhere.",
      "Comma-containing fields are double-quoted but split on delimiters inside quotes.",
    ])
      expect(
        researchMatches({
          ...core,
          claims: [{ ...qualified, statement }, core.claims[1] ?? claim],
        }),
        statement
      ).toBe(false);
    for (const statement of [
      "The header record is not optional; it is mandatory.",
      "The header record is optional, but is required.",
      "The header record must be present; only its header parameter is optional.",
    ])
      expect(
        researchMatches({ ...core, claims: [qualified, { ...claim, statement }] }),
        statement
      ).toBe(false);
    // A correct claim cannot conceal a contradictory qualification or additional claim.
    expect(
      researchMatches({
        ...core,
        claims: [qualified, ...core.claims, { ...claim, statement: "The header is required." }],
      })
    ).toBe(false);
    expect(
      researchMatches({
        ...core,
        claims: [
          { ...qualified, qualifications: ["Comma-containing fields need not be double-quoted."] },
          core.claims[1] ?? claim,
        ],
      })
    ).toBe(false);
    expect(
      researchMatches({
        ...core,
        sources: core.sources.map((item) => ({ ...item, locator: "https://example.invalid" })),
      })
    ).toBe(false);
    expect(researchMatches({ ...core, claims: [claim] })).toBe(false);
    expect(
      researchMatches({
        ...core,
        claims: core.claims.map((item) => ({ ...item, support_status: "unsupported" })),
      })
    ).toBe(false);
    expect(researchMatches({ ...core, evidence: [] })).toBe(false);
    expect(
      researchMatches({
        ...core,
        claims: [
          { ...claim, statement: "Comma-containing fields should not be double-quoted." },
          core.claims[1] ?? claim,
        ],
      })
    ).toBe(false);
    expect(
      researchMatches({
        ...core,
        claims: [
          claim,
          { ...claim, statement: "The header record is not optional; it is mandatory." },
        ],
      })
    ).toBe(false);
  });
  it("classifies negative terminal drafts/partials without attempting a positive canonical validator", () => {
    const digest = sha256("not a canonical product");
    const ref: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${digest}`,
      run_id: "owned",
      phase: "materializing_artifact",
      branch_id: null,
      kind: "produced-artifact-draft",
      operation_id: "draft",
      version: 1,
      producer: "agent:skribble",
      media_type: "text/plain",
      byte_length: 23,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    };
    for (const action of ["incomplete", "error", "cancelled"] as const) {
      const evidence = terminalOutputEvidence(
        "produce",
        {
          action,
          met: false,
          result: {
            output_kind: "rejected_draft_best_partial",
            incomplete_reason: "malformed_exact_material",
          },
        },
        Buffer.from("not a canonical product"),
        ref
      );
      expect(evidence.classification).toBe("rejected_draft");
      expect(evidence.checks).toHaveLength(1);
      expect(evidence.checks[0]?.passed).toBe(false);
      expect(evidence.checks[0]?.detail).toContain("malformed_exact_material");
      expect(
        terminalOutputEvidence("produce", { action, met: false, result: {} }, Buffer.from("{}"), {
          ...ref,
          kind: "semantic-core",
        }).classification
      ).toBe("best_partial");
    }
    expect(
      terminalOutputEvidence(
        "produce",
        { action: "cancelled", met: false, result: {} },
        Buffer.from("{}"),
        ref
      ).classification
    ).toBe("best_partial");
    // Even canonical-looking partials cannot qualify; an alleged positive still runs native validation.
    expect(
      terminalOutputEvidence(
        "produce",
        { action: "complete", met: false, result: {} },
        Buffer.from("{}"),
        ref
      ).checks.every((check) => check.passed)
    ).toBe(false);
    expect(() =>
      terminalOutputEvidence(
        "produce",
        { action: "complete", met: true, result: {} },
        Buffer.from("{}"),
        ref
      )
    ).toThrow();
  });
  it("requires a successful, complete public fetch wire body, never a citation-shaped error", () => {
    const body = {
      success: true,
      url: PUBLIC_RESEARCH_URL,
      truncated: false,
      content:
        "There may be an optional header line. Fields containing line breaks (CRLF),\n double quotes, and commas should be enclosed in double-quotes.",
    };
    expect(publicFetchMatches(body)).toBe(true);
    expect(publicFetchMatches({ ...body, success: false })).toBe(false);
    expect(publicFetchMatches({ ...body, truncated: true })).toBe(false);
    expect(publicFetchMatches({ ...body, url: "https://example.invalid" })).toBe(false);
    expect(publicFetchMatches({ ...body, content: "RFC 4180 supports CSV." })).toBe(false);
  });
  it("refuses cross-run handoff copies, envelopes, missing first-worker assignment and same-run substitution", () => {
    const digest = sha256("core");
    const ref: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${digest}`,
      run_id: "producer",
      phase: "sealing_specification",
      branch_id: null,
      kind: "semantic-core",
      operation_id: "seal",
      version: 1,
      producer: "host:core-sealer",
      media_type: "application/json",
      content_schema: { schema_id: "penny.grounded-synthesis.v1", schema_version: 1 },
      byte_length: 4,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    };
    const session = { run_id: "consumer", input_ids: [ref.artifact_id] };
    expect(exactHandoffMatches(ref, "consumer", [ref], [session])).toBe(true);
    const specification = {
      ...ref,
      kind: "specification",
      producer: "host:specification-sealer",
      content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
    };
    expect(
      exactHandoffMatches(specification, "consumer", [specification], [session], "define")
    ).toBe(true);
    expect(
      exactHandoffMatches(specification, "consumer", [specification], [session], "research")
    ).toBe(false);
    expect(exactHandoffMatches(ref, "consumer", [ref], [session], "define")).toBe(false);
    const noSchema = { ...ref };
    delete noSchema.content_schema;
    expect(exactHandoffMatches(noSchema, "consumer", [noSchema], [session])).toBe(false);
    const wrongSchema = {
      ...specification,
      content_schema: { schema_id: "penny.grounded-synthesis.v1", schema_version: 1 },
    };
    expect(exactHandoffMatches(wrongSchema, "consumer", [wrongSchema], [session], "define")).toBe(
      false
    );
    expect(exactHandoffMatches(ref, "producer", [ref], [session])).toBe(false);
    expect(
      exactHandoffMatches(ref, "consumer", [{ ...ref, run_id: "chain-copy" }], [session])
    ).toBe(false);
    expect(
      exactHandoffMatches({ ...ref, kind: "product-envelope" }, "consumer", [ref], [session])
    ).toBe(false);
    expect(exactHandoffMatches(ref, "consumer", [ref], [])).toBe(false);
    expect(exactHandoffMatches(ref, "consumer", [ref], [{ ...session, input_ids: [] }])).toBe(
      false
    );
    expect(() => reviewedAssuranceMatches({ mode: "semantic_only" }, ref, "consumer")).toThrow();
    expect(() => exactQualityChecks("unenrolled", Buffer.from("{}"), ref)).toThrow(
      "No independent quality oracle"
    );
    for (const skill of ORDINARY_SKILLS)
      expect(() => exactQualityChecks(skill, Buffer.from("{}"), ref)).toThrow();
  });
  it("binds strict reviewed assurance to exact producer/consumer and refuses a valid semantic-only downgrade", () => {
    const digest = sha256("core");
    const ref: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${digest}`,
      run_id: "producer",
      phase: "sealing_specification",
      branch_id: null,
      kind: "semantic-core",
      operation_id: "seal",
      version: 1,
      producer: "host:specification-sealer",
      media_type: "application/json",
      byte_length: 4,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    };
    const shared = {
      schema_id: "penny.composition-assurance.v1",
      schema_version: 1,
      consumer: {
        run_id: "consumer",
        registration_name: "plan",
        contract_sha256: digest,
        registration_sha256: digest,
      },
      invocation_sha256: digest,
      request_ref: { ...ref, run_id: "consumer" },
      specification_ref: ref,
      checked_artifact_count: 1,
      checked_artifact_bytes: 4,
    };
    // Metadata-only validation fixture, NOT a real Define completion/assurance issuance.
    const reviewed = {
      ...shared,
      mode: "reviewed_definition",
      producer: {
        run_id: "producer",
        registration_name: "define",
        contract_sha256: digest,
        registration_sha256: digest,
        terminal_sha256: digest,
        completion_admission_sha256: digest,
      },
      immediate_parent: { status: "not_revision", ref: null },
      checked_artifacts: [
        {
          ref,
          roles: [
            "input_specification",
            "producer_request",
            "frame",
            "source_manifest",
            "evidence_admission",
            "draft",
            "trace",
            "validity_report",
            "quality_report",
            "validity_receipt",
            "quality_receipt",
            "integrity",
            "product_envelope",
          ].sort(),
        },
      ],
      owner_evidence: ["terminal", "completion_admission", "state_visit", "execution_receipt"].map(
        (record_class) => ({
          run_id: "producer",
          record_class,
          coordinate: "fixture",
          sha256: digest,
        })
      ),
      scope: [
        "canonical_semantics",
        "completed_define_trace_contract",
        "stored_support_readable",
        "immediate_revision_closure",
      ],
    };
    const signMetadata = (body: unknown) => ({
      ...(isRecord(body) ? body : {}),
      binding_sha256: sha256(canonicalJson(body)),
    });
    expect(reviewedAssuranceMatches(signMetadata(reviewed), ref, "consumer")).toBe(true);
    expect(reviewedAssuranceMatches(signMetadata(reviewed), ref, "foreign-consumer")).toBe(false);
    expect(
      reviewedAssuranceMatches(signMetadata(reviewed), { ...ref, run_id: "copy" }, "consumer")
    ).toBe(false);
    const semantic = {
      ...shared,
      mode: "semantic_only",
      producer: null,
      immediate_parent: null,
      checked_artifacts: [{ ref, roles: ["input_specification"] }],
      scope: ["canonical_semantics"],
    };
    expect(reviewedAssuranceMatches(signMetadata(semantic), ref, "consumer")).toBe(false);
  });
  it("checks each worker identity positively as well as rejecting a drifting sibling", () => {
    const good = inspectSession(fixtureSession("expected-provider", "expected-model"), roles, [
      "owned",
    ]);
    expect(good.checks.every((check) => check.passed)).toBe(true);
    const sibling = inspectSession(
      fixtureSession("unexpected-provider", "expected-model", true, "artifact_read", {
        worker_id: "sibling",
      }),
      roles,
      ["owned"]
    );
    expect(sibling.worker_id).not.toBe(good.worker_id);
    expect(sibling.checks.some((check) => !check.passed)).toBe(true);
  });
  it("binds RFC fetch scope to the selected task policy; historical Echo-only verification remains failed", () => {
    const publicRoles = [
      {
        ...roles[0],
        agent: "echo",
        alias: "alias",
        provider: "expected-provider",
        model: "expected-model",
      },
    ];
    const fixture = (
      url: string,
      success = true,
      callId = "fetch-1",
      agent = "echo",
      state = "researching",
      purpose = "phase",
      args: Record<string, unknown> = { url }
    ) =>
      fixtureSession(
        "expected-provider",
        "expected-model",
        true,
        "artifact_read",
        { state_id: state, agent, purpose },
        [
          {
            type: "message",
            message: {
              role: "assistant",
              provider: "expected-provider",
              model: "expected-model",
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: "fetch-1", name: "web_fetch", arguments: args }],
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "web_fetch",
              toolCallId: callId,
              isError: false,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success,
                    url,
                    truncated: false,
                    content:
                      "There may be an optional header line. Fields containing line breaks (CRLF), double quotes, and commas should be enclosed in double-quotes.",
                  }),
                },
              ],
            },
          },
        ]
      );
    const accepted = inspectSession(
      fixture(PUBLIC_RESEARCH_URL),
      publicRoles,
      ["owned"],
      ["owned"]
    );
    expect(accepted.checks.every((check) => check.passed)).toBe(true);
    expect(
      inspectSession(fixture(PUBLIC_RESEARCH_URL), publicRoles, ["owned"]).checks.some(
        (check) => !check.passed
      )
    ).toBe(true);
    const verificationRoles = [
      {
        ...publicRoles[0],
        agent: "vera",
        alias: "alias",
        provider: "expected-provider",
        model: "expected-model",
      },
    ];
    const verification = fixture(PUBLIC_RESEARCH_URL, true, "fetch-1", "vera", "validating");
    expect(
      inspectSession(
        verification,
        verificationRoles,
        ["owned"],
        ["owned"],
        "echo-only"
      ).checks.some((check) => !check.passed)
    ).toBe(true);
    expect(
      inspectSession(
        verification,
        verificationRoles,
        ["owned"],
        ["owned"],
        CURRENT_RESEARCH_FETCH_POLICY
      ).checks.every((check) => check.passed)
    ).toBe(true);
    for (const file of [
      fixture(PUBLIC_RESEARCH_URL, true, "fetch-1", "vera", "verifying_decision"),
      fixture(PUBLIC_RESEARCH_URL, true, "fetch-1", "vera", "validating", "routing_repair"),
      fixture("https://example.invalid", true, "fetch-1", "vera", "validating"),
      fixture(PUBLIC_RESEARCH_URL, false, "fetch-1", "vera", "validating"),
      fixture(PUBLIC_RESEARCH_URL, true, "wrong-call", "vera", "validating"),
      fixture(PUBLIC_RESEARCH_URL, true, "fetch-1", "vera", "validating", "phase", {
        url: PUBLIC_RESEARCH_URL,
        extra: true,
      }),
    ])
      expect(
        inspectSession(
          file,
          verificationRoles,
          ["owned"],
          ["owned"],
          CURRENT_RESEARCH_FETCH_POLICY
        ).checks.some((check) => !check.passed)
      ).toBe(true);
    const task = buildCohort("research-single", (skill) => skill).steps[0]?.goal;
    for (const brief of [task, LIVE_PROJECT_GUIDANCE]) {
      expect(brief).toContain(
        "Echo in researching (gathering) and Vera in validating (verification)"
      );
      expect(brief).toContain(PUBLIC_RESEARCH_URL);
    }
    for (const file of [
      fixture("https://example.invalid"),
      fixture(PUBLIC_RESEARCH_URL, false),
      fixture(PUBLIC_RESEARCH_URL, true, "not-the-call"),
    ]) {
      expect(
        inspectSession(file, publicRoles, ["owned"], ["owned"]).checks.some(
          (check) => !check.passed
        )
      ).toBe(true);
    }
  });
  it("retains legacy offline operands and keeps the contextual reader closed, without answer leakage", () => {
    expect(COHORTS).toEqual([
      "decide-assess-parallel",
      "produce-single",
      "diagnose-single",
      "research-single",
      "define-single",
      "plan-single",
      "decide-single",
      "assess-single",
      "define-plan-chain",
      "research-decide-chain",
      "plan-produce-context-chain",
      "two-source-fan-in",
    ]);
    const chain = buildCohort("plan-produce-context-chain", unitRunIds());
    expect(chain.steps.map((step) => step.skill_name)).toEqual(["plan", "produce"]);
    expect(chain.steps[1]?.previous_artifact_designation).toBe("context");
    const fan = fanInFixture();
    const serialized = JSON.stringify(fan.consumer);
    for (const value of ["East arch", "Violet lab", "17", "29"])
      expect(serialized).not.toContain(value);
    for (const consumer of [chain.steps[1], fan.consumer]) {
      if (consumer === undefined) throw new Error("Missing consumer");
      expect(consumer.constraints.source_material).toEqual([]);
      expect(JSON.stringify(consumer)).toContain("ID-only");
      for (const value of ["18:00", "18:30", '"free"'])
        expect(JSON.stringify(consumer)).not.toContain(value);
      expect(consumer.goal).toContain(
        "Do not use memory, web, shell, filesystem tools, child workflows"
      );
    }
    expect(() => buildCohort("two-source-fan-in", () => "same")).toThrow("distinct run ID");
  });
  it("dispatches explicit fan-in only from both exact public native refs, never separate producer success", () => {
    const { cohort, refs } = fanInFixture();
    const producers = {
      details: {
        success: true,
        mode: "parallel",
        parallel_results: refs.map((ref) => ({
          success: true,
          skill_name: "produce",
          session_id: ref.run_id,
          output_artifact_ref: ref,
        })),
      },
    };
    expect(fanInProducerRefs(producers, cohort)).toEqual(refs);
    expect(fanInConsumerParams(cohort, refs)).toEqual({
      ...cohort.steps[2],
      context_artifacts: refs.map((ref) => ref.artifact_id),
    });
    expect(publicResultMatches(producers, cohort)).toBe(false);
    expect(publicResultMatches({ invocations: [producers] }, cohort)).toBe(false);
    const consumer = {
      details: { success: true, skill_name: "produce", session_id: cohort.steps[2]?.session_id },
    };
    expect(publicResultMatches({ invocations: [producers, consumer] }, cohort)).toBe(true);
    expect(
      publicResultMatches(
        { invocations: [producers, { details: { ...consumer.details, success: false } }] },
        cohort
      )
    ).toBe(false);
    for (const invalid of [
      [],
      refs.slice(0, 1),
      [...refs].reverse(),
      [refs[0], refs[0]],
      refs.map((ref) => ({ ...ref, kind: "product-envelope" })),
    ])
      expect(() =>
        fanInConsumerParams(
          cohort,
          invalid.filter((ref): ref is ArtifactRef => ref !== undefined)
        )
      ).toThrow();
    expect(() =>
      fanInProducerRefs(
        {
          details: {
            ...producers.details,
            parallel_results: producers.details.parallel_results.slice(0, 1),
          },
        },
        cohort
      )
    ).toThrow();
  });
  it("validates native consumer bytes and BOTH substantive facts, rejecting omission, coercion, ID-only and promoted authority", () => {
    const { consumer, sources, refs, content, scenario } = fanInFixture();
    for (const [index, source] of sources.entries())
      expect(
        exactQualityChecks("produce", source.bytes, source.ref, undefined, {
          ...scenario,
          step_index: index,
          context_refs: [],
        }).every((check) => check.passed)
      ).toBe(true);
    const check = (value: unknown) => {
      const fixture = nativeProducedFixture(consumer, value);
      return exactQualityChecks("produce", fixture.bytes, fixture.ref, undefined, scenario).every(
        (item) => item.passed
      );
    };
    expect(check(content)).toBe(true);
    for (const value of [
      {},
      { provenance: content.provenance },
      { ...content, arrival: undefined },
      { ...content, venue: undefined },
      { ...content, arrival: { ...FAN_IN_ARRIVAL, queue_minutes: "17" } },
      { ...content, venue: { ...FAN_IN_VENUE, capacity: "29" } },
      { ...content, arrival: { ...FAN_IN_ARRIVAL, gate: "West arch" } },
      { ...content, venue: { ...FAN_IN_VENUE, room: "Green lab" } },
      { ...content, provenance: content.provenance.slice(0, 1) },
      { ...content, provenance: [...content.provenance].reverse() },
      ...["binding", "evidence", "approved"].map((designation) => ({
        ...content,
        provenance: content.provenance.map((item) => ({ ...item, designation })),
      })),
      {
        ...content,
        provenance: content.provenance.map((item) => ({ ...item, authority: "verified" })),
      },
      {
        ...content,
        provenance: content.provenance.map((item) => ({ ...item, kind: "specification" })),
      },
      {
        ...content,
        provenance: content.provenance.map((item) => ({
          ...item,
          artifact_id: refs[0]?.artifact_id,
        })),
      },
      {
        ...content,
        provenance: content.provenance.map((item) => ({ ...item, run_id: "consumer-copy" })),
      },
      { ...content, approved: true },
    ])
      expect(check(value), canonicalJson(value)).toBe(false);
    const good = nativeProducedFixture(consumer, content);
    for (const ref of [
      { ...good.ref, kind: "produced-artifact" },
      { ...good.ref, phase: "materializing_artifact" },
      { ...good.ref, producer: "agent:skribble" },
      {
        ...good.ref,
        content_schema: { schema_id: "penny.produced-artifact.v1", schema_version: 1 },
      },
    ])
      expect(() => exactQualityChecks("produce", good.bytes, ref, undefined, scenario)).toThrow();
    expect(() =>
      exactQualityChecks("produce", Buffer.from("{}"), good.ref, undefined, scenario)
    ).toThrow();
    expect(
      contextualProductMatches(
        {
          ...good.product,
          content: good.product.content.replace('"arrival":', '"arrival":{},"arrival":'),
        },
        scenario
      )
    ).toBe(false);
    expect(
      contextualProductMatches(
        {
          ...good.product,
          request: {
            ...good.product.request,
            source_material: [{ statement: "Promoted inline predecessor" }],
          },
        },
        scenario
      )
    ).toBe(false);
    expect(contextualProductMatches(good.product, { ...scenario, context_refs: [] })).toBe(false);
  });
  it("requires Plan meaning and original StrategyV2 context provenance in a native Produce product", () => {
    const chain = buildCohort("plan-produce-context-chain", unitRunIds());
    const [plan, consumer] = chain.steps;
    if (plan === undefined || consumer === undefined) throw new Error("Missing chain fixtures");
    // Metadata-only Plan source fixture. Live harness separately validates the actual StrategyV2 bytes.
    const base = fanInFixture().refs[0];
    if (base === undefined) throw new Error("Missing source fixture ref");
    const ref: ArtifactRef = {
      ...base,
      run_id: plan.session_id,
      kind: "strategy",
      content_schema: { schema_id: "penny.strategy.v2", schema_version: 2 },
    };
    const scenario: ProductScenario = {
      selection: chain.selection,
      step_index: 1,
      context_refs: [ref],
    };
    const content = {
      notice: NOTICE,
      provenance: [
        {
          artifact_id: ref.artifact_id,
          run_id: ref.run_id,
          kind: "strategy",
          schema_id: "penny.strategy.v2",
          schema_version: 2,
          designation: "context",
          authority: "nonbinding",
        },
      ],
    };
    const fixture = nativeProducedFixture(consumer, content);
    expect(
      exactQualityChecks("produce", fixture.bytes, fixture.ref, undefined, scenario).every(
        (check) => check.passed
      )
    ).toBe(true);
    for (const value of [
      { ...content, notice: { ...NOTICE, doors: "18:30", start: "18:00" } },
      { provenance: content.provenance },
      { ...content, notice: { ...NOTICE, entry: "paid" } },
    ])
      expect(
        contextualProductMatches({ ...fixture.product, content: canonicalJson(value) }, scenario)
      ).toBe(false);
  });
  it("requires exact designation, full refs and mandatory full reads in every downstream phase (fixture observations)", () => {
    expect(contextualHandoffFixture().matches()).toBe(true);
  });
  it("rejects promotion of either context into native selection, retaining genuine native refs", () => {
    const { refs, selected, matches } = contextualHandoffFixture();
    expect(selected).toHaveLength(1);
    expect(
      selected.every((ref) => refs.every((context) => context.artifact_id !== ref.artifact_id))
    ).toBe(true);
    expect(matches()).toBe(true);
    for (const ref of refs) {
      expect(matches(undefined, undefined, [...selected, ref])).toBe(false);
      // A stale metadata variant cannot hide native promotion of the same immutable ID.
      expect(
        matches(undefined, undefined, [...selected, { ...ref, version: ref.version + 1 }])
      ).toBe(false);
    }
  });
  it("requires complete ordered admitted designations, slots and every full-ref field", () => {
    const { expected, consumer, sessions, selected, matches } = contextualHandoffFixture();
    expect(
      contextualHandoffMatches(expected, consumer.session_id, undefined, selected, sessions)
    ).toBe(false);
    for (const artifacts of [
      [],
      expected.artifacts.slice(0, 1),
      [...expected.artifacts].reverse(),
      [...expected.artifacts, ...expected.artifacts],
    ])
      expect(matches(sessions, { ...expected, artifacts })).toBe(false);
    for (const [index, binding] of expected.artifacts.entries()) {
      const ref = binding.ref;
      const substitutions: ArtifactRef[] = [
        { ...ref, artifact_id: `art_${sha256("substitute")}` },
        { ...ref, run_id: "other-producer" },
        { ...ref, phase: "other-phase" },
        { ...ref, branch_id: "other-branch" },
        { ...ref, kind: "other-kind" },
        { ...ref, operation_id: "other-operation" },
        { ...ref, version: ref.version + 1 },
        { ...ref, producer: "host:other-producer" },
        { ...ref, media_type: "text/plain" },
        { ...ref, byte_length: ref.byte_length + 1 },
        { ...ref, content_digest: sha256("other-bytes") },
        { ...ref, store_ref: `artifact://sha256/${sha256("other-store")}` },
        { ...ref, content_schema: { schema_id: "penny.strategy.v2", schema_version: 2 } },
      ];
      const noSchema = { ...ref };
      delete noSchema.content_schema;
      substitutions.push(noSchema);
      for (const replacement of [
        { ...binding, slot: "other-slot" },
        { ...binding, designation: "binding" as const },
        { slot: binding.slot, ref },
        ...substitutions.map((ref) => ({ ...binding, ref })),
      ])
        expect(
          matches(sessions, {
            ...expected,
            artifacts: expected.artifacts.map((item, i) => (i === index ? replacement : item)),
          }),
          canonicalJson(replacement)
        ).toBe(false);
    }
    for (const invalid of [
      { ...expected, artifacts: [] },
      {
        ...expected,
        artifacts: expected.artifacts.map((binding) => ({
          ...binding,
          designation: "binding" as const,
        })),
      },
      {
        ...expected,
        artifacts: expected.artifacts.map((binding) => ({
          ...binding,
          ref: { ...binding.ref, run_id: consumer.session_id },
        })),
      },
      { ...expected, artifacts: [...expected.artifacts, ...expected.artifacts] },
    ])
      expect(
        contextualHandoffMatches(invalid, consumer.session_id, invalid, selected, sessions)
      ).toBe(false);
  });
  it.each(CONTEXT_CONSUMER_PHASES)(
    "requires %s phase coverage and exact delivery/mandatory reads",
    (state) => {
      const { expected, sessions, matches } = contextualHandoffFixture();
      const session = sessions.find((item) => item.state === state);
      if (session === undefined) throw new Error("Missing fixture phase");
      expect(matches()).toBe(true);
      expect(matches(sessions.filter((item) => item !== session))).toBe(false);
      // A fully read correction does not replace the required original phase observation.
      expect(
        matches(
          sessions.map((item) => (item === session ? { ...item, purpose: "routing_repair" } : item))
        )
      ).toBe(false);
      for (const mutation of contextInvocationMutations(session, expected))
        expect(
          matches(sessions.map((item) => (item === session ? mutation.session : item))),
          mutation.name
        ).toBe(false);
    }
  );
  it.each(CONTEXT_CONSUMER_PHASES)(
    "validates every additional %s routing repair, without dropping repair sessions",
    (state) => {
      const { expected, sessions, matches } = contextualHandoffFixture();
      const original = sessions.find((item) => item.state === state);
      if (original === undefined) throw new Error("Missing fixture phase");
      const repair = { ...original, purpose: "routing_repair" };
      expect(matches([...sessions, repair])).toBe(true);
      for (const mutation of contextInvocationMutations(repair, expected))
        expect(matches([...sessions, mutation.session]), mutation.name).toBe(false);
      // Additional phase invocations are not exempt either, even with all required phases present.
      for (const mutation of contextInvocationMutations(original, expected))
        expect(matches([...sessions, mutation.session]), mutation.name).toBe(false);
    }
  );
  it("parses fixture SDK JSONL for every phase and routing repair with full original refs and actual byte ranges (not live sessions)", () => {
    const { refs, sources, consumer, expected, selected, sessions } = contextualHandoffFixture();
    const original = sessions[0];
    if (original === undefined) throw new Error("Missing fixture session");
    const invocations = [...sessions, { ...original, purpose: "routing_repair" }];
    function observe(partialInvocation = -1, partialArtifact = "") {
      return invocations.map((invocation, index) => {
        const messages = sources.flatMap((source) => {
          const text = source.bytes.toString("utf8");
          const middle = Math.floor(source.bytes.length / 2);
          const partial = index === partialInvocation && source.ref.artifact_id === partialArtifact;
          return [[0, middle], ...(partial ? [] : [[middle, source.bytes.length]])].map(
            ([start, end]) => {
              if (start === undefined || end === undefined)
                throw new Error("Missing fixture range");
              return {
                type: "message",
                message: {
                  role: "toolResult",
                  toolName: "artifact_read",
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        ok: true,
                        artifact_ref: source.ref,
                        content_digest: source.ref.content_digest,
                        returned_range: { start, end },
                        content: text.slice(start, end),
                      }),
                    },
                  ],
                },
              };
            }
          );
        });
        const file = fixtureSession(
          "expected-provider",
          "expected-model",
          true,
          "artifact_read",
          {
            run_id: consumer.session_id,
            state_id: invocation.state,
            purpose: invocation.purpose,
          },
          [
            {
              type: "custom",
              customType: "penny.orchestration.worker-continuity",
              data: { task: invocation.task, input_artifacts: refs },
            },
            ...messages,
          ]
        );
        return inspectSession(file, roles, [consumer.session_id]);
      });
    }
    const full = observe();
    expect(full.every((session) => session.checks.every((check) => check.passed))).toBe(true);
    expect(full.map((session) => session.purpose)).toEqual([
      ...sessions.map(() => "phase"),
      "routing_repair",
    ]);
    expect(contextualHandoffMatches(expected, consumer.session_id, expected, selected, full)).toBe(
      true
    );
    for (const [index, invocation] of invocations.entries()) {
      for (const ref of refs) {
        const partial = observe(index, ref.artifact_id);
        const target = partial[index];
        if (target === undefined) throw new Error("Missing partial fixture observation");
        expect(
          target.assigned_reads.find((read) => read.artifact_id === ref.artifact_id)
        ).toMatchObject({ requirement: "mandatory", complete: false });
        expect(
          partial
            .filter((_session, i) => i !== index)
            .every((session) => session.checks.every((check) => check.passed))
        ).toBe(true);
        expect(
          contextualHandoffMatches(expected, consumer.session_id, expected, selected, partial),
          `${invocation.state}/${invocation.purpose}/${ref.artifact_id}`
        ).toBe(false);
      }
    }
  });
});

/** Fabricated parser observations ONLY. These are never live/provider evidence. */
function parentParserFixture() {
  const cohort = buildCohort("assess-single", unitRunIds());
  const step = requireNativeSingle(cohort);
  const root = mkdtempSync(path.join(tmpdir(), "penny-native-parent-parser-"));
  roots.push(root);
  const file = path.join(root, "parent.jsonl");
  const selected = { provider: "parser-fixture-provider", model: "parser-fixture-model" };
  const expansion = "<skill>exact native expansion parser fixture</skill>";
  const result = {
    content: [{ type: "text", text: "Parser fixture result, not a product or live response" }],
    details: {
      success: true,
      state: "complete",
      requires_approval: false,
      errors: [],
      skill_name: step.skill_name,
      session_id: step.session_id,
    },
  };
  const call = { type: "toolCall", name: "skill", id: "parent-call", arguments: cohort.params };
  const records = [
    { type: "model_change", provider: selected.provider, modelId: selected.model },
    { type: "message", message: { role: "user", content: [{ type: "text", text: expansion }] } },
    {
      type: "message",
      message: { role: "assistant", ...selected, stopReason: "toolUse", content: [call] },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "skill",
        toolCallId: call.id,
        isError: false,
        ...result,
      },
    },
  ];
  const observation: ParentObservation = {
    literal_prompt: `/skill:${step.skill_name} ${nativeParentRequest(cohort)}`,
    native_prompts: [expansion],
    provider_requests: 1,
    provider_streams: [{ ...selected, events: 1 }],
    dispatches: [{ toolCallId: call.id, args: cohort.params }],
    outcomes: [{ toolCallId: call.id, isError: false, result }],
    blocked_calls: 0,
  };
  const inspect = (
    observed: ParentObservation = observation,
    entries: readonly unknown[] = records
  ) => {
    atomicBytes(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return inspectParentSession(file, cohort, selected, expansion, observed);
  };
  return { cohort, observation, records, call, result, selected, inspect };
}

describe("native live parent evidence contract (offline fabricated parser inputs, never live qualification)", () => {
  it("requires caller-supplied 64hex expected generation and rejects unavailable/drifting real observations", () => {
    for (const value of [
      undefined,
      null,
      "",
      "a".repeat(63),
      "a".repeat(65),
      "G".repeat(64),
      "A".repeat(64),
      ` ${"a".repeat(64)}`,
      `${"a".repeat(64)}\n`,
    ])
      expect(() => requireExpectedGeneration(value)).toThrow(EXPECTED_GENERATION_ENV);
    for (const expected of ["a".repeat(64), "b".repeat(64)]) {
      expect(requireExpectedGeneration(expected)).toBe(expected);
      expect(() => assertExpectedGeneration(expected, { generation: expected })).not.toThrow();
      for (const current of [undefined, null, {}, { generation: "c".repeat(64) }])
        expect(() => assertExpectedGeneration(expected, current)).toThrow("generation");
      // The same campaign value is reused after work, never rebound to the after observation.
      assertExpectedGeneration(expected, { generation: expected });
      expect(() => assertExpectedGeneration(expected, { generation: "d".repeat(64) })).toThrow(
        "mismatch"
      );
    }
  });
  it("allows exactly the seven single operands and marks other live modes unimplemented before providers", () => {
    for (const selection of COHORTS) {
      const cohort = buildCohort(selection, unitRunIds());
      if (cohort.mode === "single") {
        expect(requireNativeSingle(cohort)).toEqual(cohort.steps[0]);
        expect(nativeParentRequest(cohort)).toContain(canonicalJson(cohort.params));
      } else {
        expect(() => requireNativeSingle(cohort)).toThrow("LIVE_MODE_NOT_IMPLEMENTED");
        expect(() => nativeParentRequest(cohort)).toThrow("LIVE_MODE_NOT_IMPLEMENTED");
      }
    }
    expect(COHORTS.filter((selection) => selection.endsWith("-single"))).toHaveLength(7);
  });
  it("cross-checks complete parser observations without changing original params or result bytes", () => {
    const f = parentParserFixture();
    const before = canonicalJson(f.cohort.params);
    expect(f.inspect().checks.every((check) => check.passed)).toBe(true);
    expect(canonicalJson(f.cohort.params)).toBe(before);
  });
  it("cannot bless provider-free, identity-drifting or failed parent responses", () => {
    const f = parentParserFixture();
    for (const observation of [
      { ...f.observation, provider_requests: 0, provider_streams: [] },
      { ...f.observation, provider_requests: 0 },
      { ...f.observation, provider_streams: [] },
      { ...f.observation, provider_streams: [{ ...f.selected, events: 0 }] },
      { ...f.observation, provider_streams: [{ ...f.selected, model: "other", events: 1 }] },
    ])
      expect(f.inspect(observation).checks.some((check) => !check.passed)).toBe(true);
    for (const stopReason of ["error", "aborted", "pending", "length"])
      expect(
        f
          .inspect(
            undefined,
            f.records.map((entry) =>
              entry.message?.role === "assistant"
                ? { ...entry, message: { ...entry.message, stopReason } }
                : entry
            )
          )
          .checks.some((check) => !check.passed)
      ).toBe(true);
    expect(
      f
        .inspect(
          undefined,
          f.records.filter((entry) => entry.message?.role !== "assistant")
        )
        .checks.some((check) => !check.passed)
    ).toBe(true);
  });
  it("requires actual native expansion in both SDK callback and persisted user message, not a manually dispatched result", () => {
    const f = parentParserFixture();
    for (const observed of [
      { ...f.observation, native_prompts: [] },
      { ...f.observation, native_prompts: ["plain prompt, no native expansion"] },
      { ...f.observation, literal_prompt: "direct tool request, not /skill:assess" },
    ])
      expect(f.inspect(observed).checks.some((check) => !check.passed)).toBe(true);
    expect(
      f
        .inspect(
          undefined,
          f.records.filter((entry) => entry.message?.role !== "user")
        )
        .checks.some((check) => !check.passed)
    ).toBe(true);
  });
  it("rejects every changed original invocation, especially auto-generated/replaced session IDs, with no repair", () => {
    const f = parentParserFixture();
    // Undefined cannot survive JSONL, but the live gate still rejects it before dispatch.
    const nonJsonAlteration = { ...f.cohort.params, extra: undefined };
    expect(exactParentInvocation(nonJsonAlteration, f.cohort)).toBe(false);
    expect(
      f
        .inspect({
          ...f.observation,
          dispatches: [{ toolCallId: f.call.id, args: nonJsonAlteration }],
        })
        .checks.some((check) => !check.passed)
    ).toBe(true);
    for (const altered of [
      { ...f.cohort.params, skill_name: "decide" },
      { ...f.cohort.params, session_id: "different-session" },
      { ...f.cohort.params, session_id: undefined },
      { ...f.cohort.params, goal: "rewritten goal" },
      { ...f.cohort.params, constraints: {} },
      { ...f.cohort.params, model: "unrequested/model" },
      { ...f.cohort.params, max_steps: 1 },
    ]) {
      expect(exactParentInvocation(altered, f.cohort)).toBe(false);
      expect(
        f
          .inspect({ ...f.observation, dispatches: [{ toolCallId: f.call.id, args: altered }] })
          .checks.some((check) => !check.passed)
      ).toBe(true);
      expect(
        f
          .inspect(
            undefined,
            f.records.map((entry) =>
              entry.message?.role === "assistant"
                ? {
                    ...entry,
                    message: { ...entry.message, content: [{ ...f.call, arguments: altered }] },
                  }
                : entry
            )
          )
          .checks.some((check) => !check.passed)
      ).toBe(true);
    }
  });
  it("requires model toolCall, actual SDK dispatch and result, exact correlation and original result readback", () => {
    const f = parentParserFixture();
    for (const observed of [
      { ...f.observation, dispatches: [] },
      { ...f.observation, outcomes: [] },
      { ...f.observation, dispatches: [...f.observation.dispatches, ...f.observation.dispatches] },
      {
        ...f.observation,
        outcomes: f.observation.outcomes.map((outcome) => ({ ...outcome, toolCallId: "foreign" })),
      },
      {
        ...f.observation,
        outcomes: f.observation.outcomes.map((outcome) => ({ ...outcome, isError: true })),
      },
      {
        ...f.observation,
        outcomes: f.observation.outcomes.map((outcome) => ({
          ...outcome,
          result: { ...f.result, content: [] },
        })),
      },
      { ...f.observation, blocked_calls: 1 },
    ])
      expect(f.inspect(observed).checks.some((check) => !check.passed)).toBe(true);
    for (const entries of [
      f.records.filter((entry) => entry.message?.role !== "toolResult"),
      f.records.map((entry) =>
        entry.message?.role === "assistant"
          ? { ...entry, message: { ...entry.message, content: [] } }
          : entry
      ),
      f.records.map((entry) =>
        entry.message?.role === "toolResult"
          ? { ...entry, message: { ...entry.message, toolCallId: "foreign" } }
          : entry
      ),
    ])
      expect(f.inspect(undefined, entries).checks.some((check) => !check.passed)).toBe(true);
  });
  it("never qualifies refusal, incomplete, approval or error results even when success is incorrectly true", () => {
    const f = parentParserFixture();
    for (const details of [
      { ...f.result.details, success: false },
      { ...f.result.details, state: "refused" },
      { ...f.result.details, state: "incomplete" },
      { ...f.result.details, refusal_code: "REFUSED" },
      { ...f.result.details, requires_approval: true },
      { ...f.result.details, errors: ["refusal"] },
      { ...f.result.details, session_id: "foreign" },
    ]) {
      const result = { ...f.result, details };
      const observation = {
        ...f.observation,
        outcomes: [{ toolCallId: f.call.id, isError: false, result }],
      };
      const records = f.records.map((entry) =>
        entry.message?.role === "toolResult"
          ? { ...entry, message: { ...entry.message, ...result } }
          : entry
      );
      expect(f.inspect(observation, records).checks.some((check) => !check.passed)).toBe(true);
    }
  });
  it("guards the actual live wiring against reintroducing manual invocation or cognition replacement", () => {
    const harness = readFileSync(
      path.resolve(import.meta.dirname, "../smoke/ordinary-skills-live.test.ts"),
      "utf8"
    );
    for (const bypass of [
      "createTestExtensionApi",
      "fauxProvider",
      "fauxToolCall",
      "vi.mock",
      "vi.spyOn",
      "resolveModel:",
      "skillsOverride:",
    ])
      expect(harness).not.toContain(bypass);
    expect(harness).not.toMatch(/\.execute\s*\(/u);
    expect(harness).toContain("await createAgentSession({");
    expect(harness).toContain("await session.bindExtensions({");
    expect(harness).toContain("await session.prompt(literalPrompt)");
    expect(harness).toContain('pi.on("tool_call"');
    expect(harness).toContain('event.type === "tool_execution_update"');
    expect(harness).toContain('cancellation.signal.addEventListener("abort", abortParent');
    expect(harness).not.toContain("Authorization is exactly two repeats");
  });
});
