/** Advanced host states extend the ordinary machine; no parallel engine or state owner. */
import { ScaCandidateRuleSchema } from "./ordinary-contracts.js";
import { Type, type Static } from "typebox";
import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  validateDirective,
  type ArtifactRef,
  type Directive,
} from "../contracts.js";
import type { RunContext } from "../context.js";
import {
  hostOperationPolicyBinding,
  HostOperationResultV1Schema,
} from "../host-operations/contracts.js";
import { ScaRequestV1Schema } from "../skill-contracts/sca-request.js";
import { exactJson, selected, persistScaArtifact, sourceCorpus } from "./ordinary-artifacts.js";
import {
  ScaActionsSchema,
  ScaHypothesesSchema,
  ScaDispositionsSchema,
  ScaLearningSchema,
  ScaEvidenceSchema,
} from "./ordinary-contracts.js";
import {
  scaAdvancedBackend,
  scaAdvancedDeclaration,
  ScaAdvancedPrivateSchema,
} from "./ordinary-advanced-host.js";
import {
  OrdinaryApplicationExecutionPolicySchema,
  ScaAdvancedRequestSchema,
  ScaAdvancedResultSchema,
  ScaAdvancedSummarySchema,
  ScaApplicationBindingsSchema,
  ScaRulePromotionResultSchema,
  type ScaAdvancedStage,
  type ScaAdvancedResult,
} from "./ordinary-advanced-contracts.js";
const LedgerSchema = Type.Array(
  Type.Object(
    {
      request_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
      result: ScaAdvancedResultSchema,
      result_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
      private_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    },
    { additionalProperties: false }
  ),
  { maxItems: 128 }
);
type Ledger = Static<typeof LedgerSchema>;
const stageKind = (state: string) => `sca-${state.replaceAll("_", "-")}`;
export function scaAdvancedSummary(context: RunContext, store: ArtifactHostStore) {
  const ref = [...context.selectedArtifacts]
    .reverse()
    .find((x) => x.kind === "sca-advanced-summary");
  return ref === undefined
    ? { schema_version: 1 as const, operations: [] }
    : exactJson(store, ref, ScaAdvancedSummarySchema);
}
export function scaAdvancedStep(
  context: RunContext,
  store: ArtifactHostStore,
  stage: ScaAdvancedStage,
  captureOnly = false
): Directive | null {
  const save = (kind: string, value: unknown, upstream: readonly ArtifactRef[]) =>
    persistScaArtifact({
      context,
      store,
      runId: context.identity.run_id,
      phase: context.stateId,
      kind,
      schemaId: `penny.${kind}.v1`,
      content: canonicalJson(value),
      upstream,
    });
  const prior = [...context.selectedArtifacts]
    .reverse()
    .find((x) => x.kind === "sca-advanced-ledger");
  const ledger: Ledger = prior === undefined ? [] : exactJson(store, prior, LedgerSchema);
  const platform = [...context.selectedArtifacts]
    .reverse()
    .find((x) => x.phase === context.stateId && x.kind === "host-operation-result");
  if ((context.pendingDirective === null || captureOnly) && platform !== undefined) {
    const settled = exactJson(store, platform, HostOperationResultV1Schema);
    if (!ledger.some((x) => x.result.request_sha256 === settled.request_sha256)) {
      const wrapper = exactJson(
        store,
        selected(context, `sca-${stage}-request`),
        ScaAdvancedRequestSchema
      );
      if (selected(context, `sca-${stage}-request`).content_digest !== settled.request_sha256)
        throw new Error("Advanced consumed request drift");
      const result =
        settled.operation_result_ref === null
          ? validateContract(
              ScaAdvancedResultSchema,
              {
                schema_version: 1,
                stage,
                selection_id: wrapper.selection_id,
                action_id: wrapper.action_id,
                hypothesis_id: wrapper.hypothesis_id,
                request_sha256: settled.request_sha256,
                status: "incomplete",
                execution:
                  settled.disposition.remote_disposition === "proven_not_accepted" ||
                  settled.disposition.remote_disposition === "none"
                    ? "NOT RUN"
                    : "UNKNOWN",
                passed: null,
                exit_code: null,
                cleanup:
                  settled.disposition.lease_disposition === "quarantined"
                    ? "unproved"
                    : "not_needed",
                quarantine_required: settled.disposition.lease_disposition === "quarantined",
                result_sha256: sha256(canonicalJson(settled)),
                validation_sha256: null,
                release_sha256: null,
                findings_count: 0,
                baseline_unchanged: true,
              },
              "Failed advanced operation"
            )
          : validateContract(
              ScaAdvancedResultSchema,
              exactJson(store, settled.operation_result_ref, ScaAdvancedPrivateSchema).projection,
              "Owner-journaled advanced projection"
            );
      if (
        result.request_sha256 !== settled.request_sha256 ||
        result.stage !== stage ||
        result.action_id !== wrapper.action_id ||
        result.selection_id !== wrapper.selection_id
      )
        throw new Error("Advanced result substitution");
      ledger.push({
        request_ref: selected(context, `sca-${stage}-request`),
        result,
        // Public evidence cites only this independently validated projection. The raw envelope
        // remains owner-journaled under its unique per-item operation address.
        result_ref:
          settled.operation_result_ref === null
            ? null
            : save(`sca-${stage}-result`, result, [settled.operation_result_ref]),
        private_ref: settled.operation_result_ref,
      });
      save("sca-advanced-ledger", validateContract(LedgerSchema, ledger, "Advanced ledger"), [
        ...(prior === undefined ? [] : [prior]),
        platform,
      ]);
      save(
        "sca-advanced-summary",
        { schema_version: 1, operations: ledger.map((x) => x.result) },
        ledger.flatMap((x) => (x.result_ref === null ? [] : [x.result_ref]))
      );
    }
  }
  if (captureOnly) return null;
  const callerRef = selected(context, "sca-request"),
    corpusRef = selected(context, "sca-source-corpus");
  const caller = exactJson(store, callerRef, ScaRequestV1Schema);
  const corpus = sourceCorpus(store, context);
  const refs: { slot: string; ref: ArtifactRef }[] = [
    { slot: "caller", ref: callerRef },
    { slot: "corpus", ref: corpusRef },
  ];
  let selectionId: string, actionId: string, hypothesisId: string, native: unknown;
  const processed = (id: string) =>
    ledger.some((x) => x.result.stage === stage && x.result.action_id === id);
  if (stage === "application") {
    const actions = exactJson(
      store,
      selected(context, stageKind("selecting_evidence_actions")),
      ScaActionsSchema
    );
    const action = actions.actions.find(
      (x) =>
        x.kind === "application_test" && x.application_plan_id !== undefined && !processed(x.id)
    );
    if (action === undefined) return null;
    const bindingsRef = selected(context, "sca-application-bindings"),
      bindings = exactJson(store, bindingsRef, ScaApplicationBindingsSchema);
    const binding = bindings.find((x) => x.id === action.application_plan_id);
    if (binding === undefined || caller.execution_mode === "static_only")
      throw new Error("Application plan not caller admitted");
    const policy = exactJson(store, binding.policy_ref, OrdinaryApplicationExecutionPolicySchema);
    selectionId = binding.id;
    actionId = action.id;
    hypothesisId = action.hypothesis_id;
    refs.push({ slot: "application_bindings", ref: bindingsRef });
    for (const ref of [...binding.closure, binding.plan_ref, binding.policy_ref])
      if (!refs.some((x) => x.ref.artifact_id === ref.artifact_id))
        refs.push({ slot: `operand-${refs.length}`, ref });
    native = {
      schema_id: "penny.sca-ordinary-application-request.v1",
      schema_version: 1,
      project_id: policy.project_id,
      run_id: context.identity.run_id,
      action_id: action.id,
      source_snapshot_sha256: corpus.source_snapshot_sha256,
      execution_plan_ref: binding.plan_ref,
      policy_ref: binding.policy_ref,
    };
  } else {
    const assessmentRef = selected(context, stageKind("assessing_learning"));
    const assessment = exactJson(store, assessmentRef, ScaLearningSchema);
    const outcome = assessment.outcomes.find(
      (x) => x.validation_id !== undefined && !processed(`${stage}-${x.hypothesis_id}`)
    );
    if (outcome === undefined) return null;
    const chosen = caller.advanced?.learning.find((x) => x.id === outcome.validation_id);
    if (chosen === undefined) throw new Error("Learning corpus is not caller admitted");
    selectionId = chosen.id;
    hypothesisId = outcome.hypothesis_id;
    actionId = `${stage}-${hypothesisId}`;
    const reconciliationRef = selected(context, "sca-reconciliation"),
      hypothesesRef = selected(context, stageKind("forming_hypotheses")),
      evidenceRef = selected(context, "sca-validated-evidence");
    refs.push(
      { slot: "reconciliation", ref: reconciliationRef },
      { slot: "hypotheses", ref: hypothesesRef },
      { slot: "evidence", ref: evidenceRef },
      { slot: "assessment", ref: assessmentRef }
    );
    const reconciled = exactJson(store, reconciliationRef, ScaDispositionsSchema),
      hypotheses = exactJson(store, hypothesesRef, ScaHypothesesSchema);
    const disposition = reconciled.dispositions.find((x) => x.hypothesis_id === hypothesisId),
      hypothesis = hypotheses.hypotheses.find((x) => x.id === hypothesisId);
    if (disposition?.disposition !== "confirmed_code" || hypothesis === undefined)
      throw new Error("Learning requires reconciled confirmed own finding");
    const validated = ledger.find(
      (x) =>
        x.result.stage === "validation" &&
        x.result.selection_id === selectionId &&
        x.result.hypothesis_id === hypothesisId
    );
    if (stage !== "validation" && validated?.request_ref != null) {
      const original = exactJson(store, validated.request_ref, ScaAdvancedRequestSchema);
      if (
        original.stage !== "validation" ||
        original.run_id !== context.identity.run_id ||
        original.selection_id !== selectionId ||
        original.hypothesis_id !== hypothesisId ||
        original.input_sha256 !== sha256(canonicalJson(original.input_bindings))
      )
        throw new Error("Retained validation input binding drift");
      // Replay only the original owner-captured context, never a later selected revision.
      for (const operand of original.input_bindings) {
        const current = refs.findIndex((x) => x.slot === operand.slot);
        if (current < 0) refs.push(operand);
        else refs[current] = operand;
      }
      refs.push({ slot: "validation_request", ref: validated.request_ref });
    }
    if (stage === "validation") {
      const proposal: unknown =
        outcome.proposed_rule === null
          ? null
          : validateContract(
              ScaCandidateRuleSchema,
              JSON.parse(outcome.proposed_rule),
              "Inert learning candidate"
            );
      const bytes = canonicalJson(proposal);
      const candidate =
        proposal === null
          ? null
          : save(`sca-candidate-${sha256(bytes).slice(0, 24)}`, proposal, [assessmentRef]);
      if (candidate !== null) refs.push({ slot: "candidate", ref: candidate });
      native = {
        schema_version: 1,
        run_id: context.identity.run_id,
        source_snapshot_sha256: corpus.source_snapshot_sha256,
        source_corpus_sha256: corpusRef.content_digest,
        reconciliation_sha256: reconciliationRef.content_digest,
        hypothesis_sha256: sha256(canonicalJson(hypothesis)),
        disposition_sha256: sha256(canonicalJson(disposition)),
        evidence_sha256: evidenceRef.content_digest,
        hypothesis_id: hypothesisId,
        root_cause: hypothesis.violated_invariant,
        evidence_pointers: disposition.evidence,
        baseline: chosen.baseline,
        tool: chosen.tool,
        candidate:
          candidate === null
            ? null
            : {
                rule_id: chosen.rule_id,
                language: chosen.language,
                rules_path: "owner-captured-candidate",
                rules_sha256: candidate.content_digest,
              },
        no_rule_reason: candidate === null ? outcome.reason : null,
        ...(chosen.offline_validation === undefined
          ? {}
          : { offline_validation: chosen.offline_validation }),
        fixtures: chosen.fixtures,
        fixture_truth_sha256: chosen.fixture_truth_sha256,
        limits: chosen.limits,
      };
    } else if (stage === "promotion") {
      const grant = caller.advanced?.promotions.find((x) => x.validation_id === selectionId);
      if (
        grant === undefined ||
        validated?.private_ref === null ||
        validated?.private_ref === undefined ||
        validated.result.validation_sha256 === null
      ) {
        // No grant means no operation at all, not an invented caller consent.
        return skipLearning(
          context,
          store,
          stage,
          ledger,
          selectionId,
          actionId,
          hypothesisId,
          grant === undefined ? "not_requested" : "denied"
        );
      }
      refs.push({ slot: "validation", ref: validated.private_ref });
      native = {
        schema_version: 1,
        run_id: context.identity.run_id,
        validation_sha256: validated.result.validation_sha256,
        namespace: grant.namespace,
        predecessor_release_sha256: grant.predecessor_release_sha256,
        successor_revision: grant.successor_revision,
        authority: {
          decision: "allow",
          authority_sha256: grant.authority_sha256,
          explicit_caller_authority: true,
        },
      };
    } else {
      const grant = caller.advanced?.rescans.find((x) => x.validation_id === selectionId),
        promoted = ledger.find(
          (x) =>
            x.result.stage === "promotion" &&
            x.result.selection_id === selectionId &&
            x.result.hypothesis_id === hypothesisId
        );
      if (
        grant === undefined ||
        promoted?.private_ref === null ||
        promoted?.private_ref === undefined ||
        !["promoted", "adopted"].includes(promoted.result.status)
      )
        return skipLearning(
          context,
          store,
          stage,
          ledger,
          selectionId,
          actionId,
          hypothesisId,
          grant === undefined ? "not_requested" : "denied"
        );
      const promotion = exactJson(store, promoted.private_ref, ScaAdvancedPrivateSchema);
      const released = validateContract(
        ScaRulePromotionResultSchema,
        promotion.native,
        "Own promotion receipt"
      );
      if (validated?.private_ref == null || validated.request_ref === null)
        throw new Error("Rescan original validation closure absent");
      refs.push(
        { slot: "promotion", ref: promoted.private_ref },
        { slot: "validation", ref: validated.private_ref }
      );
      native = {
        schema_version: 1,
        run_id: context.identity.run_id,
        release_path: released.release_path,
        release_sha256: released.release_sha256,
        source_snapshot_sha256: grant.source_snapshot_sha256,
        source_corpus_sha256: corpusRef.content_digest,
        retained_baseline_sha256: chosen.baseline.release_sha256,
        predecessor_investigation_sha256: reconciliationRef.content_digest,
        rescan_revision: grant.rescan_revision,
        authority: {
          decision: "allow",
          authority_sha256: grant.authority_sha256,
          explicit_caller_authority: true,
        },
        limits: chosen.limits,
      };
    }
  }
  const wrapper = validateContract(
    ScaAdvancedRequestSchema,
    {
      schema_version: 1,
      stage,
      run_id: context.identity.run_id,
      selection_id: selectionId,
      action_id: actionId,
      hypothesis_id: hypothesisId,
      input_bindings: refs,
      input_sha256: sha256(canonicalJson(refs)),
      native_request: native,
    },
    "Advanced exact request"
  );
  const declaration = scaAdvancedDeclaration(stage);
  const requestRef = persistScaArtifact({
    context,
    store,
    runId: context.identity.run_id,
    phase: context.stateId,
    kind: declaration.request.artifact_kind,
    schemaId: declaration.request.schema_id,
    content: canonicalJson(wrapper),
    upstream: [...new Map(refs.map((x) => [x.ref.artifact_id, x.ref])).values()],
  });
  const registration = context.registrationContractBinding?.registration_sha256;
  if (registration === undefined) throw new Error("Advanced registration missing");
  const directive = validateDirective({
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity: context.identity,
    state_id: context.stateId,
    attempt: context.stepCount,
    operation_id: `sca-${stage}-${sha256(actionId).slice(0, 24)}`,
    operation_kind: declaration.operation_kind,
    registration_sha256: registration,
    request_ref: requestRef,
    request_sha256: requestRef.content_digest,
    input_artifacts: { schema_version: 2, artifacts: refs },
    expected_result: declaration.result,
    policy_binding: hostOperationPolicyBinding(declaration, scaAdvancedBackend(stage)),
  });
  context.pendingDirective = directive;
  context.status = "running";
  return directive;
}
function skipLearning(
  context: RunContext,
  store: ArtifactHostStore,
  stage: ScaAdvancedStage,
  ledger: Ledger,
  selection: string,
  action: string,
  hypothesis: string,
  status: "not_requested" | "denied"
): Directive | null {
  // Only a summary of absent/denied authority, never an execution or publication operation.
  const result: ScaAdvancedResult = {
    schema_version: 1,
    stage,
    selection_id: selection,
    action_id: action,
    hypothesis_id: hypothesis,
    request_sha256: sha256(
      canonicalJson({ stage, selection, action, hypothesis, run: context.identity.run_id })
    ),
    status,
    execution: "NOT RUN",
    passed: null,
    exit_code: null,
    cleanup: "not_needed",
    quarantine_required: false,
    result_sha256: sha256("separate_caller_authority_or_successful_predecessor_missing"),
    validation_sha256: null,
    release_sha256: null,
    findings_count: 0,
    baseline_unchanged: true,
  };
  ledger.push({ request_ref: null, result, result_ref: null, private_ref: null });
  for (const [kind, value] of [
    ["sca-advanced-ledger", ledger],
    ["sca-advanced-summary", { schema_version: 1, operations: ledger.map((x) => x.result) }],
  ] as const)
    persistScaArtifact({
      context,
      store,
      runId: context.identity.run_id,
      phase: context.stateId,
      kind,
      schemaId: `penny.${kind}.v1`,
      content: canonicalJson(value),
      upstream: [],
    });
  return scaAdvancedStep(context, store, stage);
}
/** Merge only host-owned application projections; private streams never enter cognition. */
export function mergeScaApplicationEvidence(
  context: RunContext,
  store: ArtifactHostStore
): ArtifactRef {
  const source = selected(context, "sca-evidence-result"),
    evidence = exactJson(store, source, ScaEvidenceSchema);
  const actions = exactJson(
    store,
    selected(context, stageKind("selecting_evidence_actions")),
    ScaActionsSchema
  );
  const ledgerRefs = context.selectedArtifacts.filter((x) => x.kind === "sca-advanced-ledger");
  const ledgerRef = ledgerRefs.at(-1);
  const ledger = ledgerRef === undefined ? [] : exactJson(store, ledgerRef, LedgerSchema);
  for (const action of actions.actions.filter((x) => x.kind === "application_test")) {
    const owned = ledger.find(
      (x) => x.result.stage === "application" && x.result.action_id === action.id
    );
    if (owned === undefined) continue;
    const value = owned.result;
    const completed = value.status === "completed";
    const observation = canonicalJson(value);
    const corpus = sourceCorpus(store, context);
    const pointers = completed
      ? action.ranges.map((range) => {
          const file = corpus.files.get(range.path);
          if (file === undefined) throw new Error("Application source absent");
          return {
            ...range,
            exact_quote: file.text
              .split(/\r?\n/u)
              .slice(range.start_line - 1, range.end_line)
              .join("\n"),
          };
        })
      : [];
    const entry = {
      action_id: action.id,
      hypothesis_id: action.hypothesis_id,
      status: completed ? ("completed" as const) : ("failed" as const),
      detail: `${value.isolation ?? "Unestablished-isolation"} application observation: ${value.status}; execution ${value.execution}; not a vulnerability or isolation attestation.`,
      pointers,
      observation,
      evidence_sha256: sha256(observation),
      execution: value.execution,
      receipt_refs: owned.result_ref === null ? [] : [owned.result_ref],
    };
    const index = evidence.results.findIndex((x) => x.action_id === action.id);
    if (index < 0) evidence.results.push(entry);
    else evidence.results[index] = entry;
  }
  return persistScaArtifact({
    context,
    store,
    runId: context.identity.run_id,
    phase: "running_application_tests",
    kind: "sca-evidence-result",
    schemaId: "penny.sca-evidence-result.v1",
    content: canonicalJson(
      validateContract(ScaEvidenceSchema, evidence, "Application evidence projection")
    ),
    upstream: [source, ...ledgerRefs],
  });
}
