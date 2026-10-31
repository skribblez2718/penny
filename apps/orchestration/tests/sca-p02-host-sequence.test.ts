import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { Checkpointer } from "../dist/checkpointer.js";
import type {
  ArtifactRef,
  Directive,
  JsonValue,
  OutputArtifactMetadata,
  RunIdentity,
  SkillContract,
} from "../dist/contracts.js";
import { validateDirective } from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { OrchestrationEngine } from "../dist/engine.js";
import {
  hostOperationPolicyBinding,
  type HostOperationAdapterV1,
} from "../dist/host-operations/contracts.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import { HostOperationRuntimeOwner } from "../dist/host-operations/owner.js";
import type {
  HostContinuationCapabilityV1,
  HostContinuationStepV1,
  PlaybookCore,
} from "../dist/playbooks/playbook.js";
import {
  passthroughStartAdmission,
  runtimeRegistrationSha256,
  type PlaybookConstructionOptions,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import { SCA_P02_OPERATION_IDS, type ScaP02OperationKind } from "../dist/sca/p02-contracts.js";
import {
  SCA_P02_CANDIDATE_SKILL_CONTRACT,
  SCA_P02_OPERATION_DECLARATIONS,
} from "../dist/sca/p02-playbook.js";
import { ProjectCatalog } from "../dist/state/catalog.js";
import type { ModelClient } from "../dist/model-client.js";
import { OrchestrationRunner, WorkerExecutor } from "../dist/worker.js";

const roots: string[] = [];
const TEST_PLAYBOOK = "sca-p02-host-sequence-fixture";
const FINAL_STATE = "sca_p02_fixture_final";
const ORDER = Object.freeze([
  "inventory",
  "semgrep_php",
  "semgrep_js_ts",
  "gitleaks",
  "osv_composer",
  "osv_npm",
] as const satisfies readonly ScaP02OperationKind[]);
const STATE = Object.freeze({
  inventory: "sca_p02_fixture_inventory",
  semgrep_php: "sca_p02_fixture_semgrep_php",
  semgrep_js_ts: "sca_p02_fixture_semgrep_js_ts",
  gitleaks: "sca_p02_fixture_gitleaks",
  osv_composer: "sca_p02_fixture_osv_composer",
  osv_npm: "sca_p02_fixture_osv_npm",
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p02-host-sequence-"));
  roots.push(root);
  return root;
}

function identity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: `session-${runId}`,
    playbook: TEST_PLAYBOOK,
    engine_owner: "typescript",
  };
}

const TEST_CONTRACT: SkillContract = {
  ...SCA_P02_CANDIDATE_SKILL_CONTRACT,
  name: TEST_PLAYBOOK,
  io: {
    ...SCA_P02_CANDIDATE_SKILL_CONTRACT.io,
    request: {
      ...SCA_P02_CANDIDATE_SKILL_CONTRACT.io.request,
      schema_id: "penny.test-sca-p02-host-sequence-request.v1",
    },
    input_ports: [],
  },
  completion_gate: {
    ...SCA_P02_CANDIDATE_SKILL_CONTRACT.completion_gate,
    allowed_terminal_origins: [FINAL_STATE],
    required_visited_states: [FINAL_STATE],
    latest_product: {
      selector: "terminal_result",
      schema_id: "penny.test-sca-p02-host-sequence-terminal.v1",
      product_schema_version: 1,
    },
  },
};

function persistRequest(
  store: ArtifactStore,
  context: RunContext,
  kind: ScaP02OperationKind
): ArtifactRef {
  const declaration = SCA_P02_OPERATION_DECLARATIONS[kind];
  const content = canonicalJson({
    schema_id: declaration.request.schema_id,
    schema_version: declaration.request.schema_version_required,
    kind,
  });
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: context.identity.run_id,
    phase: context.stateId,
    branch_id: null,
    kind: declaration.request.artifact_kind,
    operation_id: SCA_P02_OPERATION_IDS[kind],
    version: 1,
    producer: "host:sca-p02-host-sequence-fixture",
    media_type: "application/json",
    content_schema: {
      schema_id: declaration.request.schema_id,
      schema_version: declaration.request.schema_version_required,
    },
    parent_ref: null,
    upstream_refs: [],
  };
  const ref = store.persist({ metadata, content });
  store.select(ref);
  if (!context.selectedArtifacts.some((entry) => entry.artifact_id === ref.artifact_id)) {
    context.selectedArtifacts.push(ref);
  }
  return ref;
}

class SequencePlaybook implements PlaybookCore, HostContinuationCapabilityV1 {
  constructor(private readonly store: ArtifactStore) {}

  initialize(context: RunContext): Directive {
    context.transition(STATE.inventory);
    const directive = validateDirective({
      schema_version: 2,
      action: "status",
      identity: context.identity,
      status: "running",
      state_id: context.stateId,
      terminal: false,
      met: false,
    });
    context.pendingDirective = directive;
    return directive;
  }

  dispatch(context: RunContext): Directive {
    const index = ORDER.findIndex((kind) => STATE[kind] === context.stateId);
    if (index < 0) throw new Error(`fixture cannot dispatch state '${context.stateId}'`);
    const kind = ORDER[index];
    if (kind === undefined) throw new Error("fixture operation order is invalid");
    const resultKind = SCA_P02_OPERATION_DECLARATIONS[kind].result.artifact_kind;
    if (!context.selectedArtifacts.some((ref) => ref.kind === resultKind)) {
      throw new Error(`fixture lacks accepted '${kind}' result`);
    }
    const next = ORDER[index + 1];
    if (next !== undefined) {
      context.transition(STATE[next]);
      return this.issue(context, next);
    }
    context.transition(FINAL_STATE);
    context.status = "incomplete";
    context.met = false;
    const terminal = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: {
        schema_id: "penny.test-sca-p02-host-sequence-terminal.v1",
        schema_version: 1,
        accepted_operations: ORDER.length,
        campaign_terminal: false,
        release_eligible: false,
        model_calls: 0,
      },
      artifacts: context.selectedArtifacts.filter((ref) =>
        ORDER.some(
          (operationKind) =>
            ref.kind === SCA_P02_OPERATION_DECLARATIONS[operationKind].result.artifact_kind
        )
      ),
      unresolved: ["P03 remains outside this deterministic fixture."],
    });
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    return terminal;
  }

  resume(_context: RunContext, _response: JsonValue): Directive {
    throw new Error("fixture has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = "cancelled";
    context.status = "cancelled";
    context.met = false;
    const terminal = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: { campaign_terminal: false, release_eligible: false, model_calls: 0 },
      artifacts: context.selectedArtifacts.filter((ref) =>
        ORDER.some(
          (operationKind) =>
            ref.kind === SCA_P02_OPERATION_DECLARATIONS[operationKind].result.artifact_kind
        )
      ),
      unresolved: [reason],
    });
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    return terminal;
  }

  acceptSummary(): Directive {
    throw new Error("fixture has no worker summaries");
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }

  needsHostContinuation(context: RunContext): boolean {
    return context.stateId === STATE.inventory && context.terminalDirective === null;
  }

  continueHost(context: RunContext): HostContinuationStepV1 {
    return {
      event_type: "sca_p02_fixture_inventory_scheduled",
      payload: { run_id: context.identity.run_id },
      directive: this.issue(context, "inventory"),
      after_checkpoint_fault: "sca_p02_fixture:inventory_scheduled",
    };
  }

  private issue(context: RunContext, kind: ScaP02OperationKind): Directive {
    const declaration = SCA_P02_OPERATION_DECLARATIONS[kind];
    const requestRef = persistRequest(this.store, context, kind);
    const registrationSha256 = context.registrationContractBinding?.registration_sha256;
    if (registrationSha256 === undefined) throw new Error("fixture registration binding is absent");
    const directive = validateDirective({
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: context.identity,
      state_id: context.stateId,
      attempt: context.stepCount,
      operation_id: SCA_P02_OPERATION_IDS[kind],
      operation_kind: declaration.operation_kind,
      registration_sha256: registrationSha256,
      request_ref: requestRef,
      request_sha256: requestRef.content_digest,
      input_artifacts: { schema_version: 2, artifacts: [] },
      expected_result: declaration.result,
      policy_binding: hostOperationPolicyBinding(declaration, requestRef.content_digest),
    });
    context.pendingDirective = directive;
    return directive;
  }
}

function registration(): PlaybookRegistration {
  return {
    name: TEST_PLAYBOOK,
    contract: TEST_CONTRACT,
    ingress: "skill",
    start_admission: passthroughStartAdmission({
      schema_id: TEST_CONTRACT.io.request.schema_id,
      schema_version: TEST_CONTRACT.io.request.schema_version_required,
    }),
    liveness: {
      resolver_id: TEST_CONTRACT.budget_policy.resolver_id,
      resolve: () => undefined,
      thinking_policy: "agent_ssot",
    },
    worker: {
      kind: "none",
      workflow_name: TEST_PLAYBOOK,
      guidance: TEST_CONTRACT.guidance,
      guidance_required: true,
      result_transport: "host_typed",
      opening_policy: "none",
      model_policy: "none",
      phases: new Map<string, never>(),
    },
    host_states: [...Object.values(STATE), FINAL_STATE],
    host_operations: {
      schema_version: 1,
      max_active_per_run: 1,
      declarations: ORDER.map((kind) => SCA_P02_OPERATION_DECLARATIONS[kind]),
    },
    completionReceiptPredicates: new Map(),
    construct(options: PlaybookConstructionOptions) {
      if (!(options.artifactStore instanceof ArtifactStore)) {
        throw new Error("fixture requires ArtifactStore");
      }
      return new SequencePlaybook(options.artifactStore);
    },
  };
}

function adapters(calls: ScaP02OperationKind[]): ReadonlyMap<string, HostOperationAdapterV1> {
  return new Map(
    ORDER.map((kind) => {
      const declaration = SCA_P02_OPERATION_DECLARATIONS[kind];
      const adapter: HostOperationAdapterV1 = {
        adapter_id: declaration.adapter_id,
        inspectRequest: ({ directive, request_bytes }) => ({
          schema_version: 1,
          operation_kind: directive.operation_kind,
          adapter_id: declaration.adapter_id,
          backend_binding_id: declaration.backend_binding_id,
          backend_key_sha256: sha256(request_bytes),
        }),
        run: async (context) => {
          calls.push(kind);
          context.beginSubmission();
          context.recordRemoteAccepted(`fixture-${kind}`);
          const content = canonicalJson({
            schema_id: declaration.result.schema_id,
            schema_version: declaration.result.schema_version_required,
            kind,
          });
          context.recordFetched({
            schema_version: 1,
            content_sha256: sha256(content),
            byte_length: Buffer.byteLength(content, "utf8"),
            item_count: 1,
            poll_count: 0,
          });
          const disposition = {
            outcome: "completed" as const,
            remote_disposition: "proven_terminal" as const,
            lease_disposition: "released" as const,
            retryable: false as const,
            reason_code: null,
          };
          const persisted = context.persist({
            disposition,
            operation_result: {
              contract: declaration.result,
              media_type: "application/json",
              content,
            },
          });
          return {
            disposition,
            operation_result_ref: persisted.operation_result_ref,
            output_artifacts: persisted.output_artifacts,
          };
        },
      };
      return [adapter.adapter_id, adapter] as const;
    })
  );
}

interface Fixture {
  readonly root: string;
  readonly registration: PlaybookRegistration;
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly leases: HostOperationLeaseAuthority;
  readonly engine: OrchestrationEngine;
  readonly owner: HostOperationRuntimeOwner;
  readonly runner: OrchestrationRunner;
  readonly calls: ScaP02OperationKind[];
  readonly modelCalls: { count: number };
}

function fixture(): Fixture {
  const root = temporaryRoot();
  const stateRoot = path.join(root, "state");
  const catalog = new ProjectCatalog(stateRoot, { create: true });
  const project = catalog.registerProject(root);
  catalog.close();
  const checkpointer = Checkpointer.provision(path.join(root, "orchestration.db"), undefined, {
    projectId: project.projectId,
  });
  const artifacts = ArtifactStore.provision(path.join(root, "artifacts"), {
    projectId: project.projectId,
  });
  const activeRegistration = registration();
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: root,
    maxSteps: 20,
    receiptAuthority: ReceiptAuthority.provision(path.join(root, "receipt.key")),
    artifactRevisions: artifacts,
    artifactStore: artifacts,
    artifactReader: artifacts,
    playbookRegistration: activeRegistration,
  });
  const calls: ScaP02OperationKind[] = [];
  const leases = new HostOperationLeaseAuthority(stateRoot);
  const owner = new HostOperationRuntimeOwner({
    projectId: project.projectId,
    checkpointer,
    artifacts,
    leaseAuthority: leases,
    adapters: adapters(calls),
  });
  const modelCalls = { count: 0 };
  const model: ModelClient = {
    async runAgent() {
      modelCalls.count += 1;
      throw new Error("deterministic P02 host sequence must not reach a model client");
    },
  };
  const runner = new OrchestrationRunner(
    engine,
    new WorkerExecutor(model, artifacts, {
      projectRoot: root,
      parallelConcurrency: 1,
      registration: activeRegistration,
    }),
    undefined,
    owner
  );
  return {
    root,
    registration: activeRegistration,
    checkpointer,
    artifacts,
    leases,
    engine,
    owner,
    runner,
    calls,
    modelCalls,
  };
}

function start(input: Fixture, runId: string): Directive {
  return input.engine.handle({
    schema_version: 2,
    action: "start",
    identity: identity(runId),
    goal: "Exercise the deterministic six-operation P02 owner sequence.",
    constraints: {},
    project_root: input.root,
    trust_profile: "hardened-untrusted",
  });
}

function close(input: Fixture): void {
  input.leases.close();
  input.artifacts.close();
  input.checkpointer.close();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SCA P02 deterministic host-owner sequence", () => {
  it("consumes all six operations sequentially, replays exactly, and reaches no model surface", async () => {
    const active = fixture();
    const runId = "p02-host-sequence-complete";
    expect(start(active, runId)).toMatchObject({ action: "status", state_id: STATE.inventory });
    const first = active.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    const terminal = await active.runner.runUntilBoundary(first);
    expect(terminal).toMatchObject({
      action: "incomplete",
      status: "incomplete",
      result: { accepted_operations: 6, campaign_terminal: false, model_calls: 0 },
    });
    expect(active.calls).toEqual(ORDER);
    expect(active.modelCalls.count).toBe(0);
    expect(active.checkpointer.hostOperationCallsForRun(runId)).toHaveLength(6);
    expect(
      active.checkpointer
        .hostOperationCallsForRun(runId)
        .every((record) => record.lifecycle === "consumed")
    ).toBe(true);

    const replay = active.engine.handle({
      schema_version: 2,
      action: "status",
      identity: identity(runId),
    });
    expect(canonicalJson(replay)).toBe(canonicalJson(terminal));
    expect(active.calls).toEqual(ORDER);
    expect(runtimeRegistrationSha256(active.registration)).toBe(
      runtimeRegistrationSha256(active.registration)
    );
    close(active);
  });

  it("cancels before dispatch and after one accepted sibling while preserving exact prior evidence", async () => {
    const before = fixture();
    const beforeRun = "p02-host-sequence-cancel-before";
    start(before, beforeRun);
    const cancelledBefore = before.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: identity(beforeRun),
      reason: "cancel before inventory",
    });
    expect(cancelledBefore).toMatchObject({ action: "cancelled", artifacts: [] });
    expect(before.calls).toEqual([]);
    expect(before.modelCalls.count).toBe(0);
    close(before);

    const after = fixture();
    const afterRun = "p02-host-sequence-cancel-after";
    start(after, afterRun);
    const first = after.engine.handle({
      schema_version: 2,
      action: "recover",
      identity: identity(afterRun),
    });
    if (first.action !== "invoke_host_operation") {
      throw new Error(`expected first host operation, received '${first.action}'`);
    }
    const second = await after.owner.dispatch(after.engine, first);
    expect(second).toMatchObject({ action: "invoke_host_operation", state_id: STATE.semgrep_php });
    const cancelledAfter = after.engine.handle({
      schema_version: 2,
      action: "cancel",
      identity: identity(afterRun),
      reason: "cancel after inventory",
    });
    expect(cancelledAfter).toMatchObject({ action: "cancelled" });
    if (cancelledAfter.action !== "cancelled") throw new Error("expected cancellation");
    expect(cancelledAfter.artifacts).toHaveLength(1);
    expect(cancelledAfter.artifacts[0]?.kind).toBe(
      SCA_P02_OPERATION_DECLARATIONS.inventory.result.artifact_kind
    );
    expect(after.calls).toEqual(["inventory"]);
    expect(after.modelCalls.count).toBe(0);
    close(after);
  });
});
