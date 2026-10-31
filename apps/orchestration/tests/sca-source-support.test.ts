/** Current-bundle regression: scripted cognition, real engine/owner; no target execution. */
import { rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateContract, type ArtifactRef } from "../dist/contracts.js";
import type { AgentInvocation } from "../dist/model-client.js";
import { OrchestrationService } from "../dist/service.js";
import { createScaAdvancedHostAdapters } from "../dist/sca/ordinary-advanced-host.js";
import {
  ScaDispositionsSchema,
  ScaEvidenceSchema,
  type ScaDispositions,
} from "../dist/sca/ordinary-contracts.js";
import { ScaReportProductSchema } from "../dist/sca/ordinary-report.js";
import { ScaSemanticDiagnosticSchema } from "../dist/sca/ordinary-semantic.js";
import { AdvancedScriptedClient, advancedFixture } from "./helpers/sca-advanced-workflow.js";
import {
  environment,
  fixtureAdapters,
  PROJECT_ROOT,
  roots,
  ScriptedScaClient,
  start,
} from "./helpers/sca-local-workflow.js";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class RevisionClient extends AdvancedScriptedClient {
  readonly drafts: ScaDispositions[] = [];
  override output(invocation: AgentInvocation): unknown {
    const value = super.output(invocation);
    if (invocation.stateId !== "adjudicating_evidence") return value;
    const result = validateContract(ScaDispositionsSchema, value, "Adjudication fixture");
    if (this.drafts.length === 0) {
      const entry = result.dispositions[0];
      if (entry === undefined) throw new Error("Missing legacy disposition");
      // Reproduce the original contradiction once, not a semantic-repair loop.
      entry.action_ids = ["a-0", "test-application"];
    }
    this.drafts.push(structuredClone(result));
    // The successor is the unmodified helper response: reverting the fix must reject it.
    return result;
  }
}

it("revises only source support after first rejection and retains the real failed/NOT RUN application", async () => {
  const env = environment();
  for (const key of Object.keys(env)) if (key.startsWith("PENNY_SCA_ORDINARY_")) delete env[key];
  const fixture = advancedFixture("completed", false, false);
  const applicationFailure = new ReferenceError("Synthetic application failure before submission");
  // Inject at the declared application seam instead of relying on a shipping defect.
  fixture.host.applicationFactory = () => ({
    async run() {
      throw applicationFailure;
    },
  });
  const client = new RevisionClient(true, false);
  const failures: unknown[] = [];
  const adapters = new Map(fixtureAdapters("noalert"));
  const adapter = () => {
    const value = createScaAdvancedHostAdapters(
      fixture.host,
      service.artifacts,
      service.config.projectId
    ).get("sca-ordinary-advanced-v1");
    if (value === undefined) throw new Error("Missing real advanced adapter");
    return value;
  };
  adapters.set("sca-ordinary-advanced-v1", {
    adapter_id: "sca-ordinary-advanced-v1",
    inspectRequest: (input) => adapter().inspectRequest(input),
    async run(context) {
      try {
        return await adapter().run(context);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
  });
  using service = new OrchestrationService({
    projectRoot: PROJECT_ROOT,
    playbookName: "sca",
    env,
    modelClient: client,
    hostOperationAdapters: adapters,
    scaAdvanced: fixture.host,
  });
  client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
  const runId = "source-support-revision";
  const request = start(runId);
  let current = service.handle({
    ...request,
    constraints: {
      ...request.constraints,
      execution_mode: "propose_stronger_evidence",
      advanced: { ...fixture.advanced, learning: [] },
    },
  });
  const selected = (kind: string): ArtifactRef => {
    const ref = service.checkpointer
      .loadRunById(runId)
      ?.selectedArtifacts.slice()
      .reverse()
      .find((entry) => entry.kind === kind);
    if (ref === undefined) throw new Error(`Missing exact ${kind}`);
    return ref;
  };
  const read = (ref: ArtifactRef) => service.artifacts.read(ref);
  const step = async (expected: string) => {
    if (!("state_id" in current) || current.state_id !== expected)
      throw new Error(`Expected ${expected}, got ${canonicalJson(current)}`);
    if (current.action === "invoke_host_operation") {
      expect(["sca.preparation.v1", "sca.evidence.v1", "sca.application.v1"]).toContain(
        current.operation_kind
      );
      const owner = service.hostOperations;
      if (owner === undefined) throw new Error("Missing real host owner");
      current = service.engine.authorizeDispatch(await owner.dispatch(service.engine, current));
    } else if (current.action === "invoke_agent") {
      const results = await service.workers.execute(current);
      current = service.engine.authorizeDispatch(
        service.engine.acceptWorkerResults(current.identity, results)
      );
      for (const result of results) service.workers.acceptArtifact(result);
    } else throw new Error("Expected one executable step");
  };
  for (const stage of [
    "preparing_analysis",
    "selecting_scanner_dependency_leads",
    "selecting_underdetected_no_alert_surfaces",
    "forming_hypotheses",
    "challenging_hypotheses",
    "selecting_evidence_actions",
    "gathering_evidence",
    "running_application_tests",
  ])
    await step(stage);

  // The real adapter/owner must observe this exact error and retain failed/NOT RUN truth.
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBe(applicationFailure);
  expect(failures[0]).toBeInstanceOf(ReferenceError);
  expect(failures[0]).toHaveProperty("message", "Synthetic application failure before submission");
  const calls = service.checkpointer.hostOperationCallsForRun(runId);
  expect(calls.map((call) => call.operation_kind)).toEqual([
    "sca.preparation.v1",
    "sca.evidence.v1",
    "sca.application.v1",
  ]);
  expect(calls[2]).toMatchObject({
    lifecycle: "consumed",
    remote_correlation_id: null,
    operation_result_ref: null,
    disposition: {
      outcome: "failed",
      reason_code: "adapter_failed_before_submission",
      remote_disposition: "proven_not_accepted",
      lease_disposition: "released",
    },
  });
  expect(current.action).toBe("invoke_agent");
  if (current.action !== "invoke_agent") throw new Error("Missing first adjudication");
  const originals = current.input_artifacts.artifacts.map((entry) => entry.ref);
  expect(originals).toHaveLength(6);
  const evidence = validateContract(
    ScaEvidenceSchema,
    JSON.parse(read(selected("sca-validated-evidence")).toString("utf8")),
    "Actual application failure evidence"
  );
  expect(evidence.results).toEqual([
    expect.objectContaining({ action_id: "a-0", status: "completed", execution: "NOT RUN" }),
    expect.objectContaining({
      action_id: "test-application",
      status: "failed",
      execution: "NOT RUN",
      pointers: [],
      receipt_refs: [],
    }),
  ]);
  const originalBytes = originals.map(read);
  await step("adjudicating_evidence");
  const diagnosticRef = selected("sca-semantic-diagnostic");
  const diagnosticBytes = read(diagnosticRef);
  const diagnostic = validateContract(
    ScaSemanticDiagnosticSchema,
    JSON.parse(diagnosticBytes.toString("utf8")),
    "First real semantic rejection"
  );
  expect(diagnostic).toMatchObject({
    state: "adjudicating_evidence",
    rejection_ordinal: 1,
    predecessor_diagnostic: null,
    revision_limit: null,
    failure: {
      code: "evidence_binding",
      location: "/dispositions/0",
      expected_ids: [],
      expected_pointer: null,
      allowed_ranges: [],
    },
  });
  expect(diagnostic.original_input_refs).toEqual(originals);
  const rejectedBytes = read(diagnostic.rejected_artifact);
  expect(sha256(rejectedBytes)).toBe(diagnostic.rejected_artifact.content_digest);
  expect(current.action).toBe("invoke_agent");
  if (current.action !== "invoke_agent") throw new Error("Missing same-stage revision");
  expect(current.input_artifacts.artifacts.map((entry) => entry.ref)).toEqual([
    ...originals,
    diagnostic.rejected_artifact,
    diagnosticRef,
  ]);

  await step("adjudicating_evidence");
  expect(current).toMatchObject({ action: "invoke_agent", state_id: "assessing_learning" });
  const legacy = client.drafts[0];
  const corrected = client.drafts[1];
  if (legacy === undefined || corrected === undefined) throw new Error("Missing exact drafts");
  const expected = structuredClone(legacy);
  const entry = expected.dispositions[0];
  if (entry === undefined) throw new Error("Missing source-only claim");
  entry.action_ids = ["a-0"];
  expect(corrected).toEqual(expected);
  const invocation = client.invocations.at(-1);
  if (invocation === undefined) throw new Error("Missing corrective invocation");
  const base = validateContract(
    ScaDispositionsSchema,
    ScriptedScaClient.prototype.output.call(client, invocation),
    "Entire original source-only claim"
  );
  base.dispositions = base.dispositions.slice(0, 1);
  expect(corrected).toEqual(base);
  expect(JSON.parse(read(selected("sca-reconciliation")).toString("utf8"))).toEqual(corrected);

  for (const stage of [
    "assessing_learning",
    "materializing_report",
    "reviewing_report",
    "verifying_final_product",
  ])
    await step(stage);
  expect(current.action).toBe("incomplete");
  const report = validateContract(
    ScaReportProductSchema,
    JSON.parse(read(selected("semantic-core")).toString("utf8")),
    "Honest current-bundle report"
  );
  expect(report).toMatchObject({
    status: "INCOMPLETE",
    reproduction: "NOT RUN",
    target_executed: false,
  });
  expect(report.findings).toHaveLength(1);
  expect(
    report.advanced?.operations.find((operation) => operation.stage === "application")
  ).toMatchObject({
    status: "incomplete",
    execution: "NOT RUN",
    cleanup: "not_needed",
    quarantine_required: false,
  });
  expect(service.checkpointer.hostOperationCallsForRun(runId)).toEqual(calls);
  expect(fixture.counts()).toEqual({ applications: 0, processes: 0 });
  expect(selected("sca-semantic-diagnostic")).toEqual(diagnosticRef);
  expect(read(diagnosticRef)).toEqual(diagnosticBytes);
  expect(read(diagnostic.rejected_artifact)).toEqual(rejectedBytes);
  originals.forEach((ref, index) => {
    expect(read(ref)).toEqual(originalBytes[index]);
    expect(read(ref).byteLength).toBe(ref.byte_length);
    expect(sha256(read(ref))).toBe(ref.content_digest);
  });
});
