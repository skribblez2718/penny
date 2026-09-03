import { requireValue } from "./helpers/narrowing.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  Checkpointer,
  canonicalJson,
  sha256,
  type CheckpointObserver,
} from "../src/checkpointer.js";
import type {
  ArtifactRef,
  Directive,
  JsonValue,
  LivenessSnapshotV1,
  RunIdentity,
} from "../src/contracts.js";
import { RunContext } from "../src/context.js";
import { OrchestrationEngine } from "../src/engine.js";
import type { KbIngestPlaneV1 } from "../src/kb/ingest-plane.js";
import type { ArtifactKind, KbArtifactHandle } from "../src/kb/contracts.js";
import { initKb, lintKb, statusKb } from "../src/kb/workflows.js";
import { kbLivenessPolicy, LivenessController } from "../src/liveness.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../src/model-client.js";
import { ObservabilityClient } from "../src/observability.js";
import {
  KNOWLEDGE_BASE_COMPLETION_RECEIPT_PREDICATES,
  KNOWLEDGE_BASE_SKILL_CONTRACT,
  KnowledgeBasePlaybook,
  type KbAgentPhase,
} from "../src/playbooks/knowledge-base.js";
import {
  resolvePlaybook,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
} from "../src/playbooks/registry.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { researchSemanticDraftFixture } from "./helpers/research-semantic-draft.js";

const MATRIX_TEST_TIMEOUT_MS = 30_000;
const OBSERVER_TIMEOUT_MS = 10;
const OBSERVER_SETTLEMENT_MS = 20;
const FIXED_CLOCK_MS = 10_000;
const RECOVERY_CLOCK_MS = 11_000;
const MAX_STEPS = 96;
const KB_READER_CALL_CEILING = 16;
const FIXED_TIMESTAMP = "2026-08-16T00:00:00.000Z";
const PROFILE = "kbp_observability";
const SESSION = "session_observability";
const POLICY_SHA256 = "a".repeat(64);
const GENERATION_ID = `gen_${"1".repeat(40)}`;

const identity = {
  schema_version: 2 as const,
  run_id: "obs-run",
  session_id: "obs-session",
  playbook: "research",
  engine_owner: "typescript" as const,
};

function observation(eventType = "run_started") {
  return {
    identity,
    status: "running",
    stateId: "planning",
    eventType,
    payload: {
      run_id: identity.run_id,
      goal_sha256: "a".repeat(64),
      goal_bytes: 24,
    },
    sequence: 1,
    timestamp: FIXED_TIMESTAMP,
  };
}

async function settleObserver(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, OBSERVER_SETTLEMENT_MS));
}

async function expectObserverEquivalence<T>(
  scenario: (observer?: CheckpointObserver) => Promise<T>
): Promise<T> {
  const withoutObserver = await scenario();
  const throwing = await scenario(() => {
    throw new Error("observer unavailable");
  });

  const failingFetch = vi.fn<typeof fetch>(
    async () => new Response("unavailable", { status: 503 })
  );
  const client = new ObservabilityClient({
    env: { PI_OBSERVABILITY_REST_URL: "http://observability.invalid" },
    fetchImpl: failingFetch,
    timeoutMs: OBSERVER_TIMEOUT_MS,
  });
  const endpointFailure = await scenario(client.observe);
  await vi.waitFor(() => expect(failingFetch.mock.calls.length).toBeGreaterThan(0));
  await settleObserver();
  const failureCalls = failingFetch.mock.calls.length;

  const circuitOpen = await scenario(client.observe);
  await settleObserver();

  expect(throwing).toEqual(withoutObserver);
  expect(endpointFailure).toEqual(withoutObserver);
  expect(circuitOpen).toEqual(withoutObserver);
  expect(failingFetch).toHaveBeenCalledTimes(failureCalls);
  return withoutObserver;
}

function researchIdentity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: SESSION,
    playbook: "research",
    engine_owner: "typescript",
  };
}

function researchStart(projectRoot: string, runIdentity: RunIdentity): unknown {
  return {
    schema_version: 2,
    action: "start",
    identity: runIdentity,
    goal: "Synthetic observability equivalence research",
    constraints: { mode: "quick" },
    project_root: projectRoot,
    trust_profile: "trusted-interactive",
  };
}

function successfulResearchCompletion(stateId: string): AgentCompletion {
  const completions: Record<string, AgentCompletion> = {
    researching: {
      text: 'deterministic research findings\nSUMMARY:{"confidence":"PROBABLE","explore_complete":true}',
      confidence: "PROBABLE",
      details: { explore_complete: true },
    },
    validating: {
      text: 'deterministic grounding verdict\nSUMMARY:{"confidence":"CERTAIN","verdict":"PASS","unsupported_claims":[],"evidence":[{"claim":"claim-observability","source":"source-observability"}]}',
      confidence: "CERTAIN",
      details: {
        verdict: "PASS",
        unsupported_claims: [],
        evidence: [{ claim: "claim-observability", source: "source-observability" }],
      },
    },
  };
  return requireValue(
    completions[stateId],
    `observability research completion for state '${stateId}'`
  );
}

class ResearchMatrixClient implements ModelClient {
  private artifacts: ArtifactStore | undefined;

  constructor(private readonly outcome: "success" | "malformed") {}

  bindArtifacts(artifacts: ArtifactStore): void {
    this.artifacts = artifacts;
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    invocation.liveness?.({ kind: "model_turn", source: "turn_start" });
    if (this.outcome === "malformed") {
      if (invocation.task.startsWith("Repair routing metadata only.")) {
        return {
          text: 'SUMMARY:{"confidence":"UNCERTAIN"}',
          confidence: "UNCERTAIN",
          details: {},
        };
      }
      return { text: "malformed research output", confidence: "UNCERTAIN", details: {} };
    }
    if (invocation.stateId === "researching") {
      invocation.liveness?.({ kind: "tool_call", tool_name: "web_search" });
    }
    if (invocation.stateId === "synthesizing") {
      if (this.artifacts === undefined) throw new Error("observability artifacts are unbound");
      const draft = researchSemanticDraftFixture(invocation, this.artifacts, {
        title: "Observability-equivalent synthesis",
        executiveSummary: "Workflow truth is independent of observability.",
        claimStatement: "Observability does not determine workflow truth.",
        sectionHeading: "Truth",
        sectionBody: "Deterministic host products are identical with observability unavailable.",
      });
      return {
        text: `${canonicalJson(draft)}\nSUMMARY:{"confidence":"PROBABLE","synthesis_complete":true}`,
        confidence: "PROBABLE",
        details: { synthesis_complete: true },
      };
    }
    return successfulResearchCompletion(invocation.stateId);
  }
}

interface ResearchProjection {
  readonly terminal: Directive;
  readonly status: Directive;
  readonly recover: Directive;
  readonly cancel: Directive;
  readonly selected_artifact_refs: readonly ArtifactRef[];
  readonly liveness: LivenessSnapshotV1;
}

function researchRuntime(input: {
  projectRoot: string;
  stateRoot: string;
  observer: CheckpointObserver | undefined;
  client: ModelClient;
}): {
  artifacts: ArtifactStore;
  checkpointer: Checkpointer;
  engine: OrchestrationEngine;
  workers: WorkerExecutor;
} {
  const checkpointer = new Checkpointer(
    path.join(input.stateRoot, "orchestration-v2.db"),
    input.observer
  );
  const liveness = new LivenessController(checkpointer, () => FIXED_CLOCK_MS);
  const artifacts = new ArtifactStore(path.join(input.stateRoot, "artifacts"));
  if (input.client instanceof ResearchMatrixClient) input.client.bindArtifacts(artifacts);
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: input.projectRoot,
    maxSteps: MAX_STEPS,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    livenessController: liveness,
    artifactRevisions: artifacts,
    artifactStore: artifacts,
    artifactReader: artifacts,
  });
  const workers = new WorkerExecutor(input.client, artifacts, {
    projectRoot: input.projectRoot,
    parallelConcurrency: 1,
  });
  return { artifacts, checkpointer, engine, workers };
}

async function runResearchToTerminal(input: {
  projectRoot: string;
  observer: CheckpointObserver | undefined;
  outcome: "success" | "malformed";
}): Promise<ResearchProjection> {
  const stateRoot = mkdtempSync(path.join(input.projectRoot, "research-state-"));
  const timestamp = vi.spyOn(Date.prototype, "toISOString").mockReturnValue(FIXED_TIMESTAMP);
  const runIdentity = researchIdentity(`research-${input.outcome}`);
  const runtime = researchRuntime({
    projectRoot: input.projectRoot,
    stateRoot,
    observer: input.observer,
    client: new ResearchMatrixClient(input.outcome),
  });
  try {
    const runner = new OrchestrationRunner(runtime.engine, runtime.workers);
    const terminal = await runner.runUntilBoundary(
      runtime.engine.handle(researchStart(input.projectRoot, runIdentity))
    );
    const status = runtime.engine.handle({
      schema_version: 2,
      action: "status",
      identity: runIdentity,
    });
    const recover = runtime.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    const cancel = runtime.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: runIdentity,
      reason: "late cancellation must replay terminal truth",
    });
    const durable = requireValue(
      runtime.checkpointer.loadRunById(runIdentity.run_id),
      "observability research terminal run"
    );
    return {
      terminal,
      status,
      recover,
      cancel,
      selected_artifact_refs: durable.selectedArtifacts,
      liveness: runtime.engine.liveness.snapshot(runIdentity.run_id),
    };
  } finally {
    timestamp.mockRestore();
    runtime.artifacts.close();
    runtime.checkpointer.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

async function runResearchCancellation(
  projectRoot: string,
  observer?: CheckpointObserver
): Promise<
  ResearchProjection & { readonly pending: Directive; readonly pre_cancel_status: Directive }
> {
  const stateRoot = mkdtempSync(path.join(projectRoot, "research-cancel-state-"));
  const runIdentity = researchIdentity("research-cancel");
  const runtime = researchRuntime({
    projectRoot,
    stateRoot,
    observer,
    client: new ResearchMatrixClient("success"),
  });
  runtime.workers.setReceiptAuthority(runtime.engine.receiptAuthority);
  runtime.workers.setLivenessController(runtime.engine.liveness);
  try {
    const initial = runtime.engine.handle(researchStart(projectRoot, runIdentity));
    const completed = await runtime.workers.execute(initial);
    const pending = runtime.engine.acceptWorkerResults(runIdentity, completed);
    for (const result of completed) runtime.workers.acceptArtifact(result);
    const preCancelStatus = runtime.engine.handle({
      schema_version: 2,
      action: "status",
      identity: runIdentity,
    });
    const recover = runtime.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    const terminal = runtime.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: runIdentity,
      reason: "deterministic cancellation",
    });
    const status = runtime.engine.handle({
      schema_version: 2,
      action: "status",
      identity: runIdentity,
    });
    const cancel = runtime.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: runIdentity,
      reason: "idempotent cancellation",
    });
    const durable = requireValue(
      runtime.checkpointer.loadRunById(runIdentity.run_id),
      "observability research cancelled run"
    );
    return {
      pending,
      pre_cancel_status: preCancelStatus,
      terminal,
      status,
      recover,
      cancel,
      selected_artifact_refs: durable.selectedArtifacts,
      liveness: runtime.engine.liveness.snapshot(runIdentity.run_id),
    };
  } finally {
    runtime.artifacts.close();
    runtime.checkpointer.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

type KbMatrixAction = "ingest" | "query" | "save" | "promote";

const KB_PHASE_PATHS: Readonly<Record<KbMatrixAction, readonly KbAgentPhase[]>> = {
  ingest: ["ingest", "compose", "lint", "verify"],
  query: ["query", "verify"],
  save: ["compose", "lint", "verify"],
  promote: ["plan", "patch"],
};

const KB_ARTIFACT_KIND: Readonly<Record<KbAgentPhase, ArtifactKind>> = {
  ingest: "claims",
  compose: "page_draft",
  query: "query_answer",
  lint: "lint_report",
  verify: "verification_report",
  plan: "promotion_plan",
  patch: "promotion_patch",
};

function kbIdentity(action: KbMatrixAction, suffix = "path"): RunIdentity {
  return {
    schema_version: 2,
    run_id: `kb-${action}-${suffix}`,
    session_id: SESSION,
    playbook: "knowledge-base",
    engine_owner: "typescript",
  };
}

function fakeKbPlane(): KbIngestPlaneV1 {
  return {
    admitRun() {
      throw new Error("not used by the phase-path fixture");
    },
    recheckPolicy() {},
    claim() {
      return [];
    },
    admit() {},
    seal() {},
    prepareContentReview() {
      throw new Error("not used by the phase-path fixture");
    },
    persistGate() {
      throw new Error("not used by the phase-path fixture");
    },
    approve() {
      throw new Error("not used by the phase-path fixture");
    },
    deny() {},
    claimSave() {
      throw new Error("not used by the phase-path fixture");
    },
    settleSave() {},
    verifyPromotion() {
      throw new Error("not used by the phase-path fixture");
    },
  };
}

function kbRootResolver(projectRoot: string, profileId: string, sessionId: string): string {
  return path.join(projectRoot, "private-kb", profileId, sessionId);
}

function kbRegistry(plane: KbIngestPlaneV1): PlaybookRegistryV1 {
  const shipped = requireValue(resolvePlaybook("knowledge-base"), "knowledge-base registration");
  const registration: PlaybookRegistrationV1 = {
    name: "knowledge-base",
    contract: KNOWLEDGE_BASE_SKILL_CONTRACT,
    ingress: shipped.ingress,
    liveness: shipped.liveness,
    worker: shipped.worker,
    completionReceiptPredicates: KNOWLEDGE_BASE_COMPLETION_RECEIPT_PREDICATES,
    construct: (options) =>
      new KnowledgeBasePlaybook(
        options.artifactRevisions,
        plane,
        kbRootResolver,
        options.privateInput,
        options.checkpointer
      ),
  };
  return new Map([[registration.name, registration]]);
}

function configureKbContext(
  projectRoot: string,
  action: KbMatrixAction,
  runIdentity: RunIdentity
): RunContext {
  const context = RunContext.create({
    identity: runIdentity,
    goal: `Exercise the ${action} phase path without private bodies.`,
    constraints: {
      action,
      kb_profile_id: PROFILE,
      parent_identity: { provider: "local", model: "deterministic" },
    },
    projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: MAX_STEPS,
  });
  context.knowledgeBaseData.action = action;
  context.knowledgeBaseData.profile_id = PROFILE;
  context.knowledgeBaseData.kb_id = "kb_observability";
  context.knowledgeBaseData.admitted_policy_sha256 = POLICY_SHA256;
  if (action === "ingest") {
    context.knowledgeBaseData.source_capability_ids = ["cap_source_observability"];
    context.knowledgeBaseData.source_ids = ["source_observability"];
  }
  if (action === "query") {
    context.knowledgeBaseData.selected_generation_id = GENERATION_ID;
  }
  if (action === "save") {
    context.knowledgeBaseData.query_run_id = "query_observability";
    context.knowledgeBaseData.answer_artifact_id = "art_answer_observability";
  }
  if (action === "promote") {
    context.knowledgeBaseData.page_revisions = [
      { page_id: "page_observability", revision_id: "revision_observability" },
    ];
    context.knowledgeBaseData.target_capability_ids = ["target_observability"];
  }
  context.transition(requireValue(KB_PHASE_PATHS[action][0], `first ${action} phase`));
  return context;
}

function stageKbPartial(
  checkpointer: Checkpointer,
  runId: string,
  phase: KbAgentPhase
): KbArtifactHandle {
  const artifactId = `art_${sha256(`${runId}\u0000${phase}`).slice(0, 32)}`;
  const artifactKind = KB_ARTIFACT_KIND[phase];
  const digest = sha256(`synthetic ${runId} ${phase} body`);
  const storageKey = `artifacts/${phase}/${artifactId}`;
  const temporaryStorageKey = `artifacts/${phase}/.${artifactId}.tmp`;
  checkpointer.prepareKbArtifact(
    {
      schema_version: 1,
      artifact_id: artifactId,
      run_id: runId,
      state_id: phase,
      kb_profile_id: PROFILE,
      artifact_kind: artifactKind,
      media_type: "application/json",
      sha256: digest,
      byte_length: 64,
      storage_key: storageKey,
      temporary_storage_key: temporaryStorageKey,
      lifecycle: "prepared",
      created_at: FIXED_TIMESTAMP,
      updated_at: FIXED_TIMESTAMP,
    },
    8
  );
  const staged = checkpointer.kbArtifactMarkStaged(artifactId, runId);
  return {
    schema_version: 1,
    artifact_id: staged.artifact_id,
    artifact_kind: staged.artifact_kind,
    sha256: staged.sha256,
    media_type: staged.media_type,
    byte_length: staged.byte_length,
  };
}

function phaseDetails(phase: KbAgentPhase, handle: KbArtifactHandle): Record<string, JsonValue> {
  const common: Record<string, JsonValue> = {
    artifact_kind: handle.artifact_kind,
    kb_artifact_id: handle.artifact_id,
    complete: true,
  };
  switch (phase) {
    case "ingest":
      return { ...common, source_ids: ["source_observability"], claim_count: 1 };
    case "compose":
      return {
        ...common,
        page_id: "page_observability",
        revision_id: "revision_observability",
        claim_count: 1,
      };
    case "query":
      return { ...common, citation_count: 1 };
    case "lint":
      return {
        ...common,
        finding_count: 0,
        blocking_count: 0,
        candidate_conflict_count: 0,
      };
    case "verify":
      return { ...common, supported: 1, partially_supported: 0, unsupported: 0 };
    case "plan":
      return { ...common, step_count: 1, target_count: 1 };
    case "patch":
      return { ...common, hunk_count: 1, target_count: 1 };
  }
}

function kbPhase(value: string): KbAgentPhase {
  const phase = Object.values(KB_PHASE_PATHS)
    .flat()
    .find((candidate) => candidate === value);
  return requireValue(phase, `KB observability phase '${value}'`);
}

class KbMatrixClient implements ModelClient {
  constructor(
    private readonly action: KbMatrixAction,
    private readonly checkpointer: Checkpointer,
    private readonly runId: string
  ) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const phase = kbPhase(invocation.stateId);
    invocation.liveness?.({ kind: "model_turn", source: "turn_start" });
    invocation.liveness?.({ kind: "tool_call", tool_name: "stage_run_artifact" });
    const handle = stageKbPartial(this.checkpointer, this.runId, phase);
    return {
      text: `${this.action}:${phase}:complete`,
      confidence: "CERTAIN",
      details: phaseDetails(phase, handle),
    };
  }
}

function safeKbHandles(checkpointer: Checkpointer, runId: string): KbArtifactHandle[] {
  return checkpointer
    .kbArtifacts({ run_id: runId, lifecycles: ["staged", "sealed"] })
    .sort((left, right) =>
      `${left.state_id}/${left.artifact_kind}/${left.artifact_id}`.localeCompare(
        `${right.state_id}/${right.artifact_kind}/${right.artifact_id}`
      )
    )
    .map((artifact) => ({
      schema_version: 1,
      artifact_id: artifact.artifact_id,
      artifact_kind: artifact.artifact_kind,
      sha256: artifact.sha256,
      media_type: artifact.media_type,
      byte_length: artifact.byte_length,
    }));
}

interface KbPathProjection {
  readonly action: KbMatrixAction;
  readonly pending: Directive;
  readonly status: Directive;
  readonly recover: Directive;
  readonly terminal: Directive;
  readonly terminal_status: Directive;
  readonly terminal_recover: Directive;
  readonly selected_artifact_refs: readonly ArtifactRef[];
  readonly partial_handles: readonly KbArtifactHandle[];
  readonly final_unsubmitted_artifact_ref: ArtifactRef;
  readonly liveness: LivenessSnapshotV1;
}

function kbRuntime(input: {
  projectRoot: string;
  stateRoot: string;
  observer: CheckpointObserver | undefined;
  action: KbMatrixAction;
  runIdentity: RunIdentity;
  clock: () => number;
}): {
  checkpointer: Checkpointer;
  liveness: LivenessController;
  engine: OrchestrationEngine;
  workers: WorkerExecutor;
  initial: Directive;
} {
  const checkpointer = new Checkpointer(
    path.join(input.stateRoot, "orchestration-v2.db"),
    input.observer
  );
  const liveness = new LivenessController(checkpointer, input.clock);
  const plane = fakeKbPlane();
  const artifacts = new ArtifactStore(path.join(input.stateRoot, "artifacts"));
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: input.projectRoot,
    maxSteps: MAX_STEPS,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactRevisions: artifacts,
    livenessController: liveness,
    livenessPolicyResolver: () =>
      kbLivenessPolicy({
        action: input.action,
        readerMaxCallsPerPhase: KB_READER_CALL_CEILING,
      }),
    playbookName: "knowledge-base",
    playbookRegistry: kbRegistry(plane),
  });
  const context = configureKbContext(input.projectRoot, input.action, input.runIdentity);
  const initial = new KnowledgeBasePlaybook(
    artifacts,
    plane,
    kbRootResolver,
    undefined,
    checkpointer
  ).dispatch(context);
  checkpointer.createRun(context, "run_started", { fixture: "observability-equivalence" });
  liveness.bindPolicy(context);
  const workers = new WorkerExecutor(
    new KbMatrixClient(input.action, checkpointer, input.runIdentity.run_id),
    artifacts,
    { projectRoot: input.projectRoot, parallelConcurrency: 1 }
  );
  workers.setReceiptAuthority(engine.receiptAuthority);
  workers.setLivenessController(liveness);
  return { checkpointer, liveness, engine, workers, initial };
}

async function runKbPhasePath(
  projectRoot: string,
  action: KbMatrixAction,
  observer?: CheckpointObserver
): Promise<KbPathProjection> {
  const stateRoot = mkdtempSync(path.join(projectRoot, `kb-${action}-state-`));
  const runIdentity = kbIdentity(action);
  const runtime = kbRuntime({
    projectRoot,
    stateRoot,
    observer,
    action,
    runIdentity,
    clock: () => FIXED_CLOCK_MS,
  });
  try {
    const phases = KB_PHASE_PATHS[action];
    let pending = runtime.initial;
    let finalUnsubmittedArtifactRef: ArtifactRef | undefined;
    for (const [index, phase] of phases.entries()) {
      if (pending.action !== "invoke_agent" || pending.state_id !== phase) {
        throw new Error(`expected pending KB phase '${phase}'`);
      }
      const results = await runtime.workers.execute(pending);
      const result = requireValue(results[0], `worker result for KB phase '${phase}'`);
      if (index === phases.length - 1) {
        finalUnsubmittedArtifactRef = result.output_artifact;
        break;
      }
      pending = runtime.engine.acceptWorkerResults(runIdentity, results);
      for (const completed of results) runtime.workers.acceptArtifact(completed);
    }
    const status = runtime.engine.handle({
      schema_version: 2,
      action: "status",
      identity: runIdentity,
    });
    const recover = runtime.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    const terminal = runtime.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: runIdentity,
      reason: `cancel ${action} after deterministic phase execution`,
    });
    const terminalStatus = runtime.engine.handle({
      schema_version: 2,
      action: "status",
      identity: runIdentity,
    });
    const terminalRecover = runtime.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    const durable = requireValue(
      runtime.checkpointer.loadRunById(runIdentity.run_id),
      `durable KB ${action} run`
    );
    const projection: KbPathProjection = {
      action,
      pending,
      status,
      recover,
      terminal,
      terminal_status: terminalStatus,
      terminal_recover: terminalRecover,
      selected_artifact_refs: durable.selectedArtifacts,
      partial_handles: safeKbHandles(runtime.checkpointer, runIdentity.run_id),
      final_unsubmitted_artifact_ref: requireValue(
        finalUnsubmittedArtifactRef,
        `final ${action} artifact ref`
      ),
      liveness: runtime.liveness.snapshot(runIdentity.run_id),
    };
    if (canonicalJson(projection).includes(projectRoot)) {
      throw new Error("KB observability projection leaked its private root");
    }
    return projection;
  } finally {
    runtime.checkpointer.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

interface KbResumeProjection {
  readonly status_before_recovery: Directive;
  readonly recovered: Directive;
  readonly cancelled: Directive;
  readonly terminal_status: Directive;
  readonly selected_artifact_refs: readonly ArtifactRef[];
  readonly partial_handles: readonly KbArtifactHandle[];
  readonly liveness: LivenessSnapshotV1;
}

async function runKbInterruptionResume(
  projectRoot: string,
  observer?: CheckpointObserver
): Promise<KbResumeProjection> {
  const stateRoot = mkdtempSync(path.join(projectRoot, "kb-resume-state-"));
  const runIdentity = kbIdentity("ingest", "resume");
  const first = kbRuntime({
    projectRoot,
    stateRoot,
    observer,
    action: "ingest",
    runIdentity,
    clock: () => FIXED_CLOCK_MS,
  });
  try {
    const completed = await first.workers.execute(first.initial);
    const pending = first.engine.acceptWorkerResults(runIdentity, completed);
    for (const result of completed) first.workers.acceptArtifact(result);
    if (pending.action !== "invoke_agent" || pending.state_id !== "compose") {
      throw new Error("KB interruption fixture did not reach compose");
    }
    first.liveness.admitInvocation({
      runId: runIdentity.run_id,
      stateId: "compose",
      branchId: null,
      attempt: pending.attempt,
      purpose: "phase",
    });
    first.liveness.startWorker({
      runId: runIdentity.run_id,
      workerId: "worker-interrupted-observability",
      stateId: "compose",
      branchId: null,
      purpose: "phase",
    });
    first.liveness.sessionSink({
      runId: runIdentity.run_id,
      workerId: "worker-interrupted-observability",
      stateId: "compose",
    })({ kind: "model_turn", source: "turn_start" });
    first.checkpointer.close();

    const reopenedCheckpointer = new Checkpointer(
      path.join(stateRoot, "orchestration-v2.db"),
      observer
    );
    const reopenedLiveness = new LivenessController(reopenedCheckpointer, () => RECOVERY_CLOCK_MS);
    const plane = fakeKbPlane();
    const artifacts = new ArtifactStore(path.join(stateRoot, "artifacts"));
    const reopenedEngine = new OrchestrationEngine(reopenedCheckpointer, {
      projectRoot,
      maxSteps: MAX_STEPS,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactRevisions: artifacts,
      livenessController: reopenedLiveness,
      livenessPolicyResolver: () =>
        kbLivenessPolicy({
          action: "ingest",
          readerMaxCallsPerPhase: KB_READER_CALL_CEILING,
        }),
      playbookName: "knowledge-base",
      playbookRegistry: kbRegistry(plane),
    });
    try {
      const statusBeforeRecovery = reopenedEngine.handle({
        schema_version: 2,
        action: "status",
        identity: runIdentity,
      });
      const recovered = reopenedEngine.handle({
        schema_version: 2,
        action: "recover",
        identity: runIdentity,
      });
      const cancelled = reopenedEngine.handle({
        schema_version: 2,
        action: "cancel",
        identity: runIdentity,
        reason: "cancel after exact interruption recovery",
      });
      const terminalStatus = reopenedEngine.handle({
        schema_version: 2,
        action: "status",
        identity: runIdentity,
      });
      const durable = requireValue(
        reopenedCheckpointer.loadRunById(runIdentity.run_id),
        "durable KB interrupted run"
      );
      return {
        status_before_recovery: statusBeforeRecovery,
        recovered,
        cancelled,
        terminal_status: terminalStatus,
        selected_artifact_refs: durable.selectedArtifacts,
        partial_handles: safeKbHandles(reopenedCheckpointer, runIdentity.run_id),
        liveness: reopenedLiveness.snapshot(runIdentity.run_id),
      };
    } finally {
      reopenedCheckpointer.close();
    }
  } finally {
    try {
      first.checkpointer.close();
    } catch {
      // The interruption fixture intentionally closes this owner before reopening.
    }
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

interface DeterministicKbProjection {
  readonly init: ReturnType<typeof initKb>;
  readonly status: ReturnType<typeof statusKb>;
}

function terminalResult(directive: Directive, label: string): Record<string, JsonValue> {
  if (!("result" in directive)) throw new Error(`${label} is not a terminal directive`);
  return directive.result;
}

async function runDeterministicKbInit(
  observer?: CheckpointObserver
): Promise<DeterministicKbProjection> {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-kb-observability-init-"));
  const kbRoot = path.join(projectRoot, "private-kb");
  const checkpointer = new Checkpointer(path.join(projectRoot, "orchestration.db"), observer);
  try {
    const run = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: "kb-init-observability",
        session_id: SESSION,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "Initialize a deterministic advisory KB fixture.",
      constraints: { action: "init", kb_profile_id: PROFILE },
      projectRoot,
      trustProfile: "hardened-untrusted",
      maxSteps: MAX_STEPS,
    });
    checkpointer.createRun(run, "deterministic_kb_init_started", { action: "init" });
    const initialized = initKb(
      { kbRoot, profileId: PROFILE, runId: run.identity.run_id },
      "Observability equivalence KB",
      {
        kb_id: "kb_observability",
        generation_id: GENERATION_ID,
        created_at: FIXED_TIMESTAMP,
        transaction_id: "tx_observability_init",
      }
    );
    return {
      init: initialized,
      status: statusKb({ kbRoot, profileId: PROFILE, runId: run.identity.run_id }),
    };
  } finally {
    checkpointer.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

interface DeterministicLintStatusProjection {
  readonly lint: ReturnType<typeof lintKb>;
  readonly status: ReturnType<typeof statusKb>;
  readonly handles: readonly KbArtifactHandle[];
}

function deterministicLintStatusScenario(projectRoot: string) {
  const kbRoot = path.join(projectRoot, "private-kb");
  const dbPath = path.join(projectRoot, "orchestration.db");
  const runId = "kb-lint-observability";
  return async (observer?: CheckpointObserver): Promise<DeterministicLintStatusProjection> => {
    const checkpointer = new Checkpointer(dbPath, observer);
    try {
      checkpointer.bindKbRuntimeProjectRoot(projectRoot);
      let run = checkpointer.loadRunById(runId);
      if (run === undefined) {
        run = RunContext.create({
          identity: {
            schema_version: 2,
            run_id: runId,
            session_id: SESSION,
            playbook: "knowledge-base",
            engine_owner: "typescript",
          },
          goal: "Run deterministic KB lint and status.",
          constraints: { action: "lint", kb_profile_id: PROFILE },
          projectRoot,
          trustProfile: "hardened-untrusted",
          maxSteps: MAX_STEPS,
        });
        checkpointer.createRun(run, "deterministic_kb_lint_started", { action: "lint" });
      }
      checkpointer.saveRun(run, "deterministic_kb_status_checked", { action: "status" });
      return {
        lint: lintKb({ kbRoot, profileId: PROFILE, runId, checkpointer }),
        status: statusKb({ kbRoot, profileId: PROFILE, runId }),
        handles: safeKbHandles(checkpointer, runId),
      };
    } finally {
      checkpointer.close();
    }
  };
}

describe("TypeScript orchestration structured logging", () => {
  it("emits one digest-only correlated canonical log", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    });
    const client = new ObservabilityClient({
      env: { PI_OBSERVABILITY_REST_URL: "http://observability.test" },
      fetchImpl,
      timeoutMs: 100,
    });
    client.observe(observation());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(requireValue(calls[0], "observability log call").url).toBe(
      "http://observability.test/logs"
    );
    expect(JSON.stringify(calls)).not.toContain("PRIVATE_RAW_GOAL");
    expect(requireValue(calls[0], "observability log body").body).toContain("goal_sha256");
    expect(requireValue(calls[0], "observability correlated body").body).toContain("obs-session");
  });

  it(
    "keeps quick research success truth, counters, refs, status, and replay observer-independent",
    async () => {
      const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-observability-research-success-"));
      try {
        const baseline = await expectObserverEquivalence((observer) =>
          runResearchToTerminal({ projectRoot, observer, outcome: "success" })
        );
        expect(baseline.terminal).toMatchObject({
          action: "complete",
          status: "complete",
          met: true,
        });
        expect(baseline.status).toEqual(baseline.terminal);
        expect(baseline.recover).toEqual(baseline.terminal);
        expect(baseline.cancel).toEqual(baseline.terminal);
        expect(baseline.selected_artifact_refs).toHaveLength(12);
        expect(baseline.liveness).toMatchObject({
          policy_state: "bound",
          preset: "quick",
          phase_invocations: 3,
          repair_invocations: 0,
          model_turns: 3,
          tool_calls: 1,
          external_calls: 1,
          malformed_results: 0,
          open_workers: 0,
        });
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
    MATRIX_TEST_TIMEOUT_MS
  );

  it(
    "keeps malformed-stall terminal truth, liveness, and exact partial refs observer-independent",
    async () => {
      const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-observability-research-stall-"));
      try {
        const baseline = await expectObserverEquivalence((observer) =>
          runResearchToTerminal({ projectRoot, observer, outcome: "malformed" })
        );
        expect(baseline.terminal).toMatchObject({
          action: "incomplete",
          status: "incomplete",
          met: false,
          result: { terminal_reason: "identical_error_stall" },
        });
        expect(baseline.status).toEqual(baseline.terminal);
        expect(baseline.recover).toEqual(baseline.terminal);
        expect(baseline.cancel).toEqual(baseline.terminal);
        expect(
          terminalResult(baseline.terminal, "malformed research terminal")[
            "best_partial_artifact_refs"
          ]
        ).toEqual(
          baseline.selected_artifact_refs.filter((artifact) => artifact.kind === "agent-output")
        );
        expect(baseline.liveness).toMatchObject({
          phase_invocations: 2,
          repair_invocations: 1,
          model_turns: 2,
          malformed_results: 2,
          open_workers: 0,
          terminal_reason: "identical_error_stall",
        });
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
    MATRIX_TEST_TIMEOUT_MS
  );

  it(
    "keeps research cancellation, recovery, counters, and earlier-stage partial refs observer-independent",
    async () => {
      const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-observability-research-cancel-"));
      try {
        const baseline = await expectObserverEquivalence((observer) =>
          runResearchCancellation(projectRoot, observer)
        );
        expect(baseline.pending.action).toBe("invoke_agent");
        expect(baseline.pre_cancel_status.action).toBe("status");
        expect(baseline.recover).toEqual(baseline.pending);
        expect(baseline.terminal).toMatchObject({
          action: "cancelled",
          status: "cancelled",
          met: false,
        });
        expect(baseline.status).toEqual(baseline.terminal);
        expect(baseline.cancel).toEqual(baseline.terminal);
        expect(baseline.selected_artifact_refs).toHaveLength(2);
        expect(
          terminalResult(baseline.terminal, "cancelled research terminal")[
            "best_partial_artifact_refs"
          ]
        ).toEqual(
          baseline.selected_artifact_refs.filter((artifact) => artifact.kind === "agent-output")
        );
        expect(baseline.liveness).toMatchObject({
          phase_invocations: 1,
          model_turns: 1,
          tool_calls: 1,
          external_calls: 1,
          open_workers: 0,
        });
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
    MATRIX_TEST_TIMEOUT_MS
  );

  it(
    "keeps ingest, query, save, and promote phase paths and safe cancellation handles observer-independent",
    async () => {
      const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-observability-kb-paths-"));
      try {
        const actions: readonly KbMatrixAction[] = ["ingest", "query", "save", "promote"];
        for (const action of actions) {
          const baseline = await expectObserverEquivalence((observer) =>
            runKbPhasePath(projectRoot, action, observer)
          );
          const phaseCount = KB_PHASE_PATHS[action].length;
          expect(baseline.status.action).toBe("status");
          expect(baseline.recover).toMatchObject({
            action: "invoke_agent",
            state_id: requireValue(KB_PHASE_PATHS[action].at(-1), `final ${action} phase`),
          });
          expect(baseline.terminal).toMatchObject({
            action: "cancelled",
            status: "cancelled",
            met: false,
            result: { action, public_status: "cancelled" },
          });
          expect(baseline.terminal_status).toEqual(baseline.terminal);
          expect(baseline.terminal_recover).toEqual(baseline.terminal);
          expect(baseline.selected_artifact_refs).toHaveLength(phaseCount - 1);
          expect(baseline.partial_handles).toHaveLength(phaseCount);
          expect(
            terminalResult(baseline.terminal, `cancelled KB ${action} terminal`)[
              "best_partial_artifact_handles"
            ]
          ).toEqual(baseline.partial_handles);
          expect(baseline.liveness).toMatchObject({
            preset: `kb-${action}`,
            phase_invocations: phaseCount,
            repair_invocations: 0,
            model_turns: phaseCount,
            tool_calls: phaseCount,
            external_calls: 0,
            open_workers: 0,
          });
        }
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
    MATRIX_TEST_TIMEOUT_MS
  );

  it(
    "keeps KB recovery after an interrupted worker, downtime counters, refs, and cancellation observer-independent",
    async () => {
      const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-observability-kb-resume-"));
      try {
        const baseline = await expectObserverEquivalence((observer) =>
          runKbInterruptionResume(projectRoot, observer)
        );
        expect(baseline.status_before_recovery).toMatchObject({
          action: "status",
          liveness: { open_workers: 1 },
        });
        expect(baseline.recovered).toMatchObject({ action: "invoke_agent", state_id: "compose" });
        expect(baseline.cancelled).toMatchObject({
          action: "cancelled",
          status: "cancelled",
          met: false,
        });
        expect(baseline.terminal_status).toEqual(baseline.cancelled);
        expect(baseline.selected_artifact_refs).toHaveLength(1);
        expect(baseline.partial_handles).toHaveLength(1);
        expect(
          terminalResult(baseline.cancelled, "cancelled KB recovery terminal")[
            "best_partial_artifact_handles"
          ]
        ).toEqual(baseline.partial_handles);
        expect(baseline.liveness).toMatchObject({
          preset: "kb-ingest",
          phase_invocations: 2,
          model_turns: 2,
          active_wall_clock_ms: RECOVERY_CLOCK_MS - FIXED_CLOCK_MS,
          open_workers: 0,
        });
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
    MATRIX_TEST_TIMEOUT_MS
  );

  it(
    "keeps deterministic KB init, lint, and status truth and handles observer-independent",
    async () => {
      const initialized = await expectObserverEquivalence(runDeterministicKbInit);
      expect(initialized.init).toMatchObject({ action: "init", status: "complete", met: true });
      expect(initialized.status).toMatchObject({ action: "status", status: "complete", met: true });

      const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-observability-kb-deterministic-"));
      try {
        const kbRoot = path.join(projectRoot, "private-kb");
        mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
        initKb(
          { kbRoot, profileId: PROFILE, runId: "kb-deterministic-base" },
          "Deterministic lint fixture",
          {
            kb_id: "kb_observability",
            generation_id: GENERATION_ID,
            created_at: FIXED_TIMESTAMP,
            transaction_id: "tx_observability_lint_base",
          }
        );
        const baseline = await expectObserverEquivalence(
          deterministicLintStatusScenario(projectRoot)
        );
        expect(baseline.lint).toMatchObject({ action: "lint", status: "complete", met: true });
        expect(baseline.status).toMatchObject({ action: "status", status: "complete", met: true });
        expect(baseline.handles).toHaveLength(1);
        expect(baseline.lint.artifacts).toEqual(baseline.handles);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
    MATRIX_TEST_TIMEOUT_MS
  );

  it("opens a fail-silent circuit after an outage", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("server down");
    });
    const client = new ObservabilityClient({ fetchImpl, timeoutMs: OBSERVER_TIMEOUT_MS });
    expect(() => client.observe(observation("phase_result_accepted"))).not.toThrow();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    client.observe({ ...observation("run_cancelled"), sequence: 2 });
    await settleObserver();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
