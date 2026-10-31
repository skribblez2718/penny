/** Routing oracles only: the fake Vitest entry point cannot qualify native/CPU work. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import defaultConfig from "../vitest.config.js";
import nativeConfig from "../vitest.videogen-native-cpu.config.js";
import {
  parseJson,
  requireRecord,
  requireString,
  requireStringArray,
} from "./helpers/narrowing.js";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const config = "apps/orchestration/vitest.videogen-native-cpu.config.ts";
const direct = "test:videogen-native-cpu";
const aggregate = `${direct}:aggregate`;
const marker = "NATIVE_ROUTING_STUB_ONLY_NOT_QUALIFICATION";
const privateMarker = "private-binding-must-not-appear";
const files = [
  "videogen-native-production",
  "videogen-native-production-owner",
  "videogen-default-native-flow",
].flatMap((name) => [`apps/orchestration/tests/${name}.test.ts`, `tests/${name}.test.ts`]);
const scripts = requireRecord(
  requireRecord(parseJson(readFileSync(path.join(packageRoot, "package.json"), "utf8")), "package")[
    "scripts"
  ],
  "scripts"
);
const script = (name: string) => requireString(scripts[name], name);

function environment(gate?: string, native?: string, media?: string): NodeJS.ProcessEnv {
  // Never pass through ambient opt-ins, credentials, state roots or private bindings.
  return {
    PATH: requireString(process.env["PATH"], "PATH"),
    NO_COLOR: "1",
    ...(gate === undefined ? {} : { PENNY_VIDEOGEN_NATIVE_CPU: gate }),
    ...(native === undefined ? {} : { VIDEOGEN_NATIVE_TEST_BINDINGS: native }),
    ...(media === undefined ? {} : { VIDEOGEN_MEDIA_TEST_BINDINGS: media }),
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
  readonly root = mkdtempSync(path.join(tmpdir(), "penny-native-routing-"));
  constructor() {
    const cli = path.join(this.root, "node_modules/vitest/vitest.mjs");
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, `process.stdout.write(${JSON.stringify(marker)} + "\\n");`);
    writeFileSync(
      path.join(this.root, "package.json"),
      JSON.stringify({ scripts: { [direct]: script(direct), [aggregate]: script(aggregate) } })
    );
  }
  [Symbol.dispose](): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

function targets(root: string): Record<string, unknown>[] {
  const runner = path.join(repoRoot, "scripts/system/checks/typescript-tests.mjs");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { pathToFileURL } from "node:url"; const { collectTypeScriptTestTargets } = await import(pathToFileURL(process.argv[2]).href); process.stdout.write(JSON.stringify(collectTypeScriptTestTargets(process.argv[3])));',
      "native-routing-contract",
      runner,
      root,
    ],
    { env: environment(), encoding: "utf8", maxBuffer: 1_048_576 }
  );
  if (result.error !== undefined) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) throw new Error("runner targets must be an array");
  return parsed.map((entry: unknown) => requireRecord(entry, "target"));
}

function targetIssues(collected: Record<string, unknown>[]): string[] {
  const target = collected.find((entry) => entry["config"] === config);
  if (target === undefined) return ["native config not reachable from test:all"];
  return target["script"] === aggregate &&
    target["gatedExternalCpu"] === true &&
    target["gatedLiveModel"] === false
    ? []
    : ["native config must route through its external CPU aggregate gate"];
}

describe("provider-free native/CPU qualification routing contract", () => {
  it("excludes all actual native/CPU cohorts at both roots and dedicates their explicit config", () => {
    const defaultTest = requireRecord(requireRecord(defaultConfig, "default")["test"], "test");
    const excludes = requireStringArray(defaultTest["exclude"], "excludes");
    for (const file of files) expect(excludes).toContain(file);
    const nativeTest = requireRecord(requireRecord(nativeConfig, "native")["test"], "test");
    expect(requireStringArray(nativeTest["include"], "include").sort()).toEqual([...files].sort());
    expect(nativeTest["environment"]).toBe("node");
    expect(nativeTest["fileParallelism"]).toBe(false);
    expect(script(direct)).toContain("--config vitest.videogen-native-cpu.config.ts");
  });

  it.each([
    [undefined, undefined, undefined],
    ["1", undefined, privateMarker],
    ["1", privateMarker, undefined],
    ["1", "", privateMarker],
    ["1", privateMarker, ""],
    [undefined, privateMarker, privateMarker],
    ["true", privateMarker, privateMarker],
    ["0", privateMarker, privateMarker],
  ])(
    "refuses direct launch before Vitest without exact opt-in and both bindings (%#)",
    (gate, native, media) => {
      using fixture = new RoutingFixture();
      const result = run(script(direct), fixture.root, environment(gate, native, media));
      expect(result.status).not.toBe(0);
      expect(result.output).not.toContain(marker);
      expect(result.output).not.toContain(privateMarker);
    }
  );

  it.each([undefined, "0", "true"])(
    "reports NOT RUN offline even with ambient bindings (%s)",
    (gate) => {
      using fixture = new RoutingFixture();
      const result = run(
        script(aggregate),
        fixture.root,
        environment(gate, privateMarker, privateMarker)
      );
      expect(result.status).toBe(0);
      expect(result.output).toContain("Native/CPU qualification NOT RUN");
      expect(result.output).not.toContain(marker);
      expect(result.output).not.toContain(privateMarker);
    }
  );

  it.each([
    [undefined, undefined],
    [undefined, privateMarker],
    [privateMarker, undefined],
  ])("propagates opted-in refusal for missing required private bindings (%#)", (native, media) => {
    using fixture = new RoutingFixture();
    const result = run(script(aggregate), fixture.root, environment("1", native, media));
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("NOT RUN");
    expect(result.output).not.toContain(marker);
    expect(result.output).not.toContain(privateMarker);
  });

  it("routes full explicit opt-in to the direct runner (stub evidence only)", () => {
    using fixture = new RoutingFixture();
    const result = run(
      script(aggregate),
      fixture.root,
      environment("1", privateMarker, privateMarker)
    );
    expect(result.status).toBe(0);
    expect(result.output).toContain(marker);
    expect(result.output).not.toContain("NOT RUN");
    expect(result.output).not.toContain(privateMarker);
  });

  it("maps root discovery to the external CPU aggregate and detects direct-command regression", () => {
    expect(targetIssues(targets(repoRoot))).toEqual([]);
    expect(
      targetIssues([{ config, script: direct, gatedLiveModel: false, gatedExternalCpu: true }])
    ).not.toEqual([]);
  });

  it("requires native enrollment in package test:all reachability", () => {
    using fixture = new RoutingFixture();
    mkdirSync(path.join(fixture.root, ".pi/extensions"), { recursive: true });
    for (const name of ["observability", "platform-memory", "sca-service"]) {
      const directory = path.join(fixture.root, "apps", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: {} }));
    }
    const directory = path.join(fixture.root, "apps/orchestration");
    mkdirSync(directory, { recursive: true });
    for (const name of ["vitest.config.ts", "vitest.videogen-native-cpu.config.ts"])
      writeFileSync(path.join(directory, name), "export default {};\n");
    const routedScripts = {
      test: script("test"),
      "test:all": script("test:all"),
      [direct]: script(direct),
      [aggregate]: script(aggregate),
    };
    const manifest = path.join(directory, "package.json");
    writeFileSync(manifest, JSON.stringify({ scripts: routedScripts }));
    expect(targetIssues(targets(fixture.root))).toEqual([]);
    writeFileSync(
      manifest,
      JSON.stringify({
        scripts: {
          ...routedScripts,
          "test:all": routedScripts["test:all"].replace(` && bun run ${aggregate}`, ""),
        },
      })
    );
    expect(targetIssues(targets(fixture.root))).toEqual([
      "native config not reachable from test:all",
    ]);
  });
});
