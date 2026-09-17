import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScaProcessError, runBoundedScaProcess } from "../src/process.js";

const roots = new Set<string>();

async function executableDigest(): Promise<string> {
  return createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
}

async function request(arguments_: readonly string[], overrides: Record<string, unknown> = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "penny-sca-process-"));
  roots.add(cwd);
  return {
    schema_id: "penny.sca-process-request.v1",
    schema_version: 1,
    executable: process.execPath,
    executable_sha256: await executableDigest(),
    arguments: arguments_,
    cwd,
    environment: [{ name: "SCA_FIXTURE", value: "exact-value" }],
    timeout_ms: 2_000,
    max_stdout_bytes: 4_096,
    max_stderr_bytes: 4_096,
    ...overrides,
  };
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("S-04-T2 bounded shell-free process runner", () => {
  it("passes metacharacters as literal argv and only exposes the supplied environment", async () => {
    const marker = "$(printf unsafe); touch escaped";
    const result = await runBoundedScaProcess(
      await request([
        "-e",
        "process.stdout.write(JSON.stringify({arg:process.argv[1],value:process.env.SCA_FIXTURE,home:process.env.HOME??null}))",
        marker,
      ])
    );
    expect(result.status).toBe("succeeded");
    expect(JSON.parse(result.stdout)).toEqual({ arg: marker, value: "exact-value", home: null });
    expect(result.failure_code).toBe("none");
    expect(result.stdout_truncated).toBe(false);
  });

  it("classifies nonzero exit without dropping raw output", async () => {
    const result = await runBoundedScaProcess(
      await request([
        "-e",
        "process.stdout.write('raw');process.stderr.write('bad');process.exit(7)",
      ])
    );
    expect(result).toMatchObject({
      status: "nonzero_exit",
      exit_code: 7,
      stdout: "raw",
      stderr: "bad",
      failure_code: "nonzero_exit",
    });
  });

  it("bounds output and terminates the process", async () => {
    const result = await runBoundedScaProcess(
      await request(["-e", "process.stdout.write('x'.repeat(10000));setTimeout(()=>{},10000)"], {
        max_stdout_bytes: 64,
      })
    );
    expect(result.status).toBe("output_limit");
    expect(result.stdout_bytes).toBe(64);
    expect(result.stdout_truncated).toBe(true);
  });

  it("enforces timeout and caller cancellation", async () => {
    const timedOut = await runBoundedScaProcess(
      await request(["-e", "setTimeout(()=>{},10000)"], { timeout_ms: 25 })
    );
    expect(timedOut.status).toBe("timed_out");

    const controller = new AbortController();
    const running = runBoundedScaProcess(
      await request(["-e", "setTimeout(()=>{},10000)"], { timeout_ms: 10_000 }),
      controller.signal
    );
    setTimeout(() => controller.abort(), 25);
    expect((await running).status).toBe("cancelled");
  });

  it("rejects non-absolute executables, duplicate environment, and digest drift", async () => {
    await expect(
      runBoundedScaProcess({ ...(await request(["--version"])), executable: "node" })
    ).rejects.toMatchObject({ code: "unsafe_executable" });
    await expect(
      runBoundedScaProcess({
        ...(await request(["--version"])),
        environment: [
          { name: "A", value: "1" },
          { name: "A", value: "2" },
        ],
      })
    ).rejects.toMatchObject({ code: "environment_collision" });
    await expect(
      runBoundedScaProcess({
        ...(await request(["--version"])),
        executable_sha256: "0".repeat(64),
      })
    ).rejects.toBeInstanceOf(ScaProcessError);
  });
});
