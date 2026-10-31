import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "../../dist/artifact-store.js";
import { Checkpointer } from "../../dist/checkpointer.js";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { RunContext } from "../../dist/context.js";
import type { InvokeHostOperationDirectiveV1 } from "../../dist/contracts.js";
import { HostOperationStateOwner } from "../../dist/host-operations/owner.js";
import { createPreparedHostOperationCallRecord } from "../../dist/host-operations/storage.js";
import {
  hostOperationLeaseProfileSha256,
  hostOperationPolicyBinding,
  validateHostOperationCallRecord,
  type HostOperationCallRecordV1,
  type HostOperationDeclarationV1,
  type HostOperationDispositionV1,
} from "../../dist/host-operations/contracts.js";
import {
  HostOperationLeaseAuthority,
  type HostOperationLeaseRequestV1,
} from "../../dist/host-operations/lease-authority.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
  type HostCapacityMeasurementSourceV1,
} from "../../dist/host-operations/capacity-authority.js";
import {
  CAPACITY_METERS,
  hostCapacityWorkerKey,
  zeroCapacityMeters,
  type HostCapacityMetersV1,
  type HostCapacityPolicyV1,
  type HostCapacityRequestV1,
  type HostCapacitySnapshotV1,
} from "../../dist/host-operations/capacity-contracts.js";
import { ProjectCatalog } from "../../dist/state/catalog.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistration,
} from "../../dist/playbooks/registry.js";
import { requireValue } from "./narrowing.js";

export function meters(amount = 0): HostCapacityMetersV1 {
  const result = zeroCapacityMeters();
  for (const key of CAPACITY_METERS) result[key] = amount;
  return result;
}
export function capacityPolicy(): HostCapacityPolicyV1 {
  const binding = (
    id: string,
    worker: string,
    resource: string,
    kind = "video_render",
    purpose: "work" | "finish" = "work"
  ) => ({
    binding_id: id,
    worker_id: worker,
    resource_ids: [resource, resource === "gpu-a" ? "store-a" : "store-b"],
    operation_kind: kind,
    adapter_id: "fixture-adapter",
    backend_binding_id: "fixture-service",
    purpose,
  });
  return {
    schema_id: "penny.host-capacity-policy.v1",
    schema_version: 1,
    policy_id: "fixture-policy",
    topology_sha256: sha256("synthetic topology, not qualification"),
    external_work_policy: "exclusive_host",
    max_admissions: 64,
    max_admissions_per_project: 32,
    max_queued: 8,
    max_queued_per_project: 4,
    max_active: 8,
    max_active_per_project: 4,
    max_snapshots_per_operation: 8,
    queue_wait_ms: 500,
    active_inactivity_ms: 1_000,
    cleanup_grace_ms: 200,
    resources: ["gpu-a", "gpu-b", "store-a", "store-b"].map((resource_id) => ({
      resource_id,
      max_slots: 2,
      protected_finish_slots: 0,
      limits: meters(100),
      protected_finish: meters(20),
    })),
    bindings: [
      binding("video-a", "worker-a", "gpu-a"),
      binding("video-b", "worker-b", "gpu-a"),
      binding("video-c", "worker-c", "gpu-b"),
      binding("image-a", "worker-a", "gpu-a", "image_render"),
      binding("voice-a", "voice-process", "gpu-a", "voice_job"),
      binding("finish-a", "finish-worker", "gpu-a", "timeline_master", "finish"),
    ],
  };
}
const ARTIFACT_CONTRACT = {
  schema_version: 1,
  port_name: "result",
  artifact_kind: "capacity-fixture",
  schema_id: "penny.capacity-fixture.v1",
  schema_version_required: 1,
} as const;
function declaration(kind: string): HostOperationDeclarationV1 {
  const lease = {
    profile_id: "fixture-lease",
    profile_version: 1 as const,
    duration_ms: 100_000,
    renew_after_ms: 20_000,
    queue_inactivity_ms: 10_000,
  };
  return {
    schema_version: 1,
    operation_kind: kind,
    adapter_id: "fixture-adapter",
    backend_binding_id: "fixture-service",
    request: { ...ARTIFACT_CONTRACT, port_name: "request" },
    result: ARTIFACT_CONTRACT,
    capability_classes: ["artifact_store"],
    lease_profile: { ...lease, profile_sha256: hostOperationLeaseProfileSha256(lease) },
    operation_inactivity_ms: 100_000,
    max_request_bytes: 65_536,
    max_output_artifacts: 4,
    max_output_bytes: 65_536,
    max_progress_events: 16,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "local_abort_only_v1",
  };
}
export interface CapacityFixtureProject {
  readonly projectId: string;
  readonly root: string;
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly owner: HostOperationStateOwner;
  readonly authority: HostCapacityProjectAuthority;
}
export interface CapacityFixtureOperation {
  record: HostOperationCallRecordV1;
  readonly request: HostCapacityRequestV1;
  readonly project: CapacityFixtureProject;
  readonly leaseRequest: HostOperationLeaseRequestV1;
}
export class CapacityFixture implements Disposable {
  readonly root: string;
  readonly stateRoot: string;
  readonly projects: CapacityFixtureProject[] = [];
  readonly policy: HostCapacityPolicyV1;
  readonly leases: HostOperationLeaseAuthority;
  readonly snapshots = new Map<string, unknown>();
  readonly registration: PlaybookRegistration;
  readonly authorities: HostOperationCapacityAuthority[] = [];
  now = 1_000;
  constructor(policy = capacityPolicy()) {
    this.policy = policy;
    const parent = process.env["PENNY_CAPACITY_TEST_ROOT"] ?? tmpdir();
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    this.root = mkdtempSync(path.join(parent, "capacity-"));
    this.stateRoot = path.join(this.root, "state");
    const base = requireValue(resolvePlaybook("research"), "base registration");
    this.registration = {
      ...base,
      host_states: [...(base.host_states ?? []), "capacity-state"],
      host_operations: {
        schema_version: 1,
        max_active_per_run: 1,
        declarations: [...new Set(policy.bindings.map((x) => x.operation_kind))].map(declaration),
      },
    };
    using catalog = new ProjectCatalog(this.stateRoot, { create: true });
    for (let index = 0; index < 2; index += 1) {
      const root = path.join(this.root, `project-${index}`);
      mkdirSync(root, { mode: 0o700 });
      const binding = catalog.registerProject(root);
      const checkpointer = Checkpointer.provision(path.join(root, "orchestration.db"), undefined, {
        projectId: binding.projectId,
      });
      const artifacts = ArtifactStore.provision(path.join(root, "artifacts"), {
        projectId: binding.projectId,
      });
      const measurements: HostCapacityMeasurementSourceV1 = {
        read: ({ journal }) => this.snapshots.get(journal.operation_record_id),
      };
      this.projects.push({
        projectId: binding.projectId,
        root,
        checkpointer,
        artifacts,
        owner: new HostOperationStateOwner(checkpointer, artifacts),
        authority: new HostCapacityProjectAuthority(
          binding.projectId,
          checkpointer,
          artifacts,
          measurements
        ),
      });
    }
    HostOperationCapacityAuthority.configure(this.stateRoot, policy);
    this.leases = new HostOperationLeaseAuthority(this.stateRoot);
  }
  core(projects = this.projects.map((x) => x.authority)): HostOperationCapacityAuthority {
    const core = new HostOperationCapacityAuthority({
      stateRoot: this.stateRoot,
      policy: this.policy,
      projects,
      now: () => this.now,
    });
    this.authorities.push(core);
    return core;
  }
  operation(
    id: string,
    bindingId = "video-a",
    projectIndex = 0,
    amount = 20,
    requestBody?: unknown
  ): CapacityFixtureOperation {
    const binding = requireValue(
      this.policy.bindings.find((x) => x.binding_id === bindingId),
      "fixture binding"
    );
    const project = requireValue(this.projects[projectIndex], "fixture project");
    const decl = requireValue(
      this.registration.host_operations?.declarations.find(
        (x) => x.operation_kind === binding.operation_kind
      ),
      "fixture declaration"
    );
    const identity = {
      schema_version: 2 as const,
      run_id: id,
      session_id: `session-${id}`,
      playbook: "research",
      engine_owner: "typescript" as const,
    };
    const requestRef = project.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: id,
        phase: "capacity-state",
        branch_id: null,
        kind: ARTIFACT_CONTRACT.artifact_kind,
        operation_id: `request-${id}`,
        version: 1,
        producer: "host:capacity-fixture",
        media_type: "application/json",
        content_schema: { schema_id: ARTIFACT_CONTRACT.schema_id, schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(requestBody ?? { fixture_id: id }),
    });
    const directive: InvokeHostOperationDirectiveV1 = {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity,
      state_id: "capacity-state",
      attempt: 1,
      operation_id: `operation-${id}`,
      operation_kind: binding.operation_kind,
      registration_sha256: runtimeRegistrationSha256(this.registration),
      request_ref: requestRef,
      request_sha256: requestRef.content_digest,
      input_artifacts: { schema_version: 2, artifacts: [] },
      expected_result: ARTIFACT_CONTRACT,
      policy_binding: hostOperationPolicyBinding(decl, hostCapacityWorkerKey(binding.worker_id)),
    };
    const context = RunContext.create({
      identity,
      goal: "provider-free atomic shared capacity fixture",
      constraints: {},
      projectRoot: project.root,
      trustProfile: "trusted-interactive",
      maxSteps: 20,
      registrationContractBinding: {
        schema_version: 1,
        registration_name: this.registration.name,
        contract_sha256: skillContractSha256(this.registration.contract),
        registration_sha256: runtimeRegistrationSha256(this.registration),
      },
      initialArtifacts: [requestRef],
    });
    context.transition("capacity-state");
    context.pendingDirective = directive;
    project.checkpointer.createRun(context, "capacity_fixture_started", {});
    const record = project.owner.reserve({
      record: createPreparedHostOperationCallRecord({
        project_id: project.projectId,
        directive,
        queue_inactivity_expires_at_ms: this.now + 10_000,
        operation_inactivity_expires_at_ms: this.now + 100_000,
        timestamp: new Date(this.now).toISOString(),
      }),
    }).record;
    const leaseRequest: HostOperationLeaseRequestV1 = {
      operation_record_id: record.operation_record_id,
      backend_key_sha256: directive.policy_binding.backend_key_sha256,
      project_id: project.projectId,
      run_id: id,
      state_id: directive.state_id,
      attempt: 1,
      operation_id: directive.operation_id,
      registration_sha256: directive.registration_sha256,
      request_sha256: directive.request_sha256,
      duration_ms: 100_000,
      queue_inactivity_expires_at_ms: record.queue_inactivity_expires_at_ms,
    };
    const operation = {
      record,
      project,
      leaseRequest,
      request: {
        schema_id: "penny.host-capacity-request.v1" as const,
        schema_version: 1 as const,
        operation_record_id: record.operation_record_id,
        project_id: project.projectId,
        binding_id: bindingId,
        demands: [...binding.resource_ids]
          .sort()
          .map((resource_id) => ({ resource_id, slots: 1, meters: meters(amount) })),
      },
    };
    this.acquire(operation);
    return operation;
  }
  acquire(operation: CapacityFixtureOperation): void {
    const acquired = this.leases.tryAcquire(operation.leaseRequest, this.now);
    if (acquired.kind === "acquired" || acquired.kind === "adopted")
      this.transition(operation, {
        lifecycle: "lease_acquired",
        lease: acquired.active.lease,
        lease_expires_at_ms: acquired.active.expires_at_ms,
      });
  }
  transition(operation: CapacityFixtureOperation, patch: Partial<HostOperationCallRecordV1>): void {
    operation.record = operation.project.owner.transition(
      operation.record,
      validateHostOperationCallRecord({
        ...operation.record,
        ...patch,
        updated_at: new Date(this.now).toISOString(),
      })
    );
  }
  submit(operation: CapacityFixtureOperation, reconcile = false): void {
    const lease = requireValue(operation.record.lease, "submit lease");
    this.leases.guardSubmission(operation.leaseRequest, lease, this.now);
    this.transition(operation, { lifecycle: "submitting" });
    const correlation = `remote-${operation.record.operation_record_id}`;
    const accepted = reconcile
      ? this.leases.reconcileRemoteAccepted(
          operation.leaseRequest,
          lease,
          sha256(correlation),
          this.now
        )
      : this.leases.markRemoteAccepted(
          operation.leaseRequest,
          lease,
          sha256(correlation),
          this.now
        );
    this.transition(operation, {
      lifecycle: "submitted",
      remote_correlation_id: correlation,
      remote_correlation_sha256: sha256(correlation),
      lease: accepted.lease,
      lease_expires_at_ms: accepted.expires_at_ms,
    });
  }
  disposition(operation: CapacityFixtureOperation, disposition: HostOperationDispositionV1): void {
    this.transition(operation, { lifecycle: "terminal", disposition });
    const lease = requireValue(operation.record.lease, "disposition lease");
    if (disposition.lease_disposition === "released")
      this.leases.release(
        operation.leaseRequest,
        lease,
        disposition,
        operation.record.remote_correlation_sha256,
        this.now
      );
    else
      this.leases.quarantine(
        operation.leaseRequest,
        lease,
        disposition,
        operation.record.remote_correlation_sha256,
        this.now
      );
  }
  snapshot(
    operation: CapacityFixtureOperation,
    reading: number,
    sourceRevision = 1,
    kind: "cumulative" | "final" = "cumulative"
  ): HostCapacitySnapshotV1 {
    const snapshot: HostCapacitySnapshotV1 = {
      schema_id: "penny.host-capacity-snapshot.v1",
      schema_version: 1,
      operation_record_id: operation.record.operation_record_id,
      request_sha256: sha256(canonicalJson(operation.request)),
      lease: requireValue(operation.record.lease, "measurement fence"),
      source_revision: sourceRevision,
      evidence_sha256: sha256(`synthetic readings ${reading}:${sourceRevision}`),
      kind,
      readings: operation.request.demands.map((x) => ({
        resource_id: x.resource_id,
        meters: meters(reading),
      })),
    };
    this.snapshots.set(operation.record.operation_record_id, snapshot);
    return snapshot;
  }
  [Symbol.dispose](): void {
    for (const core of this.authorities) core.close();
    this.leases.close();
    for (const project of this.projects) {
      project.artifacts.close();
      project.checkpointer.close();
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}
