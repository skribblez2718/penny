import { bindProduceReviewFixture } from "./helpers/produce-review-fixture.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  Checkpointer,
  OrchestrationEngine,
  OrchestrationRunner,
  WorkerExecutor,
  ArtifactRefSchema,
  canonicalJson,
  validateContract,
  validateSemanticComposition,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type Directive,
  type InputArtifacts,
  type ModelClient,
  type StartRequest,
} from "../dist/index.js";
import { PLAYBOOK_REGISTRY } from "../dist/playbooks/registry.js";
import { ordinaryContextFixture } from "./helpers/ordinary-context-fixtures.js";
import { researchSemanticDraftFixture } from "./helpers/research-semantic-draft.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const skills = ["assess", "decide", "define", "diagnose", "plan", "produce", "research"] as const;
const pairs = skills.flatMap((producer) => skills.map((consumer) => ({ producer, consumer })));
const projectId = `prj_${"0".repeat(32)}`;
function identity(runId: string, playbook: string) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook,
    engine_owner: "typescript" as const,
  };
}
function contextInput(refs: readonly ArtifactRef[]): InputArtifacts {
  return {
    schema_version: 2,
    artifacts: refs.map((ref, index) => ({
      slot: `context-${index}`,
      designation: "context",
      ref,
    })),
  };
}
function output(terminal: Directive): ArtifactRef {
  if (terminal.action !== "complete" || terminal.status !== "complete" || !terminal.met)
    throw new Error(`Fixture failed native completion: ${canonicalJson(terminal)}`);
  return validateContract(
    ArtifactRefSchema,
    terminal.result.output_artifact_ref,
    "accepted fixture product"
  );
}

/** Scripted cognition; real engine, native contracts, sealing, reviews and completion predicates. */
class FixtureClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private cursor = 0;
  constructor(
    private readonly skill: string,
    private readonly artifacts: ArtifactStore,
    private readonly outputs: readonly string[] = ordinaryContextFixture(skill).outputs
  ) {}
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    // Preflight and cognition here both read exact full bytes. This is delivery evidence,
    // NOT an oracle for a production model's substantive use of contextual meaning.
    for (const ref of invocation.inputArtifacts) this.artifacts.read(ref);
    if (this.skill !== "research") {
      const text = this.outputs[this.cursor++];
      if (text === undefined) throw new Error(`Unexpected ${this.skill}/${invocation.stateId}`);
      return { text: bindProduceReviewFixture(invocation, text) };
    }
    const details =
      invocation.stateId === "planning"
        ? { plan_steps: ["Inspect synthetic material."], plan_complete: true }
        : invocation.stateId === "researching"
          ? { explore_complete: true }
          : invocation.stateId === "synthesizing"
            ? { synthesis_complete: true }
            : invocation.stateId === "validating"
              ? { verdict: "PASS", unsupported_claims: [], evidence: ["Exact synthetic source."] }
              : { verdict: "APPROVE", issues: [], evidence: ["Exact synthetic product."] };
    const text =
      invocation.stateId === "synthesizing"
        ? canonicalJson(researchSemanticDraftFixture(invocation, this.artifacts))
        : "Synthetic stage body.";
    return { text: `${text}\nSUMMARY:${canonicalJson({ confidence: "PROBABLE", ...details })}` };
  }
}

class Owner implements Disposable {
  readonly root = mkdtempSync(path.join(tmpdir(), "penny-universal-context-"));
  readonly artifacts = new ArtifactStore(path.join(this.root, "artifacts"), { projectId });
  checkpointer = new Checkpointer(path.join(this.root, "orchestration.db"), undefined, {
    projectId,
  });
  readonly products = new Map<string, ArtifactRef>();
  engine(skill: string): OrchestrationEngine {
    return new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.root,
      playbookName: skill,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactReader: this.artifacts,
      artifactStore: this.artifacts,
      artifactRevisions: this.artifacts,
      assuranceProjectId: projectId,
    });
  }
  start(skill: string, runId: string, inputs?: InputArtifacts): StartRequest {
    const fixture = ordinaryContextFixture(skill);
    return {
      schema_version: 2,
      action: "start",
      identity: identity(runId, skill),
      goal: fixture.goal,
      constraints: fixture.constraints,
      project_root: this.root,
      trust_profile: "hardened-untrusted",
      ...(inputs === undefined ? {} : { input_artifacts: inputs }),
    };
  }
  async execute(
    skill: string,
    runId: string,
    inputs?: InputArtifacts,
    outputs?: readonly string[]
  ) {
    const engine = this.engine(skill);
    const client = new FixtureClient(skill, this.artifacts, outputs);
    const workers = new WorkerExecutor(client, this.artifacts, {
      projectRoot: this.root,
      parallelConcurrency: 2,
      registration: engine.registration,
    });
    workers.setReceiptAuthority(engine.receiptAuthority);
    workers.setLivenessController(engine.liveness);
    const terminal = await new OrchestrationRunner(engine, workers).runUntilBoundary(
      engine.handle(this.start(skill, runId, inputs))
    );
    return { terminal, client };
  }
  product(skill: string): ArtifactRef {
    const ref = this.products.get(skill);
    if (ref === undefined) throw new Error(`Missing accepted ${skill} fixture`);
    return ref;
  }
  reopen(): void {
    this.checkpointer.close();
    this.checkpointer = new Checkpointer(path.join(this.root, "orchestration.db"), undefined, {
      projectId,
    });
  }
  [Symbol.dispose](): void {
    this.checkpointer.close();
    this.artifacts.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

let active: Owner | undefined;
function owner(): Owner {
  if (active === undefined) throw new Error("Missing fixture owner");
  return active;
}
beforeAll(async () => {
  active = new Owner();
  for (const skill of skills) {
    const result = await active.execute(skill, `producer-${skill}`);
    active.products.set(skill, output(result.terminal));
  }
});
afterAll(() => active?.[Symbol.dispose]());

describe("universal NONBINDING context (deterministic admission, not semantic-use qualification)", () => {
  it.each(pairs)(
    "$producer → $consumer admits the original accepted canonical product without native coercion",
    ({ producer, consumer }) => {
      const host = owner();
      const ref = host.product(producer);
      const inputs = contextInput([ref]);
      const bytes = host.artifacts.read(ref);
      const runId = `matrix-${producer}-${consumer}`;
      const directive = host.engine(consumer).handle(host.start(consumer, runId, inputs));
      if (directive.action !== "invoke_agent")
        throw new Error(`Unexpected matrix action ${directive.action}`);
      expect(directive.input_artifacts.artifacts).toContainEqual(inputs.artifacts[0]);
      expect(directive.output_artifact.upstream_refs).not.toContainEqual(ref);
      expect(host.artifacts.read(ref)).toEqual(bytes);
      const context = host.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("Missing matrix checkpoint");
      expect(context.admittedInputArtifacts).toEqual(inputs);
      expect(context.selectedArtifacts).not.toContainEqual(ref);
      expect(
        context.selectedArtifacts.some((input) => input.kind === "plan-specification-source-index")
      ).toBe(false);
      const request = context.selectedArtifacts.find(
        (input) =>
          input.producer === "host:request-admission" &&
          input.content_schema?.schema_id ===
            host.engine(consumer).registration.start_admission?.schema_id
      );
      if (request === undefined) throw new Error("Missing native request");
      expect(host.artifacts.read(request).toString("utf8")).not.toContain(ref.artifact_id);
    }
  );

  it("delivers Plan → Produce through every actual worker phase and checkpoint recovery with exact bytes", async () => {
    const host = owner();
    const ref = host.product("plan");
    const input = contextInput([ref]);
    const runId = "plan-produce-recover";
    const first = host.engine("produce").handle(host.start("produce", runId, input));
    host.reopen();
    const engine = host.engine("produce");
    const recovered = engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(runId, "produce"),
    });
    expect(recovered).toMatchObject({
      action: "invoke_agent",
      input_artifacts: first.action === "invoke_agent" ? first.input_artifacts : undefined,
    });
    if (first.action !== "invoke_agent" || recovered.action !== "invoke_agent")
      throw new Error("Missing recoverable worker");
    expect(recovered.task).toBe(first.task);
    const client = new FixtureClient("produce", host.artifacts);
    const workers = new WorkerExecutor(client, host.artifacts, {
      projectRoot: host.root,
      parallelConcurrency: 1,
      registration: engine.registration,
    });
    workers.setReceiptAuthority(engine.receiptAuthority);
    workers.setLivenessController(engine.liveness);
    const terminal = await new OrchestrationRunner(engine, workers).runUntilBoundary(recovered);
    expect(output(terminal).content_schema?.schema_id).toBe("penny.produced-artifact.v2");
    expect(client.invocations.map((inv) => inv.stateId)).toEqual([
      "exploring_artifact_approaches",
      "selecting_artifact_approach",
      "materializing_artifact",
      "critiquing_artifact",
      "verifying_artifact",
    ]);
    for (const invocation of client.invocations) {
      expect(invocation.inputArtifacts).toContainEqual(ref);
      expect(invocation.task).toContain("NONBINDING context slot");
      expect(invocation.task).toContain("Read every contextual artifact in full");
      expect(invocation.task).toContain(canonicalJson(ref));
      expect(invocation.registration.allowed_tools).toBeUndefined();
    }
  });

  it("preserves exact context through actual routing-only correction without replacing its native malformed source", async () => {
    const host = owner();
    const ref = host.product("plan");
    const outputs = [...ordinaryContextFixture("produce").outputs];
    const first = outputs.shift();
    if (first === undefined) throw new Error("Missing approach fixture");
    const marker = first.lastIndexOf("SUMMARY:");
    if (marker < 0) throw new Error("Missing fixture summary");
    const { terminal, client } = await host.execute(
      "produce",
      "context-routing-correction",
      contextInput([ref]),
      [first.slice(0, marker).trimEnd(), first.slice(marker), ...outputs]
    );
    output(terminal);
    const correction = client.invocations.find(
      (invocation) => invocation.executionPurpose === "routing_repair"
    );
    if (correction === undefined) throw new Error("Missing real routing correction");
    expect(correction.inputArtifacts).toContainEqual(ref);
    expect(
      correction.inputArtifacts.filter((input) => input.artifact_id !== ref.artifact_id)
    ).toHaveLength(1);
    expect(correction.task).toContain("NONBINDING context slot");
  });

  it.each(skills)("%s retains NONBINDING context through every ordinary phase", async (skill) => {
    const host = owner();
    const ref = host.product(skill === "research" ? "research" : "plan");
    const { terminal, client } = await host.execute(
      skill,
      `all-phases-${skill}`,
      contextInput([ref])
    );
    output(terminal);
    expect(client.invocations.length).toBeGreaterThan(0);
    for (const invocation of client.invocations) {
      expect(invocation.inputArtifacts).toContainEqual(ref);
      expect(invocation.task).toContain("NONBINDING context slot");
    }
  });

  it("refuses a context producer whose current review graph no longer verifies", () => {
    const host = owner();
    const ref = host.product("produce");
    const producer = host.checkpointer.loadRunById(ref.run_id);
    if (producer === undefined) throw new Error("Missing producer");
    const review = producer.selectedArtifacts.find(
      (input) => input.kind === "produce-validity-receipt"
    );
    if (review === undefined) throw new Error("Missing native validity receipt");
    const file = path.join(
      host.root,
      "artifacts",
      "objects",
      "sha256",
      review.content_digest.slice(0, 2),
      review.content_digest.slice(2)
    );
    const original = readFileSync(file);
    try {
      writeFileSync(file, "corrupt review");
      expect(() =>
        host
          .engine("assess")
          .handle(host.start("assess", "corrupt-producer-review", contextInput([ref])))
      ).toThrow(/COMPOSITION_CONTEXT_UNACCEPTED/u);
      expect(host.checkpointer.runExists("corrupt-producer-review")).toBe(false);
    } finally {
      writeFileSync(file, original);
    }
  });

  it("keeps Specification context out of Define create/revision semantics and Plan source/assurance indexes", async () => {
    const host = owner();
    const ref = host.product("define");
    for (const consumer of ["define", "plan"]) {
      const { terminal } = await host.execute(
        consumer,
        `nonbinding-spec-${consumer}`,
        contextInput([ref, host.product("decide")])
      );
      output(terminal);
      const state = host.checkpointer.loadRunById(`nonbinding-spec-${consumer}`);
      if (state === undefined) throw new Error("Missing context consumer");
      expect(
        state.selectedArtifacts.some((input) => input.kind === "plan-specification-source-index")
      ).toBe(false);
      const assurance = state.selectedArtifacts.find(
        (input) => input.kind === "composition-assurance"
      );
      if (assurance === undefined) throw new Error("Missing native assurance");
      expect(host.artifacts.read(assurance).toString("utf8")).toContain('"mode":"not_applicable"');
    }
  });

  it("refuses missing native requests and required ports despite valid context", () => {
    const host = owner();
    const ref = host.product("plan");
    for (const skill of skills.filter((skill) => skill !== "research")) {
      const request = host.start(skill, `missing-native-${skill}`, contextInput([ref]));
      request.constraints = {};
      expect(() => host.engine(skill).handle(request)).toThrow();
      expect(host.checkpointer.runExists(request.identity.run_id)).toBe(false);
    }
    const contract = structuredClone(host.engine("research").contract);
    const port = contract.io.input_ports.find((port) => port.semantic_product);
    if (port === undefined) throw new Error("Missing native fixture port");
    port.min_items = 1;
    expect(() =>
      validateSemanticComposition({
        contract,
        inputArtifacts: contextInput([host.product("research")]),
        artifactReader: host.artifacts,
        acceptContextProduct: () => {},
      })
    ).toThrow(/COMPOSITION_PORT_CARDINALITY/u);
  });

  it("preserves strict reviewed-definition refusal instead of treating Specification context as a binding subject", () => {
    const host = owner();
    const native = host.product("define");
    const unaccepted = host.artifacts.persist({
      metadata: {
        ...host.artifacts.metadata(native),
        run_id: "unaccepted-spec",
        operation_id: "unaccepted-spec",
      },
      content: host.artifacts.read(native),
    });
    const request = host.start("plan", "strict-unaccepted", {
      schema_version: 2,
      artifacts: [
        { slot: "prior-specification", designation: "binding", ref: unaccepted },
        { slot: "context", designation: "context", ref: native },
      ],
    });
    request.constraints = {
      schema_version: 2,
      request: request.constraints,
      specification_assurance: "reviewed_definition",
    };
    expect(() => host.engine("plan").handle(request)).toThrow(/SPECIFICATION_ASSURANCE/u);
    expect(host.checkpointer.runExists("strict-unaccepted")).toBe(false);
    const revise = host.start("define", "revise-context-only", contextInput([native]));
    revise.constraints = { ...revise.constraints, mode: "revise" };
    expect(() => host.engine("define").handle(revise)).toThrow();
  });

  it("refuses unaccepted, noncanonical, stale, wrong-identity and corrupt context before run creation", () => {
    const host = owner();
    const valid = host.product("assess");
    const copied = host.artifacts.persist({
      metadata: { ...host.artifacts.metadata(valid), run_id: "unaccepted", operation_id: "copy" },
      content: host.artifacts.read(valid),
    });
    const pretty = host.artifacts.persist({
      metadata: { ...host.artifacts.metadata(valid), operation_id: "noncanonical" },
      content: `${host.artifacts.read(valid).toString("utf8")}\n`,
    });
    for (const [index, ref] of [
      copied,
      pretty,
      { ...valid, content_digest: "0".repeat(64) },
      { ...valid, kind: "agent-output" },
    ].entries()) {
      const request = host.start("produce", `invalid-context-${index}`, contextInput([ref]));
      expect(() => host.engine("produce").handle(request)).toThrow();
      expect(host.checkpointer.runExists(request.identity.run_id)).toBe(false);
    }
    const file = path.join(
      host.root,
      "artifacts",
      "objects",
      "sha256",
      valid.content_digest.slice(0, 2),
      valid.content_digest.slice(2)
    );
    const original = readFileSync(file);
    try {
      writeFileSync(file, "corrupt");
      expect(() =>
        host
          .engine("produce")
          .handle(host.start("produce", "corrupt-context", contextInput([valid])))
      ).toThrow();
    } finally {
      writeFileSync(file, original);
    }
    expect(host.checkpointer.runExists("corrupt-context")).toBe(false);
  });

  it("never falls back from a native binding to context and rejects designation changes or mixed duplicates", () => {
    const host = owner();
    const ref = host.product("plan");
    const binding = {
      schema_version: 2 as const,
      artifacts: [{ slot: "native", designation: "binding" as const, ref }],
    };
    expect(() =>
      host.engine("produce").handle(host.start("produce", "no-type-fallback", binding))
    ).toThrow();
    expect(() =>
      host.engine("plan").handle(
        host.start("plan", "mixed", {
          schema_version: 2,
          artifacts: [...binding.artifacts, ...contextInput([ref]).artifacts],
        })
      )
    ).toThrow(/COMPOSITION_INPUT_DUPLICATE/u);
    const request = host.start("produce", "matrix-plan-produce", binding);
    expect(() => host.engine("produce").handle(request)).toThrow();
    expect(PLAYBOOK_REGISTRY.get("produce")?.contract.io.input_ports).toEqual([]);
  });
});
