import {
  parseJson,
  requireArray,
  requireBoolean,
  requireRecord,
  requireString,
  requireValue,
} from "./helpers/narrowing.js";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  CheckpointIdentityError,
  Checkpointer,
  ReceiptConflictError,
  canonicalJson,
} from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import {
  ConfidenceSchema,
  PhaseResultSchema,
  type Directive,
  type JsonValue,
  type PhaseResult,
  type RunIdentity,
  validateContract,
} from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { LivenessController, researchLivenessPolicy } from "../src/liveness.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../src/model-client.js";
import { researchSummarySchema } from "../src/playbooks/research.js";
import { resolvePlaybook } from "../src/playbooks/registry.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";
import { researchSemanticDraftFixture } from "./helpers/research-semantic-draft.js";

interface ResearchContractFixture {
  confidence: { valid: unknown[]; invalid: unknown[] };
  terminal_truth: Array<{
    id: string;
    met: boolean;
    action: string;
    status: string;
  }>;
}

function parseResearchContractFixture(value: unknown): ResearchContractFixture {
  const fixture = requireRecord(value, "research contract fixture");
  const confidence = requireRecord(fixture["confidence"], "research fixture confidence");
  return {
    confidence: {
      valid: requireArray(confidence["valid"], "research fixture confidence.valid"),
      invalid: requireArray(confidence["invalid"], "research fixture confidence.invalid"),
    },
    terminal_truth: requireArray(fixture["terminal_truth"], "research fixture terminal_truth").map(
      (entry, index) => {
        const terminal = requireRecord(entry, `research fixture terminal_truth[${index}]`);
        return {
          id: requireString(terminal["id"], `terminal_truth[${index}].id`),
          met: requireBoolean(terminal["met"], `terminal_truth[${index}].met`),
          action: requireString(terminal["action"], `terminal_truth[${index}].action`),
          status: requireString(terminal["status"], `terminal_truth[${index}].status`),
        };
      }
    ),
  };
}

const researchContractFixture = parseResearchContractFixture(
  parseJson(readFileSync(new URL("./fixtures/research-contract-v1.json", import.meta.url), "utf8"))
);

const tempDirectories: string[] = [];

function tempRoot(prefix = "penny-parity-"): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identity(runId: string, playbook = "research"): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: "parity-session",
    playbook,
    engine_owner: "typescript",
  };
}

function start(
  root: string,
  runIdentity: RunIdentity,
  constraints: Record<string, JsonValue>,
  trustProfile: "trusted-interactive" | "hardened-untrusted" = "trusted-interactive"
): unknown {
  return {
    schema_version: 2,
    action: "start",
    identity: runIdentity,
    goal: "compare two durable research systems",
    constraints,
    project_root: root,
    trust_profile: trustProfile,
  };
}

function runtime(root: string): {
  artifacts: ArtifactStore;
  checkpointer: Checkpointer;
  engine: OrchestrationEngine;
} {
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
  return {
    artifacts,
    checkpointer,
    engine: new OrchestrationEngine(checkpointer, {
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      projectRoot: root,
      maxSteps: 96,
      artifactRevisions: artifacts,
      artifactStore: artifacts,
      artifactReader: artifacts,
    }),
  };
}

function configuredWorkers(
  root: string,
  engine: OrchestrationEngine,
  artifacts: ArtifactStore,
  client: ModelClient = new ScenarioClient({ artifacts })
): WorkerExecutor {
  const workers = new WorkerExecutor(client, artifacts, {
    projectRoot: root,
    parallelConcurrency: 2,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  return workers;
}

class ScenarioClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];

  constructor(
    private readonly options: {
      critiqueVerdict?: "APPROVE" | "NEEDS_REVISION";
      validationVerdict?: "PASS" | "FAIL";
      invalidDraft?: boolean;
      researchDelayMs?: number;
      onResearchStart?: () => void;
      onResearchEnd?: () => void;
      planSteps?: string[];
      declaredMode?: "quick" | "standard" | "deep";
      artifacts?: ArtifactStore;
    } = {}
  ) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    if (invocation.stateId === "researching" && this.options.researchDelayMs) {
      this.options.onResearchStart?.();
      await new Promise((resolve) => setTimeout(resolve, this.options.researchDelayMs));
      this.options.onResearchEnd?.();
    }
    switch (invocation.stateId) {
      case "planning": {
        const details = {
          plan_steps: this.options.planSteps ?? ["sub-query one", "sub-query two"],
          plan_complete: true,
          ...(this.options.declaredMode === undefined ? {} : { mode: this.options.declaredMode }),
        };
        return {
          text: `research plan\nSUMMARY:${JSON.stringify({ confidence: "CERTAIN", ...details })}`,
          confidence: "CERTAIN",
          details,
        };
      }
      case "critiquing_plan":
      case "critiquing_report": {
        const details = {
          verdict: this.options.critiqueVerdict ?? "APPROVE",
          issues:
            (this.options.critiqueVerdict ?? "APPROVE") === "APPROVE"
              ? []
              : [`issue-${invocation.stateId}`],
          evidence: ["reviewed exact artifact"],
        };
        return {
          text: `critique\nSUMMARY:${JSON.stringify({ confidence: "CERTAIN", ...details })}`,
          confidence: "CERTAIN",
          details,
        };
      }
      case "researching":
        return {
          text: `cited findings: ${invocation.task}\nSUMMARY:{"confidence":"PROBABLE","explore_complete":true}`,
          confidence: "PROBABLE",
          details: { explore_complete: true },
        };
      case "synthesizing": {
        const artifacts = this.options.artifacts;
        if (artifacts === undefined) throw new Error("scenario semantic draft store is absent");
        const draft = researchSemanticDraftFixture(invocation, artifacts, {
          title: "Research parity synthesis",
          executiveSummary: "The P3 semantic product is grounded.",
          sectionBody: "The fixture finding is grounded.",
          ...(this.options.invalidDraft === undefined
            ? {}
            : { absentExcerpt: this.options.invalidDraft }),
        });
        return {
          text: `${canonicalJson(draft)}\nSUMMARY:{"confidence":"PROBABLE","synthesis_complete":true}`,
          confidence: "PROBABLE",
          details: { synthesis_complete: true },
        };
      }
      case "validating": {
        const verdict = this.options.validationVerdict ?? "PASS";
        const details = {
          verdict,
          unsupported_claims: verdict === "PASS" ? [] : ["claim-x"],
          evidence: ["checked source-x"],
        };
        return {
          text: `claim-source verification\nSUMMARY:${JSON.stringify({ confidence: "CERTAIN", ...details })}`,
          confidence: "CERTAIN",
          details,
        };
      }
    }
    throw new Error(`unexpected scenario state '${invocation.stateId}'`);
  }
}

function canonicalDirective(current: Directive): string {
  if (current.action === "invoke_agent") {
    return `invoke_agent:${current.state_id}:${current.agent}`;
  }
  if (current.action === "invoke_agents_parallel") {
    return `invoke_agents_parallel:${current.state_id}:${current.branches
      .map((branch) => branch.agent)
      .join(",")}`;
  }
  if (current.action === "await_user") {
    return `await_user:${current.state_id}`;
  }
  return `${current.action}:${current.action}`;
}

async function typescriptHappyTrace(mode: "quick" | "standard" | "deep"): Promise<string[]> {
  const root = tempRoot(`penny-ts-${mode}-`);
  const { artifacts, checkpointer, engine } = runtime(root);
  const workers = new WorkerExecutor(new ScenarioClient({ artifacts }), artifacts, {
    projectRoot: root,
    parallelConcurrency: 2,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  let current = engine.handle(start(root, identity(`ts-${mode}`), { mode }));
  const trace = [canonicalDirective(current)];
  while (current.action === "invoke_agent" || current.action === "invoke_agents_parallel") {
    const phaseResults = await workers.execute(current);
    for (const phaseResult of phaseResults) {
      current = engine.handle({
        schema_version: 2,
        action: "step",
        identity: current.identity,
        result: phaseResult,
      });
    }
    trace.push(canonicalDirective(current));
  }
  checkpointer.close();
  return trace;
}

describe("frozen research contract fixture", () => {
  it.each(researchContractFixture.confidence.valid)("accepts declared confidence %s", (value) => {
    expect(validateContract(ConfidenceSchema, value, "confidence")).toBe(value);
  });

  it.each(researchContractFixture.confidence.invalid)("rejects invalid confidence %s", (value) => {
    expect(() => validateContract(ConfidenceSchema, value, "confidence")).toThrow();
  });

  it("enforces start/step/status identity and exact recovery cases", async () => {
    const root = tempRoot();
    const { artifacts, checkpointer, engine } = runtime(root);
    const workers = configuredWorkers(root, engine, artifacts);
    const runIdentity = identity("fixture-identity");
    const initial = engine.handle(start(root, runIdentity, { mode: "quick" }));
    expect(() => engine.handle(start(root, runIdentity, { mode: "quick" }))).toThrow(
      CheckpointIdentityError
    );
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "status",
        identity: { ...runIdentity, playbook: "different" },
      })
    ).toThrow(CheckpointIdentityError);
    if (initial.action !== "invoke_agent") {
      throw new Error("expected quick research directive");
    }
    const validResult = requireValue(
      (await workers.execute(initial))[0],
      "apps/orchestration/tests/research-parity.test.ts:262"
    );
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: { ...runIdentity, session_id: "different" },
        result: validResult,
      })
    ).toThrow(CheckpointIdentityError);
    const recovered = engine.handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    expect(recovered).toMatchObject({ action: "invoke_agent", state_id: initial.state_id });
    if (recovered.action !== "invoke_agent") throw new Error("expected recovered invocation");
    expect(recovered.output_artifact.version).toBe(initial.output_artifact.version + 1);
    expect(recovered.output_artifact.parent_ref).toEqual(validResult.output_artifact);
    checkpointer.close();
  });

  it("returns a non-mutating PLAYBOOK_UNAVAILABLE recovery tombstone", () => {
    const root = tempRoot();
    const { checkpointer, engine } = runtime(root);
    const retiredIdentity = identity("retired-run", "retired-playbook");
    const context = RunContext.create({
      identity: retiredIdentity,
      goal: "legacy goal",
      constraints: {},
      projectRoot: root,
      trustProfile: "trusted-interactive",
      maxSteps: 96,
    });
    checkpointer.createRun(context, "seeded_retired", {
      run_id: retiredIdentity.run_id,
    });
    const before = context.snapshot();
    const tombstone = engine.handle({
      schema_version: 2,
      action: "recover",
      identity: retiredIdentity,
    });
    expect(tombstone.action).toBe("error");
    if (tombstone.action === "error") {
      expect(tombstone.result.code).toBe("PLAYBOOK_UNAVAILABLE");
    }
    expect(checkpointer.loadRun(retiredIdentity).snapshot()).toEqual(before);
    expect(checkpointer.events(retiredIdentity.run_id)).toHaveLength(1);
    checkpointer.close();
  });

  it("binds dynamic branches to branch, agent, run, state, attempt, and receipt", async () => {
    const root = tempRoot();
    const { artifacts, checkpointer, engine } = runtime(root);
    const workers = configuredWorkers(root, engine, artifacts);
    const runIdentity = identity("fixture-provenance");
    const plan = engine.handle(start(root, runIdentity, { mode: "standard" }));
    if (plan.action !== "invoke_agent") {
      throw new Error("expected planning directive");
    }
    const fan = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: requireValue(
        (await workers.execute(plan))[0],
        "apps/orchestration/tests/research-parity.test.ts:324"
      ),
    });
    if (fan.action !== "invoke_agents_parallel") {
      throw new Error("expected research fan");
    }
    const valid = requireValue(
      (await workers.execute(fan))[0],
      "apps/orchestration/tests/research-parity.test.ts:329"
    );
    const mutations: PhaseResult[] = [
      { ...valid, branch_id: "wrong-branch" },
      {
        ...valid,
        agent: "synthia",
        worker_receipt: { ...valid.worker_receipt, agent: "synthia" },
      },
      {
        ...valid,
        run_id: "wrong-run",
        worker_receipt: { ...valid.worker_receipt, run_id: "wrong-run" },
      },
      {
        ...valid,
        state_id: "wrong-state",
        worker_receipt: { ...valid.worker_receipt, state_id: "wrong-state" },
      },
      {
        ...valid,
        attempt: valid.attempt + 1,
        worker_receipt: {
          ...valid.worker_receipt,
          attempt: valid.worker_receipt.attempt + 1,
        },
      },
    ];
    for (const mutation of mutations) {
      expect(() =>
        engine.handle({
          schema_version: 2,
          action: "step",
          identity: runIdentity,
          result: mutation,
        })
      ).toThrow();
    }
    expect(() =>
      validateContract(
        PhaseResultSchema,
        { ...valid, worker_receipt: undefined },
        "missing receipt"
      )
    ).toThrow();
    expect(() =>
      validateContract(researchSummarySchema("researching"), {}, "empty contract")
    ).toThrow();
    engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: valid,
    });
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result: {
          ...valid,
          worker_receipt: {
            ...valid.worker_receipt,
            receipt_id: `receipt_${"f".repeat(64)}`,
          },
        },
      })
    ).toThrow();
    expect(Object.keys(researchSummarySchema("researching"))).not.toHaveLength(0);
    checkpointer.close();
  });

  it.each(researchContractFixture.terminal_truth)(
    "$id preserves complete/incomplete terminal truth",
    async (scenario) => {
      const root = tempRoot();
      const { artifacts, checkpointer, engine } = runtime(root);
      const validationVerdict =
        scenario.met || scenario.id === "TERM-MALFORMED-DRAFT" ? "PASS" : "FAIL";
      const client = new ScenarioClient({
        validationVerdict,
        invalidDraft: scenario.id === "TERM-MALFORMED-DRAFT",
        artifacts,
      });
      const terminal = await new OrchestrationRunner(
        engine,
        new WorkerExecutor(client, artifacts, {
          projectRoot: root,
          parallelConcurrency: 2,
        })
      ).runUntilBoundary(
        engine.handle(
          start(root, identity(`terminal-${scenario.id}`), {
            mode: "quick",
            max_iterations: 1,
          })
        )
      );
      expect(terminal.action).toBe(scenario.action);
      if (
        terminal.action === "complete" ||
        terminal.action === "incomplete" ||
        terminal.action === "error" ||
        terminal.action === "cancelled"
      ) {
        expect(terminal.status).toBe(scenario.status);
        expect(terminal.met).toBe(scenario.met);
        expect(terminal.result).not.toHaveProperty("rigor_escalated");
      }
      checkpointer.close();
    }
  );
});

describe("Research host inference effort", () => {
  it.each([
    ["quick", "low"],
    ["standard", "high"],
    ["deep", "xhigh"],
  ] as const)("propagates %s as invocation-level %s thinking", async (mode, expected) => {
    const root = tempRoot(`penny-thinking-${mode}-`);
    const { artifacts, checkpointer, engine } = runtime(root);
    const client = new ScenarioClient({ artifacts });
    const workers = configuredWorkers(root, engine, artifacts, client);
    workers.setLivenessController(engine.liveness);
    const pending = engine.handle(start(root, identity(`thinking-${mode}`), { mode }));

    await workers.execute(pending);

    expect(client.invocations.map((invocation) => invocation.thinkingLevel)).toEqual([expected]);
    expect(engine.liveness.policy(`thinking-${mode}`)?.preset).toBe(mode);
    checkpointer.close();
  });

  it("fails closed before model work for an unknown bound Research preset", async () => {
    const root = tempRoot("penny-thinking-unknown-");
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const registration = requireValue(resolvePlaybook("research"), "research registration");
    const engine = new OrchestrationEngine(checkpointer, {
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      projectRoot: root,
      maxSteps: 96,
      artifactRevisions: artifacts,
      artifactStore: artifacts,
      artifactReader: artifacts,
      playbookRegistration: {
        ...registration,
        liveness: {
          ...registration.liveness,
          resolve: () => ({
            ...researchLivenessPolicy("quick"),
            preset: "future-preset",
          }),
        },
      },
    });
    const client = new ScenarioClient({ artifacts });
    const workers = configuredWorkers(root, engine, artifacts, client);
    workers.setLivenessController(engine.liveness);
    const pending = engine.handle(start(root, identity("thinking-unknown"), { mode: "quick" }));

    await expect(workers.execute(pending)).rejects.toThrow(
      "unknown research liveness preset 'future-preset'"
    );
    expect(client.invocations).toHaveLength(0);
    expect(
      checkpointer
        .events("thinking-unknown")
        .filter((event) => event.eventType === "liveness_invocation_admitted")
    ).toHaveLength(0);
    checkpointer.close();
  });

  it("uses bootstrap high, then Quick low after Piper durably declares the mode", async () => {
    const root = tempRoot("penny-thinking-bootstrap-");
    const { artifacts, checkpointer, engine } = runtime(root);
    const runIdentity = identity("thinking-bootstrap-quick");
    const client = new ScenarioClient({ artifacts, declaredMode: "quick" });
    const workers = configuredWorkers(root, engine, artifacts, client);
    workers.setLivenessController(engine.liveness);
    const planning = engine.handle(start(root, runIdentity, {}));

    expect(engine.liveness.policy(runIdentity.run_id)?.preset).toBe("bootstrap");
    const planningResults = await workers.execute(planning);
    expect(client.invocations.map((invocation) => invocation.thinkingLevel)).toEqual(["high"]);
    const next = engine.acceptWorkerResults(runIdentity, planningResults);
    for (const result of planningResults) workers.acceptArtifact(result);

    expect(engine.liveness.policy(runIdentity.run_id)?.preset).toBe("quick");
    await workers.execute(next);
    expect(client.invocations.slice(1).map((invocation) => invocation.thinkingLevel)).toEqual([
      "low",
      "low",
    ]);
    checkpointer.close();
  });

  it("reuses the durable Standard level on recovery and every parallel Echo branch", async () => {
    const root = tempRoot("penny-thinking-recovery-");
    const { artifacts, checkpointer, engine } = runtime(root);
    const runIdentity = identity("thinking-standard-recovery");
    const client = new ScenarioClient({ artifacts });
    const workers = configuredWorkers(root, engine, artifacts, client);
    workers.setLivenessController(engine.liveness);
    const planning = engine.handle(start(root, runIdentity, { mode: "standard" }));
    const planningResults = await workers.execute(planning);
    const parallel = engine.acceptWorkerResults(runIdentity, planningResults);
    for (const result of planningResults) workers.acceptArtifact(result);
    const recovered = engine.handle({
      schema_version: 2,
      action: "recover",
      identity: runIdentity,
    });
    expect(recovered).toEqual(parallel);

    const restartedLiveness = new LivenessController(checkpointer);
    expect(restartedLiveness.policy(runIdentity.run_id)?.preset).toBe("standard");
    workers.setLivenessController(restartedLiveness);
    const beforeParallel = client.invocations.length;
    await workers.execute(recovered);
    const parallelInvocations = client.invocations.slice(beforeParallel);

    expect(parallelInvocations).toHaveLength(2);
    expect(parallelInvocations.map((invocation) => invocation.stateId)).toEqual([
      "researching",
      "researching",
    ]);
    expect(parallelInvocations.map((invocation) => invocation.thinkingLevel)).toEqual([
      "high",
      "high",
    ]);
    checkpointer.close();
  });
});

describe("research behavioral parity", () => {
  const EXPECTED_TRACES = {
    quick: [
      "invoke_agent:researching:echo",
      "invoke_agent:synthesizing:synthia",
      "invoke_agent:validating:vera",
      "complete:complete",
    ],
    standard: [
      "invoke_agent:planning:piper",
      "invoke_agents_parallel:researching:echo,echo",
      "invoke_agent:synthesizing:synthia",
      "invoke_agent:validating:vera",
      "complete:complete",
    ],
    deep: [
      "invoke_agent:planning:piper",
      "invoke_agent:critiquing_plan:carren",
      "invoke_agents_parallel:researching:echo,echo",
      "invoke_agent:synthesizing:synthia",
      "invoke_agent:validating:vera",
      "invoke_agent:critiquing_report:carren",
      "complete:complete",
    ],
  } as const;

  it.each(["quick", "standard", "deep"] as const)(
    "matches the frozen TypeScript canonical happy-path trace for %s",
    async (mode) => {
      expect(await typescriptHappyTrace(mode)).toEqual(EXPECTED_TRACES[mode]);
    }
  );

  it("retries malformed results without advancing the checkpoint", async () => {
    const root = tempRoot();
    const { artifacts, checkpointer, engine } = runtime(root);
    const workers = configuredWorkers(root, engine, artifacts);
    const runIdentity = identity("malformed-retry");
    const pending = engine.handle(start(root, runIdentity, { mode: "quick" }));
    if (pending.action !== "invoke_agent") {
      throw new Error("expected research directive");
    }
    const malformed = {
      ...requireValue(
        (await workers.execute(pending))[0],
        "apps/orchestration/tests/research-parity.test.ts:487"
      ),
      details: {},
    };
    const retry = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: malformed,
    });
    expect(retry.action).toBe("invoke_agent");
    if (retry.action === "invoke_agent") {
      expect(retry.state_id).toBe(pending.state_id);
      expect(retry.attempt).toBe(pending.attempt + 1);
      expect(retry.execution_purpose).toBe("routing_repair");
      expect(retry.output_artifact.kind).toBe("routing-metadata");
      expect(retry.output_artifact.version).toBe(1);
      expect(retry.output_artifact.parent_ref).toBeNull();
      expect(retry.input_artifacts.artifacts).toEqual([
        { slot: "malformed-source", ref: malformed.output_artifact },
      ]);
    }
    expect(
      engine.handle({
        schema_version: 2,
        action: "recover",
        identity: runIdentity,
      })
    ).toEqual(retry);
    checkpointer.close();
  });

  it("rejects divergent replay while exact receipt replay is idempotent", async () => {
    const root = tempRoot();
    const { artifacts, checkpointer, engine } = runtime(root);
    const workers = configuredWorkers(root, engine, artifacts);
    const runIdentity = identity("divergent-replay");
    const pending = engine.handle(start(root, runIdentity, { mode: "quick" }));
    if (pending.action !== "invoke_agent") {
      throw new Error("expected research directive");
    }
    const accepted = requireValue(
      (await workers.execute(pending))[0],
      "apps/orchestration/tests/research-parity.test.ts:522"
    );
    const next = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: accepted,
    });
    expect(
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result: accepted,
      })
    ).toEqual(next);
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result: {
          ...accepted,
          details: { explore_complete: false },
        },
      })
    ).toThrow(ReceiptConflictError);
    checkpointer.close();
  });

  it("exhausts bounded critique and validation loops honestly", async () => {
    const root = tempRoot();
    const { artifacts, checkpointer, engine } = runtime(root);
    const terminal = await new OrchestrationRunner(
      engine,
      new WorkerExecutor(
        new ScenarioClient({
          critiqueVerdict: "NEEDS_REVISION",
          validationVerdict: "FAIL",
          artifacts,
        }),
        artifacts,
        { projectRoot: root, parallelConcurrency: 2 }
      )
    ).runUntilBoundary(
      engine.handle(
        start(root, identity("loop-exhaustion"), {
          mode: "deep",
          max_iterations: 1,
        })
      )
    );
    expect(terminal.action).toBe("incomplete");
    if (terminal.action === "incomplete") {
      expect(terminal.result.plan_critique_exhausted).toBe(true);
      expect(terminal.result.report_critique_exhausted).toBe(false);
      expect(terminal.result.validation_exhausted).toBe(true);
      expect(terminal.met).toBe(false);
    }
    checkpointer.close();
  });

  it("reissues a crash but terminalizes a durable worker timeout", async () => {
    for (const failure of ["crash", "timeout"] as const) {
      const root = tempRoot(`penny-${failure}-`);
      const { artifacts, checkpointer, engine } = runtime(root);
      const runIdentity = identity(`${failure}-replay`);
      const pending = engine.handle(start(root, runIdentity, { mode: "quick" }));
      let observedThinkingLevel: AgentInvocation["thinkingLevel"];
      const client: ModelClient = {
        async runAgent(invocation) {
          observedThinkingLevel = invocation.thinkingLevel;
          if (failure === "crash") {
            throw new Error("simulated worker crash");
          }
          await new Promise<void>((_resolve, reject) => {
            invocation.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
          throw new Error("unreachable");
        },
      };
      const runner = new OrchestrationRunner(
        engine,
        new WorkerExecutor(client, artifacts, {
          projectRoot: root,
          parallelConcurrency: 1,
          workerTimeoutMs: 10,
        })
      );
      if (failure === "crash") {
        await expect(runner.runUntilBoundary(pending)).rejects.toThrow("simulated worker crash");
        expect(
          engine.handle({
            schema_version: 2,
            action: "recover",
            identity: runIdentity,
          })
        ).toEqual(pending);
      } else {
        const exhausted = await runner.runUntilBoundary(pending);
        expect(exhausted.action).toBe("incomplete");
        if (exhausted.action === "incomplete") {
          expect(exhausted.result.terminal_reason).toBe("worker_wall_clock_exhausted");
        }
        expect(
          engine.handle({
            schema_version: 2,
            action: "recover",
            identity: runIdentity,
          })
        ).toEqual(exhausted);
      }
      expect(observedThinkingLevel).toBe("low");
      expect(engine.liveness.policy(runIdentity.run_id)).toMatchObject({
        preset: "quick",
        worker_wall_clock_ms: 5 * 60_000,
        run_wall_clock_ms: 15 * 60_000,
      });
      expect(
        checkpointer
          .events(runIdentity.run_id)
          .some((event) => event.eventType === "liveness_worker_ended")
      ).toBe(true);
      checkpointer.close();
    }
  });

  it("enforces the configured parallel concurrency bound", async () => {
    const root = tempRoot();
    const { artifacts, checkpointer, engine } = runtime(root);
    let active = 0;
    let maximum = 0;
    const client = new ScenarioClient({
      researchDelayMs: 15,
      onResearchStart: () => {
        active += 1;
        maximum = Math.max(maximum, active);
      },
      onResearchEnd: () => {
        active -= 1;
      },
      planSteps: ["one", "two", "three", "four", "five"],
      artifacts,
    });
    const terminal = await new OrchestrationRunner(
      engine,
      new WorkerExecutor(client, artifacts, {
        projectRoot: root,
        parallelConcurrency: 2,
      })
    ).runUntilBoundary(
      engine.handle(
        start(root, identity("bounded-fan"), {
          mode: "standard",
          max_sub_queries: 5,
          max_fan_width: 5,
        })
      )
    );
    expect(terminal.action).toBe("complete");
    expect(maximum).toBe(2);
    checkpointer.close();
  });
});
