/**
 * KB worker client — the engine bridge for the exact §§5.7–5.8 child boundary.
 *
 * Production children never return artifact bodies to this client. They stage
 * one validated/JCS artifact through `stage_run_artifact`, then return exactly
 * one body-free typed `submit_phase_result`. The engine receipt chain receives
 * only that metadata; private bytes exist only in RunArtifactStore.
 *
 * Deterministic tests use `createTestOnlyArtifactBodyRunner` explicitly. There
 * is no production fallback that interprets assistant text as an artifact.
 */

import { strictParseJson } from "./approval-receipts.js";
import { sourcesFromAdmissions } from "./gate.js";
import { CapabilityStore } from "./capabilities.js";
import { readManifest, readPageRevision, readPolicy } from "./filesystem.js";
import { KbModelClient, type KbAgentRunner } from "./kb-model-client.js";
import { checkChildModelIdentity } from "./policy.js";
import { createPromotionReader } from "./promotion-reader.js";
import { KbQueryReader } from "./query-reader.js";
import { assessQueryVerification } from "./query-verification.js";
import {
  RunArtifactStore,
  type ArtifactHandle,
  type StageRunArtifactInput,
} from "./run-artifacts.js";
import { findSaveClaim } from "./save-claim.js";
import { createSaveEvidenceReader } from "./save-evidence-reader.js";
import {
  canonicalJson,
  sha256Hex,
  validateKbContract,
  ClaimsArtifactSchema,
  KbArtifactHandleSchema,
  KbPhaseBriefSchema,
  QueryAnswerArtifactSchema,
  ReadPhaseBriefResultSchema,
  QueryVerificationReportSchema,
  type ArtifactKind,
  type KbComposeAuthority,
  type QueryAnswerArtifact,
} from "./contracts.js";
import { validatePhaseResult, type KbPhaseInvocation, type KbPhaseState } from "./session-tools.js";
import { recheckAdmittedPolicy } from "./workflows.js";
import { readSelectedGeneration } from "./generations.js";
import {
  allocateComposeAuthority,
  claimCandidateBodies,
  validatePageDraftAuthority,
  type ComposePageCandidate,
} from "./composition-authority.js";
import { type Checkpointer, type KbPhaseOperands } from "../checkpointer.js";
import type { Confidence, JsonValue } from "../contracts.js";
import type { RunContext } from "../context.js";
import type {
  AgentCompletion,
  AgentInvocation,
  AgentSessionTraceSink,
  ModelClient,
  SessionThinkingLevel,
} from "../model-client.js";
import { readRunInput } from "../private-inputs.js";

const PRIOR_PHASES: Readonly<Record<KbPhaseState, readonly KbPhaseState[]>> = {
  ingest: [],
  compose: ["ingest"],
  query: [],
  lint: ["compose"],
  verify: ["compose"],
  plan: [],
  patch: ["plan"],
};

const PHASE_CONTRACT: Readonly<
  Record<
    KbPhaseState,
    { agent: KbPhaseOperands["agent"]; artifactKind: ArtifactKind; artifactField: string }
  >
> = {
  ingest: { agent: "echo", artifactKind: "claims", artifactField: "claims_artifact" },
  compose: {
    agent: "synthia",
    artifactKind: "page_draft",
    artifactField: "page_revision_artifact",
  },
  query: { agent: "synthia", artifactKind: "query_answer", artifactField: "answer_artifact" },
  lint: { agent: "carren", artifactKind: "lint_report", artifactField: "report_artifact" },
  verify: {
    agent: "vera",
    artifactKind: "verification_report",
    artifactField: "report_artifact",
  },
  plan: { agent: "piper", artifactKind: "promotion_plan", artifactField: "plan_artifact" },
  patch: {
    agent: "skribble",
    artifactKind: "promotion_patch",
    artifactField: "patch_artifact",
  },
};

function isKbPhaseState(value: string): value is KbPhaseState {
  return ["ingest", "compose", "query", "lint", "verify", "plan", "patch"].includes(value);
}

function phaseState(value: string): KbPhaseState {
  if (isKbPhaseState(value)) return value;
  throw new Error(`KbWorkerClient cannot serve KB phase '${value}'`);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) throw new Error(code);
  return value;
}

function stringArray(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
    throw new Error(code);
  }
  return value;
}

function recordArrayOrEmpty(value: unknown, code: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: unknown) => object(item, code));
}

function phaseArtifact(
  result: Readonly<Record<string, unknown>>,
  contract: (typeof PHASE_CONTRACT)[KbPhaseState]
): ArtifactHandle {
  return validateKbContract(
    KbArtifactHandleSchema,
    result[contract.artifactField],
    "KB phase result artifact handle"
  );
}

function phaseConfidence(value: unknown): Confidence {
  if (
    value === "CERTAIN" ||
    value === "PROBABLE" ||
    value === "POSSIBLE" ||
    value === "UNCERTAIN"
  ) {
    return value;
  }
  throw new Error("kb_phase_result_confidence_invalid");
}

function selectedPageRefsFrom(
  value: unknown,
  field: "candidates" | "page_revisions"
): Array<{ page_id: string; revision_id: string }> {
  const record = object(value, "kb_selected_page_projection_invalid");
  const candidates = record[field];
  if (candidates === undefined) return [];
  if (!Array.isArray(candidates)) throw new KbWorkerPostureError();
  return candidates.flatMap((candidate: unknown) => {
    if (!isUnknownRecord(candidate)) throw new KbWorkerPostureError();
    return typeof candidate.page_id === "string" && typeof candidate.revision_id === "string"
      ? [{ page_id: candidate.page_id, revision_id: candidate.revision_id }]
      : [];
  });
}

export interface KbWorkerClientOptions {
  readonly projectRoot: string;
  /** The exact orchestration control DB that owns this durable run. */
  readonly checkpointer?: Checkpointer;
  readonly kbRoot: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly operation: "ingest" | "query" | "save" | "promote";
  readonly sourceIds?: readonly string[];
  /** @deprecated Source capabilities are public inputs, never child source identities. */
  readonly sourceCapabilityIds?: readonly string[];
  /** TEST-ONLY exact model override. Production uses agent SSOT frontmatter. */
  readonly modelOverride?: string;
  /** TEST-ONLY thinking override. Production preserves Pi/settings defaults. */
  readonly testOnlyThinkingLevelOverride?: SessionThinkingLevel;
  /** Optional content-free lifecycle diagnostics from the shared Pi runner. */
  readonly sessionTrace?: AgentSessionTraceSink;
  readonly admittedPolicySha256?: string | (() => string);
  readonly seedPhaseOutputs?: Readonly<Record<string, { runId: string; artifactId: string }>>;
  /** Exact private phase brief (save uses this for title/page kind). */
  readonly readPhaseBrief?: () => string;
  readonly queryReader?: {
    readonly readRequest: () => string;
    readonly selectedPageRefs?: () => Array<{ page_id: string; revision_id: string }>;
    readonly searchSelectedKb: () => string;
    readonly readSelectedPage: (pageId: string, revisionId: string) => string;
    readonly readSelectedSource: (sourceId: string) => string;
  };
  readonly evidenceReader?: {
    readonly allowedSelectedPages?: () => Array<{ page_id: string; revision_id: string }>;
    readonly readSelectedPage: (pageId: string, revisionId: string) => string;
    readonly readSelectedSource: (sourceId: string) => string;
  };
  readonly promotionReader?: {
    readonly allowedSelectedPages?: () => Array<{ page_id: string; revision_id: string }>;
    readonly readPhaseBrief: () => string;
    readonly readSelectedPage: (pageId: string, revisionId: string) => string;
    readonly readCanonicalTarget: (capabilityId: string) => string;
  };
  /** TEST-ONLY. Must itself use the explicit test artifact-body adapter. */
  readonly testOnlyAgentRunner?: KbAgentRunner;
}

interface AllowedArtifact {
  readonly handle: ArtifactHandle;
  readonly runId: string;
  readonly stateId: string;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESUMABLE_PHASES = {
  ingest: new Set<KbPhaseState>(["ingest", "compose", "lint", "verify"]),
  query: new Set<KbPhaseState>(["query", "verify"]),
  save: new Set<KbPhaseState>(["compose", "lint", "verify"]),
  promote: new Set<KbPhaseState>(["plan", "patch"]),
} as const;

/** Bounded failure when durable state cannot reconstruct one exact worker posture. */
export class KbWorkerPostureError extends Error {
  readonly code = "resume_worker_posture_invalid";

  constructor() {
    super("the durable KB run does not define a valid resumable worker posture");
    this.name = "KbWorkerPostureError";
  }
}

function postureError(): never {
  throw new KbWorkerPostureError();
}

type KbStringMetadataKey = "profile_id" | "query_run_id" | "answer_artifact_id";
type KbStringListMetadataKey = "source_capability_ids" | "source_ids" | "target_capability_ids";

function metadataString(run: RunContext, key: KbStringMetadataKey): string {
  const value = run.knowledgeBaseData[key];
  return typeof value === "string" && OPAQUE_ID.test(value) ? value : postureError();
}

function metadataStringList(run: RunContext, key: KbStringListMetadataKey): string[] {
  const value = run.knowledgeBaseData[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !OPAQUE_ID.test(item))
  ) {
    return postureError();
  }
  if (new Set(value).size !== value.length) return postureError();
  return [...value];
}

function metadataPageRevisions(run: RunContext): Array<{ page_id: string; revision_id: string }> {
  const value = run.knowledgeBaseData.page_revisions;
  if (value === undefined || value.length === 0) return postureError();
  return value.map((item) => {
    if (!OPAQUE_ID.test(item.page_id) || !OPAQUE_ID.test(item.revision_id)) {
      return postureError();
    }
    return { page_id: item.page_id, revision_id: item.revision_id };
  });
}

function assertDurableActionBinding(
  run: RunContext,
  action: KbWorkerClientOptions["operation"],
  profileId: string
): void {
  if (
    run.identity.playbook !== "knowledge-base" ||
    run.status !== "running" ||
    run.terminalDirective !== null ||
    String(run.constraints.action ?? "") !== action ||
    String(run.constraints.kb_profile_id ?? "") !== profileId ||
    String(run.knowledgeBaseData.action ?? "") !== action
  ) {
    postureError();
  }
  const pending = run.pendingDirective;
  if (
    pending?.action !== "invoke_agent" ||
    pending.state_id !== run.stateId ||
    !RESUMABLE_PHASES[action].has(phaseState(pending.state_id))
  ) {
    postureError();
  }
}

export interface KbWorkerResumeInput {
  readonly projectRoot: string;
  readonly kbRoot: string;
  readonly checkpointer: Checkpointer;
  readonly run: RunContext;
  /** TEST-ONLY. Must itself use the explicit test artifact-body adapter. */
  readonly testOnlyAgentRunner?: KbAgentRunner;
}

/**
 * Reconstruct the one private-reader posture a durable running KB action owns.
 *
 * The caller must first revalidate the authenticated session/profile, KB
 * identity, and admitted policy. This function then derives every authority
 * input from the checkpoint and owner stores: never from a new public request.
 */
function isResumableOperation(value: string): value is KbWorkerClientOptions["operation"] {
  return Object.hasOwn(RESUMABLE_PHASES, value);
}

export function kbWorkerClientOptionsFromRun(input: KbWorkerResumeInput): KbWorkerClientOptions {
  const { run } = input;
  const action = String(run.knowledgeBaseData.action ?? "");
  if (!isResumableOperation(action)) return postureError();
  const profileId = metadataString(run, "profile_id");
  const admittedPolicySha256 = String(run.knowledgeBaseData.admitted_policy_sha256 ?? "");
  if (!/^[a-f0-9]{64}$/.test(admittedPolicySha256)) return postureError();
  assertDurableActionBinding(run, action, profileId);

  const base: KbWorkerClientOptions = {
    projectRoot: input.projectRoot,
    checkpointer: input.checkpointer,
    kbRoot: input.kbRoot,
    runId: run.identity.run_id,
    sessionId: run.identity.session_id,
    profileId,
    operation: action,
    sourceIds: [],
    admittedPolicySha256: () => {
      const current = input.checkpointer.loadRunById(run.identity.run_id);
      if (
        current === undefined ||
        current.identity.session_id !== run.identity.session_id ||
        String(current.knowledgeBaseData.profile_id ?? "") !== profileId ||
        String(current.knowledgeBaseData.action ?? "") !== action
      ) {
        return "";
      }
      return String(current.knowledgeBaseData.admitted_policy_sha256 ?? "");
    },
    ...(input.testOnlyAgentRunner ? { testOnlyAgentRunner: input.testOnlyAgentRunner } : {}),
  };

  if (action === "ingest") {
    const sourceCapabilityIds = metadataStringList(run, "source_capability_ids");
    const sourceIds = metadataStringList(run, "source_ids");
    if (
      canonicalJson(sourceCapabilityIds) !== canonicalJson(run.constraints.source_capability_ids)
    ) {
      return postureError();
    }
    return { ...base, sourceIds };
  }

  if (action === "query") {
    return {
      ...base,
      queryReader: new KbQueryReader({
        kbRoot: input.kbRoot,
        profileId,
        readRequest: () =>
          readRunInput({
            projectRoot: input.projectRoot,
            checkpointer: input.checkpointer,
            runId: run.identity.run_id,
          }),
        selectedGenerationId: () =>
          String(
            input.checkpointer.loadRunById(run.identity.run_id)?.knowledgeBaseData
              .selected_generation_id ?? ""
          ),
      }),
    };
  }

  if (action === "save") {
    const queryRunId = metadataString(run, "query_run_id");
    const answerArtifactId = metadataString(run, "answer_artifact_id");
    const claim = findSaveClaim(input.projectRoot, profileId, queryRunId);
    if (
      String(run.constraints.query_run_id ?? "") !== queryRunId ||
      claim?.state !== "claimed" ||
      claim.kb_profile_id !== profileId ||
      claim.save_run_id !== run.identity.run_id ||
      claim.answer_artifact_id !== answerArtifactId
    ) {
      return postureError();
    }
    let evidence: ReturnType<typeof createSaveEvidenceReader> | undefined;
    const requireEvidence = (): ReturnType<typeof createSaveEvidenceReader> => {
      evidence ??= createSaveEvidenceReader({
        kbRoot: input.kbRoot,
        queryRunId,
        answerArtifactId,
        checkpointer: input.checkpointer,
      });
      return evidence;
    };
    return {
      ...base,
      readPhaseBrief: () =>
        canonicalJson(
          readRunInput({
            projectRoot: input.projectRoot,
            checkpointer: input.checkpointer,
            runId: run.identity.run_id,
          })
        ),
      evidenceReader: {
        allowedSelectedPages: () => requireEvidence().allowedSelectedPages(),
        readSelectedPage: (pageId, revisionId) =>
          requireEvidence().readSelectedPage(pageId, revisionId),
        readSelectedSource: (sourceId) => requireEvidence().readSelectedSource(sourceId),
      },
      seedPhaseOutputs: {
        ingest: { runId: queryRunId, artifactId: answerArtifactId },
      },
    };
  }

  const pageRevisions = metadataPageRevisions(run);
  const targetCapabilityIds = metadataStringList(run, "target_capability_ids");
  if (
    canonicalJson(pageRevisions) !== canonicalJson(run.constraints.page_revisions) ||
    canonicalJson(targetCapabilityIds) !==
      canonicalJson(run.constraints.canonical_target_capability_ids)
  ) {
    return postureError();
  }
  return {
    ...base,
    promotionReader: createPromotionReader({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      runId: run.identity.run_id,
      sessionId: run.identity.session_id,
      profileId,
      operation: "promote",
      pageRevisions,
      targetCapabilityIds,
    }),
  };
}

/** Build the production worker bridge for one already-authorized recovery. */
export function createKbWorkerClientForResume(input: KbWorkerResumeInput): KbWorkerClient {
  return new KbWorkerClient(kbWorkerClientOptionsFromRun(input));
}

type KbWorkerControlState =
  | { readonly state: "unbound" }
  | {
      readonly state: "bound";
      readonly store: RunArtifactStore;
      readonly checkpointer: Checkpointer;
    };

export class KbWorkerClient implements ModelClient {
  private kbClient?: KbModelClient;
  private readonly runner: KbAgentRunner;
  private control: KbWorkerControlState = { state: "unbound" };

  private get store(): RunArtifactStore {
    if (this.control.state !== "bound") throw new KbWorkerPostureError();
    return this.control.store;
  }

  private get artifactCheckpointer(): Checkpointer {
    if (this.control.state !== "bound") throw new KbWorkerPostureError();
    return this.control.checkpointer;
  }

  constructor(private readonly options: KbWorkerClientOptions) {
    if (options.checkpointer !== undefined) this.bindCheckpointer(options.checkpointer);
    this.runner =
      options.testOnlyAgentRunner ??
      ((invocation: KbPhaseInvocation) => {
        if (this.kbClient === undefined) {
          this.kbClient = new KbModelClient({
            projectRoot: options.projectRoot,
            ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
            ...(options.testOnlyThinkingLevelOverride === undefined
              ? {}
              : {
                  testOnlyThinkingLevelOverride: options.testOnlyThinkingLevelOverride,
                }),
            ...(options.sessionTrace === undefined ? {} : { sessionTrace: options.sessionTrace }),
          });
        }
        return this.kbClient.run(invocation);
      });
  }

  /** Bind the worker to the service's exact control DB before dispatch. */
  bindCheckpointer(checkpointer: Checkpointer): void {
    if (this.control.state === "bound" && this.control.checkpointer === checkpointer) return;
    if (this.control.state === "bound") this.control.store.close();
    this.control = { state: "unbound" };
    const store = new RunArtifactStore(this.options.kbRoot, this.options.runId, checkpointer);
    this.control = { state: "bound", store, checkpointer };
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    if (this.control.state !== "bound") throw new KbWorkerPostureError();
    const phase = phaseState(invocation.stateId);
    const contract = PHASE_CONTRACT[phase];
    if (invocation.agent !== contract.agent) throw new Error("kb_phase_producer_mismatch");
    const durableResult = this.store.phaseResult(phase);
    if (durableResult !== undefined) {
      return this.completionFromResult(phase, contract, durableResult.result_jcs);
    }

    let admittedSourceIds = [...(this.options.sourceIds ?? [])];
    if (this.options.operation === "ingest" && admittedSourceIds.length === 0) {
      using capabilities = new CapabilityStore(this.options.projectRoot);
      admittedSourceIds = capabilities
        .admissionsForTransaction(this.options.runId, this.options.runId)
        .filter((record) => record.state === "admitted")
        .map((record) => record.source_id);
    }
    if (admittedSourceIds.length > 0 && this.options.operation !== "ingest") {
      throw new Error("only an ingest worker may receive admitted source ids");
    }
    const sources = sourcesFromAdmissions(
      this.options.projectRoot,
      this.options.kbRoot,
      admittedSourceIds,
      {
        runId: this.options.runId,
        transactionId: this.options.runId,
        sessionId: this.options.sessionId,
        profileId: this.options.profileId,
      }
    );
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    const currentSourceAllowlist = [...sourceById.keys()];

    const admittedSha = this.options.admittedPolicySha256;
    const admitModel =
      admittedSha === undefined
        ? undefined
        : (resolved: { provider: string; model: string }): void => {
            const resolvedSha = typeof admittedSha === "function" ? admittedSha() : admittedSha;
            if (resolvedSha.length === 0)
              throw new Error("the KB run has no admitted policy binding");
            const policy = recheckAdmittedPolicy({
              kbRoot: this.options.kbRoot,
              admittedPolicySha256: resolvedSha,
            });
            checkChildModelIdentity(policy, resolved);
          };

    const queryReader = this.options.queryReader;
    const evidenceReader = this.options.evidenceReader;
    const promotionReader = this.options.promotionReader;
    const isQueryPhase = queryReader !== undefined && (phase === "query" || phase === "verify");
    const isPromotionPhase =
      promotionReader !== undefined && (phase === "plan" || phase === "patch");
    const selectedPageReader = isQueryPhase
      ? queryReader?.readSelectedPage
      : isPromotionPhase
        ? promotionReader?.readSelectedPage
        : evidenceReader?.readSelectedPage;
    const selectedSourceReader =
      queryReader?.readSelectedSource ?? evidenceReader?.readSelectedSource;
    const priorStates =
      isQueryPhase && phase === "verify" ? (["query"] as const) : PRIOR_PHASES[phase];
    const phasePolicy = readPolicy(this.options.kbRoot);
    const resolvedAdmittedPolicySha256 =
      typeof admittedSha === "function"
        ? admittedSha()
        : (admittedSha ?? sha256Hex(canonicalJson(phasePolicy)));
    const currentAllowedArtifacts =
      this.store.phaseOperands(phase) === undefined ? this.allowedArtifacts(priorStates) : [];
    const operands = this.resolvePhaseOperands({
      phase,
      contract,
      sourceIds: currentSourceAllowlist,
      priorStates,
      allowedArtifacts: currentAllowedArtifacts,
      allowedSelectedPages: this.selectedPageOperands(phase, priorStates),
      privateInputSha256: this.verifiedPrivateInputSha256(),
      admittedPolicySha256: resolvedAdmittedPolicySha256,
    });
    const assertLiveOperands = (): void => this.assertPhaseOperandsCurrent(operands);
    const sourceAllowlist = [...operands.source_ids];
    const composeSelectedPages = new Map(
      (operands.compose_authority?.selected_pages ?? []).map((page) => [
        page.page_id,
        page.revision_id,
      ])
    );
    const allowedArtifacts: AllowedArtifact[] = operands.allowed_prior_artifacts.map((entry) => ({
      handle: entry.handle,
      runId: entry.run_id,
      stateId: entry.state_id,
    }));
    const allowedById = new Map(allowedArtifacts.map((entry) => [entry.handle.artifact_id, entry]));

    const phaseInvocation: KbPhaseInvocation = {
      agent: invocation.agent,
      stateId: phase,
      runId: this.options.runId,
      profileId: this.options.profileId,
      expectedArtifactKind: contract.artifactKind,
      readerLimits: phasePolicy.reader_limits,
      phaseBrief: invocation.task,
      readPhaseBrief: () => {
        assertLiveOperands();
        return this.phaseBrief(operands);
      },
      sourceAllowlist,
      priorPhaseAllowlist: priorStates,
      allowedPriorArtifacts: allowedArtifacts.map((entry) => entry.handle),
      ...(admitModel ? { admitModel } : {}),
      readSource: (sourceId: string): string => {
        assertLiveOperands();
        const source = sourceById.get(sourceId);
        if (source !== undefined) {
          return canonicalJson({
            schema_version: 1,
            source_id: source.sourceId,
            sha256: sha256Hex(source.content),
            media_type: source.mediaType,
            content_utf8: source.content,
          });
        }
        if (selectedSourceReader === undefined) {
          throw new Error("read_source_snapshot_not_allowed");
        }
        return selectedSourceReader(sourceId);
      },
      ...(selectedPageReader === undefined
        ? {}
        : {
            readSelectedPage: (pageId: string, revisionId: string): string => {
              assertLiveOperands();
              if (
                phase === "compose" &&
                operands.compose_authority !== undefined &&
                composeSelectedPages.get(pageId) !== revisionId
              ) {
                throw new Error("read_selected_page_not_in_compose_allocation");
              }
              return selectedPageReader(pageId, revisionId);
            },
          }),
      ...(isQueryPhase && queryReader !== undefined
        ? {
            searchSelectedKb: () => {
              assertLiveOperands();
              return queryReader.searchSelectedKb();
            },
          }
        : {}),
      ...(isPromotionPhase && promotionReader !== undefined
        ? {
            readCanonicalTarget: (capabilityId: string) => {
              assertLiveOperands();
              return promotionReader.readCanonicalTarget(capabilityId);
            },
          }
        : {}),
      ...(selectedSourceReader === undefined
        ? {}
        : {
            readSelectedSource: (sourceId: string) => {
              assertLiveOperands();
              const content = selectedSourceReader(sourceId);
              return canonicalJson({
                schema_version: 1,
                source_id: sourceId,
                sha256: sha256Hex(content),
                media_type: "text/plain",
                content_utf8: content,
              });
            },
          }),
      readRunArtifact: (artifactId: string): string => {
        assertLiveOperands();
        const allowed = allowedById.get(artifactId);
        if (allowed === undefined) throw new Error("read_run_artifact_not_allowed");
        const store =
          allowed.runId === this.options.runId
            ? this.store
            : new RunArtifactStore(this.options.kbRoot, allowed.runId, this.artifactCheckpointer);
        try {
          const read = store.read(artifactId, {
            expected_state_id: allowed.stateId,
            expected_handle: allowed.handle,
            required_lifecycle: "sealed",
          });
          const payload = strictParseJson(read.content);
          return canonicalJson({
            schema_version: 1,
            artifact: read.handle,
            payload,
          });
        } finally {
          if (store !== this.store) store.close();
        }
      },
      stageArtifact: (toolInput) => {
        assertLiveOperands();
        if (phase === "compose") this.validateComposeArtifact(toolInput, operands);
        const policy = readPolicy(this.options.kbRoot);
        return this.store.stageFromTool({
          state_id: phase,
          kb_profile_id: this.options.profileId,
          producer: invocation.agent,
          expected_producer: contract.agent,
          expected_kind: contract.artifactKind,
          expected_media_type: "application/json",
          max_bytes: policy.artifact_limits.max_artifact_utf8_bytes,
          max_artifacts: Math.min(policy.artifact_limits.max_artifacts_per_phase, 1),
          tool_input: toolInput,
        });
      },
      submitPhaseResult: (rawResult) => {
        assertLiveOperands();
        const result = validatePhaseResult(phaseInvocation, rawResult);
        if (phase === "compose") {
          const allocatedPageIds = (operands.compose_authority?.allocations ?? [])
            .map((allocation) => allocation.page_id)
            .sort();
          const resultPageIds = [
            ...stringArray(result["page_ids"], "submit_phase_result_compose_page_ids_invalid"),
          ].sort();
          if (canonicalJson(resultPageIds) !== canonicalJson(allocatedPageIds)) {
            throw new Error("submit_phase_result_compose_allocation_mismatch");
          }
        }
        const handle = phaseArtifact(result, contract);
        this.store.sealWithPhaseResult({
          state_id: phase,
          kb_profile_id: this.options.profileId,
          result,
          handles: [handle],
        });
        return canonicalJson(result);
      },
      // Legacy fields exist only for old deterministic workflow type continuity;
      // exact production sessions never register/read these tool names.
      readPhaseOutput: () => {
        throw new Error("read_phase_output_is_not_a_private_session_tool");
      },
    };

    const resultJcs = await this.runner(phaseInvocation);
    return this.completionFromResult(phase, contract, resultJcs, phaseInvocation);
  }

  private completionFromResult(
    phase: KbPhaseState,
    contract: (typeof PHASE_CONTRACT)[KbPhaseState],
    resultJcs: string,
    invocation?: KbPhaseInvocation
  ): AgentCompletion {
    let resultValue: unknown;
    try {
      resultValue = strictParseJson(resultJcs);
    } catch {
      throw new Error("kb_phase_result_invalid");
    }
    const validationInvocation =
      invocation ??
      ({
        agent: contract.agent,
        stateId: phase,
        runId: this.options.runId,
        phaseBrief: "",
        sourceAllowlist: [],
        priorPhaseAllowlist: [],
        readSource: () => {
          throw new Error("durable phase replay has no source reader");
        },
      } satisfies KbPhaseInvocation);
    const phaseResult = validatePhaseResult(validationInvocation, resultValue);
    if (
      phaseResult["run_id"] !== this.options.runId ||
      phaseResult["state_id"] !== phase ||
      phaseResult["agent"] !== contract.agent
    ) {
      throw new Error("kb_phase_result_binding_invalid");
    }
    const handle = phaseArtifact(phaseResult, contract);
    const artifact = this.store.read(handle.artifact_id, {
      expected_state_id: phase,
      expected_profile_id: this.options.profileId,
      expected_handle: handle,
      required_lifecycle: "sealed",
    });
    const payload = object(strictParseJson(artifact.content), "kb_artifact_payload_invalid");
    if (phase === "query") {
      validateKbContract(QueryAnswerArtifactSchema, payload, "query answer artifact");
    }
    if (this.options.queryReader !== undefined && phase === "verify") {
      validateKbContract(QueryVerificationReportSchema, payload, "query verification report");
    }
    return {
      text: resultJcs,
      confidence: phaseConfidence(phaseResult["confidence"]),
      details: {
        artifact_kind: contract.artifactKind,
        complete: true,
        kb_artifact_id: handle.artifact_id,
        ...this.phaseDetails(phase, payload),
      },
    };
  }

  private selectedPageOperands(
    _phase: KbPhaseState,
    priorStates: readonly KbPhaseState[]
  ): Array<{ page_id: string; revision_id: string }> {
    const inherited = priorStates
      .map((state) => this.store.phaseOperands(state))
      .find(
        (operands) => (operands?.allowed_selected_pages.length ?? 0) > 0
      )?.allowed_selected_pages;
    let pages: readonly { page_id: string; revision_id: string }[] = inherited ?? [];
    if (pages.length === 0 && this.options.queryReader !== undefined) {
      if (this.options.queryReader.selectedPageRefs !== undefined) {
        pages = this.options.queryReader.selectedPageRefs();
      } else {
        pages = selectedPageRefsFrom(
          strictParseJson(this.options.queryReader.searchSelectedKb()),
          "candidates"
        );
      }
    }
    if (pages.length === 0 && this.options.evidenceReader?.allowedSelectedPages !== undefined) {
      pages = this.options.evidenceReader.allowedSelectedPages();
    }
    if (pages.length === 0 && this.options.promotionReader !== undefined) {
      if (this.options.promotionReader.allowedSelectedPages !== undefined) {
        pages = this.options.promotionReader.allowedSelectedPages();
      } else {
        pages = selectedPageRefsFrom(
          strictParseJson(this.options.promotionReader.readPhaseBrief()),
          "page_revisions"
        );
      }
    }
    const exact = pages.map((page) => ({ page_id: page.page_id, revision_id: page.revision_id }));
    const keys = exact.map((page) => `${page.page_id}\u0000${page.revision_id}`);
    if (
      exact.length > 64 ||
      new Set(keys).size !== keys.length ||
      exact.some((page) => !OPAQUE_ID.test(page.page_id) || !OPAQUE_ID.test(page.revision_id))
    ) {
      throw new KbWorkerPostureError();
    }
    // Every phase freezes one deterministic order; inherited pages preserve the
    // exact prior phase order, while first-phase callbacks already expose their
    // host-selected order.
    return exact;
  }

  private resolvePhaseOperands(input: {
    phase: KbPhaseState;
    contract: (typeof PHASE_CONTRACT)[KbPhaseState];
    sourceIds: readonly string[];
    priorStates: readonly KbPhaseState[];
    allowedArtifacts: readonly AllowedArtifact[];
    allowedSelectedPages: readonly { page_id: string; revision_id: string }[];
    privateInputSha256: string;
    admittedPolicySha256: string;
  }): KbPhaseOperands {
    const existing = this.store.phaseOperands(input.phase);
    if (existing !== undefined) {
      if (
        existing.session_id !== this.options.sessionId ||
        existing.kb_profile_id !== this.options.profileId ||
        existing.operation !== this.options.operation ||
        existing.agent !== input.contract.agent ||
        existing.expected_artifact_kind !== input.contract.artifactKind ||
        existing.expected_media_type !== "application/json" ||
        existing.admitted_policy_sha256 !== input.admittedPolicySha256 ||
        canonicalJson(existing.source_ids) !== canonicalJson(input.sourceIds) ||
        canonicalJson(existing.prior_state_ids) !== canonicalJson(input.priorStates) ||
        canonicalJson(existing.allowed_selected_pages) !==
          canonicalJson(input.allowedSelectedPages) ||
        existing.private_input_sha256 !== input.privateInputSha256
      ) {
        throw new KbWorkerPostureError();
      }
      this.assertPhaseOperandsCurrent(existing);
      return existing;
    }
    const composeAuthority =
      input.phase === "compose"
        ? this.allocateComposeAuthority(
            input.allowedArtifacts,
            input.sourceIds,
            input.privateInputSha256
          )
        : undefined;
    const allowedSelectedPages = composeAuthority?.selected_pages.map((page) => ({
      page_id: page.page_id,
      revision_id: page.revision_id,
    })) ?? [...input.allowedSelectedPages];
    return this.store.bindPhaseOperands({
      schema_version: 1,
      run_id: this.options.runId,
      state_id: input.phase,
      session_id: this.options.sessionId,
      kb_profile_id: this.options.profileId,
      operation: this.options.operation,
      agent: input.contract.agent,
      expected_artifact_kind: input.contract.artifactKind,
      expected_media_type: "application/json",
      source_ids: [...input.sourceIds],
      prior_state_ids: [...input.priorStates],
      allowed_prior_artifacts: input.allowedArtifacts.map((entry) => ({
        run_id: entry.runId,
        state_id: entry.stateId,
        handle: entry.handle,
      })),
      allowed_selected_pages: allowedSelectedPages,
      private_input_sha256: input.privateInputSha256,
      admitted_policy_sha256: input.admittedPolicySha256,
      ...(composeAuthority === undefined ? {} : { compose_authority: composeAuthority }),
    });
  }

  private readAllowedArtifact(entry: AllowedArtifact): unknown {
    const store =
      entry.runId === this.options.runId
        ? this.store
        : new RunArtifactStore(this.options.kbRoot, entry.runId, this.artifactCheckpointer);
    try {
      return strictParseJson(
        store.read(entry.handle.artifact_id, {
          expected_state_id: entry.stateId,
          expected_handle: entry.handle,
          required_lifecycle: "sealed",
        }).content
      );
    } finally {
      if (store !== this.store) store.close();
    }
  }

  private verifiedPrivateInputSha256(): string {
    const record = this.artifactCheckpointer.getPrivateInput(this.options.runId);
    if (record === undefined || record.state !== "active") {
      throw new KbWorkerPostureError();
    }
    // The body is deliberately discarded here. Reading it verifies exact
    // owner-file custody and digest equality before allocation/reuse.
    readRunInput({
      projectRoot: this.options.projectRoot,
      checkpointer: this.artifactCheckpointer,
      runId: this.options.runId,
    });
    return record.request_sha256;
  }

  private selectedComposeBase() {
    const selected = readSelectedGeneration(this.options.kbRoot);
    const manifest = readManifest(this.options.kbRoot);
    if (selected === undefined || selected.catalog.kb_id !== manifest.kb_id) {
      throw new KbWorkerPostureError();
    }
    return { selected, manifest };
  }

  private saveEvidenceBounds(answer: QueryAnswerArtifact): {
    sourceIds: string[];
    selectedPages: Array<{
      page_id: string;
      revision_id: string;
      page_sha256: string;
      claims_sha256: string;
    }>;
  } {
    const { selected } = this.selectedComposeBase();
    const sourceIds = new Set<string>();
    const selectedPages = new Map<
      string,
      { page_id: string; revision_id: string; page_sha256: string; claims_sha256: string }
    >();
    for (const citation of answer.answer.citations) {
      if (citation.kind === "source") {
        if (selected.catalog.source_records[citation.source_id] === undefined) {
          throw new KbWorkerPostureError();
        }
        sourceIds.add(citation.source_id);
        continue;
      }
      const page = selected.catalog.pages[citation.page_id];
      if (page === undefined || page.revision_id !== citation.revision_id) {
        throw new KbWorkerPostureError();
      }
      selectedPages.set(citation.page_id, {
        page_id: citation.page_id,
        revision_id: page.revision_id,
        page_sha256: page.page_sha256,
        claims_sha256: page.claims_sha256,
      });
      const revision = readPageRevision(
        this.options.kbRoot,
        citation.page_id,
        citation.revision_id,
        { pageSha256: page.page_sha256, claimsSha256: page.claims_sha256 }
      );
      const claims =
        citation.kind === "claim"
          ? revision.claims.claims.filter((claim) => claim.claim_id === citation.claim_id)
          : revision.claims.claims;
      if (citation.kind === "claim" && claims.length !== 1) {
        throw new KbWorkerPostureError();
      }
      for (const claim of claims) {
        for (const evidence of claim.evidence) sourceIds.add(evidence.source_id);
      }
    }
    return {
      sourceIds: [...sourceIds].sort(),
      selectedPages: [...selectedPages.values()].sort((left, right) =>
        left.page_id.localeCompare(right.page_id)
      ),
    };
  }

  private allocateComposeAuthority(
    allowedArtifacts: readonly AllowedArtifact[],
    sourceIds: readonly string[],
    privateInputSha256: string
  ): KbComposeAuthority {
    if (
      allowedArtifacts.length !== 1 ||
      (this.options.operation !== "ingest" && this.options.operation !== "save")
    ) {
      throw new KbWorkerPostureError();
    }
    const prior = allowedArtifacts[0];
    if (prior === undefined) throw new KbWorkerPostureError();
    let candidate: ComposePageCandidate;
    let selectedPages: ReturnType<KbWorkerClient["saveEvidenceBounds"]>["selectedPages"] = [];
    if (this.options.operation === "ingest") {
      const claims = validateKbContract(
        ClaimsArtifactSchema,
        this.readAllowedArtifact(prior),
        "compose claims input"
      );
      const claimCandidateRefs = claims.claims.map((claim) => claim.provisional_id);
      if (
        new Set(claimCandidateRefs).size !== claimCandidateRefs.length ||
        canonicalJson([...claims.source_ids].sort()) !== canonicalJson([...sourceIds].sort())
      ) {
        throw new KbWorkerPostureError();
      }
      candidate = {
        candidate_ref: `cmp_${sha256Hex(
          canonicalJson({ run_id: this.options.runId, prior_artifact: prior.handle })
        ).slice(0, 32)}`,
        source_ids: [...sourceIds].sort(),
        claim_candidate_refs: claimCandidateRefs,
      };
    } else {
      const answer: QueryAnswerArtifact = validateKbContract(
        QueryAnswerArtifactSchema,
        this.readAllowedArtifact(prior),
        "compose query answer input"
      );
      const evidenceBounds = this.saveEvidenceBounds(answer);
      selectedPages = evidenceBounds.selectedPages;
      candidate = {
        candidate_ref: `cmp_${sha256Hex(
          canonicalJson({ run_id: this.options.runId, prior_artifact: prior.handle })
        ).slice(0, 32)}`,
        source_ids: evidenceBounds.sourceIds,
        claim_candidate_refs: [prior.handle.artifact_id],
      };
    }
    const { selected, manifest } = this.selectedComposeBase();
    return allocateComposeAuthority({
      runId: this.options.runId,
      operation: this.options.operation,
      kbId: manifest.kb_id,
      baseGenerationId: selected.selector.generation_id,
      baseCatalogSha256: selected.selector.catalog_sha256,
      privateInputSha256,
      baseCatalog: selected.catalog,
      selectedPages,
      candidates: [candidate],
    });
  }

  private assertPhaseOperandsCurrent(operands: KbPhaseOperands): void {
    const open = this.store.requireOpenPhaseOperands(operands.state_id);
    if (canonicalJson(open) !== canonicalJson(operands)) throw new KbWorkerPostureError();
    recheckAdmittedPolicy({
      kbRoot: this.options.kbRoot,
      admittedPolicySha256: operands.admitted_policy_sha256,
    });
    if (operands.private_input_sha256 !== this.verifiedPrivateInputSha256()) {
      throw new KbWorkerPostureError();
    }
    const authority = operands.compose_authority;
    if (authority === undefined) return;
    const { selected, manifest } = this.selectedComposeBase();
    if (
      authority.kb_id !== manifest.kb_id ||
      authority.base_generation_id !== selected.selector.generation_id ||
      authority.base_catalog_sha256 !== selected.selector.catalog_sha256 ||
      authority.private_input_sha256 !== this.verifiedPrivateInputSha256()
    ) {
      throw new KbWorkerPostureError();
    }
    for (const bound of authority.selected_pages) {
      const page = selected.catalog.pages[bound.page_id];
      if (
        page === undefined ||
        page.revision_id !== bound.revision_id ||
        page.page_sha256 !== bound.page_sha256 ||
        page.claims_sha256 !== bound.claims_sha256
      ) {
        throw new KbWorkerPostureError();
      }
    }
  }

  private validateComposeArtifact(
    toolInput: StageRunArtifactInput,
    operands: KbPhaseOperands
  ): void {
    if (
      toolInput.artifact_kind !== "page_draft" ||
      toolInput.media_type !== "application/json" ||
      toolInput.encoding !== "utf8" ||
      operands.compose_authority === undefined
    ) {
      throw new Error("compose_artifact_allocation_missing");
    }
    const { selected } = this.selectedComposeBase();
    const priorArtifact = operands.allowed_prior_artifacts[0];
    if (operands.operation === "ingest" && priorArtifact === undefined) {
      throw new KbWorkerPostureError();
    }
    const claimCandidates =
      operands.operation === "ingest" && priorArtifact !== undefined
        ? claimCandidateBodies(
            this.readAllowedArtifact({
              runId: priorArtifact.run_id,
              stateId: priorArtifact.state_id,
              handle: priorArtifact.handle,
            })
          )
        : undefined;
    validatePageDraftAuthority({
      document: strictParseJson(toolInput.content),
      authority: operands.compose_authority,
      selectedGenerationId: selected.selector.generation_id,
      selectedCatalogSha256: selected.selector.catalog_sha256,
      selectedCatalog: selected.catalog,
      ...(claimCandidates === undefined ? {} : { claimCandidates }),
    });
  }

  private phaseBrief(operands: KbPhaseOperands): string {
    let privateRequest: Record<string, unknown>;
    try {
      const raw =
        this.options.readPhaseBrief?.() ??
        (this.options.queryReader !== undefined
          ? this.options.queryReader.readRequest()
          : this.options.promotionReader !== undefined
            ? this.options.promotionReader.readPhaseBrief()
            : this.options.operation === "save"
              ? canonicalJson(
                  readRunInput({
                    projectRoot: this.options.projectRoot,
                    checkpointer: this.artifactCheckpointer,
                    runId: this.options.runId,
                  })
                )
              : canonicalJson({ schema_version: 1, action: "ingest" }));
      privateRequest = object(strictParseJson(raw), "kb_phase_brief_invalid");
    } catch {
      throw new Error("kb_phase_brief_invalid");
    }

    let brief: unknown;
    if (this.options.operation === "ingest") {
      brief = { action: "ingest", source_ids: [...operands.source_ids] };
    } else if (this.options.operation === "query") {
      brief = {
        action: "query",
        query: privateRequest.query,
        page_ids: Array.isArray(privateRequest.page_ids) ? privateRequest.page_ids : [],
        source_ids: Array.isArray(privateRequest.source_ids) ? privateRequest.source_ids : [],
        max_candidates:
          typeof privateRequest.max_candidates === "number" ? privateRequest.max_candidates : 20,
        verify_grounding:
          typeof privateRequest.verify_grounding === "boolean"
            ? privateRequest.verify_grounding
            : true,
      };
    } else if (this.options.operation === "save") {
      brief = {
        action: "save",
        query_run_id: privateRequest.query_run_id,
        page_kind: privateRequest.page_kind,
        title: privateRequest.title,
      };
    } else {
      brief = {
        action: "promote",
        page_revisions: privateRequest.page_revisions,
        target_capability_ids: privateRequest.target_capability_ids,
      };
    }
    const validatedBrief = validateKbContract(KbPhaseBriefSchema, brief, "KB private phase brief");
    const result = {
      schema_version: 1,
      run_id: operands.run_id,
      state_id: operands.state_id,
      brief: validatedBrief,
      allowed_prior_artifacts: operands.allowed_prior_artifacts.map((entry) => entry.handle),
      allowed_selected_pages: operands.allowed_selected_pages,
      ...(operands.compose_authority === undefined
        ? {}
        : { compose_authority: operands.compose_authority }),
    };
    return canonicalJson(
      validateKbContract(ReadPhaseBriefResultSchema, result, "read_phase_brief result")
    );
  }

  private allowedArtifacts(priorStates: readonly KbPhaseState[]): AllowedArtifact[] {
    return priorStates.flatMap((stateId) => {
      const seed = this.options.seedPhaseOutputs?.[stateId];
      if (seed !== undefined) {
        const seedStore = new RunArtifactStore(
          this.options.kbRoot,
          seed.runId,
          this.artifactCheckpointer
        );
        try {
          const read = seedStore.read(seed.artifactId, { required_lifecycle: "sealed" });
          return [
            {
              handle: read.handle,
              runId: seed.runId,
              stateId: seedStore.getIndexRecord(seed.artifactId).state_id,
            },
          ];
        } finally {
          seedStore.close();
        }
      }
      const handles = this.store.listByState(stateId, "sealed");
      const latest = handles[handles.length - 1];
      return latest === undefined ? [] : [{ handle: latest, runId: this.options.runId, stateId }];
    });
  }

  /** Body-free engine routing metadata derived from the validated staged artifact. */
  private phaseDetails(
    phase: KbPhaseState,
    parsed: Record<string, unknown>
  ): Record<string, JsonValue> {
    if (phase === "ingest") {
      const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
      const sourceIds = Array.isArray(parsed.source_ids)
        ? parsed.source_ids.filter((source): source is string => typeof source === "string")
        : [];
      return { claim_count: claims.length, source_ids: sourceIds };
    }
    if (phase === "compose") {
      const pages = recordArrayOrEmpty(parsed.pages, "compose_page_invalid");
      const first = pages[0] ?? {};
      const frontmatter = object(first.frontmatter ?? {}, "page_frontmatter_invalid");
      const claimCount = pages.reduce((sum, page) => {
        const claims = object(page.claims ?? {}, "page_claims_invalid");
        return sum + (Array.isArray(claims.claims) ? claims.claims.length : 0);
      }, 0);
      return {
        page_id: typeof frontmatter.page_id === "string" ? frontmatter.page_id : "page_unknown",
        revision_id:
          typeof frontmatter.revision_id === "string" ? frontmatter.revision_id : "rev_unknown",
        claim_count: claimCount,
      };
    }
    if (phase === "query") {
      const answer = object(parsed.answer ?? {}, "query_answer_invalid");
      const citations = recordArrayOrEmpty(answer.citations, "query_citation_invalid");
      return {
        citation_count: citations.length,
        cited_page_ids: [
          ...new Set(
            citations.flatMap((citation) =>
              typeof citation.page_id === "string" ? [citation.page_id] : []
            )
          ),
        ],
      };
    }
    if (phase === "plan" || phase === "patch") {
      const targetIds =
        phase === "plan"
          ? Array.isArray(parsed.target_capability_ids)
            ? parsed.target_capability_ids.filter((id): id is string => typeof id === "string")
            : []
          : recordArrayOrEmpty(parsed.targets, "promotion_target_invalid").flatMap((target) =>
              typeof target.target_capability_id === "string" ? [target.target_capability_id] : []
            );
      return { target_capability_ids: targetIds, target_count: targetIds.length };
    }
    if (phase === "lint") {
      const findings = recordArrayOrEmpty(parsed.findings, "lint_finding_invalid");
      const conflicts = Array.isArray(parsed.candidate_conflicts) ? parsed.candidate_conflicts : [];
      return {
        finding_count: findings.length,
        blocking_count: findings.filter((finding) => finding.severity === "blocking").length,
        candidate_conflict_count: conflicts.length,
      };
    }
    if (this.options.queryReader !== undefined) {
      const findings = recordArrayOrEmpty(
        parsed.citation_findings,
        "query_verification_finding_invalid"
      );
      const answerHandle = this.store.listByState("query", "sealed").at(-1);
      const answerDocument =
        answerHandle === undefined
          ? null
          : strictParseJson(this.store.read(answerHandle.artifact_id).content);
      const assessment = assessQueryVerification(answerDocument, parsed, answerHandle);
      return {
        supported: findings.filter((finding) => finding.verdict === "supported").length,
        partially_supported: 0,
        unsupported: findings.filter((finding) => finding.verdict === "unsupported").length,
        verification_passed: assessment.passed,
      };
    }
    const verdicts = recordArrayOrEmpty(
      parsed.claim_findings,
      "claim_verification_finding_invalid"
    ).map((finding) => String(finding.verdict));
    return {
      supported: verdicts.filter((verdict) => verdict === "supported").length,
      partially_supported: verdicts.filter((verdict) => verdict === "partially_supported").length,
      unsupported: verdicts.filter((verdict) => verdict === "unsupported").length,
    };
  }

  close(): void {
    if (this.control.state === "bound") this.control.store.close();
    this.control = { state: "unbound" };
  }
}
