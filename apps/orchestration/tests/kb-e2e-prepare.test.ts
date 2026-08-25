import { parseJson, requireRecord, requireRecordArray, requireValue } from "./helpers/narrowing.js";
/**
 * G8 prepare-only acceptance: one synthetic, non-personal flow through
 * init → policy install → ingest approval → grounded query → save
 * approval → lint → promotion preparation. All agent bodies are deterministic
 * test fixtures; no model or provider is invoked.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer, canonicalJson, sha256 } from "../src/checkpointer.js";
import type { Directive, JsonValue } from "../src/contracts.js";
import { RunContext } from "../src/context.js";
import { OrchestrationEngine } from "../src/engine.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../src/model-client.js";
import { materializeRunInput, readRunInput, settleRunInput } from "../src/private-inputs.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";
import { CapabilityStore, mintEnvelope } from "../src/kb/capabilities.js";
import {
  canonicalJson as kbCanonicalJson,
  IngestVerificationReportSchema,
  KbArtifactHandleSchema,
  PageDraftArtifactSchema,
  PromotionPatchArtifactSchema,
  PromotionPlanArtifactSchema,
  ReadPhaseBriefResultSchema,
  sha256Hex,
  validateKbContract,
  type QueryKbRequest,
} from "../src/kb/contracts.js";
import { readPolicy, writePolicy } from "../src/kb/filesystem.js";
import { mintSourceCapability } from "../src/kb/gate.js";
import {
  ContentReviewService,
  authenticateLocalContentReviewer,
} from "../src/kb/content-review.js";
import { readSelectedGeneration } from "../src/kb/generations.js";
import {
  admitOperationStart,
  completeOperationStart,
  type AdmittedOperationStart,
} from "../src/kb/operation-starts.js";
import { replayableResultFromRun } from "../src/kb/operation-receipts.js";
import { KbWorkerClient } from "../src/kb/kb-worker-client.js";
import { KbQueryReader } from "../src/kb/query-reader.js";
import { computeRequestSha256, validateQueryRequest } from "../src/kb/parent-delivery.js";
import { validatePromoteRequest } from "../src/kb/promote.js";
import { PromotionApprovalStore } from "../src/kb/promotion.js";
import { resolveKbRoot } from "../src/kb/ingest-plane.js";
import { RunArtifactStore, type ArtifactHandle } from "../src/kb/run-artifacts.js";
import {
  SaveQueryClaimStore,
  saveClaimStoreDir,
  validateSaveRequest,
} from "../src/kb/save-claim.js";
import {
  createTestOnlyArtifactBodyRunner,
  type KbPhaseInvocation,
} from "../src/kb/session-tools.js";
import { initKb, lintKb } from "../src/kb/workflows.js";
import { installGrantedProfile } from "./fixtures/kb-profile-fixture.js";

const PROFILE = "kbp_prepare_e2e";
const SESSION = "sess_prepare_e2e";
const PARENT = { provider: "ollama", model: "qwen3.8:latest" };
const NOW = "2026-08-20T00:00:00Z";
const HANDLE_KEYS = [
  "artifact_id",
  "artifact_kind",
  "byte_length",
  "media_type",
  "schema_version",
  "sha256",
];

const roots: string[] = [];
function tempRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  projectRoot: string;
  kbRoot: string;
}

function fixture(label: string): Fixture {
  const projectRoot = tempRoot(`penny-kb-prepare-${label}`);
  const kbRoot = path.join(projectRoot, "private-kb");
  installGrantedProfile({ projectRoot, kbRoot, profileId: PROFILE, sessionId: SESSION });
  initKb({ kbRoot, profileId: PROFILE, runId: `init_${label}` }, `Prepare E2E ${label}`);

  // The policy is intentionally installed by the host after init. Init remains
  // default-deny; the workflow receives no input that could weaken it.
  const policy = readPolicy(kbRoot);
  writePolicy(kbRoot, {
    ...policy,
    processing_mode: "local_only",
    allowed_parent_models: [{ ...PARENT, locality: "local" }],
    allowed_child_models: [{ ...PARENT, locality: "local" }],
  });
  return { projectRoot, kbRoot };
}

function mintSource(input: Fixture, label: string) {
  const sourcePath = path.join(input.projectRoot, `${label}.md`);
  writeFileSync(
    sourcePath,
    "Two of three acknowledgements satisfy quorum when the chair abstains.",
    { mode: 0o600 }
  );
  return mintSourceCapability({
    projectRoot: input.projectRoot,
    kbProfileId: PROFILE,
    absolutePath: sourcePath,
    title: `Quorum note ${label}`,
    authors: ["Synthetic Author"],
    sourceType: "manual",
    mediaType: "text/markdown",
    sessionId: SESSION,
    allowedOperation: "ingest",
    capturedAt: NOW,
  });
}

function phaseBodies(
  sourceId: string,
  pageId: string,
  revisionId: string,
  claimId: string
): Record<string, string> {
  return {
    ingest: JSON.stringify({
      schema_version: 1,
      artifact_kind: "claims",
      source_ids: [sourceId],
      claims: [
        {
          provisional_id: claimId,
          text: "Two of three acknowledgements satisfy quorum when the chair abstains.",
          kind: "fact",
          confidence: "CERTAIN",
          evidence: [{ source_id: sourceId, locator: "line 1" }],
        },
      ],
    }),
    compose: JSON.stringify({
      schema_version: 1,
      artifact_kind: "page_draft",
      pages: [
        {
          frontmatter: {
            schema_version: 1,
            page_id: pageId,
            revision_id: revisionId,
            kind: "synthesis",
            title: "Quorum acknowledgement rule",
            summary: "Two of three acknowledgements satisfy quorum.",
            authority: "advisory",
            lifecycle: "validated",
            created_at: NOW,
            derived_from: [sourceId],
            related_page_ids: [],
          },
          markdown:
            "## Synthesis\nTwo of three acknowledgements satisfy quorum when the chair abstains.\n\n" +
            "## Evidence\n- The admitted quorum note supports this rule.\n\n" +
            "## Tensions and unknowns\n- None recorded.\n\n" +
            "## Related\n- None.\n",
          claims: {
            schema_version: 1,
            page_id: pageId,
            revision_id: revisionId,
            claims: [
              {
                claim_id: claimId,
                text: "Two of three acknowledgements satisfy quorum when the chair abstains.",
                kind: "fact",
                state: "supported",
                confidence: "CERTAIN",
                evidence: [{ source_id: sourceId, locator: "line 1" }],
                contradicts_claim_ids: [],
                canonical_verification_refs: [],
              },
            ],
          },
        },
      ],
    }),
    lint: JSON.stringify({
      schema_version: 1,
      artifact_kind: "lint_report",
      findings: [],
      candidate_conflicts: [],
    }),
    verify: JSON.stringify({
      schema_version: 1,
      artifact_kind: "verification_report",
      verified_artifact_ids: [],
      claim_findings: [
        {
          page_id: pageId,
          revision_id: revisionId,
          claim_id: claimId,
          verdict: "supported",
          evidence: [{ evidence_id: "evidence_grounding", kind: "source", ref: sourceId }],
        },
      ],
    }),
  };
}

interface ClosableModelClient extends ModelClient {
  close?: () => void;
  bindCheckpointer?: (checkpointer: Checkpointer) => void;
}

interface AgentStack {
  projectRoot: string;
  runId: string;
  checkpointer: Checkpointer;
  engine: OrchestrationEngine;
  artifacts: ArtifactStore;
  client: ClosableModelClient;
  directive: Directive;
}

async function driveAgentRun(input: {
  projectRoot: string;
  runId: string;
  client: ClosableModelClient;
  constraints: Record<string, JsonValue>;
  startRequest?: unknown;
}): Promise<AgentStack> {
  const stateRoot = path.join(input.projectRoot, ".penny", "prepare-e2e");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const checkpointer = new Checkpointer(path.join(stateRoot, "orchestration.db"));
  const artifacts = new ArtifactStore(path.join(stateRoot, "engine-artifacts", input.runId));
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: input.projectRoot,
    maxSteps: 50,
    artifactRevisions: artifacts,
    playbookName: "knowledge-base",
  });
  input.client.bindCheckpointer?.(checkpointer);
  const workers = new WorkerExecutor(input.client, artifacts, {
    projectRoot: input.projectRoot,
    parallelConcurrency: 1,
    workerTimeoutMs: 20_000,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  const runner = new OrchestrationRunner(engine, workers);
  const action = input.constraints["action"];
  if (action !== "ingest" && action !== "save" && action !== "promote") {
    throw new Error("prepare-only fixture requires an ingest, save, or promote action");
  }
  let admittedStart: AdmittedOperationStart | undefined;
  if (input.startRequest !== undefined) {
    const context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: input.runId,
        session_id: SESSION,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "Execute the synthetic G8 prepare-only acceptance flow.",
      constraints: input.constraints,
      projectRoot: input.projectRoot,
      trustProfile: "hardened-untrusted",
      maxSteps: 50,
    });
    context.playbookData.action = action;
    context.playbookData.profile_id = PROFILE;
    admittedStart = admitOperationStart({
      projectRoot: input.projectRoot,
      checkpointer,
      context,
      session_id: SESSION,
      invocation_id: `call_${input.runId}`,
      action,
      profile_id: PROFILE,
      request: input.startRequest,
    });
  }
  const directive = await runner.runUntilBoundary(
    engine.handle({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: input.runId,
        session_id: SESSION,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "Execute the synthetic G8 prepare-only acceptance flow.",
      constraints: input.constraints,
      project_root: input.projectRoot,
      trust_profile: "hardened-untrusted",
    }),
    undefined
  );
  if (admittedStart !== undefined) {
    const durable = requireValue(
      checkpointer.loadRunById(input.runId),
      "apps/orchestration/tests/kb-e2e-prepare.test.ts:317"
    );
    const startResult = replayableResultFromRun({ action, run: durable });
    completeOperationStart({
      projectRoot: input.projectRoot,
      checkpointer,
      group_id: admittedStart.group.request_event_group_id,
      profile_id: PROFILE,
      result: startResult,
      input_digests: [admittedStart.request_sha256],
      kb_id: String(durable.playbookData.kb_id),
      policy_sha256: String(durable.playbookData.admitted_policy_sha256),
      safe_metrics: startResult.counts,
    });
  }
  return {
    projectRoot: input.projectRoot,
    runId: input.runId,
    checkpointer,
    engine,
    artifacts,
    client: input.client,
    directive,
  };
}

function closeStack(stack: AgentStack): void {
  stack.client.close?.();
  stack.artifacts.close();
  stack.checkpointer.close();
}

function respond(
  stack: AgentStack,
  response: "approve" | "deny" | "refine",
  sessionId = SESSION
): Directive {
  const run = stack.checkpointer.loadRunById(stack.runId);
  if (run === undefined) throw new Error(`missing run '${stack.runId}'`);
  const pending = run.pendingDirective;
  if (pending?.action !== "await_user") throw new Error(`run '${stack.runId}' is not at a gate`);
  if (sessionId !== run.identity.session_id) throw new Error("content-review session mismatch");
  const action = String(run.playbookData.action ?? "");
  if (action === "ingest" || action === "save") {
    return new ContentReviewService({
      projectRoot: stack.projectRoot,
      checkpointer: stack.checkpointer,
      engine: stack.engine,
      reviewer: authenticateLocalContentReviewer(),
    }).decide({ runId: stack.runId, decision: response });
  }
  return stack.engine.handle({
    schema_version: 2,
    action: "respond",
    identity: { ...run.identity, session_id: sessionId },
    gate_id: pending.gate_id,
    challenge: pending.challenge,
    response,
  });
}

function kbClient(input: {
  fixture: Fixture;
  runId: string;
  sourceIds: readonly string[];
  operation: "ingest" | "save";
  bodies: Record<string, string>;
  seedPhaseOutputs?: Readonly<Record<string, { runId: string; artifactId: string }>>;
  seen?: string[];
}): KbWorkerClient {
  let composeAllocation:
    | {
        page_id: string;
        revision_id: string;
        lifecycle: "draft" | "validated" | "superseded" | "archived";
        source_ids: string[];
        claim_allocations: Array<{ claim_id: string }>;
        supersedes: null | { revision_id: string };
      }
    | undefined;
  return new KbWorkerClient({
    projectRoot: input.fixture.projectRoot,
    kbRoot: input.fixture.kbRoot,
    runId: input.runId,
    sessionId: SESSION,
    profileId: PROFILE,
    operation: input.operation,
    sourceCapabilityIds: input.sourceIds,
    ...(input.seedPhaseOutputs ? { seedPhaseOutputs: input.seedPhaseOutputs } : {}),
    testOnlyAgentRunner: createTestOnlyArtifactBodyRunner(async (inv: KbPhaseInvocation) => {
      input.seen?.push(inv.stateId);
      // Exercise the same host-closed readers as the synthetic phase tests.
      for (const sourceId of inv.sourceAllowlist) inv.readSource(sourceId);
      for (const prior of inv.allowedPriorArtifacts ?? []) {
        inv.readRunArtifact?.(prior.artifact_id);
      }
      let body = input.bodies[inv.stateId];
      if (body === undefined) throw new Error(`no synthetic body for phase '${inv.stateId}'`);
      if (input.operation === "ingest") {
        for (const [index, capabilityId] of input.sourceIds.entries()) {
          const sourceId = inv.sourceAllowlist[index];
          if (sourceId === undefined)
            throw new Error("ingest snapshot source allocation is absent");
          body = body.split(capabilityId).join(sourceId);
        }
      }
      if (inv.stateId === "compose") {
        const brief = validateKbContract(
          ReadPhaseBriefResultSchema,
          parseJson(inv.readPhaseBrief?.() ?? "{}"),
          "synthetic compose phase brief"
        );
        const allocation = brief.compose_authority?.allocations[0];
        if (allocation === undefined || allocation.lifecycle !== "draft") {
          throw new Error("compose draft allocation is absent");
        }
        composeAllocation = allocation;
        const parsed = validateKbContract(
          PageDraftArtifactSchema,
          parseJson(body),
          "synthetic compose body"
        );
        const page = requireValue(
          parsed.pages[0],
          "apps/orchestration/tests/kb-e2e-prepare.test.ts:439"
        );
        page.frontmatter.page_id = allocation.page_id;
        page.frontmatter.revision_id = allocation.revision_id;
        page.frontmatter.lifecycle = allocation.lifecycle;
        if (allocation.supersedes !== null) {
          page.frontmatter.previous_revision_id = allocation.supersedes.revision_id;
        } else {
          delete page.frontmatter.previous_revision_id;
        }
        page.claims.page_id = allocation.page_id;
        page.claims.revision_id = allocation.revision_id;
        if (page.claims.claims.length !== allocation.claim_allocations.length) {
          throw new Error("synthetic compose claim/allocation count differs");
        }
        for (const [index, claim] of page.claims.claims.entries()) {
          claim.claim_id = requireValue(
            allocation.claim_allocations[index],
            "apps/orchestration/tests/kb-e2e-prepare.test.ts:454"
          ).claim_id;
        }
        return JSON.stringify(parsed);
      }
      if (inv.stateId === "verify" && composeAllocation !== undefined) {
        const parsed = validateKbContract(
          IngestVerificationReportSchema,
          parseJson(body),
          "synthetic ingest verification body"
        );
        for (const [index, finding] of parsed.claim_findings.entries()) {
          finding.page_id = composeAllocation.page_id;
          finding.revision_id = composeAllocation.revision_id;
          finding.claim_id = requireValue(
            composeAllocation.claim_allocations[index],
            "apps/orchestration/tests/kb-e2e-prepare.test.ts:465"
          ).claim_id;
        }
        return JSON.stringify(parsed);
      }
      return body;
    }),
  });
}

/** Promotion's plan/patch states are staged into the real KB artifact plane. */
class SyntheticPromotionClient implements ClosableModelClient {
  private store: RunArtifactStore | undefined;

  constructor(
    private readonly kbRoot: string,
    private readonly runId: string,
    private readonly bodies: Record<string, string>,
    private readonly calls: string[]
  ) {}

  bindCheckpointer(checkpointer: Checkpointer): void {
    this.store = new RunArtifactStore(this.kbRoot, this.runId, checkpointer);
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    if (this.store === undefined) throw new Error("promotion client has no control DB");
    const phase = invocation.stateId;
    const kind = phase === "plan" ? "promotion_plan" : phase === "patch" ? "promotion_patch" : null;
    if (kind === null) throw new Error(`promotion client cannot serve '${phase}'`);
    const body = this.bodies[phase];
    if (body === undefined) throw new Error(`no synthetic promotion body for '${phase}'`);
    this.calls.push(phase);
    const handle = this.store.stage({
      state_id: phase,
      kb_profile_id: PROFILE,
      artifact_kind: kind,
      content: body,
    });
    const itemCount =
      phase === "plan"
        ? validateKbContract(
            PromotionPlanArtifactSchema,
            parseJson(body),
            "synthetic promotion plan"
          ).changes.length
        : validateKbContract(
            PromotionPatchArtifactSchema,
            parseJson(body),
            "synthetic promotion patch"
          ).targets.length;
    return {
      text: body,
      confidence: "CERTAIN",
      details: {
        artifact_kind: kind,
        complete: true,
        kb_artifact_id: handle.artifact_id,
        ...(phase === "plan"
          ? { step_count: itemCount, target_count: 1 }
          : { hunk_count: itemCount, target_count: 1 }),
      },
    };
  }

  close(): void {
    this.store?.close();
  }
}

function terminalResult(directive: Directive): Record<string, unknown> {
  if (directive.action !== "complete" && directive.action !== "incomplete") {
    throw new Error(`expected a terminal directive, got '${directive.action}'`);
  }
  return directive.result;
}

function expectPathFreeHandles(value: unknown): void {
  const handles = requireRecordArray(value, "path-free artifact handles");
  for (const handle of handles) {
    expect(Object.keys(handle).sort()).toEqual(HANDLE_KEYS);
    expect(handle["artifact_id"]).toMatch(/^art_/);
    expect(handle["sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(handle["path"]).toBeUndefined();
    expect(handle["relative_path"]).toBeUndefined();
    expect(handle["storage_key"]).toBeUndefined();
    expect(handle["resolved_path"]).toBeUndefined();
  }
}

interface SnapshotEntry {
  kind: "dir" | "file";
  name: string;
  sha256?: string;
}

/** Exact content oracle for files that can publish KB state. Work/gates are excluded. */
function publicationSnapshot(kbRoot: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  const rootsToRead = [
    "sources/objects",
    "sources/records",
    "pages",
    "conflicts",
    ".kb/generations",
    ".kb/current.json",
    "index.md",
    "manifest.json",
    ".kb/policy.json",
  ];
  const visit = (absolute: string): void => {
    const stat = lstatSync(absolute);
    const name = path.relative(kbRoot, absolute).split(path.sep).join("/");
    if (stat.isDirectory()) {
      entries.push({ kind: "dir", name });
      for (const child of readdirSync(absolute).sort()) visit(path.join(absolute, child));
      return;
    }
    if (!stat.isFile()) throw new Error(`unexpected publication-plane entry '${name}'`);
    entries.push({
      kind: "file",
      name,
      sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    });
  };
  for (const relative of rootsToRead) {
    const absolute = path.join(kbRoot, relative);
    if (existsSync(absolute)) visit(absolute);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function runArtifact(
  projectRoot: string,
  kbRoot: string,
  runId: string,
  handle: { artifact_id: string }
): { handle: ArtifactHandle; body: Record<string, unknown> } {
  const checkpointer = new Checkpointer(
    path.join(projectRoot, ".penny", "prepare-e2e", "orchestration.db")
  );
  const store = new RunArtifactStore(kbRoot, runId, checkpointer);
  try {
    const read = store.read(handle.artifact_id);
    return {
      handle: read.handle,
      body: requireRecord(
        parseJson(read.content),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:597"
      ),
    };
  } finally {
    store.close();
    checkpointer.close();
  }
}

async function runGroundedQuery(
  input: Fixture,
  runId: string,
  sourceId: string,
  selectedClaim: { page_id: string; revision_id: string; claim_id: string }
): Promise<Record<string, unknown>> {
  const request: QueryKbRequest = validateQueryRequest({
    schema_version: 1,
    action: "query",
    kb_profile_id: PROFILE,
    query: "quorum acknowledgements chair abstains",
  });
  const stateRoot = path.join(input.projectRoot, ".penny", "prepare-e2e");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const checkpointer = new Checkpointer(path.join(stateRoot, "orchestration.db"));
  const artifacts = new ArtifactStore(path.join(stateRoot, "engine-artifacts", runId));
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: input.projectRoot,
    maxSteps: 8,
    artifactRevisions: artifacts,
    playbookName: "knowledge-base",
  });
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: SESSION,
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "Answer the stored private query from supported evidence.",
    constraints: { action: "query", kb_profile_id: PROFILE, parent_identity: PARENT },
    projectRoot: input.projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
  });
  const requestSha256 = computeRequestSha256(request);
  const admission = checkpointer.admitStartRun(context, {
    session_id: SESSION,
    invocation_id: `call_${runId}`,
    request_sha256: requestSha256,
    action: "query",
    profile_id: PROFILE,
    transaction_id: `tx_${runId}`,
    private_input_id: `pri_${runId}`,
    storage_key: `${runId}/request.json`,
    temporary_storage_key: `${runId}/.tx_${runId}.tmp`,
  });
  expect(admission.kind).toBe("created");
  materializeRunInput({
    projectRoot: input.projectRoot,
    checkpointer,
    runId,
    request,
    requestSha256,
  });

  const queryReader = new KbQueryReader({
    kbRoot: input.kbRoot,
    profileId: PROFILE,
    readRequest: () => readRunInput({ projectRoot: input.projectRoot, checkpointer, runId }),
    selectedGenerationId: () =>
      String(checkpointer.loadRunById(runId)?.playbookData.selected_generation_id ?? ""),
  });
  const citation = {
    kind: "claim" as const,
    ...selectedClaim,
  };
  const worker = new KbWorkerClient({
    projectRoot: input.projectRoot,
    checkpointer,
    kbRoot: input.kbRoot,
    runId,
    sessionId: SESSION,
    profileId: PROFILE,
    operation: "query",
    sourceCapabilityIds: [],
    admittedPolicySha256: () =>
      String(checkpointer.loadRunById(runId)?.playbookData.admitted_policy_sha256 ?? ""),
    queryReader,
    testOnlyAgentRunner: createTestOnlyArtifactBodyRunner(async (invocation) => {
      expect(invocation.phaseBrief).not.toContain(request.query);
      expect(invocation.readPhaseBrief?.()).toContain(request.query);
      expect(invocation.searchSelectedKb?.()).toContain(selectedClaim.page_id);
      expect(
        invocation.readSelectedPage?.(selectedClaim.page_id, selectedClaim.revision_id)
      ).toContain(selectedClaim.claim_id);
      expect(invocation.readSelectedSource?.(sourceId)).toContain("chair abstains");
      if (invocation.stateId === "query") {
        return JSON.stringify({
          schema_version: 1,
          artifact_kind: "query_answer",
          answer: {
            authority: "advisory",
            text: "Two of three acknowledgements satisfy quorum when the chair abstains.",
            citations: [citation],
            contradictions: [],
            unknowns: [],
            canonical_verification_required: true,
          },
        });
      }
      const prior = invocation.allowedPriorArtifacts?.[0];
      expect(prior).toBeDefined();
      expect(
        invocation.readRunArtifact?.(
          requireValue(prior, "apps/orchestration/tests/kb-e2e-prepare.test.ts:707").artifact_id
        )
      ).toContain(selectedClaim.claim_id);
      return JSON.stringify({
        schema_version: 1,
        artifact_kind: "verification_report",
        passed: true,
        answer_artifact_id: requireValue(
          prior,
          "apps/orchestration/tests/kb-e2e-prepare.test.ts:712"
        ).artifact_id,
        answer_sha256: requireValue(prior, "apps/orchestration/tests/kb-e2e-prepare.test.ts:713")
          .sha256,
        answer_verdict: "supported",
        citation_findings: [
          { citation, verdict: "supported", notes: "The admitted source states the rule." },
        ],
      });
    }),
  });
  const workers = new WorkerExecutor(worker, artifacts, {
    projectRoot: input.projectRoot,
    parallelConcurrency: 1,
    workerTimeoutMs: 20_000,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  const runner = new OrchestrationRunner(engine, workers);
  const directive = await runner.runUntilBoundary(
    engine.handle({
      schema_version: 2,
      action: "start",
      identity: context.identity,
      goal: context.goal,
      constraints: context.constraints,
      project_root: input.projectRoot,
      trust_profile: "hardened-untrusted",
    }),
    undefined
  );
  expect(directive.action).toBe("complete");
  const result = terminalResult(directive);

  // The durable run is bound to the active session, not merely to its run id.
  expect(() =>
    engine.handle({
      schema_version: 2,
      action: "status",
      identity: { ...context.identity, session_id: "sess_other" },
    })
  ).toThrow();

  const resultSha256 = sha256(canonicalJson(result));
  checkpointer.settleStartAdmission(runId, {
    terminal_result_id: `trm_${resultSha256}`,
    terminal_result_sha256: resultSha256,
  });
  settleRunInput({ projectRoot: input.projectRoot, checkpointer, runId });
  expect(checkpointer.getPrivateInput(runId)?.state).toBe("discarded");
  worker.close();
  artifacts.close();
  checkpointer.close();
  return result;
}

function registerCanonicalTarget(input: Fixture): {
  targetPath: string;
  targetRoot: string;
  capabilityId: string;
  original: Buffer;
} {
  const targetRoot = path.join(input.projectRoot, "canonical-target");
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const targetPath = path.join(targetRoot, "GUIDANCE.md");
  writeFileSync(targetPath, "# Canonical\n\nExisting guidance.\n", { mode: 0o600 });
  const original = readFileSync(targetPath);
  const envelope = mintEnvelope({
    kind: "canonical_target",
    session_id: SESSION,
    kb_profile_id: PROFILE,
    resolved_path: targetPath,
    authority_root: targetRoot,
    expected_sha256: sha256(original),
    allowed_operation: "promote",
    issued_at: NOW,
    expires_at: "2027-08-20T00:00:00Z",
  });
  const store = new CapabilityStore(input.projectRoot);
  try {
    store.register(envelope);
  } finally {
    store.close();
  }
  return { targetPath, targetRoot, capabilityId: envelope.capability_id, original };
}

async function startIngest(
  input: Fixture,
  label: string
): Promise<{
  stack: AgentStack;
  capabilityId: string;
}> {
  const capability = mintSource(input, label);
  const runId = `run_ingest_${label}`;
  const bodies = phaseBodies(
    capability.capability_id,
    `page_${label}`,
    `rev_${label}`,
    `claim_${label}`
  );
  const client = kbClient({
    fixture: input,
    runId,
    sourceIds: [capability.capability_id],
    operation: "ingest",
    bodies,
  });
  const stack = await driveAgentRun({
    projectRoot: input.projectRoot,
    runId,
    client,
    constraints: {
      action: "ingest",
      kb_profile_id: PROFILE,
      source_capability_ids: [capability.capability_id],
      parent_identity: PARENT,
    },
    startRequest: {
      schema_version: 1,
      action: "ingest",
      kb_profile_id: PROFILE,
      source_capability_ids: [capability.capability_id],
    },
  });
  return { stack, capabilityId: capability.capability_id };
}

describe("G8 prepare-only end to end", () => {
  it("executes init → ingest approval → supported query → save → lint → promote prepare", async () => {
    const input = fixture("main");
    expect(resolveKbRoot(input.projectRoot, PROFILE, SESSION)).toBe(input.kbRoot);
    expect(() => resolveKbRoot(input.projectRoot, PROFILE, "sess_wrong")).toThrow();
    expect(() => resolveKbRoot(input.projectRoot, "kbp_wrong", SESSION)).toThrow();

    const source = mintSource(input, "main");
    const ingestRunId = "run_ingest_main";
    const ingestSeen: string[] = [];
    const ingestStack = await driveAgentRun({
      projectRoot: input.projectRoot,
      runId: ingestRunId,
      client: kbClient({
        fixture: input,
        runId: ingestRunId,
        sourceIds: [source.capability_id],
        operation: "ingest",
        bodies: phaseBodies(source.capability_id, "page_quorum", "rev_quorum_1", "claim_quorum"),
        seen: ingestSeen,
      }),
      constraints: {
        action: "ingest",
        kb_profile_id: PROFILE,
        source_capability_ids: [source.capability_id],
        parent_identity: PARENT,
      },
      startRequest: {
        schema_version: 1,
        action: "ingest",
        kb_profile_id: PROFILE,
        source_capability_ids: [source.capability_id],
      },
    });
    let admittedSourceId = "";
    let quorumClaim = { page_id: "", revision_id: "", claim_id: "" };
    try {
      expect(ingestStack.directive.action).toBe("await_user");
      expect(ingestSeen).toEqual(["ingest", "compose", "lint", "verify"]);
      const gate = requireValue(
        ingestStack.checkpointer.contentReviewForRun(ingestRunId),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:877"
      );
      const ingestRun = requireValue(
        ingestStack.checkpointer.loadRunById(ingestRunId),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:878"
      );
      admittedSourceId = requireValue(
        ingestRun.knowledgeBaseData.source_ids?.[0],
        "admitted ingest source id"
      );
      expect(admittedSourceId).toMatch(/^src_[a-f0-9]{32}$/);
      expect(admittedSourceId).not.toBe(source.capability_id);
      expect(gate.state).toBe("awaiting");
      expect(gate.packet.kb_profile_id).toBe(PROFILE);
      expect(gate.packet.candidate_artifacts.map((a) => a.artifact_kind)).toEqual([
        "page_draft",
        "lint_report",
        "verification_report",
      ]);
      expectPathFreeHandles(gate.packet.candidate_artifacts);
      const composeAuthority = ingestStack.checkpointer.kbPhaseOperands(
        ingestRunId,
        "compose"
      )?.compose_authority;
      const quorumAllocation = composeAuthority?.allocations[0];
      const quorumClaimAllocation = quorumAllocation?.claim_allocations[0];
      if (quorumAllocation === undefined || quorumClaimAllocation === undefined) {
        throw new Error("ingest compose allocation is absent");
      }
      quorumClaim = {
        page_id: quorumAllocation.page_id,
        revision_id: quorumAllocation.revision_id,
        claim_id: quorumClaimAllocation.claim_id,
      };
      const semanticLint = requireValue(
        gate.packet.candidate_artifacts.find((a) => a.artifact_kind === "lint_report"),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:904"
      );
      expect(
        runArtifact(input.projectRoot, input.kbRoot, ingestRunId, semanticLint).body
      ).toMatchObject({
        artifact_kind: "lint_report",
        findings: [],
      });

      const selectedBefore = requireValue(
        readSelectedGeneration(input.kbRoot),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:914"
      ).selector.generation_id;
      expect(existsSync(path.join(input.kbRoot, "sources"))).toBe(false);
      expect(() => respond(ingestStack, "approve", "sess_wrong")).toThrow();
      expect(
        requireValue(
          readSelectedGeneration(input.kbRoot),
          "apps/orchestration/tests/kb-e2e-prepare.test.ts:917"
        ).selector.generation_id
      ).toBe(selectedBefore);
      expect(ingestStack.checkpointer.contentReviewForRun(ingestRunId)?.state).toBe("awaiting");

      const approved = respond(ingestStack, "approve");
      expect(approved.action).toBe("complete");
      const approvedResult = terminalResult(approved);
      expect(approvedResult["kb_profile_id"]).toBe(PROFILE);
      expect(approvedResult["review_decision"]).toBe("approve");
      expect(String(approvedResult["published_generation_id"])).toMatch(/^gen_/);
      expect(
        requireValue(
          readSelectedGeneration(input.kbRoot),
          "apps/orchestration/tests/kb-e2e-prepare.test.ts:926"
        ).selector.generation_id
      ).not.toBe(selectedBefore);
      expect(ingestStack.checkpointer.contentReviewForRun(ingestRunId)?.state).toBe("consumed");
      expect(ingestStack.checkpointer.operationReceipts(ingestRunId)).toMatchObject([
        { event_sequence: 0, action: "ingest", event: "prepared" },
        { event_sequence: 1, action: "ingest", event: "published" },
      ]);
    } finally {
      closeStack(ingestStack);
    }

    // Query is engine-owned and grounded. Deterministic retrieval binds the
    // candidate set; Synthia synthesizes and Vera verifies before claim creation.
    const beforeQuery = publicationSnapshot(input.kbRoot);
    const queryRunId = "run_query_main";
    const queryResult = await runGroundedQuery(input, queryRunId, admittedSourceId, quorumClaim);
    expect(publicationSnapshot(input.kbRoot)).toEqual(beforeQuery);
    expect(queryResult["public_status"]).toBe("complete");
    expect(queryResult["met"]).toBe(true);
    expect(queryResult["kb_profile_id"]).toBe(PROFILE);
    expect(queryResult["candidate_count"]).toBeGreaterThanOrEqual(1);
    expect(canonicalJson(queryResult)).not.toContain("quorum acknowledgements chair abstains");
    const queryHandle: ArtifactHandle = validateKbContract(
      KbArtifactHandleSchema,
      queryResult["answer_handle"],
      "query answer handle"
    );
    expectPathFreeHandles([queryHandle]);
    const answer = runArtifact(input.projectRoot, input.kbRoot, queryRunId, queryHandle);
    expect(answer.body["artifact_kind"]).toBe("query_answer");
    const answerBody = requireRecord(answer.body["answer"], "query answer body");
    expect(answerBody["citations"]).toEqual([{ kind: "claim", ...quorumClaim }]);
    const queryArtifactControl = new Checkpointer(
      path.join(input.projectRoot, ".penny", "prepare-e2e", "orchestration.db")
    );
    const queryStore = new RunArtifactStore(input.kbRoot, queryRunId, queryArtifactControl);
    try {
      expect(queryStore.listByState("query", "sealed")).toEqual([queryHandle]);
    } finally {
      queryStore.close();
      queryArtifactControl.close();
    }
    const claimStore = new SaveQueryClaimStore(saveClaimStoreDir(input.projectRoot, PROFILE));
    expect(claimStore.load(queryRunId)).toMatchObject({
      state: "available",
      answer_artifact_id: queryHandle.artifact_id,
      answer_sha256: queryHandle.sha256,
    });

    // Closed public requests cannot smuggle a review decision or apply intent.
    expect(() =>
      validateQueryRequest({
        schema_version: 1,
        action: "query",
        kb_profile_id: PROFILE,
        query: "quorum",
        approval: "approve",
      })
    ).toThrow();
    expect(() =>
      validateSaveRequest({
        schema_version: 1,
        action: "save",
        kb_profile_id: PROFILE,
        query_run_id: queryRunId,
        page_kind: "synthesis",
        title: "Saved quorum rule",
        decision: "approve",
      })
    ).toThrow();

    // Save claims the sealed answer, produces semantic lint/grounding evidence,
    // and publishes only after a second host-authenticated content review.
    const saveRequest = validateSaveRequest({
      schema_version: 1,
      action: "save",
      kb_profile_id: PROFILE,
      query_run_id: queryRunId,
      page_kind: "synthesis",
      title: "Saved quorum rule",
    });
    const saveRunId = "run_save_main";
    const saveSeen: string[] = [];
    const saveStack = await driveAgentRun({
      projectRoot: input.projectRoot,
      runId: saveRunId,
      client: kbClient({
        fixture: input,
        runId: saveRunId,
        sourceIds: [],
        operation: "save",
        bodies: phaseBodies(admittedSourceId, "page_saved", "rev_saved_1", "claim_saved"),
        seedPhaseOutputs: {
          ingest: { runId: queryRunId, artifactId: queryHandle.artifact_id },
        },
        seen: saveSeen,
      }),
      constraints: {
        action: "save",
        kb_profile_id: PROFILE,
        query_run_id: saveRequest.query_run_id,
        page_kind: saveRequest.page_kind,
        parent_identity: PARENT,
      },
      startRequest: saveRequest,
    });
    let savedPage = { page_id: "", revision_id: "" };
    try {
      expect(saveStack.directive.action).toBe("await_user");
      expect(saveSeen).toEqual(["compose", "lint", "verify"]);
      expect(claimStore.load(queryRunId)).toMatchObject({
        state: "claimed",
        save_run_id: saveRunId,
      });
      const gate = requireValue(
        saveStack.checkpointer.contentReviewForRun(saveRunId),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:1035"
      );
      expect(gate.packet.action).toBe("save");
      expect(gate.packet.query_run_id).toBe(queryRunId);
      expect(gate.packet.candidate_artifacts.map((a) => a.artifact_kind)).toEqual([
        "page_draft",
        "lint_report",
        "verification_report",
      ]);
      expectPathFreeHandles(gate.packet.candidate_artifacts);
      const saveAllocation = saveStack.checkpointer.kbPhaseOperands(saveRunId, "compose")
        ?.compose_authority?.allocations[0];
      if (saveAllocation === undefined) throw new Error("save compose allocation is absent");
      savedPage = {
        page_id: saveAllocation.page_id,
        revision_id: saveAllocation.revision_id,
      };
      const semanticLint = requireValue(
        gate.packet.candidate_artifacts.find((a) => a.artifact_kind === "lint_report"),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:1051"
      );
      const semanticVerification = requireValue(
        gate.packet.candidate_artifacts.find((a) => a.artifact_kind === "verification_report"),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:1054"
      );
      expect(
        runArtifact(input.projectRoot, input.kbRoot, saveRunId, semanticLint).body
      ).toMatchObject({
        findings: [],
        candidate_conflicts: [],
      });
      expect(
        runArtifact(input.projectRoot, input.kbRoot, saveRunId, semanticVerification).body
      ).toMatchObject({
        claim_findings: [{ verdict: "supported" }],
      });

      const generationBeforeSave = requireValue(
        readSelectedGeneration(input.kbRoot),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:1069"
      ).selector.generation_id;
      const saved = respond(saveStack, "approve");
      expect(saved.action).toBe("complete");
      expect(
        requireValue(
          readSelectedGeneration(input.kbRoot),
          "apps/orchestration/tests/kb-e2e-prepare.test.ts:1072"
        ).selector.generation_id
      ).not.toBe(generationBeforeSave);
      expect(
        requireValue(
          readSelectedGeneration(input.kbRoot),
          "apps/orchestration/tests/kb-e2e-prepare.test.ts:1076"
        ).catalog.pages[savedPage.page_id]?.revision_id
      ).toBe(savedPage.revision_id);
      expect(claimStore.load(queryRunId)).toMatchObject({
        state: "consumed",
        save_run_id: saveRunId,
      });
      expect(saveStack.checkpointer.operationReceipts(saveRunId)).toMatchObject([
        { event_sequence: 0, action: "save", event: "prepared" },
        { event_sequence: 1, action: "save", event: "published" },
      ]);
    } finally {
      closeStack(saveStack);
    }

    // Deterministic lint supplies separate evidence and may write only its
    // same-run work artifact, never any publication-plane state.
    const beforeLint = publicationSnapshot(input.kbRoot);
    const lintControl = new Checkpointer(
      path.join(input.projectRoot, ".penny", "prepare-e2e", "orchestration.db")
    );
    const lintContext = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: "run_lint_main",
        session_id: SESSION,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "Deterministic lint fixture.",
      constraints: { action: "lint", kb_profile_id: PROFILE },
      projectRoot: input.projectRoot,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
    });
    lintControl.createRun(lintContext, "lint_fixture_started", {});
    const lintResult = lintKb({
      kbRoot: input.kbRoot,
      profileId: PROFILE,
      runId: "run_lint_main",
      checkpointer: lintControl,
    });
    expect(lintResult.status).toBe("complete");
    expect(lintResult.met).toBe(true);
    expect(lintResult.counts.blocking).toBe(0);
    expectPathFreeHandles(lintResult.artifacts);
    expect(
      runArtifact(
        input.projectRoot,
        input.kbRoot,
        "run_lint_main",
        requireValue(
          lintResult.artifacts[0],
          "apps/orchestration/tests/kb-e2e-prepare.test.ts:1122"
        )
      ).body
    ).toMatchObject({
      artifact_kind: "lint_report",
      candidate_conflicts: [],
    });
    expect(publicationSnapshot(input.kbRoot)).toEqual(beforeLint);
    lintControl.close();

    // Prepare promotion against a real host-minted target. Plan, patch, and the
    // host's independently generated verification are sealed for review; no
    // public input can approve/apply, and even a host approval is refused at G8.
    const target = registerCanonicalTarget(input);
    const promoteRequest = validatePromoteRequest({
      schema_version: 1,
      action: "promote",
      kb_profile_id: PROFILE,
      page_revisions: [savedPage],
      canonical_target_capability_ids: [target.capabilityId],
    });
    for (const extra of [
      { decision: "approve" },
      { apply: true },
      { approval_receipt: "receipt" },
      { target_path: target.targetPath },
    ]) {
      expect(() => validatePromoteRequest({ ...promoteRequest, ...extra })).toThrow();
    }

    const replacement =
      "# Canonical\n\nExisting guidance. Quorum requires two of three acknowledgements.\n";
    const promotionBodies = {
      plan: kbCanonicalJson({
        schema_version: 1,
        artifact_kind: "promotion_plan",
        page_revisions: [savedPage],
        target_capability_ids: [target.capabilityId],
        verification_report_artifact_ids: [],
        changes: [
          {
            target_capability_id: target.capabilityId,
            summary: "Add the reviewed quorum rule to canonical guidance.",
          },
        ],
      }),
      patch: kbCanonicalJson({
        schema_version: 1,
        artifact_kind: "promotion_patch",
        targets: [
          {
            target_capability_id: target.capabilityId,
            preimage_sha256: sha256(target.original),
            postimage_sha256: sha256Hex(replacement),
            replacement_utf8: replacement,
          },
        ],
      }),
    };
    const promotionCalls: string[] = [];
    const promotionRunId = "run_promote_main";
    const beforePromote = publicationSnapshot(input.kbRoot);
    const selectedBeforePromote = requireValue(
      readSelectedGeneration(input.kbRoot),
      "apps/orchestration/tests/kb-e2e-prepare.test.ts:1182"
    ).selector.generation_id;
    const targetBefore = readFileSync(target.targetPath);
    const targetListingBefore = readdirSync(target.targetRoot).sort();
    const promotionStack = await driveAgentRun({
      projectRoot: input.projectRoot,
      runId: promotionRunId,
      client: new SyntheticPromotionClient(
        input.kbRoot,
        promotionRunId,
        promotionBodies,
        promotionCalls
      ),
      constraints: {
        action: "promote",
        kb_profile_id: PROFILE,
        page_revisions: promoteRequest.page_revisions,
        canonical_target_capability_ids: promoteRequest.canonical_target_capability_ids,
        parent_identity: PARENT,
      },
    });
    try {
      expect(promotionStack.directive.action).toBe("await_user");
      expect(promotionCalls).toEqual(["plan", "patch"]);
      const approval = new PromotionApprovalStore({
        projectRoot: input.projectRoot,
        kbRoot: input.kbRoot,
      });
      const gate = requireValue(
        approval.gateForRun(promotionRunId),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:1209"
      );
      expect(gate.state).toBe("awaiting");
      const gateArtifacts = [
        gate.packet.plan_artifact,
        gate.packet.patch_artifact,
        gate.packet.verification_artifact,
      ];
      expect(gateArtifacts.map((a) => a.artifact_kind)).toEqual([
        "promotion_plan",
        "promotion_patch",
        "verification_report",
      ]);
      expectPathFreeHandles(gateArtifacts);
      const verificationHandle = gate.packet.verification_artifact;
      const verification = runArtifact(
        input.projectRoot,
        input.kbRoot,
        promotionRunId,
        verificationHandle
      ).body;
      expect(verification).toMatchObject({
        artifact_kind: "verification_report",
        verified: true,
        page_revisions: [savedPage],
        targets: [
          {
            capability_id: target.capabilityId,
            preimage_sha256: sha256(targetBefore),
          },
        ],
        findings: [],
      });

      expect(publicationSnapshot(input.kbRoot)).toEqual(beforePromote);
      expect(
        requireValue(
          readSelectedGeneration(input.kbRoot),
          "apps/orchestration/tests/kb-e2e-prepare.test.ts:1243"
        ).selector.generation_id
      ).toBe(selectedBeforePromote);
      expect(readFileSync(target.targetPath)).toEqual(targetBefore);
      expect(readdirSync(target.targetRoot).sort()).toEqual(targetListingBefore);
      const capabilityStore = new CapabilityStore(input.projectRoot);
      try {
        expect(capabilityStore.lease(target.capabilityId)?.state).toBe("claimed");
      } finally {
        capabilityStore.close();
      }

      expect(() => respond(promotionStack, "approve")).toThrow(/host-only|not implemented/i);
      expect(approval.gateForRun(promotionRunId)?.state).toBe("awaiting");
      approval.close();
      expect(publicationSnapshot(input.kbRoot)).toEqual(beforePromote);
      expect(readFileSync(target.targetPath)).toEqual(targetBefore);
      expect(readdirSync(target.targetRoot).sort()).toEqual(targetListingBefore);
    } finally {
      closeStack(promotionStack);
    }
  });

  it("routes a host-authenticated refine back to compose without publishing", async () => {
    const input = fixture("refine");
    const { stack, capabilityId } = await startIngest(input, "refine");
    try {
      expect(stack.directive.action).toBe("await_user");
      const atGate = publicationSnapshot(input.kbRoot);
      const generationAtGate = requireValue(
        readSelectedGeneration(input.kbRoot),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:1272"
      ).selector.generation_id;
      const next = respond(stack, "refine");
      expect(next.action).toBe("invoke_agent");
      if (next.action === "invoke_agent") expect(next.state_id).toBe("compose");
      expect(
        requireValue(
          readSelectedGeneration(input.kbRoot),
          "apps/orchestration/tests/kb-e2e-prepare.test.ts:1276"
        ).selector.generation_id
      ).toBe(generationAtGate);
      expect(publicationSnapshot(input.kbRoot)).toEqual(atGate);
      expect(stack.checkpointer.contentReviewForRun(stack.runId)?.state).toBe("refined");
      const store = new CapabilityStore(input.projectRoot);
      try {
        expect(store.lease(capabilityId)?.state).toBe("claimed");
      } finally {
        store.close();
      }
    } finally {
      closeStack(stack);
    }
  });

  it("routes a host-authenticated deny to an honest terminal without publishing", async () => {
    const input = fixture("deny");
    const { stack, capabilityId } = await startIngest(input, "deny");
    try {
      expect(stack.directive.action).toBe("await_user");
      const atGate = publicationSnapshot(input.kbRoot);
      const generationAtGate = requireValue(
        readSelectedGeneration(input.kbRoot),
        "apps/orchestration/tests/kb-e2e-prepare.test.ts:1296"
      ).selector.generation_id;
      const denied = respond(stack, "deny");
      expect(denied.action).toBe("incomplete");
      expect(terminalResult(denied)).toMatchObject({
        met: false,
        kb_profile_id: PROFILE,
        review_decision: "deny",
      });
      expect(
        requireValue(
          readSelectedGeneration(input.kbRoot),
          "apps/orchestration/tests/kb-e2e-prepare.test.ts:1304"
        ).selector.generation_id
      ).toBe(generationAtGate);
      expect(publicationSnapshot(input.kbRoot)).toEqual(atGate);
      expect(stack.checkpointer.contentReviewForRun(stack.runId)?.state).toBe("denied");
      const store = new CapabilityStore(input.projectRoot);
      try {
        expect(store.lease(capabilityId)?.state).toBe("invalidated");
      } finally {
        store.close();
      }
    } finally {
      closeStack(stack);
    }
  });
});
