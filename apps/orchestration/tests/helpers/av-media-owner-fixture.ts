import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "../../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { Checkpointer } from "../../dist/checkpointer.js";
import { RunContext } from "../../dist/context.js";
import type {
  ArtifactRef,
  Directive,
  InvokeHostOperationDirectiveV1,
  JsonValue,
} from "../../dist/contracts.js";
import { OrchestrationEngine } from "../../dist/engine.js";
import { ConfinedMediaRunner } from "../../dist/host-operations/confined-media-runner.js";
import {
  hostOperationLeaseProfileSha256,
  hostOperationPolicyBinding,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
} from "../../dist/host-operations/contracts.js";
import { HostOperationLeaseAuthority } from "../../dist/host-operations/lease-authority.js";
import {
  HostOperationRuntimeOwner,
  type HostOperationRuntimeOwnerOptions,
} from "../../dist/host-operations/owner.js";
import type { Playbook } from "../../dist/playbooks/playbook.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistration,
} from "../../dist/playbooks/registry.js";
import { ReceiptAuthority } from "../../dist/receipts.js";
import { ProjectCatalog } from "../../dist/state/catalog.js";
import { MEDIA_FRAME_CONTRACT, MEDIA_PCM_CONTRACT } from "../../dist/videogen/media-contracts.js";
import { AvMediaCustody } from "../../dist/videogen/av-media-custody.js";
import {
  AV_MEDIA_REQUEST_CONTRACT,
  AV_MEDIA_RESULT_CONTRACT,
  type AvMediaPolicyV1,
  type AvMediaRequestV1,
} from "../../dist/videogen/av-media-contracts.js";
import { createAvMediaDecodeAdapter } from "../../dist/videogen/av-media-adapter.js";
import { pennyStatePaths, projectStatePaths } from "../../dist/state/paths.js";
import { MEDIA_LIMITS, MEDIA_SELECTION, required } from "./videogen-media-fixtures.js";
import { AV_POLICY } from "./av-media-fixtures.js";

class MediaConsumer implements Playbook {
  initialize(c: RunContext): Directive {
    return this.dispatch(c);
  }
  dispatch(c: RunContext): Directive {
    if (c.pendingDirective !== null) return c.pendingDirective;
    const receipt = required(c.selectedArtifacts.find((x) => x.kind === "host-operation-receipt"));
    const d: Directive = {
      schema_version: 2,
      action: "await_user",
      identity: c.identity,
      state_id: c.stateId,
      gate_id: "fixture-complete",
      challenge: "fixture-ack",
      payload_digest: receipt.content_digest,
      questions: [{ id: "ack", prompt: "Acknowledge raw fixture result (not production)." }],
    };
    c.status = "awaiting_user";
    c.pendingDirective = d;
    return d;
  }
  resume(c: RunContext, _r: JsonValue): Directive {
    return this.dispatch(c);
  }
  cancel(c: RunContext, _r: string): Directive {
    return this.dispatch(c);
  }
  acceptSummary(c: RunContext, _r: Record<string, JsonValue>): Directive {
    return this.dispatch(c);
  }
  rebindPendingDirective(c: RunContext): Directive | null {
    return c.pendingDirective;
  }
}
export class AvOwnerFixture implements Disposable {
  readonly root = mkdtempSync(path.join(tmpdir(), "penny-videogen-media-"));
  readonly state_root = path.join(this.root, "state");
  readonly project_id: string;
  readonly run_id = "run-media";
  readonly store: ArtifactStore;
  readonly checkpointer: Checkpointer;
  readonly leases: HostOperationLeaseAuthority;
  readonly declaration: HostOperationDeclarationV1;
  readonly registration: PlaybookRegistration;
  readonly engine: OrchestrationEngine;
  readonly backend = sha256("media-fixture-worker");
  readonly policy_ref: ArtifactRef;
  readonly selection_ref: ArtifactRef;
  private sequence = 0;
  constructor(readonly policy: AvMediaPolicyV1 = AV_POLICY) {
    chmodSync(this.root, 0o700);
    using catalog = new ProjectCatalog(this.state_root, { create: true });
    this.project_id = catalog.registerProject(this.root).projectId;
    const paths = projectStatePaths(pennyStatePaths(this.state_root), this.project_id);
    this.store = ArtifactStore.provision(paths.artifacts.root, {
      projectId: this.project_id,
    });
    this.checkpointer = Checkpointer.provision(paths.orchestration.database, undefined, {
      projectId: this.project_id,
    });
    this.leases = new HostOperationLeaseAuthority(this.state_root);
    const lp = {
      profile_id: "media-fixture-lease",
      profile_version: 1 as const,
      duration_ms: 60000,
      renew_after_ms: 10000,
      queue_inactivity_ms: 30000,
    };
    this.declaration = {
      schema_version: 1,
      operation_kind: "media_decode_extract",
      adapter_id: "raw-media-fixture",
      request: AV_MEDIA_REQUEST_CONTRACT,
      result: AV_MEDIA_RESULT_CONTRACT,
      backend_binding_id: "media-fixture",
      capability_classes: ["artifact_store"],
      lease_profile: { ...lp, profile_sha256: hostOperationLeaseProfileSha256(lp) },
      operation_inactivity_ms: 60000,
      max_request_bytes: 16384,
      max_input_artifacts: 3,
      max_input_bytes: policy.limits.max_input_bytes + 65536,
      output_contracts: [MEDIA_FRAME_CONTRACT, MEDIA_PCM_CONTRACT],
      max_output_artifacts: 32,
      max_output_bytes: policy.limits.max_output_bytes,
      max_progress_events: 16,
      max_pre_acceptance_retries: 0,
      recovery_semantics: "disposable_v1",
      cancellation_semantics: "local_abort_only_v1",
    };
    const base = required(resolvePlaybook("research"));
    this.registration = {
      ...base,
      host_states: [...(base.host_states ?? []), "media-fixture"],
      host_operations: {
        schema_version: 1,
        max_active_per_run: 1,
        declarations: [this.declaration],
      },
      construct: () => new MediaConsumer(),
    };
    this.engine = new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.root,
      maxSteps: 20,
      receiptAuthority: ReceiptAuthority.provision(paths.orchestration.receiptKey),
      artifactStore: this.store,
      artifactReader: this.store,
      artifactRevisions: this.store,
      playbookRegistration: this.registration,
    });
    this.policy_ref = this.json(policy, policy.schema_id);
    this.selection_ref = this.json(MEDIA_SELECTION, MEDIA_SELECTION.schema_id);
  }
  raw(
    bytes: Uint8Array | string,
    mediaType: string,
    schemaId?: string,
    kind = "videogen-media-fixture"
  ): ArtifactRef {
    return this.store.persist({
      metadata: {
        schema_version: 2,
        run_id: this.run_id,
        phase: "media-fixture",
        branch_id: null,
        kind,
        operation_id: `fixture-${++this.sequence}`,
        version: 1,
        producer: "host:media-fixture",
        media_type: mediaType,
        parent_ref: null,
        upstream_refs: [],
        ...(schemaId === undefined
          ? {}
          : { content_schema: { schema_id: schemaId, schema_version: 1 } }),
      },
      content: bytes,
    });
  }
  json(value: unknown, schemaId: string, kind?: string): ArtifactRef {
    return this.raw(canonicalJson(value), "application/json", schemaId, kind);
  }
  request(
    bytes: Buffer,
    mediaType = "video/mp4",
    spans: AvMediaRequestV1["required_spans"] = [
      { start: { numerator: 0, denominator: 1 }, end: { numerator: 1, denominator: 1 } },
    ]
  ): AvMediaRequestV1 {
    return {
      schema_id: "penny.videogen-av-media-request.v1",
      schema_version: 1,
      operation_id: "media-operation",
      media_ref: this.raw(bytes, mediaType),
      decode_policy_ref: this.policy_ref,
      required_spans: spans,
      frame_selection_ref: this.selection_ref,
      audio_policy: "decode_untrimmed_coded_timeline_not_alignment",
    };
  }
  prepare(request: AvMediaRequestV1): InvokeHostOperationDirectiveV1 {
    const ref = this.json(request, request.schema_id, AV_MEDIA_REQUEST_CONTRACT.artifact_kind);
    const identity = {
      schema_version: 2 as const,
      run_id: this.run_id,
      session_id: "session-media",
      playbook: "research",
      engine_owner: "typescript" as const,
    };
    const d: InvokeHostOperationDirectiveV1 = {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity,
      state_id: "media-fixture",
      attempt: 1,
      operation_id: request.operation_id,
      operation_kind: "media_decode_extract",
      registration_sha256: runtimeRegistrationSha256(this.registration),
      request_ref: ref,
      request_sha256: ref.content_digest,
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "media", ref: request.media_ref },
          { slot: "decode-policy", ref: request.decode_policy_ref },
          { slot: "frame-selection", ref: request.frame_selection_ref },
        ],
      },
      expected_result: AV_MEDIA_RESULT_CONTRACT,
      policy_binding: hostOperationPolicyBinding(this.declaration, this.backend),
    };
    const context = RunContext.create({
      identity,
      goal: "raw media owner protocol fixture",
      constraints: {},
      projectRoot: this.root,
      trustProfile: "trusted-interactive",
      maxSteps: 20,
      registrationContractBinding: {
        schema_version: 1,
        registration_name: this.registration.name,
        contract_sha256: skillContractSha256(this.registration.contract),
        registration_sha256: runtimeRegistrationSha256(this.registration),
      },
      initialArtifacts: [ref, ...d.input_artifacts.artifacts.map((x) => x.ref)],
    });
    context.transition(d.state_id);
    context.pendingDirective = d;
    this.checkpointer.createRun(context, "media_fixture_started", {});
    this.engine.liveness.bindPolicy(context);
    return d;
  }
  adapter(runner: ConfinedMediaRunner): HostOperationAdapterV1 {
    return createAvMediaDecodeAdapter({
      adapter_id: this.declaration.adapter_id,
      backend_binding_id: this.declaration.backend_binding_id,
      backend_key_sha256: this.backend,
      policy_ref: this.policy_ref,
      policy: this.policy,
      runner,
      limits: MEDIA_LIMITS,
    });
  }
  private originalOwner: HostOperationRuntimeOwner | undefined;
  owner(
    adapter: HostOperationAdapterV1,
    fault?: HostOperationRuntimeOwnerOptions["fault"]
  ): HostOperationRuntimeOwner {
    if (this.originalOwner !== undefined) return this.originalOwner;
    this.originalOwner = new HostOperationRuntimeOwner({
      projectId: this.project_id,
      checkpointer: this.checkpointer,
      artifacts: this.store,
      leaseAuthority: this.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
      ...(fault === undefined ? {} : { fault }),
    });
    return this.originalOwner;
  }
  evidence(
    store = this.store,
    checkpointer = this.checkpointer,
    policy_ref = this.policy_ref
  ): AvMediaCustody {
    return new AvMediaCustody({
      state_root: this.state_root,
      project_id: this.project_id,
      store,
      checkpointer,
      leases: this.leases,
      limits: MEDIA_LIMITS,
      declaration: this.declaration,
      registration_sha256: runtimeRegistrationSha256(this.registration),
      backend_key_sha256: this.backend,
      policy_ref,
    });
  }
  [Symbol.dispose](): void {
    this.leases.close();
    this.store.close();
    this.checkpointer.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
