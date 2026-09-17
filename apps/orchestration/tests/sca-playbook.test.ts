import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OrchestrationService,
  initializePennyState,
  type AgentCompletion,
  type AgentInvocation,
  type Directive,
  type JsonValue,
  type ModelClient,
} from "../src/index.js";
import { computeScaSourceSnapshotSha256, SCA_PLAYBOOK_REGISTRATION } from "../src/playbooks/sca.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
let sourceRoot = "";
let sequence = 0;

function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-playbook-"));
  roots.push(root);
  sourceRoot = path.join(root, "source");
  mkdirSync(sourceRoot);
  writeFileSync(path.join(sourceRoot, "fixture.ts"), "exec(userInput);\neval(userInput);\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  return env;
}

function identity(runId: string) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook: "sca",
    engine_owner: "typescript" as const,
  };
}

function start(runId: string) {
  const bytes = readFileSync(path.join(sourceRoot, "fixture.ts"));
  const scope = { include: [] as string[], exclude: [] as string[] };
  const sourceSnapshotSha256 = computeScaSourceSnapshotSha256({
    scope,
    files: [
      {
        path: "fixture.ts",
        byte_length: bytes.byteLength,
        content_sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  });
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: identity(runId),
    goal: "Assess the admitted repository snapshot for source-composition security weaknesses.",
    constraints: {
      schema_version: 1,
      source_root: sourceRoot,
      source_snapshot_sha256: sourceSnapshotSha256,
      scope,
      execution_mode: "static_only",
      primary_a_model: "provider/model-a",
      primary_b_model: "provider/model-b",
      critic_model: "provider/model-c",
    },
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
  };
}

function summary(value: Record<string, JsonValue>, body = "Stage output."): string {
  return `${body}\nSUMMARY:${JSON.stringify({ ...value, confidence: "PROBABLE" })}`;
}

class ScriptedScaClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private finalVerificationIndex = 0;

  constructor(
    private readonly consensus: "PASS" | "GAP" = "PASS",
    private readonly finalVerification: readonly ("PASS" | "GAP")[] = ["PASS"]
  ) {}

  runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    if (invocation.stateId === "inventorying_static") {
      return Promise.resolve({
        text: summary({ complete: true, candidate_count: 1, analysis_gaps: [] }, "Inventory."),
      });
    }
    if (invocation.stateId === "analyzing_candidates") {
      const profile = invocation.task.includes("primary_a") ? "primary_a" : "primary_b";
      return Promise.resolve({
        text: summary(
          {
            complete: true,
            profile_id: profile,
            confirmed_count: 1,
            rejected_count: 0,
            inconclusive_count: 0,
            gaps: [],
          },
          `${profile} analysis.`
        ),
      });
    }
    if (invocation.stateId === "reviewing_consensus") {
      return Promise.resolve({
        text: summary(
          {
            verdict: this.consensus,
            finding_count: this.consensus === "PASS" ? 1 : 0,
            gaps: this.consensus === "PASS" ? [] : ["Primary analyses conflict."],
          },
          "Consensus review."
        ),
      });
    }
    if (invocation.stateId === "materializing_report") {
      return Promise.resolve({
        text: summary(
          { complete: true },
          "# SCA report\n\nOne validated high-severity finding. Analysis completion does not prove the repository vulnerability-free."
        ),
      });
    }
    if (invocation.stateId === "verifying_final_product") {
      const verdict = this.finalVerification[this.finalVerificationIndex] ?? "PASS";
      this.finalVerificationIndex += 1;
      return Promise.resolve({
        text: summary(
          { verdict, gaps: verdict === "PASS" ? [] : ["Report count is inconsistent."] },
          `Final ${verdict}.`
        ),
      });
    }
    throw new Error(`unexpected SCA state '${invocation.stateId}'`);
  }
}

type TerminalDirective = Extract<Directive, { result: Record<string, JsonValue> }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function terminal(value: Directive, action: "complete" | "incomplete"): TerminalDirective {
  if (value.action !== action) {
    throw new Error(`expected ${action} directive, received '${value.action}'`);
  }
  return value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("S-09 SCA skill playbook", () => {
  it("runs inventory, two pinned primary branches, critic review, report verification, and release gate", async () => {
    const client = new ScriptedScaClient();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: SCA_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-sca-happy-${sequence}`;
    const awaiting = await service.execute(start(runId));
    expect(awaiting.action).toBe("await_user");
    if (awaiting.action !== "await_user") throw new Error("SCA release gate was not reached");
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_candidates",
      "analyzing_candidates",
      "reviewing_consensus",
      "materializing_report",
      "verifying_final_product",
    ]);
    expect(
      client.invocations
        .filter((invocation) => invocation.stateId === "analyzing_candidates")
        .map((invocation) => invocation.modelOverride)
        .sort()
    ).toEqual(["provider/model-a", "provider/model-b"]);
    expect(
      client.invocations
        .filter(
          (invocation) =>
            invocation.stateId === "reviewing_consensus" ||
            invocation.stateId === "verifying_final_product"
        )
        .map((invocation) => invocation.modelOverride)
    ).toEqual(["provider/model-c", "provider/model-c"]);
    expect(
      client.invocations.find((invocation) => invocation.stateId === "reviewing_consensus")?.task
    ).toContain("concrete adverse security consequences");
    expect(
      client.invocations.find((invocation) => invocation.stateId === "analyzing_candidates")?.task
    ).toContain("do not create a supplemental or unadjudicated tier");
    const run = service.checkpointer.loadRunById(runId);
    const inventory = run?.selectedArtifacts.find(
      (artifact) => artifact.phase === "inventorying_static"
    );
    if (inventory === undefined) throw new Error("SCA static inventory artifact is absent");
    const inventoryContent: unknown = JSON.parse(
      service.artifacts.readById(inventory.artifact_id).toString("utf8")
    );
    if (!isRecord(inventoryContent) || !Array.isArray(inventoryContent.candidates)) {
      throw new Error("SCA static inventory content is malformed");
    }
    expect(inventoryContent).toMatchObject({
      model_invocation_count: 0,
      source_snapshot_sha256: inventoryContent.computed_source_snapshot_sha256,
    });
    expect(
      inventoryContent.candidates.map((candidate) =>
        isRecord(candidate) ? candidate.rule_id : undefined
      )
    ).toEqual(["javascript.child-process-exec", "javascript.dynamic-eval"]);
    const report = run?.selectedArtifacts.find(
      (artifact) => artifact.phase === "materializing_report"
    );
    if (report === undefined) throw new Error("SCA report artifact is absent");
    const completed = terminal(
      await service.execute({
        schema_version: 2,
        action: "respond",
        identity: identity(runId),
        gate_id: awaiting.gate_id,
        challenge: awaiting.challenge,
        response: {
          decision: "approved",
          report_artifact_id: report.artifact_id,
          report_sha256: report.content_digest,
        },
      }),
      "complete"
    );
    expect(completed).toMatchObject({
      met: true,
      result: {
        met: true,
        release_approved: true,
        output_artifact_ref: { artifact_id: report.artifact_id },
      },
      unresolved: [],
    });
    expect(service.checkpointer.completionAdmission(runId)).toBeDefined();
  });

  it("terminates honestly when critic consensus has an unresolved gap", async () => {
    const client = new ScriptedScaClient("GAP");
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: SCA_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const result = terminal(await service.execute(start(`run-sca-gap-${sequence}`)), "incomplete");
    expect(result).toMatchObject({ met: false, unresolved: ["Primary analyses conflict."] });
    expect(
      client.invocations.some((invocation) => invocation.stateId === "materializing_report")
    ).toBe(false);
  });

  it("recovers an exact pending human gate after service restart", async () => {
    const env = environment();
    const runId = `run-sca-recovery-${++sequence}`;
    let gateId = "";
    let challenge = "";
    let reportId = "";
    let reportSha = "";
    {
      const client = new ScriptedScaClient();
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: SCA_PLAYBOOK_REGISTRATION,
      });
      const awaiting = await service.execute(start(runId));
      if (awaiting.action !== "await_user") throw new Error("SCA release gate was not reached");
      gateId = awaiting.gate_id;
      challenge = awaiting.challenge;
      const report = service.checkpointer
        .loadRunById(runId)
        ?.selectedArtifacts.find((artifact) => artifact.phase === "materializing_report");
      if (report === undefined) throw new Error("SCA report artifact is absent");
      reportId = report.artifact_id;
      reportSha = report.content_digest;
    }
    const recoveryClient = new ScriptedScaClient();
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveryClient,
      playbookRegistration: SCA_PLAYBOOK_REGISTRATION,
    });
    const pending = await recovered.execute({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(pending).toMatchObject({ action: "await_user", gate_id: gateId, challenge });
    expect(recoveryClient.invocations).toEqual([]);
    expect(
      terminal(
        await recovered.execute({
          schema_version: 2,
          action: "respond",
          identity: identity(runId),
          gate_id: gateId,
          challenge,
          response: {
            decision: "approved",
            report_artifact_id: reportId,
            report_sha256: reportSha,
          },
        }),
        "complete"
      ).met
    ).toBe(true);
  });

  it("revises a report once when final verification finds a correctable gap", async () => {
    const client = new ScriptedScaClient("PASS", ["GAP", "PASS"]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: SCA_PLAYBOOK_REGISTRATION,
    });
    const awaiting = await service.execute(start(`run-sca-report-repair-${++sequence}`));
    expect(awaiting.action).toBe("await_user");
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "analyzing_candidates",
      "analyzing_candidates",
      "reviewing_consensus",
      "materializing_report",
      "verifying_final_product",
      "materializing_report",
      "verifying_final_product",
    ]);
    const secondMaterialization = client.invocations.filter(
      (invocation) => invocation.stateId === "materializing_report"
    )[1];
    expect(
      secondMaterialization?.inputArtifacts.some(
        (artifact) => artifact.phase === "verifying_final_product"
      )
    ).toBe(true);
  });

  it("rejects a source snapshot digest mismatch before model work", async () => {
    const client = new ScriptedScaClient();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: SCA_PLAYBOOK_REGISTRATION,
    });
    const request = start(`run-sca-digest-reject-${++sequence}`);
    await expect(
      service.execute({
        ...request,
        constraints: { ...request.constraints, source_snapshot_sha256: "0".repeat(64) },
      })
    ).rejects.toThrow(/source snapshot digest mismatch/u);
    expect(client.invocations).toEqual([]);
  });

  it("rejects non-distinct model profiles before model work", async () => {
    const client = new ScriptedScaClient();
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: SCA_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const request = start(`run-sca-model-reject-${sequence}`);
    await expect(
      service.execute({
        ...request,
        constraints: {
          ...request.constraints,
          primary_b_model: request.constraints.primary_a_model,
        },
      })
    ).rejects.toThrow(/model profiles must be distinct/u);
    expect(client.invocations).toEqual([]);
  });
});
