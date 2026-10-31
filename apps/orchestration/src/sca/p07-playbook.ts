import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { Checkpointer } from "../checkpointer.js";
import {
  ArtifactRefSchema,
  type ArtifactRef,
  type Directive,
  type InputArtifacts,
  type InvokeHostOperationDirectiveV1,
  type OutputArtifactMetadata,
  type SkillContract,
  type StartRequest,
  validateContract,
  validateDirective,
} from "../contracts.js";
import { RunContext } from "../context.js";
import {
  validateHostOperationDeclaration,
  validateHostOperationReceipt,
  validateHostOperationResult,
  type HostOperationCallRecordV1,
  type HostOperationDeclarationV1,
  type HostOperationDispositionV1,
  type HostOperationReceiptV1,
  type HostOperationResultV1,
} from "../host-operations/contracts.js";
import type { PlaybookCore } from "../playbooks/playbook.js";
import type {
  PlaybookRegistration,
  PreparedStartV1,
  StartAdmissionV1,
} from "../playbooks/registry.js";
import { OpaqueIdSchema } from "../skill-contracts/common.js";
import { admitScaP07ExecutionPlan, type ScaP07CurrentAuthorityScopeV1 } from "./p07-admission.js";
import {
  SCA_P07_ADMISSION_SCHEMA,
  SCA_P07_EVIDENCE_LEDGER_SCHEMA,
  SCA_P07_EXECUTION_PLAN_SCHEMA,
  SCA_P07_HOST_REQUEST_SCHEMA,
  SCA_P07_TERMINAL_SCHEMA,
  SCA_P07_TO_P08_TRANSITION_SCHEMA,
  validateScaP07AdmissionV1,
  validateScaP07EvidenceLedgerV1,
  validateScaP07ExecutionPlanV1,
  validateScaP07HostRequestV1,
  validateScaP07HostResultV1,
  validateScaP07TerminalV1,
  validateScaP07ToP08TransitionV1,
  withP07Digest,
  type ScaP07ActionOutcomeV1,
  type ScaP07AdmissionV1,
  type ScaP07ExecutionPlanV1,
  type ScaP07HostRequestV1,
  type ScaP07TerminalV1,
} from "./p07-contracts.js";
import {
  SCA_P07_ADAPTER_ID,
  SCA_P07_OPERATION_KIND,
  SCA_P07_REQUEST_CONTRACT,
  SCA_P07_RESULT_CONTRACT,
  createScaP07HostDeclaration,
  scaP07HostDirectives,
} from "./p07-operation.js";

/**
 * Inactive candidate only. This module is deliberately absent from `PLAYBOOK_REGISTRY` and
 * `SCA_PHASE_REGISTRY`: a registration here is a construction, not an accepted P07 phase.
 *
 * The candidate consumes one separately admitted execution plan, dispatches each authorized
 * action in deterministic plan order through the registered asynchronous host-operation owner,
 * accounts for every admitted action, and always terminates `incomplete/met:false`.
 *
 * The registered host-operation owner selects exactly one artifact per `(run, state, kind)`, so
 * each admitted action binds its own deterministic host state. The candidate therefore declares
 * the full bounded plan cardinality and refuses a larger plan rather than reusing a state.
 */
export const SCA_P07_CANDIDATE_PLAYBOOK_NAME = "sca-p07-candidate" as const;
export const SCA_P07_START_V1_SCHEMA = "penny.sca-p07-candidate-start.v1" as const;
export const SCA_P07_FINAL_STATE = "sca_p07_finalizing_evidence" as const;
export const SCA_P07_MAX_ACTIONS = 64 as const;

/** One deterministic host state per admitted action, in exact plan order. */
export const SCA_P07_ACTION_STATES: readonly string[] = Object.freeze(
  Array.from(
    { length: SCA_P07_MAX_ACTIONS },
    (_, index) => `sca_p07_action_${String(index).padStart(2, "0")}`
  )
);

function actionState(index: number): string {
  const state = SCA_P07_ACTION_STATES[index];
  if (state === undefined) throw new Error(`SCA P07 action state ${index} is out of range`);
  return state;
}

const CANCELLED_STATE = "sca_p07_cancelled" as const;
const P07_PHASE = "SCA-P07" as const;
const PRODUCER = "host:sca-p07-candidate" as const;
const REQUEST_KIND = "sca-p07-candidate-request" as const;
const HOST_REQUEST_OPERATION_PREFIX = "sca-p07-host-request" as const;

/**
 * Fixed candidate host-operation declaration and backend binding for the exported provider-free
 * compatibility fixture. Production composition does not use these constants; a caller binds the
 * registration to a live `ScaP07ProductionHostCompositionV1` through
 * `createScaP07CandidateRegistrationV1`, which projects the composition's own declaration and
 * socket-bound backend key.
 */
export const SCA_P07_CANDIDATE_DECLARATION = createScaP07HostDeclaration({
  backend_binding_id: "sca-p07-candidate-broker-backend-v1",
  lease_profile_id: "sca-p07-candidate-lease-v1",
  lease_duration_ms: 300_000,
  lease_renew_after_ms: 60_000,
  queue_inactivity_ms: 60_000,
  operation_inactivity_ms: 300_000,
  max_input_bytes: 33_554_432,
  max_output_bytes: 16_777_216,
});
export const SCA_P07_CANDIDATE_BACKEND_KEY_SHA256 = sha256(
  canonicalJson({
    schema_version: 1,
    operation_kind: SCA_P07_OPERATION_KIND,
    adapter_id: SCA_P07_ADAPTER_ID,
    backend_binding_id: SCA_P07_CANDIDATE_DECLARATION.backend_binding_id,
  })
);

/**
 * Independent resolver of the current P07 execution authority. The production
 * `createScaP07CandidateRegistrationV1` factory requires an explicit instance; the exported
 * compatibility fixture omits it and revalidates an admission against its own authority.
 */
export type ScaP07CurrentAuthorityResolverV1 = (
  scope: ScaP07CurrentAuthorityScopeV1
) => ArtifactRef;

/**
 * Exact construction binding for the inactive P07 candidate. `declaration` and
 * `backend_key_sha256` are projected verbatim into every host-operation directive;
 * `resolve_current_authority_ref` re-derives current authority during admission revalidation.
 */
export interface ScaP07CandidateBindingV1 {
  readonly declaration: HostOperationDeclarationV1;
  readonly backend_key_sha256: string;
  /**
   * Absent only for the exported provider-free compatibility fixture, which has no independent
   * authority owner and self-echoes the admission under validation. The production factory never
   * permits this fallback.
   */
  readonly resolve_current_authority_ref?: ScaP07CurrentAuthorityResolverV1;
}

const ScaP07StartConstraintsV1Schema = Type.Object(
  {
    plan_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
  },
  { additionalProperties: false, $id: SCA_P07_START_V1_SCHEMA }
);

const P07DataSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    plan_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    host_request_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
    operation_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false }
);
type P07Data = Readonly<Static<typeof P07DataSchema>>;

function data(context: RunContext): P07Data {
  return validateContract(P07DataSchema, context.playbookData, "SCA P07 durable state");
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.artifact_id)) return false;
    seen.add(ref.artifact_id);
    return true;
  });
}
function exactBytes(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) {
    throw new Error(`P07 ${label} exact ref is absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P07 ${label} exact bytes drifted`);
  }
  return bytes;
}
function exactJson(store: ArtifactHostStore, ref: ArtifactRef, label: string): unknown {
  const text = exactBytes(store, ref, label).toString("utf8");
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`P07 ${label} is not canonical JSON`);
  return value;
}
function latestSelected(
  context: RunContext,
  predicate: (ref: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts].reverse().find(predicate);
}
function persistJson(input: {
  readonly store: ArtifactHostStore;
  readonly context?: RunContext;
  readonly runId: string;
  readonly phase: string;
  readonly kind: string;
  readonly operationId: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly value: unknown;
  readonly upstreamRefs: readonly ArtifactRef[];
  /** False for repeated `(run, phase, kind)` artifacts; the owner selects one artifact per kind. */
  readonly select?: boolean;
}): ArtifactRef {
  const content = canonicalJson(input.value);
  const select = input.select ?? true;
  const prior = input.store.refFor(
    input.runId,
    input.phase,
    null,
    input.kind,
    input.operationId,
    1
  );
  if (prior !== null) {
    if (
      prior.content_digest !== sha256(content) ||
      input.store.readById(prior.artifact_id).toString("utf8") !== content
    ) {
      throw new Error(`P07 artifact '${input.operationId}' conflicts with immutable prior bytes`);
    }
    if (select) input.store.select(prior);
    const context = input.context;
    if (
      context !== undefined &&
      !context.selectedArtifacts.some((ref) => ref.artifact_id === prior.artifact_id)
    ) {
      context.selectedArtifacts.push(prior);
    }
    return prior;
  }
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: PRODUCER,
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: input.schemaVersion },
    parent_ref: null,
    upstream_refs: uniqueRefs(input.upstreamRefs).sort((left, right) =>
      left.artifact_id.localeCompare(right.artifact_id)
    ),
  };
  const ref = input.store.persist({ metadata, content });
  if (select) input.store.select(ref);
  const context = input.context;
  if (
    context !== undefined &&
    !context.selectedArtifacts.some((candidate) => candidate.artifact_id === ref.artifact_id)
  ) {
    context.selectedArtifacts.push(ref);
  }
  return ref;
}

interface SettledOperationV1 {
  readonly platform_ref: ArtifactRef;
  readonly platform: HostOperationResultV1;
  readonly receipt_ref: ArtifactRef;
  readonly receipt: HostOperationReceiptV1;
}
interface AccountedStateV1 {
  readonly plan: ScaP07ExecutionPlanV1;
  readonly admission: ScaP07AdmissionV1;
  readonly rows: readonly ScaP07ActionOutcomeV1[];
}
interface PersistedAccountingV1 {
  readonly ledger_ref: ArtifactRef;
  readonly transition_ref: ArtifactRef | null;
  readonly terminal_ref: ArtifactRef;
  readonly terminal: ScaP07TerminalV1;
}

export class ScaP07CandidatePlaybook implements PlaybookCore {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly binding: ScaP07CandidateBindingV1,
    private readonly checkpointer?: Checkpointer
  ) {}

  initialize(context: RunContext): Directive {
    const requestRef = latestSelected(
      context,
      (ref) =>
        ref.kind === REQUEST_KIND &&
        ref.producer === PRODUCER &&
        ref.run_id === context.identity.run_id
    );
    if (requestRef === undefined) throw new Error("SCA P07 admitted request is absent");
    const constraints = validateContract(
      ScaP07StartConstraintsV1Schema,
      exactJson(this.store, requestRef, "candidate request"),
      "SCA P07 start constraints"
    );
    const plan = validateScaP07ExecutionPlanV1(
      exactJson(this.store, constraints.plan_ref, "execution plan")
    );
    const admission = validateScaP07AdmissionV1(
      exactJson(this.store, constraints.admission_ref, "admission")
    );
    this.verifyAdmission(plan, admission, constraints.plan_ref, constraints.admission_ref);
    if (
      plan.transition_ref.run_id !== context.identity.run_id ||
      plan.items.length < 1 ||
      plan.items.length > SCA_P07_MAX_ACTIONS
    ) {
      throw new Error("SCA P07 plan does not belong to this run or exceeds the action bound");
    }
    const hostRequestRefs = plan.items.map((item, index) =>
      this.persistHostRequest(context, constraints, item, index)
    );
    const state: P07Data = {
      request_ref: requestRef,
      plan_ref: constraints.plan_ref,
      admission_ref: constraints.admission_ref,
      host_request_refs: hostRequestRefs,
      operation_ids: [],
    };
    // `scaP07HostDirectives` commits its operation identity to the exact action, job and attempt
    // only; the per-action state binding below is the sole difference between two projections.
    const projected = this.directives(context, state, plan, admission, actionState(0));
    Object.assign(context.playbookData, {
      ...state,
      operation_ids: projected.map((directive) => directive.operation_id),
    });
    context.transition(actionState(0));
    return this.issue(context, plan, admission, 0);
  }

  dispatch(context: RunContext): Directive {
    if (context.pendingDirective !== null) return context.pendingDirective;
    const index = SCA_P07_ACTION_STATES.indexOf(context.stateId);
    if (index < 0) throw new Error(`SCA P07 has no dispatch for '${context.stateId}'`);
    const state = data(context);
    const { plan, admission } = this.verifyState(state);
    if (index >= plan.items.length) throw new Error("SCA P07 state exceeds its admitted plan");
    const operationId = state.operation_ids[index];
    if (operationId === undefined) throw new Error("SCA P07 action operation id is absent");
    const entry = this.settledOperations(context).get(operationId);
    if (entry === undefined) {
      // The exact directive is checkpointed but its host operation is not settled: reissue it.
      return this.issue(context, plan, admission, index);
    }
    if (entry.platform.disposition.outcome !== "completed") {
      return this.finalize(context, state, "blocked", [
        `p07_action_${entry.platform.disposition.outcome}_blocks_gathering`,
      ]);
    }
    const next = index + 1;
    if (next === plan.items.length) {
      return this.finalize(context, state, "candidate_complete", []);
    }
    context.transition(actionState(next));
    return this.issue(context, plan, admission, next);
  }

  resume(): Directive {
    throw new Error("SCA P07 candidate has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = CANCELLED_STATE;
    context.status = "cancelled";
    context.met = false;
    const state = data(context);
    const accounted = this.account(context, state);
    const persisted = this.persistAccounting(context, state, accounted, "cancelled", []);
    const directive = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: persisted.terminal,
      artifacts: this.terminalArtifacts(state, accounted, persisted),
      unresolved: [reason],
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  acceptSummary(): Directive {
    throw new Error("SCA P07 candidate never accepts worker summaries");
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }

  private finalize(
    context: RunContext,
    state: P07Data,
    status: "candidate_complete" | "blocked",
    blockerCodes: readonly string[]
  ): Directive {
    context.transition(SCA_P07_FINAL_STATE);
    const accounted = this.account(context, state);
    const persisted = this.persistAccounting(context, state, accounted, status, blockerCodes);
    context.status = "incomplete";
    context.met = false;
    const directive = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: persisted.terminal,
      artifacts: this.terminalArtifacts(state, accounted, persisted),
      unresolved:
        blockerCodes.length === 0
          ? [
              "SCA-P08 remains separately admitted; no disposition, report, release, or campaign completion is claimed.",
            ]
          : [...blockerCodes],
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  private verifyState(state: P07Data): {
    readonly plan: ScaP07ExecutionPlanV1;
    readonly admission: ScaP07AdmissionV1;
  } {
    const plan = validateScaP07ExecutionPlanV1(
      exactJson(this.store, state.plan_ref, "execution plan")
    );
    const admission = validateScaP07AdmissionV1(
      exactJson(this.store, state.admission_ref, "admission")
    );
    this.verifyAdmission(plan, admission, state.plan_ref, state.admission_ref);
    if (
      state.host_request_refs.length !== plan.items.length ||
      state.operation_ids.length !== plan.items.length
    ) {
      throw new Error("SCA P07 durable state disagrees with the admitted plan");
    }
    return { plan, admission };
  }

  /** Re-derive the exact admission from the supplied authority. The host owner enforces currency. */
  private verifyAdmission(
    plan: ScaP07ExecutionPlanV1,
    admission: ScaP07AdmissionV1,
    planRef: ArtifactRef,
    admissionRef: ArtifactRef
  ): void {
    if (planRef.kind !== "sca-p07-execution-plan" || admissionRef.kind !== "sca-p07-admission") {
      throw new Error("SCA P07 plan or admission ref kind is invalid");
    }
    if (
      planRef.content_schema?.schema_id !== SCA_P07_EXECUTION_PLAN_SCHEMA ||
      admissionRef.content_schema?.schema_id !== SCA_P07_ADMISSION_SCHEMA
    ) {
      throw new Error("SCA P07 plan or admission content schema is invalid");
    }
    if (!same(admission.plan_ref, planRef) || !same(plan.authority_ref, admission.authority_ref)) {
      throw new Error("SCA P07 admission does not bind the supplied plan and authority");
    }
    const rederived = admitScaP07ExecutionPlan({
      store: this.store,
      transition_ref: admission.transition_ref,
      authority_ref: admission.authority_ref,
      // The injected resolver is the only authority source. The exported compatibility fixture
      // omits it and revalidates the admission against its own authority; production never does.
      resolve_current_authority_ref:
        this.binding.resolve_current_authority_ref ?? (() => admission.authority_ref),
      plan_ref: admission.plan_ref,
    });
    if (!same(rederived, admission)) {
      throw new Error("SCA P07 admission is not the exact separately admitted execution plan");
    }
  }

  private persistHostRequest(
    context: RunContext,
    constraints: Static<typeof ScaP07StartConstraintsV1Schema>,
    item: ScaP07ExecutionPlanV1["items"][number],
    index: number
  ): ArtifactRef {
    const value = validateScaP07HostRequestV1(
      withP07Digest(
        {
          schema_id: SCA_P07_HOST_REQUEST_SCHEMA,
          schema_version: 1 as const,
          plan_ref: constraints.plan_ref,
          admission_ref: constraints.admission_ref,
          item_index: index,
          action_record_ref: item.action_record_ref,
          broker_request: item.broker_request,
          broker_request_sha256: item.broker_request_sha256,
        },
        "request_sha256"
      )
    );
    return persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: actionState(index),
      kind: SCA_P07_REQUEST_CONTRACT.artifact_kind,
      operationId: `${HOST_REQUEST_OPERATION_PREFIX}-${String(index).padStart(4, "0")}`,
      schemaId: SCA_P07_HOST_REQUEST_SCHEMA,
      schemaVersion: 1,
      value,
      upstreamRefs: [constraints.plan_ref, constraints.admission_ref],
      select: false,
    });
  }

  private hostRequests(
    state: P07Data,
    plan: ScaP07ExecutionPlanV1
  ): readonly { readonly ref: ArtifactRef; readonly value: ScaP07HostRequestV1 }[] {
    return plan.items.map((item, index) => {
      const ref = state.host_request_refs[index];
      if (ref === undefined) throw new Error("SCA P07 host request ref is absent");
      const value = validateScaP07HostRequestV1(
        withP07Digest(
          {
            schema_id: SCA_P07_HOST_REQUEST_SCHEMA,
            schema_version: 1 as const,
            plan_ref: state.plan_ref,
            admission_ref: state.admission_ref,
            item_index: index,
            action_record_ref: item.action_record_ref,
            broker_request: item.broker_request,
            broker_request_sha256: item.broker_request_sha256,
          },
          "request_sha256"
        )
      );
      return { ref, value };
    });
  }

  private directives(
    context: RunContext,
    state: P07Data,
    plan: ScaP07ExecutionPlanV1,
    admission: ScaP07AdmissionV1,
    stateId: string
  ): readonly InvokeHostOperationDirectiveV1[] {
    const registrationSha256 = context.registrationContractBinding?.registration_sha256;
    if (registrationSha256 === undefined) {
      throw new Error("SCA P07 lacks an exact runtime registration binding");
    }
    return scaP07HostDirectives({
      plan,
      plan_ref: state.plan_ref,
      admission,
      admission_ref: state.admission_ref,
      requests: this.hostRequests(state, plan),
      identity: context.identity,
      state_id: stateId,
      attempt: 1,
      registration_sha256: registrationSha256,
      declaration: this.binding.declaration,
      backend_key_sha256: this.binding.backend_key_sha256,
    });
  }

  private issue(
    context: RunContext,
    plan: ScaP07ExecutionPlanV1,
    admission: ScaP07AdmissionV1,
    index: number
  ): Directive {
    const state = data(context);
    const stateId = SCA_P07_ACTION_STATES[index];
    if (stateId === undefined) throw new Error("SCA P07 action state is absent");
    const directive = this.directives(context, state, plan, admission, stateId)[index];
    if (directive === undefined) throw new Error("SCA P07 action directive is absent");
    context.pendingDirective = directive;
    return directive;
  }

  private settledOperations(context: RunContext): ReadonlyMap<string, SettledOperationV1> {
    const platforms = new Map<string, { ref: ArtifactRef; value: HostOperationResultV1 }>();
    const receipts = new Map<string, { ref: ArtifactRef; value: HostOperationReceiptV1 }>();
    for (const ref of context.selectedArtifacts) {
      if (ref.run_id !== context.identity.run_id) continue;
      if (ref.kind === "host-operation-result") {
        const value = validateHostOperationResult(exactJson(this.store, ref, "platform result"));
        platforms.set(value.operation_id, { ref, value });
      } else if (ref.kind === "host-operation-receipt") {
        const value = validateHostOperationReceipt(exactJson(this.store, ref, "host receipt"));
        receipts.set(value.operation_id, { ref, value });
      }
    }
    const settled = new Map<string, SettledOperationV1>();
    for (const [operationId, platform] of platforms) {
      const receipt = receipts.get(operationId);
      if (receipt === undefined) continue;
      if (
        platform.value.operation_kind !== SCA_P07_OPERATION_KIND ||
        !same(platform.value.identity, context.identity) ||
        receipt.value.operation_record_id !== platform.value.operation_record_id ||
        receipt.value.request_sha256 !== platform.value.request_sha256
      ) {
        throw new Error("SCA P07 host result does not bind its exact operation");
      }
      settled.set(operationId, {
        platform_ref: platform.ref,
        platform: platform.value,
        receipt_ref: receipt.ref,
        receipt: receipt.value,
      });
    }
    return settled;
  }

  private journalByOperationId(
    context: RunContext
  ): ReadonlyMap<string, HostOperationCallRecordV1> {
    const checkpointer = this.checkpointer;
    if (checkpointer === undefined) return new Map();
    return new Map(
      checkpointer
        .hostOperationCallsForRun(context.identity.run_id)
        .map((record) => [record.operation_id, record] as const)
    );
  }

  private account(context: RunContext, state: P07Data): AccountedStateV1 {
    const { plan, admission } = this.verifyState(state);
    const settled = this.settledOperations(context);
    const journal = this.journalByOperationId(context);
    const rows = plan.items.map((item, index) => {
      const operationId = state.operation_ids[index];
      const hostRequestRef = state.host_request_refs[index];
      if (operationId === undefined || hostRequestRef === undefined) {
        throw new Error("SCA P07 durable action state is incomplete");
      }
      return this.row(
        context,
        index,
        item.action_record_ref,
        operationId,
        hostRequestRef,
        settled.get(operationId),
        journal.get(operationId)
      );
    });
    return { plan, admission, rows };
  }

  private row(
    context: RunContext,
    index: number,
    actionRecordRef: ArtifactRef,
    operationId: string,
    hostRequestRef: ArtifactRef,
    settled?: SettledOperationV1,
    journal?: HostOperationCallRecordV1
  ): ScaP07ActionOutcomeV1 {
    if (settled !== undefined) {
      const disposition: HostOperationDispositionV1 = settled.platform.disposition;
      const hostResultRef = settled.platform.operation_result_ref;
      if (hostResultRef === null) {
        if (disposition.outcome === "completed") {
          throw new Error("SCA P07 completed action lacks its exact host result");
        }
      } else {
        const request = validateScaP07HostRequestV1(
          exactJson(this.store, hostRequestRef, "host request")
        );
        validateScaP07HostResultV1(exactJson(this.store, hostResultRef, "host result"), request);
        if (
          hostResultRef.kind !== SCA_P07_RESULT_CONTRACT.artifact_kind ||
          hostResultRef.content_schema?.schema_id !== SCA_P07_RESULT_CONTRACT.schema_id ||
          hostResultRef.content_schema.schema_version !==
            SCA_P07_RESULT_CONTRACT.schema_version_required
        ) {
          throw new Error("SCA P07 host result ref violates its registered result contract");
        }
      }
      return {
        item_index: index,
        action_record_ref: actionRecordRef,
        operation_id: operationId,
        host_request_ref: hostRequestRef,
        host_result_ref: hostResultRef,
        platform_result_ref: settled.platform_ref,
        host_receipt_ref: settled.receipt_ref,
        disposition,
        status: disposition.outcome === "completed" ? "completed" : "blocked",
        blocker_codes:
          disposition.outcome === "completed"
            ? []
            : [`p07_action_${disposition.outcome}_uncontained`],
      };
    }
    if (journal !== undefined && journal.lifecycle !== "consumed") {
      return {
        item_index: index,
        action_record_ref: actionRecordRef,
        operation_id: operationId,
        host_request_ref: hostRequestRef,
        host_result_ref: journal.operation_result_ref,
        platform_result_ref: journal.platform_result_ref,
        host_receipt_ref: journal.host_receipt_ref,
        disposition: journal.disposition,
        status: "blocked",
        blocker_codes: [`p07_host_operation_journal_${journal.lifecycle}`],
      };
    }
    return {
      item_index: index,
      action_record_ref: actionRecordRef,
      operation_id: operationId,
      host_request_ref: hostRequestRef,
      host_result_ref: null,
      platform_result_ref: null,
      host_receipt_ref: null,
      disposition: null,
      status: "not_invoked",
      blocker_codes: ["p07_action_not_invoked"],
    };
  }

  private persistAccounting(
    context: RunContext,
    state: P07Data,
    accounted: AccountedStateV1,
    status: "candidate_complete" | "blocked" | "cancelled",
    blockerCodes: readonly string[]
  ): PersistedAccountingV1 {
    const { plan, rows } = accounted;
    const completed = rows.filter((row) => row.status === "completed").length;
    const blocked = rows.filter((row) => row.status === "blocked").length;
    const notInvoked = rows.filter((row) => row.status === "not_invoked").length;
    const ledger = validateScaP07EvidenceLedgerV1(
      withP07Digest(
        {
          schema_id: SCA_P07_EVIDENCE_LEDGER_SCHEMA,
          schema_version: 1 as const,
          phase_id: P07_PHASE,
          run_id: context.identity.run_id,
          transition_ref: plan.transition_ref,
          authority_ref: plan.authority_ref,
          plan_ref: state.plan_ref,
          admission_ref: state.admission_ref,
          rows,
          action_count: rows.length,
          completed_action_count: completed,
          blocked_action_count: blocked,
          not_invoked_action_count: notInvoked,
          exhaustive_accounting: true as const,
          execution_occurred: completed + blocked > 0,
          release_eligible: false as const,
          campaign_complete: false as const,
        },
        "ledger_sha256"
      )
    );
    const ledgerRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P07_PHASE,
      kind: "sca-p07-evidence-ledger",
      operationId: "sca-p07-evidence-ledger",
      schemaId: SCA_P07_EVIDENCE_LEDGER_SCHEMA,
      schemaVersion: 1,
      value: ledger,
      upstreamRefs: [state.plan_ref, state.admission_ref, plan.transition_ref],
    });
    const transitionRef =
      status === "cancelled"
        ? null
        : persistJson({
            store: this.store,
            context,
            runId: context.identity.run_id,
            phase: P07_PHASE,
            kind: "sca-p07-to-p08-transition",
            operationId: "sca-p07-to-p08-transition",
            schemaId: SCA_P07_TO_P08_TRANSITION_SCHEMA,
            schemaVersion: 1,
            value: validateScaP07ToP08TransitionV1(
              withP07Digest(
                {
                  schema_id: SCA_P07_TO_P08_TRANSITION_SCHEMA,
                  schema_version: 1 as const,
                  source_phase_id: P07_PHASE,
                  target_phase_id: "SCA-P08" as const,
                  handoff_kind: "candidate_evidence_only" as const,
                  qualification_scope: "evidence_gathering_only_not_p08_disposition" as const,
                  phase_gate_passed: false as const,
                  p06_transition_ref: plan.transition_ref,
                  p07_authority_ref: plan.authority_ref,
                  p07_plan_ref: state.plan_ref,
                  p07_admission_ref: state.admission_ref,
                  evidence_ledger_ref: ledgerRef,
                  action_count: rows.length,
                  completed_action_result_refs: rows
                    .filter((row) => row.status === "completed")
                    .map((row) => row.host_result_ref)
                    .filter((ref): ref is ArtifactRef => ref !== null),
                  blocked_action_count: blocked,
                  not_invoked_action_count: notInvoked,
                  evidence_complete: blocked === 0 && notInvoked === 0,
                  p08_disposition_authorized_by_this_transition: false as const,
                  release_eligible: false as const,
                  campaign_complete: false as const,
                  campaign_completion_claimed: false as const,
                },
                "transition_sha256"
              )
            ),
            upstreamRefs: [ledgerRef],
          });
    const terminal = validateScaP07TerminalV1(
      withP07Digest(
        {
          schema_id: SCA_P07_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P07_PHASE,
          status,
          evidence_ledger_ref: ledgerRef,
          p08_transition_ref: transitionRef,
          p08_handoff_ready: transitionRef !== null,
          evidence_complete: status === "candidate_complete",
          phase_gate_passed: false as const,
          execution_occurred: completed + blocked > 0,
          action_count: rows.length,
          completed_action_count: completed,
          blocked_action_count: blocked,
          not_invoked_action_count: notInvoked,
          selected_artifact_refs: uniqueRefs([
            plan.transition_ref,
            plan.authority_ref,
            state.plan_ref,
            state.admission_ref,
            ...rows
              .map((row) => row.host_result_ref)
              .filter((ref): ref is ArtifactRef => ref !== null),
            ledgerRef,
            ...(transitionRef === null ? [] : [transitionRef]),
          ]).slice(0, 128),
          blocker_codes: [...blockerCodes],
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          report_or_finding_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P07_PHASE,
      kind: "sca-p07-terminal",
      operationId: "sca-p07-terminal",
      schemaId: SCA_P07_TERMINAL_SCHEMA,
      schemaVersion: 1,
      value: terminal,
      upstreamRefs: [ledgerRef, ...(transitionRef === null ? [] : [transitionRef])],
    });
    return {
      ledger_ref: ledgerRef,
      transition_ref: transitionRef,
      terminal_ref: terminalRef,
      terminal,
    };
  }

  private terminalArtifacts(
    state: P07Data,
    accounted: AccountedStateV1,
    persisted: PersistedAccountingV1
  ): ArtifactRef[] {
    return uniqueRefs([
      state.plan_ref,
      state.admission_ref,
      accounted.plan.transition_ref,
      accounted.plan.authority_ref,
      persisted.ledger_ref,
      ...(persisted.transition_ref === null ? [] : [persisted.transition_ref]),
      persisted.terminal_ref,
      ...accounted.rows
        .map((row) => row.host_result_ref)
        .filter((ref): ref is ArtifactRef => ref !== null),
    ]).slice(0, 128);
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
    schema_id: input.schema,
    schema_version_required: 1 as const,
    artifact_kind: input.kind,
    source: input.direction === "input" ? ("caller" as const) : ("skill" as const),
    min_items: input.min ?? 1,
    max_items: input.max ?? 1,
    semantic_product: false,
  };
}

export const SCA_P07_CANDIDATE_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: SCA_P07_CANDIDATE_PLAYBOOK_NAME,
  objective:
    "Gather exact bounded source, graph, or isolated-test evidence for every separately admitted P07 action through the registered asynchronous host-operation owner, without claiming P08 disposition, report, release, or campaign completion.",
  io: {
    request: {
      schema_version: 1,
      name: "request",
      direction: "input",
      transport: "inline_request",
      schema_id: SCA_P07_START_V1_SCHEMA,
      schema_version_required: 1,
      artifact_kind: null,
      source: "caller",
      min_items: 1,
      max_items: 1,
      semantic_product: false,
    },
    input_ports: [
      port({
        name: "p07_execution_plan",
        kind: "sca-p07-execution-plan",
        schema: SCA_P07_EXECUTION_PLAN_SCHEMA,
        direction: "input",
      }),
      port({
        name: "p07_admission",
        kind: "sca-p07-admission",
        schema: SCA_P07_ADMISSION_SCHEMA,
        direction: "input",
      }),
    ],
    active_output_ports: [
      port({
        name: "p07_evidence_ledger",
        kind: "sca-p07-evidence-ledger",
        schema: SCA_P07_EVIDENCE_LEDGER_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p07_to_p08_transition",
        kind: "sca-p07-to-p08-transition",
        schema: SCA_P07_TO_P08_TRANSITION_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p07_terminal",
        kind: "sca-p07-terminal",
        schema: SCA_P07_TERMINAL_SCHEMA,
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
  guidance: { skill_root: "apps/orchestration/src/sca", resolution: "per_agent_phase" },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.sca-p07-candidate-budget.v1",
    resolver_id: "scaP07CandidateDeterministicResolver",
    admission_id: "scaP07CandidateAdmission",
    snapshot_id: "scaP07CandidateSnapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [SCA_P07_FINAL_STATE],
    required_visited_states: [SCA_P07_FINAL_STATE],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: SCA_P07_TERMINAL_SCHEMA,
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

const START_ADMISSION: StartAdmissionV1 = {
  schema_id: SCA_P07_START_V1_SCHEMA,
  schema_version: 1,
  prepare(request: StartRequest): PreparedStartV1 {
    const constraints = validateContract(
      ScaP07StartConstraintsV1Schema,
      request.constraints,
      "SCA P07 start constraints"
    );
    if (request.identity.playbook !== SCA_P07_CANDIDATE_PLAYBOOK_NAME) {
      throw new Error("SCA P07 start identity is invalid");
    }
    const inputs: InputArtifacts | undefined = request.input_artifacts;
    if (inputs === undefined || inputs.artifacts.length !== 2) {
      throw new Error("SCA P07 start requires the exact admitted plan and admission inputs");
    }
    const planBinding = inputs.artifacts.find((binding) => binding.slot === "plan");
    const admissionBinding = inputs.artifacts.find((binding) => binding.slot === "admission");
    if (
      planBinding === undefined ||
      admissionBinding === undefined ||
      !same(planBinding.ref, constraints.plan_ref) ||
      !same(admissionBinding.ref, constraints.admission_ref)
    ) {
      throw new Error("SCA P07 start inputs do not equal the declared plan and admission refs");
    }
    return {
      schema_id: SCA_P07_START_V1_SCHEMA,
      schema_version: 1,
      request,
      goal: request.goal,
      constraints,
      input_artifacts: inputs,
      admission_data: constraints,
    };
  },
  materialize(prepared, host) {
    if (host.artifactStore === undefined || prepared.input_artifacts === undefined) {
      throw new Error("SCA P07 materialization requires artifact store and exact inputs");
    }
    const constraints = validateContract(
      ScaP07StartConstraintsV1Schema,
      prepared.constraints,
      "SCA P07 start constraints"
    );
    const requestRef = persistJson({
      store: host.artifactStore,
      runId: host.run_id,
      phase: P07_PHASE,
      kind: REQUEST_KIND,
      operationId: "sca-p07-candidate-request",
      schemaId: SCA_P07_START_V1_SCHEMA,
      schemaVersion: 1,
      value: constraints,
      upstreamRefs: [constraints.plan_ref, constraints.admission_ref],
    });
    return [requestRef];
  },
};

const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Internal builder shared by the exported compatibility fixture and the production factory. The
 * binding is captured only by `construct`; nothing about it changes the serialized registration
 * digest beyond the declared host-operation declaration it names.
 */
function buildScaP07CandidateRegistration(binding: ScaP07CandidateBindingV1): PlaybookRegistration {
  const registration: PlaybookRegistration = {
    name: SCA_P07_CANDIDATE_PLAYBOOK_NAME,
    contract: SCA_P07_CANDIDATE_SKILL_CONTRACT,
    ingress: "skill",
    start_admission: START_ADMISSION,
    caller_documentation: {
      constraints_schema: ScaP07StartConstraintsV1Schema,
      example: {
        goal: "Run the inactive P07 bounded evidence-gathering candidate.",
        constraints: { plan_ref: {}, admission_ref: {} },
      },
      semantic_caveat:
        "P07 gathers evidence for an exact separately admitted plan. It does not adjudicate dispositions, report, release, or complete a campaign, and it never claims public success.",
    },
    liveness: {
      resolver_id: SCA_P07_CANDIDATE_SKILL_CONTRACT.budget_policy.resolver_id,
      resolve: () => undefined,
      thinking_policy: "agent_ssot",
    },
    worker: {
      kind: "none",
      workflow_name: SCA_P07_CANDIDATE_PLAYBOOK_NAME,
      guidance: SCA_P07_CANDIDATE_SKILL_CONTRACT.guidance,
      guidance_required: true,
      result_transport: "host_typed",
      opening_policy: "none",
      model_policy: "none",
      phases: new Map<string, never>(),
    },
    host_states: [...SCA_P07_ACTION_STATES, SCA_P07_FINAL_STATE],
    host_operations: {
      schema_version: 1,
      max_active_per_run: 1,
      declarations: [binding.declaration],
    },
    completionReceiptPredicates: new Map(),
    construct(options) {
      if (options.artifactStore === undefined) {
        throw new Error("SCA P07 candidate requires the artifact host store");
      }
      return new ScaP07CandidatePlaybook(options.artifactStore, binding, options.checkpointer);
    },
  };
  return Object.freeze(registration);
}

/**
 * Production composition factory. Unlike the exported compatibility fixture, it requires an
 * explicit current-authority resolver and projects the supplied declaration and backend key
 * verbatim, so a caller can bind the registration to the exact live
 * `ScaP07ProductionHostCompositionV1` (its declaration, backend key, adapters, and use validator).
 */
export function createScaP07CandidateRegistrationV1(input: {
  readonly declaration: HostOperationDeclarationV1;
  readonly backend_key_sha256: string;
  readonly resolve_current_authority_ref: ScaP07CurrentAuthorityResolverV1;
}): PlaybookRegistration {
  const declaration = validateHostOperationDeclaration(input.declaration);
  const expectedDeclaration =
    declaration.max_input_bytes === undefined
      ? null
      : createScaP07HostDeclaration({
          backend_binding_id: declaration.backend_binding_id,
          lease_profile_id: declaration.lease_profile.profile_id,
          lease_duration_ms: declaration.lease_profile.duration_ms,
          lease_renew_after_ms: declaration.lease_profile.renew_after_ms,
          queue_inactivity_ms: declaration.lease_profile.queue_inactivity_ms,
          operation_inactivity_ms: declaration.operation_inactivity_ms,
          max_input_bytes: declaration.max_input_bytes,
          max_output_bytes: declaration.max_output_bytes,
        });
  if (expectedDeclaration === null || !same(declaration, expectedDeclaration)) {
    throw new Error("SCA P07 candidate declaration is not the registered host operation shape");
  }
  if (!SHA256_DIGEST_PATTERN.test(input.backend_key_sha256)) {
    throw new Error("SCA P07 candidate backend key is not a SHA-256 digest");
  }
  if (typeof input.resolve_current_authority_ref !== "function") {
    throw new Error("SCA P07 candidate requires an independent current-authority resolver");
  }
  return buildScaP07CandidateRegistration(
    Object.freeze({
      declaration,
      backend_key_sha256: input.backend_key_sha256,
      resolve_current_authority_ref: input.resolve_current_authority_ref,
    })
  );
}

/**
 * Fixed provider-free compatibility fixture. It keeps historical self-echo admission
 * revalidation because it has no independent authority owner; provider-free unit tests depend on
 * it. Production callers construct through `createScaP07CandidateRegistrationV1`.
 */
export const SCA_P07_CANDIDATE_REGISTRATION: PlaybookRegistration =
  buildScaP07CandidateRegistration({
    declaration: SCA_P07_CANDIDATE_DECLARATION,
    backend_key_sha256: SCA_P07_CANDIDATE_BACKEND_KEY_SHA256,
  });
