import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { Checkpointer } from "../dist/checkpointer.js";
import { ComfyWorkerIdentityRegistry } from "../dist/comfy/worker-identity.js";
import { RunContext } from "../dist/context.js";
import type { ArtifactRef, Directive, InvokeHostOperationDirectiveV1 } from "../dist/contracts.js";
import { OrchestrationEngine } from "../dist/engine.js";
import {
  hostOperationPolicyBinding,
  type HostOperationAdapterV1,
  type HostOperationExecutionContextV1,
} from "../dist/host-operations/contracts.js";
import { FileHostOperationResultCache } from "../dist/host-operations/result-cache.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import {
  HostOperationRuntimeOwner,
  type HostOperationRuntimeOwnerOptions,
} from "../dist/host-operations/owner.js";
import type { Playbook } from "../dist/playbooks/playbook.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import { encodeCanonicalPng } from "../dist/png-media.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import { ProjectCatalog } from "../dist/state/catalog.js";
import { buildVideoSubmittedGraph } from "../dist/videogen/graph-builder.js";
import {
  validateVideoReferenceUploadReceipt,
  validateVideogenProfileSnapshot,
} from "../dist/videogen/contracts.js";
import {
  ComfyVideogenOperationAdapter,
  createComfyVideogenDeclaration,
  type ComfyVideogenAdapterOptionsV1,
} from "../dist/videogen/operation-owner.js";
import { decodeVideogenFetchedCache } from "../dist/videogen/render-safety.js";
import type { ResolvedVideogenProfileV1 } from "../dist/videogen/profile-registry.js";
import { StaticVideogenProfileRegistry } from "../dist/videogen/profile-registry.js";
import { requireValue } from "./helpers/narrowing.js";
import { syntheticVideogenProfile } from "./helpers/videogen-fixtures.js";

class RenderConsumer implements Playbook {
  initialize(context: RunContext): Directive {
    return this.dispatch(context);
  }
  dispatch(context: RunContext): Directive {
    if (context.pendingDirective !== null) return context.pendingDirective;
    const receipt = requireValue(
      context.selectedArtifacts.find((ref) => ref.kind === "host-operation-receipt"),
      "owner receipt"
    );
    const directive: Directive = {
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: context.stateId,
      gate_id: "fixture-finished",
      challenge: "fixture-acknowledge",
      payload_digest: receipt.content_digest,
      questions: [{ id: "acknowledge", prompt: "Acknowledge the provider-free result." }],
    };
    context.status = "awaiting_user";
    context.pendingDirective = directive;
    return directive;
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

/** Genuine engine/artifact/journal/shared-worker authority. Only HTTP observations are fake.
 * The synthetic prior upload receipt is not represented as deployed qualification.
 */
export class RenderSafetyFixture implements Disposable {
  readonly root = mkdtempSync(path.join(tmpdir(), "penny-render-safety-store-"));
  readonly stateRoot = path.join(this.root, "state");
  readonly projectId: string;
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly leases: HostOperationLeaseAuthority;
  readonly engine: OrchestrationEngine;
  readonly directive: InvokeHostOperationDirectiveV1;
  readonly registry: StaticVideogenProfileRegistry;
  readonly png = encodeCanonicalPng({
    width: 1,
    height: 1,
    rgba: Uint8Array.from([0, 0, 255, 255]),
  });
  readonly backendKey: string;
  readonly declaration = createComfyVideogenDeclaration({
    backend_binding_id: "fixture-comfy",
    lease_profile_id: "fixture-render-lease",
    lease_duration_ms: 60_000,
    lease_renew_after_ms: 10_000,
    queue_inactivity_ms: 5_000,
    operation_inactivity_ms: 120_000,
    max_request_bytes: 65_536,
    max_input_bytes: 262_144,
    max_output_bytes: 2_000_000,
    max_progress_events: 64,
  });
  readonly registration: PlaybookRegistration;
  observedContext: HostOperationExecutionContextV1 | undefined;
  private artifactIndex = 0;

  constructor(port: number, mode: "t2v" | "i2v" = "i2v") {
    chmodSync(this.root, 0o700);
    using catalog = new ProjectCatalog(this.stateRoot, { create: true });
    this.projectId = catalog.registerProject(this.root).projectId;
    this.checkpointer = Checkpointer.provision(
      path.join(this.root, "orchestration.db"),
      undefined,
      { projectId: this.projectId }
    );
    this.artifacts = ArtifactStore.provision(path.join(this.root, "artifacts"), {
      projectId: this.projectId,
    });
    this.leases = new HostOperationLeaseAuthority(this.stateRoot);
    const profile = syntheticVideogenProfile({ port, mode });
    this.registry = new StaticVideogenProfileRegistry({
      profiles: [profile],
      approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
      worker_identities: new ComfyWorkerIdentityRegistry([
        { worker_id: "fixture-physical-comfy", endpoints: [profile.endpoint] },
      ]),
    });
    this.backendKey = this.registry.resolve(profile.profile_id).backend_key_sha256;
    const snapshot = validateVideogenProfileSnapshot({
      schema_id: "penny.videogen-profile-snapshot.v1",
      schema_version: 1,
      profile,
      approved_profile_sha256: profile.profile_sha256,
      source_graph_sha256: profile.source_graph_sha256,
    });
    const snapshotRef = this.persist(
      "videogen-profile-snapshot",
      snapshot.schema_id,
      canonicalJson(snapshot)
    );
    const pngRef = this.persist("canonical-png", "penny.canonical-png.v1", this.png, "image/png");
    const receipt =
      mode === "t2v"
        ? null
        : validateVideoReferenceUploadReceipt({
            schema_id: "penny.video-reference-upload-receipt.v1",
            schema_version: 1,
            run_id: "render-safety-run",
            profile_id: profile.profile_id,
            profile_sha256: profile.profile_sha256,
            canonical_png_ref: pngRef,
            canonical_png_sha256: pngRef.content_digest,
            canonical_png_bytes: pngRef.byte_length,
            remote_descriptor: {
              filename: `${pngRef.content_digest}.png`,
              subfolder: profile.input_subfolder,
              type: "input",
            },
            status: "uploaded_verified",
          });
    const receiptRef =
      receipt === null
        ? null
        : this.persist("video-reference-upload-receipt", receipt.schema_id, canonicalJson(receipt));
    const submitted = buildVideoSubmittedGraph({
      run_id: "render-safety-run",
      shot_id: "shot-1",
      profile_snapshot: snapshot,
      profile_snapshot_ref: snapshotRef,
      spec: {
        mode,
        positive_prompt: "synthetic moving blue square",
        negative_prompt: "flicker",
        seed: 7,
        dimensions: { width: 64, height: 64 },
        frame_count: 3,
        fps: 3,
      },
      input_upload_receipt: receipt,
      input_upload_receipt_ref: receiptRef,
    });
    const graphRef = this.persist(
      "video-submitted-graph",
      submitted.schema_id,
      canonicalJson(submitted)
    );
    const requestRef = this.persist(
      "video-generation-operation-request",
      "penny.video-generation-operation-request.v1",
      canonicalJson({
        schema_id: "penny.video-generation-operation-request.v1",
        schema_version: 1,
        run_id: submitted.run_id,
        shot_id: submitted.shot_id,
        profile_id: profile.profile_id,
        profile_sha256: profile.profile_sha256,
        profile_snapshot_ref: snapshotRef,
        submitted_graph_ref: graphRef,
        submitted_graph_sha256: graphRef.content_digest,
        mode,
        dimensions: submitted.dimensions,
        frame_count: 3,
        fps: 3,
      })
    );
    const base = requireValue(resolvePlaybook("research"), "base registration");
    this.registration = {
      ...base,
      host_states: [...(base.host_states ?? []), "host-operation-state"],
      host_operations: {
        schema_version: 1 as const,
        max_active_per_run: 1,
        declarations: [this.declaration],
      },
      construct: () => new RenderConsumer(),
    };
    this.engine = new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.root,
      maxSteps: 20,
      receiptAuthority: ReceiptAuthority.provision(path.join(this.root, "receipt.key")),
      artifactRevisions: this.artifacts,
      artifactStore: this.artifacts,
      artifactReader: this.artifacts,
      playbookRegistration: this.registration,
    });
    this.directive = {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: {
        schema_version: 2,
        run_id: "render-safety-run",
        session_id: "render-safety-session",
        playbook: "research",
        engine_owner: "typescript",
      },
      state_id: "host-operation-state",
      attempt: 1,
      operation_id: "render-safety-operation",
      operation_kind: this.declaration.operation_kind,
      registration_sha256: runtimeRegistrationSha256(this.registration),
      request_ref: requestRef,
      request_sha256: requestRef.content_digest,
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "profile_snapshot", ref: snapshotRef },
          { slot: "submitted_graph", ref: graphRef },
          ...(receiptRef === null ? [] : [{ slot: "input_upload_receipt", ref: receiptRef }]),
        ],
      },
      expected_result: this.declaration.result,
      policy_binding: hostOperationPolicyBinding(this.declaration, this.backendKey),
    };
    const context = RunContext.create({
      identity: this.directive.identity,
      goal: "Provider-free bounded render safety",
      constraints: {},
      projectRoot: this.root,
      trustProfile: "trusted-interactive",
      maxSteps: 20,
      registrationContractBinding: {
        schema_version: 1,
        registration_name: this.registration.name,
        contract_sha256: skillContractSha256(this.registration.contract),
        registration_sha256: this.directive.registration_sha256,
      },
      initialArtifacts: [
        requestRef,
        snapshotRef,
        graphRef,
        ...(receiptRef === null ? [] : [receiptRef]),
      ],
    });
    context.transition("host-operation-state");
    context.pendingDirective = this.directive;
    this.checkpointer.createRun(context, "render_safety_fixture_started", {});
    this.engine.liveness.bindPolicy(context);
  }

  private persist(
    kind: string,
    schemaId: string,
    content: string | Uint8Array,
    mediaType = "application/json"
  ): ArtifactRef {
    return this.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "render-safety-run",
        phase: "host-operation-state",
        branch_id: null,
        kind,
        operation_id: `fixture-input-${this.artifactIndex++}`,
        version: 1,
        producer: "host:render-safety-fixture",
        media_type: mediaType,
        content_schema: { schema_id: schemaId, schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content,
    });
  }

  async runtime(
    fault?: HostOperationRuntimeOwnerOptions["fault"],
    options: Pick<ComfyVideogenAdapterOptionsV1, "cancellation_authority"> = {},
    legacyBytesOnly = false
  ): Promise<HostOperationRuntimeOwner> {
    const delegate = new ComfyVideogenOperationAdapter({
      legacy_http: true,
      profiles: this.registry,
      ...options,
    });
    const adapter: HostOperationAdapterV1 = {
      adapter_id: delegate.adapter_id,
      inspectRequest: (input) => delegate.inspectRequest(input),
      run: (context) => {
        this.observedContext = context;
        // Reproduce the old byte-only cache milestone through the real owner's cache API.
        // Used only to construct an authentic disposable legacy recovery fixture.
        return delegate.run(
          legacyBytesOnly
            ? {
                ...context,
                cacheResult: async (envelope) =>
                  await context.cacheResult(
                    decodeVideogenFetchedCache(envelope, context.declaration.max_output_bytes).video
                  ),
              }
            : context
        );
      },
    };
    return new HostOperationRuntimeOwner({
      projectId: this.projectId,
      checkpointer: this.checkpointer,
      artifacts: this.artifacts,
      leaseAuthority: this.leases,
      resultCache: await FileHostOperationResultCache.provision(path.join(this.root, "cache")),
      adapters: new Map([[adapter.adapter_id, adapter]]),
      ...(fault === undefined ? {} : { fault }),
    });
  }

  record() {
    return requireValue(
      this.checkpointer.hostOperationCallForDirective(
        this.directive.identity.run_id,
        this.directive.state_id,
        this.directive.attempt,
        this.directive.operation_id
      ),
      "canonical render operation"
    );
  }

  [Symbol.dispose](): void {
    this.leases.close();
    this.artifacts.close();
    this.checkpointer.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Synthetic protocol bytes, not a live issuer or a current deployed-build attestation. */
export function syntheticCancellationEvidence(resolved: ResolvedVideogenProfileV1) {
  const binding = {
    profile_id: resolved.profile.profile_id,
    profile_schema_version: 1 as const,
    profile_sha256: resolved.profile.profile_sha256,
    backend_key_sha256: resolved.backend_key_sha256,
    endpoint: { ...resolved.profile.endpoint },
    deployed_version_sha256: sha256("synthetic local HTTP server version"),
  };
  const evidence = {
    schema_id: "penny.videogen-prompt-cancellation-evidence.v1",
    schema_version: 1,
    binding,
    interrupt_protocol: "POST /interrupt:exact_prompt_id",
    terminal_protocol: "GET /history/{prompt_id}:completed=true",
    target_prompt_sha256: sha256("fixture-qualified-target"),
    unrelated_prompt_sha256: sha256("fixture-unrelated-running"),
    target_terminal: {
      prompt_sha256: sha256("fixture-qualified-target"),
      completed: true,
      history_sha256: sha256("synthetic completed exact-target history"),
    },
    unrelated_running_before_sha256: sha256("synthetic unrelated running state"),
    unrelated_running_after_sha256: sha256("synthetic unrelated running state"),
    unknown_target_noop: {
      prompt_sha256: sha256("fixture-unknown-target"),
      running_before_sha256: sha256("synthetic running set"),
      running_after_sha256: sha256("synthetic running set"),
      transcript_sha256: sha256("synthetic unknown-target no-op transcript"),
    },
    transcript_sha256: sha256("synthetic two-prompt qualification transcript"),
  };
  const evidenceJson = canonicalJson(evidence);
  return {
    current_bindings: [structuredClone(binding)],
    registrations: [
      {
        binding: structuredClone(binding),
        approved_evidence_sha256: sha256(evidenceJson),
        evidence_json: evidenceJson,
      },
    ],
  };
}
