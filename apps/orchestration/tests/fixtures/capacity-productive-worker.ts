import { Type } from "typebox";
import { ArtifactStore } from "../../dist/artifact-store.js";
import { Checkpointer } from "../../dist/checkpointer.js";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { validateSkillSchema } from "../../dist/skill-contracts/common.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
} from "../../dist/host-operations/capacity-authority.js";
import {
  HostCapacityPolicyV1Schema,
  CAPACITY_METERS,
  zeroCapacityMeters,
  type HostCapacitySnapshotV1,
} from "../../dist/host-operations/capacity-contracts.js";
import { validateCapacityProductiveObservation } from "../../dist/host-operations/capacity-runtime-contracts.js";

const Input = Type.Object(
  {
    stateRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    dbPath: Type.String({ minLength: 1, maxLength: 4096 }),
    artifactRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    projectId: Type.String({ pattern: "^prj_[a-f0-9]{32}$" }),
    operationRecordId: Type.String({ pattern: "^hop_[a-f0-9]{64}$" }),
    policy: HostCapacityPolicyV1Schema,
    now: Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 }),
    revision: Type.Integer({ minimum: 1, maximum: 4 }),
    units: Type.Integer({ minimum: 1, maximum: 1000 }),
  },
  { additionalProperties: false }
);
const argument = process.argv[2];
if (argument === undefined) throw new Error("independent productive fixture input absent");
const raw: unknown = JSON.parse(argument);
const input = validateSkillSchema(Input, raw, "IndependentProductiveFixtureV1");
using checkpointer = Checkpointer.openExisting(input.dbPath, undefined, {
  projectId: input.projectId,
});
using artifacts = ArtifactStore.openExisting(input.artifactRoot, { projectId: input.projectId });
const project = new HostCapacityProjectAuthority(
  input.projectId,
  checkpointer,
  artifacts,
  { read: () => undefined },
  {
    source_id: "synthetic-progress",
    producer: "host:synthetic-progress",
    max_observations: 4,
    max_units: 1000,
    read: ({ journal }) =>
      artifacts.selected(
        journal.identity.run_id,
        "host-capacity-progress",
        null,
        "host-capacity-progress"
      ),
  }
);
using core = new HostOperationCapacityAuthority({
  stateRoot: input.stateRoot,
  policy: input.policy,
  projects: [project],
  now: () => input.now,
});
const journal = project.read(input.operationRecordId);
const capacity = core.inspect(input.operationRecordId);
if (
  capacity === undefined ||
  capacity.state !== "held" ||
  journal.lifecycle !== "submitted" ||
  journal.remote_correlation_sha256 === null ||
  journal.lease === null
)
  throw new Error("independent productive fixture exact active operation absent");
const observation = validateCapacityProductiveObservation({
  schema_id: "penny.host-capacity-productive-observation.v1",
  schema_version: 1,
  project_id: input.projectId,
  operation_record_id: input.operationRecordId,
  directive_sha256: journal.directive_sha256,
  operation_request_sha256: journal.request_sha256,
  capacity_request_sha256: sha256(canonicalJson(capacity.request)),
  lease: journal.lease,
  remote_correlation_sha256: journal.remote_correlation_sha256,
  source_id: "synthetic-progress",
  productive_revision: input.revision,
  completed_units: input.units,
  total_units: 1000,
  observed_at_ms: input.now,
  kind: "productive_output",
});
const meters = zeroCapacityMeters();
for (const meter of CAPACITY_METERS) meters[meter] = input.revision;
const snapshot: HostCapacitySnapshotV1 = {
  schema_id: "penny.host-capacity-snapshot.v1",
  schema_version: 1,
  operation_record_id: input.operationRecordId,
  request_sha256: sha256(canonicalJson(capacity.request)),
  lease: journal.lease,
  source_revision: input.revision,
  kind: "cumulative",
  evidence_sha256: sha256(canonicalJson({ fixture: true, completed_units: input.units })),
  readings: capacity.request.demands.map((x) => ({ resource_id: x.resource_id, meters })),
};
// Independent durable construction, not a payload supplied to the owner's callback.
for (const item of [
  {
    kind: "capacity-meter",
    operation: `meter:${input.operationRecordId}`,
    producer: "host:synthetic-meter",
    body: snapshot,
  },
  {
    kind: "host-capacity-progress",
    operation: `capacity-productive:${input.operationRecordId}:synthetic-progress`,
    producer: "host:synthetic-progress",
    body: observation,
  },
]) {
  const parent =
    input.revision === 1
      ? null
      : artifacts.refFor(
          journal.identity.run_id,
          item.kind,
          null,
          item.kind,
          item.operation,
          input.revision - 1
        );
  if (parent === undefined) throw new Error("independent fixture prior evidence absent");
  const ref = artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: journal.identity.run_id,
      phase: item.kind,
      branch_id: null,
      kind: item.kind,
      operation_id: item.operation,
      version: input.revision,
      producer: item.producer,
      media_type: "application/json",
      content_schema: { schema_id: item.body.schema_id, schema_version: 1 },
      parent_ref: parent,
      upstream_refs: [journal.request_ref],
    },
    content: canonicalJson(item.body),
  });
  artifacts.select(ref);
}
process.stdout.write("durable-fixture-progress\n");
