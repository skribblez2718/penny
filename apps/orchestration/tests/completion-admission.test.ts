import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer, canonicalJson, type StartAdmissionInput } from "../src/checkpointer.js";
import {
  validateDirective,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type JsonValue,
  type RunIdentity,
  type SkillContract,
} from "../src/contracts.js";
import { RunContext } from "../src/context.js";
import { orchestrationDurableStateCodec } from "../src/durable-state.js";
import { OrchestrationEngine } from "../src/engine.js";
import type { PlaybookCoreV1 } from "../src/playbooks/playbook.js";
import type { PlaybookRegistrationV1, PlaybookRegistryV1 } from "../src/playbooks/registry.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];
const PLAYBOOK = "completion-admission-test";

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "penny-completion-admission-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function identity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: "session_completion_admission",
    playbook: PLAYBOOK,
    engine_owner: "typescript",
  };
}

function artifact(version: number, operation = "op_completion"): ArtifactRef {
  const digest = String(version).padStart(64, "a").slice(-64);
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: "upstream_run",
    phase: "origin",
    branch_id: null,
    kind: "agent-output",
    operation_id: operation,
    version,
    producer: "agent:test",
    media_type: "text/plain",
    byte_length: version,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function terminal(context: RunContext): Directive {
  const origin = context.stateId;
  context.previousState = origin;
  context.stateId = "complete";
  context.status = "complete";
  context.met = true;
  context.pendingBranches = [];
  const mode = String(context.constraints.terminal_artifacts ?? "all");
  const artifacts =
    mode === "none"
      ? []
      : mode === "first"
        ? context.selectedArtifacts.slice(0, 1)
        : [...context.selectedArtifacts];
  const next = validateDirective({
    schema_version: 2,
    action: "complete",
    identity: context.identity,
    status: "complete",
    met: true,
    result: { met: true, product: "candidate" },
    artifacts,
    unresolved: context.constraints.unresolved === true ? ["candidate warning"] : [],
  });
  if (context.constraints.forge_previous === true) context.previousState = "origin";
  context.pendingDirective = next;
  context.terminalDirective = next;
  return next;
}

class AdmissionPlaybook implements PlaybookCoreV1 {
  initialize(context: RunContext): Directive {
    if (context.constraints.missing_required !== true) context.transition("required");
    context.transition(context.constraints.forbidden_origin === true ? "forbidden" : "origin");
    return terminal(context);
  }

  dispatch(context: RunContext): Directive {
    return terminal(context);
  }

  resume(context: RunContext, _response: JsonValue): Directive {
    return terminal(context);
  }

  cancel(context: RunContext): Directive {
    context.status = "cancelled";
    context.met = false;
    const next = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: {},
      artifacts: context.selectedArtifacts,
      unresolved: [],
    });
    context.terminalDirective = next;
    return next;
  }

  validateDetails(_state: string, details: Record<string, JsonValue>): Record<string, JsonValue> {
    return details;
  }

  acceptSummary(
    context: RunContext,
    _details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    return terminal(context);
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
}

function contract(
  latestProduct: SkillContract["completion_gate"]["latest_product"] = {
    selector: "terminal_result",
    schema_id: "penny.orchestration.terminal-result",
    product_schema_version: 2,
  },
  overrides: Partial<SkillContract["completion_gate"]> = {}
): SkillContract {
  return {
    ...RESEARCH_SKILL_CONTRACT,
    name: PLAYBOOK,
    repair_routing: { schema_version: 1, routes: [] },
    completion_gate: {
      schema_version: 2,
      allowed_terminal_origins: ["origin"],
      required_visited_states: ["required"],
      required_receipt_predicates: [],
      latest_product: latestProduct,
      unresolved_policy: { mode: "allow_any" },
      ...overrides,
    },
  };
}

function registration(skillContract = contract()): PlaybookRegistrationV1 {
  return {
    name: PLAYBOOK,
    contract: skillContract,
    ingress: "dedicated_tool",
    liveness: {
      resolver_id: skillContract.budget_policy.resolver_id,
      resolve: () => undefined,
      thinking_policy: "agent_ssot",
    },
    worker: {
      kind: "catalog-agent",
      workflow_name: PLAYBOOK,
      guidance: skillContract.guidance,
      guidance_required: true,
      result_transport: "persisted_summary",
      opening_policy: "registration_guidance_task_artifacts",
      model_policy: "directive_override_or_runtime_default",
      phases: new Map([
        [
          "origin",
          {
            agent: "test",
            result_schema_id: "penny.test.completion-admission-summary",
            result_schema_version: 1,
            schema: Type.Record(Type.String(), Type.Unknown()),
          },
        ],
      ]),
    },
    completionReceiptPredicates: new Map(),
    construct: () => new AdmissionPlaybook(),
  };
}

function runtime(input: {
  projectRoot: string;
  skillContract?: SkillContract;
  observer?: () => void;
}): { checkpointer: Checkpointer; engine: OrchestrationEngine; dbPath: string } {
  const dbPath = path.join(input.projectRoot, "orchestration.db");
  const checkpointer = new Checkpointer(dbPath, input.observer);
  const active = registration(input.skillContract);
  const registry: PlaybookRegistryV1 = new Map([[PLAYBOOK, active]]);
  return {
    checkpointer,
    dbPath,
    engine: new OrchestrationEngine(checkpointer, {
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      projectRoot: input.projectRoot,
      maxSteps: 16,
      playbookName: PLAYBOOK,
      playbookRegistry: registry,
    }),
  };
}

function start(
  engine: OrchestrationEngine,
  projectRoot: string,
  runId: string,
  constraints: Record<string, JsonValue> = {},
  artifacts: ArtifactRef[] = []
): Directive {
  return engine.handle({
    schema_version: 2,
    action: "start",
    identity: identity(runId),
    goal: "Exercise completion admission.",
    constraints,
    project_root: projectRoot,
    trust_profile: "trusted-interactive",
    ...(artifacts.length > 0
      ? {
          input_artifacts: {
            schema_version: 2,
            artifacts: artifacts.map((ref, index) => ({ slot: `input-${index}`, ref })),
          },
        }
      : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rawDatabase(dbPath: string): DatabaseSync {
  const sqlite = process.getBuiltinModule("node:sqlite");
  if (sqlite === undefined) throw new Error("node:sqlite is unavailable");
  return new sqlite.DatabaseSync(dbPath);
}

function startAdmission(runId: string): StartAdmissionInput {
  const transactionId = `tx_${runId}`;
  return {
    session_id: identity(runId).session_id,
    invocation_id: `invocation_${runId}`,
    request_sha256: "c".repeat(64),
    action: "query",
    profile_id: "kbp_completion_admission",
    transaction_id: transactionId,
    private_input_id: `private_${runId}`,
    storage_key: `${runId}/request.json`,
    temporary_storage_key: `${runId}/.${transactionId}.tmp`,
  };
}

describe("P1.1 central completion admission", () => {
  it("admits once with append-only visits and exact replay even when observability throws", () => {
    const projectRoot = root();
    const { checkpointer, engine } = runtime({
      projectRoot,
      observer: () => {
        throw new Error("observability unavailable");
      },
    });
    const runId = "run_admitted_once";
    const admitted = start(engine, projectRoot, runId);
    expect(admitted).toMatchObject({ action: "complete", status: "complete", met: true });
    expect(checkpointer.loadRun(identity(runId)).completionProtocolVersion).toBe(1);
    expect(checkpointer.loadRun(identity(runId)).snapshot().completion_protocol_version).toBe(1);

    const envelope = checkpointer.completionAdmission(runId);
    expect(envelope).toMatchObject({
      schema_version: 1,
      run_id: runId,
      origin_state: "origin",
      latest_product: {
        selector: "terminal_result",
        schema_id: "penny.orchestration.terminal-result",
        product_schema_version: 2,
      },
      evidence_refs: [],
      unresolved_count: 0,
    });
    expect(checkpointer.stateVisits(runId).map((visit) => visit.state_id)).toEqual([
      "intake",
      "required",
      "origin",
    ]);
    expect(
      engine.handle({ schema_version: 2, action: "status", identity: identity(runId) })
    ).toEqual(admitted);
    expect(
      engine.handle({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(admitted);
    expect(
      checkpointer.events(runId).filter((event) => event.payload.completion_admission_v1)
    ).toHaveLength(1);
    checkpointer.close();
  });

  it("refuses missing visit evidence to durable incomplete while preserving artifacts", () => {
    const projectRoot = root();
    const { checkpointer, engine } = runtime({ projectRoot });
    const ref = artifact(1);
    const result = start(engine, projectRoot, "run_missing_visit", { missing_required: true }, [
      ref,
    ]);
    expect(result).toMatchObject({
      action: "incomplete",
      status: "incomplete",
      met: false,
      artifacts: [ref],
      result: {
        met: false,
        completion_admission: {
          admitted: false,
          failure_codes: ["REQUIRED_STATE_NOT_VISITED"],
        },
      },
    });
    expect(checkpointer.completionAdmission("run_missing_visit")).toBeUndefined();
    expect(checkpointer.completionRefusal("run_missing_visit")?.failure_codes).toEqual([
      "REQUIRED_STATE_NOT_VISITED",
    ]);
    expect(checkpointer.loadRun(identity("run_missing_visit")).terminalDirective).toEqual(result);
    checkpointer.close();
  });

  it("uses the final visit instead of forged previousState and enforces unresolved max_count", () => {
    const projectRoot = root();
    const { checkpointer, engine } = runtime({
      projectRoot,
      skillContract: contract(undefined, {
        unresolved_policy: { mode: "max_count", max_count: 0 },
      }),
    });
    const refused = start(engine, projectRoot, "run_forged_origin", {
      forbidden_origin: true,
      forge_previous: true,
      unresolved: true,
    });
    expect(refused).toMatchObject({ action: "incomplete", met: false });
    expect(checkpointer.completionRefusal("run_forged_origin")?.failure_codes).toEqual([
      "TERMINAL_ORIGIN_NOT_ALLOWED",
      "UNRESOLVED_LIMIT_EXCEEDED",
    ]);
    checkpointer.close();
  });

  it.each([
    ["none", [], "LATEST_PRODUCT_MISSING"],
    ["all", [artifact(1), artifact(2, "op_other")], "LATEST_PRODUCT_AMBIGUOUS"],
    ["first", [artifact(1), artifact(2)], "LATEST_PRODUCT_MISMATCH"],
  ] as const)("refuses %s terminal-artifact selection deterministically", (mode, refs, code) => {
    const projectRoot = root();
    const artifactContract = contract({
      selector: "terminal_artifact",
      schema_id: "test.legacy-product",
      product_schema_version: 1,
      artifact_kind: "agent-output",
      producing_state: "origin",
    });
    const { checkpointer, engine } = runtime({ projectRoot, skillContract: artifactContract });
    const result = start(engine, projectRoot, `run_product_${mode}`, { terminal_artifacts: mode }, [
      ...refs,
    ]);
    expect(result).toMatchObject({ action: "incomplete", met: false });
    expect(checkpointer.completionRefusal(`run_product_${mode}`)?.failure_codes).toContain(code);
    checkpointer.close();
  });

  it("rejects forged reserved payloads and direct positive writes without admission", () => {
    const projectRoot = root();
    const checkpointer = new Checkpointer(path.join(projectRoot, "barrier.db"));
    const context = RunContext.create({
      identity: identity("run_write_barrier"),
      goal: "Barrier fixture",
      constraints: {},
      projectRoot,
      trustProfile: "trusted-interactive",
      maxSteps: 8,
    });
    expect(() => checkpointer.createRun(context, "run_created", { state_visits_v1: [] })).toThrow(
      /reserved key/
    );
    checkpointer.createRun(context, "run_created", {});
    context.previousState = context.stateId;
    context.stateId = "complete";
    context.status = "complete";
    context.met = true;
    context.terminalDirective = validateDirective({
      schema_version: 2,
      action: "complete",
      identity: context.identity,
      status: "complete",
      met: true,
      result: {},
      artifacts: [],
      unresolved: [],
    });
    expect(() => checkpointer.saveRun(context, "forged_positive", {})).toThrow(
      /lacks completion admission/
    );
    expect(checkpointer.loadRun(identity("run_write_barrier")).terminalDirective).toBeNull();
    checkpointer.close();
  });

  it("requires protocol version 1 for createRun and admitStartRun inserts", () => {
    const projectRoot = root();
    const checkpointer = new Checkpointer(path.join(projectRoot, "protocol-version.db"));
    const fresh = RunContext.create({
      identity: identity("run_protocol_version"),
      goal: "Protocol discriminator fixture",
      constraints: {},
      projectRoot,
      trustProfile: "trusted-interactive",
      maxSteps: 8,
    });
    const legacySnapshot = structuredClone(fresh.snapshot());
    delete legacySnapshot.completion_protocol_version;
    const unversioned = RunContext.fromSnapshot(legacySnapshot);

    expect(() => checkpointer.createRun(unversioned, "run_created", {})).toThrow(
      /lacks completion protocol version 1/
    );
    expect(checkpointer.runExists(fresh.identity.run_id)).toBe(false);

    expect(() =>
      checkpointer.admitStartRun(unversioned, startAdmission(fresh.identity.run_id))
    ).toThrow(/lacks completion protocol version 1/);
    expect(checkpointer.runExists(fresh.identity.run_id)).toBe(false);
    expect(checkpointer.getStartAdmission(fresh.identity.run_id)).toBeUndefined();
    expect(checkpointer.getPrivateInput(fresh.identity.run_id)).toBeUndefined();

    checkpointer.createRun(fresh, "run_created", {});
    expect(checkpointer.loadRun(fresh.identity).completionProtocolVersion).toBe(1);
    checkpointer.close();
  });

  it("rejects a newly persisted positive run state without a terminal directive", () => {
    const projectRoot = root();
    const checkpointer = new Checkpointer(path.join(projectRoot, "missing-terminal.db"));
    const context = RunContext.create({
      identity: identity("run_positive_state_only"),
      goal: "Positive state attack fixture",
      constraints: {},
      projectRoot,
      trustProfile: "trusted-interactive",
      maxSteps: 8,
    });
    context.stateId = "complete";
    context.status = "complete";
    context.met = true;

    expect(() => checkpointer.createRun(context, "forged_positive_state", {})).toThrow(
      /positive run state lacks matching completion admission/
    );
    expect(checkpointer.runExists(context.identity.run_id)).toBe(false);
    expect(checkpointer.events(context.identity.run_id)).toEqual([]);

    const persisted = RunContext.create({
      identity: identity("run_positive_state_update"),
      goal: "Persisted positive state attack fixture",
      constraints: {},
      projectRoot,
      trustProfile: "trusted-interactive",
      maxSteps: 8,
    });
    checkpointer.createRun(persisted, "run_created", {});
    persisted.stateId = "complete";
    persisted.status = "complete";
    persisted.met = true;
    expect(() => checkpointer.saveRun(persisted, "forged_positive_state", {})).toThrow(
      /positive run state lacks matching completion admission/
    );
    expect(checkpointer.loadRun(persisted.identity)).toMatchObject({
      status: "running",
      stateId: "intake",
      met: false,
      terminalDirective: null,
    });
    checkpointer.close();
  });

  it("fails engine construction on an unknown host predicate", () => {
    const projectRoot = root();
    const dbPath = path.join(projectRoot, "unknown-predicate.db");
    const checkpointer = new Checkpointer(dbPath);
    const bad = registration(
      contract(undefined, { required_receipt_predicates: ["unknown.predicate.v1"] })
    );
    expect(
      () =>
        new OrchestrationEngine(checkpointer, {
          receiptAuthority: TEST_RECEIPT_AUTHORITY,
          projectRoot,
          maxSteps: 8,
          playbookName: PLAYBOOK,
          playbookRegistry: new Map([[PLAYBOOK, bad]]),
        })
    ).toThrow(/COMPLETION_PREDICATE_UNKNOWN/);
    checkpointer.close();
  });

  it("replays an exact legacy positive without fabricating an envelope", () => {
    const projectRoot = root();
    const { checkpointer, dbPath } = runtime({ projectRoot });
    const context = RunContext.create({
      identity: identity("run_legacy_positive"),
      goal: "Legacy fixture",
      constraints: {},
      projectRoot,
      trustProfile: "trusted-interactive",
      maxSteps: 8,
    });
    checkpointer.createRun(context, "legacy_started", {});
    context.previousState = "intake";
    context.stateId = "complete";
    context.status = "complete";
    context.met = true;
    const legacy = validateDirective({
      schema_version: 2,
      action: "complete",
      identity: context.identity,
      status: "complete",
      met: true,
      result: { legacy: true },
      artifacts: [],
      unresolved: [],
    });
    context.terminalDirective = legacy;
    context.pendingDirective = legacy;
    const legacySnapshot = structuredClone(context.snapshot());
    delete legacySnapshot.completion_protocol_version;
    const checkpoint = canonicalJson(
      orchestrationDurableStateCodec.encodeCheckpoint(legacySnapshot)
    );
    checkpointer.close();
    const db = rawDatabase(dbPath);
    db.prepare(
      "UPDATE runs SET status='complete', state_id='complete', context_json=? WHERE run_id=?"
    ).run(checkpoint, context.identity.run_id);
    // A true pre-W7 event has none of the reserved completion-protocol metadata.
    db.prepare("UPDATE events SET payload_json=? WHERE run_id=?").run(
      canonicalJson({}),
      context.identity.run_id
    );
    db.close();

    const reopened = runtime({ projectRoot });
    expect(
      reopened.engine.handle({
        schema_version: 2,
        action: "status",
        identity: context.identity,
      })
    ).toEqual(legacy);
    expect(
      reopened.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: context.identity,
      })
    ).toEqual(legacy);
    expect(
      reopened.checkpointer.loadRun(context.identity).completionProtocolVersion
    ).toBeUndefined();
    expect(reopened.checkpointer.completionAdmission(context.identity.run_id)).toBeUndefined();
    reopened.checkpointer.close();
  });

  it("fails closed when all protocol event metadata is removed from an admitted protocol-v1 positive", () => {
    const projectRoot = root();
    const first = runtime({ projectRoot });
    const runId = "run_all_protocol_metadata_removed";
    const admittedContext = RunContext.create({
      identity: identity(runId),
      goal: "Admitted protocol discriminator attack fixture",
      constraints: {},
      projectRoot,
      trustProfile: "trusted-interactive",
      maxSteps: 8,
    });
    expect(first.checkpointer.admitStartRun(admittedContext, startAdmission(runId))).toEqual({
      kind: "created",
      run_id: runId,
    });
    expect(start(first.engine, projectRoot, runId)).toMatchObject({
      action: "complete",
      status: "complete",
      met: true,
    });
    first.checkpointer.close();

    const db = rawDatabase(first.dbPath);
    const runRow = db.prepare("SELECT context_json FROM runs WHERE run_id=?").get(runId);
    const contextJson = runRow?.["context_json"];
    if (typeof contextJson !== "string") throw new Error("run context is absent");
    const durableContext: unknown = JSON.parse(contextJson);
    if (!isRecord(durableContext)) throw new Error("run context is malformed");
    expect(durableContext["completion_protocol_version"]).toBe(1);

    const rows = db.prepare("SELECT sequence, payload_json FROM events WHERE run_id=?").all(runId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const sequence = row["sequence"];
      const payloadJson = row["payload_json"];
      if (typeof sequence !== "number" || typeof payloadJson !== "string") {
        throw new Error("protocol event row is malformed");
      }
      const payload: unknown = JSON.parse(payloadJson);
      if (!isRecord(payload)) throw new Error("protocol event payload is malformed");
      delete payload["state_visits_v1"];
      delete payload["completion_admission_v1"];
      delete payload["completion_refusal_v1"];
      db.prepare("UPDATE events SET payload_json=? WHERE run_id=? AND sequence=?").run(
        canonicalJson(payload),
        runId,
        sequence
      );
    }
    db.close();

    const reopened = runtime({ projectRoot });
    expect(reopened.checkpointer.hasCompletionProtocolMetadata(runId)).toBe(false);
    expect(reopened.checkpointer.loadRun(identity(runId)).completionProtocolVersion).toBe(1);
    for (const action of ["status", "recover"] as const) {
      expect(() =>
        reopened.engine.handle({ schema_version: 2, action, identity: identity(runId) })
      ).toThrow(/missing completion admission evidence/);
    }
    expect(reopened.checkpointer.events(runId)).toHaveLength(rows.length);
    reopened.checkpointer.close();
  });

  it("fails closed on a missing protocol-v1 envelope during status and recover", () => {
    const projectRoot = root();
    const first = runtime({ projectRoot });
    const runId = "run_missing_envelope";
    start(first.engine, projectRoot, runId);
    first.checkpointer.close();

    const db = rawDatabase(first.dbPath);
    const row = db
      .prepare("SELECT payload_json FROM events WHERE run_id=? AND event_type='run_started'")
      .get(runId);
    const payloadJson = row?.["payload_json"];
    if (typeof payloadJson !== "string") throw new Error("admission event payload is absent");
    const payload: unknown = JSON.parse(payloadJson);
    if (!isRecord(payload)) throw new Error("admission event payload is malformed");
    expect(payload["state_visits_v1"]).toBeDefined();
    expect(delete payload["completion_admission_v1"]).toBe(true);
    db.prepare("UPDATE events SET payload_json=? WHERE run_id=? AND event_type='run_started'").run(
      canonicalJson(payload),
      runId
    );
    db.close();

    const reopened = runtime({ projectRoot });
    for (const action of ["status", "recover"] as const) {
      expect(() =>
        reopened.engine.handle({ schema_version: 2, action, identity: identity(runId) })
      ).toThrow(/missing completion admission evidence/);
    }
    expect(reopened.checkpointer.events(runId)).toHaveLength(1);
    reopened.checkpointer.close();
  });

  it("fails closed on a corrupt protocol-v1 envelope instead of regenerating it", () => {
    const projectRoot = root();
    const first = runtime({ projectRoot });
    const runId = "run_corrupt_envelope";
    start(first.engine, projectRoot, runId);
    first.checkpointer.close();

    const db = rawDatabase(first.dbPath);
    const row = db
      .prepare("SELECT payload_json FROM events WHERE run_id=? AND event_type='run_started'")
      .get(runId);
    const payloadJson = row?.["payload_json"];
    if (typeof payloadJson !== "string") throw new Error("admission event payload is absent");
    const payload: unknown = JSON.parse(payloadJson);
    if (!isRecord(payload)) throw new Error("admission event payload is malformed");
    const envelope = payload["completion_admission_v1"];
    if (!isRecord(envelope)) throw new Error("admission envelope is absent");
    envelope["terminal_digest"] = "0".repeat(64);
    db.prepare("UPDATE events SET payload_json=? WHERE run_id=? AND event_type='run_started'").run(
      canonicalJson(payload),
      runId
    );
    db.close();

    const reopened = runtime({ projectRoot });
    for (const action of ["status", "recover"] as const) {
      expect(() =>
        reopened.engine.handle({ schema_version: 2, action, identity: identity(runId) })
      ).toThrow(/corrupt completion admission evidence/);
    }
    expect(reopened.checkpointer.events(runId)).toHaveLength(1);
    reopened.checkpointer.close();
  });
});
