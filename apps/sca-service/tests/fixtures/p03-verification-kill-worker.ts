/** Offline process-death fixture. All paths are supplied by the disposable test caller.
 * The only Docker observation records the REAL owner guard and kills this test worker.
 * This is never an approval, live Docker adapter, or operational entrypoint. */
import { readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { ArtifactStore } from "../../../orchestration/dist/artifact-store.js";
import { canonicalJson } from "../../../orchestration/dist/canonical-json.js";
import { Checkpointer } from "../../../orchestration/dist/checkpointer.js";
import {
  InvokeHostOperationDirectiveV1Schema,
  validateContract,
} from "../../../orchestration/dist/contracts.js";
import { OrchestrationEngine } from "../../../orchestration/dist/engine.js";
import { HostOperationLeaseAuthority } from "../../../orchestration/dist/host-operations/lease-authority.js";
import { HostOperationRuntimeOwner } from "../../../orchestration/dist/host-operations/owner.js";
import { ReceiptAuthority } from "../../../orchestration/dist/receipts.js";
import { SCA_P03_VERIFICATION_REGISTRATION } from "../../../orchestration/dist/sca/p03-bootstrap-verification.js";
import { OpaqueIdSchema, Sha256Schema } from "../../../orchestration/dist/skill-contracts/common.js";
import { OrchestrationRunner, WorkerExecutor } from "../../../orchestration/dist/worker.js";
import { ScaP03ProductionSampleInputV1Schema } from "../../src/p03-production-sampler.js";

const file = process.argv[2];
if (file === undefined) throw new Error("kill-worker exact config path required");
const value: unknown = JSON.parse(readFileSync(file, "utf8"));
const input = validateContract(
  Type.Object(
    {
      directive: InvokeHostOperationDirectiveV1Schema,
      project_id: OpaqueIdSchema,
      project_root: Type.String(),
      database: Type.String(),
      store_root: Type.String(),
      state_root: Type.String(),
      receipt_key: Type.String(),
      sample_input: ScaP03ProductionSampleInputV1Schema,
      backend: Sha256Schema,
      marker: Type.String(),
    },
    { additionalProperties: false }
  ),
  value,
  "offline kill fixture input"
);
// A bundled CLI import must not start its unrelated main entrypoint.
process.argv[1] = "";
const { createScaP03BootstrapVerificationDeterministicTestOnlyAdapterV1 } =
  await import("../../src/p03-bootstrap-verification.js");
using checkpointer = Checkpointer.openExisting(input.database, undefined, {
  projectId: input.project_id,
});
using store = ArtifactStore.openExisting(input.store_root, { projectId: input.project_id });
using leases = new HostOperationLeaseAuthority(input.state_root);
const engine = new OrchestrationEngine(checkpointer, {
  projectRoot: input.project_root,
  maxSteps: 20,
  receiptAuthority: ReceiptAuthority.loadExisting(input.receipt_key),
  artifactStore: store,
  artifactReader: store,
  artifactRevisions: store,
  playbookRegistration: SCA_P03_VERIFICATION_REGISTRATION,
});
const adapter = createScaP03BootstrapVerificationDeterministicTestOnlyAdapterV1({
  store,
  sample_input: input.sample_input,
  approved_backend_resource_sha256: input.backend,
  docker_observations: async () => {
    const record = checkpointer.hostOperationCallForDirective(
      input.directive.identity.run_id,
      input.directive.state_id,
      input.directive.attempt,
      input.directive.operation_id
    );
    const lease = leases.inspect(input.backend);
    if (
      record?.lifecycle !== "submitting" ||
      lease.state !== "active" ||
      lease.active.phase !== "submission_guarded"
    )
      throw new Error("kill point reached without real guard/journal");
    writeFileSync(input.marker, canonicalJson({ lifecycle: record.lifecycle, lease }), {
      mode: 0o600,
      flush: true,
    });
    process.kill(process.pid, "SIGKILL");
    throw new Error("SIGKILL unexpectedly returned");
  },
});
const owner = new HostOperationRuntimeOwner({
  projectId: input.project_id,
  checkpointer,
  artifacts: store,
  leaseAuthority: leases,
  adapters: new Map([[adapter.adapter_id, adapter]]),
});
const workers = new WorkerExecutor(
  {
    async runAgent() {
      throw new Error("kill fixture forbids model dispatch");
    },
  },
  store,
  {
    projectRoot: input.project_root,
    parallelConcurrency: 1,
    registration: SCA_P03_VERIFICATION_REGISTRATION,
  }
);
await new OrchestrationRunner(engine, workers, undefined, owner).runUntilBoundary(input.directive);
throw new Error("kill fixture unexpectedly completed");
