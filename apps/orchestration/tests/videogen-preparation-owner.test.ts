import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { OrchestrationEngine } from "../dist/engine.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  validateContract,
  ArtifactRefSchema,
  type InvokeHostOperationDirectiveV1,
} from "../dist/contracts.js";
import { HostOperationRuntimeOwner } from "../dist/host-operations/owner.js";
import { ConfinedMediaRunner } from "../dist/host-operations/confined-media-runner.js";
import { hostOperationPolicyBinding } from "../dist/host-operations/contracts.js";
import { hostCapacityWorkerKey } from "../dist/host-operations/capacity-contracts.js";
import { runtimeRegistrationSha256 } from "../dist/playbooks/runtime-registration-digest.js";
import { bootstrapVideogenRuntime } from "../dist/videogen/runtime-manifest.js";
import { VideogenRuntime } from "../dist/videogen/runtime.js";
import { CurrentRightsV1Schema } from "../dist/videogen/rights-ledger.js";
import { selectVideogenRights } from "../dist/videogen/owner-selection.js";
import { materializeRuntimeVoice } from "../dist/videogen/runtime-voice.js";
import {
  createNativeMediaAdapter,
  NATIVE_MEDIA_REQUEST,
  NATIVE_MEDIA_RESULT,
  materializeRuntimeMedia,
} from "../dist/videogen/runtime-media.js";
import {
  SourcePreparationRequestSchema,
  PREPARED_PCM,
  SourcePreparationResultSchema,
} from "../dist/videogen/runtime-preparation.js";
import { VoiceStudioJobRequestV1Schema } from "../dist/videogen/voice-studio-contracts.js";
import { executionState, saveExecution, slot } from "../dist/videogen/execution-state.js";
import { inspectCanonicalPcmWav } from "../dist/videogen/media-decode.js";
import { VoiceFixture } from "./helpers/videogen-voice-fixture.js";
import { MEDIA_LIMITS, MEDIA_POLICY, required } from "./helpers/videogen-media-fixtures.js";

/** Fake remote synthesis/consent, real journals, leases, owner dispatch and consumption.
 * PCM padding is in-process. The unused codec binding never executes a process. */
describe("settled Voice → prepared PCM owner custody (not a production film)", () => {
  it.each(["current", "stale_selection", "revoked_rights", "foreign_receipt"])(
    "consumes one separate zero-tail result; stale raw selection refuses (%s)",
    async (mode) => {
      await using f = new VoiceFixture(undefined, true);
      const declaration = {
        ...f.decode_declaration,
        request: NATIVE_MEDIA_REQUEST,
        result: NATIVE_MEDIA_RESULT,
        output_contracts: [PREPARED_PCM],
        max_input_artifacts: 4,
        max_output_artifacts: 3,
      };
      f.registration = {
        ...f.registration,
        host_operations: {
          schema_version: 1,
          max_active_per_run: 1,
          declarations: [f.declaration, declaration],
        },
      };
      f.engine = new OrchestrationEngine(f.checkpointer, {
        projectRoot: f.root,
        maxSteps: 100,
        receiptAuthority: f.engine.receiptAuthority,
        artifactStore: f.store,
        artifactReader: f.store,
        artifactRevisions: f.store,
        playbookRegistration: f.registration,
      });
      await f.start();
      await (await f.owner()).dispatch(f.engine, required(f.directive));
      const original = f.record();
      expect(original.disposition?.outcome, f.diagnostics()).toBe("completed");
      const raw = required(original.output_artifacts[0]),
        registration = runtimeRegistrationSha256(f.registration);
      const manifest: unknown = JSON.parse(
        readFileSync(new URL("./fixtures/videogen-minimal-manifest.json", import.meta.url), "utf8")
      );
      const base = bootstrapVideogenRuntime({ store: f.store, project_id: f.project_id, manifest });
      const runtime = new VideogenRuntime(f.store, f.checkpointer, f.project_id, {
        ...base,
        config: { ...base.config, territory: "test-territory", limits: MEDIA_LIMITS },
        host_owners: { leases: f.leases, state_root: f.state_root },
        effects: new Map([
          [
            "voice_job",
            {
              declaration: f.declaration,
              request_schema: VoiceStudioJobRequestV1Schema,
              createAdapter() {
                throw new Error("no new synthesis during materialization");
              },
            },
          ],
          [
            "media_decode_extract",
            {
              declaration,
              request_schema: SourcePreparationRequestSchema,
              media: { policy_ref: f.media_policy_ref },
              createAdapter() {
                throw new Error("owner injects the actual preparation adapter");
              },
            },
          ],
        ]),
      });
      const c = required(f.checkpointer.loadRunById(f.run_id));
      saveExecution(c, {
        schema_version: 1,
        config_digest: runtime.binding_digest,
        slots: [],
        shot_ids: [],
        shot_index: 0,
        asset_index: 0,
        effect_index: 0,
        effects: [],
      });
      materializeRuntimeVoice(
        runtime,
        c,
        original.operation_record_id,
        registration,
        "voice-asset"
      );
      expect(slot(executionState(c), "performance")).toEqual(raw);
      const request = validateContract(
        SourcePreparationRequestSchema,
        {
          schema_id: NATIVE_MEDIA_REQUEST.schema_id,
          schema_version: 1,
          operation_id: "prepare-voice",
          subject_id: "voice-asset",
          media_ref: raw,
          source_result_ref: original.operation_result_ref,
          source_receipt_ref:
            mode === "foreign_receipt"
              ? f.raw(
                  canonicalJson({ not_a_receipt: true }),
                  "application/json",
                  "penny.host-operation-receipt.v1"
                )
              : original.host_receipt_ref,
          decode_policy_ref: f.media_policy_ref,
          preparation: { kind: "pcm_silence_pad", duration: { numerator: 2, denominator: 1 } },
        },
        "test preparation"
      );
      const requestRef = f.store.persist({
        metadata: {
          schema_version: 2,
          run_id: f.run_id,
          phase: "voice_capture",
          branch_id: null,
          kind: NATIVE_MEDIA_REQUEST.artifact_kind,
          operation_id: request.operation_id,
          version: 1,
          producer: "host:synthetic-test",
          media_type: "application/json",
          content_schema: { schema_id: NATIVE_MEDIA_REQUEST.schema_id, schema_version: 1 },
          parent_ref: null,
          upstream_refs: [
            raw,
            required(original.operation_result_ref),
            required(original.host_receipt_ref),
          ],
        },
        content: canonicalJson(request),
      });
      const input_artifacts = {
        schema_version: 2 as const,
        artifacts: [
          { slot: "media", ref: raw },
          { slot: "source-result", ref: required(original.operation_result_ref) },
          { slot: "source-receipt", ref: request.source_receipt_ref },
          { slot: "decode-policy", ref: f.media_policy_ref },
        ],
      };
      const directive: InvokeHostOperationDirectiveV1 = {
        schema_version: 2,
        host_operation_schema_version: 1,
        action: "invoke_host_operation",
        identity: c.identity,
        state_id: c.stateId,
        attempt: 1,
        operation_id: request.operation_id,
        operation_kind: declaration.operation_kind,
        registration_sha256: registration,
        request_ref: requestRef,
        request_sha256: requestRef.content_digest,
        input_artifacts,
        expected_result: declaration.result,
        policy_binding: hostOperationPolicyBinding(declaration, hostCapacityWorkerKey("test-cpu")),
      };
      c.status = "running";
      c.pendingDirective = directive;
      for (const operand of input_artifacts.artifacts)
        if (!c.selectedArtifacts.some((r) => r.artifact_id === operand.ref.artifact_id))
          c.selectedArtifacts.push(operand.ref);
      if (mode === "stale_selection") {
        const s = executionState(c),
          selection = required(s.slots.find((row) => row.slot === "performance"));
        selection.ref = f.raw(f.wav, "audio/wav");
        saveExecution(c, s);
      }
      if (mode === "revoked_rights") {
        const current = validateContract(
          Type.Object({
            rights: Type.Array(CurrentRightsV1Schema),
            cross_run_edge_refs: Type.Array(ArtifactRefSchema),
          }),
          c.playbookData.videogen_owner_selection,
          "test source grants"
        );
        required(
          current.rights.find((row) => row.subject_ref.artifact_id === raw.artifact_id)
        ).status = "revoked";
        selectVideogenRights(c, current.rights, current.cross_run_edge_refs);
      }
      f.checkpointer.saveRun(c, "synthetic_prep_start", {});
      const unused = { path: "/not-executed", sha256: sha256("unused synthetic codec binding") },
        runner = new ConfinedMediaRunner({
          bubblewrap: unused,
          prlimit: unused,
          ffmpeg: { source: unused.path, target: "/ffmpeg", sha256: unused.sha256 },
          ffprobe: { source: unused.path, target: "/ffprobe", sha256: unused.sha256 },
          runtime_files: [],
          scratch_root: f.root,
          max_runtime_bytes: 1,
        });
      const adapter = createNativeMediaAdapter({
        adapter_id: declaration.adapter_id,
        backend_binding_id: declaration.backend_binding_id,
        backend_key_sha256: directive.policy_binding.backend_key_sha256,
        runner,
        policy_ref: f.media_policy_ref,
        policy: MEDIA_POLICY,
        limits: MEDIA_LIMITS,
        preparation: {
          runner,
          policy_ref: f.media_policy_ref,
          policy: MEDIA_POLICY,
          limits: MEDIA_LIMITS,
          owner: f.ownerSelection(),
          custody: {
            project_id: f.project_id,
            store: f.store,
            checkpointer: f.checkpointer,
            leases: f.leases,
            limits: MEDIA_LIMITS,
          },
          sourceDeclaration: () => f.declaration,
        },
      });
      const owner = new HostOperationRuntimeOwner({
        projectId: f.project_id,
        checkpointer: f.checkpointer,
        artifacts: f.store,
        leaseAuthority: f.leases,
        adapters: new Map([[adapter.adapter_id, adapter]]),
      });
      await owner.dispatch(f.engine, directive);
      const record = required(
        f.checkpointer.hostOperationCallForDirective(f.run_id, c.stateId, 1, request.operation_id)
      );
      if (mode !== "current") {
        expect(record.disposition?.outcome, f.diagnostics(record)).toBe("failed");
        expect(record.operation_result_ref).toBeNull();
        expect(record.output_artifacts).toHaveLength(0);
      } else {
        expect(record.lifecycle).toBe("consumed");
        expect(record.disposition?.outcome).toBe("completed");
        const output = required(record.output_artifacts[0]);
        expect(output.artifact_id).not.toBe(raw.artifact_id);
        expect(f.store.read(raw)).toEqual(f.wav);
        const result = validateContract(
          SourcePreparationResultSchema,
          JSON.parse(f.store.read(required(record.operation_result_ref)).toString()),
          "prepared result"
        );
        expect(result.source_result_ref).toEqual(original.operation_result_ref);
        expect(result.source_receipt_ref).toEqual(original.host_receipt_ref);
        const ready = required(f.checkpointer.loadRunById(f.run_id));
        materializeRuntimeMedia(
          runtime,
          ready,
          record.operation_record_id,
          registration,
          "asset",
          "voice-asset"
        );
        expect(slot(executionState(ready), "raw-performance")).toEqual(raw);
        expect(slot(executionState(ready), "performance")).toEqual(output);
        const pcm = inspectCanonicalPcmWav(f.store.read(output), MEDIA_POLICY);
        expect(pcm.samples).toBe(16000);
        expect(pcm.data.subarray(0, 16000)).toEqual(
          inspectCanonicalPcmWav(f.wav, MEDIA_POLICY).data
        );
        expect(pcm.data.subarray(16000)).toEqual(Buffer.alloc(16000));
        const audio = validateContract(
          Type.Object({ sample_count: Type.Integer(), unassessed: Type.Array(Type.String()) }),
          JSON.parse(
            f.store.read(slot(executionState(ready), "audio_evidence-voice-asset")).toString()
          ),
          "prepared measurement"
        );
        expect(audio.sample_count).toBe(16000);
        expect(audio.unassessed).toContain("word_alignment");
        const before = canonicalJson(record.output_artifacts);
        await owner.dispatch(f.engine, directive);
        expect(
          canonicalJson(
            required(f.checkpointer.hostOperationCall(record.operation_record_id)).output_artifacts
          )
        ).toBe(before);
        expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toHaveLength(2);
      }
      expect(f.calls.filter((x) => x === "POST /api/tts/generate")).toHaveLength(1);
    }
  );
});
