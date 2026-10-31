import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";
import { OrchestrationService } from "../dist/service.js";
import { SCA_AGENT_BY_STATE, SCA_PLAYBOOK_REGISTRATION } from "../dist/playbooks/sca.js";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import {
  createScaOrdinaryHostAdapters,
  type ScaOrdinaryRuntime,
} from "../dist/sca/ordinary-host.js";
import { SCA_MODEL_OVERRIDE } from "../dist/sca/model-identity.js";
import {
  ScaReportProductSchema,
  renderScaOrdinaryMarkdown,
  renderScaOrdinarySarif,
  validateScaReportRepresentations,
} from "../dist/sca/ordinary-report.js";
import {
  ScaActionsSchema,
  ScaDispositionsSchema,
  ScaEvidenceSchema,
  ScaHypothesesSchema,
  ScaReportDraftSchema,
  ScaReviewSchema,
  parseScaReview,
  type ScaAnalysisTools,
  type ScaEvidence,
} from "../dist/sca/ordinary-contracts.js";
import { validateContract } from "../dist/contracts.js";
import type { AgentInvocation } from "../dist/model-client.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  environment,
  fixtureAdapters,
  fixtureRuntime,
  identity,
  PROJECT_ROOT,
  pointer,
  roots,
  ScriptedScaClient,
  start,
  type ScaFixtureMode,
} from "./helpers/sca-local-workflow.js";
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function run(
  mode: ScaFixtureMode = "confirmed",
  overrides = true,
  suppliedClient?: ScriptedScaClient,
  runtime?: ScaOrdinaryRuntime,
  tools?: ScaAnalysisTools
) {
  // This cohort includes intentionally persistent mutants. Its finite policy is
  // fixture-owned, not a default for ordinary operator runs.
  const env = { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "3" };
  const client = suppliedClient ?? new ScriptedScaClient(mode);
  const service = new OrchestrationService({
    projectRoot: PROJECT_ROOT,
    playbookName: "sca",
    env,
    modelClient: client,
    ...(overrides
      ? {
          hostOperationAdapters:
            runtime === undefined ? fixtureAdapters(mode) : createScaOrdinaryHostAdapters(runtime),
        }
      : {}),
  });
  client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
  const request = start(`ordinary-${mode}-${overrides}`);
  const directive = await service.execute({
    ...request,
    constraints: {
      ...request.constraints,
      ...(tools === undefined ? {} : { analysis_tools: tools }),
    },
  });
  const context = service.checkpointer.loadRunById(`ordinary-${mode}-${overrides}`);
  if (context === undefined) throw new Error("Test run not persisted");
  const result = { directive, context: context.snapshot() };
  const reportRef = [...result.context.selected_artifacts]
    .reverse()
    .find((ref) => ref.kind === "semantic-core");
  const report =
    reportRef === undefined
      ? null
      : validateContract(
          ScaReportProductSchema,
          JSON.parse(service.artifacts.readById(reportRef.artifact_id).toString("utf8")),
          "Test report"
        );
  const evidenceRef = [...result.context.selected_artifacts]
    .reverse()
    .find((ref) => ref.kind === "sca-validated-evidence");
  const evidence =
    evidenceRef === undefined
      ? null
      : validateContract(
          ScaEvidenceSchema,
          JSON.parse(service.artifacts.readById(evidenceRef.artifact_id).toString("utf8")),
          "Test evidence"
        );
  const rawEvidenceRef = [...result.context.selected_artifacts]
    .reverse()
    .find((ref) => ref.kind === "sca-evidence-result");
  const rawEvidence =
    rawEvidenceRef === undefined
      ? null
      : validateContract(
          ScaEvidenceSchema,
          JSON.parse(service.artifacts.readById(rawEvidenceRef.artifact_id).toString("utf8")),
          "Test attempted evidence"
        );
  service.close();
  return { service, client, result, report, reportRef, evidence, rawEvidence };
}
class MutatingClient extends ScriptedScaClient {
  constructor(private readonly mutate: (invocation: AgentInvocation, output: unknown) => unknown) {
    super();
  }
  override output(invocation: AgentInvocation): unknown {
    return this.mutate(invocation, super.output(invocation));
  }
}
function mutatingRuntime(
  mutate: (evidence: ScaEvidence, input: Parameters<ScaOrdinaryRuntime["gather"]>[0]) => void,
  base = fixtureRuntime()
): ScaOrdinaryRuntime {
  return {
    prepare: (input) => base.prepare(input),
    async gather(input) {
      const evidence = await base.gather(input);
      mutate(evidence, input);
      return evidence;
    },
  };
}
const graphTools: ScaAnalysisTools = {
  graph: {
    joern: {
      executable: path.join(PROJECT_ROOT, "fixture-tools", "joern"),
      sha256: sha256("fixture-joern"),
      version: "offline",
    },
    queries: ["offline-query", "other-query"].map((id) => ({
      id,
      script_path: path.join(PROJECT_ROOT, "fixture-tools", `${id}.sc`),
      sha256: sha256(id),
    })),
  },
};
function graphFixtureRuntime(): ScaOrdinaryRuntime {
  const base = fixtureRuntime();
  return {
    async prepare(input) {
      const prepared = await base.prepare(input);
      for (const graph of prepared.graphs) {
        const first = graph.query_observations[0];
        if (first === undefined) throw new Error("Missing fixture query");
        const p = pointer(graph.language === "php" ? "src/handler.php" : "src/handler.ts");
        first.observation.rows = [
          {
            title: "Offline relation",
            path: p.path,
            start_line: p.start_line,
            end_line: p.end_line,
          },
        ];
        first.observation_sha256 = sha256(canonicalJson(first.observation));
        first.raw_stdout_sha256 = first.observation_sha256;
        const other = {
          ...first,
          query_id: "other-query",
          observation: { ...first.observation, rows: [] },
        };
        other.observation_sha256 = sha256(canonicalJson(other.observation));
        other.raw_stdout_sha256 = other.observation_sha256;
        graph.query_observations.push(other);
      }
      return prepared;
    },
    async gather(input) {
      const evidence = await base.gather(input);
      for (const action of input.actions.actions.filter((entry) => entry.kind === "graph")) {
        const entry = evidence.results.find((result) => result.action_id === action.id);
        if (entry === undefined) throw new Error("Missing fixture graph result");
        const observations = input.graphs.map((graph) => {
          const query = graph.query_observations.find(
            (query) => query.query_id === action.query_id
          );
          if (query === undefined) throw new Error("Missing fixture graph query");
          return { ...query.observation, digest: query.raw_stdout_sha256 };
        });
        entry.status = "completed";
        entry.pointers = observations.flatMap((observed) =>
          observed.rows.map((row) =>
            pointer(row.path === "src/handler.php" ? "src/handler.php" : "src/handler.ts")
          )
        );
        entry.observation = canonicalJson(observations);
        entry.evidence_sha256 = sha256(entry.observation);
      }
      return evidence;
    },
  };
}
function graphClient(queryId = "offline-query"): MutatingClient {
  return new MutatingClient((invocation, output) => {
    if (invocation.stateId !== "selecting_evidence_actions") return output;
    const value = validateContract(ScaActionsSchema, output, "Graph action fixture");
    const first = value.actions[0];
    if (first === undefined) throw new Error("Missing graph action");
    first.kind = "graph";
    first.query_id = queryId;
    return value;
  });
}
describe("ordinary registered SCA replacement", () => {
  it("routes real admission/owner/engine/artifacts through the complete ordinary phase sequence", async () => {
    const { result, report, client } = await run();
    expect(result.context.status).toBe("complete");
    expect(client.invocations.map((entry) => entry.stateId)).toEqual(
      Object.keys(SCA_AGENT_BY_STATE)
    );
    expect(client.invocations.every((entry) => entry.modelOverride === SCA_MODEL_OVERRIDE)).toBe(
      true
    );
    expect(report?.status).toBe("COMPLETE");
    expect(report?.findings).toHaveLength(2);
    expect(report?.findings.every((entry) => entry.status === "Confirmed — code verified")).toBe(
      true
    );
    expect(report?.learning.baseline_unchanged).toBe(true);
    expect(report?.evidence_refs.some((ref) => ref.kind === "sca-reconciliation")).toBe(true);
    expect(
      result.context.selected_artifacts.some((ref) => ref.kind === "sca-output-manifest")
    ).toBe(true);
    expect(report?.findings[0]?.severity).toBe("Critical");
    expect(report?.findings[0]?.scoring?.score).toBe(9.3);
  });
  it("adopts exact cached scanner output after owner fetch interruption without rerunning preparation", async () => {
    const env = environment();
    const client = new ScriptedScaClient();
    const base = fixtureRuntime();
    let preparations = 0;
    const adapters = createScaOrdinaryHostAdapters({
      async prepare(input) {
        preparations += 1;
        return base.prepare(input);
      },
      gather: (input) => base.gather(input),
    });
    const first = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      playbookName: "sca",
      env,
      modelClient: client,
      hostOperationAdapters: adapters,
      hostOperationFault: (point, operation) => {
        if (point === "after_fetch" && operation === "sca.preparation.v1")
          throw new HostOperationSimulatedCrashError(point);
      },
    });
    client.bindArtifactReader((id) => first.artifacts.readById(id).toString("utf8"));
    await expect(first.execute(start("ordinary-cached-recovery"))).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    first.close();
    expect(preparations).toBe(1);
    const recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      playbookName: "sca",
      env,
      modelClient: client,
      hostOperationAdapters: adapters,
    });
    client.bindArtifactReader((id) => recovered.artifacts.readById(id).toString("utf8"));
    const result = await recovered.execute({
      schema_version: 2,
      action: "recover",
      identity: identity("ordinary-cached-recovery"),
    });
    expect(result.action).toBe("complete");
    expect(preparations).toBe(1);
    recovered.close();
  });
  it("recovers exact cached evidence once, quarantines substitution and still finishes the useful report", async () => {
    const env = environment();
    const client = new ScriptedScaClient();
    const base = mutatingRuntime((evidence) => {
      const first = evidence.results[0];
      if (first === undefined) throw new Error("Missing recovery evidence");
      first.pointers = [pointer("src/handler.php")];
      first.evidence_sha256 = sha256(canonicalJson(first.pointers));
    });
    let gatherings = 0;
    const adapters = createScaOrdinaryHostAdapters({
      prepare: (input) => base.prepare(input),
      gather(input) {
        gatherings += 1;
        return base.gather(input);
      },
    });
    const runId = "ordinary-evidence-cached-recovery";
    const first = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      playbookName: "sca",
      env,
      modelClient: client,
      hostOperationAdapters: adapters,
      hostOperationFault: (point, operation) => {
        if (point === "after_fetch" && operation === "sca.evidence.v1")
          throw new HostOperationSimulatedCrashError(point);
      },
    });
    client.bindArtifactReader((id) => first.artifacts.readById(id).toString("utf8"));
    await expect(first.execute(start(runId))).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    first.close();
    expect(gatherings).toBe(1);
    const recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      playbookName: "sca",
      env,
      modelClient: client,
      hostOperationAdapters: adapters,
    });
    using _owner = recovered;
    client.bindArtifactReader((id) => recovered.artifacts.readById(id).toString("utf8"));
    const result = await recovered.execute({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(result.action).toBe("incomplete");
    expect(gatherings).toBe(1);
    const reportRef = recovered.checkpointer
      .loadRunById(runId)
      ?.selectedArtifacts.find((ref) => ref.kind === "semantic-core");
    if (reportRef === undefined) throw new Error("Missing recovered report");
    const report = validateContract(
      ScaReportProductSchema,
      JSON.parse(recovered.artifacts.readById(reportRef.artifact_id).toString("utf8")),
      "Recovered report"
    );
    expect(report.dispositions.dispositions.map((entry) => entry.disposition)).toEqual([
      "inconclusive",
      "confirmed_code",
    ]);
    expect(report.findings).toHaveLength(2);
    expect(client.invocations.at(-1)?.stateId).toBe("verifying_final_product");
  });
  it("does not send the full source corpus to either selection/hypothesis worker", async () => {
    const { client } = await run();
    for (const worker of client.invocations) {
      expect(worker.inputArtifacts.some((ref) => ref.kind === "sca-source-corpus")).toBe(false);
      expect(worker.task).not.toContain("x".repeat(1000));
    }
    expect(SCA_PLAYBOOK_REGISTRATION.worker.kind).toBe("catalog-agent");
    expect(SCA_PLAYBOOK_REGISTRATION.host_operations?.declarations).toHaveLength(6);
    expect(
      SCA_PLAYBOOK_REGISTRATION.worker.kind === "catalog-agent" &&
        [...SCA_PLAYBOOK_REGISTRATION.worker.phases.values()].every(
          (phase) => phase.allowed_tools?.join() === "artifact_read"
        )
    ).toBe(true);
  });
  it("preserves AI-only no-alert findings and full reconciliation", async () => {
    const { report } = await run("noalert");
    expect(report?.status).toBe("COMPLETE");
    expect(report?.findings).toHaveLength(2);
    expect(report?.candidates).toEqual([]);
    expect(report?.findings).toHaveLength(2);
    expect(report?.hypotheses.hypotheses).toHaveLength(
      report?.dispositions.dispositions.length ?? -1
    );
  });
  it("retains concrete counterevidence and produces honest zero-finding learning", async () => {
    const { report, result } = await run("refuted");
    expect(result.context.status).toBe("complete");
    expect(report?.findings).toEqual([]);
    expect(report?.dispositions.dispositions[0]?.disposition).toBe("refuted");
    expect(report?.dispositions.dispositions[0]?.counterevidence[0]?.path).toBe("src/safe.ts");
    expect(report?.learning.outcomes).toEqual([]);
    expect(report?.learning.no_eligible_findings_reason).toContain("refuted");
  });
  it("finishes reporting but never safe-PASSes a material missing capability", async () => {
    const { result, report, client } = await run("missing");
    expect(result.context.status).toBe("incomplete");
    expect(report?.status).toBe("INCOMPLETE");
    expect(report?.findings).toHaveLength(2);
    expect(client.invocations.at(-1)?.stateId).toBe("verifying_final_product");
    expect(report?.preparation.capabilities.some((entry) => entry.status === "unavailable")).toBe(
      true
    );
  });
  it("runs the installed default adapter without requiring injected tools or bootstrap, reporting absence explicitly", async () => {
    const { report, result } = await run("noalert", false);
    expect(result.context.status).toBe("incomplete");
    expect(report?.findings).toHaveLength(2);
    expect(report?.preparation.capabilities.some((entry) => entry.status === "unavailable")).toBe(
      true
    );
    expect(
      result.context.selected_artifacts.some(
        (ref) => ref.kind.includes("bootstrap") || ref.kind.includes("qualification")
      )
    ).toBe(false);
  });
  it("repairs the exact report, re-renders and obtains fresh Carren and Vera review", async () => {
    const { result, client } = await run("repair");
    expect(result.context.status).toBe("complete");
    expect(
      client.invocations.filter((entry) => entry.stateId === "materializing_report")
    ).toHaveLength(2);
    expect(client.invocations.filter((entry) => entry.stateId === "reviewing_report")).toHaveLength(
      2
    );
    expect(
      client.invocations.filter((entry) => entry.stateId === "verifying_final_product")
    ).toHaveLength(1);
  });
  it("keeps a useful report when the bounded repair allowance is exhausted", async () => {
    const { result, report } = await run("exhaust");
    expect(result.context.status).toBe("incomplete");
    expect(report?.findings).toHaveLength(2);
    expect(result.directive.action).toBe("incomplete");
  });
  it("rejects review contradictions and stale or unsupplied evidence bindings", () => {
    const base = {
      schema_version: 1,
      report_artifact_id: `art_${"a".repeat(64)}`,
      report_sha256: "a".repeat(64),
      checked_evidence_ids: [`art_${"b".repeat(64)}`],
      claim_support: true,
      counterevidence_addressed: true,
      execution_truth: true,
      scoring_semantics: true,
      redaction: true,
      report_quality: true,
      issues: [],
    };
    expect(() => parseScaReview({ ...base, verdict: "PASS", execution_truth: false })).toThrow();
    expect(() => parseScaReview({ ...base, verdict: "GAP" })).toThrow();
  });
  it("rejects substituted h-1 evidence on h-0, exhausts bounded drafts and retains both hypotheses", async () => {
    const client = new MutatingClient((invocation, output) => {
      if (invocation.stateId !== "adjudicating_evidence") return output;
      const value = validateContract(ScaDispositionsSchema, output, "Substitution fixture");
      const first = value.dispositions[0];
      if (first === undefined) throw new Error("Missing h-0 disposition");
      first.evidence = [pointer("src/handler.php")];
      return value;
    });
    const { report, result } = await run("confirmed", true, client);
    expect(result.context.status).toBe("incomplete");
    if (report === null) throw new Error("Missing substitution report");
    expect(report.status).toBe("INCOMPLETE");
    expect(report.hypotheses.hypotheses).toHaveLength(2);
    expect(report.dispositions.dispositions.map((entry) => entry.disposition)).toEqual([
      "inconclusive",
      "inconclusive",
    ]);
    expect(report.findings).toHaveLength(2);
    expect(report.findings.find((entry) => entry.hypothesis_id === "h-0")?.status).not.toBe(
      "Confirmed — code verified"
    );
    expect(report.gaps.join(" ")).toContain("SCA evidence_binding");
    expect(client.invocations.at(-1)?.stateId).toBe("adjudicating_evidence");
  });
  it.each([
    "confirmed_code",
    "refuted",
    "probable",
    "theoretical",
    "duplicate",
    "out_of_scope",
    "inconclusive",
  ] as const)(
    "rejects %s claims with substituted counterevidence without editing the disposition or dropping a hypothesis",
    async (disposition) => {
      const client = new MutatingClient((invocation, output) => {
        if (invocation.stateId !== "adjudicating_evidence") return output;
        const value = validateContract(ScaDispositionsSchema, output, "Counterevidence fixture");
        const first = value.dispositions[0];
        if (first === undefined) throw new Error("Missing disposition");
        first.disposition = disposition;
        first.duplicate_of = disposition === "duplicate" ? "h-1" : null;
        first.counterevidence = [pointer("src/handler.php")];
        return value;
      });
      const { report, result } = await run("confirmed", true, client);
      expect(result.context.status).toBe("incomplete");
      if (report === null) throw new Error("Missing counterevidence report");
      expect(report.dispositions.dispositions[0]?.disposition).toBe("inconclusive");
      expect(report.dispositions.dispositions[0]?.counterevidence).toEqual([]);
      expect(report.dispositions.dispositions[1]?.disposition).toBe("inconclusive");
      expect(report.findings).toHaveLength(2);
      expect(report.gaps.join(" ")).toContain("SCA evidence_binding");
      expect(client.invocations.at(-1)?.stateId).toBe("adjudicating_evidence");
    }
  );
  it.each([false, true])(
    "requires an independent source action to be declared by its disposition (declared=%s)",
    async (declared) => {
      const client = new MutatingClient((invocation, output) => {
        if (invocation.stateId === "selecting_evidence_actions") {
          const value = validateContract(ScaActionsSchema, output, "Independent source fixture");
          const first = value.actions[0];
          if (first === undefined) throw new Error("Missing source action");
          value.actions.push({
            ...first,
            id: "a-independent",
            ranges: [{ path: "src/handler.php", start_line: 2, end_line: 4 }],
          });
          return value;
        }
        if (invocation.stateId !== "adjudicating_evidence") return output;
        const value = validateContract(
          ScaDispositionsSchema,
          output,
          "Independent disposition fixture"
        );
        const first = value.dispositions[0];
        if (first === undefined) throw new Error("Missing disposition");
        first.evidence = [pointer("src/handler.php")];
        if (declared) first.action_ids.push("a-independent");
        return value;
      });
      const { report, result } = await run("confirmed", true, client);
      expect(result.context.status).toBe(declared ? "complete" : "incomplete");
      if (report === null) throw new Error("Missing independent source report");
      expect(report.dispositions.dispositions[0]?.disposition).toBe(
        declared ? "confirmed_code" : "inconclusive"
      );
      expect(report.findings).toHaveLength(2);
    }
  );
  it.each([true, false])(
    "requires full line coverage when composing quotations from own completed observations (contiguous=%s)",
    async (contiguous) => {
      const client = new MutatingClient((invocation, output) => {
        if (invocation.stateId !== "selecting_evidence_actions") return output;
        const value = validateContract(ScaActionsSchema, output, "Split source fixture");
        const first = value.actions[0];
        if (first === undefined) throw new Error("Missing split source action");
        first.ranges = [
          { path: "src/handler.ts", start_line: 1, end_line: 1 },
          { path: "src/handler.ts", start_line: contiguous ? 2 : 3, end_line: 3 },
        ];
        return value;
      });
      const { report, result } = await run("confirmed", true, client);
      expect(result.context.status).toBe(contiguous ? "complete" : "incomplete");
      if (report === null) throw new Error("Missing split source report");
      expect(report.dispositions.dispositions[0]?.disposition).toBe(
        contiguous ? "confirmed_code" : "inconclusive"
      );
      expect(report.findings).toHaveLength(2);
      expect(client.invocations.at(-1)?.stateId).toBe("verifying_final_product");
    }
  );
  it("accepts exact subrange counterevidence independently obtained by a hypothesis-bound source action", async () => {
    const client = new MutatingClient((invocation, output) => {
      if (invocation.stateId === "selecting_evidence_actions") {
        const value = validateContract(ScaActionsSchema, output, "Independent refutation action");
        const first = value.actions[0];
        if (first === undefined) throw new Error("Missing action");
        first.ranges = [{ path: "src/safe.ts", start_line: 1, end_line: 4 }];
        return value;
      }
      if (invocation.stateId !== "adjudicating_evidence") return output;
      const value = validateContract(ScaDispositionsSchema, output, "Independent refutation");
      const first = value.dispositions[0];
      if (first === undefined) throw new Error("Missing disposition");
      const p = pointer("src/safe.ts");
      first.disposition = "refuted";
      first.evidence = [];
      first.counterevidence = [
        {
          ...p,
          start_line: 2,
          end_line: 3,
          exact_quote: p.exact_quote.split("\n").slice(1, 3).join("\n"),
        },
      ];
      return value;
    });
    const { report, result } = await run("confirmed", true, client);
    expect(result.context.status).toBe("complete");
    if (report === null) throw new Error("Missing independent refutation report");
    expect(report.dispositions.dispositions[0]?.disposition).toBe("refuted");
    expect(report.dispositions.dispositions[0]?.counterevidence[0]?.start_line).toBe(2);
    expect(report.findings.map((finding) => finding.hypothesis_id)).toEqual(["h-1"]);
  });
  it.each([
    "wrong-source",
    "empty-pointers",
    "duplicate-pointer",
    "wrong-hypothesis",
    "missing-result",
    "duplicate-result",
    "noncompleted-pointers",
    "deferred-source",
    "digest",
    "source-observation",
    "runtime-claim",
  ])(
    "quarantines %s host evidence per requested action and preserves the best full report",
    async (mutation) => {
      const runtime = mutatingRuntime((evidence) => {
        const first = evidence.results[0];
        if (first === undefined) throw new Error("Missing host result");
        if (mutation === "wrong-source") first.pointers = [pointer("src/handler.php")];
        if (mutation === "empty-pointers") first.pointers = [];
        if (mutation === "duplicate-pointer") first.pointers.push(...first.pointers);
        if (mutation === "wrong-hypothesis") first.hypothesis_id = "h-1";
        if (mutation === "missing-result") evidence.results.shift();
        if (mutation === "duplicate-result") evidence.results.push({ ...first });
        if (mutation === "noncompleted-pointers") first.status = "unavailable";
        if (mutation === "deferred-source") {
          first.status = "deferred";
          first.pointers = [];
        }
        if (mutation === "source-observation")
          first.observation = "An invented observation with an honestly recomputed hash";
        if (mutation === "runtime-claim") first.execution = "RUN";
        first.evidence_sha256 =
          mutation === "digest"
            ? "0".repeat(64)
            : sha256(first.observation === "" ? canonicalJson(first.pointers) : first.observation);
      });
      const client = new ScriptedScaClient();
      const { report, result, evidence, rawEvidence } = await run(
        "confirmed",
        true,
        client,
        runtime
      );
      expect(result.context.status).toBe("incomplete");
      if (report === null || evidence === null || rawEvidence === null)
        throw new Error(`Missing retained evidence/report: ${report?.gaps.join("; ")}`);
      expect(
        evidence.results.map((entry) => [entry.action_id, entry.hypothesis_id, entry.status])
      ).toEqual([
        ["a-0", "h-0", "failed"],
        ["a-1", "h-1", "completed"],
      ]);
      expect(report.dispositions.dispositions.map((entry) => entry.disposition)).toEqual([
        "inconclusive",
        "confirmed_code",
      ]);
      expect(report.findings).toHaveLength(2);
      expect(report.findings.find((entry) => entry.hypothesis_id === "h-1")?.status).toBe(
        "Confirmed — code verified"
      );
      expect(report.gaps.join(" ")).toContain("Rejected a-0 evidence");
      expect(client.invocations.at(-1)?.stateId).toBe("verifying_final_product");
    }
  );
  it.each(["defer", "application_test"] as const)(
    "does not accept a completed %s action as ordinary static proof",
    async (kind) => {
      const client = new MutatingClient((invocation, output) => {
        if (invocation.stateId !== "selecting_evidence_actions") return output;
        const value = validateContract(ScaActionsSchema, output, "Non-source action fixture");
        const first = value.actions[0];
        if (first === undefined) throw new Error("Missing action");
        first.kind = kind;
        return value;
      });
      const runtime = mutatingRuntime((evidence) => {
        const first = evidence.results[0];
        if (first === undefined) throw new Error("Missing host result");
        first.status = "completed";
        first.pointers = [pointer("src/handler.ts")];
        first.evidence_sha256 = sha256(canonicalJson(first.pointers));
      });
      const { report, result } = await run("confirmed", true, client, runtime);
      expect(result.context.status).toBe("incomplete");
      if (report === null) throw new Error("Missing report");
      expect(report.dispositions.dispositions[0]?.disposition).toBe("inconclusive");
      expect(report.findings).toHaveLength(2);
      expect(client.invocations.at(-1)?.stateId).toBe("verifying_final_product");
    }
  );
  it.each(["foreign-result", "explicit-gap"])(
    "accounts for %s host material even when requested results are otherwise adequate",
    async (mutation) => {
      const runtime = mutatingRuntime((evidence) => {
        const first = evidence.results[0];
        if (first === undefined) throw new Error("Missing host result");
        if (mutation === "foreign-result")
          evidence.results.push({ ...first, action_id: "invented-action" });
        else evidence.gaps.push("Independent host evidence obligation remains unresolved");
      });
      const { report, result, evidence } = await run("confirmed", true, undefined, runtime);
      expect(result.context.status).toBe("incomplete");
      if (report === null || evidence === null) throw new Error("Missing report/evidence");
      expect(report.findings).toHaveLength(2);
      expect(evidence.results).toHaveLength(2);
      expect(report.gaps.join(" ")).toContain(
        mutation === "foreign-result"
          ? "Foreign evidence result"
          : "Independent host evidence obligation"
      );
    }
  );
  it("accepts completed graph evidence only with the exact requested query, captured graphs and source rows", async () => {
    const { report, result, evidence } = await run(
      "confirmed",
      true,
      graphClient(),
      graphFixtureRuntime(),
      graphTools
    );
    expect(result.context.status, report?.gaps.join("; ")).toBe("complete");
    if (report === null || evidence === null) throw new Error("Missing graph report/evidence");
    expect(evidence.results[0]?.status).toBe("completed");
    expect(report.findings).toHaveLength(2);
  });
  it.each(["absent", "different-query"])(
    "rejects graph completion with %s caller query configuration",
    async (configuration) => {
      const graph = graphTools.graph;
      if (graph === undefined) throw new Error("Missing graph tool fixture");
      const selectedTools =
        configuration === "absent"
          ? undefined
          : {
              graph: {
                ...graph,
                queries: graph.queries.filter((query) => query.id === "other-query"),
              },
            };
      const client = graphClient();
      const { report, result, evidence } = await run(
        "confirmed",
        true,
        client,
        graphFixtureRuntime(),
        selectedTools
      );
      expect(result.context.status).toBe("incomplete");
      if (report === null || evidence === null) throw new Error("Missing graph binding report");
      expect(evidence.results[0]?.status).toBe("failed");
      expect(report.dispositions.dispositions[0]?.disposition).toBe("inconclusive");
      expect(report.gaps.join(" ")).toContain("caller-selected query binding");
      expect(report.findings).toHaveLength(2);
    }
  );
  it.each([
    "query",
    "source-hash",
    "coverage",
    "incomplete",
    "missing-observation",
    "duplicate-observation",
    "foreign-row",
    "pointer-substitution",
  ])(
    "rejects completed graph evidence with %s substitution even with a valid observation digest",
    async (mutation) => {
      const runtime = mutatingRuntime((evidence, input) => {
        const first = evidence.results[0];
        if (first === undefined) throw new Error("Missing graph result");
        const observations = input.graphs.map((graph) => {
          const query = graph.query_observations.find(
            (query) => query.query_id === (mutation === "query" ? "other-query" : "offline-query")
          );
          if (query === undefined) throw new Error("Missing captured query");
          return { ...query.observation, digest: query.raw_stdout_sha256 };
        });
        const observed = observations[0];
        if (observed === undefined) throw new Error("Missing graph observation");
        if (mutation === "source-hash")
          observed.files = observed.files.map((file) => ({
            ...file,
            content_sha256: "0".repeat(64),
          }));
        if (mutation === "coverage") observed.files = [];
        if (mutation === "incomplete") observed.complete = false;
        if (mutation === "missing-observation") observations.pop();
        if (mutation === "duplicate-observation") observations[1] = observed;
        if (mutation === "foreign-row")
          observed.rows = [
            { title: "Foreign row", path: "src/safe.ts", start_line: 1, end_line: 4 },
          ];
        if (mutation === "pointer-substitution") first.pointers = [pointer("src/safe.ts")];
        first.observation = canonicalJson(observations);
        first.evidence_sha256 = sha256(first.observation);
      }, graphFixtureRuntime());
      const client = graphClient();
      const { report, result, evidence, rawEvidence } = await run(
        "confirmed",
        true,
        client,
        runtime,
        graphTools
      );
      expect(result.context.status).toBe("incomplete");
      if (report === null || evidence === null || rawEvidence === null)
        throw new Error(`Missing retained graph evidence/report: ${report?.gaps.join("; ")}`);
      expect(evidence.results[0]?.status).toBe("failed");
      expect(report.dispositions.dispositions.map((entry) => entry.disposition)).toEqual([
        "inconclusive",
        "confirmed_code",
      ]);
      expect(report.findings).toHaveLength(2);
      expect(client.invocations.at(-1)?.stateId).toBe("verifying_final_product");
    }
  );
  it("rejects fabricated source quotations without promoting them or losing the exact attempted work", async () => {
    const client = new MutatingClient((invocation, output) => {
      if (invocation.stateId !== "forming_hypotheses") return output;
      const value = validateContract(ScaHypothesesSchema, output, "Mutation fixture");
      const first = value.hypotheses[0]?.support[0];
      if (first !== undefined) first.exact_quote = "invented source";
      return value;
    });
    const { report, result } = await run("confirmed", true, client);
    expect(result.context.status).toBe("incomplete");
    expect(report?.status).toBe("INCOMPLETE");
    expect(report?.gaps.join(" ")).toContain("SCA citation_quote at /hypotheses/0/support/0");
    expect(
      report?.findings.every((finding) => finding.status !== "Confirmed — code verified")
    ).toBe(true);
    expect(report?.evidence_refs.some((ref) => ref.kind === "sca-forming-hypotheses")).toBe(false);
    expect(
      result.context.selected_artifacts.some((ref) => ref.kind === "sca-semantic-diagnostic")
    ).toBe(true);
    expect(client.invocations.filter((i) => i.stateId === "forming_hypotheses")).toHaveLength(3);
  });
  it.each(["missing-cwe", "missing-metrics", "redaction"])(
    "retains %s report material as INCOMPLETE, never a successful empty report",
    async (mode) => {
      const client = new MutatingClient((invocation, output) => {
        if (invocation.stateId !== "materializing_report") return output;
        const draft = validateContract(ScaReportDraftSchema, output, "Mutation draft");
        const first = draft.findings[0];
        if (first === undefined) throw new Error("Missing fixture finding");
        if (mode === "missing-cwe") {
          first.cwe_id = null;
          first.cwe_name = null;
        }
        if (mode === "missing-metrics") {
          first.cvss_vector = null;
          first.missing_metrics = ["AV", "SC"];
        }
        if (mode === "redaction")
          first.description += " Fixture private contact: analyst@example.invalid";
        return draft;
      });
      const { report, result } = await run("confirmed", true, client);
      expect(result.context.status).toBe("incomplete");
      expect(report?.findings).toHaveLength(2);
      expect(report?.findings[0]?.missing.length).toBeGreaterThan(0);
      if (mode === "redaction")
        expect(canonicalJson(report)).not.toContain("analyst@example.invalid");
      if (mode === "missing-metrics") expect(report?.findings[0]?.severity).toBe("Unscored");
    }
  );
  it("refuses stale or contradictory final reviews under bounded repair and retains an annotated partial report", async () => {
    const client = new MutatingClient((invocation, output) => {
      if (invocation.stateId !== "verifying_final_product") return output;
      const review = validateContract(ScaReviewSchema, output, "Mutation review");
      review.report_sha256 = "0".repeat(64);
      return review;
    });
    const { report, result, client: captured } = await run("confirmed", true, client);
    expect(result.context.status).toBe("incomplete");
    expect(report?.status).toBe("INCOMPLETE");
    expect(report?.gaps.join(" ")).toContain("repair");
    expect(
      captured.invocations
        .filter((entry) => entry.stateId === "materializing_report")
        .slice(1)
        .every((entry) => entry.inputArtifacts.some((ref) => ref.kind === "sca-report-feedback"))
    ).toBe(true);
  });
  it("renders five sections, full metadata and matching deterministic severity in every representation", async () => {
    const { report } = await run();
    if (report === null) throw new Error("Test report missing");
    const markdown = renderScaOrdinaryMarkdown(report);
    const sarif = renderScaOrdinarySarif(report);
    expect(validateScaReportRepresentations(report, markdown, sarif)).toEqual([]);
    expect(markdown.match(/^#{3,4} /gm)).toHaveLength(report.findings.length * 5);
    expect(markdown).toContain("CWE-78 (Improper Neutralization");
    expect(markdown).toContain("Target execution: NOT RUN");
    expect(markdown).not.toContain("/home/");
    expect(canonicalJson(sarif)).toContain("source_snapshot_sha256");
    expect(
      validateScaReportRepresentations(report, markdown.replace("(Critical)", "(Low)"), sarif)
    ).not.toEqual([]);
    expect(identity("fixture").playbook).toBe("sca");
  });
});
