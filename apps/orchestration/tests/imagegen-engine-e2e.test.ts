import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { Checkpointer } from "../dist/checkpointer.js";
import type { JsonValue, RunIdentity } from "../dist/contracts.js";
import { OrchestrationEngine } from "../dist/engine.js";
import { SqliteImagegenActivationController } from "../dist/imagegen/activation.js";
import {
  GENERATED_IMAGE_CONTRACT,
  IMAGE_GENERATION_OPERATION_RECEIPT_CONTRACT,
  IMAGE_VALIDATION_RECEIPT_CONTRACT,
} from "../dist/imagegen/operation-owner.js";
import {
  COMFY_IMAGEGEN_READINESS_ADAPTER_ID,
  IMAGEGEN_READINESS_RECEIPT_CONTRACT,
} from "../dist/imagegen/readiness-operation.js";
import {
  IMAGEGEN_EXPORT_ADAPTER_ID,
  ImagegenExportOperationAdapter,
} from "../dist/imagegen/export-operation.js";
import { StaticImagegenExportRegistry } from "../dist/imagegen/export-registry.js";
import { StaticImagegenProfileRegistry } from "../dist/imagegen/profile-registry.js";
import { SqliteImagegenStorageAdmission } from "../dist/imagegen/storage-admission.js";
import type {
  HostOperationAdapterV1,
  HostOperationDispositionV1,
} from "../dist/host-operations/contracts.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import { HostOperationRuntimeOwner } from "../dist/host-operations/owner.js";
import { encodeCanonicalPng } from "../dist/png-media.js";
import { IMAGEGEN_PLAYBOOK_REGISTRATION } from "../dist/playbooks/imagegen.js";
import {
  validateImageGenerationOperationRequest,
  validateImageSubmittedGraph,
  validateImagegenReadinessRequest,
} from "../dist/skill-contracts/imagegen.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import { ProjectCatalog } from "../dist/state/catalog.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../dist/model-client.js";
import { OrchestrationRunner, WorkerExecutor } from "../dist/worker.js";
import { SYNTHETIC_NODE_POLICIES, syntheticProfile } from "./helpers/imagegen-fixtures.js";

const roots: string[] = [];
const resources: Array<{ close(): void }> = [];

afterEach(() => {
  for (const resource of resources.splice(0).reverse()) resource.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-imagegen-engine-e2e-"));
  roots.push(root);
  return root;
}

function completed(): HostOperationDispositionV1 {
  return {
    outcome: "completed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: null,
  };
}

function readinessAdapter(): HostOperationAdapterV1 {
  return {
    adapter_id: COMFY_IMAGEGEN_READINESS_ADAPTER_ID,
    inspectRequest: ({ directive }) => ({
      schema_version: 1,
      operation_kind: directive.operation_kind,
      adapter_id: directive.policy_binding.adapter_id,
      backend_binding_id: directive.policy_binding.backend_binding_id,
      backend_key_sha256: directive.policy_binding.backend_key_sha256,
    }),
    run: async (context) => {
      const request = validateImagegenReadinessRequest(
        JSON.parse(Buffer.from(context.request_bytes).toString("utf8"))
      );
      const receipt = {
        schema_id: "penny.imagegen-readiness-receipt.v1",
        schema_version: 1,
        status: "ready",
        profile_id: request.profile_id,
        profile_sha256: request.profile_sha256,
        profile_snapshot_ref: request.profile_snapshot_ref,
        inventory_sha256: "f".repeat(64),
        fallback_disposition: { status: "not_applied" },
      } as const;
      const receiptContent = canonicalJson(receipt);
      context.beginSubmission();
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256(receiptContent),
        byte_length: Buffer.byteLength(receiptContent, "utf8"),
        item_count: 1,
        poll_count: 1,
      });
      const disposition = completed();
      const persisted = context.persist({
        disposition,
        operation_result: {
          contract: IMAGEGEN_READINESS_RECEIPT_CONTRACT,
          media_type: "application/json",
          content: receiptContent,
        },
      });
      return {
        disposition,
        operation_result_ref: persisted.operation_result_ref,
        output_artifacts: persisted.output_artifacts,
      };
    },
  };
}

function generationAdapter(): HostOperationAdapterV1 {
  return {
    adapter_id: "imagegen.comfyui-adapter.v1",
    inspectRequest: ({ directive }) => ({
      schema_version: 1,
      operation_kind: directive.operation_kind,
      adapter_id: directive.policy_binding.adapter_id,
      backend_binding_id: directive.policy_binding.backend_binding_id,
      backend_key_sha256: directive.policy_binding.backend_key_sha256,
    }),
    run: async (context) => {
      const request = validateImageGenerationOperationRequest(
        JSON.parse(Buffer.from(context.request_bytes).toString("utf8"))
      );
      const graphInput = context.readInput("submitted_graph");
      const submitted = validateImageSubmittedGraph(
        JSON.parse(Buffer.from(graphInput.bytes).toString("utf8"))
      );
      const png = encodeCanonicalPng({
        width: request.dimensions.width,
        height: request.dimensions.height,
        rgba: Buffer.from([
          0, 80, 180, 255, 0, 100, 200, 255, 20, 110, 210, 255, 40, 120, 220, 255,
        ]),
      });
      const validation = {
        schema_id: "penny.image-validation-receipt.v1",
        schema_version: 1,
        slot: request.slot,
        revision: request.revision,
        status: "valid",
        response_status: 200,
        response_media_type: "image/png",
        raw_sha256: sha256(png),
        raw_byte_length: png.byteLength,
        canonical_sha256: sha256(png),
        canonical_byte_length: png.byteLength,
        dimensions: request.dimensions,
        decoder: "penny.png-media.v1",
        reason_code: null,
      } as const;
      const receipt = {
        schema_id: "penny.image-generation-operation-receipt.v1",
        schema_version: 1,
        run_id: request.run_id,
        reservation_id: request.reservation_id,
        profile_sha256: request.profile_sha256,
        submitted_graph_ref: request.submitted_graph_ref,
        slot: request.slot,
        revision: request.revision,
        effective_seed: submitted.effective_seed,
        status: "persisted",
        prompt_id_sha256: sha256("provider-free-prompt"),
        poll_count: 1,
        validation,
        storage_commit_id: "provider-free-storage-commit",
      } as const;
      context.beginSubmission();
      context.recordRemoteAccepted("provider-free-prompt");
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256(png),
        byte_length: png.byteLength,
        item_count: 1,
        poll_count: 1,
      });
      const disposition = completed();
      const persisted = context.persist({
        disposition,
        operation_result: {
          contract: IMAGE_GENERATION_OPERATION_RECEIPT_CONTRACT,
          media_type: "application/json",
          content: canonicalJson(receipt),
        },
        outputs: [
          {
            contract: IMAGE_VALIDATION_RECEIPT_CONTRACT,
            media_type: "application/json",
            content: canonicalJson(validation),
          },
          { contract: GENERATED_IMAGE_CONTRACT, media_type: "image/png", content: png },
        ],
      });
      return {
        disposition,
        operation_result_ref: persisted.operation_result_ref,
        output_artifacts: persisted.output_artifacts,
      };
    },
  };
}

class ImagegenModelClient implements ModelClient {
  readonly states: string[] = [];

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.states.push(invocation.stateId);
    if (invocation.stateId === "framing") {
      const details = {
        complete: true,
        needs_clarification: false,
        clarifying_questions: [],
        frame: {
          schema_id: "penny.image-frame.v1",
          schema_version: 1,
          brief: "A calm wordless geometric composition in blue.",
          hard_requirements: ["wordless", "blue geometric forms"],
          material_ambiguities: [],
        },
      };
      return {
        text: `provider-free frame\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", ...details })}`,
        confidence: "CERTAIN",
        details,
      };
    }
    if (invocation.stateId === "composing") {
      const details = {
        complete: true,
        needs_clarification: false,
        clarifying_questions: [],
        prompt_plan: {
          schema_id: "penny.image-prompt-plan.v1",
          schema_version: 1,
          positive_prompt: "calm blue geometric forms",
          negative_prompt: "text, letters, words, captions, watermark, typography",
          raw_prompt_preserved: true,
          strategy_delta: null,
        },
      };
      return {
        text: `provider-free prompt plan\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", ...details })}`,
        confidence: "CERTAIN",
        details,
      };
    }
    const image = invocation.inputArtifacts.find((ref) => ref.kind === "generated-image");
    if (image === undefined) throw new Error("critic invocation lacks its exact PNG artifact");
    const candidate = {
      slot: 0,
      revision: 0,
      image_artifact_id: image.artifact_id,
      image_sha256: image.content_digest,
    };
    if (invocation.stateId === "critiquing_candidates" && invocation.agent === "vera") {
      const details = {
        complete: true,
        report: {
          schema_id: "penny.image-validity-report.v1",
          schema_version: 1,
          review_epoch: 1,
          candidates: [{ candidate, approved: true, finding_ids: [] }],
          findings: [],
        },
      };
      return {
        text: `Vera approved\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", ...details })}`,
        confidence: "CERTAIN",
        details,
      };
    }
    if (invocation.stateId === "critiquing_candidates" && invocation.agent === "carren") {
      const details = {
        complete: true,
        report: {
          schema_id: "penny.image-quality-report.v1",
          schema_version: 1,
          review_epoch: 1,
          candidates: [{ candidate, approved: true, finding_ids: [] }],
          findings: [],
          ranking: [candidate],
        },
      };
      return {
        text: `Carren approved\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", ...details })}`,
        confidence: "CERTAIN",
        details,
      };
    }
    throw new Error(`unexpected imagegen worker state '${invocation.stateId}'`);
  }
}

describe("imagegen real engine provider-free path", () => {
  it("runs readiness, serial generation, parallel visual critics, atomic export, and completion admission", async () => {
    const root = temporaryRoot();
    const stateRoot = path.join(root, "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    const catalog = new ProjectCatalog(stateRoot, { create: true });
    const projectId = catalog.registerProject(root).projectId;
    catalog.close();
    const artifacts = ArtifactStore.provision(path.join(root, "artifacts"), { projectId });
    const checkpointer = Checkpointer.provision(path.join(root, "orchestration.db"), undefined, {
      projectId,
    });
    resources.push(artifacts, checkpointer);
    const profile = syntheticProfile({ port: 8188 });
    const profiles = new StaticImagegenProfileRegistry({
      profiles: [profile],
      approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
      node_class_policies: SYNTHETIC_NODE_POLICIES,
      default_profile_id: profile.profile_id,
    });
    const storage = new SqliteImagegenStorageAdmission({
      directory: path.join(root, "storage"),
      ceiling_bytes: 32 * 1024 * 1024,
      warning_threshold_bytes: 24 * 1024 * 1024,
    });
    resources.push(storage);
    const exportRoot = path.join(root, "exports");
    mkdirSync(exportRoot, { mode: 0o700 });
    const exports = new StaticImagegenExportRegistry([
      {
        destination_id: "provider-free-destination",
        root: exportRoot,
        max_files: 8,
        max_bytes: 8 * 1024 * 1024,
      },
    ]);
    const providers = {
      profiles,
      storage,
      exports,
      activation: new SqliteImagegenActivationController({
        directory: path.join(root, "activation"),
        mode: "enabled",
      }),
    };
    resources.push(providers.activation);
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 64,
      receiptAuthority: ReceiptAuthority.provision(path.join(root, "receipt.key")),
      artifactRevisions: artifacts,
      artifactStore: artifacts,
      artifactReader: artifacts,
      playbookRegistration: IMAGEGEN_PLAYBOOK_REGISTRATION,
      imagegen: providers,
    });
    const leases = new HostOperationLeaseAuthority(stateRoot);
    resources.push(leases);
    const hostOperations = new HostOperationRuntimeOwner({
      projectId,
      checkpointer,
      artifacts,
      leaseAuthority: leases,
      adapters: new Map([
        [COMFY_IMAGEGEN_READINESS_ADAPTER_ID, readinessAdapter()],
        ["imagegen.comfyui-adapter.v1", generationAdapter()],
        [IMAGEGEN_EXPORT_ADAPTER_ID, new ImagegenExportOperationAdapter(exports)],
      ]),
    });
    const model = new ImagegenModelClient();
    const workers = new WorkerExecutor(model, artifacts, {
      projectRoot: root,
      parallelConcurrency: 2,
      registration: IMAGEGEN_PLAYBOOK_REGISTRATION,
    });
    const runner = new OrchestrationRunner(engine, workers, undefined, hostOperations);
    const identity: RunIdentity = {
      schema_version: 2,
      run_id: "run-imagegen-real-engine",
      session_id: "session-imagegen-real-engine",
      playbook: "imagegen",
      engine_owner: "typescript",
    };
    const constraints: Record<string, JsonValue> = {
      schema_version: 1,
      profile_id: profile.profile_id,
      count: 1,
      seed: 42,
      max_revision_rounds: 1,
      raw_prompt: "calm blue geometric forms",
      dimensions: { width: 2, height: 2 },
      export: {
        destination_id: "provider-free-destination",
        directory_name: "run-output",
      },
    };
    const terminal = await runner.runUntilBoundary(
      engine.handle({
        schema_version: 2,
        action: "start",
        identity,
        goal: "Create a calm wordless blue geometric image",
        constraints,
        project_root: root,
        trust_profile: "hardened-untrusted",
      })
    );

    expect(terminal).toMatchObject({ action: "complete", status: "complete", met: true });
    expect(model.states).toEqual([
      "framing",
      "composing",
      "critiquing_candidates",
      "critiquing_candidates",
    ]);
    if (terminal.action !== "complete") throw new Error("expected imagegen completion");
    const selectedImageRef = terminal.artifacts.find((ref) => ref.kind === "generated-image");
    if (selectedImageRef === undefined) throw new Error("expected generated image artifact");
    expect(terminal.result.output_artifact_ref).toEqual(selectedImageRef);
    expect(terminal.artifacts.some((ref) => ref.kind === "imagegen-manifest")).toBe(true);
    expect(terminal.artifacts.some((ref) => ref.kind === "imagegen-export-receipt")).toBe(true);
    expect(readdirSync(path.join(exportRoot, "run-output")).sort()).toEqual([
      "candidate-0.png",
      "manifest.json",
      "selected.png",
    ]);
    expect(checkpointer.completionAdmission(identity.run_id)?.origin_state).toBe(
      "admitting_product"
    );
  });
});
