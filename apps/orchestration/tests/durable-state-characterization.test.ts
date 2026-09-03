import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer, canonicalJson, sha256 } from "../src/checkpointer.js";
import {
  ContractValidationError,
  type ArtifactRef,
  type Directive,
  type JsonValue,
  type PhaseResult,
  type RunIdentity,
  validateDirective,
} from "../src/contracts.js";
import { RunContext } from "../src/context.js";
import { OrchestrationEngine, type EngineOptions } from "../src/engine.js";
import { kbLivenessPolicy } from "../src/liveness.js";
import { KnowledgeBasePlaybook } from "../src/playbooks/knowledge-base.js";
import { ReceiptAuthority, trustedInvocationDigest } from "../src/receipts.js";

const PROJECT_ROOT = "/workspace";
const FIXTURE_MODEL = "fixture-model";
const FIXED_TIMESTAMP = "2026-08-24T00:00:00.000Z";
const RECEIPT_KEY_HEX = Array.from({ length: 32 }, (_, index) =>
  index.toString(16).padStart(2, "0")
).join("");
const FIXTURE_ROOT = new URL("./fixtures/orchestration-durable-state/", import.meta.url);

const RESEARCH_PENDING_IDENTITY = {
  schema_version: 2,
  run_id: "run_ts200_research_pending",
  session_id: "session_ts200",
  playbook: "research",
  engine_owner: "typescript",
} satisfies RunIdentity;

const RESEARCH_TERMINAL_IDENTITY = {
  ...RESEARCH_PENDING_IDENTITY,
  run_id: "run_ts200_research_terminal",
} satisfies RunIdentity;

const KB_IDENTITY = {
  schema_version: 2,
  run_id: "run_ts200_kb_compose",
  session_id: "session_ts200",
  playbook: "knowledge-base",
  engine_owner: "typescript",
} satisfies RunIdentity;

const UNKNOWN_IDENTITY = {
  schema_version: 2,
  run_id: "run_ts200_unknown_playbook",
  session_id: "session_ts200",
  playbook: "unregistered-playbook",
  engine_owner: "typescript",
} satisfies RunIdentity;

const directories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), `penny-ts200-${label}-`));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_ROOT), "utf8").trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface SqliteModule {
  readonly DatabaseSync: typeof import("node:sqlite").DatabaseSync;
}

function isSqliteModule(value: object | undefined): value is SqliteModule {
  return value !== undefined && "DatabaseSync" in value && typeof value.DatabaseSync === "function";
}

function database(file: string): SqliteDatabase {
  const sqlite = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(sqlite)) throw new Error("node:sqlite unavailable");
  return new sqlite.DatabaseSync(file);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} fixture value is not an object`);
  return value;
}

function fixtureObject(name: string): Record<string, unknown> {
  return requiredRecord(JSON.parse(fixture(name)), name);
}

function withCompletionProtocolV1(serialized: string): string {
  const value = requiredRecord(JSON.parse(serialized), "legacy durable-state fixture");
  return canonicalJson({ ...value, completion_protocol_version: 1 });
}

function fixtureDirective(
  name: string,
  field: "pending_directive" | "terminal_directive"
): Directive {
  return validateDirective(fixtureObject(name)[field]);
}

function deterministicReceiptAuthority(directory: string): ReceiptAuthority {
  return ReceiptAuthority.load(path.join(directory, "unused-test-receipt-key"), {
    PENNY_RECEIPT_HMAC_KEY: RECEIPT_KEY_HEX,
  });
}

function engine(
  checkpointer: Checkpointer,
  directory: string,
  options: Pick<EngineOptions, "playbookName" | "dispatchMode" | "livenessPolicyResolver"> = {}
): OrchestrationEngine {
  return new OrchestrationEngine(checkpointer, {
    projectRoot: PROJECT_ROOT,
    maxSteps: 16,
    receiptAuthority: deterministicReceiptAuthority(directory),
    ...(options.playbookName === undefined ? {} : { playbookName: options.playbookName }),
    ...(options.dispatchMode === undefined ? {} : { dispatchMode: options.dispatchMode }),
    ...(options.livenessPolicyResolver === undefined
      ? {}
      : { livenessPolicyResolver: options.livenessPolicyResolver }),
  });
}

function withPlanningModel<T>(operation: () => T): T {
  const name = "PENNY_RESEARCH_PLANNING_MODEL";
  const previous = process.env[name];
  process.env[name] = FIXTURE_MODEL;
  try {
    return operation();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function startResearch(
  orchestration: OrchestrationEngine,
  identity: RunIdentity
): Extract<Directive, { action: "invoke_agent" }> {
  const result = withPlanningModel(() =>
    orchestration.handle({
      schema_version: 2,
      action: "start",
      identity,
      goal: "Characterize durable orchestration state.",
      constraints: { mode: "standard", max_iterations: 3 },
      project_root: PROJECT_ROOT,
      trust_profile: "hardened-untrusted",
    })
  );
  if (result.action !== "invoke_agent") {
    throw new Error(`research fixture expected invoke_agent, received '${result.action}'`);
  }
  return result;
}

function contextJson(dbPath: string, runId: string): string {
  const connection = database(dbPath);
  try {
    const row = connection.prepare("SELECT context_json FROM runs WHERE run_id=?").get(runId);
    if (row === undefined || typeof row.context_json !== "string") {
      throw new Error(`run '${runId}' has no serialized context`);
    }
    return row.context_json;
  } finally {
    connection.close();
  }
}

function receiptJson(dbPath: string, receiptId: string): string {
  const connection = database(dbPath);
  try {
    const row = connection
      .prepare("SELECT result_json FROM receipts WHERE receipt_id=?")
      .get(receiptId);
    if (row === undefined || typeof row.result_json !== "string") {
      throw new Error(`receipt '${receiptId}' has no serialized result`);
    }
    return row.result_json;
  } finally {
    connection.close();
  }
}

function replaceContextJson(dbPath: string, runId: string, serialized: string): void {
  const connection = database(dbPath);
  try {
    const result = connection
      .prepare("UPDATE runs SET context_json=? WHERE run_id=?")
      .run(serialized, runId);
    if (Number(result.changes) !== 1) throw new Error(`run '${runId}' was not updated`);
  } finally {
    connection.close();
  }
}

function initializeDatabase(dbPath: string): void {
  const checkpointer = new Checkpointer(dbPath);
  checkpointer.close();
}

function insertRunFixture(input: {
  dbPath: string;
  identity: RunIdentity;
  status: string;
  stateId: string;
  serialized: string;
}): void {
  const connection = database(input.dbPath);
  try {
    connection
      .prepare(
        `INSERT INTO runs(
          run_id,session_id,playbook,engine_owner,schema_version,status,
          state_id,context_json,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.identity.run_id,
        input.identity.session_id,
        input.identity.playbook,
        input.identity.engine_owner,
        input.identity.schema_version,
        input.status,
        input.stateId,
        input.serialized,
        FIXED_TIMESTAMP,
        FIXED_TIMESTAMP
      );
  } finally {
    connection.close();
  }
}

function withoutField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = structuredClone(record);
  delete copy[field];
  return copy;
}

function restoreError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error_name: "NonError" };
  return {
    error_name: error.name,
    ...(error instanceof SyntaxError ? {} : { error_message: error.message }),
  };
}

function researchRestoreProjection(
  checkpointer: Checkpointer,
  name: string
): Record<string, unknown> {
  try {
    const restored = checkpointer.loadRun(RESEARCH_PENDING_IDENTITY);
    const snapshot = restored.snapshot();
    return {
      case: name,
      accepted: true,
      state_id: restored.stateId,
      playbook_data_present: Object.hasOwn(snapshot, "playbook_data"),
      future_field: restored.playbookData.future_field ?? null,
    };
  } catch (error) {
    return { case: name, accepted: false, ...restoreError(error) };
  }
}

function kbRestoreProjection(checkpointer: Checkpointer, name: string): Record<string, unknown> {
  try {
    const restored = checkpointer.loadRun(KB_IDENTITY);
    return {
      case: name,
      accepted: true,
      state_id: restored.stateId,
      phases: restored.playbookData.phases ?? null,
    };
  } catch (error) {
    return { case: name, accepted: false, ...restoreError(error) };
  }
}

function kbComposeContext(): RunContext {
  const context = RunContext.create({
    identity: KB_IDENTITY,
    goal: "Characterize path-free knowledge-base phase state.",
    constraints: {
      action: "ingest",
      kb_profile_id: "kbp_ts200",
      source_capability_ids: ["cap_ts200"],
      parent_identity: { provider: "fixture-provider", model: "fixture-model" },
    },
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 16,
  });
  context.playbookData.action = "ingest";
  context.playbookData.profile_id = "kbp_ts200";
  context.playbookData.kb_id = "kb_ts200";
  context.playbookData.admitted_policy_sha256 = "a".repeat(64);
  context.playbookData.source_capability_ids = ["cap_ts200"];
  context.playbookData.source_ids = ["src_ts200"];
  context.transition("ingest");
  context.playbookData.phases = {
    ingest: {
      artifact_kind: "claims",
      kb_artifact_id: "kbart_ts200_claims",
      counts: { claim_count: 2 },
      verdict: "pass",
    },
  };
  const digest = "b".repeat(64);
  const artifact = {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: KB_IDENTITY.run_id,
    phase: "ingest",
    branch_id: null,
    kind: "agent-output",
    operation_id: `agent-operation:${"c".repeat(64)}`,
    version: 1,
    producer: "agent:echo",
    media_type: "text/plain; charset=utf-8",
    byte_length: 128,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  } satisfies ArtifactRef;
  context.selectedArtifacts.push(artifact);
  context.transition("compose");
  new KnowledgeBasePlaybook().dispatch(context);
  return context;
}

function planningResult(input: {
  orchestration: OrchestrationEngine;
  pending: Extract<Directive, { action: "invoke_agent" }>;
  details: Record<string, JsonValue>;
  receiptId: string;
}): PhaseResult {
  const digest = sha256(canonicalJson(input.details));
  const expected = input.pending.output_artifact;
  const outputArtifact = {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: expected.run_id,
    phase: expected.phase,
    branch_id: expected.branch_id,
    kind: expected.kind,
    operation_id: expected.operation_id,
    version: expected.version,
    producer: expected.producer,
    media_type: expected.media_type,
    byte_length: Buffer.byteLength(canonicalJson(input.details), "utf8"),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  } satisfies ArtifactRef;
  const receipt = input.orchestration.receiptAuthority.sign({
    schema_version: 2,
    receipt_id: input.receiptId,
    run_id: input.pending.identity.run_id,
    state_id: input.pending.state_id,
    branch_id: null,
    agent: input.pending.agent,
    attempt: input.pending.attempt,
    worker_id: "worker_ts200",
    executor: "pi-sdk",
    command: ["pi-sdk", input.pending.agent],
    model: input.pending.model_override ?? null,
    working_directory: PROJECT_ROOT,
    trust_profile: input.pending.trust_profile,
    started_at: FIXED_TIMESTAMP,
    ended_at: FIXED_TIMESTAMP,
    exit_code: 0,
    output_digest: digest,
    output_artifact_ref: outputArtifact,
    trusted_invocation_digest: trustedInvocationDigest({
      identity: input.pending.identity,
      state_id: input.pending.state_id,
      branch_id: null,
      agent: input.pending.agent,
      attempt: input.pending.attempt,
      trust_profile: input.pending.trust_profile,
      model_override: input.pending.model_override ?? null,
      task_sha256: sha256(input.pending.task),
      input_artifacts: input.pending.input_artifacts,
      output_artifact: input.pending.output_artifact,
    }),
  });
  return {
    schema_version: 2,
    run_id: input.pending.identity.run_id,
    state_id: input.pending.state_id,
    agent: input.pending.agent,
    attempt: input.pending.attempt,
    confidence: "CERTAIN",
    details: input.details,
    output_artifact: outputArtifact,
    worker_receipt: receipt,
  };
}

function keyProjection(value: object): string[] {
  return Object.keys(value).sort();
}

function phaseResultProjection(
  result: PhaseResult,
  next: Directive,
  persisted: PhaseResult | undefined
): Record<string, unknown> {
  return {
    result_keys: keyProjection(result),
    details_keys: keyProjection(result.details),
    output_artifact_keys: keyProjection(result.output_artifact),
    worker_receipt_keys: keyProjection(result.worker_receipt),
    next_action: next.action,
    persisted_equal: canonicalJson(persisted) === canonicalJson(result),
  };
}

function legacyUnmeteredPause(identity: RunIdentity, stateId: string) {
  return {
    schema_version: 2 as const,
    action: "paused" as const,
    identity,
    status: "running" as const,
    state_id: stateId,
    code: "LEGACY_UNMETERED" as const,
    reason: "active legacy run has no durable liveness policy; recovery is paused",
    retryable: true as const,
    recovery: {
      action: "recover" as const,
      run_id: identity.run_id,
      checkpoint_preserved: true,
    },
  };
}

function createBareResearchRun(identity: RunIdentity): RunContext {
  return RunContext.create({
    identity,
    goal: "Characterize fail-closed recovery.",
    constraints: {},
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 16,
  });
}

describe("TS-200 RP-0 serialized checkpoint compatibility", () => {
  it("locks protocol-v1 research pending writer bytes and restores the legacy fixture", () => {
    const legacyBytes = fixture("research-pending.context.v2.json");
    const expectedBytes = withCompletionProtocolV1(legacyBytes);
    const expectedDirective = fixtureDirective(
      "research-pending.context.v2.json",
      "pending_directive"
    );
    const writerRoot = temporaryDirectory("research-pending-writer");
    const writerDb = path.join(writerRoot, "orchestration.db");
    const writer = new Checkpointer(writerDb);
    const writerEngine = engine(writer, writerRoot);
    const emitted = startResearch(writerEngine, RESEARCH_PENDING_IDENTITY);
    expect(emitted).toEqual(expectedDirective);
    expect(contextJson(writerDb, RESEARCH_PENDING_IDENTITY.run_id)).toBe(expectedBytes);
    expect(canonicalJson(writer.loadRun(RESEARCH_PENDING_IDENTITY).snapshot())).toBe(expectedBytes);
    writer.close();

    const readerRoot = temporaryDirectory("research-pending-reader");
    const readerDb = path.join(readerRoot, "orchestration.db");
    initializeDatabase(readerDb);
    insertRunFixture({
      dbPath: readerDb,
      identity: RESEARCH_PENDING_IDENTITY,
      status: "running",
      stateId: "planning",
      serialized: legacyBytes,
    });
    const reader = new Checkpointer(readerDb);
    const readerEngine = engine(reader, readerRoot);
    expect(
      readerEngine.handle({
        schema_version: 2,
        action: "recover",
        identity: RESEARCH_PENDING_IDENTITY,
      })
    ).toEqual(legacyUnmeteredPause(RESEARCH_PENDING_IDENTITY, "planning"));
    expect(canonicalJson(reader.loadRun(RESEARCH_PENDING_IDENTITY).snapshot())).toBe(legacyBytes);
    reader.close();
  });

  it("locks protocol-v1 research terminal bytes and replays the legacy terminal fixture", () => {
    const legacyBytes = fixture("research-terminal.context.v2.json");
    const expectedDirective = fixtureDirective(
      "research-terminal.context.v2.json",
      "terminal_directive"
    );
    const writerRoot = temporaryDirectory("research-terminal-writer");
    const writerDb = path.join(writerRoot, "orchestration.db");
    const writer = new Checkpointer(writerDb);
    const writerEngine = engine(writer, writerRoot);
    startResearch(writerEngine, RESEARCH_TERMINAL_IDENTITY);
    const terminal = writerEngine.handle({
      schema_version: 2,
      action: "cancel",
      identity: RESEARCH_TERMINAL_IDENTITY,
      reason: "TS-200 fixture cancellation",
    });
    expect(terminal.action).toBe("cancelled");
    if (terminal.action !== "cancelled") throw new Error("expected cancelled writer terminal");
    expect(terminal.result.liveness).toMatchObject({
      schema_version: 1,
      policy_state: "bound",
      terminal_reason: null,
    });
    expect(terminal.result.best_partial_artifact_refs).toEqual([]);
    expect(terminal.result).not.toHaveProperty("report_dir");
    expect(contextJson(writerDb, RESEARCH_TERMINAL_IDENTITY.run_id)).toBe(
      canonicalJson(writer.loadRun(RESEARCH_TERMINAL_IDENTITY).snapshot())
    );
    writer.close();

    const readerRoot = temporaryDirectory("research-terminal-reader");
    const readerDb = path.join(readerRoot, "orchestration.db");
    initializeDatabase(readerDb);
    insertRunFixture({
      dbPath: readerDb,
      identity: RESEARCH_TERMINAL_IDENTITY,
      status: "cancelled",
      stateId: "cancelled",
      serialized: legacyBytes,
    });
    const reader = new Checkpointer(readerDb);
    const readerEngine = engine(reader, readerRoot);
    expect(
      readerEngine.handle({
        schema_version: 2,
        action: "recover",
        identity: RESEARCH_TERMINAL_IDENTITY,
      })
    ).toEqual(expectedDirective);
    reader.close();
  });

  it("locks the protocol-v1 path-free KB projection and restores the legacy fixture", () => {
    const legacyBytes = fixture("knowledge-base-compose.context.v1.json");
    const expectedBytes = withCompletionProtocolV1(legacyBytes);
    const writerRoot = temporaryDirectory("kb-writer");
    const writerDb = path.join(writerRoot, "orchestration.db");
    const writer = new Checkpointer(writerDb);
    const context = kbComposeContext();
    writer.createRun(context, "kb_fixture_created", {});
    expect(contextJson(writerDb, KB_IDENTITY.run_id)).toBe(expectedBytes);
    expect(expectedBytes).not.toContain(PROJECT_ROOT);
    expect(expectedBytes).not.toContain("project_root");
    expect(writer.loadRun(KB_IDENTITY).playbookData.phases).toEqual(context.playbookData.phases);
    writer.close();

    const readerRoot = temporaryDirectory("kb-reader");
    const readerDb = path.join(readerRoot, "orchestration.db");
    initializeDatabase(readerDb);
    insertRunFixture({
      dbPath: readerDb,
      identity: KB_IDENTITY,
      status: "running",
      stateId: "compose",
      serialized: legacyBytes,
    });
    const reader = new Checkpointer(readerDb);
    const readerEngine = engine(reader, readerRoot, {
      playbookName: "knowledge-base",
      livenessPolicyResolver: () =>
        kbLivenessPolicy({ action: "ingest", readerMaxCallsPerPhase: 16 }),
    });
    expect(
      readerEngine.handle({
        schema_version: 2,
        action: "recover",
        identity: KB_IDENTITY,
      })
    ).toEqual(legacyUnmeteredPause(KB_IDENTITY, "compose"));
    const restored = reader.loadRun(KB_IDENTITY);
    expect(restored.projectRoot).toBe(PROJECT_ROOT);
    expect(restored.playbookData.phases).toEqual(context.playbookData.phases);
    reader.close();
  });
});

describe("TS-200 restored-state acceptance and rejection policy", () => {
  it("machine-compares valid, malformed, missing, wrong-type, and extra research state", () => {
    const baseBytes = fixture("research-pending.context.v2.json");
    const base = requiredRecord(JSON.parse(baseBytes), "research pending context");
    const extraPlaybookData = {
      ...base,
      playbook_data: { future_field: "preserved" },
    };
    const cases = [
      { name: "valid_without_optional_playbook_data", serialized: baseBytes },
      { name: "malformed_json", serialized: '{"schema_version":2' },
      { name: "missing_required_goal", serialized: canonicalJson(withoutField(base, "goal")) },
      {
        name: "wrong_type_step_count",
        serialized: canonicalJson({ ...base, step_count: "1" }),
      },
      {
        name: "wrong_type_playbook_data",
        serialized: canonicalJson({ ...base, playbook_data: [] }),
      },
      {
        name: "extra_top_level_state",
        serialized: canonicalJson({ ...base, future_state: true }),
      },
      {
        name: "extra_playbook_data_member",
        serialized: canonicalJson(extraPlaybookData),
      },
    ];
    const root = temporaryDirectory("research-restore-policy");
    const dbPath = path.join(root, "orchestration.db");
    initializeDatabase(dbPath);
    insertRunFixture({
      dbPath,
      identity: RESEARCH_PENDING_IDENTITY,
      status: "running",
      stateId: "planning",
      serialized: baseBytes,
    });
    const checkpointer = new Checkpointer(dbPath);
    const actual = cases.map((entry) => {
      replaceContextJson(dbPath, RESEARCH_PENDING_IDENTITY.run_id, entry.serialized);
      return researchRestoreProjection(checkpointer, entry.name);
    });
    expect(actual).toEqual(fixtureObject("restore-policy.v1.json").research);
    checkpointer.close();
  });

  it("machine-compares the closed KB projection and absolute-path fail-closed rule", () => {
    const baseBytes = fixture("knowledge-base-compose.context.v1.json");
    const base = requiredRecord(JSON.parse(baseBytes), "KB compose context");
    const playbookData = requiredRecord(base.playbook_data, "KB playbook_data");
    const cases = [
      { name: "valid_path_free_projection", serialized: baseBytes },
      { name: "malformed_json", serialized: '{"durable_schema_version":1' },
      {
        name: "missing_required_playbook_data",
        serialized: canonicalJson(withoutField(base, "playbook_data")),
      },
      {
        name: "wrong_durable_schema_version",
        serialized: canonicalJson({ ...base, durable_schema_version: "1" }),
      },
      {
        name: "extra_top_level_state",
        serialized: canonicalJson({ ...base, future_state: true }),
      },
      {
        name: "nested_absolute_path",
        serialized: canonicalJson({
          ...base,
          playbook_data: { ...playbookData, future_locator: "/absolute-path-fixture" },
        }),
      },
    ];
    const root = temporaryDirectory("kb-restore-policy");
    const dbPath = path.join(root, "orchestration.db");
    initializeDatabase(dbPath);
    insertRunFixture({
      dbPath,
      identity: KB_IDENTITY,
      status: "running",
      stateId: "compose",
      serialized: baseBytes,
    });
    const checkpointer = new Checkpointer(dbPath);
    checkpointer.bindKbRuntimeProjectRoot(PROJECT_ROOT);
    const actual = cases.map((entry) => {
      replaceContextJson(dbPath, KB_IDENTITY.run_id, entry.serialized);
      return kbRestoreProjection(checkpointer, entry.name);
    });
    expect(actual).toEqual(fixtureObject("restore-policy.v1.json").knowledge_base);
    checkpointer.close();
  });
});

describe("TS-200 result/details envelopes", () => {
  it("locks the exact accepted PhaseResult bytes and persisted receipt envelope", () => {
    const root = temporaryDirectory("result-envelope");
    const dbPath = path.join(root, "orchestration.db");
    const checkpointer = new Checkpointer(dbPath);
    const orchestration = engine(checkpointer, root);
    const pending = startResearch(orchestration, {
      ...RESEARCH_PENDING_IDENTITY,
      run_id: "run_ts200_result_envelope",
    });
    const result = planningResult({
      orchestration,
      pending,
      details: {
        plan_steps: ["Inspect the durable checkpoint contract."],
        plan_complete: true,
        mode: "standard",
      },
      receiptId: "receipt_ts200_valid",
    });
    const expectedBytes = fixture("research-planning-result.v2.json");
    expect(canonicalJson(result)).toBe(expectedBytes);
    const next = orchestration.handle({
      schema_version: 2,
      action: "step",
      identity: pending.identity,
      result,
    });
    expect(receiptJson(dbPath, result.worker_receipt.receipt_id)).toBe(expectedBytes);
    const projection = phaseResultProjection(
      result,
      next,
      checkpointer.receiptResult(result.worker_receipt)
    );
    expect(projection).toEqual(fixtureObject("contract-projection.v1.json").valid_phase_result);
    checkpointer.close();
  });

  it("fails closed when details are missing without changing the checkpoint", () => {
    const root = temporaryDirectory("missing-details");
    const dbPath = path.join(root, "orchestration.db");
    const checkpointer = new Checkpointer(dbPath);
    const orchestration = engine(checkpointer, root);
    const identity = { ...RESEARCH_PENDING_IDENTITY, run_id: "run_ts200_missing_details" };
    const pending = startResearch(orchestration, identity);
    const result = planningResult({
      orchestration,
      pending,
      details: { plan_steps: ["Inspect state."], plan_complete: true },
      receiptId: "receipt_ts200_missing_details",
    });
    const missingDetails = withoutField({ ...result }, "details");
    const before = contextJson(dbPath, identity.run_id);
    let caught: unknown;
    try {
      orchestration.handle({
        schema_version: 2,
        action: "step",
        identity,
        result: missingDetails,
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof ContractValidationError)) {
      throw new Error("missing details did not fail with ContractValidationError");
    }
    const projection = {
      error_name: caught.name,
      detail_issues: caught.issues.filter((issue) => issue.startsWith("/result:")),
      checkpoint_unchanged: contextJson(dbPath, identity.run_id) === before,
      receipt_persisted: checkpointer.receiptResult(result.worker_receipt) !== undefined,
    };
    expect(projection).toEqual(fixtureObject("contract-projection.v1.json").missing_details);
    checkpointer.close();
  });

  it("persists an outer-valid extra detail but reissues it as malformed_result", () => {
    const root = temporaryDirectory("extra-details");
    const dbPath = path.join(root, "orchestration.db");
    const checkpointer = new Checkpointer(dbPath);
    const orchestration = engine(checkpointer, root);
    const identity = { ...RESEARCH_PENDING_IDENTITY, run_id: "run_ts200_extra_details" };
    const pending = startResearch(orchestration, identity);
    const result = planningResult({
      orchestration,
      pending,
      details: {
        plan_steps: ["Inspect state."],
        plan_complete: true,
        future_detail: true,
      },
      receiptId: "receipt_ts200_extra_details",
    });
    const next = orchestration.handle({
      schema_version: 2,
      action: "step",
      identity,
      result,
    });
    const malformedEvent = checkpointer
      .events(identity.run_id)
      .find((event) => event.eventType === "phase_result_malformed");
    if (malformedEvent === undefined) throw new Error("malformed result event was not persisted");
    const restored = checkpointer.loadRun(identity);
    const projection = {
      next_action: next.action,
      event_type: malformedEvent.eventType,
      feedback_kind: malformedEvent.payload.feedback_kind,
      state_id: restored.stateId,
      step_count: restored.stepCount,
      persisted_equal:
        canonicalJson(checkpointer.receiptResult(result.worker_receipt)) === canonicalJson(result),
    };
    expect(projection).toEqual(fixtureObject("contract-projection.v1.json").extra_details);
    checkpointer.close();
  });
});

describe("TS-200 recovery error codes and fail-closed behavior", () => {
  it("machine-compares unavailable-playbook, invalid-dispatch, and missing-directive recovery", () => {
    const projection: Record<string, unknown> = {};

    const unknownRoot = temporaryDirectory("unknown-playbook");
    const unknownDb = path.join(unknownRoot, "orchestration.db");
    const unknownCheckpointer = new Checkpointer(unknownDb);
    unknownCheckpointer.createRun(
      createBareResearchRun(UNKNOWN_IDENTITY),
      "unknown_fixture_created",
      {}
    );
    const unknownBefore = contextJson(unknownDb, UNKNOWN_IDENTITY.run_id);
    const unknownEngine = engine(unknownCheckpointer, unknownRoot);
    projection.unavailable_playbook = {
      directive: unknownEngine.handle({
        schema_version: 2,
        action: "recover",
        identity: UNKNOWN_IDENTITY,
      }),
      checkpoint_unchanged: contextJson(unknownDb, UNKNOWN_IDENTITY.run_id) === unknownBefore,
    };
    unknownCheckpointer.close();

    const dispatchRoot = temporaryDirectory("invalid-dispatch");
    const dispatchDb = path.join(dispatchRoot, "orchestration.db");
    initializeDatabase(dispatchDb);
    insertRunFixture({
      dbPath: dispatchDb,
      identity: RESEARCH_PENDING_IDENTITY,
      status: "running",
      stateId: "planning",
      serialized: fixture("research-pending.context.v2.json"),
    });
    const dispatchCheckpointer = new Checkpointer(dispatchDb);
    const dispatchBefore = contextJson(dispatchDb, RESEARCH_PENDING_IDENTITY.run_id);
    const dispatchEngine = engine(dispatchCheckpointer, dispatchRoot, {
      dispatchMode: () => "unexpected-mode",
    });
    projection.invalid_dispatch_mode = {
      directive: dispatchEngine.handle({
        schema_version: 2,
        action: "recover",
        identity: RESEARCH_PENDING_IDENTITY,
      }),
      checkpoint_unchanged:
        contextJson(dispatchDb, RESEARCH_PENDING_IDENTITY.run_id) === dispatchBefore,
    };
    dispatchCheckpointer.close();

    const missingRoot = temporaryDirectory("missing-directive");
    const missingDb = path.join(missingRoot, "orchestration.db");
    const missingCheckpointer = new Checkpointer(missingDb);
    const missingIdentity = {
      ...RESEARCH_PENDING_IDENTITY,
      run_id: "run_ts200_missing_directive",
    };
    missingCheckpointer.createRun(
      createBareResearchRun(missingIdentity),
      "missing_directive_fixture_created",
      {}
    );
    const missingBefore = contextJson(missingDb, missingIdentity.run_id);
    const missingEngine = engine(missingCheckpointer, missingRoot);
    projection.missing_directive = {
      directive: missingEngine.handle({
        schema_version: 2,
        action: "recover",
        identity: missingIdentity,
      }),
      checkpoint_unchanged: contextJson(missingDb, missingIdentity.run_id) === missingBefore,
    };
    missingCheckpointer.close();

    expect(projection).toEqual(fixtureObject("contract-projection.v1.json").recovery_fail_closed);
  });
});
