import { RunContext } from "../dist/context.js";
import { Checkpointer } from "../dist/checkpointer.js";
import { OrchestrationService } from "../dist/service.js";
import { initializePennyState } from "../dist/state/index.js";
import { initializeVideogenOwnerSelection } from "../dist/videogen/owner-selection.js";
import { assertImageAssetOwners } from "../dist/imagegen/asset-authority.js";
import { skillContractSha256, runtimeRegistrationSha256 } from "../dist/playbooks/registry.js";
import { describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateDirective } from "../dist/contracts.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import {
  HostOperationReceiptV1Schema,
  HostOperationResultV1Schema,
  validateHostOperationCallRecord,
} from "../dist/host-operations/contracts.js";
import {
  HostEffectIntentV1Schema,
  HostReceiptedResultV1Schema,
  hostEffectOperationId,
  prepareHostEffectArtifacts,
  verifyHostEffectBinding,
  verifyHostResultWrapper,
} from "../dist/host-operations/effect-protocol.js";
import {
  HostOperationSimulatedCrashError,
  HostOperationStateOwner,
  type HostOperationFaultPointV1,
} from "../dist/host-operations/owner.js";
import { createRawMediaDecodeAdapter } from "../dist/videogen/media-decode.js";
import {
  RAW_MEDIA_REQUEST_CONTRACT,
  RAW_MEDIA_RESULT_CONTRACT,
  RawMediaDecodeRequestV1Schema,
  MEDIA_FRAME_CONTRACT,
  MEDIA_PCM_CONTRACT,
} from "../dist/videogen/media-contracts.js";
import { ConfinedMediaRunner } from "../dist/host-operations/confined-media-runner.js";
import { MediaEvidenceCustody } from "../dist/videogen/media-evidence.js";
import {
  MEDIA_LIMITS,
  MEDIA_POLICY,
  MEDIA_SELECTION,
  pcmAsset,
  required,
} from "./helpers/videogen-media-fixtures.js";
import {
  EFFECT_REQUEST_SCHEMA,
  HostEffectFixture,
  effectAdapter,
  effectDeclaration,
} from "./helpers/host-effect-fixture.js";

function preparation(f: HostEffectFixture) {
  return {
    store: f.store,
    identity: f.identity(),
    request_contract: f.declaration.request,
    request_schema: EFFECT_REQUEST_SCHEMA,
    request: {
      schema_id: f.declaration.request.schema_id,
      schema_version: 1,
      value: "exact input",
    },
    input_refs: [],
    budget_reservation_ref: f.ref({ held: "fixture" }),
    expected_output_contract_ref: f.ref(f.declaration.result),
  };
}
function counter() {
  return { submitted: 0, runs: 0, recoveries: 0 };
}

describe("host request-intent and post-receipt recovery", () => {
  it("writes exact request before intent, with stable logical identity and no self-reference", () => {
    using f = new HostEffectFixture();
    const input = preparation(f),
      writes: string[] = [],
      persist = f.store.persist.bind(f.store);
    const observed = vi.spyOn(f.store, "persist").mockImplementation((value) => {
      writes.push(value.metadata.kind);
      return persist(value);
    });
    const prepared = prepareHostEffectArtifacts(input);
    expect(writes).toEqual(["effect-fixture-request", "videogen-effect-intent"]);
    const request: unknown = JSON.parse(f.store.read(prepared.request_ref).toString("utf8"));
    expect(request).toEqual({
      ...input.request,
      operation_id: hostEffectOperationId(input.identity),
    });
    expect(request).not.toHaveProperty("effect_intent_ref");
    const intent = validateSkillSchema(
      HostEffectIntentV1Schema,
      JSON.parse(f.store.read(prepared.effect_intent_ref).toString("utf8")),
      "intent"
    );
    expect(intent.request_ref).toEqual(prepared.request_ref);
    expect(prepareHostEffectArtifacts(input)).toEqual(prepared);
    expect(writes).toHaveLength(2);
    expect(() =>
      prepareHostEffectArtifacts({ ...input, request: { ...input.request, value: "changed" } })
    ).toThrow(/conflict/u);
    observed.mockRestore();
  });
  it("refuses an orphan request after a request-before-intent crash, including reopened stores", () => {
    using f = new HostEffectFixture();
    const input = preparation(f);
    const persist = f.store.persist.bind(f.store);
    const crash = vi.spyOn(f.store, "persist").mockImplementation((value) => {
      if (value.metadata.kind === "videogen-effect-intent")
        throw new Error("injected request/intent crash");
      return persist(value);
    });
    expect(() => prepareHostEffectArtifacts(input)).toThrow(/injected/u);
    crash.mockRestore();
    f.reopen();
    expect(() => prepareHostEffectArtifacts({ ...input, store: f.store })).toThrow(/orphan/u);
    expect(f.checkpointer.hostOperationCallsForRun(f.runId)).toHaveLength(0);
  });
  it.each(["operation", "request", "intent", "identity", "missing-pair"] as const)(
    "refuses %s linkage drift before journal/effect",
    async (drift) => {
      using f = new HostEffectFixture();
      const d = f.start(),
        count = counter();
      const other = f.prepare({ identity: { ...required(d.effect_identity), slot: "other-slot" } });
      const { effect_intent_ref: _removedIntent, effect_identity: _removedIdentity, ...legacy } = d;
      const bad = validateDirective(
        drift === "operation"
          ? { ...d, operation_id: "wrong" }
          : drift === "request"
            ? {
                ...d,
                request_ref: other.request_ref,
                request_sha256: other.request_ref.content_digest,
              }
            : drift === "intent"
              ? { ...d, effect_intent_ref: other.effect_intent_ref }
              : drift === "identity"
                ? { ...d, effect_identity: { ...d.effect_identity, visit: 2 } }
                : legacy
      );
      if (bad.action !== "invoke_host_operation") throw new Error("host fixture directive lost");
      await expect(
        f.owner(effectAdapter(count)).dispatch(f.engine, bad, new AbortController().signal)
      ).rejects.toThrow();
      expect(count.submitted).toBe(0);
      expect(f.checkpointer.hostOperationCallsForRun(f.runId)).toHaveLength(0);
    }
  );
  it("rejects a mutually matching request/intent whose visit was never committed in the parent", async () => {
    using f = new HostEffectFixture();
    const prepared = f.prepare({ identity: { ...f.identity(), visit: 2 } });
    const d = f.start(prepared),
      count = counter();
    await expect(f.owner(effectAdapter(count)).dispatch(f.engine, d)).rejects.toThrow(
      /durable current state visit/u
    );
    expect(count.submitted).toBe(0);
    expect(f.checkpointer.hostOperationCallsForRun(f.runId)).toHaveLength(0);
  });
  const boundaries = [
    "after_remote_checkpoint",
    "after_fetch",
    "after_raw_plan",
    "after_raw_artifacts",
    "after_persist",
    "after_receipt",
    "after_wrapper_plan",
    "after_wrapper_persist",
    "after_wrapper",
    "before_consume",
    "after_consume",
  ] as const satisfies readonly HostOperationFaultPointV1[];
  it.each(boundaries)(
    "reopens at %s and consumes one exact receipt/result without a second submission",
    async (point) => {
      using f = new HostEffectFixture();
      const d = f.start(),
        count = counter();
      let tripped = false;
      const owner = f.owner(effectAdapter(count), (where) => {
        if (!tripped && where === point) {
          tripped = true;
          throw new HostOperationSimulatedCrashError(where);
        }
      });
      await expect(owner.dispatch(f.engine, d, new AbortController().signal)).rejects.toThrow(
        HostOperationSimulatedCrashError
      );
      expect(tripped).toBe(true);
      const prior = required(f.checkpointer.hostOperationCallsForRun(f.runId)[0]);
      f.reopen();
      expect(
        await f.owner(effectAdapter(count)).dispatch(f.engine, d, new AbortController().signal)
      ).toMatchObject({ action: point === "after_consume" ? "status" : "await_user" });
      const record = required(f.checkpointer.hostOperationCallsForRun(f.runId)[0]);
      expect(record.lifecycle).toBe("consumed");
      expect(count.submitted).toBe(1);
      expect(record.directive.effect_intent_ref).toEqual(d.effect_intent_ref);
      if (prior.host_receipt_ref !== null)
        expect(record.host_receipt_ref).toEqual(prior.host_receipt_ref);
      if (prior.operation_result_ref !== null)
        expect(record.operation_result_ref).toEqual(prior.operation_result_ref);
      if (prior.result_wrapper?.ref != null)
        expect(record.result_wrapper).toEqual(prior.result_wrapper);
      verifyHostEffectBinding(f.store, f.projectId, record.directive);
      verifyHostResultWrapper(f.store, record);
      const wrapperRef = required(record.result_wrapper?.ref),
        rawRef = required(record.operation_result_ref);
      const wrapper = validateSkillSchema(
        HostReceiptedResultV1Schema,
        JSON.parse(f.store.read(wrapperRef).toString("utf8")),
        "wrapper"
      );
      expect(wrapper.raw_result_ref).toEqual(rawRef);
      expect(wrapper.receipt_ref).toEqual(record.host_receipt_ref);
      const receipt = validateSkillSchema(
        HostOperationReceiptV1Schema,
        JSON.parse(f.store.read(required(record.host_receipt_ref)).toString("utf8")),
        "receipt"
      );
      expect(receipt.result_sha256).toBe(rawRef.content_digest);
      expect(receipt.output_bytes).toBe(rawRef.byte_length);
      const platform = validateSkillSchema(
        HostOperationResultV1Schema,
        JSON.parse(f.store.read(required(record.platform_result_ref)).toString("utf8")),
        "platform result"
      );
      expect(platform.operation_result_ref).toEqual(rawRef);
      expect(canonicalJson(platform)).not.toContain(wrapperRef.artifact_id);
      expect(
        f.checkpointer
          .events(f.runId)
          .filter((event) => event.eventType === "host_operation_consumed")
      ).toHaveLength(1);
      expect(f.checkpointer.loadRun(d.identity).selectedArtifacts).toContainEqual(wrapperRef);
      expect(
        await f.owner(effectAdapter(count)).dispatch(f.engine, d, new AbortController().signal)
      ).toMatchObject({ action: "status" });
      expect(count.submitted).toBe(1);
    }
  );
  it("makes wrapper plans and prior settled evidence immutable, and rejects forged wrapper coordinates", async () => {
    using f = new HostEffectFixture();
    const d = f.start();
    await expect(
      f
        .owner(effectAdapter(counter()), (point) => {
          if (point === "after_wrapper_plan") throw new HostOperationSimulatedCrashError(point);
        })
        .dispatch(f.engine, d, new AbortController().signal)
    ).rejects.toThrow();
    const record = required(f.checkpointer.hostOperationCallsForRun(f.runId)[0]);
    const state = new HostOperationStateOwner(f.checkpointer, f.store);
    const { result_wrapper: _removed, ...withoutWrapper } = record;
    expect(() => state.transition(record, validateHostOperationCallRecord(withoutWrapper))).toThrow(
      /immutable/u
    );
    const wrapper = required(record.result_wrapper);
    expect(() =>
      state.transition(
        record,
        validateHostOperationCallRecord({
          ...record,
          result_wrapper: { ...wrapper, plan: { ...wrapper.plan, operation_id: "changed-plan" } },
        })
      )
    ).toThrow(/immutable/u);
    await f.owner(effectAdapter(counter())).dispatch(f.engine, d, new AbortController().signal);
    const consumed = required(f.checkpointer.hostOperationCallsForRun(f.runId)[0]);
    expect(() =>
      verifyHostResultWrapper(f.store, {
        ...consumed,
        result_wrapper: {
          ...required(consumed.result_wrapper),
          ref: required(consumed.operation_result_ref),
        },
      })
    ).toThrow();
  });
  it("does not overwrite a durable parent selection changed after continuation preparation", async () => {
    using f = new HostEffectFixture();
    const d = f.start(),
      count = counter();
    const consume = f.checkpointer.consumeHostOperationCall.bind(f.checkpointer);
    const fence = vi
      .spyOn(f.checkpointer, "consumeHostOperationCall")
      .mockImplementationOnce((input) => {
        const current = f.checkpointer.loadRun(d.identity);
        current.playbookData.revoked = true;
        f.checkpointer.saveRun(current, "fixture_revocation", {});
        return consume(input);
      });
    await expect(
      f.owner(effectAdapter(count)).dispatch(f.engine, d, new AbortController().signal)
    ).rejects.toThrow(/parent selections/u);
    fence.mockRestore();
    expect(f.checkpointer.loadRun(d.identity).playbookData.revoked).toBe(true);
    expect(required(f.checkpointer.hostOperationCallsForRun(f.runId)[0]).lifecycle).toBe("settled");
    f.reopen();
    await f.owner(effectAdapter(count)).dispatch(f.engine, d, new AbortController().signal);
    expect(f.checkpointer.loadRun(d.identity).playbookData.revoked).toBe(true);
    expect(count.submitted).toBe(1);
  });
  it("runs the retained raw-decode adapter through the real protocol, recovering its post-receipt result without re-decoding", async () => {
    const declaration = {
      ...effectDeclaration(),
      request: RAW_MEDIA_REQUEST_CONTRACT,
      result: RAW_MEDIA_RESULT_CONTRACT,
      output_contracts: [MEDIA_FRAME_CONTRACT, MEDIA_PCM_CONTRACT],
      max_input_bytes: MEDIA_POLICY.max_input_bytes + 65_536,
      max_output_bytes: MEDIA_POLICY.max_output_bytes,
      recovery_semantics: "disposable_v1" as const,
      cancellation_semantics: "local_abort_only_v1" as const,
    };
    using f = new HostEffectFixture(declaration);
    const scratch = join(f.root, "scratch");
    mkdirSync(scratch, { mode: 0o700 });
    const runner = new ConfinedMediaRunner({
      scratch_root: scratch,
      max_runtime_bytes: 65_536,
      bubblewrap: { path: "/fixture-not-executed", sha256: sha256("fixture") },
      prlimit: { path: "/fixture-not-executed", sha256: sha256("fixture") },
      ffmpeg: { source: "/fixture-not-executed", target: "/bin/ffmpeg", sha256: sha256("fixture") },
      ffprobe: {
        source: "/fixture-not-executed",
        target: "/bin/ffprobe",
        sha256: sha256("fixture"),
      },
      runtime_files: [],
    });
    const wav = pcmAsset(),
      pcm = wav.subarray(44);
    let subprocessCalls = 0;
    const processBoundary = vi.spyOn(runner, "run").mockImplementation(async ({ verb }) => {
      subprocessCalls++;
      if (verb === "probe")
        return {
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(
            canonicalJson({
              streams: [
                {
                  index: 0,
                  codec_type: "audio",
                  codec_name: "pcm_s16le",
                  sample_rate: "8000",
                  channels: 1,
                  time_base: "1/8000",
                },
              ],
              packets: [
                { stream_index: 0, pts: 0, dts: 0, duration: 8000, pos: "44", size: "16000" },
              ],
              format: { format_name: "wav" },
            })
          ),
        };
      if (verb === "audio_s16le") return { stderr: Buffer.alloc(0), stdout: pcm };
      throw new Error("unexpected decoder verb");
    });
    const media = f.ref(wav, "penny.effect-fixture-media.v1", "raw-media", "audio/wav"),
      policy = f.ref(MEDIA_POLICY, MEDIA_POLICY.schema_id),
      selection = f.ref(MEDIA_SELECTION, MEDIA_SELECTION.schema_id);
    const inputs = [
      { slot: "media", ref: media },
      { slot: "decode-policy", ref: policy },
      { slot: "frame-selection", ref: selection },
    ];
    const prepared = f.prepare({
      request_schema: RawMediaDecodeRequestV1Schema,
      request: {
        schema_id: RAW_MEDIA_REQUEST_CONTRACT.schema_id,
        schema_version: 1,
        media_ref: media,
        decode_policy_ref: policy,
        frame_selection_ref: selection,
        audio_policy: "measure_pcm",
        required_spans: [
          { start: { numerator: 0, denominator: 1 }, end: { numerator: 1, denominator: 1 } },
        ],
      },
      input_refs: inputs.map((x) => x.ref),
    });
    const d = f.start(prepared, inputs);
    const adapter = createRawMediaDecodeAdapter({
      adapter_id: declaration.adapter_id,
      backend_binding_id: declaration.backend_binding_id,
      backend_key_sha256: f.backend,
      policy: MEDIA_POLICY,
      policy_ref: policy,
      limits: MEDIA_LIMITS,
      runner,
    });
    await expect(
      f
        .owner(adapter, (point) => {
          if (point === "after_receipt") throw new HostOperationSimulatedCrashError(point);
        })
        .dispatch(f.engine, d, new AbortController().signal)
    ).rejects.toThrow(HostOperationSimulatedCrashError);
    expect(subprocessCalls).toBe(2);
    f.reopen();
    await f.owner(adapter).dispatch(f.engine, d, new AbortController().signal);
    expect(subprocessCalls).toBe(2);
    const record = required(f.checkpointer.hostOperationCallsForRun(f.runId)[0]);
    expect(record.disposition?.outcome).toBe("completed");
    verifyHostResultWrapper(f.store, record);
    const evidence = new MediaEvidenceCustody({
      project_id: f.projectId,
      store: f.store,
      checkpointer: f.checkpointer,
      leases: f.leases,
      limits: MEDIA_LIMITS,
      declaration,
      registration_sha256: d.registration_sha256,
      backend_key_sha256: f.backend,
      policy_ref: policy,
    });
    expect(
      evidence.verifySettled(record.operation_record_id, RAW_MEDIA_RESULT_CONTRACT).record
        .host_receipt_ref
    ).toEqual(record.host_receipt_ref);
    processBoundary.mockRestore();
  });
});

describe("durable owner composition and dependency retention", () => {
  it("constructs image authority only from the service's actual selected run, without enabling a workflow or calling a model", () => {
    using f = new HostEffectFixture();
    const env = { PENNY_STATE_ROOT: join(f.root, "service-state") };
    initializePennyState(f.root, { env });
    let models = 0;
    using service = new OrchestrationService({
      projectRoot: f.root,
      env,
      modelClient: {
        async runAgent() {
          models++;
          throw new Error("no provider in this fixture");
        },
      },
    });
    expect(() => service.imageAssetAuthorityForRun("absent")).toThrow(/missing/u);
    const registration = service.engine.registration;
    const c = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: "service-owner",
        session_id: "service-owner",
        playbook: registration.name,
        engine_owner: "typescript",
      },
      goal: "service owner composition",
      constraints: {},
      projectRoot: f.root,
      trustProfile: "trusted-interactive",
      maxSteps: 20,
      registrationContractBinding: {
        schema_version: 1,
        registration_name: registration.name,
        contract_sha256: skillContractSha256(registration.contract),
        registration_sha256: runtimeRegistrationSha256(registration),
      },
    });
    initializeVideogenOwnerSelection(c, {
      project_id: service.config.projectId,
      limits: MEDIA_LIMITS,
      admitted_destination_id: "fixture-local",
      territory: "fixture",
    });
    service.checkpointer.createRun(c, "fixture_owner_initialized", {});
    const authority = service.imageAssetAuthorityForRun(c.identity.run_id);
    expect(() =>
      assertImageAssetOwners(authority, service.artifacts, service.checkpointer)
    ).not.toThrow();
    expect(() => assertImageAssetOwners(authority, f.store, f.checkpointer)).toThrow();
    expect(models).toBe(0);
  });
  it("pins an older producer while an active consumer retains its exact handoff, then prunes both after settlement", () => {
    using f = new HostEffectFixture();
    const d = f.start();
    const producer = RunContext.create({
      identity: { ...d.identity, run_id: "older-producer", session_id: "older-producer" },
      goal: "retained producer",
      constraints: {},
      projectRoot: f.root,
      trustProfile: "trusted-interactive",
      maxSteps: 20,
      registrationContractBinding: {
        schema_version: 1,
        registration_name: f.registration.name,
        contract_sha256: skillContractSha256(f.registration.contract),
        registration_sha256: runtimeRegistrationSha256(f.registration),
      },
    });
    const finish = (c: RunContext) => {
      c.status = "incomplete";
      c.pendingDirective = null;
      c.terminalDirective = {
        schema_version: 2,
        action: "incomplete",
        identity: c.identity,
        status: "incomplete",
        met: false,
        result: { fixture: "settled" },
        artifacts: c.selectedArtifacts,
        unresolved: ["fixture only"],
      };
    };
    finish(producer);
    f.checkpointer.createRun(producer, "fixture_producer_settled", {});
    const source = f.ref({ value: "exact retained bytes" });
    const handoff = f.store.persist({
      metadata: {
        ...f.store.metadata(source),
        run_id: producer.identity.run_id,
        operation_id: "retained-handoff",
      },
      content: f.store.read(source),
    });
    const consumer = f.checkpointer.loadRun(d.identity);
    consumer.selectedArtifacts.push(handoff);
    f.checkpointer.saveRun(consumer, "fixture_handoff_selected", {});
    using retention = new Checkpointer(join(f.root, "control.db"), undefined, {
      projectId: f.projectId,
      maxRetainedRuns: 0,
    });
    expect(retention.pruneTerminalRuns()).toEqual([]);
    expect(retention.hasRunById(producer.identity.run_id)).toBe(true);
    finish(consumer);
    f.checkpointer.saveRun(consumer, "fixture_consumer_settled", {});
    expect(new Set(retention.pruneTerminalRuns())).toEqual(
      new Set([producer.identity.run_id, d.identity.run_id])
    );
    expect(f.store.read(handoff)).toEqual(f.store.read(source));
  });
});
