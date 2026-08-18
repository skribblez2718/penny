import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  CheckpointIdentityError,
  Checkpointer,
  ReceiptConflictError,
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
import {
  parseSummaryFromText,
  type AgentCompletion,
  type AgentInvocation,
  type ModelClient,
} from "../src/model-client.js";
import { researchSummarySchema } from "../src/playbooks/research.js";
import { OrchestrationRunner, WorkerExecutor } from "../src/worker.js";

interface CorrectedFixture {
  confidence: { valid: unknown[]; invalid: unknown[] };
  terminal_truth: Array<{
    id: string;
    met: boolean;
    action: string;
    status: string;
  }>;
}

const correctedFixture = JSON.parse(
  readFileSync(new URL("./fixtures/corrected-python-contract-v1.json", import.meta.url), "utf8")
) as CorrectedFixture;

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
  checkpointer: Checkpointer;
  engine: OrchestrationEngine;
} {
  const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
  return {
    checkpointer,
    engine: new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 96,
    }),
  };
}

function configuredWorkers(
  root: string,
  engine: OrchestrationEngine,
  client: ModelClient = new ScenarioClient()
): WorkerExecutor {
  const workers = new WorkerExecutor(client, new ArtifactStore(path.join(root, "artifacts")), {
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
      writeComplete?: boolean;
      researchDelayMs?: number;
      onResearchStart?: () => void;
      onResearchEnd?: () => void;
      planSteps?: string[];
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
      case "planning":
        return {
          text: "research plan",
          confidence: "CERTAIN",
          details: {
            plan_steps: this.options.planSteps ?? ["sub-query one", "sub-query two"],
            plan_complete: true,
          },
        };
      case "critiquing_plan":
      case "critiquing_report":
        return {
          text: "critique",
          confidence: "CERTAIN",
          details: {
            verdict: this.options.critiqueVerdict ?? "APPROVE",
            issues:
              (this.options.critiqueVerdict ?? "APPROVE") === "APPROVE"
                ? []
                : [`issue-${invocation.stateId}`],
            evidence: ["reviewed exact artifact"],
          },
        };
      case "researching":
        return {
          text: `cited findings: ${invocation.task}`,
          confidence: "PROBABLE",
          details: { explore_complete: true },
        };
      case "synthesizing":
        return {
          text: "cited synthesis",
          confidence: "PROBABLE",
          details: { synthesis_complete: true },
        };
      case "validating": {
        const verdict = this.options.validationVerdict ?? "PASS";
        return {
          text: "claim-source verification",
          confidence: "CERTAIN",
          details: {
            verdict,
            unsupported_claims: verdict === "PASS" ? [] : ["claim-x"],
            evidence: ["checked source-x"],
          },
        };
      }
      case "report_writing":
        return {
          text: "# report.md\nReport\n# sources.md\nSources\n# README.md\nReadme",
          confidence: "CERTAIN",
          details: {
            write_complete: this.options.writeComplete ?? true,
          },
        };
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
  const { checkpointer, engine } = runtime(root);
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const workers = new WorkerExecutor(new ScenarioClient(), artifacts, {
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

function pythonHappyTrace(root: string, mode: "quick" | "standard" | "deep"): string[] {
  const script = String.raw`
import json, os, sys
from pathlib import Path
from orchestration.checkpointer import Checkpointer
from orchestration.playbooks.research import ResearchPlaybook
root, mode = sys.argv[1], sys.argv[2]
cp = Checkpointer(db_path=Path(root) / "python.db")
sid, rid = "parity-session", f"py-{mode}"
def canon(d):
    action = d["action"]
    if action == "invoke_agent": return f"invoke_agent:{d['state_id']}:{d['agent']}"
    if action == "invoke_agents_parallel": return f"invoke_agents_parallel:{d['state_id']}:" + ",".join(t["agent"] for t in d["tasks"])
    if action == "await_user": return f"await_user:{d['state_id']}"
    return f"{action}:{action}"
def step(agent, value):
    return ResearchPlaybook(cp).step(session_id=sid, run_id=rid, agent=agent, result=value)
d = ResearchPlaybook(cp).start(session_id=sid, run_id=rid, goal="compare two durable research systems", constraints={"mode": mode}, project_root=root)
trace=[canon(d)]
if mode != "quick":
    d=step("piper", {"plan_steps":["sub-query one","sub-query two"],"plan_complete":True,"confidence":"CERTAIN"}); trace.append(canon(d))
    if mode == "deep":
        d=step("carren", {"verdict":"APPROVE","issues":[],"evidence":["reviewed"],"confidence":"CERTAIN"}); trace.append(canon(d))
    d=step("__parallel__", [
      {"branch_id":"sq1","agent":"echo","exitCode":0,"summary":{"explore_complete":True,"confidence":"PROBABLE"}},
      {"branch_id":"sq2","agent":"echo","exitCode":0,"summary":{"explore_complete":True,"confidence":"PROBABLE"}},
    ]); trace.append(canon(d))
else:
    d=step("echo", {"explore_complete":True,"confidence":"PROBABLE"}); trace.append(canon(d))
d=step("synthia", {"synthesis_complete":True,"confidence":"PROBABLE"}); trace.append(canon(d))
if mode == "deep":
    d=step("carren", {"verdict":"APPROVE","issues":[],"evidence":["reviewed"],"confidence":"CERTAIN"}); trace.append(canon(d))
d=step("vera", {"verdict":"PASS","unsupported_claims":[],"evidence":["checked"],"confidence":"CERTAIN"}); trace.append(canon(d))
d=step("skribble", {"write_complete":True,"confidence":"CERTAIN"}); trace.append(canon(d))
print(json.dumps(trace))
`;
  const projectRoot = path.resolve("../..");
  const pythonPath = path.join(projectRoot, ".venv", "bin", "python");
  const output = execFileSync(pythonPath, ["-c", script, root, mode], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(projectRoot, "apps", "orchestration", "src"),
      PENNY_ARTIFACT_ROOT: path.join(root, "python-artifacts"),
      PENNY_RECEIPT_HMAC_KEY: "5a".repeat(32),
      PENNY_ORCH_TEST_ALLOW_PROGRAMMATIC_RESULTS: "1",
    },
    encoding: "utf8",
  });
  return JSON.parse(output) as string[];
}

describe("corrected Python contract fixture", () => {
  it.each(correctedFixture.confidence.valid)("accepts declared confidence %s", (value) => {
    expect(validateContract(ConfidenceSchema, value, "confidence")).toBe(value);
  });

  it.each(correctedFixture.confidence.invalid)("rejects invalid confidence %s", (value) => {
    expect(() => validateContract(ConfidenceSchema, value, "confidence")).toThrow();
  });

  it("enforces start/step/status identity and exact recovery cases", async () => {
    const root = tempRoot();
    const { checkpointer, engine } = runtime(root);
    const workers = configuredWorkers(root, engine);
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
    const validResult = (await workers.execute(initial))[0]!;
    expect(() =>
      engine.handle({
        schema_version: 2,
        action: "step",
        identity: { ...runIdentity, session_id: "different" },
        result: validResult,
      })
    ).toThrow(CheckpointIdentityError);
    expect(
      engine.handle({
        schema_version: 2,
        action: "recover",
        identity: runIdentity,
      })
    ).toEqual(initial);
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
    const { checkpointer, engine } = runtime(root);
    const workers = configuredWorkers(root, engine);
    const runIdentity = identity("fixture-provenance");
    const plan = engine.handle(start(root, runIdentity, { mode: "standard" }));
    if (plan.action !== "invoke_agent") {
      throw new Error("expected planning directive");
    }
    const fan = engine.handle({
      schema_version: 2,
      action: "step",
      identity: runIdentity,
      result: (await workers.execute(plan))[0]!,
    });
    if (fan.action !== "invoke_agents_parallel") {
      throw new Error("expected research fan");
    }
    const valid = (await workers.execute(fan))[0]!;
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

  it.each(correctedFixture.terminal_truth)(
    "$id preserves complete/incomplete terminal truth",
    async (scenario) => {
      const root = tempRoot();
      const { checkpointer, engine } = runtime(root);
      const validationVerdict =
        scenario.met || scenario.id === "TERM-FAILED-WRITE" ? "PASS" : "FAIL";
      const client = new ScenarioClient({
        validationVerdict,
        writeComplete: scenario.id !== "TERM-FAILED-WRITE",
      });
      const artifacts = new ArtifactStore(path.join(root, "artifacts"));
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
      }
      checkpointer.close();
    }
  );
});

describe("research behavioral parity", () => {
  it.each(["quick", "standard", "deep"] as const)(
    "matches the corrected Python canonical happy-path trace for %s",
    async (mode) => {
      const pythonRoot = tempRoot(`penny-python-${mode}-`);
      expect(await typescriptHappyTrace(mode)).toEqual(pythonHappyTrace(pythonRoot, mode));
    }
  );

  it("retries malformed results without advancing the checkpoint", async () => {
    const root = tempRoot();
    const { checkpointer, engine } = runtime(root);
    const workers = configuredWorkers(root, engine);
    const runIdentity = identity("malformed-retry");
    const pending = engine.handle(start(root, runIdentity, { mode: "quick" }));
    if (pending.action !== "invoke_agent") {
      throw new Error("expected research directive");
    }
    const malformed = {
      ...(await workers.execute(pending))[0]!,
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
      expect(retry.output_artifact.version).toBe(2);
      expect(retry.output_artifact.parent_ref).toEqual(malformed.output_artifact);
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
    const { checkpointer, engine } = runtime(root);
    const workers = configuredWorkers(root, engine);
    const runIdentity = identity("divergent-replay");
    const pending = engine.handle(start(root, runIdentity, { mode: "quick" }));
    if (pending.action !== "invoke_agent") {
      throw new Error("expected research directive");
    }
    const accepted = (await workers.execute(pending))[0]!;
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
    const { checkpointer, engine } = runtime(root);
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const terminal = await new OrchestrationRunner(
      engine,
      new WorkerExecutor(
        new ScenarioClient({
          critiqueVerdict: "NEEDS_REVISION",
          validationVerdict: "FAIL",
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
      expect(terminal.result.report_critique_exhausted).toBe(true);
      expect(terminal.result.validation_exhausted).toBe(true);
      expect(terminal.met).toBe(false);
    }
    checkpointer.close();
  });

  it("survives crash and timeout without consuming the pending assignment", async () => {
    for (const failure of ["crash", "timeout"] as const) {
      const root = tempRoot(`penny-${failure}-`);
      const { checkpointer, engine } = runtime(root);
      const runIdentity = identity(`${failure}-replay`);
      const pending = engine.handle(start(root, runIdentity, { mode: "quick" }));
      const client: ModelClient = {
        async runAgent(invocation) {
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
        new WorkerExecutor(client, new ArtifactStore(path.join(root, "artifacts")), {
          projectRoot: root,
          parallelConcurrency: 1,
          workerTimeoutMs: 10,
        })
      );
      await expect(runner.runUntilBoundary(pending)).rejects.toThrow();
      expect(
        engine.handle({
          schema_version: 2,
          action: "recover",
          identity: runIdentity,
        })
      ).toEqual(pending);
      expect(checkpointer.events(runIdentity.run_id)).toHaveLength(1);
      checkpointer.close();
    }
  });

  it("enforces the configured parallel concurrency bound", async () => {
    const root = tempRoot();
    const { checkpointer, engine } = runtime(root);
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
    });
    const terminal = await new OrchestrationRunner(
      engine,
      new WorkerExecutor(client, new ArtifactStore(path.join(root, "artifacts")), {
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

  it("uses a separate v2 database without mutating the legacy Python database", () => {
    const root = tempRoot();
    const legacyPath = path.join(root, "orchestration.db");
    const sentinel = "legacy-python-db-must-remain-unchanged";
    writeFileSync(legacyPath, sentinel);
    const { checkpointer, engine } = runtime(root);
    engine.handle(start(root, identity("separate-db"), { mode: "quick" }));
    expect(readFileSync(legacyPath, "utf8")).toBe(sentinel);
    expect(checkpointer.dbPath).toBe(path.join(root, "orchestration-v2.db"));
    checkpointer.close();
  });
});

describe("live summary parsing", () => {
  it("extracts the final balanced SUMMARY object without leaking body text", () => {
    const parsed = parseSummaryFromText(
      'Body with {braces}.\nSUMMARY: {"explore_complete":true,"confidence":"PROBABLE"}\n'
    );
    expect(parsed).toEqual({
      confidence: "PROBABLE",
      details: { explore_complete: true },
    });
  });

  it("fails closed on malformed or invalid-confidence summaries", () => {
    expect(() => parseSummaryFromText("no summary")).toThrow("missing");
    expect(() =>
      parseSummaryFromText('SUMMARY: {"explore_complete":true,"confidence":"likely"}')
    ).toThrow();
  });
});
