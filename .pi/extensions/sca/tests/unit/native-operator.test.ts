import { expect, it } from "vitest";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { requireFunction, requireRecord } from "../../../../lib/tests/test-narrowers.js";
import { registerScaP03NativeOperatorV1 } from "../../src/native-operator.js";

it("keeps the dormant native component unavailable without a host or model tools", async () => {
  let command: unknown;
  const tools: string[] = [];
  registerScaP03NativeOperatorV1(
    createTestExtensionApi({
      onRegisterCommand(name, options) {
        if (name === "sca-p03-initial") command = options;
      },
      onRegisterTool(value) {
        const tool = requireRecord(value);
        if (typeof tool.name !== "string") throw new Error("tool name required");
        tools.push(tool.name);
      },
    })
  );
  expect(tools).toEqual([]);
  const handler = requireFunction(requireRecord(command).handler);
  const notifications: { message: string; level: string }[] = [];
  await handler("start art_" + "a".repeat(64), {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });
  expect(notifications).toEqual([
    {
      message:
        "missing_input: trusted native authenticated operator/profile + canonical backend/state authority composition",
      level: "error",
    },
  ]);
});

it("rejects an equal-budget foreign exact pin through native and same-realm start/response/recovery before body reads", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { vi } = await import("vitest");
  const { initializePennyState } =
    await import("../../../../../apps/orchestration/dist/state/setup.js");
  const { OrchestrationService } =
    await import("../../../../../apps/orchestration/dist/service.js");
  const { ArtifactStore } =
    await import("../../../../../apps/orchestration/dist/artifact-store.js");
  const { canonicalJson, sha256 } =
    await import("../../../../../apps/orchestration/dist/canonical-json.js");
  const {
    ScaP03InitialProposalBindingV1,
    ScaP03InitialAuthorizationV1,
    validateScaP03InitialProposalV1,
  } = await import("../../../../../apps/orchestration/dist/sca/p03-initial-authorization.js");
  const { createScaP03InitialQualificationRegistrationV1, readScaP03InitialGate } =
    await import("../../../../../apps/orchestration/dist/sca/p03-initial-qualification.js");
  const { registerScaP03NativeOperatorV1 } = await import("../../src/native-operator.js");
  const { runtimeRegistrationSha256 } =
    await import("../../../../../apps/orchestration/dist/playbooks/registry.js");
  const { signTrustedHumanEvent, verifyExecutionOwnerSignature } =
    await import("../../../skill/execution-receipts.js");
  const root = mkdtempSync(path.join(tmpdir(), "p03-native-pin-"));
  try {
    const state = initializePennyState(root, {
      env: { PENNY_STATE_ROOT: path.join(root, "state") },
    });
    using store = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    const persist = (kind: string, content: string, operation = kind) =>
      store.persist({
        metadata: {
          schema_version: 2,
          run_id: "pinned-run",
          phase: "SCA-P03",
          branch_id: null,
          kind,
          operation_id: operation,
          version: 1,
          producer: "host:sca-p03-initial-authorization",
          media_type: "application/json",
          content_schema: { schema_id: `penny.${kind}.v1`, schema_version: 1 },
          parent_ref: null,
          upstream_refs: [],
        },
        content,
      });
    const proof = persist("opaque-proof", "{}");
    const now = Date.now();
    const proposal = validateScaP03InitialProposalV1({
      schema_id: "penny.sca-p03-initial-proposal.v1",
      schema_version: 1,
      run_id: "pinned-run",
      invocation_nonce: "nonce",
      approval_id: "approval",
      project_id: state.projectId,
      principal_id: "test-principal",
      policy_id: "test-policy",
      installation_id: "test-installation",
      revocation_generation: 1,
      state_authority_sha256: sha256("state"),
      backend_resource_sha256: sha256("backend"),
      deployment_sha256: sha256("deployment"),
      configuration_sha256: sha256("config"),
      evidence_destination_sha256: sha256("evidence"),
      fixture_cohort_sha256: proof.content_digest,
      issued_at: new Date(now - 1000).toISOString(),
      not_before: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      effect: "fixture_qualification",
      input_refs: [proof],
      resources: {
        cpus: 1,
        memory_bytes: 1024,
        pids: 1,
        tmp_bytes: 1,
        work_bytes: 100,
        command_output_bytes: 100,
        concurrency: 1,
        inactivity_ms: 60_000,
        cleanup_grace_ms: 100,
        max_commands: 1,
        max_source_bytes: 1,
        max_source_files: 1,
        max_graph_bytes: 1,
        max_query_bytes: 1,
        max_query_items: 1,
        max_page_items: 1,
        max_pages_per_query: 1,
        max_ast_depth: 1,
        max_ast_nodes: 1,
        max_num_def: 1,
        jvm_heap_bytes: 1,
        max_host_workspace_bytes: 1,
        max_evidence_bytes: 1,
      },
    });
    const ref = persist("sca-p03-initial-proposal", canonicalJson(proposal));
    const binding = new ScaP03InitialProposalBindingV1(store, ref);
    const authorization = new ScaP03InitialAuthorizationV1(
      {
        current: () => ({ ...proposal, revoked: false, permitted_effects: [proposal.effect] }),
        now: () => new Date(),
        authenticatedInteractivePrincipal: () => proposal.principal_id,
        assertCurrentInputs() {},
      },
      { verify: verifyExecutionOwnerSignature },
      binding
    );
    const foreignProof = persist("foreign-proof", "{}");
    const foreign = validateScaP03InitialProposalV1({
      ...proposal,
      approval_id: "foreign-approval",
      invocation_nonce: "foreign-nonce",
      input_refs: [foreignProof],
    });
    expect(foreign.input_refs.length).toBe(proposal.input_refs.length);
    expect(foreign.input_refs.reduce((n, r) => n + r.byte_length, 0)).toBe(
      proposal.input_refs.reduce((n, r) => n + r.byte_length, 0)
    );
    expect(foreign.resources).toEqual(proposal.resources);
    const foreignRef = persist(
      "sca-p03-initial-proposal",
      canonicalJson(foreign),
      "foreign-proposal"
    );
    const foreignBinding = new ScaP03InitialProposalBindingV1(store, foreignRef);
    const foreignAuthorization = new ScaP03InitialAuthorizationV1(
      {
        current: () => ({ ...foreign, revoked: false, permitted_effects: [foreign.effect] }),
        now: () => new Date(),
        authenticatedInteractivePrincipal: () => foreign.principal_id,
        assertCurrentInputs() {},
      },
      { verify: verifyExecutionOwnerSignature },
      foreignBinding
    );
    const model = vi.fn(async () => {
      throw new Error("models forbidden");
    });
    using service = new OrchestrationService({
      projectRoot: root,
      env: { PENNY_STATE_ROOT: path.join(root, "state") },
      playbookRegistration: createScaP03InitialQualificationRegistrationV1({
        authorization,
        binding,
      }),
      enableChildWorkflows: false,
      modelClient: { runAgent: model },
    });
    using foreignService = new OrchestrationService({
      projectRoot: root,
      env: { PENNY_STATE_ROOT: path.join(root, "state") },
      playbookRegistration: createScaP03InitialQualificationRegistrationV1({
        authorization: foreignAuthorization,
        binding: foreignBinding,
      }),
      enableChildWorkflows: false,
      modelClient: { runAgent: model },
    });
    // Equal declaration digests are intentional. A registration mismatch must not
    // substitute for the full proposal-pin check on same-run recovery/replay.
    expect(runtimeRegistrationSha256(foreignService.engine.registration)).toBe(
      runtimeRegistrationSha256(service.engine.registration)
    );
    let command: unknown;
    registerScaP03NativeOperatorV1(
      createTestExtensionApi({
        onRegisterCommand(_name, value) {
          command = value;
        },
      }),
      { service, authorization, binding, state_authority_sha256: proposal.state_authority_sha256 }
    );
    const handler = requireFunction(requireRecord(command).handler);
    const read = vi.spyOn(service.artifacts, "read"),
      byId = vi.spyOn(service.artifacts, "readById");
    const nativeStoreRead = vi.spyOn(store, "read");
    const nativeStoreById = vi.spyOn(store, "readById");
    const ctx = { mode: "tui", hasUI: true, ui: { notify() {} } };
    await expect(handler(`start ${foreignRef.artifact_id}`, ctx)).rejects.toThrow(
      "foreign_proposal"
    );
    await expect(handler("respond foreign-run", ctx)).rejects.toThrow("foreign_run");
    const start = {
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: foreign.run_id,
        session_id: "foreign-session",
        playbook: foreignService.engine.registration.name,
        engine_owner: "typescript",
      },
      goal: "offline equal-budget foreign pin",
      project_root: root,
      trust_profile: "trusted-interactive",
      constraints: { proposal_ref: foreignRef },
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "initial_proposal", ref: foreignRef },
          { slot: "proof_000", ref: foreignProof },
        ],
      },
    };
    await expect(service.execute(start)).rejects.toThrow("foreign_proposal");
    // A separately pinned composition can create the real checkpoint and gate.
    const gate = await foreignService.execute(start);
    if (gate.action !== "await_user") throw new Error("foreign gate absent");
    const transport = foreignService.checkpointer
      .loadRun(gate.identity)
      .selectedArtifacts.find((r) => r.kind === "sca-p03-initial-transport");
    if (transport === undefined) throw new Error("foreign transport absent");
    const gateBinding = readScaP03InitialGate(foreignService.artifacts, foreignRef, transport);
    const event = signTrustedHumanEvent({
      runId: foreign.run_id,
      gateId: gate.gate_id,
      challenge: gate.challenge,
      artifactRef: foreignRef,
      transportRef: transport,
      renderedQuestionsDigest: gateBinding.rendered_questions_digest,
      response: "approve",
    });
    const branch = {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "questionnaire",
        details: { trustedHumanEvents: [event] },
      },
    };
    // Native response and same-realm response both reach the actual stored gate.
    await expect(
      handler(`respond ${foreign.run_id}`, {
        ...ctx,
        sessionManager: { getBranch: () => [branch] },
      })
    ).rejects.toThrow("foreign_proposal");
    await expect(
      service.execute({
        schema_version: 2,
        action: "respond",
        identity: gate.identity,
        gate_id: gate.gate_id,
        challenge: gate.challenge,
        response: event,
      })
    ).rejects.toThrow("foreign_proposal");
    for (let replay = 0; replay < 2; replay++)
      await expect(
        service.execute({ schema_version: 2, action: "recover", identity: gate.identity })
      ).rejects.toThrow("foreign_proposal");
    const pending = foreignService.handle({
      schema_version: 2,
      action: "respond",
      identity: gate.identity,
      gate_id: gate.gate_id,
      challenge: gate.challenge,
      response: event,
    });
    if (pending.action !== "invoke_host_operation") throw new Error("foreign operation absent");
    // Repeat against a real pending operation, not only an awaiting-user checkpoint.
    for (let replay = 0; replay < 2; replay++)
      await expect(
        service.execute({ schema_version: 2, action: "recover", identity: pending.identity })
      ).rejects.toThrow("foreign_proposal");
    expect(read).not.toHaveBeenCalled();
    expect(byId).not.toHaveBeenCalled();
    expect(nativeStoreRead).not.toHaveBeenCalled();
    expect(nativeStoreById).not.toHaveBeenCalled();
    expect(service.checkpointer.hostOperationCallsForRun(foreign.run_id)).toHaveLength(0);
    expect(model).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
