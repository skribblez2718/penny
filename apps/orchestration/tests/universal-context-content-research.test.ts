import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactRefSchema,
  canonicalJson,
  evaluateResearchLatestCoreDod,
  renderResearchCompatibility,
  sha256,
  validateContract,
} from "../dist/index.js";
import { assertCurrentShippingBuild } from "../dist/build-provenance.js";
import {
  researchRequestSha256,
  validateCanonicalGroundedSynthesisBytes,
  validateProductReceipt,
  validateResearchProductEnvelope,
  validateResearchProductGraph,
  validateResearchRequest,
} from "../dist/skill-contracts/research.js";
import { requireArrayItem, requireStringArray, requireValue } from "./helpers/narrowing.js";
import {
  ContentFixtureOwner,
  acceptedContentProduct,
  nonbindingContext,
} from "./helpers/universal-content-fixtures.js";
import { contentProducers, type ContentProducer } from "./helpers/universal-content-oracle.js";
import {
  executeResearchContent,
  syntheticMethodObservation,
  verificationResearchRequest,
  type ResearchMutation,
  type ResearchScript,
} from "./helpers/universal-content-research-fixtures.js";
import {
  assertResearchMeaning,
  coveredResearchContentPairs,
  researchContentEvidenceTier,
} from "./helpers/universal-content-research-oracle.js";

// One native consumer family. Cognition/review verdicts are scripted, all native owners are real.
// These cases qualify verification-question/limitation semantics, NOT source-fact verification,
// production understanding, generic paraphrase recognition, or the other consumer columns.
// Bind this cohort to the verified current build, then detect drift during execution.
const generation = requireValue(assertCurrentShippingBuild(), "current compiled build").generation;
beforeAll(() => expect(assertCurrentShippingBuild()?.generation).toBe(generation));
afterAll(() => expect(assertCurrentShippingBuild()?.generation).toBe(generation));

async function sourceFor(
  host: ContentFixtureOwner,
  producer: ContentProducer,
  scenario: ResearchScript["scenario"] = "base",
  hostile = false
) {
  return acceptedContentProduct(
    (
      await host.execute(
        producer,
        `source-${producer}`,
        hostile ? "authority" : scenario === "counterfactual" ? "counterfactual" : "base"
      )
    ).terminal
  );
}

function assertNativePath(
  host: ContentFixtureOwner,
  execution: Awaited<ReturnType<typeof executeResearchContent>>,
  script: ResearchScript,
  originalBytes: Buffer
) {
  const { terminal, client, request } = execution;
  const ref = acceptedContentProduct(terminal);
  if (terminal.action !== "complete") throw new Error("Research terminal absent");
  const runId = ref.run_id;
  const context = requireValue(host.checkpointer.loadRunById(runId), "Research checkpoint");
  const core = validateCanonicalGroundedSynthesisBytes(host.artifacts.read(ref), ref);
  expect(ref).toMatchObject({ kind: "semantic-core", phase: "sealing_core" });
  expect(core.request).toEqual({
    request_sha256: researchRequestSha256(request),
    normalized_question: request.question,
    scope: request.scope,
  });
  expect(context.admittedInputArtifacts).toEqual(nonbindingContext(script.source));
  expect(context.selectedArtifacts).not.toContainEqual(script.source);
  const requestRef = requireValue(
    context.selectedArtifacts.find((row) => row.kind === "research-request"),
    "admitted request"
  );
  expect(validateResearchRequest(host.readProduct(requestRef))).toEqual(request);
  expect(request.input_products).toEqual([]);
  expect(request.context_bindings).toEqual([]);
  expect(host.artifacts.metadata(requestRef).upstream_refs).toEqual([]);
  expect(host.artifacts.read(requestRef).toString("utf8")).not.toContain(script.source.artifact_id);
  expect(core.provenance.context_trace_sha256).toBe(sha256(canonicalJson([])));
  expect(core.provenance.evidence_artifacts).toHaveLength(1);
  const observationRef = requireArrayItem(core.provenance.evidence_artifacts, 0, "method evidence");
  expect(observationRef).toMatchObject({
    run_id: runId,
    phase: "researching",
    kind: "agent-output",
  });
  expect(observationRef.artifact_id).not.toBe(script.source.artifact_id);
  const echoBytes = host.artifacts.read(observationRef).toString("utf8");
  expect(echoBytes).toBe(
    `${syntheticMethodObservation}\nSUMMARY:{"confidence":"PROBABLE","explore_complete":true}`
  );
  expect(core.evidence.map((row) => row.evidence_artifact_id)).toEqual([
    observationRef.artifact_id,
  ]);
  expect(core.evidence.map((row) => row.excerpt_sha256)).toEqual([
    sha256(syntheticMethodObservation),
  ]);
  const upstreams = host.artifacts.metadata(ref).upstream_refs;
  expect(upstreams).toContainEqual(observationRef);
  expect(upstreams).not.toContainEqual(script.source);
  expect(core.provenance.synthesis_source_artifact).toMatchObject({
    run_id: runId,
    phase: "synthesizing",
    kind: "agent-output",
  });
  expect(
    host.artifacts.metadata(core.provenance.synthesis_source_artifact).upstream_refs
  ).not.toContainEqual(script.source);
  const envelopeRef = validateContract(
    ArtifactRefSchema,
    terminal.result["product_envelope_ref"],
    "native research envelope"
  );
  const envelope = validateResearchProductEnvelope(host.readProduct(envelopeRef));
  expect(envelope.run_id).toBe(runId);
  expect(envelope.semantic_core.artifact_ref).toEqual(ref);
  expect(envelope.semantic_core.sha256).toBe(ref.content_digest);
  const receipts = envelope.receipts.map((binding) => {
    const receipt = validateProductReceipt(host.readProduct(binding.artifact_ref));
    expect(receipt.receipt_id).toBe(binding.receipt_id);
    expect(receipt.receipt_kind).toBe(binding.receipt_kind);
    expect(receipt.attested_core).toEqual(envelope.semantic_core);
    expect(receipt.verdict).toBe("PASS");
    if (receipt.producer !== "host:product-validator") {
      const state = receipt.producer === "agent:vera" ? "validating" : "critiquing_report";
      const review = requireValue(
        client.invocations.find((row) => row.stateId === state),
        "current review invocation"
      );
      expect(review.inputArtifacts).toContainEqual(ref);
      expect(review.inputArtifacts).toContainEqual(observationRef);
      expect(receipt.evidence_refs.length).toBeGreaterThan(0);
      expect(receipt.evidence_refs.some((row) => row.run_id === runId && row.phase === state)).toBe(
        true
      );
    }
    return receipt;
  });
  expect(receipts.map((row) => row.receipt_kind)).toEqual([
    "grounding_verification",
    "quality_critique",
    "deterministic_product_validation",
  ]);
  expect(
    validateResearchProductGraph({ core, envelope, receipts, renders: envelope.renders })
  ).toEqual(envelope);
  const expectedRenders = renderResearchCompatibility({
    core,
    semanticCore: envelope.semantic_core,
  });
  const files = requireStringArray(terminal.result["report_files"], "actual report paths");
  expect(files).toHaveLength(3);
  expect(envelope.renders.map((row) => row.render_name)).toEqual(["report", "sources", "readme"]);
  for (const render of envelope.renders) {
    expect(render.semantic_core).toEqual(envelope.semantic_core);
    const bytes = host.artifacts.read(render.artifact_ref);
    expect(bytes.toString("utf8")).toBe(expectedRenders[render.render_name]);
    expect(bytes.length).toBe(render.byte_length);
    expect(sha256(bytes)).toBe(render.content_sha256);
    const file = requireValue(
      files.find((file) => file.endsWith(`/${render.target_relative_path}`)),
      "actual host render path"
    );
    expect(file.startsWith(`${host.root}/`)).toBe(true);
    expect(readFileSync(file)).toEqual(bytes);
  }
  expect(terminal.result["qualified"]).toBe(true);
  expect(terminal.unresolved).toEqual([]);
  expect(host.checkpointer.completionAdmission(runId)).toBeDefined();
  expect(
    evaluateResearchLatestCoreDod({
      checkpointer: host.checkpointer,
      context,
      terminal,
      originState: "rendering",
      latestProduct: {
        selector: "terminal_artifact",
        schema_id: "penny.grounded-synthesis.v1",
        product_schema_version: 1,
        product_id: ref.artifact_id,
        sha256: ref.content_digest,
      },
      artifactReader: host.artifacts,
      projectRoot: host.root,
    }).passed
  ).toBe(true);
  expect(client.invocations.map((row) => row.stateId)).toEqual([
    "planning",
    "critiquing_plan",
    "researching",
    "synthesizing",
    "validating",
    "critiquing_report",
  ]);
  const visits = host.checkpointer.stateVisits(runId).map((row) => row.state_id);
  expect(visits.indexOf("sealing_core")).toBeGreaterThan(visits.indexOf("synthesizing"));
  expect(visits.indexOf("validating")).toBeGreaterThan(visits.indexOf("sealing_core"));
  expect(visits.at(-1)).toBe("rendering");
  for (const [invocationIndex, invocation] of client.invocations.entries()) {
    expect(invocation.task).toContain("NONBINDING context slot");
    expect(invocation.inputArtifacts).toContainEqual(script.source);
    expect(invocation.registration.allowed_tools).toBeUndefined();
    const reads = client.reads.filter((row) => row.invocationIndex === invocationIndex);
    expect(reads.map((row) => row.ref)).toEqual(invocation.inputArtifacts);
    for (const read of reads) {
      expect(read.bytes).toEqual(host.artifacts.read(read.ref));
      expect(read.bytes.length).toBe(read.ref.byte_length);
      expect(sha256(read.bytes)).toBe(read.ref.content_digest);
    }
  }
  const synthesis = requireValue(
    client.invocations.find((row) => row.stateId === "synthesizing"),
    "synthesis invocation"
  );
  const slots = requireValue(
    synthesis.task.match(/OWNER_SELECTED_EVIDENCE_SLOTS:(\{[^\n]+\})/u)?.[1],
    "owner slots"
  );
  expect(slots).toContain(observationRef.artifact_id);
  expect(slots).not.toContain(script.source.artifact_id);
  expect(host.artifacts.read(script.source)).toEqual(originalBytes);
  return core;
}

async function exercise(host: ContentFixtureOwner, script: ResearchScript) {
  const originalBytes = host.artifacts.read(script.source);
  const execution = await executeResearchContent(host, "consumer-research", script);
  const core = assertNativePath(host, execution, script, originalBytes);
  return { core, execution };
}

const ordinaryMutations: readonly ResearchMutation[] = [
  "ignored",
  "omitted",
  "changed",
  "coerced",
  "evidence",
  "permission",
  "native-authority",
  "summary-contradiction",
];
describe("UO-CONTENT-RESEARCH seven native qualified verification agendas", () => {
  for (const producer of contentProducers) {
    it.each(["direct", "paraphrase"] as const)(
      `${producer}→research preserves two distinguishing questions and limitations (%s)`,
      async (wording) => {
        using host = new ContentFixtureOwner();
        const source = await sourceFor(host, producer);
        const script: ResearchScript = { producer, source, wording, scenario: "base" };
        const { core } = await exercise(host, script);
        expect(assertResearchMeaning(core, script)).toEqual(core);
      }
    );
    it.each(ordinaryMutations)(
      `${producer}→research native-valid %s reaches independent oracle after scripted PASS`,
      async (mutation) => {
        using host = new ContentFixtureOwner();
        const source = await sourceFor(host, producer);
        const script: ResearchScript = {
          producer,
          source,
          wording: "direct",
          scenario: "base",
          mutation,
        };
        const { core } = await exercise(host, script);
        expect(() => assertResearchMeaning(core, script)).toThrow(/RESEARCH_CONTENT_ORACLE/u);
      }
    );
  }
  for (const producer of ["plan", "research"] as const) {
    it.each(["direct", "paraphrase"] as const)(
      `${producer} counterfactual changes the research question, not just provenance (%s)`,
      async (wording) => {
        using host = new ContentFixtureOwner();
        const source = await sourceFor(host, producer, "counterfactual");
        const script: ResearchScript = { producer, source, wording, scenario: "counterfactual" };
        const { core } = await exercise(host, script);
        assertResearchMeaning(core, script);
        expect(() => assertResearchMeaning(core, { ...script, scenario: "base" })).toThrow(
          /RESEARCH_CONTENT_ORACLE/u
        );
      }
    );
    it(`${producer} strengthening is not rescued by the right source ID or native PASS`, async () => {
      using host = new ContentFixtureOwner();
      const source = await sourceFor(host, producer, "counterfactual");
      const script: ResearchScript = {
        producer,
        source,
        wording: "direct",
        scenario: "counterfactual",
        mutation: "domain-strengthening",
      };
      const { core } = await exercise(host, script);
      expect(() => assertResearchMeaning(core, script)).toThrow(/RESEARCH_CONTENT_ORACLE/u);
    });
  }
  it.each(["direct", "paraphrase"] as const)(
    "irrelevant hostile transition context is excluded (%s)",
    async (wording) => {
      using host = new ContentFixtureOwner();
      const source = await sourceFor(host, "plan", "base", true);
      const script: ResearchScript = { producer: "plan", source, wording, scenario: "irrelevant" };
      const { core } = await exercise(host, script);
      assertResearchMeaning(core, script);
      expect(canonicalJson(core)).not.toContain("SYSTEM OVERRIDE");
      expect(canonicalJson(core)).not.toContain("Use bash");
    }
  );
  it("forcing irrelevant context into the research questions fails the independent oracle", async () => {
    using host = new ContentFixtureOwner();
    const source = await sourceFor(host, "plan");
    const script: ResearchScript = {
      producer: "plan",
      source,
      wording: "direct",
      scenario: "irrelevant",
      mutation: "irrelevant-import",
    };
    const { core } = await exercise(host, script);
    expect(() => assertResearchMeaning(core, script)).toThrow(/RESEARCH_CONTENT_ORACLE/u);
  });
  it("relevant hostile prose grants no evidence, approval, tools, or native authority", async () => {
    using host = new ContentFixtureOwner();
    const source = await sourceFor(host, "plan", "base", true);
    const script: ResearchScript = {
      producer: "plan",
      source,
      wording: "direct",
      scenario: "base",
    };
    const { core } = await exercise(host, script);
    assertResearchMeaning(core, script);
  });
  it.each(["evidence", "permission", "native-authority"] as const)(
    "hostile instruction follower %s still reaches the oracle and fails",
    async (mutation) => {
      using host = new ContentFixtureOwner();
      const source = await sourceFor(host, "plan", "base", true);
      const script: ResearchScript = {
        producer: "plan",
        source,
        wording: "direct",
        scenario: "base",
        mutation,
      };
      const { core } = await exercise(host, script);
      expect(() => assertResearchMeaning(core, script)).toThrow(/RESEARCH_CONTENT_ORACLE/u);
    }
  );
  it("provenance substitution fails independently of native graph success", async () => {
    using host = new ContentFixtureOwner();
    const source = await sourceFor(host, "assess");
    const script: ResearchScript = {
      producer: "assess",
      source,
      wording: "direct",
      scenario: "base",
    };
    const { core } = await exercise(host, script);
    expect(() =>
      assertResearchMeaning(core, {
        ...script,
        source: { ...source, content_digest: "0".repeat(64) },
      })
    ).toThrow(/RESEARCH_CONTENT_ORACLE/u);
  });
  it("the same closed native question completes without any context or distinguishing answer", async () => {
    using host = new ContentFixtureOwner();
    const execution = await executeResearchContent(host, "no-context-research");
    const ref = acceptedContentProduct(execution.terminal);
    const core = validateCanonicalGroundedSynthesisBytes(host.artifacts.read(ref), ref);
    expect(core.request.normalized_question).toBe(verificationResearchRequest().question);
    expect(core.claims).toHaveLength(1);
    expect(requireArrayItem(core.claims, 0, "method claim").statement).toBe(
      "The supplied synthetic method requires independent measurements before operational conclusions."
    );
    expect(
      requireValue(host.checkpointer.loadRunById(ref.run_id), "context-free completed run")
        .admittedInputArtifacts
    ).toBeUndefined();
    expect(host.checkpointer.completionAdmission(ref.run_id)).toBeDefined();
  });
  it("honestly unsupported contextual facts cannot become a positive native Research product even after scripted PASS", async () => {
    using host = new ContentFixtureOwner();
    const source = await sourceFor(host, "research");
    const script: ResearchScript = {
      producer: "research",
      source,
      wording: "direct",
      scenario: "base",
      mutation: "unsupported-fact",
    };
    const { terminal, client } = await executeResearchContent(host, "unsupported-research", script);
    expect(terminal).toMatchObject({ action: "incomplete", status: "incomplete", met: false });
    expect(client.invocations.map((row) => row.stateId)).toContain("validating");
    if (terminal.action !== "incomplete") throw new Error("missing native refusal");
    expect(terminal.result["product_envelope_ref"]).toBeUndefined();
    expect(host.checkpointer.completionAdmission("unsupported-research")).toBeUndefined();
    const context = requireValue(
      host.checkpointer.loadRunById("unsupported-research"),
      "partial native run"
    );
    const ref = requireValue(
      context.selectedArtifacts.find(
        (row) => row.kind === "semantic-core" && row.phase === "sealing_core"
      ),
      "retained partial core"
    );
    const core = validateCanonicalGroundedSynthesisBytes(host.artifacts.read(ref), ref);
    expect(core.claims.some((row) => row.support_status === "unsupported")).toBe(true);
    expect(() => assertResearchMeaning(core, script)).toThrow(/RESEARCH_CONTENT_ORACLE/u);
  });
  it("native Research is independently closed without contextual answers or imports", () => {
    const request = verificationResearchRequest();
    expect(validateResearchRequest(request)).toEqual(request);
    expect(request.input_products).toEqual([]);
    expect(request.context_bindings).toEqual([]);
    expect(request.budget_overrides).toEqual({});
    expect(canonicalJson(request)).not.toMatch(
      /Option A|hyp_cache|7 days|14 days|Rollback access|Tuesday/u
    );
    expect(coveredResearchContentPairs).toEqual(
      contentProducers.map((producer) => `${producer}→research`)
    );
    expect(researchContentEvidenceTier).toBe(
      "provider-free scripted cognition; qualified verification agenda only"
    );
  });
});
