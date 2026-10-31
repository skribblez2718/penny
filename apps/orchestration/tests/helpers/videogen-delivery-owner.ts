import {
  initializeVideogenOwnerSelection,
  selectVideogenRights,
  recordVideogenGateAnswer,
  VideogenOwnerSelection,
} from "../../dist/videogen/owner-selection.js";
import {
  prepareHostEffectArtifacts,
  HOST_RECEIPTED_RESULT_CONTRACT,
} from "../../dist/host-operations/effect-protocol.js";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { ArtifactStore } from "../../dist/artifact-store.js";
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
import { ProjectCatalog } from "../../dist/state/catalog.js";
import { LocalDeliveryFiles } from "../../dist/videogen/delivery-files.js";
import {
  createLocalDeliveryAdapter,
  prepareLocalDelivery,
  DELIVERY_REQUEST_CONTRACT,
  DELIVERY_RESULT_CONTRACT,
  DeliveryOperationRequestSchema,
  type DeliveryHost,
  type LocalDeliveryBinding,
} from "../../dist/videogen/delivery.js";
import {
  constructGateDecision,
  validateGatePacket,
  type CurrentGateApprovalV1,
} from "../../dist/videogen/gates.js";
import { FoundationFixture, FOUNDATION_LIMITS } from "./videogen-foundation-fixtures.js";
import type { VideogenMeter } from "../../dist/videogen/foundation-contracts.js";
import { editFixture, packageFixture, manifestMetadata } from "./videogen-edit-fixtures.js";
import { TEST_RECEIPT_AUTHORITY } from "../fixtures/test-receipt-authority.js";
class Consumer implements Playbook {
  dispatch(c: RunContext): Directive {
    const d: Directive = {
      schema_version: 2,
      action: "await_user",
      identity: c.identity,
      state_id: c.stateId,
      gate_id: "fixture-done",
      challenge: "fixture-only",
      payload_digest: sha256("fixture"),
      questions: [{ id: "ack", prompt: "Protocol only, not production." }],
    };
    c.pendingDirective = d;
    c.status = "awaiting_user";
    return d;
  }
  initialize(c: RunContext): Directive {
    return this.dispatch(c);
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
export class DeliveryOwnerFixture extends FoundationFixture {
  declare readonly project_id: string;
  declare readonly store: ArtifactStore;
  declare readonly checkpointer: Checkpointer;
  readonly e: ReturnType<typeof editFixture>;
  readonly p: ReturnType<typeof packageFixture>;
  readonly destination = path.join(this.root, "destination");
  readonly backend = sha256("local delivery fixture");
  readonly files: LocalDeliveryFiles;
  readonly leases: HostOperationLeaseAuthority;
  readonly declaration: HostOperationDeclarationV1;
  readonly registration: PlaybookRegistration;
  readonly engine: OrchestrationEngine;
  readonly context: RunContext;
  readonly binding: LocalDeliveryBinding;
  readonly manifest_ref: ArtifactRef;
  readonly g5: ArtifactRef;
  readonly budget_ref: ArtifactRef;
  constructor(
    declaration?: HostOperationDeclarationV1,
    campaignMeters?: readonly { meter: VideogenMeter; limit: number }[],
    editOptions?: Parameters<typeof editFixture>[1]
  ) {
    super();
    mkdirSync(this.destination, { mode: 0o700 });
    this.files = new LocalDeliveryFiles([
      {
        destination_id: "local-output",
        root: this.destination,
        max_files: 1000,
        max_bytes: 10000000,
        reserve_bytes: 1,
      },
    ]);
    const state = path.join(this.root, "state");
    using catalog = new ProjectCatalog(state, { create: true });
    this.store.close();
    this.checkpointer.close();
    this.project_id = catalog.registerProject(this.root).projectId;
    this.store = ArtifactStore.provision(path.join(this.root, "delivery-artifacts"), {
      projectId: this.project_id,
    });
    this.checkpointer = Checkpointer.provision(
      path.join(this.root, "delivery-control.db"),
      undefined,
      { projectId: this.project_id }
    );
    this.e = editFixture(this, editOptions);
    this.p = packageFixture(this, this.e);
    this.leases = new HostOperationLeaseAuthority(state);
    const lp = {
      profile_id: "delivery-fixture",
      profile_version: 1 as const,
      duration_ms: 60000,
      renew_after_ms: 10000,
      queue_inactivity_ms: 30000,
    };
    this.declaration = declaration ?? {
      schema_version: 1,
      operation_kind: "local_delivery",
      adapter_id: "delivery-fixture",
      backend_binding_id: "local-fixture",
      request: DELIVERY_REQUEST_CONTRACT,
      result: DELIVERY_RESULT_CONTRACT,
      capability_classes: ["registered_export_root"],
      lease_profile: { ...lp, profile_sha256: hostOperationLeaseProfileSha256(lp) },
      operation_inactivity_ms: 60000,
      max_request_bytes: 16384,
      max_input_artifacts: 1,
      max_input_bytes: 16384,
      max_output_artifacts: 2,
      effect_protocol: "request_intent_v1",
      receipt_citing_result: HOST_RECEIPTED_RESULT_CONTRACT,
      max_output_bytes: 1000000,
      max_progress_events: 16,
      max_pre_acceptance_retries: 0,
      recovery_semantics: "atomic_local_publication_v1",
      cancellation_semantics: "local_abort_only_v1",
    };
    const base = resolvePlaybook("research");
    if (base === undefined) throw new Error("research missing");
    this.registration = {
      ...base,
      host_states: [...(base.host_states ?? []), "delivery-fixture"],
      host_operations: {
        schema_version: 1,
        max_active_per_run: 1,
        declarations: [this.declaration],
      },
      construct: () => new Consumer(),
    };
    this.engine = new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.root,
      maxSteps: 200,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactStore: this.store,
      artifactReader: this.store,
      artifactRevisions: this.store,
      playbookRegistration: this.registration,
    });
    this.context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: this.run_id,
        session_id: "delivery-fixture",
        playbook: "research",
        engine_owner: "typescript",
      },
      goal: "local protocol fixture",
      constraints: {},
      projectRoot: this.root,
      trustProfile: "trusted-interactive",
      maxSteps: 200,
      registrationContractBinding: {
        schema_version: 1,
        registration_name: this.registration.name,
        contract_sha256: skillContractSha256(this.registration.contract),
        registration_sha256: runtimeRegistrationSha256(this.registration),
      },
    });
    initializeVideogenOwnerSelection(this.context, {
      project_id: this.project_id,
      limits: FOUNDATION_LIMITS,
      admitted_destination_id: "local-output",
      territory: this.e.host.territory,
    });
    selectVideogenRights(this.context, this.current_rights);
    // Fixture selection is deliberately committed through the concrete checkpoint, not a host index.
    this.context.selectedArtifacts.push(
      this.e.edit_ref,
      this.e.edit.source_dependency_ledger_ref,
      ...this.e.host.current_dependencies.map((n) => n.ref),
      ...this.e.host.measured_source_refs,
      ...this.e.host.audio_sources.flatMap((a) => [a.source_ref, a.measurement_ref])
    );
    this.checkpointer.createRun(this.context, "delivery_fixture_started", {});
    this.engine.liveness.bindPolicy(this.context);
    this.manifest_ref = this.store.persist({
      metadata: manifestMetadata(this),
      content: canonicalJson(this.p.manifest),
    });
    const approvals: CurrentGateApprovalV1[] = [],
      presented: { role: string; ref: ArtifactRef; revision: number }[] = [];
    const host: DeliveryHost = {
      ...this.e.host,
      checkpointer: this.checkpointer,
      admitted_destination_id: "local-output",
      current_approvals: approvals,
      current_presented: presented,
    };
    for (const gate of ["G1", "G2", "G3", "G4", "G5"] as const) {
      const roles = {
        G1: "story",
        G2: "look-voice",
        G3: "animatic",
        G4: "rough-cut",
        G5: "master",
      };
      const items =
        gate === "G5"
          ? [
              { role: "master", ref: this.p.master, revision: 1 },
              { role: "package", ref: this.manifest_ref, revision: 1 },
              { role: "project", ref: this.p.project, revision: 1 },
            ]
          : [
              {
                role: roles[gate],
                ref:
                  gate === "G4" ? this.e.edit_ref : this.opaque(`${gate} synthetic prerequisite`),
                revision: 1,
              },
            ];
      if (gate === "G1") {
        const story = items[0];
        if (story === undefined) throw new Error("story absent");
        const ref = this.opaque("rights fixture");
        items.push({
          role: "asset-intent",
          revision: 1,
          ref: this.json(
            {
              schema_id: "penny.videogen-asset-intent.v1",
              schema_version: 1,
              asset_id: "asset",
              purpose: "first_frame",
              story_ref: story.ref,
              source: "imagegen_fresh",
              input_refs: [],
              allowed_change: "fixture",
              preserve_criteria: ["fixture"],
              consent_ref: ref,
              rights_ref: ref,
              estimated_meters: [{ meter: "attempts", reserved: 1 }],
              attempt_limit: 1,
              scope_status: "proposed",
            },
            "penny.videogen-asset-intent.v1"
          ),
        });
      }
      presented.push(...items);
      const packet = validateGatePacket(
        {
          schema_id: "penny.videogen-gate-packet.v1",
          schema_version: 1,
          kind: "approval",
          gate_id: gate,
          run_id: this.run_id,
          challenge: `challenge-${gate}`,
          producer_state: {
            G1: "story_plan",
            G2: "asset_prepare",
            G3: "animatic_plan",
            G4: "rough_build",
            G5: "finish_prepare",
          }[gate],
          presented: items,
          prior_decisions: approvals.map((a) => a.decision_ref),
          change_summary: "synthetic protocol only",
          affected_shot_ids: [],
          effect_scope: {
            kinds:
              gate === "G1"
                ? ["child_imagegen"]
                : gate === "G3" || gate === "G4"
                  ? gate === "G4"
                    ? ["video_render", "kdenlive_build_verify"]
                    : ["video_render"]
                  : [],
            subject_ids: gate === "G1" ? ["asset"] : gate === "G3" || gate === "G4" ? ["shot"] : [],
            meters:
              gate === "G1" || gate === "G3" || gate === "G4"
                ? gate === "G1"
                  ? [{ meter: "attempts", limit: 1 }]
                  : [...(campaignMeters ?? [{ meter: "attempts", limit: 1 }])]
                : [],
            ...(gate === "G5" ? { destination_id: "local-output" } : {}),
          },
          limitations: ["NOT qualified production"],
          rights_refs: [],
          review_evidence_refs: [],
          questions: ["Fixture?"],
          choices: ["approve", "refine", "deny"],
        },
        FOUNDATION_LIMITS
      );
      const packet_ref = this.json(packet, packet.schema_id),
        decision = constructGateDecision(packet, packet_ref, "approve", FOUNDATION_LIMITS),
        decision_ref = this.json(decision, decision.schema_id),
        engine_gate_id = `fixture-${gate}`;
      this.context.transition(gate.toLowerCase());
      this.context.status = "awaiting_user";
      this.context.pendingDirective = {
        schema_version: 2,
        action: "await_user",
        identity: this.context.identity,
        state_id: this.context.stateId,
        gate_id: engine_gate_id,
        challenge: packet.challenge,
        payload_digest: packet_ref.content_digest,
        questions: [{ id: "accept", prompt: "Fixture only?" }],
      };
      this.context.selectedArtifacts.push(packet_ref, decision_ref, ...items.map((i) => i.ref));
      this.checkpointer.saveRun(this.context, "fixture_gate_pending", {});
      const pending = this.context.pendingDirective;
      if (pending === null) throw new Error("fixture pending absent");
      recordVideogenGateAnswer(this.context, pending, decision, this.store);
      this.context.pendingDirective = null;
      this.context.status = "running";
      this.checkpointer.saveGateResponse(
        this.context,
        engine_gate_id,
        packet.challenge,
        decision,
        "fixture_gate_answered",
        {}
      );
      approvals.push({
        gate_id: gate,
        engine_gate_id,
        challenge: packet.challenge,
        packet_ref,
        decision_ref,
      });
    }
    const g5 = approvals.at(-1);
    if (g5 === undefined) throw new Error("g5 missing");
    this.g5 = g5.decision_ref;
    this.budget_ref = this.json(
      {
        schema_id: "penny.videogen-budget-reservation.v1",
        schema_version: 1,
        reservation_id: "delivery-fixture-reservation",
        subject_id: "local-output",
        created_at_utc: new Date(Date.now() - 60000).toISOString(),
        policy_refs: {
          queue: this.opaque("queue"),
          inactivity: this.opaque("inactivity"),
          cleanup: this.opaque("cleanup"),
        },
        scope_gate_ref: this.g5,
        operation_kind: "local_delivery",
        expires_at_utc: new Date(Date.now() + 3600000).toISOString(),
        meters: [{ meter: "stored_bytes", reserved: 10000000, consumed: 0, unit: "byte" }],
        state: "held",
        reason: "applied",
      },
      "penny.videogen-budget-reservation.v1"
    );
    this.context.selectedArtifacts.push(
      this.manifest_ref,
      this.budget_ref,
      this.p.master,
      this.p.project
    );
    this.checkpointer.saveRun(this.context, "delivery_selections", {});
    this.binding = {
      owner: new VideogenOwnerSelection({
        store: this.store,
        checkpointer: this.checkpointer,
        project_id: this.project_id,
        run_id: this.run_id,
      }),
      host,
      files: this.files,
      adapter_id: this.declaration.adapter_id,
      backend_binding_id: this.declaration.backend_binding_id,
      backend_key_sha256: this.backend,
    };
  }
  prepare(master_ref = this.p.master) {
    return prepareLocalDelivery({
      binding: this.binding,
      intent: {
        destination_id: "local-output",
        g5_decision_ref: this.g5,
        master_ref,
        manifest_ref: this.manifest_ref,
        project_ref: this.p.project,
        rights_check_ref: this.p.manifest.rights_ledger_ref,
        budget_ref: this.budget_ref,
      },
      metadata: {
        ...manifestMetadata(this),
        kind: "videogen-delivery-intent",
        producer: "host:videogen-delivery",
        content_schema: { schema_id: "penny.videogen-delivery-intent.v1", schema_version: 1 },
      },
      signal: new AbortController().signal,
    });
  }
  directive(intent_ref: ArtifactRef): InvokeHostOperationDirectiveV1 {
    const effect = prepareHostEffectArtifacts({
      store: this.store,
      identity: {
        project_id: this.project_id,
        run_id: this.run_id,
        state_id: "delivery-fixture",
        visit: 1,
        attempt: 1,
        kind: "local_delivery",
        slot: "local-output",
        scope_ref: this.g5,
        predecessor_ref: this.manifest_ref,
      },
      request_contract: DELIVERY_REQUEST_CONTRACT,
      request_schema: DeliveryOperationRequestSchema,
      request: {
        schema_id: DELIVERY_REQUEST_CONTRACT.schema_id,
        schema_version: 1,
        delivery_intent_ref: intent_ref,
      },
      input_refs: [intent_ref],
      budget_reservation_ref: this.budget_ref,
      expected_output_contract_ref: this.json(
        DELIVERY_RESULT_CONTRACT,
        "penny.videogen-expected-delivery-output.v1"
      ),
    });
    const d: InvokeHostOperationDirectiveV1 = {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: this.context.identity,
      state_id: "delivery-fixture",
      attempt: 1,
      operation_id: effect.operation_id,
      effect_intent_ref: effect.effect_intent_ref,
      effect_identity: effect.effect_identity,
      operation_kind: "local_delivery",
      registration_sha256: runtimeRegistrationSha256(this.registration),
      request_ref: effect.request_ref,
      request_sha256: effect.request_ref.content_digest,
      input_artifacts: {
        schema_version: 2,
        artifacts: [{ slot: "delivery-intent", ref: intent_ref }],
      },
      expected_result: DELIVERY_RESULT_CONTRACT,
      policy_binding: hostOperationPolicyBinding(this.declaration, this.backend),
    };
    this.context.transition(d.state_id);
    this.context.pendingDirective = d;
    this.checkpointer.saveRun(this.context, "delivery_fixture_prepared", {});
    return d;
  }
  owner(fault?: HostOperationRuntimeOwnerOptions["fault"]) {
    const adapter = createLocalDeliveryAdapter(this.binding);
    return new HostOperationRuntimeOwner({
      projectId: this.project_id,
      checkpointer: this.checkpointer,
      artifacts: this.store,
      leaseAuthority: this.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
      useValidator: adapter,
      ...(fault === undefined ? {} : { fault }),
    });
  }
  override [Symbol.dispose](): void {
    this.files[Symbol.dispose]();
    this.leases.close();
    super[Symbol.dispose]();
  }
}
