import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { Directive } from "../dist/contracts.js";
import { loadRuntimeConfig } from "../dist/config.js";
import { PiAgentClient } from "../dist/model-client.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import {
  SCA_P06_REQUIRED_MODEL,
  SCA_P06_REQUIRED_TOOL_SUBSET,
  validateScaP06DecisionResultAgainstPayload,
} from "../dist/sca/p06-contracts.js";
import { SCA_P06_CANDIDATE_REGISTRATION } from "../dist/sca/p06-playbook.js";
import { initializePennyState } from "../dist/state/index.js";
import { WorkerExecutor } from "../dist/worker.js";
import { createScaP06GuardFixture, type ScaP06SmokeCase } from "./sca-p06-fixture.js";

const ENABLED = process.env.PENNY_SCA_P06_MODEL_SMOKE === "1";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
const priorStateRoot = process.env.PENNY_STATE_ROOT;

afterEach(() => {
  if (priorStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = priorStateRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directive(
  built: ReturnType<typeof createScaP06GuardFixture>
): Extract<Directive, { action: "invoke_agent" }> {
  return {
    schema_version: 2,
    action: "invoke_agent",
    identity: {
      schema_version: 2,
      run_id: built.runId,
      session_id: `session-${built.runId}`,
      playbook: "sca-p06-candidate",
      engine_owner: "typescript",
    },
    state_id: "selecting_evidence_actions",
    agent: "demetri",
    attempt: 1,
    task: 'Choose exactly one least-consequential evidence decision for the assigned hypothesis using only the exact payload. Infer each mode\'s capability independently from the hypothesis. For the result\'s payload_sha256 field, copy the exact payload.payload_sha256 JSON field inside the cognitive payload; do not copy the input artifact ref content_digest, which is a different digest. Copy exact P05 observable records and target/oracle semantics, authority/resource/revision/question/stopping bindings. No child capability is needed or available, so child_use must be exactly {"status":"not_invoked","capability_id":null,"invocation_ref":null,"reason_code":"not_required_for_decision"}. Do not invoke an action, execute P07, adjudicate a vulnerability, or claim report, release, or campaign work. No tools are available.',
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "cognitive_payload", ref: built.payloadRef },
        { slot: "disclosure_admission", ref: built.disclosureRef },
      ],
    },
    output_artifact: {
      schema_version: 2,
      run_id: built.runId,
      phase: "selecting_evidence_actions",
      branch_id: null,
      kind: "sca-p06-decision-output",
      operation_id: "sca-p06-live-smoke-output",
      version: 1,
      producer: "agent:demetri",
      media_type: "text/plain",
      content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [built.payloadRef, built.disclosureRef],
    },
    trust_profile: "hardened-untrusted",
    model_override: SCA_P06_REQUIRED_MODEL.override,
  };
}

const CASES: ReadonlyArray<{
  readonly smokeCase: ScaP06SmokeCase;
  readonly classification:
    | "source_sufficient"
    | "graph_needed"
    | "runtime_needed"
    | "no_authorized_action";
  readonly action: "source_query" | "graph_query" | "application_test" | "none";
}> = [
  { smokeCase: "source_sufficient", classification: "source_sufficient", action: "source_query" },
  { smokeCase: "graph_needed", classification: "graph_needed", action: "graph_query" },
  { smokeCase: "runtime_needed", classification: "runtime_needed", action: "application_test" },
  {
    smokeCase: "no_authorized_action",
    classification: "no_authorized_action",
    action: "none",
  },
];

(ENABLED ? describe : describe.skip)("opt-in SCA P06 DeepSeek blinded decision smoke", () => {
  it("classifies four blinded payloads on the exact zero-tool required identity", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-sca-p06-live-smoke-"));
    roots.push(root);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(root, "state"),
      PI_OBSERVABILITY_AUTO_START: "false",
      PI_OBSERVABILITY_ENABLED: "false",
    };
    process.env.PENNY_STATE_ROOT = env.PENNY_STATE_ROOT;
    const initialized = initializePennyState(PROJECT_ROOT, { env });
    const config = loadRuntimeConfig(PROJECT_ROOT, env);
    using artifacts = new ArtifactStore(initialized.paths.artifacts.root);
    const client = new PiAgentClient({
      catalogSessions: { projectId: config.projectId, root: config.subagentSessionRoot },
    });
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: PROJECT_ROOT,
      parallelConcurrency: 1,
      registration: SCA_P06_CANDIDATE_REGISTRATION,
    });
    workers.setReceiptAuthority(ReceiptAuthority.createEphemeral());
    expect(SCA_P06_REQUIRED_TOOL_SUBSET).toEqual([]);
    const observations: unknown[] = [];
    for (const expected of CASES) {
      const built = createScaP06GuardFixture(artifacts, expected.smokeCase);
      const result = (await workers.execute(directive(built)))[0];
      if (result === undefined) throw new Error("P06 live decision result is absent");
      let summary;
      try {
        summary = validateScaP06DecisionResultAgainstPayload(result.details, built.payload);
      } catch (error) {
        throw new Error(
          `live P06 ${expected.smokeCase} response was not schema/semantic compatible: ${error instanceof Error ? error.message : String(error)}; persisted=${artifacts.readById(result.output_artifact.artifact_id).toString("utf8")}`
        );
      }
      expect(summary.items).toHaveLength(1);
      expect(summary.items[0]?.decision_classification).toBe(expected.classification);
      expect(summary.items[0]?.selected_action.action_kind).toBe(expected.action);
      expect(summary.items[0]?.selected_action.execution_status).toBe("not_invoked");
      expect(summary.items[0]?.p07_execution_status).toBe("not_started");
      expect(summary.items[0]?.vulnerability_adjudication).toBe("not_performed");
      expect(summary.items[0]?.report_or_release_claimed).toBe(false);
      expect(result.worker_receipt.requested_model).toEqual(SCA_P06_REQUIRED_MODEL);
      expect(result.worker_receipt.observed_model).toEqual({
        provider: SCA_P06_REQUIRED_MODEL.provider,
        model: SCA_P06_REQUIRED_MODEL.model,
      });
      observations.push({
        smoke_case: expected.smokeCase,
        expected_classification: expected.classification,
        expected_action: expected.action,
        payload_ref: built.payloadRef,
        disclosure_ref: built.disclosureRef,
        output_ref: result.output_artifact,
        worker_receipt: result.worker_receipt,
        summary,
      });
    }

    const evidencePath = process.env.PENNY_SCA_P06_SMOKE_EVIDENCE_PATH;
    if (evidencePath !== undefined && evidencePath.trim().length > 0) {
      const evidenceBody = {
        schema_id: "penny.sca-p06-live-gate-evidence.v1",
        schema_version: 1,
        observed_at: new Date().toISOString(),
        status: "passed",
        required_model: SCA_P06_REQUIRED_MODEL,
        required_tool_subset: SCA_P06_REQUIRED_TOOL_SUBSET,
        cases: observations,
        assertions: {
          case_count: CASES.length,
          provider_calls: CASES.length,
          tools_available: 0,
          actions_invoked: 0,
          p07_runs_started: 0,
          vulnerability_adjudications: 0,
          report_or_release_claims: 0,
        },
      };
      const evidence = {
        ...evidenceBody,
        evidence_sha256: sha256(canonicalJson(evidenceBody)),
      };
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(evidencePath, 0o600);
    }
  }, 900_000);
});
