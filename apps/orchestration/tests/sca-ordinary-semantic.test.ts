/** Exact semantic mutants, real engine capture/receipts/routes; no provider or external replay. */
import { afterEach, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OrchestrationService } from "../dist/service.js";
import { validateContract, type ArtifactRef } from "../dist/contracts.js";
import type { AgentInvocation } from "../dist/model-client.js";
import { canonicalJson } from "../dist/canonical-json.js";
import {
  ScaPreparationSchema,
  ScaHypothesesSchema,
  ScaSelectionSchema,
  ScaReviewSchema,
  ScaReviewConsistencyError,
  parseScaReview,
  type ScaReview,
} from "../dist/sca/ordinary-contracts.js";
import {
  ScaSemanticDiagnosticSchema,
  ScaStageRejection,
  validateScaStageShape,
} from "../dist/sca/ordinary-semantic.js";
import { ScaReportProductSchema } from "../dist/sca/ordinary-report.js";
import { SCA_AGENT_BY_STATE } from "../dist/playbooks/sca.js";
import {
  environment,
  fixtureAdapters,
  fixtureRuntime,
  identity,
  PROJECT_ROOT,
  roots,
  sourceRoot,
  ScriptedScaClient,
  start,
} from "./helpers/sca-local-workflow.js";
import { createScaOrdinaryHostAdapters } from "../dist/sca/ordinary-host.js";
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
type Mutant =
  | "whitespace"
  | "missing-id"
  | "extra-id"
  | "overlap"
  | "range"
  | "unknown-field"
  | "omitted-file";
class RevisingClient extends ScriptedScaClient {
  private failures = 0;
  constructor(
    readonly mutant: Mutant,
    readonly always = false,
    readonly rejectionCount = 1
  ) {
    super();
  }
  override output(invocation: AgentInvocation): unknown {
    const good = super.output(invocation);
    const state =
      this.mutant === "omitted-file"
        ? "selecting_underdetected_no_alert_surfaces"
        : this.mutant === "range"
          ? "selecting_scanner_dependency_leads"
          : "forming_hypotheses";
    if (invocation.stateId !== state || (!this.always && this.failures++ >= this.rejectionCount))
      return good;
    if (this.mutant === "omitted-file") {
      const v = validateContract(ScaSelectionSchema, good, "Omitted indexed file mutant");
      if (v.deferred.length === 0) throw new Error("Missing indexed source deferrals");
      return { ...v, selections: [], deferred: [] };
    }
    if (this.mutant === "range") {
      const v = validateContract(ScaSelectionSchema, good, "Range mutant");
      const r = v.selections[0]?.ranges[0];
      if (r === undefined) throw new Error("Missing fixture range");
      r.end_line = 999999;
      return v;
    }
    const v = validateContract(ScaHypothesesSchema, good, "Hypothesis mutant");
    const h = v.hypotheses[0],
      p = h?.support[0];
    if (h === undefined || p === undefined) throw new Error("Missing fixture hypothesis");
    if (this.mutant === "whitespace") p.exact_quote += " ";
    if (this.mutant === "missing-id") v.hypotheses.pop();
    if (this.mutant === "extra-id") h.selection_ids.push("foreign-selection");
    if (this.mutant === "overlap")
      v.unformed.push({
        selection_id: h.selection_ids[0] ?? "missing",
        reason: "Overlaps a used ID",
      });
    return this.mutant === "unknown-field"
      ? { ...v, unregistered_secret_key: "must never enter diagnostic" }
      : v;
  }
}
function diagnostic(service: OrchestrationService, ref: ArtifactRef) {
  return validateContract(
    ScaSemanticDiagnosticSchema,
    JSON.parse(service.artifacts.readById(ref.artifact_id).toString("utf8")),
    "Exact diagnostic"
  );
}
const reviewFixture: ScaReview = {
  schema_version: 1,
  report_artifact_id: `art_${"a".repeat(64)}`,
  report_sha256: "b".repeat(64),
  verdict: "PASS",
  checked_evidence_ids: [`art_${"a".repeat(64)}`],
  claim_support: true,
  counterevidence_addressed: true,
  execution_truth: true,
  scoring_semantics: true,
  redaction: true,
  report_quality: true,
  issues: [],
};
const reviewFailures = [
  ["schema", "schema_invalid", "/report_quality"],
  ["consistency", "review_consistency", "/verdict+checks+issues"],
  ["empty-gap", "review_consistency", "/verdict+checks+issues"],
  ["report-id", "input_binding", "/report_artifact_id"],
  ["report-digest", "input_binding", "/report_sha256"],
  ["missing-evidence", "evidence_binding", "/checked_evidence_ids"],
  ["foreign-evidence", "evidence_binding", "/checked_evidence_ids"],
] as const;
type ReviewMutant = (typeof reviewFailures)[number][0];
const rejectedIssue = "Rejected review detail belongs only in the exact captured attempt.";
class ReviewClient extends ScriptedScaClient {
  private visits = 0;
  constructor(
    readonly reviewState: "reviewing_report" | "verifying_final_product",
    readonly mutant: ReviewMutant,
    readonly always = false,
    readonly gapAfterRejection = false
  ) {
    super();
  }
  override output(invocation: AgentInvocation): unknown {
    const good = super.output(invocation);
    if (invocation.stateId !== this.reviewState) return good;
    const review = validateContract(ScaReviewSchema, good, "Review mutation fixture");
    const visit = this.visits++;
    if (visit > 0 && !this.always)
      return this.gapAfterRejection && visit === 1
        ? {
            ...review,
            verdict: "GAP",
            claim_support: false,
            issues: ["Executive summary: clarify the exact source-only scope before acceptance."],
          }
        : review;
    switch (this.mutant) {
      case "schema":
        return { ...review, report_quality: "not-a-boolean" };
      case "consistency":
        return { ...review, execution_truth: false, issues: [rejectedIssue] };
      case "empty-gap":
        return { ...review, verdict: "GAP" };
      case "report-id":
        return { ...review, report_artifact_id: `art_${"0".repeat(64)}` };
      case "report-digest":
        return { ...review, report_sha256: "0".repeat(64) };
      case "missing-evidence": {
        const ref = invocation.inputArtifacts.find((x) => x.kind === "sca-evidence-result");
        if (ref === undefined) throw new Error("Missing required evidence fixture");
        return {
          ...review,
          checked_evidence_ids: review.checked_evidence_ids.filter((id) => id !== ref.artifact_id),
        };
      }
      case "foreign-evidence":
        return {
          ...review,
          checked_evidence_ids: [...review.checked_evidence_ids, `art_${"0".repeat(64)}`],
        };
    }
  }
}
describe("strict ordinary SCA review semantics", () => {
  it.each([
    "claim_support",
    "counterevidence_addressed",
    "execution_truth",
    "scoring_semantics",
    "redaction",
    "report_quality",
  ] as const)("rejects PASS with failed %s without rewriting the review", (field) => {
    const invalid = { ...reviewFixture, [field]: false };
    expect(() => parseScaReview(invalid)).toThrow(ScaReviewConsistencyError);
    try {
      parseScaReview(invalid);
      throw new Error("Inconsistent review was accepted");
    } catch (error) {
      if (!(error instanceof ScaReviewConsistencyError)) throw error;
      expect(error.consistency.failed_checks).toEqual([field]);
      expect(error.consistency.issue_count).toBe(0);
    }
    expect(invalid).toEqual({ ...reviewFixture, [field]: false });
    expect(parseScaReview({ ...invalid, verdict: "GAP" }).verdict).toBe("GAP");
  });
  it("rejects PASS issues and empty all-true GAP, but accepts issues-only GAP and honest PASS", () => {
    expect(() => parseScaReview({ ...reviewFixture, issues: [rejectedIssue] })).toThrow(
      ScaReviewConsistencyError
    );
    expect(() => parseScaReview({ ...reviewFixture, verdict: "GAP" })).toThrow(
      ScaReviewConsistencyError
    );
    expect(
      parseScaReview({ ...reviewFixture, verdict: "GAP", issues: [rejectedIssue] }).verdict
    ).toBe("GAP");
    expect(parseScaReview(reviewFixture)).toEqual(reviewFixture);
  });
  it.each([
    ["extra field", { ...reviewFixture, extra: "unknown field" }],
    ["missing field", { ...reviewFixture, report_quality: undefined }],
    ["invalid type", { ...reviewFixture, issues: "not-an-array" }],
    ["transport field", { ...reviewFixture, confidence: "CERTAIN" }],
  ])("rejects %s as schema failure, not consistency", (_name, invalid) => {
    expect(() => parseScaReview(invalid)).toThrow();
    expect(() => parseScaReview(invalid)).not.toThrow(ScaReviewConsistencyError);
    expect(() => validateScaStageShape(ScaReviewSchema, invalid)).toThrow(ScaStageRejection);
    expect(() => validateScaStageShape(ScaReviewSchema, invalid)).toThrow("schema_invalid");
  });
});
describe.each(["reviewing_report", "verifying_final_product"] as const)(
  "ordinary SCA %s diagnostics",
  (state) => {
    it.each(reviewFailures)(
      "classifies %s rejection as %s at %s, then revalidates a fresh same-stage review",
      async (mutant, code, location) => {
        const env = environment(),
          client = new ReviewClient(state, mutant),
          runId = `review-${state}-${mutant}`;
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          playbookName: "sca",
          modelClient: client,
          hostOperationAdapters: fixtureAdapters(),
        });
        client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
        const terminal = await service.execute(start(runId));
        expect(terminal.action, canonicalJson(terminal)).toBe("complete");
        const visits = client.invocations.filter((x) => x.stateId === state);
        expect(visits).toHaveLength(2);
        const first = visits[0],
          second = visits[1],
          ref = second?.inputArtifacts.find((x) => x.kind === "sca-semantic-diagnostic");
        if (first === undefined || second === undefined || ref === undefined)
          throw new Error("Missing same-stage review diagnostic");
        const d = diagnostic(service, ref);
        expect(d.failure.code).toBe(code);
        expect(d.failure.location).toBe(location);
        expect(d.original_input_refs).toEqual(first.inputArtifacts);
        expect(second.inputArtifacts).toEqual([...first.inputArtifacts, d.rejected_artifact, ref]);
        expect(second.executionPurpose).not.toBe("routing_repair");
        expect(d.rejection_ordinal).toBe(1);
        expect(d.revision_limit).toBeNull();
        expect(canonicalJson(d)).not.toContain(rejectedIssue);
        if (code === "review_consistency") {
          expect(d.failure.review_consistency).toEqual({
            rule: "PASS iff all six checks are true and issues is empty; otherwise GAP. Reassess the exact inputs without suppressing supported defects or forcing PASS.",
            verdict: mutant === "empty-gap" ? "GAP" : "PASS",
            failed_checks: mutant === "empty-gap" ? [] : ["execution_truth"],
            issue_count: mutant === "empty-gap" ? 0 : 1,
          });
          expect(d.failure.expected_ids).toEqual([]);
        } else expect(d.failure.review_consistency).toBeUndefined();
        const report = first.inputArtifacts.find((x) => x.kind === "semantic-core");
        if (report === undefined) throw new Error("Missing exact reviewed report");
        if (mutant === "report-id") expect(d.failure.expected_ids).toEqual([report.artifact_id]);
        if (mutant === "report-digest")
          expect(d.failure.expected_ids).toEqual([report.content_digest]);
        if (code === "evidence_binding") {
          const required = first.inputArtifacts.find((x) => x.kind === "sca-evidence-result");
          if (required === undefined) throw new Error("Missing evidence binding oracle");
          expect(d.failure.expected_ids).toContain(required.artifact_id);
          expect(d.failure.expected_ids).not.toContain(`art_${"0".repeat(64)}`);
        }
        for (const other of Object.keys(SCA_AGENT_BY_STATE).filter((x) => x !== state))
          expect(client.invocations.filter((x) => x.stateId === other)).toHaveLength(1);
        expect(service.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(2);
      }
    );
    it("accepts a fresh genuine GAP into existing report repair, then requires new bindings and both reviews", async () => {
      const env = environment(),
        client = new ReviewClient(state, "consistency", false, true),
        runId = `review-gap-repair-${state}`;
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        playbookName: "sca",
        modelClient: client,
        hostOperationAdapters: fixtureAdapters(),
      });
      client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const terminal = await service.execute(start(runId));
      expect(terminal.action, canonicalJson(terminal)).toBe("complete");
      const visits = client.invocations.filter((x) => x.stateId === state);
      expect(visits).toHaveLength(3);
      const original = visits[0]?.inputArtifacts.find((x) => x.kind === "semantic-core"),
        replacement = visits[2]?.inputArtifacts.find((x) => x.kind === "semantic-core");
      if (original === undefined || replacement === undefined)
        throw new Error("Missing report epochs");
      expect(replacement.artifact_id).not.toBe(original.artifact_id);
      expect(client.invocations.filter((x) => x.stateId === "materializing_report")).toHaveLength(
        2
      );
      expect(client.invocations.slice(-3).map((x) => x.stateId)).toEqual([
        "materializing_report",
        "reviewing_report",
        "verifying_final_product",
      ]);
      const repair = client.invocations.filter((x) => x.stateId === "materializing_report")[1];
      const feedbackRef = repair?.inputArtifacts.find((x) => x.kind === "sca-report-feedback");
      if (feedbackRef === undefined) throw new Error("Missing exact actionable report feedback");
      const feedback = service.artifacts.readById(feedbackRef.artifact_id).toString("utf8");
      expect(feedback).toContain("clarify the exact source-only scope");
      expect(feedback).not.toContain(rejectedIssue);
      expect(feedback).toContain(original.artifact_id);
      expect(service.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(2);
    });
    it("honors explicit policy for persistent inconsistent reviews without report repair, acceptance or recovery replay", async () => {
      const env = { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "3" },
        client = new ReviewClient(state, "consistency", true),
        runId = `review-consistency-exhaustion-${state}`;
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        playbookName: "sca",
        modelClient: client,
        hostOperationAdapters: fixtureAdapters(),
      });
      client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const terminal = await service.execute(start(runId));
      expect(terminal.action).toBe("incomplete");
      expect(client.invocations.filter((x) => x.stateId === state)).toHaveLength(3);
      expect(client.invocations.filter((x) => x.stateId === "materializing_report")).toHaveLength(
        1
      );
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("Missing rejected review run");
      expect(
        context.selectedArtifacts.some((x) => x.kind === `sca-${state.replaceAll("_", "-")}`)
      ).toBe(false);
      expect(context.selectedArtifacts.some((x) => x.kind === "sca-report-feedback")).toBe(false);
      let ref = context.selectedArtifacts.find((x) => x.kind === "sca-semantic-diagnostic");
      const ordinals: number[] = [];
      while (ref !== undefined) {
        const d = diagnostic(service, ref);
        ordinals.push(d.rejection_ordinal);
        expect(d.failure.code).toBe("review_consistency");
        expect(
          service.artifacts.readById(d.rejected_artifact.artifact_id).toString("utf8")
        ).toContain(rejectedIssue);
        ref = d.predecessor_diagnostic ?? undefined;
      }
      expect(ordinals).toEqual([3, 2, 1]);
      const count = client.invocations.length;
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      expect(client.invocations).toHaveLength(count);
      expect(service.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(2);
    });
  }
);
describe("ordinary operator-policy same-stage semantic revisions", () => {
  it.each([null, 8])(
    "uses only actual operator policy %s beyond the former two-revision default",
    async (limit) => {
      const env = {
        ...environment(),
        PENNY_ORCHESTRATION_MAX_ITERATIONS: limit === null ? undefined : String(limit),
        PENNY_ORCHESTRATION_MAX_STEPS: undefined,
      };
      const client = new RevisingClient("whitespace", limit !== null, 5);
      const runId = `operator-revisions-${limit ?? "unspecified"}`;
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        playbookName: "sca",
        modelClient: client,
        hostOperationAdapters: fixtureAdapters(),
      });
      client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const terminal = await service.execute(start(runId));
      expect(terminal.action).toBe(limit === null ? "complete" : "incomplete");
      expect(client.invocations.filter((x) => x.stateId === "forming_hypotheses")).toHaveLength(
        limit === null ? 6 : limit
      );
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("Missing operator-policy run");
      expect(context.maxIterations).toBe(limit);
      const ref = context.selectedArtifacts.find((x) => x.kind === "sca-semantic-diagnostic");
      if (ref === undefined) throw new Error("Missing actual repair-policy diagnostic");
      const d = diagnostic(service, ref);
      expect(d.rejection_ordinal).toBe(limit === null ? 5 : limit);
      expect(d.revision_limit).toBe(limit === null ? null : limit - 1);
      expect(context.iteration).toBe(limit === null ? 5 : limit - 1);
      expect(service.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(
        limit === null ? 2 : 1
      );
      const count = client.invocations.length;
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      expect(client.invocations).toHaveLength(count);
    }
  );
  it.each<Mutant>([
    "whitespace",
    "missing-id",
    "extra-id",
    "overlap",
    "range",
    "unknown-field",
    "omitted-file",
  ])(
    "rejects %s exactly, then accepts a fresh complete good stage without rerunning stable work",
    async (mutant) => {
      const env = environment(),
        client = new RevisingClient(mutant),
        runId = `semantic-${mutant}`;
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        playbookName: "sca",
        modelClient: client,
        hostOperationAdapters: fixtureAdapters(),
      });
      client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const terminal = await service.execute(start(runId));
      expect(terminal.action, canonicalJson(terminal)).toBe("complete");
      const state =
        mutant === "omitted-file"
          ? "selecting_underdetected_no_alert_surfaces"
          : mutant === "range"
            ? "selecting_scanner_dependency_leads"
            : "forming_hypotheses";
      const visits = client.invocations.filter((x) => x.stateId === state);
      expect(visits).toHaveLength(2);
      const first = visits[0],
        second = visits[1];
      if (first === undefined || second === undefined)
        throw new Error("Missing revision invocations");
      const ref = second.inputArtifacts.find((x) => x.kind === "sca-semantic-diagnostic");
      if (ref === undefined) throw new Error("Missing exact diagnostic input");
      const d = diagnostic(service, ref);
      expect(d.rejection_ordinal).toBe(1);
      expect(d.revision_limit).toBeNull();
      expect(d.original_input_refs).toEqual(first.inputArtifacts);
      expect(second.inputArtifacts).toEqual([...first.inputArtifacts, d.rejected_artifact, ref]);
      expect(second.executionPurpose).not.toBe("routing_repair");
      expect(second.modelOverride).toBe(first.modelOverride);
      expect(second.task).toContain("SAME-STAGE semantic revision");
      expect(service.artifacts.readById(d.rejected_artifact.artifact_id).length).toBeGreaterThan(0);
      if (mutant === "whitespace") {
        expect(d.failure.code).toBe("citation_quote");
        expect(d.failure.location).toBe("/hypotheses/0/support/0");
        expect(d.failure.expected_pointer?.exact_quote.endsWith(" ")).toBe(false);
      }
      if (mutant === "missing-id") expect(d.failure.expected_ids).toEqual(["selection-1"]);
      if (mutant === "omitted-file") {
        expect(d.failure.code).toBe("id_accounting");
        expect(d.failure.location).toBe("/selections/ranges/path+deferred");
        expect(d.failure.expected_ids).toEqual([
          "src/handler.php",
          "src/handler.ts",
          "src/safe.ts",
          "src/unrelated.ts",
        ]);
        const calls = service.checkpointer.hostOperationCallsForRun(runId);
        expect(calls.filter((x) => x.operation_kind === "sca.preparation.v1")).toHaveLength(1);
        expect(calls.filter((x) => x.operation_kind === "sca.evidence.v1")).toHaveLength(1);
      }
      if (mutant === "unknown-field")
        expect(canonicalJson(d)).not.toContain("unregistered_secret_key");
      for (const other of Object.keys(SCA_AGENT_BY_STATE).filter((x) => x !== state))
        expect(client.invocations.filter((x) => x.stateId === other)).toHaveLength(1);
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("Missing run");
      const product = context.selectedArtifacts.find((x) => x.kind === "semantic-core");
      if (product === undefined) throw new Error("Missing report");
      const report = validateContract(
        ScaReportProductSchema,
        JSON.parse(service.artifacts.readById(product.artifact_id).toString("utf8")),
        "Report"
      );
      expect(report.hypotheses.hypotheses).toHaveLength(2);
      expect(report.findings).toHaveLength(2);
      expect(
        report.evidence_refs.some(
          (x) => x.kind === "sca-semantic-diagnostic" || x.kind === "agent-output"
        )
      ).toBe(false);
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      expect(client.invocations.filter((x) => x.stateId === state)).toHaveLength(2);
    }
  );
  it.each([
    ["selecting_underdetected_no_alert_surfaces", "unregistered_field"],
    ["challenging_hypotheses", "challenges"],
    ["selecting_evidence_actions", "actions"],
    ["adjudicating_evidence", "dispositions"],
    ["assessing_learning", "outcomes"],
    ["materializing_report", "findings"],
    ["reviewing_report", "report_artifact_id"],
    ["verifying_final_product", "report_artifact_id"],
  ] as const)(
    "revalidates %s through the same registered revision route before accepting any product",
    async (state, field) => {
      class Once extends ScriptedScaClient {
        private rejected = false;
        override output(invocation: AgentInvocation): unknown {
          const good = super.output(invocation);
          if (invocation.stateId !== state || this.rejected) return good;
          this.rejected = true;
          if (good === null || typeof good !== "object" || Array.isArray(good))
            throw new Error("Missing object fixture");
          return {
            ...good,
            [field]: field === "report_artifact_id" ? `art_${"0".repeat(64)}` : [],
          };
        }
      }
      const client = new Once(),
        runId = `semantic-${state}`,
        env = environment();
      let preparations = 0,
        gathers = 0;
      const native = fixtureRuntime();
      const adapters = createScaOrdinaryHostAdapters({
        prepare(input) {
          preparations++;
          return native.prepare(input);
        },
        gather(input) {
          gathers++;
          return native.gather(input);
        },
      });
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        playbookName: "sca",
        modelClient: client,
        hostOperationAdapters: adapters,
      });
      client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const terminal = await service.execute(start(runId));
      expect(terminal.action, canonicalJson(terminal)).toBe("complete");
      const visits = client.invocations.filter((x) => x.stateId === state);
      expect(visits).toHaveLength(2);
      const first = visits[0],
        second = visits[1],
        ref = second?.inputArtifacts.find((x) => x.kind === "sca-semantic-diagnostic");
      if (first === undefined || second === undefined || ref === undefined)
        throw new Error("Missing exact revised stage");
      const d = diagnostic(service, ref);
      expect(d.original_input_refs).toEqual(first.inputArtifacts);
      expect(second.inputArtifacts).toEqual([...first.inputArtifacts, d.rejected_artifact, ref]);
      expect(preparations).toBe(1);
      expect(gathers).toBe(1);
      for (const other of Object.keys(SCA_AGENT_BY_STATE).filter((x) => x !== state))
        expect(client.invocations.filter((x) => x.stateId === other)).toHaveLength(1);
    }
  );
  it("keeps every indexed file for an oversized corpus and honors explicit exhaustion rather than truncating deferrals", async () => {
    const env = { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "3" },
      client = new ScriptedScaClient(),
      runId = "oversize-no-alert";
    for (let i = 0; i < 600; i++)
      writeFileSync(path.join(sourceRoot, "src", `indexed-${i}.ts`), "export const bounded = 1;\n");
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "sca",
      modelClient: client,
      hostOperationAdapters: fixtureAdapters(),
    });
    client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
    const terminal = await service.execute(start(runId));
    expect(terminal.action).toBe("incomplete");
    const refs = service.checkpointer.loadRunById(runId)?.selectedArtifacts;
    if (refs === undefined) throw new Error("Missing oversized run");
    const prepRef = refs.find((x) => x.kind === "sca-preparation-result");
    if (prepRef === undefined) throw new Error("Missing complete file index");
    const prep = validateContract(
      ScaPreparationSchema,
      JSON.parse(service.artifacts.readById(prepRef.artifact_id).toString("utf8")),
      "Complete oversized index"
    );
    expect(prep.files).toHaveLength(604);
    expect(new Set(prep.files.map((x) => x.path)).size).toBe(604);
    expect(refs.some((x) => x.kind === "sca-selecting-underdetected-no-alert-surfaces")).toBe(
      false
    );
    expect(
      client.invocations.filter((x) => x.stateId === "selecting_underdetected_no_alert_surfaces")
    ).toHaveLength(3);
    const diagnosticRef = refs.find((x) => x.kind === "sca-semantic-diagnostic");
    if (diagnosticRef === undefined) throw new Error("Missing bounded exhaustion evidence");
    const d = diagnostic(service, diagnosticRef);
    expect(d.rejection_ordinal).toBe(3);
    expect(d.original_input_refs).toContainEqual(prepRef);
    expect(service.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(1);
    const invocations = client.invocations.length;
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(terminal);
    expect(client.invocations).toHaveLength(invocations);
  });
  it("honors an explicit two-revision policy, retains invalid attempts and never replays external work on recovery", async () => {
    const env = { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "3" },
      client = new RevisingClient("whitespace", true),
      runId = "semantic-exhaustion";
    let preparations = 0,
      gathers = 0;
    const native = fixtureRuntime();
    const adapters = createScaOrdinaryHostAdapters({
      prepare(input) {
        preparations++;
        return native.prepare(input);
      },
      gather(input) {
        gathers++;
        return native.gather(input);
      },
    });
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "sca",
      modelClient: client,
      hostOperationAdapters: adapters,
    });
    client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
    const terminal = await service.execute(start(runId));
    expect(terminal.action).toBe("incomplete");
    expect(preparations).toBe(1);
    expect(gathers).toBe(0);
    expect(client.invocations.filter((x) => x.stateId === "forming_hypotheses")).toHaveLength(3);
    const selected = service.checkpointer.loadRunById(runId)?.selectedArtifacts ?? [];
    let ref = selected.find((x) => x.kind === "sca-semantic-diagnostic");
    const ordinals: number[] = [];
    while (ref !== undefined) {
      const d = diagnostic(service, ref);
      ordinals.push(d.rejection_ordinal);
      expect(
        service.artifacts.readById(d.rejected_artifact.artifact_id).toString("utf8")
      ).toContain("SUMMARY:");
      ref = d.predecessor_diagnostic ?? undefined;
    }
    expect(ordinals).toEqual([3, 2, 1]);
    expect(selected.some((x) => x.kind === "sca-forming-hypotheses")).toBe(false);
    expect(selected.some((x) => x.kind === "sca-selecting-scanner-dependency-leads")).toBe(true);
    expect(selected.some((x) => x.kind === "sca-selecting-underdetected-no-alert-surfaces")).toBe(
      true
    );
    expect(canonicalJson(terminal)).toContain("Operator semantic repair allowance exhausted");
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(terminal);
    expect(preparations).toBe(1);
    expect(gathers).toBe(0);
  });
});
