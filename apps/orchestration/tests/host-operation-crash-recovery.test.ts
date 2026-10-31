import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { Checkpointer } from "../dist/checkpointer.js";
import type { Directive, InvokeHostOperationDirectiveV1, RunIdentity } from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { OrchestrationEngine } from "../dist/engine.js";
import {
  hostOperationLeaseProfileSha256,
  hostOperationPolicyBinding,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
} from "../dist/host-operations/contracts.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import {
  HOST_OPERATION_FAULT_POINTS,
  HostOperationRuntimeOwner,
  HostOperationSimulatedCrashError,
  type HostOperationFaultPointV1,
  type HostOperationUseValidatorV1,
} from "../dist/host-operations/owner.js";
import type { PlaybookStepOutcome, Playbook } from "../dist/playbooks/playbook.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import { ProjectCatalog } from "../dist/state/catalog.js";
import { requireValue } from "./helpers/narrowing.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `penny-host-crash-${label}-`));
  roots.push(root);
  return root;
}

function identity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: `session-${runId}`,
    playbook: "research",
    engine_owner: "typescript",
  };
}

const REQUEST_CONTRACT = {
  schema_version: 1,
  port_name: "request",
  artifact_kind: "host-request",
  schema_id: "penny.host-request.v1",
  schema_version_required: 1,
} as const;

const RESULT_CONTRACT = {
  schema_version: 1,
  port_name: "result",
  artifact_kind: "host-result",
  schema_id: "penny.host-result.v1",
  schema_version_required: 1,
} as const;

function declaration(): HostOperationDeclarationV1 {
  const profileBody = {
    profile_id: "crash-lease-profile",
    profile_version: 1 as const,
    duration_ms: 30_000,
    renew_after_ms: 10_000,
    queue_inactivity_ms: 5_000,
  };
  return {
    schema_version: 1,
    operation_kind: "fixture-operation",
    adapter_id: "fixture-adapter",
    request: REQUEST_CONTRACT,
    result: RESULT_CONTRACT,
    backend_binding_id: "fixture-backend",
    capability_classes: ["artifact_store", "registered_loopback_http"],
    lease_profile: { ...profileBody, profile_sha256: hostOperationLeaseProfileSha256(profileBody) },
    operation_inactivity_ms: 60_000,
    max_request_bytes: 16_384,
    max_output_artifacts: 4,
    max_output_bytes: 65_536,
    max_progress_events: 32,
    max_pre_acceptance_retries: 1,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "local_abort_only_v1",
  };
}

class HostConsumerPlaybook implements Playbook {
  initialize(context: RunContext): Directive {
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    if (context.pendingDirective !== null) return context.pendingDirective;
    const hostReceipt = requireValue(
      [...context.selectedArtifacts]
        .reverse()
        .find((artifact) => artifact.kind === "host-operation-receipt"),
      "fixture host-operation receipt"
    );
    const next: Directive = {
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: context.stateId,
      gate_id: "host-operation-complete",
      challenge: "acknowledge-host-operation",
      payload_digest: hostReceipt.content_digest,
      questions: [{ id: "acknowledge", prompt: "Acknowledge the host-operation result." }],
    };
    context.status = "awaiting_user";
    context.pendingDirective = next;
    return next;
  }

  resume(context: RunContext): Directive {
    return this.dispatch(context);
  }

  cancel(context: RunContext): Directive {
    return this.dispatch(context);
  }

  acceptSummary(context: RunContext): PlaybookStepOutcome {
    return this.dispatch(context);
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
}

function registration(): PlaybookRegistration {
  const base = requireValue(resolvePlaybook("research"), "research registration");
  return {
    ...base,
    host_states: [...(base.host_states ?? []), "host-operation-state"],
    host_operations: {
      schema_version: 1,
      max_active_per_run: 1,
      declarations: [declaration()],
    },
    construct: () => new HostConsumerPlaybook(),
  };
}

interface Fixture {
  readonly root: string;
  readonly projectId: string;
  readonly registration: PlaybookRegistration;
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly engine: OrchestrationEngine;
}

function fixture(label: string): Fixture {
  const root = temporaryRoot(label);
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
  return {
    root,
    projectId: project.projectId,
    registration: activeRegistration,
    checkpointer,
    artifacts,
    engine,
  };
}

function prepareRun(input: Fixture, runId: string): InvokeHostOperationDirectiveV1 {
  const runIdentity = identity(runId);
  const requestRef = input.artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "host-operation-state",
      branch_id: null,
      kind: REQUEST_CONTRACT.artifact_kind,
      operation_id: `host-request:${runId}`,
      version: 1,
      producer: "host:fixture",
      media_type: "application/json",
      content_schema: {
        schema_id: REQUEST_CONTRACT.schema_id,
        schema_version: REQUEST_CONTRACT.schema_version_required,
      },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson({ prompt: "deterministic request" }),
  });
  const activeDeclaration = requireValue(
    input.registration.host_operations?.declarations[0],
    "fixture host-operation declaration"
  );
  const directive: InvokeHostOperationDirectiveV1 = {
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity: runIdentity,
    state_id: "host-operation-state",
    attempt: 1,
    operation_id: `fixture-operation:${runId}`,
    operation_kind: activeDeclaration.operation_kind,
    registration_sha256: runtimeRegistrationSha256(input.registration),
    request_ref: requestRef,
    request_sha256: requestRef.content_digest,
    input_artifacts: { schema_version: 2, artifacts: [] },
    expected_result: RESULT_CONTRACT,
    policy_binding: hostOperationPolicyBinding(activeDeclaration, sha256("fixture-backend-A")),
  };
  const context = RunContext.create({
    identity: runIdentity,
    goal: "exercise the generic host-operation crash seam",
    constraints: {},
    projectRoot: input.root,
    trustProfile: "trusted-interactive",
    maxSteps: 20,
    registrationContractBinding: {
      schema_version: 1,
      registration_name: input.registration.name,
      contract_sha256: skillContractSha256(input.registration.contract),
      registration_sha256: runtimeRegistrationSha256(input.registration),
    },
    initialArtifacts: [requestRef],
  });
  context.transition("host-operation-state");
  context.pendingDirective = directive;
  input.checkpointer.createRun(context, "host_operation_fixture_started", {
    state_id: context.stateId,
  });
  input.engine.liveness.bindPolicy(context);
  return directive;
}

interface SubmissionCounter {
  submissions: number;
}

function crashAdapter(counter: SubmissionCounter): HostOperationAdapterV1 {
  return {
    adapter_id: "fixture-adapter",
    inspectRequest: ({ directive }) => ({
      schema_version: 1,
      operation_kind: directive.operation_kind,
      adapter_id: directive.policy_binding.adapter_id,
      backend_binding_id: directive.policy_binding.backend_binding_id,
      backend_key_sha256: directive.policy_binding.backend_key_sha256,
    }),
    run: async (context) => {
      if (context.journal.remote_correlation_id === null) {
        context.beginSubmission();
        counter.submissions += 1;
        context.recordRemoteAccepted("fixture-crash-correlation");
      }
      const resultContent = canonicalJson({ ok: true, operation: context.directive.operation_id });
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256(resultContent),
        byte_length: Buffer.byteLength(resultContent, "utf8"),
        item_count: 1,
        poll_count: 1,
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
          contract: RESULT_CONTRACT,
          media_type: "application/json",
          content: resultContent,
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

function crashAt(point: HostOperationFaultPointV1): (point: HostOperationFaultPointV1) => void {
  return (candidate) => {
    if (candidate === point) throw new HostOperationSimulatedCrashError(candidate);
  };
}

function owner(
  input: Fixture,
  counter: SubmissionCounter,
  fault?: (p: HostOperationFaultPointV1) => void,
  useValidator?: HostOperationUseValidatorV1
) {
  const leases = new HostOperationLeaseAuthority(path.join(input.root, "state"));
  const runtime = new HostOperationRuntimeOwner({
    projectId: input.projectId,
    checkpointer: input.checkpointer,
    artifacts: input.artifacts,
    leaseAuthority: leases,
    adapters: new Map([["fixture-adapter", crashAdapter(counter)]]),
    ...(fault === undefined ? {} : { fault }),
    ...(useValidator === undefined ? {} : { useValidator }),
  });
  return { leases, runtime };
}

function recordFor(input: Fixture, directive: InvokeHostOperationDirectiveV1) {
  return requireValue(
    input.checkpointer.hostOperationCallForDirective(
      directive.identity.run_id,
      directive.state_id,
      directive.attempt,
      directive.operation_id
    ),
    "fixture host-operation record"
  );
}

describe("host-operation crash seam leaves exact durable recovery boundaries", () => {
  it("exposes only host-owned, non-caller-selectable interruption points", () => {
    expect([...HOST_OPERATION_FAULT_POINTS].sort()).toEqual(
      [
        "capacity_queued",
        "after_capacity_park",
        "after_capacity_reacquire",
        "before_capacity_admit",
        "after_capacity_admit",
        "after_fetch",
        "after_persist",
        "after_raw_plan",
        "after_raw_artifacts",
        "after_receipt",
        "after_wrapper_plan",
        "after_wrapper_persist",
        "after_wrapper",
        "after_consume",
        "after_remote_checkpoint",
        "after_submit_before_remote_checkpoint",
        "before_consume",
        "before_submit",
      ].sort()
    );
  });

  it("crashes before submit with a proven non-acceptance and resubmits on restart", async () => {
    const active = fixture("before-submit");
    const counter: SubmissionCounter = { submissions: 0 };
    const first = owner(active, counter, crashAt("before_submit"));
    const directive = prepareRun(active, "run-crash-before-submit");
    await expect(first.runtime.dispatch(active.engine, directive)).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    expect(recordFor(active, directive).lifecycle).toBe("lease_acquired");
    expect(recordFor(active, directive).remote_correlation_id).toBeNull();
    first.leases.close();

    const second = owner(active, counter);
    await expect(second.runtime.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    expect(counter.submissions).toBe(1);
    expect(recordFor(active, directive)).toMatchObject({
      lifecycle: "consumed",
      disposition: { outcome: "completed", lease_disposition: "released" },
    });
    expect(second.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
      state: "free",
    });
    second.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("crashes in the acceptance-ambiguity window and quarantines without resubmitting", async () => {
    const active = fixture("ambiguous-commit");
    const counter: SubmissionCounter = { submissions: 0 };
    const first = owner(active, counter, crashAt("after_submit_before_remote_checkpoint"));
    const directive = prepareRun(active, "run-crash-ambiguous");
    await expect(first.runtime.dispatch(active.engine, directive)).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    expect(recordFor(active, directive).lifecycle).toBe("submitting");
    expect(recordFor(active, directive).remote_correlation_id).toBeNull();
    first.leases.close();

    const second = owner(active, counter);
    await expect(second.runtime.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    expect(counter.submissions).toBe(1);
    expect(recordFor(active, directive)).toMatchObject({
      lifecycle: "consumed",
      disposition: { outcome: "remote_unknown", lease_disposition: "quarantined" },
    });
    expect(second.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
      state: "quarantined",
    });
    second.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  const cases: readonly (readonly [HostOperationFaultPointV1, string])[] = [
    ["after_remote_checkpoint", "submitted"],
    ["after_fetch", "fetched"],
    ["after_persist", "verified"],
    ["before_consume", "settled"],
  ];
  it.each(cases)(
    "crashes at '%s' and adopts/consumes the exact operation without a new submission",
    async (point, lifecycle) => {
      const active = fixture(point);
      const counter: SubmissionCounter = { submissions: 0 };
      const first = owner(active, counter, crashAt(point));
      const directive = prepareRun(active, `run-crash-${point}`);
      await expect(first.runtime.dispatch(active.engine, directive)).rejects.toBeInstanceOf(
        HostOperationSimulatedCrashError
      );
      expect(recordFor(active, directive).lifecycle).toBe(lifecycle);
      const priorCorrelation = recordFor(active, directive).remote_correlation_sha256;
      first.leases.close();

      const second = owner(active, counter);
      await expect(second.runtime.dispatch(active.engine, directive)).resolves.toMatchObject({
        action: "await_user",
      });
      expect(counter.submissions).toBe(1);
      const adopted = recordFor(active, directive);
      expect(adopted).toMatchObject({
        lifecycle: "consumed",
        disposition: { outcome: "completed", lease_disposition: "released" },
      });
      expect(adopted.remote_correlation_sha256).toBe(priorCorrelation);
      expect(second.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
        state: "free",
      });
      second.leases.close();
      active.artifacts.close();
      active.checkpointer.close();
    }
  );

  it("revalidates use before consumed replay and refuses stale authority without resubmission", async () => {
    const active = fixture("use-validator-consumed");
    const counter: SubmissionCounter = { submissions: 0 };
    const directive = prepareRun(active, "run-use-validator-consumed");
    let validations = 0;
    const first = owner(active, counter, undefined, {
      validateUse() {
        validations += 1;
      },
    });
    await expect(first.runtime.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    expect(recordFor(active, directive).lifecycle).toBe("consumed");
    expect(validations).toBe(1);
    expect(counter.submissions).toBe(1);
    first.leases.close();

    const second = owner(active, counter, undefined, {
      validateUse() {
        validations += 1;
        throw new Error("fixture_use_authority_stale");
      },
    });
    await expect(second.runtime.dispatch(active.engine, directive)).rejects.toThrow(
      "fixture_use_authority_stale"
    );
    expect(validations).toBe(2);
    expect(counter.submissions).toBe(1);
    expect(recordFor(active, directive).lifecycle).toBe("consumed");
    second.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("cancels authority replay before any journal or adapter effect", async () => {
    const active = fixture("use-validator-cancelled");
    const counter: SubmissionCounter = { submissions: 0 };
    const directive = prepareRun(active, "run-use-validator-cancelled");
    const controller = new AbortController();
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const current = owner(active, counter, undefined, {
      async validateUse(input) {
        observedSignal = input.signal;
        input.reportWorkMilestone();
        entered?.();
        await new Promise<void>((resolve) =>
          input.signal.addEventListener("abort", () => resolve(), { once: true })
        );
      },
    });
    const dispatched = current.runtime.dispatch(active.engine, directive, controller.signal);
    await started;
    controller.abort(new Error("fixture authority cancellation"));

    await expect(dispatched).rejects.toThrow("fixture authority cancellation");
    expect(observedSignal?.aborted).toBe(true);
    expect(counter.submissions).toBe(0);
    expect(
      active.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      )
    ).toBeUndefined();
    current.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("cannot terminalize a crash and never exposes the seam through a directive", () => {
    const active = fixture("seam-surface");
    const directive = prepareRun(active, "run-seam-surface");
    // The seam is a construction-time capability: it is not a directive, registration, request,
    // or artifact field, so no caller, model, or request can name a crash point.
    expect(Object.keys(directive)).not.toContain("fault");
    expect(Object.keys(directive)).not.toContain("crash");
    expect(canonicalJson(directive)).not.toContain("fault");
    active.artifacts.close();
    active.checkpointer.close();
  });
});
