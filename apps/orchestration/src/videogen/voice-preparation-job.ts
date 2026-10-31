import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactStore } from "../artifact-store.js";
import { Checkpointer } from "../checkpointer.js";
import { RunContext } from "../context.js";
import {
  type Directive,
  type SkillContract,
  type InvokeHostOperationDirectiveV1,
} from "../contracts.js";
import { OrchestrationEngine } from "../engine.js";
import { ReceiptAuthority } from "../receipts.js";
import { loadRuntimeConfig } from "../config.js";
import { ordinaryLivenessPolicy } from "../liveness.js";
import { OrchestrationRunner, WorkerExecutor } from "../worker.js";
import {
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistration,
} from "../playbooks/registry.js";
import type { Playbook } from "../playbooks/playbook.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
} from "../host-operations/capacity-authority.js";
import { HostOperationCapacityRuntimeBinding } from "../host-operations/capacity-runtime.js";
import { HostOperationRuntimeOwner } from "../host-operations/owner.js";
import { HostOperationLeaseAuthority } from "../host-operations/lease-authority.js";
import { hostOperationPolicyBinding } from "../host-operations/contracts.js";
import {
  hostCapacityWorkerKey,
  zeroCapacityMeters,
} from "../host-operations/capacity-contracts.js";
import { NativeCapacityMeter } from "../host-operations/native-capacity.js";
import { readNativeText } from "../host-operations/native-process.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import {
  VoicePreparationAdapter,
  VoicePreparationObserver,
  VoicePreparationBindingsSchema,
  VoicePreparationRequestSchema,
  VOICE_PREPARATION_ADAPTER,
  VOICE_PREPARATION_REQUEST,
  VOICE_PREPARATION_RESULT,
  voicePreparationDeclaration,
  type VoicePreparationBindings,
  type VoicePreparationRequest,
} from "./voice-preparation.js";

const NAME = "voice-preparation";
const STATE = "prepare_models";
const PREDICATE = "voice.preparation_settled.v1";
const guidance = {
  skill_root: "apps/orchestration/src/videogen",
  resolution: "per_agent_phase",
} as const;
const contract: SkillContract = {
  schema_version: 2,
  name: NAME,
  objective:
    "Prepare exactly pinned Voice models under an explicit operator request and measured shared capacity. No narration or film authority.",
  io: {
    request: {
      schema_version: 1,
      name: "preparation_request",
      direction: "input",
      transport: "inline_request",
      schema_id: VOICE_PREPARATION_REQUEST.schema_id,
      schema_version_required: 1,
      artifact_kind: null,
      source: "caller",
      min_items: 1,
      max_items: 1,
      semantic_product: false,
    },
    input_ports: [],
    active_output_ports: [
      {
        schema_version: 1,
        name: "prepared_models",
        direction: "output",
        transport: "artifact",
        schema_id: VOICE_PREPARATION_RESULT.schema_id,
        schema_version_required: 1,
        artifact_kind: VOICE_PREPARATION_RESULT.artifact_kind,
        source: "skill",
        min_items: 1,
        max_items: 1,
        semantic_product: true,
      },
    ],
  },
  behavior: {
    side_effects: {
      external_reads: "host_policy_only",
      external_mutations: "host_approved_only",
      filesystem_writes: "host_policy_only",
      allowed_relative_paths: [],
    },
    approval: { policy: "existing_host_gates", additional_approval_required: false },
    stopping: {
      budget_exhaustion: "incomplete",
      cancellation: "cancelled",
      blocking_ambiguity: "incomplete",
    },
    escalation: { out_of_scope_effect: "non_positive", sandbox_prevention_claim: false },
    violation_terminal: "incomplete",
  },
  guidance,
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.voice-preparation-budget.v1",
    resolver_id: "voicePreparationLiveness",
    admission_id: "LivenessController.admitInvocation",
    snapshot_id: "LivenessController.snapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [STATE],
    required_visited_states: [STATE],
    required_receipt_predicates: [PREDICATE],
    latest_product: {
      selector: "terminal_artifact",
      schema_id: VOICE_PREPARATION_RESULT.schema_id,
      product_schema_version: 1,
      artifact_kind: VOICE_PREPARATION_RESULT.artifact_kind,
      producing_state: STATE,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};
class PreparationConsumer implements Playbook {
  initialize(c: RunContext) {
    return this.dispatch(c);
  }
  dispatch(c: RunContext): Directive {
    if (c.pendingDirective) return c.pendingDirective;
    const raw = c.selectedArtifacts.find((r) => r.kind === VOICE_PREPARATION_RESULT.artifact_kind);
    const next: Directive = {
      schema_version: 2,
      action: raw ? "complete" : "incomplete",
      identity: c.identity,
      status: raw ? "complete" : "incomplete",
      met: raw !== undefined,
      result: {},
      artifacts: raw ? [raw] : [],
      unresolved: raw ? [] : ["Preparation did not establish verified residency and settlement."],
    };
    c.status = raw ? "complete" : "incomplete";
    c.met = raw !== undefined;
    c.terminalDirective = next;
    c.pendingDirective = null;
    return next;
  }
  resume(c: RunContext) {
    return this.dispatch(c);
  }
  cancel(c: RunContext): Directive {
    return {
      schema_version: 2,
      action: "cancelled",
      identity: c.identity,
      status: "cancelled",
      met: false,
      result: {},
      artifacts: [],
      unresolved: ["Preparation cancelled; inspect retained operation/capacity before any retry."],
    };
  }
  acceptSummary(c: RunContext) {
    return this.dispatch(c);
  }
  rebindPendingDirective(c: RunContext) {
    return c.pendingDirective;
  }
}
export function voicePreparationRegistration(
  backend: string,
  request: VoicePreparationRequest,
  capacity: HostOperationCapacityAuthority
): PlaybookRegistration {
  return {
    name: NAME,
    contract,
    ingress: "dedicated_tool",
    host_states: [STATE],
    worker: {
      kind: "none",
      workflow_name: NAME,
      guidance,
      guidance_required: true,
      result_transport: "host_typed",
      opening_policy: "none",
      model_policy: "none",
      phases: new Map<string, never>(),
    },
    liveness: {
      resolver_id: "voicePreparationLiveness",
      resolve: () => ordinaryLivenessPolicy({ scope: NAME, preset: "standard" }),
      thinking_policy: "agent_ssot",
    },
    host_operations: {
      schema_version: 1,
      max_active_per_run: 1,
      declarations: [voicePreparationDeclaration(backend, request)],
    },
    completionReceiptPredicates: new Map([
      [
        PREDICATE,
        ({ context, checkpointer }) => {
          const calls = checkpointer.hostOperationCallsForRun(context.identity.run_id),
            call = calls[0];
          const held = call ? capacity.inspect(call.operation_record_id) : undefined;
          return {
            passed:
              calls.length === 1 &&
              call?.disposition?.outcome === "completed" &&
              ["settled", "consumed"].includes(call.lifecycle) &&
              held?.state === "settled" &&
              held.snapshot?.kind === "final",
            evidence_refs: [],
          };
        },
      ],
    ]),
    construct: () => new PreparationConsumer(),
  };
}

/** Finite ceilings derive only from this exact admitted request and fixed native sources/tariffs.
 * Internal tariff units are not dollars, invoices or a measured electricity estimate. */
export function voicePreparationDemands(b: VoicePreparationBindings, r: VoicePreparationRequest) {
  const binding = b.policy.bindings.find((x) => x.binding_id === b.capacity_binding_id);
  const meter = b.native.meters.find((x) => x.binding_id === b.capacity_binding_id);
  if (
    !binding ||
    !meter ||
    binding.operation_kind !== "voice_model_preparation" ||
    binding.adapter_id !== VOICE_PREPARATION_ADAPTER ||
    binding.backend_binding_id !== b.backend_binding_id ||
    binding.worker_id !== b.control.worker.worker_id ||
    binding.purpose !== "work" ||
    canonicalJson(meter.process) !== canonicalJson(b.control.worker.process) ||
    canonicalJson(b.observer.process) !== canonicalJson(meter.process) ||
    canonicalJson(b.native.workers.find((x) => x.worker_id === binding.worker_id)) !==
      canonicalJson(b.control.worker)
  )
    throw new Error("voice preparation capacity/process mapping drift");
  if (
    meter.resources.filter((x) => x.sources.includes("gpu_allocation_window")).length !== 1 ||
    meter.resources.filter((x) => x.sources.includes("worker_cpu")).length !== 1
  )
    throw new Error("voice preparation requires exact native GPU allocation and CPU sources");
  return binding.resource_ids.map((resource_id) => {
    const spec = meter.resources.find((x) => x.resource_id === resource_id);
    if (!spec) throw new Error("voice preparation native meter missing");
    const meters = zeroCapacityMeters();
    for (const source of spec.sources) {
      switch (source) {
        case "worker_cpu":
          meters.cpu_milliseconds = r.max_runtime_ms * r.cpu_cores;
          break;
        case "gpu_allocation_window":
          meters.gpu_milliseconds = r.max_runtime_ms;
          break;
        case "private_bytes":
        case "journal_bytes":
          meters.stored_bytes = r.max_output_bytes;
          break;
        case "transfer_bytes":
          meters.egress_bytes = r.max_transfer_bytes;
          break;
        case "journal_events":
          meters.attempts = 1;
          meters.engine_steps = 256;
          break;
      }
    }
    if (
      spec.tariff.numerator !== 1 ||
      spec.tariff.denominator !== 1 ||
      (spec.sources.includes("worker_cpu")
        ? spec.tariff.per !== "cpu_allocation_milliseconds"
        : spec.sources.includes("gpu_allocation_window")
          ? spec.tariff.per !== "gpu_milliseconds"
          : spec.tariff.per !== "cpu_milliseconds")
    )
      throw new Error(
        "voice preparation requires explicit internal 1/unit allocated CPU/GPU tariff"
      );
    meters.cost_microcredits =
      spec.tariff.per === "cpu_allocation_milliseconds"
        ? r.max_runtime_ms * r.cpu_cores
        : meters[spec.tariff.per];
    return { resource_id, slots: spec.sources.includes("worker_cpu") ? r.cpu_cores : 1, meters };
  });
}

/** Existing stores/catalog only. No setup, service restart, model discovery or implicit policy install. */
export async function runVoicePreparationJob(
  bindings: unknown,
  request: unknown,
  signal?: AbortSignal
): Promise<Directive> {
  const b = validateSkillSchema(
      VoicePreparationBindingsSchema,
      bindings,
      "voice preparation bindings"
    ),
    r = validateSkillSchema(VoicePreparationRequestSchema, request, "voice preparation request");
  if (sha256(canonicalJson(b)) !== r.bindings_sha256)
    throw new Error("voice preparation bindings digest drift");
  const cfg = loadRuntimeConfig(b.project_root, { PENNY_STATE_ROOT: b.state_root });
  using store = new ArtifactStore(cfg.artifactRoot, { projectId: cfg.projectId });
  using checkpointer = new Checkpointer(cfg.dbPath, undefined, { projectId: cfg.projectId });
  using leases = new HostOperationLeaseAuthority(cfg.stateRoot);
  const native = new NativeCapacityMeter(b.native, b.policy, b.native.gpu_probe);
  native.registerVoice(b.control, b.backend_binding_id);
  for (const peer of b.comfy_services) {
    if (
      !peer.source_files.some(
        (p) => canonicalJson(p) === canonicalJson(peer.binding.worker.gate_build)
      )
    )
      throw new Error("Comfy admin gate source pin missing");
    native.registerComfy(peer.binding);
  }
  const project = new HostCapacityProjectAuthority(cfg.projectId, checkpointer, store, native);
  using capacity = new HostOperationCapacityAuthority({
    stateRoot: cfg.stateRoot,
    policy: b.policy,
    projects: [project],
  });
  const demands = voicePreparationDemands(b, r);
  const meter = b.native.meters.find((x) => x.binding_id === b.capacity_binding_id);
  if (!meter) throw new Error("voice preparation meter missing");
  const [quotaText, periodText] = readNativeText(`${meter.cpu_cgroup.directory}/cpu.max`, 256)
    .trim()
    .split(/\s+/u);
  const quota = Number(quotaText),
    period = Number(periodText);
  if (
    !Number.isSafeInteger(quota) ||
    !Number.isSafeInteger(period) ||
    quota <= 0 ||
    period <= 0 ||
    quota > r.cpu_cores * period
  )
    throw new Error("voice preparation actual CPU quota exceeds request");
  const allowed = readNativeText(`/proc/${meter.process.pid}/status`, 65536).match(
    /^Cpus_allowed_list:\s*(.+)$/mu
  )?.[1];
  if (!allowed) throw new Error("voice preparation actual CPU affinity unavailable");
  const cores = allowed.split(",").reduce((total, range) => {
    const match = range.trim().match(/^(\d+)(?:-(\d+))?$/u);
    if (!match) throw new Error("voice preparation CPU affinity invalid");
    const first = Number(match[1]),
      last = Number(match[2] ?? match[1]);
    if (last < first || !Number.isSafeInteger(last))
      throw new Error("voice preparation CPU affinity invalid");
    return total + last - first + 1;
  }, 0);
  if (cores > r.cpu_cores || cores < 1)
    throw new Error("voice preparation actual logical CPU affinity exceeds request");
  const effective = readNativeText(
    `${meter.cpu_cgroup.directory}/cpuset.cpus.effective`,
    4096
  ).trim();
  const effectiveCores = effective.split(",").reduce((total, range) => {
    const match = range.match(/^(\d+)(?:-(\d+))?$/u);
    if (!match) throw new Error("voice preparation actual cgroup CPU set unavailable");
    const first = Number(match[1]),
      last = Number(match[2] ?? match[1]);
    if (last < first || !Number.isSafeInteger(last))
      throw new Error("voice preparation actual cgroup CPU set invalid");
    return total + last - first + 1;
  }, 0);
  if (effectiveCores > r.cpu_cores || effectiveCores < 1)
    throw new Error("voice preparation actual cgroup logical CPU set exceeds request");
  for (const pid of new Set([
    ...b.native.workers.map((w) => w.process.pid),
    ...b.native.meters.map((m) => m.process.pid),
  ])) {
    const interfaces = readNativeText(`/proc/${pid}/net/dev`, 65536)
      .split("\n")
      .flatMap((line) => {
        const name = line.match(/^\s*([^:\s]+)\s*:/u)?.[1];
        return name === undefined ? [] : [name];
      });
    if (interfaces.length !== 1 || interfaces[0] !== "lo")
      throw new Error("voice preparation actual network namespace is not loopback-only");
  }
  const capacityRuntime = new HostOperationCapacityRuntimeBinding(capacity, project, {
    requestFor: (input) => ({
      schema_id: "penny.host-capacity-request.v1",
      schema_version: 1,
      project_id: input.project_id,
      operation_record_id: input.operation_record_id,
      binding_id: b.capacity_binding_id,
      demands,
    }),
  });
  const relay = native.voiceRelay(b.control.worker.worker_id);
  const observer = new VoicePreparationObserver(
    b.observer,
    b.backend_binding_id,
    native.managedWorkers(),
    b.comfy_services.flatMap((p) => [...p.source_files, ...p.runtime_files])
  );
  const key = hostCapacityWorkerKey(b.control.worker.worker_id);
  const adapter = new VoicePreparationAdapter(r, key, relay, observer, capacity);
  const registration = voicePreparationRegistration(b.backend_binding_id, r, capacity);
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: cfg.projectRoot,
    maxSteps: cfg.maxSteps,
    maxIterations: cfg.maxIterations,
    receiptAuthority: ReceiptAuthority.loadExisting(cfg.receiptKeyPath),
    artifactStore: store,
    artifactReader: store,
    artifactRevisions: store,
    playbookRegistration: registration,
  });
  const owner = new HostOperationRuntimeOwner({
    projectId: cfg.projectId,
    checkpointer,
    artifacts: store,
    leaseAuthority: leases,
    adapters: new Map([[adapter.adapter_id, adapter]]),
    capacityRuntime,
    useValidator: {
      validateUse: (input) => {
        if (sha256(input.request_bytes) !== sha256(canonicalJson(r)))
          throw new Error("preparation request no longer selected");
      },
    },
  });
  try {
    let c = checkpointer.loadRunById(r.run_id);
    if (c === undefined) {
      const persist = (value: unknown, kind: string, schema: string) =>
        store.persist({
          metadata: {
            schema_version: 2,
            run_id: r.run_id,
            phase: STATE,
            branch_id: null,
            kind,
            operation_id: `${r.operation_id}:${kind}`,
            version: 1,
            producer: "host:voice-preparation",
            media_type: "application/json",
            content_schema: { schema_id: schema, schema_version: 1 },
            parent_ref: null,
            upstream_refs: [],
          },
          content: canonicalJson(value),
        });
      const ref = persist(
        r,
        VOICE_PREPARATION_REQUEST.artifact_kind,
        VOICE_PREPARATION_REQUEST.schema_id
      );
      const pins = persist(b, "voice-preparation-bindings", b.schema_id);
      c = RunContext.create({
        identity: {
          schema_version: 2,
          run_id: r.run_id,
          session_id: `prep-${sha256(r.run_id).slice(0, 32)}`,
          playbook: NAME,
          engine_owner: "typescript",
        },
        goal: r.brief,
        constraints: {},
        projectRoot: cfg.projectRoot,
        trustProfile: "trusted-interactive",
        maxSteps: cfg.maxSteps,
        maxIterations: cfg.maxIterations,
        registrationContractBinding: {
          schema_version: 1,
          registration_name: NAME,
          contract_sha256: skillContractSha256(contract),
          registration_sha256: runtimeRegistrationSha256(registration),
        },
        initialArtifacts: [ref, pins],
      });
      c.transition(STATE);
      const directive: InvokeHostOperationDirectiveV1 = {
        schema_version: 2,
        host_operation_schema_version: 1,
        action: "invoke_host_operation",
        identity: c.identity,
        state_id: STATE,
        attempt: 1,
        operation_id: r.operation_id,
        operation_kind: "voice_model_preparation",
        registration_sha256: runtimeRegistrationSha256(registration),
        request_ref: ref,
        request_sha256: ref.content_digest,
        input_artifacts: { schema_version: 2, artifacts: [] },
        expected_result: VOICE_PREPARATION_RESULT,
        policy_binding: hostOperationPolicyBinding(
          voicePreparationDeclaration(b.backend_binding_id, r),
          key
        ),
      };
      c.pendingDirective = directive;
      checkpointer.createRun(c, "voice_preparation_operator_request", {
        request_sha256: ref.content_digest,
        bindings_sha256: pins.content_digest,
      });
      engine.liveness.bindPolicy(c);
    } else {
      if (
        c.identity.playbook !== NAME ||
        c.goal !== r.brief ||
        !c.selectedArtifacts.some(
          (x) =>
            x.kind === VOICE_PREPARATION_REQUEST.artifact_kind &&
            x.content_digest === sha256(canonicalJson(r))
        ) ||
        !c.selectedArtifacts.some(
          (x) => x.kind === "voice-preparation-bindings" && x.content_digest === r.bindings_sha256
        )
      )
        throw new Error("voice preparation retained run binding conflict");
    }
    const pending = c.pendingDirective ?? c.terminalDirective;
    if (!pending) throw new Error("voice preparation pending directive absent");
    const workers = new WorkerExecutor(
      { runAgent: () => Promise.reject(new Error("management job cannot execute model workers")) },
      store,
      { projectRoot: cfg.projectRoot, parallelConcurrency: 1, registration }
    );
    return await new OrchestrationRunner(engine, workers, undefined, owner).runUntilBoundary(
      pending,
      signal
    );
  } finally {
    native.close();
  }
}
