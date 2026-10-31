import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import defaultConfig from "../vitest.config.js";
import cpuConfig from "../vitest.videogen-media-cpu.config.js";
import {
  parseJson,
  requireRecord,
  requireString,
  requireStringArray,
} from "./helpers/narrowing.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const CPU_CONFIG = "apps/orchestration/vitest.videogen-media-cpu.config.ts";
const CPU_FILES = [
  "apps/orchestration/tests/videogen-media-cpu.test.ts",
  "tests/videogen-media-cpu.test.ts",
];
const DIRECT = "test:videogen-media-cpu";
const AGGREGATE = `${DIRECT}:aggregate`;
const RUNNER_MARKER = "CPU_ROUTING_STUB_REACHED";
const PRIVATE_MARKER = "caller-binding-must-not-appear";
const scripts = requireRecord(
  requireRecord(
    parseJson(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")),
    "package"
  )["scripts"],
  "scripts"
);

function script(name: string): string {
  return requireString(scripts[name], name);
}

function environment(gate?: string, bindings?: string): NodeJS.ProcessEnv {
  // Never inherit caller bindings, opt-ins, state roots or provider configuration.
  return {
    PATH: requireString(process.env["PATH"], "PATH"),
    NO_COLOR: "1",
    ...(gate === undefined ? {} : { PENNY_VIDEOGEN_MEDIA_CPU: gate }),
    ...(bindings === undefined ? {} : { VIDEOGEN_MEDIA_TEST_BINDINGS: bindings }),
  };
}

function run(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync("sh", ["-c", command], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 1_048_576,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

class RoutingFixture implements Disposable {
  readonly root = mkdtempSync(path.join(tmpdir(), "penny-cpu-routing-"));
  constructor() {
    const cli = path.join(this.root, "node_modules/vitest/vitest.mjs");
    mkdirSync(path.dirname(cli), { recursive: true });
    // Routing oracle only: reaching this stub must never count as actual CPU qualification.
    writeFileSync(cli, `process.stdout.write(${JSON.stringify(RUNNER_MARKER)} + "\\n");`);
    writeFileSync(
      path.join(this.root, "package.json"),
      JSON.stringify({ scripts: { [DIRECT]: script(DIRECT), [AGGREGATE]: script(AGGREGATE) } })
    );
  }
  [Symbol.dispose](): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

function defaultRoutingIssues(config: unknown): string[] {
  const test = requireRecord(requireRecord(config, "default config")["test"], "default test");
  const excludes = requireStringArray(test["exclude"], "default excludes");
  return CPU_FILES.filter((file) => !excludes.includes(file));
}

function refusedBeforeRunner(command: string, env: NodeJS.ProcessEnv): boolean {
  using fixture = new RoutingFixture();
  const result = run(command, fixture.root, env);
  return result.status !== null && result.status !== 0 && !result.output.includes(RUNNER_MARKER);
}

function targets(root: string): Record<string, unknown>[] {
  const runner = path.join(REPO_ROOT, "scripts/system/checks/typescript-tests.mjs");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { pathToFileURL } from "node:url"; const { collectTypeScriptTestTargets } = await import(pathToFileURL(process.argv[2]).href); process.stdout.write(JSON.stringify(collectTypeScriptTestTargets(process.argv[3])));',
      "cpu-routing-contract",
      runner,
      root,
    ],
    { env: environment(), encoding: "utf8", maxBuffer: 1_048_576 }
  );
  if (result.error !== undefined) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) throw new Error("runner targets must be an array");
  return parsed.map((target: unknown) => requireRecord(target, "runner target"));
}

function cpuTargetIssues(collected: Record<string, unknown>[]): string[] {
  const target = collected.find((entry) => entry["config"] === CPU_CONFIG);
  if (target === undefined) return ["CPU config not reachable from test:all"];
  return target["script"] === AGGREGATE && target["gatedExternalCpu"] === true
    ? []
    : ["CPU config must use the explicit external CPU aggregate gate"];
}

describe("provider-free actual CPU qualification routing contract", () => {
  it("excludes actual CPU tests unconditionally at both package and repository roots", () => {
    expect(defaultRoutingIssues(defaultConfig)).toEqual([]);
    const test = requireRecord(requireRecord(defaultConfig, "config")["test"], "test");
    expect(requireStringArray(test["include"], "include")).toContain("tests/**/*.test.ts");
    expect(requireStringArray(test["include"], "include")).toContain(
      "apps/orchestration/tests/**/*.test.ts"
    );
    for (const name of ["test", "test:unit", "test:node-unit", "test:runner", "test:integration"]) {
      expect(script(name)).toContain("--config vitest.config.ts");
      expect(script(name)).not.toMatch(/videogen-media-cpu|--exclude/u);
    }
  });

  it.each(CPU_FILES)("detects a reverted default exclude for %s", (file) => {
    const test = requireRecord(requireRecord(defaultConfig, "config")["test"], "test");
    const exclude = requireStringArray(test["exclude"], "exclude").filter(
      (entry) => entry !== file
    );
    expect(defaultRoutingIssues({ test: { ...test, exclude } })).toEqual([file]);
  });

  it("dedicates the opt-in config to the unchanged real CPU suite only", () => {
    const test = requireRecord(requireRecord(cpuConfig, "CPU config")["test"], "CPU test");
    expect(requireStringArray(test["include"], "CPU include")).toEqual(CPU_FILES);
    expect(test["environment"]).toBe("node");
    expect(script(DIRECT)).toContain("--config vitest.videogen-media-cpu.config.ts");
    const suite = readFileSync(path.join(PACKAGE_ROOT, "tests/videogen-media-cpu.test.ts"), "utf8");
    expect(suite).not.toMatch(/\b(?:it|describe)\.(?:skip|skipIf|todo)\b/u);
    expect(suite).toContain('suppliedCpuBindings("")');
  });

  it.each([
    [undefined, undefined],
    ["1", undefined],
    ["1", ""],
    [undefined, PRIVATE_MARKER],
    ["true", PRIVATE_MARKER],
    ["0", PRIVATE_MARKER],
  ])(
    "refuses direct launch before Vitest without exact opt-in and bindings (%s)",
    (gate, bindings) => {
      expect(refusedBeforeRunner(script(DIRECT), environment(gate, bindings))).toBe(true);
    }
  );

  it("detects removal of either direct-command prerequisite", () => {
    const cli =
      "node ./node_modules/vitest/vitest.mjs run --config vitest.videogen-media-cpu.config.ts";
    expect(refusedBeforeRunner(cli, environment("1"))).toBe(false);
    expect(refusedBeforeRunner(cli, environment(undefined, PRIVATE_MARKER))).toBe(false);
  });

  it.each([undefined, "0", "true"])(
    "explicitly reports external CPU qualification NOT RUN without opt-in (%s), even with ambient bindings",
    (gate) => {
      using fixture = new RoutingFixture();
      const result = run(script(AGGREGATE), fixture.root, environment(gate, PRIVATE_MARKER));
      expect(result.status).toBe(0);
      expect(result.output).toContain("external CPU qualification NOT RUN");
      expect(result.output).not.toContain(RUNNER_MARKER);
      expect(result.output).not.toContain(PRIVATE_MARKER);
    }
  );

  it("propagates direct refusal rather than skipping when explicitly opted in without bindings", () => {
    using fixture = new RoutingFixture();
    const result = run(script(AGGREGATE), fixture.root, environment("1"));
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("NOT RUN");
    expect(result.output).not.toContain(RUNNER_MARKER);
  });

  it("routes explicit opt-in to the direct command (stub evidence, not a CPU pass)", () => {
    using fixture = new RoutingFixture();
    const result = run(script(AGGREGATE), fixture.root, environment("1", PRIVATE_MARKER));
    expect(result.status).toBe(0);
    expect(result.output).toContain(RUNNER_MARKER);
    expect(result.output).not.toContain("NOT RUN");
    expect(result.output).not.toContain(PRIVATE_MARKER);
  });

  it.each([
    `${PRIVATE_MARKER}{`,
    JSON.stringify(PRIVATE_MARKER),
    "null",
    "[]",
    "{}",
    JSON.stringify({ unexpected: PRIVATE_MARKER }),
  ])(
    "refuses malformed bindings at real CPU suite collection without disclosing them (case %#)",
    (bindings) => {
      const result = run(script(DIRECT), PACKAGE_ROOT, environment("1", bindings));
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("valid caller-supplied VIDEOGEN_MEDIA_TEST_BINDINGS JSON");
      expect(result.output).not.toContain(PRIVATE_MARKER);
      expect(result.output).not.toMatch(/Tests\s+\d+ passed/u);
    }
  );

  it("refuses a schema-valid but unavailable runtime binding without printing its private path", () => {
    using fixture = new RoutingFixture();
    const probe = path.join(fixture.root, "pinned-probe");
    const content = "provider-free pin fixture; never executed";
    writeFileSync(probe, content);
    const digest = createHash("sha256").update(content).digest("hex");
    const pinned = { path: probe, sha256: digest };
    const bindings = JSON.stringify({
      bubblewrap: pinned,
      prlimit: pinned,
      security_probe: pinned,
      fixture_ffmpeg: pinned,
      ffmpeg: {
        source: path.join(fixture.root, PRIVATE_MARKER),
        target: "/bin/ffmpeg",
        sha256: digest,
      },
      ffprobe: { source: probe, target: "/bin/ffprobe", sha256: digest },
      runtime_files: [],
      max_runtime_bytes: 4096,
    });
    const result = run(script(DIRECT), PACKAGE_ROOT, environment("1", bindings));
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("valid caller-supplied VIDEOGEN_MEDIA_TEST_BINDINGS JSON");
    expect(result.output).not.toContain(PRIVATE_MARKER);
    expect(result.output).not.toContain(fixture.root);
    expect(result.output).not.toMatch(/Tests\s+\d+ passed/u);
  });

  it("refuses config bypass without opt-in even when a binding value exists", () => {
    const result = run(
      "node ./node_modules/vitest/vitest.mjs run --config vitest.videogen-media-cpu.config.ts",
      PACKAGE_ROOT,
      environment(undefined, PRIVATE_MARKER)
    );
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("PENNY_VIDEOGEN_MEDIA_CPU=1");
    expect(result.output).not.toContain(PRIVATE_MARKER);
  });

  it("maps the root TypeScript runner to the explicit aggregate, not the direct command", () => {
    expect(cpuTargetIssues(targets(REPO_ROOT))).toEqual([]);
    expect(cpuTargetIssues([{ config: CPU_CONFIG, script: DIRECT }])).not.toEqual([]);
  });

  it("detects aggregate omission from authoritative package test:all reachability", () => {
    using fixture = new RoutingFixture();
    mkdirSync(path.join(fixture.root, ".pi/extensions"), { recursive: true });
    for (const name of ["observability", "platform-memory", "sca-service"]) {
      const directory = path.join(fixture.root, "apps", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: {} }));
    }
    const directory = path.join(fixture.root, "apps/orchestration");
    mkdirSync(directory, { recursive: true });
    for (const config of ["vitest.config.ts", "vitest.videogen-media-cpu.config.ts"])
      writeFileSync(path.join(directory, config), "export default {};\n");
    const routedScripts = {
      test: script("test"),
      "test:all": script("test:all"),
      [DIRECT]: script(DIRECT),
      [AGGREGATE]: script(AGGREGATE),
    };
    const manifest = path.join(directory, "package.json");
    writeFileSync(manifest, JSON.stringify({ scripts: routedScripts }));
    expect(cpuTargetIssues(targets(fixture.root))).toEqual([]);
    writeFileSync(
      manifest,
      JSON.stringify({
        scripts: {
          ...routedScripts,
          "test:all": routedScripts["test:all"].replace(` && bun run ${AGGREGATE}`, ""),
        },
      })
    );
    expect(cpuTargetIssues(targets(fixture.root))).toEqual([
      "CPU config not reachable from test:all",
    ]);
  });
});
