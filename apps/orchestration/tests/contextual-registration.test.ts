/** Synthetic extension conformance: real owners, scripted cognition, no permanent skill. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  ArtifactRefSchema,
  validateContract,
  Checkpointer,
  OrchestrationEngine,
  OrchestrationRunner,
  WorkerExecutor,
  canonicalJson,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type Directive,
  type InputArtifacts,
  type ModelClient,
  type StartRequest,
} from "../dist/index.js";
import {
  PLAYBOOK_REGISTRY,
  runtimeRegistrationSha256,
  validateRegistrationContract,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import { CORE_ONLY_REGISTRATION } from "./fixtures/core-only-playbook.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { ordinaryContextFixture } from "./helpers/ordinary-context-fixtures.js";

const registration: PlaybookRegistration = {
  ...CORE_ONLY_REGISTRATION,
  contextual_inputs: "accepted_terminal_products_v1",
};
const projectId = `prj_${"2".repeat(32)}`;
const outputText = 'Synthetic result.\nSUMMARY:{"confidence":"CERTAIN","complete":true}';
let root = "";
let checkpointer: Checkpointer | undefined;
let artifacts: ArtifactStore | undefined;
let accepted: ArtifactRef | undefined;
function store(): ArtifactStore {
  if (artifacts === undefined) throw new Error("Missing artifact owner");
  return artifacts;
}
function checkpoint(): Checkpointer {
  if (checkpointer === undefined) throw new Error("Missing checkpoint owner");
  return checkpointer;
}
function product(): ArtifactRef {
  if (accepted === undefined) throw new Error("Missing accepted producer");
  return accepted;
}
function identity(runId: string, playbook = registration.name) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook,
    engine_owner: "typescript" as const,
  };
}
function inputs(): InputArtifacts {
  return {
    schema_version: 2,
    artifacts: [{ slot: "explicit-context", designation: "context", ref: product() }],
  };
}
function engine(selected = registration): OrchestrationEngine {
  return new OrchestrationEngine(checkpoint(), {
    projectRoot: root,
    playbookName: selected.name,
    playbookRegistry: new Map([...PLAYBOOK_REGISTRY, [selected.name, selected]]),
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactStore: store(),
    artifactReader: store(),
    artifactRevisions: store(),
    assuranceProjectId: projectId,
  });
}
function start(runId: string, constraints = {}): StartRequest {
  return {
    schema_version: 2,
    action: "start",
    identity: identity(runId),
    goal: "Exercise a synthetic registered consumer without granting context authority.",
    constraints,
    project_root: root,
    trust_profile: "hardened-untrusted",
    input_artifacts: inputs(),
  };
}
function invocation(directive: Directive): Extract<Directive, { action: "invoke_agent" }> {
  if (directive.action !== "invoke_agent") throw new Error(`Unexpected ${directive.action}`);
  return directive;
}
class Client implements ModelClient {
  readonly calls: AgentInvocation[] = [];
  constructor(private readonly outputs: readonly string[]) {}
  async runAgent(input: AgentInvocation): Promise<AgentCompletion> {
    this.calls.push(input);
    for (const ref of input.inputArtifacts) store().read(ref);
    const text = this.outputs[this.calls.length - 1];
    if (text === undefined) throw new Error("Unexpected synthetic worker");
    return { text };
  }
}
function workers(runtime: OrchestrationEngine, client: ModelClient): WorkerExecutor {
  const worker = new WorkerExecutor(client, store(), {
    projectRoot: root,
    parallelConcurrency: 1,
    registration: runtime.registration,
  });
  worker.setReceiptAuthority(runtime.receiptAuthority);
  worker.setLivenessController(runtime.liveness);
  return worker;
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "penny-context-extension-"));
  artifacts = new ArtifactStore(path.join(root, "artifacts"), { projectId });
  checkpointer = new Checkpointer(path.join(root, "orchestration.db"), undefined, { projectId });
  const runtime = engine();
  const producer = new OrchestrationEngine(checkpoint(), {
    projectRoot: root,
    playbookName: "plan",
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactStore: store(),
    artifactReader: store(),
    artifactRevisions: store(),
    assuranceProjectId: projectId,
  });
  const fixture = ordinaryContextFixture("plan");
  const terminal = await new OrchestrationRunner(
    producer,
    workers(producer, new Client(fixture.outputs))
  ).runUntilBoundary(
    producer.handle({
      schema_version: 2,
      action: "start",
      identity: identity("accepted-plan", "plan"),
      goal: fixture.goal,
      constraints: fixture.constraints,
      project_root: root,
      trust_profile: "hardened-untrusted",
    })
  );
  if (terminal.action !== "complete" || !terminal.met)
    throw new Error(`Producer failed: ${canonicalJson(terminal)}`);
  accepted = validateContract(
    ArtifactRefSchema,
    terminal.result.output_artifact_ref,
    "accepted producer product"
  );
  store().read(accepted);
  product();
  validateRegistrationContract(runtime.registration);
});
afterAll(() => {
  checkpointer?.close();
  artifacts?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("synthetic contextual registration through existing owners", () => {
  it("binds the opt-in capability without permanent catalog growth or native-port changes", () => {
    expect(PLAYBOOK_REGISTRY.has(registration.name)).toBe(false);
    expect(registration.contract).toBe(CORE_ONLY_REGISTRATION.contract);
    expect(runtimeRegistrationSha256(registration)).not.toBe(
      runtimeRegistrationSha256(CORE_ONLY_REGISTRATION)
    );
    expect(() => engine(CORE_ONLY_REGISTRATION).handle(start("not-opted-in"))).toThrow(
      /COMPOSITION_CONTEXT_UNACCEPTED/u
    );
    expect(checkpoint().runExists("not-opted-in")).toBe(false);
    expect(() => engine().handle(start("bad-native", { injected: true }))).toThrow(
      /closed empty object/u
    );
    expect(checkpoint().runExists("bad-native")).toBe(false);
  });

  it("binds guidance metadata, exact contextual custody, signed output and host completion", async () => {
    const runtime = engine();
    const pending = invocation(runtime.handle(start("synthetic-complete")));
    expect(pending.input_artifacts).toEqual(inputs());
    expect(pending.output_artifact.upstream_refs).not.toContainEqual(product());
    expect(pending.task).toContain("NONBINDING");
    const client = new Client([outputText]);
    const worker = workers(runtime, client);
    const result = (await worker.execute(pending))[0];
    if (result === undefined) throw new Error("Missing exact worker result");
    expect(store().read(result.output_artifact).toString("utf8")).toBe(outputText);
    expect(runtime.receiptAuthority.verify(result.worker_receipt)).toEqual(result.worker_receipt);
    const terminal = runtime.handle({
      schema_version: 2,
      action: "step",
      identity: identity("synthetic-complete"),
      result,
    });
    worker.acceptArtifact(result);
    expect(terminal).toMatchObject({ action: "complete", status: "complete", met: true });
    expect(checkpoint().completionAdmission("synthetic-complete")).toMatchObject({
      origin_state: "planning",
      latest_product: { selector: "terminal_result" },
    });
    expect(client.calls[0]?.registration).toMatchObject({
      workflow_name: registration.name,
      guidance: registration.contract.guidance,
      opening_policy: "registration_guidance_task_artifacts",
    });
    expect(client.calls[0]?.stateId).toBe("planning");
    expect(
      engine().handle({
        schema_version: 2,
        action: "recover",
        identity: identity("synthetic-complete"),
      })
    ).toEqual(terminal);
  });

  it("preserves exact context across a checkpoint reopen and fences cancellation", async () => {
    const first = invocation(engine().handle(start("synthetic-cancel")));
    checkpoint().close();
    checkpointer = new Checkpointer(path.join(root, "orchestration.db"), undefined, { projectId });
    const runtime = engine();
    const recovered = invocation(
      runtime.handle({
        schema_version: 2,
        action: "recover",
        identity: identity("synthetic-cancel"),
      })
    );
    expect(recovered).toEqual(first);
    expect(checkpoint().loadRun(identity("synthetic-cancel")).admittedInputArtifacts).toEqual(
      inputs()
    );
    const worker = workers(runtime, new Client([outputText]));
    const result = (await worker.execute(recovered))[0];
    if (result === undefined) throw new Error("Missing late output fixture");
    const cancelled = runtime.handle({
      schema_version: 2,
      action: "cancel",
      identity: identity("synthetic-cancel"),
      reason: "Operator cancellation before result acceptance",
    });
    expect(cancelled).toMatchObject({ action: "cancelled", met: false });
    expect(() =>
      runtime.handle({
        schema_version: 2,
        action: "step",
        identity: identity("synthetic-cancel"),
        result,
      })
    ).toThrow(/already terminal/u);
    expect(
      runtime.handle({
        schema_version: 2,
        action: "recover",
        identity: identity("synthetic-cancel"),
      })
    ).toEqual(cancelled);
    expect(checkpoint().completionAdmission("synthetic-cancel")).toBeUndefined();
  });
});
