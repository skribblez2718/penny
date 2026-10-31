/** SCRIPTED cognition/native receipts. Real ingress, owner, native learning validator, IO and recovery. */
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { validateContract } from "../../dist/contracts.js";
import type { AgentInvocation } from "../../dist/model-client.js";
import { describeScaSourceSnapshotV1 } from "../../dist/sca/ordinary-source.js";
import {
  ScaActionsSchema,
  ScaChallengeSchema,
  ScaDispositionsSchema,
  ScaHypothesesSchema,
  ScaLearningSchema,
  ScaSelectionSchema,
} from "../../dist/sca/ordinary-contracts.js";
import {
  OrdinaryApplicationTestRequestSchema,
  ScaAdvancedInputsSchema,
  type ScaProcessRequestV1,
  type ScaProcessResultV1,
} from "../../dist/sca/ordinary-advanced-contracts.js";
import type { ScaAdvancedHostOptions } from "../../dist/sca/ordinary-advanced-host.js";
import { ScriptedScaClient, sourceRoot, sources } from "./sca-local-workflow.js";
export const candidateRule = {
  rules: [
    {
      id: "test.handler",
      languages: ["typescript"],
      message: "Inert test rule",
      severity: "WARNING",
      pattern: "exec($X)",
    },
  ],
};
export class AdvancedScriptedClient extends ScriptedScaClient {
  constructor(
    readonly application = true,
    readonly learning = true,
    readonly wrongPlan = false,
    readonly noRule = false
  ) {
    super("noalert");
  }
  override output(invocation: AgentInvocation): unknown {
    const value = super.output(invocation);
    switch (invocation.stateId) {
      case "selecting_underdetected_no_alert_surfaces": {
        const result = validateContract(ScaSelectionSchema, value, "Scripted selection");
        result.selections = result.selections.slice(0, 1);
        return result;
      }
      case "forming_hypotheses": {
        const result = validateContract(ScaHypothesesSchema, value, "Scripted hypotheses");
        result.hypotheses = result.hypotheses.slice(0, 1);
        return result;
      }
      case "challenging_hypotheses": {
        const result = validateContract(ScaChallengeSchema, value, "Scripted challenges");
        result.challenges = result.challenges.slice(0, 1);
        return result;
      }
      case "selecting_evidence_actions": {
        const result = validateContract(ScaActionsSchema, value, "Scripted actions");
        result.actions = result.actions.slice(0, 1);
        if (this.application) {
          const action = result.actions[0];
          if (action === undefined) throw new Error("Missing scripted action");
          result.actions.push({
            ...action,
            id: "test-application",
            kind: "application_test",
            application_plan_id: this.wrongPlan ? "foreign" : "admitted-test",
          });
        }
        return result;
      }
      case "adjudicating_evidence": {
        const result = validateContract(ScaDispositionsSchema, value, "Scripted dispositions");
        result.dispositions = result.dispositions.slice(0, 1);
        return result;
      }
      case "assessing_learning": {
        const result = validateContract(ScaLearningSchema, value, "Scripted learning");
        if (this.learning)
          for (const entry of result.outcomes) {
            entry.validation_id = "independent-corpus";
            entry.status = "quarantined";
            entry.proposed_rule = this.noRule ? null : canonicalJson(candidateRule);
            if (this.noRule) {
              entry.status = "not_feasible";
              entry.reason = "No bounded rule expresses this invariant.";
            }
            entry.positive_test = "Design only; caller fixture truth remains independent";
            entry.negative_test = "Design only";
          }
        return result;
      }
      default:
        return value;
    }
  }
}
export function advancedFixture(
  applicationResult: "completed" | "unknown" | "unsupported" = "completed",
  promotion = true,
  rescan = true
) {
  rmSync(path.join(sourceRoot, "src/handler.php"));
  const root = path.dirname(sourceRoot),
    work = path.join(root, "learning-work"),
    namespace = path.join(root, "future-releases");
  mkdirSync(work, { mode: 0o700 });
  mkdirSync(namespace, { mode: 0o700 });
  const snapshot = describeScaSourceSnapshotV1({
    source_root: sourceRoot,
    scope: { include: [], exclude: [] },
  }).source_snapshot_sha256;
  const harness = path.join(root, "harness.mjs");
  writeFileSync(harness, "// Never executed by this scripted test\n", { mode: 0o600 });
  const baselinePath = path.join(root, "baseline.json"),
    baseline = canonicalJson({ rules: [] });
  writeFileSync(baselinePath, baseline, { mode: 0o600 });
  const fixtures = (
    [
      "vulnerable",
      "fixed",
      "negative_neighbor",
      "benign",
      "generalized",
      "retained_vulnerable",
      "held_out",
      "broader_regression",
      "performance",
    ] as const
  ).map((case_class, index) => {
    const match = !["fixed", "negative_neighbor", "benign"].includes(case_class);
    const text = `// Independent scripted oracle\n// ruleid: test.handler\nexec(input);\n// ${match ? "ruleid" : "ok"}: test.handler\n${match ? "exec(other);" : "String(other);"}\n`;
    return {
      id: `fixture-${index}`,
      case_class,
      file_name: `${case_class}.ts`,
      content_base64: Buffer.from(text).toString("base64"),
      content_sha256: sha256(text),
      control_lines: [3],
      baseline_matches: [],
      assertions: [{ line: 5, match }],
    };
  });
  const resources = {
    vm_timeout_seconds: 30,
    test_timeout_ms: 1000,
    cpu_seconds: 1,
    memory_bytes: 67108864,
    processes: 4,
    file_bytes: 1024,
    output_bytes: 1024,
  };
  const metachecks = canonicalJson({
    rules: ["scripted.check-one", "scripted.check-two"].map((id) => ({
      id,
      languages: ["yaml"],
      message: "Scripted only",
      severity: "ERROR",
      pattern: 'message: ""',
    })),
  });
  const metachecksPath = path.join(root, "scripted-metachecks.json");
  writeFileSync(metachecksPath, metachecks, { mode: 0o600 });
  const advanced = validateContract(
    ScaAdvancedInputsSchema,
    {
      application_tests: [
        {
          id: "admitted-test",
          source_snapshot_sha256: snapshot,
          interpreter: "node",
          source_files: [
            { path: "src/handler.ts", content_sha256: sha256(sources["src/handler.ts"]) },
          ],
          harness: { path: harness, sha256: sha256(readFileSync(harness)) },
          test_inputs: [],
          stdin: null,
          expected_exit_code: 0,
          resources,
          maxima: resources,
        },
      ],
      learning: [
        {
          id: "independent-corpus",
          source_snapshot_sha256: snapshot,
          baseline: {
            release_sha256: sha256("retained-baseline"),
            rules_path: baselinePath,
            rules_sha256: sha256(baseline),
            rule_ids: [],
          },
          tool: {
            executable: path.join(root, "synthetic-tool"),
            sha256: sha256("synthetic-only"),
            version: "synthetic-only",
          },
          offline_validation: {
            python: {
              executable: path.join(root, "scripted-python"),
              sha256: sha256("scripted-python"),
              version: "scripted-only",
            },
            core: {
              executable: path.join(root, "scripted-core"),
              sha256: sha256("scripted-core"),
              version: "synthetic-only",
            },
            metachecks: {
              rules_path: metachecksPath,
              rules_sha256: sha256(metachecks),
              rule_ids: ["scripted.check-one", "scripted.check-two"],
            },
          },
          language: "typescript",
          rule_id: "test.handler",
          fixtures,
          fixture_truth_sha256: sha256(canonicalJson(fixtures)),
          limits: {
            inactivity_ms: 30000,
            max_output_bytes: 1048576,
            max_file_bytes: 1048576,
            max_input_bytes: 8388608,
            max_memory_mb: 512,
            max_processes: 20,
            performance_bound_ms: 300000,
          },
        },
      ],
      promotions: promotion
        ? [
            {
              validation_id: "independent-corpus",
              candidate_sha256: sha256(canonicalJson(candidateRule)),
              namespace,
              predecessor_release_sha256: sha256("retained-baseline"),
              successor_revision: 1,
              authority_sha256: sha256("explicit promotion"),
            },
          ]
        : [],
      rescans:
        promotion && rescan
          ? [
              {
                validation_id: "independent-corpus",
                source_snapshot_sha256: snapshot,
                rescan_revision: 1,
                authority_sha256: sha256("separate explicit rescan"),
              },
            ]
          : [],
    },
    "Independent caller inputs"
  );
  let applications = 0,
    processes = 0;
  const host: ScaAdvancedHostOptions = {
    applicationFactory() {
      return {
        async run(value, owner) {
          const request = validateContract(
            OrdinaryApplicationTestRequestSchema,
            value,
            "Scripted application"
          );
          applications++;
          if (applicationResult !== "unsupported") {
            owner.beforeSubmit("scripted-unit");
            owner.accepted("scripted-unit");
          }
          return {
            schema_id: "penny.sca-ordinary-application-result.v1",
            schema_version: 1,
            request_sha256: sha256(canonicalJson(request)),
            source_snapshot_sha256: request.source_snapshot_sha256,
            status:
              applicationResult === "completed"
                ? "completed"
                : applicationResult === "unknown"
                  ? "incomplete"
                  : "unsupported",
            reason:
              applicationResult === "completed"
                ? "observed"
                : applicationResult === "unknown"
                  ? "containment_unproved"
                  : "not_configured",
            execution:
              applicationResult === "completed"
                ? "RUN"
                : applicationResult === "unknown"
                  ? "UNKNOWN"
                  : "NOT RUN",
            acceptance:
              applicationResult === "unknown"
                ? "ambiguous"
                : applicationResult === "completed"
                  ? "terminal"
                  : "not_submitted",
            cleanup:
              applicationResult === "unknown"
                ? "unproved"
                : applicationResult === "completed"
                  ? "proved"
                  : "not_needed",
            quarantine_required: applicationResult === "unknown",
            passed: applicationResult === "completed" ? true : null,
            exit_code: applicationResult === "completed" ? 0 : null,
            stdout_base64: "",
            stderr_base64: "",
            raw_receipt_base64:
              applicationResult === "unsupported"
                ? ""
                : Buffer.from("SCRIPTED_RECEIPT_PRIVATE_ONLY").toString("base64"),
            retained_workspace: null,
            evidence_scope:
              "untrusted_guest_observation_not_vulnerability_or_isolation_attestation",
          };
        },
      };
    },
    learning: {
      workRoot: work,
      async runOffline(invocation) {
        processes++;
        if (invocation.arguments.includes("-c")) return processResult(invocation, "");
        if (invocation.arguments.includes("-check_rules"))
          return processResult(
            invocation,
            `.\n${canonicalJson({ version: "synthetic-only", results: [], errors: [], skipped_rules: [] })}`
          );
        if (invocation.arguments.includes("--validate"))
          return processResult(invocation, '{"errors":[]}');
        const config = invocation.arguments[invocation.arguments.indexOf("--config") + 1];
        if (config === undefined) throw new Error("Missing scripted config");
        const targets = invocation.arguments.slice(invocation.arguments.indexOf("--") + 1);
        const file = targets[0];
        if (file === undefined) throw new Error("Missing scripted target");
        const fixture = fixtures.find((x) => x.file_name === path.basename(file)),
          expected =
            fixture === undefined
              ? [2]
              : [3, ...fixture.assertions.filter((x) => x.match).map((x) => x.line)];
        if (invocation.arguments.includes("--test"))
          return processResult(
            invocation,
            canonicalJson({
              config_missing_tests: [],
              config_missing_fixtests: [],
              config_with_errors: [],
              results: {
                [config]: {
                  checks: {
                    "test.handler": {
                      passed: true,
                      matches: {
                        [realpathSync(file)]: {
                          expected_lines: expected,
                          reported_lines: expected,
                        },
                      },
                      errors: [],
                    },
                  },
                },
              },
              fixtest_results: {},
            })
          );
        const results = targets.flatMap((target) =>
          (fixture === undefined ? (target.endsWith("handler.ts") ? [2] : []) : expected).map(
            (line) => ({ check_id: "test.handler", path: target, start: { line }, end: { line } })
          )
        );
        return processResult(
          invocation,
          canonicalJson({
            version: "synthetic-only",
            results,
            errors: [],
            paths: { scanned: targets },
            skipped_rules: [],
          }),
          results.length > 0
        );
      },
    },
  };
  return { advanced, host, snapshot, namespace, counts: () => ({ applications, processes }) };
}
function processResult(
  request: ScaProcessRequestV1,
  stdout: string,
  matches = false
): ScaProcessResultV1 {
  return {
    schema_id: "penny.sca-process-result.v1",
    schema_version: 1,
    request_sha256: sha256(canonicalJson(request)),
    status: matches ? "nonzero_exit" : "succeeded",
    exit_code: matches ? 1 : 0,
    signal: null,
    stdout,
    stderr: "",
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(""),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    failure_code: matches ? "nonzero_exit" : "none",
  };
}
