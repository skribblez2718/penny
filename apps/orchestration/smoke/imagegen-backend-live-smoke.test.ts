import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateContract, type ArtifactRef } from "../dist/contracts.js";
import { SqliteImagegenActivationController } from "../dist/imagegen/activation.js";
import { IMAGEGEN_EXPORT_OPERATION_KIND } from "../dist/imagegen/export-operation.js";
import { COMFY_IMAGEGEN_OPERATION_KIND } from "../dist/imagegen/operation-owner.js";
import { COMFY_IMAGEGEN_READINESS_OPERATION_KIND } from "../dist/imagegen/readiness-operation.js";
import { loadImagegenRuntimeFromEnvironment } from "../dist/imagegen/runtime-config.js";
import { validateImageSlotLedger } from "../dist/imagegen/slot-ledger.js";
import { validateCanonicalPng } from "../dist/png-media.js";
import { OrchestrationService } from "../dist/service.js";
import {
  ImagegenManifestV1Schema,
  ImagegenStorageReleaseReceiptV1Schema,
  ImagegenStorageReservationReceiptV1Schema,
  validateImageSubmittedGraph,
  validateImageValidationReceipt,
} from "../dist/skill-contracts/imagegen.js";
import { initializePennyState } from "../dist/state/setup.js";
import { DeterministicImagegenSmokeModel } from "../tests/helpers/imagegen-smoke-model.js";
import {
  assertImagegenLiveSmokeGate,
  imagegenBackendLiveSmokeIssueCodes,
  IMAGEGEN_LIVE_MANIFEST_ENV,
  IMAGEGEN_LIVE_SMOKE_CONSTRAINTS,
  IMAGEGEN_LIVE_SMOKE_SEED,
} from "./imagegen-live-smoke-contract.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
const RUN_ID = "run-imagegen-backend-live-smoke";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-imagegen-backend-live-smoke-"));
  roots.push(root);
  return root;
}

function startRequest(): unknown {
  return {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: RUN_ID,
      session_id: "session-imagegen-backend-live-smoke",
      playbook: "imagegen",
      engine_owner: "typescript",
    },
    goal: "Create one calm wordless blue geometric image against the approved private profile.",
    constraints: IMAGEGEN_LIVE_SMOKE_CONSTRAINTS,
    project_root: PROJECT_ROOT,
    trust_profile: "trusted-interactive",
  };
}

function kindCount(artifacts: readonly ArtifactRef[], kind: string): number {
  return artifacts.filter((ref) => ref.kind === kind).length;
}

describe("opt-in imagegen backend live smoke", () => {
  it(
    "runs exactly one real loopback ComfyUI submission through the registered host-operation path",
    async () => {
      assertImagegenLiveSmokeGate(process.env);
      if (process.env[IMAGEGEN_LIVE_MANIFEST_ENV] === undefined) {
        throw new Error(
          `Set ${IMAGEGEN_LIVE_MANIFEST_ENV} to the operator-private imagegen runtime manifest.`
        );
      }

      const root = temporaryRoot();
      const stateRoot = path.join(root, "state");
      mkdirSync(stateRoot, { mode: 0o700 });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PENNY_STATE_ROOT: stateRoot,
        PI_OBSERVABILITY_AUTO_START: "false",
        PI_OBSERVABILITY_ENABLED: "false",
      };
      initializePennyState(PROJECT_ROOT, { env });
      // artifact_read is a Pi extension that resolves its partition from process.env.
      const previousStateRoot = process.env.PENNY_STATE_ROOT;
      process.env.PENNY_STATE_ROOT = stateRoot;

      const loaded = loadImagegenRuntimeFromEnvironment({ env, state_root: stateRoot });
      if (loaded === undefined) {
        throw new Error(
          `Set ${IMAGEGEN_LIVE_MANIFEST_ENV} to the operator-private imagegen runtime manifest.`
        );
      }
      // Smoke-only seam: production activation remains the manifest mode. This disposable
      // partition admits the single smoke start without touching the operator's durable mode.
      const smokeActivation = new SqliteImagegenActivationController({
        directory: path.join(stateRoot, "imagegen-smoke-activation"),
        mode: "enabled",
      });
      const providers = { ...loaded.providers, activation: smokeActivation };

      let service: OrchestrationService | undefined;
      let cleanShutdown = false;
      const closeResources = (): void => {
        service?.close();
        smokeActivation.close();
        loaded.close();
      };
      try {
        service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          playbookName: "imagegen",
          imagegen: providers,
          hostOperationAdapters: loaded.adapters,
          modelClient: new DeterministicImagegenSmokeModel(),
        });
        const directive = await service.execute(startRequest());
        if (directive.action !== "complete") {
          throw new Error(`live imagegen smoke terminated as '${directive.action}'`);
        }

        const calls = service.checkpointer.hostOperationCallsForRun(RUN_ID);
        const generationCalls = calls.filter(
          (call) => call.operation_kind === COMFY_IMAGEGEN_OPERATION_KIND
        );
        if (generationCalls.length !== 1) {
          throw new Error(`live imagegen smoke observed ${generationCalls.length} submissions`);
        }
        const generation = generationCalls[0];
        if (generation === undefined) throw new Error("live imagegen smoke submission is absent");
        if (generation.remote_correlation_id === null) {
          throw new Error("live imagegen smoke submission lacks remote acceptance evidence");
        }
        expect(generation.disposition?.lease_disposition).toBe("released");
        expect(generation.remote_correlation_sha256).toMatch(/^[a-f0-9]{64}$/u);

        const submittedRef = directive.artifacts.find(
          (ref) => ref.kind === "image-submitted-graph"
        );
        if (submittedRef === undefined) throw new Error("submitted graph artifact is absent");
        const submitted = validateImageSubmittedGraph(
          JSON.parse(service.artifacts.readById(submittedRef.artifact_id).toString("utf8"))
        );
        expect(submitted.slot).toBe(0);
        expect(submitted.revision).toBe(0);
        expect(submitted.effective_seed).toBe(IMAGEGEN_LIVE_SMOKE_SEED);

        const imageRef = directive.artifacts.find((ref) => ref.kind === "generated-image");
        if (imageRef === undefined) throw new Error("generated image artifact is absent");
        expect(imageRef.media_type).toBe("image/png");
        const imageBytes = service.artifacts.readById(imageRef.artifact_id);
        const imageInfo = validateCanonicalPng(imageBytes);
        expect(imageInfo.width).toBeGreaterThan(0);
        expect(imageInfo.height).toBeGreaterThan(0);

        const validationRef = directive.artifacts.find(
          (ref) => ref.kind === "image-validation-receipt"
        );
        if (validationRef === undefined) throw new Error("validation receipt is absent");
        const validation = validateImageValidationReceipt(
          JSON.parse(service.artifacts.readById(validationRef.artifact_id).toString("utf8"))
        );
        expect(validation.status).toBe("valid");

        const ledgerRef = directive.artifacts.find((ref) => ref.kind === "image-slot-ledger");
        if (ledgerRef === undefined) throw new Error("slot ledger is absent");
        const ledger = validateImageSlotLedger(
          JSON.parse(service.artifacts.readById(ledgerRef.artifact_id).toString("utf8"))
        );
        expect(ledger.count).toBe(IMAGEGEN_LIVE_SMOKE_CONSTRAINTS.count);
        expect(ledger.slots[0]?.state).toBe("accepted");

        const reservationRef = directive.artifacts.find(
          (ref) => ref.kind === "image-storage-reservation-receipt"
        );
        if (reservationRef === undefined) throw new Error("storage reservation receipt is absent");
        const reservation = validateContract(
          ImagegenStorageReservationReceiptV1Schema,
          JSON.parse(service.artifacts.readById(reservationRef.artifact_id).toString("utf8")),
          "ImagegenStorageReservationReceiptV1"
        );
        expect(reservation.base_seed).toBe(IMAGEGEN_LIVE_SMOKE_SEED);

        const releaseRef = directive.artifacts.find(
          (ref) => ref.kind === "image-storage-release-receipt"
        );
        if (releaseRef !== undefined) {
          validateContract(
            ImagegenStorageReleaseReceiptV1Schema,
            JSON.parse(service.artifacts.readById(releaseRef.artifact_id).toString("utf8")),
            "ImagegenStorageReleaseReceiptV1"
          );
        }

        const manifestRef = directive.artifacts.find((ref) => ref.kind === "imagegen-manifest");
        if (manifestRef === undefined) throw new Error("imagegen manifest is absent");
        const manifest = validateContract(
          ImagegenManifestV1Schema,
          JSON.parse(service.artifacts.readById(manifestRef.artifact_id).toString("utf8")),
          "ImagegenManifestV1"
        );
        expect(manifest.selected_image_ref.artifact_id).toBe(imageRef.artifact_id);
        expect(manifest.review_epoch).toBe(1);

        closeResources();
        cleanShutdown = true;

        const quarantined = calls.filter(
          (call) => call.disposition?.lease_disposition === "quarantined"
        );
        expect(
          imagegenBackendLiveSmokeIssueCodes({
            terminal_action: directive.action,
            terminal_met: directive.met,
            readiness_operation_count: calls.filter(
              (call) => call.operation_kind === COMFY_IMAGEGEN_READINESS_OPERATION_KIND
            ).length,
            generation_submission_count: generationCalls.length,
            export_operation_count: calls.filter(
              (call) => call.operation_kind === IMAGEGEN_EXPORT_OPERATION_KIND
            ).length,
            submitted_graph_count: kindCount(directive.artifacts, "image-submitted-graph"),
            generated_image_count: kindCount(directive.artifacts, "generated-image"),
            validation_receipt_count: kindCount(directive.artifacts, "image-validation-receipt"),
            storage_reservation_receipt_count: kindCount(
              directive.artifacts,
              "image-storage-reservation-receipt"
            ),
            storage_release_receipt_count: kindCount(
              directive.artifacts,
              "image-storage-release-receipt"
            ),
            manifest_count: kindCount(directive.artifacts, "imagegen-manifest"),
            slot_ledger_present: true,
            slot_accepted: ledger.slots[0]?.state === "accepted",
            quarantined_lease_count: quarantined.length,
            clean_shutdown: cleanShutdown,
          })
        ).toEqual([]);
      } finally {
        closeResources();
        if (previousStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
        else process.env.PENNY_STATE_ROOT = previousStateRoot;
      }
      expect(cleanShutdown).toBe(true);
    },
    15 * 60_000
  );
});
