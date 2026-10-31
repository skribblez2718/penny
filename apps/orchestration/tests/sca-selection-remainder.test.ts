/** Real registered engine/custody with offline scripted cognition and preparation only. */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { OrchestrationService } from "../dist/service.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateContract, type ArtifactRef } from "../dist/contracts.js";
import type { AgentInvocation } from "../dist/model-client.js";
import { SCA_PLAYBOOK_REGISTRATION } from "../dist/playbooks/sca.js";
import {
  ScaPreparationSchema,
  ScaSelectionSchema,
  ScaSelectionDraftSchema,
  parseScaReview,
  type ScaSelectionDraft,
} from "../dist/sca/ordinary-contracts.js";
import {
  materializeScaSelectionDraft,
  ScaSemanticDiagnosticSchema,
} from "../dist/sca/ordinary-semantic.js";
import { ScaReportProductSchema } from "../dist/sca/ordinary-report.js";
import { ScaOutputManifestSchema } from "../dist/sca/ordinary-terminal.js";
import { createScaOrdinaryHostAdapters } from "../dist/sca/ordinary-host.js";
import {
  environment,
  fixtureRuntime,
  identity,
  PROJECT_ROOT,
  pointer,
  roots,
  sourceRoot,
  ScriptedScaClient,
  start,
} from "./helpers/sca-local-workflow.js";

const scanner = "selecting_scanner_dependency_leads";
const files = "selecting_underdetected_no_alert_surfaces";
const kind = (state: string) => `sca-${state.replaceAll("_", "-")}`;
const sharedReason = "Deferred for bounded follow-up, not a safety conclusion.  Exact reason: α.";
const specialReason = "A different explicit deferral reason.";
const adapters = () => {
  const native = fixtureRuntime();
  return createScaOrdinaryHostAdapters({
    async prepare(input) {
      const result = await native.prepare(input);
      const original = result.preparation.leads;
      result.preparation.leads = Array.from({ length: 512 }, (_, i) => {
        const lead = original[i % original.length];
        if (lead === undefined) throw new Error("Missing scanner fixture lead");
        return {
          ...lead,
          id: `lead:${sha256(`selection-fixture-${i}`)}`,
          origin: i % 2 === 0 ? "semgrep" : "dependency",
        };
      });
      return result;
    },
    gather: (input) => native.gather(input),
  });
};
type Mutate = (draft: ScaSelectionDraft, invocation: AgentInvocation) => unknown;
class CompactClient extends ScriptedScaClient {
  readonly drafts = new Map<string, ScaSelectionDraft>();
  readonly raw = new Map<string, string>();
  private readExact: ((id: string) => string) | undefined;
  constructor(
    readonly allLeadsDeferred = false,
    readonly mutate?: Mutate
  ) {
    super(allLeadsDeferred ? "noalert" : "confirmed");
  }
  override bindArtifactReader(reader: (id: string) => string): void {
    super.bindArtifactReader(reader);
    this.readExact = reader;
  }
  override async runAgent(invocation: AgentInvocation) {
    const completion = await super.runAgent(invocation);
    const draft = this.drafts.get(invocation.stateId);
    if (draft === undefined) return completion;
    const text = `${canonicalJson(draft)}\nSUMMARY:${canonicalJson({ ...draft, confidence: "PROBABLE" })}`;
    this.raw.set(invocation.stateId, text);
    return { text };
  }
  override output(invocation: AgentInvocation): unknown {
    const state = invocation.stateId;
    if (state !== scanner && state !== files) return super.output(invocation);
    const prepRef = invocation.inputArtifacts.find((ref) => ref.kind === "sca-preparation-result");
    if (prepRef === undefined || this.readExact === undefined)
      throw new Error("Missing exact preparation");
    const preparation = validateContract(
      ScaPreparationSchema,
      JSON.parse(this.readExact(prepRef.artifact_id)),
      "Complete fixture preparation"
    );
    const selected =
      state === scanner
        ? this.allLeadsDeferred
          ? []
          : preparation.leads.slice(0, 2).map((lead, i) => ({
              id: `selection-${i}`,
              lead_ids: [lead.id],
              rationale: "Inspect the exact synthetic source flow, not an exploitability claim.",
              ranges: lead.locations,
            }))
        : this.allLeadsDeferred
          ? (["src/handler.ts", "src/handler.php"] as const).map((name, i) => {
              const p = pointer(name);
              return {
                id: `noalert-${i}`,
                lead_ids: [],
                rationale: "Inspect a surface despite scanner silence.",
                ranges: [{ path: p.path, start_line: p.start_line, end_line: p.end_line }],
              };
            })
          : [];
    const covered = new Set(
      state === scanner
        ? selected.flatMap((s) => s.lead_ids)
        : selected.flatMap((s) => s.ranges.map((r) => r.path))
    );
    const expected =
      state === scanner
        ? preparation.leads.map((lead) => lead.id)
        : preparation.files.map((file) => file.path);
    const special = expected.find((id) => !covered.has(id));
    const draft: ScaSelectionDraft = {
      schema_version: 1,
      selections: selected,
      deferred: special === undefined ? [] : [{ id: special, reason: specialReason }],
      gaps: [],
      defer_remainder: {
        preparation_artifact_id: prepRef.artifact_id,
        preparation_sha256: prepRef.content_digest,
        scope: state === scanner ? "leads" : "files",
        reason: sharedReason,
      },
    };
    const value = this.mutate === undefined ? draft : this.mutate(draft, invocation);
    // Keep malformed mutant bytes exact too; no fixture-side repair/normalization.
    if (Value.Check(ScaSelectionDraftSchema, value)) this.drafts.set(state, value);
    else this.drafts.delete(state);
    return value;
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function exactJson(service: OrchestrationService, ref: ArtifactRef): unknown {
  const bytes = service.artifacts.readById(ref.artifact_id);
  expect(bytes.length).toBe(ref.byte_length);
  expect(sha256(bytes)).toBe(ref.content_digest);
  return JSON.parse(bytes.toString("utf8"));
}
function requiredRef(refs: readonly ArtifactRef[], artifactKind: string): ArtifactRef {
  const ref = refs.find((entry) => entry.kind === artifactKind);
  if (ref === undefined) throw new Error(`Missing exact ${artifactKind}`);
  return ref;
}

describe("explicit preparation-bound selection draft remainder", () => {
  it.each([false, true])(
    "retains exhaustive canonical records at 512 hashed leads and 512 files (all leads deferred=%s)",
    async (allLeadsDeferred) => {
      const env = environment();
      // This is an isolated synthetic source fixture, never an operator target tree.
      for (let i = 4; i < 512; i++)
        writeFileSync(path.join(sourceRoot, "src", `indexed-${i}.ts`), "export const item = 1;\n");
      const client = new CompactClient(allLeadsDeferred, (draft, invocation) => {
        draft.gaps = [
          `Original ${invocation.stateId} gap; exact Unicode λ and spacing.  Not resolved.`,
        ];
        if (invocation.stateId === files) {
          const selection = draft.selections[0];
          const range = selection?.ranges[0];
          if (selection !== undefined && range !== undefined)
            selection.ranges.push({ ...range, end_line: range.start_line });
        }
        return draft;
      });
      const runId = `compact-512-${allLeadsDeferred}`;
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        playbookName: "sca",
        modelClient: client,
        hostOperationAdapters: adapters(),
      });
      client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const terminal = await service.execute(start(runId));
      // Deferred candidates remain unresolved; compact syntax cannot upgrade assessment truth.
      expect(terminal.action, canonicalJson(terminal)).toBe("incomplete");
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("Missing real engine run");
      const prepRef = requiredRef(context.selectedArtifacts, "sca-preparation-result");
      const preparation = validateContract(
        ScaPreparationSchema,
        exactJson(service, prepRef),
        "Prep"
      );
      expect(preparation.leads).toHaveLength(512);
      expect(preparation.files).toHaveLength(512);
      expect(preparation.leads.every((lead) => /^lead:[a-f0-9]{64}$/u.test(lead.id))).toBe(true);
      const report = validateContract(
        ScaReportProductSchema,
        exactJson(service, requiredRef(context.selectedArtifacts, "semantic-core")),
        "Unchanged canonical report"
      );
      expect(report.preparation).toEqual(preparation);
      expect(report.status).toBe("INCOMPLETE");
      if (terminal.action !== "incomplete") throw new Error("Missing honest negative terminal");
      expect(terminal.met).toBe(false);
      expect(context.previousState).toBe("verifying_final_product");
      expect(context.stateId).toBe("incomplete");
      const reportRef = requiredRef(context.selectedArtifacts, "semantic-core");
      const manifestRef = requiredRef(terminal.artifacts, "sca-output-manifest");
      const manifest = validateContract(
        ScaOutputManifestSchema,
        exactJson(service, manifestRef),
        "Complete exact terminal manifest"
      );
      expect(manifest.status).toBe("incomplete");
      expect(manifest.unresolved).toEqual(report.gaps);
      expect(terminal.unresolved).toEqual([
        `${report.gaps.length} unresolved SCA diagnostics retained exactly at ${reportRef.artifact_id} (SHA-256 ${reportRef.content_digest}), JSON /gaps. Read with artifact_read through next_range until complete.`,
      ]);
      expect(terminal.result.output_artifact_ref).toEqual(reportRef);
      expect(terminal.result.output_manifest_ref).toEqual(manifestRef);
      expect(terminal.artifacts).toEqual([...manifest.outputs, manifestRef]);
      expect(service.artifacts.metadata(manifestRef).upstream_refs).toEqual(manifest.outputs);
      const products = context.selectedArtifacts.filter((ref) =>
        [
          "semantic-core",
          "sca-report-markdown",
          "sca-report-sarif",
          "sca-report-validation",
          kind("reviewing_report"),
          kind("verifying_final_product"),
        ].includes(ref.kind)
      );
      expect(products).toHaveLength(6);
      expect(terminal.result.best_partial_artifact_refs).toEqual(products);
      for (const ref of products) {
        expect(manifest.outputs).toContainEqual(ref);
        expect(terminal.artifacts).toContainEqual(ref);
        expect(service.artifacts.readById(ref.artifact_id)).toHaveLength(ref.byte_length);
      }
      for (const state of ["reviewing_report", "verifying_final_product"]) {
        const ref = requiredRef(products, kind(state));
        const review = parseScaReview(exactJson(service, ref));
        expect(review.verdict).toBe("PASS");
        expect(review.report_artifact_id).toBe(reportRef.artifact_id);
        expect(review.report_sha256).toBe(reportRef.content_digest);
        const invocation = client.invocations.find((visit) => visit.stateId === state);
        if (invocation === undefined) throw new Error("Missing independent review visit");
        expect(invocation.agent).toBe(state === "reviewing_report" ? "carren" : "vera");
        expect(invocation.inputArtifacts).toContainEqual(reportRef);
        expect(client.invocations.filter((visit) => visit.stateId === state)).toHaveLength(1);
      }
      expect(canonicalJson({ terminal, report, manifest })).not.toMatch(
        /Rejected incomplete stage|Terminal partial annotation|fresh final semantic approval|terminal partial annotation/iu
      );
      expect(report.candidates).toHaveLength(512);
      expect(report.candidates.map((candidate) => candidate.id)).toEqual(
        preparation.leads.map((lead) => lead.id)
      );
      const scannerSelection = report.selections[0];
      if (scannerSelection === undefined) throw new Error("Missing report scanner accounting");
      const deferredNotes = new Map(
        scannerSelection.deferred.map((entry) => [entry.id, entry.reason])
      );
      expect(report.gaps.filter((gap) => gap.includes(": deferred candidate — "))).toEqual(
        preparation.leads.flatMap((lead) => {
          const reason = deferredNotes.get(lead.id);
          return reason === undefined ? [] : [`${lead.id}: deferred candidate — ${reason}`];
        })
      );
      for (const state of [scanner, files])
        expect(report.gaps).toContain(
          `Recorded at ${state}: Original ${state} gap; exact Unicode λ and spacing.  Not resolved.`
        );
      for (const candidate of report.candidates) {
        const reason = deferredNotes.get(candidate.id);
        expect(candidate.decision).toBe(reason === undefined ? "selected" : "deferred");
        if (reason !== undefined) expect(candidate.note).toBe(reason);
      }
      const alternateRefs = ["foreign-preparation-run", runId].map((alternateRun) =>
        service.artifacts.persist({
          metadata: {
            ...service.artifacts.metadata(prepRef),
            run_id: alternateRun,
            operation_id: alternateRun === runId ? prepRef.operation_id : "foreign-preparation",
            version: alternateRun === runId ? prepRef.version + 1 : 1,
            parent_ref: alternateRun === runId ? prepRef : null,
            upstream_refs: [prepRef],
          },
          content: service.artifacts.readById(prepRef.artifact_id),
        })
      );
      for (const alternate of alternateRefs) {
        expect(alternate.artifact_id).not.toBe(prepRef.artifact_id);
        expect(alternate.content_digest).toBe(prepRef.content_digest);
      }
      for (const [index, state] of ([scanner, files] as const).entries()) {
        const ref = requiredRef(context.selectedArtifacts, kind(state));
        const canonical = validateContract(
          ScaSelectionSchema,
          exactJson(service, ref),
          "Selection"
        );
        const draft = client.drafts.get(state);
        const raw = client.raw.get(state);
        const invocation = client.invocations.find((visit) => visit.stateId === state);
        if (draft === undefined || raw === undefined || invocation === undefined)
          throw new Error("Missing exact draft/capture oracle");
        expect(Buffer.byteLength(raw)).toBeLessThan(4000);
        expect(draft.deferred).toHaveLength(1);
        expect(Value.Check(ScaSelectionSchema, draft)).toBe(false);
        if (SCA_PLAYBOOK_REGISTRATION.worker.kind !== "catalog-agent")
          throw new Error("Missing catalog selection registration");
        const phase = SCA_PLAYBOOK_REGISTRATION.worker.phases.get(state);
        if (phase === undefined) throw new Error("Missing registered selection schema");
        expect(Value.Check(phase.schema, draft)).toBe(true);
        const expected =
          state === scanner
            ? preparation.leads.map((lead) => lead.id)
            : preparation.files.map((file) => file.path);
        const selectedIds =
          state === scanner
            ? canonical.selections.flatMap((s) => s.lead_ids)
            : [...new Set(canonical.selections.flatMap((s) => s.ranges.map((r) => r.path)))];
        const explicit = new Set([...selectedIds, ...draft.deferred.map((entry) => entry.id)]);
        expect(canonical.selections).toEqual(draft.selections);
        expect(canonical.gaps).toEqual(draft.gaps);
        expect(canonical.deferred).toEqual([
          ...draft.deferred,
          ...expected.filter((id) => !explicit.has(id)).map((id) => ({ id, reason: sharedReason })),
        ]);
        expect(canonical.deferred).toHaveLength(512 - selectedIds.length);
        expect([...selectedIds, ...canonical.deferred.map((entry) => entry.id)].sort()).toEqual(
          [...expected].sort()
        );
        expect(report.selections[index]).toEqual(canonical);
        expect(canonical).not.toHaveProperty("defer_remainder");
        const upstream = service.artifacts.metadata(ref).upstream_refs;
        expect(upstream).toContainEqual(prepRef);
        const worker = requiredRef(upstream, "agent-output");
        expect(service.artifacts.readById(worker.artifact_id).toString("utf8")).toBe(raw);
        expect(service.artifacts.metadata(worker).upstream_refs).toEqual(invocation.inputArtifacts);
        const before = canonicalJson({ draft, preparation });
        const input = { state, value: draft, preparation, preparationRef: prepRef };
        expect(materializeScaSelectionDraft(input)).toEqual(canonical);
        expect(materializeScaSelectionDraft(input)).toEqual(canonical);
        expect(canonicalJson({ draft, preparation })).toBe(before);
        for (const alternate of alternateRefs) {
          const declaration = draft.defer_remainder;
          if (declaration === undefined) throw new Error("Missing explicit declaration");
          // Identical bytes in another run/revision still cannot replace the current identity.
          const foreignDraft = {
            ...draft,
            defer_remainder: { ...declaration, preparation_artifact_id: alternate.artifact_id },
          };
          expect(() => materializeScaSelectionDraft({ ...input, value: foreignDraft })).toThrow(
            "input_binding"
          );
          expect(() =>
            materializeScaSelectionDraft({ ...input, preparationRef: alternate })
          ).toThrow("input_binding");
        }
        expect(client.invocations.filter((visit) => visit.stateId === state)).toHaveLength(1);
      }
      expect(service.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(2);
      const visits = client.invocations.length;
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      expect(client.invocations).toHaveLength(visits);
    }
  );

  const mutants = [
    "foreign-id",
    "wrong-digest",
    "snapshot-digest",
    "wrong-scope",
    "missing-binding",
    "null-declaration",
    "extra-field",
    "extra-id",
    "omitted-without-declaration",
    "duplicate-deferred",
    "duplicate-selection",
    "duplicate-lead",
    "foreign-lead",
    "overlap",
    "range",
  ] as const;
  describe.each([scanner, files])("%s draft refusal", (state) => {
    it.each(mutants)("refuses %s before canonical persistence", async (mutant) => {
      const env = { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "1" };
      const client = new CompactClient(false, (draft, invocation) => {
        if (invocation.stateId !== state) return draft;
        const declaration = draft.defer_remainder;
        if (declaration === undefined) throw new Error("Missing mutation declaration");
        switch (mutant) {
          case "foreign-id":
            declaration.preparation_artifact_id = `art_${"0".repeat(64)}`;
            break;
          case "wrong-digest":
            declaration.preparation_sha256 = "0".repeat(64);
            break;
          case "snapshot-digest": {
            const prepRef = requiredRef(invocation.inputArtifacts, "sca-preparation-result");
            const prep = validateContract(
              ScaPreparationSchema,
              exactJson(service, prepRef),
              "Prep mutant"
            );
            declaration.preparation_sha256 = prep.source_snapshot_sha256;
            break;
          }
          case "wrong-scope":
            declaration.scope = state === scanner ? "files" : "leads";
            break;
          case "missing-binding":
            return {
              ...draft,
              defer_remainder: { scope: declaration.scope, reason: sharedReason },
            };
          case "null-declaration":
            return { ...draft, defer_remainder: null };
          case "extra-field":
            return { ...draft, defer_remainder: { ...declaration, except: [] } };
          case "extra-id":
            draft.deferred.push({ id: "foreign", reason: specialReason });
            break;
          case "omitted-without-declaration":
            delete draft.defer_remainder;
            break;
          case "duplicate-deferred":
            draft.deferred.push(...draft.deferred);
            break;
          case "duplicate-selection": {
            const selection = draft.selections[0];
            if (selection === undefined) {
              const entry = {
                id: "duplicate",
                lead_ids: [],
                rationale: "Inspect",
                ranges: [{ path: "src/handler.ts", start_line: 1, end_line: 3 }],
              };
              draft.selections.push(entry, entry);
              draft.deferred = draft.deferred.filter((d) => d.id !== "src/handler.ts");
            } else draft.selections.push({ ...selection, lead_ids: [] });
            break;
          }
          case "duplicate-lead":
          case "foreign-lead": {
            const lead =
              invocation.stateId === scanner ? draft.selections[0]?.lead_ids[0] : "foreign-lead";
            if (lead === undefined) throw new Error("Missing lead oracle");
            draft.selections.push({
              id: "extra-lead-claim",
              lead_ids: mutant === "duplicate-lead" ? [lead, lead] : ["foreign-lead"],
              rationale: "Inspect",
              ranges: [{ path: "src/handler.ts", start_line: 1, end_line: 3 }],
            });
            break;
          }
          case "overlap": {
            const id = state === scanner ? draft.selections[0]?.lead_ids[0] : "src/handler.ts";
            if (id === undefined) throw new Error("Missing overlap oracle");
            if (state === files)
              draft.selections.push({
                id: "new-file-selection",
                lead_ids: [],
                rationale: "Inspect",
                ranges: [{ path: id, start_line: 1, end_line: 3 }],
              });
            draft.deferred.push({ id, reason: specialReason });
            break;
          }
          case "range":
            draft.selections.push({
              id: "invalid-range",
              lead_ids: [],
              rationale: "Inspect",
              ranges: [{ path: "src/handler.ts", start_line: 1, end_line: 999999 }],
            });
            break;
        }
        return draft;
      });
      const runId = `reject-${state}-${mutant}`;
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        playbookName: "sca",
        modelClient: client,
        hostOperationAdapters: adapters(),
      });
      client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const terminal = await service.execute(start(runId));
      expect(terminal.action, `${mutant}: ${canonicalJson(terminal)}`).toBe("incomplete");
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("Missing refusal run");
      expect(
        context.selectedArtifacts.some((ref) => ref.kind === kind(state)),
        mutant
      ).toBe(false);
      const diagnostic = validateContract(
        ScaSemanticDiagnosticSchema,
        exactJson(service, requiredRef(context.selectedArtifacts, "sca-semantic-diagnostic")),
        "Refusal"
      );
      expect(diagnostic.state).toBe(state);
      expect(diagnostic.failure.code).toBe(
        ["foreign-id", "wrong-digest", "snapshot-digest", "wrong-scope"].includes(mutant)
          ? "input_binding"
          : ["missing-binding", "null-declaration", "extra-field"].includes(mutant)
            ? "schema_invalid"
            : mutant === "range"
              ? "citation_range"
              : "id_accounting"
      );
      expect(diagnostic.original_input_refs).toContainEqual(
        requiredRef(context.selectedArtifacts, "sca-preparation-result")
      );
      expect(
        service.artifacts.readById(diagnostic.rejected_artifact.artifact_id).toString("utf8")
      ).toContain("SUMMARY:");
      expect(client.invocations.filter((visit) => visit.stateId === state)).toHaveLength(1);
      expect(service.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(1);
    });
  });

  it.each([scanner, files])(
    "revalidates a fresh compact %s draft without replaying preparation",
    async (state) => {
      const env = { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "2" };
      let rejected = false;
      const client = new CompactClient(true, (draft, invocation) => {
        if (invocation.stateId !== state || rejected) return draft;
        rejected = true;
        const declaration = draft.defer_remainder;
        if (declaration === undefined) throw new Error("Missing revision binding");
        declaration.preparation_artifact_id = `art_${"0".repeat(64)}`;
        return draft;
      });
      const runId = `compact-revision-${state}`;
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        playbookName: "sca",
        modelClient: client,
        hostOperationAdapters: createScaOrdinaryHostAdapters(fixtureRuntime()),
      });
      client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
      const terminal = await service.execute(start(runId));
      expect(terminal.action, canonicalJson(terminal)).toBe("incomplete");
      const visits = client.invocations.filter((visit) => visit.stateId === state);
      expect(visits).toHaveLength(2);
      const first = visits[0],
        second = visits[1];
      if (first === undefined || second === undefined)
        throw new Error("Missing revised invocation");
      const diagnostic = validateContract(
        ScaSemanticDiagnosticSchema,
        exactJson(service, requiredRef(second.inputArtifacts, "sca-semantic-diagnostic")),
        "Revision diagnostic"
      );
      expect(diagnostic.failure.code).toBe("input_binding");
      expect(diagnostic.original_input_refs).toEqual(first.inputArtifacts);
      expect(second.inputArtifacts).toEqual([
        ...first.inputArtifacts,
        diagnostic.rejected_artifact,
        requiredRef(second.inputArtifacts, "sca-semantic-diagnostic"),
      ]);
      expect(second.task).toContain("SAME-STAGE");
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("Missing revised run");
      const canonical = validateContract(
        ScaSelectionSchema,
        exactJson(service, requiredRef(context.selectedArtifacts, kind(state))),
        "Revised canonical selection"
      );
      expect(canonical.deferred).toHaveLength(2);
      expect(canonical.deferred.map((entry) => entry.reason)).toEqual([
        specialReason,
        sharedReason,
      ]);
      expect(
        service.artifacts.readById(diagnostic.rejected_artifact.artifact_id).toString("utf8")
      ).toContain(`art_${"0".repeat(64)}`);
      expect(service.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(2);
    }
  );

  it("rejects an expanded file remainder beyond canonical capacity without dropping indexed files", async () => {
    const env = { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "1" };
    for (let i = 4; i < 513; i++)
      writeFileSync(path.join(sourceRoot, "src", `indexed-${i}.ts`), "export const item = 1;\n");
    const client = new CompactClient();
    const runId = "expanded-file-capacity";
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "sca",
      modelClient: client,
      hostOperationAdapters: adapters(),
    });
    client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
    const terminal = await service.execute(start(runId));
    expect(terminal.action).toBe("incomplete");
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("Missing oversized draft run");
    const prep = validateContract(
      ScaPreparationSchema,
      exactJson(service, requiredRef(context.selectedArtifacts, "sca-preparation-result")),
      "Complete oversized preparation"
    );
    expect(prep.files).toHaveLength(513);
    expect(prep.leads).toHaveLength(512);
    expect(context.selectedArtifacts.some((ref) => ref.kind === kind(files))).toBe(false);
    const diagnostic = validateContract(
      ScaSemanticDiagnosticSchema,
      exactJson(service, requiredRef(context.selectedArtifacts, "sca-semantic-diagnostic")),
      "Capacity refusal"
    );
    expect(diagnostic.failure.code).toBe("schema_invalid");
    expect(diagnostic.failure.location).toBe("/deferred");
    const raw = client.raw.get(files);
    if (raw === undefined) throw new Error("Missing compact oversized draft");
    expect(Buffer.byteLength(raw)).toBeLessThan(4000);
    expect(client.invocations.some((visit) => visit.stateId === "forming_hypotheses")).toBe(false);
    expect(service.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(1);
  });

  it("keeps old per-ID worker drafts compatible through the real engine", async () => {
    const env = environment();
    const client = new ScriptedScaClient();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "sca",
      modelClient: client,
      hostOperationAdapters: createScaOrdinaryHostAdapters(fixtureRuntime()),
    });
    client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
    const terminal = await service.execute(start("old-selection-draft"));
    expect(terminal.action, canonicalJson(terminal)).toBe("complete");
    for (const state of [scanner, files]) {
      const invocation = client.invocations.find((visit) => visit.stateId === state);
      if (invocation === undefined) throw new Error("Missing old draft invocation");
      const draft = client.output(invocation);
      expect(Value.Check(ScaSelectionDraftSchema, draft)).toBe(true);
      const context = service.checkpointer.loadRunById("old-selection-draft");
      if (context === undefined) throw new Error("Missing old draft run");
      expect(exactJson(service, requiredRef(context.selectedArtifacts, kind(state)))).toEqual(
        draft
      );
    }
  });

  it("binds static prompt schemas to draft registration while leaving canonical products closed", () => {
    for (const [state, agent] of [
      [scanner, "annie"],
      [files, "echo"],
    ] as const) {
      const prompt = readFileSync(
        path.join(PROJECT_ROOT, `.pi/skills/sca/assets/prompts/${agent}-${state}.md`),
        "utf8"
      );
      const json = prompt.split("```json\n")[1]?.split("\n```")[0];
      if (json === undefined) throw new Error("Missing prompt schema");
      expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(ScaSelectionDraftSchema)));
      expect(prompt).toContain("Without the declaration, exact per-ID accounting remains required");
      expect(prompt).toContain("until complete");
    }
    expect(ScaSelectionSchema.properties).not.toHaveProperty("defer_remainder");
  });
});
