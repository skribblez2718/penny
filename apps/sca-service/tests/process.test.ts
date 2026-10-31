import { createHash } from "node:crypto";
import * as childProcess from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ScaProcessError, runBoundedScaProcess } from "../src/process.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const roots = new Set<string>();
const fixturePids = new Set<number>();

function isLive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process fixture did not become ready: ${file}`);
}

function readTree(file: string): number[] {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(
      (pid: unknown): pid is number =>
        typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1
    )
  ) {
    throw new Error("Malformed process-tree fixture receipt");
  }
  const pids: number[] = value;
  for (const pid of pids) fixturePids.add(pid);
  return pids;
}

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
  vi.restoreAllMocks();
  // Also clean the deliberately broken old-runner counterexample, without signalling
  // the test runner's own process group or treating kill(0) as proof of exit.
  for (const pid of fixturePids) {
    if (isLive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* It may have exited between reads. */
      }
    }
  }
  fixturePids.clear();
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

  it("lets trusted output renew inactivity beyond the former total-runtime ceiling", async () => {
    const result = await runBoundedScaProcess(
      await request(
        [
          "-e",
          "let n=0;const timer=setInterval(()=>{process.stdout.write('x');if(++n===8){clearInterval(timer)}},50)",
        ],
        { timeout_ms: 120 }
      )
    );
    expect(result.status).toBe("succeeded");
    expect(result.stdout).toBe("xxxxxxxx");
  });

  it("enforces inactivity expiry and caller cancellation", async () => {
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

  it("forwards trusted productive activity to the owner without a total wall-clock cutoff", async () => {
    let activities = 0;
    const result = await runBoundedScaProcess(
      await request(
        ["-e", "let n=0;const t=setInterval(()=>{console.log(++n);if(n===6)clearInterval(t)},50)"],
        { timeout_ms: 160 }
      ),
      undefined,
      () => {
        activities += 1;
      }
    );
    expect(result.status).toBe("succeeded");
    expect(activities).toBeGreaterThan(1);
  });

  it("cancels safely when an activity owner refuses renewal rather than throwing from an event", async () => {
    const result = await runBoundedScaProcess(
      await request(["-e", "console.log('activity');setTimeout(()=>{},10000)"]),
      undefined,
      () => {
        throw new Error("Owner lease refused");
      }
    );
    expect(result.status).toBe("cancelled");
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

describe("pinned executable bytes and process-group regressions", () => {
  it.each(["rename", "overwrite"] as const)(
    "executes the measured shebang bytes after %s immediately before real spawn",
    async (replacement) => {
      const input = await request([]);
      const executable = path.join(input.cwd, "analyzer.cjs");
      const original = `#!${process.execPath}\nprocess.stdout.write('pinned-original');`;
      const substituted = `#!${process.execPath}\nprocess.stdout.write('unverified-replacement');`;
      writeFileSync(executable, original, { mode: 0o700 });
      const digest = createHash("sha256").update(original).digest("hex");
      const actualSpawn = (
        await vi.importActual<typeof import("node:child_process")>("node:child_process")
      ).spawn;
      let intercepted = false;
      vi.mocked(childProcess.spawn).mockImplementationOnce(
        (...args: Parameters<typeof childProcess.spawn>) => {
          intercepted = true;
          if (replacement === "rename") {
            const other = path.join(input.cwd, "substitute");
            writeFileSync(other, substituted, { mode: 0o700 });
            renameSync(other, executable);
          } else {
            writeFileSync(executable, substituted);
          }
          return actualSpawn(...args);
        }
      );
      const result = await runBoundedScaProcess({
        ...input,
        executable,
        executable_sha256: digest,
      });
      expect(intercepted).toBe(true);
      expect(result.status).toBe("succeeded");
      expect(result.stdout).toBe("pinned-original");
    }
  );

  it("executes a legitimate pinned Node binary that re-execs itself without losing argv", async () => {
    const input = await request([
      "-e",
      `const c=require('node:child_process').spawn(process.execPath,['-e',"process.stdout.write('child-node')"],{stdio:['ignore','pipe','inherit']});c.stdout.pipe(process.stdout);c.on('exit',code=>{process.exitCode=code});`,
    ]);
    const result = await runBoundedScaProcess(input);
    expect(result.status).toBe("succeeded");
    expect(result.stdout).toBe("child-node");
  });

  it("keeps pinned native Node bytes when the original executable is replaced", async () => {
    const input = await request(["--version"]);
    const executable = path.join(input.cwd, "node-fixture");
    copyFileSync(process.execPath, executable);
    chmodSync(executable, 0o700);
    const actualSpawn = (
      await vi.importActual<typeof import("node:child_process")>("node:child_process")
    ).spawn;
    vi.mocked(childProcess.spawn).mockImplementationOnce(
      (...args: Parameters<typeof childProcess.spawn>) => {
        writeFileSync(
          executable,
          `#!${process.execPath}\nprocess.stdout.write('substituted-native-tool');`
        );
        return actualSpawn(...args);
      }
    );
    const result = await runBoundedScaProcess({ ...input, executable });
    expect(result.status).toBe("succeeded");
    expect(result.stdout.trim()).toBe(process.version);
  });

  it("never silently executes an unpinned interpreter on an unsupported shebang", async () => {
    const input = await request([]);
    const executable = path.join(input.cwd, "analyzer");
    const content = "#!/nonexistent/penny-fixture-interpreter\nnot executable JavaScript";
    writeFileSync(executable, content, { mode: 0o700 });
    const result = await runBoundedScaProcess({
      ...input,
      executable,
      executable_sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(result.status).toBe("spawn_failed");
  });

  it("rejects non-executable files rather than granting execution during staging", async () => {
    const input = await request([]);
    const executable = path.join(input.cwd, "non-executable");
    const content = `#!${process.execPath}\nconsole.log('not permitted');`;
    writeFileSync(executable, content, { mode: 0o600 });
    chmodSync(executable, 0o600);
    await expect(
      runBoundedScaProcess({
        ...input,
        executable,
        executable_sha256: createHash("sha256").update(content).digest("hex"),
      })
    ).rejects.toMatchObject({ code: "unsafe_executable" });
  });

  it.each([
    "cancellation",
    "activity refusal",
    "stdout overflow",
    "stderr overflow",
    "inactivity",
    "parent exit",
  ] as const)(
    "%s waits for a long-lived, TERM-ignoring grandchild even after the parent exits",
    async (cause) => {
      const input = await request([], {
        timeout_ms: cause === "inactivity" ? 300 : 5_000,
        max_stdout_bytes: 64,
        max_stderr_bytes: 1_024,
      });
      const ready = path.join(input.cwd, "tree-ready.json");
      const trigger = path.join(input.cwd, "trigger");
      const term = path.join(input.cwd, "grandchild-term");
      const grandchild = `const fs=require('node:fs');process.on('SIGTERM',()=>fs.appendFileSync(${JSON.stringify(term)},'t'));fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify([Number(process.argv[1]),process.ppid,process.pid]));setInterval(()=>{},1000);`;
      const middle = `require('node:child_process').spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(grandchild)},process.argv[1]],{stdio:'ignore'});setInterval(()=>{},1000);`;
      const action =
        cause === "parent exit"
          ? "process.exit(0)"
          : cause === "stdout overflow"
            ? "process.stdout.write('x'.repeat(8192))"
            : cause === "stderr overflow"
              ? "process.stderr.write('x'.repeat(8192))"
              : "process.stdout.write('activity')";
      const root = `const fs=require('node:fs');require('node:child_process').spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(middle)},String(process.pid)],{stdio:'ignore'});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(trigger)})){clearInterval(timer);${action}}},10);setInterval(()=>{},1000);`;
      const controller = new AbortController();
      let refusalEnabled = false;
      const running = runBoundedScaProcess(
        { ...input, arguments: ["-e", root] },
        controller.signal,
        () => {
          if (refusalEnabled) throw new Error("fixture lease refusal");
        }
      );
      try {
        await waitForFile(ready);
        const pids = readTree(ready);
        expect(pids.every(isLive)).toBe(true);
        if (cause === "cancellation") controller.abort();
        else if (cause !== "inactivity") {
          refusalEnabled = cause === "activity refusal";
          writeFileSync(trigger, "go");
        }
        const result = await running;
        const expected =
          cause === "parent exit"
            ? "succeeded"
            : cause === "inactivity"
              ? "timed_out"
              : cause.includes("overflow")
                ? "output_limit"
                : "cancelled";
        expect(result.status).toBe(expected);
        expect(pids.map(isLive)).toEqual([false, false, false]);
        expect(readFileSync(term, "utf8")).toContain("t");
      } finally {
        controller.abort();
        await running;
        if (existsSync(ready)) readTree(ready);
      }
    }
  );

  it.each(["CPU", "I/O"] as const)(
    "renews silent descendant %s progress beyond the inactivity window",
    async (kind) => {
      const input = await request([], { timeout_ms: 200 });
      const worker =
        kind === "CPU"
          ? "const until=Date.now()+750;while(Date.now()<until){Math.sqrt(Math.random())}"
          : `const fs=require('node:fs');let n=0;const t=setInterval(()=>{fs.appendFileSync(${JSON.stringify(path.join(input.cwd, "io-progress"))},'observed I/O\\n');if(++n===25)clearInterval(t)},30);`;
      const code = `const c=require('node:child_process').spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(worker)}],{stdio:'ignore'});c.on('exit',code=>process.exit(code));`;
      const result = await runBoundedScaProcess({ ...input, arguments: ["-e", code] });
      expect(result.status).toBe("succeeded");
      expect(result.stdout).toBe("");
    }
  );

  it("does not postpone escalation when overflow continues after TERM", async () => {
    const input = await request([], { max_stdout_bytes: 16 });
    const code =
      "process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('x'.repeat(8192)),5)";
    const result = await runBoundedScaProcess({ ...input, arguments: ["-e", code] });
    expect(result.status).toBe("output_limit");
    expect(result.signal).toBe("SIGKILL");
    expect(result.stdout_bytes).toBe(16);
  });
});

describe("process boundary failure and staging cleanup", () => {
  it("fails unsupported executable formats without libuv's implicit shell fallback", async () => {
    const input = await request([]);
    const executable = path.join(input.cwd, "no-shebang");
    const content = "printf implicit-shell-fallback";
    writeFileSync(executable, content, { mode: 0o700 });
    const result = await runBoundedScaProcess({
      ...input,
      executable,
      executable_sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(result.status).toBe("spawn_failed");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ENOEXEC");
  });

  it("removes private executable/invocation staging only after the process exits", async () => {
    const result = await runBoundedScaProcess(
      await request(["-e", "process.stdout.write(process.execPath)"])
    );
    expect(result.status).toBe("succeeded");
    expect(path.basename(path.dirname(result.stdout))).toBe("executable");
    expect(existsSync(path.dirname(path.dirname(result.stdout)))).toBe(false);
  });

  it("bounds preparation errors as well as child stderr", async () => {
    const input = await request([], { max_stderr_bytes: 32 });
    const result = await runBoundedScaProcess({
      ...input,
      executable: path.join(input.cwd, "a".repeat(300)),
    });
    expect(result.status).toBe("spawn_failed");
    expect(result.stderr_bytes).toBe(32);
    expect(result.stderr_truncated).toBe(true);
  });

  it("honestly reports unconfirmed cleanup when an escaped session holds inherited pipes", async () => {
    const input = await request([]);
    const ready = path.join(input.cwd, "escaped-ready.json");
    const worker = `require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify([Number(process.argv[1]),Number(process.argv[1]),process.pid]));setInterval(()=>{},1000);`;
    const code = `const fs=require('node:fs');const c=require('node:child_process').spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(worker)},String(process.pid)],{detached:true,stdio:['ignore',1,2]});c.unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(t);process.exit(0)}},10);`;
    const running = runBoundedScaProcess({ ...input, arguments: ["-e", code] });
    try {
      await waitForFile(ready);
      const pids = readTree(ready);
      const result = await running;
      expect(result.status).toBe("spawn_failed");
      expect(result.failure_code).toBe("cleanup_failed");
      expect(result.stderr).toContain("cleanup could not confirm");
      const escaped = pids[2];
      if (escaped === undefined) throw new Error("Missing escaped fixture PID");
      expect(isLive(escaped)).toBe(true);
    } finally {
      // This escape is intentional verification of the boundary, not a sandbox claim.
      if (existsSync(ready)) readTree(ready);
      for (const pid of fixturePids) {
        if (isLive(pid)) process.kill(pid, "SIGKILL");
      }
      await running;
    }
  });
});
