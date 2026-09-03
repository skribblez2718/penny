/**
 * W2 — Playbook registry (Foundation stage, workstream 1 of 3).
 *
 * `apps/orchestration/src/playbooks/registry.ts` is named as a required target by
 * `research/agents-md-research/IMPLEMENTATION_PLAN.md` §4.3. It is therefore an unmet
 * item of the agents-md plan, not only a universal-skills import.
 *
 * The registry maps a playbook name to its constructor. The engine constructs through it
 * and never imports a concrete playbook class, so adding a playbook is a registration
 * change rather than an engine change.
 *
 * ## Registration history — read this before adding an entry
 *
 * **Foundation stage (workstream 1): exactly one entry.** Research was the sole
 * registration, because research is the mandatory parity/canary oracle
 * (`agents-md-research` §1 outcome 5) and the Foundation PRD's binding constraint 1
 * forbade registering or activating a second skill during that stage. Multi-playbook
 * dispatch was proven with an injected test double, never a shipped registration.
 *
 * **Workstream 2 (post-G6): a second entry is authorized.** G6 passed by operator
 * decision 2026-08-18, which unblocks stateful KB work, and the KB playbook is the
 * second playbook the whole seam extraction existed to host. The Foundation-stage
 * "exactly one entry" rule ended with that stage; it is not a standing invariant.
 *
 * **Recorded defect (2026-08-19).** The KB entry was added at G8 while this docstring
 * still claimed "exactly one entry … never with a shipped registration", and
 * `assertSoleProductionRegistration()` was weakened to "research is present" in the
 * same change that would otherwise have failed — with its test edited to match. The
 * Foundation PRD §8 names that exact stop condition ("a parity test is edited in the
 * same change that makes it fail"). This block, `assertExpectedRegistrations()`, and
 * the accompanying test now state one truth instead of three.
 *
 * `assertExpectedRegistrations()` is the executable form of the *current* rule:
 * research must always be present, and only explicitly authorized names may ship.
 * An accidental or unauthorized registration fails closed.
 */

import type { TSchema } from "typebox";

import {
  SkillContractSchema,
  validateContract,
  type ArtifactRef,
  type InputArtifacts,
  type JsonValue,
  type LivenessPolicyV1,
  type ReleaseStatus,
  type SkillContract,
  type StartRequest,
} from "../contracts.js";
import { canonicalJson, sha256, type Checkpointer } from "../checkpointer.js";
import type {
  ArtifactHostStore,
  ArtifactReader,
  ArtifactRevisionLookup,
} from "../artifact-store.js";
import type { ResearchContextOwnerV1 } from "../research-context.js";
import {
  canonicalizeResearchRequest,
  researchRuntimeConstraints,
  validateResearchRequest,
} from "../skill-contracts/research.js";
import { researchBootstrapLivenessPolicy, researchLivenessPolicy } from "../liveness.js";
import type { CompletionReceiptPredicateV1, PlaybookV1 } from "./playbook.js";
import {
  AGENT_BY_STATE,
  RESEARCH_COMPLETION_RECEIPT_PREDICATES,
  RESEARCH_SKILL_CONTRACT,
  ResearchPlaybook,
  researchSummarySchema,
} from "./research.js";
import {
  KB_AGENT_PHASES,
  KNOWLEDGE_BASE_AGENT_BY_PHASE,
  KNOWLEDGE_BASE_COMPLETION_RECEIPT_PREDICATES,
  KNOWLEDGE_BASE_SKILL_CONTRACT,
  KnowledgeBasePlaybook,
  validateKnowledgeBasePhaseDetails,
  type KbAgentPhase,
} from "./knowledge-base.js";
import { ASSESS_CANDIDATE_REGISTRATION } from "./assess.js";
import { DECIDE_CANDIDATE_REGISTRATION } from "./decide.js";
import { DIAGNOSE_CANDIDATE_REGISTRATION } from "./diagnose.js";
import { PLAN_CANDIDATE_REGISTRATION } from "./plan.js";
import { PRODUCE_CANDIDATE_REGISTRATION } from "./produce.js";

export interface PlaybookConstructionOptionsV1 {
  readonly artifactRevisions?: ArtifactRevisionLookup;
  readonly artifactReader?: ArtifactReader;
  readonly artifactStore?: ArtifactHostStore;
  readonly researchContext?: ResearchContextOwnerV1;
  readonly checkpointer?: Checkpointer;
  readonly researchHostFault?: (point: string) => void;
  /**
   * Optional custody seam for private start inputs (§5.6): playbooks whose start
   * actions carry private request bodies in host-allocated files read them back
   * through this capability, which the engine binds to its own control DB. The
   * capability is read-only and scoped to one run id — no write surface — and a
   * playbook that never declares the capability never sees these bodies.
   */
  readonly privateInput?: {
    readonly read: (runId: string) => unknown;
    readonly sha256: (runId: string) => string | undefined;
  };
}

export type WorkerRegistrationV1 =
  | {
      readonly kind: "catalog-agent";
      readonly workflow_name: string;
      readonly guidance: SkillContract["guidance"];
      readonly guidance_required: true;
      readonly result_transport: "persisted_summary";
      readonly opening_policy: "registration_guidance_task_artifacts";
      readonly model_policy: "directive_override_or_runtime_default";
      readonly phases: ReadonlyMap<
        string,
        {
          readonly agent: string;
          readonly result_schema_id: string;
          readonly result_schema_version: 1;
          readonly schema: TSchema;
          /**
           * Sole catalog narrowing declaration: one fixed strict YAML subset for this phase.
           * Absence preserves YAML equality. The canonical registration digest includes it.
           */
          readonly allowed_tools?: readonly string[];
        }
      >;
    }
  | {
      readonly kind: "host-private";
      readonly workflow_name: "knowledge-base";
      readonly guidance: SkillContract["guidance"];
      readonly guidance_required: true;
      readonly result_transport: "host_typed";
      readonly opening_policy: "host_private_opening";
      readonly model_policy: "host_private_ssot_model";
      readonly phases: ReadonlyMap<
        string,
        {
          readonly agent: string;
          readonly validate: (details: Record<string, JsonValue>) => Record<string, JsonValue>;
        }
      >;
    };

type CatalogWorkerRegistrationV1 = Extract<WorkerRegistrationV1, { kind: "catalog-agent" }>;
type HostPrivateWorkerRegistrationV1 = Extract<WorkerRegistrationV1, { kind: "host-private" }>;

export interface PreparedStartV1 {
  readonly schema_id: string;
  readonly schema_version: number;
  readonly request: StartRequest;
  readonly goal: string;
  readonly constraints: Readonly<Record<string, JsonValue>>;
  readonly input_artifacts?: InputArtifacts;
  /** Registration-private, transient parsed data. It never enters RunContext. */
  readonly admission_data?: unknown;
}

export interface StartAdmissionReadOnlyHostV1 {
  readonly artifactReader?: ArtifactReader;
  readonly researchContext?: ResearchContextOwnerV1;
}

export interface StartAdmissionArtifactHostV1 extends StartAdmissionReadOnlyHostV1 {
  readonly run_id: string;
  readonly artifactStore?: ArtifactHostStore;
}

export interface StartAdmissionV1 {
  readonly schema_id: string;
  readonly schema_version: number;
  prepare(request: StartRequest, host: StartAdmissionReadOnlyHostV1): PreparedStartV1;
  materialize(
    prepared: PreparedStartV1,
    host: StartAdmissionArtifactHostV1
  ): readonly ArtifactRef[];
}

export interface RegistrationLivenessV1 {
  readonly resolver_id: string;
  resolve(context: import("../context.js").RunContext): LivenessPolicyV1 | undefined;
  readonly thinking_policy: "agent_ssot" | "research_preset";
}

export interface PlaybookRegistrationV1 {
  readonly name: string;
  /** W3: the skill's declared contract. Validated at dispatch. */
  readonly contract: SkillContract;
  /** The model/user-facing skill ingress or a separate typed host tool. */
  readonly ingress: "skill" | "dedicated_tool";
  /** Required for every skill-ingress registration and forbidden for dedicated tools. */
  readonly start_admission?: StartAdmissionV1;
  /** Registration-owned finite execution and thinking posture. */
  readonly liveness: RegistrationLivenessV1;
  /** W6: exact active worker identity, guidance, transport, model, and phase contracts. */
  readonly worker: WorkerRegistrationV1;
  /** Deterministic non-worker states that registered repair routes may target. */
  readonly host_states?: readonly string[];
  /** W7: host-owned predicates named by the closed completion gate. */
  readonly completionReceiptPredicates: ReadonlyMap<string, CompletionReceiptPredicateV1>;
  construct(options: PlaybookConstructionOptionsV1): PlaybookV1;
}

export type PlaybookRegistryV1 = ReadonlyMap<string, PlaybookRegistrationV1>;

/** The default shipped playbook when the caller does not select one explicitly. */
export const DEFAULT_PLAYBOOK_NAME = "research";

export function passthroughStartAdmission(input: {
  readonly schema_id: string;
  readonly schema_version: number;
}): StartAdmissionV1 {
  return {
    ...input,
    prepare: (request) => ({
      schema_id: input.schema_id,
      schema_version: input.schema_version,
      request,
      goal: request.goal,
      constraints: request.constraints,
      ...(request.input_artifacts === undefined
        ? {}
        : { input_artifacts: request.input_artifacts }),
    }),
    materialize: () => [],
  };
}

function persistResearchRequestArtifact(input: {
  readonly request: unknown;
  readonly runId: string;
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly store?: ArtifactHostStore;
}): ArtifactRef | undefined {
  const store = input.store;
  if (store === undefined) return undefined;
  const request = validateResearchRequest(input.request);
  const operationId = `research-request:${sha256(input.runId).slice(0, 32)}`;
  const metadata = {
    schema_version: 2 as const,
    run_id: input.runId,
    phase: "intake",
    branch_id: null,
    kind: "research-request",
    operation_id: operationId,
    version: 1,
    producer: "host:request-admission",
    media_type: "application/json",
    content_schema: {
      schema_id: "penny.research-request.v1",
      schema_version: 1,
    },
    parent_ref: null,
    upstream_refs: [...input.upstreamRefs].sort((left, right) =>
      left.artifact_id.localeCompare(right.artifact_id)
    ),
  };
  const content = canonicalJson(request);
  const existing = store.refFor(input.runId, "intake", null, "research-request", operationId, 1);
  let ref: ArtifactRef;
  if (existing !== null) {
    if (
      store.lastVersion(input.runId, "intake", null, "research-request", operationId) !== 1 ||
      canonicalJson(store.metadata(existing)) !== canonicalJson(metadata) ||
      store.readById(existing.artifact_id).toString("utf8") !== content
    ) {
      throw new Error("durable research request artifact diverged");
    }
    ref = existing;
  } else {
    ref = store.persist({ metadata, content });
  }
  const reread = store.refById(ref.artifact_id);
  if (
    reread === undefined ||
    canonicalJson(reread) !== canonicalJson(ref) ||
    store.readById(ref.artifact_id).toString("utf8") !== content
  ) {
    throw new Error("durable research request artifact failed manifest re-read");
  }
  store.select(reread);
  return reread;
}

const RESEARCH_START_ADMISSION: StartAdmissionV1 = {
  schema_id: "penny.research-request.v1",
  schema_version: 1,
  prepare: (request) => {
    const canonicalRequest = canonicalizeResearchRequest({
      question: request.goal,
      constraints: request.constraints,
      ...(request.input_artifacts === undefined ? {} : { inputArtifacts: request.input_artifacts }),
    });
    return {
      schema_id: "penny.research-request.v1",
      schema_version: 1,
      request,
      goal: request.goal,
      constraints: researchRuntimeConstraints(canonicalRequest, {
        ...(typeof request.constraints.validate_model === "string"
          ? { legacyVerificationModelOverride: request.constraints.validate_model }
          : {}),
      }),
      ...(request.input_artifacts === undefined
        ? {}
        : { input_artifacts: request.input_artifacts }),
      admission_data: canonicalRequest,
    };
  },
  materialize: (prepared, host) => {
    const request = validateResearchRequest(prepared.admission_data);
    const contextRefs =
      request.context_bindings.length === 0
        ? []
        : (() => {
            if (host.researchContext === undefined) {
              throw new Error("research context bindings require an owner resolver");
            }
            return host.researchContext.prepare(request, host.run_id);
          })();
    const inputRefs = prepared.input_artifacts?.artifacts.map((binding) => binding.ref) ?? [];
    const requestRef = persistResearchRequestArtifact({
      request,
      runId: host.run_id,
      upstreamRefs: [...inputRefs, ...contextRefs],
      ...(host.artifactStore === undefined ? {} : { store: host.artifactStore }),
    });
    return [...contextRefs, ...(requestRef === undefined ? [] : [requestRef])];
  },
};

const RESEARCH_WORKER_PHASES: CatalogWorkerRegistrationV1["phases"] = new Map([
  [
    "planning",
    {
      agent: AGENT_BY_STATE.planning,
      result_schema_id: "penny.research.planning-summary",
      result_schema_version: 1,
      schema: researchSummarySchema("planning"),
    },
  ],
  [
    "critiquing_plan",
    {
      agent: AGENT_BY_STATE.critiquing_plan,
      result_schema_id: "penny.research.critiquing-plan-summary",
      result_schema_version: 1,
      schema: researchSummarySchema("critiquing_plan"),
    },
  ],
  [
    "researching",
    {
      agent: AGENT_BY_STATE.researching,
      result_schema_id: "penny.research.researching-summary",
      result_schema_version: 1,
      schema: researchSummarySchema("researching"),
    },
  ],
  [
    "synthesizing",
    {
      agent: AGENT_BY_STATE.synthesizing,
      result_schema_id: "penny.research.synthesizing-summary",
      result_schema_version: 1,
      schema: researchSummarySchema("synthesizing"),
    },
  ],
  [
    "critiquing_report",
    {
      agent: AGENT_BY_STATE.critiquing_report,
      result_schema_id: "penny.research.critiquing-report-summary",
      result_schema_version: 1,
      schema: researchSummarySchema("critiquing_report"),
    },
  ],
  [
    "validating",
    {
      agent: AGENT_BY_STATE.validating,
      result_schema_id: "penny.research.validating-summary",
      result_schema_version: 1,
      schema: researchSummarySchema("validating"),
    },
  ],
]);

const RESEARCH_REGISTRATION: PlaybookRegistrationV1 = {
  name: DEFAULT_PLAYBOOK_NAME,
  contract: RESEARCH_SKILL_CONTRACT,
  ingress: "skill",
  start_admission: RESEARCH_START_ADMISSION,
  liveness: {
    resolver_id: "researchLivenessPolicy",
    resolve: (context) =>
      context.research.mode.length === 0
        ? researchBootstrapLivenessPolicy()
        : researchLivenessPolicy(context.research.mode),
    thinking_policy: "research_preset",
  },
  worker: {
    kind: "catalog-agent",
    workflow_name: "research",
    guidance: RESEARCH_SKILL_CONTRACT.guidance,
    guidance_required: true,
    result_transport: "persisted_summary",
    opening_policy: "registration_guidance_task_artifacts",
    model_policy: "directive_override_or_runtime_default",
    phases: RESEARCH_WORKER_PHASES,
  },
  completionReceiptPredicates: RESEARCH_COMPLETION_RECEIPT_PREDICATES,
  construct: (options) =>
    new ResearchPlaybook(
      options.artifactRevisions,
      options.researchContext,
      options.artifactStore,
      options.checkpointer,
      options.researchHostFault
    ),
};

/**
 * The KB playbook registration — the second registry entry, authorized by the G6
 * operator decision of 2026-08-18.
 *
 * It constructs through the same options as research (including the artifact
 * revision lookup), because it is a real state machine on the engine's seams rather
 * than a name in a map.
 */
const knowledgeBasePhaseContract = (
  phase: KbAgentPhase
): {
  readonly agent: string;
  readonly validate: (details: Record<string, JsonValue>) => Record<string, JsonValue>;
} => ({
  agent: KNOWLEDGE_BASE_AGENT_BY_PHASE[phase],
  validate: (details) => validateKnowledgeBasePhaseDetails(phase, details),
});

const KNOWLEDGE_BASE_WORKER_PHASES: HostPrivateWorkerRegistrationV1["phases"] = new Map(
  KB_AGENT_PHASES.map((phase) => [phase, knowledgeBasePhaseContract(phase)])
);

const KNOWLEDGE_BASE_REGISTRATION: PlaybookRegistrationV1 = {
  name: "knowledge-base",
  contract: KNOWLEDGE_BASE_SKILL_CONTRACT,
  ingress: "dedicated_tool",
  liveness: {
    resolver_id: "KbWorkerClient.livenessPolicy",
    resolve: () => undefined,
    thinking_policy: "agent_ssot",
  },
  worker: {
    kind: "host-private",
    workflow_name: "knowledge-base",
    guidance: KNOWLEDGE_BASE_SKILL_CONTRACT.guidance,
    guidance_required: true,
    result_transport: "host_typed",
    opening_policy: "host_private_opening",
    model_policy: "host_private_ssot_model",
    phases: KNOWLEDGE_BASE_WORKER_PHASES,
  },
  completionReceiptPredicates: KNOWLEDGE_BASE_COMPLETION_RECEIPT_PREDICATES,
  construct: (options) =>
    new KnowledgeBasePlaybook(
      options.artifactRevisions,
      undefined,
      undefined,
      options.privateInput,
      options.checkpointer
    ),
};

/** Shipped production registrations. Candidate source can never enter this map. */
export const PLAYBOOK_REGISTRY: PlaybookRegistryV1 = new Map([
  [RESEARCH_REGISTRATION.name, RESEARCH_REGISTRATION],
  [KNOWLEDGE_BASE_REGISTRATION.name, KNOWLEDGE_BASE_REGISTRATION],
]);

/** Source-defined candidates remain outside production; manifests control model visibility. */
export const CANDIDATE_PLAYBOOK_REGISTRY: PlaybookRegistryV1 = new Map([
  [ASSESS_CANDIDATE_REGISTRATION.name, ASSESS_CANDIDATE_REGISTRATION],
  [DECIDE_CANDIDATE_REGISTRATION.name, DECIDE_CANDIDATE_REGISTRATION],
  [DIAGNOSE_CANDIDATE_REGISTRATION.name, DIAGNOSE_CANDIDATE_REGISTRATION],
  [PLAN_CANDIDATE_REGISTRATION.name, PLAN_CANDIDATE_REGISTRATION],
  [PRODUCE_CANDIDATE_REGISTRATION.name, PRODUCE_CANDIDATE_REGISTRATION],
]);

export function skillContractSha256(contractValue: SkillContract): string {
  const contract = validateContract(SkillContractSchema, contractValue, "skill contract digest");
  return sha256(canonicalJson(contract));
}

/**
 * Canonical runtime registration digest. Catalog phase `allowed_tools` is serialized as either
 * its exact list or null, so subset drift cannot preserve a candidate checkpoint binding.
 */
export function runtimeRegistrationSha256(registration: PlaybookRegistrationV1): string {
  const worker =
    registration.worker.kind === "catalog-agent"
      ? {
          kind: registration.worker.kind,
          workflow_name: registration.worker.workflow_name,
          guidance: registration.worker.guidance,
          guidance_required: registration.worker.guidance_required,
          result_transport: registration.worker.result_transport,
          opening_policy: registration.worker.opening_policy,
          model_policy: registration.worker.model_policy,
          phases: [...registration.worker.phases.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([state_id, phase]) => ({
              state_id,
              agent: phase.agent,
              result_schema_id: phase.result_schema_id,
              result_schema_version: phase.result_schema_version,
              schema: phase.schema,
              allowed_tools: phase.allowed_tools ?? null,
            })),
        }
      : {
          kind: registration.worker.kind,
          workflow_name: registration.worker.workflow_name,
          guidance: registration.worker.guidance,
          guidance_required: registration.worker.guidance_required,
          result_transport: registration.worker.result_transport,
          opening_policy: registration.worker.opening_policy,
          model_policy: registration.worker.model_policy,
          phases: [...registration.worker.phases.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([state_id, phase]) => ({ state_id, agent: phase.agent })),
        };
  return sha256(
    canonicalJson({
      name: registration.name,
      contract: registration.contract,
      ingress: registration.ingress,
      start_admission:
        registration.start_admission === undefined
          ? null
          : {
              schema_id: registration.start_admission.schema_id,
              schema_version: registration.start_admission.schema_version,
            },
      liveness: {
        resolver_id: registration.liveness.resolver_id,
        thinking_policy: registration.liveness.thinking_policy,
      },
      worker,
      host_states: [...(registration.host_states ?? [])],
      completion_receipt_predicate_ids: [...registration.completionReceiptPredicates.keys()].sort(),
    })
  );
}

export function resolveEvaluationCandidate(input: {
  readonly name: string;
  readonly contract_sha256: string;
  readonly registry?: PlaybookRegistryV1;
}): PlaybookRegistrationV1 | undefined {
  const registry = input.registry ?? CANDIDATE_PLAYBOOK_REGISTRY;
  const registration = registry.get(input.name);
  if (
    registration === undefined ||
    registration.contract.release_status !== "candidate" ||
    skillContractSha256(registration.contract) !== input.contract_sha256
  ) {
    return undefined;
  }
  validateRegistrationContract(registration, "candidate");
  return registration;
}

/** Registered names, sorted, for diagnostics and tests. */
export function registeredPlaybookNames(
  registry: PlaybookRegistryV1 = PLAYBOOK_REGISTRY
): string[] {
  return [...registry.keys()].sort();
}

export function isRegisteredPlaybook(
  name: string,
  registry: PlaybookRegistryV1 = PLAYBOOK_REGISTRY
): boolean {
  return registry.has(name);
}

/**
 * Resolve a registration, or `undefined` when the name is unregistered.
 *
 * Returning `undefined` rather than throwing keeps the caller in control of the refusal
 * shape: `engine.recover()` must continue to answer with the exact `PLAYBOOK_UNAVAILABLE`
 * directive it produced before this registry existed.
 */
export function resolvePlaybook(
  name: string,
  registry: PlaybookRegistryV1 = PLAYBOOK_REGISTRY
): PlaybookRegistrationV1 | undefined {
  const registration = registry.get(name);
  if (registration !== undefined && registry === PLAYBOOK_REGISTRY) {
    validateRegistrationContract(registration, "production");
  }
  return registration;
}

/**
 * W3 — validate a registration's contract at dispatch.
 *
 * Fails closed: a registration whose contract is missing a required field, carries an
 * unknown key, or declares a name that disagrees with its registry key cannot be
 * constructed. The contract is authority metadata, so an invalid one is a hard error
 * rather than a warning.
 */
export function validateRegistrationContract(
  registration: PlaybookRegistrationV1,
  expectedReleaseStatus?: ReleaseStatus
): SkillContract {
  const contract = validateContract(
    SkillContractSchema,
    registration.contract,
    `skill contract for playbook '${registration.name}'`
  );
  if (contract.name !== registration.name) {
    throw new Error(
      `skill contract name '${contract.name}' does not match registration '${registration.name}'`
    );
  }
  if (expectedReleaseStatus !== undefined && contract.release_status !== expectedReleaseStatus) {
    throw new Error(
      `skill contract release status '${contract.release_status}' does not match '${expectedReleaseStatus}' registry namespace`
    );
  }
  if ((registration.ingress === "skill") !== (registration.start_admission !== undefined)) {
    throw new Error(
      `registration '${registration.name}' must bind start admission exactly when ingress is 'skill'`
    );
  }
  if (
    registration.start_admission !== undefined &&
    (registration.start_admission.schema_id !== contract.io.request.schema_id ||
      registration.start_admission.schema_version !== contract.io.request.schema_version_required)
  ) {
    throw new Error(
      `start admission does not match the contract request port for '${registration.name}'`
    );
  }
  if (registration.liveness.resolver_id !== contract.budget_policy.resolver_id) {
    throw new Error(
      `liveness resolver '${registration.liveness.resolver_id}' does not match contract budget policy for '${registration.name}'`
    );
  }
  const referenceContract =
    registration.name === "research"
      ? RESEARCH_SKILL_CONTRACT
      : registration.name === "knowledge-base"
        ? KNOWLEDGE_BASE_SKILL_CONTRACT
        : undefined;
  if (
    referenceContract !== undefined &&
    (canonicalJson(contract.io) !== canonicalJson(referenceContract.io) ||
      canonicalJson(contract.behavior) !== canonicalJson(referenceContract.behavior) ||
      canonicalJson(contract.budget_policy) !== canonicalJson(referenceContract.budget_policy))
  ) {
    throw new Error(
      `skill contract I/O, behavior, or budget projection drifted for '${registration.name}'`
    );
  }
  const ports = [
    contract.io.request,
    ...contract.io.input_ports,
    ...contract.io.active_output_ports,
  ];
  const portNames = ports.map((port) => port.name);
  if (new Set(portNames).size !== portNames.length) {
    throw new Error(`skill contract port names must be unique for '${registration.name}'`);
  }
  if (
    contract.io.request.direction !== "input" ||
    contract.io.request.transport !== "inline_request" ||
    contract.io.request.min_items !== 1 ||
    contract.io.request.max_items !== 1 ||
    contract.io.request.artifact_kind !== null ||
    contract.io.input_ports.some(
      (port) => port.direction !== "input" || port.transport !== "artifact"
    ) ||
    contract.io.active_output_ports.some(
      (port) => port.direction !== "output" || port.transport !== "artifact"
    ) ||
    ports.some(
      (port) =>
        port.min_items > port.max_items ||
        (port.transport === "artifact") !== (port.artifact_kind !== null)
    )
  ) {
    throw new Error(`skill contract port direction, transport, or cardinality is invalid`);
  }
  const duplicate = (values: readonly string[]): string | undefined =>
    values.find((value, index) => values.indexOf(value) !== index);
  const duplicateOrigin = duplicate(contract.completion_gate.allowed_terminal_origins);
  const duplicateVisit = duplicate(contract.completion_gate.required_visited_states);
  const duplicatePredicate = duplicate(contract.completion_gate.required_receipt_predicates);
  if (
    duplicateOrigin !== undefined ||
    duplicateVisit !== undefined ||
    duplicatePredicate !== undefined
  ) {
    throw new Error("completion gate state and predicate IDs must be unique");
  }
  for (const predicateId of contract.completion_gate.required_receipt_predicates) {
    if (!registration.completionReceiptPredicates.has(predicateId)) {
      throw new Error(
        `COMPLETION_PREDICATE_UNKNOWN: playbook '${registration.name}' requires '${predicateId}'`
      );
    }
  }
  const worker = registration.worker;
  if (worker.workflow_name !== registration.name) {
    throw new Error(
      `worker workflow '${worker.workflow_name}' does not match registration '${registration.name}'`
    );
  }
  if (
    worker.guidance_required !== true ||
    worker.guidance.skill_root.trim().length === 0 ||
    worker.guidance.skill_root !== contract.guidance.skill_root ||
    worker.guidance.resolution !== contract.guidance.resolution
  ) {
    throw new Error(`worker guidance does not match contract for '${registration.name}'`);
  }
  if (worker.phases.size === 0) {
    throw new Error(`worker registration '${registration.name}' declares no phases`);
  }
  if (worker.kind === "catalog-agent") {
    for (const [state, phase] of worker.phases) {
      if (state.trim().length === 0 || phase.agent.trim().length === 0) {
        throw new Error(`worker registration '${registration.name}' has an empty state or agent`);
      }
      if (phase.result_schema_id.trim().length === 0 || phase.result_schema_version !== 1) {
        throw new Error(
          `catalog worker phase '${registration.name}:${state}' has an invalid result schema identity`
        );
      }
      // Structural validation belongs to the registration. PiAgentClient revalidates strict
      // YAML membership before session creation; provider load/activation is checked before prompt.
      if (phase.allowed_tools !== undefined) {
        if (
          phase.allowed_tools.length === 0 ||
          phase.allowed_tools.some((tool) => !/^[a-z][a-z0-9_]*$/u.test(tool)) ||
          new Set(phase.allowed_tools).size !== phase.allowed_tools.length
        ) {
          throw new Error(
            `catalog worker phase '${registration.name}:${state}' has an invalid exact tool subset`
          );
        }
      }
    }
  } else {
    if (registration.ingress !== "dedicated_tool") {
      throw new Error("host-private worker registrations require dedicated_tool ingress");
    }
    for (const [state, phase] of worker.phases) {
      if (state.trim().length === 0 || phase.agent.trim().length === 0) {
        throw new Error(`worker registration '${registration.name}' has an empty state or agent`);
      }
    }
  }
  const hostStates = registration.host_states ?? [];
  if (
    hostStates.some((state) => state.trim().length === 0) ||
    new Set(hostStates).size !== hostStates.length ||
    hostStates.some((state) => worker.phases.has(state))
  ) {
    throw new Error(`registration '${registration.name}' has invalid deterministic host states`);
  }
  const stateDescriptor = new Set([
    ...worker.phases.keys(),
    ...hostStates,
    ...contract.completion_gate.allowed_terminal_origins,
    "incomplete",
  ]);
  const routeKeys = new Set<string>();
  for (const route of contract.repair_routing.routes) {
    const key = `${route.origin_state}\u0000${route.feedback_kind}`;
    if (routeKeys.has(key)) {
      throw new Error(
        `duplicate repair route '${registration.name}:${route.origin_state}:${route.feedback_kind}'`
      );
    }
    routeKeys.add(key);
    if (route.feedback_kind === "malformed_result") {
      throw new Error("malformed_result remains engine-owned by P1.2 routing repair");
    }
    if (!worker.phases.has(route.origin_state)) {
      throw new Error(
        `repair route origin '${route.origin_state}' is unreachable in '${registration.name}'`
      );
    }
    for (const target of [route.repair.target_state, route.on_exhaustion.target_state]) {
      if (!stateDescriptor.has(target)) {
        throw new Error(
          `repair route target '${target}' is not in '${registration.name}' state descriptor`
        );
      }
    }
  }
  return contract;
}

/**
 * Every playbook name authorized to ship, in sorted order.
 *
 * `research` — the parity/canary oracle, authorized since the Foundation stage.
 * `knowledge-base` — authorized by the G6 operator decision of 2026-08-18.
 *
 * Adding a name here is the explicit authorization step. It is deliberately a
 * separate edit from adding the registration itself.
 */
export const AUTHORIZED_PLAYBOOK_NAMES: readonly string[] = [
  "knowledge-base",
  DEFAULT_PLAYBOOK_NAME,
];

/**
 * Executable form of the current registration rule. Fails closed on both sides:
 * research must be present (it is the oracle every other gate leans on), and no
 * unauthorized name may ship (a registration is an authority grant, so an
 * accidental one is a hard error rather than a warning).
 */
export function assertExpectedRegistrations(
  registry: PlaybookRegistryV1 = PLAYBOOK_REGISTRY
): void {
  const names = registeredPlaybookNames(registry);
  if (!names.includes(DEFAULT_PLAYBOOK_NAME)) {
    throw new Error(`research playbook is missing from the registry; found [${names.join(", ")}]`);
  }
  const unauthorized = names.filter((n) => !AUTHORIZED_PLAYBOOK_NAMES.includes(n));
  if (unauthorized.length > 0) {
    throw new Error(
      `unauthorized playbook registration(s) [${unauthorized.join(", ")}]; ` +
        `authorized names are [${[...AUTHORIZED_PLAYBOOK_NAMES].join(", ")}]`
    );
  }
  for (const registration of registry.values()) {
    validateRegistrationContract(registration, "production");
  }
}
