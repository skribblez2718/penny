import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PRODUCE_CANDIDATE_REGISTRATION,
  PRODUCE_PLAYBOOK_NAME,
  PRODUCE_START_ADMISSION,
  OrchestrationService,
  ProducePlaybook,
  canonicalJson,
  evaluateProduceLatestReviewedArtifactDod,
  initializePennyState,
  mediaTypeForArtifactKind,
  sha256,
  validateProduceProductEnvelope,
  validateProduceProductIntegrity,
  validateProduceQualityReceipt,
  validateProduceValidityReceipt,
  validateProducedArtifact,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactApproachV1,
  type Directive,
  type JsonValue,
  type ModelClient,
  type PlaybookRegistrationV1,
  type ProduceArtifactKind,
  type ProduceRequestV1,
  type ProducedArtifactDraftV1,
} from "../src/index.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
let sequence = 0;

function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-produce-playbook-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  return env;
}

function request(
  kind: ProduceArtifactKind = "markdown",
  outputName = "greeting.md"
): ProduceRequestV1 {
  return {
    schema_version: 1,
    purpose_statement: "Create a concise greeting artifact from the supplied statement.",
    output_name: outputName,
    artifact_kind: kind,
    specification: [{ statement: "Include one greeting and identify its supplied status." }],
    source_material: [{ statement: "Hello, world.", source_label: "caller statement" }],
    acceptance_criteria: [{ statement: "The exact greeting appears once." }],
    hard_constraints: [{ statement: "Do not claim the statement was independently verified." }],
    non_goals: [{ statement: "Do not write, execute, or publish the artifact." }],
    known_uncertainties: [{ statement: "No preferred tone beyond concise was supplied." }],
  };
}

function identity(runId: string) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook: PRODUCE_PLAYBOOK_NAME,
    engine_owner: "typescript" as const,
  };
}

function start(
  runId: string,
  kind: ProduceArtifactKind = "markdown",
  outputName = "greeting.md",
  requestOverride?: ProduceRequestV1
) {
  const value = requestOverride ?? request(kind, outputName);
  const { purpose_statement: goal, ...constraints } = value;
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: identity(runId),
    goal,
    constraints,
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
  };
}

function approach(label = "direct"): ArtifactApproachV1 {
  return {
    schema_version: 1,
    approaches: [
      {
        approach_id: `${label}_direct`,
        title: "Direct greeting",
        description: "Present the supplied greeting with a short supplied-source note.",
        tradeoffs: ["Concise and exact, with minimal context."],
      },
      {
        approach_id: `${label}_sectioned`,
        title: "Sectioned greeting",
        description: "Use separate greeting and provenance sections.",
        tradeoffs: ["Makes provenance explicit but adds length."],
      },
    ],
    recommended_approach_id: `${label}_direct`,
    recommendation_rationale: "The direct structure best matches the concise brief.",
    confidence: "PROBABLE",
  };
}

function persistedApproach(value = approach()): string {
  return `ARTIFACT_APPROACH:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true}`;
}

function coverage(value = request()) {
  return {
    purpose_statement_covered: true as const,
    specification_indexes: value.specification.map((_item, index) => index),
    source_material_indexes: value.source_material.map((_item, index) => index),
    acceptance_criterion_indexes: value.acceptance_criteria.map((_item, index) => index),
    hard_constraint_indexes: value.hard_constraints.map((_item, index) => index),
    non_goal_indexes: value.non_goals.map((_item, index) => index),
    known_uncertainty_indexes: value.known_uncertainties.map((_item, index) => index),
  };
}

function draft(
  content = "# Greeting\n\nHello, world.\n\n*Supplied by the caller.*",
  requestValue = request()
): ProducedArtifactDraftV1 {
  return {
    schema_version: 1,
    disposition: "produced",
    output_name: requestValue.output_name,
    artifact_kind: requestValue.artifact_kind,
    media_type: mediaTypeForArtifactKind(requestValue.artifact_kind),
    content,
    rationale: "The concise direct structure satisfies the exact greeting brief.",
    assumptions: [],
    uncertainties: ["Tone beyond concise was not specified."],
    request_coverage: coverage(requestValue),
    confidence: "PROBABLE",
    external_actions_performed: false,
    filesystem_writes_performed: false,
    tests_executed: false,
  };
}

function notApplicableDraft(requestValue: ProduceRequestV1): ProducedArtifactDraftV1 {
  return {
    ...draft("placeholder", requestValue),
    disposition: "not_applicable",
    content: "",
    rationale: "The brief requires source material, but no source material was supplied.",
    uncertainties: ["The required source statement is absent."],
  };
}

function persistedDraft(value: ProducedArtifactDraftV1): string {
  return `PRODUCED_ARTIFACT_DRAFT:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true}`;
}

function routingOnly(output: string): string {
  const marker = output.lastIndexOf("SUMMARY:");
  if (marker < 0) throw new Error("scripted routing summary is absent");
  return output.slice(marker);
}

function qualityApprove(): string {
  return `Quality review.\nSUMMARY:${JSON.stringify({
    confidence: "PROBABLE",
    verdict: "APPROVE",
    gap_kind: "none",
    repair_owner: "none",
    findings: [],
    evidence: ["The current artifact is clear, complete, and fit for the exact brief."],
    strategy_delta: "Preserve this exact current artifact for objective verification.",
  })}`;
}

function qualityFail(): string {
  return `Quality failure.\nSUMMARY:${JSON.stringify({
    confidence: "PROBABLE",
    verdict: "FAIL",
    gap_kind: "quality_gap",
    repair_owner: "skribble",
    findings: [{ severity: "major", message: "The greeting presentation is unclear." }],
    evidence: ["The current content does not clearly distinguish supplied material."],
    strategy_delta: "Replace the draft with explicit supplied-material framing.",
  })}`;
}

function veraPass(): string {
  return `Validity report.\nSUMMARY:${JSON.stringify({
    confidence: "CERTAIN",
    verdict: "PASS",
    gap_kind: "none",
    repair_owner: "none",
    findings: [],
    evidence: ["Coverage, content hash, no-action flags, and exact lineage all match."],
    strategy_delta: "Admit only this exact current product and review evidence.",
  })}`;
}

function veraGap(kind: "brief_gap" | "artifact_product_gap"): string {
  return `Validity failure.\nSUMMARY:${JSON.stringify({
    confidence: "PROBABLE",
    verdict: "FAIL",
    gap_kind: kind,
    repair_owner: kind === "brief_gap" ? "ida" : "skribble",
    findings: [`The exact current product has a ${kind}.`],
    evidence: ["The current product disagrees with the exact request or its current lineage."],
    strategy_delta:
      kind === "brief_gap"
        ? "Replace the approach, then rematerialize from the exact brief."
        : "Replace the artifact draft while preserving the valid approach.",
  })}`;
}

class ScriptedProduceClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private next = 0;

  constructor(private readonly outputs: readonly string[]) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const text = this.outputs[this.next];
    this.next += 1;
    if (text === undefined) throw new Error("scripted Produce output is exhausted");
    return { text };
  }
}

type TerminalDirective = Extract<Directive, { result: Record<string, JsonValue> }>;

function complete(value: Directive): TerminalDirective {
  if (value.action !== "complete") {
    throw new Error(
      `expected complete directive, received '${value.action}': ${canonicalJson(value)}`
    );
  }
  return value;
}

function readJson(service: OrchestrationService, artifactId: string): unknown {
  return JSON.parse(service.artifacts.readById(artifactId).toString("utf8"));
}

function productRef(terminal: TerminalDirective) {
  const product = terminal.result.output_artifact_ref;
  if (product === null || typeof product !== "object" || Array.isArray(product)) {
    throw new Error("produced artifact ref is absent");
  }
  return product;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("orchestrated produce candidate", () => {
  it("rejects even an empty caller artifact-input envelope at closed V1 intake", () => {
    sequence += 1;
    expect(() =>
      PRODUCE_START_ADMISSION.prepare(
        {
          ...start(`run-produce-input-rejection-${sequence}`),
          input_artifacts: { schema_version: 2, artifacts: [] },
        },
        {}
      )
    ).toThrow(/no caller artifact inputs/u);
  });

  it("completes the exact Ida → Skribble → seal → Carren → Vera → host admission flow", async () => {
    const client = new ScriptedProduceClient([
      persistedApproach(),
      persistedDraft(draft()),
      qualityApprove(),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PRODUCE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-produce-happy-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "exploring_artifact_approaches",
      "materializing_artifact",
      "critiquing_artifact",
      "verifying_artifact",
    ]);
    expect(client.invocations.map((invocation) => invocation.agent)).toEqual([
      "ida",
      "skribble",
      "carren",
      "vera",
    ]);
    expect(
      client.invocations.map((invocation) => invocation.inputArtifacts.map((ref) => ref.phase))
    ).toEqual([
      ["intake"],
      ["intake", "exploring_artifact_approaches"],
      ["intake", "exploring_artifact_approaches", "materializing_artifact", "sealing_artifact"],
      [
        "intake",
        "exploring_artifact_approaches",
        "materializing_artifact",
        "sealing_artifact",
        "critiquing_artifact",
      ],
    ]);
    expect(
      client.invocations.every((invocation) => !("allowed_tools" in invocation.registration))
    ).toBe(true);
    expect(
      client.invocations.every((invocation) => /Do not execute tests/iu.test(invocation.task))
    ).toBe(true);

    const product = productRef(terminal);
    expect(validateProducedArtifact(readJson(service, String(product.artifact_id)))).toMatchObject({
      schema_id: "penny.produced-artifact.v1",
      disposition: "produced",
      output_name: "greeting.md",
      artifact_kind: "markdown",
      external_actions_performed: false,
      filesystem_writes_performed: false,
      tests_executed: false,
    });
    const quality = terminal.artifacts.find(
      (artifact) => artifact.kind === "produce-quality-receipt"
    );
    const validity = terminal.artifacts.find(
      (artifact) => artifact.kind === "produce-validity-receipt"
    );
    const integrity = terminal.artifacts.find(
      (artifact) => artifact.kind === "produce-product-integrity"
    );
    const envelope = terminal.artifacts.find(
      (artifact) => artifact.kind === "produce-product-envelope"
    );
    if (
      quality === undefined ||
      validity === undefined ||
      integrity === undefined ||
      envelope === undefined
    ) {
      throw new Error("produce product evidence graph is incomplete");
    }
    expect(validateProduceQualityReceipt(readJson(service, quality.artifact_id))).toMatchObject({
      verdict: "APPROVE",
      reviewer: "carren",
      product_ref: { artifact_id: product.artifact_id },
    });
    expect(validateProduceValidityReceipt(readJson(service, validity.artifact_id))).toMatchObject({
      verdict: "PASS",
      reviewer: "vera",
      product_ref: { artifact_id: product.artifact_id },
      quality_receipt_ref: { artifact_id: quality.artifact_id },
    });
    expect(validateProduceProductIntegrity(readJson(service, integrity.artifact_id))).toMatchObject(
      {
        status: "PASS",
        product_ref: { artifact_id: product.artifact_id },
        quality_receipt_ref: { artifact_id: quality.artifact_id },
        validity_receipt_ref: { artifact_id: validity.artifact_id },
      }
    );
    expect(validateProduceProductEnvelope(readJson(service, envelope.artifact_id))).toMatchObject({
      status: "complete",
      product_ref: { artifact_id: product.artifact_id },
      integrity_ref: { artifact_id: integrity.artifact_id },
    });
    expect(terminal).toMatchObject({
      action: "complete",
      met: true,
      unresolved: [],
      result: {
        external_actions_performed: false,
        filesystem_writes_performed: false,
        tests_executed: false,
      },
    });
    expect(service.checkpointer.completionAdmission(terminal.identity.run_id)).toBeDefined();

    const staleContext = service.checkpointer.loadRunById(terminal.identity.run_id);
    if (staleContext === undefined) throw new Error("completed Produce context is absent");
    staleContext.selectedArtifacts = staleContext.selectedArtifacts.map((artifact) =>
      artifact.kind === "produce-quality-receipt" ? { ...artifact, run_id: "stale-run" } : artifact
    );
    expect(
      evaluateProduceLatestReviewedArtifactDod({
        checkpointer: service.checkpointer,
        context: staleContext,
        terminal,
        originState: "admitting_artifact",
        latestProduct: {
          selector: "terminal_artifact",
          schema_id: "penny.produced-artifact.v1",
          product_schema_version: 1,
          product_id: String(product.artifact_id),
          sha256: String(product.content_digest),
        },
        artifactReader: service.artifacts,
        projectRoot: PROJECT_ROOT,
      })
    ).toEqual({ passed: false, evidence_refs: [] });
  });

  it("completes truthful not_applicable when required inline source material is absent", async () => {
    const value: ProduceRequestV1 = {
      ...request("text", "missing-source.txt"),
      source_material: [],
      specification: [{ statement: "Quote the required source statement exactly." }],
      acceptance_criteria: [{ statement: "No statement may be invented." }],
    };
    const client = new ScriptedProduceClient([
      persistedApproach(approach("missing")),
      persistedDraft(notApplicableDraft(value)),
      qualityApprove(),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PRODUCE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(
      await service.execute(
        start(`run-produce-na-${sequence}`, "text", "missing-source.txt", value)
      )
    );
    const product = productRef(terminal);
    expect(validateProducedArtifact(readJson(service, String(product.artifact_id)))).toMatchObject({
      disposition: "not_applicable",
      content: "",
      content_sha256: sha256(""),
    });
  });

  it("counts a Carren report accepted through routing repair as one execution group", async () => {
    const malformedQuality = `Quality review.\nSUMMARY:{"confidence":"PROBABLE"}`;
    const client = new ScriptedProduceClient([
      persistedApproach(),
      persistedDraft(draft()),
      malformedQuality,
      routingOnly(qualityApprove()),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PRODUCE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-produce-routing-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "exploring_artifact_approaches",
      "materializing_artifact",
      "critiquing_artifact",
      "critiquing_artifact",
      "verifying_artifact",
    ]);
    expect(client.invocations[3]?.executionPurpose).toBe("routing_repair");
    expect(productRef(terminal)).toMatchObject({ kind: "semantic-core", version: 1 });
  });

  it("routes Carren quality FAIL to Skribble, then reseals and repeats Carren before Vera", async () => {
    const client = new ScriptedProduceClient([
      persistedApproach(),
      persistedDraft(draft("# Greeting\n\nHello, world.")),
      qualityFail(),
      persistedDraft(draft()),
      qualityApprove(),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PRODUCE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-produce-quality-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "exploring_artifact_approaches",
      "materializing_artifact",
      "critiquing_artifact",
      "materializing_artifact",
      "critiquing_artifact",
      "verifying_artifact",
    ]);
    expect(client.invocations[3]?.inputArtifacts.map((ref) => ref.phase)).toEqual([
      "intake",
      "exploring_artifact_approaches",
      "materializing_artifact",
      "sealing_artifact",
      "critiquing_artifact",
    ]);
    expect(productRef(terminal)).toMatchObject({ version: 2 });
  });

  it("routes both Vera repair kinds through their exact owner and repeats Carren then Vera", async () => {
    for (const kind of ["brief_gap", "artifact_product_gap"] as const) {
      const outputs = [
        persistedApproach(),
        persistedDraft(draft("# Greeting\n\nHello, world.")),
        qualityApprove(),
        veraGap(kind),
      ];
      if (kind === "brief_gap") outputs.push(persistedApproach(approach("revised")));
      outputs.push(persistedDraft(draft()), qualityApprove(), veraPass());
      const client = new ScriptedProduceClient(outputs);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: PRODUCE_CANDIDATE_REGISTRATION,
      });
      sequence += 1;
      const terminal = complete(await service.execute(start(`run-produce-${kind}-${sequence}`)));
      expect(client.invocations.map((invocation) => invocation.stateId)).toEqual(
        kind === "brief_gap"
          ? [
              "exploring_artifact_approaches",
              "materializing_artifact",
              "critiquing_artifact",
              "verifying_artifact",
              "exploring_artifact_approaches",
              "materializing_artifact",
              "critiquing_artifact",
              "verifying_artifact",
            ]
          : [
              "exploring_artifact_approaches",
              "materializing_artifact",
              "critiquing_artifact",
              "verifying_artifact",
              "materializing_artifact",
              "critiquing_artifact",
              "verifying_artifact",
            ]
      );
      const repairInvocation = client.invocations[4];
      expect(repairInvocation?.agent).toBe(kind === "brief_gap" ? "ida" : "skribble");
      expect(repairInvocation?.inputArtifacts.map((ref) => ref.phase)).toContain(
        "verifying_artifact"
      );
      expect(productRef(terminal)).toMatchObject({ version: 2 });
    }
  });

  it("uses one host seal-feedback repair and never treats invalid draft flags as a product", async () => {
    const invalid = { ...draft(), tests_executed: true };
    const client = new ScriptedProduceClient([
      persistedApproach(),
      `PRODUCED_ARTIFACT_DRAFT:${canonicalJson(invalid)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      persistedDraft(draft()),
      qualityApprove(),
      veraPass(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PRODUCE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = complete(await service.execute(start(`run-produce-seal-repair-${sequence}`)));
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "exploring_artifact_approaches",
      "materializing_artifact",
      "materializing_artifact",
      "critiquing_artifact",
      "verifying_artifact",
    ]);
    expect(
      validateProducedArtifact(readJson(service, String(productRef(terminal).artifact_id)))
    ).toMatchObject({
      tests_executed: false,
      filesystem_writes_performed: false,
      external_actions_performed: false,
    });
  });

  it("recovers after host seal persistence without creating a duplicate product revision", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistrationV1 = {
      ...PRODUCE_CANDIDATE_REGISTRATION,
      construct: (options) =>
        new ProducePlaybook(
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (!interrupted && point === "sealing_artifact:artifact-persistence") {
              interrupted = true;
              throw new Error("injected produce seal interruption");
            }
          }
        ),
    };
    sequence += 1;
    const runId = `run-produce-seal-recovery-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedProduceClient([persistedApproach(), persistedDraft(draft())]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(/injected produce seal/u);
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_artifact");
    }
    const recoveredClient = new ScriptedProduceClient([qualityApprove(), veraPass()]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: PRODUCE_CANDIDATE_REGISTRATION,
    });
    const terminal = complete(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    const products = terminal.artifacts.filter(
      (artifact) => artifact.kind === "semantic-core" && artifact.phase === "sealing_artifact"
    );
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ version: 1 });
    expect(recoveredClient.invocations.map((invocation) => invocation.stateId)).toEqual([
      "critiquing_artifact",
      "verifying_artifact",
    ]);
  });

  it("recovers an interrupted receipt/integrity admission window without another model call", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistrationV1 = {
      ...PRODUCE_CANDIDATE_REGISTRATION,
      construct: (options) =>
        new ProducePlaybook(
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (!interrupted && point === "admitting_artifact:integrity-persistence") {
              interrupted = true;
              throw new Error("injected produce integrity interruption");
            }
          }
        ),
    };
    sequence += 1;
    const runId = `run-produce-integrity-recovery-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedProduceClient([
          persistedApproach(),
          persistedDraft(draft()),
          qualityApprove(),
          veraPass(),
        ]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(/injected produce integrity/u);
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("admitting_artifact");
    }
    const recoveredClient = new ScriptedProduceClient([]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: PRODUCE_CANDIDATE_REGISTRATION,
    });
    const terminal = complete(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    expect(recoveredClient.invocations).toEqual([]);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "produce-quality-receipt")
    ).toHaveLength(1);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "produce-validity-receipt")
    ).toHaveLength(1);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "produce-product-integrity")
    ).toHaveLength(1);
    expect(
      terminal.artifacts.filter((artifact) => artifact.kind === "produce-product-envelope")
    ).toHaveLength(1);
  });

  it("terminates repeated artifact product gaps as bounded non-positive incomplete", async () => {
    const outputs = [persistedApproach()];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      outputs.push(
        persistedDraft(draft(`# Greeting\n\nHello, world.\n\nAttempt ${attempt + 1}.`)),
        qualityApprove(),
        veraGap("artifact_product_gap")
      );
    }
    const client = new ScriptedProduceClient(outputs);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PRODUCE_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-produce-exhaust-${sequence}`));
    expect(terminal).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        incomplete_reason: "repair_budget_exhausted",
        exhausted: true,
        exhaustion_reason: "verifying_artifact:product_gap",
        external_actions_performed: false,
        filesystem_writes_performed: false,
        tests_executed: false,
      },
    });
    expect(client.invocations.filter((invocation) => invocation.agent === "skribble")).toHaveLength(
      4
    );
  });
});
