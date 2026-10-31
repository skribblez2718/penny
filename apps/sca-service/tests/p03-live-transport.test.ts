import { runScaP03BootstrapCliV1 } from "../src/p03-bootstrap-cli.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertScaP03ClosedDockerArgvV1,
  ScaP03ProgressInactivityV1,
  scaP03CompletedDockerStdoutV1,
} from "../src/p03-live-transport.js";
const image = `example.invalid/fixture@sha256:${"a".repeat(64)}`;
const id = "b".repeat(64);
const name = "penny-p03-12345678-1234-1234-1234-123456789012";
afterEach(() => vi.useRealTimers());
describe("owned P03 transport is closed, inactive-only and finitely bounded", () => {
  it("separates successful stdout from bounded diagnostics without adopting stderr as evidence", () => {
    const stdout = Buffer.from('{"measured":"stdout-only"}');
    const stderr = Buffer.from(
      "Picked up JAVA_TOOL_OPTIONS: -Xmx536870912\nexecuting /scripts/inventory.sc\n"
    );
    const limit = stdout.byteLength + stderr.byteLength;
    expect(scaP03CompletedDockerStdoutV1(0, stdout, stderr, limit)).toBe(stdout.toString());
    expect(scaP03CompletedDockerStdoutV1(0, Buffer.alloc(0), stdout, limit)).toBe("");
    for (const exitCode of [1, 137, null])
      expect(() => scaP03CompletedDockerStdoutV1(exitCode, stdout, stderr, limit)).toThrow(
        "p03_live_command_failed"
      );
    expect(() => scaP03CompletedDockerStdoutV1(0, stdout, stderr, limit - 1)).toThrow(
      "p03_live_output_limit"
    );
    expect(() => scaP03CompletedDockerStdoutV1(0, stdout, stderr, 0)).toThrow();
    expect(() =>
      scaP03CompletedDockerStdoutV1(0, Buffer.from([0xff]), Buffer.alloc(0), limit)
    ).toThrow();
  });
  it("refuses direct live CLI entry before reading any caller manifest or effect", async () => {
    for (const command of [
      "freeze-record",
      "freeze-production-record",
      "seal",
      "seal-production",
      "verify",
      "verify-production",
    ]) {
      await expect(
        runScaP03BootstrapCliV1([command, "--manifest", "/nonexistent/test-only-manifest"], {
          emit: () => {
            throw new Error("must not emit success");
          },
        })
      ).rejects.toThrow("p03_trusted_initial_operator_required");
    }
  });
  it("renews only increasing accepted activity and remains active beyond sixty seconds", () => {
    vi.useFakeTimers();
    let mono = 0;
    let accepted = 0;
    using timer = new ScaP03ProgressInactivityV1(
      60_000,
      new AbortController().signal,
      () => accepted++,
      () => mono
    );
    for (let i = 1; i <= 4; i++) {
      mono += 45_000;
      vi.advanceTimersByTime(45_000);
      timer.accept(i);
    }
    expect(mono).toBe(180_000);
    expect(timer.signal.aborted).toBe(false);
    expect(accepted).toBe(4);
    mono += 60_001;
    vi.advanceTimersByTime(60_001);
    expect(timer.signal.aborted).toBe(true);
    expect(() => timer.accept(5)).toThrow();
  });
  it("does not renew on duplicates, empty activity, stale frames or rejected owner/fence", () => {
    vi.useFakeTimers();
    let mono = 0;
    using timer = new ScaP03ProgressInactivityV1(
      100,
      new AbortController().signal,
      () => {
        throw new Error("fence lost");
      },
      () => mono
    );
    expect(() => timer.accept(0)).toThrow();
    mono = 90;
    expect(() => timer.accept(1)).toThrow("fence lost");
    mono = 100;
    vi.advanceTimersByTime(100);
    expect(timer.signal.aborted).toBe(true);
    using ok = new ScaP03ProgressInactivityV1(
      100,
      new AbortController().signal,
      () => {},
      () => mono
    );
    ok.accept(1);
    expect(() => ok.accept(1)).toThrow();
    mono = 201;
    expect(() => ok.accept(2)).toThrow();
  });
  it("forwards cancellation and releases all timer listeners", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const timer = new ScaP03ProgressInactivityV1(100, parent.signal, () => {});
    parent.abort(new Error("cancelled"));
    expect(timer.signal.aborted).toBe(true);
    timer[Symbol.dispose]();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("admits only exact measurements, fixed parser/readback vectors and exact cleanup census", () => {
    const allowed = [
      ["version", "--format", "{{json .}}"],
      ["image", "inspect", "--format", "{{json .}}", image],
      ["container", "inspect", "--format", "{{json .}}", id],
      ["container", "start", id],
      ["container", "rm", "--force", name],
      ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
      [
        "container",
        "exec",
        id,
        "joern-parse",
        "--language",
        "JSSRC",
        "--output",
        "/work/graph.cpg.bin",
        "--max-num-def",
        "100",
        "/source",
      ],
      ["container", "exec", id, "python3", "/scripts/readback.py", "graph.cpg.bin", "65536"],
    ];
    for (const argv of allowed)
      expect(() => assertScaP03ClosedDockerArgvV1(argv, image)).not.toThrow();
    for (const argv of [
      ["run", "--privileged", image],
      ["--context", "operator", "version"],
      ["container", "exec", id, "sh", "-c", "anything"],
      ["container", "rm", "--force", "unowned"],
      ["container", "exec", id, "python3", "/scripts/readback.py", "../secret", "10"],
      ["image", "inspect", "--format", "{{json .}}", "mutable:tag"],
    ])
      expect(() => assertScaP03ClosedDockerArgvV1(argv, image)).toThrow();
  });
  it("rejects host escapes, duplicate scalar flags and unapproved creation switches", () => {
    const create = [
      "container",
      "create",
      "--pull=never",
      "--read-only",
      "--no-healthcheck",
      "--init",
      "--name",
      name,
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--log-driver",
      "none",
      "--entrypoint",
      "sleep",
      image,
      "infinity",
    ];
    expect(() => assertScaP03ClosedDockerArgvV1(create, image)).not.toThrow();
    for (const extra of [
      ["--privileged"],
      ["--volume", "/:/host"],
      ["--device", "/dev/sda"],
      ["--network", "host"],
      ["--label", "caller=can-run"],
      ["--entrypoint", "sh"],
    ])
      expect(() =>
        assertScaP03ClosedDockerArgvV1([...create.slice(0, -2), ...extra, image, "infinity"], image)
      ).toThrow();
  });
});
