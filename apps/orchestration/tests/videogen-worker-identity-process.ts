import { Type } from "typebox";
import { Checkpointer } from "../dist/checkpointer.js";
import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import { HostOperationArtifactCustody } from "../dist/host-operations/storage.js";
import {
  HostOperationLeaseAuthority,
  type HostOperationLeaseRequestV1,
} from "../dist/host-operations/lease-authority.js";
import { OpaqueIdSchema, validateSkillSchema } from "../dist/skill-contracts/common.js";
import { workerProfiles } from "./videogen-worker-identity-fixtures.js";

// Test subprocess only. Paths are exact caller-supplied disposable stores, never discovered.
const Input = Type.Object(
  {
    state_root: Type.String({ minLength: 1, maxLength: 4096 }),
    database: Type.String({ minLength: 1, maxLength: 4096 }),
    artifacts: Type.String({ minLength: 1, maxLength: 4096 }),
    project_id: Type.String({ pattern: "^prj_[a-f0-9]{32}$" }),
    operation_record_id: Type.String({ pattern: "^hop_[a-f0-9]{64}$" }),
    consumer: Type.Union([
      Type.Literal("image"),
      Type.Literal("first"),
      Type.Literal("second"),
      Type.Literal("distinct"),
    ]),
    now: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    run_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
const text = process.argv[2];
if (text === undefined || Buffer.byteLength(text) > 16384)
  throw new Error("child input absent/oversized");
const raw: unknown = JSON.parse(text);
const input = validateSkillSchema(Input, raw, "WorkerIdentityProcessInput");
using checkpointer = Checkpointer.openExisting(input.database, undefined, {
  projectId: input.project_id,
});
using artifacts = ArtifactStore.openExisting(input.artifacts, { projectId: input.project_id });
const stored = checkpointer.hostOperationCall(input.operation_record_id);
if (stored === undefined) throw new Error("exact child journal missing");
const journal = HostOperationArtifactCustody.fromArtifactStore(artifacts).verifyForProject(
  input.project_id,
  stored
);
const profiles = workerProfiles();
const key =
  input.consumer === "image"
    ? profiles.images.resolve(profiles.image.profile_id).backend_key_sha256
    : input.consumer === "distinct"
      ? profiles.images.resolve(profiles.distinct.profile_id).backend_key_sha256
      : profiles.videos.resolve(
          input.consumer === "first" ? profiles.first.profile_id : profiles.second.profile_id
        ).backend_key_sha256;
if (journal.identity.run_id !== input.run_id || journal.policy_binding.backend_key_sha256 !== key)
  throw new Error("child current worker/journal drift");
const request: HostOperationLeaseRequestV1 = {
  operation_record_id: journal.operation_record_id,
  backend_key_sha256: key,
  project_id: input.project_id,
  run_id: journal.identity.run_id,
  state_id: journal.state_id,
  attempt: journal.attempt,
  operation_id: journal.operation_id,
  registration_sha256: journal.registration_sha256,
  request_sha256: journal.request_sha256,
  duration_ms: 100000,
  queue_inactivity_expires_at_ms: journal.queue_inactivity_expires_at_ms,
};
using leases = new HostOperationLeaseAuthority(input.state_root);
const outcome = leases.tryAcquire(request, input.now);
process.stdout.write(
  canonicalJson(
    outcome.kind === "acquired" || outcome.kind === "adopted"
      ? { kind: outcome.kind, lease: outcome.active.lease }
      : outcome
  )
);
