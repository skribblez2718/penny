import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  hostOperationDeclarationSha256,
  validateHostOperationReceipt,
  validateHostOperationResult,
  type HostOperationAdapterV1,
} from "../../orchestration/dist/host-operations/contracts.js";
import type { HostOperationUseValidatorV1 } from "../../orchestration/dist/host-operations/owner.js";
import { FileHostOperationResultCache } from "../../orchestration/dist/host-operations/result-cache.js";
import type { ModelClient } from "../../orchestration/dist/model-client.js";
import type { PlaybookRegistration } from "../../orchestration/dist/playbooks/registry.js";
import { OrchestrationService } from "../../orchestration/dist/service.js";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { scaBrokerExecuteRequestSha256 } from "../../orchestration/dist/sca/broker-contracts.js";
import {
  validateScaP07HostRequestV1,
  validateScaP07HostResultV1,
  validateScaP07TerminalV1,
  SCA_P07_HOST_RESULT_SCHEMA,
  SCA_P07_TERMINAL_SCHEMA,
} from "../../orchestration/dist/sca/p07-contracts.js";
import { createScaP07ProductionHostCompositionV1 } from "../../orchestration/dist/sca/p07-production-host.js";
import {
  createScaP07CandidateRegistrationV1,
  SCA_P07_CANDIDATE_DECLARATION,
  SCA_P07_CANDIDATE_PLAYBOOK_NAME,
} from "../../orchestration/dist/sca/p07-playbook.js";
import { initializePennyState } from "../../orchestration/dist/state/index.js";
import { buildScaP07Lineage } from "../../orchestration/tests/sca-p07-lineage.js";
import type { ScaAdapterRegistry, ScaOperationAdapter } from "../src/adapters.js";
import { ScaJobStore } from "../src/job-store.js";
import { startScaService, type ScaServiceHandle } from "../src/server.js";

/**
 * Provider-free end-to-end regression for the registered (inactive) SCA P07 host operation.
 *
 * It drives the real `OrchestrationService` host-operation path (engine -> `HostOperationRuntimeOwner`)
 * through the real P07 production Unix-domain-socket client into a real `startScaService`
 * server/router/`ScaJobOwner`. The only substitution is one deterministic `ScaOperationAdapter`
 * inside the service process: no VM, container, provider, model, or network is touched.
 *
 * Durable state is entirely temporary and project-bound: the service's `ArtifactStore`/checkpointer,
 * the state-root-global host-operation lease catalog, a `FileHostOperationResultCache`, and a real
 * `ScaJobStore`. The test asserts the exact request/result artifacts, the terminal receipt counters,
 * exactly one `settled -> consumed` journal transition (the single parent continuation), and that a
 * recovery/restart with the service socket already shut down performs no duplicate broker effect.
 */

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Best-effort teardown only; the assertion result is already decided.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TOKEN = "sca-p07-socket-e2e-token-000000000000000000";
const RUN_ID = "sca-p07-socket-e2e";
/** The P07 lineage broker scope; the real job store binds the broker request's project exactly. */
const SCA_PROJECT_ID = "project";

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "penny-sca-p07-e2e-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function identity() {
  return {
    schema_version: 2 as const,
    run_id: RUN_ID,
    session_id: `session-${RUN_ID}`,
    playbook: SCA_P07_CANDIDATE_PLAYBOOK_NAME,
    engine_owner: "typescript" as const,
  };
}

function makeService(input: {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cache: FileHostOperationResultCache;
  readonly registration: PlaybookRegistration;
  readonly adapters: ReadonlyMap<string, HostOperationAdapterV1>;
  readonly useValidator: HostOperationUseValidatorV1;
}): OrchestrationService {
  const modelClient: ModelClient = {
    async runAgent() {
      throw new Error("the provider-free P07 socket regression must not invoke a model");
    },
  };
  return new OrchestrationService({
    projectRoot: input.projectRoot,
    env: input.env,
    modelClient,
    playbookRegistration: input.registration,
    hostOperationAdapters: input.adapters,
    hostOperationUseValidator: input.useValidator,
    hostOperationResultCache: input.cache,
  });
}

describe("SCA P07 host operation over a real sca-service Unix socket", () => {
  it("drives the registered P07 operation through the real server and recovers without a duplicate effect", async () => {
    const root = temporaryRoot();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const canonicalProjectRoot = realpathSync(projectRoot);
    const env: NodeJS.ProcessEnv = { PENNY_STATE_ROOT: path.join(root, "state") };
    const state = initializePennyState(canonicalProjectRoot, { env });

    // Open the exact project-bound artifact manifest once. The production composition and the
    // candidate registration are both constructed from it before the service that drives them.
    const compositionStore = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    cleanups.push(() => compositionStore.close());

    const socketPath = path.join(root, "sca.sock");
    const jobStore = ScaJobStore.provision(path.join(root, "jobs.db"), {
      projectId: SCA_PROJECT_ID,
    });
    cleanups.push(() => jobStore.close());

    const cacheRoot = path.join(root, "host-operation-cache");
    const cache = await FileHostOperationResultCache.provision(cacheRoot);

    // A wall-clock-relative base keeps the broker request window open for the real transport.
    const base = new Date(Date.now() - 1_000).toISOString();
    const lineage = buildScaP07Lineage({
      store: compositionStore,
      run_id: RUN_ID,
      kinds: ["source_query"],
      now: base,
    });
    const planItem = lineage.plan.items[0];
    if (planItem === undefined) throw new Error("P07 lineage plan item is absent");
    const brokerRequestSha256 = scaBrokerExecuteRequestSha256(planItem.broker_request);

    // Deterministic broker evidence output: a real project-bound artifact the service adapter may
    // cite as a terminal output. The service never reads its bytes; the owner keeps it as receipt
    // evidence only, and the P07 result embeds the exact ref.
    const outputContent = canonicalJson({ evidence: "deterministic-p07-output" });
    const outputRef = compositionStore.persist({
      metadata: {
        schema_version: 2,
        run_id: RUN_ID,
        phase: "SCA-P07",
        branch_id: null,
        kind: "sca-p07-evidence-output",
        operation_id: "sca-p07-evidence-output",
        version: 1,
        producer: "host:sca-p07-candidate",
        media_type: "application/json",
        content_schema: { schema_id: "penny.sca-p07-evidence-output.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: outputContent,
    });

    let adapterRuns = 0;
    const deterministicAdapter: ScaOperationAdapter = {
      async capability() {
        throw new Error("the P07 socket regression never requests service capability");
      },
      async run() {
        adapterRuns += 1;
        return {
          terminal_status: "succeeded" as const,
          partial: false,
          truncated: false,
          output_refs: [outputRef],
          result_item_count: 1,
          failure: null,
        };
      },
    };
    const adapters: ScaAdapterRegistry = {
      source_query: deterministicAdapter,
      graph_query: deterministicAdapter,
      application_test: deterministicAdapter,
    };

    // One production composition supplies the declaration, adapter map, use-time validator, and
    // socket-bound backend key. The candidate registration is built from those exact values, so no
    // hand-built adapter or duplicated current-admission logic remains here.
    const composition = createScaP07ProductionHostCompositionV1({
      store: compositionStore,
      resolve_current_authority_ref: () => lineage.authority_ref,
      socket: {
        socket_path: socketPath,
        authentication_token: TOKEN,
        response_inactivity_ms: 5_000,
        max_response_bytes: 1_048_576,
      },
      backend_binding_id: SCA_P07_CANDIDATE_DECLARATION.backend_binding_id,
      lease_profile_id: SCA_P07_CANDIDATE_DECLARATION.lease_profile.profile_id,
      lease_duration_ms: SCA_P07_CANDIDATE_DECLARATION.lease_profile.duration_ms,
      lease_renew_after_ms: SCA_P07_CANDIDATE_DECLARATION.lease_profile.renew_after_ms,
      queue_inactivity_ms: SCA_P07_CANDIDATE_DECLARATION.lease_profile.queue_inactivity_ms,
      operation_inactivity_ms: SCA_P07_CANDIDATE_DECLARATION.operation_inactivity_ms,
      max_input_bytes: SCA_P07_CANDIDATE_DECLARATION.max_input_bytes ?? 0,
      max_output_bytes: SCA_P07_CANDIDATE_DECLARATION.max_output_bytes,
    });
    const registration = createScaP07CandidateRegistrationV1({
      declaration: composition.declaration,
      backend_key_sha256: composition.backend_key_sha256,
      resolve_current_authority_ref: () => lineage.authority_ref,
    });

    // Declaration, backend key, and adapter are one exact binding across the composition and the
    // registration: the production input reproduces the candidate fixture declaration, the
    // registration declares that exact declaration, and the adapter map is keyed by it.
    expect(canonicalJson(composition.declaration)).toBe(
      canonicalJson(SCA_P07_CANDIDATE_DECLARATION)
    );
    expect(registration.host_operations?.declarations).toEqual([composition.declaration]);
    expect(composition.adapters.get(composition.declaration.adapter_id)).toBe(composition.adapter);
    expect(composition.adapter.adapter_id).toBe(composition.declaration.adapter_id);
    expect(composition.use_validator.validateUse).toEqual(expect.any(Function));

    const service: ScaServiceHandle = await startScaService(
      { socketPath, authenticationToken: TOKEN },
      { adapters, jobStore }
    );
    cleanups.push(() => service.shutdown());

    const orchestration = makeService({
      projectRoot: canonicalProjectRoot,
      env,
      cache,
      registration,
      adapters: composition.adapters,
      useValidator: composition.use_validator,
    });
    cleanups.push(() => orchestration.close());

    const terminal = await orchestration.execute({
      schema_version: 2,
      action: "start",
      identity: identity(),
      goal: "Exercise the registered inactive SCA P07 host operation over the real service socket.",
      constraints: { plan_ref: lineage.plan_ref, admission_ref: lineage.admission_ref },
      project_root: canonicalProjectRoot,
      trust_profile: "hardened-untrusted",
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "plan", ref: lineage.plan_ref },
          { slot: "admission", ref: lineage.admission_ref },
        ],
      },
    });

    expect(terminal).toMatchObject({ action: "incomplete", status: "incomplete", met: false });
    if (!("result" in terminal)) throw new Error("P07 terminal directive lacks a result");
    const p07Terminal = validateScaP07TerminalV1(terminal.result);
    expect(p07Terminal).toMatchObject({
      schema_id: SCA_P07_TERMINAL_SCHEMA,
      status: "candidate_complete",
      evidence_complete: true,
      phase_gate_passed: false,
      release_eligible: false,
      campaign_complete: false,
      execution_occurred: true,
      action_count: 1,
      completed_action_count: 1,
      blocked_action_count: 0,
      not_invoked_action_count: 0,
    });
    expect(adapterRuns).toBe(1);

    // Exactly one durable host-operation journal record: one prepared reservation and one
    // `settled -> consumed` transition (the single parent continuation), plus bounded progress.
    const journal = orchestration.checkpointer.hostOperationCallsForRun(RUN_ID);
    expect(journal).toHaveLength(1);
    const record = journal[0];
    if (record === undefined) throw new Error("P07 journal record is absent");
    expect(record.lifecycle).toBe("consumed");
    expect(record.disposition?.outcome).toBe("completed");
    // The persisted policy binding is the composition's exact declaration and socket-bound backend
    // key, projected through the candidate registration rather than a hardcoded fixture constant.
    expect(record.policy_binding.adapter_id).toBe(composition.declaration.adapter_id);
    expect(record.policy_binding.backend_key_sha256).toBe(composition.backend_key_sha256);
    expect(record.policy_binding.declaration_sha256).toBe(
      hostOperationDeclarationSha256(composition.declaration)
    );

    // Declaration drift is refused before request I/O: the composition's use-time validator only
    // accepts the declared binding, so a differently-keyed declaration fails closed.
    expect(() =>
      composition.use_validator.validateUse({
        directive: record.directive,
        declaration: { ...composition.declaration, backend_binding_id: "drifted-backend" },
        request_bytes: new Uint8Array(),
        signal: new AbortController().signal,
        reportWorkMilestone() {},
      })
    ).toThrow(/declaration drift/u);
    const events = orchestration.checkpointer.events(RUN_ID);
    expect(events.filter((event) => event.eventType === "host_operation_prepared")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "host_operation_consumed")).toHaveLength(1);
    const hostEventTypes = new Set(
      events
        .filter((event) => event.eventType.startsWith("host_operation_"))
        .map((event) => event.eventType)
    );
    expect([...hostEventTypes].sort()).toEqual([
      "host_operation_consumed",
      "host_operation_prepared",
      "host_operation_progress",
    ]);

    // Exact request artifact.
    const requestText = orchestration.artifacts
      .readById(record.request_ref.artifact_id)
      .toString("utf8");
    const hostRequest = validateScaP07HostRequestV1(JSON.parse(requestText));
    expect(requestText).toBe(canonicalJson(hostRequest));
    expect(hostRequest.broker_request).toEqual(planItem.broker_request);
    expect(hostRequest.broker_request_sha256).toBe(brokerRequestSha256);

    // Exact result artifact and the settled platform result/receipt evidence.
    const resultRef = record.operation_result_ref;
    const receiptRef = record.host_receipt_ref;
    const platformRef = record.platform_result_ref;
    if (resultRef === null || receiptRef === null || platformRef === null) {
      throw new Error("P07 settled evidence is incomplete");
    }
    const resultText = orchestration.artifacts.readById(resultRef.artifact_id).toString("utf8");
    const hostResult = validateScaP07HostResultV1(JSON.parse(resultText), hostRequest);
    expect(resultText).toBe(canonicalJson(hostResult));
    expect(resultRef.content_schema).toEqual({
      schema_id: SCA_P07_HOST_RESULT_SCHEMA,
      schema_version: 1,
    });
    expect(hostResult.receipt.terminal_status).toBe("succeeded");
    expect(hostResult.receipt.request_sha256).toBe(brokerRequestSha256);
    expect(hostResult.receipt.output_refs).toEqual([outputRef]);
    expect(hostResult.receipt.result_item_count).toBe(1);
    expect(orchestration.artifacts.readById(outputRef.artifact_id).toString("utf8")).toBe(
      outputContent
    );

    const hostReceipt = validateHostOperationReceipt(
      JSON.parse(orchestration.artifacts.readById(receiptRef.artifact_id).toString("utf8"))
    );
    expect(hostReceipt.disposition.outcome).toBe("completed");
    expect(hostReceipt.output_artifact_count).toBe(1);
    expect(hostReceipt.output_bytes).toBe(Buffer.byteLength(resultText, "utf8"));
    expect(hostReceipt.result_sha256).toBe(sha256(Buffer.from(resultText)));
    expect(hostReceipt.poll_count).toBeGreaterThanOrEqual(1);
    const platformResult = validateHostOperationResult(
      JSON.parse(orchestration.artifacts.readById(platformRef.artifact_id).toString("utf8"))
    );
    expect(platformResult.disposition).toEqual(hostReceipt.disposition);
    expect(platformResult.operation_result_ref).toEqual(resultRef);

    // The real sca-service job owner retained exactly one terminal job for this exact request.
    const storedJob = jobStore.get(brokerRequestSha256);
    expect(storedJob?.receipt?.terminal_status).toBe("succeeded");
    expect(storedJob?.request.job_id).toBe(planItem.broker_request.job_id);

    // Restart boundary: close the project service, stop the socket server, and recover from a fresh
    // service instance. The terminal run must replay from durable state only.
    orchestration.close();
    await service.shutdown();
    jobStore.close();

    let restartValidatorCalls = 0;
    const restartAdapterMap = new Map<string, HostOperationAdapterV1>();
    const restarted = makeService({
      projectRoot: canonicalProjectRoot,
      env,
      cache: await FileHostOperationResultCache.provision(cacheRoot),
      registration,
      adapters: restartAdapterMap,
      useValidator: {
        validateUse() {
          restartValidatorCalls += 1;
          throw new Error("restart recovery must not re-enter the host operation");
        },
      },
    });
    cleanups.push(() => restarted.close());
    const recovered = await restarted.execute({
      schema_version: 2,
      action: "recover",
      identity: identity(),
    });
    expect(recovered).toMatchObject({ action: "incomplete", status: "incomplete", met: false });
    if (!("result" in recovered)) throw new Error("recovered terminal directive lacks a result");
    const recoveredTerminal = validateScaP07TerminalV1(recovered.result);
    expect(recoveredTerminal.terminal_sha256).toBe(p07Terminal.terminal_sha256);
    expect(restartValidatorCalls).toBe(0);
    expect(adapterRuns).toBe(1);
    expect(restarted.checkpointer.hostOperationCallsForRun(RUN_ID)).toHaveLength(1);
    expect(
      restarted.checkpointer
        .events(RUN_ID)
        .filter((event) => event.eventType === "host_operation_consumed")
    ).toHaveLength(1);
  }, 60_000);
});
