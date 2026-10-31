/** Opt-in REAL Docker/Semgrep boundary through the normal configured ordinary owner.
 * Cognition and scanner/graph preparation are explicitly SCRIPTED, not provider evidence.
 * Never supplies applicationFactory, runOffline, a replacement owner or native process results.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateContract } from "../dist/contracts.js";
import type { AgentInvocation } from "../dist/model-client.js";
import { OrchestrationService } from "../dist/service.js";
import {
  HostOperationSimulatedCrashError,
  HostOperationRuntimeOwner,
} from "../dist/host-operations/owner.js";
import { createScaOrdinaryResultCache } from "../dist/sca/ordinary-host.js";
import { ScaAdvancedPrivateSchema } from "../dist/sca/ordinary-advanced-host.js";
import { ScaOfflineRunnerConfigSchema } from "../dist/sca/ordinary-offline-runner.js";
import {
  OrdinaryApplicationContainerConfigSchema,
  OrdinaryApplicationTestResultSchema,
  OrdinaryApplicationTestRequestSchema,
  OrdinaryApplicationExecutionPlanSchema,
  ScaAdvancedInputsSchema,
  ScaAdvancedRequestSchema,
  ScaRuleLearningProcessReceiptSchema,
  ScaLearnedRuleReleaseSchema,
  ScaRulePromotionResultSchema,
  ScaRuleRescanResultSchema,
  ScaRuleLearningOfflineValidationSchema,
} from "../dist/sca/ordinary-advanced-contracts.js";
import {
  ScaActionsSchema,
  ScaDispositionsSchema,
  ScaLearningSchema,
  ScaToolPathSchema,
} from "../dist/sca/ordinary-contracts.js";
import { ScaReportProductSchema } from "../dist/sca/ordinary-report.js";
import { describeScaSourceSnapshotV1 } from "../dist/sca/ordinary-source.js";
import { AdvancedScriptedClient, advancedFixture } from "./helpers/sca-advanced-workflow.js";
import {
  environment,
  fixtureAdapters,
  identity,
  PROJECT_ROOT,
  sourceRoot,
  start,
} from "./helpers/sca-local-workflow.js";

const optIn = process.env.PENNY_SCA_ORDINARY_NATIVE === "1";
const configPath = process.env.PENNY_SCA_ORDINARY_NATIVE_CONFIG;
const File = Type.String({ minLength: 1 });
const ConfigSchema = Type.Object(
  {
    application_config: File,
    learning_config: File,
    offline_runner: ScaOfflineRunnerConfigSchema,
    evidence_directory: File,
  },
  { additionalProperties: false }
);
const LearningConfigSchema = Type.Object(
  {
    tools: Type.Object(
      {
        semgrep: Type.Object(
          { tool: ScaToolPathSchema, rules_path: File, rules_sha256: File },
          { additionalProperties: false }
        ),
      },
      { additionalProperties: false }
    ),
    evidence_directory: File,
    offline_validation: ScaRuleLearningOfflineValidationSchema,
  },
  { additionalProperties: false }
);
const candidate = {
  rules: [
    {
      id: "test.handler",
      languages: ["typescript"],
      message: "Disposable source-only handler call",
      severity: "WARNING",
      pattern: "exec($X)",
      metadata: { category: "correctness", technology: ["typescript"] },
    },
  ],
};
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
function save(root: string, name: string, value: unknown) {
  writeFileSync(path.join(root, name), canonicalJson(value), { mode: 0o600, flag: "wx" });
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected evidence object");
  return { ...value };
}
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Required exact evidence absent");
  return value;
}
class NativeScriptedClient extends AdvancedScriptedClient {
  constructor(
    readonly planIds: string[],
    readonly withLearning: boolean
  ) {
    super(planIds.length > 0, withLearning);
  }
  override output(invocation: AgentInvocation): unknown {
    const value = super.output(invocation);
    if (invocation.stateId === "selecting_evidence_actions") {
      const result = validateContract(ScaActionsSchema, value, "SCRIPTED actions");
      const action = required(result.actions[0]);
      result.actions = [
        action,
        ...this.planIds.map((id, i) => ({
          ...action,
          id: `native-app-${i}`,
          kind: "application_test" as const,
          application_plan_id: id,
        })),
      ];
      return result;
    }
    if (invocation.stateId === "adjudicating_evidence") {
      const result = validateContract(ScaDispositionsSchema, value, "SCRIPTED adjudication");
      required(result.dispositions[0]).action_ids = [
        "a-0",
        ...this.planIds.map((_id, i) => `native-app-${i}`),
      ];
      return result;
    }
    if (invocation.stateId === "assessing_learning" && this.withLearning) {
      const result = validateContract(ScaLearningSchema, value, "SCRIPTED candidate selection");
      for (const entry of result.outcomes) entry.proposed_rule = canonicalJson(candidate);
      return result;
    }
    return value;
  }
}
function fixture(
  name: string,
  learning: boolean,
  languages: readonly ("node_typescript" | "node" | "php")[] = ["node_typescript"]
) {
  if (!optIn || configPath === undefined)
    throw new Error("Explicit native opt-in and caller config required");
  const config = validateContract(
    ConfigSchema,
    readJson(configPath),
    "Caller native integration config"
  );
  const supplied = validateContract(
    OrdinaryApplicationContainerConfigSchema,
    readJson(config.application_config),
    "Caller Docker config"
  );
  const pins = validateContract(
    LearningConfigSchema,
    readJson(config.learning_config),
    "Caller complete native pins"
  );
  expect(pins.offline_validation.metachecks.rule_ids).toHaveLength(47);
  expect(sha256(readFileSync(pins.offline_validation.metachecks.rules_path))).toBe(
    pins.offline_validation.metachecks.rules_sha256
  );
  const env = environment();
  const base = advancedFixture("unsupported"); // Caller operands only; its synthetic host is NEVER installed.
  const root = path.dirname(sourceRoot),
    runId = `native-${name}`;
  const privateRoot = path.join(root, `PRIVATE_NATIVE_PATH_${randomUUID()}`);
  mkdirSync(privateRoot, { mode: 0o700 });
  const containerWork = path.join(privateRoot, "containers"),
    workRoot = path.join(privateRoot, "learning");
  mkdirSync(containerWork, { mode: 0o700 });
  mkdirSync(workRoot, { mode: 0o700 });
  const marker = `PRIVATE_NATIVE_OUTPUT_${randomUUID()}`;
  const input = path.join(privateRoot, "input.txt");
  writeFileSync(input, marker, { mode: 0o600 });
  const stdin = path.join(privateRoot, "stdin.txt");
  writeFileSync(stdin, "exact-stdin", { mode: 0o600 });
  // Source executed only inside the admitted container, never on the analyzer/control host.
  const sourceTexts = {
    node_typescript:
      "export function render(value: string): string { return value.toUpperCase(); }\n",
    node: "export function render(value) { return value.toUpperCase(); }\n",
    php: "<?php function render($value) { return strtoupper($value); }\n",
  };
  const sourceNames = {
    node_typescript: "src/probe.ts",
    node: "src/probe.mjs",
    php: "src/probe.php",
  };
  for (const language of languages)
    writeFileSync(path.join(sourceRoot, sourceNames[language]), sourceTexts[language]);
  const snapshot = describeScaSourceSnapshotV1({
    source_root: sourceRoot,
    scope: { include: [], exclude: [] },
  }).source_snapshot_sha256;
  const resources = {
    operation_timeout_seconds: 30,
    test_timeout_ms: 5000,
    cpu_seconds: 3,
    memory_bytes: 536870912,
    processes: 32,
    file_bytes: 1048576,
    output_bytes: 8192,
  };
  const application_tests = languages.map((interpreter, i) => {
    const text =
      interpreter === "php"
        ? `<?php require '/input/source/src/probe.php'; if(render('safe')!=='SAFE') exit(2); if(trim(file_get_contents('/sys/fs/cgroup/memory.max'))!=='536870912')exit(3); if(file_get_contents('php://stdin')!=='exact-stdin')exit(4); echo file_get_contents('data/value.txt');`
        : `import fs from 'node:fs'; import {render} from '/input/source/${sourceNames[interpreter]}';
if(render('safe')!=='SAFE' || process.getuid()!==65534)process.exit(2);
const status=fs.readFileSync('/proc/self/status','utf8');if(!/^NoNewPrivs:\\s+1$/m.test(status)||!/^CapEff:\\s+0+$/m.test(status))process.exit(3);
for(const [f,v] of [['memory.max','536870912'],['memory.swap.max','0'],['pids.max','32'],['cpu.max','100000 100000']])if(fs.readFileSync('/sys/fs/cgroup/'+f,'utf8').trim()!==v)process.exit(4);
for(const p of ['/input/source/${sourceNames[interpreter]}','/readonly-canary']){try{fs.writeFileSync(p,'no');process.exit(5)}catch{}}
if(fs.existsSync('/run/docker.sock')||fs.existsSync('/root/.aws')||fs.readFileSync(0,'utf8')!=='exact-stdin')process.exit(6);
process.stdout.write(fs.readFileSync('data/value.txt','utf8'));`;
    const file = path.join(
      privateRoot,
      `harness-${i}.${interpreter === "php" ? "php" : interpreter === "node" ? "mjs" : "ts"}`
    );
    writeFileSync(file, text, { mode: 0o600 });
    return {
      id: i === 0 ? "admitted-test" : `admitted-test-${i}`,
      source_snapshot_sha256: snapshot,
      isolation: "container" as const,
      profile: "docker-local-no-network-v1" as const,
      interpreter,
      source_files: [
        { path: sourceNames[interpreter], content_sha256: sha256(sourceTexts[interpreter]) },
      ],
      harness: { path: file, sha256: sha256(text) },
      test_inputs: [{ name: "value.txt", file: { path: input, sha256: sha256(marker) } }],
      stdin: { path: stdin, sha256: sha256("exact-stdin") },
      expected_exit_code: 0,
      resources,
      maxima: resources,
    };
  });
  const chosen = required(base.advanced.learning[0]);
  chosen.source_snapshot_sha256 = snapshot;
  chosen.tool = pins.tools.semgrep.tool;
  chosen.offline_validation = pins.offline_validation;
  chosen.limits.max_processes = 20;
  // Real retained baseline is checked in every independent scan, not just an empty placeholder.
  const baselineBytes = canonicalJson({
    rules: [
      {
        id: "fixture.baseline",
        languages: ["typescript"],
        message: "Disposable retained conversion",
        severity: "INFO",
        pattern: "String($X)",
      },
    ],
  });
  writeFileSync(chosen.baseline.rules_path, baselineBytes);
  chosen.baseline.rules_sha256 = sha256(baselineBytes);
  chosen.baseline.rule_ids = ["fixture.baseline"];
  for (const f of chosen.fixtures)
    if (["fixed", "negative_neighbor", "benign"].includes(f.case_class))
      f.baseline_matches = [{ rule_id: "fixture.baseline", line: 5 }];
  chosen.fixture_truth_sha256 = sha256(canonicalJson(chosen.fixtures));
  const promotion = required(base.advanced.promotions[0]);
  promotion.candidate_sha256 = sha256(canonicalJson(candidate));
  const rescan = required(base.advanced.rescans[0]);
  rescan.source_snapshot_sha256 = snapshot;
  const advanced = validateContract(
    ScaAdvancedInputsSchema,
    {
      application_tests,
      learning: learning ? [chosen] : [],
      promotions: learning ? [promotion] : [],
      rescans: learning ? [rescan] : [],
    },
    "Independent caller exact oracle/grants"
  );
  const docker = { ...supplied, workspace_parent: containerWork };
  const offline = {
    ...config.offline_runner,
    workRoot,
    ipc_python: pins.offline_validation.python,
  };
  save(privateRoot, "application.json", docker);
  save(privateRoot, "offline.json", offline);
  const cleanEnv: NodeJS.ProcessEnv = {
    ...env,
    PENNY_SCA_ORDINARY_APPLICATION_CONFIG: path.join(privateRoot, "application.json"),
    PENNY_SCA_ORDINARY_OFFLINE_CONFIG: path.join(privateRoot, "offline.json"),
  };
  delete cleanEnv.PENNY_SCA_ORDINARY_APPLICATION_VM_CONFIG;
  const client = new NativeScriptedClient(
    application_tests.map((x) => x.id),
    learning
  );
  const options = {
    projectRoot: PROJECT_ROOT,
    playbookName: "sca",
    env: cleanEnv,
    modelClient: client,
    hostOperationAdapters: fixtureAdapters("noalert"),
  };
  const request = {
    ...start(runId),
    constraints: {
      ...start(runId).constraints,
      execution_mode: "propose_stronger_evidence",
      advanced,
    },
  };
  save(root, "request.json", request);
  save(root, "host-inputs.json", { configPath, supplied, pins, privateRoot });
  mkdirSync(config.evidence_directory, { recursive: true, mode: 0o700 });
  save(config.evidence_directory, `${runId}-${randomUUID()}.json`, { root, runId });
  return {
    root,
    runId,
    options,
    request,
    client,
    privateRoot,
    marker,
    docker,
    containerWork,
    workRoot,
    chosen,
    baselineBytes,
    namespace: base.namespace,
  };
}
type Fixture = ReturnType<typeof fixture>;
function bind(service: OrchestrationService, h: Fixture) {
  expect(service.hostOperations).toBeInstanceOf(HostOperationRuntimeOwner);
  h.client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
}
function product(service: OrchestrationService, h: Fixture) {
  const ref = required(
    service.checkpointer
      .loadRunById(h.runId)
      ?.selectedArtifacts.find((x) => x.kind === "semantic-core")
  );
  return validateContract(
    ScaReportProductSchema,
    JSON.parse(service.artifacts.readById(ref.artifact_id).toString("utf8")),
    "Exact final product"
  );
}
function privateOutputs(service: OrchestrationService, h: Fixture, kind: string) {
  return service.checkpointer
    .hostOperationCallsForRun(h.runId)
    .filter((x) => x.operation_kind === kind)
    .map((call) => {
      const ref = required(call.operation_result_ref);
      const bytes = service.artifacts.readById(ref.artifact_id);
      expect(sha256(bytes)).toBe(ref.content_digest);
      expect(bytes.length).toBe(ref.byte_length);
      return {
        call,
        ref,
        value: validateContract(
          ScaAdvancedPrivateSchema,
          JSON.parse(bytes.toString("utf8")),
          "Reread exact private native result"
        ),
      };
    });
}
function absent(h: Fixture, name: string) {
  const out = execFileSync(
    h.docker.docker.path,
    [
      "--config",
      h.privateRoot,
      "--host",
      `unix://${h.docker.daemon_socket}`,
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.ID}}",
    ],
    { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10000 }
  );
  expect(out.trim()).toBe("");
  return { name, absent: true };
}
const RawSchema = Type.Object(
  {
    name: Type.String(),
    events: Type.Array(
      Type.Object(
        {
          argv: Type.Array(Type.String()),
          response: Type.Object({ stdout: Type.String() }, { additionalProperties: true }),
        },
        { additionalProperties: true }
      )
    ),
  },
  { additionalProperties: true }
);
function verifyApplications(service: OrchestrationService, h: Fixture) {
  const checks = privateOutputs(service, h, "sca.application.v1").map(({ call, value }, i) => {
    const native = validateContract(
      OrdinaryApplicationTestResultSchema,
      value.native,
      "Native private application API"
    );
    save(h.root, `application-${i}.json`, native);
    expect(native).toMatchObject({
      status: "completed",
      execution: "RUN",
      passed: true,
      isolation: "CONTAINER",
      acceptance: "terminal",
      cleanup: "proved",
      quarantine_required: false,
      retained_workspace: null,
    });
    expect(Buffer.from(native.stdout_base64, "base64").toString("utf8")).toBe(h.marker);
    const raw = validateContract(
      RawSchema,
      JSON.parse(Buffer.from(native.raw_receipt_base64, "base64").toString("utf8")),
      "Actual Docker controller receipt"
    );
    save(h.root, `docker-raw-${i}.json`, raw);
    const inspected = raw.events
      .filter((e) => e.argv[0] === "container" && e.argv[1] === "inspect")
      .map((e) => object(JSON.parse(Buffer.from(e.response.stdout, "base64").toString("utf8"))));
    const created = required(inspected.find((x) => object(x.State).Status === "created"));
    const policy = object(created.HostConfig),
      cfg = object(created.Config);
    expect(cfg.User).toBe("65534:65534");
    expect(policy.NetworkMode).toBe("none");
    expect(policy.ReadonlyRootfs).toBe(true);
    expect(policy.CapDrop).toEqual(["ALL"]);
    expect(policy.PidsLimit).toBe(32);
    expect(policy.Memory).toBe(536870912);
    expect(policy.NanoCpus).toBe(1000000000);
    expect(policy.SecurityOpt).toEqual(
      expect.arrayContaining([
        "no-new-privileges=true",
        "seccomp=builtin",
        "apparmor=docker-default",
      ])
    );
    const mounts = created.Mounts;
    if (!Array.isArray(mounts)) throw new Error("Actual mounts absent");
    expect(mounts).toHaveLength(1);
    expect(object(mounts[0]).RW).toBe(false);
    expect(call.remote_correlation_id).toBe(raw.name);
    const nativeRequest = validateContract(
      OrdinaryApplicationTestRequestSchema,
      validateContract(
        ScaAdvancedRequestSchema,
        readJsonArtifact(service, call.request_ref.artifact_id),
        "Owner advanced request"
      ).native_request,
      "Exact admitted application request"
    );
    expect(raw.name).toBe(`penny-app-${sha256(canonicalJson(nativeRequest))}`);
    const plan = validateContract(
      OrdinaryApplicationExecutionPlanSchema,
      readJsonArtifact(service, nativeRequest.execution_plan_ref.artifact_id),
      "Exact execution plan"
    );
    expect(plan.schema_version).toBe(2);
    expect(plan.source_snapshot_sha256).toBe(
      h.request.constraints.advanced.application_tests[i]?.source_snapshot_sha256
    );
    return {
      ...absent(h, raw.name),
      request_sha256: native.request_sha256,
      raw_sha256: sha256(Buffer.from(native.raw_receipt_base64, "base64")),
      plan,
      policy: {
        user: cfg.User,
        network: policy.NetworkMode,
        readonly: policy.ReadonlyRootfs,
        cap_drop: policy.CapDrop,
        pids: policy.PidsLimit,
        memory: policy.Memory,
        cpu: policy.NanoCpus,
      },
    };
  });
  save(h.root, "independent-container-checks.json", checks);
  return checks;
}
function readJsonArtifact(service: OrchestrationService, id: string): unknown {
  return JSON.parse(service.artifacts.readById(id).toString("utf8"));
}
function privacy(service: OrchestrationService, h: Fixture) {
  const forbidden = [
    h.privateRoot,
    h.marker,
    Buffer.from(h.marker).toString("base64"),
    h.namespace,
    '"raw_receipt_base64"',
    '"stdout_base64"',
    '"stderr_base64"',
    '"retained_workspace"',
    '"workspace_path"',
    '"rules_path"',
    '"fixture_truth_sha256"',
  ];
  let refs = 0;
  for (const invocation of h.client.invocations) {
    for (const text of [
      invocation.task,
      ...invocation.inputArtifacts.map((ref) => {
        refs++;
        return service.artifacts.readById(ref.artifact_id).toString("utf8");
      }),
    ])
      for (const secret of forbidden) expect(text).not.toContain(secret);
  }
  const selected = required(service.checkpointer.loadRunById(h.runId)).selectedArtifacts;
  for (const ref of selected.filter((x) =>
    [
      "semantic-core",
      "sca-advanced-summary",
      "sca-report-markdown",
      "sca-report-sarif",
      "sca-report-validation",
      "sca-output-manifest",
    ].includes(x.kind)
  ))
    for (const secret of forbidden)
      expect(service.artifacts.readById(ref.artifact_id).toString("utf8")).not.toContain(secret);
  save(h.root, "public-projection-privacy.json", {
    cognitive_invocations: h.client.invocations.length,
    exact_input_reads: refs,
    checked_fields_and_canaries: forbidden.map((x) => sha256(x)),
    private_fields_absent_from_cognition_and_reports: true,
    note: "Raw native API fields and runtime-produced canary retained only in exact private artifacts; this is not a live model disclosure test.",
  });
}
function claims(h: Fixture) {
  return readdirSync(h.containerWork)
    .sort()
    .map((file) => ({
      file,
      ctime: lstatSync(path.join(h.containerWork, file)).ctimeMs,
      entries: readdirSync(path.join(h.containerWork, file)).sort(),
    }));
}

async function verifyFullLearning(
  learningService: OrchestrationService,
  h: Fixture,
  terminal: Awaited<ReturnType<OrchestrationService["execute"]>>
) {
  const report = product(learningService, h);
  const learningClaims = claims(h);
  save(h.root, "terminal.json", terminal);
  save(h.root, "report-product.json", report);
  save(
    h.root,
    "journal-after-reopen.json",
    learningService.checkpointer.hostOperationCallsForRun(h.runId)
  );
  verifyApplications(learningService, h);
  privacy(learningService, h);
  const validation = required(privateOutputs(learningService, h, "sca.validation.v1")[0]).value;
  const record = required(validation.validation);
  save(h.root, "validation-record.json", record);
  expect(record.admission.decision).toBe("allow");
  expect(record.admission.fixture_truth_sha256).toBe(h.chosen.fixture_truth_sha256);
  save(h.root, "learning-observed-summary.json", {
    status: record.result.status,
    reasons: record.result.reasons,
    receipts: record.receipts.map((x) => ({
      kind: x.kind,
      fixture: x.fixture_id,
      status: x.result.status,
      exit_code: x.result.exit_code,
    })),
    baseline_unchanged:
      readFileSync(h.chosen.baseline.rules_path).toString("utf8") === h.baselineBytes,
  });
  expect(record.result.status, canonicalJson(record.result)).toBe("validated");
  expect(record.receipts).toHaveLength(20);
  expect(record.receipts.filter((x) => x.kind === "validate_schema")).toHaveLength(1);
  expect(record.receipts.filter((x) => x.kind === "validate")).toHaveLength(1);
  expect(record.receipts.filter((x) => x.kind === "test")).toHaveLength(9);
  expect(record.receipts.filter((x) => x.kind === "scan")).toHaveLength(9);
  expect(record.result.cases).toHaveLength(9);
  expect(record.result.cases.every((x) => x.status === "passed" && x.baseline_matches_passed)).toBe(
    true
  );
  for (const receipt of record.receipts) {
    expect(receipt.result.stdout_sha256).toBe(sha256(receipt.result.stdout));
    expect(receipt.result.stderr_sha256).toBe(sha256(receipt.result.stderr));
    expect(existsSync(receipt.workspace_path)).toBe(false);
  }
  const core = required(record.receipts.find((x) => x.kind === "validate"));
  expect(core.result.stdout).toMatch(/^\.\n\{/u);
  expect(core.result.stdout).toContain(h.chosen.tool.version);
  const promoted = validateContract(
    ScaRulePromotionResultSchema,
    required(privateOutputs(learningService, h, "sca.promotion.v1")[0]).value.native,
    "Native immutable promotion"
  );
  expect(promoted.status).toBe("promoted");
  const releasePath = required(promoted.release_path),
    releaseBytes = readFileSync(releasePath);
  expect(sha256(releaseBytes)).toBe(promoted.release_sha256);
  const release = validateContract(
    ScaLearnedRuleReleaseSchema,
    JSON.parse(releaseBytes.toString("utf8")),
    "Exact immutable release"
  );
  expect(release).toMatchObject({
    future_only: true,
    immutable: true,
    rule_sha256: sha256(canonicalJson(candidate)),
    fixture_truth_sha256: h.chosen.fixture_truth_sha256,
  });
  expect(release.offline_validation).toEqual(h.chosen.offline_validation);
  expect(lstatSync(releasePath).mode & 0o222).toBe(0);
  expect(terminal.action).toBe("incomplete"); // New scanner leads require investigation, never confirmation.
  expect(report.advanced?.operations.map((x) => [x.stage, x.status])).toEqual([
    ["application", "completed"],
    ["validation", "validated"],
    ["promotion", "promoted"],
    ["rescan", "completed"],
  ]);
  expect(report.reproduction).toBe("RUN");
  expect(report.target_executed).toBe(true);
  const rescanned = validateContract(
    ScaRuleRescanResultSchema,
    required(privateOutputs(learningService, h, "sca.rescan.v1")[0]).value.native,
    "Separately admitted real rescan"
  );
  expect(rescanned.status).toBe("completed");
  expect(rescanned.reenter_investigation).toBe(true);
  expect(rescanned.findings.length).toBeGreaterThan(0);
  expect(rescanned.predecessor_investigation_sha256).toBe(release.reconciliation_sha256);
  expect(rescanned.source_snapshot_sha256).toBe(release.source_snapshot_sha256);
  const calls = learningService.checkpointer.hostOperationCallsForRun(h.runId);
  expect(calls).toHaveLength(6);
  expect(calls.every((x) => x.lifecycle === "consumed")).toBe(true);
  const rescanReceipts = required(
    privateOutputs(learningService, h, "sca.rescan.v1")[0]
  ).value.receipts.map((x) =>
    validateContract(ScaRuleLearningProcessReceiptSchema, x, "Native rescan process receipt")
  );
  expect(rescanReceipts).toHaveLength(1);
  expect(rescanReceipts[0]?.kind).toBe("rescan");
  save(h.root, "rescan-receipts.json", rescanReceipts);

  expect(readFileSync(h.chosen.baseline.rules_path).toString("utf8")).toBe(h.baselineBytes);
  expect(readFileSync(releasePath).equals(releaseBytes)).toBe(true);
  expect(claims(h)).toEqual(learningClaims);
  expect(learningClaims).toHaveLength(1);
  expect(learningClaims.every((x) => x.entries.length === 0)).toBe(true);
  const previousInvocations = h.client.invocations.length;
  expect(
    await learningService.execute({
      schema_version: 2,
      action: "recover",
      identity: identity(h.runId),
    })
  ).toEqual(terminal);
  expect(h.client.invocations).toHaveLength(previousInvocations);
  expect(claims(h)).toEqual(learningClaims);
  save(h.root, "summary.json", {
    cognition: "SCRIPTED",
    preparation: "PREVALIDATED FIXTURE",
    native_applications: 1,
    validation_receipts: 20,
    rescan_receipts: 1,
    metachecks: 47,
    source_snapshot_sha256:
      h.request.constraints.advanced.application_tests[0]?.source_snapshot_sha256,
    retained_baseline_sha256: sha256(h.baselineBytes),
    release_sha256: promoted.release_sha256,

    recovery: "terminal_no_reexecution",
    private_root: h.privateRoot,
  });
}

// Mapping comes from normal tests/**/*.test.ts; no aggregate row or foreign config changed.
describe.skipIf(!optIn)(
  "configured ordinary native integration (SCRIPTED cognition/preparation)",
  () => {
    it("consumes three distinct PHP/JS/TS native application results, adopts the third cached fetch without replay, then requires full learning/promotion/separate rescan", async () => {
      const h = fixture("multi-application", false, ["node_typescript", "node", "php"]);
      let fetchedApplications = 0;
      using first = new OrchestrationService({
        ...h.options,
        hostOperationFault(point, kind) {
          if (
            point === "after_fetch" &&
            kind === "sca.application.v1" &&
            ++fetchedApplications === 3
          )
            throw new HostOperationSimulatedCrashError(point);
        },
      });
      bind(first, h);
      await expect(first.execute(h.request)).rejects.toBeInstanceOf(
        HostOperationSimulatedCrashError
      );
      const beforeCalls = first.checkpointer.hostOperationCallsForRun(h.runId);
      save(h.root, "journal-before-reopen.json", beforeCalls);
      const applicationsBefore = beforeCalls.filter(
        (x) => x.operation_kind === "sca.application.v1"
      );
      expect(applicationsBefore).toHaveLength(3);
      expect(applicationsBefore.map((x) => x.lifecycle)).toEqual([
        "consumed",
        "consumed",
        "fetched",
      ]);
      const fetched = required(applicationsBefore.at(-1));
      expect(fetched.lifecycle).toBe("fetched");
      const cached = required(
        await createScaOrdinaryResultCache(first.config.dbPath).read(fetched.request_sha256)
      );
      save(
        h.root,
        "fetch-cache-before-reopen.json",
        JSON.parse(Buffer.from(cached.bytes).toString("utf8"))
      );
      const beforeClaims = claims(h);
      const cachedPrivate = validateContract(
        ScaAdvancedPrivateSchema,
        object(JSON.parse(Buffer.from(cached.bytes).toString("utf8"))).private,
        "Exact application fetch before reopen"
      );
      const cachedNative = validateContract(
        OrdinaryApplicationTestResultSchema,
        cachedPrivate.native,
        "Actual completed container before owner crash"
      );
      expect(cachedNative).toMatchObject({
        status: "completed",
        execution: "RUN",
        passed: true,
        cleanup: "proved",
      });
      first.close();
      using reopened = new OrchestrationService(h.options);
      bind(reopened, h);
      const terminal = await reopened.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(h.runId),
      });
      const report = product(reopened, h);
      save(h.root, "terminal.json", terminal);
      save(h.root, "report-product.json", report);
      save(
        h.root,
        "journal-after-reopen.json",
        reopened.checkpointer.hostOperationCallsForRun(h.runId)
      );
      const applicationResults = privateOutputs(reopened, h, "sca.application.v1");
      expect(applicationResults).toHaveLength(3);
      expect(new Set(applicationResults.map((x) => x.call.operation_record_id)).size).toBe(3);
      expect(new Set(applicationResults.map((x) => x.ref.artifact_id)).size).toBe(3);
      expect(new Set(applicationResults.map((x) => x.call.request_sha256)).size).toBe(3);
      expect(applicationResults.every((x) => x.call.lifecycle === "consumed")).toBe(true);
      const adopted = required(
        applicationResults.find((x) => x.call.operation_record_id === fetched.operation_record_id)
      );
      expect(adopted.value.native).toEqual(cachedPrivate.native);
      expect(adopted.call.lifecycle).toBe("consumed");
      expect(claims(h)).toEqual(beforeClaims);
      save(h.root, "cache-adoption-proof.json", {
        cache_sha256: cached.content_sha256,
        before_claims: beforeClaims,
        after_claims: claims(h),
        raw_result_identical: true,
        operation_record_id: adopted.call.operation_record_id,
      });
      verifyApplications(reopened, h);
      privacy(reopened, h);
      expect(report.advanced?.operations.map((x) => [x.stage, x.status])).toEqual([
        ["application", "completed"],
        ["application", "completed"],
        ["application", "completed"],
      ]);
      expect(claims(h)).toEqual(beforeClaims);
      expect(beforeClaims).toHaveLength(3);
      expect(beforeClaims.every((x) => x.entries.length === 0)).toBe(true);
      const invocations = h.client.invocations.length;
      expect(
        await reopened.execute({
          schema_version: 2,
          action: "recover",
          identity: identity(h.runId),
        })
      ).toEqual(terminal);
      expect(h.client.invocations).toHaveLength(invocations);
      expect(claims(h)).toEqual(beforeClaims);
      save(h.root, "summary.json", {
        native_applications: 3,
        distinct_consumed_results: 3,
        recovery: "exact_cached_adoption_no_reexecution",
        cache_sha256: cached.content_sha256,
      });
      // The unchanged primitive honestly supports only a single-language rescan corpus.
      // Never filter/rename mixed source to bypass its coverage gate. Prove full learning on
      // its separately admitted TS corpus, in addition to the three-plan mixed campaign above.
      const learningFixture = fixture("learning", true);
      using learningService = new OrchestrationService(learningFixture.options);
      bind(learningService, learningFixture);
      const learningTerminal = await learningService.execute(learningFixture.request);
      await verifyFullLearning(learningService, learningFixture, learningTerminal);
    }, 5400000);
    it("quarantines lost-cache recovery after actual Docker fetch, remains UNKNOWN and never replays", async () => {
      const h = fixture("lost-cache", false, ["php"]);
      using first = new OrchestrationService({
        ...h.options,
        hostOperationFault(point, kind) {
          if (point === "after_fetch" && kind === "sca.application.v1")
            throw new HostOperationSimulatedCrashError(point);
        },
      });
      bind(first, h);
      await expect(first.execute(h.request)).rejects.toBeInstanceOf(
        HostOperationSimulatedCrashError
      );
      const call = required(
        first.checkpointer
          .hostOperationCallsForRun(h.runId)
          .find((x) => x.operation_kind === "sca.application.v1")
      );
      const cached = required(
        await createScaOrdinaryResultCache(first.config.dbPath).read(call.request_sha256)
      );
      const bundle = object(JSON.parse(Buffer.from(cached.bytes).toString("utf8")));
      const privateValue = validateContract(
        ScaAdvancedPrivateSchema,
        bundle.private,
        "Actual fetched native result"
      );
      const native = validateContract(
        OrdinaryApplicationTestResultSchema,
        privateValue.native,
        "Actual Docker result before cache loss"
      );
      expect(native).toMatchObject({
        status: "completed",
        execution: "RUN",
        passed: true,
        cleanup: "proved",
      });
      const raw = validateContract(
        RawSchema,
        JSON.parse(Buffer.from(native.raw_receipt_base64, "base64").toString("utf8")),
        "Exact fetched Docker evidence"
      );
      save(h.root, "lost-cache-original-private.json", privateValue);
      save(h.root, "journal-before-reopen.json", call);
      const before = claims(h),
        db = first.config.dbPath;
      first.close();
      // Delete precisely the disposable test's known cache entry; never mutate canonical production state.
      unlinkSync(
        path.join(path.dirname(db), "sca-host-result-cache", `${call.request_sha256}.json`)
      );
      using reopened = new OrchestrationService(h.options);
      bind(reopened, h);
      const terminal = await reopened.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(h.runId),
      });
      const report = product(reopened, h);
      expect(report.reproduction).toBe("UNKNOWN");
      expect(report.target_executed).toBeNull();
      const recovered = required(
        reopened.checkpointer
          .hostOperationCallsForRun(h.runId)
          .find((x) => x.operation_kind === "sca.application.v1")
      );
      expect(recovered.disposition?.lease_disposition).toBe("quarantined");
      expect(report.advanced?.operations[0]).toMatchObject({
        status: "incomplete",
        execution: "UNKNOWN",
        quarantine_required: true,
      });
      expect(
        await reopened.execute({
          schema_version: 2,
          action: "recover",
          identity: identity(h.runId),
        })
      ).toEqual(terminal);
      expect(claims(h)).toEqual(before);
      save(h.root, "journal-after-reopen.json", recovered);
      save(h.root, "report-product.json", report);
      save(h.root, "independent-container-checks.json", [absent(h, raw.name)]);
      privacy(reopened, h);
    }, 120000);
    it.each(["static_only", "vm_consent"] as const)(
      "denies %s rather than selecting or relabeling Docker",
      async (mode) => {
        const h = fixture(mode, false, ["node_typescript"]);
        const input = required(h.request.constraints.advanced.application_tests[0]);
        if (input.isolation !== "container") throw new Error("Explicit CONTAINER fixture required");
        const { operation_timeout_seconds, ...rest } = input.resources;
        const vm = {
          ...input,
          isolation: "vm",
          resources: { ...rest, vm_timeout_seconds: operation_timeout_seconds },
          maxima: { ...rest, vm_timeout_seconds: operation_timeout_seconds },
        };
        const { profile: _profile, ...vmInput } = vm;
        using service = new OrchestrationService(h.options);
        bind(service, h);
        if (mode === "static_only") {
          await expect(
            service.execute({
              ...h.request,
              constraints: { ...h.request.constraints, execution_mode: "static_only" },
            })
          ).rejects.toThrow();
          expect(h.client.invocations).toHaveLength(0);
        } else {
          await service.execute({
            ...h.request,
            constraints: {
              ...h.request.constraints,
              advanced: { ...h.request.constraints.advanced, application_tests: [vmInput] },
            },
          });
          const result = validateContract(
            OrdinaryApplicationTestResultSchema,
            required(privateOutputs(service, h, "sca.application.v1")[0]).value.native,
            "VM consent backend mismatch"
          );
          expect(result).toMatchObject({
            status: "denied",
            execution: "NOT RUN",
            acceptance: "not_submitted",
          });
          expect(product(service, h).reproduction).toBe("NOT RUN");
          save(h.root, "denied-native.json", result);
          privacy(service, h);
        }
        expect(readdirSync(h.containerWork)).toEqual([]);
        save(h.root, "denial-summary.json", { mode, applications: 0, claims: [] });
      },
      120000
    );
  }
);
