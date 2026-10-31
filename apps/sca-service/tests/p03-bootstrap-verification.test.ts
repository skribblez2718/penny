import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { Checkpointer } from "../../orchestration/dist/checkpointer.js";
import type {
  ArtifactRef,
  InvokeHostOperationDirectiveV1,
} from "../../orchestration/dist/contracts.js";
import { OrchestrationEngine } from "../../orchestration/dist/engine.js";
import { HostOperationLeaseAuthority } from "../../orchestration/dist/host-operations/lease-authority.js";
import {
  HostOperationRuntimeOwner,
  HostOperationSimulatedCrashError,
  type HostOperationFaultPointV1,
} from "../../orchestration/dist/host-operations/owner.js";
import {
  PLAYBOOK_REGISTRY,
  runtimeRegistrationSha256,
  validateRegistrationContract,
} from "../../orchestration/dist/playbooks/registry.js";
import { ReceiptAuthority } from "../../orchestration/dist/receipts.js";
import { ProjectCatalog } from "../../orchestration/dist/state/catalog.js";
import { OrchestrationRunner, WorkerExecutor } from "../../orchestration/dist/worker.js";
import {
  SCA_P03_VERIFICATION_NAME,
  SCA_P03_VERIFICATION_REGISTRATION,
  SCA_P03_VERIFICATION_STATE,
  SCA_P03_VERIFICATION_DECLARATION,
  SCA_P03_VERIFICATION_REQUEST_SCHEMA,
  scaP03VerificationInputsV1,
  type ScaP03VerificationRequestV1,
  readScaP03VerificationRequestV1,
} from "../../orchestration/dist/sca/p03-bootstrap-verification.js";
import {
  createScaP03BootstrapVerificationDeterministicTestOnlyAdapterV1,
  readScaP03ConsumedVerificationV1,
} from "../src/p03-bootstrap-verification.js";
import {
  parseScaP03CliCanonical,
  ScaP03CliProductionFreezeHandoffSchema,
  ScaP03CliProductionSealedHandoffSchema,
} from "../src/p03-bootstrap-cli-contracts.js";
import { createScaP03BoundVerificationReaderV1 } from "../src/p03-verification-reader.js";
import {
  disposeSamplerFixtures,
  productionSamplerFixture,
  verificationChild,
} from "./p03-production-sampler-fixture.js";

import { buildP03CompiledFixture } from "./p03-compiled-orchestration-fixture.js";

const roots: string[] = [];
const handles: { close(): void }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0).reverse()) handle.close();
  disposeSamplerFixtures();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("required fixture evidence absent");
  return value;
}

async function fixture(stateRoot?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "p03-guarded-"));
  roots.push(root);
  const state = stateRoot ?? path.join(root, "state");
  using catalog = new ProjectCatalog(state, { create: stateRoot === undefined });
  const project = catalog.registerProject(root);
  const f = await productionSamplerFixture(false, { project_id: project.projectId });
  const db = path.join(f.working, "orchestration.db");
  const receiptKey = path.join(f.working, "receipt-key");
  let checkpointer = Checkpointer.provision(db, undefined, { projectId: project.projectId });
  handles.push(checkpointer);
  let store = ArtifactStore.openExisting(f.storeRoot, { projectId: project.projectId });
  handles.push(store);
  let leases = new HostOperationLeaseAuthority(state);
  handles.push(leases);
  const receipt = ReceiptAuthority.provision(receiptKey);
  const construct = () =>
    new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 20,
      receiptAuthority: receipt,
      artifactStore: store,
      artifactReader: store,
      artifactRevisions: store,
      playbookRegistration: SCA_P03_VERIFICATION_REGISTRATION,
    });
  let engine = construct();
  const frozen = parseScaP03CliCanonical(
    ScaP03CliProductionFreezeHandoffSchema,
    readFileSync(f.freezePath)
  );
  const sealed = parseScaP03CliCanonical(
    ScaP03CliProductionSealedHandoffSchema,
    readFileSync(f.sealedPath)
  );
  const b = frozen.bindings;
  const accepted = frozen.production_bindings.roots.accepted_p01;
  // Fixed exact closure from caller-supplied handoffs, NOT store/manifest discovery.
  const refs = [
    b.fixture_corpus_ref,
    b.source_oracle_ref,
    b.source_oracle_validation_ref,
    b.source_oracle_review_ref,
    b.baseline_query_set_ref,
    b.qualification_profile_ref,
    b.runtime_policy_ref,
    b.implementation_identity_ref,
    b.runtime_identity_ref,
    ...b.fixture_content_refs,
    ...b.query_script_refs,
    ...b.query_plan_refs,
    ...b.runtime_package_refs,
    ...b.implementation_source_refs,
    accepted.request_ref,
    accepted.obligation_ledger_ref,
    accepted.campaign_manifest_core_ref,
    accepted.admission_evidence_ref,
    accepted.p01_gate_ref,
    accepted.campaign_manifest_ref,
    ...accepted.frozen_refs,
    sealed.production_record_ref,
    sealed.record_ref,
    sealed.attempt_ref,
    sealed.cleanup_ref,
    sealed.isolation_ref,
    sealed.external_review_ref,
    sealed.receipt_ref,
    sealed.review_ref,
    sealed.host_attestation_ref,
    sealed.binding_ref,
  ]
    .filter(
      (ref, i, all) => all.findIndex((candidate) => candidate.artifact_id === ref.artifact_id) === i
    )
    .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
  const backend = sha256("explicit offline shared Docker verification backend");
  const getRecord = (directive: InvokeHostOperationDirectiveV1) =>
    required(
      checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      )
    );
  const start = (overrides: { refs?: ArtifactRef[]; backend?: string; nonce?: string } = {}) => {
    const runId = `verification-${randomUUID()}`;
    const nonce = overrides.nonce ?? `invocation-${randomUUID()}`;
    const request: ScaP03VerificationRequestV1 = {
      schema_id: SCA_P03_VERIFICATION_REQUEST_SCHEMA,
      schema_version: 1 as const,
      run_id: runId,
      invocation_nonce: nonce,
      manifest_sha256: f.manifest_sha256,
      backend_resource_sha256: overrides.backend ?? backend,
      input_refs: overrides.refs ?? refs,
    };
    const ref = store.persist({
      metadata: {
        schema_version: 2,
        run_id: runId,
        phase: SCA_P03_VERIFICATION_STATE,
        branch_id: null,
        kind: SCA_P03_VERIFICATION_DECLARATION.request.artifact_kind,
        operation_id: `request:${nonce}`,
        version: 1,
        producer: "host:offline-qualification",
        media_type: "application/json",
        content_schema: { schema_id: request.schema_id, schema_version: 1 },
        parent_ref: null,
        upstream_refs: request.input_refs,
      },
      content: canonicalJson(request),
    });
    const directive = engine.handle({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: `session-${runId}`,
        playbook: SCA_P03_VERIFICATION_NAME,
        engine_owner: "typescript",
      },
      goal: "Exercise guarded offline verification only",
      constraints: { request_ref: ref },
      project_root: root,
      trust_profile: "trusted-interactive",
      input_artifacts: {
        schema_version: 2,
        artifacts: [{ slot: "request", ref }, ...scaP03VerificationInputsV1(request).artifacts],
      },
    });
    if (directive.action !== "invoke_host_operation")
      throw new Error(`expected real engine operation, received ${directive.action}`);
    expect(checkpointer.loadRun(directive.identity).pendingDirective).toEqual(directive);
    return { directive, nonce };
  };
  const runner = (
    options: {
      fault?: (point: HostOperationFaultPointV1) => void;
      crashAtDocker?: boolean;
      custodyAttack?: boolean;
    } = {}
  ) => {
    const adapter = createScaP03BootstrapVerificationDeterministicTestOnlyAdapterV1({
      store,
      sample_input: { manifest_path: f.manifest_path, manifest_sha256: f.manifest_sha256 },
      approved_backend_resource_sha256: backend,
      docker_observations: async (argv, cwd, signal) => {
        const active = leases.inspect(backend);
        expect(active).toMatchObject({ state: "active", active: { phase: "submission_guarded" } });
        if (options.crashAtDocker)
          throw new HostOperationSimulatedCrashError("after_submit_before_remote_checkpoint");
        return f.command(argv, cwd, signal);
      },
    });
    const actual = options.custodyAttack
      ? {
          ...adapter,
          async run(context: Parameters<typeof adapter.run>[0]) {
            const reader = createScaP03BoundVerificationReaderV1(context, store);
            const unrelated = store.persist({
              metadata: {
                ...store.metadata(refs[0] ?? sealed.record_ref),
                operation_id: "unbound-input",
              },
              content: "{}",
            });
            expect(() => reader.read(unrelated)).toThrow("ref_out_of_scope");
            expect(() => reader.metadata(unrelated)).toThrow("ref_out_of_scope");
            expect(() => reader.refById(unrelated.artifact_id)).toThrow("ref_out_of_scope");
            const bound = refs[0];
            if (bound === undefined) throw new Error("missing bound ref");
            expect(() => reader.metadata({ ...bound, producer: "host:forged" })).toThrow(
              "ref_out_of_scope"
            );
            expect(reader.metadata(bound)).toEqual(store.metadata(bound));
            return adapter.run(context);
          },
        }
      : adapter;
    const owner = new HostOperationRuntimeOwner({
      projectId: project.projectId,
      checkpointer,
      artifacts: store,
      leaseAuthority: leases,
      adapters: new Map([[actual.adapter_id, actual]]),
      ...(options.fault === undefined ? {} : { fault: options.fault }),
    });
    const worker = new WorkerExecutor(
      {
        async runAgent() {
          throw new Error("model dispatch forbidden");
        },
      },
      store,
      { projectRoot: root, parallelConcurrency: 1, registration: SCA_P03_VERIFICATION_REGISTRATION }
    );
    return new OrchestrationRunner(engine, worker, undefined, owner);
  };
  return {
    f,
    root,
    state,
    backend,
    refs,
    start,
    runner,
    getRecord,
    get engine() {
      return engine;
    },
    get store() {
      return store;
    },
    get checkpointer() {
      return checkpointer;
    },
    get leases() {
      return leases;
    },
    reopen() {
      for (const handle of [leases, store, checkpointer]) {
        handles.splice(handles.indexOf(handle), 1);
        handle.close();
      }
      checkpointer = Checkpointer.openExisting(db, undefined, { projectId: project.projectId });
      handles.push(checkpointer);
      store = ArtifactStore.openExisting(f.storeRoot, { projectId: project.projectId });
      handles.push(store);
      leases = new HostOperationLeaseAuthority(state);
      handles.push(leases);
      engine = construct();
    },
    read(current: ReturnType<typeof start>, nonce = current.nonce) {
      return readScaP03ConsumedVerificationV1({
        store,
        checkpointer,
        directive: current.directive,
        invocation_nonce: nonce,
      });
    },
  };
}

describe("P03 canonical guarded verification offline qualification", () => {
  it("has a real zero-model closed registration outside the public registry", () => {
    expect(() => validateRegistrationContract(SCA_P03_VERIFICATION_REGISTRATION)).not.toThrow();
    expect(SCA_P03_VERIFICATION_REGISTRATION.worker.kind).toBe("none");
    expect(PLAYBOOK_REGISTRY.has(SCA_P03_VERIFICATION_NAME)).toBe(false);
    expect(runtimeRegistrationSha256(SCA_P03_VERIFICATION_REGISTRATION)).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);
  it("does not let engine recovery, missing owner, or pre-dispatch cancellation execute proof effects", async () => {
    const f = await fixture();
    const current = f.start();
    expect(
      f.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: current.directive.identity,
      })
    ).toEqual(current.directive);
    const workers = new WorkerExecutor(
      {
        async runAgent() {
          throw new Error("no model dispatch");
        },
      },
      f.store,
      {
        projectRoot: f.root,
        parallelConcurrency: 1,
        registration: SCA_P03_VERIFICATION_REGISTRATION,
      }
    );
    await expect(
      new OrchestrationRunner(f.engine, workers).runUntilBoundary(current.directive)
    ).resolves.toMatchObject({
      action: "error",
      result: { code: "HOST_OPERATION_OWNER_UNAVAILABLE" },
    });
    expect(f.checkpointer.hostOperationCallsForRun(current.directive.identity.run_id)).toHaveLength(
      0
    );
    const cancelled = f.start();
    const abort = new AbortController();
    abort.abort();
    await expect(
      f.runner().runUntilBoundary(cancelled.directive, abort.signal)
    ).resolves.toMatchObject({ action: "cancelled", met: false });
    expect(
      f.checkpointer.hostOperationCallsForRun(cancelled.directive.identity.run_id)
    ).toHaveLength(0);
    expect(f.f.commands).toHaveLength(0);
    expect(f.leases.inspect(f.backend)).toEqual({ state: "absent" });
  }, 120_000);
  it("bounds and canonicalizes the closed request instead of accepting duplicate, unknown, or unsorted data", async () => {
    const f = await fixture();
    const current = f.start();
    const bytes = f.store.read(current.directive.request_ref);
    const request = readScaP03VerificationRequestV1(bytes);
    expect(() =>
      readScaP03VerificationRequestV1(Buffer.concat([bytes, Buffer.from("\n")]))
    ).toThrow("noncanonical");
    expect(() =>
      readScaP03VerificationRequestV1(
        Buffer.alloc(SCA_P03_VERIFICATION_DECLARATION.max_request_bytes + 1)
      )
    ).toThrow("request_limit");
    expect(() =>
      readScaP03VerificationRequestV1(Buffer.from(canonicalJson({ ...request, unknown: true })))
    ).toThrow("schema validation");
    expect(() =>
      readScaP03VerificationRequestV1(
        Buffer.from(
          canonicalJson({
            ...request,
            input_refs: [required(request.input_refs[0]), required(request.input_refs[0])],
          })
        )
      )
    ).toThrow("input_refs_invalid");
    expect(() =>
      readScaP03VerificationRequestV1(
        Buffer.from(canonicalJson({ ...request, input_refs: [...request.input_refs].reverse() }))
      )
    ).toThrow("input_refs_invalid");
    expect(() =>
      readScaP03VerificationRequestV1(Buffer.from('{"run_id":"a","run_id":"b"}'))
    ).toThrow("noncanonical");
    expect(f.f.commands).toHaveLength(0);
  }, 120_000);
  it("guards before real proof effects and consumes two distinct fresh measurements without changing the sample body", async () => {
    const f = await fixture();
    const first = f.start();
    expect(() => f.read(first)).toThrow("current_consumed_result_required");
    await expect(
      f.runner({ custodyAttack: true }).runUntilBoundary(first.directive)
    ).resolves.toMatchObject({ action: "incomplete", met: false });
    const one = f.read(first);
    const second = f.start();
    await f.runner().runUntilBoundary(second.directive);
    const two = f.read(second);
    expect(two.sample).toEqual(one.sample);
    expect(two.result_ref).not.toEqual(one.result_ref);
    expect(two.receipt_ref).not.toEqual(one.receipt_ref);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.directive.policy_binding.backend_key_sha256).toBe(
      first.directive.policy_binding.backend_key_sha256
    );
    expect(f.getRecord(first.directive).lifecycle).toBe("consumed");
    expect(f.getRecord(second.directive).lifecycle).toBe("consumed");
    expect(f.f.commands.filter((args) => args[1] === "create")).toHaveLength(2);
    expect(f.leases.inspect(f.backend)).toEqual({ state: "free" });
    expect(() => f.read(first, second.nonce)).toThrow("current_invocation_mismatch");
    expect(() => f.read(second, first.nonce)).toThrow("current_invocation_mismatch");
  }, 120_000);
  it("crashes at guarded dispatch, reopens exact canonical state, and quarantines across fresh runs and projects until inspected reset", async () => {
    const f = await fixture();
    const current = f.start();
    await expect(
      f.runner({ crashAtDocker: true }).runUntilBoundary(current.directive)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    expect(f.getRecord(current.directive).lifecycle).toBe("submitting");
    expect(f.leases.inspect(f.backend)).toMatchObject({
      state: "active",
      active: { phase: "submission_guarded" },
    });
    f.reopen();
    await f.runner().runUntilBoundary(current.directive);
    expect(f.getRecord(current.directive)).toMatchObject({
      lifecycle: "consumed",
      disposition: { outcome: "remote_unknown", lease_disposition: "quarantined" },
    });
    expect(() => f.read(current)).toThrow("current_consumed_result_required");
    const quarantine = f.leases.inspect(f.backend);
    if (quarantine.state !== "quarantined") throw new Error("expected durable quarantine");
    const fresh = f.start();
    await f.runner().runUntilBoundary(fresh.directive);
    expect(f.getRecord(fresh.directive).disposition?.reason_code).toBe("backend_quarantined");
    const other = await fixture(f.state);
    const otherRun = other.start();
    await other.runner().runUntilBoundary(otherRun.directive);
    expect(other.getRecord(otherRun.directive).disposition?.reason_code).toBe(
      "backend_quarantined"
    );
    expect(other.f.commands).toHaveLength(0);
    expect(() =>
      other.leases.resetQuarantine({
        backend_key_sha256: f.backend,
        quarantine_id: "wrong",
        disposition: "queue_inspected_empty",
        evidence_sha256: sha256("offline inspection"),
      })
    ).toThrow("exact poisoned lease");
    const reset = other.leases.resetQuarantine({
      backend_key_sha256: f.backend,
      quarantine_id: quarantine.quarantine_id,
      disposition: "queue_inspected_empty",
      evidence_sha256: sha256("offline fixture inspector confirms no Docker was called"),
    });
    expect(reset.quarantine_id).toBe(quarantine.quarantine_id);
    const after = other.start();
    await other.runner().runUntilBoundary(after.directive);
    expect(other.read(after).sample).toHaveProperty("proof_sha256");
  }, 120_000);
  it("survives actual verifier process SIGKILL after durable submission guard and journal, never replaying Docker", async () => {
    const f = await fixture();
    const current = f.start();
    // Build an offline worker in this disposable test deployment; no application command executes.
    const { orchestration } = verificationChild(f.f); // Protected deployment; never launched here.
    const worker = path.join(f.f.working, "kill-worker.mjs");
    buildP03CompiledFixture({
      entrypoint: fileURLToPath(
        new URL("./fixtures/p03-verification-kill-worker.ts", import.meta.url)
      ),
      outfile: worker,
      orchestration,
    });
    const marker = path.join(f.f.working, "guard-before-kill.json");
    const config = f.f.file(
      "kill-worker-input.json",
      canonicalJson({
        directive: current.directive,
        project_id: f.f.project_id,
        project_root: f.root,
        database: path.join(f.f.working, "orchestration.db"),
        store_root: f.f.storeRoot,
        state_root: f.state,
        receipt_key: path.join(f.f.working, "receipt-key"),
        sample_input: { manifest_path: f.f.manifest_path, manifest_sha256: f.f.manifest_sha256 },
        backend: f.backend,
        marker,
      })
    );
    const killed = spawnSync(process.execPath, [worker, config], {
      cwd: f.f.working,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
      maxBuffer: 1_048_576,
    });
    expect(killed.error).toBeUndefined();
    expect(killed.status, killed.stderr).toBeNull();
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    const observed: unknown = JSON.parse(readFileSync(marker, "utf8"));
    expect(observed).toMatchObject({
      lifecycle: "submitting",
      lease: { state: "active", active: { phase: "submission_guarded" } },
    });
    f.reopen();
    expect(f.getRecord(current.directive).lifecycle).toBe("submitting");
    await f.runner().runUntilBoundary(current.directive);
    expect(f.getRecord(current.directive).disposition).toMatchObject({
      outcome: "remote_unknown",
      lease_disposition: "quarantined",
    });
    const next = f.start();
    await f.runner().runUntilBoundary(next.directive);
    expect(f.getRecord(next.directive).disposition?.reason_code).toBe("backend_quarantined");
    expect(f.f.commands).toHaveLength(0);
    expect(() => f.read(next)).toThrow("current_consumed_result_required");
  }, 120_000);
  it("leaves a durable global guard when the project journal cannot record submitting, with zero proof effects", async () => {
    const f = await fixture();
    const current = f.start();
    const original = f.checkpointer.transitionHostOperationCall.bind(f.checkpointer);
    const write = vi
      .spyOn(f.checkpointer, "transitionHostOperationCall")
      .mockImplementation((input) => {
        if (
          f.leases.inspect(f.backend).state === "active" &&
          input.next.lifecycle !== "lease_acquired"
        )
          throw new Error("journal storage unavailable");
        return original(input);
      });
    await expect(f.runner().runUntilBoundary(current.directive)).rejects.toThrow(
      "journal storage unavailable"
    );
    expect(f.f.commands).toHaveLength(0);
    expect(f.leases.inspect(f.backend)).toMatchObject({
      state: "active",
      active: { phase: "submission_guarded" },
    });
    write.mockRestore();
    f.reopen();
    // Expired guarded owners are poisoned by the canonical lease authority, not a P03 cache.
    const active = f.leases.inspect(f.backend);
    if (active.state !== "active") throw new Error("guard missing");
    const next = f.start();
    // No backend state is synthesized; advancing the trusted owner clock exposes real expiry.
    const adapter = createScaP03BootstrapVerificationDeterministicTestOnlyAdapterV1({
      store: f.store,
      sample_input: { manifest_path: f.f.manifest_path, manifest_sha256: f.f.manifest_sha256 },
      approved_backend_resource_sha256: f.backend,
      docker_observations: f.f.command,
    });
    const engine = new OrchestrationEngine(f.checkpointer, {
      projectRoot: f.root,
      maxSteps: 20,
      receiptAuthority: ReceiptAuthority.loadExisting(path.join(f.f.working, "receipt-key")),
      artifactStore: f.store,
      artifactReader: f.store,
      artifactRevisions: f.store,
      playbookRegistration: SCA_P03_VERIFICATION_REGISTRATION,
    });
    const owner = new HostOperationRuntimeOwner({
      projectId: f.f.project_id,
      checkpointer: f.checkpointer,
      artifacts: f.store,
      leaseAuthority: f.leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
      now: () => active.active.expires_at_ms + 1,
    });
    const workers = new WorkerExecutor(
      {
        async runAgent() {
          throw new Error("no model");
        },
      },
      f.store,
      {
        projectRoot: f.root,
        parallelConcurrency: 1,
        registration: SCA_P03_VERIFICATION_REGISTRATION,
      }
    );
    await new OrchestrationRunner(engine, workers, undefined, owner).runUntilBoundary(
      next.directive
    );
    expect(f.leases.inspect(f.backend)).toMatchObject({ state: "quarantined" });
    expect(f.f.commands).toHaveLength(0);
  }, 120_000);
  it("settles after a write fault only from exact persisted proof, with no repeated verification", async () => {
    const f = await fixture();
    const current = f.start();
    const original = f.checkpointer.transitionHostOperationCall.bind(f.checkpointer);
    const fault = vi
      .spyOn(f.checkpointer, "transitionHostOperationCall")
      .mockImplementation((input) => {
        if (input.next.lifecycle === "settled") throw new Error("settlement write unavailable");
        return original(input);
      });
    await expect(f.runner().runUntilBoundary(current.directive)).rejects.toThrow(
      "settlement write unavailable"
    );
    expect(f.leases.inspect(f.backend)).toEqual({ state: "free" });
    expect(f.getRecord(current.directive).lifecycle).toBe("terminal");
    expect(() => f.read(current)).toThrow("current_consumed_result_required");
    const count = f.f.commands.length;
    fault.mockRestore();
    f.reopen();
    await f.runner().runUntilBoundary(current.directive);
    expect(f.read(current).sample).toHaveProperty("proof_sha256");
    expect(f.f.commands).toHaveLength(count);
  }, 120_000);
  it("refuses missing proof refs and request-specific backend substitution before Docker", async () => {
    const f = await fixture();
    const missing = f.start({ refs: f.refs.slice(1) });
    await f.runner().runUntilBoundary(missing.directive);
    expect(() => f.read(missing)).toThrow("current_consumed_result_required");
    expect(f.f.commands).toHaveLength(0);
    const changed = f.start({ backend: sha256("per-request bypass") });
    await f.runner().runUntilBoundary(changed.directive);
    expect(f.getRecord(changed.directive).disposition?.reason_code).toBe(
      "adapter_request_inspection_failed"
    );
    expect(f.f.commands).toHaveLength(0);
  }, 120_000);
});
