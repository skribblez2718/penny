/** Exercises the default installed sibling factory, real processes, owner, cache and artifact store. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { ArtifactRefSchema, validateContract } from "../dist/contracts.js";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { OrchestrationService } from "../dist/service.js";
import {
  createScaOrdinaryResultCache,
  ScaRawEvidenceSchema,
  SCA_RAW_RECORD_COUNT,
  SCA_RAW_RECORD_BYTES,
  SCA_RAW_TOTAL_BYTES,
  validateScaRawEvidence,
  type ScaRawEvidence,
} from "../dist/sca/ordinary-host.js";
import { ScaPreparationSchema, ScaSelectionSchema } from "../dist/sca/ordinary-contracts.js";
import type { AgentInvocation } from "../dist/model-client.js";
import {
  ScaProcessRequestV1Schema,
  ScaProcessResultV1Schema,
} from "../../sca-service/src/process.js";
import {
  environment,
  identity,
  PROJECT_ROOT,
  roots,
  ScriptedScaClient,
  sourceRoot,
  sources,
  start,
} from "./helpers/sca-local-workflow.js";

beforeAll(() => {
  // Join the complete production builder, including its single-generation externalization plugin.
  execFileSync("bun", ["scripts/build.mjs"], {
    cwd: path.join(PROJECT_ROOT, "apps/sca-service"),
    stdio: "pipe",
  });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const PRIVATE_MARKER = "PRIVATE_PROCESS_DIAGNOSTIC_NOT_FOR_COGNITION";
class HostNoAlertClient extends ScriptedScaClient {
  private readArtifact: ((id: string) => string) | undefined;
  constructor() {
    super("noalert");
  }
  override bindArtifactReader(reader: (id: string) => string): void {
    super.bindArtifactReader(reader);
    this.readArtifact = reader;
  }
  override output(invocation: AgentInvocation): unknown {
    const value = super.output(invocation);
    if (invocation.stateId !== "selecting_scanner_dependency_leads") return value;
    const ref = invocation.inputArtifacts.find((entry) => entry.kind === "sca-preparation-result");
    if (ref === undefined || this.readArtifact === undefined)
      throw new Error("Missing exact default-host preparation");
    const preparation = validateContract(
      ScaPreparationSchema,
      JSON.parse(this.readArtifact(ref.artifact_id)),
      "Captured default-host preparation"
    );
    const selection = validateContract(ScaSelectionSchema, value, "No-alert fixture selection");
    return {
      ...selection,
      deferred: preparation.leads.map((lead) => ({
        id: lead.id,
        reason:
          "This raw-retention fixture assesses selected handler flows only; this preparation lead remains explicitly unassessed, not safe.",
      })),
    };
  }
}
function fixture(
  mode: "success" | "failure" | "truncated" | "sink-limit" = "success",
  dependencies = true
) {
  const env = environment();
  const root = path.dirname(sourceRoot);
  const tools = path.join(root, "tools");
  mkdirSync(tools, { mode: 0o700 });
  const count = path.join(root, "invocations");
  const executable = (name: string, body: string) => {
    const executable = path.join(tools, name);
    writeFileSync(
      executable,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(count)},${JSON.stringify(name + "\n")});\n${body}`,
      { flag: "wx", mode: 0o700 }
    );
    return {
      executable,
      sha256: sha256(readFileSync(executable)),
      version: "harmless-offline-fixture",
    };
  };
  const file = (name: string, content: string) => {
    const selected = path.join(tools, name);
    writeFileSync(selected, content, { flag: "wx", mode: 0o600 });
    return selected;
  };
  file("offline-advisory.json", "{ malformed retained offline advisory bytes }\n");
  if (dependencies) {
    writeFileSync(path.join(sourceRoot, "package.json"), '{"dependencies":{"alpha":"1.0.0"}}');
    writeFileSync(
      path.join(sourceRoot, "package-lock.json"),
      canonicalJson({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { alpha: "1.0.0" } },
          "node_modules/alpha": { name: "alpha", version: "1.0.0" },
        },
      })
    );
  }
  const semgrep = executable(
    "semgrep",
    `console.error(${JSON.stringify(PRIVATE_MARKER)});` +
      (mode === "sink-limit"
        ? "process.stderr.write('\\0'.repeat(8*1024*1024+1));"
        : mode === "truncated"
          ? "process.stdout.write('x'.repeat(8*1024*1024+1));"
          : mode === "failure"
            ? "console.log('malformed scanner bytes');process.exitCode=2;"
            : `console.log(JSON.stringify({results:[],errors:[],paths:{scanned:${JSON.stringify([...Object.keys(sources), "src/unrelated.ts"])}},skipped_rules:[]}));`)
  );
  const gitleaks = executable("gitleaks", "console.log('[]');");
  const frontend = executable(
    "frontend",
    "require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--output')+1],'harmless-cpg-fixture');"
  );
  const sourceFiles = [...Object.keys(sources), "src/unrelated.ts"].map((name) => ({
    path: name,
    content_sha256: sha256(readFileSync(path.join(sourceRoot, name))),
    status: "supported",
    detail: "Offline fixture, not native semantic proof",
  }));
  const query = executable(
    "query",
    `const language=process.argv.join(' ').includes('javascript_typescript.cpg')?'ts':'php';console.log(JSON.stringify({schema_version:1,complete:true,files:${JSON.stringify(sourceFiles)}.filter(f=>f.path.endsWith('.'+language)),rows:[]}));`
  );
  const rules = file("rules.yml", "rules: []\n");
  const script = file("query.sc", "// caller selected harmless fixture query\n");
  const analysis_tools = {
    semgrep: { tool: semgrep, rules_path: rules, rules_sha256: sha256(readFileSync(rules)) },
    gitleaks: { tool: gitleaks, rules_path: rules, rules_sha256: sha256(readFileSync(rules)) },
    graph: {
      js_frontend: frontend,
      php_frontend: frontend,
      joern: query,
      queries: [{ id: "fixture", script_path: script, sha256: sha256(readFileSync(script)) }],
    },
    advisory_results: {
      path: path.join(tools, "offline-advisory.json"),
      sha256: sha256(readFileSync(path.join(tools, "offline-advisory.json"))),
    },
  };
  const client = new HostNoAlertClient();
  const options = { projectRoot: PROJECT_ROOT, playbookName: "sca", env, modelClient: client };
  const runId = `default-private-retention-${mode}`;
  return {
    options,
    client,
    count,
    runId,
    tools,
    request: { ...start(runId), constraints: { ...start(runId).constraints, analysis_tools } },
  };
}
function bind(service: OrchestrationService, client: ScriptedScaClient) {
  client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
}
function retained(service: OrchestrationService, runId: string) {
  const operations = service.checkpointer.hostOperationCallsForRun(runId);
  const operation = operations.find((entry) => entry.operation_kind === "sca.preparation.v1");
  if (operation === undefined || operation.operation_result_ref === null)
    throw new Error("Preparation missing");
  const ref = operation.output_artifacts.find((ref) => ref.kind === "sca-private-raw-evidence");
  if (ref === undefined)
    throw new Error("Private raw output absent from retained operation manifest");
  expect(
    operation.persistence_plan?.outputs.some((plan) => plan.content_sha256 === ref.content_digest)
  ).toBe(true);
  const bytes = service.artifacts.read(ref);
  expect(sha256(bytes)).toBe(ref.content_digest);
  const raw = validateContract(
    ScaRawEvidenceSchema,
    JSON.parse(bytes.toString("utf8")),
    "Private raw output"
  );
  for (const record of raw.records) {
    const captured = Buffer.from(record.content_base64, "base64");
    expect(captured.length).toBe(record.byte_length);
    expect(sha256(captured)).toBe(record.content_sha256);
  }
  const preparation = validateContract(
    ScaPreparationSchema,
    JSON.parse(service.artifacts.read(operation.operation_result_ref).toString("utf8")),
    "Preparation"
  );
  return { raw, bytes, ref, preparation };
}
function processes(raw: ScaRawEvidence) {
  return raw.records
    .filter((record) => record.kind === "process")
    .map((record) =>
      validateContract(
        Type.Object(
          { request: ScaProcessRequestV1Schema, result: ScaProcessResultV1Schema },
          { additionalProperties: true }
        ),
        JSON.parse(Buffer.from(record.content_base64, "base64").toString("utf8")),
        "Retained process"
      )
    );
}
function assertPrivate(service: OrchestrationService, input: ReturnType<typeof fixture>) {
  const openings = canonicalJson(input.client.invocations);
  expect(openings).not.toContain(PRIVATE_MARKER);
  expect(openings).not.toContain(input.tools);
  expect(
    input.client.invocations.every((entry) =>
      entry.inputArtifacts.every((ref) => ref.kind !== "sca-private-raw-evidence")
    )
  ).toBe(true);
  const context = service.checkpointer.loadRunById(input.runId);
  if (context === undefined) throw new Error("Missing retained run");
  const privateRefs = context.selectedArtifacts.filter(
    (ref) => ref.kind === "sca-private-raw-evidence"
  );
  expect(privateRefs.length).toBeGreaterThan(0);
  const operationRawRefs = service.checkpointer
    .hostOperationCallsForRun(input.runId)
    .flatMap((operation) =>
      operation.output_artifacts.filter((ref) => ref.kind === "sca-private-raw-evidence")
    );
  expect(privateRefs.map((ref) => ref.artifact_id).sort()).toEqual(
    operationRawRefs.map((ref) => ref.artifact_id).sort()
  );
  const publicRefs = context.selectedArtifacts.filter((entry) =>
    ["semantic-core", "sca-report-markdown", "sca-report-sarif", "sca-report-validation"].includes(
      entry.kind
    )
  );
  expect(publicRefs.length).toBeGreaterThanOrEqual(4);
  for (const ref of publicRefs) {
    const publicBytes = service.artifacts.read(ref).toString("utf8");
    expect(publicBytes).not.toContain(PRIVATE_MARKER);
    expect(publicBytes).not.toContain(input.tools);
    expect(publicBytes).not.toContain("sca-private-raw-evidence");
    for (const privateRef of privateRefs) {
      expect(publicBytes).not.toContain(privateRef.artifact_id);
      expect(publicBytes).not.toContain(privateRef.store_ref);
    }
  }
  for (const invocation of input.client.invocations) {
    const disclosed = invocation.inputArtifacts
      .map((ref) => service.artifacts.read(ref).toString("utf8"))
      .join("\n");
    expect(disclosed).not.toContain(PRIVATE_MARKER);
    expect(disclosed).not.toContain(input.tools);
    for (const ref of privateRefs) expect(disclosed).not.toContain(ref.artifact_id);
  }
  const terminal = context.terminalDirective;
  if (
    terminal === null ||
    !["complete", "incomplete", "cancelled"].includes(terminal.action) ||
    !("artifacts" in terminal) ||
    !("result" in terminal)
  )
    throw new Error("Missing exact terminal custody");
  const manifestRef = terminal.artifacts.find((ref) => ref.kind === "sca-output-manifest");
  if (manifestRef === undefined) throw new Error("Missing terminal output manifest");
  const manifestBytes = service.artifacts.read(manifestRef).toString("utf8");
  const manifest = validateContract(
    Type.Object({ outputs: Type.Array(ArtifactRefSchema) }, { additionalProperties: true }),
    JSON.parse(manifestBytes),
    "Terminal custody manifest"
  );
  const result = validateContract(
    Type.Object(
      { best_partial_artifact_refs: Type.Array(ArtifactRefSchema) },
      { additionalProperties: true }
    ),
    terminal.result,
    "Terminal public partial reports"
  );
  expect(manifestBytes).not.toContain(PRIVATE_MARKER);
  expect(manifestBytes).not.toContain(input.tools);
  for (const ref of privateRefs) {
    expect(terminal.artifacts).toContainEqual(ref);
    expect(manifest.outputs).toContainEqual(ref);
    expect(service.artifacts.metadata(manifestRef).upstream_refs).toContainEqual(ref);
    expect(result.best_partial_artifact_refs).not.toContainEqual(ref);
  }
}
describe("private raw evidence exact bounds", () => {
  const record = (bytes: Buffer) => ({
    kind: "process" as const,
    byte_length: bytes.length,
    content_sha256: sha256(bytes),
    content_base64: bytes.toString("base64"),
  });
  it("rejects record-count overflow and exact-byte or encoding substitution", () => {
    const entry = record(Buffer.from("captured"));
    const valid = { schema_version: 1, records: [entry] };
    expect(validateScaRawEvidence(valid)).toEqual(valid);
    expect(() =>
      validateScaRawEvidence({
        schema_version: 1,
        records: Array.from({ length: SCA_RAW_RECORD_COUNT + 1 }, () => entry),
      })
    ).toThrow();
    expect(() =>
      validateScaRawEvidence({
        ...valid,
        records: [{ ...entry, content_base64: Buffer.from("swapped!").toString("base64") }],
      })
    ).toThrow(/exact binding/);
    expect(() =>
      validateScaRawEvidence({
        ...valid,
        records: [{ ...entry, content_base64: entry.content_base64 + "\n" }],
      })
    ).toThrow(/exact binding/);
  });
  it("enforces both the individual and decoded aggregate byte ceilings, including recovery reads", () => {
    const maximum = record(Buffer.alloc(SCA_RAW_RECORD_BYTES, 0x61));
    expect(SCA_RAW_TOTAL_BYTES).toBe(SCA_RAW_RECORD_BYTES * 2);
    expect(
      validateScaRawEvidence({ schema_version: 1, records: [maximum, maximum] }).records
    ).toHaveLength(2);
    expect(() =>
      validateScaRawEvidence({ schema_version: 1, records: [maximum, maximum, maximum] })
    ).toThrow(/aggregate limit/);
    expect(() =>
      validateScaRawEvidence({
        schema_version: 1,
        records: [{ ...maximum, byte_length: SCA_RAW_RECORD_BYTES + 1 }],
      })
    ).toThrow();
  });
});

describe("default ordinary host private raw retention", () => {
  it("persists raw evidence on an uninterrupted complete default-host assessment, never disclosing it to report reviewers", async () => {
    const input = fixture("success", false);
    using service = new OrchestrationService(input.options);
    bind(service, input.client);
    const outcome = await service.execute(input.request);
    expect(outcome.action).toBe("complete");
    const result = retained(service, input.runId);
    expect(processes(result.raw)).toHaveLength(6);
    assertPrivate(service, input);
    const context = service.checkpointer.loadRunById(input.runId);
    if (context === undefined) throw new Error("Missing run");
    const manifestRef = context.selectedArtifacts.find((ref) => ref.kind === "sca-output-manifest");
    if (manifestRef === undefined) throw new Error("Missing output manifest");
    // The output manifest retains refs only; no private streams or local paths belong in it.
    const manifest = service.artifacts.read(manifestRef).toString("utf8");
    expect(manifest).toContain(result.ref.artifact_id);
    expect(manifest).not.toContain(PRIVATE_MARKER);
    expect(manifest).not.toContain(input.tools);
    service.close();
  });
  it.each(["success", "failure", "truncated"] as const)(
    "retains rereadable %s scanner/frontend/query/dependency/advisory bytes through real cache recovery",
    async (mode) => {
      const input = fixture(mode);
      using first = new OrchestrationService({
        ...input.options,
        hostOperationFault(point, operation) {
          if (point === "after_fetch" && operation === "sca.preparation.v1")
            throw new HostOperationSimulatedCrashError(point);
        },
      });
      bind(first, input.client);
      await expect(first.execute(input.request)).rejects.toBeInstanceOf(
        HostOperationSimulatedCrashError
      );
      const operation = first.checkpointer.hostOperationCallsForRun(input.runId)[0];
      if (operation === undefined) throw new Error("Missing fetched journal");
      const dbPath = first.checkpointer.dbPath;
      const cache = await createScaOrdinaryResultCache(dbPath).read(operation.request_sha256);
      if (cache === null) throw new Error("Missing exact cached raw bytes");
      const cached = validateContract(
        Type.Object(
          { result: ScaPreparationSchema, raw: ScaRawEvidenceSchema },
          { additionalProperties: true }
        ),
        JSON.parse(Buffer.from(cache.bytes).toString("utf8")),
        "Cached raw"
      );
      expect(processes(cached.raw)).toHaveLength(6);
      expect(cached.raw.records.filter((record) => record.kind === "dependencies")).toHaveLength(1);
      expect(cached.raw.records.filter((record) => record.kind === "advisories")).toHaveLength(1);
      first.close();
      using recovered = new OrchestrationService(input.options);
      bind(recovered, input.client);
      const outcome = await recovered.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(input.runId),
      });
      expect(outcome.action).toBe("incomplete");
      const result = retained(recovered, input.runId);
      expect(result.raw).toEqual(cached.raw);
      expect(result.preparation).toEqual(cached.result);
      expect(result.preparation.leads).toHaveLength(1);
      const lead = result.preparation.leads[0];
      if (lead === undefined) throw new Error("Missing captured dependency lead");
      expect(lead.origin).toBe("dependency");
      expect(lead.title).toContain("alpha@1.0.0");
      const selectionRef = recovered.checkpointer
        .loadRunById(input.runId)
        ?.selectedArtifacts.find((ref) => ref.kind === "sca-selecting-scanner-dependency-leads");
      if (selectionRef === undefined) throw new Error("Missing accepted default-host selection");
      const selection = validateContract(
        ScaSelectionSchema,
        JSON.parse(recovered.artifacts.read(selectionRef).toString("utf8")),
        "Accepted default-host lead accounting"
      );
      expect(selection.selections).toEqual([]);
      expect(selection.deferred.map((entry) => entry.id).sort()).toEqual(
        result.preparation.leads.map((lead) => lead.id).sort()
      );
      const dependency = result.raw.records.find((record) => record.kind === "dependencies");
      const advisory = result.raw.records.find((record) => record.kind === "advisories");
      if (dependency === undefined || advisory === undefined)
        throw new Error("Missing deterministic raw records");
      const dependencyObservation = validateContract(
        Type.Object(
          {
            result: Type.Object(
              { inventory_sha256: Type.String() },
              { additionalProperties: true }
            ),
          },
          { additionalProperties: true }
        ),
        JSON.parse(Buffer.from(dependency.content_base64, "base64").toString("utf8")),
        "Dependency raw observation"
      );
      expect(dependencyObservation.result.inventory_sha256).toBe(
        result.preparation.capabilities.find((entry) => entry.id === "dependencies")
          ?.evidence_sha256
      );
      const advisoryObservation = validateContract(
        Type.Object(
          {
            result: Type.Object({ content_base64: Type.String() }, { additionalProperties: true }),
          },
          { additionalProperties: true }
        ),
        JSON.parse(Buffer.from(advisory.content_base64, "base64").toString("utf8")),
        "Advisory raw observation"
      );
      expect(
        Buffer.from(advisoryObservation.result.content_base64, "base64").toString("utf8")
      ).toBe("{ malformed retained offline advisory bytes }\n");
      const observed = processes(result.raw);
      const scanner = observed.find((record) => record.request.arguments[0] === "scan");
      if (scanner === undefined) throw new Error("Missing raw scanner invocation");
      expect(scanner.result.stderr).toBe(PRIVATE_MARKER + "\n");
      expect(scanner.result.status).toBe(
        mode === "success" ? "succeeded" : mode === "failure" ? "nonzero_exit" : "output_limit"
      );
      expect(scanner.result.stdout_truncated).toBe(mode === "truncated");
      expect(result.preparation.capabilities.find((entry) => entry.id === "semgrep")?.status).toBe(
        mode === "success" ? "completed" : "failed"
      );
      for (const record of observed) {
        expect(sha256(record.result.stdout)).toBe(record.result.stdout_sha256);
        expect(sha256(record.result.stderr)).toBe(record.result.stderr_sha256);
        expect(existsSync(record.request.cwd)).toBe(false);
      }
      expect(readFileSync(input.count, "utf8").trim().split("\n")).toHaveLength(6);
      expect(lstatSync(path.join(path.dirname(dbPath), "sca-host-result-cache")).mode & 0o777).toBe(
        0o700
      );
      expect(
        lstatSync(
          path.join(
            path.dirname(dbPath),
            "sca-host-result-cache",
            `${operation.request_sha256}.json`
          )
        ).mode & 0o777
      ).toBe(0o600);
      assertPrivate(recovered, input);
      recovered.close();
      using reopened = new OrchestrationService(input.options);
      bind(reopened, input.client);
      expect(retained(reopened, input.runId).bytes).toEqual(result.bytes);
      const terminal = reopened.checkpointer.loadRunById(input.runId)?.terminalDirective;
      if (terminal === undefined || terminal === null) throw new Error("Missing terminal replay");
      expect(
        await reopened.execute({
          schema_version: 2,
          action: "recover",
          identity: identity(input.runId),
        })
      ).toEqual(terminal);
      assertPrivate(reopened, input);
      expect(readFileSync(input.count, "utf8").trim().split("\n")).toHaveLength(6);
      reopened.close();
    }
  );
  it.each(["selecting_scanner_dependency_leads", "reviewing_report"])(
    "retains terminal raw custody without public disclosure when cancelled at %s",
    async (state) => {
      const input = fixture("success", false);
      const controller = new AbortController();
      using service = new OrchestrationService({
        ...input.options,
        modelClient: {
          async runAgent(invocation) {
            if (invocation.stateId === state) controller.abort();
            return input.client.runAgent(invocation);
          },
        },
      });
      bind(service, input.client);
      const outcome = await service.execute(input.request, controller.signal);
      expect(outcome.action).toBe("cancelled");
      const raw = retained(service, input.runId);
      assertPrivate(service, input);
      service.close();
      using reopened = new OrchestrationService(input.options);
      bind(reopened, input.client);
      expect(
        await reopened.execute({
          schema_version: 2,
          action: "recover",
          identity: identity(input.runId),
        })
      ).toEqual(outcome);
      expect(retained(reopened, input.runId).bytes).toEqual(raw.bytes);
      expect(readFileSync(input.count, "utf8").trim().split("\n")).toHaveLength(6);
      assertPrivate(reopened, input);
    }
  );
  it("never chmod-repairs a pre-existing non-private cache path", async () => {
    environment();
    const root = path.dirname(sourceRoot);
    const cachePath = path.join(root, "sca-host-result-cache");
    mkdirSync(cachePath, { mode: 0o755 });
    await expect(
      createScaOrdinaryResultCache(path.join(root, "orchestration.db")).read(sha256("request"))
    ).rejects.toThrow(/0700/);
    expect(lstatSync(cachePath).mode & 0o777).toBe(0o755);
  });
  it("refuses over-count cached raw records rather than adopting them or rerunning scanners", async () => {
    const input = fixture();
    using first = new OrchestrationService({
      ...input.options,
      hostOperationFault(point, operation) {
        if (point === "after_fetch" && operation === "sca.preparation.v1")
          throw new HostOperationSimulatedCrashError(point);
      },
    });
    bind(first, input.client);
    await expect(first.execute(input.request)).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    const cache = createScaOrdinaryResultCache(first.checkpointer.dbPath);
    first.close();
    using recovered = new OrchestrationService({
      ...input.options,
      hostOperationResultCache: {
        async read(key) {
          const cached = await cache.read(key);
          if (cached === null) return null;
          const original = validateContract(
            Type.Object({ raw: ScaRawEvidenceSchema }, { additionalProperties: true }),
            JSON.parse(Buffer.from(cached.bytes).toString("utf8")),
            "Cached raw"
          );
          const record = original.raw.records[0];
          if (record === undefined) throw new Error("No original raw observation");
          const bytes = Buffer.from(
            canonicalJson({
              ...original,
              raw: {
                schema_version: 1,
                records: Array.from({ length: SCA_RAW_RECORD_COUNT + 1 }, () => record),
              },
            })
          );
          return { ...cached, bytes, byte_length: bytes.length, content_sha256: sha256(bytes) };
        },
        write: (key, bytes) => cache.write(key, bytes),
      },
    });
    bind(recovered, input.client);
    const outcome = await recovered.execute({
      schema_version: 2,
      action: "recover",
      identity: identity(input.runId),
    });
    expect(outcome.action).toBe("incomplete");
    expect(readFileSync(input.count, "utf8").trim().split("\n")).toHaveLength(6);
    expect(
      recovered.checkpointer.hostOperationCallsForRun(input.runId)[0]?.disposition?.outcome
    ).not.toBe("completed");
    recovered.close();
  });
  it("does not swallow default raw sink byte-limit failures or turn them into clean results", async () => {
    const input = fixture("sink-limit");
    using service = new OrchestrationService(input.options);
    bind(service, input.client);
    const outcome = await service.execute(input.request);
    expect(outcome.action).toBe("incomplete");
    const operation = service.checkpointer
      .hostOperationCallsForRun(input.runId)
      .find((entry) => entry.operation_kind === "sca.preparation.v1");
    expect(operation?.disposition?.outcome).not.toBe("completed");
    expect(operation?.operation_result_ref).toBeNull();
    expect(readFileSync(input.count, "utf8").trim().split("\n")).toHaveLength(1);
    service.close();
  });
});
