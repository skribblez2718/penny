import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  JsonValueSchema,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type JsonValue,
  type OutputArtifactMetadata,
  type SkillContract,
  type StartRequest,
  validateContract,
  validateDirective,
} from "../contracts.js";
import { RunContext, type PendingBranch } from "../context.js";
import {
  assertResolvedModelIdentity,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
  validateModelDispatchGuardV1,
  validateModelExecutionReceiptV1,
} from "../required-model.js";
import type { FanAggregateCapabilityV1, Playbook } from "../playbooks/playbook.js";
import type {
  PlaybookRegistration,
  PreparedStartV1,
  StartAdmissionV1,
} from "../playbooks/registry.js";
import {
  admitScaP04Candidate,
  buildScaP04AcceptedCohortArtifact,
  buildScaP04SelectionPopulation,
  scaP04InputArtifacts,
} from "./p04-admission.js";
import {
  SCA_P04_SERIALIZED_OPENING_MAX_BYTES,
  SCA_P04_SERIALIZED_OPENING_RESERVE_BYTES,
} from "./p04-dispatch-guard.js";
import {
  SCA_P04_ACCEPTED_COHORT_V1_SCHEMA,
  SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P04_CONVERGENCE_MATRIX_V1_SCHEMA,
  SCA_P04_COVERAGE_DOSSIER_V1_SCHEMA,
  SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P04_EVIDENCE_MANIFEST_V1_SCHEMA,
  SCA_P04_GATE_V1_SCHEMA,
  SCA_P04_OBLIGATION_IDS,
  SCA_P04_OMISSION_DOSSIER_V1_SCHEMA,
  SCA_P04_POPULATION_V1_SCHEMA,
  SCA_P04_PROVIDER_OPENING_GUARD,
  SCA_P04_REQUIRED_MODEL,
  SCA_P04_REQUEST_V1_SCHEMA,
  SCA_P04_SCANNER_SPECIALIST,
  SCA_P04_SELECTION_DOSSIER_V1_SCHEMA,
  SCA_P04_SPECIALIST_DOSSIER_V1_SCHEMA,
  SCA_P04_SPECIALIST_IDS,
  SCA_P04_SPECIALIST_RESULT_V1_SCHEMA,
  SCA_P04_SPECIALIST_STATE,
  SCA_P04_SUCCESSOR_LEDGER_V1_SCHEMA,
  SCA_P04_TERMINAL_V1_SCHEMA,
  SCA_P04_TO_P05_TRANSITION_V1_SCHEMA,
  SCA_P04_UNDERDETECTED_SPECIALIST,
  ScaP04CognitivePayloadV1Schema,
  ScaP04DisclosureAdmissionV1Schema,
  ScaP04RequestV1Schema,
  ScaP04SpecialistResultV1Schema,
  scaP04SpecialistTask,
  scaP04StableDiscoveryId,
  validateScaP04AcceptedCohortV1,
  validateScaP04CognitivePayloadV1,
  validateScaP04ConvergenceMatrixV1,
  validateScaP04CoverageDossierV1,
  validateScaP04DisclosureAdmissionV1,
  validateScaP04EvidenceManifestV1,
  validateScaP04GateV1,
  validateScaP04OmissionDossierV1,
  validateScaP04RequestV1,
  validateScaP04SelectionDossierV1,
  validateScaP04SelectionPopulationV1,
  validateScaP04SpecialistDossierV1,
  validateScaP04SpecialistResultV1,
  validateScaP04SuccessorLedgerV1,
  validateScaP04TerminalV1,
  validateScaP04ToP05TransitionV1,
  withSelfDigest,
  type ScaP04CognitivePayloadV1,
  type ScaP04ConvergenceRowV1,
  type ScaP04DisclosureAdmissionV1,
  type ScaP04PopulationItemV1,
  type ScaP04SelectionPopulationV1,
  type ScaP04SpecialistResultItemV1,
  type ScaP04SpecialistResultV1,
} from "./p04-contracts.js";

export const SCA_P04_CANDIDATE_PLAYBOOK_NAME = "sca-p04-candidate" as const;
export const SCA_P04_START_V1_SCHEMA = "penny.sca-p04-candidate-start.v1" as const;
const PHASE = "SCA-P04" as const;
const PRODUCER = "host:sca-p04-candidate" as const;
const SELECTING = SCA_P04_SPECIALIST_STATE;
const FINAL = "finalizing_p04_candidate" as const;

const ScaP04StartConstraintsV1Schema = Type.Object(
  { p04_request: ScaP04RequestV1Schema },
  { additionalProperties: false, $id: SCA_P04_START_V1_SCHEMA }
);

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const prior = byId.get(ref.artifact_id);
    if (prior !== undefined && !same(prior, ref)) {
      throw new Error(`artifact '${ref.artifact_id}' has conflicting refs`);
    }
    byId.set(ref.artifact_id, ref);
  }
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}

function exactBytes(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) throw new Error(`${label} exact ref is absent`);
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`${label} exact bytes drifted`);
  }
  return bytes;
}

function exactJson(store: ArtifactHostStore, ref: ArtifactRef, label: string): unknown {
  const bytes = exactBytes(store, ref, label);
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return parsed;
  } catch (error) {
    throw new Error(`${label} is not JSON`, { cause: error });
  }
}

function latestSelected(
  context: RunContext,
  predicate: (ref: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts].reverse().find(predicate);
}

function persistJson(input: {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly schema_id: string;
  readonly schema_version: number;
  readonly value: unknown;
  readonly upstream_refs: readonly ArtifactRef[];
  readonly branch_id?: string | null;
  readonly context?: RunContext;
}): ArtifactRef {
  const content = canonicalJson(input.value);
  const branchId = input.branch_id ?? null;
  const prior = input.store.refFor(
    input.run_id,
    PHASE,
    branchId,
    input.kind,
    input.operation_id,
    1
  );
  if (prior !== null) {
    if (
      prior.content_digest !== sha256(content) ||
      input.store.readById(prior.artifact_id).toString("utf8") !== content
    ) {
      throw new Error(`P04 artifact '${input.operation_id}' conflicts with immutable prior bytes`);
    }
    input.store.select(prior);
    if (
      input.context !== undefined &&
      !input.context.selectedArtifacts.some((ref) => ref.artifact_id === prior.artifact_id)
    ) {
      input.context.selectedArtifacts.push(prior);
    }
    return prior;
  }
  const ref = input.store.persist({
    metadata: {
      schema_version: 2,
      run_id: input.run_id,
      phase: PHASE,
      branch_id: branchId,
      kind: input.kind,
      operation_id: input.operation_id,
      version: 1,
      producer: PRODUCER,
      media_type: "application/json",
      content_schema: { schema_id: input.schema_id, schema_version: input.schema_version },
      parent_ref: null,
      upstream_refs: uniqueRefs(input.upstream_refs),
    },
    content,
  });
  input.store.select(ref);
  if (input.context !== undefined) input.context.selectedArtifacts.push(ref);
  return ref;
}

function outputArtifact(
  runId: string,
  specialistId: string,
  agent: "annie" | "echo"
): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: runId,
    phase: SELECTING,
    branch_id: specialistId,
    kind: "sca-p04-specialist-output",
    operation_id: `sca-p04-${specialistId}-output`,
    version: 1,
    producer: `agent:${agent}`,
    media_type: "text/plain",
    content_schema: {
      schema_id: "penny.persisted-summary-line.v1",
      schema_version: 1,
    },
    parent_ref: null,
    upstream_refs: [],
  };
}

export interface ScaP04CognitiveAdmissionV1 {
  readonly request: { readonly run_id: string };
}

export interface ScaP04DisclosurePolicyAdmissionV1 {
  readonly request: { readonly run_id: string };
  readonly runtime_policy: { readonly max_payload_bytes_per_call: number };
  readonly p01_request: { readonly model_data_policy_ref: ArtifactRef };
  readonly model_data_policy: {
    readonly payload_limit_bytes: number;
    readonly destination_class: string;
    readonly provider_retention_status: string;
    readonly provider_retention_days: number;
    readonly provider_training_use: string;
    readonly data_classes: readonly {
      readonly data_class:
        | "source-code"
        | "scanner-evidence"
        | "dependency-coordinates"
        | "secrets"
        | "personal-data";
      readonly treatment: "deny" | "allow-minimized" | "allow-redacted";
    }[];
  };
}

export function buildScaP04CognitivePayload(input: {
  readonly admission: ScaP04CognitiveAdmissionV1;
  readonly population: ScaP04SelectionPopulationV1;
  readonly population_ref: ArtifactRef;
  readonly specialist_id:
    | typeof SCA_P04_SCANNER_SPECIALIST
    | typeof SCA_P04_UNDERDETECTED_SPECIALIST;
}): ScaP04CognitivePayloadV1 {
  const assignedItems = input.population.items.filter((item) =>
    item.assigned_specialists.includes(input.specialist_id)
  );
  const classes = new Set<"source-code" | "scanner-evidence" | "dependency-coordinates">();
  for (const item of assignedItems) {
    if (item.source_path !== null) classes.add("source-code");
    if (item.item_kind === "dependency_lead") classes.add("dependency-coordinates");
    if (item.item_kind !== "source_surface") classes.add("scanner-evidence");
  }
  if (classes.size === 0) classes.add("source-code");
  const body = {
    schema_id: SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA,
    schema_version: 1 as const,
    run_id: input.admission.request.run_id,
    phase_id: PHASE,
    call_id: `sca-p04-${input.specialist_id}`,
    specialist_id: input.specialist_id,
    purpose:
      input.specialist_id === SCA_P04_SCANNER_SPECIALIST
        ? ("scanner_dependency_lead_selection" as const)
        : ("underdetected_no_alert_selection" as const),
    population_ref: input.population_ref,
    population_sha256: input.population.population_sha256,
    source_snapshot_ref: input.population.source_snapshot_ref,
    required_model: SCA_P04_REQUIRED_MODEL,
    assigned_items: assignedItems,
    assigned_item_ids: assignedItems.map((item) => item.stable_id),
    evidence_data_classes: [...classes].sort(),
    minimization: {
      raw_source_embedded: false as const,
      secrets_embedded: false as const,
      personal_data_embedded: false as const,
      content_mode: "bounded_selection_metadata_and_exact_evidence_refs" as const,
    },
  };
  return validateScaP04CognitivePayloadV1(withSelfDigest(body, "payload_sha256"));
}

export function buildScaP04DisclosureAdmission(input: {
  readonly admission: ScaP04DisclosurePolicyAdmissionV1;
  readonly payload: ScaP04CognitivePayloadV1;
  readonly payload_ref: ArtifactRef;
  readonly agent: "annie" | "echo";
}): ScaP04DisclosureAdmissionV1 {
  const policy = input.admission.model_data_policy;
  const treatment = new Map(
    policy.data_classes.map((entry) => [entry.data_class, entry.treatment])
  );
  const included = new Set(input.payload.evidence_data_classes);
  const blockerCodes: string[] = [];
  const serializedOpeningByteLimit = Math.min(
    policy.payload_limit_bytes,
    input.admission.runtime_policy.max_payload_bytes_per_call,
    SCA_P04_SERIALIZED_OPENING_MAX_BYTES
  );
  const payloadCapacity = Math.max(
    0,
    serializedOpeningByteLimit - SCA_P04_SERIALIZED_OPENING_RESERVE_BYTES
  );
  if (input.payload_ref.byte_length > payloadCapacity) {
    blockerCodes.push("payload_size_denied");
  }
  if (
    policy.destination_class !== "cloud" ||
    policy.provider_retention_status !== "known" ||
    policy.provider_training_use !== "prohibited"
  ) {
    blockerCodes.push("destination_retention_or_training_denied");
  }
  const dataClasses = [
    "dependency-coordinates",
    "personal-data",
    "scanner-evidence",
    "secrets",
    "source-code",
  ] as const;
  const decisions = dataClasses.map((dataClass) => {
    const applied = treatment.get(dataClass);
    if (applied === undefined) blockerCodes.push(`missing_data_class:${dataClass}`);
    if (included.has(dataClass) && applied === "deny") {
      blockerCodes.push(`included_data_class_denied:${dataClass}`);
    }
    return {
      data_class: dataClass,
      included: included.has(dataClass),
      treatment: applied ?? ("deny" as const),
      minimization:
        included.has(dataClass) && dataClass === "dependency-coordinates"
          ? ("stable-identifiers-only" as const)
          : included.has(dataClass)
            ? ("normalized-metadata-only" as const)
            : ("excluded" as const),
    };
  });
  const body = {
    schema_id: SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
    schema_version: 1 as const,
    run_id: input.admission.request.run_id,
    phase_id: PHASE,
    call_id: input.payload.call_id,
    specialist_id: input.payload.specialist_id,
    agent: input.agent,
    directive_state_id: SELECTING,
    required_model: SCA_P04_REQUIRED_MODEL,
    model_data_policy_ref: input.admission.p01_request.model_data_policy_ref,
    model_data_policy_sha256: input.admission.p01_request.model_data_policy_ref.content_digest,
    payload_ref: input.payload_ref,
    payload_sha256: input.payload_ref.content_digest,
    payload_byte_length: input.payload_ref.byte_length,
    serialized_opening_byte_limit: serializedOpeningByteLimit,
    destination: "cloud" as const,
    retention_days: policy.provider_retention_days,
    training: "prohibited" as const,
    data_class_decisions: decisions,
    decision: blockerCodes.length === 0 ? ("allow" as const) : ("deny" as const),
    blocker_codes: [...new Set(blockerCodes)].sort(),
    evaluated_before_dispatch: true as const,
  };
  return validateScaP04DisclosureAdmissionV1(withSelfDigest(body, "admission_sha256"));
}

const START_ADMISSION: StartAdmissionV1 = {
  schema_id: SCA_P04_START_V1_SCHEMA,
  schema_version: 1,
  prepare(request: StartRequest): PreparedStartV1 {
    const constraints = validateContract(
      ScaP04StartConstraintsV1Schema,
      request.constraints,
      "SCA P04 start constraints"
    );
    const p04 = validateScaP04RequestV1(constraints.p04_request);
    if (
      request.identity.playbook !== SCA_P04_CANDIDATE_PLAYBOOK_NAME ||
      request.identity.run_id !== p04.run_id ||
      request.input_artifacts === undefined ||
      !same(request.input_artifacts, scaP04InputArtifacts(p04))
    ) {
      throw new Error("SCA P04 start identity or exact transition-rooted input set is invalid");
    }
    return {
      schema_id: SCA_P04_START_V1_SCHEMA,
      schema_version: 1,
      request,
      goal: request.goal,
      constraints,
      input_artifacts: request.input_artifacts,
      admission_data: p04,
    };
  },
  materialize(prepared, host) {
    if (host.artifactStore === undefined || prepared.input_artifacts === undefined) {
      throw new Error("SCA P04 materialization requires the host artifact store and exact inputs");
    }
    const clock = host.trustedClock ?? (() => new Date());
    const admitted = admitScaP04Candidate({
      store: host.artifactStore,
      request: prepared.admission_data,
      input_artifacts: prepared.input_artifacts,
      trusted_clock: clock,
    });
    const requestRef = persistJson({
      store: host.artifactStore,
      run_id: host.run_id,
      kind: "sca-p04-candidate-request",
      operation_id: "sca-p04-candidate-request",
      schema_id: SCA_P04_REQUEST_V1_SCHEMA,
      schema_version: 1,
      value: admitted.request,
      upstream_refs: prepared.input_artifacts.artifacts.map((binding) => binding.ref),
    });
    const now = clock();
    if (!Number.isFinite(now.getTime())) throw new Error("SCA P04 trusted clock is invalid");
    const cohort = buildScaP04AcceptedCohortArtifact({
      admission: admitted,
      p04_request_ref: requestRef,
      admitted_at: now.toISOString(),
    });
    const cohortRef = persistJson({
      store: host.artifactStore,
      run_id: host.run_id,
      kind: "sca-p04-accepted-cohort",
      operation_id: "sca-p04-accepted-cohort",
      schema_id: SCA_P04_ACCEPTED_COHORT_V1_SCHEMA,
      schema_version: 1,
      value: cohort,
      upstream_refs: [requestRef, ...admitted.transitive_refs],
    });
    const population = buildScaP04SelectionPopulation({
      admission: admitted,
      accepted_cohort_ref: cohortRef,
    });
    const populationRef = persistJson({
      store: host.artifactStore,
      run_id: host.run_id,
      kind: "sca-p04-selection-population",
      operation_id: "sca-p04-selection-population",
      schema_id: SCA_P04_POPULATION_V1_SCHEMA,
      schema_version: 1,
      value: population,
      upstream_refs: [cohortRef, ...admitted.transitive_refs],
    });
    const refs: ArtifactRef[] = [requestRef, cohortRef, populationRef];
    for (const specialistId of SCA_P04_SPECIALIST_IDS) {
      const agent = specialistId === SCA_P04_SCANNER_SPECIALIST ? "annie" : "echo";
      const payload = buildScaP04CognitivePayload({
        admission: admitted,
        population,
        population_ref: populationRef,
        specialist_id: specialistId,
      });
      const payloadRef = persistJson({
        store: host.artifactStore,
        run_id: host.run_id,
        kind: "sca-p04-cognitive-payload",
        operation_id: `sca-p04-${specialistId}-payload`,
        schema_id: SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA,
        schema_version: 1,
        value: payload,
        upstream_refs: [cohortRef, populationRef],
        branch_id: specialistId,
      });
      const disclosure = buildScaP04DisclosureAdmission({
        admission: admitted,
        payload,
        payload_ref: payloadRef,
        agent,
      });
      const disclosureRef = persistJson({
        store: host.artifactStore,
        run_id: host.run_id,
        kind: "sca-p04-disclosure-admission",
        operation_id: `sca-p04-${specialistId}-disclosure-admission`,
        schema_id: SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
        schema_version: 1,
        value: disclosure,
        upstream_refs: [payloadRef, admitted.p01_request.model_data_policy_ref],
        branch_id: specialistId,
      });
      refs.push(payloadRef, disclosureRef);
    }
    return refs;
  },
};

const P04DataSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    accepted_cohort_ref: ArtifactRefSchema,
    population_ref: ArtifactRefSchema,
    payload_refs: Type.Record(Type.String(), ArtifactRefSchema),
    disclosure_refs: Type.Record(Type.String(), ArtifactRefSchema),
  },
  { additionalProperties: false }
);
type P04Data = Readonly<Static<typeof P04DataSchema>>;

function data(context: RunContext): P04Data {
  return validateContract(P04DataSchema, context.playbookData, "SCA P04 durable state");
}

function exactRefPair(refs: readonly ArtifactRef[], label: string): [ArtifactRef, ArtifactRef] {
  const [first, second, ...extra] = uniqueRefs(refs);
  if (first === undefined || second === undefined || extra.length !== 0) {
    throw new Error(`${label} requires exactly two unique refs`);
  }
  return [first, second];
}

function specialistAgent(specialistId: string): "annie" | "echo" {
  if (specialistId === SCA_P04_SCANNER_SPECIALIST) return "annie";
  if (specialistId === SCA_P04_UNDERDETECTED_SPECIALIST) return "echo";
  throw new Error(`unknown P04 specialist '${specialistId}'`);
}

export class ScaP04CandidatePlaybook implements Playbook, FanAggregateCapabilityV1 {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly trustedClock: () => Date = () => new Date()
  ) {}

  initialize(context: RunContext): Directive {
    const requestRef = latestSelected(
      context,
      (ref) =>
        ref.run_id === context.identity.run_id &&
        ref.kind === "sca-p04-candidate-request" &&
        ref.content_schema?.schema_id === SCA_P04_REQUEST_V1_SCHEMA
    );
    const cohortRef = latestSelected(
      context,
      (ref) =>
        ref.run_id === context.identity.run_id &&
        ref.kind === "sca-p04-accepted-cohort" &&
        ref.content_schema?.schema_id === SCA_P04_ACCEPTED_COHORT_V1_SCHEMA
    );
    const populationRef = latestSelected(
      context,
      (ref) =>
        ref.run_id === context.identity.run_id &&
        ref.kind === "sca-p04-selection-population" &&
        ref.content_schema?.schema_id === SCA_P04_POPULATION_V1_SCHEMA
    );
    if (requestRef === undefined || cohortRef === undefined || populationRef === undefined) {
      throw new Error("SCA P04 admitted request/cohort/population is absent");
    }
    const request = validateScaP04RequestV1(exactJson(this.store, requestRef, "P04 request"));
    const cohort = validateScaP04AcceptedCohortV1(
      exactJson(this.store, cohortRef, "P04 accepted cohort")
    );
    const population = validateScaP04SelectionPopulationV1(
      exactJson(this.store, populationRef, "P04 population")
    );
    if (
      !same(cohort.p04_request_ref, requestRef) ||
      !same(population.accepted_cohort_ref, cohortRef) ||
      request.run_id !== context.identity.run_id
    ) {
      throw new Error("SCA P04 entry artifacts do not form one exact cohort");
    }
    const payloadRefs: Record<string, ArtifactRef> = {};
    const disclosureRefs: Record<string, ArtifactRef> = {};
    const disclosureBlockers: string[] = [];
    for (const specialistId of SCA_P04_SPECIALIST_IDS) {
      const payloadRef = latestSelected(
        context,
        (ref) =>
          ref.branch_id === specialistId &&
          ref.kind === "sca-p04-cognitive-payload" &&
          ref.content_schema?.schema_id === SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA
      );
      const disclosureRef = latestSelected(
        context,
        (ref) =>
          ref.branch_id === specialistId &&
          ref.kind === "sca-p04-disclosure-admission" &&
          ref.content_schema?.schema_id === SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA
      );
      if (payloadRef === undefined || disclosureRef === undefined) {
        throw new Error(`SCA P04 '${specialistId}' payload or disclosure admission is absent`);
      }
      const payload = validateScaP04CognitivePayloadV1(
        exactJson(this.store, payloadRef, `P04 ${specialistId} payload`)
      );
      const disclosure = validateScaP04DisclosureAdmissionV1(
        exactJson(this.store, disclosureRef, `P04 ${specialistId} disclosure`)
      );
      if (
        payload.specialist_id !== specialistId ||
        disclosure.specialist_id !== specialistId ||
        !same(disclosure.payload_ref, payloadRef) ||
        disclosure.payload_sha256 !== payloadRef.content_digest ||
        disclosure.payload_byte_length !== payloadRef.byte_length
      ) {
        throw new Error(`SCA P04 '${specialistId}' payload/disclosure binding drift`);
      }
      if (disclosure.decision !== "allow") disclosureBlockers.push(...disclosure.blocker_codes);
      payloadRefs[specialistId] = payloadRef;
      disclosureRefs[specialistId] = disclosureRef;
    }
    Object.assign(context.playbookData, {
      request_ref: requestRef,
      accepted_cohort_ref: cohortRef,
      population_ref: populationRef,
      payload_refs: payloadRefs,
      disclosure_refs: disclosureRefs,
    });
    if (disclosureBlockers.length > 0) {
      context.transition(FINAL);
      return this.terminal(context, "blocked", false, [
        "disclosure_admission_denied",
        ...disclosureBlockers,
      ]);
    }
    context.transition(SELECTING);
    return this.issueSpecialists(context);
  }

  dispatch(context: RunContext): Directive {
    if (context.stateId !== SELECTING) {
      throw new Error(`SCA P04 has no dispatch for '${context.stateId}'`);
    }
    return this.issueSpecialists(context);
  }

  resume(): Directive {
    throw new Error("SCA P04 candidate has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = "sca_p04_cancelled";
    context.status = "cancelled";
    context.met = false;
    // Preserve every checkpointed branch result/attempt for recovery and forensic truth.
    const terminal = validateScaP04TerminalV1({
      schema_id: SCA_P04_TERMINAL_V1_SCHEMA,
      schema_version: 1,
      phase_id: PHASE,
      status: "cancelled",
      gate_ref: null,
      p05_transition_ref: null,
      p05_authorized: false,
      selected_artifact_refs: this.terminalArtifacts(context),
      blocker_codes: [
        reason.startsWith("model call outcome remote_unknown")
          ? "remote_model_outcome_unknown"
          : reason.startsWith("pre-dispatch policy denied")
            ? "pre_dispatch_policy_denied"
            : "caller_cancelled",
      ],
      nonterminal_campaign: true,
    });
    const directive = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: terminal,
      artifacts: this.terminalArtifacts(context),
      unresolved: [reason],
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  aggregateBranches(branchDetails: readonly unknown[]): Record<string, JsonValue> {
    const results = branchDetails
      .map((value) => validateScaP04SpecialistResultV1(value))
      .sort((left, right) => left.specialist_id.localeCompare(right.specialist_id));
    if (
      results.length !== 2 ||
      results[0]?.specialist_id !== SCA_P04_SCANNER_SPECIALIST ||
      results[1]?.specialist_id !== SCA_P04_UNDERDETECTED_SPECIALIST
    ) {
      throw new Error("SCA P04 fan requires exactly the two registered specialist results");
    }
    return {
      complete: true,
      specialists: validateContract(JsonValueSchema, results, "P04 specialist aggregate"),
    };
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    if (
      context.stateId !== SELECTING ||
      details.complete !== true ||
      !Array.isArray(details.specialists)
    ) {
      throw new Error("SCA P04 only accepts one complete two-specialist aggregate");
    }
    const results = details.specialists
      .map((value) => validateScaP04SpecialistResultV1(value))
      .sort((left, right) => left.specialist_id.localeCompare(right.specialist_id));
    const completedBranches = [...context.pendingBranches];
    context.transition(FINAL);
    return this.finalize(context, results, completedBranches);
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    if (context.stateId !== SELECTING) return context.pendingDirective;
    const incomplete = context.pendingBranches.filter((branch) => !branch.completed);
    if (incomplete.length === 0) {
      throw new Error("SCA P04 selecting checkpoint has no incomplete branch to recover");
    }
    for (const branch of incomplete) {
      const coordinate = {
        run_id: context.identity.run_id,
        state_id: SELECTING,
        branch_id: branch.branch_id,
        agent: branch.agent,
        attempt: branch.attempt,
      };
      if (
        this.store.refFor(
          context.identity.run_id,
          SELECTING,
          branch.branch_id,
          "model-dispatch-guard",
          modelDispatchGuardOperationId(coordinate),
          1
        ) !== null
      ) {
        return this.cancel(
          context,
          "model call outcome remote_unknown; durable dispatch fencing prohibits automatic replay"
        );
      }
    }
    return this.issueSpecialists(context);
  }

  private issueSpecialists(context: RunContext): Directive {
    const state = data(context);
    const initial = context.pendingBranches.length === 0;
    const existingById = new Map(
      context.pendingBranches.map((branch) => [branch.branch_id, branch])
    );
    if (
      !initial &&
      (context.pendingBranches.length !== SCA_P04_SPECIALIST_IDS.length ||
        SCA_P04_SPECIALIST_IDS.some((specialistId) => !existingById.has(specialistId)))
    ) {
      throw new Error("SCA P04 durable specialist branch set is incomplete or substituted");
    }
    const specialistIds = initial
      ? [...SCA_P04_SPECIALIST_IDS]
      : SCA_P04_SPECIALIST_IDS.filter(
          (specialistId) => existingById.get(specialistId)?.completed === false
        );
    if (specialistIds.length === 0) {
      throw new Error("SCA P04 has no incomplete specialist branch to dispatch");
    }
    const branches = specialistIds.map((specialistId) => {
      const agent = specialistAgent(specialistId);
      const prior = existingById.get(specialistId);
      if (prior !== undefined && prior.agent !== agent) {
        throw new Error(`SCA P04 '${specialistId}' durable agent binding drift`);
      }
      const payloadRef = state.payload_refs[specialistId];
      const disclosureRef = state.disclosure_refs[specialistId];
      if (payloadRef === undefined || disclosureRef === undefined) {
        throw new Error(`SCA P04 '${specialistId}' admitted payload refs are absent`);
      }
      const artifact = outputArtifact(context.identity.run_id, specialistId, agent);
      artifact.upstream_refs = [payloadRef, disclosureRef];
      return {
        branch_id: specialistId,
        state_id: SELECTING,
        agent,
        attempt: prior?.attempt ?? 1,
        task: scaP04SpecialistTask(specialistId),
        input_artifacts: {
          schema_version: 2 as const,
          artifacts: [
            { slot: "cognitive_payload", ref: payloadRef },
            { slot: "disclosure_admission", ref: disclosureRef },
          ],
        },
        output_artifact: artifact,
        trust_profile: "hardened-untrusted" as const,
        model_override: SCA_P04_REQUIRED_MODEL.override,
      };
    });
    const directive = validateDirective({
      schema_version: 2,
      action: "invoke_agents_parallel",
      identity: context.identity,
      state_id: SELECTING,
      branches,
    });
    if (initial) {
      context.pendingBranches = branches.map(
        (branch): PendingBranch => ({
          branch_id: branch.branch_id,
          agent: branch.agent,
          attempt: branch.attempt,
          completed: false,
          confidence: null,
          result: null,
          artifact: null,
        })
      );
    } else {
      for (const branch of context.pendingBranches) {
        if (
          branch.completed &&
          (branch.confidence === null || branch.result === null || branch.artifact === null)
        ) {
          throw new Error(
            `SCA P04 '${branch.branch_id}' completed checkpoint evidence is incomplete`
          );
        }
      }
    }
    context.pendingDirective = directive;
    return directive;
  }

  private validateBranchResult(
    population: ScaP04SelectionPopulationV1,
    branch: PendingBranch,
    result: ScaP04SpecialistResultV1
  ): void {
    if (branch.artifact === null || branch.agent !== specialistAgent(result.specialist_id)) {
      throw new Error(`SCA P04 '${result.specialist_id}' branch artifact/agent is absent or wrong`);
    }
    const expectedIds = population.items
      .filter((item) => item.assigned_specialists.includes(result.specialist_id))
      .map((item) => item.stable_id);
    if (
      result.population_sha256 !== population.population_sha256 ||
      !same(result.assigned_item_ids, expectedIds)
    ) {
      throw new Error(`SCA P04 '${result.specialist_id}' assignment/population binding drift`);
    }
    const items = new Map(population.items.map((item) => [item.stable_id, item]));
    for (const entry of result.results) {
      const item = items.get(entry.stable_id);
      if (item === undefined || !item.assigned_specialists.includes(result.specialist_id)) {
        throw new Error(`SCA P04 '${result.specialist_id}' returned an unassigned stable id`);
      }
      if (
        entry.evidence_refs.some(
          (ref) => !item.evidence_refs.some((admitted) => same(admitted, ref))
        )
      ) {
        throw new Error(`SCA P04 '${entry.stable_id}' result cites non-admitted exact evidence`);
      }
      for (const ref of entry.evidence_refs) exactBytes(this.store, ref, "P04 result evidence");
    }
    for (const discovery of result.discoveries) {
      const basis = items.get(discovery.basis_item_id);
      const expected = scaP04StableDiscoveryId({
        source_snapshot_sha256: population.source_snapshot_sha256,
        specialist_id: result.specialist_id,
        basis_item_id: discovery.basis_item_id,
        normalized_locator: discovery.normalized_locator,
        evidence_refs: discovery.evidence_refs,
      });
      if (
        basis === undefined ||
        !basis.assigned_specialists.includes(result.specialist_id) ||
        discovery.stable_id !== expected ||
        discovery.evidence_refs.some(
          (ref) => !basis.evidence_refs.some((admitted) => same(admitted, ref))
        )
      ) {
        throw new Error(
          `SCA P04 '${result.specialist_id}' discovery is not exact-ref bound to its assigned basis item`
        );
      }
      for (const ref of discovery.evidence_refs) {
        exactBytes(this.store, ref, "P04 discovery evidence");
      }
    }
  }

  private executionEvidence(
    context: RunContext,
    branch: PendingBranch
  ): { readonly guard_ref: ArtifactRef; readonly receipt_ref: ArtifactRef } {
    if (branch.artifact === null) throw new Error("P04 branch output artifact is absent");
    const coordinate = {
      run_id: context.identity.run_id,
      state_id: SELECTING,
      branch_id: branch.branch_id,
      agent: branch.agent,
      attempt: branch.attempt,
    };
    const guardRef = this.store.refFor(
      context.identity.run_id,
      SELECTING,
      branch.branch_id,
      "model-dispatch-guard",
      modelDispatchGuardOperationId(coordinate),
      1
    );
    const receiptRef = this.store.refFor(
      context.identity.run_id,
      SELECTING,
      branch.branch_id,
      "model-execution-receipt",
      modelExecutionReceiptOperationId(coordinate),
      1
    );
    if (guardRef === null || receiptRef === null) {
      throw new Error(`P04 '${branch.branch_id}' durable model identity evidence is absent`);
    }
    const guard = validateModelDispatchGuardV1(
      exactJson(this.store, guardRef, "P04 model dispatch guard")
    );
    if (
      branch.branch_id !== SCA_P04_SCANNER_SPECIALIST &&
      branch.branch_id !== SCA_P04_UNDERDETECTED_SPECIALIST
    ) {
      throw new Error(`P04 execution evidence has unknown branch '${branch.branch_id}'`);
    }
    const state = data(context);
    const payloadRef = state.payload_refs[branch.branch_id];
    const disclosureRef = state.disclosure_refs[branch.branch_id];
    if (payloadRef === undefined || disclosureRef === undefined) {
      throw new Error(`P04 '${branch.branch_id}' execution input refs are absent`);
    }
    const expectedInputArtifacts = {
      schema_version: 2 as const,
      artifacts: [
        { slot: "cognitive_payload", ref: payloadRef },
        { slot: "disclosure_admission", ref: disclosureRef },
      ],
    };
    if (
      !same(guard.coordinate, coordinate) ||
      guard.input_artifacts_sha256 !== sha256(canonicalJson(expectedInputArtifacts)) ||
      !same(guard.requested_model, SCA_P04_REQUIRED_MODEL) ||
      guard.provider_opening_guard !== SCA_P04_PROVIDER_OPENING_GUARD ||
      guard.serialized_opening_byte_length <= 0
    ) {
      throw new Error(`P04 '${branch.branch_id}' dispatch guard opening/model binding drift`);
    }
    const wrapper = validateModelExecutionReceiptV1(
      exactJson(this.store, receiptRef, "P04 model execution receipt")
    );
    if (!same(wrapper.dispatch_guard_ref, guardRef)) {
      throw new Error(`P04 '${branch.branch_id}' execution receipt wrapper drift`);
    }
    const receipt = wrapper.execution_receipt;
    if (
      receipt.run_id !== coordinate.run_id ||
      receipt.state_id !== coordinate.state_id ||
      receipt.branch_id !== coordinate.branch_id ||
      receipt.agent !== coordinate.agent ||
      receipt.attempt !== coordinate.attempt ||
      !same(receipt.requested_model, SCA_P04_REQUIRED_MODEL) ||
      receipt.observed_model === undefined ||
      !same(receipt.output_artifact_ref, branch.artifact)
    ) {
      throw new Error(`P04 '${branch.branch_id}' requested/observed/output receipt binding drift`);
    }
    assertResolvedModelIdentity(
      SCA_P04_REQUIRED_MODEL,
      receipt.observed_model,
      "P04 observed model"
    );
    return { guard_ref: guardRef, receipt_ref: receiptRef };
  }

  private finalize(
    context: RunContext,
    results: readonly ScaP04SpecialistResultV1[],
    completedBranches: readonly PendingBranch[]
  ): Directive {
    const state = data(context);
    const request = validateScaP04RequestV1(
      exactJson(this.store, state.request_ref, "P04 request")
    );
    const cohort = validateScaP04AcceptedCohortV1(
      exactJson(this.store, state.accepted_cohort_ref, "P04 accepted cohort")
    );
    const population = validateScaP04SelectionPopulationV1(
      exactJson(this.store, state.population_ref, "P04 population")
    );
    const branches = [...completedBranches].sort((left, right) =>
      left.branch_id.localeCompare(right.branch_id)
    );
    if (branches.length !== 2 || results.length !== 2) {
      throw new Error("P04 finalization requires exactly two durable specialist branches");
    }
    const dossierRefs: ArtifactRef[] = [];
    const outputRefs: ArtifactRef[] = [];
    const guardRefs: ArtifactRef[] = [];
    const receiptRefs: ArtifactRef[] = [];
    for (const result of results) {
      const branch = branches.find((candidate) => candidate.branch_id === result.specialist_id);
      if (branch === undefined) throw new Error(`P04 branch '${result.specialist_id}' is absent`);
      this.validateBranchResult(population, branch, result);
      const execution = this.executionEvidence(context, branch);
      const outputRef = branch.artifact;
      if (outputRef === null) throw new Error("P04 specialist output ref is absent");
      const payloadRef = state.payload_refs[result.specialist_id];
      const disclosureRef = state.disclosure_refs[result.specialist_id];
      if (payloadRef === undefined || disclosureRef === undefined) {
        throw new Error("P04 specialist admission refs are absent");
      }
      const dossierBody = {
        schema_id: SCA_P04_SPECIALIST_DOSSIER_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: context.identity.run_id,
        phase_id: PHASE,
        specialist_id: result.specialist_id,
        role: result.role,
        agent: specialistAgent(result.specialist_id),
        source_output_ref: outputRef,
        cognitive_payload_ref: payloadRef,
        disclosure_admission_ref: disclosureRef,
        dispatch_guard_ref: execution.guard_ref,
        model_execution_receipt_ref: execution.receipt_ref,
        result,
      };
      const dossier = validateScaP04SpecialistDossierV1(
        withSelfDigest(dossierBody, "dossier_sha256")
      );
      const dossierRef = persistJson({
        store: this.store,
        context,
        run_id: context.identity.run_id,
        kind: "sca-p04-specialist-dossier",
        operation_id: `sca-p04-${result.specialist_id}-dossier`,
        schema_id: SCA_P04_SPECIALIST_DOSSIER_V1_SCHEMA,
        schema_version: 1,
        value: dossier,
        upstream_refs: [
          outputRef,
          payloadRef,
          disclosureRef,
          execution.guard_ref,
          execution.receipt_ref,
        ],
        branch_id: result.specialist_id,
      });
      dossierRefs.push(dossierRef);
      outputRefs.push(outputRef);
      guardRefs.push(execution.guard_ref);
      receiptRefs.push(execution.receipt_ref);
    }

    const resultBySpecialist = new Map(results.map((result) => [result.specialist_id, result]));
    const rows: ScaP04ConvergenceRowV1[] = [];
    const finalMetadata = new Map<
      string,
      {
        origin: "initial_population" | "branch_discovery";
        source_path: string | null;
        package_coordinate: string | null;
        evidence_refs: ArtifactRef[];
        specialist_ids: string[];
        alert_state: ScaP04PopulationItemV1["alert_state"];
      }
    >();
    for (const item of population.items) {
      const recommendations = item.assigned_specialists.map((specialistId) => {
        const entry = resultBySpecialist
          .get(specialistId)
          ?.results.find((candidate) => candidate.stable_id === item.stable_id);
        if (entry === undefined)
          throw new Error(`P04 '${item.stable_id}' lacks specialist accounting`);
        return {
          specialist_id: specialistId,
          recommendation: entry.recommendation,
          reason_code: entry.reason_code,
          evidence_status: entry.evidence_status,
          uncertainty_code: entry.uncertainty_code,
          p05_question_codes: entry.p05_question_codes,
          evidence_refs: entry.evidence_refs,
        };
      });
      rows.push(this.convergeRow(item.stable_id, "initial_population", recommendations));
      finalMetadata.set(item.stable_id, {
        origin: "initial_population",
        source_path: item.source_path,
        package_coordinate: item.package_coordinate,
        evidence_refs: uniqueRefs(recommendations.flatMap((entry) => entry.evidence_refs)),
        specialist_ids: [...item.assigned_specialists],
        alert_state: item.alert_state,
      });
    }
    for (const result of results) {
      for (const discovery of result.discoveries) {
        rows.push(
          this.convergeRow(discovery.stable_id, "branch_discovery", [
            {
              specialist_id: result.specialist_id,
              recommendation: discovery.recommendation,
              reason_code: discovery.reason_code,
              evidence_status: "bounded_but_usable",
              uncertainty_code: "bounded_metadata_only",
              p05_question_codes: [],
              evidence_refs: discovery.evidence_refs,
            },
          ])
        );
        finalMetadata.set(discovery.stable_id, {
          origin: "branch_discovery",
          source_path: discovery.source_path,
          package_coordinate: discovery.package_coordinate,
          evidence_refs: uniqueRefs(discovery.evidence_refs),
          specialist_ids: [result.specialist_id],
          alert_state: "not_applicable",
        });
      }
    }
    rows.sort((left, right) => left.stable_id.localeCompare(right.stable_id));
    const convergenceBody = {
      schema_id: SCA_P04_CONVERGENCE_MATRIX_V1_SCHEMA,
      schema_version: 1 as const,
      run_id: context.identity.run_id,
      phase_id: PHASE,
      population_ref: state.population_ref,
      specialist_dossier_refs: exactRefPair(dossierRefs, "P04 convergence dossiers"),
      rows,
      reconciler: "deterministic_host_union_partition" as const,
      semantic_model_call_used: false as const,
    };
    const convergence = validateScaP04ConvergenceMatrixV1(
      withSelfDigest(convergenceBody, "matrix_sha256")
    );
    const convergenceRef = persistJson({
      store: this.store,
      context,
      run_id: context.identity.run_id,
      kind: "sca-p04-convergence-matrix",
      operation_id: "sca-p04-convergence-matrix",
      schema_id: SCA_P04_CONVERGENCE_MATRIX_V1_SCHEMA,
      schema_version: 1,
      value: convergence,
      upstream_refs: [state.population_ref, ...dossierRefs],
    });

    const selected = rows
      .filter((row) => row.final_disposition === "selected_for_p05")
      .map((row) => {
        const metadata = finalMetadata.get(row.stable_id);
        if (metadata === undefined) throw new Error("P04 selected metadata is absent");
        return {
          stable_id: row.stable_id,
          origin: metadata.origin,
          source_path: metadata.source_path,
          package_coordinate: metadata.package_coordinate,
          reason_code: row.host_reason_code,
          evidence_refs: metadata.evidence_refs,
        };
      });
    const omitted = rows
      .filter((row) => row.final_disposition !== "selected_for_p05")
      .map((row) => {
        const metadata = finalMetadata.get(row.stable_id);
        if (metadata === undefined) throw new Error("P04 omitted metadata is absent");
        return {
          stable_id: row.stable_id,
          origin: metadata.origin,
          source_path: metadata.source_path,
          package_coordinate: metadata.package_coordinate,
          reason_code: row.host_reason_code,
          evidence_refs: metadata.evidence_refs,
          disposition: row.final_disposition,
          safe_claim: false as const,
        };
      });
    const selection = validateScaP04SelectionDossierV1(
      withSelfDigest(
        {
          schema_id: SCA_P04_SELECTION_DOSSIER_V1_SCHEMA,
          schema_version: 1 as const,
          run_id: context.identity.run_id,
          phase_id: PHASE,
          convergence_matrix_ref: convergenceRef,
          selected,
          selected_count: selected.length,
          purpose: "bounded_input_for_p05_analysis" as const,
          adjudication_status: "not_performed" as const,
        },
        "dossier_sha256"
      )
    );
    const selectionRef = persistJson({
      store: this.store,
      context,
      run_id: context.identity.run_id,
      kind: "sca-p04-selection-dossier",
      operation_id: "sca-p04-selection-dossier",
      schema_id: SCA_P04_SELECTION_DOSSIER_V1_SCHEMA,
      schema_version: 1,
      value: selection,
      upstream_refs: [convergenceRef],
    });
    const omission = validateScaP04OmissionDossierV1(
      withSelfDigest(
        {
          schema_id: SCA_P04_OMISSION_DOSSIER_V1_SCHEMA,
          schema_version: 1 as const,
          run_id: context.identity.run_id,
          phase_id: PHASE,
          convergence_matrix_ref: convergenceRef,
          omitted,
          omitted_count: omitted.length,
          no_safe_or_not_vulnerable_claims: true as const,
        },
        "dossier_sha256"
      )
    );
    const omissionRef = persistJson({
      store: this.store,
      context,
      run_id: context.identity.run_id,
      kind: "sca-p04-omission-dossier",
      operation_id: "sca-p04-omission-dossier",
      schema_id: SCA_P04_OMISSION_DOSSIER_V1_SCHEMA,
      schema_version: 1,
      value: omission,
      upstream_refs: [convergenceRef],
    });
    const finalIds = rows.map((row) => row.stable_id);
    const coverage = validateScaP04CoverageDossierV1(
      withSelfDigest(
        {
          schema_id: SCA_P04_COVERAGE_DOSSIER_V1_SCHEMA,
          schema_version: 1 as const,
          run_id: context.identity.run_id,
          phase_id: PHASE,
          population_ref: state.population_ref,
          entries: rows.map((row) => {
            const metadata = finalMetadata.get(row.stable_id);
            if (metadata === undefined) throw new Error("P04 coverage metadata is absent");
            return {
              stable_id: row.stable_id,
              origin: metadata.origin,
              specialist_ids: [...metadata.specialist_ids].sort(),
              status:
                row.final_disposition === "selected_for_p05"
                  ? ("selected" as const)
                  : row.final_disposition === "deferred"
                    ? ("deferred" as const)
                    : row.final_disposition === "blocked_evidence_gap"
                      ? ("blocked" as const)
                      : ("omitted" as const),
              alert_state: metadata.alert_state,
            };
          }),
          initial_population_ids: population.items.map((item) => item.stable_id),
          final_accounted_ids: finalIds,
          exhaustive: true as const,
          no_alert_semantics: "absence_of_scanner_alert_is_not_evidence_of_safety" as const,
        },
        "dossier_sha256"
      )
    );
    const coverageRef = persistJson({
      store: this.store,
      context,
      run_id: context.identity.run_id,
      kind: "sca-p04-coverage-dossier",
      operation_id: "sca-p04-coverage-dossier",
      schema_id: SCA_P04_COVERAGE_DOSSIER_V1_SCHEMA,
      schema_version: 1,
      value: coverage,
      upstream_refs: [state.population_ref, convergenceRef, selectionRef, omissionRef],
    });

    const expectedReasonCode = {
      select: "select_for_p05",
      omit: "omit_lower_relative_priority",
      defer: "defer_pending_evidence",
      block: "block_required_evidence_gap",
    } as const;
    const semanticContradictionIds = new Set(
      results.flatMap((result) =>
        result.results
          .filter((entry) => {
            const defersOrBlocks =
              entry.recommendation === "defer" || entry.recommendation === "block";
            return (
              entry.reason_code !== expectedReasonCode[entry.recommendation] ||
              (entry.evidence_status === "evidence_gap") !== defersOrBlocks ||
              (entry.uncertainty_code === "missing_required_evidence") !== defersOrBlocks ||
              entry.p05_question_codes.includes("resolve_evidence_gap") !== defersOrBlocks
            );
          })
          .map((entry) => entry.stable_id)
      )
    );
    const semanticEvidenceGapIds = new Set([
      ...semanticContradictionIds,
      ...results.flatMap((result) =>
        result.results
          .filter(
            (entry) =>
              entry.recommendation === "defer" ||
              entry.recommendation === "block" ||
              entry.evidence_status === "evidence_gap" ||
              entry.uncertainty_code === "missing_required_evidence" ||
              entry.p05_question_codes.includes("resolve_evidence_gap")
          )
          .map((entry) => entry.stable_id)
      ),
    ]);

    type PendingP04Obligation = {
      obligation_id: (typeof SCA_P04_OBLIGATION_IDS)[0];
      scope_id: string;
      reason_code:
        | "blocked_evidence_gap"
        | "branch_gap"
        | "deferred_selection"
        | "evidence_gap"
        | "material_unaccounted";
      detail_code:
        | "assigned_evidence_incomplete"
        | "payload_metadata_insufficient"
        | "population_assignment_inconsistent"
        | "specialist_scope_unavailable"
        | null;
      evidence_refs: ArtifactRef[];
    };
    const pendingObligations: PendingP04Obligation[] = [];
    for (const row of rows) {
      const metadata = finalMetadata.get(row.stable_id);
      if (metadata === undefined) {
        pendingObligations.push({
          obligation_id: SCA_P04_OBLIGATION_IDS[0],
          scope_id: row.stable_id,
          reason_code: "material_unaccounted",
          detail_code: null,
          evidence_refs: [],
        });
        continue;
      }
      if (row.final_disposition === "blocked_evidence_gap") {
        pendingObligations.push({
          obligation_id: SCA_P04_OBLIGATION_IDS[0],
          scope_id: row.stable_id,
          reason_code: "blocked_evidence_gap",
          detail_code: null,
          evidence_refs: metadata.evidence_refs,
        });
      }
      if (
        row.final_disposition === "deferred" ||
        row.recommendations.some((entry) => entry.recommendation === "defer")
      ) {
        pendingObligations.push({
          obligation_id: SCA_P04_OBLIGATION_IDS[0],
          scope_id: row.stable_id,
          reason_code: "deferred_selection",
          detail_code: null,
          evidence_refs: metadata.evidence_refs,
        });
      }
      if (semanticEvidenceGapIds.has(row.stable_id)) {
        pendingObligations.push({
          obligation_id: SCA_P04_OBLIGATION_IDS[0],
          scope_id: row.stable_id,
          reason_code: "evidence_gap",
          detail_code: null,
          evidence_refs: metadata.evidence_refs,
        });
      }
    }
    for (const result of results) {
      const dossierRef = dossierRefs.find((ref) => ref.branch_id === result.specialist_id);
      if (dossierRef === undefined) throw new Error("P04 branch-gap dossier ref is absent");
      for (const gapCode of result.branch_gap_codes) {
        pendingObligations.push({
          obligation_id: SCA_P04_OBLIGATION_IDS[0],
          scope_id: result.specialist_id,
          reason_code: "branch_gap",
          detail_code: gapCode,
          evidence_refs: [dossierRef],
        });
      }
    }
    pendingObligations.sort((left, right) =>
      `${left.scope_id}:${left.reason_code}:${left.detail_code ?? ""}`.localeCompare(
        `${right.scope_id}:${right.reason_code}:${right.detail_code ?? ""}`
      )
    );

    const ledgerRecordedAt = this.trustedClock();
    if (!Number.isFinite(ledgerRecordedAt.getTime())) {
      throw new Error("P04 trusted ledger clock is invalid");
    }
    const ledger = validateScaP04SuccessorLedgerV1(
      withSelfDigest(
        {
          schema_id: SCA_P04_SUCCESSOR_LEDGER_V1_SCHEMA,
          schema_version: 1 as const,
          run_id: context.identity.run_id,
          phase_id: PHASE,
          prior_ledger_ref: cohort.refs.p03_successor_ledger_ref,
          prior_ledger_sha256: cohort.refs.p03_successor_ledger_ref.content_digest,
          dispositions: [
            {
              obligation_id: SCA_P04_OBLIGATION_IDS[0],
              status:
                pendingObligations.length === 0 ? ("satisfied" as const) : ("pending" as const),
              evidence_refs: [state.accepted_cohort_ref, coverageRef],
            },
            {
              obligation_id: SCA_P04_OBLIGATION_IDS[1],
              status: "satisfied" as const,
              evidence_refs: [convergenceRef, ...dossierRefs],
            },
            {
              obligation_id: SCA_P04_OBLIGATION_IDS[2],
              status: "satisfied" as const,
              evidence_refs: [selectionRef],
            },
            {
              obligation_id: SCA_P04_OBLIGATION_IDS[3],
              status: "satisfied" as const,
              evidence_refs: [omissionRef],
            },
            {
              obligation_id: SCA_P04_OBLIGATION_IDS[4],
              status: "satisfied" as const,
              evidence_refs: [coverageRef],
            },
          ],
          pending_obligations: pendingObligations,
          pending_phase_ids: [
            "SCA-P05",
            "SCA-P06",
            "SCA-P07",
            "SCA-P08",
            "SCA-P09",
            "SCA-P10",
            "SCA-P11",
            "SCA-P12",
          ],
          append_only: true as const,
          campaign_completion_claimed: false as const,
          release_eligible: false as const,
          recorded_at: ledgerRecordedAt.toISOString(),
        },
        "ledger_sha256"
      )
    );
    const ledgerRef = persistJson({
      store: this.store,
      context,
      run_id: context.identity.run_id,
      kind: "sca-p04-successor-obligation-ledger",
      operation_id: "sca-p04-successor-obligation-ledger",
      schema_id: SCA_P04_SUCCESSOR_LEDGER_V1_SCHEMA,
      schema_version: 1,
      value: ledger,
      upstream_refs: [cohort.refs.p03_successor_ledger_ref, selectionRef, omissionRef, coverageRef],
    });
    const payloadRefs = uniqueRefs(Object.values(state.payload_refs));
    const disclosureRefs = uniqueRefs(Object.values(state.disclosure_refs));
    const evidenceAllRefs = uniqueRefs([
      state.accepted_cohort_ref,
      state.population_ref,
      ...payloadRefs,
      ...disclosureRefs,
      ...guardRefs,
      ...receiptRefs,
      ...outputRefs,
      ...dossierRefs,
      convergenceRef,
      selectionRef,
      omissionRef,
      coverageRef,
      ledgerRef,
    ]);
    for (const ref of evidenceAllRefs) this.store.readById(ref.artifact_id);
    const evidence = validateScaP04EvidenceManifestV1(
      withSelfDigest(
        {
          schema_id: SCA_P04_EVIDENCE_MANIFEST_V1_SCHEMA,
          schema_version: 1 as const,
          run_id: context.identity.run_id,
          phase_id: PHASE,
          accepted_cohort_ref: state.accepted_cohort_ref,
          population_ref: state.population_ref,
          cognitive_payload_refs: exactRefPair(payloadRefs, "P04 cognitive payloads"),
          disclosure_admission_refs: exactRefPair(disclosureRefs, "P04 disclosure admissions"),
          dispatch_guard_refs: exactRefPair(guardRefs, "P04 dispatch guards"),
          model_execution_receipt_refs: exactRefPair(receiptRefs, "P04 model execution receipts"),
          specialist_output_refs: exactRefPair(outputRefs, "P04 specialist outputs"),
          specialist_dossier_refs: exactRefPair(dossierRefs, "P04 specialist dossiers"),
          convergence_matrix_ref: convergenceRef,
          selection_dossier_ref: selectionRef,
          omission_dossier_ref: omissionRef,
          coverage_dossier_ref: coverageRef,
          all_refs: evidenceAllRefs,
          complete: true as const,
        },
        "manifest_sha256"
      )
    );
    const evidenceRef = persistJson({
      store: this.store,
      context,
      run_id: context.identity.run_id,
      kind: "sca-p04-evidence-manifest",
      operation_id: "sca-p04-evidence-manifest",
      schema_id: SCA_P04_EVIDENCE_MANIFEST_V1_SCHEMA,
      schema_version: 1,
      value: evidence,
      upstream_refs: evidenceAllRefs,
    });
    const now = this.trustedClock();
    if (!Number.isFinite(now.getTime())) throw new Error("P04 trusted gate clock is invalid");
    const blockers: string[] = [];
    if (cohort.qualification_scope !== "live_qualified")
      blockers.push("synthetic_lineage_not_authorizing");
    if (selected.length === 0) blockers.push("no_selected_surfaces");
    if (selected.length > population.max_selected_items) {
      blockers.push("selected_population_exceeds_policy");
    }
    const pendingReasons = new Set(pendingObligations.map((entry) => entry.reason_code));
    if (pendingReasons.has("blocked_evidence_gap")) blockers.push("blocked_evidence_gap");
    if (pendingReasons.has("deferred_selection")) blockers.push("deferred_selection_pending");
    if (pendingReasons.has("evidence_gap") || semanticEvidenceGapIds.size > 0) {
      blockers.push("required_evidence_gap");
    }
    if (pendingReasons.has("branch_gap")) blockers.push("specialist_branch_gap");
    if (semanticContradictionIds.size > 0) {
      blockers.push("specialist_result_semantic_contradiction");
    }
    if (pendingReasons.has("material_unaccounted")) blockers.push("material_item_unaccounted");
    const disclosuresAllowed = disclosureRefs.every(
      (ref) =>
        validateScaP04DisclosureAdmissionV1(exactJson(this.store, ref, "P04 disclosure"))
          .decision === "allow"
    );
    if (!disclosuresAllowed) blockers.push("disclosure_admission_denied");
    const gate = validateScaP04GateV1(
      withSelfDigest(
        {
          schema_id: SCA_P04_GATE_V1_SCHEMA,
          schema_version: 1 as const,
          run_id: context.identity.run_id,
          phase_id: PHASE,
          qualification_scope: cohort.qualification_scope,
          accepted_cohort_ref: state.accepted_cohort_ref,
          population_ref: state.population_ref,
          selection_dossier_ref: selectionRef,
          omission_dossier_ref: omissionRef,
          coverage_dossier_ref: coverageRef,
          evidence_manifest_ref: evidenceRef,
          successor_ledger_ref: ledgerRef,
          required_model: SCA_P04_REQUIRED_MODEL,
          specialist_count: 2 as const,
          disclosure_admissions_allowed: disclosuresAllowed,
          exhaustive_accounting: true,
          pending_obligation_count: pendingObligations.length,
          gate_status: blockers.length === 0 ? ("passed" as const) : ("blocked" as const),
          blocker_codes: blockers.sort(),
          evaluated_at: now.toISOString(),
        },
        "gate_sha256"
      )
    );
    const gateRef = persistJson({
      store: this.store,
      context,
      run_id: context.identity.run_id,
      kind: "sca-p04-gate",
      operation_id: "sca-p04-gate",
      schema_id: SCA_P04_GATE_V1_SCHEMA,
      schema_version: 1,
      value: gate,
      upstream_refs: [
        state.accepted_cohort_ref,
        state.population_ref,
        selectionRef,
        omissionRef,
        coverageRef,
        evidenceRef,
        ledgerRef,
      ],
    });
    let transitionRef: ArtifactRef | null = null;
    if (gate.gate_status === "passed" && cohort.qualification_scope === "live_qualified") {
      const transition = validateScaP04ToP05TransitionV1(
        withSelfDigest(
          {
            schema_id: SCA_P04_TO_P05_TRANSITION_V1_SCHEMA,
            schema_version: 1 as const,
            tenant_id: request.tenant_id,
            project_id: request.project_id,
            source_run_id: context.identity.run_id,
            source_phase_id: PHASE,
            target_phase_id: "SCA-P05" as const,
            p04_request_ref: state.request_ref,
            accepted_cohort_ref: state.accepted_cohort_ref,
            selection_dossier_ref: selectionRef,
            omission_dossier_ref: omissionRef,
            coverage_dossier_ref: coverageRef,
            evidence_manifest_ref: evidenceRef,
            successor_ledger_ref: ledgerRef,
            gate_ref: gateRef,
            gate_sha256: gateRef.content_digest,
            qualification_scope: "live_qualified" as const,
            authorized: true as const,
            campaign_terminal: false as const,
            release_eligible: false as const,
            transitioned_at: now.toISOString(),
          },
          "transition_sha256"
        )
      );
      transitionRef = persistJson({
        store: this.store,
        context,
        run_id: context.identity.run_id,
        kind: "sca-p04-to-p05-transition",
        operation_id: "sca-p04-to-p05-transition",
        schema_id: SCA_P04_TO_P05_TRANSITION_V1_SCHEMA,
        schema_version: 1,
        value: transition,
        upstream_refs: [gateRef, selectionRef, omissionRef, coverageRef, evidenceRef, ledgerRef],
      });
    }
    return this.terminal(
      context,
      gate.gate_status === "passed" ? "candidate_complete" : "blocked",
      transitionRef !== null,
      gate.blocker_codes,
      gateRef,
      transitionRef
    );
  }

  private convergeRow(
    stableId: string,
    origin: "initial_population" | "branch_discovery",
    recommendations: readonly {
      specialist_id: typeof SCA_P04_SCANNER_SPECIALIST | typeof SCA_P04_UNDERDETECTED_SPECIALIST;
      recommendation: ScaP04SpecialistResultItemV1["recommendation"];
      reason_code: string;
      evidence_status: ScaP04SpecialistResultItemV1["evidence_status"];
      uncertainty_code: ScaP04SpecialistResultItemV1["uncertainty_code"];
      p05_question_codes: readonly ScaP04SpecialistResultItemV1["p05_question_codes"][number][];
      evidence_refs: readonly ArtifactRef[];
    }[]
  ): ScaP04ConvergenceRowV1 {
    const ordered = [...recommendations].sort((left, right) =>
      left.specialist_id.localeCompare(right.specialist_id)
    );
    const choices = ordered.map((entry) => entry.recommendation);
    const hasEvidenceGapSignal = ordered.some(
      (entry) =>
        entry.evidence_status === "evidence_gap" ||
        entry.uncertainty_code === "missing_required_evidence" ||
        entry.p05_question_codes.includes("resolve_evidence_gap")
    );
    const finalDisposition = hasEvidenceGapSignal
      ? ("blocked_evidence_gap" as const)
      : choices.includes("block")
        ? ("blocked_evidence_gap" as const)
        : choices.includes("defer")
          ? ("deferred" as const)
          : choices.includes("select")
            ? ("selected_for_p05" as const)
            : ("not_selected" as const);
    return {
      stable_id: stableId,
      origin,
      recommendations: ordered.map((entry) => ({
        specialist_id: entry.specialist_id,
        recommendation: entry.recommendation,
        reason_code: entry.reason_code,
        evidence_status: entry.evidence_status,
        evidence_refs: uniqueRefs(entry.evidence_refs),
      })),
      final_disposition: finalDisposition,
      host_reason_code:
        finalDisposition === "selected_for_p05"
          ? "selected_by_specialist"
          : finalDisposition === "blocked_evidence_gap"
            ? "evidence_gap_requires_resolution"
            : finalDisposition === "deferred"
              ? "deferred_by_specialist"
              : "not_selected_by_specialist",
    };
  }

  private terminal(
    context: RunContext,
    status: "candidate_complete" | "blocked",
    p05Authorized: boolean,
    blockerCodes: readonly string[],
    gateRef: ArtifactRef | null = null,
    transitionRef: ArtifactRef | null = null
  ): Directive {
    context.stateId = FINAL;
    context.status = "incomplete";
    context.met = false;
    context.pendingBranches = [];
    const terminal = validateScaP04TerminalV1({
      schema_id: SCA_P04_TERMINAL_V1_SCHEMA,
      schema_version: 1,
      phase_id: PHASE,
      status,
      gate_ref: gateRef,
      p05_transition_ref: transitionRef,
      p05_authorized: p05Authorized,
      selected_artifact_refs: this.terminalArtifacts(context),
      blocker_codes: [...new Set(blockerCodes)].sort(),
      nonterminal_campaign: true,
    });
    const directive = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: terminal,
      artifacts: this.terminalArtifacts(context),
      unresolved:
        status === "candidate_complete"
          ? ["SCA-P05 requires a separate admission and remains outside this P04 candidate."]
          : terminal.blocker_codes,
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  private terminalArtifacts(context: RunContext): ArtifactRef[] {
    return uniqueRefs(
      context.selectedArtifacts.filter((ref) => ref.run_id === context.identity.run_id)
    ).slice(0, 2_048);
  }
}

function port(input: {
  readonly name: string;
  readonly kind: string;
  readonly schema: string;
  readonly direction: "input" | "output";
  readonly min?: number;
  readonly max?: number;
}) {
  return {
    schema_version: 1 as const,
    name: input.name,
    direction: input.direction,
    transport: "artifact" as const,
    artifact_kind: input.kind,
    schema_id: input.schema,
    schema_version_required: 1,
    source: input.direction === "input" ? ("caller" as const) : ("skill" as const),
    min_items: input.min ?? 1,
    max_items: input.max ?? 1,
    semantic_product: input.direction === "output",
  };
}

export const SCA_P04_CANDIDATE_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: SCA_P04_CANDIDATE_PLAYBOOK_NAME,
  objective:
    "Select a focused, evidence-bound P05 surface from the exact live-qualified P03 cohort without vulnerability adjudication.",
  io: {
    request: {
      schema_version: 1,
      name: "request",
      direction: "input",
      transport: "inline_request",
      schema_id: SCA_P04_START_V1_SCHEMA,
      schema_version_required: 1,
      artifact_kind: null,
      source: "caller",
      min_items: 1,
      max_items: 1,
      semantic_product: false,
    },
    input_ports: [
      port({
        name: "p03_transition",
        kind: "sca-p03-to-p04-transition",
        schema: "penny.sca-p03-p04-transition.v2",
        direction: "input",
      }),
      port({
        name: "implementation_identity",
        kind: "sca-p04-implementation-identity",
        schema: "penny.sca-p04-implementation-identity.v1",
        direction: "input",
      }),
      port({
        name: "runtime_policy",
        kind: "sca-p04-runtime-policy",
        schema: "penny.sca-p04-runtime-policy.v1",
        direction: "input",
      }),
    ],
    active_output_ports: [
      port({
        name: "p04_request",
        kind: "sca-p04-candidate-request",
        schema: SCA_P04_REQUEST_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "accepted_cohort",
        kind: "sca-p04-accepted-cohort",
        schema: SCA_P04_ACCEPTED_COHORT_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "selection_population",
        kind: "sca-p04-selection-population",
        schema: SCA_P04_POPULATION_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "cognitive_payloads",
        kind: "sca-p04-cognitive-payload",
        schema: SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA,
        direction: "output",
        min: 0,
        max: 2,
      }),
      port({
        name: "disclosure_admissions",
        kind: "sca-p04-disclosure-admission",
        schema: SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
        direction: "output",
        min: 0,
        max: 2,
      }),
      port({
        name: "specialist_dossiers",
        kind: "sca-p04-specialist-dossier",
        schema: SCA_P04_SPECIALIST_DOSSIER_V1_SCHEMA,
        direction: "output",
        min: 0,
        max: 2,
      }),
      port({
        name: "convergence_matrix",
        kind: "sca-p04-convergence-matrix",
        schema: SCA_P04_CONVERGENCE_MATRIX_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "selection",
        kind: "sca-p04-selection-dossier",
        schema: SCA_P04_SELECTION_DOSSIER_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "omission",
        kind: "sca-p04-omission-dossier",
        schema: SCA_P04_OMISSION_DOSSIER_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "coverage",
        kind: "sca-p04-coverage-dossier",
        schema: SCA_P04_COVERAGE_DOSSIER_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "evidence",
        kind: "sca-p04-evidence-manifest",
        schema: SCA_P04_EVIDENCE_MANIFEST_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "successor_ledger",
        kind: "sca-p04-successor-obligation-ledger",
        schema: SCA_P04_SUCCESSOR_LEDGER_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "gate",
        kind: "sca-p04-gate",
        schema: SCA_P04_GATE_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p05_transition",
        kind: "sca-p04-to-p05-transition",
        schema: SCA_P04_TO_P05_TRANSITION_V1_SCHEMA,
        direction: "output",
        min: 0,
      }),
    ],
  },
  behavior: {
    side_effects: {
      external_reads: "host_policy_only",
      external_mutations: "forbidden",
      filesystem_writes: "host_policy_only",
      allowed_relative_paths: [],
    },
    approval: { policy: "caller_skill_request", additional_approval_required: false },
    stopping: {
      budget_exhaustion: "incomplete",
      cancellation: "cancelled",
      blocking_ambiguity: "incomplete",
    },
    escalation: { out_of_scope_effect: "non_positive", sandbox_prevention_claim: false },
    violation_terminal: "incomplete",
  },
  guidance: {
    skill_root: ".pi/skills/sca/assets/prompts",
    resolution: "per_agent_phase",
  },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.sca-p04-candidate-budget.v1",
    resolver_id: "scaP04CandidateLeaseResolver",
    admission_id: "scaP04CandidateAdmission",
    snapshot_id: "scaP04CandidateSnapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [FINAL],
    required_visited_states: [FINAL],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: SCA_P04_TERMINAL_V1_SCHEMA,
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

export const SCA_P04_CANDIDATE_REGISTRATION: PlaybookRegistration = {
  name: SCA_P04_CANDIDATE_PLAYBOOK_NAME,
  contract: SCA_P04_CANDIDATE_SKILL_CONTRACT,
  ingress: "skill",
  start_admission: START_ADMISSION,
  caller_documentation: {
    constraints_schema: ScaP04StartConstraintsV1Schema,
    example: {
      goal: "Run the inactive P04 focused surface-selection candidate.",
      constraints: { p04_request: {} },
    },
    semantic_caveat:
      "P04 selects bounded P05 analysis surfaces. It does not adjudicate vulnerabilities, write a final report, release, or claim campaign completion.",
  },
  liveness: {
    resolver_id: SCA_P04_CANDIDATE_SKILL_CONTRACT.budget_policy.resolver_id,
    resolve: () => undefined,
    thinking_policy: "agent_ssot",
  },
  worker: {
    kind: "catalog-agent",
    workflow_name: SCA_P04_CANDIDATE_PLAYBOOK_NAME,
    guidance: SCA_P04_CANDIDATE_SKILL_CONTRACT.guidance,
    guidance_required: true,
    result_transport: "persisted_summary",
    opening_policy: "registration_guidance_task_artifacts",
    model_policy: "directive_override_or_runtime_default",
    phases: new Map([
      [
        "selecting_scanner_dependency_leads",
        {
          agent: "annie",
          directive_state_id: SELECTING,
          guidance_state_id: "selecting_scanner_dependency_leads",
          result_schema_id: SCA_P04_SPECIALIST_RESULT_V1_SCHEMA,
          result_schema_version: 1 as const,
          schema: ScaP04SpecialistResultV1Schema,
          allowed_tools: [],
          required_model: SCA_P04_REQUIRED_MODEL,
          provider_opening_guard: SCA_P04_PROVIDER_OPENING_GUARD,
        },
      ],
      [
        "selecting_underdetected_no_alert_surfaces",
        {
          agent: "echo",
          directive_state_id: SELECTING,
          guidance_state_id: "selecting_underdetected_no_alert_surfaces",
          result_schema_id: SCA_P04_SPECIALIST_RESULT_V1_SCHEMA,
          result_schema_version: 1 as const,
          schema: ScaP04SpecialistResultV1Schema,
          allowed_tools: [],
          required_model: SCA_P04_REQUIRED_MODEL,
          provider_opening_guard: SCA_P04_PROVIDER_OPENING_GUARD,
        },
      ],
    ]),
  },
  host_states: [FINAL],
  completionReceiptPredicates: new Map(),
  construct: (options) => {
    if (options.artifactStore === undefined) {
      throw new Error("SCA P04 candidate requires an artifact store");
    }
    return new ScaP04CandidatePlaybook(
      options.artifactStore,
      options.trustedClock ?? (() => new Date())
    );
  },
};

// Keep the typed summary schema explicit in the candidate module for prompt-smoke imports.
export {
  ScaP04SpecialistResultV1Schema,
  ScaP04CognitivePayloadV1Schema,
  ScaP04DisclosureAdmissionV1Schema,
};
void ArtifactRefSchema;
void ScaP04DisclosureAdmissionV1Schema;
void ScaP04SpecialistResultV1Schema;
