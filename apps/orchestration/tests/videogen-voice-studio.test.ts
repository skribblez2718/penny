import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VoiceStudioReadinessV1Schema } from "../dist/videogen/voice-studio-contracts.js";
import { describe, expect, it, vi } from "vitest";
import { MediaEvidenceCustody } from "../dist/videogen/media-evidence.js";
import { AudioSourceDecodeCustody } from "../dist/videogen/audio-sources.js";
import { Checkpointer } from "../dist/checkpointer.js";
import { RunContext } from "../dist/context.js";
import { VoiceStudioAuthority } from "../dist/videogen/voice-studio-authority.js";
import {
  readVideogenOwnerSelection,
  VideogenOwnerSelection,
} from "../dist/videogen/owner-selection.js";
import { sameRef } from "../dist/videogen/bounds.js";
import { type ArtifactRef } from "../dist/contracts.js";
import { VoiceFixture, type VoiceMode } from "./helpers/videogen-voice-fixture.js";
import { required } from "./helpers/videogen-media-fixtures.js";
import {
  HostOperationSimulatedCrashError,
  type HostOperationFaultPointV1,
} from "../dist/host-operations/owner.js";
import { decodeVoiceFixture } from "./helpers/videogen-voice-decode-fixture.js";
import { canonicalJson } from "../dist/canonical-json.js";
import {
  validateVoiceStudioTransport,
  VoiceStudioTransport,
} from "../dist/videogen/voice-studio-transport.js";
import { measureVoiceLoudness } from "../dist/videogen/voice-audio-meter.js";
import { createVoiceStudioDeclaration } from "../dist/videogen/voice-studio-adapter.js";

describe("VG-WP-013 provider-free Voice Studio transport and real owner", () => {
  it("captures exact approved script/voice, all chunks, canonical non-silent WAV and honest unavailable alignment", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const owner = await f.owner(),
      d = required(f.directive);
    await owner.dispatch(f.engine, d);
    expect(f.record().lifecycle).toBe("consumed");
    expect(f.record().disposition?.outcome).toBe("completed");
    expect(f.calls.filter((c) => c === "POST /api/tts/generate")).toHaveLength(1);
    expect(f.bodies).toEqual([
      { source_text: f.narration.source_text, voice_profile_id: f.voice.id },
      { narration_item_id: f.narration.id, voice_profile_id: f.voice.id },
    ]);
    const captured = f.custody().capture(f.record().operation_record_id);
    expect(f.store.read(captured.media_ref)).toEqual(f.wav);
    expect(captured.media_ref.content_schema).toBeUndefined();
    expect(captured.sync_route).toBe("alignment_unavailable");
    const timing: unknown = JSON.parse(f.store.read(captured.timing_unavailable_ref).toString());
    expect(timing).toMatchObject({
      alignment: "unavailable",
      sync_route: "blocked",
      measured_samples: 8000,
      uncertain_line_ids: ["line-1"],
    });
    expect(f.custody().capture(f.record().operation_record_id)).toEqual(captured);
    await owner.dispatch(f.engine, d);
    expect(f.calls.filter((c) => c === "POST /api/tts/generate")).toHaveLength(1);
  });
  it.each<VoiceMode>([
    "fallback",
    "partial",
    "errored",
    "lost",
    "wrong-job",
    "ambiguous-start",
    "busy",
    "silent",
    "bad-coverage",
    "bad-wav",
    "voice-race",
    "ambiguous-create",
    "readback-drift",
  ])("fails closed for %s without partial export or fallback", async (mode) => {
    await using f = new VoiceFixture();
    await f.start();
    f.mode = mode;
    await (await f.owner()).dispatch(f.engine, required(f.directive));
    const j = f.record();
    expect(j.disposition?.outcome).not.toBe("completed");
    expect(j.operation_result_ref).toBeNull();
    expect(j.output_artifacts).toEqual([]);
    expect(f.calls.filter((c) => c === "POST /api/tts/generate").length).toBeLessThanOrEqual(1);
    if (!["silent", "bad-wav"].includes(mode))
      expect(f.calls.some((c) => c.includes("/result/"))).toBe(false);
    if (
      [
        "lost",
        "wrong-job",
        "ambiguous-start",
        "busy",
        "ambiguous-create",
        "readback-drift",
      ].includes(mode)
    )
      expect(j.disposition?.lease_disposition).toBe("quarantined");
    expect(() => f.custody().capture(j.operation_record_id)).toThrow();
  });
  it.each<HostOperationFaultPointV1>([
    "before_submit",
    "after_submit_before_remote_checkpoint",
    "after_remote_checkpoint",
    "after_fetch",
    "after_persist",
    "before_consume",
    "after_raw_artifacts",
    "after_receipt",
    "after_wrapper_plan",
    "after_wrapper_persist",
    "after_wrapper",
    "after_consume",
  ])("recovers exact journal at %s without repeat start", async (point) => {
    await using f = new VoiceFixture();
    await f.start();
    let crashed = false;
    const owner = await f.owner((p) => {
      if (!crashed && p === point) {
        crashed = true;
        throw new HostOperationSimulatedCrashError(p);
      }
    });
    await expect(owner.dispatch(f.engine, required(f.directive))).rejects.toThrow("simulated");
    expect(crashed).toBe(true);
    const calls = f.calls.filter((c) => c === "POST /api/tts/generate").length;
    if (point === "after_fetch") f.mode = "lost";
    await f.reopen();
    await (await f.owner()).dispatch(f.engine, required(f.directive));
    if (point === "before_submit") expect(f.record().disposition?.outcome).toBe("completed");
    else expect(f.calls.filter((c) => c === "POST /api/tts/generate")).toHaveLength(calls);
    if (point === "after_submit_before_remote_checkpoint")
      expect(f.record().disposition?.lease_disposition).toBe("quarantined");
    else expect(f.record().disposition?.outcome).toBe("completed");
    if (
      ["after_fetch", "after_persist", "before_consume", "after_remote_checkpoint"].includes(point)
    )
      expect(f.record().disposition?.outcome).toBe("completed");
  });
  it("does not accept health-only readiness and changes no remote state", async () => {
    await using f = new VoiceFixture();
    await f.start();
    f.clearReadiness();
    await expect((await f.owner()).dispatch(f.engine, required(f.directive))).rejects.toThrow(
      "observation custody"
    );
    expect(f.calls).toEqual([]);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });
  it("uses concrete collection custody, not caller maps or a copied fixed-issuer receipt", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const a = required(f.authority),
      b = a.bindings,
      old = a.readiness();
    for (const observations of [{ ...b.observations }, new Proxy(b.observations, {})])
      expect(() => {
        Reflect.construct(VoiceStudioAuthority, [{ ...b, observations }]);
      }).toThrow("concrete");
    f.readiness.set(
      required(f.profile_ref).content_digest,
      f.json({ ...old, process_epoch: "caller-forgery" }, old.schema_id)
    );
    expect(a.readiness()).toEqual(old);
    const c = required(f.checkpointer.loadRunById(f.run_id));
    const receipt = required(
      c.selectedArtifacts.find(
        (r) => r.content_schema?.schema_id === "penny.videogen-voice-observation-receipt.v1"
      )
    );
    const metadata = f.store.metadata(receipt);
    const copied = f.store.persist({
      metadata: { ...metadata, operation_id: "copied-observation-receipt" },
      content: f.store.read(receipt),
    });
    c.selectedArtifacts = c.selectedArtifacts.filter((r) => r.artifact_id !== receipt.artifact_id);
    c.selectedArtifacts.push(copied);
    f.checkpointer.saveRun(c, "fixture_copied_observation", {});
    expect(() => a.readiness()).toThrow("custody unavailable");
    await expect((await f.owner()).dispatch(f.engine, required(f.directive))).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it("declines unsupported health-only process exports before any HTTP or journal work", async () => {
    await using f = new VoiceFixture();
    await f.start();
    f.clearReadiness();
    writeFileSync(f.observation_path, canonicalJson({ readiness: { health: "ok" }, coverage: [] }));
    await expect(
      required(f.observations).collect("readiness", new AbortController().signal)
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });
  it("fences raw observation collection across awaits before the next HTTP and retains no replacement selection", async () => {
    await using f = new VoiceFixture();
    await f.start();
    f.clearReadiness();
    f.beforeResponse = (route) => {
      if (route === `/api/voices/${f.voice.id}`) {
        const c = required(f.checkpointer.loadRunById(f.run_id));
        c.selectedArtifacts = c.selectedArtifacts.filter(
          (r) => r.artifact_id !== required(f.request).budget_reservation_ref.artifact_id
        );
        f.checkpointer.saveRun(c, "fixture_changed_observation_source", {});
      }
    };
    await expect(
      required(f.observations).collect("readiness", new AbortController().signal)
    ).rejects.toThrow();
    expect(f.calls).toEqual([`GET /api/voices/${f.voice.id}`]);
    expect(
      required(f.checkpointer.loadRunById(f.run_id)).selectedArtifacts.some(
        (r) => r.content_schema?.schema_id === "penny.videogen-voice-observation-receipt.v1"
      )
    ).toBe(false);
  });
  it("does not replay or consume settled voice evidence after concrete observation selection changes", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const owner = await f.owner();
    await owner.dispatch(f.engine, required(f.directive));
    const before = f.record(),
      count = f.calls.length;
    f.clearReadiness();
    await expect(owner.dispatch(f.engine, required(f.directive))).rejects.toThrow(
      "observation custody"
    );
    expect(f.calls).toHaveLength(count);
    expect(f.record()).toEqual(before);
    expect(before.host_receipt_ref).not.toBeNull();
  });
  it("rechecks revoked rights on replay before cache or network adoption", async () => {
    await using f = new VoiceFixture();
    await f.start();
    await (await f.owner()).dispatch(f.engine, required(f.directive));
    const voice = required(
      f.rights_index.find(
        (r) => r.subject_ref.artifact_id === required(f.request).voice_ref.artifact_id
      )
    );
    voice.status = "revoked";
    f.commitRights();
    const count = f.calls.length;
    await expect((await f.owner()).dispatch(f.engine, required(f.directive))).rejects.toThrow();
    expect(f.calls).toHaveLength(count);
  });
  it("cancels only exact durable job and quarantines cooperative 2xx without stop proof", async () => {
    await using f = new VoiceFixture();
    await f.start();
    f.mode = "cancel-unproven";
    const owner = await f.owner(),
      active = owner.dispatch(f.engine, required(f.directive));
    while (!f.calls.some((c) => c.includes("/tts/jobs/")))
      await new Promise((r) => setTimeout(r, 2));
    owner.cancelRun(f.run_id);
    await active;
    expect(f.calls.filter((c) => c.includes("/tts/cancel/"))).toEqual([
      "POST /api/tts/cancel/job-fixture",
    ]);
    expect(f.record().disposition?.lease_disposition).toBe("quarantined");
    expect(f.calls.some((c) => c.includes("/result/"))).toBe(false);
  });
  it("refuses caller-controlled URL, credentials, nonlocal HTTP and unsafe TLS configuration", () => {
    for (const origin of [
      "http://example.invalid",
      "http://127.0.0.1/path",
      "http://user:pass@127.0.0.1",
      "http://127.0.0.1?x",
      "file:///tmp/test",
      "http://127.0.0.2",
    ])
      expect(() => validateVoiceStudioTransport({ origin, mode: "isolated_loopback" })).toThrow();
    expect(() =>
      validateVoiceStudioTransport({
        origin: "https://127.0.0.1",
        mode: "trusted_tls",
        servername: "127.0.0.1",
        ca_pem: "fixture",
        peer_cert_sha256: "1".repeat(64),
      })
    ).toThrow();
  });
  it("has no preacceptance retry grant, rejects unregistered routes and measures rather than asserts speech", async () => {
    await using f = new VoiceFixture();
    await f.start();
    expect(f.declaration.max_pre_acceptance_retries).toBe(0);
    expect(
      createVoiceStudioDeclaration({
        backend_binding_id: "test",
        lease_profile_id: "test",
        lease_duration_ms: 100,
        lease_renew_after_ms: 10,
        queue_inactivity_ms: 50,
        operation_inactivity_ms: 100,
        max_request_bytes: 100,
        max_input_bytes: 100,
        max_output_bytes: 100,
        max_progress_events: 1,
      }).operation_kind
    ).toBe("voice_job");
    const t = new VoiceStudioTransport(
      { origin: f.origin, mode: "isolated_loopback" },
      required(f.profile).limits
    );
    await expect(
      t.json("GET", "/api/system/preload", new AbortController().signal)
    ).rejects.toThrow();
    expect(measureVoiceLoudness(f.wav.subarray(44), 1, 8000).loudness_lufs).toBeGreaterThan(-30);
    expect(() => measureVoiceLoudness(Buffer.alloc(16000), 1, 8000)).toThrow();
    expect(canonicalJson(f.declaration)).not.toContain(f.origin);
  });
  it("materializes the sole AudioSourceV1 via real settled decode custody, without forged timing or speech", async () => {
    await using f = new VoiceFixture(["First fixture line.", "Second fixture line."]);
    await f.start();
    await (await f.owner()).dispatch(f.engine, required(f.directive));
    expect(f.record().disposition?.outcome).toBe("completed");
    const custody = f.custody(),
      capture = custody.capture(f.record().operation_record_id);
    const rights = f.rights(
      capture.media_ref,
      "voice",
      [required(f.request).consent_ref],
      capture.provenance_ref
    );
    const decoded = await decodeVoiceFixture(f, capture.media_ref);
    const input = {
      operation_record_id: f.record().operation_record_id,
      decode_operation_record_id: decoded.operation_record_id,
      decode: decoded.decode,
      audio_custody: decoded.audio,
      host: f.host(),
      rights_ref: rights,
    };
    const result = custody.materialize(input);
    const source: unknown = JSON.parse(f.store.read(result.result.audio_source_ref).toString());
    expect(source).toMatchObject({
      source_kind: "voice_studio",
      codec: "canonical_pcm",
      channels: "mono",
      sample_rate: { numerator: 8000, denominator: 1 },
      media_ref: capture.media_ref,
    });
    const evidence: unknown = JSON.parse(f.store.read(result.result.audio_evidence_ref).toString());
    expect(evidence).toMatchObject({
      unassessed: ["intelligibility", "identity", "word_alignment"],
      speech_intervals: [],
      sync_offsets: [],
    });
    expect(result.result).toMatchObject({
      timing_ref: null,
      sync_route: "alignment_unavailable",
      source_admission: "admitted",
      production_admission: "blocked",
    });
    expect(result.result.measured_meters).toHaveLength(7);
    expect(result.result.measured_meters.every((m) => m.amount === 2)).toBe(true);
    expect(custody.materialize(input)).toEqual(result);
    const { host: staleHost, ...withoutProjection } = input;
    expect(custody.materialize(withoutProjection)).toEqual(result);
    await f.reopen();
    const rebound = {
      ...decoded.bindings,
      store: f.store,
      checkpointer: f.checkpointer,
      leases: f.leases,
    };
    const reopenedInput = {
      ...input,
      host: f.host(),
      decode: new MediaEvidenceCustody(rebound),
      audio_custody: new AudioSourceDecodeCustody(rebound),
    };
    expect(f.custody().materialize(reopenedInput)).toEqual(result);
    // A stale compatibility host must never restore current rights to already captured bytes.
    required(f.rights_index.find((row) => sameRef(row.subject_ref, capture.media_ref))).status =
      "revoked";
    f.commitRights();
    expect(() =>
      f.custody().materialize({ ...reopenedInput, host: { ...staleHost, store: f.store } })
    ).toThrow("not admitted");
    await f.reopen();
    const reboundAgain = {
      ...rebound,
      store: f.store,
      checkpointer: f.checkpointer,
      leases: f.leases,
    };
    expect(() =>
      f.custody().materialize({
        ...reopenedInput,
        host: f.host(),
        decode: new MediaEvidenceCustody(reboundAgain),
        audio_custody: new AudioSourceDecodeCustody(reboundAgain),
      })
    ).toThrow("not admitted");
    expect(f.calls.filter((c) => c === "POST /api/tts/generate")).toHaveLength(1);
  });
  it("rejects changed consent, unknown keys and changed script/chunk operands at the use boundary", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const a = required(f.authority),
      r = required(f.request),
      d = required(f.directive);
    expect(() =>
      a.parseRequest(Buffer.from(canonicalJson({ ...r, endpoint: f.origin })))
    ).toThrow();
    for (const changed of [
      { ...r, consent_ref: f.raw("other consent") },
      { ...r, voice_id: "111111111111" },
      { ...r, expected_chunk_ids: ["missing"] },
      { ...r, script_ref: r.voice_ref },
      { ...r, scope: "preview" as const },
    ])
      expect(() => a.validateRequest(changed, d)).toThrow();
    expect(f.calls).toEqual([]);
  });
  it.each(["missing", "corrupt"])(
    "never regenerates a fetched WAV when its durable cache is %s",
    async (mode) => {
      await using f = new VoiceFixture();
      await f.start();
      await expect(
        (
          await f.owner((point) => {
            if (point === "after_fetch") throw new HostOperationSimulatedCrashError(point);
          })
        ).dispatch(f.engine, required(f.directive))
      ).rejects.toThrow();
      const cache = path.join(f.root, "cache", `${required(f.directive).request_sha256}.json`);
      if (mode === "missing") unlinkSync(cache);
      else writeFileSync(cache, "{}");
      f.mode = "lost";
      await f.reopen();
      const calls = f.calls.length;
      await (await f.owner()).dispatch(f.engine, required(f.directive));
      expect(f.record().disposition?.lease_disposition).toBe("quarantined");
      expect(
        f.calls.slice(calls).some((x) => x.includes("/result/") || x === "POST /api/tts/generate")
      ).toBe(false);
      expect(f.record().output_artifacts).toEqual([]);
    }
  );
  it.each(["lost", "epoch"])(
    "quarantines accepted %s after host restart without a second narration/start",
    async (mode) => {
      await using f = new VoiceFixture();
      await f.start();
      await expect(
        (
          await f.owner((point) => {
            if (point === "after_remote_checkpoint")
              throw new HostOperationSimulatedCrashError(point);
          })
        ).dispatch(f.engine, required(f.directive))
      ).rejects.toThrow();
      if (mode === "lost") f.mode = "lost";
      else {
        const profile = required(f.profile_ref),
          ref = required(f.readiness.get(profile.content_digest));
        const ready = required(f.authority).read(
          ref,
          VoiceStudioReadinessV1Schema,
          "penny.videogen-voice-studio-readiness.v1"
        );
        f.readiness.set(
          profile.content_digest,
          f.json({ ...ready, process_epoch: "new-epoch" }, ready.schema_id)
        );
      }
      await f.reopen();
      const n = f.calls.filter((x) => x.startsWith("POST")).length;
      await (await f.owner()).dispatch(f.engine, required(f.directive));
      expect(f.calls.filter((x) => x.startsWith("POST"))).toHaveLength(n);
      expect(f.record().disposition?.lease_disposition).toBe("quarantined");
    }
  );
  it("uses the real shared physical process lease and GPU reservation, not an application mutex", async () => {
    await using f = new VoiceFixture();
    await f.start();
    await expect(
      (
        await f.owner((point) => {
          if (point === "after_remote_checkpoint")
            throw new HostOperationSimulatedCrashError(point);
        })
      ).dispatch(f.engine, required(f.directive))
    ).rejects.toThrow();
    expect(f.competingReservation(true).lease.kind).toBe("waiting");
    const other = f.competingReservation(false);
    expect(other.lease.kind).toBe("acquired");
    expect(other.capacity?.state).toBe("queued");
    expect(f.capacity_authority.inspect(f.record().operation_record_id)?.state).toBe("held");
    expect(f.calls.filter((x) => x === "POST /api/tts/generate")).toHaveLength(1);
  });
  it("requires the original request-before-intent pair before even creating a journal or doing HTTP", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const d = required(f.directive);
    const { effect_identity: _identity, effect_intent_ref: _intent, ...missing } = d;
    const owner = await f.owner();
    for (const bad of [
      missing,
      { ...d, effect_intent_ref: required(f.request).script_ref },
      { ...d, operation_id: "wrong-operation" },
      { ...d, effect_identity: { ...required(d.effect_identity), visit: 2 } },
    ])
      await expect(owner.dispatch(f.engine, bad)).rejects.toThrow();
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.declaration.effect_protocol).toBe("request_intent_v1");
  });
});

/** A snapshot is evidence only. Mutation helpers below commit through the real checkpoint owner. */
function deselect(f: VoiceFixture, ref: ArtifactRef): void {
  const context = required(f.checkpointer.loadRunById(f.run_id));
  context.selectedArtifacts = context.selectedArtifacts.filter((x) => !sameRef(x, ref));
  f.checkpointer.saveRun(context, "fixture_deselection", {});
}
function revokeVoice(f: VoiceFixture): void {
  const row = required(
    f.rights_index.find((x) => sameRef(x.subject_ref, required(f.request).voice_ref))
  );
  row.status = "revoked";
  f.commitRights();
}
describe("Voice Studio live concrete checkpoint integration", () => {
  it("refuses structural/copied/proxied selections, another project and a different concrete checkpointer", async () => {
    await using f = new VoiceFixture(),
      other = new VoiceFixture();
    await f.start();
    await other.start();
    const a = required(f.authority),
      b = a.bindings,
      owner = b.owner;
    const projection = readVideogenOwnerSelection(owner);
    const forged: unknown = Object.create(VideogenOwnerSelection.prototype);
    for (const bad of [projection, { ...owner }, forged, new Proxy(owner, {})])
      expect(() => {
        Reflect.construct(VoiceStudioAuthority, [{ ...b, owner: bad }]);
      }).toThrow();
    expect(() => new VoiceStudioAuthority({ ...b, owner: other.ownerSelection() })).toThrow(
      "binding mismatch"
    );
    using second = Checkpointer.openExisting(f.checkpointer.dbPath, undefined, {
      projectId: f.project_id,
    });
    expect(() => new VoiceStudioAuthority({ ...b, checkpointer: second })).toThrow(
      "binding mismatch"
    );
    const copied: unknown = { ...f.checkpointer };
    expect(() => {
      Reflect.construct(VideogenOwnerSelection, [
        { store: f.store, checkpointer: copied, project_id: f.project_id, run_id: f.run_id },
      ]);
    }).toThrow();
    // Frozen capabilities cannot be replaced with a structural authority even with its old fields.
    const fakeAuthority: unknown = Object.create(VoiceStudioAuthority.prototype, {
      bindings: { value: b },
    });
    expect(() => VoiceStudioAuthority.prototype.current.call(fakeAuthority)).toThrow();
    expect(f.calls).toEqual([]);
  });
  it("refuses a different run even with copied original selections and gate evidence", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const original = required(f.checkpointer.loadRunById(f.run_id));
    const copy = RunContext.fromSnapshot({
      ...original.snapshot(),
      pending_directive: null,
      identity: { ...original.identity, run_id: "other-run" },
    });
    copy.pendingDirective = null;
    f.checkpointer.createRun(copy, "copied_fixture_not_authority", {});
    const owner = new VideogenOwnerSelection({
      store: f.store,
      checkpointer: f.checkpointer,
      project_id: f.project_id,
      run_id: copy.identity.run_id,
    });
    expect(() => new VoiceStudioAuthority({ ...required(f.authority).bindings, owner })).toThrow(
      "same concrete"
    );
    expect(f.calls).toEqual([]);
  });
  it.each(["gate", "proposal", "approved-intent", "ledger", "budget"] as const)(
    "rechecks actual %s deselection, not an old projection",
    async (operand) => {
      await using f = new VoiceFixture();
      await f.start();
      const a = required(f.authority),
        r = required(f.request),
        snapshot = a.current();
      const refs = {
        gate: r.gate_decision_ref,
        proposal: required(snapshot.gate.current_presented.find((x) => x.role === "asset-intent"))
          .ref,
        "approved-intent": r.asset_intent_ref,
        ledger: r.selected_ledger_ref,
        budget: r.budget_reservation_ref,
      };
      a.validateRequest(r, required(f.directive));
      deselect(f, refs[operand]);
      expect(snapshot.gate.current_approvals).toHaveLength(1);
      expect(() => a.validateRequest(r, required(f.directive))).toThrow();
      await f.reopen();
      expect(() => required(f.authority).validateRequest(r, required(f.directive))).toThrow();
      expect(f.calls).toEqual([]);
    }
  );
  it("never trusts a mutated current() projection; current rights survive restart and use the wall clock", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const a = required(f.authority),
      r = required(f.request),
      stale = a.current();
    revokeVoice(f);
    // Editing an old projection does not write the owner selection back.
    const copiedRow = required(
      stale.rights.current_rights.find((x) => sameRef(x.subject_ref, r.voice_ref))
    );
    copiedRow.status = "cleared";
    expect(() => a.validateRequest(r, required(f.directive))).toThrow("revoked");
    await f.reopen();
    expect(() => required(f.authority).validateRequest(r, required(f.directive))).toThrow(
      "revoked"
    );
    required(f.rights_index.find((x) => sameRef(x.subject_ref, r.voice_ref))).status = "cleared";
    f.commitRights();
    required(f.authority).validateRequest(r, required(f.directive));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2028-01-01T00:00:00Z"));
      expect(() => required(f.authority).validateRequest(r, required(f.directive))).toThrow(
        "time mismatch"
      );
    } finally {
      vi.useRealTimers();
    }
    expect(f.calls).toEqual([]);
  });
  it.each([
    "/api/voices/abcdef123456/sample",
    "/api/narrations",
    "/api/narrations/item-fixture",
    "/api/tts/generate",
    "/api/tts/jobs/job-fixture",
    "/api/tts/result/item-fixture.wav",
  ])("rechecks revocation across awaited %s", async (route) => {
    await using f = new VoiceFixture();
    await f.start();
    let revoked = false;
    f.beforeResponse = (current) => {
      if (!revoked && current === route) {
        revoked = true;
        revokeVoice(f);
      }
    };
    // The owner can return a negative disposition or reject after the durable refusal. Neither may admit output.
    await Promise.allSettled([(await f.owner()).dispatch(f.engine, required(f.directive))]);
    expect(revoked).toBe(true);
    const record = f.record();
    expect(record.disposition?.outcome).not.toBe("completed");
    expect(record.operation_result_ref).toBeNull();
    expect(record.output_artifacts).toEqual([]);
    expect(f.calls.filter((x) => x === "POST /api/tts/generate")).toHaveLength(
      route.startsWith("/api/tts/") ? 1 : 0
    );
    expect(() => f.custody().capture(record.operation_record_id)).toThrow();
  });
  it("rejects accepted recovery and captured-byte adoption after actual owner revocation", async () => {
    await using f = new VoiceFixture();
    await f.start();
    await expect(
      (
        await f.owner((point) => {
          if (point === "after_remote_checkpoint")
            throw new HostOperationSimulatedCrashError(point);
        })
      ).dispatch(f.engine, required(f.directive))
    ).rejects.toThrow("simulated");
    revokeVoice(f);
    await f.reopen();
    const count = f.calls.length;
    await expect((await f.owner()).dispatch(f.engine, required(f.directive))).rejects.toThrow();
    expect(f.calls).toHaveLength(count);
    expect(() => f.custody().capture(f.record().operation_record_id)).toThrow();
  });
  it("refuses captured-byte adoption after the parent becomes terminal", async () => {
    await using f = new VoiceFixture();
    await f.start();
    await (await f.owner()).dispatch(f.engine, required(f.directive));
    f.custody().capture(f.record().operation_record_id);
    const parent = required(f.checkpointer.loadRunById(f.run_id));
    parent.status = "cancelled";
    f.checkpointer.saveRun(parent, "fixture_cancel_parent", {});
    expect(() => f.custody().capture(f.record().operation_record_id)).toThrow();
    await f.reopen();
    expect(() => f.custody().capture(f.record().operation_record_id)).toThrow();
  });
  it("does not consume or capture a completed WAV without actual final meters", async () => {
    await using f = new VoiceFixture();
    await f.start();
    f.measure = () => {};
    await expect((await f.owner()).dispatch(f.engine, required(f.directive))).rejects.toThrow();
    expect(f.calls.filter((x) => x === "POST /api/tts/generate")).toHaveLength(1);
    expect(f.record().lifecycle).not.toBe("consumed");
    expect(() => f.custody().capture(f.record().operation_record_id)).toThrow();
    await f.reopen();
    expect(() => f.custody().capture(f.record().operation_record_id)).toThrow();
  });
});
