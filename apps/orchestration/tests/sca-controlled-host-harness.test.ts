import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type {
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
  validateHostOperationReceipt,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
} from "../dist/host-operations/contracts.js";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import type { PlaybookStepOutcome, Playbook } from "../dist/playbooks/playbook.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import {
  ScaControlledHostHarness,
  requireLiveQualifiedObservation,
} from "../dist/sca/controlled-host-harness.js";
import {
  buildP01SourceSnapshotV2,
  type P01SourceIncludePolicy,
} from "../dist/sca/p01-source-snapshot-builder.js";
import {
  validateScaCampaignSourceSnapshotV2,
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  validateScaP01SourceMaterialV1,
  validateScaSourceProvenanceV1,
} from "../dist/sca/p01-contracts.js";
import { requireValue } from "./helpers/narrowing.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "penny-controlled-sca-"));
  roots.push(value);
  return value;
}
const limits = { max_unique_artifact_bytes: 100_000, max_observations: 1 };
const policy = {
  include_paths: ["src"],
  exclude_paths: ["src/ignored"],
  max_files: 3,
  max_total_bytes: 10_000,
  max_file_bytes: 5_000,
  max_walk_entries: 20,
};
function harnessInput(base: string) {
  return { temporary_root: base, project_root: base, now_ms: 1_700_000_000_000, limits };
}

const REQUEST = {
  schema_version: 1,
  port_name: "request",
  artifact_kind: "host-request",
  schema_id: "penny.host-request.v1",
  schema_version_required: 1,
} as const;
const RESULT = {
  schema_version: 1,
  port_name: "result",
  artifact_kind: "host-result",
  schema_id: "penny.host-result.v1",
  schema_version_required: 1,
} as const;

function declaration(): HostOperationDeclarationV1 {
  const profile = {
    profile_id: "sca-controlled-lease",
    profile_version: 1 as const,
    duration_ms: 30_000,
    renew_after_ms: 10_000,
    queue_inactivity_ms: 5_000,
  };
  return {
    schema_version: 1,
    operation_kind: "sca-controlled-operation",
    adapter_id: "sca-controlled-adapter",
    request: REQUEST,
    result: RESULT,
    backend_binding_id: "sca-controlled-backend",
    capability_classes: ["artifact_store"],
    lease_profile: { ...profile, profile_sha256: hostOperationLeaseProfileSha256(profile) },
    operation_inactivity_ms: 60_000,
    max_request_bytes: 4_096,
    max_output_artifacts: 2,
    max_output_bytes: 8_192,
    max_progress_events: 4,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "local_abort_only_v1",
  };
}
class Consumer implements Playbook {
  initialize(context: RunContext): Directive {
    return this.dispatch(context);
  }
  dispatch(context: RunContext): Directive {
    if (context.pendingDirective !== null) return context.pendingDirective;
    const next: Directive = {
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: context.stateId,
      gate_id: "control-complete",
      challenge: "acknowledge",
      payload_digest: sha256("acknowledge"),
      questions: [{ id: "ack", prompt: "Acknowledge." }],
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
function registration(): PlaybookRegistration {
  const base = requireValue(resolvePlaybook("research"), "research registration");
  return {
    ...base,
    host_states: [...(base.host_states ?? []), "sca-controlled-state"],
    host_operations: { schema_version: 1, max_active_per_run: 1, declarations: [declaration()] },
    construct: () => new Consumer(),
  };
}
function prepare(harness: ScaControlledHostHarness, base: string) {
  const active = registration();
  const runId = "controlled-run";
  const identity: RunIdentity = {
    schema_version: 2,
    run_id: runId,
    session_id: "controlled-session",
    playbook: "research",
    engine_owner: "typescript",
  };
  const requestRef = harness.artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "sca-controlled-state",
      branch_id: null,
      kind: REQUEST.artifact_kind,
      operation_id: "controlled-request",
      version: 1,
      producer: "host:controlled",
      media_type: "application/json",
      content_schema: { schema_id: REQUEST.schema_id, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson({ request: "fixture" }),
  });
  const directive: InvokeHostOperationDirectiveV1 = {
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity,
    state_id: "sca-controlled-state",
    attempt: 1,
    operation_id: "controlled-op",
    operation_kind: "sca-controlled-operation",
    registration_sha256: runtimeRegistrationSha256(active),
    request_ref: requestRef,
    request_sha256: requestRef.content_digest,
    input_artifacts: { schema_version: 2, artifacts: [] },
    expected_result: RESULT,
    policy_binding: hostOperationPolicyBinding(declaration(), sha256("backend")),
  };
  const context = RunContext.create({
    identity,
    goal: "controlled host rehearsal",
    constraints: {},
    projectRoot: base,
    trustProfile: "trusted-interactive",
    maxSteps: 20,
    registrationContractBinding: {
      schema_version: 1,
      registration_name: active.name,
      contract_sha256: skillContractSha256(active.contract),
      registration_sha256: runtimeRegistrationSha256(active),
    },
    initialArtifacts: [requestRef],
  });
  context.transition("sca-controlled-state");
  context.pendingDirective = directive;
  harness.checkpointer.createRun(context, "controlled_started", { state_id: context.stateId });
  const engine = new OrchestrationEngine(harness.checkpointer, {
    projectRoot: base,
    maxSteps: 20,
    receiptAuthority: ReceiptAuthority.provision(path.join(base, "receipt.key")),
    artifactRevisions: harness.artifacts,
    artifactStore: harness.artifacts,
    artifactReader: harness.artifacts,
    playbookRegistration: active,
  });
  engine.liveness.bindPolicy(context);
  return { engine, directive };
}

function adapter(
  submissions: { value: number },
  afterAcceptance?: () => void
): HostOperationAdapterV1 {
  return {
    adapter_id: "sca-controlled-adapter",
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
        submissions.value += 1;
        context.recordRemoteAccepted("controlled-remote-correlation");
        afterAcceptance?.();
      }
      const content = canonicalJson({ result: "fixture" });
      const cached = await context.cacheResult(Buffer.from(content));
      context.recordFetched({
        schema_version: 1,
        content_sha256: cached.content_sha256,
        byte_length: cached.byte_length,
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
      const output = context.persist({
        disposition,
        operation_result: { contract: RESULT, media_type: "application/json", content },
      });
      return {
        disposition,
        operation_result_ref: output.operation_result_ref,
        output_artifacts: output.output_artifacts,
      };
    },
  };
}

function buildSource(
  host: ScaControlledHostHarness,
  sourceRoot: string,
  overrides: Partial<P01SourceIncludePolicy> = {}
) {
  return buildP01SourceSnapshotV2({
    source_root: sourceRoot,
    store: host.artifacts,
    run_id: "boundary-run",
    snapshot_id: "boundary-snapshot",
    policy: { ...policy, ...overrides },
  });
}

describe("SCA controlled host foundation (offline rehearsal only)", () => {
  it("builds and exactly re-reads a bounded P01 V2 snapshot with sealed provenance", async () => {
    const base = root();
    mkdirSync(path.join(base, "src", "ignored"), { recursive: true });
    writeFileSync(path.join(base, "src", "main.ts"), "export const answer = 42;\n");
    writeFileSync(path.join(base, "src", "ignored", "extra.ts"), "ignored");
    using host = await ScaControlledHostHarness.provision(harnessInput(base));
    const refs = buildP01SourceSnapshotV2({
      source_root: base,
      store: host.artifacts,
      run_id: "source-run",
      snapshot_id: "source-snapshot-a",
      policy,
    });
    const manifest = validateScaP01SourceFileManifestV1(
      JSON.parse(
        host
          .readExact(refs.file_manifest_ref, { parent_ref: null, upstream_refs: [] })
          .toString("utf8")
      )
    );
    const custody = validateScaP01SourceCustodyCorpusV1(
      JSON.parse(
        host
          .readExact(refs.custody_ref, {
            parent_ref: null,
            upstream_refs: [refs.file_manifest_ref],
          })
          .toString("utf8")
      )
    );
    const snapshot = validateScaCampaignSourceSnapshotV2(
      JSON.parse(
        host
          .readExact(refs.snapshot_ref, {
            parent_ref: null,
            upstream_refs: [refs.custody_ref, refs.file_manifest_ref].sort((a, b) =>
              Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id))
            ),
          })
          .toString("utf8")
      )
    );
    expect(manifest.files.map((file) => file.path)).toEqual(["src/main.ts"]);
    expect(custody.files[0]?.content_base64).toBe(
      Buffer.from("export const answer = 42;\n").toString("base64")
    );
    expect(snapshot.custody_sha256).toBe(refs.custody_ref.content_digest);
    validateScaP01SourceMaterialV1({
      snapshot,
      file_manifest_ref: refs.file_manifest_ref,
      file_manifest: manifest,
      custody_ref: refs.custody_ref,
      custody,
    });
    const provenance = validateScaSourceProvenanceV1(
      JSON.parse(
        host
          .readExact(refs.provenance_ref, {
            parent_ref: null,
            upstream_refs: [refs.custody_ref, refs.file_manifest_ref, refs.snapshot_ref].sort(
              (a, b) => Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id))
            ),
          })
          .toString("utf8")
      )
    );
    expect(provenance).toEqual({
      schema_id: "penny.sca-source-provenance.v1",
      schema_version: 1,
      snapshot_ref: refs.snapshot_ref,
      file_manifest_ref: refs.file_manifest_ref,
      custody_ref: refs.custody_ref,
      custody_sha256: refs.custody_ref.content_digest,
      capture_method: "host-frozen",
      custody_status: "verified",
    });
    expect(snapshot).toMatchObject({
      snapshot_id: "source-snapshot-a",
      file_manifest_ref: refs.file_manifest_ref,
      custody_ref: refs.custody_ref,
      status: "frozen",
    });
  });

  it.each(["", "src//main.ts", "src/./main.ts", "src/../main.ts", "src\\main.ts"])(
    "refuses noncanonical include path %j before capture",
    async (includePath) => {
      const base = root();
      using host = await ScaControlledHostHarness.provision(harnessInput(base));
      expect(() => buildSource(host, base, { include_paths: [includePath] })).toThrow(
        /canonical and repository-relative/
      );
    }
  );

  it("refuses an absolute include path", async () => {
    const base = root();
    using host = await ScaControlledHostHarness.provision(harnessInput(base));
    expect(() => buildSource(host, base, { include_paths: [path.join(base, "src")] })).toThrow(
      /canonical and repository-relative/
    );
  });

  it.each(["file", "directory", "include ancestor", "source root", "root ancestor"] as const)(
    "rejects a %s symlink without reading through it",
    async (link) => {
      const base = root();
      const source = path.join(base, "source");
      mkdirSync(path.join(source, "src", "nested"), { recursive: true });
      writeFileSync(path.join(source, "src", "nested", "main.ts"), "a");
      let sourceRoot = source;
      let includes: readonly string[] = ["src"];
      if (link === "file") {
        symlinkSync(
          path.join(source, "src", "nested", "main.ts"),
          path.join(source, "src", "link.ts")
        );
      } else if (link === "directory") {
        symlinkSync(path.join(source, "src", "nested"), path.join(source, "src", "linked"));
      } else if (link === "include ancestor") {
        symlinkSync(path.join(source, "src", "nested"), path.join(source, "src", "linked"));
        includes = ["src/linked/main.ts"];
      } else if (link === "source root") {
        sourceRoot = path.join(base, "source-link");
        symlinkSync(source, sourceRoot);
      } else {
        const ancestor = path.join(base, "ancestor-link");
        symlinkSync(source, ancestor);
        sourceRoot = path.join(ancestor, "src");
        includes = ["nested/main.ts"];
      }
      using host = await ScaControlledHostHarness.provision(harnessInput(base));
      expect(() =>
        buildSource(host, sourceRoot, {
          include_paths: includes,
          exclude_paths: [],
        })
      ).toThrow(/symlink|link|real directory/);
    }
  );

  it("isolates file count from total-byte limits", async () => {
    const base = root();
    mkdirSync(path.join(base, "src"));
    writeFileSync(path.join(base, "src", "a.ts"), "a");
    writeFileSync(path.join(base, "src", "b.ts"), "b");
    using host = await ScaControlledHostHarness.provision(harnessInput(base));
    expect(() => buildSource(host, base, { max_files: 1, max_total_bytes: 10_000 })).toThrow(
      /file count or byte budget/
    );
    expect(buildSource(host, base, { max_files: 2, max_total_bytes: 10_000 })).toBeDefined();
  });

  it("isolates aggregate bytes from file count and per-file limits", async () => {
    const base = root();
    mkdirSync(path.join(base, "src"));
    writeFileSync(path.join(base, "src", "a.ts"), "ab");
    using host = await ScaControlledHostHarness.provision(harnessInput(base));
    expect(() =>
      buildSource(host, base, { max_files: 3, max_total_bytes: 1, max_file_bytes: 5_000 })
    ).toThrow(/file count or byte budget/);
  });

  it("enforces per-file bytes independently", async () => {
    const base = root();
    mkdirSync(path.join(base, "src"));
    writeFileSync(path.join(base, "src", "a.ts"), "ab");
    using host = await ScaControlledHostHarness.provision(harnessInput(base));
    expect(() =>
      buildSource(host, base, { max_files: 3, max_total_bytes: 10_000, max_file_bytes: 1 })
    ).toThrow(/file count or byte budget/);
  });

  it("stops directory traversal at max_walk_entries", async () => {
    const base = root();
    mkdirSync(path.join(base, "src"));
    writeFileSync(path.join(base, "src", "a.ts"), "a");
    using host = await ScaControlledHostHarness.provision(harnessInput(base));
    expect(() => buildSource(host, base, { max_walk_entries: 1 })).toThrow(
      /traversal entry budget/
    );
  });

  it("pins corpus, runtime and implementation in a synthetic observation without a live-qualified path", async () => {
    const base = root();
    using host = await ScaControlledHostHarness.provision(harnessInput(base));
    const implementationRef = host.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "run-evidence",
        phase: "control",
        branch_id: null,
        kind: "implementation-input",
        operation_id: "implementation",
        version: 1,
        producer: "host:control",
        media_type: "application/json",
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson({ revision: "rev-1" }),
    });
    const corpusRef = host.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "run-evidence",
        phase: "control",
        branch_id: null,
        kind: "corpus",
        operation_id: "corpus",
        version: 1,
        producer: "host:control",
        media_type: "application/json",
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson({ files: 1 }),
    });
    const observedRef = host.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "run-evidence",
        phase: "control",
        branch_id: null,
        kind: "observation",
        operation_id: "observation",
        version: 1,
        producer: "host:control",
        media_type: "application/json",
        parent_ref: null,
        upstream_refs: [corpusRef],
      },
      content: canonicalJson({ observed: true }),
    });
    const refs = [implementationRef, corpusRef, observedRef].sort((a, b) =>
      Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id))
    );
    const current = registration();
    const input = {
      evidence_class: "synthetic" as const,
      bindings: {
        implementation_revision: "rev-1",
        implementation_ref: implementationRef,
        implementation_provenance: { parent_ref: null, upstream_refs: [] },
        runtime_registration_sha256: runtimeRegistrationSha256(current),
        corpus_ref: corpusRef,
        corpus_provenance: { parent_ref: null, upstream_refs: [] },
      },
      observed_ref: observedRef,
      observed_provenance: { parent_ref: null, upstream_refs: [corpusRef] },
      registration: current,
      run_id: "run-evidence",
      operation_id: "evidence",
    };
    expect(() =>
      host.capture({ ...input, observed_provenance: { parent_ref: null, upstream_refs: [] } })
    ).toThrow(/provenance/);
    expect(() =>
      host.capture({
        ...input,
        bindings: {
          ...input.bindings,
          runtime_registration_sha256: sha256("claimed-not-current"),
        },
      })
    ).toThrow(/runtime binding/);
    const captured = host.capture(input);
    expect(captured.observation).toMatchObject({
      qualification_disposition: "not_live_qualified",
      evidence_class: "synthetic",
      implementation_ref: implementationRef,
      implementation_assurance_scope: "declaration_only",
      observed_sha256: observedRef.content_digest,
      runtime_registration_sha256: input.bindings.runtime_registration_sha256,
    });
    expect(
      host.readExact(captured.ref, { parent_ref: null, upstream_refs: refs }).toString("utf8")
    ).toBe(canonicalJson(captured.observation));
    for (const evidence_class of ["synthetic", "fixture"] as const) {
      expect(() =>
        requireLiveQualifiedObservation({
          ...captured.observation,
          evidence_class,
        })
      ).toThrow(/cannot satisfy live-qualified/);
    }
    expect(() => host.capture(input)).toThrow(/observation budget/);
    expect(() =>
      host.readExact(
        { ...corpusRef, content_digest: sha256("wrong") },
        { parent_ref: null, upstream_refs: [] }
      )
    ).toThrow(/store_ref does not match|metadata changed/);
    expect(captured.observation.observed_at).toBe(
      new Date(harnessInput(base).now_ms).toISOString()
    );
    host.clock.advance(4_000);
    expect(host.clock.now()).toBe(harnessInput(base).now_ms + 4_000);
    expect(() => host.clock.advance(-1)).toThrow();
  });

  it("charges unique bytes before reading and refuses an existing state root for new provisioning", async () => {
    const base = root();
    const config = {
      ...harnessInput(base),
      limits: { max_unique_artifact_bytes: 4, max_observations: 1 },
    };
    using host = await ScaControlledHostHarness.provision(config);
    const ref = host.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "budget-run",
        phase: "budget",
        branch_id: null,
        kind: "budget-input",
        operation_id: "budget-input",
        version: 1,
        producer: "host:control",
        media_type: "application/json",
        parent_ref: null,
        upstream_refs: [],
      },
      content: "12345",
    });
    expect(() => host.readExact(ref, { parent_ref: null, upstream_refs: [] })).toThrow(
      /byte budget/
    );
    await expect(ScaControlledHostHarness.provision(config)).rejects.toThrow(/must be fresh/);
  });

  it("uses its injected clock for durable journal, progress and receipt times", async () => {
    const base = root();
    using host = await ScaControlledHostHarness.provision(harnessInput(base));
    const { engine, directive } = prepare(host, base);
    const start = new Date(host.clock.now()).toISOString();
    const events: string[] = [];
    const adapters = new Map([
      ["sca-controlled-adapter", adapter({ value: 0 }, () => host.clock.advance(250))],
    ]);
    await expect(
      host.owner(adapters).dispatch(engine, directive, undefined, (event) => {
        events.push(event.observed_at);
      })
    ).resolves.toMatchObject({ action: "await_user" });
    const finish = new Date(host.clock.now()).toISOString();
    expect(events).toEqual([start, start, finish, finish]);
    expect(
      host.checkpointer
        .events(directive.identity.run_id)
        .filter((event) => event.eventType === "host_operation_progress")
        .map((event) => event.createdAt)
    ).toEqual(events);
    const record = requireValue(
      host.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      ),
      "deterministic operation record"
    );
    expect(record.created_at).toBe(start);
    expect(record.started_at).toBe(start);
    expect(record.updated_at).toBe(finish);
    const receiptRef = requireValue(record.host_receipt_ref, "host receipt ref");
    const receipt = validateHostOperationReceipt(
      JSON.parse(host.artifacts.readById(receiptRef.artifact_id).toString("utf8"))
    );
    expect(receipt).toMatchObject({ started_at: start, ended_at: finish });
  });

  it.each([
    "before_submit",
    "after_remote_checkpoint",
    "after_fetch",
    "after_persist",
    "before_consume",
  ] as const)("reopens durable stores and adopts %s without resubmitting", async (point) => {
    const base = root();
    const first = await ScaControlledHostHarness.provision(harnessInput(base));
    const { engine, directive } = prepare(first, base);
    const submissions = { value: 0 };
    first.faults.arm(point, directive.operation_kind);
    const adapters = new Map([["sca-controlled-adapter", adapter(submissions)]]);
    await expect(first.dispatch(engine, directive, adapters)).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    if (point === "after_persist") {
      const persisted = requireValue(
        first.checkpointer.hostOperationCallForDirective(
          directive.identity.run_id,
          directive.state_id,
          directive.attempt,
          directive.operation_id
        ),
        "after-persist journal milestone"
      );
      expect(persisted.lifecycle).toBe("verified");
      expect(persisted.operation_result_ref).not.toBeNull();
      expect(persisted.platform_result_ref).toBeNull();
    }
    first.close();
    using second = await ScaControlledHostHarness.reopen(harnessInput(base));
    const resumed = new OrchestrationEngine(second.checkpointer, {
      projectRoot: base,
      maxSteps: 20,
      receiptAuthority: ReceiptAuthority.provision(path.join(base, "receipt.key")),
      artifactRevisions: second.artifacts,
      artifactStore: second.artifacts,
      artifactReader: second.artifacts,
      playbookRegistration: registration(),
    });
    await expect(second.dispatch(resumed, directive, adapters)).resolves.toMatchObject({
      action: "await_user",
    });
    expect(submissions.value).toBe(1);
    const cached = await second.cache.read(directive.request_sha256);
    expect(cached?.content_sha256).toBe(sha256(canonicalJson({ result: "fixture" })));
    const record = requireValue(
      second.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      ),
      "durable operation record"
    );
    expect(record.lifecycle).toBe("consumed");
    expect(record.disposition).toMatchObject({
      outcome: "completed",
      lease_disposition: "released",
    });
    expect(second.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
      state: "free",
    });
    // The record is not synthesized from the cache: it remains an exact journal entry.
    expect(record.request_sha256).toBe(directive.request_ref.content_digest);
  });

  it("quarantines uncertain acceptance on fresh restart and never retries the external submission", async () => {
    const base = root();
    const first = await ScaControlledHostHarness.provision(harnessInput(base));
    const { engine, directive } = prepare(first, base);
    const submissions = { value: 0 };
    const adapters = new Map([["sca-controlled-adapter", adapter(submissions)]]);
    first.faults.arm("after_submit_before_remote_checkpoint", directive.operation_kind);
    await expect(first.dispatch(engine, directive, adapters)).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    first.close();
    using second = await ScaControlledHostHarness.reopen(harnessInput(base));
    const resumed = new OrchestrationEngine(second.checkpointer, {
      projectRoot: base,
      maxSteps: 20,
      receiptAuthority: ReceiptAuthority.provision(path.join(base, "receipt.key")),
      artifactRevisions: second.artifacts,
      artifactStore: second.artifacts,
      artifactReader: second.artifacts,
      playbookRegistration: registration(),
    });
    await expect(second.dispatch(resumed, directive, adapters)).resolves.toMatchObject({
      action: "await_user",
    });
    expect(submissions.value).toBe(1);
    expect(second.leases.inspect(directive.policy_binding.backend_key_sha256)).toMatchObject({
      state: "quarantined",
    });
    expect(
      second.checkpointer.hostOperationCallForDirective(
        directive.identity.run_id,
        directive.state_id,
        directive.attempt,
        directive.operation_id
      )?.disposition
    ).toMatchObject({
      outcome: "remote_unknown",
      lease_disposition: "quarantined",
      retryable: false,
    });
  });
});
