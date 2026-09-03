import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer, canonicalJson, sha256 } from "../src/checkpointer.js";
import type { Directive, JsonValue, RunIdentity } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../src/model-client.js";
import {
  ResearchContextOwnerV1,
  type ResearchContextProviderHandlersV1,
} from "../src/research-context.js";
import {
  ResearchHostInterruptionError,
  evaluateResearchLatestCoreDod,
  renderResearchCompatibility,
} from "../src/playbooks/research.js";
import {
  researchSemanticDraftPromptContract,
  validateCanonicalGroundedSynthesisBytes,
  validateSemanticCoreRef,
} from "../src/skill-contracts/research.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";
import { requireRecord } from "./helpers/narrowing.js";
import { researchSemanticDraftFixture } from "./helpers/research-semantic-draft.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p3-product-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function compatibilityDirectory(root: string): string {
  return path.join(
    root,
    "research",
    `what-does-p3-activate-${sha256("What does P3 activate?").slice(0, 8)}`
  );
}

function identity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: "session-p3-product",
    playbook: "research",
    engine_owner: "typescript",
  };
}

function start(root: string, runId: string, mode: "quick" | "standard" | "deep") {
  return {
    schema_version: 2,
    action: "start",
    identity: identity(runId),
    goal: "What does P3 activate?",
    constraints: { mode },
    project_root: root,
    trust_profile: "trusted-interactive",
  };
}

function buildDraft(
  invocation: AgentInvocation,
  artifacts: ArtifactStore,
  options: ProductClientOptions
) {
  return researchSemanticDraftFixture(invocation, artifacts, {
    title: "P3 activated research",
    executiveSummary: "The semantic core is authoritative and renders are derived.",
    claimStatement: "P3 activates a semantic-core product.",
    sectionHeading: "Activation",
    sectionBody: "The sealed core precedes Vera, optional Carren, and deterministic rendering.",
    ...(options.qualified === undefined ? {} : { qualified: options.qualified }),
    ...(options.blocking === undefined ? {} : { blocking: options.blocking }),
    ...(options.absentExcerpt === undefined ? {} : { absentExcerpt: options.absentExcerpt }),
  });
}

interface ProductClientOptions {
  readonly validationFailures?: readonly ("evidence" | "synthesis")[];
  readonly qualityFailures?: number;
  readonly sealFailures?: number;
  readonly qualified?: boolean;
  readonly blocking?: boolean;
  readonly emptySynthesis?: boolean;
  readonly absentExcerpt?: boolean;
}

class ProductClient implements ModelClient {
  readonly states: string[] = [];
  readonly synthesisTasks: string[] = [];
  private validationCalls = 0;
  private qualityCalls = 0;
  private synthesisCalls = 0;

  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly options: ProductClientOptions = {}
  ) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.states.push(invocation.stateId);
    switch (invocation.stateId) {
      case "planning":
        return {
          text: 'plan\nSUMMARY:{"confidence":"CERTAIN","plan_steps":["one","two"],"plan_complete":true}',
          confidence: "CERTAIN",
          details: { plan_steps: ["one", "two"], plan_complete: true },
        };
      case "critiquing_plan":
        return {
          text: 'approved\nSUMMARY:{"confidence":"CERTAIN","verdict":"APPROVE","issues":[],"evidence":["exact"]}',
          confidence: "CERTAIN",
          details: { verdict: "APPROVE", issues: [], evidence: ["exact"] },
        };
      case "critiquing_report": {
        this.qualityCalls += 1;
        const pass = this.qualityCalls > (this.options.qualityFailures ?? 0);
        const details = {
          verdict: pass ? "APPROVE" : "NEEDS_REVISION",
          issues: pass ? [] : ["revise quality"],
          evidence: ["exact"],
        };
        return {
          text: `quality review\nSUMMARY:${JSON.stringify({ confidence: "CERTAIN", ...details })}`,
          confidence: "CERTAIN",
          details,
        };
      }
      case "researching":
        return {
          text: 'evidence\nSUMMARY:{"confidence":"CERTAIN","explore_complete":true}',
          confidence: "CERTAIN",
          details: { explore_complete: true },
        };
      case "synthesizing": {
        this.synthesisCalls += 1;
        this.synthesisTasks.push(invocation.task);
        if (this.options.emptySynthesis === true) {
          return {
            text: "",
            confidence: "CERTAIN",
            details: { synthesis_complete: true },
          };
        }
        const draft = buildDraft(invocation, this.artifacts, {
          ...this.options,
          absentExcerpt:
            this.synthesisCalls <= (this.options.sealFailures ?? 0) ||
            this.options.absentExcerpt === true,
        });
        return {
          text: `${canonicalJson(draft)}\nSUMMARY:{"confidence":"CERTAIN","synthesis_complete":true}`,
          confidence: "CERTAIN",
          details: { synthesis_complete: true },
        };
      }
      case "validating": {
        const failure = this.options.validationFailures?.[this.validationCalls];
        this.validationCalls += 1;
        const details =
          failure === undefined
            ? { verdict: "PASS" as const, unsupported_claims: [], evidence: ["exact"] }
            : {
                verdict: "FAIL" as const,
                unsupported_claims: ["claim-0001"],
                evidence: ["exact"],
                ...(failure === "evidence" ? { evidence_needed: ["targeted source"] } : {}),
              };
        return {
          text: `${failure === undefined ? "grounded" : "not grounded"}\nSUMMARY:${JSON.stringify({ confidence: "CERTAIN", ...details })}`,
          confidence: "CERTAIN",
          details,
        };
      }
    }
    throw new Error(`unexpected product fixture state '${invocation.stateId}'`);
  }
}

function runtime(
  root: string,
  options: ProductClientOptions = {},
  researchHostFault?: (point: string) => void,
  contextProviders?: ResearchContextProviderHandlersV1
) {
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
  const researchContext =
    contextProviders === undefined
      ? undefined
      : new ResearchContextOwnerV1(artifacts, contextProviders);
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: root,
    maxSteps: 96,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactRevisions: artifacts,
    artifactStore: artifacts,
    artifactReader: artifacts,
    ...(researchHostFault === undefined ? {} : { researchHostFault }),
    ...(researchContext === undefined ? {} : { researchContext }),
  });
  const client = new ProductClient(artifacts, options);
  const workers = new WorkerExecutor(client, artifacts, {
    projectRoot: root,
    parallelConcurrency: 2,
    registration: engine.registration,
    ...(researchContext === undefined ? {} : { researchContext }),
  });
  return { artifacts, checkpointer, engine, client, workers };
}

function terminalResult(directive: Directive): Record<string, JsonValue> {
  if (
    directive.action !== "complete" &&
    directive.action !== "incomplete" &&
    directive.action !== "cancelled" &&
    directive.action !== "error"
  ) {
    throw new Error(`expected terminal, received '${directive.action}'`);
  }
  return directive.result;
}

describe("P3 deterministic renderer golden", () => {
  it("matches the pre-production frozen bytes and digests", () => {
    const fixture = new URL("./fixtures/research-p3-render-golden/", import.meta.url);
    const coreBytes = readFileSync(new URL("core.json", fixture));
    const manifestValue: unknown = JSON.parse(
      readFileSync(new URL("manifest.json", fixture), "utf8")
    );
    const manifest = requireRecord(manifestValue, "render manifest");
    const core = validateCanonicalGroundedSynthesisBytes(coreBytes);
    const semanticCore = validateSemanticCoreRef(manifest["semantic_core"]);
    const rendered = renderResearchCompatibility({ core, semanticCore });
    for (const [name, file] of [
      ["report", "report.md"],
      ["sources", "sources.md"],
      ["readme", "README.md"],
    ] as const) {
      const expected = readFileSync(new URL(file, fixture));
      expect(Buffer.from(rendered[name], "utf8")).toEqual(expected);
      expect(expected.toString("utf8").normalize("NFC")).toBe(expected.toString("utf8"));
      expect(expected.toString("utf8")).not.toContain("\r");
      expect(expected.toString("utf8")).toMatch(/[^\n]\n$/u);
    }
  });
});

describe("P3 semantic product activation", () => {
  it.each([
    ["quick", ["researching", "synthesizing", "validating"]],
    ["standard", ["planning", "researching", "researching", "synthesizing", "validating"]],
    [
      "deep",
      [
        "planning",
        "critiquing_plan",
        "researching",
        "researching",
        "synthesizing",
        "validating",
        "critiquing_report",
      ],
    ],
  ] as const)(
    "completes %s with latest core, graph, renders, and exact topology",
    async (mode, expectedStates) => {
      const root = temporaryRoot();
      const stack = runtime(root);
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, `run-p3-${mode}`, mode))
      );
      expect(terminal).toMatchObject({ action: "complete", met: true, status: "complete" });
      expect(stack.client.states).toEqual(expectedStates);
      const result = terminalResult(terminal);
      const output = requireRecord(result["output_artifact_ref"], "terminal semantic core");
      expect(output["kind"]).toBe("semantic-core");
      expect(output["phase"]).toBe("sealing_core");
      expect(result["product_envelope_ref"]).toMatchObject({ kind: "product-envelope" });
      expect(result["report_files"]).toEqual([
        path.join(
          root,
          "research",
          `what-does-p3-activate-${sha256("What does P3 activate?").slice(0, 8)}`,
          "report.md"
        ),
        path.join(
          root,
          "research",
          `what-does-p3-activate-${sha256("What does P3 activate?").slice(0, 8)}`,
          "sources.md"
        ),
        path.join(
          root,
          "research",
          `what-does-p3-activate-${sha256("What does P3 activate?").slice(0, 8)}`,
          "README.md"
        ),
      ]);
      const visits = stack.checkpointer
        .stateVisits(`run-p3-${mode}`)
        .map((visit) => visit.state_id);
      expect(visits).toContain("sealing_core");
      expect(visits.at(-1)).toBe("rendering");
      expect(visits.indexOf("synthesizing")).toBeLessThan(visits.indexOf("sealing_core"));
      expect(visits.indexOf("sealing_core")).toBeLessThan(visits.indexOf("validating"));
      if (mode === "deep") {
        expect(visits.indexOf("validating")).toBeLessThan(visits.lastIndexOf("critiquing_report"));
      }
      const synthesisTask = stack.client.synthesisTasks.at(-1);
      if (synthesisTask === undefined) throw new Error("semantic drafting task was not captured");
      expect(synthesisTask).toContain(
        `MECHANICALLY_PROJECTED_RESEARCH_SEMANTIC_DRAFT_CONTRACT:${researchSemanticDraftPromptContract()}`
      );
      expect(synthesisTask).toContain("OWNER_SELECTED_EVIDENCE_SLOTS:");
      expect(synthesisTask).toContain("one closed ResearchSemanticDraftV1 JSON value");
      expect(synthesisTask).toContain("do not emit request/provenance fields");
      expect(synthesisTask).not.toContain("GroundedSynthesisV1 candidate");
      expect(synthesisTask).not.toContain("first line(s)");
      const selected = stack.checkpointer.loadRunById(`run-p3-${mode}`)?.selectedArtifacts ?? [];
      for (const artifact of selected.filter((ref) => ref.phase === "researching")) {
        expect(synthesisTask).toContain(artifact.artifact_id);
      }
      const requestRef = selected.find((artifact) => artifact.phase === "intake");
      if (requestRef === undefined) throw new Error("admitted request ref is absent");
      expect(synthesisTask).not.toContain(requestRef.content_digest);
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  );

  it("rejects an empty semantic-draft turn before persistence or routing repair", async () => {
    const root = temporaryRoot();
    const runId = "run-p4-empty-semantic-draft";
    const stack = runtime(root, { emptySynthesis: true });
    await expect(
      new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, runId, "quick"))
      )
    ).rejects.toThrow(/no non-empty final assistant text/u);
    const run = stack.checkpointer.loadRunById(runId);
    expect(run?.stateId).toBe("synthesizing");
    expect(run?.pendingDirective?.action).toBe("invoke_agent");
    expect(
      run?.selectedArtifacts.filter((artifact) =>
        ["synthesizing", "sealing_core", "validating", "rendering", "product-envelope"].includes(
          artifact.phase
        )
      )
    ).toEqual([]);
    expect(
      run?.selectedArtifacts.some((artifact) =>
        ["semantic-core", "product-envelope", "deterministic-render"].includes(artifact.kind)
      )
    ).toBe(false);
    expect(
      stack.checkpointer.events(runId).some((event) => event.eventType.startsWith("routing_repair"))
    ).toBe(false);
    stack.artifacts.close();
    stack.checkpointer.close();
  });

  it("keeps terminal truth and completion-gate digest equal across context modes", async () => {
    const documentContent = "P4 normative document context.";
    const kbContent = "P4 private approved advisory context sentinel.";
    const documentBinding = {
      slot: "domain_guidance",
      binding_kind: "versioned_document",
      selected_by: "caller",
      source_id: "p4-document-source",
      document_id: "p4-document",
      revision_id: "p4-document-revision",
      expected_sha256: sha256(documentContent),
    } as const;
    const kbBinding = {
      slot: "standard_guidance",
      binding_kind: "approved_kb_result",
      selected_by: "host",
      source_id: "p4-kb-source",
      kb_profile_id: "p4-kb-profile",
      result_id: "p4-approved-result",
      expected_sha256: sha256(kbContent),
    } as const;
    const providers: ResearchContextProviderHandlersV1 = {
      versionedDocument: () => ({
        content: documentContent,
        media_type: "text/markdown",
        role: "normative",
        scope_id: "p4-context-scope",
        freshness: { status: "not_time_sensitive" },
        upstream_locators: [
          { source_id: "p4-document-source", locator: "https://example.invalid/p4-document" },
        ],
        provider: {
          provider_id: "p4-document-provider",
          configuration_sha256: "a".repeat(64),
          eligibility_record_id: "p4-document-eligibility",
          eligibility_sha256: "b".repeat(64),
        },
        verification_disposition: "accepted_for_scope",
        conflict: { status: "none" },
      }),
      approvedKbResult: () => ({
        content: kbContent,
        media_type: "text/markdown",
        role: "advisory",
        scope_id: "p4-context-scope",
        freshness: { status: "not_time_sensitive" },
        upstream_locators: [{ source_id: "p4-kb-source", locator: "kb-result:p4-approved-result" }],
        provider: {
          provider_id: "p4-kb-provider",
          configuration_sha256: "c".repeat(64),
          eligibility_record_id: "p4-kb-eligibility",
          eligibility_sha256: "d".repeat(64),
        },
        verification_disposition: "advisory_only",
        conflict: { status: "none" },
        approval_id: "p4-kb-approval",
        approval_sha256: "e".repeat(64),
      }),
    };
    const modes = [
      { label: "none", bindings: [], providers: undefined },
      { label: "document", bindings: [documentBinding], providers },
      { label: "approved-kb", bindings: [kbBinding], providers },
      { label: "combined", bindings: [documentBinding, kbBinding], providers },
    ] as const;
    const truth: unknown[] = [];
    const gateDigests: string[] = [];
    for (const mode of modes) {
      const root = temporaryRoot();
      const runId = `run-p4-context-${mode.label}`;
      const stack = runtime(root, {}, undefined, mode.providers);
      const request = {
        ...start(root, runId, "quick"),
        constraints: { mode: "quick", context_bindings: [...mode.bindings] },
      };
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(request)
      );
      truth.push({
        action: terminal.action,
        status: "status" in terminal ? terminal.status : undefined,
        met: "met" in terminal ? terminal.met : undefined,
        unresolved: "unresolved" in terminal ? terminal.unresolved : undefined,
      });
      const admission = stack.checkpointer.completionAdmission(runId);
      if (admission === undefined) throw new Error(`${mode.label} completion admission is absent`);
      gateDigests.push(admission.gate_digest);
      if (terminal.action !== "complete") {
        throw new Error(`${mode.label} expected complete terminal, received '${terminal.action}'`);
      }
      expect(terminal.artifacts.some((ref) => ref.kind === "semantic-core")).toBe(true);
      if (mode.label === "approved-kb" || mode.label === "combined") {
        expect(canonicalJson(terminal)).not.toContain(kbContent);
        expect(canonicalJson(stack.checkpointer.events(runId))).not.toContain(kbContent);
        for (const artifact of terminal.artifacts) {
          expect(stack.artifacts.read(artifact).toString("utf8")).not.toContain(kbContent);
        }
        const reportFiles = terminal.result.report_files;
        if (!Array.isArray(reportFiles)) throw new Error(`${mode.label} report files are absent`);
        for (const file of reportFiles) {
          expect(readFileSync(String(file), "utf8")).not.toContain(kbContent);
        }
      }
      stack.artifacts.close();
      stack.checkpointer.close();
    }
    expect(new Set(truth.map((value) => canonicalJson(value))).size).toBe(1);
    expect(new Set(gateDigests).size).toBe(1);
  });

  it.each([
    [
      "evidence",
      { validationFailures: ["evidence"] },
      ["validating", "researching", "synthesizing", "validating"],
    ],
    [
      "synthesis",
      { validationFailures: ["synthesis"] },
      ["validating", "synthesizing", "validating"],
    ],
    ["core sealing", { sealFailures: 1 }, ["synthesizing", "synthesizing", "validating"]],
  ] as const)(
    "routes one %s repair through typed drafting, sealing, and Vera",
    async (_name, options, suffix) => {
      const root = temporaryRoot();
      const stack = runtime(root, options);
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, `run-p3-repair-${_name.replace(/ /gu, "-")}`, "standard"))
      );
      expect(terminal).toMatchObject({ action: "complete", met: true });
      expect(stack.client.states.slice(-suffix.length)).toEqual(suffix);
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  );

  it("routes Carren quality repair through a new core and mandatory Vera re-entry", async () => {
    const root = temporaryRoot();
    const stack = runtime(root, { qualityFailures: 1 });
    const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
      stack.engine.handle(start(root, "run-p3-quality-repair", "deep"))
    );
    expect(terminal).toMatchObject({ action: "complete", met: true });
    expect(stack.client.states.slice(-5)).toEqual([
      "validating",
      "critiquing_report",
      "synthesizing",
      "validating",
      "critiquing_report",
    ]);
    const visits = stack.checkpointer
      .stateVisits("run-p3-quality-repair")
      .map((visit) => visit.state_id);
    const lastCarren = visits.lastIndexOf("critiquing_report");
    const priorVera = visits.lastIndexOf("validating", lastCarren - 1);
    const latestSeal = visits.lastIndexOf("sealing_core", lastCarren - 1);
    expect(latestSeal).toBeLessThan(priorVera);
    expect(priorVera).toBeLessThan(lastCarren);
    stack.artifacts.close();
    stack.checkpointer.close();
  });

  it.each(["symlink", "nonregular", "postwrite-drift"] as const)(
    "returns non-positive for unsafe materialization: %s",
    async (fault) => {
      const root = temporaryRoot();
      const directory = compatibilityDirectory(root);
      mkdirSync(directory, { recursive: true });
      if (fault === "symlink") {
        const outside = path.join(root, "outside-report.md");
        writeFileSync(outside, "outside\n");
        symlinkSync(outside, path.join(directory, "report.md"));
      } else if (fault === "nonregular") {
        mkdirSync(path.join(directory, "report.md"));
      }
      const stack = runtime(
        root,
        {},
        fault === "postwrite-drift"
          ? (point) => {
              if (point === "rendering:directory-fsync:report") {
                writeFileSync(path.join(directory, "report.md"), "drift\n");
              }
            }
          : undefined
      );
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, `run-unsafe-${fault}`, "quick"))
      );
      expect(terminal).toMatchObject({ action: "incomplete", met: false });
      if (terminal.action === "incomplete") {
        expect(terminal.artifacts.some((artifact) => artifact.kind === "product-envelope")).toBe(
          false
        );
        expect(terminal.result.output_artifact_ref).toMatchObject({ kind: "semantic-core" });
      }
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  );

  it("rejects same-digest latest-core and graph-artifact substitution", async () => {
    const root = temporaryRoot();
    const stack = runtime(root);
    const runId = "run-p3-substitution";
    const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
      stack.engine.handle(start(root, runId, "quick"))
    );
    if (terminal.action !== "complete") throw new Error("expected complete substitution fixture");
    const context = stack.checkpointer.loadRun(identity(runId));
    const core = terminal.artifacts.find((artifact) => artifact.kind === "semantic-core");
    if (core === undefined) throw new Error("substitution fixture core is absent");
    const base = {
      checkpointer: stack.checkpointer,
      context,
      terminal,
      originState: "rendering",
      latestProduct: {
        selector: "terminal_artifact" as const,
        schema_id: "penny.grounded-synthesis.v1",
        product_schema_version: 1,
        product_id: core.artifact_id,
        sha256: core.content_digest,
      },
      artifactReader: stack.artifacts,
      projectRoot: root,
    };
    expect(evaluateResearchLatestCoreDod(base).passed).toBe(true);
    const withoutRender = {
      ...terminal,
      artifacts: terminal.artifacts.filter((artifact) => artifact.kind !== "deterministic-render"),
    };
    expect(evaluateResearchLatestCoreDod({ ...base, terminal: withoutRender }).passed).toBe(false);
    expect(
      evaluateResearchLatestCoreDod({
        ...base,
        latestProduct: {
          ...base.latestProduct,
          product_id: `art_${"0".repeat(64)}`,
        },
      }).passed
    ).toBe(false);
    stack.artifacts.close();
    stack.checkpointer.close();
  });

  it("admits disclosed qualified success but blocks a blocking core before envelope creation", async () => {
    for (const [name, options, expected] of [
      ["qualified", { qualified: true }, { action: "complete", met: true }],
      ["blocking", { blocking: true }, { action: "incomplete", met: false }],
    ] as const) {
      const root = temporaryRoot();
      const stack = runtime(root, options);
      const terminal = await new OrchestrationRunner(stack.engine, stack.workers).runUntilBoundary(
        stack.engine.handle(start(root, `run-p3-${name}`, "quick"))
      );
      expect(terminal).toMatchObject(expected);
      const result = terminalResult(terminal);
      if (name === "qualified") {
        expect(result["qualified"]).toBe(true);
      } else if (
        terminal.action === "incomplete" ||
        terminal.action === "cancelled" ||
        terminal.action === "error"
      ) {
        expect(terminal.artifacts.some((artifact) => artifact.kind === "product-envelope")).toBe(
          false
        );
      }
      stack.artifacts.close();
      stack.checkpointer.close();
    }
  });
});

const RENDERING_FAULTS = [
  "sealing_core:artifact-persistence",
  "rendering:intent-persistence",
  ...(["report", "sources", "readme"] as const).flatMap((name) => [
    `rendering:render-artifact-persistence:${name}`,
    `rendering:prewrite:${name}`,
    `rendering:partial-temporary-write:${name}`,
    `rendering:file-fsync:${name}`,
    `rendering:rename:${name}`,
    `rendering:directory-fsync:${name}`,
  ]),
  "rendering:validation-receipt-persistence",
  "rendering:envelope-persistence",
  "rendering:final-checkpoint-admission",
] as const;

describe("P3 deterministic host crash recovery", () => {
  it("cooperatively cancels from a persisted host phase with the best exact core", async () => {
    const root = temporaryRoot();
    const runId = "run-host-cancel";
    const first = runtime(root, {}, (point) => {
      if (point === "rendering:intent-persistence") {
        throw new ResearchHostInterruptionError(point);
      }
    });
    await expect(
      new OrchestrationRunner(first.engine, first.workers).runUntilBoundary(
        first.engine.handle(start(root, runId, "quick"))
      )
    ).rejects.toThrow(ResearchHostInterruptionError);
    first.artifacts.close();
    first.checkpointer.close();

    const resumed = runtime(root);
    const cancelled = resumed.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: identity(runId),
      reason: "cancel deterministic host phase",
    });
    expect(cancelled).toMatchObject({ action: "cancelled", met: false });
    if (cancelled.action === "cancelled") {
      expect(cancelled.result.output_artifact_ref).toMatchObject({ kind: "semantic-core" });
      expect(cancelled.artifacts.some((artifact) => artifact.kind === "product-envelope")).toBe(
        false
      );
    }
    expect(
      resumed.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      })
    ).toEqual(cancelled);
    resumed.artifacts.close();
    resumed.checkpointer.close();
  });

  it.each(RENDERING_FAULTS)("converges after %s", async (faultPoint) => {
    const root = temporaryRoot();
    const runId = `run-fault-${sha256(faultPoint).slice(0, 16)}`;
    let interrupted = false;
    const first = runtime(root, {}, (point) => {
      if (!interrupted && point === faultPoint) {
        interrupted = true;
        throw new ResearchHostInterruptionError(point);
      }
    });
    await expect(
      new OrchestrationRunner(first.engine, first.workers).runUntilBoundary(
        first.engine.handle(start(root, runId, "quick"))
      )
    ).rejects.toThrow(ResearchHostInterruptionError);
    expect(interrupted).toBe(true);
    first.artifacts.close();
    first.checkpointer.close();

    const recovered = runtime(root);
    const resumed = recovered.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    const terminal = await new OrchestrationRunner(
      recovered.engine,
      recovered.workers
    ).runUntilBoundary(resumed);
    expect(terminal).toMatchObject({ action: "complete", status: "complete", met: true });
    const replay = recovered.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(canonicalJson(replay)).toBe(canonicalJson(terminal));
    const result = terminalResult(terminal);
    const files = result["report_files"];
    if (!Array.isArray(files)) throw new Error("recovered report files are malformed");
    const filePaths = files.map((file) => {
      if (typeof file !== "string") throw new Error("recovered report file is not a path");
      return file;
    });
    const firstBytes = filePaths.map((file) => readFileSync(file));
    const secondReplay = recovered.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(canonicalJson(secondReplay)).toBe(canonicalJson(terminal));
    expect(filePaths.map((file) => readFileSync(file))).toEqual(firstBytes);
    recovered.artifacts.close();
    recovered.checkpointer.close();
  });
});
