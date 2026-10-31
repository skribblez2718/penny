import { ComfyWorkerIdentityRegistry } from "../dist/comfy/worker-identity.js";
import { StaticImagegenProfileRegistry } from "../dist/imagegen/profile-registry.js";
import { StaticVideogenProfileRegistry } from "../dist/videogen/profile-registry.js";
import { syntheticProfile, SYNTHETIC_NODE_POLICIES } from "./helpers/imagegen-fixtures.js";
import { syntheticVideogenProfile } from "./helpers/videogen-fixtures.js";

/** Literal fixture addresses only; these tests never connect to a backend. */
export function workerProfiles() {
  const image = syntheticProfile({ port: 10101 });
  const first = syntheticVideogenProfile({ port: 10101, mode: "t2v" });
  const second = syntheticVideogenProfile({ port: 10101, mode: "i2v" });
  const distinct = syntheticProfile({ port: 10102, profile_id: "distinct-image" });
  const topology = [
    { worker_id: "worker-a", endpoints: [image.endpoint, { ...image.endpoint, host: "::1" }] },
    { worker_id: "worker-c", endpoints: [distinct.endpoint] },
  ];
  const workers = new ComfyWorkerIdentityRegistry(topology);
  const images = new StaticImagegenProfileRegistry({
    profiles: [image, distinct],
    approved_profile_sha256_by_id: new Map(
      [image, distinct].map((p) => [p.profile_id, p.profile_sha256])
    ),
    node_class_policies: SYNTHETIC_NODE_POLICIES,
    worker_identities: workers,
  });
  const videos = new StaticVideogenProfileRegistry({
    profiles: [first, second],
    approved_profile_sha256_by_id: new Map(
      [first, second].map((p) => [p.profile_id, p.profile_sha256])
    ),
    worker_identities: workers,
  });
  return { image, first, second, distinct, topology, workers, images, videos };
}

import { canonicalJson } from "../dist/canonical-json.js";
import { RunContext } from "../dist/context.js";
import type { InvokeHostOperationDirectiveV1 } from "../dist/contracts.js";
import { hostOperationPolicyBinding } from "../dist/host-operations/contracts.js";
import { createPreparedHostOperationCallRecord } from "../dist/host-operations/storage.js";
import { runtimeRegistrationSha256, skillContractSha256 } from "../dist/playbooks/registry.js";
import {
  CapacityFixture,
  meters,
  type CapacityFixtureOperation,
} from "./helpers/capacity-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";

/** Real project journal/artifact custody with the key supplied by the actual profile registry,
 * rather than re-deriving a test-only worker key inside the lease fixture. No remote effects. */
export function prepareWorkerConsumer(
  f: CapacityFixture,
  input: {
    readonly id: string;
    readonly key: string;
    readonly binding_id: string;
    readonly project_index?: number;
    readonly amount?: number;
  }
): CapacityFixtureOperation {
  const binding = requireValue(
    f.policy.bindings.find((b) => b.binding_id === input.binding_id),
    "binding"
  );
  const declaration = requireValue(
    f.registration.host_operations?.declarations.find(
      (d) => d.operation_kind === binding.operation_kind
    ),
    "declaration"
  );
  const project = requireValue(f.projects[input.project_index ?? 0], "project");
  const identity = {
    schema_version: 2 as const,
    run_id: input.id,
    session_id: `session-${input.id}`,
    playbook: "research",
    engine_owner: "typescript" as const,
  };
  const request = project.artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: input.id,
      phase: "capacity-state",
      branch_id: null,
      kind: declaration.request.artifact_kind,
      operation_id: `request-${input.id}`,
      version: 1,
      producer: "host:worker-identity-fixture",
      media_type: "application/json",
      content_schema: { schema_id: declaration.request.schema_id, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson({ fixture_id: input.id }),
  });
  const directive: InvokeHostOperationDirectiveV1 = {
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity,
    state_id: "capacity-state",
    attempt: 1,
    operation_id: `operation-${input.id}`,
    operation_kind: declaration.operation_kind,
    registration_sha256: runtimeRegistrationSha256(f.registration),
    request_ref: request,
    request_sha256: request.content_digest,
    input_artifacts: { schema_version: 2, artifacts: [] },
    expected_result: declaration.result,
    policy_binding: hostOperationPolicyBinding(declaration, input.key),
  };
  const context = RunContext.create({
    identity,
    goal: "Provider-free registry to catalog worker exclusion",
    constraints: {},
    projectRoot: project.root,
    trustProfile: "trusted-interactive",
    maxSteps: 20,
    registrationContractBinding: {
      schema_version: 1,
      registration_name: f.registration.name,
      contract_sha256: skillContractSha256(f.registration.contract),
      registration_sha256: runtimeRegistrationSha256(f.registration),
    },
    initialArtifacts: [request],
  });
  context.transition("capacity-state");
  context.pendingDirective = directive;
  project.checkpointer.createRun(context, "worker_identity_started", {});
  const record = project.owner.reserve({
    record: createPreparedHostOperationCallRecord({
      project_id: project.projectId,
      directive,
      queue_inactivity_expires_at_ms: f.now + 10_000,
      operation_inactivity_expires_at_ms: f.now + 100_000,
      timestamp: new Date(f.now).toISOString(),
    }),
  }).record;
  return {
    record,
    project,
    leaseRequest: {
      operation_record_id: record.operation_record_id,
      backend_key_sha256: input.key,
      project_id: project.projectId,
      run_id: input.id,
      state_id: directive.state_id,
      attempt: 1,
      operation_id: directive.operation_id,
      registration_sha256: directive.registration_sha256,
      request_sha256: directive.request_sha256,
      duration_ms: 100_000,
      queue_inactivity_expires_at_ms: record.queue_inactivity_expires_at_ms,
    },
    request: {
      schema_id: "penny.host-capacity-request.v1",
      schema_version: 1,
      project_id: project.projectId,
      operation_record_id: record.operation_record_id,
      binding_id: input.binding_id,
      demands: [...binding.resource_ids]
        .sort()
        .map((resource_id) => ({ resource_id, slots: 1, meters: meters(input.amount ?? 20) })),
    },
  };
}
