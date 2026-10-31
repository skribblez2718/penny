import { validateImagegenChildPolicy } from "../child-workflows/imagegen-policy.js";
import { validatePhaseResultProjector } from "../phase-result-projection.js";
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
 * research must always be present, and only explicitly authorized names may run.
 * An accidental or unauthorized registration fails closed.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { TSchema } from "typebox";

import {
  loadPromptDocumentation,
  loadStaticPromptSourceBindings,
  type StaticDocumentSource,
} from "../catalog-prompt.js";
import {
  ChildWorkflowBudgetAllocationV1Schema,
  ChildWorkflowOutputContractV1Schema,
  JsonValueSchema,
  SkillContractSchema,
  validateContract,
  type ArtifactRef,
  type ChildWorkflowBudgetAllocationV1,
  type ChildWorkflowOutputContractV1,
  type InputArtifacts,
  type JsonValue,
  type LivenessPolicy,
  type SkillContract,
  type StartRequest,
} from "../contracts.js";
import { canonicalJson, sha256, type Checkpointer } from "../checkpointer.js";
import type {
  ArtifactHostStore,
  ArtifactReader,
  ArtifactRevisionLookup,
  ArtifactStore,
} from "../artifact-store.js";
import type { ResearchContextOwnerV2 } from "../research-context.js";
import type { ImagegenStartAdmissionProvidersV1 } from "../imagegen/types.js";
import {
  canonicalizeResearchRequest,
  ResearchCallerConstraintsV1Schema,
  researchRuntimeConstraints,
  validateResearchRequest,
} from "../skill-contracts/research.js";
import { childExecutionProgressLeaseBinding } from "../liveness-profiles.js";
import { researchBootstrapLivenessPolicy, researchLivenessPolicy } from "../liveness.js";
import { validateRegisteredBrowserNetworkAllowlist } from "../browser-policy-carrier.js";
import {
  CATALOG_AGENT_NAME_PATTERN,
  parseSsotTools,
  type GenericChildCatalogAgentYamlMaximumCarrierV1,
} from "../model-client.js";
import { validateRequiredModelIdentity, type RequiredModelIdentityV1 } from "../required-model.js";
import {
  validateChildProviderDescriptor,
  type ChildProviderDescriptorV1,
} from "../child-workflows/registration.js";
import {
  ChildWorkflowBudgetCeilingV1Schema,
  validateChildWorkflowPolicy,
  validateChildWorkflowRequest,
  type ChildWorkflowBudgetCeilingV1,
  type ChildWorkflowPolicyV1,
} from "../child-workflows/contracts.js";
import {
  validateHostOperationAuthority,
  type HostOperationAuthorityV1,
} from "../host-operations/contracts.js";
import {
  assessmentRequestConstraints,
  validateAssessmentRequest,
} from "../skill-contracts/assess.js";
import { decisionRequestConstraints, validateDecisionRequest } from "../skill-contracts/decide.js";
import {
  diagnosisRequestConstraints,
  validateDiagnosisRequest,
} from "../skill-contracts/diagnose.js";
import type { EffectEvidenceProviderV1 } from "../skill-contracts/effects.js";
import { validateSealPolicy, type SealPolicyV1 } from "../skill-contracts/sealing.js";
import {
  definitionRequestConstraints,
  validateDefinitionRequest,
} from "../skill-contracts/define.js";
import { planRequestConstraints, validatePlanRequest } from "../skill-contracts/plan.js";
import { produceRequestConstraints, validateProduceRequest } from "../skill-contracts/produce.js";
import type { CompletionReceiptPredicateV1, Playbook } from "./playbook.js";
import {
  AGENT_BY_STATE,
  RESEARCH_COMPLETION_RECEIPT_PREDICATES,
  RESEARCH_SKILL_CONTRACT,
  RESEARCH_SEAL_POLICY,
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
import { ASSESS_PLAYBOOK_REGISTRATION, AssessPlaybook } from "./assess.js";
import { DECIDE_PLAYBOOK_REGISTRATION, DecidePlaybook } from "./decide.js";
import { DIAGNOSE_PLAYBOOK_REGISTRATION, DiagnosePlaybook } from "./diagnose.js";
import { DEFINE_PLAYBOOK_REGISTRATION, DefinePlaybook } from "./define.js";
import { VIDEOGEN_PLAYBOOK_REGISTRATION } from "./videogen-unconfigured.js";
import { IMAGEGEN_PLAYBOOK_REGISTRATION } from "./imagegen.js";
import { PLAN_PLAYBOOK_REGISTRATION, PlanPlaybook } from "./plan.js";
import { PRODUCE_PLAYBOOK_REGISTRATION, ProducePlaybook } from "./produce.js";
import { SCA_PLAYBOOK_REGISTRATION } from "./sca.js";
import type { ScaP02ComponentValidationAuthorityV1 } from "../sca/p02-contracts.js";

export interface OrdinaryHostFaultPointV1 {
  readonly skill: GenericChildWorkflowName;
  readonly phase: string;
  readonly point: string;
  readonly boundary: "before_checkpoint_commit" | "after_checkpoint_commit";
}

/** In-process host option only; never a request, registration, environment or worker field. */
export type OrdinaryHostFaultV1 = (point: OrdinaryHostFaultPointV1) => void;

export interface PlaybookConstructionOptions {
  readonly hostFault?: OrdinaryHostFaultV1;
  readonly artifactRevisions?: ArtifactRevisionLookup;
  readonly artifactReader?: ArtifactReader;
  readonly artifactStore?: ArtifactHostStore;
  readonly researchContext?: ResearchContextOwnerV2;
  readonly checkpointer?: Checkpointer;
  readonly verifyExecutionReceipt?: import("../receipts.js").ExecutionReceiptVerifier;
  readonly researchHostFault?: (point: string) => void;
  /** Trusted host clock for deterministic gate evaluation; never caller- or model-selected. */
  readonly trustedClock?: () => Date;
  /** Host-owned P02 component admission authority; absence is deny-by-default. */
  readonly scaP02ComponentValidationAuthority?: ScaP02ComponentValidationAuthorityV1;
  /** Optional trusted, immutable effect-trace snapshot provider for scoped admission. */
  readonly effectEvidenceProvider?: EffectEvidenceProviderV1;
  /** Private imagegen owner dependencies; absent is a fail-closed construction posture. */
  readonly imagegen?: ImagegenStartAdmissionProvidersV1;
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
      readonly documentation_sources?: readonly StaticDocumentSource[];
      readonly prompt_sources?: readonly StaticDocumentSource[];
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
          /** Pure host projection, explicitly bound to this phase; absence preserves transport. */
          readonly result_projection?: import("../phase-result-projection.js").PhaseResultProjectorV1;
          /** Repair may only reproduce the exact source's independently valid final SUMMARY. */
          readonly routing_repair_policy?: "preserve_source_summary_v1";
          /**
           * Sole catalog tool narrowing declaration: one fixed strict YAML subset for this phase.
           * Absence preserves YAML equality. The canonical registration digest includes it.
           */
          readonly allowed_tools?: readonly string[];
          /** Registration-owned exact model identity; directives and observed sessions must match. */
          readonly required_model?: RequiredModelIdentityV1;
          /** Closed final-opening authorization policy. It requires an explicit zero-tool phase. */
          readonly provider_opening_guard?:
            | "sca_p04_payload_disclosure_v1"
            | "sca_p05_payload_disclosure_v1"
            | "sca_p06_payload_disclosure_v1"
            | "sca_p08_payload_disclosure_v1"
            | "sca_p10_payload_disclosure_v1"
            | "sca_p11_payload_disclosure_v1";
          /**
           * Optional immutable, canonical browser destination policy owned only by this phase.
           * Absence preserves ordinary browser behavior; an explicitly empty list denies all.
           */
          readonly browser_network_allowlist?: readonly string[];
          /** Optional directive state shared by heterogeneous branches with distinct phase keys. */
          readonly directive_state_id?: string;
          /** Optional guidance filename state when a fan branch has an internal execution state. */
          readonly guidance_state_id?: string;
          /** Require positive Pi model-metadata evidence for image input before every prompt. */
          readonly requires_image_input?: true;
        }
      >;
    }
  | {
      readonly kind: "host-private";
      readonly workflow_name: "knowledge-base";
      readonly guidance: SkillContract["guidance"];
      readonly documentation_sources?: readonly StaticDocumentSource[];
      readonly prompt_sources?: readonly StaticDocumentSource[];
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
    }
  | {
      /** Deterministic host-state/host-operation playbooks. No worker may be dispatched. */
      readonly kind: "none";
      readonly workflow_name: string;
      readonly guidance: SkillContract["guidance"];
      readonly documentation_sources?: readonly StaticDocumentSource[];
      readonly prompt_sources?: readonly StaticDocumentSource[];
      readonly guidance_required: true;
      readonly result_transport: "host_typed";
      readonly opening_policy: "none";
      readonly model_policy: "none";
      readonly phases: ReadonlyMap<string, never>;
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
  /** Exact project-bound verifier, never caller-supplied. */
  readonly assurance?: {
    readonly artifacts: ArtifactStore;
    readonly checkpointer: Checkpointer;
    readonly project_id: string;
    readonly project_root: string;
    readonly consumer: import("../composition-assurance.js").CompositionAssuranceV1["consumer"];
    /** Exact active Define registration accepted as a reviewed producer, or null when unavailable. */
    readonly supported_define_registration_sha256: string | null;
  };
  readonly researchContext?: ResearchContextOwnerV2;
  /** Private host-owned profile, export, and storage registries; absent is deny-by-default. */
  readonly imagegen?: ImagegenStartAdmissionProvidersV1;
}

export interface StartAdmissionArtifactHostV1 extends StartAdmissionReadOnlyHostV1 {
  readonly run_id: string;
  readonly artifactStore?: ArtifactHostStore;
  /** Host-owned admission clock; caller content cannot select it. */
  readonly trustedClock?: () => Date;
}

export interface StartAdmissionV1 {
  readonly schema_id: string;
  readonly schema_version: number;
  /** Bound to the runtime registration digest; only declared invocation versions work. */
  readonly invocation_versions?: readonly number[];
  prepare(request: StartRequest, host: StartAdmissionReadOnlyHostV1): PreparedStartV1;
  materialize(
    prepared: PreparedStartV1,
    host: StartAdmissionArtifactHostV1
  ): readonly ArtifactRef[];
}

/**
 * Documentation is bound to the same structural constraints schema and admission seam as
 * execution. It is presentation metadata, deliberately excluded from registration digests.
 */
export interface CallerDocumentationV1 {
  readonly constraints_schema: TSchema;
  readonly example: {
    readonly goal: string;
    readonly constraints: Readonly<Record<string, JsonValue>>;
  };
  readonly semantic_caveat: string;
}

export interface RegistrationLivenessV1 {
  readonly resolver_id: string;
  resolve(
    context: import("../context.js").RunContext,
    boundPolicy?: LivenessPolicy
  ): LivenessPolicy | undefined;
  readonly thinking_policy: "agent_ssot" | "research_preset";
}

export type GenericChildToolAuthorityV1 =
  | GenericChildCatalogAgentYamlMaximumCarrierV1
  | {
      readonly carrier: "registration_strict_subset";
      readonly allowed_tools: readonly string[];
    };

export interface GenericChildProviderPhaseV1 {
  readonly schema_version: 1;
  readonly state_id: string;
  readonly agent: string;
  readonly result_schema_id: string;
  readonly result_schema_version: 1;
  readonly result_schema: TSchema;
  readonly result_projection?: import("../phase-result-projection.js").PhaseResultProjectionDeclarationV1;
  readonly routing_repair_policy?: "preserve_source_summary_v1";
  /** Exact fixed worker/model-client authority carrier; never request-selected. */
  readonly tool_authority: GenericChildToolAuthorityV1;
  /** The only registered destination policy. Null means the existing phase has none. */
  readonly browser_network_allowlist: readonly string[] | null;
}

export interface GenericChildProviderDeclarationV1 {
  readonly schema_version: 1;
  readonly provider_name: string;
  readonly ingress: "skill";
  readonly model_visibility: "model_visible_ordinary";
  /** Registry-owned authority used by the internal depth-one runtime; not qualification status. */
  readonly availability: "active_internal_runtime";
  readonly operator_authorization: "explicit_static";
  /** Internal host-only, depth-one dispatch through ChildWorkflowRuntimeOwner. */
  readonly dispatch_capability: "depth_one";
  /** Gate 2 and live-provider evidence remain deliberately separate and unrun. */
  readonly qualification: {
    readonly gate_id: "gate_2_live_provider";
    readonly status: "not_run";
    readonly evidence: null;
  };
  readonly native_request: {
    readonly validator_id: string;
    readonly port: SkillContract["io"]["request"];
  };
  readonly input_ports: readonly SkillContract["io"]["input_ports"][number][];
  readonly terminal_output_port: SkillContract["io"]["active_output_ports"][number];
  readonly expected_output: ChildWorkflowOutputContractV1;
  readonly phases: readonly GenericChildProviderPhaseV1[];
}

export interface GenericChildTargetV1 {
  readonly schema_version: 1;
  readonly child_name: string;
  readonly native_request: {
    readonly schema_id: string;
    readonly schema_version: number;
  };
  readonly expected_output: ChildWorkflowOutputContractV1;
  readonly budget: ChildWorkflowBudgetAllocationV1;
}

export interface GenericChildParentPolicyV1 {
  readonly schema_version: 1;
  readonly authorization_id: "operator.generic-child.universal-v1";
  readonly request_envelope: {
    readonly schema_id: "penny.child-workflow-request.v1";
    readonly schema_version: 1;
  };
  readonly max_nesting_depth: 1;
  readonly max_active_children: 1;
  readonly max_calls: 1;
  readonly project_concurrency_limit: 1;
  readonly aggregate_budget: ChildWorkflowBudgetCeilingV1;
  readonly parent_sealing_reserve: ChildWorkflowBudgetCeilingV1;
  readonly targets: readonly GenericChildTargetV1[];
}

export interface GenericChildAuthorityV1 {
  readonly schema_version: 1;
  readonly parent_policy: GenericChildParentPolicyV1;
  readonly provider: GenericChildProviderDeclarationV1;
}

export interface GenericChildTargetV2 {
  readonly schema_version: 2;
  readonly child_name: string;
  readonly native_request: {
    readonly schema_id: string;
    readonly schema_version: number;
  };
  readonly expected_output: ChildWorkflowOutputContractV1;
  readonly progress_lease: ReturnType<typeof childExecutionProgressLeaseBinding>;
}

export interface GenericChildParentPolicyV2 {
  readonly schema_version: 2;
  readonly authorization_id: "operator.generic-child.universal-v2";
  readonly request_envelope: {
    readonly schema_id: "penny.child-workflow-request.v1";
    readonly schema_version: 1;
  };
  readonly max_nesting_depth: 1;
  readonly max_active_children: 1;
  readonly max_calls: 1;
  readonly project_concurrency_limit: 1;
  readonly targets: readonly GenericChildTargetV2[];
}

export interface GenericChildAuthorityV2 {
  readonly schema_version: 2;
  readonly parent_policy: GenericChildParentPolicyV2;
  readonly provider: GenericChildProviderDeclarationV1;
}

export type GenericChildAuthority = GenericChildAuthorityV1 | GenericChildAuthorityV2;

export interface PlaybookRegistration {
  readonly name: string;
  /** W3: the skill's declared contract. Validated at dispatch. */
  readonly contract: SkillContract;
  /** The model/user-facing skill ingress or a separate typed host tool. */
  readonly ingress: "skill" | "dedicated_tool";
  /** Required for every skill-ingress registration and forbidden for dedicated tools. */
  readonly start_admission?: StartAdmissionV1;
  readonly contextual_inputs?: "accepted_terminal_products_v1";
  /** Required for generic skill ingress; generated SKILL.md source of truth. */
  readonly caller_documentation?: CallerDocumentationV1;
  /** Registration-owned finite execution and thinking posture. */
  readonly liveness: RegistrationLivenessV1;
  /** W6: exact active worker identity, guidance, transport, model, and phase contracts. */
  readonly worker: WorkerRegistrationV1;
  /** Deterministic non-worker states that registered repair routes may target. */
  readonly host_states?: readonly string[];
  /**
   * Optional only for non-active/synthetic registrations. Absence is a generic-child deny.
   * Every ordinary registration in PLAYBOOK_REGISTRY carries the explicit static projection.
   */
  readonly generic_child?: GenericChildAuthority;
  /** Separate explicit parent-only authority; never projects this workflow as a provider. */
  readonly information_child?: InformationChildAuthorityV1;
  /** Explicit asset-only child authority. Absence does not grant imagegen composition. */
  readonly imagegen_child?: import("../child-workflows/imagegen-policy.js").ImagegenChildPolicyV1;
  /** Opt-in only; legacy/other registrations retain their exact existing digest. */
  readonly seal_policy?: SealPolicyV1;
  /** Optional registered asynchronous host-operation authority. Absence is deny-by-default. */
  readonly host_operations?: HostOperationAuthorityV1;
  /** Opt-in exact recurrence measurement; requires both repair-progress playbook methods.
   * Version changes when the host's semantic fingerprint basis changes. Absence is unchanged. */
  readonly repair_progress_policy?: "exact_fingerprint_v1";
  /** W7: host-owned predicates named by the closed completion gate. */
  readonly completionReceiptPredicates: ReadonlyMap<string, CompletionReceiptPredicateV1>;
  construct(options: PlaybookConstructionOptions): Playbook;
}

export interface InformationChildAuthorityV1 {
  readonly schema_version: 1;
  readonly authorization_id: "operator.videogen-information-child.v1";
  readonly parent_states: readonly ["child_call"];
  readonly parent_policy: Omit<GenericChildParentPolicyV2, "authorization_id" | "max_calls"> & {
    readonly authorization_id: "operator.videogen-information-child.v1";
    readonly max_calls: number;
  };
}
export type PlaybookRegistry = ReadonlyMap<string, PlaybookRegistration>;

function validateInformationChildAuthority(registration: PlaybookRegistration): void {
  const a = registration.information_child;
  if (a === undefined) return;
  const p = a.parent_policy;
  if (
    registration.name !== "videogen" ||
    registration.ingress !== "skill" ||
    registration.generic_child !== undefined ||
    a.schema_version !== 1 ||
    a.authorization_id !== "operator.videogen-information-child.v1" ||
    canonicalJson(a.parent_states) !== canonicalJson(["child_call"]) ||
    p.schema_version !== 2 ||
    p.authorization_id !== a.authorization_id ||
    canonicalJson(p.request_envelope) !==
      canonicalJson({ schema_id: "penny.child-workflow-request.v1", schema_version: 1 }) ||
    p.max_nesting_depth !== 1 ||
    p.max_active_children !== 1 ||
    p.project_concurrency_limit !== 1 ||
    !Number.isSafeInteger(p.max_calls) ||
    p.max_calls < 1 ||
    p.max_calls > 6 ||
    p.targets.length < 1 ||
    p.targets.length > 7 ||
    new Set(p.targets.map((t) => t.child_name)).size !== p.targets.length
  )
    throw new Error("invalid explicit videogen information-child authority");
  for (const t of p.targets) {
    const ordinary = GENERIC_CHILD_PARENT_POLICY.targets.find((x) => x.child_name === t.child_name);
    if (ordinary === undefined || canonicalJson(t) !== canonicalJson(ordinary))
      throw new Error("information child must bind an unchanged ordinary native provider target");
  }
}

export const GENERIC_CHILD_WORKFLOW_NAMES = Object.freeze([
  "assess",
  "decide",
  "define",
  "diagnose",
  "plan",
  "produce",
  "research",
] as const);

export type GenericChildWorkflowName = (typeof GENERIC_CHILD_WORKFLOW_NAMES)[number];

/** One depth-one call, no external requests, and a bounded local/model envelope. */
export const GENERIC_CHILD_TARGET_BUDGET_V1 = Object.freeze({
  schema_version: 1,
  model_turns: 8,
  tool_calls: 16,
  external_calls: 0,
  wall_clock_ms: 120_000,
  max_steps: 8,
  output_bytes: 1_048_576,
} as const satisfies ChildWorkflowBudgetAllocationV1);

/** Capacity retained only for exact legacy V1 replay. */
export const GENERIC_CHILD_PARENT_SEALING_RESERVE_V1 = Object.freeze({
  schema_version: 1,
  model_turns: 2,
  tool_calls: 2,
  external_calls: 0,
  wall_clock_ms: 30_000,
  max_steps: 2,
  output_bytes: 65_536,
} as const satisfies ChildWorkflowBudgetCeilingV1);

export const GENERIC_CHILD_AGGREGATE_BUDGET_V1 = Object.freeze({
  schema_version: 1,
  model_turns: 10,
  tool_calls: 18,
  external_calls: 0,
  wall_clock_ms: 150_000,
  max_steps: 10,
  output_bytes: 1_114_112,
} as const satisfies ChildWorkflowBudgetCeilingV1);

/**
 * Non-shipping child-workflow qualification shape. It remains separate from the active static
 * authority declaration and never mutates a production registration or its digest.
 */
export interface ChildWorkflowCandidateRegistrationV1 {
  readonly registration: PlaybookRegistration;
  readonly parent_policy: ChildWorkflowPolicyV1;
  readonly provider?: ChildProviderDescriptorV1;
}

export function validateChildWorkflowCandidateRegistration(
  value: ChildWorkflowCandidateRegistrationV1
): ChildWorkflowCandidateRegistrationV1 {
  validateRegistrationContract(value.registration);
  const registration = value.registration;
  const parentPolicy = validateChildWorkflowPolicy(value.parent_policy);
  if (value.provider === undefined) {
    return { registration: value.registration, parent_policy: parentPolicy };
  }
  const provider = validateChildProviderDescriptor(value.provider);
  if (registration.name !== provider.provider_name) {
    throw new Error(
      `candidate provider '${provider.provider_name}' does not match registration '${registration.name}'`
    );
  }
  if (registration.ingress !== provider.ingress) {
    throw new Error(`candidate provider '${provider.provider_name}' has incompatible ingress`);
  }
  if (
    registration.start_admission === undefined ||
    registration.start_admission.schema_id !== provider.request.schema_id ||
    registration.start_admission.schema_version !== provider.request.schema_version
  ) {
    throw new Error(`candidate provider '${provider.provider_name}' request admission diverges`);
  }
  return { registration: value.registration, parent_policy: parentPolicy, provider };
}

interface GenericChildNativeRequestValidatorV1 {
  readonly validator_id: string;
  validate(value: unknown): unknown;
  /**
   * Registration-owned inverse of the ordinary ingress canonicalizer. It preserves each
   * provider's native request semantics while constructing the child engine's closed start
   * envelope; the generic dispatcher never switches on a provider name.
   */
  start(
    value: unknown,
    policy: import("../child-workflows/contracts.js").ChildWorkflowRequestV1["invocation_policy"]
  ): { readonly goal: string; readonly constraints: Record<string, JsonValue> };
}

function expectedChildOutput(
  port: SkillContract["io"]["active_output_ports"][number]
): ChildWorkflowOutputContractV1 {
  if (port.artifact_kind === null) {
    throw new Error(`generic child output port '${port.name}' must be an artifact`);
  }
  return Object.freeze({
    schema_version: 1,
    port_name: port.name,
    schema_id: port.schema_id,
    schema_version_required: port.schema_version_required,
    artifact_kind: port.artifact_kind,
  });
}

/**
 * Read the exact ordinary catalog maximum used by an active child-authority projection.
 * The same caller project catalog is re-read during validation, so YAML edits refuse rather
 * than silently widening a digest-bound phase.
 */
function hasCatalogAgentDefinitions(catalogProjectRoot: string): boolean {
  return existsSync(path.join(catalogProjectRoot, ".pi", "agents"));
}

function catalogAgentYamlMaximum(catalogProjectRoot: string, agent: string): readonly string[] {
  if (!CATALOG_AGENT_NAME_PATTERN.test(agent)) {
    throw new Error(`generic child provider has non-canonical catalog agent '${agent}'`);
  }
  const definitionPath = path.join(catalogProjectRoot, ".pi", "agents", `${agent}.md`);
  let definition: string;
  try {
    definition = readFileSync(definitionPath, "utf8");
  } catch {
    throw new Error(
      `generic child provider agent '${agent}' has no readable YAML tool maximum in the project catalog`
    );
  }
  return Object.freeze([...parseSsotTools(definition, agent)]);
}

function projectGenericChildProvider(
  registration: PlaybookRegistration,
  validator: GenericChildNativeRequestValidatorV1,
  catalogProjectRoot?: string
): GenericChildProviderDeclarationV1 {
  if (
    registration.ingress !== "skill" ||
    registration.start_admission === undefined ||
    registration.worker.kind !== "catalog-agent"
  ) {
    throw new Error(
      `registration '${registration.name}' is not an ordinary generic-child provider`
    );
  }
  const output = registration.contract.io.active_output_ports[0];
  if (output === undefined || registration.contract.io.active_output_ports.length !== 1) {
    throw new Error(
      `generic child provider '${registration.name}' must declare exactly one active output port`
    );
  }
  const phases = [...registration.worker.phases.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state_id, phase]) =>
      Object.freeze({
        schema_version: 1 as const,
        state_id,
        agent: phase.agent,
        result_schema_id: phase.result_schema_id,
        result_schema_version: phase.result_schema_version,
        result_schema: phase.schema,
        ...(phase.result_projection === undefined
          ? {}
          : { result_projection: phase.result_projection.declaration }),
        ...(phase.routing_repair_policy === undefined
          ? {}
          : { routing_repair_policy: phase.routing_repair_policy }),
        tool_authority: Object.freeze(
          phase.allowed_tools === undefined
            ? {
                carrier: "catalog_agent_yaml_maximum" as const,
                allowed_tools:
                  catalogProjectRoot === undefined ||
                  !hasCatalogAgentDefinitions(catalogProjectRoot)
                    ? null
                    : catalogAgentYamlMaximum(catalogProjectRoot, phase.agent),
              }
            : {
                carrier: "registration_strict_subset" as const,
                allowed_tools: phase.allowed_tools,
              }
        ),
        browser_network_allowlist: phase.browser_network_allowlist ?? null,
      })
    );
  return Object.freeze({
    schema_version: 1,
    provider_name: registration.name,
    ingress: "skill",
    model_visibility: "model_visible_ordinary",
    availability: "active_internal_runtime",
    operator_authorization: "explicit_static",
    dispatch_capability: "depth_one",
    qualification: Object.freeze({
      gate_id: "gate_2_live_provider",
      status: "not_run",
      evidence: null,
    }),
    native_request: Object.freeze({
      validator_id: validator.validator_id,
      port: registration.contract.io.request,
    }),
    input_ports: Object.freeze([...registration.contract.io.input_ports]),
    terminal_output_port: output,
    expected_output: expectedChildOutput(output),
    phases: Object.freeze(phases),
  });
}

function buildLegacyGenericChildParentPolicy(
  providers: readonly GenericChildProviderDeclarationV1[]
): GenericChildParentPolicyV1 {
  const targets = [...providers]
    .sort((left, right) => left.provider_name.localeCompare(right.provider_name))
    .map((provider) =>
      Object.freeze({
        schema_version: 1 as const,
        child_name: provider.provider_name,
        native_request: Object.freeze({
          schema_id: provider.native_request.port.schema_id,
          schema_version: provider.native_request.port.schema_version_required,
        }),
        expected_output: provider.expected_output,
        budget: GENERIC_CHILD_TARGET_BUDGET_V1,
      })
    );
  return Object.freeze({
    schema_version: 1,
    authorization_id: "operator.generic-child.universal-v1",
    request_envelope: Object.freeze({
      schema_id: "penny.child-workflow-request.v1",
      schema_version: 1,
    }),
    max_nesting_depth: 1,
    max_active_children: 1,
    max_calls: 1,
    project_concurrency_limit: 1,
    aggregate_budget: GENERIC_CHILD_AGGREGATE_BUDGET_V1,
    parent_sealing_reserve: GENERIC_CHILD_PARENT_SEALING_RESERVE_V1,
    targets: Object.freeze(targets),
  });
}

function buildGenericChildParentPolicy(
  providers: readonly GenericChildProviderDeclarationV1[]
): GenericChildParentPolicyV2 {
  const targets = [...providers]
    .sort((left, right) => left.provider_name.localeCompare(right.provider_name))
    .map((provider) =>
      Object.freeze({
        schema_version: 2 as const,
        child_name: provider.provider_name,
        native_request: Object.freeze({
          schema_id: provider.native_request.port.schema_id,
          schema_version: provider.native_request.port.schema_version_required,
        }),
        expected_output: provider.expected_output,
        progress_lease: childExecutionProgressLeaseBinding(),
      })
    );
  return Object.freeze({
    schema_version: 2,
    authorization_id: "operator.generic-child.universal-v2",
    request_envelope: Object.freeze({
      schema_id: "penny.child-workflow-request.v1",
      schema_version: 1,
    }),
    max_nesting_depth: 1,
    max_active_children: 1,
    max_calls: 1,
    project_concurrency_limit: 1,
    targets: Object.freeze(targets),
  });
}

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
      routing_repair_policy: "preserve_source_summary_v1",
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
      routing_repair_policy: "preserve_source_summary_v1",
    },
  ],
  [
    "validating",
    {
      agent: AGENT_BY_STATE.validating,
      result_schema_id: "penny.research.validating-summary",
      result_schema_version: 1,
      schema: researchSummarySchema("validating"),
      routing_repair_policy: "preserve_source_summary_v1",
    },
  ],
]);

const RESEARCH_REGISTRATION: PlaybookRegistration = {
  name: DEFAULT_PLAYBOOK_NAME,
  contract: RESEARCH_SKILL_CONTRACT,
  ingress: "skill",
  start_admission: RESEARCH_START_ADMISSION,
  seal_policy: RESEARCH_SEAL_POLICY,
  repair_progress_policy: "exact_fingerprint_v1",
  host_states: ["sealing_core", "rendering"],
  caller_documentation: {
    constraints_schema: ResearchCallerConstraintsV1Schema,
    example: {
      goal: "Research the supplied question.",
      constraints: {
        mode: "quick",
        scope: { include: [], exclude: [] },
      },
    },
    semantic_caveat:
      "Caller artifacts must be exact admitted ports; ordinary constraints cannot set host liveness.",
  },
  liveness: {
    resolver_id: "researchLivenessPolicy",
    resolve: (context) => {
      const selected = context.research.mode.length === 0 ? undefined : context.research.mode;
      return selected === undefined
        ? researchBootstrapLivenessPolicy()
        : researchLivenessPolicy(selected);
    },
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
      options.researchHostFault,
      RESEARCH_SEAL_POLICY
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

const KNOWLEDGE_BASE_REGISTRATION: PlaybookRegistration = {
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

const GENERIC_CHILD_NATIVE_REQUEST_VALIDATORS: ReadonlyMap<
  GenericChildWorkflowName,
  GenericChildNativeRequestValidatorV1
> = new Map([
  [
    "assess",
    {
      validator_id: "penny.assessment-request.v1.validator",
      validate: validateAssessmentRequest,
      start: (value) => {
        const request = validateAssessmentRequest(value);
        return {
          goal: request.assessment_purpose,
          constraints: assessmentRequestConstraints(request),
        };
      },
    },
  ],
  [
    "decide",
    {
      validator_id: "penny.decision-request.v1.validator",
      validate: validateDecisionRequest,
      start: (value) => {
        const request = validateDecisionRequest(value);
        return {
          goal: request.decision_question,
          constraints: decisionRequestConstraints(request),
        };
      },
    },
  ],
  [
    "diagnose",
    {
      validator_id: "penny.diagnosis-request.v1.validator",
      validate: validateDiagnosisRequest,
      start: (value) => {
        const request = validateDiagnosisRequest(value);
        return {
          goal: request.problem_statement,
          constraints: diagnosisRequestConstraints(request),
        };
      },
    },
  ],
  [
    "define",
    {
      validator_id: "penny.definition-request.v1.invocation-v2.validator",
      validate: validateDefinitionRequest,
      start: (value, policy) => {
        const request = validateDefinitionRequest(value);
        const native = definitionRequestConstraints(request);
        return {
          goal: request.goal,
          constraints:
            policy === undefined
              ? native
              : {
                  schema_version: 2,
                  request: native,
                  specification_assurance: policy.specification_assurance,
                },
        };
      },
    },
  ],
  [
    "plan",
    {
      validator_id: "penny.plan-request.v1.invocation-v2.validator",
      validate: validatePlanRequest,
      start: (value, policy) => {
        const request = validatePlanRequest(value);
        const native = planRequestConstraints(request);
        return {
          goal: request.goal,
          constraints:
            policy === undefined
              ? native
              : {
                  schema_version: 2,
                  request: native,
                  specification_assurance: policy.specification_assurance,
                },
        };
      },
    },
  ],
  [
    "produce",
    {
      validator_id: "penny.produce-request.v1.validator",
      validate: validateProduceRequest,
      start: (value) => {
        const request = validateProduceRequest(value);
        return {
          goal: request.purpose_statement,
          constraints: produceRequestConstraints(request),
        };
      },
    },
  ],
  [
    "research",
    {
      validator_id: "penny.research-request.v1.validator",
      validate: validateResearchRequest,
      start: (value) => {
        const request = validateResearchRequest(value);
        return {
          goal: request.question,
          constraints: {
            mode: request.mode,
            scope: request.scope,
            verification_model_override: request.verification_model_override,
            budget_overrides: request.budget_overrides,
            context_bindings: request.context_bindings,
          },
        };
      },
    },
  ],
]);

const ORDINARY_BASE_REGISTRATIONS = [
  ASSESS_PLAYBOOK_REGISTRATION,
  DECIDE_PLAYBOOK_REGISTRATION,
  DIAGNOSE_PLAYBOOK_REGISTRATION,
  DEFINE_PLAYBOOK_REGISTRATION,
  PLAN_PLAYBOOK_REGISTRATION,
  PRODUCE_PLAYBOOK_REGISTRATION,
  RESEARCH_REGISTRATION,
] as const;

function isGenericChildWorkflowName(value: string): value is GenericChildWorkflowName {
  return GENERIC_CHILD_WORKFLOW_NAMES.some((name) => name === value);
}

function genericChildValidator(name: string): GenericChildNativeRequestValidatorV1 {
  if (!isGenericChildWorkflowName(name)) {
    throw new Error(`generic child provider '${name}' has no static native request validator`);
  }
  const validator = GENERIC_CHILD_NATIVE_REQUEST_VALIDATORS.get(name);
  if (validator === undefined) {
    throw new Error(`generic child provider '${name}' has no static native request validator`);
  }
  return validator;
}

const GENERIC_CHILD_PROVIDERS = ORDINARY_BASE_REGISTRATIONS.map((registration) =>
  projectGenericChildProvider(registration, genericChildValidator(registration.name))
);
const LEGACY_GENERIC_CHILD_PARENT_POLICY =
  buildLegacyGenericChildParentPolicy(GENERIC_CHILD_PROVIDERS);
export const GENERIC_CHILD_PARENT_POLICY = buildGenericChildParentPolicy(GENERIC_CHILD_PROVIDERS);

function ordinaryFaultAdapter(
  skill: GenericChildWorkflowName,
  hook: OrdinaryHostFaultV1 | undefined
): ((point: string) => void) | undefined {
  if (hook === undefined) return undefined;
  return (point) => {
    const separator = point.indexOf(":");
    if (separator <= 0 || separator === point.length - 1) {
      throw new Error("registered host fault point has no phase or name");
    }
    hook({
      skill,
      phase: point.slice(0, separator),
      point,
      boundary:
        point.endsWith(":completion-admission") || point === "rendering:final-checkpoint-admission"
          ? "after_checkpoint_commit"
          : "before_checkpoint_commit",
    });
  };
}

function withGenericChildAuthority(registration: PlaybookRegistration): PlaybookRegistration {
  const provider = GENERIC_CHILD_PROVIDERS.find(
    (candidate) => candidate.provider_name === registration.name
  );
  if (provider === undefined) {
    throw new Error(`ordinary registration '${registration.name}' lacks a generic child provider`);
  }
  return Object.freeze({
    ...registration,
    contextual_inputs: "accepted_terminal_products_v1",
    // Constructors in the skill source retain their legacy optional callback positions.
    // This registry adapter wires the ordinary host-only seam without changing skill source
    // or the serialized registration/contract digest.
    construct: (options: PlaybookConstructionOptions): Playbook => {
      if (options.hostFault !== undefined && options.researchHostFault !== undefined) {
        throw new Error("ambiguous host fault hooks: choose hostFault or researchHostFault");
      }
      if (registration.name === "research") {
        const hook =
          options.researchHostFault ?? ordinaryFaultAdapter("research", options.hostFault);
        return registration.construct({
          ...options,
          ...(hook === undefined ? {} : { researchHostFault: hook }),
        });
      }
      if (
        registration.name !== "assess" &&
        registration.name !== "decide" &&
        registration.name !== "define" &&
        registration.name !== "diagnose" &&
        registration.name !== "plan" &&
        registration.name !== "produce"
      ) {
        throw new Error("ordinary host fault adapter requires an ordinary registration");
      }
      const hook = ordinaryFaultAdapter(registration.name, options.hostFault);
      switch (registration.name) {
        case "assess":
          return new AssessPlaybook(
            options.artifactRevisions,
            options.artifactStore,
            options.checkpointer,
            hook,
            options.effectEvidenceProvider
          );
        case "decide":
          return new DecidePlaybook(
            options.artifactRevisions,
            options.artifactStore,
            options.checkpointer,
            hook
          );
        case "define":
          return new DefinePlaybook(
            options.artifactRevisions,
            options.artifactStore,
            options.checkpointer,
            hook
          );
        case "diagnose":
          return new DiagnosePlaybook(
            options.artifactRevisions,
            options.artifactStore,
            options.checkpointer,
            hook
          );
        case "plan":
          return new PlanPlaybook(
            options.artifactRevisions,
            options.artifactStore,
            options.checkpointer,
            hook
          );
        case "produce":
          return new ProducePlaybook(
            options.artifactRevisions,
            options.artifactStore,
            options.checkpointer,
            hook,
            options.effectEvidenceProvider,
            options.verifyExecutionReceipt
          );
      }
    },
    generic_child: Object.freeze({
      schema_version: 2,
      parent_policy: GENERIC_CHILD_PARENT_POLICY,
      provider,
    }),
  });
}

function registrationPromptSourcePaths(registration: PlaybookRegistration): readonly string[] {
  const rolePaths = [
    ...new Set(
      [...registration.worker.phases.values()].map((phase) => `.pi/agents/${phase.agent}.md`)
    ),
  ].sort();
  const guidancePaths = [...registration.worker.phases.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stateId, phase]) =>
      registration.worker.guidance.resolution === "per_agent"
        ? `${registration.worker.guidance.skill_root}/${phase.agent}.md`
        : `${registration.worker.guidance.skill_root}/${phase.agent}-${
            "guidance_state_id" in phase && phase.guidance_state_id !== undefined
              ? phase.guidance_state_id
              : stateId
          }.md`
    );
  return [...new Set([".pi/SYSTEM.md", "AGENTS.md", ...rolePaths, ...guidancePaths])];
}

function hasCompletePromptCatalog(projectRoot: string): boolean {
  return (
    existsSync(path.join(projectRoot, ".pi", "SYSTEM.md")) &&
    existsSync(path.join(projectRoot, "AGENTS.md")) &&
    hasCatalogAgentDefinitions(projectRoot)
  );
}

/**
 * Bind an ordinary registry template to the caller project catalog before it becomes active.
 * Templates deliberately retain `null` YAML carriers so import/discovery needs no caller path.
 * A caller without an agent catalog stays unbound and cannot start a catalog model session; once a
 * catalog is present, the active registration carries its exact lists in the runtime digest.
 */
export function bindGenericChildYamlAuthority(
  registration: PlaybookRegistration,
  catalogProjectRoot: string
): PlaybookRegistration {
  if (!path.isAbsolute(catalogProjectRoot)) {
    throw new Error("generic child catalog project root must be absolute");
  }
  // Preserve the policy for alternate constructors using the same native admission owner.
  if (
    ORDINARY_BASE_REGISTRATIONS.some(
      (base) =>
        base.name === registration.name && base.start_admission === registration.start_admission
    )
  ) {
    registration = { ...registration, contextual_inputs: "accepted_terminal_products_v1" };
  }
  const declarations = registration.contract.guidance.documentation;
  let boundRegistration = registration;
  if (declarations !== undefined && existsSync(path.join(catalogProjectRoot, "docs", "agents"))) {
    const currentSources = Object.freeze(
      loadPromptDocumentation(catalogProjectRoot, declarations).map((document) =>
        Object.freeze({ ...document.source })
      )
    );
    const recordedSources = registration.worker.documentation_sources;
    if (
      recordedSources !== undefined &&
      canonicalJson(recordedSources) !== canonicalJson(currentSources)
    ) {
      throw new Error(`documentation source binding drifted for '${registration.name}'`);
    }
    if (recordedSources === undefined) {
      boundRegistration = Object.freeze({
        ...registration,
        worker: Object.freeze({
          ...registration.worker,
          documentation_sources: currentSources,
        }),
      });
    }
  }
  if (hasCompletePromptCatalog(catalogProjectRoot)) {
    const currentPromptSources = Object.freeze(
      loadStaticPromptSourceBindings(
        catalogProjectRoot,
        registrationPromptSourcePaths(boundRegistration)
      ).map((source) => Object.freeze({ ...source }))
    );
    const recordedPromptSources = boundRegistration.worker.prompt_sources;
    if (
      recordedPromptSources !== undefined &&
      canonicalJson(recordedPromptSources) !== canonicalJson(currentPromptSources)
    ) {
      throw new Error(`prompt source binding drifted for '${registration.name}'`);
    }
    if (recordedPromptSources === undefined) {
      boundRegistration = Object.freeze({
        ...boundRegistration,
        worker: Object.freeze({
          ...boundRegistration.worker,
          prompt_sources: currentPromptSources,
        }),
      });
    }
  }
  if (boundRegistration.generic_child === undefined) {
    validateRegistrationContract(boundRegistration, catalogProjectRoot);
    return boundRegistration;
  }
  if (!hasCatalogAgentDefinitions(catalogProjectRoot)) return boundRegistration;
  const yamlMaximums = boundRegistration.generic_child.provider.phases.filter(
    (phase) => phase.tool_authority.carrier === "catalog_agent_yaml_maximum"
  );
  if (yamlMaximums.some((phase) => phase.tool_authority.allowed_tools !== null)) {
    validateRegistrationContract(boundRegistration, catalogProjectRoot);
    return boundRegistration;
  }
  const provider = projectGenericChildProvider(
    boundRegistration,
    genericChildValidator(boundRegistration.name),
    catalogProjectRoot
  );
  const bound = Object.freeze({
    ...boundRegistration,
    generic_child: Object.freeze({
      ...boundRegistration.generic_child,
      provider,
    }),
  });
  validateRegistrationContract(bound, catalogProjectRoot);
  return bound;
}

const ACTIVE_ORDINARY_REGISTRATIONS = new Map(
  ORDINARY_BASE_REGISTRATIONS.map((registration) => {
    const active = withGenericChildAuthority(registration);
    return [active.name, active] as const;
  })
);

/** Preserve an explicitly supplied base registration's digest while wiring its normal host seam. */
export function withOrdinaryFaultConstructor(
  registration: PlaybookRegistration
): PlaybookRegistration {
  if (!ORDINARY_BASE_REGISTRATIONS.some((base) => base === registration)) return registration;
  const active = ACTIVE_ORDINARY_REGISTRATIONS.get(registration.name);
  if (active === undefined) throw new Error("ordinary host fault constructor is unavailable");
  return { ...registration, construct: active.construct };
}

function activeOrdinaryRegistration(name: GenericChildWorkflowName): PlaybookRegistration {
  const registration = ACTIVE_ORDINARY_REGISTRATIONS.get(name);
  if (registration === undefined) {
    throw new Error(`active ordinary registration '${name}' is absent`);
  }
  return registration;
}

/** Every executable registered playbook. Model visibility alone still grants no authority. */
export const PLAYBOOK_REGISTRY: PlaybookRegistry = new Map([
  ["assess", activeOrdinaryRegistration("assess")],
  ["decide", activeOrdinaryRegistration("decide")],
  ["define", activeOrdinaryRegistration("define")],
  ["diagnose", activeOrdinaryRegistration("diagnose")],
  // Hidden, model-invisible, explicitly invocable. It carries no generic-child authority, and
  // every new start still passes the host-owned activation gate before any effect.
  [IMAGEGEN_PLAYBOOK_REGISTRATION.name, IMAGEGEN_PLAYBOOK_REGISTRATION],
  [KNOWLEDGE_BASE_REGISTRATION.name, KNOWLEDGE_BASE_REGISTRATION],
  ["plan", activeOrdinaryRegistration("plan")],
  ["produce", activeOrdinaryRegistration("produce")],
  [DEFAULT_PLAYBOOK_NAME, activeOrdinaryRegistration(DEFAULT_PLAYBOOK_NAME)],
  [SCA_PLAYBOOK_REGISTRATION.name, SCA_PLAYBOOK_REGISTRATION],
  [VIDEOGEN_PLAYBOOK_REGISTRATION.name, VIDEOGEN_PLAYBOOK_REGISTRATION],
]);

export function skillContractSha256(contractValue: SkillContract): string {
  const contract = validateContract(SkillContractSchema, contractValue, "skill contract digest");
  return sha256(canonicalJson(contract));
}

export { runtimeRegistrationSha256 } from "./runtime-registration-digest.js";

/** Registered names, sorted, for diagnostics and tests. */
export function registeredPlaybookNames(registry: PlaybookRegistry = PLAYBOOK_REGISTRY): string[] {
  return [...registry.keys()].sort();
}

export function isRegisteredPlaybook(
  name: string,
  registry: PlaybookRegistry = PLAYBOOK_REGISTRY
): boolean {
  return registry.has(name);
}

function validateGenericChildParentPolicy(
  registrationName: string,
  policy: GenericChildParentPolicyV1 | GenericChildParentPolicyV2
): void {
  const legacy = policy.schema_version === 1;
  if (
    policy.authorization_id !==
      (legacy ? "operator.generic-child.universal-v1" : "operator.generic-child.universal-v2") ||
    policy.request_envelope.schema_id !== "penny.child-workflow-request.v1" ||
    policy.request_envelope.schema_version !== 1 ||
    policy.max_nesting_depth !== 1 ||
    policy.max_active_children !== 1 ||
    policy.max_calls !== 1 ||
    policy.project_concurrency_limit !== 1
  ) {
    throw new Error(
      `generic child parent policy for '${registrationName}' is not the fixed depth-one policy`
    );
  }
  if (legacy) {
    validateContract(
      ChildWorkflowBudgetCeilingV1Schema,
      policy.aggregate_budget,
      `legacy generic child aggregate budget for '${registrationName}'`
    );
    validateContract(
      ChildWorkflowBudgetCeilingV1Schema,
      policy.parent_sealing_reserve,
      `legacy generic child parent reserve for '${registrationName}'`
    );
    if (
      canonicalJson(policy.aggregate_budget) !== canonicalJson(GENERIC_CHILD_AGGREGATE_BUDGET_V1) ||
      canonicalJson(policy.parent_sealing_reserve) !==
        canonicalJson(GENERIC_CHILD_PARENT_SEALING_RESERVE_V1)
    ) {
      throw new Error(
        `legacy generic child parent policy for '${registrationName}' changed its fixed replay budget`
      );
    }
  }
  const names = policy.targets.map((target) => target.child_name);
  if (
    canonicalJson(names) !== canonicalJson(GENERIC_CHILD_WORKFLOW_NAMES) ||
    new Set(names).size !== names.length
  ) {
    throw new Error(
      `generic child parent policy for '${registrationName}' must target exactly the seven ordinary workflows`
    );
  }
  for (const target of policy.targets) {
    const targetLegacy = target.schema_version === 1;
    if (targetLegacy !== legacy) {
      throw new Error(
        `generic child target '${registrationName}:${target.child_name}' changed policy generation`
      );
    }
    if (targetLegacy) {
      validateContract(
        ChildWorkflowBudgetAllocationV1Schema,
        target.budget,
        `legacy generic child target budget '${registrationName}:${target.child_name}'`
      );
    }
    validateContract(
      ChildWorkflowOutputContractV1Schema,
      target.expected_output,
      `generic child target output '${registrationName}:${target.child_name}'`
    );
    if (
      target.native_request.schema_id.trim().length === 0 ||
      !Number.isSafeInteger(target.native_request.schema_version) ||
      target.native_request.schema_version < 1 ||
      (targetLegacy &&
        canonicalJson(target.budget) !== canonicalJson(GENERIC_CHILD_TARGET_BUDGET_V1)) ||
      (!targetLegacy &&
        canonicalJson(target.progress_lease) !==
          canonicalJson(childExecutionProgressLeaseBinding()))
    ) {
      throw new Error(
        `generic child target '${registrationName}:${target.child_name}' has a non-fixed contract or lease`
      );
    }
  }
  const expectedPolicy = legacy ? LEGACY_GENERIC_CHILD_PARENT_POLICY : GENERIC_CHILD_PARENT_POLICY;
  if (canonicalJson(policy) !== canonicalJson(expectedPolicy)) {
    throw new Error(
      `generic child parent policy for '${registrationName}' diverges from the fixed all-seven projection`
    );
  }
}

function validateGenericChildAuthority(
  registration: PlaybookRegistration,
  catalogProjectRoot?: string
): void {
  const authority = registration.generic_child;
  if (authority === undefined) return;
  if (
    (authority.schema_version !== 1 && authority.schema_version !== 2) ||
    registration.ingress !== "skill" ||
    registration.start_admission === undefined ||
    registration.worker.kind !== "catalog-agent" ||
    !isGenericChildWorkflowName(registration.name)
  ) {
    throw new Error(
      `registration '${registration.name}' cannot declare ordinary generic child authority`
    );
  }
  const validator = genericChildValidator(registration.name);
  const expectedProvider = projectGenericChildProvider(registration, validator, catalogProjectRoot);
  validateGenericChildParentPolicy(registration.name, authority.parent_policy);
  const expectedPolicy =
    authority.schema_version === 1
      ? LEGACY_GENERIC_CHILD_PARENT_POLICY
      : GENERIC_CHILD_PARENT_POLICY;
  if (
    canonicalJson(authority) !==
    canonicalJson({
      schema_version: authority.schema_version,
      parent_policy: expectedPolicy,
      provider: expectedProvider,
    })
  ) {
    throw new Error(
      `generic child authority for '${registration.name}' diverges from its native fixed projection`
    );
  }
}

function targetMatchesProvider(
  target: GenericChildTargetV1 | GenericChildTargetV2,
  provider: GenericChildProviderDeclarationV1
): boolean {
  return (
    target.child_name === provider.provider_name &&
    target.native_request.schema_id === provider.native_request.port.schema_id &&
    target.native_request.schema_version === provider.native_request.port.schema_version_required &&
    canonicalJson(target.expected_output) === canonicalJson(provider.expected_output) &&
    (target.schema_version === 1
      ? canonicalJson(target.budget) === canonicalJson(GENERIC_CHILD_TARGET_BUDGET_V1)
      : canonicalJson(target.progress_lease) ===
        canonicalJson(childExecutionProgressLeaseBinding()))
  );
}

/**
 * Pure static authorization lookup. It grants no dispatch, model call, result acceptance, or
 * aggregate charging capability; unknown, dedicated, malformed, and declaration-absent entries deny.
 */
export function isGenericChildWorkflowEligible(
  parentName: string,
  childName: string,
  registry: PlaybookRegistry = PLAYBOOK_REGISTRY,
  catalogProjectRoot?: string
): boolean {
  const parent = registry.get(parentName);
  const child = registry.get(childName);
  if (
    (parent?.generic_child === undefined && parent?.information_child === undefined) ||
    child?.generic_child === undefined ||
    (!isGenericChildWorkflowName(parentName) && parentName !== "videogen") ||
    !isGenericChildWorkflowName(childName)
  ) {
    return false;
  }
  try {
    validateRegistrationContract(parent, catalogProjectRoot);
    validateRegistrationContract(child, catalogProjectRoot);
    const target = (
      parent.generic_child?.parent_policy ?? parent.information_child?.parent_policy
    )?.targets.find((candidate) => candidate.child_name === childName);
    return target !== undefined && targetMatchesProvider(target, child.generic_child.provider);
  } catch {
    return false;
  }
}

/** Validate one authorized envelope against the selected provider's exact native request parser. */
export function validateGenericChildProviderRequest(
  parentName: string,
  value: unknown,
  registry: PlaybookRegistry = PLAYBOOK_REGISTRY,
  catalogProjectRoot?: string
): JsonValue {
  const request = validateChildWorkflowRequest(value);
  if (
    !isGenericChildWorkflowEligible(parentName, request.child_name, registry, catalogProjectRoot)
  ) {
    throw new Error(
      `generic child request '${parentName}->${request.child_name}' is not statically authorized`
    );
  }
  const registration = registry.get(request.child_name);
  const provider = registration?.generic_child?.provider;
  if (provider === undefined) {
    throw new Error(`generic child provider '${request.child_name}' is absent`);
  }
  if (
    request.provider_request_schema_id !== provider.native_request.port.schema_id ||
    request.provider_request_schema_version !== provider.native_request.port.schema_version_required
  ) {
    throw new Error(
      `generic child provider '${request.child_name}' refuses a non-native request contract`
    );
  }
  const validator = genericChildValidator(request.child_name);
  if (provider.native_request.validator_id !== validator.validator_id) {
    throw new Error(`generic child provider '${request.child_name}' validator binding diverged`);
  }
  const nativeRequest = validateContract(
    JsonValueSchema,
    validator.validate(request.provider_request),
    `native generic child request for '${request.child_name}'`
  );
  if (canonicalJson(nativeRequest) !== canonicalJson(request.provider_request)) {
    throw new Error(
      `generic child provider '${request.child_name}' request parser changed canonical values`
    );
  }
  return nativeRequest;
}

/**
 * Registration-owned native request adapter for the internal child start path. The caller still
 * validates the canonical request artifact and exact input refs separately; this adapter only
 * reconstructs the ordinary provider ingress fields and contains no engine dispatch policy.
 */
export function genericChildStartParts(
  parentName: string,
  value: unknown,
  registry: PlaybookRegistry = PLAYBOOK_REGISTRY,
  catalogProjectRoot?: string
): {
  readonly child_name: string;
  readonly goal: string;
  readonly constraints: Record<string, JsonValue>;
} {
  const request = validateChildWorkflowRequest(value);
  const nativeRequest = validateGenericChildProviderRequest(
    parentName,
    request,
    registry,
    catalogProjectRoot
  );
  if (
    request.invocation_policy !== undefined &&
    request.child_name !== "define" &&
    request.child_name !== "plan"
  ) {
    throw new Error("generic child invocation policy is supported only by Define/Plan");
  }
  const adapter = genericChildValidator(request.child_name);
  const start = adapter.start(nativeRequest, request.invocation_policy);
  if (canonicalJson(adapter.validate(nativeRequest)) !== canonicalJson(nativeRequest)) {
    throw new Error(
      `generic child provider '${request.child_name}' start adapter changed native bytes`
    );
  }
  return { child_name: request.child_name, ...start };
}

/** Exact all-seven production projection check; Gate 2/live qualification remains intentionally absent. */
export function assertGenericChildAuthorityProjection(
  registry: PlaybookRegistry = PLAYBOOK_REGISTRY,
  catalogProjectRoot?: string
): void {
  const knowledgeBase = registry.get("knowledge-base");
  if (knowledgeBase?.generic_child !== undefined) {
    throw new Error("knowledge-base cannot enter generic child parent/provider authority");
  }
  for (const [name, registration] of registry) {
    if (registration.generic_child !== undefined && !isGenericChildWorkflowName(name)) {
      throw new Error(`unapproved generic child authority declaration '${name}'`);
    }
  }
  const registrations = GENERIC_CHILD_WORKFLOW_NAMES.map((name) => {
    const registration = registry.get(name);
    if (registration?.generic_child === undefined) {
      throw new Error(`ordinary registration '${name}' lacks explicit generic child authority`);
    }
    validateRegistrationContract(registration, catalogProjectRoot);
    return registration;
  });
  const providers = registrations.map((registration) => registration.generic_child?.provider);
  if (providers.some((provider) => provider === undefined)) {
    throw new Error("generic child provider projection is incomplete");
  }
  const completeProviders = providers.flatMap((provider) =>
    provider === undefined ? [] : [provider]
  );
  const expectedPolicy = buildGenericChildParentPolicy(completeProviders);
  for (const registration of registrations) {
    const authority = registration.generic_child;
    if (
      authority === undefined ||
      canonicalJson(authority.parent_policy) !== canonicalJson(expectedPolicy)
    ) {
      throw new Error(
        `generic child parent policy for '${registration.name}' diverges from the all-seven provider projection`
      );
    }
    for (const childName of GENERIC_CHILD_WORKFLOW_NAMES) {
      if (
        !isGenericChildWorkflowEligible(registration.name, childName, registry, catalogProjectRoot)
      ) {
        throw new Error(
          `generic child eligibility '${registration.name}->${childName}' is not exact`
        );
      }
    }
  }
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
  registry: PlaybookRegistry = PLAYBOOK_REGISTRY
): PlaybookRegistration | undefined {
  const registration = registry.get(name);
  if (registry === PLAYBOOK_REGISTRY) {
    assertGenericChildAuthorityProjection(registry);
    if (registration !== undefined) validateRegistrationContract(registration);
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
  registration: PlaybookRegistration,
  catalogProjectRoot?: string
): SkillContract {
  if (
    registration.contextual_inputs !== undefined &&
    (registration.contextual_inputs !== "accepted_terminal_products_v1" ||
      registration.ingress !== "skill")
  )
    throw new Error("invalid registration contextual-input policy");
  if (
    registration.repair_progress_policy !== undefined &&
    registration.repair_progress_policy !== "exact_fingerprint_v1"
  )
    throw new Error("invalid repair progress policy");
  if (registration.imagegen_child !== undefined)
    validateImagegenChildPolicy(registration.imagegen_child);
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
  const documentation = contract.guidance.documentation;
  if (documentation === undefined && worker.documentation_sources !== undefined) {
    throw new Error(`worker documentation sources are undeclared for '${registration.name}'`);
  }
  if (documentation !== undefined) {
    for (const declaration of documentation) {
      const normalized = path.posix.normalize(declaration);
      if (
        path.isAbsolute(declaration) ||
        declaration.includes("\\") ||
        !declaration.startsWith("docs/agents/") ||
        !declaration.endsWith(".md") ||
        normalized !== declaration ||
        normalized.includes("/../")
      ) {
        throw new Error(`worker documentation path '${declaration}' is invalid`);
      }
    }
    if (worker.documentation_sources !== undefined) {
      if (
        canonicalJson(worker.documentation_sources.map((source) => source.path)) !==
        canonicalJson(documentation)
      ) {
        throw new Error(`worker documentation projection diverges for '${registration.name}'`);
      }
      if (worker.documentation_sources.some((source) => !/^[a-f0-9]{64}$/u.test(source.sha256))) {
        throw new Error(`worker documentation digest is invalid for '${registration.name}'`);
      }
    }
    if (
      catalogProjectRoot !== undefined &&
      existsSync(path.join(catalogProjectRoot, "docs", "agents"))
    ) {
      const current = loadPromptDocumentation(catalogProjectRoot, documentation).map(
        (document) => document.source
      );
      if (
        worker.documentation_sources !== undefined &&
        canonicalJson(worker.documentation_sources) !== canonicalJson(current)
      ) {
        throw new Error(`worker documentation content drifted for '${registration.name}'`);
      }
    }
  }
  if (worker.prompt_sources !== undefined) {
    if (
      canonicalJson(worker.prompt_sources.map((source) => source.path)) !==
      canonicalJson(registrationPromptSourcePaths(registration))
    ) {
      throw new Error(`worker prompt-source projection diverges for '${registration.name}'`);
    }
    if (worker.prompt_sources.some((source) => !/^[a-f0-9]{64}$/u.test(source.sha256))) {
      throw new Error(`worker prompt-source digest is invalid for '${registration.name}'`);
    }
    if (catalogProjectRoot !== undefined && hasCompletePromptCatalog(catalogProjectRoot)) {
      const current = loadStaticPromptSourceBindings(
        catalogProjectRoot,
        registrationPromptSourcePaths(registration)
      );
      if (canonicalJson(worker.prompt_sources) !== canonicalJson(current)) {
        throw new Error(`worker prompt-source content drifted for '${registration.name}'`);
      }
    }
  }
  if (worker.kind === "none") {
    if (worker.phases.size !== 0) {
      throw new Error(
        `worker registration '${registration.name}' with kind 'none' must declare zero phases`
      );
    }
    if (
      worker.result_transport !== "host_typed" ||
      worker.opening_policy !== "none" ||
      worker.model_policy !== "none"
    ) {
      throw new Error(
        `worker registration '${registration.name}' has invalid deterministic worker policy`
      );
    }
  } else if (worker.phases.size === 0) {
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
      if (
        phase.routing_repair_policy !== undefined &&
        phase.routing_repair_policy !== "preserve_source_summary_v1"
      )
        throw new Error("invalid catalog routing repair policy");
      if (phase.result_projection !== undefined) {
        validatePhaseResultProjector({
          projector: phase.result_projection,
          registrationName: registration.name,
          stateId: state,
          agent: phase.agent,
          resultSchemaId: phase.result_schema_id,
          resultSchemaVersion: phase.result_schema_version,
        });
        if (phase.provider_opening_guard !== undefined || phase.directive_state_id !== undefined) {
          throw new Error("phase result projection cannot override guarded or aliased transport");
        }
      }
      // Structural validation belongs to the registration. PiAgentClient revalidates exact
      // YAML membership before session creation; provider load/activation is checked before prompt.
      if (phase.allowed_tools !== undefined) {
        if (
          phase.allowed_tools.some((tool) => !/^[a-z][a-z0-9_]*$/u.test(tool)) ||
          new Set(phase.allowed_tools).size !== phase.allowed_tools.length ||
          (phase.allowed_tools.length === 0 && phase.provider_opening_guard === undefined)
        ) {
          throw new Error(
            `catalog worker phase '${registration.name}:${state}' has an invalid exact tool subset`
          );
        }
      }
      const openingGuardMatchesRegistration =
        phase.provider_opening_guard === undefined ||
        (phase.provider_opening_guard === "sca_p04_payload_disclosure_v1" &&
          registration.name === "sca-p04-candidate") ||
        (phase.provider_opening_guard === "sca_p05_payload_disclosure_v1" &&
          registration.name === "sca-p05-candidate") ||
        (phase.provider_opening_guard === "sca_p06_payload_disclosure_v1" &&
          registration.name === "sca-p06-candidate") ||
        (phase.provider_opening_guard === "sca_p08_payload_disclosure_v1" &&
          registration.name === "sca-p08-candidate") ||
        (phase.provider_opening_guard === "sca_p10_payload_disclosure_v1" &&
          registration.name === "sca-p10-candidate") ||
        (phase.provider_opening_guard === "sca_p11_payload_disclosure_v1" &&
          registration.name === "sca-p11-candidate");
      if (
        phase.provider_opening_guard !== undefined &&
        (!openingGuardMatchesRegistration ||
          phase.allowed_tools?.length !== 0 ||
          phase.required_model === undefined)
      ) {
        throw new Error(
          `catalog worker phase '${registration.name}:${state}' has an invalid provider opening guard`
        );
      }
      if (phase.required_model !== undefined) {
        validateRequiredModelIdentity(
          phase.required_model,
          `catalog worker phase '${registration.name}:${state}' required model`
        );
      }
      if (phase.browser_network_allowlist !== undefined) {
        validateRegisteredBrowserNetworkAllowlist(
          phase.browser_network_allowlist,
          `catalog worker phase '${registration.name}:${state}' browser network allowlist`
        );
      }
    }
  } else if (worker.kind === "host-private") {
    if (registration.ingress !== "dedicated_tool") {
      throw new Error("host-private worker registrations require dedicated_tool ingress");
    }
    for (const [state, phase] of worker.phases) {
      if ("result_projection" in phase || "routing_repair_policy" in phase) {
        throw new Error("host-private phases cannot opt into catalog result policies");
      }
      if (state.trim().length === 0 || phase.agent.trim().length === 0) {
        throw new Error(`worker registration '${registration.name}' has an empty state or agent`);
      }
    }
  }
  validateGenericChildAuthority(registration, catalogProjectRoot);
  validateInformationChildAuthority(registration);
  if (registration.seal_policy !== undefined) {
    const policy = validateSealPolicy(registration.seal_policy);
    if (policy.skill !== registration.name) {
      throw new Error("registered seal policy skill does not match registration");
    }
    if (
      !registration.host_states?.includes(policy.seal_phase) ||
      !registration.worker.phases.has(policy.draft_phase)
    ) {
      throw new Error("registered seal policy phase is not part of the registration");
    }
  }
  if (registration.host_operations !== undefined) {
    validateHostOperationAuthority(registration.host_operations);
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
    if (!worker.phases.has(route.origin_state) && !hostStates.includes(route.origin_state)) {
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
 * Each entry is an explicit generic execution authorization and is deliberately a
 * separate edit from adding the registration itself.
 */
export const AUTHORIZED_PLAYBOOK_NAMES: readonly string[] = [
  "assess",
  "decide",
  "define",
  "diagnose",
  "imagegen",
  "knowledge-base",
  "plan",
  "produce",
  DEFAULT_PLAYBOOK_NAME,
  "sca",
  "videogen",
];

/**
 * Executable form of the current registration rule. Fails closed on both sides:
 * research must be present (it is the oracle every other gate leans on), and no
 * unauthorized name may ship (a registration is an authority grant, so an
 * accidental one is a hard error rather than a warning).
 */
export function assertExpectedRegistrations(registry: PlaybookRegistry = PLAYBOOK_REGISTRY): void {
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
    validateRegistrationContract(registration);
  }
  if (registry === PLAYBOOK_REGISTRY) assertGenericChildAuthorityProjection(registry);
}
