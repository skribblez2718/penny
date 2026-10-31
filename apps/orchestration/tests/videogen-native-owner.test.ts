import { describe, expect, it } from "vitest";
import { sha256 } from "../dist/canonical-json.js";
import { prepareHostEffectArtifacts } from "../dist/host-operations/effect-protocol.js";
import { createKdenliveAdapter } from "../dist/videogen/kdenlive-adapter.js";
import { KdenliveFixtureRegistry } from "../dist/videogen/kdenlive-registry.js";
import {
  NativeBuildRequestV1Schema,
  NativeOperationRequestSchema,
  NATIVE_REQUEST_CONTRACT,
  NATIVE_RESULT_CONTRACT,
} from "../dist/videogen/native-contracts.js";
import {
  readVideogenOwnerSelection,
  selectVideogenRights,
} from "../dist/videogen/owner-selection.js";
import { hostOperationPolicyBinding } from "../dist/host-operations/contracts.js";
import { HostOperationRuntimeOwner } from "../dist/host-operations/owner.js";
import { OrchestrationEngine } from "../dist/engine.js";
import type { InvokeHostOperationDirectiveV1 } from "../dist/contracts.js";
import { runtimeRegistrationSha256 } from "../dist/playbooks/registry.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { DeliveryOwnerFixture } from "./helpers/videogen-delivery-owner.js";
import { saved, XML_LIMITS } from "./helpers/videogen-native-fixtures.js";
import { RunnerFixture, NATIVE_TEST_POLICY } from "./helpers/videogen-native-runner.js";

// Native construction remains unqualified: the saved registry has no demonstrated voice/trim
// mapping. These tests prove actual checkpoint authority before any editor/driver can be invoked.
describe("native adapter concrete current G4 through the real host owner (NO editor qualification)", () => {
  it.each(["G1", "G4", "rights", "budget", "ledger", "measurement"] as const)(
    "refuses %s revocation instead of replaying a structural host",
    async (changed) => {
      using f = new DeliveryOwnerFixture();
      using process = new RunnerFixture();
      const digest = sha256(saved("single.kdenlive"));
      const driverDigest = process.driver_digest;
      if (!driverDigest) throw new Error("driver pin absent");
      const registry = new KdenliveFixtureRegistry({
        editor_build_digest: driverDigest,
        mlt_build_digest: driverDigest,
        limits: XML_LIMITS,
        fixtures: ["single.kdenlive", "ordered.kdenlive", "caption.kdenlive"].map((n) => ({
          bytes: saved(n),
          sha256: sha256(saved(n)),
        })),
      });
      const h = readVideogenOwnerSelection(f.binding.owner),
        g4 = h.gate.current_approvals.find((a) => a.gate_id === "G4");
      if (!g4) throw new Error("G4 absent");
      const budget = f.json(
        {
          schema_id: "penny.videogen-budget-reservation.v1",
          schema_version: 1,
          reservation_id: "native-fixture",
          subject_id: "shot",
          scope_gate_ref: g4.decision_ref,
          operation_kind: "kdenlive_build_verify",
          state: "held",
          reason: "applied",
          created_at_utc: "2026-01-01T00:00:00Z",
          expires_at_utc: "2027-01-01T00:00:00Z",
          policy_refs: {
            queue: f.opaque("queue"),
            inactivity: f.opaque("inactivity"),
            cleanup: f.opaque("cleanup"),
          },
          meters: [
            { meter: "attempts", unit: "count", reserved: 1, consumed: 0 },
            { meter: "stored_bytes", unit: "byte", reserved: 8000000, consumed: 0 },
          ],
        },
        "penny.videogen-budget-reservation.v1"
      );
      const build = f.json(
        {
          schema_id: "penny.videogen-native-build-request.v1",
          schema_version: 1,
          edit_ref: f.e.edit_ref,
          assets: [{ source_ref: f.e.video, role: "video", relative_path: "assets/video.mp4" }],
          fixture_digest: digest,
          editor_build_digest: driverDigest,
          mlt_build_digest: driverDigest,
          feature_subset_digest: registry.digest,
          output_root_selector: "native-output",
          limits: {
            max_xml_bytes: 262144,
            max_assets: 4,
            max_duration_frames: 10000,
            max_normalize_ms: 5000,
          },
        },
        NativeBuildRequestV1Schema.properties.schema_id.const
      );
      const declaration = {
        ...f.declaration,
        operation_kind: "kdenlive_build_verify",
        adapter_id: "native-fixture",
        request: NATIVE_REQUEST_CONTRACT,
        result: NATIVE_RESULT_CONTRACT,
      };
      const registration = {
        ...f.registration,
        host_operations: {
          schema_version: 1 as const,
          max_active_per_run: 1 as const,
          declarations: [declaration],
        },
      };
      const effect = prepareHostEffectArtifacts({
        store: f.store,
        identity: {
          project_id: f.project_id,
          run_id: f.run_id,
          state_id: "delivery-fixture",
          visit: 1,
          attempt: 1,
          kind: "kdenlive_build_verify",
          slot: "native",
          scope_ref: g4.decision_ref,
          predecessor_ref: f.e.edit_ref,
        },
        request_contract: NATIVE_REQUEST_CONTRACT,
        request_schema: NativeOperationRequestSchema,
        request: {
          schema_id: NATIVE_REQUEST_CONTRACT.schema_id,
          schema_version: 1,
          native_build_request_ref: build,
        },
        input_refs: [build, f.e.video],
        budget_reservation_ref: budget,
        expected_output_contract_ref: f.json(
          NATIVE_RESULT_CONTRACT,
          "penny.videogen-expected-native-output.v1"
        ),
      });
      const d: InvokeHostOperationDirectiveV1 = {
        schema_version: 2,
        host_operation_schema_version: 1,
        action: "invoke_host_operation",
        identity: f.context.identity,
        state_id: "delivery-fixture",
        attempt: 1,
        ...effect,
        operation_kind: "kdenlive_build_verify",
        registration_sha256: runtimeRegistrationSha256(registration),
        request_sha256: effect.request_ref.content_digest,
        input_artifacts: {
          schema_version: 2,
          artifacts: [
            { slot: "native-build", ref: build },
            { slot: "asset-0", ref: f.e.video },
          ],
        },
        expected_result: NATIVE_RESULT_CONTRACT,
        policy_binding: hostOperationPolicyBinding(declaration, f.backend),
      };
      const c = f.checkpointer.loadRunById(f.run_id);
      if (!c) throw new Error("parent absent");
      c.selectedArtifacts.push(budget, build);
      c.transition(d.state_id);
      c.pendingDirective = d;
      f.checkpointer.saveRun(c, "fixture_native_prepared", {});
      const adapter = createKdenliveAdapter({
        owner: f.binding.owner,
        host: f.binding.host,
        runner: process.runner,
        process_policy: NATIVE_TEST_POLICY,
        registry,
        output_root_selector: "native-output",
        adapter_id: declaration.adapter_id,
        backend_binding_id: declaration.backend_binding_id,
        backend_key_sha256: f.backend,
      });
      expect(
        adapter.inspectRequest({
          directive: d,
          declaration,
          request_bytes: f.store.read(d.request_ref),
          input_artifacts: d.input_artifacts,
        })
      ).toMatchObject({ operation_kind: "kdenlive_build_verify" });
      const current = f.checkpointer.loadRunById(f.run_id);
      if (!current) throw new Error("parent absent");
      if (changed === "rights")
        selectVideogenRights(
          current,
          h.rights.current_rights.map((r) => ({ ...r, status: "revoked" }))
        );
      else {
        const ref =
          changed === "G1"
            ? h.gate.current_approvals.find((a) => a.gate_id === "G1")?.decision_ref
            : changed === "G4"
              ? g4.decision_ref
              : changed === "budget"
                ? budget
                : changed === "ledger"
                  ? f.e.ledger_ref
                  : f.e.measured_ref;
        if (!ref) throw new Error("operand absent");
        current.selectedArtifacts = current.selectedArtifacts.filter(
          (r) => r.artifact_id !== ref.artifact_id
        );
      }
      f.checkpointer.saveRun(current, "fixture_native_revoked", {});
      const engine = new OrchestrationEngine(f.checkpointer, {
        projectRoot: f.root,
        maxSteps: 200,
        receiptAuthority: TEST_RECEIPT_AUTHORITY,
        artifactStore: f.store,
        artifactReader: f.store,
        artifactRevisions: f.store,
        playbookRegistration: registration,
      });
      const owner = new HostOperationRuntimeOwner({
        projectId: f.project_id,
        checkpointer: f.checkpointer,
        artifacts: f.store,
        leaseAuthority: f.leases,
        adapters: new Map([[adapter.adapter_id, adapter]]),
        useValidator: adapter,
      });
      await expect(owner.dispatch(engine, d)).rejects.toThrow();
      expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
    }
  );
});
