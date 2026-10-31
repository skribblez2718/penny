import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { Checkpointer } from "../dist/checkpointer.js";
import type {
  ArtifactRef,
  Directive,
  InvokeHostOperationDirectiveV1,
  JsonValue,
  RunIdentity,
} from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { OrchestrationEngine } from "../dist/engine.js";
import {
  hostOperationLeaseProfileSha256,
  hostOperationPolicyBinding,
  hostOperationResultIsSelected,
  validateHostOperationCallRecord,
  validateHostOperationDeclaration,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
} from "../dist/host-operations/contracts.js";
import {
  HostOperationLeaseAuthority,
  type HostOperationLeaseRequestV1,
} from "../dist/host-operations/lease-authority.js";
import {
  HostOperationRuntimeOwner,
  HostOperationStateOwner,
} from "../dist/host-operations/owner.js";
import { createPreparedHostOperationCallRecord } from "../dist/host-operations/storage.js";
import type { PlaybookStepOutcome, Playbook } from "../dist/playbooks/playbook.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  skillContractSha256,
  validateRegistrationContract,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import { ProjectCatalog } from "../dist/state/catalog.js";
import type { ModelClient } from "../dist/model-client.js";
import {
  assertWorkerExecutableDirective,
  OrchestrationRunner,
  WorkerExecutor,
} from "../dist/worker.js";
import { requireValue } from "./helpers/narrowing.js";

const roots: string[] = [];

function temporaryRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `penny-host-operations-${label}-`));
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

function declaration(
  limits: {
    readonly duration_ms?: number;
    readonly renew_after_ms?: number;
    readonly queue_inactivity_ms?: number;
    readonly operation_inactivity_ms?: number;
  } = {}
): HostOperationDeclarationV1 {
  const profileBody = {
    profile_id: "test-lease-profile",
    profile_version: 1 as const,
    duration_ms: limits.duration_ms ?? 30_000,
    renew_after_ms: limits.renew_after_ms ?? 10_000,
    queue_inactivity_ms: limits.queue_inactivity_ms ?? 5_000,
  };
  return {
    schema_version: 1,
    operation_kind: "fixture-operation",
    adapter_id: "fixture-adapter",
    request: REQUEST_CONTRACT,
    result: RESULT_CONTRACT,
    backend_binding_id: "fixture-backend",
    capability_classes: ["artifact_store", "registered_loopback_http"],
    lease_profile: {
      ...profileBody,
      profile_sha256: hostOperationLeaseProfileSha256(profileBody),
    },
    operation_inactivity_ms: limits.operation_inactivity_ms ?? 60_000,
    max_request_bytes: 16_384,
    max_output_artifacts: 4,
    max_output_bytes: 65_536,
    max_progress_events: 32,
    max_pre_acceptance_retries: 1,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "registered_remote_cancel_then_observe_v1",
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

  resume(context: RunContext, _response: JsonValue): Directive {
    return this.dispatch(context);
  }

  cancel(context: RunContext, _reason: string): Directive {
    return this.dispatch(context);
  }

  acceptSummary(context: RunContext, _details: Record<string, JsonValue>): PlaybookStepOutcome {
    return this.dispatch(context);
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
}

function registration(
  activeDeclaration: HostOperationDeclarationV1 = declaration()
): PlaybookRegistration {
  const base = requireValue(resolvePlaybook("research"), "research registration");
  return {
    ...base,
    host_states: [...(base.host_states ?? []), "host-operation-state"],
    host_operations: {
      schema_version: 1,
      max_active_per_run: 1,
      declarations: [activeDeclaration],
    },
    construct: () => new HostConsumerPlaybook(),
  };
}

interface Fixture {
  readonly root: string;
  readonly projectId: string;
  readonly secondProjectId: string;
  readonly registration: PlaybookRegistration;
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly leases: HostOperationLeaseAuthority;
  readonly engine: OrchestrationEngine;
}

function fixture(
  label: string,
  activeDeclaration: HostOperationDeclarationV1 = declaration()
): Fixture {
  const root = temporaryRoot(label);
  const stateRoot = path.join(root, "state");
  const catalog = new ProjectCatalog(stateRoot, { create: true });
  const project = catalog.registerProject(root);
  const secondProjectRoot = path.join(root, "second-project");
  mkdirSync(secondProjectRoot);
  const secondProject = catalog.registerProject(secondProjectRoot);
  catalog.close();
  const checkpointer = Checkpointer.provision(path.join(root, "orchestration.db"), undefined, {
    projectId: project.projectId,
  });
  const artifacts = ArtifactStore.provision(path.join(root, "artifacts"), {
    projectId: project.projectId,
  });
  const activeRegistration = registration(activeDeclaration);
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
    secondProjectId: secondProject.projectId,
    registration: activeRegistration,
    checkpointer,
    artifacts,
    leases: new HostOperationLeaseAuthority(stateRoot),
    engine,
  };
}

function prepareRun(
  input: Fixture,
  runId: string,
  exactInputs: readonly { readonly slot: string; readonly ref: ArtifactRef }[] = []
): InvokeHostOperationDirectiveV1 {
  const runIdentity = identity(runId);
  const requestContent = canonicalJson({ prompt: "deterministic request" });
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
    content: requestContent,
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
    input_artifacts: { schema_version: 2, artifacts: [...exactInputs] },
    expected_result: RESULT_CONTRACT,
    policy_binding: hostOperationPolicyBinding(activeDeclaration, sha256("fixture-backend-A")),
  };
  const context = RunContext.create({
    identity: runIdentity,
    goal: "exercise the generic host-operation runtime",
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
    initialArtifacts: [requestRef, ...exactInputs.map((binding) => binding.ref)],
  });
  context.transition("host-operation-state");
  context.pendingDirective = directive;
  input.checkpointer.createRun(context, "host_operation_fixture_started", {
    state_id: context.stateId,
  });
  input.engine.liveness.bindPolicy(context);
  return directive;
}

function successfulAdapter(calls: { count: number }): HostOperationAdapterV1 {
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
      calls.count += 1;
      context.beginSubmission();
      context.recordRemoteAccepted("fixture-remote-correlation-1");
      const resultContent = canonicalJson({ ok: true, operation: context.directive.operation_id });
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256(resultContent),
        byte_length: Buffer.byteLength(resultContent, "utf8"),
        item_count: 1,
        poll_count: 2,
      });
      context.emitProgress({
        progress_class: "adapter_progress",
        completed_units: 1,
        total_units: 1,
        detail_code: "fixture-complete",
      });
      const persisted = context.persist({
        disposition: {
          outcome: "completed",
          remote_disposition: "proven_terminal",
          lease_disposition: "released",
          retryable: false,
          reason_code: null,
        },
        operation_result: {
          contract: RESULT_CONTRACT,
          media_type: "application/json",
          content: resultContent,
        },
      });
      return {
        disposition: {
          outcome: "completed",
          remote_disposition: "proven_terminal",
          lease_disposition: "released",
          retryable: false,
          reason_code: null,
        },
        operation_result_ref: persisted.operation_result_ref,
        output_artifacts: persisted.output_artifacts,
      };
    },
  };
}

function leaseRequest(input: {
  readonly operationDigit: string;
  readonly backendKeySha256: string;
  readonly projectId: string;
}): HostOperationLeaseRequestV1 {
  return {
    operation_record_id: `hop_${input.operationDigit.repeat(64)}`,
    backend_key_sha256: input.backendKeySha256,
    project_id: input.projectId,
    run_id: `run-lease-${input.operationDigit}`,
    state_id: "host-operation-state",
    attempt: 1,
    operation_id: `operation-${input.operationDigit}`,
    registration_sha256: "a".repeat(64),
    request_sha256: input.operationDigit.repeat(64),
    duration_ms: 100,
    queue_inactivity_expires_at_ms: 10_000,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Drive exactly one registered host operation to its terminal through the real owner. */
async function driveOneOperation(
  active: Fixture,
  calls: { count: number },
  runId: string
): Promise<InvokeHostOperationDirectiveV1> {
  const owner = new HostOperationRuntimeOwner({
    projectId: active.projectId,
    checkpointer: active.checkpointer,
    artifacts: active.artifacts,
    leaseAuthority: active.leases,
    adapters: new Map([["fixture-adapter", successfulAdapter(calls)]]),
  });
  const directive = prepareRun(active, runId);
  const noWorkerClient: ModelClient = {
    runAgent: async () => {
      throw new Error("host-operation directives must not reach a model worker");
    },
  };
  const runner = new OrchestrationRunner(
    active.engine,
    new WorkerExecutor(noWorkerClient, active.artifacts, {
      projectRoot: active.root,
      parallelConcurrency: 1,
      registration: active.registration,
    }),
    undefined,
    owner
  );
  const next = await runner.runUntilBoundary(directive);
  expect(next).toMatchObject({ action: "await_user", state_id: "host-operation-state" });
  return directive;
}

describe("generic registered asynchronous host-operation owner", () => {
  it("rejects duplicate operation kinds and a drifted lease-profile digest", () => {
    const active = registration();
    expect(() =>
      validateRegistrationContract({
        ...active,
        host_operations: {
          schema_version: 1,
          max_active_per_run: 1,
          declarations: [declaration(), declaration()],
        },
      })
    ).toThrow(/operation kinds/u);
    const current = declaration();
    expect(() =>
      validateRegistrationContract({
        ...active,
        host_operations: {
          schema_version: 1,
          max_active_per_run: 1,
          declarations: [
            {
              ...current,
              lease_profile: {
                ...current.lease_profile,
                profile_sha256: "f".repeat(64),
              },
            },
          ],
        },
      })
    ).toThrow(/lease profile digest diverges/u);
  });

  it("persists, verifies, settles, consumes, and replays one exact registered operation", async () => {
    const active = fixture("completed");
    const calls = { count: 0 };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([["fixture-adapter", successfulAdapter(calls)]]),
    });
    const directive = prepareRun(active, "run-host-operation-completed");
    const noWorkerClient: ModelClient = {
      runAgent: async () => {
        throw new Error("host-operation directives must not reach a model worker");
      },
    };
    const runner = new OrchestrationRunner(
      active.engine,
      new WorkerExecutor(noWorkerClient, active.artifacts, {
        projectRoot: active.root,
        parallelConcurrency: 1,
        registration: active.registration,
      }),
      undefined,
      owner
    );
    const progress: string[] = [];

    const next = await runner.runUntilBoundary(directive, undefined, (event) => {
      progress.push(event.event);
    });
    expect(next).toMatchObject({ action: "await_user", state_id: "host-operation-state" });
    const record = requireValue(
      active.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      ),
      "consumed host-operation record"
    );
    expect(record).toMatchObject({
      lifecycle: "consumed",
      disposition: {
        outcome: "completed",
        remote_disposition: "proven_terminal",
        lease_disposition: "released",
      },
      progress_event_count: 5,
    });
    expect(record.operation_result_ref?.kind).toBe("host-result");
    expect(record.platform_result_ref?.kind).toBe("host-operation-result");
    expect(record.host_receipt_ref?.kind).toBe("host-operation-receipt");
    expect(calls.count).toBe(1);
    expect(progress).toContain("host_operation_progress");
    expect(active.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
      state: "free",
    });

    const replay = await owner.dispatch(active.engine, directive);
    expect(replay.action).toBe("status");
    expect(calls.count).toBe(1);

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("preserves default result-artifact selection and honors an unselected opt-out", async () => {
    // Default declaration (no policy): the historical single-selection behavior is preserved.
    const defaultActive = fixture("default-result-selection");
    const defaultCalls = { count: 0 };
    const defaultDirective = await driveOneOperation(
      defaultActive,
      defaultCalls,
      "run-selection-default"
    );
    expect(
      defaultActive.artifacts.selected(
        defaultDirective.identity.run_id,
        defaultDirective.state_id,
        null,
        RESULT_CONTRACT.artifact_kind
      )
    ).toBeDefined();
    expect(
      defaultActive.artifacts.selected(
        defaultDirective.identity.run_id,
        defaultDirective.state_id,
        null,
        "host-operation-result"
      )
    ).toBeDefined();
    expect(
      defaultActive.artifacts.selected(
        defaultDirective.identity.run_id,
        defaultDirective.state_id,
        null,
        "host-operation-receipt"
      )
    ).toBeDefined();
    defaultActive.leases.close();
    defaultActive.artifacts.close();
    defaultActive.checkpointer.close();

    // Opt-out declaration: every owner result artifact persists durably but is left unselected.
    const optOutDeclaration: HostOperationDeclarationV1 = {
      ...declaration(),
      result_selection_policy: "unselected",
    };
    const optOutActive = fixture("unselected-result-selection", optOutDeclaration);
    const optOutCalls = { count: 0 };
    const optOutDirective = await driveOneOperation(
      optOutActive,
      optOutCalls,
      "run-selection-unselected"
    );
    const record = requireValue(
      optOutActive.checkpointer.hostOperationCallForDirective(
        optOutDirective.identity.run_id,
        optOutDirective.state_id,
        optOutDirective.attempt,
        optOutDirective.operation_id
      ),
      "unselected host-operation record"
    );
    expect(record.lifecycle).toBe("consumed");
    expect(record.operation_result_ref).not.toBeNull();
    expect(record.platform_result_ref).not.toBeNull();
    expect(record.host_receipt_ref).not.toBeNull();
    for (const kind of [
      RESULT_CONTRACT.artifact_kind,
      "host-operation-result",
      "host-operation-receipt",
    ]) {
      expect(
        optOutActive.artifacts.selected(
          optOutDirective.identity.run_id,
          optOutDirective.state_id,
          null,
          kind
        )
      ).toBeUndefined();
    }
    // The exact artifacts remain durably readable even though they were never selected.
    const resultRef = requireValue(record.operation_result_ref, "unselected result ref");
    expect(optOutActive.artifacts.readById(resultRef.artifact_id).byteLength).toBe(
      resultRef.byte_length
    );
    optOutActive.leases.close();
    optOutActive.artifacts.close();
    optOutActive.checkpointer.close();
  });

  it("validates the optional result-selection policy without changing the absent default", () => {
    const validated = validateHostOperationDeclaration(declaration());
    expect(validated.result_selection_policy).toBeUndefined();
    expect(hostOperationResultIsSelected(validated)).toBe(true);
    expect(
      hostOperationResultIsSelected({ ...validated, result_selection_policy: "selected" })
    ).toBe(true);
    expect(
      hostOperationResultIsSelected({ ...validated, result_selection_policy: "unselected" })
    ).toBe(false);
    expect(() =>
      validateHostOperationDeclaration({ ...declaration(), result_selection_policy: "sometimes" })
    ).toThrow();
    // The absent policy changes no canonical declaration digest for existing operations.
    expect(validateHostOperationDeclaration(declaration())).toEqual(validated);
  });

  it("renews host-operation inactivity while productive work exceeds the former duration", async () => {
    const activeDeclaration = declaration({
      queue_inactivity_ms: 100,
      operation_inactivity_ms: 200,
    });
    const active = fixture("productive-renewal", activeDeclaration);
    const calls = { count: 0 };
    const terminalAdapter = successfulAdapter(calls);
    const adapter: HostOperationAdapterV1 = {
      ...terminalAdapter,
      run: async (context) => {
        for (let index = 0; index < 4; index += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 80));
          context.reportActivity("fixture_productive_unit", 1);
        }
        return terminalAdapter.run(context);
      },
    };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
    });
    const directive = prepareRun(active, "run-host-operation-productive-renewal");

    await expect(owner.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    expect(calls.count).toBe(1);
    expect(
      active.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      )
    ).toMatchObject({ lifecycle: "consumed", disposition: { outcome: "completed" } });

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("gives adapters only exact bounded directive inputs by slot", async () => {
    const activeDeclaration = {
      ...declaration(),
      max_input_artifacts: 1,
      max_input_bytes: 64,
    };
    const active = fixture("exact-input-read", activeDeclaration);
    const runId = "run-host-operation-exact-input";
    const inputBytes = Buffer.from("exact bounded input");
    const inputRef = active.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: runId,
        phase: "host-operation-state",
        branch_id: null,
        kind: "host-input",
        operation_id: "host-input",
        version: 1,
        producer: "host:fixture",
        media_type: "application/octet-stream",
        content_schema: { schema_id: "penny.host-input.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: inputBytes,
    });
    const calls = { count: 0 };
    const base = successfulAdapter(calls);
    const adapter: HostOperationAdapterV1 = {
      ...base,
      run: async (context) => {
        const readsBefore = reads.mock.calls.length;
        expect(Buffer.from(context.readInput("payload").bytes)).toEqual(inputBytes);
        expect(() => context.readInput("not-bound")).toThrow("not bound");
        expect(reads).toHaveBeenCalledTimes(readsBefore);
        return base.run(context);
      },
    };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
    });
    const directive = prepareRun(active, runId, [{ slot: "payload", ref: inputRef }]);
    const reads = vi.spyOn(active.artifacts, "readById");

    await expect(owner.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    expect(calls.count).toBe(1);

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("refuses directive input bytes above the registered ceiling before adapter execution", async () => {
    const activeDeclaration = {
      ...declaration(),
      max_input_artifacts: 1,
      max_input_bytes: 4,
    };
    const active = fixture("exact-input-overflow", activeDeclaration);
    const runId = "run-host-operation-input-overflow";
    const inputRef = active.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: runId,
        phase: "host-operation-state",
        branch_id: null,
        kind: "host-input",
        operation_id: "host-input",
        version: 1,
        producer: "host:fixture",
        media_type: "application/octet-stream",
        content_schema: { schema_id: "penny.host-input.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: "five!",
    });
    const calls = { count: 0 };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([["fixture-adapter", successfulAdapter(calls)]]),
    });
    const directive = prepareRun(active, runId, [{ slot: "payload", ref: inputRef }]);
    const reads = vi.spyOn(active.artifacts, "readById");

    await expect(owner.dispatch(active.engine, directive)).rejects.toThrow(
      "input artifacts exceed registration"
    );
    expect(reads).not.toHaveBeenCalled();
    expect(calls.count).toBe(0);

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("rejects adapter output artifacts that are absent from the declaration", async () => {
    const active = fixture("unregistered-output");
    const adapter: HostOperationAdapterV1 = {
      adapter_id: "fixture-adapter",
      inspectRequest: ({ directive }) => ({
        schema_version: 1,
        operation_kind: directive.operation_kind,
        adapter_id: directive.policy_binding.adapter_id,
        backend_binding_id: directive.policy_binding.backend_binding_id,
        backend_key_sha256: directive.policy_binding.backend_key_sha256,
      }),
      run: async (context) => {
        context.beginSubmission();
        context.recordRemoteAccepted("fixture-output-contract");
        context.recordFetched({
          schema_version: 1,
          content_sha256: sha256("output"),
          byte_length: 6,
          item_count: 1,
          poll_count: 1,
        });
        context.persist({
          disposition: {
            outcome: "completed",
            remote_disposition: "proven_terminal",
            lease_disposition: "released",
            retryable: false,
            reason_code: null,
          },
          operation_result: {
            contract: RESULT_CONTRACT,
            media_type: "application/json",
            content: canonicalJson({ ok: true }),
          },
          outputs: [
            {
              contract: {
                schema_version: 1,
                port_name: "undeclared",
                artifact_kind: "undeclared-output",
                schema_id: "penny.undeclared-output.v1",
                schema_version_required: 1,
              },
              media_type: "application/octet-stream",
              content: "output",
            },
          ],
        });
        throw new Error("unreachable after unregistered output");
      },
    };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
    });
    const directive = prepareRun(active, "run-host-operation-unregistered-output");

    await expect(owner.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    const record = requireValue(
      active.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      ),
      "unregistered-output operation record"
    );
    expect(record.disposition).toMatchObject({
      outcome: "failed",
      remote_disposition: "proven_terminal",
      reason_code: "post_fetch_persistence_failed",
    });
    expect(record.output_artifacts).toEqual([]);

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("refuses stale registration and changed-request replay before a second adapter effect", async () => {
    const active = fixture("binding-conflict");
    const calls = { count: 0 };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([["fixture-adapter", successfulAdapter(calls)]]),
    });
    const directive = prepareRun(active, "run-host-operation-binding-conflict");

    await expect(
      owner.dispatch(active.engine, {
        ...directive,
        registration_sha256: "f".repeat(64),
      })
    ).rejects.toThrow(/registration digest is stale/u);
    expect(active.checkpointer.hostOperationCallsForRun(directive.identity.run_id)).toEqual([]);

    await expect(owner.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    expect(calls.count).toBe(1);
    const changedContent = canonicalJson({ prompt: "changed request" });
    const changedRef = active.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: directive.identity.run_id,
        phase: directive.state_id,
        branch_id: null,
        kind: REQUEST_CONTRACT.artifact_kind,
        operation_id: `host-request:${directive.identity.run_id}:changed`,
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
      content: changedContent,
    });

    await expect(
      owner.dispatch(active.engine, {
        ...directive,
        request_ref: changedRef,
        request_sha256: changedRef.content_digest,
      })
    ).rejects.toThrow(/immutable operands|identity conflicts|logical directive/u);
    expect(calls.count).toBe(1);

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("refuses a pending operation with a stable terminal when no runtime owner is installed", async () => {
    const active = fixture("missing-owner");
    const directive = prepareRun(active, "run-host-operation-missing-owner");

    expect(
      active.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: directive.identity,
      })
    ).toEqual(directive);
    expect(active.checkpointer.hostOperationCallsForRun(directive.identity.run_id)).toEqual([]);
    expect(() => assertWorkerExecutableDirective(directive)).toThrow(/not executable by a worker/u);
    const noWorkerClient: ModelClient = {
      runAgent: async () => {
        throw new Error("host-operation directives must not reach a model worker");
      },
    };
    const runner = new OrchestrationRunner(
      active.engine,
      new WorkerExecutor(noWorkerClient, active.artifacts, {
        projectRoot: active.root,
        parallelConcurrency: 1,
        registration: active.registration,
      })
    );
    await expect(runner.runUntilBoundary(directive)).resolves.toMatchObject({
      action: "error",
      status: "error",
      result: { code: "HOST_OPERATION_OWNER_UNAVAILABLE" },
    });
    expect(active.checkpointer.hostOperationCallsForRun(directive.identity.run_id)).toEqual([]);

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("turns an unregistered runtime adapter into a durable no-effect failure", async () => {
    const active = fixture("missing-adapter");
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map(),
    });
    const directive = prepareRun(active, "run-host-operation-missing-adapter");

    await expect(owner.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    const record = requireValue(
      active.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      ),
      "failed host-operation record"
    );
    expect(record).toMatchObject({
      lifecycle: "consumed",
      lease: null,
      disposition: {
        outcome: "failed",
        remote_disposition: "none",
        lease_disposition: "released",
        retryable: false,
        reason_code: "adapter_unavailable",
      },
    });

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it.each(["default", "explicit"])(
    "settles an already-aborted unsubmitted action without adapter entry (%s reason)",
    async (reason) => {
      const active = fixture(`already-aborted-${reason}`);
      const calls = { count: 0 };
      const adapter = successfulAdapter(calls);
      const inspect = vi.spyOn(adapter, "inspectRequest");
      const run = vi.spyOn(adapter, "run");
      const acquire = vi.spyOn(active.leases, "tryAcquire");
      const owner = new HostOperationRuntimeOwner({
        projectId: active.projectId,
        checkpointer: active.checkpointer,
        artifacts: active.artifacts,
        leaseAuthority: active.leases,
        adapters: new Map([[adapter.adapter_id, adapter]]),
      });
      const directive = prepareRun(active, `run-already-aborted-${reason}`);
      const controller = new AbortController();
      if (reason === "default") controller.abort();
      else controller.abort(new Error("fixture caller cancellation"));

      await expect(
        owner.dispatch(active.engine, directive, controller.signal)
      ).resolves.toMatchObject({
        action: "await_user",
      });
      const record = requireValue(
        active.checkpointer.hostOperationCallForDirective(
          directive.identity.run_id,
          directive.state_id,
          directive.attempt,
          directive.operation_id
        ),
        "already-aborted host-operation record"
      );
      const disposition = {
        outcome: "cancelled",
        remote_disposition: "none",
        lease_disposition: "released",
        retryable: false,
      };
      expect(record).toMatchObject({
        lifecycle: "consumed",
        lease: null,
        remote_correlation_id: null,
        operation_result_ref: null,
        output_artifacts: [],
        progress_event_count: 0,
        disposition,
      });
      for (const ref of [record.platform_result_ref, record.host_receipt_ref]) {
        const exact = requireValue(ref, "canonical cancellation evidence");
        const value: unknown = JSON.parse(
          active.artifacts.readById(exact.artifact_id).toString("utf8")
        );
        expect(value).toMatchObject({ disposition });
      }
      await expect(owner.dispatch(active.engine, directive)).resolves.toMatchObject({
        action: "status",
      });
      expect(inspect).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(calls.count).toBe(0);
      expect(active.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
        state: "absent",
      });
      active.leases.close();
      active.artifacts.close();
      active.checkpointer.close();
    }
  );

  it.each(["duplicate slots", "input count", "input bytes", "ref-only authority"])(
    "refuses already-aborted %s before any read or journal effect",
    async (refusal) => {
      const active = fixture(`aborted-preflight-${refusal.replaceAll(" ", "-")}`, {
        ...declaration(),
        max_input_artifacts: 1,
        max_input_bytes: 64,
      });
      const calls = { count: 0 };
      const adapter = successfulAdapter(calls);
      const inspect = vi.spyOn(adapter, "inspectRequest");
      const preflight = vi.fn(() => {
        if (refusal === "ref-only authority") throw new Error("unapproved refs");
      });
      const validateUse = vi.fn(() => {
        throw new Error("unexpected use validation");
      });
      const owner = new HostOperationRuntimeOwner({
        projectId: active.projectId,
        checkpointer: active.checkpointer,
        artifacts: active.artifacts,
        leaseAuthority: active.leases,
        adapters: new Map([[adapter.adapter_id, adapter]]),
        useValidator: { preflightRefs: preflight, validateUse },
      });
      const directive = prepareRun(active, `run-aborted-preflight-${refusal.replaceAll(" ", "-")}`);
      const ref = directive.request_ref;
      const invalid: InvokeHostOperationDirectiveV1 = {
        ...directive,
        input_artifacts: {
          schema_version: 2,
          artifacts:
            refusal === "duplicate slots"
              ? [
                  { slot: "proof", ref },
                  { slot: "proof", ref },
                ]
              : refusal === "input count"
                ? [
                    { slot: "first", ref },
                    { slot: "second", ref },
                  ]
                : [
                    {
                      slot: "proof",
                      ref: refusal === "input bytes" ? { ...ref, byte_length: 65 } : ref,
                    },
                  ],
        },
      };
      const reads = vi.spyOn(active.artifacts, "readById");
      const controller = new AbortController();
      controller.abort();
      await expect(owner.dispatch(active.engine, invalid, controller.signal)).rejects.toThrow(
        refusal === "duplicate slots"
          ? "input slots are duplicated"
          : refusal === "ref-only authority"
            ? "unapproved refs"
            : "input artifacts exceed registration"
      );
      expect(reads).not.toHaveBeenCalled();
      expect(validateUse).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      expect(calls.count).toBe(0);
      expect(active.checkpointer.hostOperationCallsForRun(directive.identity.run_id)).toEqual([]);
      active.leases.close();
      active.artifacts.close();
      active.checkpointer.close();
    }
  );

  it("does not bypass configured use authority to settle an already-aborted call", async () => {
    const active = fixture("aborted-use-authority");
    const calls = { count: 0 };
    const preflight = vi.fn();
    const validateUse = vi.fn();
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([["fixture-adapter", successfulAdapter(calls)]]),
      useValidator: { preflightRefs: preflight, validateUse },
    });
    const directive = prepareRun(active, "run-aborted-use-authority");
    const reads = vi.spyOn(active.artifacts, "readById");
    const controller = new AbortController();
    controller.abort();
    await expect(owner.dispatch(active.engine, directive, controller.signal)).rejects.toThrow(
      "input work was cancelled"
    );
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(validateUse).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(calls.count).toBe(0);
    expect(active.checkpointer.hostOperationCallsForRun(directive.identity.run_id)).toEqual([]);
    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("stops buffering inputs on cancellation but retains exact settlement custody", async () => {
    const active = fixture("cancel-during-inputs", {
      ...declaration(),
      max_input_artifacts: 2,
      max_input_bytes: 64,
    });
    const refs = ["first", "second"].map((slot) => ({
      slot,
      ref: active.artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: "run-cancel-during-inputs",
          phase: "host-operation-state",
          branch_id: null,
          kind: "host-input",
          operation_id: slot,
          version: 1,
          producer: "host:fixture",
          media_type: "application/octet-stream",
          parent_ref: null,
          upstream_refs: [],
        },
        content: slot,
      }),
    }));
    const first = requireValue(refs[0], "first input");
    const second = requireValue(refs[1], "second input");
    const directive = prepareRun(active, "run-cancel-during-inputs", refs);
    const controller = new AbortController();
    const calls = { count: 0 };
    const adapter = successfulAdapter(calls);
    const inspect = vi.spyOn(adapter, "inspectRequest");
    const acquire = vi.spyOn(active.leases, "tryAcquire");
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
    });
    const reserve = vi.spyOn(HostOperationStateOwner.prototype, "reserve");
    const nativeRead = active.artifacts.readById.bind(active.artifacts);
    const inputWorkReads: string[] = [];
    const reads = vi.spyOn(active.artifacts, "readById").mockImplementation((id) => {
      if (reserve.mock.calls.length === 0) {
        inputWorkReads.push(id);
        if (id === first.ref.artifact_id) controller.abort();
      }
      return nativeRead(id);
    });
    try {
      await expect(
        owner.dispatch(active.engine, directive, controller.signal)
      ).resolves.toMatchObject({
        action: "await_user",
      });
      expect(inputWorkReads).toEqual([directive.request_ref.artifact_id, first.ref.artifact_id]);
      // These reads are mandatory journal custody, not resumed input buffering.
      expect(reads).toHaveBeenCalledWith(second.ref.artifact_id);
      expect(active.checkpointer.hostOperationCallsForRun(directive.identity.run_id)).toMatchObject(
        [
          {
            lifecycle: "consumed",
            disposition: { outcome: "cancelled", remote_disposition: "none" },
          },
        ]
      );
      expect(inspect).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(calls.count).toBe(0);
    } finally {
      reserve.mockRestore();
      active.leases.close();
      active.artifacts.close();
      active.checkpointer.close();
    }
  });

  it("releases cancellation before submission as proven non-acceptance", async () => {
    const active = fixture("cancel-before-submission");
    const adapter: HostOperationAdapterV1 = {
      adapter_id: "fixture-adapter",
      inspectRequest: ({ directive }) => ({
        schema_version: 1,
        operation_kind: directive.operation_kind,
        adapter_id: directive.policy_binding.adapter_id,
        backend_binding_id: directive.policy_binding.backend_binding_id,
        backend_key_sha256: directive.policy_binding.backend_key_sha256,
      }),
      run: async () => await new Promise<never>(() => undefined),
    };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
    });
    const directive = prepareRun(active, "run-host-operation-cancel-before-submission");
    const controller = new AbortController();
    const pending = owner.dispatch(active.engine, directive, controller.signal);
    setTimeout(() => controller.abort(new Error("fixture cancellation")), 10);

    await expect(pending).resolves.toMatchObject({ action: "await_user" });
    const record = requireValue(
      active.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      ),
      "cancelled pre-submission host-operation record"
    );
    expect(record).toMatchObject({
      lifecycle: "consumed",
      disposition: {
        outcome: "cancelled",
        remote_disposition: "proven_not_accepted",
        lease_disposition: "released",
      },
    });
    expect(active.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
      state: "free",
    });

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("expires a stalled operation through its renewable inactivity lease", async () => {
    const activeDeclaration = declaration({
      duration_ms: 100,
      renew_after_ms: 50,
      queue_inactivity_ms: 20,
      operation_inactivity_ms: 40,
    });
    const active = fixture("timeout-before-submission", activeDeclaration);
    const adapter: HostOperationAdapterV1 = {
      adapter_id: "fixture-adapter",
      inspectRequest: ({ directive }) => ({
        schema_version: 1,
        operation_kind: directive.operation_kind,
        adapter_id: directive.policy_binding.adapter_id,
        backend_binding_id: directive.policy_binding.backend_binding_id,
        backend_key_sha256: directive.policy_binding.backend_key_sha256,
      }),
      run: async () => await new Promise<never>(() => undefined),
    };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
    });
    const directive = prepareRun(active, "run-host-operation-timeout-before-submission");

    await expect(owner.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    const record = requireValue(
      active.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      ),
      "timed-out pre-submission host-operation record"
    );
    expect(record).toMatchObject({
      lifecycle: "consumed",
      disposition: {
        outcome: "timed_out",
        remote_disposition: "proven_not_accepted",
        lease_disposition: "released",
      },
    });
    expect(active.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
      state: "free",
    });

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("quarantines cancellation during an acceptance-ambiguous submission", async () => {
    const active = fixture("cancel-ambiguous");
    const adapter: HostOperationAdapterV1 = {
      adapter_id: "fixture-adapter",
      inspectRequest: ({ directive }) => ({
        schema_version: 1,
        operation_kind: directive.operation_kind,
        adapter_id: directive.policy_binding.adapter_id,
        backend_binding_id: directive.policy_binding.backend_binding_id,
        backend_key_sha256: directive.policy_binding.backend_key_sha256,
      }),
      run: async (context) => {
        context.beginSubmission();
        return await new Promise<never>(() => undefined);
      },
    };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
    });
    const directive = prepareRun(active, "run-host-operation-cancel-ambiguous");
    const controller = new AbortController();
    const pending = owner.dispatch(active.engine, directive, controller.signal);
    setTimeout(() => controller.abort(new Error("fixture cancellation")), 10);

    await expect(pending).resolves.toMatchObject({ action: "await_user" });
    const record = requireValue(
      active.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      ),
      "cancelled host-operation record"
    );
    expect(record).toMatchObject({
      lifecycle: "consumed",
      disposition: {
        outcome: "remote_unknown",
        remote_disposition: "unknown_acceptance",
        lease_disposition: "quarantined",
        retryable: false,
      },
    });
    expect(active.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
      state: "quarantined",
    });

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("durably quarantines a submitted adapter whose local cleanup is unproven", async () => {
    const active = fixture("cleanup-unproven");
    let runs = 0;
    const adapter: HostOperationAdapterV1 = {
      adapter_id: "fixture-adapter",
      inspectRequest: ({ directive }) => ({
        schema_version: 1,
        operation_kind: directive.operation_kind,
        adapter_id: directive.policy_binding.adapter_id,
        backend_binding_id: directive.policy_binding.backend_binding_id,
        backend_key_sha256: directive.policy_binding.backend_key_sha256,
      }),
      async run(context) {
        runs += 1;
        context.beginSubmission();
        context.recordRemoteAccepted("local-process-correlation");
        throw new Error("p03_cleanup_unproven");
      },
    };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
    });
    const directive = prepareRun(active, "run-host-operation-cleanup-unproven");
    await expect(owner.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    const record = requireValue(
      active.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      ),
      "cleanup-unproven record"
    );
    expect(record).toMatchObject({
      lifecycle: "consumed",
      disposition: {
        outcome: "remote_unknown",
        remote_disposition: "may_continue",
        lease_disposition: "quarantined",
        retryable: false,
      },
    });
    expect(active.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
      state: "quarantined",
    });
    await expect(owner.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "status",
    });
    expect(runs).toBe(1);
    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("adopts an exact pre-journaled artifact after a persisting-boundary restart", async () => {
    const active = fixture("persisting-adoption");
    const calls = { count: 0 };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([["fixture-adapter", successfulAdapter(calls)]]),
    });
    const directive = prepareRun(active, "run-host-operation-persisting-adoption");
    const activeDeclaration = declaration();
    const state = new HostOperationStateOwner(active.checkpointer, active.artifacts);
    const now = Date.now();
    const timestamp = (offset: number): string => new Date(now + offset).toISOString();
    let record = state.reserve({
      record: createPreparedHostOperationCallRecord({
        project_id: active.projectId,
        directive,
        queue_inactivity_expires_at_ms: now + activeDeclaration.lease_profile.queue_inactivity_ms,
        operation_inactivity_expires_at_ms: now + activeDeclaration.operation_inactivity_ms,
        timestamp: timestamp(0),
      }),
    }).record;
    const request: HostOperationLeaseRequestV1 = {
      operation_record_id: record.operation_record_id,
      backend_key_sha256: record.policy_binding.backend_key_sha256,
      project_id: record.project_id,
      run_id: record.identity.run_id,
      state_id: record.state_id,
      attempt: record.attempt,
      operation_id: record.operation_id,
      registration_sha256: record.registration_sha256,
      request_sha256: record.request_sha256,
      duration_ms: activeDeclaration.lease_profile.duration_ms,
      queue_inactivity_expires_at_ms: record.queue_inactivity_expires_at_ms,
    };
    const acquisition = active.leases.tryAcquire(request, now + 1);
    if (acquisition.kind !== "acquired") throw new Error("fixture lease was not acquired");
    record = state.transition(
      record,
      validateHostOperationCallRecord({
        ...record,
        lifecycle: "lease_acquired",
        lease: acquisition.active.lease,
        lease_expires_at_ms: acquisition.active.expires_at_ms,
        updated_at: timestamp(1),
      })
    );
    active.leases.guardSubmission(request, acquisition.active.lease, now + 2);
    record = state.transition(
      record,
      validateHostOperationCallRecord({
        ...record,
        lifecycle: "submitting",
        updated_at: timestamp(2),
      })
    );
    const remoteCorrelationId = "fixture-adopted-remote-correlation";
    const remoteCorrelationSha256 = sha256(remoteCorrelationId);
    record = state.transition(
      record,
      validateHostOperationCallRecord({
        ...record,
        lifecycle: "submitted",
        remote_correlation_id: remoteCorrelationId,
        remote_correlation_sha256: remoteCorrelationSha256,
        updated_at: timestamp(3),
      })
    );
    const accepted = active.leases.reconcileRemoteAccepted(
      request,
      acquisition.active.lease,
      remoteCorrelationSha256,
      now + 4
    );
    record = state.transition(
      record,
      validateHostOperationCallRecord({
        ...record,
        lease: accepted.lease,
        lease_expires_at_ms: accepted.expires_at_ms,
        updated_at: timestamp(4),
      })
    );
    const resultContent = canonicalJson({ adopted: true });
    record = state.transition(
      record,
      validateHostOperationCallRecord({
        ...record,
        lifecycle: "fetched",
        fetched: {
          schema_version: 1,
          content_sha256: sha256(resultContent),
          byte_length: Buffer.byteLength(resultContent, "utf8"),
          item_count: 1,
          poll_count: 1,
        },
        updated_at: timestamp(5),
      })
    );
    const resultOperationId = `host-operation-specific-result:${record.operation_record_id}`;
    const resultPlan = {
      schema_version: 1 as const,
      operation_id: resultOperationId,
      version: 1,
      artifact_kind: RESULT_CONTRACT.artifact_kind,
      media_type: "application/json",
      schema_id: RESULT_CONTRACT.schema_id,
      schema_version_required: RESULT_CONTRACT.schema_version_required,
      byte_length: Buffer.byteLength(resultContent, "utf8"),
      content_sha256: sha256(resultContent),
    };
    const completedDisposition = {
      outcome: "completed" as const,
      remote_disposition: "proven_terminal" as const,
      lease_disposition: "released" as const,
      retryable: false as const,
      reason_code: null,
    };
    record = state.transition(
      record,
      validateHostOperationCallRecord({
        ...record,
        lifecycle: "persisting",
        persistence_plan: {
          schema_version: 1,
          operation_result: resultPlan,
          outputs: [],
          disposition: completedDisposition,
        },
        updated_at: timestamp(6),
      })
    );
    const preJournaled = active.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: record.identity.run_id,
        phase: record.state_id,
        branch_id: null,
        kind: RESULT_CONTRACT.artifact_kind,
        operation_id: resultOperationId,
        version: 1,
        producer: `host:${activeDeclaration.adapter_id}`,
        media_type: "application/json",
        content_schema: {
          schema_id: RESULT_CONTRACT.schema_id,
          schema_version: RESULT_CONTRACT.schema_version_required,
        },
        parent_ref: null,
        upstream_refs: [record.request_ref],
      },
      content: resultContent,
    });

    await expect(owner.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    const adopted = requireValue(
      active.checkpointer.hostOperationCall(record.operation_record_id),
      "adopted host-operation record"
    );
    expect(adopted).toMatchObject({
      lifecycle: "consumed",
      operation_result_ref: { artifact_id: preJournaled.artifact_id },
      disposition: completedDisposition,
    });
    expect(calls.count).toBe(0);
    expect(active.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
      state: "free",
    });

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("enforces the registration output-byte ceiling before artifact persistence", async () => {
    const active = fixture("output-overflow");
    const oversized = Buffer.alloc(declaration().max_output_bytes + 1, 0x61);
    const adapter: HostOperationAdapterV1 = {
      adapter_id: "fixture-adapter",
      inspectRequest: ({ directive }) => ({
        schema_version: 1,
        operation_kind: directive.operation_kind,
        adapter_id: directive.policy_binding.adapter_id,
        backend_binding_id: directive.policy_binding.backend_binding_id,
        backend_key_sha256: directive.policy_binding.backend_key_sha256,
      }),
      run: async (context) => {
        context.beginSubmission();
        context.recordRemoteAccepted("fixture-overflow-correlation");
        context.recordFetched({
          schema_version: 1,
          content_sha256: sha256(oversized),
          byte_length: oversized.byteLength,
          item_count: 1,
          poll_count: 1,
        });
        context.persist({
          disposition: {
            outcome: "completed",
            remote_disposition: "proven_terminal",
            lease_disposition: "released",
            retryable: false,
            reason_code: null,
          },
          operation_result: {
            contract: RESULT_CONTRACT,
            media_type: "application/json",
            content: oversized,
          },
        });
        throw new Error("unreachable after output overflow");
      },
    };
    const owner = new HostOperationRuntimeOwner({
      projectId: active.projectId,
      checkpointer: active.checkpointer,
      artifacts: active.artifacts,
      leaseAuthority: active.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
    });
    const directive = prepareRun(active, "run-host-operation-output-overflow");

    await expect(owner.dispatch(active.engine, directive)).resolves.toMatchObject({
      action: "await_user",
    });
    const record = requireValue(
      active.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      ),
      "output-overflow host-operation record"
    );
    expect(record).toMatchObject({
      lifecycle: "consumed",
      operation_result_ref: null,
      output_artifacts: [],
      disposition: {
        outcome: "failed",
        remote_disposition: "proven_terminal",
        lease_disposition: "released",
        reason_code: "post_fetch_persistence_failed",
      },
    });
    expect(active.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
      state: "free",
    });

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("serializes a backend FIFO across projects and quarantines ambiguous stale acceptance", () => {
    const active = fixture("global-lease");
    const backendKeySha256 = sha256("shared-backend-capacity");
    const first = leaseRequest({
      operationDigit: "1",
      backendKeySha256,
      projectId: active.projectId,
    });
    const second = leaseRequest({
      operationDigit: "2",
      backendKeySha256,
      projectId: active.secondProjectId,
    });
    const third = leaseRequest({
      operationDigit: "3",
      backendKeySha256,
      projectId: active.projectId,
    });

    const firstAcquisition = active.leases.tryAcquire(first, 100);
    if (firstAcquisition.kind !== "acquired") throw new Error("first lease was not acquired");
    expect(active.leases.tryAcquire(second, 101)).toEqual({ kind: "waiting" });
    expect(active.leases.tryAcquire(third, 102)).toEqual({ kind: "waiting" });
    active.leases.release(
      first,
      firstAcquisition.active.lease,
      {
        outcome: "failed",
        remote_disposition: "none",
        lease_disposition: "released",
        retryable: true,
        reason_code: "fixture-pre-submission-release",
      },
      null,
      103
    );
    expect(active.leases.tryAcquire(third, 104)).toEqual({ kind: "waiting" });
    const secondAcquisition = active.leases.tryAcquire(second, 105);
    if (secondAcquisition.kind !== "acquired")
      throw new Error("second FIFO lease was not acquired");
    expect(() => active.leases.guardSubmission(first, firstAcquisition.active.lease, 106)).toThrow(
      /exact active owner|fence/u
    );

    active.leases.guardSubmission(second, secondAcquisition.active.lease, 107);
    const poisoned = active.leases.tryAcquire(third, 1_000);
    if (poisoned.kind !== "quarantined") throw new Error("stale ambiguous lease was not poisoned");
    expect(active.leases.inspect(backendKeySha256)).toMatchObject({
      state: "quarantined",
      quarantine_id: poisoned.quarantine_id,
    });
    expect(active.leases.tryAcquire(first, 1_001)).toMatchObject({ kind: "quarantined" });
    const reset = active.leases.resetQuarantine({
      backend_key_sha256: backendKeySha256,
      quarantine_id: poisoned.quarantine_id,
      disposition: "queue_drained",
      evidence_sha256: sha256("inspected-remote-terminal-evidence"),
      queue_operation_record_ids: [third.operation_record_id, first.operation_record_id],
      now_ms: 1_002,
    });
    expect(reset.queue_snapshot_sha256).toBe(
      sha256(canonicalJson([third.operation_record_id, first.operation_record_id]))
    );
    expect(active.leases.inspect(backendKeySha256)).toMatchObject({ state: "free" });

    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });

  it("serializes independent lease-authority connections against the same state root", () => {
    const active = fixture("global-lease-connections");
    const competing = new HostOperationLeaseAuthority(path.join(active.root, "state"));
    const backendKeySha256 = sha256("shared-backend-two-connections");
    const first = leaseRequest({
      operationDigit: "4",
      backendKeySha256,
      projectId: active.projectId,
    });
    const second = leaseRequest({
      operationDigit: "5",
      backendKeySha256,
      projectId: active.secondProjectId,
    });

    const acquired = active.leases.tryAcquire(first, 200);
    if (acquired.kind !== "acquired") throw new Error("first connection did not acquire lease");
    expect(competing.tryAcquire(second, 201)).toEqual({ kind: "waiting" });
    active.leases.release(
      first,
      acquired.active.lease,
      {
        outcome: "failed",
        remote_disposition: "none",
        lease_disposition: "released",
        retryable: true,
        reason_code: "fixture-independent-connection-release",
      },
      null,
      202
    );
    expect(competing.tryAcquire(second, 203)).toMatchObject({ kind: "acquired" });

    competing.close();
    active.leases.close();
    active.artifacts.close();
    active.checkpointer.close();
  });
});

it("runs ref-only preflight before reads and current authority before proofs on dispatch and consumed replay", async () => {
  const active = fixture("preflight-order");
  const events: string[] = [];
  const calls = { count: 0 };
  const ref = active.artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: "preflight-order",
      phase: "host-operation-state",
      branch_id: null,
      kind: "opaque-input",
      operation_id: "proof",
      version: 1,
      producer: "host:test",
      media_type: "application/octet-stream",
      parent_ref: null,
      upstream_refs: [],
    },
    content: "exact proof",
  });
  const directive = prepareRun(active, "preflight-order", [{ slot: "proof", ref }]);
  const native = active.artifacts.readById.bind(active.artifacts);
  const reads = vi.spyOn(active.artifacts, "readById").mockImplementation((id) => {
    events.push(id === ref.artifact_id ? "proof" : "read");
    return native(id);
  });
  let refuse = false;
  const owner = new HostOperationRuntimeOwner({
    projectId: active.projectId,
    checkpointer: active.checkpointer,
    artifacts: active.artifacts,
    leaseAuthority: active.leases,
    adapters: new Map([["fixture-adapter", successfulAdapter(calls)]]),
    useValidator: {
      preflightRefs() {
        events.push("preflight");
        if (refuse) throw new Error("preflight refused");
      },
      validateUse() {
        events.push("authority");
      },
    },
  });
  for (let i = 0; i < 2; i++) {
    events.length = 0;
    await owner.dispatch(active.engine, directive);
    expect(events[0]).toBe("preflight");
    expect(events.indexOf("authority")).toBeLessThan(events.indexOf("proof"));
  }
  refuse = true;
  reads.mockClear();
  await expect(owner.dispatch(active.engine, directive)).rejects.toThrow("preflight refused");
  expect(reads).not.toHaveBeenCalled();
  expect(calls.count).toBe(1);
  active.leases.close();
  active.artifacts.close();
  active.checkpointer.close();
});
