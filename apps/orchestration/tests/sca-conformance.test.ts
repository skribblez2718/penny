/** Provider-free current SCA acceptance evidence. Cognition/scanner observations are scripted;
 * registration, admission, engine, host owner, custody, reviews and terminal gates are real.
 * This is not native-analyzer, provider, target-execution or production qualification.
 */
import { afterEach, describe, expect, it } from "vitest";
import { rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, Directive } from "../dist/contracts.js";
import type { AgentCompletion, AgentInvocation } from "../dist/model-client.js";
import { SCA_AGENT_BY_STATE, SCA_PLAYBOOK_REGISTRATION } from "../dist/playbooks/sca.js";
import {
  bindGenericChildYamlAuthority,
  runtimeRegistrationSha256,
} from "../dist/playbooks/registry.js";
import {
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
  ModelExecutionReceiptV1Schema,
  ModelDispatchGuardV1Schema,
} from "../dist/required-model.js";
import { exactJson } from "../dist/sca/ordinary-artifacts.js";
import { ScaReviewSchema } from "../dist/sca/ordinary-contracts.js";
import {
  createScaOrdinaryHostAdapters,
  type ScaOrdinaryRuntime,
} from "../dist/sca/ordinary-host.js";
import { SCA_REQUIRED_MODEL } from "../dist/sca/ordinary-model-guard.js";
import {
  ScaReportProductSchema,
  validateScaReportRepresentations,
} from "../dist/sca/ordinary-report.js";
import { describeScaSourceSnapshotV1 } from "../dist/sca/ordinary-source.js";
import { ScaOutputManifestSchema } from "../dist/sca/ordinary-terminal.js";
import { OrchestrationService } from "../dist/service.js";
import {
  environment,
  fixtureRuntime,
  PROJECT_ROOT,
  roots,
  ScriptedScaClient,
  sources,
  start,
  type ScaFixtureMode,
} from "./helpers/sca-local-workflow.js";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function required(refs: readonly ArtifactRef[], kind: string): ArtifactRef {
  const matches = refs.filter((ref) => ref.kind === kind);
  const ref = matches[0];
  if (matches.length !== 1 || ref === undefined) throw new Error(`Expected one exact ${kind}`);
  return ref;
}
function terminal(value: Directive) {
  if (value.action !== "complete" && value.action !== "incomplete")
    throw new Error(`Expected native assessment terminal, received ${value.action}`);
  return value;
}
function fixture(
  options: {
    mode?: ScaFixtureMode;
    client?: ScriptedScaClient;
    runtime?: ScaOrdinaryRuntime;
    modelOverride?: string;
  } = {}
) {
  const env = environment();
  const client = options.client ?? new ScriptedScaClient(options.mode);
  const base = options.runtime ?? fixtureRuntime(options.mode);
  const calls = { prepare: 0, gather: 0 };
  const service = new OrchestrationService({
    projectRoot: PROJECT_ROOT,
    playbookName: "sca",
    env,
    modelClient: client,
    ...(options.modelOverride === undefined ? {} : { modelOverride: options.modelOverride }),
    hostOperationAdapters: createScaOrdinaryHostAdapters({
      prepare(input) {
        calls.prepare += 1;
        return base.prepare(input);
      },
      gather(input) {
        calls.gather += 1;
        return base.gather(input);
      },
    }),
  });
  client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
  return { service, client, calls };
}

class DriftedResolution extends ScriptedScaClient {
  resolutions = 0;
  modelWork = 0;
  constructor(private readonly drift: "provider" | "model") {
    super();
  }
  override async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.resolutions += 1;
    const admit = invocation.admitResolvedModel;
    if (admit === undefined) throw new Error("Missing real required-model admission hook");
    admit({
      provider: this.drift === "provider" ? "other-provider" : SCA_REQUIRED_MODEL.provider,
      model: this.drift === "model" ? "other-model" : SCA_REQUIRED_MODEL.model,
    });
    // A provider-equivalent work boundary: a refusal must happen before reaching it.
    this.modelWork += 1;
    return super.runAgent(invocation);
  }
}

function assertNoDispatch(service: OrchestrationService, runId: string) {
  const context = service.checkpointer.loadRunById(runId);
  if (context === undefined || context.pendingDirective?.action !== "invoke_agent")
    throw new Error("Expected refused pending first cognitive assignment");
  const pending = context.pendingDirective;
  expect(context.met).toBe(false);
  expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
  expect(
    service.artifacts.refFor(
      runId,
      pending.state_id,
      null,
      "model-dispatch-guard",
      modelDispatchGuardOperationId({
        run_id: runId,
        state_id: pending.state_id,
        branch_id: null,
        agent: pending.agent,
        attempt: pending.attempt,
      }),
      1
    )
  ).toBeNull();
  expect(context.selectedArtifacts.some((ref) => ref.kind === "agent-output")).toBe(false);
}

function assertReviews(
  service: OrchestrationService,
  client: ScriptedScaClient,
  value: ReturnType<typeof terminal>
) {
  const reportRef = required(value.artifacts, "semantic-core");
  for (const kind of ["sca-reviewing-report", "sca-verifying-final-product"]) {
    const reviewRef = required(value.artifacts, kind);
    const review = exactJson(service.artifacts, reviewRef, ScaReviewSchema);
    const report = exactJson(service.artifacts, reportRef, ScaReportProductSchema);
    for (const ref of report.evidence_refs.filter((entry) => entry.kind === "sca-advanced-summary"))
      expect(review.checked_evidence_ids).toContain(ref.artifact_id);
    expect(review.verdict).toBe("PASS");
    expect(review.report_artifact_id).toBe(reportRef.artifact_id);
    expect(review.report_sha256).toBe(reportRef.content_digest);
    const state = kind === "sca-reviewing-report" ? "reviewing_report" : "verifying_final_product";
    const invocation = client.invocations.find((entry) => entry.stateId === state);
    if (invocation === undefined) throw new Error("Missing actual independent review invocation");
    for (const evidenceKind of [
      "sca-report-validation",
      "sca-evidence-result",
      "sca-validated-evidence",
      "sca-focused-sources",
    ])
      expect(review.checked_evidence_ids).toContain(
        required(invocation.inputArtifacts, evidenceKind).artifact_id
      );
  }
}

describe("provider-free current SCA conformance", () => {
  it("refuses changed source identity/digest and requested or resolved model bindings before affected model work", async () => {
    for (const mutation of ["source-bytes", "source-identity", "request-model"] as const) {
      const { service, client, calls } = fixture();
      using owner = service;
      const runId = `conformance-${mutation}`;
      const request = start(runId);
      const before = describeScaSourceSnapshotV1(request.constraints);
      const file = path.join(request.constraints.source_root, "src/handler.ts");
      if (mutation === "source-bytes") {
        writeFileSync(file, sources["src/handler.ts"].replace("exec", "nope"));
        expect(describeScaSourceSnapshotV1(request.constraints).source_snapshot_sha256).not.toBe(
          before.source_snapshot_sha256
        );
      }
      if (mutation === "source-identity") {
        const replacement = path.join(
          path.dirname(request.constraints.source_root),
          "same-bytes.ts"
        );
        writeFileSync(replacement, sources["src/handler.ts"]);
        unlinkSync(file);
        symlinkSync(replacement, file);
      }
      await expect(
        owner.execute({
          ...request,
          constraints: {
            ...request.constraints,
            source_snapshot_sha256: before.source_snapshot_sha256,
            ...(mutation === "request-model" ? { model: "other-model" } : {}),
          },
        })
      ).rejects.toThrow(
        mutation === "source-bytes"
          ? /snapshot digest mismatch/u
          : mutation === "source-identity"
            ? /could not be bound completely: symlink:src\/handler.ts/u
            : /model/u
      );
      expect(client.invocations).toEqual([]);
      expect(calls).toEqual({ prepare: 0, gather: 0 });
      expect(owner.checkpointer.loadRunById(runId)).toBeUndefined();
    }
    const overridden = fixture({ modelOverride: "ollama/other-model" });
    {
      using owner = overridden.service;
      await expect(owner.execute(start("conformance-host-model"))).rejects.toThrow(
        /worker refuses model override/u
      );
      expect(overridden.client.invocations).toEqual([]);
      expect(overridden.calls).toEqual({ prepare: 1, gather: 0 });
      assertNoDispatch(owner, "conformance-host-model");
    }
    for (const drift of ["provider", "model"] as const) {
      const client = new DriftedResolution(drift);
      const { service, calls } = fixture({ client });
      using owner = service;
      const runId = `conformance-resolved-${drift}`;
      await expect(owner.execute(start(runId))).rejects.toThrow(
        /worker-observed model .* does not equal required/u
      );
      expect(client.resolutions).toBe(1);
      expect(client.modelWork).toBe(0);
      expect(client.invocations).toEqual([]);
      expect(calls).toEqual({ prepare: 1, gather: 0 });
      assertNoDispatch(owner, runId);
    }
  });

  // Companion to the existing full-flow real_entrypoint assertion: that file stays
  // enrolled in full. This separately pins the current native admission/evidence semantics.
  it("admits the exact current registered terminal with consumed owner operations, signed captures and fresh evidence-bound reviews", async () => {
    const { service, client, calls } = fixture();
    using owner = service;
    const runId = "conformance-complete";
    const request = start(runId);
    const result = terminal(await owner.execute(request));
    expect(result.action).toBe("complete");
    expect(result.met).toBe(true);
    expect(result.unresolved).toEqual([]);
    expect(calls).toEqual({ prepare: 1, gather: 1 });
    expect(runtimeRegistrationSha256(owner.engine.registration)).toBe(
      runtimeRegistrationSha256(
        bindGenericChildYamlAuthority(SCA_PLAYBOOK_REGISTRATION, PROJECT_ROOT)
      )
    );
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual(
      Object.keys(SCA_AGENT_BY_STATE)
    );
    const reportRef = required(result.artifacts, "semantic-core");
    const report = exactJson(owner.artifacts, reportRef, ScaReportProductSchema);
    const manifest = exactJson(
      owner.artifacts,
      required(result.artifacts, "sca-output-manifest"),
      ScaOutputManifestSchema
    );
    expect(report.status).toBe("COMPLETE");
    expect(report.findings).toHaveLength(2);
    expect(report.gaps).toEqual([]);
    expect(manifest.status).toBe("complete");
    expect(manifest.outputs).toContainEqual(reportRef);
    expect(manifest.unresolved).toEqual([]);
    expect(manifest.source_snapshot_sha256).toBe(report.source_snapshot_sha256);
    expect(manifest.target_execution).toBe("NOT RUN");
    expect(manifest.publication_performed).toBe(false);
    const markdown = owner.artifacts
      .read(required(result.artifacts, "sca-report-markdown"))
      .toString("utf8");
    const sarif: unknown = JSON.parse(
      owner.artifacts.read(required(result.artifacts, "sca-report-sarif")).toString("utf8")
    );
    expect(validateScaReportRepresentations(report, markdown, sarif)).toEqual([]);
    assertReviews(owner, client, result);
    const registration = runtimeRegistrationSha256(owner.engine.registration);
    const operations = owner.checkpointer.hostOperationCallsForRun(runId);
    expect(operations.map((operation) => operation.operation_kind)).toEqual([
      "sca.preparation.v1",
      "sca.evidence.v1",
    ]);
    for (const operation of operations) {
      expect(operation.lifecycle).toBe("consumed");
      expect(operation.registration_sha256).toBe(registration);
      expect(operation.disposition?.outcome).toBe("completed");
      if (operation.host_receipt_ref === null || operation.platform_result_ref === null)
        throw new Error("Missing real owner receipt/result");
      expect(sha256(owner.artifacts.read(operation.host_receipt_ref))).toBe(
        operation.host_receipt_ref.content_digest
      );
      expect(sha256(owner.artifacts.read(operation.platform_result_ref))).toBe(
        operation.platform_result_ref.content_digest
      );
    }
    for (const invocation of client.invocations) {
      const session = invocation.workflowSession;
      if (session === undefined) throw new Error("Missing owner invocation coordinate");
      const coordinate = {
        run_id: runId,
        state_id: invocation.stateId,
        branch_id: null,
        agent: invocation.agent,
        attempt: session.attempt,
      };
      const receiptRef = owner.artifacts.refFor(
        runId,
        invocation.stateId,
        null,
        "model-execution-receipt",
        modelExecutionReceiptOperationId(coordinate),
        1
      );
      if (receiptRef === null) throw new Error("Missing signed model capture");
      const captured = exactJson(owner.artifacts, receiptRef, ModelExecutionReceiptV1Schema);
      const receipt = owner.engine.receiptAuthority.verify(captured.execution_receipt);
      expect(receipt.requested_model).toEqual(SCA_REQUIRED_MODEL);
      expect(receipt.observed_model).toEqual({
        provider: SCA_REQUIRED_MODEL.provider,
        model: SCA_REQUIRED_MODEL.model,
      });
      expect(sha256(owner.artifacts.read(receipt.output_artifact_ref))).toBe(receipt.output_digest);
      const guard = exactJson(
        owner.artifacts,
        captured.dispatch_guard_ref,
        ModelDispatchGuardV1Schema
      );
      expect(guard.coordinate).toEqual(coordinate);
      expect(guard.registration_sha256).toBe(registration);
      expect(invocation.registration.allowed_tools).toEqual(["artifact_read"]);
    }
    const admission = owner.checkpointer.completionAdmission(runId);
    if (admission === undefined) throw new Error("Missing native positive completion admission");
    expect(admission.origin_state).toBe("verifying_final_product");
    expect(admission.latest_product.product_id).toBe(reportRef.artifact_id);
    expect(admission.latest_product.sha256).toBe(reportRef.content_digest);
    expect(admission.unresolved_count).toBe(0);
    for (const state of SCA_PLAYBOOK_REGISTRATION.contract.completion_gate.required_visited_states)
      expect(admission.state_visit_refs.map((visit) => visit.state_id)).toContain(state);
    const before = client.invocations.length;
    expect(
      await owner.execute({ schema_version: 2, action: "recover", identity: request.identity })
    ).toEqual(result);
    expect(client.invocations).toHaveLength(before);
    expect(calls).toEqual({ prepare: 1, gather: 1 });
  });

  it("keeps unresolved mandatory coverage or evidence non-positive even when both final reviews PASS", async () => {
    for (const gap of ["missing-capability", "missing-result", "explicit-evidence-gap"] as const) {
      const mode = gap === "missing-capability" ? "missing" : "confirmed";
      const base = fixtureRuntime(mode);
      const { service, client, calls } = fixture({
        mode,
        runtime: {
          prepare: (input) => base.prepare(input),
          async gather(input) {
            const evidence = await base.gather(input);
            if (gap === "missing-result") evidence.results.shift();
            if (gap === "explicit-evidence-gap")
              evidence.gaps.push("Mandatory independent evidence remains unresolved");
            return evidence;
          },
        },
      });
      using owner = service;
      const runId = `conformance-${gap}`;
      const request = start(runId);
      const result = terminal(await owner.execute(request));
      expect(result.action).toBe("incomplete");
      expect(result.met).toBe(false);
      expect(result.unresolved.length).toBeGreaterThan(0);
      expect(owner.checkpointer.completionAdmission(runId)).toBeUndefined();
      const context = owner.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("Missing durable negative terminal");
      expect(context.status).toBe("incomplete");
      expect(context.met).toBe(false);
      const report = exactJson(
        owner.artifacts,
        required(result.artifacts, "semantic-core"),
        ScaReportProductSchema
      );
      const manifest = exactJson(
        owner.artifacts,
        required(result.artifacts, "sca-output-manifest"),
        ScaOutputManifestSchema
      );
      expect(report.status).toBe("INCOMPLETE");
      expect(report.findings).toHaveLength(2);
      expect(manifest.status).toBe("incomplete");
      expect(manifest.unresolved).toEqual(report.gaps);
      expect(result.unresolved).toEqual(report.gaps);
      expect(report.gaps.join(" ")).toContain(
        gap === "missing-capability"
          ? "unavailable"
          : gap === "missing-result"
            ? "missing or duplicate evidence result"
            : "Mandatory independent evidence remains unresolved"
      );
      if (gap === "missing-result")
        expect(report.dispositions.dispositions[0]?.disposition).toBe("inconclusive");
      assertReviews(owner, client, result);
      expect(client.invocations.at(-1)?.stateId).toBe("verifying_final_product");
      const before = client.invocations.length;
      expect(
        await owner.execute({ schema_version: 2, action: "recover", identity: request.identity })
      ).toEqual(result);
      expect(client.invocations).toHaveLength(before);
      expect(calls).toEqual({ prepare: 1, gather: 1 });
      expect(manifest.target_execution).toBe("NOT RUN");
      expect(result.result.target_executed).toBe(false);
    }
  });
});
