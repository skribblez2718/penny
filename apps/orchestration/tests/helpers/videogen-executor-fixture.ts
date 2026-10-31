import path from "node:path";
import { OrchestrationEngine } from "../../dist/engine.js";
import { WorkerExecutor, OrchestrationRunner } from "../../dist/worker.js";
import { createVideogenRegistration } from "../../dist/playbooks/videogen.js";
import { validateRegistrationContract } from "../../dist/playbooks/registry.js";
import {
  validateVideogenPrivateConfig,
  type VideogenRuntimeProvidersV1,
} from "../../dist/videogen/runtime-config.js";
import { TEST_RECEIPT_AUTHORITY } from "../fixtures/test-receipt-authority.js";
import { FoundationFixture, FOUNDATION_LIMITS } from "./videogen-foundation-fixtures.js";
import { videogenStageEnvelope, videogenStageWorkerFixtures } from "./videogen-stage-fixtures.js";
import { canonicalJson } from "../../dist/canonical-json.js";
import { workerState, validateVideogenWorker } from "../../dist/videogen/workers.js";
const root = path.resolve(import.meta.dirname, "../../../..");
export function fixtureProviders(f: FoundationFixture): VideogenRuntimeProvidersV1 {
  const ref = f.opaque("isolated fixture, never production qualification");
  const rights = f.rights(ref);
  const config = validateVideogenPrivateConfig({
    schema_id: "penny.videogen-private-config.v1",
    schema_version: 1,
    activation: "enabled",
    context: "isolated_fixture",
    config_digest: "a".repeat(64),
    territory: "test-territory",
    limits: FOUNDATION_LIMITS,
    envelope: (({ request_ref, ...fields }) => {
      void request_ref;
      return fields;
    })(videogenStageEnvelope(ref)),
    rights: f.current_rights,
    cross_run_edge_refs: [],
    assets: [
      {
        schema_id: "penny.videogen-asset-intent.v1",
        schema_version: 1,
        asset_id: "image1",
        purpose: "look_test",
        source: "supplied",
        input_refs: [ref],
        allowed_change: "none",
        preserve_criteria: ["fixture"],
        consent_ref: ref,
        rights_ref: rights,
        estimated_meters: [{ meter: "attempts", reserved: 1 }],
        attempt_limit: 1,
      },
    ],
    routes: [
      {
        schema_id: "penny.videogen-shot-route.v1",
        schema_version: 1,
        shot_id: "shot1",
        mode: {
          mode: "t2v",
          shot_id: "shot1",
          profile_snapshot_ref: ref,
          settings_ref: ref,
          rights_refs: [rights],
          prompt_ref: ref,
          expected_output_contract_ref: ref,
          target: {
            width: 640,
            height: 360,
            frame_count: 24,
            fps: { numerator: 24, denominator: 1 },
            duration: { numerator: 1, denominator: 1 },
          },
        },
        qualified_profile_snapshot_ref: ref,
        source_refs: [],
        timing_target: { numerator: 1, denominator: 1 },
        acceptance_criteria: ["fixture"],
        rights_refs: [rights],
        required_gate: "G3",
        estimated_meters: [{ meter: "attempts", reserved: 1 }],
      },
    ],
    initial_products: [],
    model_capability_ref: ref,
    optional: { research: false, alternatives: false },
  });
  const providers: VideogenRuntimeProvidersV1 = {
    project_id: f.project_id,
    config,
    recipes: [],
    effects: new Map(),
  };
  return providers;
}
export function setup(f: FoundationFixture, supplied?: VideogenRuntimeProvidersV1) {
  const providers = fixtureProviders(f);
  const registration = createVideogenRegistration(supplied ?? providers);
  validateRegistrationContract(registration, root);
  const engine = new OrchestrationEngine(f.checkpointer, {
    projectRoot: root,
    maxSteps: 200,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactStore: f.store,
    artifactReader: f.store,
    artifactRevisions: f.store,
    playbookRegistration: registration,
  });
  const client = {
    async runAgent(
      invocation: Parameters<import("../../dist/model-client.js").ModelClient["runAgent"]>[0]
    ) {
      if (!workerState(invocation.stateId)) throw new Error("unknown fixture phase");
      const original = videogenStageWorkerFixtures()[invocation.stateId];
      const parsed = validateVideogenWorker(invocation.stateId, original);
      const target = invocation.stateId.startsWith("reference")
        ? invocation.stateId.endsWith("verify")
          ? "look"
          : "verified"
        : invocation.stateId.startsWith("rough")
          ? "rough"
          : invocation.stateId.startsWith("master")
            ? "master"
            : "shot";
      const evidence = invocation.stateId.startsWith("reference")
        ? "png_evidence-0"
        : invocation.stateId.startsWith("master")
          ? "video"
          : "evidence";
      const details =
        "target_slot" in parsed
          ? {
              ...parsed,
              target_slot: target,
              ...("evidence_slots" in parsed
                ? {
                    evidence_slots: [evidence],
                    criteria: parsed.criteria.map((x) => ({ ...x, evidence_slot: evidence })),
                  }
                : {
                    criteria: parsed.criteria.map((x) => ({
                      ...x,
                      frame_slots: [
                        invocation.stateId.startsWith("reference") ? "png_evidence-0" : target,
                      ],
                    })),
                  }),
            }
          : parsed;
      return { text: `SUMMARY:${canonicalJson(details)}` };
    },
  };
  const worker = new WorkerExecutor(client, f.store, {
    projectRoot: root,
    parallelConcurrency: 1,
    registration,
  });
  worker.setReceiptAuthority(engine.receiptAuthority);
  worker.setLivenessController(engine.liveness);
  return {
    client,
    worker,
    engine,
    runner: new OrchestrationRunner(engine, worker),
    registration,
    providers,
  };
}
