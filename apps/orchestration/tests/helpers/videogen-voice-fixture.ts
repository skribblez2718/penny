import { LocalApiOperationMeter } from "../../dist/host-operations/local-api-meter.js";
import {
  VoiceApiAdapter,
  createVoiceApiDeclaration,
} from "../../dist/videogen/voice-api-adapter.js";
import { VoiceApiObservationCollector } from "../../dist/videogen/voice-api-observations.js";
import {
  VOICE_API_ADAPTER_ID,
  VOICE_API_RAW_RESULT,
  type VoiceApiProfile,
} from "../../dist/videogen/voice-api-contracts.js";
import { VoiceStudioObservationCollector } from "../../dist/videogen/voice-studio-observations.js";
import {
  prepareHostEffectArtifacts,
  hostEffectOperationId,
} from "../../dist/host-operations/effect-protocol.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ArtifactStore } from "../../dist/artifact-store.js";
import { Checkpointer } from "../../dist/checkpointer.js";
import { RunContext } from "../../dist/context.js";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import type {
  ArtifactRef,
  Directive,
  InvokeHostOperationDirectiveV1,
} from "../../dist/contracts.js";
import { OrchestrationEngine } from "../../dist/engine.js";
import {
  HostOperationRuntimeOwner,
  HostOperationStateOwner,
  type HostOperationRuntimeOwnerOptions,
} from "../../dist/host-operations/owner.js";
import { createPreparedHostOperationCallRecord } from "../../dist/host-operations/storage.js";
import { FileHostOperationResultCache } from "../../dist/host-operations/result-cache.js";
import { HostOperationLeaseAuthority } from "../../dist/host-operations/lease-authority.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
} from "../../dist/host-operations/capacity-authority.js";
import {
  HostOperationCapacityRuntimeBinding,
  type HostCapacityDemandSourceV1,
} from "../../dist/host-operations/capacity-runtime.js";
import {
  hostCapacityWorkerKey,
  type HostCapacityPolicyV1,
} from "../../dist/host-operations/capacity-contracts.js";
import {
  hostOperationPolicyBinding,
  validateHostOperationCallRecord,
  type HostOperationDeclarationV1,
} from "../../dist/host-operations/contracts.js";
import type { Playbook } from "../../dist/playbooks/playbook.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistration,
} from "../../dist/playbooks/registry.js";
import { ProjectCatalog } from "../../dist/state/catalog.js";
import { initializePennyState } from "../../dist/state/index.js";
import { pennyStatePaths, projectStatePaths } from "../../dist/state/paths.js";
import { ReceiptAuthority } from "../../dist/receipts.js";
import { constructGateDecision, type GatePacketV1 } from "../../dist/videogen/gates.js";
import {
  type RightsHostV1,
  type CurrentRightsV1,
  type RightsBindingV1,
} from "../../dist/videogen/rights-ledger.js";
import {
  initializeVideogenOwnerSelection,
  selectVideogenRights,
  readVideogenOwnerSelection,
  VideogenOwnerSelection,
} from "../../dist/videogen/owner-selection.js";
import {
  VoiceStudioAuthority,
  voiceStudioInputs,
} from "../../dist/videogen/voice-studio-authority.js";
import {
  createVoiceStudioDeclaration,
  createVoiceStudioHostBinding,
} from "../../dist/videogen/voice-studio-adapter.js";
import { VoiceStudioCaptureCustody } from "../../dist/videogen/voice-studio-custody.js";
import {
  VOICE_STUDIO_ADAPTER_ID,
  VOICE_STUDIO_REQUEST,
  VoiceStudioJobRequestV1Schema,
  VOICE_STUDIO_RAW_RESULT,
  type VoiceStudioProfileV1,
  type VoiceStudioJobRequestV1,
  VoiceStudioCorrelationV1Schema,
  VoiceStudioReadinessV1Schema,
  VoiceStudioCoverageV1Schema,
} from "../../dist/videogen/voice-studio-contracts.js";
import {
  RAW_MEDIA_REQUEST_CONTRACT,
  RAW_MEDIA_RESULT_CONTRACT,
  MEDIA_PCM_CONTRACT,
  parseMediaJson,
} from "../../dist/videogen/media-contracts.js";
import {
  MEDIA_LIMITS,
  MEDIA_POLICY,
  MEDIA_SELECTION,
  pcmAsset,
  required,
} from "./videogen-media-fixtures.js";
import { meters } from "./capacity-fixtures.js";
import { fixtureMeasurements, captureCapacityMeasurement } from "./capacity-runtime-fixtures.js";

class Consumer implements Playbook {
  dispatch(c: RunContext): Directive {
    if (c.pendingDirective !== null) return c.pendingDirective;
    const ref = required(c.selectedArtifacts.find((x) => x.kind === "host-operation-receipt"));
    const d: Directive = {
      schema_version: 2,
      action: "await_user",
      identity: c.identity,
      state_id: c.stateId,
      gate_id: "fixture-captured",
      challenge: "ack",
      payload_digest: ref.content_digest,
      questions: [{ id: "ack", prompt: "Synthetic capture only, not speech qualification." }],
    };
    c.status = "awaiting_user";
    c.pendingDirective = d;
    return d;
  }
  initialize(c: RunContext): Directive {
    return this.dispatch(c);
  }
  resume(c: RunContext): Directive {
    c.pendingDirective = null;
    c.status = "running";
    const d: Directive = {
      schema_version: 2,
      action: "status",
      identity: c.identity,
      status: c.status,
      state_id: c.stateId,
      terminal: false,
      met: false,
    };
    c.pendingDirective = d;
    return d;
  }
  cancel(c: RunContext): Directive {
    return this.dispatch(c);
  }
  acceptSummary(c: RunContext): Directive {
    return this.dispatch(c);
  }
  rebindPendingDirective(c: RunContext): Directive | null {
    return c.pendingDirective;
  }
}
export type VoiceMode =
  | "ok"
  | "fallback"
  | "partial"
  | "errored"
  | "lost"
  | "wrong-job"
  | "ambiguous-start"
  | "busy"
  | "running"
  | "silent"
  | "bad-coverage"
  | "cancel-unproven"
  | "bad-wav"
  | "voice-race"
  | "ambiguous-create"
  | "readback-drift";
export class VoiceFixture implements AsyncDisposable {
  readonly root = mkdtempSync(path.join(tmpdir(), "penny-voice-studio-"));
  readonly state_root = path.join(this.root, "state");
  readonly project_id: string;
  readonly run_id = "run-voice";
  store: ArtifactStore;
  checkpointer: Checkpointer;
  leases: HostOperationLeaseAuthority;
  capacity_authority: HostOperationCapacityAuthority;
  capacity_project: HostCapacityProjectAuthority;
  capacity: HostOperationCapacityRuntimeBinding;
  readonly policy: HostCapacityPolicyV1;
  readonly rights_index: CurrentRightsV1[] = [];
  private apiLicense: ArtifactRef | undefined;
  readonly readiness = new Map<string, ArtifactRef>();
  readonly coverage = new Map<string, ArtifactRef>();
  readonly observation_path = path.join(this.root, "process-observations.json");
  observations: VoiceStudioObservationCollector | undefined;
  apiObservations: VoiceApiObservationCollector | undefined;
  localMeter: LocalApiOperationMeter | undefined;
  last_readiness_id: string | undefined;
  writeObservationSnapshot(): void {
    const ready = required(this.readiness.get(required(this.profile_ref).content_digest));
    const text = canonicalJson({
      readiness: parseMediaJson(VoiceStudioReadinessV1Schema, this.store.read(ready), MEDIA_LIMITS),
      coverage: [...this.coverage.values()].map((ref) =>
        parseMediaJson(VoiceStudioCoverageV1Schema, this.store.read(ref), MEDIA_LIMITS)
      ),
    });
    writeFileSync(`${this.observation_path}.pending`, text, { mode: 0o600 });
    renameSync(`${this.observation_path}.pending`, this.observation_path);
  }
  clearReadiness(): void {
    const c = required(this.checkpointer.loadRunById(this.run_id));
    c.selectedArtifacts = c.selectedArtifacts.filter(
      (r) => r.content_schema?.schema_id !== "penny.videogen-voice-observation-receipt.v1"
    );
    this.checkpointer.saveRun(c, "fixture_observation_revoked", {});
  }
  readonly calls: string[] = [];
  readonly bodies: unknown[] = [];
  readonly wav = pcmAsset();
  readonly voice = {
    id: "abcdef123456",
    name: "Synthetic fixture voice",
    source: "cloned",
    is_builtin: false,
    meta: {},
    created_at: 1767225600.125,
  };
  readonly narration = {
    id: "item-fixture",
    title: "",
    source_text: "Fixture speech words.",
    instruct: "",
    voice_profile_id: this.voice.id,
    status: "pending",
    created_at: 1767225600.125,
    chunk_count: 1,
    char_count: 21,
  };
  readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => res.destroy());
  });
  mode: VoiceMode = "ok";
  getOnly = false;
  beforeResponse?: (route: string) => void;
  sequence = 0;
  origin = "";
  readonly media_policy_ref: ArtifactRef;
  profile_ref: ArtifactRef | undefined;
  profile: VoiceStudioProfileV1 | undefined;
  apiProfile: VoiceApiProfile | undefined;
  request: VoiceStudioJobRequestV1 | undefined;
  directive: InvokeHostOperationDirectiveV1 | undefined;
  declaration: HostOperationDeclarationV1;
  readonly decode_declaration: HostOperationDeclarationV1;
  registration: PlaybookRegistration;
  engine: OrchestrationEngine;
  authority: VoiceStudioAuthority | undefined;
  readonly demands: HostCapacityDemandSourceV1;
  constructor(
    texts: readonly string[] = ["Fixture speech words."],
    readonly api = false,
    options: { serviceState?: boolean } = {}
  ) {
    this.narration.source_text = texts.join("\n");
    this.narration.char_count = Array.from(this.narration.source_text).length;
    this.narration.chunk_count = texts.length;
    chmodSync(this.root, 0o700);
    if (options.serviceState)
      initializePennyState(this.root, { env: { PENNY_STATE_ROOT: this.state_root } });
    using catalog = new ProjectCatalog(this.state_root, { create: true });
    this.project_id = catalog.registerProject(this.root).projectId;
    const paths = projectStatePaths(pennyStatePaths(this.state_root), this.project_id);
    this.store = ArtifactStore.provision(paths.artifacts.root, { projectId: this.project_id });
    this.checkpointer = Checkpointer.provision(paths.orchestration.database, undefined, {
      projectId: this.project_id,
    });
    this.leases = new HostOperationLeaseAuthority(this.state_root);
    this.media_policy_ref = this.json(MEDIA_POLICY, MEDIA_POLICY.schema_id);
    this.declaration = (api ? createVoiceApiDeclaration : createVoiceStudioDeclaration)({
      backend_binding_id: "voice-fixture",
      lease_profile_id: "voice-lease",
      lease_duration_ms: 10000,
      lease_renew_after_ms: 1000,
      queue_inactivity_ms: 2000,
      operation_inactivity_ms: 5000,
      max_request_bytes: 65536,
      max_input_bytes: 1048576,
      max_output_bytes: 1048576,
      max_progress_events: 128,
    });
    const {
      effect_protocol: _protocol,
      receipt_citing_result: _wrapper,
      ...decodeBase
    } = this.declaration;
    this.decode_declaration = {
      ...decodeBase,
      operation_kind: "media_decode_extract",
      adapter_id: "voice-pcm-fixture",
      backend_binding_id: "voice-pcm-fixture",
      request: RAW_MEDIA_REQUEST_CONTRACT,
      result: RAW_MEDIA_RESULT_CONTRACT,
      capability_classes: ["artifact_store"],
      output_contracts: [MEDIA_PCM_CONTRACT],
      max_input_artifacts: 3,
      recovery_semantics: "disposable_v1",
      cancellation_semantics: "local_abort_only_v1",
    };
    const base = required(resolvePlaybook("research"));
    this.registration = {
      ...base,
      host_states: [...(base.host_states ?? []), "voice_capture", "decode-fixture"],
      construct: () => new Consumer(),
      host_operations: {
        schema_version: 1,
        max_active_per_run: 1,
        declarations: [this.declaration, this.decode_declaration],
      },
    };
    this.engine = this.makeEngine();
    const resourceMeters = (id: string, n: number) =>
      !api
        ? meters(n)
        : {
            ...meters(n),
            cpu_milliseconds: id === "shared-gpu" ? 0 : n,
            gpu_milliseconds: id === "shared-gpu" ? n : 0,
            stored_bytes: id === "shared-gpu" ? 0 : n,
            egress_bytes: id === "shared-gpu" ? 0 : n,
          };
    this.policy = {
      schema_id: "penny.host-capacity-policy.v1",
      schema_version: 1,
      policy_id: "voice-policy",
      topology_sha256: sha256("synthetic physical binding"),
      external_work_policy: api ? "penny_serialized_api" : "exclusive_host",
      max_admissions: 32,
      max_admissions_per_project: 32,
      max_queued: 8,
      max_queued_per_project: 8,
      max_active: 2,
      max_active_per_project: 2,
      max_snapshots_per_operation: 8,
      queue_wait_ms: 2000,
      active_inactivity_ms: 5000,
      cleanup_grace_ms: api ? 2000 : 100,
      resources: ["shared-gpu", "shared-store"].map((resource_id) => ({
        resource_id,
        max_slots: 1,
        protected_finish_slots: 0,
        limits: resourceMeters(resource_id, 10000000),
        protected_finish: resourceMeters(resource_id, 1),
      })),
      bindings: [
        {
          binding_id: "competing-binding",
          worker_id: "other-physical-worker",
          operation_kind: "media_decode_extract",
          adapter_id: this.decode_declaration.adapter_id,
          backend_binding_id: this.decode_declaration.backend_binding_id,
          resource_ids: ["shared-gpu", "shared-store"],
          purpose: "work",
        },
        {
          binding_id: "voice-binding",
          worker_id: "voice-process",
          operation_kind: "voice_job",
          adapter_id: api ? VOICE_API_ADAPTER_ID : VOICE_STUDIO_ADAPTER_ID,
          backend_binding_id: "voice-fixture",
          resource_ids: ["shared-gpu", "shared-store"],
          purpose: "work",
        },
      ],
    };
    HostOperationCapacityAuthority.configure(this.state_root, this.policy);
    this.capacity_project = this.makeCapacityProject();
    this.capacity_authority = new HostOperationCapacityAuthority({
      stateRoot: this.state_root,
      policy: this.policy,
      projects: [this.capacity_project],
    });
    this.demands = {
      requestFor: (i) => ({
        schema_id: "penny.host-capacity-request.v1",
        schema_version: 1,
        operation_record_id: i.operation_record_id,
        project_id: i.project_id,
        binding_id: "voice-binding",
        demands: ["shared-gpu", "shared-store"].map((resource_id) => ({
          resource_id,
          slots: 1,
          meters: resourceMeters(resource_id, 2000000),
        })),
      }),
    };
    this.capacity = new HostOperationCapacityRuntimeBinding(
      this.capacity_authority,
      this.capacity_project,
      this.demands
    );
  }
  private makeCapacityProject(): HostCapacityProjectAuthority {
    if (this.api) {
      this.localMeter = new LocalApiOperationMeter(this.store, this.policy, {
        assurance: "trusted_local_api",
        storage_resource_id: "shared-store",
        network_resource_id: "shared-store",
        resources: [
          { resource_id: "shared-gpu", cpu_slots: 0, gpu_slots: 1 },
          { resource_id: "shared-store", cpu_slots: 1, gpu_slots: 0 },
        ],
        tariffs: { ...meters(1), cost_microcredits: 0, engine_steps: 0 },
        max_socket_observations: 128,
      });
      return new HostCapacityProjectAuthority(
        this.project_id,
        this.checkpointer,
        this.store,
        this.localMeter
      );
    }
    const source = fixtureMeasurements(() => this.store);
    return new HostCapacityProjectAuthority(this.project_id, this.checkpointer, this.store, {
      read: (input) => {
        const j = input.journal;
        if (
          j.remote_correlation_id === null &&
          j.disposition?.remote_disposition === "proven_not_accepted"
        ) {
          const r = this.demands.requestFor({
            project_id: this.project_id,
            operation_record_id: j.operation_record_id,
            directive: j.directive,
            request_bytes: this.store.read(j.request_ref),
          });
          captureCapacityMeasurement(this.store, j, r, 0);
        }
        return source.read(input);
      },
    });
  }
  private makeEngine(): OrchestrationEngine {
    const paths = projectStatePaths(pennyStatePaths(this.state_root), this.project_id);
    return new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.root,
      maxSteps: 100,
      receiptAuthority: ReceiptAuthority.provision(paths.orchestration.receiptKey),
      artifactStore: this.store,
      artifactReader: this.store,
      artifactRevisions: this.store,
      playbookRegistration: this.registration,
    });
  }
  raw(content: string | Uint8Array, media_type = "text/plain", schema?: string): ArtifactRef {
    return this.store.persist({
      metadata: {
        schema_version: 2,
        run_id: this.run_id,
        phase: "voice-fixture",
        branch_id: null,
        kind: "voice-fixture",
        operation_id: `fixture-${++this.sequence}`,
        version: 1,
        producer: "host:voice-fixture",
        media_type,
        parent_ref: null,
        upstream_refs: [],
        ...(schema ? { content_schema: { schema_id: schema, schema_version: 1 } } : {}),
      },
      content,
    });
  }
  json(v: unknown, schema: string): ArtifactRef {
    return this.raw(canonicalJson(v), "application/json", schema);
  }
  rights(
    subject: ArtifactRef,
    subject_kind: RightsBindingV1["subject_kind"],
    consent: ArtifactRef[],
    provenanceRef?: ArtifactRef
  ): ArtifactRef {
    const provenance =
      provenanceRef ??
      this.json(
        {
          schema_id: "penny.videogen-provenance-binding.v1",
          schema_version: 1,
          subject_ref: subject,
          source_refs: [],
          producer_receipt_ref: this.raw("synthetic source receipt, not production"),
        },
        "penny.videogen-provenance-binding.v1"
      );
    const r: RightsBindingV1 = {
      schema_id: "penny.videogen-rights-binding.v1",
      schema_version: 1,
      subject_ref: subject,
      subject_kind,
      revision: 1,
      provenance_ref: provenance,
      license_ref: this.api
        ? (this.apiLicense ??= this.raw("synthetic shared license, not clearance"))
        : this.raw("synthetic license, not clearance"),
      consent_refs: consent,
      allowed_uses: ["source", "preview", "edit", "motion", "deliver"],
      territories: ["test-territory"],
      credits: ["fixture only"],
      valid_from_utc: "2026-01-01T00:00:00Z",
      expires_at_utc: "2027-01-01T00:00:00Z",
    };
    const ref = this.json(r, r.schema_id);
    this.rights_index.push({
      subject_ref: subject,
      rights_ref: ref,
      revision: 1,
      status: "cleared",
    });
    if (this.checkpointer.loadRunById(this.run_id)) this.commitRights();
    return ref;
  }
  ownerSelection(): VideogenOwnerSelection {
    return new VideogenOwnerSelection({
      store: this.store,
      checkpointer: this.checkpointer,
      project_id: this.project_id,
      run_id: this.run_id,
    });
  }
  commitRights(): void {
    const context = required(this.checkpointer.loadRunById(this.run_id));
    selectVideogenRights(context, this.rights_index);
    this.checkpointer.saveRun(context, "fixture_rights_selection", {});
  }
  host(): RightsHostV1 {
    return readVideogenOwnerSelection(this.ownerSelection()).rights;
  }
  async start(registrationForRun?: () => PlaybookRegistration): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address();
    if (!addr || typeof addr === "string") throw new Error("fixture HTTP address");
    this.origin = `http://127.0.0.1:${addr.port}`;
    const build = this.raw("synthetic pinned build, no live qualification"),
      consent = this.raw("synthetic consent");
    const voiceRef = this.json(this.voice, "penny.videogen-voice-studio-voice.v1");
    const script = {
      schema_id: "penny.videogen-script.v1",
      schema_version: 1,
      story_outline_ref: this.raw("outline"),
      scenes: [{ scene_id: "scene-1", ordered_lines: [] }],
      narration_lines: this.narration.source_text
        .split("\n")
        .map((text, i) => ({ line_id: `line-${i + 1}`, text, delivery_intent: "neutral fixture" })),
      language: "en",
      coverage_shot_ids: ["shot-1"],
    };
    const scriptRef = this.json(script, script.schema_id),
      voiceRights = this.rights(voiceRef, "voice", [consent]),
      scriptRights = this.rights(scriptRef, "text", []);
    const plan = {
      schema_id: "penny.videogen-voice-studio-chunk-plan.v1",
      schema_version: 1,
      script_ref: scriptRef,
      source_text: this.narration.source_text,
      chunks: script.narration_lines.map((line, i) => ({
        chunk_id: `chunk-${i + 1}`,
        line_ids: [line.line_id],
        text: line.text,
      })),
    };
    const planRef = this.json(plan, plan.schema_id);
    this.profile = {
      schema_id: "penny.videogen-voice-studio-profile.v1",
      schema_version: 1,
      profile_id: "voice-fixture",
      backend_binding_id: "voice-fixture",
      process_worker_id: "voice-process",
      gpu_resource_ids: ["shared-gpu"],
      service_build_ref: build,
      model_sha256: sha256("synthetic-model"),
      voice_id: this.voice.id,
      voice_sha256: sha256(canonicalJson(this.voice)),
      sample_sha256: sha256(this.wav),
      engine: "fixture-real-interface",
      media_policy_ref: this.media_policy_ref,
      limits: {
        max_text_bytes: 10000,
        max_chunks: 4,
        max_json_bytes: 65536,
        max_wav_bytes: 65536,
        max_sample_bytes: 65536,
        max_request_bytes: 65536,
        connect_ms: 500,
        silence_ms: 500,
        poll_ms: 5,
        cancel_observations: 2,
      },
    };
    this.apiProfile = {
      ...this.profile,
      schema_id: "penny.videogen-voice-api-profile.v1",
      model_sha256: null,
    };
    const configuredProfile = this.api ? this.apiProfile : this.profile;
    this.profile_ref = this.json(configuredProfile, configuredProfile.schema_id);
    const now = Date.now();
    if (!this.api)
      this.readiness.set(
        this.profile_ref.content_digest,
        this.json(
          {
            schema_id: "penny.videogen-voice-studio-readiness.v1",
            schema_version: 1,
            profile_sha256: this.profile_ref.content_digest,
            service_build_ref: build,
            model_sha256: this.profile.model_sha256,
            process_worker_id: "voice-process",
            process_epoch: "fixture-epoch",
            engine: this.profile.engine,
            observed_at_ms: now,
            expires_at_ms: now + 60000,
            isolation: "isolated_loopback",
            external_work: "excluded",
            synthesis: "model_loaded_and_verified",
          },
          "penny.videogen-voice-studio-readiness.v1"
        )
      );
    const story = this.raw("exact fixture story"),
      proposal = {
        schema_id: "penny.videogen-asset-intent.v1",
        schema_version: 1,
        asset_id: "voice-asset",
        purpose: "performance",
        story_ref: story,
        source: "voice_studio",
        input_refs: [scriptRef, planRef, voiceRef],
        allowed_change: "Exact script with exact voice",
        preserve_criteria: ["All words"],
        consent_ref: consent,
        rights_ref: voiceRights,
        estimated_meters: [
          { meter: "attempts", reserved: 1 },
          { meter: "stored_bytes", reserved: 1048576 },
        ],
        attempt_limit: 1,
        scope_status: "proposed",
      };
    const proposalRef = this.json(proposal, proposal.schema_id);
    const packet: GatePacketV1 = {
      schema_id: "penny.videogen-gate-packet.v1",
      schema_version: 1,
      kind: "approval",
      gate_id: "G1",
      run_id: this.run_id,
      challenge: "voice-scope",
      producer_state: "g1",
      presented: [
        { role: "story", ref: story, revision: 1 },
        { role: "asset-intent", ref: proposalRef, revision: 1 },
      ],
      prior_decisions: [],
      change_summary: "Provider-free voice fixture",
      affected_shot_ids: ["shot-1"],
      effect_scope: {
        kinds: ["voice_job"],
        subject_ids: ["voice-asset"],
        meters: [
          { meter: "attempts", limit: 1 },
          { meter: "stored_bytes", limit: 1048576 },
        ],
      },
      limitations: ["Synthetic tone; not speech"],
      rights_refs: [voiceRights, scriptRights],
      review_evidence_refs: [],
      questions: ["Approve fixture?"],
      choices: ["approve", "refine", "deny"],
    };
    const packetRef = this.json(packet, packet.schema_id),
      decision = constructGateDecision(packet, packetRef, "approve", MEDIA_LIMITS),
      decisionRef = this.json(decision, decision.schema_id);
    if (registrationForRun !== undefined) {
      // Seed only the synthetic G1 exchange with Consumer; effect dispatch uses the real service
      // engine and its unchanged registration. No full film or worker execution is implied.
      this.registration = { ...registrationForRun(), construct: () => new Consumer() };
      this.engine = this.makeEngine();
    }
    const identity = {
      schema_version: 2 as const,
      run_id: this.run_id,
      session_id: "voice-session",
      playbook: this.registration.name,
      engine_owner: "typescript" as const,
    };
    const context = RunContext.create({
      identity,
      goal: "provider-free Voice Studio",
      constraints: {},
      projectRoot: this.root,
      trustProfile: "trusted-interactive",
      maxSteps: 100,
      registrationContractBinding: {
        schema_version: 1,
        registration_name: this.registration.name,
        contract_sha256: skillContractSha256(this.registration.contract),
        registration_sha256: runtimeRegistrationSha256(this.registration),
      },
      initialArtifacts: [packetRef, decisionRef, ...packet.presented.map((x) => x.ref)],
    });
    initializeVideogenOwnerSelection(context, {
      project_id: this.project_id,
      limits: MEDIA_LIMITS,
      admitted_destination_id: "local",
      territory: "test-territory",
    });
    selectVideogenRights(context, this.rights_index);
    context.transition("g1");
    context.status = "awaiting_user";
    context.pendingDirective = {
      schema_version: 2,
      action: "await_user",
      identity,
      state_id: "g1",
      gate_id: "voice-G1",
      challenge: packet.challenge,
      payload_digest: packetRef.content_digest,
      questions: [{ id: "approval", prompt: "Fixture approval" }],
    };
    this.checkpointer.createRun(context, "voice_fixture", {});
    this.engine.liveness.bindPolicy(context);
    this.engine.handle({
      schema_version: 2,
      action: "respond",
      identity,
      gate_id: "voice-G1",
      challenge: packet.challenge,
      response: decision,
    });
    const approved = this.json(
      { ...proposal, scope_status: "approved", gate_scope_ref: decisionRef },
      proposal.schema_id
    );
    const policy = this.raw("private fixed policy");
    const ledger = this.json(
      {
        schema_id: "penny.videogen-dependency-ledger.v1",
        schema_version: 1,
        nodes: [scriptRef, voiceRef, decisionRef, approved, planRef].map((ref, i) => ({
          stable_id: `operand-${i}`,
          role: i === 0 ? "script" : i === 1 ? "voice" : i === 2 ? "approval" : "effect",
          ref,
          revision: 1,
          status: "current",
        })),
        edges: [],
        review_epochs: [],
        invalidations: [],
      },
      "penny.videogen-dependency-ledger.v1"
    );
    const budget = this.json(
      {
        schema_id: "penny.videogen-budget-reservation.v1",
        schema_version: 1,
        reservation_id: "voice-budget",
        scope_gate_ref: decisionRef,
        subject_id: "voice-asset",
        operation_kind: "voice_job",
        meters: [
          { meter: "attempts", unit: "count", reserved: 1, consumed: 0 },
          { meter: "stored_bytes", unit: "byte", reserved: 1048576, consumed: 0 },
        ],
        created_at_utc: "2026-01-01T00:00:00Z",
        expires_at_utc: "2027-01-01T00:00:00Z",
        policy_refs: { queue: policy, inactivity: policy, cleanup: policy },
        state: "held",
        reason: "prepared",
      },
      "penny.videogen-budget-reservation.v1"
    );
    const effectIdentity = {
      project_id: this.project_id,
      run_id: this.run_id,
      state_id: "voice_capture",
      visit: 1,
      attempt: 1,
      kind: "voice_job",
      scope_ref: decisionRef,
      predecessor_ref: approved,
      slot: "performance",
    };
    this.request = {
      schema_id: "penny.videogen-voice-job-request.v1",
      schema_version: 1,
      operation_id: hostEffectOperationId(effectIdentity),
      gate_decision_ref: decisionRef,
      selected_ledger_ref: ledger,
      budget_reservation_ref: budget,
      policy_refs: {
        schema_id: "penny.videogen-policy-binding.v1",
        schema_version: 1,
        queue_policy_ref: { ref: policy, max_wait_ms: 2000, discipline: "FIFO" },
        inactivity_policy_ref: {
          ref: policy,
          active_inactivity_ms: 5000,
          transport_silence_ms: 500,
          renewal_source: "trusted_host_milestone",
        },
        cleanup_policy_ref: {
          ref: policy,
          cancel_grace_ms: this.api ? 2000 : 100,
          retention_ms: 10000,
          quarantine_requires_operator_proof: true,
        },
      },
      limits: { max_input_bytes: 1048576, max_output_bytes: 1048576 },
      asset_intent_ref: approved,
      profile_ref: this.profile_ref,
      script_ref: scriptRef,
      script_rights_ref: scriptRights,
      chunk_plan_ref: planRef,
      voice_ref: voiceRef,
      voice_rights_ref: voiceRights,
      voice_id: this.voice.id,
      service_build_ref: build,
      consent_ref: consent,
      expected_chunk_ids: script.narration_lines.map((_, i) => `chunk-${i + 1}`),
      capture_format: "canonical_pcm",
      scope: "performance",
      role: "narration",
      placement: { numerator: 0, denominator: 1 },
    };
    const prepared = prepareHostEffectArtifacts({
      store: this.store,
      identity: effectIdentity,
      request_contract: VOICE_STUDIO_REQUEST,
      request_schema: VoiceStudioJobRequestV1Schema,
      request: this.request,
      input_refs: voiceStudioInputs(this.request, this.profile).map((x) => x.ref),
      budget_reservation_ref: budget,
      expected_output_contract_ref: this.raw(
        canonicalJson(this.api ? VOICE_API_RAW_RESULT : VOICE_STUDIO_RAW_RESULT),
        "application/json"
      ),
      profile_snapshot_ref: this.profile_ref,
    });
    this.directive = {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity,
      state_id: "voice_capture",
      attempt: 1,
      ...prepared,
      operation_kind: "voice_job",
      registration_sha256: runtimeRegistrationSha256(this.registration),
      request_sha256: prepared.request_ref.content_digest,
      input_artifacts: {
        schema_version: 2,
        artifacts: voiceStudioInputs(this.request, this.profile),
      },
      expected_result: this.api ? VOICE_API_RAW_RESULT : VOICE_STUDIO_RAW_RESULT,
      policy_binding: hostOperationPolicyBinding(
        this.declaration,
        hostCapacityWorkerKey("voice-process")
      ),
    };
    const loaded = required(this.checkpointer.loadRunById(this.run_id));
    loaded.selectedArtifacts.push(ledger, budget, approved);
    loaded.transition("voice_capture");
    loaded.status = "running";
    loaded.pendingDirective = this.directive;
    this.checkpointer.saveRun(loaded, "voice_ready", {});
    const owner = this.ownerSelection();
    if (this.api) {
      this.apiObservations = new VoiceApiObservationCollector({
        owner,
        profile_ref: this.profile_ref,
        profile: required(this.apiProfile),
        transport: { origin: this.origin, mode: "isolated_loopback" },
        wire_meter: required(this.localMeter),
      });
    } else {
      this.writeObservationSnapshot();
      this.observations = new VoiceStudioObservationCollector({
        owner,
        profile_ref: this.profile_ref,
        profile: this.profile,
        transport: { origin: this.origin, mode: "isolated_loopback" },
        process_snapshot_path: this.observation_path,
      });
      await this.observations.collect("readiness", AbortSignal.timeout(2000));
      this.last_readiness_id = required(
        this.readiness.get(this.profile_ref.content_digest)
      ).artifact_id;
    }
    this.calls.length = 0;
    this.authority = new VoiceStudioAuthority({
      store: this.store,
      checkpointer: this.checkpointer,
      owner,
      capacity: this.capacity,
      capacity_authority: this.capacity_authority,
      profile_ref: this.profile_ref,
      profile: configuredProfile,
      transport: { origin: this.origin, mode: "isolated_loopback" },
      limits: MEDIA_LIMITS,
      observations: required(this.api ? this.apiObservations : this.observations),
      ...(this.api ? { assurance: "trusted_local_api" as const } : {}),
    });
  }
  competingReservation(sameWorker: boolean) {
    const operation_id = sameWorker ? "same-process" : "other-process";
    const run_id = `competing-${operation_id}`;
    const declaration = sameWorker ? this.declaration : this.decode_declaration;
    const source = this.raw(this.wav, "audio/wav"),
      selection = this.json(MEDIA_SELECTION, MEDIA_SELECTION.schema_id);
    const request = sameWorker
      ? { ...required(this.request), operation_id }
      : {
          schema_id: RAW_MEDIA_REQUEST_CONTRACT.schema_id,
          schema_version: 1,
          operation_id,
          media_ref: source,
          decode_policy_ref: this.media_policy_ref,
          frame_selection_ref: selection,
          required_spans: [
            { start: { numerator: 0, denominator: 1 }, end: { numerator: 1, denominator: 1 } },
          ],
          audio_policy: "measure_pcm",
        };
    const ref0 = this.json(request, request.schema_id),
      ref = this.store.persist({
        metadata: {
          ...this.store.metadata(ref0),
          kind: declaration.request.artifact_kind,
          run_id,
          operation_id,
        },
        content: canonicalJson(request),
      });
    const {
      effect_identity: _identity,
      effect_intent_ref: _intent,
      ...parent
    } = required(this.directive);
    const directive = {
      ...parent,
      identity: { ...required(this.directive).identity, run_id },
      state_id: "decode-fixture",
      operation_id,
      operation_kind: declaration.operation_kind,
      request_ref: ref,
      request_sha256: ref.content_digest,
      expected_result: declaration.result,
      policy_binding: hostOperationPolicyBinding(
        declaration,
        hostCapacityWorkerKey(sameWorker ? "voice-process" : "other-physical-worker")
      ),
    };
    const context = RunContext.create({
      identity: directive.identity,
      goal: "capacity-only competing fixture; no provider dispatch",
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
      initialArtifacts: [ref],
    });
    context.transition(directive.state_id);
    context.pendingDirective = directive;
    this.checkpointer.createRun(context, "fixture_competing_capacity", {});
    this.engine.liveness.bindPolicy(context);
    const now = Date.now(),
      owner = new HostOperationStateOwner(this.checkpointer, this.store);
    let record = owner.reserve({
      record: createPreparedHostOperationCallRecord({
        project_id: this.project_id,
        directive,
        queue_inactivity_expires_at_ms: now + 1000,
        operation_inactivity_expires_at_ms: now + 5000,
        timestamp: new Date(now).toISOString(),
      }),
    }).record;
    const lease = this.leases.tryAcquire(
      {
        operation_record_id: record.operation_record_id,
        backend_key_sha256: directive.policy_binding.backend_key_sha256,
        project_id: this.project_id,
        run_id,
        state_id: directive.state_id,
        attempt: 1,
        operation_id,
        registration_sha256: directive.registration_sha256,
        request_sha256: ref.content_digest,
        duration_ms: 10000,
        queue_inactivity_expires_at_ms: record.queue_inactivity_expires_at_ms,
      },
      now
    );
    if (lease.kind !== "acquired" && lease.kind !== "adopted")
      return { lease, capacity: undefined };
    record = owner.transition(
      record,
      validateHostOperationCallRecord({
        ...record,
        lifecycle: "lease_acquired",
        lease: lease.active.lease,
        lease_expires_at_ms: lease.active.expires_at_ms,
        updated_at: new Date(now).toISOString(),
      })
    );
    const capacity = this.capacity_authority.reserveRuntime({
      schema_id: "penny.host-capacity-request.v1",
      schema_version: 1,
      operation_record_id: record.operation_record_id,
      project_id: this.project_id,
      binding_id: "competing-binding",
      demands: ["shared-gpu", "shared-store"].map((resource_id) => ({
        resource_id,
        slots: 1,
        meters: meters(2000000),
      })),
    });
    return { lease, capacity };
  }
  async reopen(): Promise<void> {
    const previous = required(this.authority).bindings;
    this.capacity_authority.close();
    this.leases.close();
    this.checkpointer.close();
    this.store.close();
    const paths = projectStatePaths(pennyStatePaths(this.state_root), this.project_id);
    this.store = ArtifactStore.openExisting(paths.artifacts.root, { projectId: this.project_id });
    this.checkpointer = Checkpointer.openExisting(paths.orchestration.database, undefined, {
      projectId: this.project_id,
    });
    this.leases = new HostOperationLeaseAuthority(this.state_root);
    this.capacity_project = this.makeCapacityProject();
    this.capacity_authority = new HostOperationCapacityAuthority({
      stateRoot: this.state_root,
      policy: this.policy,
      projects: [this.capacity_project],
    });
    this.capacity = new HostOperationCapacityRuntimeBinding(
      this.capacity_authority,
      this.capacity_project,
      this.demands
    );
    this.engine = this.makeEngine();
    const owner = this.ownerSelection();
    if (this.api) {
      this.apiObservations = new VoiceApiObservationCollector({
        owner,
        profile_ref: required(this.profile_ref),
        profile: required(this.apiProfile),
        transport: { origin: this.origin, mode: "isolated_loopback" },
        wire_meter: required(this.localMeter),
      });
    } else {
      this.writeObservationSnapshot();
      this.observations = required(this.observations).rebindOwner(owner);
      if (
        this.last_readiness_id !==
        required(this.readiness.get(required(this.profile_ref).content_digest)).artifact_id
      ) {
        await this.observations.collect("readiness", AbortSignal.timeout(2000));
        this.last_readiness_id = required(
          this.readiness.get(required(this.profile_ref).content_digest)
        ).artifact_id;
      }
    }
    this.authority = new VoiceStudioAuthority({
      ...previous,
      observations: required(this.api ? this.apiObservations : this.observations),
      store: this.store,
      checkpointer: this.checkpointer,
      owner,
      capacity: this.capacity,
      capacity_authority: this.capacity_authority,
    });
  }
  record() {
    return required(
      this.checkpointer.hostOperationCallForDirective(
        this.run_id,
        "voice_capture",
        1,
        required(this.directive).operation_id
      )
    );
  }
  /** Body-free synthetic host evidence for a failed operation, before output narrowing. */
  diagnostics(record = this.record()): string {
    const capacity = this.capacity_authority.inspect(record.operation_record_id);
    return canonicalJson({
      operation_id: record.operation_id,
      state_id: record.state_id,
      lifecycle: record.lifecycle,
      disposition: record.disposition,
      created_at: record.created_at,
      updated_at: record.updated_at,
      queue_inactivity_expires_at_ms: record.queue_inactivity_expires_at_ms,
      operation_inactivity_expires_at_ms: record.operation_inactivity_expires_at_ms,
      lease_expires_at_ms: record.lease_expires_at_ms,
      capacity: capacity
        ? {
            state: capacity.state,
            active_started_ms: capacity.active_started_ms,
            last_milestone_ms: capacity.last_milestone_ms,
            cleanup_started_ms: capacity.cleanup_started_ms,
            deadlines: this.capacity_authority.deadlines(record.operation_record_id),
          }
        : null,
      calls: this.calls,
    });
  }
  async owner(
    fault?: HostOperationRuntimeOwnerOptions["fault"]
  ): Promise<HostOperationRuntimeOwner> {
    const authority = required(this.authority);
    const binding = this.api
      ? {
          adapters: new Map([
            [VOICE_API_ADAPTER_ID, required(this.localMeter).wrap(new VoiceApiAdapter(authority))],
          ]),
          useValidator: authority,
          capacityRuntime: this.capacity,
          resultCache: await FileHostOperationResultCache.provision(path.join(this.root, "cache")),
        }
      : createVoiceStudioHostBinding(
          authority,
          this.declaration,
          await FileHostOperationResultCache.provision(path.join(this.root, "cache"))
        );
    return new HostOperationRuntimeOwner({
      projectId: this.project_id,
      checkpointer: this.checkpointer,
      artifacts: this.store,
      leaseAuthority: this.leases,
      ...binding,
      ...(fault ? { fault } : {}),
    });
  }
  custody(): VoiceStudioCaptureCustody {
    return new VoiceStudioCaptureCustody({
      authority: required(this.authority),
      leases: this.leases,
      declaration: this.declaration,
      registration_sha256: runtimeRegistrationSha256(this.registration),
    });
  }
  measure(): void {
    const j = this.record(),
      request = this.demands.requestFor({
        project_id: this.project_id,
        operation_record_id: j.operation_record_id,
        directive: j.directive,
        request_bytes: this.store.read(j.request_ref),
      });
    captureCapacityMeasurement(this.store, j, request, 1);
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = req.url ?? "";
    this.calls.push(`${req.method} ${route}`);
    if (this.getOnly && req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const json = (value: unknown, status = 200): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) {
        if (!Buffer.isBuffer(c)) throw new Error("fixture body type");
        chunks.push(c);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      this.bodies.push(body);
    }
    this.beforeResponse?.(route);
    if (route === "/openapi.json")
      return json({
        openapi: "3.1.0",
        paths: {
          "/api/narrations": { post: {} },
          "/api/narrations/{item_id}": { get: {} },
          "/api/tts/generate": { post: {} },
          "/api/tts/jobs/{job_id}": { get: {} },
          "/api/tts/result/{item_id}.wav": { get: {} },
        },
      });
    if (route === "/api/system/health")
      return json({
        status: "ok",
        version: "fixture-normal-api",
        models_loaded: false,
        gpu_available: true,
        engine: required(this.profile).engine,
      });
    if (route === "/api/voices") return json([this.voice]);
    if (route === `/api/voices/${this.voice.id}`)
      return json(this.mode === "fallback" ? { ...this.voice, name: "wrong voice" } : this.voice);
    if (route.endsWith("/sample")) {
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(this.wav);
      return;
    }
    if (route === "/api/narrations" && this.mode === "ambiguous-create") {
      req.socket.destroy();
      return;
    }
    if (route.startsWith("/api/narrations/") && this.mode === "readback-drift")
      return json({ ...this.narration, source_text: "Wrong words." });
    if (route.startsWith("/api/narrations"))
      return json(this.narration, req.method === "POST" ? 201 : 200);
    if (route === "/api/tts/generate") {
      if (this.mode === "ambiguous-start") {
        req.socket.destroy();
        return;
      }
      if (this.mode === "busy") return json({ detail: "busy" }, 409);
      return json({
        job_id: "job-fixture",
        narration_item_id: this.narration.id,
        status: "running",
      });
    }
    if (route.startsWith("/api/tts/jobs/")) {
      if (this.mode === "lost") return json({ detail: "unknown volatile job" }, 404);
      const running = this.mode === "running" || this.mode === "cancel-unproven";
      const j = {
        job_id: this.mode === "wrong-job" ? "wrong-job" : "job-fixture",
        narration_item_id: this.narration.id,
        status: running
          ? "running"
          : this.mode === "errored"
            ? "completed_with_errors"
            : "completed",
        total_chunks: this.narration.chunk_count + (this.mode === "partial" ? 1 : 0),
        completed: running ? 0 : this.narration.chunk_count,
        errored: this.mode === "errored" ? 1 : 0,
        percent: running ? 0 : 100,
      };
      if (this.api) return json(j);
      const r = required(this.request),
        corr = parseMediaJson(
          VoiceStudioCorrelationV1Schema,
          Buffer.from(required(this.record().remote_correlation_id)),
          MEDIA_LIMITS
        );
      if (!this.coverage.has("job-fixture"))
        this.coverage.set(
          "job-fixture",
          this.json(
            {
              schema_id: "penny.videogen-voice-studio-coverage.v1",
              schema_version: 1,
              correlation: corr,
              script_ref: r.script_ref,
              chunk_plan_ref: r.chunk_plan_ref,
              voice_id: r.voice_id,
              observed_at_ms: Date.now(),
              narration_sha256: sha256(canonicalJson(this.narration)),
              chunks: this.narration.source_text.split("\n").map((text, i) => ({
                chunk_id: `chunk-${i + 1}`,
                segment_id: `segment-${i + 1}`,
                text_sha256: sha256(this.mode === "bad-coverage" ? "wrong words" : text),
                voice_id: r.voice_id,
                resolved_voice_sha256: required(this.profile).voice_sha256,
                fallback_used: this.mode === "voice-race",
                status: "completed",
                error: null,
              })),
            },
            "penny.videogen-voice-studio-coverage.v1"
          )
        );
      this.writeObservationSnapshot();
      if (!running) this.measure();
      return json(j);
    }
    if (route.startsWith("/api/tts/cancel/"))
      return json({ job_id: "job-fixture", status: "cancelled" });
    if (route.endsWith(".wav")) {
      if (!this.api) this.measure();
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(
        this.mode === "silent"
          ? pcmAsset(true)
          : this.mode === "bad-wav"
            ? Buffer.from("not WAV")
            : this.wav
      );
      return;
    }
    json({ detail: "unknown fixture route" }, 404);
  }
  async [Symbol.asyncDispose](): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.capacity_authority.close();
    this.leases.close();
    this.checkpointer.close();
    this.store.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
