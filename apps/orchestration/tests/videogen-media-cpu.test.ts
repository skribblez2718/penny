import { closeSync, fstatSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { registerAvMediaCpuTests } from "./helpers/av-media-cpu-cases.js";
import { registerAvcImportCpuTests } from "./helpers/avc-import-cpu-cases.js";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { ConfinedMediaRunner } from "../dist/host-operations/confined-media-runner.js";
import { validateMp4Video } from "../dist/mp4-media.js";
import { validateCanonicalPng, decodePng } from "../dist/png-media.js";
import { decodeMediaBytes, inspectStrictAvcMp4 } from "../dist/videogen/media-decode.js";
import {
  MEDIA_LIMITS,
  MEDIA_POLICY,
  MEDIA_SELECTION,
  MediaFixture,
  pcmAsset,
  suppliedCpuBindings,
  syntheticVideo,
  required,
  canonicalExecutable,
} from "./helpers/videogen-media-fixtures.js";

// Collection guard only: never run or silently skip real CPU tests without caller opt-in.
if (process.env["PENNY_VIDEOGEN_MEDIA_CPU"] !== "1")
  throw new Error("Set PENNY_VIDEOGEN_MEDIA_CPU=1 for external CPU qualification.");
try {
  // Reuse the fixture's closed binding schema and probe pin check before any test executes.
  const { bindings } = suppliedCpuBindings("");
  // Fail before collection for unavailable/drifted caller files too, without leaking their paths.
  const pins = [
    { source: bindings.bubblewrap.path, sha256: bindings.bubblewrap.sha256 },
    { source: bindings.prlimit.path, sha256: bindings.prlimit.sha256 },
    bindings.ffmpeg,
    bindings.ffprobe,
    ...bindings.runtime_files,
  ];
  for (const pin of pins)
    if (canonicalExecutable(pin.source).sha256 !== pin.sha256)
      throw new Error("CPU runtime pin mismatch");
} catch {
  // Parser/file errors may contain private input or paths; disclose neither.
  throw new Error(
    "CPU qualification requires valid caller-supplied VIDEOGEN_MEDIA_TEST_BINDINGS JSON."
  );
}

function fixtureBox(
  bytes: Buffer,
  type: string,
  start = 0,
  end = bytes.length
): { payload: number; end: number } {
  for (let cursor = start; cursor + 8 <= end; ) {
    const size = bytes.readUInt32BE(cursor);
    if (size < 8 || cursor + size > end) throw new Error("invalid synthetic box");
    if (bytes.toString("ascii", cursor + 4, cursor + 8) === type)
      return { payload: cursor + 8, end: cursor + size };
    cursor += size;
  }
  throw new Error(`missing synthetic ${type}`);
}
function decode(
  f: MediaFixture,
  runner: ConfinedMediaRunner,
  bytes: Buffer,
  mediaType: string,
  policy = f.policy
) {
  const request = f.request(bytes, mediaType);
  return decodeMediaBytes({
    runner,
    request,
    bytes,
    policy,
    selection: MEDIA_SELECTION,
    limits: MEDIA_LIMITS,
    signal: new AbortController().signal,
  });
}
function probeRunner(f: MediaFixture) {
  const supplied = suppliedCpuBindings(f.root);
  const executable = canonicalExecutable(supplied.security_probe);
  const runner = new ConfinedMediaRunner({
    ...supplied.bindings,
    ffprobe: {
      source: executable.path,
      target: supplied.bindings.ffprobe.target,
      sha256: executable.sha256,
    },
  });
  return { runner, original: supplied.bindings };
}
registerAvMediaCpuTests();
registerAvcImportCpuTests();

describe("REAL bounded CPU media decode (explicit bindings required; never auto-installed/skipped)", () => {
  it("fully decodes synthetic H.264 current bytes to differing canonical PNGs at actual rational PTS through the real engine/owner", async () => {
    using f = new MediaFixture();
    const { bindings, fixture_ffmpeg } = suppliedCpuBindings(f.root);
    const runner = new ConfinedMediaRunner(bindings);
    const bytes = syntheticVideo(fixture_ffmpeg, path.join(f.root, "synthetic.mp4"));
    expect(inspectStrictAvcMp4(bytes, MEDIA_POLICY).nal_length).toBe(4);
    await expect(decode(f, runner, bytes, "video/mp4")).resolves.toMatchObject({
      result: { video: { decoded_frame_count: 8 } },
    });
    const request = f.request(bytes, "video/mp4");
    const d = f.prepare(request);
    await expect(f.owner(f.adapter(runner)).dispatch(f.engine, d)).resolves.toMatchObject({
      action: "await_user",
    });
    const record = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
    expect(record.disposition).toMatchObject({ outcome: "completed" });
    const evidence = f.evidence().materialize(record.operation_record_id);
    const ref = required(evidence.video_evidence_ref);
    const result: unknown = JSON.parse(f.store.read(ref).toString("utf8"));
    expect(result).toMatchObject({
      source_clip_ref: request.media_ref,
      frames: [
        { index: 0, pts: { numerator: 0, denominator: 1 } },
        { index: 4, pts: { numerator: 1, denominator: 2 } },
        { index: 7, pts: { numerator: 7, denominator: 8 } },
      ],
      unassessed: ["motion", "speech", "sound", "sync"],
    });
    expect(record.output_artifacts.length).toBe(3);
    const frames = record.output_artifacts.map((r) => f.store.read(r));
    for (const frame of frames)
      expect(validateCanonicalPng(frame)).toMatchObject({ width: 32, height: 24 });
    expect(
      Buffer.from(decodePng(required(frames[0])).rgba).equals(
        Buffer.from(decodePng(required(frames[2])).rgba)
      )
    ).toBe(false);
    const raw: unknown = JSON.parse(
      f.store.read(required(record.operation_result_ref)).toString("utf8")
    );
    expect(raw).toMatchObject({ video: { decoded_frame_count: 8 } });
    expect(f.evidence().materialize(record.operation_record_id)).toEqual(evidence);
    expect(readdirSync(f.root).filter((x) => x.startsWith("decode-"))).toEqual([]);
  });
  it("actually decodes complete PCM and exact disjoint approved sample spans; measurements are not intelligibility or LUFS", async () => {
    using f = new MediaFixture();
    const { bindings } = suppliedCpuBindings(f.root);
    const runner = new ConfinedMediaRunner(bindings);
    const bytes = pcmAsset();
    await expect(decode(f, runner, bytes, "audio/wav")).resolves.toMatchObject({
      result: { audio: { decoded_sample_count: 8000 } },
    });
    const request = f.request(bytes);
    const d = f.prepare(request);
    await f.owner(f.adapter(runner)).dispatch(f.engine, d);
    const record = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
    expect(record.disposition).toMatchObject({ outcome: "completed" });
    const evidence = f.evidence().materialize(record.operation_record_id);
    expect(evidence.audio_measurement_ref).not.toBeNull();
    expect(evidence.production_admission).toBe("blocked");
    const spans = [
      { start: { numerator: 1, denominator: 4 }, end: { numerator: 1, denominator: 2 } },
      { start: { numerator: 3, denominator: 4 }, end: { numerator: 1, denominator: 1 } },
    ];
    const r = f.request(bytes, "audio/wav", spans);
    const decoded = await decodeMediaBytes({
      runner,
      request: r,
      bytes,
      policy: f.policy,
      selection: MEDIA_SELECTION,
      limits: MEDIA_LIMITS,
      signal: new AbortController().signal,
    });
    expect(decoded.result.audio?.spans).toMatchObject([
      { start_sample: 2000, end_sample: 4000 },
      { start_sample: 6000, end_sample: 8000 },
    ]);
    expect(decoded.outputs.map((o) => o.bytes.length)).toEqual([4044, 4044]);
    expect(canonicalJson(decoded.result)).not.toMatch(
      /intelligibility|loudness_lufs|speech_intervals/
    );
  });
  it("rejects current-byte digest drift, corrupt coded pictures, container/coded metadata, oversized decode and unsupported streams before claiming evidence", async () => {
    using f = new MediaFixture();
    const { bindings, fixture_ffmpeg } = suppliedCpuBindings(f.root);
    const runner = new ConfinedMediaRunner(bindings);
    const bytes = syntheticVideo(fixture_ffmpeg, path.join(f.root, "synthetic.mp4"));
    const request = f.request(bytes, "video/mp4");
    const changed = Buffer.from(bytes);
    changed[100] = (changed[100] ?? 0) ^ 0xff;
    await expect(
      decodeMediaBytes({
        runner,
        request,
        bytes: changed,
        policy: f.policy,
        selection: MEDIA_SELECTION,
        limits: MEDIA_LIMITS,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/digest/);
    const udta = Buffer.alloc(8);
    udta.writeUInt32BE(8);
    udta.write("udta", 4);
    await expect(decode(f, runner, Buffer.concat([bytes, udta]), "video/mp4")).rejects.toThrow(
      /unapproved/
    );
    const corrupt = Buffer.from(bytes);
    const layout = inspectStrictAvcMp4(corrupt, f.policy);
    const mdat = required(layout.media_ranges[0]);
    // Retain length-prefix and NAL header, destroy coded slice bytes. Structure alone still admits;
    // the actual decoder/probe must fail rather than emitting sampled success.
    const firstNalBytes = corrupt.readUInt32BE(mdat.payload);
    corrupt.fill(0xff, mdat.payload + 5, mdat.payload + 4 + firstNalBytes);
    expect(
      validateMp4Video(corrupt, {
        width: 32,
        height: 24,
        frame_count: 8,
        fps: 8,
        max_bytes: f.policy.max_input_bytes,
      }).status
    ).toBe("valid");
    await expect(decode(f, runner, corrupt, "video/mp4")).rejects.toThrow();
    const moov = fixtureBox(bytes, "moov");
    const movieHeader = fixtureBox(bytes, "mvhd", moov.payload, moov.end);
    const hiddenMetadata = Buffer.from(bytes);
    hiddenMetadata[movieHeader.payload + 72] = 65;
    await expect(decode(f, runner, hiddenMetadata, "video/mp4")).rejects.toThrow(/metadata/);
    const multiplexed = syntheticVideo(fixture_ffmpeg, path.join(f.root, "with-audio.mp4"), true);
    await expect(decode(f, runner, multiplexed, "video/mp4")).rejects.toThrow(
      /duplicate MP4 boxes|extra\/nonvideo stream/
    );
    const sei = Buffer.from(bytes);
    sei[mdat.payload + 4] = 6;
    await expect(decode(f, runner, sei, "video/mp4")).rejects.toThrow(/coded metadata/);
    using limited = new MediaFixture({ ...MEDIA_POLICY, max_decoded_bytes: 1024 });
    await expect(decode(limited, runner, bytes, "video/mp4")).rejects.toThrow(/representation/);
    const withMetadata = readFileSync(path.join(f.root, "synthetic.mp4"));
    await expect(decode(f, runner, withMetadata, "video/mp4")).rejects.toThrow(
      /metadata|unapproved/
    );
    await expect(decode(f, runner, bytes, "video/webm")).rejects.toThrow(/unsupported/);
  });
  it("demonstrates independent filesystem, credentials, network and process confinement with a real adversarial executable", async () => {
    using f = new MediaFixture();
    const { runner } = probeRunner(f);
    const victim = path.join(f.root, "private-victim");
    writeFileSync(victim, "not granted", { mode: 0o600 });
    const prior = process.env["VIDEOGEN_MEDIA_TEST_SECRET"];
    process.env["VIDEOGEN_MEDIA_TEST_SECRET"] = "not forwarded";
    try {
      const result = await runner.run({
        verb: "probe",
        bytes: Buffer.from(`P${victim}`),
        policy: MEDIA_POLICY,
        signal: new AbortController().signal,
      });
      const parsed: unknown = JSON.parse(result.stdout.toString("utf8"));
      expect(parsed).toEqual({
        host_denied: true,
        write_denied: true,
        proc_denied: true,
        network_denied: true,
        fork_denied: true,
        secret_absent: true,
      });
    } finally {
      if (prior === undefined) delete process.env["VIDEOGEN_MEDIA_TEST_SECRET"];
      else process.env["VIDEOGEN_MEDIA_TEST_SECRET"] = prior;
    }
    expect(readdirSync(f.root).filter((x) => x.startsWith("decode-"))).toEqual([]);
  });
  it("denies namespace, mount, tracing and kernel module actions with the actual helper", async () => {
    using f = new MediaFixture();
    const { runner } = probeRunner(f);
    const result = await runner.run({
      verb: "probe",
      bytes: Buffer.from("U"),
      policy: MEDIA_POLICY,
      signal: new AbortController().signal,
    });
    const parsed: unknown = JSON.parse(result.stdout.toString());
    expect(parsed).toEqual({
      unshare_denied: true,
      setns_denied: true,
      mount_denied: true,
      ptrace_denied: true,
      init_module_denied: true,
      finit_module_denied: true,
      delete_module_denied: true,
    });
  });
  it("cannot appropriate a real host process counter, descriptor or memory, or open perf counters", async () => {
    using f = new MediaFixture();
    const { runner } = probeRunner(f);
    // Hold a REAL host process counter open, not a fabricated PID, counter or helper result.
    const counter = `/proc/${process.pid}/stat`;
    const fd = openSync(counter, "r");
    try {
      const before = fstatSync(fd);
      expect(readFileSync(counter).toString()).toMatch(new RegExp(`^${process.pid} `));
      const result = await runner.run({
        verb: "probe",
        bytes: Buffer.from(`H${process.pid} ${fd}`),
        policy: MEDIA_POLICY,
        signal: new AbortController().signal,
      });
      const parsed: unknown = JSON.parse(result.stdout.toString());
      expect(parsed).toEqual({
        host_stat_denied: true,
        host_fd_denied: true,
        host_mem_denied: true,
        host_perf_denied: true,
        self_perf_denied: true,
      });
      expect(fstatSync(fd).ino).toBe(before.ino);
      expect(readFileSync(counter).toString()).toMatch(new RegExp(`^${process.pid} `));
    } finally {
      closeSync(fd);
    }
  });
  it("enforces output, diagnostics, CPU, address space, elapsed, inactivity, cancellation and per-runner concurrency independently", async () => {
    using f = new MediaFixture();
    const { runner } = probeRunner(f);
    const run = (verb: string, policy = MEDIA_POLICY, signal = new AbortController().signal) =>
      runner.run({ verb: "probe", bytes: Buffer.from(verb), policy, signal });
    const threads = await run("T", { ...MEDIA_POLICY, max_processes: 8 });
    expect(threads.stdout.toString("ascii")).toBe("0\n");
    expect((await run("I")).stdout.toString("ascii")).toBe("1");
    await expect(run("O", { ...MEDIA_POLICY, max_probe_bytes: 1024 })).rejects.toThrow(
      /stdout limit/
    );
    await expect(run("E", { ...MEDIA_POLICY, max_diagnostic_bytes: 1024 })).rejects.toThrow(
      /diagnostic limit/
    );
    await expect(run("S", { ...MEDIA_POLICY, inactivity_ms: 50 })).rejects.toThrow(/inactivity/);
    await expect(
      run("S", { ...MEDIA_POLICY, max_elapsed_ms: 70, inactivity_ms: 70 })
    ).rejects.toThrow(/elapsed/);
    await expect(run("C", { ...MEDIA_POLICY, cpu_seconds: 1 })).rejects.toThrow(/decoder refused/);
    expect(
      (await run("M", { ...MEDIA_POLICY, address_space_bytes: 67_108_864 })).stdout.toString()
    ).toBe("1");
    const controller = new AbortController();
    const pending = run("S", MEDIA_POLICY, controller.signal);
    await expect(run("P")).rejects.toThrow(/concurrency/);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancel/);
    expect(readdirSync(f.root).filter((x) => x.startsWith("decode-"))).toEqual([]);
  });
  it.each(["after_persist", "before_consume"] as const)(
    "recovers REAL decoded PCM at %s through the existing owner without another decoder process",
    async (point) => {
      using f = new MediaFixture();
      const { bindings } = suppliedCpuBindings(f.root);
      const runner = new ConfinedMediaRunner(bindings);
      const processes = vi.spyOn(runner, "run");
      const directive = f.prepare(f.request(pcmAsset()));
      const adapter = f.adapter(runner);
      await expect(
        f
          .owner(adapter, (observed) => {
            if (observed === point) throw new HostOperationSimulatedCrashError(point);
          })
          .dispatch(f.engine, directive)
      ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
      expect(processes).toHaveBeenCalledTimes(2);
      await f.owner(adapter).dispatch(f.engine, directive);
      const record = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
      const evidence = f.evidence().materialize(record.operation_record_id);
      expect(evidence.audio_measurement_ref).not.toBeNull();
      expect(f.evidence().materialize(record.operation_record_id)).toEqual(evidence);
      expect(processes).toHaveBeenCalledTimes(2);
    }
  );
  it("returns an honest owner-custodied local failure for invalid media without inventing remote acceptance or evidence", async () => {
    using f = new MediaFixture();
    const { bindings } = suppliedCpuBindings(f.root);
    const runner = new ConfinedMediaRunner(bindings);
    const request = f.request(Buffer.from("not media"));
    const d = f.prepare(request);
    await f.owner(f.adapter(runner)).dispatch(f.engine, d);
    const record = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
    expect(record.disposition).toMatchObject({
      outcome: "failed",
      reason_code: "media_decode_refused",
      remote_disposition: "proven_terminal",
    });
    expect(record.remote_correlation_id).toBeNull();
    expect(record.output_artifacts).toEqual([]);
    expect(() => f.evidence().materialize(record.operation_record_id)).toThrow(/completed settled/);
    expect(f.leases.inspect(f.backend)).toEqual({ state: "free" });
  });
  it("fails closed on missing bindings, executable pin changes and unsafe runtime mount targets", async () => {
    using f = new MediaFixture();
    const { bindings } = suppliedCpuBindings(f.root);
    expect(
      () =>
        new ConfinedMediaRunner({
          ...bindings,
          runtime_files: [
            ...bindings.runtime_files,
            {
              source: bindings.ffmpeg.source,
              sha256: bindings.ffmpeg.sha256,
              target: "/input/injected",
            },
          ],
        })
    ).toThrow(/target/);
    const bad = new ConfinedMediaRunner({
      ...bindings,
      ffprobe: { ...bindings.ffprobe, sha256: sha256("wrong") },
    });
    await expect(
      bad.run({
        verb: "probe",
        bytes: pcmAsset(),
        policy: MEDIA_POLICY,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/digest/);
  });
});
