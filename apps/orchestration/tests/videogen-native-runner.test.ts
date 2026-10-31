import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NATIVE_VERBS } from "../dist/host-operations/confined-native-runner.js";
import { verifyNormalizedNative, writeNativeProject } from "../dist/videogen/kdenlive-writer.js";
import { FoundationFixture } from "./helpers/videogen-foundation-fixtures.js";
import { nativeInput } from "./helpers/videogen-native-fixtures.js";
import { RunnerFixture, NATIVE_TEST_POLICY as POLICY } from "./helpers/videogen-native-runner.js";
describe("actual fixed confined process native protocol (static fixture driver, NO editor invocation)", () => {
  it("runs all four fixed verbs, relocates without original mount and independently checks saved output", async () => {
    using f = new FoundationFixture();
    using runner = new RunnerFixture();
    const input = nativeInput(f),
      written = writeNativeProject(input);
    for (const verb of NATIVE_VERBS) {
      const bytes = await runner.runner.run({
        verb,
        files: [{ relative_path: "project.kdenlive", bytes: written.bytes }],
        policy: POLICY,
        signal: new AbortController().signal,
      });
      if (verb !== "render_compare")
        expect(verifyNormalizedNative(written, bytes, input.registry)).toEqual(written.readback);
      else expect(bytes.toString()).toContain("NOT qualified AV");
    }
    expect(readdirSync(runner.root)).toEqual(["driver"]);
  });
  it("kills timed-out and cancelled process groups and cleans the exact private stage", async () => {
    using runner = new RunnerFixture(1);
    const files = [{ relative_path: "project.kdenlive", bytes: Buffer.from("fixture") }];
    await expect(
      runner.runner.run({
        verb: "open_save_normalize",
        files,
        policy: { ...POLICY, inactivity_ms: 100 },
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("inactivity");
    const controller = new AbortController();
    const pending = runner.runner.run({
      verb: "close_reopen_readback",
      files,
      policy: POLICY,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow("cancelled");
    expect(readdirSync(runner.root)).toEqual(["driver"]);
  });
  it("enforces aggregate writable bytes across multiple individually permitted files, including /tmp aliases", async () => {
    using runner = new RunnerFixture(5);
    const bytes = await runner.runner.run({
      verb: "open_save_normalize",
      files: [{ relative_path: "project.kdenlive", bytes: Buffer.from("fixture") }],
      policy: { ...POLICY, max_output_bytes: 1048576 },
      signal: new AbortController().signal,
    });
    expect(bytes.toString()).toBe("aggregate ENOSPC");
    expect(readdirSync(runner.root)).toEqual(["driver"]);
  });
  it("refuses missing/undersized aggregate policy without invoking a driver and cleans up", async () => {
    using runner = new RunnerFixture();
    for (const max_writable_bytes of [0, 4095, Number.NaN]) {
      await expect(
        runner.runner.run({
          verb: "open_save_normalize",
          files: [{ relative_path: "project.kdenlive", bytes: Buffer.from("fixture") }],
          policy: { ...POLICY, max_writable_bytes },
          signal: new AbortController().signal,
        })
      ).rejects.toThrow();
      expect(readdirSync(runner.root)).toEqual(["driver"]);
    }
  });
  it("refuses an unsupported actual mount bootstrap before driver output and removes its stage", async () => {
    using runner = new RunnerFixture(4, true);
    await expect(
      runner.runner.run({
        verb: "open_save_normalize",
        files: [{ relative_path: "project.kdenlive", bytes: Buffer.from("fixture") }],
        policy: POLICY,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("driver/sandbox failed");
    expect(readdirSync(runner.root)).toEqual(["driver"]);
  });
  it("blocks nested namespace/mount and anonymous writable-filesystem escapes with actual kernel seccomp", async () => {
    using runner = new RunnerFixture(6);
    const bytes = await runner.runner.run({
      verb: "open_save_normalize",
      files: [{ relative_path: "project.kdenlive", bytes: Buffer.from("fixture") }],
      policy: POLICY,
      signal: new AbortController().signal,
    });
    expect(bytes.toString()).toBe("mount and memfd escapes denied");
    expect(readdirSync(runner.root)).toEqual(["driver"]);
  });
  it("rejects crash, output overflow, wrong saved bytes and unsupported resource paths", async () => {
    using f = new FoundationFixture();
    const input = nativeInput(f),
      written = writeNativeProject(input);
    for (const mode of [2, 3, 4]) {
      using runner = new RunnerFixture(mode);
      const result = runner.runner.run({
        verb: "open_save_normalize",
        files: [{ relative_path: "project.kdenlive", bytes: written.bytes }],
        policy: { ...POLICY, max_output_bytes: 32768 },
        signal: new AbortController().signal,
      });
      if (mode === 4)
        expect(() =>
          verifyNormalizedNative(written, Buffer.from("wrong bytes"), input.registry)
        ).toThrow();
      if (mode === 4) await expect(result).resolves.toEqual(Buffer.from("wrong bytes"));
      else await expect(result).rejects.toThrow();
      expect(readdirSync(runner.root)).toEqual(["driver"]);
    }
    using runner = new RunnerFixture();
    await expect(
      runner.runner.run({
        verb: "open_save_normalize",
        files: [{ relative_path: "../escape", bytes: written.bytes }],
        policy: POLICY,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow();
  });
});
