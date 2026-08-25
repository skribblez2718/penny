import {
  parseJson,
  requireRecord,
  requireRecordArray,
  requireString,
  requireValue,
} from "../tests/helpers/narrowing.js";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer, type CheckpointObservation } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import type { Directive } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import {
  contentFreeSessionProtocolErrorRecord,
  type AgentSessionTraceRecordV1,
} from "../src/model-client.js";
import {
  materializeRunInput,
  readRunInput,
  settleRunInput,
  verifyAndSettleTerminalStart,
} from "../src/private-inputs.js";
import { initializePennyState } from "../src/state/index.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";
import { scoreAnswerQuality, type AnswerQualityCaseObservation } from "../src/kb/answer-quality.js";
import {
  canonicalJson,
  QueryAnswerArtifactSchema,
  QueryVerificationReportSchema,
  sha256Hex,
  validateKbContract,
  type ClaimsSidecar,
  type PageRevisionFrontmatter,
  type QueryAnswerArtifact,
  type QueryVerificationReport,
} from "../src/kb/contracts.js";
import {
  generationCatalogPath,
  generationIndexPath,
  pageClaimsPath,
  pageMarkdownPath,
  readManifest,
  readPolicy,
  writePageRevision,
  writePolicy,
} from "../src/kb/filesystem.js";
import { buildCatalog, buildGenerationIndex, publishGeneration } from "../src/kb/generations.js";
import { parseRetrievalFixture } from "../src/kb/gate-decisions.js";
import { KbWorkerClient } from "../src/kb/kb-worker-client.js";
import { validateQueryRequest } from "../src/kb/parent-delivery.js";
import { KbSessionProfileGrantStore } from "../src/kb/profile-grants.js";
import { KbQueryReader } from "../src/kb/query-reader.js";
import { assessQueryVerification } from "../src/kb/query-verification.js";
import { RunArtifactStore } from "../src/kb/run-artifacts.js";
import { KB_PHASE_TOOL_MATRIX } from "../src/kb/session-tools.js";
import { initKb } from "../src/kb/workflows.js";
import {
  G8_SMOKE_MANIFEST_PATH,
  g8SmokeCohortIssueCodes,
  g8SmokeScheduledPairs,
  loadG8SmokeCohortManifest,
  resolveG8SmokeResultPath,
  resolveG8SmokeResultShaPath,
  validateG8SmokeResultReceipt,
  type G8SmokeCohortManifest,
  type G8SmokePairReceipt,
  type G8SmokeResultReceipt,
} from "./kb-model-smoke-contract.js";

const GATE_ENV = "PENNY_KB_MODEL_SMOKE";
const MODEL_IDENTITY = { provider: "ollama", model: "qwen3.8:latest", locality: "local" } as const;
const PROFILE = "kbp_model_smoke";
const SESSION = "sess_kb_model_smoke";
const NOW = "2026-01-01T00:00:00Z";
const RETRIEVAL_K = 10;

interface FrozenCase {
  readonly case_id: string;
  readonly query: string;
  readonly supported_citations: readonly unknown[];
}

interface FrozenPage {
  readonly frontmatter: PageRevisionFrontmatter;
  readonly markdown: string;
  readonly claims: ClaimsSidecar;
}

interface FrozenFixture {
  readonly schema_version: 1;
  readonly fixture_id: string;
  readonly corpus: readonly FrozenPage[];
  readonly cases: readonly FrozenCase[];
}

interface Sentinel {
  readonly kind: "query" | "page" | "claim";
  readonly id: string;
  readonly text: string;
}

interface PrivacyLeak {
  readonly surface: string;
  readonly sentinel_kind: Sentinel["kind"];
  readonly sentinel_id: string;
}

interface PhaseSmokeResult {
  readonly state_id: "query" | "verify";
  readonly agent: string;
  readonly tools: readonly string[];
  readonly result: Record<string, unknown>;
  readonly artifact_lifecycle: string;
  readonly parent_persistence_matches: boolean;
}

interface CaseExecution {
  readonly observation: AnswerQualityCaseObservation;
  readonly pair_id: string;
  readonly case_id: string;
  readonly repetition: 1 | 2;
  readonly run_id: string;
  readonly model: string;
  readonly terminal_action: string;
  readonly terminal_status: string;
  readonly terminal_observed: boolean;
  readonly met: boolean;
  readonly candidate_count: number;
  readonly citations: readonly unknown[];
  readonly supported_citations: readonly unknown[];
  readonly answer_sha256?: string;
  readonly verification?: {
    readonly passed: boolean;
    readonly answer_verdict: string;
    readonly citation_findings: readonly {
      readonly citation: unknown;
      readonly verdict: string;
    }[];
    readonly host_assessment_passed: boolean;
    readonly host_assessment_reason?: string;
  };
  readonly phases: readonly PhaseSmokeResult[];
  readonly receipt_ids: readonly string[];
  readonly event_count: number;
  readonly log_capture_count: number;
  readonly child_session_files_created: readonly string[];
  readonly session_trace: readonly AgentSessionTraceRecordV1[];
  readonly private_input_state?: string;
  readonly error?: string;
  readonly privacy_leaks: readonly PrivacyLeak[];
  readonly issues: readonly string[];
  readonly duration_ms: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const smokeResultPath = resolveG8SmokeResultPath();
const smokeResultShaPath = resolveG8SmokeResultShaPath();
const originalStateRoot = process.env.PENNY_STATE_ROOT;
let scratchRoot: string | undefined;
let smokeStateRoot: string | undefined;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  return requireRecord(value, label);
}

function safeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      const stat = lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(absolute);
      else if (stat.isFile()) files.push(absolute);
    }
  };
  walk(root);
  return files;
}

function scanSurface(
  surface: string,
  value: unknown,
  sentinels: readonly Sentinel[]
): PrivacyLeak[] {
  const text = safeText(value);
  return sentinels.flatMap((sentinel) =>
    text.includes(sentinel.text)
      ? [{ surface, sentinel_kind: sentinel.kind, sentinel_id: sentinel.id }]
      : []
  );
}

function scanFile(
  file: string,
  sentinels: readonly Sentinel[]
): Array<PrivacyLeak & { readonly file: string }> {
  const bytes = readFileSync(file);
  return sentinels.flatMap((sentinel) =>
    bytes.includes(Buffer.from(sentinel.text, "utf8"))
      ? [
          {
            surface: "temporary filesystem",
            file,
            sentinel_kind: sentinel.kind,
            sentinel_id: sentinel.id,
          },
        ]
      : []
  );
}

function loadTrackedFixture(manifest: G8SmokeCohortManifest): FrozenFixture {
  const fixturePath = path.resolve(repoRoot, manifest.fixture.path);
  invariant(
    fixturePath === path.join(repoRoot, "apps/orchestration/tests/fixtures/kb-retrieval.json"),
    "retrieval fixture did not resolve to the manifest-bound tracked path"
  );
  invariant(existsSync(fixturePath), "tracked retrieval fixture is absent");
  const fixtureBytes = readFileSync(fixturePath, "utf8");
  invariant(sha256(fixtureBytes) === manifest.fixture.sha256, "tracked fixture digest drifted");
  const fixture: FrozenFixture = parseRetrievalFixture(fixtureBytes);
  invariant(fixture.schema_version === 1, "tracked fixture schema changed");
  invariant(
    fixture.cases.length === manifest.case_ids.length,
    "tracked fixture case count mismatches the manifest"
  );
  invariant(
    canonicalJson(fixture.cases.map((testCase) => testCase.case_id)) ===
      canonicalJson(manifest.case_ids),
    "tracked fixture case order or identity drifted"
  );
  invariant(
    new Set(fixture.cases.map((testCase) => testCase.case_id)).size === fixture.cases.length,
    "tracked fixture contains duplicate case ids"
  );
  invariant(RETRIEVAL_K === 10, "tracked retrieval k drifted");
  invariant(manifest.bad_answer_ceiling === 0, "tracked bad-answer ceiling drifted");
  return fixture;
}

function copySessionInputs(projectRoot: string): Record<string, string> {
  const relativePaths = [
    ".pi/SYSTEM.md",
    ".pi/agents/synthia.md",
    ".pi/agents/vera.md",
    ".pi/skills/knowledge-base/assets/prompts/synthia-query.md",
    ".pi/skills/knowledge-base/assets/prompts/vera-verify.md",
  ] as const;
  const digests: Record<string, string> = {};
  for (const relative of relativePaths) {
    const source = path.join(repoRoot, relative);
    const destination = path.join(projectRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    const sourceBytes = readFileSync(source);
    const destinationBytes = readFileSync(destination);
    invariant(sourceBytes.equals(destinationBytes), `session input copy drifted: ${relative}`);
    digests[relative] = createHash("sha256").update(sourceBytes).digest("hex");
  }
  return digests;
}

function installProfile(projectRoot: string, kbRoot: string): void {
  const state = initializePennyState(projectRoot, { env: process.env });
  mkdirSync(kbRoot, { recursive: true, mode: 0o700 });
  chmodSync(kbRoot, 0o700);
  const registryPath = state.paths.knowledgeBase.profiles;
  writeFileSync(
    registryPath,
    canonicalJson({
      schema_version: 1,
      profiles: [
        {
          schema_version: 1,
          kb_profile_id: PROFILE,
          kb_root: kbRoot,
          allow_create: true,
          repository_admission: { mode: "outside_worktree" },
        },
      ],
    }),
    { encoding: "utf8", mode: 0o600 }
  );
  chmodSync(registryPath, 0o600);
  using grants = new KbSessionProfileGrantStore(state.paths.knowledgeBase.hostGrants);
  grants.mint({
    session_id: SESSION,
    kb_profile_id: PROFILE,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
}

function seedFrozenKb(
  projectRoot: string,
  fixture: FrozenFixture
): { kbRoot: string; generationId: string; publishedBodyPaths: Set<string> } {
  const kbRoot = path.join(projectRoot, "private-kb");
  installProfile(projectRoot, kbRoot);
  const initialized = initKb(
    { kbRoot, profileId: PROFILE, runId: "run_kb_model_smoke_init" },
    "Frozen real-session model smoke fixture",
    {
      kb_id: "kb_model_smoke_fixture",
      generation_id: "gen_kb_model_smoke_empty",
      created_at: NOW,
    }
  );
  invariant(initialized.status === "complete", "could not initialize model-smoke KB");
  invariant(typeof initialized.kb_id === "string", "initialized model-smoke KB has no id");

  const policy = readPolicy(kbRoot);
  writePolicy(kbRoot, {
    ...policy,
    processing_mode: "local_only",
    allowed_parent_models: [MODEL_IDENTITY],
    allowed_child_models: [MODEL_IDENTITY],
  });

  const publishedBodyPaths = new Set<string>();
  for (const page of fixture.corpus) {
    writePageRevision(kbRoot, page.frontmatter, page.markdown, page.claims);
    publishedBodyPaths.add(
      path.resolve(pageMarkdownPath(kbRoot, page.frontmatter.page_id, page.frontmatter.revision_id))
    );
    publishedBodyPaths.add(
      path.resolve(pageClaimsPath(kbRoot, page.frontmatter.page_id, page.frontmatter.revision_id))
    );
  }

  const generationId = "gen_kb_model_smoke_frozen";
  const { index_sha256: indexSha256 } = buildGenerationIndex(
    kbRoot,
    generationId,
    initialized.kb_id,
    fixture.corpus.map((page) => ({
      page_id: page.frontmatter.page_id,
      revision_id: page.frontmatter.revision_id,
      title: page.frontmatter.title,
      summary: page.frontmatter.summary,
      body_sha256: sha256Hex(page.markdown),
      body: page.markdown,
    }))
  );
  const catalog = buildCatalog({
    generation_id: generationId,
    kb_id: initialized.kb_id,
    manifest: readManifest(kbRoot),
    policy: readPolicy(kbRoot),
    pages: fixture.corpus.map((page) => ({
      page_id: page.frontmatter.page_id,
      revision_id: page.frontmatter.revision_id,
      page_sha256: sha256Hex(
        readFileSync(
          pageMarkdownPath(kbRoot, page.frontmatter.page_id, page.frontmatter.revision_id),
          "utf8"
        )
      ),
      claims_sha256: sha256Hex(
        readFileSync(
          pageClaimsPath(kbRoot, page.frontmatter.page_id, page.frontmatter.revision_id),
          "utf8"
        )
      ),
    })),
    source_records: [],
    source_objects: [],
    conflicts: [],
    index_sha256: indexSha256,
  });
  publishGeneration(kbRoot, catalog);
  publishedBodyPaths.add(path.resolve(generationCatalogPath(kbRoot, generationId)));
  publishedBodyPaths.add(path.resolve(generationIndexPath(kbRoot, generationId)));
  return { kbRoot, generationId, publishedBodyPaths };
}

function fixtureSentinels(fixture: FrozenFixture): Sentinel[] {
  const querySentinels = fixture.cases.map((testCase) => ({
    kind: "query" as const,
    id: testCase.case_id,
    text: testCase.query,
  }));
  const pageSentinels = fixture.corpus.map((page) => {
    const synthesis = page.markdown.match(/^## Synthesis\n([^\n]+)$/mu)?.[1];
    invariant(synthesis !== undefined, `fixture page ${page.frontmatter.page_id} lacks synthesis`);
    return { kind: "page" as const, id: page.frontmatter.page_id, text: synthesis };
  });
  const claimSentinels = fixture.corpus.flatMap((page) =>
    page.claims.claims.map((claim) => ({
      kind: "claim" as const,
      id: `${page.frontmatter.page_id}/${claim.claim_id}`,
      text: claim.text,
    }))
  );
  for (const [kind, values] of [
    ["query", querySentinels],
    ["page", pageSentinels],
    ["claim", claimSentinels],
  ] as const) {
    invariant(
      new Set(values.map((entry) => entry.text)).size === values.length,
      `${kind} sentinels are not independent`
    );
  }
  return [...querySentinels, ...pageSentinels, ...claimSentinels];
}

function captureConsole(): {
  readonly records: string[];
  readonly restore: () => void;
} {
  const records: string[] = [];
  const original = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  const capture = (...args: unknown[]): void => {
    records.push(args.map(safeText).join(" "));
  };
  console.debug = capture;
  console.error = capture;
  console.info = capture;
  console.log = capture;
  console.warn = capture;
  return {
    records,
    restore: () => {
      console.debug = original.debug;
      console.error = original.error;
      console.info = original.info;
      console.log = original.log;
      console.warn = original.warn;
    },
  };
}

function terminalProjection(directive: Directive | undefined): {
  action: string;
  status: string;
  met: boolean;
  result: Record<string, unknown>;
} {
  if (directive === undefined)
    return { action: "missing", status: "error", met: false, result: {} };
  const terminal = directive as Directive & {
    readonly met?: boolean;
    readonly result?: Record<string, unknown>;
  };
  const result = terminal.result ?? {};
  return {
    action: terminal.action,
    status:
      typeof result["public_status"] === "string"
        ? String(result["public_status"])
        : terminal.action === "error"
          ? "error"
          : terminal.action,
    met: terminal.met === true,
    result,
  };
}

function phaseHandle(result: Record<string, unknown>, state: "query" | "verify") {
  const field = state === "query" ? "answer_artifact" : "report_artifact";
  return asObject(result[field], `${state} phase artifact handle`);
}

function receiptRows(controlPath: string, runId: string): Array<Record<string, unknown>> {
  if (!existsSync(controlPath)) return [];
  // Vite 5 predates node:sqlite, so resolve the built-in through Node itself.
  const sqlite = process.getBuiltinModule("node:sqlite");
  invariant(sqlite !== undefined, "node:sqlite is unavailable");
  const database = new sqlite.DatabaseSync(controlPath, { readOnly: true });
  try {
    const rows = requireRecordArray(
      database
        .prepare(
          `SELECT receipt_id,state_id,agent,result_json
           FROM receipts WHERE run_id=? ORDER BY created_at,receipt_id`
        )
        .all(runId),
      "model-smoke receipt rows"
    );
    return rows.map((row, index) => ({
      receipt_id: requireString(row["receipt_id"], `receipt rows[${index}].receipt_id`),
      state_id: requireString(row["state_id"], `receipt rows[${index}].state_id`),
      agent: requireString(row["agent"], `receipt rows[${index}].agent`),
      result: parseJson(requireString(row["result_json"], `receipt rows[${index}].result_json`)),
    }));
  } finally {
    database.close();
  }
}

async function executeCase(input: {
  readonly projectRoot: string;
  readonly kbRoot: string;
  readonly testCase: FrozenCase;
  readonly repetition: 1 | 2;
  readonly k: number;
  readonly modelOverride: "ollama/qwen3.8:latest";
  readonly phaseTimeoutMs: 300_000;
  readonly thinkingLevel: "off";
  readonly sentinels: readonly Sentinel[];
  readonly allowedBodyPaths: Set<string>;
}): Promise<CaseExecution> {
  const startedAt = performance.now();
  const pairId = `${input.testCase.case_id}#${input.repetition}`;
  const runId = `run_kb_model_smoke_${input.testCase.case_id.replace(/-/gu, "_")}_r${input.repetition}`;
  const controlPath = path.join(input.projectRoot, ".smoke-private", `${runId}.db`);
  const parentArtifactRoot = path.join(
    input.projectRoot,
    ".smoke-private",
    "parent-artifacts",
    runId
  );
  mkdirSync(path.dirname(controlPath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(controlPath), 0o700);
  const observations: CheckpointObservation[] = [];
  const issues: string[] = [];
  const privacyLeaks: PrivacyLeak[] = [];
  const consoleCapture = captureConsole();
  const sessionFilesBefore = new Set(
    (await SessionManager.list(input.projectRoot)).map((session) => session.path)
  );
  let childSessionFilesCreated: string[] = [];
  let checkpointer: Checkpointer | undefined;
  let parentArtifacts: ArtifactStore | undefined;
  let worker: KbWorkerClient | undefined;
  let runStore: RunArtifactStore | undefined;
  let directive: Directive | undefined;
  let terminal = terminalProjection(undefined);
  let citations: readonly unknown[] = [];
  let answerSha256: string | undefined;
  let verification: CaseExecution["verification"];
  let phaseResults: PhaseSmokeResult[] = [];
  let events: ReturnType<Checkpointer["events"]> = [];
  let parentPersistence: unknown[] = [];
  let privateInputState: string | undefined;
  let errorMessage: string | undefined;
  let receipts: Array<Record<string, unknown>> = [];
  const sessionTrace: AgentSessionTraceRecordV1[] = [];

  try {
    checkpointer = new Checkpointer(controlPath, (observation) => observations.push(observation));
    parentArtifacts = new ArtifactStore(parentArtifactRoot);
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: input.projectRoot,
      maxSteps: 8,
      artifactRevisions: parentArtifacts,
      playbookName: "knowledge-base",
    });

    const request = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: input.testCase.query,
      max_candidates: input.k,
    });
    const identity = {
      schema_version: 2 as const,
      run_id: runId,
      session_id: SESSION,
      playbook: "knowledge-base",
      engine_owner: "typescript" as const,
    };
    const goal = "Answer one stored frozen synthetic request through grounded KB readers.";
    const constraints = {
      action: "query",
      kb_profile_id: PROFILE,
      parent_identity: { provider: MODEL_IDENTITY.provider, model: MODEL_IDENTITY.model },
    } as const;
    const context = RunContext.create({
      identity,
      goal,
      constraints,
      projectRoot: input.projectRoot,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
    });
    const transactionId = `tx_${runId}`;
    const admission = checkpointer.admitStartRun(context, {
      session_id: SESSION,
      invocation_id: `call_${runId}`,
      request_sha256: sha256Hex(canonicalJson(request)),
      action: "query",
      profile_id: PROFILE,
      transaction_id: transactionId,
      private_input_id: `pri_${runId}`,
      storage_key: `${runId}/request.json`,
      temporary_storage_key: `${runId}/.${transactionId}.tmp`,
    });
    invariant(
      admission.kind === "created",
      `${input.testCase.case_id}: start was not newly admitted`
    );
    materializeRunInput({
      projectRoot: input.projectRoot,
      checkpointer,
      runId,
      request,
      requestSha256: sha256Hex(canonicalJson(request)),
    });

    const queryReader = new KbQueryReader({
      kbRoot: input.kbRoot,
      profileId: PROFILE,
      readRequest: () =>
        readRunInput({
          projectRoot: input.projectRoot,
          checkpointer: requireValue(
            checkpointer,
            "apps/orchestration/smoke/kb-model-smoke.test.ts:650"
          ),
          runId,
        }),
      selectedGenerationId: () =>
        String(checkpointer?.loadRunById(runId)?.playbookData.selected_generation_id ?? ""),
    });
    worker = new KbWorkerClient({
      projectRoot: input.projectRoot,
      checkpointer,
      kbRoot: input.kbRoot,
      runId,
      sessionId: SESSION,
      profileId: PROFILE,
      operation: "query",
      modelOverride: input.modelOverride,
      testOnlyThinkingLevelOverride: input.thinkingLevel,
      sessionTrace: (record) => sessionTrace.push(record),
      admittedPolicySha256: () =>
        String(checkpointer?.loadRunById(runId)?.playbookData.admitted_policy_sha256 ?? ""),
      queryReader,
    });
    const executor = new WorkerExecutor(worker, parentArtifacts, {
      projectRoot: input.projectRoot,
      parallelConcurrency: 1,
      workerTimeoutMs: input.phaseTimeoutMs,
    });
    const runner = new OrchestrationRunner(engine, executor);
    directive = await runner.runUntilBoundary(
      engine.handle({
        schema_version: 2,
        action: "start",
        identity,
        goal,
        constraints,
        project_root: input.projectRoot,
        trust_profile: "hardened-untrusted",
      })
    );
    terminal = terminalProjection(directive);

    const run = checkpointer.loadRunById(runId);
    invariant(run !== undefined, `${input.testCase.case_id}: durable run disappeared`);
    events = checkpointer.events(runId);
    runStore = new RunArtifactStore(input.kbRoot, runId, checkpointer);
    const phaseRecords = (["query", "verify"] as const).map((stateId) => {
      const phaseResult = runStore?.phaseResult(stateId);
      invariant(
        phaseResult !== undefined,
        `${input.testCase.case_id}: missing ${stateId} phase result`
      );
      const result = asObject(parseJson(phaseResult.result_jcs), `${stateId} result`);
      const handle = phaseHandle(result, stateId);
      const artifactId = String(handle["artifact_id"] ?? "");
      const artifactRecord = checkpointer?.kbArtifact(artifactId);
      invariant(
        artifactRecord !== undefined,
        `${input.testCase.case_id}: ${stateId} artifact is absent`
      );
      invariant(
        artifactRecord.lifecycle === "sealed",
        `${input.testCase.case_id}: ${stateId} artifact is not sealed`
      );
      input.allowedBodyPaths.add(
        path.resolve(input.kbRoot, "work", runId, artifactRecord.storage_key)
      );
      const selected = run.selectedArtifacts.find((artifact) => artifact.phase === stateId);
      const persisted =
        selected === undefined
          ? undefined
          : parentArtifacts?.read(selected, `state:${stateId}`).toString("utf8");
      const parentPersistenceMatches = persisted === phaseResult.result_jcs;
      if (!parentPersistenceMatches) {
        issues.push(`${stateId}: parent persistence does not equal body-free phase result JCS`);
      }
      if (String(result["state_id"] ?? "") !== stateId) {
        issues.push(`${stateId}: submitted state binding is wrong`);
      }
      if (stateId === "query" && String(result["agent"] ?? "") !== "synthia") {
        issues.push("query: submitted agent binding is not synthia");
      }
      if (stateId === "verify" && String(result["agent"] ?? "") !== "vera") {
        issues.push("verify: submitted agent binding is not vera");
      }
      return {
        state_id: stateId,
        agent: String(result["agent"] ?? ""),
        tools: [...KB_PHASE_TOOL_MATRIX[stateId]],
        result,
        artifact_lifecycle: artifactRecord.lifecycle,
        parent_persistence_matches: parentPersistenceMatches,
      } satisfies PhaseSmokeResult;
    });
    phaseResults = phaseRecords;

    const queryPhase = phaseRecords[0];
    const verifyPhase = phaseRecords[1];
    invariant(queryPhase !== undefined, `${input.testCase.case_id}: query phase disappeared`);
    invariant(verifyPhase !== undefined, `${input.testCase.case_id}: verify phase disappeared`);
    const answerHandle = phaseHandle(queryPhase.result, "query");
    const answerArtifactId = String(answerHandle["artifact_id"] ?? "");
    const verificationArtifactId = String(
      phaseHandle(verifyPhase.result, "verify")["artifact_id"] ?? ""
    );
    const answerDocument: QueryAnswerArtifact = validateKbContract(
      QueryAnswerArtifactSchema,
      parseJson(runStore.read(answerArtifactId).content),
      "model-smoke query answer"
    );
    const verificationDocument: QueryVerificationReport = validateKbContract(
      QueryVerificationReportSchema,
      parseJson(runStore.read(verificationArtifactId).content),
      "model-smoke verification report"
    );
    citations = answerDocument.answer.citations;
    answerSha256 = sha256Hex(answerDocument.answer.text);
    const assessment = assessQueryVerification(answerDocument, verificationDocument, answerHandle);
    const unsupportedIds = Array.isArray(verifyPhase.result["unsupported_claim_ids"])
      ? verifyPhase.result["unsupported_claim_ids"]
      : [];
    const verificationSupported = assessment.passed && unsupportedIds.length === 0;
    verification = {
      passed: verificationDocument.passed,
      answer_verdict: verificationDocument.answer_verdict,
      citation_findings: verificationDocument.citation_findings.map((finding) => ({
        citation: finding.citation,
        verdict: finding.verdict,
      })),
      host_assessment_passed: verificationSupported,
      ...(assessment.reason === undefined ? {} : { host_assessment_reason: assessment.reason }),
    };

    parentPersistence = run.selectedArtifacts.map((artifact) => ({
      ref: artifact,
      content: parentArtifacts?.read(artifact, `state:${artifact.phase}`).toString("utf8"),
    }));
    verifyAndSettleTerminalStart({ projectRoot: input.projectRoot, checkpointer, run });
    privateInputState = checkpointer.getPrivateInput(runId)?.state;
    if (privateInputState !== "discarded") {
      issues.push(`private input terminal state is '${String(privateInputState)}', not discarded`);
    }
    if (terminal.action !== "complete" || !terminal.met) {
      issues.push(`terminal is ${terminal.action}, met=${String(terminal.met)}`);
    }
    if (!verificationSupported)
      issues.push("host verification did not support the complete answer");
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    const protocolError = contentFreeSessionProtocolErrorRecord(error);
    if (protocolError !== undefined) sessionTrace.push(protocolError);
    terminal = terminalProjection(directive);
    if (checkpointer !== undefined) {
      try {
        const failedRun = checkpointer.loadRunById(runId);
        if (failedRun?.terminalDirective !== null && failedRun?.terminalDirective !== undefined) {
          directive = failedRun.terminalDirective;
          terminal = terminalProjection(directive);
          verifyAndSettleTerminalStart({
            projectRoot: input.projectRoot,
            checkpointer,
            run: failedRun,
          });
        } else {
          // A worker exception/timeout is a nonterminal cohort failure. This
          // scratch run will never resume, so discard its exact indexed private
          // bytes before privacy scans instead of flagging expected test cleanup.
          settleRunInput({ projectRoot: input.projectRoot, checkpointer, runId });
        }
        events = checkpointer.events(runId);
        privateInputState = checkpointer.getPrivateInput(runId)?.state;
        if (
          failedRun?.terminalDirective !== null &&
          failedRun?.terminalDirective !== undefined &&
          privateInputState !== "discarded"
        ) {
          issues.push(
            `terminal failure left private input '${String(privateInputState)}', not discarded`
          );
        }
      } catch (settlementError) {
        issues.push(`terminal private-input settlement failed: ${safeText(settlementError)}`);
      }
    }
  } finally {
    consoleCapture.restore();
    try {
      const after = await SessionManager.list(input.projectRoot);
      childSessionFilesCreated = after
        .map((session) => session.path)
        .filter((sessionPath) => !sessionFilesBefore.has(sessionPath));
    } catch (error) {
      issues.push(`child session persistence scan failed: ${safeText(error)}`);
    }
    if (checkpointer !== undefined) {
      try {
        for (const artifact of checkpointer.kbArtifacts({ run_id: runId })) {
          // Same-run work artifacts are an allowed private content plane on
          // success and failure. Add every indexed exact key before scanning;
          // this grants no path to a child and adopts no unindexed file.
          input.allowedBodyPaths.add(
            path.resolve(input.kbRoot, "work", runId, artifact.storage_key)
          );
        }
      } catch (error) {
        issues.push(`same-run work artifact scan failed: ${safeText(error)}`);
      }
    }
    runStore?.close();
    worker?.close();
    parentArtifacts?.close();
    checkpointer?.close();
  }

  try {
    receipts = receiptRows(controlPath, runId);
  } catch (error) {
    issues.push(`execution receipt scan failed: ${safeText(error)}`);
  }
  if (receipts.length !== 2) issues.push(`expected 2 execution receipts, found ${receipts.length}`);
  if (childSessionFilesCreated.length > 0) {
    issues.push(`child sessions persisted ${childSessionFilesCreated.length} file(s)`);
  }

  const surfaces: Array<[string, unknown]> = [
    ["terminal parent projection", terminal],
    ["child tool phase-result details", phaseResults.map((phase) => phase.result)],
    ["worker execution receipts", receipts],
    ["parent artifact persistence", parentPersistence],
    ["observability log capture", observations],
    ["control events", events],
    ["console log capture", consoleCapture.records],
    ["content-free session trace", sessionTrace],
    ["bounded failure", errorMessage ?? ""],
  ];
  for (const [surface, value] of surfaces) {
    privacyLeaks.push(...scanSurface(surface, value, input.sentinels));
  }
  for (const sessionFile of childSessionFilesCreated) {
    if (existsSync(sessionFile)) {
      privacyLeaks.push(
        ...scanSurface("child session persistence", readFileSync(sessionFile), input.sentinels)
      );
    }
  }
  if (privacyLeaks.length > 0)
    issues.push(`${privacyLeaks.length} in-memory/log projection leak(s)`);

  const verificationSupported = verification?.host_assessment_passed === true;
  const finalStatus = errorMessage === undefined ? terminal.status : "error";
  const terminalObserved =
    directive?.action === "complete" ||
    directive?.action === "incomplete" ||
    directive?.action === "error" ||
    directive?.action === "cancelled";
  return {
    observation: {
      caseId: pairId,
      supportedCitations: input.testCase.supported_citations,
      finalResult: {
        status: finalStatus,
        met: errorMessage === undefined && terminal.met,
        citations,
        verificationSupported,
      },
    },
    pair_id: pairId,
    case_id: input.testCase.case_id,
    repetition: input.repetition,
    run_id: runId,
    model: input.modelOverride,
    terminal_action:
      terminalObserved && errorMessage === undefined
        ? terminal.action
        : terminalObserved
          ? terminal.action
          : "nonterminal",
    terminal_status: finalStatus,
    terminal_observed: terminalObserved,
    met: errorMessage === undefined && terminal.met,
    candidate_count:
      typeof terminal.result["candidate_count"] === "number"
        ? terminal.result["candidate_count"]
        : 0,
    citations,
    supported_citations: input.testCase.supported_citations,
    ...(answerSha256 === undefined ? {} : { answer_sha256: answerSha256 }),
    ...(verification === undefined ? {} : { verification }),
    phases: phaseResults,
    receipt_ids: receipts.flatMap((receipt) =>
      typeof receipt["receipt_id"] === "string" ? [receipt["receipt_id"]] : []
    ),
    event_count: events.length,
    log_capture_count: observations.length + consoleCapture.records.length,
    child_session_files_created: childSessionFilesCreated,
    session_trace: sessionTrace,
    ...(privateInputState === undefined ? {} : { private_input_state: privateInputState }),
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
    privacy_leaks: privacyLeaks,
    issues,
    duration_ms: Math.round(performance.now() - startedAt),
  };
}

function splitPhaseTrace(
  records: readonly AgentSessionTraceRecordV1[]
): readonly [readonly AgentSessionTraceRecordV1[], readonly AgentSessionTraceRecordV1[]] {
  const query: AgentSessionTraceRecordV1[] = [];
  const verify: AgentSessionTraceRecordV1[] = [];
  let target = query;
  for (const record of records) {
    target.push(record);
    if (
      target === query &&
      record.kind === "tool" &&
      record.name === "submit_phase_result" &&
      record.outcome === "success"
    ) {
      target = verify;
    }
  }
  return [query, verify];
}

function traceMetrics(records: readonly AgentSessionTraceRecordV1[]) {
  const turns = records.filter(
    (record): record is Extract<AgentSessionTraceRecordV1, { kind: "turn" }> =>
      record.kind === "turn"
  );
  const tools = records.filter(
    (record): record is Extract<AgentSessionTraceRecordV1, { kind: "tool" }> =>
      record.kind === "tool"
  );
  const errorCodes = records.flatMap((record) =>
    "error_code" in record && record.error_code !== undefined ? [record.error_code] : []
  );
  return {
    cache_read_tokens: turns.reduce((sum, record) => sum + record.token_counts.cache_read, 0),
    cache_write_tokens: turns.reduce((sum, record) => sum + record.token_counts.cache_write, 0),
    input_tokens: turns.reduce((sum, record) => sum + record.token_counts.input, 0),
    output_tokens: turns.reduce((sum, record) => sum + record.token_counts.output, 0),
    protocol_error_codes: [...new Set(errorCodes)],
    tool_errors: tools.filter((record) => record.outcome === "error").length,
    tool_events: tools.length,
    total_tokens: turns.reduce((sum, record) => sum + record.token_counts.total, 0),
    turn_events: turns.length,
  };
}

function receiptAction(value: string): G8SmokePairReceipt["terminal"]["action"] {
  switch (value) {
    case "complete":
    case "incomplete":
    case "error":
    case "cancelled":
    case "missing":
    case "nonterminal":
      return value;
    default:
      return "nonterminal";
  }
}

function receiptCaseId(value: string): G8SmokePairReceipt["case_id"] {
  switch (value) {
    case "sqlite-query":
    case "typebox-query":
    case "cross-query":
      return value;
    default:
      throw new Error(`Unexpected model-smoke case id: ${value}`);
  }
}

function pairReceipt(input: {
  execution: CaseExecution;
  badReasons: readonly G8SmokePairReceipt["metrics"]["bad_reasons"][number][];
  badAnswer: boolean;
  filesystemPrivacyIncidents: number;
}): G8SmokePairReceipt {
  const phaseTraces = splitPhaseTrace(input.execution.session_trace);
  const expectedPhases = [
    { state_id: "query" as const, agent: "synthia" as const, trace: phaseTraces[0] },
    { state_id: "verify" as const, agent: "vera" as const, trace: phaseTraces[1] },
  ];
  const action = receiptAction(input.execution.terminal_action);
  return {
    case_id: receiptCaseId(input.execution.case_id),
    execution_count: 1,
    pair_id: input.execution.pair_id,
    repetition: input.execution.repetition,
    run_id: input.execution.run_id,
    terminal: {
      action,
      met: input.execution.met,
      observed: input.execution.terminal_observed,
      status: input.execution.terminal_status,
    },
    phases: expectedPhases.map(({ state_id, agent, trace }) => {
      const observed = input.execution.phases.find((phase) => phase.state_id === state_id);
      return {
        agent,
        artifact_lifecycle: observed?.artifact_lifecycle ?? "missing",
        observed: observed !== undefined,
        parent_persistence_matches: observed?.parent_persistence_matches ?? false,
        state_id,
        metrics: traceMetrics(trace),
      };
    }),
    metrics: {
      bad_answer: input.badAnswer,
      bad_reasons: [...input.badReasons],
      candidate_count: input.execution.candidate_count,
      child_session_files_created: input.execution.child_session_files_created.length,
      duration_ms: input.execution.duration_ms,
      event_count: input.execution.event_count,
      log_capture_count: input.execution.log_capture_count,
      privacy_incidents: input.execution.privacy_leaks.length + input.filesystemPrivacyIncidents,
      protocol_issues: input.execution.issues.length,
      receipt_count: input.execution.receipt_ids.length,
    },
  };
}

function buildResultReceipt(input: {
  manifest: G8SmokeCohortManifest;
  manifestSha256: string;
  fixture: FrozenFixture;
  pairs: readonly G8SmokePairReceipt[];
}): G8SmokeResultReceipt {
  const toolMatrix = [
    { phase: "query" as const, tools: [...KB_PHASE_TOOL_MATRIX.query] },
    { phase: "verify" as const, tools: [...KB_PHASE_TOOL_MATRIX.verify] },
  ] as const;
  const issueCodes = g8SmokeCohortIssueCodes({
    manifest: input.manifest,
    pairs: input.pairs,
    excludedPairs: 0,
    retries: 0,
  });
  const terminalPairs = input.pairs.filter((pair) => pair.terminal.observed).length;
  const badAnswers = input.pairs.filter((pair) => pair.metrics.bad_answer).length;
  const privacyIncidents = input.pairs.reduce(
    (sum, pair) => sum + pair.metrics.privacy_incidents,
    0
  );
  const payload = {
    schema_version: 1 as const,
    receipt_kind: "g8_qwen3_8_smoke_result" as const,
    cohort_id: input.manifest.cohort_id,
    manifest_matrix: [
      {
        path: G8_SMOKE_MANIFEST_PATH,
        sha256: input.manifestSha256,
        scheduled_pair_count: input.manifest.scheduled_pair_count,
      },
    ],
    fixture_matrix: [
      {
        case_ids: [...input.manifest.case_ids],
        fixture_id: input.fixture.fixture_id,
        path: input.manifest.fixture.path,
        sha256: input.manifest.fixture.sha256,
      },
    ],
    model_matrix: [
      {
        agent: "synthia" as const,
        locality: MODEL_IDENTITY.locality,
        model: MODEL_IDENTITY.model,
        model_id: input.manifest.model,
        phase: "query" as const,
        provider: MODEL_IDENTITY.provider,
        thinking_level: input.manifest.thinking_level,
      },
      {
        agent: "vera" as const,
        locality: MODEL_IDENTITY.locality,
        model: MODEL_IDENTITY.model,
        model_id: input.manifest.model,
        phase: "verify" as const,
        provider: MODEL_IDENTITY.provider,
        thinking_level: input.manifest.thinking_level,
      },
    ],
    tool_matrix: toolMatrix,
    schedule: {
      excluded_pairs: 0 as const,
      repetitions: input.manifest.repetitions,
      retries: 0 as const,
      scheduled_pairs: input.manifest.scheduled_pair_count,
      started_pairs: input.pairs.length,
      terminal_pairs: terminalPairs,
    },
    pairs: input.pairs,
    totals: {
      bad_answers: badAnswers,
      good_pairs: input.pairs.length - badAnswers,
      privacy_incidents: privacyIncidents,
      scheduled_pairs: input.manifest.scheduled_pair_count,
      terminal_pairs: terminalPairs,
    },
    outcome: issueCodes.length === 0 ? ("pass" as const) : ("fail" as const),
    issue_codes: issueCodes,
  };
  return validateG8SmokeResultReceipt(
    {
      ...payload,
      receipt_payload_sha256: sha256(canonicalJson(payload)),
    },
    input.manifest,
    toolMatrix
  );
}

function writeResultReceipt(receipt: G8SmokeResultReceipt): {
  readonly path: string;
  readonly sha256: string;
} {
  const resultPath = smokeResultPath;
  const digestPath = smokeResultShaPath;
  invariant(
    !existsSync(resultPath) && !existsSync(digestPath),
    "stable G8 smoke receipt already exists; rerun refused"
  );
  mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
  const bytes = canonicalJson(receipt);
  const digest = sha256(bytes);
  const resultTemp = `${resultPath}.tmp`;
  const digestTemp = `${digestPath}.tmp`;
  invariant(
    !existsSync(resultTemp) && !existsSync(digestTemp),
    "stable G8 smoke receipt temp already exists"
  );
  writeFileSync(resultTemp, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
  writeFileSync(digestTemp, `${digest}  ${path.basename(resultPath)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  for (const temporary of [resultTemp, digestTemp]) {
    const descriptor = openSync(temporary, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  renameSync(digestTemp, digestPath);
  renameSync(resultTemp, resultPath);
  const directoryDescriptor = openSync(path.dirname(resultPath), "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
  chmodSync(resultPath, 0o600);
  chmodSync(digestPath, 0o600);
  invariant(readFileSync(resultPath, "utf8") === bytes, "stable G8 smoke receipt write drifted");
  invariant(
    sha256(readFileSync(resultPath, "utf8")) === digest,
    "stable G8 smoke receipt digest drifted"
  );
  return { path: resultPath, sha256: digest };
}

const gatedDescribe = process.env[GATE_ENV] === "1" ? describe : describe.skip;

gatedDescribe("G8 stable qwen real-session KB model smoke", () => {
  afterAll(() => {
    if (scratchRoot !== undefined) rmSync(scratchRoot, { recursive: true, force: true });
    if (smokeStateRoot !== undefined) rmSync(smokeStateRoot, { recursive: true, force: true });
    if (originalStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
    else process.env.PENNY_STATE_ROOT = originalStateRoot;
  });

  it("executes all six frozen case/repetition pairs exactly once", async () => {
    const loadedManifest = loadG8SmokeCohortManifest(repoRoot);
    const { manifest } = loadedManifest;
    invariant(
      !existsSync(smokeResultPath),
      "stable G8 smoke receipt already exists; live rerun refused"
    );
    invariant(
      !existsSync(smokeResultShaPath),
      "stable G8 smoke receipt SHA already exists; live rerun refused"
    );
    const fixture = loadTrackedFixture(manifest);
    scratchRoot = mkdtempSync(path.join(tmpdir(), "penny-kb-model-smoke-"));
    smokeStateRoot = mkdtempSync(path.join(tmpdir(), "penny-kb-model-smoke-state-"));
    chmodSync(scratchRoot, 0o700);
    chmodSync(smokeStateRoot, 0o700);
    process.env.PENNY_STATE_ROOT = smokeStateRoot;
    copySessionInputs(scratchRoot);
    const { kbRoot, publishedBodyPaths } = seedFrozenKb(scratchRoot, fixture);
    const allowedBodyPaths = new Set(
      [...publishedBodyPaths].map((candidate) => path.resolve(candidate))
    );
    const sentinels = fixtureSentinels(fixture);
    const fixtureById = new Map(fixture.cases.map((testCase) => [testCase.case_id, testCase]));
    const executions: CaseExecution[] = [];

    for (const pair of g8SmokeScheduledPairs(manifest)) {
      const testCase = fixtureById.get(pair.case_id);
      invariant(testCase !== undefined, `${pair.pair_id}: frozen case is absent`);
      executions.push(
        await executeCase({
          projectRoot: scratchRoot,
          kbRoot,
          testCase,
          repetition: pair.repetition,
          k: RETRIEVAL_K,
          modelOverride: manifest.model,
          phaseTimeoutMs: manifest.per_phase_timeout_ms,
          thinkingLevel: manifest.thinking_level,
          sentinels,
          allowedBodyPaths,
        })
      );
    }

    const score = scoreAnswerQuality(executions.map((execution) => execution.observation));
    const filesystemLeaks: Array<PrivacyLeak & { readonly file: string }> = [];
    for (const file of filesUnder(scratchRoot)) {
      const matches = scanFile(file, sentinels);
      if (matches.length > 0 && !allowedBodyPaths.has(path.resolve(file))) {
        filesystemLeaks.push(...matches);
      }
    }
    const filesystemPrivacyByPair = new Map(executions.map((execution) => [execution.pair_id, 0]));
    for (const leak of filesystemLeaks) {
      const owner = executions.find((execution) => leak.file.includes(execution.run_id));
      const pairId = owner?.pair_id ?? executions[0]?.pair_id;
      if (pairId !== undefined) {
        filesystemPrivacyByPair.set(pairId, (filesystemPrivacyByPair.get(pairId) ?? 0) + 1);
      }
    }

    const pairReceipts = executions.map((execution): G8SmokePairReceipt => {
      const pairScore = score.cases.find((entry) => entry.caseId === execution.pair_id);
      return pairReceipt({
        execution,
        badReasons: pairScore?.reasons ?? ["missing_result"],
        badAnswer: pairScore?.bad ?? true,
        filesystemPrivacyIncidents: filesystemPrivacyByPair.get(execution.pair_id) ?? 0,
      });
    });
    const resultReceipt = buildResultReceipt({
      manifest,
      manifestSha256: loadedManifest.sha256,
      fixture,
      pairs: pairReceipts,
    });
    const durable = writeResultReceipt(resultReceipt);
    process.stdout.write(`KB_MODEL_SMOKE_RECEIPT_PATH=${durable.path}\n`);
    process.stdout.write(`KB_MODEL_SMOKE_RECEIPT_SHA256=${durable.sha256}\n`);
    process.stdout.write(`KB_MODEL_SMOKE_RECEIPT=${canonicalJson(resultReceipt)}\n`);

    expect(score.caseCount, canonicalJson(resultReceipt)).toBe(manifest.scheduled_pair_count);
    expect(resultReceipt.schedule.started_pairs, canonicalJson(resultReceipt)).toBe(6);
    expect(resultReceipt.schedule.terminal_pairs, canonicalJson(resultReceipt)).toBe(6);
    expect(resultReceipt.totals.good_pairs, canonicalJson(resultReceipt)).toBe(6);
    expect(resultReceipt.totals.bad_answers, canonicalJson(resultReceipt)).toBe(0);
    expect(resultReceipt.totals.privacy_incidents, canonicalJson(resultReceipt)).toBe(0);
    expect(resultReceipt.issue_codes, canonicalJson(resultReceipt)).toEqual([]);
    expect(resultReceipt.outcome, canonicalJson(resultReceipt)).toBe("pass");
  });
});
