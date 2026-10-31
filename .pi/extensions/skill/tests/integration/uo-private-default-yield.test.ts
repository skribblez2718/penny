/** One catalog-owner private-context evidence leaf; anonymous KB matrices are NOT equivalent. */
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_WORKER_CONTINUITY_METADATA,
  OrchestrationService,
  assertCurrentShippingBuild,
  initializePennyState,
  parseSsotTools,
  validateCatalogWorkerContinuityMetadata,
  type SkillResult,
} from "@penny/orchestration";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord, requireDefined } from "../../../../lib/tests/test-narrowers.js";
import skillExtension from "../../index.js";
import { repository } from "../helpers/uo-continuation-fixture.js";
import {
  privateBody,
  privateFailure,
  privateRequest,
  privateContextFixture,
  type PrivateCase,
} from "../helpers/uo-private-context-fixture.js";

// Bind to the verified current build once; never refresh the expected generation mid-run.
const compiledGeneration = requireDefined(
  assertCurrentShippingBuild(),
  "compiled identity absent"
).generation;

const { DatabaseSync } = requireDefined(process.getBuiltinModule("node:sqlite"));

// Supported service options only: inject offline SDK cognition + a trusted resolver adapter.
// No registry, owner, resolver, metadata, session or compaction implementation is replaced.
const injection = vi.hoisted(() => ({
  configure: undefined as
    | ((
        options: ConstructorParameters<typeof OrchestrationService>[0]
      ) => Pick<
        ConstructorParameters<typeof OrchestrationService>[0],
        "modelClient" | "researchContextProviders"
      >)
    | undefined,
}));
vi.mock("@penny/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@penny/orchestration")>();
  return {
    ...actual,
    OrchestrationService: class extends actual.OrchestrationService {
      constructor(options: ConstructorParameters<typeof actual.OrchestrationService>[0]) {
        super({
          ...options,
          ...requireDefined(injection.configure, "offline service wiring absent")(options),
        });
      }
    },
  };
});
interface PublicSkill {
  name: "skill";
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    context: unknown
  ): Promise<{ details: SkillResult }>;
}
function isPublicSkill(value: unknown): value is PublicSkill {
  return isRecord(value) && value.name === "skill" && typeof value.execute === "function";
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  injection.configure = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(requireDefined(assertCurrentShippingBuild(), "compiled identity absent").generation).toBe(
    compiledGeneration
  );
});
function fixture(mode: PrivateCase) {
  expect(requireDefined(assertCurrentShippingBuild(), "compiled identity absent").generation).toBe(
    compiledGeneration
  );
  const f = privateContextFixture(mode);
  cleanups.push(f.cleanup);
  const env = {
    PROJECT_ROOT: f.projectRoot,
    PENNY_STATE_ROOT: `${f.root}/state`,
    PI_CODING_AGENT_DIR: f.agentDir,
    PENNY_SKILLS_DIR: `${repository}/.pi/skills`,
    PI_OBSERVABILITY_ENABLED: "false",
    PI_OBSERVABILITY_API_KEY: "offline-fixture-only",
    PI_OBSERVABILITY_REST_URL: "http://telemetry.invalid",
    PENNY_TOOL_RESULT_MAX_BYTES: "6000",
    PI_COMPACTION_SUMMARY_MODEL: "",
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const requests: string[] = [];
  vi.stubGlobal("fetch", async () => {
    requests.push("blocked fetch");
    throw new Error("External network forbidden");
  });
  initializePennyState(f.projectRoot, { env: process.env });
  injection.configure = (options) => ({
    modelClient: f.client(options),
    researchContextProviders: f.providers,
  });
  let selected: PublicSkill | undefined;
  skillExtension(
    createTestExtensionApi({
      onRegisterTool(value) {
        if (isPublicSkill(value)) selected = value;
      },
    })
  );
  const tool = requireDefined(selected, "public skill absent");
  const run = () =>
    tool.execute(
      "private-default-yield",
      {
        skill_name: "research",
        session_id: "private-default-yield",
        ...privateRequest,
        model: "faux/continuation",
      },
      undefined,
      undefined,
      {
        cwd: f.projectRoot,
        isProjectTrusted: () => true,
        ui: { theme: { fg: (_color: string, text: string) => text }, notify() {} },
      }
    );
  return { ...f, run, requests };
}
type Fixture = ReturnType<typeof fixture>;
function owner(f: Fixture) {
  return new OrchestrationService({ projectRoot: f.projectRoot, playbookName: "research" });
}
function runId(service: OrchestrationService) {
  using db = new DatabaseSync(service.config.dbPath, { readOnly: true });
  const rows = db.prepare("SELECT run_id FROM runs").all();
  expect(rows).toHaveLength(1);
  const value = requireDefined(rows[0]).run_id;
  if (typeof value !== "string") throw new Error("run identity absent");
  return value;
}
function excludesPrivate(value: string) {
  expect(value).not.toContain(privateBody);
  expect(value).not.toContain(privateFailure);
}
function assertGenericCustody(f: Fixture, service: OrchestrationService, id: string) {
  const checkpoint = requireDefined(service.checkpointer.loadRunById(id));
  excludesPrivate(JSON.stringify(checkpoint));
  excludesPrivate(JSON.stringify(service.checkpointer.events(id)));
  excludesPrivate(JSON.stringify(service.checkpointer.completionAdmission(id)) ?? "");
  // Inspect all artifacts in this disposable run, including unselected/unreferenced products.
  using manifest = new DatabaseSync(path.join(service.config.artifactRoot, "manifest.db"), {
    readOnly: true,
  });
  const rows = manifest
    .prepare(
      "SELECT artifact_id, ref_json, metadata_json FROM artifacts WHERE run_id = ? ORDER BY artifact_id"
    )
    .all(id);
  expect(rows.length).toBeGreaterThan(0);
  const kinds: string[] = [];
  for (const row of rows) {
    const artifactId = row.artifact_id;
    if (typeof artifactId !== "string") throw new Error("invalid manifest identity");
    excludesPrivate(JSON.stringify(row));
    const ref = requireDefined(service.artifacts.refById(artifactId));
    kinds.push(ref.kind);
    excludesPrivate(service.artifacts.read(ref).toString("utf8"));
  }
  expect(kinds).toContain("context-source-ref");
  expect(kinds).not.toContain("worker-compaction-context");
  expect(kinds).not.toContain("handoff-index");
  expect(f.requests).toEqual([]);
  return checkpoint;
}
async function refusedRun(f: Fixture): Promise<Error> {
  try {
    await f.run();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error("non-Error owner refusal");
    excludesPrivate(String(error));
    excludesPrivate(JSON.stringify(error, Object.getOwnPropertyNames(error)));
    return error;
  }
  throw new Error("expected owner refusal, not successful tool delivery");
}
function assertActualPrivateYield(f: Fixture) {
  const first = requireDefined(f.observations[0], "private worker absent");
  expect(first.invocation.session).toBeUndefined(); // This is NOT the anonymous private tool/readResult path.
  expect(first.reasons).toEqual(["overflow"]);
  expect(first.hookCalls).toBe(1);
  expect(first.trustedPrivateHookCalls).toBe(1);
  expect(first.hookYielded).toBe(1); // Actual loaded Penny handler returned undefined.
  expect(first.summaries).toBe(1);
  expect(first.summarySawPrivateBody).toBe(true); // Native provider, not a manufactured event, received the opening.
  expect(first.resumed).toBeGreaterThan(0);
  expect(first.postCompactionReads).toBeGreaterThan(0);
  const compactions = first.session.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "compaction");
  expect(compactions).toHaveLength(1);
  const compact = requireDefined(compactions[0]);
  expect(compact.fromHook).not.toBe(true);
  expect(compact.summary).toContain(first.invocation.task);
  excludesPrivate(JSON.stringify(compact));
  expect(compact.summary).not.toContain("[RESUME-REFS");
  expect(compact.summary).not.toContain("Worker Continuity");
  expect(
    first.session.sessionManager.getEntries().some((entry) => entry.type === "context_edit")
  ).toBe(true);
}
function assertWorkers(f: Fixture, service: OrchestrationService, id: string, captured: boolean) {
  for (const entry of f.observations) {
    expect(entry.invocation.session).toBeUndefined();
    expect(entry.shutdownStarted).toBe(1);
    expect(entry.shutdownFinished).toBe(1); // Must be awaited before public owner terminal delivery.
    const terminal = requireDefined(
      [...entry.session.messages].reverse().find((message) => message.role === "assistant")
    );
    if (terminal.role !== "assistant") throw new Error("actual assistant terminal absent");
    expect(
      terminal.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe(entry.expected);
    expect(terminal.stopReason).toBe(captured ? "stop" : "error");
    expect(entry.privateOpeningSeen).toBeGreaterThan(0);
    const overlay = requireDefined(entry.invocation.contextOverlays?.[0]);
    expect(overlay.content).toBe(privateBody);
    expect(overlay).toMatchObject({
      validation: {
        authority_kind: "resolver_v2",
        current: {
          provider: { eligibility_record_id: "synthetic-use-time-eligibility" },
          approval: { status: "approved" },
        },
      },
    });
    const metadataEntries = entry.session.sessionManager
      .getEntries()
      .filter(
        (item) => item.type === "custom" && item.customType === CATALOG_WORKER_CONTINUITY_METADATA
      );
    expect(metadataEntries).toHaveLength(1);
    const custom = requireDefined(metadataEntries[0]);
    if (custom.type !== "custom") throw new Error("continuity entry is not custom metadata");
    const metadata = validateCatalogWorkerContinuityMetadata(custom.data);
    expect(metadata.compaction_continuity).toEqual({
      mode: "pi_default_private_context",
      reason: "owner_resolved_context_present",
    });
    expect(metadata.input_artifacts).toEqual(entry.invocation.inputArtifacts);
    excludesPrivate(JSON.stringify(metadata));
    const yaml = readFileSync(
      path.join(f.projectRoot, `.pi/agents/${entry.invocation.agent}.md`),
      "utf8"
    );
    expect(entry.session.getActiveToolNames().sort()).toEqual(
      [...parseSsotTools(yaml, entry.invocation.agent)].sort()
    );
    expect(entry.toolExecutions.every((name) => name === "artifact_read")).toBe(true);
    expect(entry.readIds).toEqual(entry.invocation.inputArtifacts.map((ref) => ref.artifact_id));
    for (const ref of entry.invocation.inputArtifacts)
      expect(entry.readBytes.get(ref.artifact_id)).toBe(
        service.artifacts.read(ref).toString("utf8")
      );
    const sessionFile = requireDefined(entry.session.sessionManager.getSessionFile());
    const stat = lstatSync(sessionFile);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.nlink).toBe(1);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.uid).toBe(process.geteuid?.());
    expect(lstatSync(path.dirname(sessionFile)).mode & 0o777).toBe(0o700);
    const transcript = readFileSync(sessionFile, "utf8");
    expect(transcript).toContain(privateBody); // Private session custody is intentional; not a generic artifact.
    expect(transcript).toContain("excluded synthetic private-worker reasoning");
    expect(transcript).not.toContain(privateFailure);
    if (captured) {
      const output = requireDefined(
        service.checkpointer
          .loadRunById(id)
          ?.selectedArtifacts.find(
            (ref) =>
              ref.phase === entry.invocation.stateId &&
              ref.producer === `agent:${entry.invocation.agent}`
          )
      );
      expect(service.artifacts.read(output).toString("utf8")).toBe(entry.expected);
      expect(entry.expected).not.toContain("excluded synthetic private-worker reasoning");
    }
  }
}
function evidence(f: Fixture, outcome: string) {
  process.stdout.write(
    `${JSON.stringify({ suite: "uo-private-default-yield", outcome, resolver_calls: f.resolutions.length, workers: f.observations.map((entry) => ({ state: entry.invocation.stateId, private_hook_calls: entry.trustedPrivateHookCalls, penny_yields: entry.hookYielded, native_summaries: entry.summaries, native_compactions: entry.session.sessionManager.getEntries().filter((item) => item.type === "compaction").length, exact_inputs: entry.readIds.length, ranges: entry.rangeReads, post_compaction_reads: entry.postCompactionReads, awaited_shutdowns: entry.shutdownFinished })), blocked_fetches: f.requests.length, anonymous_private_matrix: "unverified" })}\n`
  );
}

describe("complete registered owner private-context native default yield (frozen compiled generation)", () => {
  it("resolves approved private context through the owner, yields the loaded Penny hook, and completes exact custody without generic leakage", async () => {
    const f = fixture("complete");
    const { details } = await f.run();
    expect(details).toMatchObject({ success: true, state: "complete" });
    excludesPrivate(JSON.stringify(details));
    using service = owner(f);
    const id = runId(service);
    assertActualPrivateYield(f);
    assertWorkers(f, service, id, true);
    expect(f.observations.map((entry) => entry.invocation.stateId)).toEqual([
      "planning",
      "researching",
      "synthesizing",
      "validating",
    ]);
    expect(f.resolutions).toHaveLength(4);
    for (const resolution of f.resolutions) {
      expect(resolution.purpose).toBe("use_time");
      expect(resolution.signal).toBeInstanceOf(AbortSignal);
      expect(resolution.interval_ms).toBeGreaterThan(0);
    }
    expect(f.observations.some((entry) => entry.rangeReads > entry.readIds.length)).toBe(true);
    const checkpoint = assertGenericCustody(f, service, id);
    expect(checkpoint.status).toBe("complete");
    expect(service.checkpointer.completionAdmission(id)).toBeDefined();
    const recovered = service.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: {
        schema_version: 2,
        run_id: id,
        session_id: "private-default-yield",
        playbook: "research",
        engine_owner: "typescript",
      },
    });
    expect(recovered).toMatchObject({ action: "complete", met: true });
    excludesPrivate(JSON.stringify(recovered));
    if (recovered.action !== "complete") throw new Error("successful research terminal absent");
    const files = recovered.result.report_files;
    if (!Array.isArray(files) || !files.every((file): file is string => typeof file === "string"))
      throw new Error("rendered files absent");
    expect(files).toHaveLength(3);
    for (const file of files) excludesPrivate(readFileSync(file, "utf8"));
    evidence(f, "complete");
  });

  it("does not promote success-shaped final text after actual private default compaction when the provider fails", async () => {
    const f = fixture("provider-error");
    const error = await refusedRun(f);
    expect(error.name).toBe("AgentTerminalError");
    expect(error.message).toContain("assistant terminal stop reason: error");
    using service = owner(f);
    const id = runId(service);
    assertActualPrivateYield(f);
    assertWorkers(f, service, id, false);
    expect(f.observations).toHaveLength(1);
    expect(requireDefined(f.observations[0]).expected).toContain('"plan_complete":true');
    expect(requireDefined(f.observations[0]).expected).toContain(privateBody);
    const checkpoint = assertGenericCustody(f, service, id);
    // Preserve actual failed-provider truth: no fabricated durable terminal or successful stage capture.
    expect(checkpoint.status).toBe("running");
    expect(checkpoint.selectedArtifacts.some((ref) => ref.producer === "agent:piper")).toBe(false);
    expect(service.checkpointer.completionAdmission(id)).toBeUndefined();
    evidence(f, "provider-error:no-admission");
  });

  it.each(["revoked", "resolver-outage"] as const)(
    "%s use-time resolver control refuses before any SDK session without leaking private diagnostics",
    async (mode) => {
      const f = fixture(mode);
      const error = await refusedRun(f);
      expect(error.name).toBe("SkillSchemaValidationError");
      expect(error.message).toContain(
        mode === "revoked" ? "approval is revoked" : "current resolver is unavailable"
      );
      expect(f.resolutions).toHaveLength(1);
      expect(f.observations).toEqual([]);
      expect(f.faux.state.callCount).toBe(0);
      using service = owner(f);
      const id = runId(service);
      const checkpoint = assertGenericCustody(f, service, id);
      expect(checkpoint.status).toBe("running");
      expect(checkpoint.selectedArtifacts.some((ref) => ref.producer.startsWith("agent:"))).toBe(
        false
      );
      expect(service.checkpointer.completionAdmission(id)).toBeUndefined();
      evidence(f, `${mode}:pre-session-refusal`);
    }
  );
});
