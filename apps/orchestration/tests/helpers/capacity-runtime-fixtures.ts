import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "../../dist/artifact-store.js";
import { Checkpointer } from "../../dist/checkpointer.js";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { loadRuntimeConfig } from "../../dist/config.js";
import { RunContext } from "../../dist/context.js";
import type {
  ArtifactRef,
  Directive,
  InvokeHostOperationDirectiveV1,
} from "../../dist/contracts.js";
import type { HostCapacityProductiveObservationV1 } from "../../dist/host-operations/capacity-runtime-contracts.js";
import { OrchestrationEngine } from "../../dist/engine.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
  type HostCapacityMeasurementSourceV1,
  type HostCapacityProductiveSourceV1,
} from "../../dist/host-operations/capacity-authority.js";
import {
  hostCapacityWorkerKey,
  type HostCapacityPolicyV1,
  type HostCapacitySnapshotV1,
} from "../../dist/host-operations/capacity-contracts.js";
import {
  HostOperationCapacityRuntimeBinding,
  type HostCapacityDemandSourceV1,
} from "../../dist/host-operations/capacity-runtime.js";
import {
  hostOperationLeaseProfileSha256,
  hostOperationPolicyBinding,
  type HostOperationAdapterV1,
  type HostOperationCallRecordV1,
  type HostOperationDispositionV1,
} from "../../dist/host-operations/contracts.js";
import { HostOperationLeaseAuthority } from "../../dist/host-operations/lease-authority.js";
import {
  HostOperationRuntimeOwner,
  type HostOperationRuntimeOwnerOptions,
} from "../../dist/host-operations/owner.js";
import type { Playbook } from "../../dist/playbooks/playbook.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistration,
} from "../../dist/playbooks/registry.js";
import { ReceiptAuthority } from "../../dist/receipts.js";
import { initializePennyState } from "../../dist/state/index.js";
import { capacityPolicy, meters } from "./capacity-fixtures.js";
import { requireValue } from "./narrowing.js";

export const CAPACITY_ARTIFACT = {
  schema_version: 1,
  port_name: "result",
  artifact_kind: "capacity-fixture",
  schema_id: "penny.capacity-fixture.v1",
  schema_version_required: 1,
} as const;
export const CAPACITY_COMPLETED: HostOperationDispositionV1 = {
  outcome: "completed",
  remote_disposition: "proven_terminal",
  lease_disposition: "released",
  retryable: false,
  reason_code: null,
};
class CapacityConsumer implements Playbook {
  initialize(context: RunContext): Directive {
    return this.dispatch(context);
  }
  dispatch(context: RunContext): Directive {
    if (context.pendingDirective !== null) return context.pendingDirective;
    const ref = requireValue(
      context.selectedArtifacts.find((x) => x.kind === "host-operation-receipt"),
      "fixture receipt"
    );
    const next: Directive = {
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: context.stateId,
      gate_id: "fixture-capacity-complete",
      challenge: "fixture-ack",
      payload_digest: ref.content_digest,
      questions: [{ id: "ack", prompt: "Acknowledge this synthetic operation." }],
    };
    context.pendingDirective = next;
    context.status = "awaiting_user";
    return next;
  }
  resume(context: RunContext): Directive {
    return this.dispatch(context);
  }
  cancel(context: RunContext): Directive {
    return this.dispatch(context);
  }
  acceptSummary(context: RunContext): Directive {
    return this.dispatch(context);
  }
  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
}
export function capacityRuntimeRegistration(): PlaybookRegistration {
  const lease = {
    profile_id: "fixture-lease",
    profile_version: 1 as const,
    duration_ms: 500,
    renew_after_ms: 100,
    queue_inactivity_ms: 200,
  };
  const base = requireValue(resolvePlaybook("research"), "fixture base registration");
  return {
    ...base,
    host_states: [...(base.host_states ?? []), "capacity-state"],
    construct: () => new CapacityConsumer(),
    host_operations: {
      schema_version: 1,
      max_active_per_run: 1,
      declarations: [
        {
          schema_version: 1,
          operation_kind: "video_render",
          adapter_id: "fixture-adapter",
          backend_binding_id: "fixture-service",
          request: { ...CAPACITY_ARTIFACT, port_name: "request" },
          result: CAPACITY_ARTIFACT,
          capability_classes: ["artifact_store"],
          lease_profile: { ...lease, profile_sha256: hostOperationLeaseProfileSha256(lease) },
          operation_inactivity_ms: 10_000,
          max_request_bytes: 65_536,
          max_output_artifacts: 4,
          max_output_bytes: 65_536,
          max_progress_events: 1000,
          max_pre_acceptance_retries: 0,
          recovery_semantics: "journaled_remote_submission_v1",
          cancellation_semantics: "registered_remote_cancel_then_observe_v1",
        },
      ],
    },
  };
}
export function capacityDemandSource(
  bindingId = "video-a",
  amount = 20
): HostCapacityDemandSourceV1 {
  const binding = requireValue(
    capacityPolicy().bindings.find((x) => x.binding_id === bindingId),
    "fixture binding"
  );
  return {
    requestFor: (input) => ({
      schema_id: "penny.host-capacity-request.v1",
      schema_version: 1,
      project_id: input.project_id,
      operation_record_id: input.operation_record_id,
      binding_id: bindingId,
      demands: [...binding.resource_ids]
        .sort()
        .map((resource_id) => ({ resource_id, slots: 1, meters: meters(amount) })),
    }),
  };
}
export function prepareCapacityRun(
  input: {
    readonly config: ReturnType<typeof loadRuntimeConfig>;
    readonly checkpointer: Checkpointer;
    readonly artifacts: ArtifactStore;
    readonly engine: OrchestrationEngine;
  },
  runId: string,
  worker = "worker-a"
): InvokeHostOperationDirectiveV1 {
  const identity = {
    schema_version: 2 as const,
    run_id: runId,
    session_id: `session-${runId}`,
    playbook: "research",
    engine_owner: "typescript" as const,
  };
  const request = input.artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "capacity-state",
      branch_id: null,
      kind: CAPACITY_ARTIFACT.artifact_kind,
      operation_id: `request:${runId}`,
      version: 1,
      producer: "host:capacity-fixture",
      media_type: "application/json",
      content_schema: { schema_id: CAPACITY_ARTIFACT.schema_id, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson({ fixture: runId }),
  });
  const registration = input.engine.registration;
  const declaration = requireValue(
    registration.host_operations?.declarations[0],
    "fixture declaration"
  );
  const directive: InvokeHostOperationDirectiveV1 = {
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity,
    state_id: "capacity-state",
    attempt: 1,
    operation_id: `operation:${runId}`,
    operation_kind: declaration.operation_kind,
    registration_sha256: runtimeRegistrationSha256(registration),
    request_ref: request,
    request_sha256: request.content_digest,
    input_artifacts: { schema_version: 2, artifacts: [] },
    expected_result: declaration.result,
    policy_binding: hostOperationPolicyBinding(declaration, hostCapacityWorkerKey(worker)),
  };
  const context = RunContext.create({
    identity,
    goal: "provider-free capacity lifecycle",
    constraints: {},
    projectRoot: input.config.projectRoot,
    trustProfile: "trusted-interactive",
    maxSteps: 20,
    registrationContractBinding: {
      schema_version: 1,
      registration_name: registration.name,
      contract_sha256: skillContractSha256(registration.contract),
      registration_sha256: runtimeRegistrationSha256(registration),
    },
    initialArtifacts: [request],
  });
  context.transition("capacity-state");
  context.pendingDirective = directive;
  input.checkpointer.createRun(context, "capacity_fixture_started", {});
  input.engine.liveness.bindPolicy(context);
  return directive;
}

/** Final snapshots are exact immutable artifacts, not completion/stop booleans. The synthetic
 * collector is provider-free test evidence only; no production metering is qualified. */
export function fixtureMeasurements(
  artifacts: () => ArtifactStore
): HostCapacityMeasurementSourceV1 {
  return {
    read: ({ journal }) => {
      const ref = requireValue(
        artifacts().refFor(
          journal.identity.run_id,
          "capacity-meter",
          null,
          "capacity-meter",
          `meter:${journal.operation_record_id}`,
          artifacts().lastVersion(
            journal.identity.run_id,
            "capacity-meter",
            null,
            "capacity-meter",
            `meter:${journal.operation_record_id}`
          )
        ),
        "final measured artifact"
      );
      const value: unknown = JSON.parse(artifacts().readById(ref.artifact_id).toString("utf8"));
      return value;
    },
  };
}
export function captureCapacityMeasurement(
  artifacts: ArtifactStore,
  journal: HostOperationCallRecordV1,
  request: ReturnType<HostCapacityDemandSourceV1["requestFor"]>,
  amount = 3,
  sourceRevision = 1,
  kind: "cumulative" | "final" = "final"
): void {
  const snapshot: HostCapacitySnapshotV1 = {
    schema_id: "penny.host-capacity-snapshot.v1",
    schema_version: 1,
    operation_record_id: journal.operation_record_id,
    request_sha256: sha256(canonicalJson(request)),
    lease: requireValue(journal.lease, "meter lease"),
    source_revision: sourceRevision,
    evidence_sha256: sha256(
      canonicalJson({ synthetic_measurement: amount, request: journal.request_sha256 })
    ),
    kind,
    readings: request.demands.map((x) => ({ resource_id: x.resource_id, meters: meters(amount) })),
  };
  artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: journal.identity.run_id,
      phase: "capacity-meter",
      branch_id: null,
      kind: "capacity-meter",
      operation_id: `meter:${journal.operation_record_id}`,
      version: sourceRevision,
      producer: "host:synthetic-meter",
      media_type: "application/json",
      content_schema: { schema_id: snapshot.schema_id, schema_version: 1 },
      parent_ref:
        sourceRevision === 1
          ? null
          : requireValue(
              artifacts.refFor(
                journal.identity.run_id,
                "capacity-meter",
                null,
                "capacity-meter",
                `meter:${journal.operation_record_id}`,
                sourceRevision - 1
              ),
              "preceding meter"
            ),
      upstream_refs: [journal.request_ref],
    },
    content: canonicalJson(snapshot),
  });
}
export function fixtureProductiveSource(
  artifacts: () => ArtifactStore,
  limits = { max_observations: 100, max_units: 1000 }
): HostCapacityProductiveSourceV1 {
  return {
    source_id: "synthetic-progress",
    producer: "host:synthetic-progress",
    ...limits,
    read: ({ journal }) =>
      artifacts().selected(
        journal.identity.run_id,
        "host-capacity-progress",
        null,
        "host-capacity-progress"
      ),
  };
}
export function captureProductiveObservation(
  artifacts: ArtifactStore,
  journal: HostOperationCallRecordV1,
  request: ReturnType<HostCapacityDemandSourceV1["requestFor"]>,
  revision: number,
  units: number,
  patch: Partial<HostCapacityProductiveObservationV1> = {}
): ArtifactRef {
  const observation: HostCapacityProductiveObservationV1 = {
    schema_id: "penny.host-capacity-productive-observation.v1",
    schema_version: 1,
    project_id: journal.project_id,
    operation_record_id: journal.operation_record_id,
    directive_sha256: journal.directive_sha256,
    operation_request_sha256: journal.request_sha256,
    capacity_request_sha256: sha256(canonicalJson(request)),
    lease: requireValue(journal.lease, "productive fence"),
    remote_correlation_sha256: requireValue(
      journal.remote_correlation_sha256,
      "productive remote target"
    ),
    source_id: "synthetic-progress",
    productive_revision: revision,
    completed_units: units,
    total_units: 1000,
    observed_at_ms: Date.now(),
    kind: "productive_output",
    ...patch,
  };
  const parent = artifacts.selected(
    journal.identity.run_id,
    "host-capacity-progress",
    null,
    "host-capacity-progress"
  );
  const ref = artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: journal.identity.run_id,
      phase: "host-capacity-progress",
      branch_id: null,
      kind: "host-capacity-progress",
      operation_id: `capacity-productive:${journal.operation_record_id}:synthetic-progress`,
      version: revision,
      producer: "host:synthetic-progress",
      media_type: "application/json",
      content_schema: { schema_id: observation.schema_id, schema_version: 1 },
      parent_ref: parent ?? null,
      upstream_refs: [journal.request_ref],
    },
    content: canonicalJson(observation),
  });
  artifacts.select(ref);
  return ref;
}
export function syntheticCapacityAdapter(
  onMeasured: (journal: HostOperationCallRecordV1) => void,
  counter: { submissions: number }
): HostOperationAdapterV1 {
  return {
    adapter_id: "fixture-adapter",
    inspectRequest: ({ directive }) => ({
      schema_version: 1,
      operation_kind: directive.operation_kind,
      adapter_id: directive.policy_binding.adapter_id,
      backend_binding_id: directive.policy_binding.backend_binding_id,
      backend_key_sha256: directive.policy_binding.backend_key_sha256,
    }),
    run: async (context) => {
      if (context.journal.remote_correlation_id === null) {
        context.beginSubmission();
        counter.submissions += 1;
        context.recordRemoteAccepted(`remote:${context.directive.operation_id}`);
      }
      const content = canonicalJson({ ok: true, request: context.directive.request_sha256 });
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256(content),
        byte_length: Buffer.byteLength(content),
        item_count: 1,
        poll_count: 2,
      });
      onMeasured(context.journal);
      const output = context.persist({
        disposition: CAPACITY_COMPLETED,
        operation_result: { contract: CAPACITY_ARTIFACT, media_type: "application/json", content },
      });
      return { disposition: CAPACITY_COMPLETED, ...output };
    },
  };
}
export class CapacityRuntimeFixture implements Disposable {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config: ReturnType<typeof loadRuntimeConfig>;
  readonly registration = capacityRuntimeRegistration();
  checkpointer: Checkpointer;
  artifacts: ArtifactStore;
  engine: OrchestrationEngine;
  leases: HostOperationLeaseAuthority;
  capacity: HostOperationCapacityAuthority;
  project: HostCapacityProjectAuthority;
  readonly counter = { submissions: 0 };
  demands = capacityDemandSource();
  constructor(
    readonly policy: HostCapacityPolicyV1 = capacityPolicy(),
    install = true,
    readonly productiveLimits?: { readonly max_observations: number; readonly max_units: number }
  ) {
    this.root = mkdtempSync(path.join(tmpdir(), "capacity-runtime-"));
    const projectRoot = path.join(this.root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    this.env = { PENNY_STATE_ROOT: path.join(this.root, "state") };
    initializePennyState(projectRoot, { env: this.env });
    this.config = loadRuntimeConfig(projectRoot, this.env);
    this.checkpointer = Checkpointer.openExisting(this.config.dbPath, undefined, {
      projectId: this.config.projectId,
    });
    this.artifacts = ArtifactStore.openExisting(this.config.artifactRoot, {
      projectId: this.config.projectId,
    });
    this.engine = this.createEngine();
    this.project = this.createProject();
    this.leases = new HostOperationLeaseAuthority(this.config.stateRoot);
    if (install) HostOperationCapacityAuthority.configure(this.config.stateRoot, policy);
    this.capacity = new HostOperationCapacityAuthority({
      stateRoot: this.config.stateRoot,
      policy,
      projects: [this.project],
    });
  }
  private createProject(): HostCapacityProjectAuthority {
    return new HostCapacityProjectAuthority(
      this.config.projectId,
      this.checkpointer,
      this.artifacts,
      fixtureMeasurements(() => this.artifacts),
      this.productiveLimits === undefined
        ? undefined
        : fixtureProductiveSource(() => this.artifacts, this.productiveLimits)
    );
  }
  private createEngine(): OrchestrationEngine {
    return new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.config.projectRoot,
      maxSteps: 20,
      receiptAuthority: ReceiptAuthority.loadExisting(this.config.receiptKeyPath),
      artifactRevisions: this.artifacts,
      artifactStore: this.artifacts,
      artifactReader: this.artifacts,
      playbookRegistration: this.registration,
    });
  }
  demand(journal: HostOperationCallRecordV1): ReturnType<HostCapacityDemandSourceV1["requestFor"]> {
    return this.demands.requestFor({
      project_id: journal.project_id,
      operation_record_id: journal.operation_record_id,
      directive: journal.directive,
      request_bytes: this.artifacts.readById(journal.request_ref.artifact_id),
    });
  }
  measure(
    journal: HostOperationCallRecordV1,
    amount = 3,
    sourceRevision = 1,
    kind: "cumulative" | "final" = "final"
  ): void {
    const request = this.demands.requestFor({
      project_id: journal.project_id,
      operation_record_id: journal.operation_record_id,
      directive: journal.directive,
      request_bytes: this.artifacts.readById(journal.request_ref.artifact_id),
    });
    captureCapacityMeasurement(this.artifacts, journal, request, amount, sourceRevision, kind);
  }
  owner(
    options: Partial<
      Pick<HostOperationRuntimeOwnerOptions, "fault" | "useValidator" | "adapters">
    > = {},
    optIn = true
  ): HostOperationRuntimeOwner {
    return new HostOperationRuntimeOwner({
      projectId: this.config.projectId,
      checkpointer: this.checkpointer,
      artifacts: this.artifacts,
      leaseAuthority: this.leases,
      adapters: new Map([
        [
          "fixture-adapter",
          syntheticCapacityAdapter((journal) => this.measure(journal), this.counter),
        ],
      ]),
      ...(optIn
        ? {
            capacityRuntime: new HostOperationCapacityRuntimeBinding(
              this.capacity,
              this.project,
              this.demands
            ),
          }
        : {}),
      ...options,
    });
  }
  prepare(runId: string, worker = "worker-a"): InvokeHostOperationDirectiveV1 {
    return prepareCapacityRun(this, runId, worker);
  }
  record(directive: InvokeHostOperationDirectiveV1): HostOperationCallRecordV1 {
    return requireValue(
      this.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      ),
      "fixture journal"
    );
  }
  reopen(): void {
    this.capacity.close();
    this.leases.close();
    this.artifacts.close();
    this.checkpointer.close();
    this.checkpointer = Checkpointer.openExisting(this.config.dbPath, undefined, {
      projectId: this.config.projectId,
    });
    this.artifacts = ArtifactStore.openExisting(this.config.artifactRoot, {
      projectId: this.config.projectId,
    });
    this.engine = this.createEngine();
    this.project = this.createProject();
    this.leases = new HostOperationLeaseAuthority(this.config.stateRoot);
    this.capacity = new HostOperationCapacityAuthority({
      stateRoot: this.config.stateRoot,
      policy: this.policy,
      projects: [this.project],
    });
  }
  [Symbol.dispose](): void {
    this.capacity.close();
    this.leases.close();
    this.artifacts.close();
    this.checkpointer.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
