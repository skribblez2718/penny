import { ArtifactStore } from "../artifact-store.js";
import { canonicalJson } from "../canonical-json.js";
import type { RunContext } from "../context.js";
import {
  validateContract,
  validateDirective,
  type Directive,
  type JsonValue,
  type Confidence,
  type EvaluationResult,
} from "../contracts.js";
import { ordinaryLivenessPolicy } from "../liveness.js";
import { VideogenRuntime } from "../videogen/runtime.js";
import { executionState, saveExecution } from "../videogen/execution-state.js";
import {
  validateVideogenPrivateConfig,
  type VideogenRuntimeProvidersV1,
} from "../videogen/runtime-config.js";
import {
  VIDEOGEN_FLOW,
  VIDEOGEN_HOST_STATES,
  VIDEOGEN_WORKER_PHASES,
  VIDEOGEN_REPAIRS,
} from "../videogen/matrix.js";
import { VIDEOGEN_WORKERS, workerState, validateVideogenWorker } from "../videogen/workers.js";
import { VideoRequestV1Schema, validateVideoRequest } from "../videogen/foundation-contracts.js";
import { VIDEOGEN_COMPLETION_PREDICATES } from "../videogen/completion.js";
import { buildOutputArtifactMetadata } from "./artifact-metadata.js";
import { hostContinuation, type Playbook, type PlaybookStepOutcome } from "./playbook.js";
import type { PlaybookRegistration, StartAdmissionV1 } from "./registry.js";
import { runtimeRegistrationSha256 } from "./runtime-registration-digest.js";
export { VIDEOGEN_FLOW };
export { VIDEOGEN_SKILL_CONTRACT } from "./videogen-contract.js";
import { VIDEOGEN_SKILL_CONTRACT } from "./videogen-contract.js";
export { VIDEOGEN_PLAYBOOK_REGISTRATION } from "./videogen-unconfigured.js";

function missing(): never {
  throw new Error(
    "VIDEOGEN_PRIVATE_CONFIG_MISSING: exact-name videogen is registered but requires caller-supplied enabled private configuration, profile IDs, endpoints and concrete runtime providers; no deployment was activated."
  );
}
function admission(providers?: VideogenRuntimeProvidersV1): StartAdmissionV1 {
  return {
    schema_id: "penny.videogen-request.v1",
    schema_version: 1,
    prepare(request, host) {
      if (providers === undefined) missing();
      const config = validateVideogenPrivateConfig(providers.config);
      if (config.activation !== "enabled")
        throw new Error("VIDEOGEN_DISABLED: private activation is disabled");
      const video = validateVideoRequest(request.constraints, config.limits);
      if (video.brief !== request.goal)
        throw new Error("videogen goal must equal the closed request brief");
      if (video.unresolved.length > 0)
        throw new Error("videogen request contains unresolved admission fields");
      if (
        video.constraints.max_shots > config.envelope.max_shots ||
        video.constraints.max_scenes > config.envelope.max_scenes ||
        video.constraints.max_storage_bytes > config.envelope.max_storage_bytes ||
        video.constraints.max_cost_units > config.envelope.max_cost_units ||
        video.constraints.max_attempts > config.envelope.max_attempts
      )
        throw new Error("videogen request exceeds admitted private envelope");
      if (host.artifactReader === undefined)
        throw new Error("videogen exact artifact reader missing");
      for (const ref of [
        ...config.initial_products.map((x) => x.ref),
        ...(config.brief_context_refs ?? []),
        ...config.rights.map((x) => x.rights_ref),
        config.model_capability_ref,
        ...config.routes.map((x) => x.qualified_profile_snapshot_ref),
      ]) {
        if (canonicalJson(host.artifactReader.refById(ref.artifact_id)) !== canonicalJson(ref))
          throw new Error("videogen configured exact artifact mismatch");
        host.artifactReader.readById(ref.artifact_id);
      }
      return {
        schema_id: "penny.videogen-request.v1",
        schema_version: 1,
        request,
        goal: video.brief,
        constraints: validateContract(VideoRequestV1Schema, video, "videogen request"),
        admission_data: video,
      };
    },
    materialize(prepared, host) {
      if (!(host.artifactStore instanceof ArtifactStore))
        throw new Error("videogen requires concrete actual artifact store");
      const content = canonicalJson(
        validateContract(VideoRequestV1Schema, prepared.admission_data, "videogen request")
      );
      const ref = host.artifactStore.persist({
        metadata: {
          schema_version: 2,
          run_id: host.run_id,
          phase: "admit",
          branch_id: null,
          kind: "videogen-request",
          operation_id: `videogen-request:${host.run_id}`,
          version: 1,
          producer: "host:videogen",
          media_type: "application/json",
          content_schema: { schema_id: "penny.videogen-request.v1", schema_version: 1 },
          parent_ref: null,
          upstream_refs: [],
        },
        content,
      });
      host.artifactStore.select(ref);
      return [ref];
    },
  };
}
export class VideogenPlaybook implements Playbook {
  constructor(
    readonly runtime: VideogenRuntime | undefined,
    readonly registration: () => PlaybookRegistration
  ) {}
  private r(): VideogenRuntime {
    return this.runtime ?? missing();
  }
  initialize(c: RunContext): Directive {
    this.r().initialize(c);
    return this.dispatch(c);
  }
  dispatch(c: RunContext): Directive {
    const r = this.r();
    try {
      r.assertConfig(c);
      for (let transitions = 0; transitions < 64; transitions++) {
        r.afterWorker(c);
        if (["incomplete", "cancelled", "error"].includes(c.stateId))
          return r.terminal(
            c,
            c.stateId === "cancelled" ? "cancelled" : c.stateId === "error" ? "error" : "incomplete"
          );
        if (workerState(c.stateId)) {
          if (r.acceptAuthored(c)) continue;
          const worker = VIDEOGEN_WORKERS[c.stateId],
            inputs = r.bindings(c),
            output = buildOutputArtifactMetadata({
              context: c,
              phase: c.stateId,
              agent: worker.agent,
              branchId: null,
              upstreamRefs: inputs.map((x) => x.ref),
              revisions: r.store,
            });
          const d = validateDirective({
            schema_version: 2,
            action: "invoke_agent",
            identity: c.identity,
            state_id: c.stateId,
            agent: worker.agent,
            attempt: c.stepCount,
            trust_profile: c.trustProfile,
            task: [
              `Execute videogen ${c.stateId}. Return the complete schema-bound product as SUMMARY JSON. Use only the exact supplied input slot names.`,
              `INPUT_SLOTS:${canonicalJson(inputs.map(({ slot, ref }) => ({ slot, artifact_id: ref.artifact_id })))}`,
            ].join("\n"),
            input_artifacts: { schema_version: 2, artifacts: inputs },
            output_artifact: output,
          });
          c.pendingDirective = d;
          return d;
        }
        if (/^g[1-5]$/u.test(c.stateId)) {
          const id = { g1: "G1", g2: "G2", g3: "G3", g4: "G4", g5: "G5" } as const;
          const gate = Object.entries(id).find(([state]) => state === c.stateId)?.[1];
          if (gate === undefined) throw new Error("unknown gate");
          return r.gate(c, gate);
        }
        if (c.stateId === "clarify") return r.gate(c, "clarify");
        const d = r.host(c, runtimeRegistrationSha256(this.registration()));
        if (d !== undefined) return d;
      }
      throw new Error("videogen deterministic transition bound");
    } catch (error) {
      return r.terminal(
        c,
        "incomplete",
        error instanceof Error ? error.message : "videogen host validation failed"
      );
    }
  }
  acceptSummary(
    c: RunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): PlaybookStepOutcome {
    this.r().workerAccepted(c, details);
    return hostContinuation();
  }
  needsHostContinuation(c: RunContext): boolean {
    return executionState(c).pending_worker_state !== undefined;
  }
  continueHost(c: RunContext) {
    return {
      event_type: "videogen_host_continuation",
      payload: { state_id: c.stateId },
      directive: this.dispatch(c),
    };
  }
  resume(c: RunContext, response: JsonValue): Directive {
    this.r().resume(c, response);
    return this.dispatch(c);
  }
  cancel(c: RunContext, reason: string): Directive {
    return this.r().terminal(c, "cancelled", reason);
  }
  rebindPendingDirective(c: RunContext): Directive | null {
    this.r().assertConfig(c);
    return c.pendingDirective ?? this.dispatch(c);
  }
  evaluateRepair(
    _c: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): EvaluationResult | null {
    if (!workerState(state)) return null;
    const value = validateVideogenWorker(state, details);
    if ("contradiction_slots" in value && value.contradiction_slots !== undefined) return null;
    if (
      !("disposition" in value) ||
      value.disposition === "pass" ||
      value.needs_clarification === true
    )
      return null;
    const route = VIDEOGEN_REPAIRS.find((x) => x[0] === state);
    if (route === undefined) return null;
    return {
      schema_version: 2,
      kind: route[1],
      detail: `${state} requires current-product repair`,
      findings: value.violations.length
        ? value.violations
        : ["Required evidence is blocked or needs repair"],
      strategy_delta:
        "Repair the selected product and re-run both current reviews; preserve independent siblings.",
    };
  }
  applyRepairBookkeeping(
    c: RunContext,
    state: string,
    _details: Record<string, JsonValue>,
    evaluation: EvaluationResult
  ): void {
    const route = VIDEOGEN_REPAIRS.find((x) => x[0] === state && x[1] === evaluation.kind);
    if (route === undefined) throw new Error("unregistered repair");
    const s = executionState(c);
    delete s.pending_worker_state;
    s.effect_index = 0;
    saveExecution(c, s);
    // Engine owns the transition. Only descendant gate/product selection is invalidated here.
    const shot = s.shot_ids[s.shot_index];
    if (shot !== undefined && (state.startsWith("draft") || state.startsWith("final"))) {
      const prefix = state.startsWith("draft") ? "draft" : "final";
      s.slots = s.slots.filter((x) => x.slot !== `${prefix}-${shot}`);
      saveExecution(c, s);
    }
  }
  terminalizeRepairExhaustion(c: RunContext): Directive {
    return this.r().terminal(c, "incomplete", "registered repair budget exhausted");
  }
  routingRepair(c: RunContext): Directive {
    c.reissueCurrent();
    return this.dispatch(c);
  }
  terminalizeLiveness(c: RunContext, reason: string): Directive {
    return this.r().terminal(c, "incomplete", reason);
  }
}
export function createVideogenRegistration(
  providers?: VideogenRuntimeProvidersV1
): PlaybookRegistration {
  const registration: PlaybookRegistration = {
    name: "videogen",
    contract: VIDEOGEN_SKILL_CONTRACT,
    ingress: "skill",
    start_admission: admission(providers),
    caller_documentation: {
      constraints_schema: VideoRequestV1Schema,
      example: {
        goal: "Produce a bounded film from caller-approved private profiles.",
        constraints: {},
      },
      semantic_caveat:
        "Hidden exact-name workflow; private activation and concrete providers are mandatory. Fixtures do not qualify production.",
    },
    liveness: {
      resolver_id: "videogenLivenessPolicy",
      resolve: () => ordinaryLivenessPolicy({ scope: "videogen", preset: "standard" }),
      thinking_policy: "agent_ssot",
    },
    worker: {
      kind: "catalog-agent",
      workflow_name: "videogen",
      guidance: VIDEOGEN_SKILL_CONTRACT.guidance,
      guidance_required: true,
      result_transport: "persisted_summary",
      opening_policy: "registration_guidance_task_artifacts",
      model_policy: "directive_override_or_runtime_default",
      phases: VIDEOGEN_WORKER_PHASES,
    },
    host_states: VIDEOGEN_HOST_STATES,
    ...(providers?.information_child === undefined
      ? {}
      : { information_child: providers.information_child }),
    ...(providers?.imagegen_child === undefined
      ? {}
      : { imagegen_child: providers.imagegen_child }),
    completionReceiptPredicates: VIDEOGEN_COMPLETION_PREDICATES,
    ...(providers === undefined || providers.effects.size === 0
      ? {}
      : {
          host_operations: {
            schema_version: 1,
            max_active_per_run: 1,
            declarations: [...providers.effects.values()].map((x) => x.declaration),
          },
        }),
    construct(options) {
      let runtime: VideogenRuntime | undefined;
      if (providers !== undefined) {
        if (!(options.artifactStore instanceof ArtifactStore) || options.checkpointer === undefined)
          throw new Error("videogen concrete store/checkpointer missing");
        const project = providers.project_id;
        runtime = new VideogenRuntime(
          options.artifactStore,
          options.checkpointer,
          project,
          providers
        );
      }
      return new VideogenPlaybook(runtime, () => this);
    },
  };
  return registration;
}
