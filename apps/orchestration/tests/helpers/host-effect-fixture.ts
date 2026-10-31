import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
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
import {
  hostOperationLeaseProfileSha256,
  hostOperationPolicyBinding,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
} from "../../dist/host-operations/contracts.js";
import {
  prepareHostEffectArtifacts,
  HOST_RECEIPTED_RESULT_CONTRACT,
} from "../../dist/host-operations/effect-protocol.js";
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
import { required } from "./videogen-media-fixtures.js";

export const EFFECT_REQUEST_SCHEMA = Type.Object(
  {
    schema_id: Type.Literal("penny.effect-fixture-request.v1"),
    schema_version: Type.Literal(1),
    operation_id: Type.String(),
    value: Type.String(),
  },
  { additionalProperties: false }
);
export const EFFECT_RESULT = {
  schema_version: 1,
  port_name: "raw",
  artifact_kind: "effect-fixture-result",
  schema_id: "penny.effect-fixture-result.v1",
  schema_version_required: 1,
} as const;
export function effectDeclaration(): HostOperationDeclarationV1 {
  const lease = {
    profile_id: "effect-fixture",
    profile_version: 1 as const,
    duration_ms: 60_000,
    renew_after_ms: 10_000,
    queue_inactivity_ms: 30_000,
  };
  return {
    schema_version: 1,
    operation_kind: "media_decode_extract",
    adapter_id: "effect-fixture",
    request: {
      schema_version: 1,
      port_name: "request",
      artifact_kind: "effect-fixture-request",
      schema_id: "penny.effect-fixture-request.v1",
      schema_version_required: 1,
    },
    result: EFFECT_RESULT,
    effect_protocol: "request_intent_v1",
    receipt_citing_result: HOST_RECEIPTED_RESULT_CONTRACT,
    backend_binding_id: "effect-fixture",
    capability_classes: ["artifact_store"],
    lease_profile: { ...lease, profile_sha256: hostOperationLeaseProfileSha256(lease) },
    operation_inactivity_ms: 60_000,
    max_request_bytes: 16_384,
    max_input_artifacts: 8,
    max_input_bytes: 2_000_000,
    max_output_artifacts: 8,
    max_output_bytes: 2_000_000,
    max_progress_events: 32,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "registered_remote_cancel_then_observe_v1",
  };
}
class Consumer implements Playbook {
  initialize(c: RunContext) {
    return this.dispatch(c);
  }
  dispatch(c: RunContext): Directive {
    if (c.pendingDirective !== null) return c.pendingDirective;
    const receipt = required(c.selectedArtifacts.find((x) => x.kind === "host-operation-receipt"));
    const next: Directive = {
      schema_version: 2,
      action: "await_user",
      identity: c.identity,
      state_id: c.stateId,
      gate_id: "effect-fixture-done",
      challenge: "effect-fixture-ack",
      payload_digest: receipt.content_digest,
      questions: [{ id: "ack", prompt: "Acknowledge the exact fixture result." }],
    };
    c.pendingDirective = next;
    c.status = "awaiting_user";
    return next;
  }
  resume(c: RunContext, _answer: JsonValue) {
    return this.dispatch(c);
  }
  cancel(c: RunContext, _reason: string) {
    return this.dispatch(c);
  }
  acceptSummary(c: RunContext, _details: Record<string, JsonValue>) {
    return this.dispatch(c);
  }
  rebindPendingDirective(c: RunContext) {
    return c.pendingDirective;
  }
}
/** Real project/store/engine/journal fixture. The synthetic adapter counts only simulated effects;
 * no source/receipt/gate fixture is deployment authorization or decode qualification. */
export class HostEffectFixture implements Disposable {
  readonly root = mkdtempSync(join(tmpdir(), "penny-effect-protocol-"));
  readonly projectId: string;
  readonly runId = "effect-fixture-run";
  store: ArtifactStore;
  checkpointer: Checkpointer;
  leases: HostOperationLeaseAuthority;
  engine: OrchestrationEngine;
  readonly registration: PlaybookRegistration;
  private serial = 0;
  constructor(
    readonly declaration = effectDeclaration(),
    readonly backend = sha256("effect-fixture-backend")
  ) {
    const catalog = new ProjectCatalog(join(this.root, "state"), { create: true });
    this.projectId = catalog.registerProject(this.root).projectId;
    catalog.close();
    this.store = ArtifactStore.provision(join(this.root, "artifacts"), {
      projectId: this.projectId,
    });
    this.checkpointer = Checkpointer.provision(join(this.root, "control.db"), undefined, {
      projectId: this.projectId,
    });
    this.leases = new HostOperationLeaseAuthority(join(this.root, "state"));
    this.registration = {
      ...required(resolvePlaybook("research")),
      host_states: [...(required(resolvePlaybook("research")).host_states ?? []), "effect-fixture"],
      host_operations: {
        schema_version: 1 as const,
        max_active_per_run: 1,
        declarations: [declaration],
      },
      construct: () => new Consumer(),
    };
    this.engine = this.newEngine(ReceiptAuthority.provision(join(this.root, "receipt.key")));
  }
  private newEngine(receipts: ReceiptAuthority) {
    return new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.root,
      maxSteps: 20,
      receiptAuthority: receipts,
      artifactStore: this.store,
      artifactReader: this.store,
      artifactRevisions: this.store,
      playbookRegistration: this.registration,
    });
  }
  ref(
    value: unknown,
    schema = "penny.effect-fixture-input.v1",
    kind = "effect-fixture-input",
    media = "application/json"
  ): ArtifactRef {
    return this.store.persist({
      metadata: {
        schema_version: 2,
        run_id: this.runId,
        phase: "effect-fixture",
        branch_id: null,
        kind,
        operation_id: `fixture-input-${++this.serial}`,
        version: 1,
        producer: "host:effect-fixture",
        media_type: media,
        content_schema: { schema_id: schema, schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: value instanceof Uint8Array ? value : canonicalJson(value),
    });
  }
  identity() {
    return {
      project_id: this.projectId,
      run_id: this.runId,
      state_id: "effect-fixture",
      visit: 1,
      attempt: 1,
      kind: this.declaration.operation_kind,
      scope_ref: this.ref({ scope: "fixture" }),
      predecessor_ref: this.ref({ predecessor: "fixture" }),
      slot: "fixture-slot",
    };
  }
  prepare(
    input?: Partial<
      Pick<
        Parameters<typeof prepareHostEffectArtifacts>[0],
        "identity" | "request" | "request_schema" | "input_refs" | "profile_snapshot_ref"
      >
    >
  ) {
    return prepareHostEffectArtifacts({
      store: this.store,
      identity: input?.identity ?? this.identity(),
      request_contract: this.declaration.request,
      request_schema: input?.request_schema ?? EFFECT_REQUEST_SCHEMA,
      request: input?.request ?? {
        schema_id: "penny.effect-fixture-request.v1",
        schema_version: 1,
        value: "exact input",
      },
      input_refs: input?.input_refs ?? [],
      budget_reservation_ref: this.ref({ reservation: "fixture" }),
      expected_output_contract_ref: this.ref(this.declaration.result),
      ...(input?.profile_snapshot_ref === undefined
        ? {}
        : { profile_snapshot_ref: input.profile_snapshot_ref }),
    });
  }
  start(
    prepared = this.prepare(),
    inputs: readonly { slot: string; ref: ArtifactRef }[] = []
  ): InvokeHostOperationDirectiveV1 {
    const identity = {
      schema_version: 2 as const,
      run_id: this.runId,
      session_id: "effect-fixture-session",
      playbook: "research",
      engine_owner: "typescript" as const,
    };
    const directive: InvokeHostOperationDirectiveV1 = {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity,
      state_id: "effect-fixture",
      attempt: 1,
      ...prepared,
      operation_kind: this.declaration.operation_kind,
      registration_sha256: runtimeRegistrationSha256(this.registration),
      request_sha256: prepared.request_ref.content_digest,
      input_artifacts: { schema_version: 2, artifacts: [...inputs] },
      expected_result: this.declaration.result,
      policy_binding: hostOperationPolicyBinding(this.declaration, this.backend),
    };
    const context = RunContext.create({
      identity,
      goal: "fixture protocol recovery",
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
      initialArtifacts: [
        prepared.request_ref,
        prepared.effect_intent_ref,
        ...inputs.map((x) => x.ref),
      ],
    });
    context.transition(directive.state_id);
    context.pendingDirective = directive;
    this.checkpointer.createRun(context, "effect_fixture_started", {});
    this.engine.liveness.bindPolicy(context);
    return directive;
  }
  owner(
    adapter: HostOperationAdapterV1,
    fault?: HostOperationRuntimeOwnerOptions["fault"],
    resultCache?: HostOperationRuntimeOwnerOptions["resultCache"]
  ) {
    return new HostOperationRuntimeOwner({
      projectId: this.projectId,
      artifacts: this.store,
      checkpointer: this.checkpointer,
      leaseAuthority: this.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
      ...(fault === undefined ? {} : { fault }),
      ...(resultCache === undefined ? {} : { resultCache }),
    });
  }
  reopen() {
    this.leases.close();
    this.checkpointer.close();
    this.store.close();
    this.store = new ArtifactStore(join(this.root, "artifacts"), { projectId: this.projectId });
    this.checkpointer = new Checkpointer(join(this.root, "control.db"), undefined, {
      projectId: this.projectId,
    });
    this.leases = new HostOperationLeaseAuthority(join(this.root, "state"));
    this.engine = this.newEngine(ReceiptAuthority.loadExisting(join(this.root, "receipt.key")));
  }
  [Symbol.dispose]() {
    this.leases.close();
    this.checkpointer.close();
    this.store.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
export function effectAdapter(counter: {
  submitted: number;
  runs: number;
  recoveries: number;
}): HostOperationAdapterV1 {
  return {
    adapter_id: "effect-fixture",
    inspectRequest: ({ directive }) => ({
      schema_version: 1,
      operation_kind: directive.operation_kind,
      adapter_id: directive.policy_binding.adapter_id,
      backend_binding_id: directive.policy_binding.backend_binding_id,
      backend_key_sha256: directive.policy_binding.backend_key_sha256,
    }),
    run: async (c) => {
      counter.runs++;
      if (c.journal.remote_correlation_id === null) {
        c.beginSubmission();
        counter.submitted++;
        c.recordRemoteAccepted("fixture-exact-target");
      } else counter.recoveries++;
      const content = canonicalJson({
        schema_id: EFFECT_RESULT.schema_id,
        schema_version: 1,
        operation_id: c.directive.operation_id,
        value: "raw",
      });
      c.recordFetched({
        schema_version: 1,
        content_sha256: sha256(content),
        byte_length: Buffer.byteLength(content),
        item_count: 1,
        poll_count: 1,
      });
      const disposition = {
        outcome: "completed",
        remote_disposition: "proven_terminal",
        lease_disposition: "released",
        retryable: false,
        reason_code: null,
      } as const;
      const persisted = c.persist({
        disposition,
        operation_result: { contract: EFFECT_RESULT, media_type: "application/json", content },
      });
      return { disposition, ...persisted };
    },
  };
}
