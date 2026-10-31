import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";
import { URL } from "node:url";

import { buildOrchestration, runBuildStep } from "./build.mjs";
import { shippingImportFindings, rewriteOrchestrationImports } from "./shipping-imports.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const temporary = mkdtempSync(path.join(tmpdir(), "penny-build-regression-"));
  roots.push(temporary);
  const root = path.join(temporary, "workspace with spaces & symbols;");
  const packageRoot = path.join(root, "apps/orchestration");
  mkdirSync(path.join(packageRoot, "src/videogen"), { recursive: true });
  mkdirSync(path.join(root, ".pi/extensions/artifacts"), { recursive: true });
  mkdirSync(path.join(root, ".pi/lib"), { recursive: true });
  mkdirSync(path.join(packageRoot, "scripts"));
  for (const name of ["package.json", "bun.lock", ".nvmrc"])
    writeFileSync(path.join(root, name), "{}\n");
  symlinkSync(
    new URL("../../../node_modules", import.meta.url),
    path.join(root, "node_modules"),
    "dir"
  );
  for (const name of ["build-provenance.ts", "shipping.ts"])
    writeFileSync(
      path.join(packageRoot, "src", name),
      readFileSync(new URL("../src/" + name, import.meta.url))
    );
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@penny/orchestration",
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      bin: { fixture: "./dist/cli.js" },
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    })
  );
  writeFileSync(
    path.join(packageRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        rootDir: "src",
        outDir: "dist",
        strict: true,
        declaration: true,
        sourceMap: true,
        noEmitOnError: true,
        types: ["node"],
        skipLibCheck: true,
      },
      include: ["src/**/*.ts"],
    })
  );
  writeFileSync(path.join(packageRoot, "src/index.ts"), "export class OrchestrationService {}\n");
  writeFileSync(path.join(packageRoot, "src/cli.ts"), "export const fixture = true;\n");
  writeFileSync(path.join(packageRoot, "src/videogen/voice-private-peer.py"), "# fixture asset\n");
  writeFileSync(
    path.join(root, ".pi/extensions/artifacts/index.ts"),
    "export const fixture = true;\n"
  );
  const dist = path.join(packageRoot, "dist");
  mkdirSync(path.join(dist, "nested"), { recursive: true });
  writeFileSync(path.join(dist, "index.js"), "export const previousBuild = true;\n");
  writeFileSync(path.join(dist, "nested/old-only.js"), "previous build asset\n");
  return { root, packageRoot, dist, before: snapshot(dist) };
}

function snapshot(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const candidate = path.join(directory, entry.name);
      const name = path.posix.join(prefix, entry.name);
      return entry.isDirectory()
        ? snapshot(candidate, name)
        : [[name, createHash("sha256").update(readFileSync(candidate)).digest("hex")]];
    });
}

function assertRetained(f) {
  assert.deepEqual(snapshot(f.dist), f.before);
  assert.equal(readdirSync(f.packageRoot).includes("build"), false);
  assert.equal(readdirSync(f.packageRoot).includes(".build-lock"), false);
}

test("the package build and ordinary test gates use the safe builder and its regressions", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts.build, "node scripts/build.mjs");
  assert.match(manifest.scripts["test:all"], /\bbun run test:build\b/u);
  assert.match(manifest.scripts["test:unit"], /\bbun run test:build\b/u);
});

test("real compiler failure preserves every previous output byte", async () => {
  const f = fixture();
  writeFileSync(path.join(f.packageRoot, "src/index.ts"), "const invalid: string = 123;\n");
  await assert.rejects(buildOrchestration({ packageRoot: f.packageRoot }), /Build step failed/u);
  assertRetained(f);
});

test("real worker bundling failure preserves the previous package after compilation", async () => {
  const f = fixture();
  writeFileSync(path.join(f.root, ".pi/extensions/artifacts/index.ts"), "export const = ;\n");
  await assert.rejects(buildOrchestration({ packageRoot: f.packageRoot }), /Build step failed/u);
  assertRetained(f);
});

test("missing copied asset preserves the previous package", async () => {
  const f = fixture();
  rmSync(path.join(f.packageRoot, "src/videogen/voice-private-peer.py"));
  await assert.rejects(buildOrchestration({ packageRoot: f.packageRoot }), /regular.*file/u);
  assertRetained(f);
});

test("missing declared entry point refuses to publish", async () => {
  const f = fixture();
  rmSync(path.join(f.packageRoot, "src/cli.ts"));
  await assert.rejects(buildOrchestration({ packageRoot: f.packageRoot }), /regular.*file/u);
  assertRetained(f);
});

test("a runtime import failure refuses to publish otherwise compiled output", async () => {
  const f = fixture();
  writeFileSync(
    path.join(f.packageRoot, "src/index.ts"),
    'throw new Error("synthetic import refusal"); export class OrchestrationService {}\n'
  );
  await assert.rejects(buildOrchestration({ packageRoot: f.packageRoot }), /Build step failed/u);
  assertRetained(f);
});

test("success publishes a complete fresh tree, removes stale files and keeps source maps valid", async () => {
  const f = fixture();
  const oldMode = lstatSync(f.dist).mode & 0o777;
  await buildOrchestration({ packageRoot: f.packageRoot });
  assert.match(readFileSync(path.join(f.dist, "index.js"), "utf8"), /class OrchestrationService/u);
  assert.equal(
    readFileSync(path.join(f.dist, "videogen/voice-private-peer.py"), "utf8"),
    "# fixture asset\n"
  );
  for (const name of ["index.d.ts", "cli.js", "artifact-worker.js"]) {
    assert.equal(lstatSync(path.join(f.dist, name)).isFile(), true);
  }
  assert.equal(lstatSync(f.dist).mode & 0o777, oldMode);
  assert.equal(readdirSync(f.dist).includes("nested"), false);
  const map = JSON.parse(readFileSync(path.join(f.dist, "index.js.map"), "utf8"));
  assert.deepEqual(map.sources, ["../src/index.ts"]);
  assert.deepEqual(
    readdirSync(f.packageRoot).filter((name) => name.startsWith(".build-")),
    []
  );
});

test("a first build succeeds without an existing dist directory", async () => {
  const f = fixture();
  rmSync(f.dist, { recursive: true });
  await buildOrchestration({ packageRoot: f.packageRoot });
  assert.match(readFileSync(path.join(f.dist, "index.js"), "utf8"), /class OrchestrationService/u);
  assert.equal(lstatSync(path.join(f.dist, "artifact-worker.js")).isFile(), true);
  assert.equal(readdirSync(f.packageRoot).includes("build"), false);
});

test("an existing staging directory is preserved rather than reused or deleted", async () => {
  const f = fixture();
  const stage = path.join(f.packageRoot, "build");
  mkdirSync(stage);
  writeFileSync(path.join(stage, "retained.txt"), "retained prior work\n");
  await assert.rejects(buildOrchestration({ packageRoot: f.packageRoot }), /EEXIST/u);
  assert.deepEqual(snapshot(f.dist), f.before);
  assert.equal(readFileSync(path.join(stage, "retained.txt"), "utf8"), "retained prior work\n");
  assert.equal(readdirSync(f.packageRoot).includes(".build-lock"), false);
});

test("publication failure restores the previous directory", async () => {
  const f = fixture();
  await assert.rejects(
    buildOrchestration({
      packageRoot: f.packageRoot,
      move: (source, destination) => {
        if (path.basename(source) === "build" && destination === f.dist) {
          throw new Error("synthetic promotion failure");
        }
        renameSync(source, destination);
      },
    }),
    /synthetic promotion failure/u
  );
  assertRetained(f);
});

test("failed rollback preserves the previous output at the reported recovery path", async () => {
  const f = fixture();
  await assert.rejects(
    buildOrchestration({
      packageRoot: f.packageRoot,
      move: (source, destination) => {
        if (destination === f.dist) throw new Error("synthetic publication filesystem failure");
        renameSync(source, destination);
      },
    }),
    /previous output is preserved/u
  );
  const previousRoot = path.join(f.packageRoot, "out");
  const retained = readdirSync(previousRoot).filter((name) => name.startsWith("previous-"));
  assert.equal(retained.length, 1);
  assert.deepEqual(snapshot(path.join(previousRoot, retained[0], "dist")), f.before);
  assert.equal(readdirSync(f.packageRoot).includes(".build-lock"), false);
});

test("an overlapping build refuses without releasing the first build's lock", async () => {
  const f = fixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let firstStep = true;
  const first = buildOrchestration({
    packageRoot: f.packageRoot,
    runCommand: async (...args) => {
      if (firstStep) {
        firstStep = false;
        entered.resolve();
        await release.promise;
      }
      return runBuildStep(...args);
    },
  });
  try {
    await entered.promise;
    await assert.rejects(buildOrchestration({ packageRoot: f.packageRoot }), /build is locked/u);
    assert.deepEqual(snapshot(f.dist), f.before);
    assert.equal(lstatSync(path.join(f.packageRoot, ".build-lock")).isDirectory(), true);
  } finally {
    release.resolve();
    await first;
  }
});

test("an interrupted build's lock is not guessed stale or silently removed", async () => {
  const f = fixture();
  const lock = path.join(f.packageRoot, ".build-lock");
  mkdirSync(lock);
  writeFileSync(path.join(lock, "owner.json"), '{"pid":1}\n');
  await assert.rejects(buildOrchestration({ packageRoot: f.packageRoot }), /inspect owner.json/u);
  assert.deepEqual(snapshot(f.dist), f.before);
  assert.equal(readFileSync(path.join(lock, "owner.json"), "utf8"), '{"pid":1}\n');
});

test("a symlinked destination is refused without touching its target", async () => {
  const f = fixture();
  const previous = path.join(f.packageRoot, "existing-output");
  renameSync(f.dist, previous);
  symlinkSync(previous, f.dist, "dir");
  await assert.rejects(buildOrchestration({ packageRoot: f.packageRoot }), /real directory/u);
  assert.deepEqual(snapshot(previous), f.before);
  assert.equal(lstatSync(f.dist).isSymbolicLink(), true);
});

test("cancellation waits for the build child and preserves the previous package", async () => {
  const f = fixture();
  const controller = new globalThis.AbortController();
  const entered = Promise.withResolvers();
  const build = buildOrchestration({
    packageRoot: f.packageRoot,
    signal: controller.signal,
    runCommand: (_command, _args, options) => {
      const child = runBuildStep(
        process.execPath,
        ["--eval", "setInterval(() => {}, 1000)"],
        options
      );
      entered.resolve();
      return child;
    },
  });
  await entered.promise;
  controller.abort();
  await assert.rejects(build, /abort/iu);
  assertRetained(f);
});

function importFixture(f, entry = "index.js") {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "await import(process.argv[1])",
      new URL(entry, new URL("file://" + f.dist + "/")).href,
    ],
    { encoding: "utf8" }
  );
}

test("shipping import detector rejects source, dist bypasses, aliases and undeclared exports", () => {
  const workspace = path.resolve("fixture-workspace");
  const file = path.join(workspace, ".pi/extensions/fixture/index.ts");
  const exports = { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } };
  for (const source of [
    'import { X } from "@penny/orchestration/source";',
    'const x = import("../../../apps/orchestration/src/service.js");',
    'export * from "../../../apps/orchestration/dist/service.js";',
    'vi.mock("../../../apps/orchestration/src/index.ts");',
    'import type { X } from "@penny/orchestration/unknown";',
    'import type { X } from "@penny/orchestration/%73ource";',
    'const required = require("../../../apps/orchestration/./dist/private.js");',
    'type T = import("../../../apps/orchestration/./src/private.js").T;',
    'import module = require("../../../apps/orchestration/./src/private.js");',
  ])
    assert.equal(shippingImportFindings(source, file, workspace, exports).length, 1);
  assert.deepEqual(
    shippingImportFindings('import { X } from "@penny/orchestration";', file, workspace, exports),
    []
  );
});

test("shipping canonical paths reject private targets and leave metadata alone", () => {
  const workspace = path.resolve("fixture-workspace");
  const packageRoot = path.join(workspace, "apps/orchestration");
  const file = path.join(workspace, "apps/sca-service/src/fixture.ts");
  const destination = path.join(workspace, "apps/sca-service/dist");
  const exports = { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } };
  for (const specifier of [
    "../../orchestration/./dist/private.js",
    "../../orchestration/dist/../dist/private.js",
    "../../%6frchestration/dist/%70rivate.js",
    "../../orchestration/src/../src/private.js",
    "../../orchestration/%73rc/private.js",
    "../../orchestration/dist/private.js?query#fragment",
    "../../orchestration/dist/private.js".replaceAll("/", "\\"),
    new URL("file://" + path.join(packageRoot, "dist/private.js")).href,
  ]) {
    const source = `export * from ${JSON.stringify(specifier)};`;
    assert.equal(shippingImportFindings(source, file, workspace, exports).length, 1, source);
    assert.throws(
      () => rewriteOrchestrationImports(source, file, packageRoot, exports, destination),
      /Undeclared/u
    );
  }
  const escaped = 'import "../../orchestrati\\u006fn/./dist/private.js";';
  assert.equal(shippingImportFindings(escaped, file, workspace, exports).length, 1);
  const metadata = 'const source = "../../orchestration/./dist/private.js";';
  assert.deepEqual(shippingImportFindings(metadata, file, workspace, exports), []);
  assert.equal(
    rewriteOrchestrationImports(metadata, file, packageRoot, exports, destination),
    metadata
  );
  assert.equal(
    rewriteOrchestrationImports(
      'import "@penny/orchestration";',
      file,
      packageRoot,
      exports,
      destination
    ),
    'import "../../orchestration/dist/index.js";'
  );
  assert.throws(
    () =>
      rewriteOrchestrationImports(
        'import "@penny/orchestration/private";',
        file,
        packageRoot,
        exports,
        destination
      ),
    /Undeclared/u
  );
  const publicPath = "../../orchestration/./dist/%69ndex.js";
  const publicImport = `export * from ${JSON.stringify(publicPath)}; const metadata = ${JSON.stringify(publicPath)};`;
  assert.deepEqual(shippingImportFindings(publicImport, file, workspace, exports), []);
  assert.equal(
    rewriteOrchestrationImports(publicImport, file, packageRoot, exports, destination),
    `export * from "../../orchestration/dist/index.js"; const metadata = ${JSON.stringify(publicPath)};`
  );
});

test("shipping resolves symlink aliases before checking the export allowlist", () => {
  const f = fixture();
  const privateFile = path.join(f.dist, "private.js");
  writeFileSync(privateFile, "export {};\n");
  const file = path.join(f.root, ".pi/extensions/artifacts/index.ts");
  symlinkSync(f.dist, path.join(f.root, "alias"), "dir");
  const exports = { ".": "./dist/index.js" };
  const source = 'import "../../../alias/private.js";';
  assert.equal(shippingImportFindings(source, file, f.root, exports).length, 1);
  assert.throws(
    () => rewriteOrchestrationImports(source, file, f.packageRoot, exports, f.dist),
    /Undeclared/u
  );
});

test("provenance is deterministic and binds source, helper graph, declarations and copied assets", async () => {
  const f = fixture();
  await buildOrchestration({ packageRoot: f.packageRoot });
  const first = snapshot(f.dist);
  const manifest = JSON.parse(readFileSync(path.join(f.dist, "build-provenance.json"), "utf8"));
  assert.ok(manifest.inputs["apps/orchestration/src/index.ts"]);
  assert.deepEqual(manifest.helper_inputs, [".pi/extensions/artifacts/index.ts"]);
  for (const file of ["artifact-worker.js", "index.d.ts", "videogen/voice-private-peer.py"])
    assert.ok(manifest.outputs[file]);
  assert.equal(importFixture(f).status, 0);
  await buildOrchestration({ packageRoot: f.packageRoot });
  assert.deepEqual(snapshot(f.dist), first);
});

test("fresh processes refuse changed source, helper, declarations, missing provenance and new source files", async () => {
  const f = fixture();
  await buildOrchestration({ packageRoot: f.packageRoot });
  for (const file of [
    path.join(f.packageRoot, "src/index.ts"),
    path.join(f.root, ".pi/extensions/artifacts/index.ts"),
    path.join(f.dist, "index.d.ts"),
    path.join(f.dist, "artifact-worker.js"),
    path.join(f.dist, "build-provenance.json"),
  ]) {
    const original = readFileSync(file);
    writeFileSync(
      file,
      file.endsWith(".json") ? "{}" : Buffer.concat([original, Buffer.from("\n// drift\n")])
    );
    for (const entry of ["index.js", "cli.js", "artifact-worker.js"]) {
      const execution = importFixture(f, entry);
      assert.notEqual(execution.status, 0);
      assert.match(execution.stderr, /ORCHESTRATION_BUILD_STALE/u);
    }
    writeFileSync(file, original);
  }
  writeFileSync(path.join(f.packageRoot, "src/new.ts"), "export {};\n");
  assert.match(importFixture(f).stderr, /ORCHESTRATION_BUILD_STALE/u);
});

test("source mutation during compilation refuses publication and preserves the prior generation", async () => {
  const f = fixture();
  let first = true;
  await assert.rejects(
    buildOrchestration({
      packageRoot: f.packageRoot,
      runCommand: async (...args) => {
        await runBuildStep(...args);
        if (first) {
          first = false;
          writeFileSync(path.join(f.packageRoot, "src/cli.ts"), "export const changed = true;\n");
        }
      },
    }),
    /inputs changed/u
  );
  assertRetained(f);
});

test("an already loaded generation refuses a later rebuild instead of loading a new helper into old classes", async () => {
  const f = fixture();
  await buildOrchestration({ packageRoot: f.packageRoot });
  await import(new URL("file://" + path.join(f.dist, "index.js")).href);
  const { assertCurrentShippingBuild } = await import(
    new URL("file://" + path.join(f.dist, "build-provenance.js")).href
  );
  const before = assertCurrentShippingBuild();
  writeFileSync(path.join(f.packageRoot, "src/cli.ts"), "export const changed = true;\n");
  await buildOrchestration({ packageRoot: f.packageRoot });
  assert.throws(() => assertCurrentShippingBuild(), /ORCHESTRATION_BUILD_STALE/u);
  await assert.rejects(
    import(new URL("file://" + path.join(f.dist, "cli.js")).href),
    /ORCHESTRATION_BUILD_STALE/u
  );
  assert.ok(before.generation);
  assert.equal(importFixture(f).status, 0);
});
