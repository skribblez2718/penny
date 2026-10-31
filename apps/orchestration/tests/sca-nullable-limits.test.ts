/** Provider-free unit coverage for optional SCA limits; no source analysis or worker execution. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { RunContext } from "../dist/context.js";
import {
  validateDirective,
  validateContract,
  type OutputArtifactMetadata,
  type PhaseResult,
} from "../dist/contracts.js";
import { ScaPlaybook } from "../dist/playbooks/sca.js";
import { ScaSemanticDiagnosticSchema } from "../dist/sca/ordinary-semantic.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const state = "forming_hypotheses";
const projectRoot = path.resolve(import.meta.dirname, "../../..");

function withFixture(
  limits: { maxSteps: number | null; maxIterations: number | null },
  check: (context: RunContext, store: ArtifactStore, playbook: ScaPlaybook) => void
): void {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-nullable-limits-"));
  try {
    using store = new ArtifactStore(path.join(root, "artifacts"));
    const context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: "sca-nullable-limits",
        session_id: "sca-nullable-limits-session",
        playbook: "sca",
        engine_owner: "typescript",
      },
      goal: "Check optional limits without executing an assessment.",
      constraints: {},
      projectRoot,
      trustProfile: "hardened-untrusted",
      ...limits,
    });
    context.stateId = state;
    check(context, store, new ScaPlaybook(store, store));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function metadata(context: RunContext, kind: string): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: context.identity.run_id,
    phase: state,
    branch_id: null,
    kind,
    operation_id: `fixture:${kind}`,
    version: 1,
    producer: "host:nullable-limit-fixture",
    media_type: "application/json",
    parent_ref: null,
    upstream_refs: [],
  };
}

function malformedResult(context: RunContext, store: ArtifactStore): PhaseResult {
  const output = metadata(context, "agent-output");
  const content = "Synthetic malformed routing output";
  const ref = store.persist({ metadata: output, content });
  context.stepCount = 32;
  context.pendingDirective = validateDirective({
    schema_version: 2,
    action: "invoke_agent",
    identity: context.identity,
    state_id: state,
    agent: "ida",
    attempt: context.stepCount,
    trust_profile: context.trustProfile,
    task: "Synthetic assignment",
    input_artifacts: { schema_version: 2, artifacts: [] },
    output_artifact: output,
  });
  return {
    schema_version: 2,
    run_id: context.identity.run_id,
    state_id: state,
    agent: "ida",
    attempt: context.stepCount,
    confidence: "UNCERTAIN",
    details: {},
    output_artifact: ref,
    worker_receipt: TEST_RECEIPT_AUTHORITY.sign({
      schema_version: 2,
      receipt_id: "synthetic-routing-receipt",
      run_id: context.identity.run_id,
      state_id: state,
      branch_id: null,
      agent: "ida",
      attempt: context.stepCount,
      worker_id: "synthetic-worker",
      executor: "pi-sdk",
      command: ["synthetic-unit-fixture"],
      model: null,
      working_directory: projectRoot,
      trust_profile: context.trustProfile,
      started_at: "2026-01-01T00:00:00Z",
      ended_at: "2026-01-01T00:00:01Z",
      exit_code: 0,
      output_digest: sha256(content),
      output_artifact_ref: ref,
      trusted_invocation_digest: sha256("synthetic-unit-fixture"),
    }),
  };
}

describe("SCA nullable cycle limits", () => {
  it.each([null, 3, 12])("preserves exact diagnostic policy with maxIterations=%s", (limit) => {
    for (const ordinal of [1, 2, limit ?? 9]) {
      withFixture({ maxSteps: null, maxIterations: limit }, (context, store) => {
        const rejected = store.persist({
          metadata: metadata(context, "agent-output"),
          content: "Synthetic rejected semantic output",
        });
        const diagnostic = store.persist({
          metadata: metadata(context, "sca-semantic-diagnostic"),
          content: canonicalJson({
            schema_version: 1,
            state,
            rejected_artifact: rejected,
            original_input_refs: [rejected],
            predecessor_diagnostic: null,
            rejection_ordinal: ordinal,
            revision_limit: limit === null ? null : limit - 1,
            failure: {
              code: "schema_invalid",
              location: "/synthetic",
              expected_ids: [],
              expected_pointer: null,
              allowed_ranges: [],
            },
          }),
        });
        const parsed = validateContract(
          ScaSemanticDiagnosticSchema,
          JSON.parse(store.readById(diagnostic.artifact_id).toString("utf8")),
          "Exact persisted diagnostic"
        );
        expect(parsed.rejection_ordinal).toBe(ordinal);
        expect(parsed.revision_limit).toBe(limit === null ? null : limit - 1);
      });
    }
  });

  it.each([null, 33])("allows a bound routing repair with maxSteps=%s", (limit) => {
    withFixture({ maxSteps: limit, maxIterations: null }, (context, store, playbook) => {
      const malformed = malformedResult(context, store);
      const repair = playbook.routingRepair(context, malformed);
      expect(context.stepCount).toBe(33);
      expect(context.pendingDirective).toBe(repair);
      expect(repair).toMatchObject({
        action: "invoke_agent",
        attempt: 33,
        execution_purpose: "routing_repair",
        routing_repair_binding: {
          source_artifact_ref: malformed.output_artifact,
          source_receipt_id: malformed.worker_receipt.receipt_id,
        },
      });
    });
  });

  it("enforces an explicit exhausted step limit without changing the pending assignment", () => {
    withFixture({ maxSteps: 32, maxIterations: null }, (context, store, playbook) => {
      const malformed = malformedResult(context, store);
      const pending = context.pendingDirective;
      expect(() => playbook.routingRepair(context, malformed)).toThrow("run exceeded max_steps=32");
      expect(context.stepCount).toBe(32);
      expect(context.pendingDirective).toBe(pending);
    });
  });

  it("keeps assignment-binding refusal when the step limit is unlimited", () => {
    withFixture({ maxSteps: null, maxIterations: null }, (context, store, playbook) => {
      const malformed = malformedResult(context, store);
      expect(() => playbook.routingRepair(context, { ...malformed, attempt: 31 })).toThrow(
        "routing_repair_binding_invalid"
      );
      expect(context.stepCount).toBe(32);
    });
  });
});
