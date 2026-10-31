/** Offline cognition/scanner/graph fixtures only. The ordinary engine, runner, owner and artifacts are real. */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { initializePennyState } from "../../dist/state/setup.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../../dist/model-client.js";
import type { JsonValue } from "../../dist/contracts.js";
import {
  createScaOrdinaryHostAdapters,
  sourceOnlyEvidence,
  unavailablePreparation,
  type ScaOrdinaryRuntime,
  type ScaGraphData,
} from "../../dist/sca/ordinary-host.js";
import {
  ScaDispositionsSchema,
  ScaEvidenceSchema,
  ScaPreparationSchema,
  type ScaPointer,
  type ScaPreparation,
} from "../../dist/sca/ordinary-contracts.js";
import { validateContract } from "../../dist/contracts.js";
export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../../..");
export const roots: string[] = [];
export let sourceRoot = "";
export const sources = {
  "src/handler.ts": "export function handler(input: string) {\n  return exec(input);\n}",
  "src/handler.php": "<?php\nfunction handler($input) {\n  return shell_exec($input);\n}",
  "src/safe.ts":
    "export function safe(input: string) {\n  const fixed = input === 'status' ? 'status' : 'help';\n  return exec(fixed);\n}",
};
export function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-ordinary-test-"));
  roots.push(root);
  sourceRoot = path.join(root, "target");
  mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
  for (const [name, content] of Object.entries(sources))
    writeFileSync(path.join(sourceRoot, name), content);
  // Large context is indexed and explicitly not selected, never compulsorily read by two primaries.
  writeFileSync(
    path.join(sourceRoot, "src", "unrelated.ts"),
    `export const value = ${JSON.stringify("x".repeat(80_000))};\n`
  );
  const env = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_ENABLED: "false",
    PI_OBSERVABILITY_AUTO_START: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  return env;
}
export function identity(runId: string) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook: "sca",
    engine_owner: "typescript" as const,
  };
}
export function start(runId: string) {
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: identity(runId),
    goal: "Assess the synthetic PHP/TS fixture without target execution.",
    constraints: {
      schema_version: 1,
      source_root: sourceRoot,
      scope: { include: [], exclude: [] },
      execution_mode: "static_only",
      model: "deepseek-flash",
    },
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
  };
}
export function summary(value: unknown): string {
  return `Complete offline fixture stage; no live provider/scanner/graph attestation.\nSUMMARY:${canonicalJson({ ...validateRecord(value), confidence: "PROBABLE" })}`;
}
function validateRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Fixture summary is not an object");
  return { ...value };
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function pointer(name: keyof typeof sources): ScaPointer {
  return {
    path: name,
    start_line: name.endsWith("php") ? 2 : 1,
    end_line: sources[name].split("\n").length,
    exact_quote: name.endsWith("php")
      ? sources[name].split("\n").slice(1).join("\n")
      : sources[name],
  };
}
export type ScaFixtureMode = "confirmed" | "refuted" | "noalert" | "missing" | "repair" | "exhaust";
export function fixtureRuntime(mode: ScaFixtureMode = "confirmed"): ScaOrdinaryRuntime {
  return {
    async prepare({ corpus }) {
      const prepared = unavailablePreparation(
        corpus,
        "Offline scanner/graph fixture; not native execution."
      );
      prepared.gaps = [];
      for (const cap of prepared.capabilities) {
        cap.status = mode === "missing" ? "unavailable" : "completed";
        cap.detail =
          mode === "missing"
            ? "Fixture models an unavailable material tool."
            : "Offline deterministic scanner/semantic graph fixture observation, not installed tool proof.";
        cap.version = "offline-fixture-v1";
        cap.evidence_sha256 = sha256(cap.id);
      }
      if (mode !== "noalert")
        prepared.leads = ["src/handler.ts", "src/handler.php"].map((name, index) => ({
          id: `lead-${index}`,
          origin: "semgrep",
          title: "Synthetic scanner candidate, not proof",
          locations: [{ path: name, start_line: 1, end_line: name.endsWith("php") ? 4 : 3 }],
          evidence_sha256: sha256(name),
        }));
      const graphs: ScaGraphData[] =
        mode === "missing"
          ? []
          : (["php", "javascript_typescript"] as const).map((language) => {
              const observation = {
                schema_version: 1 as const,
                complete: true,
                rows: [],
                files: prepared.files
                  .filter((file) => file.language === language)
                  .map((file) => ({
                    path: file.path,
                    content_sha256: file.content_sha256,
                    status: "supported" as const,
                    detail: "Offline synthetic frontend support record; not native semantic proof.",
                  })),
              };
              const graph = Buffer.from(`synthetic-${language}-semantic-cpg-fixture`);
              return {
                schema_version: 1,
                language,
                source_snapshot_sha256: prepared.source_snapshot_sha256,
                format: "joern-cpg",
                bytes_base64: graph.toString("base64"),
                graph_sha256: sha256(graph),
                tool_version: "offline-fixture-v1",
                query_observations: [
                  {
                    query_id: "offline-query",
                    raw_stdout_sha256: sha256(canonicalJson(observation)),
                    observation_sha256: sha256(canonicalJson(observation)),
                    observation,
                  },
                ],
              };
            });
      return {
        preparation: validateContract(ScaPreparationSchema, prepared, "Fixture preparation"),
        graphs,
      };
    },
    async gather({ corpus, actions }) {
      return sourceOnlyEvidence({ corpus, actions });
    },
  };
}
export function fixtureAdapters(mode: ScaFixtureMode = "confirmed") {
  return createScaOrdinaryHostAdapters(fixtureRuntime(mode));
}
export class ScriptedScaClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private reader: ((id: string) => string) | undefined;
  private reviewCount = 0;
  constructor(readonly mode: ScaFixtureMode = "confirmed") {}
  bindArtifactReader(reader: (id: string) => string): void {
    this.reader = reader;
  }
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    // Explicit scripted model-boundary observation, NOT provider/SDK evidence.
    invocation.admitResolvedModel?.({ provider: "ollama", model: "deepseek-v4.1-flash:cloud" });
    invocation.guardModelDispatch?.(`SCRIPTED fixture opening: ${invocation.task}`);
    return { text: summary(this.output(invocation)) };
  }
  output(invocation: AgentInvocation): unknown {
    const read = (kind: string): unknown => {
      const ref = invocation.inputArtifacts.find((entry) => entry.kind === kind);
      if (ref === undefined || this.reader === undefined)
        throw new Error(`Fixture missing exact ${kind}`);
      return JSON.parse(this.reader(ref.artifact_id));
    };
    const stage = invocation.stateId;
    const names: (keyof typeof sources)[] =
      this.mode === "refuted" ? ["src/safe.ts"] : ["src/handler.ts", "src/handler.php"];
    const pointers = names.map(pointer);
    if (stage === "selecting_scanner_dependency_leads") {
      const prep = validateContract(
        ScaPreparationSchema,
        read("sca-preparation-result"),
        "Fixture prep"
      );
      return {
        schema_version: 1,
        selections:
          this.mode === "noalert"
            ? []
            : prep.leads.map((lead, index) => ({
                id: `selection-${index}`,
                lead_ids: [lead.id],
                rationale:
                  "Inspect exact caller-bounded initiation and effect, including alternative controls.",
                ranges: [
                  this.mode === "refuted"
                    ? { path: "src/safe.ts", start_line: 1, end_line: 4 }
                    : lead.locations[0],
                ],
              })),
        deferred: [],
        gaps: [],
      };
    }
    if (stage === "selecting_underdetected_no_alert_surfaces") {
      const prep = validateContract(
        ScaPreparationSchema,
        read("sca-preparation-result"),
        "Fixture prep"
      );
      return {
        schema_version: 1,
        selections:
          this.mode === "noalert"
            ? pointers.map((p, index) => ({
                id: `noalert-${index}`,
                lead_ids: [],
                rationale:
                  "Scanner silence leaves this bounded actor-to-effect surface worth testing.",
                ranges: [{ path: p.path, start_line: p.start_line, end_line: p.end_line }],
              }))
            : [],
        deferred: prep.files
          .filter((file) => this.mode !== "noalert" || !names.some((name) => name === file.path))
          .map((file) => ({
            id: file.path,
            reason:
              "Deliberately not selected for no-alert semantic focus; bounded assessment is not repository safety.",
          })),
        gaps: [],
      };
    }
    const selections =
      this.mode === "noalert"
        ? ["noalert-0", "noalert-1"]
        : this.mode === "refuted"
          ? ["selection-0", "selection-1"]
          : ["selection-0", "selection-1"];
    const ids = names.map((_name, index) => `h-${index}`);
    if (stage === "forming_hypotheses")
      return {
        schema_version: 1,
        hypotheses: names.map((_name, index) => ({
          id: ids[index],
          selection_ids: this.mode === "refuted" ? selections : [selections[index]],
          claim:
            "Caller input may influence the command interpreted by the handler's downstream execution adapter.",
          violated_invariant: "Untrusted operation choice must not become interpreter syntax.",
          threat_id: `{THREAT-${index}}`,
          support: [pointers[index]],
          refutation_test:
            "Inspect whether a fixed allowlist replaces all attacker-controlled command text before the effect.",
          expected_support: "Raw input reaches the effect argument without replacement.",
          expected_refutation: "Every effect receives only fixed operation text.",
          unknowns: [],
        })),
        unformed: [],
        gaps: [],
      };
    if (stage === "challenging_hypotheses")
      return {
        schema_version: 1,
        challenges: ids.map((id, index) => ({
          hypothesis_id: id,
          alternative: "A fixed operation mapping may constrain command text.",
          counterevidence: this.mode === "refuted" ? [pointers[index]] : [],
          missing: [],
        })),
        gaps: [],
      };
    if (stage === "selecting_evidence_actions")
      return {
        schema_version: 1,
        actions: pointers.map((p, index) => ({
          id: `a-${index}`,
          hypothesis_id: ids[index],
          kind: "source",
          ranges: [{ path: p.path, start_line: p.start_line, end_line: p.end_line }],
          query_id: null,
          rationale: "Resolve the exact disputed effect argument and intervening control.",
          discriminating_observation:
            "Direct input versus fixed allowlist result passed to effect.",
        })),
        gaps: [],
      };
    if (stage === "adjudicating_evidence") {
      const evidence = validateContract(
        ScaEvidenceSchema,
        read("sca-validated-evidence"),
        "Fixture observed evidence"
      );
      const grounded = (p: ScaPointer, index: number) => {
        const ranges = evidence.results
          .filter(
            (x) =>
              x.action_id === `a-${index}` &&
              x.hypothesis_id === ids[index] &&
              x.status === "completed"
          )
          .flatMap((x) => x.pointers)
          .filter((x) => x.path === p.path)
          .sort((a, b) => a.start_line - b.start_line);
        let next = p.start_line;
        for (const r of ranges) {
          if (r.start_line > next) break;
          next = Math.max(next, r.end_line + 1);
        }
        return next > p.end_line;
      };
      return {
        schema_version: 1,
        dispositions: pointers.map((p, index) => ({
          hypothesis_id: ids[index],
          disposition: !grounded(p, index)
            ? "inconclusive"
            : this.mode === "refuted"
              ? "refuted"
              : "confirmed_code",
          duplicate_of: null,
          reason:
            this.mode === "refuted"
              ? "The complete source replaces every input with a fixed operation before exec."
              : "The complete named handler directly passes input to the effect with no intervening guard; this is code evidence only.",
          evidence: grounded(p, index) ? [p] : [],
          counterevidence: grounded(p, index) && this.mode === "refuted" ? [p] : [],
          action_ids: [`a-${index}`],
          gaps: [],
        })),
        gaps: [],
      };
    }
    const reconciled = () =>
      validateContract(ScaDispositionsSchema, read("sca-reconciliation"), "Fixture reconciliation");
    if (stage === "assessing_learning") {
      const eligible = reconciled().dispositions.filter(
        (entry) => entry.disposition === "confirmed_code"
      );
      return {
        schema_version: 1,
        outcomes: eligible.map((entry) => ({
          hypothesis_id: entry.hypothesis_id,
          status: "deferred",
          reason: "No empirical rule-validation job was admitted; preserve frozen baseline.",
          proposed_rule: null,
          positive_test: null,
          negative_test: null,
        })),
        no_eligible_findings_reason:
          eligible.length === 0
            ? "All hypotheses were refuted or remain inconclusive; no confirmed issue is eligible."
            : null,
        baseline_unchanged: true,
        promotion_performed: false,
        rescan: "not_run",
        gaps: [],
      };
    }
    if (stage === "materializing_report") {
      const reportable = reconciled().dispositions.filter((entry) =>
        ["confirmed_code", "probable", "theoretical", "inconclusive"].includes(entry.disposition)
      );
      const vector = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N";
      return {
        schema_version: 1,
        executive_summary:
          "This bounded fixture assessment inspects selected handler flows. Source-only conclusions are not PoC execution or a repository-safety certification.",
        findings: reportable.map((entry) => {
          const index = ids.indexOf(entry.hypothesis_id);
          const p = pointers[index];
          if (p === undefined) throw new Error("Fixture missing report pointer");
          return {
            hypothesis_id: entry.hypothesis_id,
            title: "Untrusted handler argument reaches the command adapter",
            cwe_id: "CWE-78",
            cwe_name:
              "Improper Neutralization of Special Elements used in an OS Command ('OS Command Injection')",
            description:
              "The handler normally forwards a requested operation. It passes the caller's full text to a command adapter instead of selecting a fixed operation, so a caller could influence command interpretation. This source evidence does not establish a deployed endpoint or observed execution.",
            prerequisites: [
              "Exact synthetic source snapshot and authorized source-only review; no live service or credentials used.",
            ],
            reproduction: [
              `Open ${p.path} in the exact snapshot.`,
              "Trace the input argument through the full quoted handler to the effect call; the distinguishing oracle is raw input versus a fixed allowlist argument. NOT RUN as a runtime test.",
            ],
            reproduction_gaps: [],
            code_analysis: [
              {
                explanation:
                  "Initiation: caller provides the handler input; no preceding validation appears in the complete named handler.",
                pointer: p,
              },
              {
                explanation:
                  "Propagation and sink: the same input reaches the command effect. No mitigating fixed-operation mapping appears; deployment reachability remains outside the code-verified claim.",
                pointer: p,
              },
            ],
            remediation: `Change ${p.path} handler to select fixed operation arguments before the command adapter, following src/safe.ts:1-4. This restores separation between caller data and interpreter structure.`,
            regression_tests: [
              "Reject command separators and substitutions; accept the documented fixed status/help operations; verify rejected inputs never reach the command adapter.",
            ],
            compatibility_risks:
              "Restricting free-form command behavior changes callers; migrate them to documented operation names before rollout.",
            cvss_vector: vector,
            scoring_rationale:
              "Offline synthetic metric rationale for fixture impact; not real scanner or live semantic proof. Required conditions are scored present with perfect attacker knowledge and final vulnerable-system impact only.",
            metric_evidence: vector
              .split("/")
              .slice(1)
              .map((metric) => ({
                metric: metric.split(":")[0],
                rationale:
                  "Synthetic fixture assumption, supported by complete handler flow; no discovery-difficulty or deployment discount.",
                evidence: [p],
              })),
            missing_metrics: [],
          };
        }),
        chains: [],
        gaps: [],
      };
    }
    if (stage === "reviewing_report" || stage === "verifying_final_product") {
      const report = invocation.inputArtifacts.find((entry) => entry.kind === "semantic-core");
      if (report === undefined) throw new Error("Fixture missing exact report");
      const fail =
        stage === "reviewing_report" &&
        (this.mode === "exhaust" || (this.mode === "repair" && this.reviewCount++ === 0));
      return {
        schema_version: 1,
        report_artifact_id: report.artifact_id,
        report_sha256: report.content_digest,
        verdict: fail ? "GAP" : "PASS",
        checked_evidence_ids: invocation.inputArtifacts
          .filter((ref) => ref.kind !== "agent-output" && ref.kind !== "sca-semantic-diagnostic")
          .map((ref) => ref.artifact_id),
        claim_support: !fail,
        counterevidence_addressed: true,
        execution_truth: true,
        scoring_semantics: true,
        redaction: true,
        report_quality: true,
        issues: fail ? ["Clarify this exact report's synthetic scope and source-only claim."] : [],
      };
    }
    throw new Error(`Unknown ordinary SCA fixture phase: ${stage}`);
  }
}
export function prepFrom(value: unknown): ScaPreparation {
  return validateContract(ScaPreparationSchema, value, "Test prep");
}
export function jsonObject(value: unknown): Record<string, JsonValue> {
  const parsed = validateRecord(value);
  const text = canonicalJson(parsed);
  const result: unknown = JSON.parse(text);
  if (!isRecord(result)) throw new Error("Test JSON object absent");
  return validateContract(TypeJsonObject, result, "Test JSON");
}
import { Type } from "typebox";
import { JsonValueSchema } from "../../dist/contracts.js";
const TypeJsonObject = Type.Record(Type.String(), JsonValueSchema);
