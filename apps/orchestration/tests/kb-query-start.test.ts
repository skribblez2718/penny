import { parseJson, requireRecord, requireValue } from "./helpers/narrowing.js";
/**
 * G8 — engine-owned `query` start and grounding (§5.6) end-to-end.
 *
 * Acceptance under test:
 *
 * - every query run is addressable through the shared checkpointer; there is
 *   no KB-side run store;
 * - the request body lives only in durable private-input custody and reaches
 *   Synthia/Vera only through host-closed readers, never control DB/events or
 *   opening prompts;
 * - default-true requests run purpose-built Synthia synthesis then Vera
 *   citation verification with deterministic fixtures and no live model;
 * - only a cited complete/met answer with a passing closed report creates the
 *   single-use save claim; failed reports are complete/met:false and claimless;
 * - explicit `verify_grounding:false` remains deterministic, visibly
 *   unverified, unsaveable, and parent-delivery-ineligible;
 * - idempotent replay, status/recover, path-free handles, and private-input
 *   settlement remain exact and body-free.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  Checkpointer,
  StartAdmissionMismatchError,
  canonicalJson,
  sha256,
} from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { OrchestrationEngine } from "../src/engine.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { OrchestrationService } from "../src/service.js";
import { initializePennyState } from "../src/state/index.js";
import {
  materializeRunInput,
  privateInputRoot,
  readRunInput,
  settleRunInput,
} from "../src/private-inputs.js";
import type { Directive } from "../src/contracts.js";
import { initKb, queryKb } from "../src/kb/workflows.js";
import {
  pageClaimsPath,
  pageMarkdownPath,
  readPolicy,
  writePolicy,
  writePageRevision,
  writeSourceObject,
  writeSourceRecord,
} from "../src/kb/filesystem.js";
import {
  buildCatalog,
  buildGenerationIndex,
  newGenerationId,
  publishGeneration,
} from "../src/kb/generations.js";
import { SaveQueryClaimStore, saveClaimStoreDir } from "../src/kb/save-claim.js";
import { RunArtifactStore } from "../src/kb/run-artifacts.js";
import { KbWorkerClient } from "../src/kb/kb-worker-client.js";
import { KbQueryReader } from "../src/kb/query-reader.js";
import { createTestOnlyArtifactBodyRunner, kbSessionSpec } from "../src/kb/session-tools.js";
import { computeRequestSha256, validateQueryRequest } from "../src/kb/parent-delivery.js";
import {
  ReadPhaseBriefResultSchema,
  ReadRunArtifactResultSchema,
  SearchSelectedKbResultSchema,
  sha256Hex,
  validateKbContract,
  type KbManifest,
  type PageRevisionFrontmatter,
  type QueryKbRequest,
} from "../src/kb/contracts.js";
import { kbArtifactControl } from "./fixtures/kb-artifact-control.js";
import { installGrantedProfile } from "./fixtures/kb-profile-fixture.js";

const PROFILE = "kbp_qstart";
const SESSION = "sess_qstart";
const E2E_PARENT = { provider: "ollama", model: "qwen327b:latest" };
/** Distinctive body: its absence from control state is the assertion. */
const QUERY_BODY = "quorum acknowledgement when the chair abstains — PRIVATE-QUERY 4b7e21";
const SOURCE_BODY =
  "The quorum rule requires two of three acknowledgements when the chair abstains. PRIVATE-SOURCE 6c81af";
const NOW = "2026-01-01T00:00:00Z";

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(path.join(tmpdir(), "penny-kb-qstart-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function installKbWithPage(projectRoot: string): { kbRoot: string; kbId: string } {
  const kbRoot = path.join(projectRoot, "private-kb");
  installGrantedProfile({ projectRoot, kbRoot, profileId: PROFILE, sessionId: SESSION });
  const ctx = { kbRoot, profileId: PROFILE, runId: "qstart-init" };
  const init = initKb(ctx, "Query-start KB");
  if (init.status !== "complete" || init.kb_id === undefined) {
    throw new Error("query-start KB fixture did not initialize");
  }
  const kbId = init.kb_id;

  // The out-of-band policy install §5.3 requires (default-deny until an
  // operator edits the ignored policy; this test performs that host operation).
  const policy = readPolicy(kbRoot);
  writePolicy(kbRoot, {
    ...policy,
    processing_mode: "local_only",
    allowed_parent_models: [{ ...E2E_PARENT, locality: "local" }],
    allowed_child_models: [{ ...E2E_PARENT, locality: "local" }],
  });

  // One published generation with a queryable page: the canonical content
  // plane (page + claims) and the deterministic index over it (§5.10), then
  // the atomic publication + selector.
  const pageBody =
    "## Synthesis\nTwo of three acknowledgements satisfy quorum when the chair abstains.\n\n## Evidence\n- Admitted quorum note.\n\n## Tensions and unknowns\n- None.\n\n## Related\n- None.\n";
  const pageFrontmatter = {
    schema_version: 1,
    page_id: "page_quorum",
    revision_id: "rev_q1",
    kind: "synthesis",
    title: "Quorum rule",
    summary: "Two of three acknowledgements satisfy quorum when the chair abstains.",
    authority: "advisory",
    lifecycle: "validated",
    created_at: NOW,
    derived_from: [],
    related_page_ids: [],
  } satisfies PageRevisionFrontmatter;
  const sourceDigest = sha256Hex(SOURCE_BODY);
  const sourceRecord = {
    schema_version: 1 as const,
    source_id: "source_quorum",
    source_type: "manual" as const,
    captured_at: NOW,
    title: "Quorum note",
    authors: ["Fixture Author"],
    media_type: "text/plain" as const,
    sha256: sourceDigest,
    object_ref: `sources/objects/${sourceDigest}`,
    provenance: {
      source_capability_digest: sha256Hex("fixture-source-capability"),
      supplied_by: "host_capability" as const,
      originating_run_id: "qstart_fixture_ingest",
    },
  };
  writeSourceObject(kbRoot, sourceDigest, Buffer.from(SOURCE_BODY, "utf8"));
  writeSourceRecord(kbRoot, sourceRecord);

  writePageRevision(kbRoot, pageFrontmatter, pageBody, {
    schema_version: 1,
    page_id: "page_quorum",
    revision_id: "rev_q1",
    claims: [
      {
        claim_id: "claim_quorum",
        text: "Two of three acknowledgements satisfy quorum when the chair abstains.",
        kind: "fact",
        state: "supported",
        confidence: "CERTAIN",
        evidence: [{ source_id: "source_quorum" }],
        contradicts_claim_ids: [],
        canonical_verification_refs: [],
      },
    ],
  });
  const generationId = newGenerationId();
  const { index_sha256 } = buildGenerationIndex(kbRoot, generationId, kbId, [
    {
      page_id: "page_quorum",
      revision_id: "rev_q1",
      title: pageFrontmatter.title,
      summary: pageFrontmatter.summary,
      body_sha256: sha256Hex(pageBody),
      body: pageBody,
    },
  ]);
  const catalog = buildCatalog({
    generation_id: generationId,
    kb_id: kbId,
    manifest: {
      schema_version: 1,
      kb_id: kbId,
      title: "Query-start KB",
      authority: "advisory",
      paths: {
        policy: ".kb/policy.json",
        source_records: "sources/records",
        source_objects: "sources/objects",
        pages: "pages",
        conflicts: "conflicts",
        work: "work",
        lock: ".kb/lock",
        generations: ".kb/generations",
        generation_catalog_filename: "catalog.json",
        generation_index_filename: "index.sqlite",
        current: ".kb/current.json",
        root_index: "index.md",
      },
      created_at: NOW,
    } as KbManifest,
    policy: readPolicy(kbRoot),
    pages: [
      {
        page_id: "page_quorum",
        revision_id: "rev_q1",
        page_sha256: sha256Hex(
          readFileSync(pageMarkdownPath(kbRoot, "page_quorum", "rev_q1"), "utf8")
        ),
        claims_sha256: sha256Hex(
          readFileSync(pageClaimsPath(kbRoot, "page_quorum", "rev_q1"), "utf8")
        ),
      },
    ],
    source_records: [
      { source_id: "source_quorum", record_sha256: sha256Hex(canonicalJson(sourceRecord)) },
    ],
    source_objects: [sourceDigest],
    conflicts: [],
    index_sha256,
  });
  publishGeneration(kbRoot, catalog);
  return { kbRoot, kbId };
}

/**
 * An initialized KB with an EMPTY generation.
 * @param allowParent when false the out-of-band policy step is skipped, so
 *   the policy stays default-deny and the parent is refused by §5.3.
 */
function installKbEmpty(projectRoot: string, profileId: string, allowParent: boolean): string {
  const kbRoot = path.join(projectRoot, `private-kb-${profileId}`);
  installGrantedProfile({ projectRoot, kbRoot, profileId, sessionId: SESSION });
  initKb({ kbRoot, profileId, runId: "qstart-init-empty" }, "Query-start empty KB");
  if (allowParent) {
    const policy = readPolicy(kbRoot);
    writePolicy(kbRoot, {
      ...policy,
      processing_mode: "local_only",
      allowed_parent_models: [{ ...E2E_PARENT, locality: "local" }],
      allowed_child_models: [{ ...E2E_PARENT, locality: "local" }],
    });
  }
  return kbRoot;
}

interface Stack {
  projectRoot: string;
  kbRoot: string;
  checkpointer: Checkpointer;
  engine: OrchestrationEngine;
}

function buildStack(projectRoot: string): Stack {
  const dbPath = path.join(projectRoot, ".penny", "orchestration-qstart.db");
  const checkpointer = new Checkpointer(dbPath);
  const engine = new OrchestrationEngine(checkpointer, {
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    projectRoot,
    maxSteps: 8,
    playbookName: "knowledge-base",
  });
  return {
    projectRoot,
    kbRoot: path.join(projectRoot, "private-kb"),
    checkpointer,
    engine,
  };
}

/** The host admission sequence, exactly as the adapter performs it. */
function admitAndMaterialize(
  stack: Stack,
  runId: string,
  request: QueryKbRequest,
  invocationId: string,
  sessionId = SESSION
) {
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: sessionId,
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "Answer the stored private request from the selected generation; advisory only.",
    constraints: {
      action: "query",
      kb_profile_id: PROFILE,
      parent_identity: E2E_PARENT,
    },
    projectRoot: stack.projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
  });
  const transactionId = `tx_${runId}`;
  const admission = stack.checkpointer.admitStartRun(context, {
    session_id: sessionId,
    invocation_id: invocationId,
    request_sha256: computeRequestSha256(request),
    action: "query",
    profile_id: PROFILE,
    transaction_id: transactionId,
    private_input_id: `pri_${runId}`,
    storage_key: `${runId}/request.json`,
    temporary_storage_key: `${runId}/.${transactionId}.tmp`,
  });
  if (admission.kind === "created") {
    materializeRunInput({
      projectRoot: stack.projectRoot,
      checkpointer: stack.checkpointer,
      runId,
      request,
      requestSha256: computeRequestSha256(request),
    });
  }
  return admission;
}

function startRequest(stack: Stack, runId: string, sessionId = SESSION) {
  return {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: sessionId,
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "Answer the stored private request from the selected generation; advisory only.",
    constraints: {
      action: "query",
      kb_profile_id: PROFILE,
      parent_identity: E2E_PARENT,
    },
    project_root: stack.projectRoot,
    trust_profile: "hardened-untrusted",
  } as const;
}

type TerminalDirective = Extract<Directive, { result: Record<string, unknown> }>;

function requireTerminal(directive: Directive): TerminalDirective {
  if ("result" in directive) return directive;
  throw new Error(`qstart: expected a terminal directive, got '${directive.action}'`);
}

function terminalResult(directive: Directive): Record<string, unknown> {
  return requireTerminal(directive).result;
}

function settle(stack: Stack, runId: string, result: Record<string, unknown>) {
  const resultSha = sha256(canonicalJson(result));
  stack.checkpointer.settleStartAdmission(runId, {
    terminal_result_id: `trm_${sha256(canonicalJson({ run_id: runId, result_sha256: resultSha }))}`,
    terminal_result_sha256: resultSha,
  });
  settleRunInput({
    projectRoot: stack.projectRoot,
    checkpointer: stack.checkpointer,
    runId,
  });
}

async function runGroundedQuery(input: {
  projectRoot: string;
  runId: string;
  verificationPasses: boolean;
}) {
  const stateRoot = tmpRoot();
  const stateEnv = {
    ...process.env,
    PENNY_STATE_ROOT: stateRoot,
    PENNY_ARTIFACT_ROOT: undefined,
    PENNY_ORCH_DB: undefined,
    PENNY_ORCH_V2_DB: undefined,
  };
  const state = initializePennyState(input.projectRoot, { env: stateEnv });
  const dbPath = state.paths.orchestration.database;
  const request = validateQueryRequest({
    schema_version: 1,
    action: "query",
    kb_profile_id: PROFILE,
    query: QUERY_BODY,
  });
  const identity = {
    schema_version: 2 as const,
    run_id: input.runId,
    session_id: SESSION,
    playbook: "knowledge-base",
    engine_owner: "typescript" as const,
  };
  const context = RunContext.create({
    identity,
    goal: "Answer the stored private request through grounded query readers; advisory only.",
    constraints: { action: "query", kb_profile_id: PROFILE, parent_identity: E2E_PARENT },
    projectRoot: input.projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
  });
  const custody = new Checkpointer(dbPath);
  custody.admitStartRun(context, {
    session_id: SESSION,
    invocation_id: `call_${input.runId}`,
    request_sha256: computeRequestSha256(request),
    action: "query",
    profile_id: PROFILE,
    transaction_id: `tx_${input.runId}`,
    private_input_id: `pri_${input.runId}`,
    storage_key: `${input.runId}/request.json`,
    temporary_storage_key: `${input.runId}/.tx_${input.runId}.tmp`,
  });
  materializeRunInput({
    projectRoot: input.projectRoot,
    checkpointer: custody,
    runId: input.runId,
    request,
    requestSha256: computeRequestSha256(request),
  });
  custody.close();

  const phases: string[] = [];
  const phaseBriefs: string[] = [];
  const serviceSlot: { current?: OrchestrationService } = {};
  const queryReader = new KbQueryReader({
    kbRoot: path.join(input.projectRoot, "private-kb"),
    profileId: PROFILE,
    readRequest: () =>
      readRunInput({
        projectRoot: input.projectRoot,
        checkpointer: requireValue(serviceSlot.current, "query service").checkpointer,
        runId: input.runId,
      }),
    selectedGenerationId: () =>
      String(
        requireValue(serviceSlot.current, "query service").checkpointer.loadRunById(input.runId)
          ?.playbookData.selected_generation_id ?? ""
      ),
  });
  const worker = new KbWorkerClient({
    projectRoot: input.projectRoot,
    kbRoot: path.join(input.projectRoot, "private-kb"),
    runId: input.runId,
    sessionId: SESSION,
    profileId: PROFILE,
    operation: "query",
    sourceCapabilityIds: [],
    admittedPolicySha256: () =>
      String(
        requireValue(serviceSlot.current, "query service").checkpointer.loadRunById(input.runId)
          ?.playbookData.admitted_policy_sha256 ?? ""
      ),
    queryReader,
    testOnlyAgentRunner: createTestOnlyArtifactBodyRunner(async (invocation) => {
      phases.push(invocation.stateId);
      phaseBriefs.push(invocation.phaseBrief);
      expect(invocation.phaseBrief).not.toContain(QUERY_BODY);
      expect(invocation.phaseBrief).not.toContain(SOURCE_BODY);
      const privateBriefText = invocation.readPhaseBrief?.() ?? "{}";
      expect(privateBriefText).toContain(QUERY_BODY);
      const privateBrief = validateKbContract(
        ReadPhaseBriefResultSchema,
        parseJson(privateBriefText),
        "query-start private phase brief"
      );
      expect(Object.keys(privateBrief).sort()).toEqual([
        "allowed_prior_artifacts",
        "allowed_selected_pages",
        "brief",
        "run_id",
        "schema_version",
        "state_id",
      ]);
      expect(Object.keys(privateBrief.brief).sort()).toEqual([
        "action",
        "max_candidates",
        "page_ids",
        "query",
        "source_ids",
        "verify_grounding",
      ]);
      expect(privateBriefText).not.toContain("expected_artifact_kind");
      expect(privateBriefText).not.toContain("task");
      const search = validateKbContract(
        SearchSelectedKbResultSchema,
        parseJson(invocation.searchSelectedKb?.() ?? "{}"),
        "query-start selected KB search"
      );
      expect(search.candidates[0]?.page_id).toBe("page_quorum");
      expect(invocation.readSelectedPage?.("page_quorum", "rev_q1")).toContain("claim_quorum");
      expect(invocation.readSelectedSource?.("source_quorum")).toContain("PRIVATE-SOURCE 6c81af");
      if (invocation.stateId === "query") {
        return JSON.stringify({
          schema_version: 1,
          artifact_kind: "query_answer",
          answer: {
            authority: "advisory",
            text: "Two of three acknowledgements satisfy quorum when the chair abstains.",
            citations: [
              {
                kind: "claim",
                page_id: "page_quorum",
                revision_id: "rev_q1",
                claim_id: "claim_quorum",
              },
            ],
            contradictions: [],
            unknowns: [],
            canonical_verification_required: true,
          },
        });
      }
      const prior = invocation.allowedPriorArtifacts?.[0];
      expect(prior).toBeDefined();
      const priorRead = validateKbContract(
        ReadRunArtifactResultSchema,
        parseJson(
          invocation.readRunArtifact?.(
            requireValue(prior, "apps/orchestration/tests/kb-query-start.test.ts:508").artifact_id
          ) ?? "{}"
        ),
        "query-start prior artifact"
      );
      expect(JSON.stringify(priorRead.payload)).toContain("claim_quorum");
      expect(priorRead.artifact).toMatchObject({
        artifact_id: requireValue(prior, "apps/orchestration/tests/kb-query-start.test.ts:514")
          .artifact_id,
        sha256: requireValue(prior, "apps/orchestration/tests/kb-query-start.test.ts:515").sha256,
      });
      return JSON.stringify({
        schema_version: 1,
        artifact_kind: "verification_report",
        passed: input.verificationPasses,
        answer_artifact_id: requireValue(
          prior,
          "apps/orchestration/tests/kb-query-start.test.ts:521"
        ).artifact_id,
        answer_sha256: requireValue(prior, "apps/orchestration/tests/kb-query-start.test.ts:522")
          .sha256,
        answer_verdict: input.verificationPasses ? "supported" : "unsupported",
        citation_findings: [
          {
            citation: {
              kind: "claim",
              page_id: "page_quorum",
              revision_id: "rev_q1",
              claim_id: "claim_quorum",
            },
            verdict: input.verificationPasses ? "supported" : "unsupported",
            notes: input.verificationPasses
              ? "The selected source directly states the quorum rule."
              : "The citation was not accepted as support.",
          },
        ],
      });
    }),
  });
  const service = new OrchestrationService({
    projectRoot: input.projectRoot,
    env: stateEnv,
    playbookName: "knowledge-base",
    modelClient: worker,
  });
  serviceSlot.current = service;
  try {
    const directive = await service.execute({
      schema_version: 2,
      action: "start",
      identity,
      goal: "Answer the stored private request through grounded query readers; advisory only.",
      constraints: { action: "query", kb_profile_id: PROFILE, parent_identity: E2E_PARENT },
      project_root: input.projectRoot,
      trust_profile: "hardened-untrusted",
    });
    return { directive, phases, phaseBriefs, service, worker };
  } catch (error) {
    service.close();
    worker.close();
    throw error;
  }
}

describe("engine-owned query start (§5.6)", () => {
  it("registers the purpose-built query readers without putting the request in the opening", () => {
    const spec = kbSessionSpec({
      invocation: {
        agent: "synthia",
        stateId: "query",
        runId: "run_query_tools",
        profileId: PROFILE,
        expectedArtifactKind: "query_answer",
        phaseBrief: "Execute the query through host-closed readers.",
        readPhaseBrief: () => canonicalJson({ query: QUERY_BODY }),
        sourceAllowlist: [],
        priorPhaseAllowlist: [],
        allowedPriorArtifacts: [],
        readSource: () => {
          throw new Error("no admitted ingest source");
        },
        readRunArtifact: () => {
          throw new Error("no prior artifact");
        },
        searchSelectedKb: () => canonicalJson({ candidates: [] }),
        readSelectedPage: () => "selected page body",
        stageArtifact: () => ({
          schema_version: 1,
          artifact_id: "art_1234567890abcdef1234567890abcdef",
          artifact_kind: "query_answer",
          sha256: sha256Hex("{}"),
          media_type: "application/json",
          byte_length: 2,
        }),
        submitPhaseResult: (result) => canonicalJson(result),
      },
      cognitiveFrame: "Cognitive frame.",
      phaseGuidance: "Use the query readers and submit one typed result.",
    });
    expect(spec.noTools).toBe("all");
    expect(spec.tools).toEqual([
      "read_phase_brief",
      "search_selected_kb",
      "read_selected_page",
      "stage_run_artifact",
      "submit_phase_result",
    ]);
    const customTools = spec.customTools;
    if (customTools === undefined) throw new Error("query session registered no custom tools");
    expect(customTools.map((tool) => tool.name)).toEqual(spec.tools);
    expect(spec.opening).not.toContain(QUERY_BODY);
    expect(spec.opening).not.toContain(SOURCE_BODY);
  });

  it("runs a status-addressable deterministic query with the body outside control state", () => {
    const projectRoot = tmpRoot();
    installKbWithPage(projectRoot);
    const stack = buildStack(projectRoot);
    const request = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: QUERY_BODY,
      verify_grounding: false,
    });
    const runId = "qstart_run_1";
    const admission = admitAndMaterialize(stack, runId, request, "call-1");
    expect(admission.kind).toBe("created");

    // Engine-owned start: the admitted branch drives the playbook step.
    const directive = stack.engine.handle(startRequest(stack, runId));
    const terminal = requireTerminal(directive);
    const result = terminal.result;
    expect(directive.action).toBe("complete");
    expect(terminal.met).toBe(true);
    expect(result["public_status"]).toBe("complete");
    expect(result["candidate_count"]).toBeGreaterThanOrEqual(1);
    expect(result["kb_id"]).toBeTruthy();
    const handle = requireRecord(result["answer_handle"], "query-start answer handle");
    expect(handle["artifact_kind"]).toBe("query_answer");
    expect(typeof handle["artifact_id"]).toBe("string");
    expect(typeof handle["sha256"]).toBe("string");
    // Path-free: no locator of any kind in the handle.
    expect(handle["path"]).toBeUndefined();
    expect(handle["relative_path"]).toBeUndefined();
    expect(stack.checkpointer.completionAdmission(runId)).toMatchObject({
      origin_state: "intake",
      latest_product: { selector: "terminal_result" },
      evidence_refs: [
        {
          kind: "kb_artifact",
          reference_id: handle["artifact_id"],
          sha256: handle["sha256"],
        },
      ],
    });

    // Terminal settlement: idempotency record terminal + exact bytes discarded.
    settle(stack, runId, result);
    expect(stack.checkpointer.getPrivateInput(runId)?.state).toBe("discarded");
    expect(existsSync(path.join(privateInputRoot(projectRoot), runId, "request.json"))).toBe(false);

    // STATUS-ADDRESSABLE: a fresh handle sees the durable run; the engine's
    // status and recover both replay the exact terminal directive.
    stack.checkpointer.close();
    const reopened = new Checkpointer(path.join(projectRoot, ".penny", "orchestration-qstart.db"));
    const reopenedEngine = new OrchestrationEngine(reopened, {
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      projectRoot,
      maxSteps: 8,
      playbookName: "knowledge-base",
    });
    const status = requireTerminal(
      reopenedEngine.handle({
        schema_version: 2,
        action: "status",
        identity: {
          schema_version: 2,
          run_id: runId,
          session_id: SESSION,
          playbook: "knowledge-base",
          engine_owner: "typescript",
        },
      })
    );
    expect(status.action).toBe("complete");
    expect(status.met).toBe(true);
    expect(status.result).toEqual(result);
    const recovered = requireTerminal(
      reopenedEngine.handle({
        schema_version: 2,
        action: "recover",
        identity: {
          schema_version: 2,
          run_id: runId,
          session_id: SESSION,
          playbook: "knowledge-base",
          engine_owner: "typescript",
        },
      })
    );
    expect(recovered.action).toBe("complete");
    expect(recovered.met).toBe(true);

    // The body is in NO control-db file, snapshot, or event payload.
    const run = reopened.loadRunById(runId);
    expect(run).toBeDefined();
    expect(
      canonicalJson(
        requireValue(run, "apps/orchestration/tests/kb-query-start.test.ts:692").snapshot()
      )
    ).not.toContain(QUERY_BODY);
    for (const event of reopened.events(runId)) {
      expect(canonicalJson(event.payload)).not.toContain(QUERY_BODY);
    }
    reopened.close();
    const allDbBytes = ((): string => {
      const base = path.join(projectRoot, ".penny", "orchestration-qstart.db");
      const parts: string[] = [];
      for (const suffix of ["", "-wal", "-shm"]) {
        const f = `${base}${suffix}`;
        if (existsSync(f)) parts.push(readFileSync(f, "latin1"));
      }
      return parts.join("\u0000");
    })();
    expect(allDbBytes).not.toContain(QUERY_BODY);
  });

  it("runs default-true queries through Synthia then Vera and claims only a passing answer", async () => {
    const projectRoot = tmpRoot();
    installKbWithPage(projectRoot);
    const runId = "qstart_grounded_pass";
    const { directive, phases, phaseBriefs, service, worker } = await runGroundedQuery({
      projectRoot,
      runId,
      verificationPasses: true,
    });
    try {
      expect(phases).toEqual(["query", "verify"]);
      expect(phaseBriefs.join("\n")).not.toContain(QUERY_BODY);
      expect(phaseBriefs.join("\n")).not.toContain(SOURCE_BODY);
      expect(directive.action).toBe("complete");
      const terminal = requireTerminal(directive);
      expect(terminal.met).toBe(true);
      expect(terminal.result["grounding_verified"]).toBe(true);
      expect(terminal.result["verification_artifact_id"]).toMatch(/^art_/);
      expect(service.checkpointer.completionAdmission(runId)).toMatchObject({
        origin_state: "verify",
        evidence_refs: [
          { kind: "kb_artifact" },
          { kind: "kb_artifact" },
          { kind: "kb_phase_result" },
          { kind: "kb_phase_result" },
        ],
      });
      const claim = new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, PROFILE)).load(runId);
      expect(claim.state).toBe("available");
      expect(claim.answer_artifact_id).toBe(terminal.result["answer_artifact_id"]);
      const run = service.checkpointer.loadRunById(runId);
      expect(
        canonicalJson(
          requireValue(run, "apps/orchestration/tests/kb-query-start.test.ts:734").snapshot()
        )
      ).not.toContain(QUERY_BODY);
      expect(
        canonicalJson(
          requireValue(run, "apps/orchestration/tests/kb-query-start.test.ts:735").snapshot()
        )
      ).not.toContain(SOURCE_BODY);
      for (const event of service.checkpointer.events(runId)) {
        expect(canonicalJson(event.payload)).not.toContain(QUERY_BODY);
        expect(canonicalJson(event.payload)).not.toContain(SOURCE_BODY);
      }
      const controlBytes = ["", "-wal", "-shm"]
        .map((suffix) => path.join(projectRoot, ".penny", `${runId}.db${suffix}`))
        .filter(existsSync)
        .map((file) => readFileSync(file, "latin1"))
        .join("\u0000");
      expect(controlBytes).not.toContain(QUERY_BODY);
      expect(controlBytes).not.toContain(SOURCE_BODY);
    } finally {
      service.close();
      worker.close();
    }
  });

  it("completes met:false and creates no claim when Vera's citation report fails", async () => {
    const projectRoot = tmpRoot();
    installKbWithPage(projectRoot);
    const runId = "qstart_grounded_fail";
    const { directive, phases, service, worker } = await runGroundedQuery({
      projectRoot,
      runId,
      verificationPasses: false,
    });
    try {
      expect(phases).toEqual(["query", "verify"]);
      expect(directive.action).toBe("incomplete");
      const terminal = requireTerminal(directive);
      expect(terminal.met).toBe(false);
      expect(terminal.result["public_status"]).toBe("complete");
      expect(terminal.result["grounding_verified"]).toBe(false);
      expect(terminal.result["warnings"]).toContain("grounding_verification_failed");
      expect(new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, PROFILE)).find(runId)).toBe(
        undefined
      );
    } finally {
      service.close();
      worker.close();
    }
  });

  it("replays the original run on the same invocation without a second side effect", () => {
    const projectRoot = tmpRoot();
    installKbWithPage(projectRoot);
    const stack = buildStack(projectRoot);
    const request = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: QUERY_BODY,
      verify_grounding: false,
    });
    const runId = "qstart_idem_1";
    admitAndMaterialize(stack, runId, request, "call-2");
    const first = stack.engine.handle(startRequest(stack, runId));
    const firstResult = terminalResult(first);
    settle(stack, runId, firstResult);

    // Explicitly unverified deterministic answers have no save authority.
    const claimStore = new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, PROFILE));
    expect(claimStore.find(runId)).toBeUndefined();

    // Same session+invocation+digest, a fresh run id the host would mint:
    // the ORIGINAL run is replayed with no second side effect.
    const retryAdmission = admitAndMaterialize(stack, "qstart_idem_1_retry", request, "call-2");
    expect(retryAdmission).toEqual({ kind: "replay", run_id: runId });
    expect(stack.checkpointer.runExists("qstart_idem_1_retry")).toBe(false);

    const retried = requireTerminal(stack.engine.handle(startRequest(stack, runId)));
    expect(retried.action).toBe("complete");
    expect(retried.result).toEqual(firstResult);
    // No second side effect: the deterministic replay still created no claim.
    const claimAgain = new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, PROFILE));
    expect(claimAgain.find(runId)).toBeUndefined();

    // The public result never carries the body either.
    expect(canonicalJson(firstResult)).not.toContain(QUERY_BODY);
    stack.checkpointer.close();
  });

  it("is `idempotency_mismatch` for the same invocation with a different digest", () => {
    const projectRoot = tmpRoot();
    installKbWithPage(projectRoot);
    const stack = buildStack(projectRoot);
    const request = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: QUERY_BODY,
      verify_grounding: false,
    });
    const runId = "qstart_mis_1";
    admitAndMaterialize(stack, runId, request, "call-3");
    stack.engine.handle(startRequest(stack, runId));

    const mutated = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: "a different private query for the same invocation 9d11ef",
      verify_grounding: false,
    });
    let error: unknown = null;
    try {
      const context = RunContext.create({
        identity: {
          schema_version: 2,
          run_id: "qstart_mis_1_retry",
          session_id: SESSION,
          playbook: "knowledge-base",
          engine_owner: "typescript",
        },
        goal: "retry",
        constraints: { action: "query", kb_profile_id: PROFILE, parent_identity: E2E_PARENT },
        projectRoot: stack.projectRoot,
        trustProfile: "hardened-untrusted",
        maxSteps: 8,
      });
      stack.checkpointer.admitStartRun(context, {
        session_id: SESSION,
        invocation_id: "call-3",
        request_sha256: computeRequestSha256(mutated),
        action: "query",
        profile_id: PROFILE,
        transaction_id: "tx_mis_retry",
        private_input_id: "pri_mis_retry",
        storage_key: "qstart_mis_1_retry/request.json",
        temporary_storage_key: "qstart_mis_1_retry/.tx_mis_retry.tmp",
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(StartAdmissionMismatchError);
    expect(stack.checkpointer.runExists("qstart_mis_1_retry")).toBe(false);
    // The original run is untouched and still addressable.
    const status = stack.engine.handle({
      schema_version: 2,
      action: "status",
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: SESSION,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
    });
    expect(status.action).toBe("complete");
    stack.checkpointer.close();
  });

  it("projects an unmet-but-finished query as §5.6 complete/met:false and creates no claim", () => {
    const projectRoot = tmpRoot();
    installKbEmpty(projectRoot, "kbp_qstart_empty", true);
    const dbPath = path.join(projectRoot, ".penny", "orchestration-qstart.db");
    const checkpointer = new Checkpointer(dbPath);
    const engine = new OrchestrationEngine(checkpointer, {
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      projectRoot,
      maxSteps: 8,
      playbookName: "knowledge-base",
    });
    // The KB admits the parent but has NO pages: the flow finishes, the
    // retrieval is empty, and the §5.6 projection is complete/met:false.
    const request = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: "kbp_qstart_empty",
      query: "xylophone maintenance schedule for brass wind instruments 77aa02",
      verify_grounding: false,
    });
    const runId = "qstart_unmet_1";
    const context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: SESSION,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "stored private request",
      constraints: {
        action: "query",
        kb_profile_id: "kbp_qstart_empty",
        parent_identity: E2E_PARENT,
      },
      projectRoot,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
    });
    checkpointer.admitStartRun(context, {
      session_id: SESSION,
      invocation_id: "call-4",
      request_sha256: computeRequestSha256(request),
      action: "query",
      profile_id: "kbp_qstart_empty",
      transaction_id: "tx_unmet",
      private_input_id: "pri_unmet",
      storage_key: `${runId}/request.json`,
      temporary_storage_key: `${runId}/.tx_unmet.tmp`,
    });
    materializeRunInput({
      projectRoot,
      checkpointer,
      runId,
      request,
      requestSha256: computeRequestSha256(request),
    });
    const directive = requireTerminal(
      engine.handle({
        schema_version: 2,
        action: "start",
        identity: {
          schema_version: 2,
          run_id: runId,
          session_id: SESSION,
          playbook: "knowledge-base",
          engine_owner: "typescript",
        },
        goal: "stored private request",
        constraints: {
          action: "query",
          kb_profile_id: "kbp_qstart_empty",
          parent_identity: E2E_PARENT,
        },
        project_root: projectRoot,
        trust_profile: "hardened-untrusted",
      })
    );
    // Engine truth met:false; the §5.6 PUBLIC projection is `complete`/`met:false`.
    expect(directive.met).toBe(false);
    expect(directive.result["public_status"]).toBe("complete");
    expect(directive.result["candidate_count"]).toBe(0);

    // Status mirrors it: addressable, unmet, public `complete`.
    const status = requireTerminal(
      engine.handle({
        schema_version: 2,
        action: "status",
        identity: {
          schema_version: 2,
          run_id: runId,
          session_id: SESSION,
          playbook: "knowledge-base",
          engine_owner: "typescript",
        },
      })
    );
    expect(status.action).toBe(directive.action);
    expect(status.met).toBe(false);

    // No useful answer, no claim: a save naming this run must have nothing to claim.
    const claimStore = new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, "kbp_qstart_empty"));
    expect(claimStore.find(runId)).toBeUndefined();
    checkpointer.close();
  });

  it("refuses a policy-denied query durably as public `refused`, body-free and addressable", () => {
    const projectRoot = tmpRoot();
    // Default-deny policy: the active parent identity is not allowed, so §5.3
    // admission refuses BEFORE any private body read.
    installKbEmpty(projectRoot, "kbp_qstart_refused", false);
    const dbPath = path.join(projectRoot, ".penny", "orchestration-qstart.db");
    const checkpointer = new Checkpointer(dbPath);
    const engine = new OrchestrationEngine(checkpointer, {
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      projectRoot,
      maxSteps: 8,
      playbookName: "knowledge-base",
    });
    const request = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: "kbp_qstart_refused",
      query: "any private body 3c91de",
      verify_grounding: false,
    });
    const runId = "qstart_ref_1";
    const context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: SESSION,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "stored private request",
      constraints: {
        action: "query",
        kb_profile_id: "kbp_qstart_refused",
        parent_identity: E2E_PARENT,
      },
      projectRoot,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
    });
    checkpointer.admitStartRun(context, {
      session_id: SESSION,
      invocation_id: "call-5",
      request_sha256: computeRequestSha256(request),
      action: "query",
      profile_id: "kbp_qstart_refused",
      transaction_id: "tx_ref_1",
      private_input_id: "pri_ref_1",
      storage_key: `${runId}/request.json`,
      temporary_storage_key: `${runId}/.tx_ref_1.tmp`,
    });
    materializeRunInput({
      projectRoot,
      checkpointer,
      runId,
      request,
      requestSha256: computeRequestSha256(request),
    });
    // The refusal is a DURABLE terminal, not an exception: the run stays
    // addressable and the public projection says `refused`.
    const directive = requireTerminal(
      engine.handle({
        schema_version: 2,
        action: "start",
        identity: {
          schema_version: 2,
          run_id: runId,
          session_id: SESSION,
          playbook: "knowledge-base",
          engine_owner: "typescript",
        },
        goal: "stored private request",
        constraints: {
          action: "query",
          kb_profile_id: "kbp_qstart_refused",
          parent_identity: E2E_PARENT,
        },
        project_root: projectRoot,
        trust_profile: "hardened-untrusted",
      })
    );
    expect(directive.met).toBe(false);
    expect(directive.result["public_status"]).toBe("refused");

    // Settlement discards the private body even though the run refused.
    settleRunInput({ projectRoot, checkpointer, runId });
    expect(checkpointer.getPrivateInput(runId)?.state).toBe("discarded");

    // Status mirrors the refusal durably.
    const status = requireTerminal(
      engine.handle({
        schema_version: 2,
        action: "status",
        identity: {
          schema_version: 2,
          run_id: runId,
          session_id: SESSION,
          playbook: "knowledge-base",
          engine_owner: "typescript",
        },
      })
    );
    expect(status.action).toBe(directive.action);
    expect(status.met).toBe(false);

    // The body is nowhere in control state.
    const run = checkpointer.loadRunById(runId);
    expect(
      canonicalJson(
        requireValue(run, "apps/orchestration/tests/kb-query-start.test.ts:1106").snapshot()
      )
    ).not.toContain("any private body 3c91de");
    checkpointer.close();
  });

  it("keeps the query run's answer artifact sealed and readable under the run's own index", () => {
    const projectRoot = tmpRoot();
    installKbWithPage(projectRoot);
    const stack = buildStack(projectRoot);
    const request = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: QUERY_BODY,
      verify_grounding: false,
    });
    const runId = "qstart_seal_1";
    admitAndMaterialize(stack, runId, request, "call-6");
    const terminal = requireTerminal(stack.engine.handle(startRequest(stack, runId)));
    const handle = requireRecord(terminal.result["answer_handle"], "sealed answer handle");
    const store = new RunArtifactStore(stack.kbRoot, runId, stack.checkpointer);
    const { handle: checked, content } = store.read(String(handle["artifact_id"]));
    store.close();
    expect(checked.artifact_id).toBe(String(handle["artifact_id"]));
    expect(checked.artifact_kind).toBe("query_answer");
    const doc = requireRecord(
      parseJson(content),
      "apps/orchestration/tests/kb-query-start.test.ts:1133"
    );
    expect(doc["artifact_kind"]).toBe("query_answer");
    expect(doc["answer"]).toBeTruthy();
    // The request body is not copied into the answer artifact or control state.
    expect(content).not.toContain(QUERY_BODY);
    const run = stack.checkpointer.loadRunById(runId);
    expect(
      canonicalJson(
        requireValue(run, "apps/orchestration/tests/kb-query-start.test.ts:1138").snapshot()
      )
    ).not.toContain(QUERY_BODY);
    stack.checkpointer.close();
  });

  it("keeps deterministic verify_grounding:false results explicitly unverified and unsaveable", () => {
    const projectRoot = tmpRoot();
    installKbWithPage(projectRoot);
    const kbRoot = path.join(projectRoot, "private-kb");
    const checkpointer = kbArtifactControl({
      root: projectRoot,
      runId: "qstart_unverified_direct",
      profileId: PROFILE,
      action: "query",
    });
    const result = queryKb(
      {
        kbRoot,
        profileId: PROFILE,
        runId: "qstart_unverified_direct",
        checkpointer,
      },
      "quorum acknowledgement chair",
      { verifyGrounding: false }
    );
    expect(result.met).toBe(true);
    expect(result.warnings).toContain("grounding_not_verified");
    expect(
      new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, PROFILE)).find(
        "qstart_unverified_direct"
      )
    ).toBeUndefined();
  });

  it("does not regress the direct workflow surface (queryKb remains the canonical machine)", () => {
    const projectRoot = tmpRoot();
    installKbWithPage(projectRoot);
    const kbRoot = path.join(projectRoot, "private-kb");
    const checkpointer = kbArtifactControl({
      root: projectRoot,
      runId: "qstart_direct",
      profileId: PROFILE,
      action: "query",
    });
    const q = queryKb(
      { kbRoot, profileId: PROFILE, runId: "qstart_direct", checkpointer },
      "quorum acknowledgement chair",
      { verifyGrounding: false }
    );
    expect(q.met).toBe(true);
    expect(q.artifacts[0]?.artifact_kind).toBe("query_answer");
  });
});
