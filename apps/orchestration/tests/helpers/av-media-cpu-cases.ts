import { ArtifactStore } from "../../dist/artifact-store.js";
import { HostOperationSimulatedCrashError } from "../../dist/host-operations/owner.js";
import { AvOwnerFixture } from "./av-media-owner-fixture.js";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfinedMediaRunner } from "../../dist/host-operations/confined-media-runner.js";
import { decodeAvMediaBytes } from "../../dist/videogen/av-media-decode.js";
import { avVideoStep, validateAvMediaResult } from "../../dist/videogen/av-media-contracts.js";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { inspectAvMediaMp4 } from "../../dist/videogen/av-media-container.js";
import { decodeMediaBytes } from "../../dist/videogen/media-decode.js";
import { validateCanonicalPng } from "../../dist/png-media.js";
import {
  AvProbeSchema,
  parseAvJson,
  validateAvProbe,
  AvFramesSchema,
  validateAvFrames,
  validateAvDecodeLog,
} from "../../dist/videogen/av-media-evidence.js";
import {
  MEDIA_LIMITS,
  MEDIA_SELECTION,
  MediaFixture,
  suppliedCpuBindings,
  required,
  canonicalExecutable,
} from "./videogen-media-fixtures.js";
import {
  AV_POLICY,
  avRequest,
  syntheticAv,
  locateAvBox,
  avFixturePolicy,
} from "./av-media-fixtures.js";

// Registered only by the existing guarded opt-in CPU suite; never default-collected.
export function registerAvMediaCpuTests(): void {
  describe("REAL host-profile muxed AV decoding (not playback/production)", () => {
    const cases = [
      { policy: AV_POLICY, count: 8, seconds: 1 },
      {
        policy: avFixturePolicy("another-small", 64, 48, { numerator: 25, denominator: 1 }, 10),
        count: 25,
        seconds: 1,
      },
      {
        policy: avFixturePolicy("small-third", 48, 32, { numerator: 12, denominator: 1 }, 10),
        count: 12,
        seconds: 1,
      },
      {
        policy: avFixturePolicy(
          "rational-ntsc",
          80,
          48,
          { numerator: 30000, denominator: 1001 },
          10
        ),
        count: 30,
        seconds: 1,
      },
      {
        policy: avFixturePolicy(
          "rational-film",
          96,
          54,
          { numerator: 24000, denominator: 1001 },
          10
        ),
        count: 24,
        seconds: 1,
      },
      {
        policy: avFixturePolicy("useful-short", 512, 288, { numerator: 25, denominator: 1 }, 21),
        count: 10,
        seconds: 0.4,
      },
    ];
    it.each(cases)(
      "fully decodes independent finite synthetic source $policy.profile.profile_id",
      async ({ policy, count, seconds }) => {
        using f = new MediaFixture();
        const { bindings, fixture_ffmpeg } = suppliedCpuBindings(f.root);
        const runner = new ConfinedMediaRunner(bindings),
          bytes = syntheticAv(f, fixture_ffmpeg, policy, count, seconds);
        const request = avRequest(f, bytes, policy);
        if (seconds === 0.4)
          request.required_spans[0] = {
            start: { numerator: 0, denominator: 1 },
            end: { numerator: 2, denominator: 5 },
          };
        const decoded = await decodeAvMediaBytes({
          runner,
          request,
          bytes,
          policy,
          selection: MEDIA_SELECTION,
          limits: MEDIA_LIMITS,
          signal: new AbortController().signal,
        });
        const layout = inspectAvMediaMp4(bytes, policy);
        expect(decoded.result.profile).toEqual(policy.profile);
        expect(decoded.result.policy_sha256).toBe(sha256(canonicalJson(policy)));
        expect(decoded.result.video.decoded_frame_count).toBe(count);
        expect(decoded.result.video.frame_step).toBe(
          avVideoStep(policy.profile, layout.video.timescale)
        );
        expect(decoded.result.unassessed).toContain("aac_ancillary_payloads");
        expect(decoded.result.qualification).toBe("raw_av_decode_only_not_playback_or_production");
        expect(decoded.result.audio).toMatchObject({
          decoded_access_units: seconds === 1 ? 48 : 20,
          decoded_sample_count: seconds === 1 ? 49152 : 20480,
          sample_rate: 48000,
          timing: "untrimmed_coded_samples_priming_unknown_no_alignment_claim",
        });
        expect(decoded.result.audio.spans).toMatchObject([
          { start_sample: 0, end_sample: seconds * 48000 },
        ]);
        for (const o of decoded.outputs.filter((o) => o.media_type === "image/png"))
          expect(validateCanonicalPng(o.bytes)).toMatchObject({
            width: policy.profile.width,
            height: policy.profile.height,
          });
        expect(
          decoded.outputs.filter((o) => o.media_type === "audio/wav").map((o) => o.bytes.length)
        ).toEqual([seconds * 96000 + 44]);
        expect(() => validateAvMediaResult(decoded.result, policy)).not.toThrow();
        expect(() =>
          validateAvMediaResult(
            { ...decoded.result, profile: { ...policy.profile, profile_id: "drift" } },
            policy
          )
        ).toThrow();
        expect(() =>
          validateAvMediaResult({ ...decoded.result, policy_sha256: sha256("wrong") }, policy)
        ).toThrow();
        expect(readdirSync(f.root).filter((n) => n.startsWith("decode-"))).toEqual([]);
        await expect(
          decodeMediaBytes({
            runner,
            request: f.request(bytes, "video/mp4"),
            bytes,
            policy: f.policy,
            selection: MEDIA_SELECTION,
            limits: MEDIA_LIMITS,
            signal: new AbortController().signal,
          })
        ).rejects.toThrow();
      }
    );
    it("refuses exact policy/rate/dimension and resource drift before starting any decoder", async () => {
      using f = new MediaFixture();
      const { bindings, fixture_ffmpeg } = suppliedCpuBindings(f.root);
      const runner = new ConfinedMediaRunner(bindings),
        bytes = syntheticAv(f, fixture_ffmpeg),
        layout = inspectAvMediaMp4(bytes, AV_POLICY),
        calls = vi.spyOn(runner, "run");
      const reject = async (policy: typeof AV_POLICY, pattern?: RegExp) => {
        const request = avRequest(f, bytes, policy);
        await expect(
          decodeAvMediaBytes({
            runner,
            request,
            bytes,
            policy,
            selection: MEDIA_SELECTION,
            limits: MEDIA_LIMITS,
            signal: new AbortController().signal,
          })
        ).rejects.toThrow(pattern);
        expect(calls).not.toHaveBeenCalled();
      };
      const decodedBytes = 32 * 24 * 4 * 8 + 48 * 2048;
      const exact = {
        ...AV_POLICY,
        limits: {
          ...AV_POLICY.limits,
          max_input_bytes: bytes.length,
          max_width: 32,
          max_height: 24,
          max_pixels: 768,
          max_frames: 8,
          max_samples: 49152,
          max_decoded_bytes: decodedBytes,
          max_duration: { numerator: 128, denominator: 125 },
        },
      };
      expect(() => inspectAvMediaMp4(bytes, exact)).not.toThrow();
      const exactDecoded = await decodeAvMediaBytes({
        runner,
        request: avRequest(f, bytes, exact),
        bytes,
        policy: exact,
        selection: MEDIA_SELECTION,
        limits: MEDIA_LIMITS,
        signal: new AbortController().signal,
      });
      expect(exactDecoded.result.video.decoded_frame_count).toBe(8);
      expect(exactDecoded.result.audio.decoded_sample_count).toBe(49152);
      expect(calls).toHaveBeenCalledTimes(4);
      calls.mockClear();
      for (const limits of [
        { max_input_bytes: bytes.length - 1 },
        { max_width: 31 },
        { max_height: 23 },
        { max_pixels: 767 },
        { max_frames: 7 },
        { max_samples: 49151 },
        { max_decoded_bytes: decodedBytes - 1 },
        { max_duration: { numerator: 1, denominator: 1 } },
        { max_output_bytes: 1000 },
      ])
        await reject({ ...exact, limits: { ...exact.limits, ...limits } });
      for (const profile of [
        { ...AV_POLICY.profile, width: 34 },
        { ...AV_POLICY.profile, height: 26 },
        { ...AV_POLICY.profile, frame_rate: { numerator: 7, denominator: 1 } },
        { ...AV_POLICY.profile, frame_rate: { numerator: 30000, denominator: 1001 } },
        { ...AV_POLICY.profile, video: { ...AV_POLICY.profile.video, level_idc: 21 as const } },
      ])
        await reject({ ...AV_POLICY, profile });
      const request = avRequest(f, bytes);
      await expect(
        decodeAvMediaBytes({
          runner,
          request,
          bytes,
          policy: { ...AV_POLICY, profile: { ...AV_POLICY.profile, profile_id: "renamed" } },
          selection: MEDIA_SELECTION,
          limits: MEDIA_LIMITS,
          signal: new AbortController().signal,
        })
      ).rejects.toThrow(/digest/);
      expect(calls).not.toHaveBeenCalled();
      // All table bytes remain finite; nonintegral timebase cannot be rounded into the policy rate.
      const changed = Buffer.from(bytes);
      changed.writeUInt32BE(layout.video.timescale + 1, locateAvBox(changed, "mdhd").p + 12);
      expect(() => inspectAvMediaMp4(changed, AV_POLICY)).toThrow(/integral/);
    });
    it("rejects container/track/metadata/timing/table and coded corruption adversaries", async () => {
      using f = new MediaFixture();
      const { bindings, fixture_ffmpeg } = suppliedCpuBindings(f.root);
      const runner = new ConfinedMediaRunner(bindings),
        bytes = syntheticAv(f, fixture_ffmpeg);
      const decode = (source: Buffer, policy = AV_POLICY) =>
        decodeAvMediaBytes({
          runner,
          request: avRequest(f, source, policy),
          bytes: source,
          policy,
          selection: MEDIA_SELECTION,
          limits: MEDIA_LIMITS,
          signal: new AbortController().signal,
        });
      const refused = async (source: Buffer) => {
        await expect(decode(source)).rejects.toThrow();
      };
      await refused(readFileSync(path.join(f.root, "av-raw.mp4")));
      await refused(bytes.subarray(0, bytes.length - 1));
      // Both observed muxer encodings are valid only with the exact mono ASC and decode proof.
      for (const nominal of [1, 2]) {
        const changed = Buffer.from(bytes);
        changed.writeUInt16BE(nominal, locateAvBox(changed, "mp4a").p + 16);
        expect(() => inspectAvMediaMp4(changed, AV_POLICY)).not.toThrow();
      }
      for (const nominal of [0, 3]) {
        const changed = Buffer.from(bytes);
        changed.writeUInt16BE(nominal, locateAvBox(changed, "mp4a").p + 16);
        await refused(changed);
      }
      for (const [type, occurrence, offset, value] of [
        ["mvhd", 0, 4, 1],
        ["tkhd", 1, 12, 9],
        ["hdlr", 1, 24, 65],
        ["url ", 1, 3, 0],
        ["stts", 0, 15, 1],
        ["stts", 1, 15, 1],
        ["stco", 1, 8, 0xff],
        ["stsc", 1, 19, 2],
        ["stsz", 1, 15, 0],
        ["avcC", 0, 1, 100],
        ["esds", 0, 10, 0x20],
      ] as const) {
        const changed = Buffer.from(bytes);
        changed[locateAvBox(changed, type, occurrence).p + offset] = value;
        await refused(changed);
      }
      for (const type of ["ctts", "edts", "meta", "uuid", "moof", "sgpd", "sbgp"]) {
        const changed = Buffer.from(bytes);
        changed.write(type, locateAvBox(changed, "stss").start + 4);
        await refused(changed);
      }
      const moov = locateAvBox(bytes, "moov"),
        trak = locateAvBox(bytes, "trak");
      const extra = Buffer.concat([bytes, bytes.subarray(trak.start, trak.end)]);
      extra.writeUInt32BE(moov.end - moov.start + trak.end - trak.start, moov.start);
      await refused(extra);
      for (const handler of ["text", "subt", "meta", "hint"]) {
        const changed = Buffer.from(bytes);
        changed.write(handler, locateAvBox(changed, "hdlr", 1).p + 8);
        await refused(changed);
      }
      const layout = inspectAvMediaMp4(bytes, AV_POLICY);
      for (const video of [true, false]) {
        const changed = Buffer.from(bytes),
          s = required((video ? layout.video : layout.audio).samples[0]);
        let payload = s.pos;
        if (video) {
          while (payload < s.pos + s.size) {
            const length = changed.readUInt32BE(payload),
              type = (changed[payload + 4] ?? 0) & 31;
            if (type === 1 || type === 5) break;
            payload += length + 4;
          }
          changed.fill(255, payload + 5, payload + 4 + changed.readUInt32BE(payload));
        } else changed.fill(255, s.pos, s.pos + s.size);
        // The independent container grammar still admits; a real full decoder must refuse.
        expect(() => inspectAvMediaMp4(changed, AV_POLICY)).not.toThrow();
        await refused(changed);
      }
      const sei = Buffer.from(bytes),
        first = required(layout.video.samples[0]);
      sei[first.pos + 4] = 6;
      await refused(sei);
      await expect(
        decode(bytes, { ...AV_POLICY, limits: { ...AV_POLICY.limits, max_decoded_bytes: 1024 } })
      ).rejects.toThrow(/representation/);
      const request = avRequest(f, bytes);
      const changed = Buffer.from(bytes);
      changed[100] = (changed[100] ?? 0) ^ 1;
      await expect(
        decodeAvMediaBytes({
          runner,
          request,
          bytes: changed,
          policy: AV_POLICY,
          selection: MEDIA_SELECTION,
          limits: MEDIA_LIMITS,
          signal: new AbortController().signal,
        })
      ).rejects.toThrow(/digest/);
      expect(readdirSync(f.root).filter((n) => n.startsWith("decode-"))).toEqual([]);
    });
    it("cross-checks real complete packet/frame/sample/PTS evidence and refuses omission, skip, reordering and diagnostics", async () => {
      using f = new MediaFixture();
      const { bindings, fixture_ffmpeg } = suppliedCpuBindings(f.root);
      const runner = new ConfinedMediaRunner(bindings),
        bytes = syntheticAv(f, fixture_ffmpeg),
        layout = inspectAvMediaMp4(bytes, AV_POLICY);
      const p = await runner.run({
        verb: "av_probe",
        bytes,
        policy: AV_POLICY.limits,
        signal: new AbortController().signal,
      });
      const probe = parseAvJson(
        AvProbeSchema,
        p.stdout,
        MEDIA_LIMITS,
        AV_POLICY.limits.max_probe_bytes
      );
      validateAvProbe(probe, layout);
      const framesOutput = await runner.run({
        verb: "av_frames",
        bytes,
        policy: AV_POLICY.limits,
        signal: new AbortController().signal,
      });
      const frames = parseAvJson(
        AvFramesSchema,
        framesOutput.stdout,
        MEDIA_LIMITS,
        AV_POLICY.limits.max_probe_bytes
      );
      validateAvFrames(frames, layout);
      for (const field of ["pts", "dts", "duration", "pos", "size", "stream_index"]) {
        const changed = structuredClone(probe),
          packet = required(changed.packets[0]);
        Object.defineProperty(packet, field, {
          value: field === "pos" || field === "size" ? "999" : 999,
          enumerable: true,
        });
        expect(() => validateAvProbe(changed, layout)).toThrow();
      }
      expect(() =>
        validateAvProbe({ ...probe, packets: probe.packets.slice(1) }, layout)
      ).toThrow();
      for (const field of [
        "pts",
        "pkt_pts",
        "pkt_dts",
        "best_effort_timestamp",
        "pkt_duration",
        "nb_samples",
      ]) {
        const changed = structuredClone(frames),
          frame = required(changed.frames.find((x) => x.stream_index === 1));
        Object.defineProperty(frame, field, { value: 999, enumerable: true });
        expect(() => validateAvFrames(changed, layout)).toThrow();
      }
      expect(() => validateAvFrames({ frames: frames.frames.slice(1) }, layout)).toThrow();
      for (const extra of [
        { side_data_list: [{ side_data_type: "Skip Samples", skip_samples: 1024 }] },
        { tags: { command: "not authority" } },
      ]) {
        const changed = structuredClone(frames);
        Object.assign(required(changed.frames[0]), extra);
        expect(() =>
          parseAvJson(AvFramesSchema, Buffer.from(JSON.stringify(changed)), MEDIA_LIMITS, 1048576)
        ).toThrow();
      }
      const video = await runner.run({
        verb: "av_video_rgba",
        bytes,
        policy: AV_POLICY.limits,
        signal: new AbortController().signal,
      });
      expect(() =>
        validateAvDecodeLog(
          Buffer.concat([video.stderr, Buffer.from("[warning] damaged\n")]),
          layout.video,
          true
        )
      ).toThrow(/diagnostic/);
      expect(() =>
        validateAvDecodeLog(
          Buffer.from(video.stderr.toString().replace(/pts:\s*2048/u, "pts: 2049")),
          layout.video,
          true
        )
      ).toThrow(/PTS/);
    });
    it.each(["after_persist", "before_consume"] as const)(
      "uses only the original owner/canonical store and adopts %s without another decode",
      async (point) => {
        const policy = avFixturePolicy(
          "custody-injected",
          512,
          288,
          { numerator: 25, denominator: 1 },
          21
        );
        using f = new AvOwnerFixture(policy);
        const { bindings, fixture_ffmpeg } = suppliedCpuBindings(f.root);
        const runner = new ConfinedMediaRunner(bindings),
          bytes = syntheticAv(f, fixture_ffmpeg, policy, 25);
        const request = f.request(bytes, "video/mp4", [
          { start: { numerator: 0, denominator: 1 }, end: { numerator: 1, denominator: 4 } },
          { start: { numerator: 1, denominator: 2 }, end: { numerator: 1, denominator: 1 } },
        ]);
        const directive = f.prepare(request),
          adapter = f.adapter(runner),
          calls = vi.spyOn(runner, "run");
        let crashed = false;
        const owner = f.owner(adapter, (observed) => {
          if (!crashed && observed === point) {
            crashed = true;
            throw new HostOperationSimulatedCrashError(point);
          }
        });
        await expect(owner.dispatch(f.engine, directive)).rejects.toBeInstanceOf(
          HostOperationSimulatedCrashError
        );
        const record = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
        if (point === "after_persist")
          expect(() => f.evidence().inspect(record.operation_record_id)).toThrow(/settled/);
        expect(calls).toHaveBeenCalledTimes(4);
        await owner.dispatch(f.engine, directive);
        const settled = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
        expect(settled.disposition?.outcome).toBe("completed");
        const evidence = f.evidence().inspect(record.operation_record_id);
        expect(evidence.production_admission).toBe("blocked");
        expect(evidence.result.profile).toEqual(policy.profile);
        const driftRef = f.json(
          { ...policy, profile: { ...policy.profile, width: 510 } },
          policy.schema_id
        );
        expect(() =>
          f.evidence(f.store, f.checkpointer, driftRef).inspect(record.operation_record_id)
        ).toThrow(/current policy/);
        expect(evidence.missing_qualification).toContain(
          "AAC_ancillary_payload_metadata_unqualified"
        );
        expect(evidence.pcm_spans.map((s) => [s.start_sample, s.end_sample])).toEqual([
          [0, 12000],
          [24000, 48000],
        ]);
        expect(f.evidence().inspect(record.operation_record_id)).toEqual(evidence);
        await owner.dispatch(f.engine, directive);
        expect(calls).toHaveBeenCalledTimes(4);
        using foreign = new AvOwnerFixture();
        expect(() => f.evidence(foreign.store)).toThrow(/canonical/);
        using shadow = ArtifactStore.provision(path.join(f.root, "shadow"), {
          projectId: f.project_id,
        });
        expect(() => f.evidence(shadow)).toThrow(/canonical/);
        const read = vi.spyOn(f.store, "read");
        read.mockImplementation(() => Buffer.from("corrupt"));
        expect(() => f.evidence().inspect(record.operation_record_id)).toThrow();
        read.mockRestore();
        expect(readdirSync(f.root).filter((n) => n.startsWith("decode-"))).toEqual([]);
      }
    );
    it("preserves independent no-host-files/network/tasks/secret controls for all new verbs", async () => {
      using f = new MediaFixture();
      const supplied = suppliedCpuBindings(f.root);
      const pin = canonicalExecutable(supplied.security_probe);
      const bindings = supplied.bindings;
      const runner = new ConfinedMediaRunner({
        ...bindings,
        ffprobe: { ...bindings.ffprobe, source: pin.path, sha256: pin.sha256 },
        ffmpeg: { ...bindings.ffmpeg, source: pin.path, sha256: pin.sha256 },
      });
      const victim = path.join(f.root, "private-victim");
      writeFileSync(victim, "not granted", { mode: 0o600 });
      const prior = process.env["VIDEOGEN_MEDIA_TEST_SECRET"];
      process.env["VIDEOGEN_MEDIA_TEST_SECRET"] = "not forwarded";
      try {
        for (const verb of ["av_probe", "av_frames", "av_video_rgba", "av_audio_s16le"] as const) {
          const output = await runner.run({
            verb,
            bytes: Buffer.from(`P${victim}`),
            policy: AV_POLICY.limits,
            signal: new AbortController().signal,
          });
          const result: unknown = JSON.parse(output.stdout.toString());
          expect(result).toEqual({
            host_denied: true,
            write_denied: true,
            proc_denied: true,
            network_denied: true,
            fork_denied: true,
            secret_absent: true,
          });
        }
      } finally {
        if (prior === undefined) delete process.env["VIDEOGEN_MEDIA_TEST_SECRET"];
        else process.env["VIDEOGEN_MEDIA_TEST_SECRET"] = prior;
      }
      expect(readdirSync(f.root).filter((n) => n.startsWith("decode-"))).toEqual([]);
    });
    it("records a settled local refusal with no fabricated correlation or AV success", async () => {
      using f = new AvOwnerFixture();
      const { bindings } = suppliedCpuBindings(f.root);
      const runner = new ConfinedMediaRunner(bindings),
        d = f.prepare(f.request(Buffer.from("invalid mux")));
      const owner = f.owner(f.adapter(runner));
      await owner.dispatch(f.engine, d);
      const record = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
      expect(record.disposition).toMatchObject({
        outcome: "failed",
        reason_code: "av_media_decode_refused",
        remote_disposition: "proven_terminal",
      });
      expect(record.remote_correlation_id).toBeNull();
      expect(record.output_artifacts).toEqual([]);
      expect(() => f.evidence().inspect(record.operation_record_id)).toThrow(/completed settled/);
      expect(f.leases.inspect(f.backend)).toEqual({ state: "free" });
    });
  });
}
