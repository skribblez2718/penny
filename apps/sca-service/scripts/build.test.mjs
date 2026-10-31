import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import process from "node:process";
import ts from "typescript";

const builder = readFileSync(new URL("./build.mjs", import.meta.url));
function snapshot(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [
      entry.name,
      entry.isDirectory()
        ? snapshot(path.join(directory, entry.name))
        : createHash("sha256")
            .update(readFileSync(path.join(directory, entry.name)))
            .digest("hex"),
    ]);
}
const entries = [
  "index",
  "p01-joern-root",
  "p03-bootstrap-cli",
  "job-store-cli",
  "process",
  "ordinary-runtime",
  "ordinary-application-tests",
  "ordinary-application-container",
  "ordinary-rule-learning",
  "p02-inventory-worker",
];

test("real bundles preserve one external orchestration instance even through nested adapters", () => {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-build-"));
  try {
    const service = path.join(root, "apps/sca-service");
    const orchestration = path.join(root, "apps/orchestration");
    mkdirSync(path.join(service, "scripts"), { recursive: true });
    mkdirSync(path.join(service, "src/adapters"), { recursive: true });
    mkdirSync(path.join(orchestration, "dist"), { recursive: true });
    for (const directory of [service, orchestration])
      writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({
          type: "module",
          exports: {
            "./artifact-store": {
              types: "./dist/artifact-store.d.ts",
              default: "./dist/artifact-store.js",
            },
          },
        })
      );
    writeFileSync(
      path.join(orchestration, "dist/artifact-store.js"),
      "export class ArtifactStore {}\n"
    );
    writeFileSync(path.join(service, "scripts/build.mjs"), builder);
    mkdirSync(path.join(orchestration, "scripts"));
    writeFileSync(
      path.join(orchestration, "scripts/shipping-imports.mjs"),
      readFileSync(new URL("../../orchestration/scripts/shipping-imports.mjs", import.meta.url))
    );
    symlinkSync(
      new URL("../../../node_modules", import.meta.url),
      path.join(root, "node_modules"),
      "dir"
    );
    writeFileSync(
      path.join(service, "src/adapters/fixture.ts"),
      'export { ArtifactStore } from "../../../orchestration/./dist/artifact-store.js";\nexport const metadata = "../../../orchestration/./dist/artifact-store.js";\n'
    );
    for (const entry of entries)
      writeFileSync(
        path.join(service, "src", entry + ".ts"),
        '#!/usr/bin/env node\nexport { ArtifactStore, metadata } from "./adapters/fixture.js";\n'
      );
    for (const file of [
      "p02-host-worker.mjs",
      "p02-osv-worker.mjs",
      "p02-scratch-launcher.mjs",
      "ordinary-application-tests-bridge.py",
      "ordinary-application-tests-guest.py",
    ])
      writeFileSync(path.join(service, "src", file), "# fixture asset\n");
    const build = () => spawnSync("bun", ["scripts/build.mjs"], { cwd: service, encoding: "utf8" });
    const result = build();
    assert.equal(result.status, 0, result.stderr);
    const first = readFileSync(path.join(service, "dist/index.js"), "utf8");
    const before = snapshot(path.join(service, "dist"));
    assert.match(first, /\.\.\/\.\.\/orchestration\/dist\/artifact-store.js/u);
    assert.doesNotMatch(first, /class ArtifactStore/u);
    assert.match(first, /orchestration\/\.\/dist\/artifact-store.js/u); // Metadata was not rewritten.
    const execution = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      const entry = await import(${JSON.stringify(pathToFileURL(path.join(service, "dist/index.js")).href)});
      const owner = await import(${JSON.stringify(pathToFileURL(path.join(orchestration, "dist/artifact-store.js")).href)});
      assert.equal(entry.ArtifactStore, owner.ArtifactStore);
      assert.equal(entry.metadata, "../../../orchestration/./dist/artifact-store.js");
    `,
      ],
      { encoding: "utf8" }
    );
    assert.equal(execution.status, 0, execution.stderr);
    writeFileSync(
      path.join(orchestration, "dist/private.js"),
      "export const privateValue = true;\n"
    );
    for (const specifier of [
      "../../../orchestration/dist/private.js",
      "../../../orchestration/./dist/private.js",
      "../../../%6frchestration/dist/%70rivate.js",
      "../../../orchestration/dist/../src/private.ts",
    ]) {
      writeFileSync(
        path.join(service, "src/adapters/fixture.ts"),
        `export * from ${JSON.stringify(specifier)};\n`
      );
      const refused = build();
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /Undeclared orchestration shipping import/u);
      assert.deepEqual(snapshot(path.join(service, "dist")), before);
      assert.equal(readdirSync(service).includes("build"), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Use the real facade and installed broker owner, not a synthetic copy of its schemas/classes.
const contractsSource = readFileSync(new URL("../src/contracts.ts", import.meta.url), "utf8");
const brokerOwner = new URL("../../orchestration/dist/sca/broker-contracts.js", import.meta.url);

function brokerFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-contract-build-"));
  const service = path.join(root, "apps/sca-service");
  const orchestration = path.join(root, "apps/orchestration");
  mkdirSync(path.join(service, "scripts"), { recursive: true });
  mkdirSync(path.join(service, "src/adapters"), { recursive: true });
  mkdirSync(path.join(orchestration, "dist/sca"), { recursive: true });
  mkdirSync(path.join(orchestration, "scripts"));
  writeFileSync(path.join(service, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    path.join(orchestration, "package.json"),
    readFileSync(new URL("../../orchestration/package.json", import.meta.url))
  );
  // A forwarding edge only: the real installed module still owns every value and freshness check.
  writeFileSync(
    path.join(orchestration, "dist/sca/broker-contracts.js"),
    `export * from ${JSON.stringify(brokerOwner.href)};\n`
  );
  writeFileSync(path.join(service, "scripts/build.mjs"), builder);
  writeFileSync(
    path.join(orchestration, "scripts/shipping-imports.mjs"),
    readFileSync(new URL("../../orchestration/scripts/shipping-imports.mjs", import.meta.url))
  );
  symlinkSync(
    new URL("../../../node_modules", import.meta.url),
    path.join(root, "node_modules"),
    "dir"
  );
  writeFileSync(path.join(service, "src/contracts.ts"), contractsSource);
  writeFileSync(
    path.join(service, "src/adapters/fixture.ts"),
    'export * from "../contracts.js";\n' +
      'export * as wildcard from "../contracts.js";\n' +
      'export { ScaBrokerContractError as namedError, validateScaBrokerExecuteRequestV1 as namedValidate } from "../../../orchestration/./dist/sca/broker-contracts.js";\n' +
      'export * as externalWildcard from "../../../orchestration/dist/sca/broker-contracts.js";\n'
  );
  for (const entry of entries)
    writeFileSync(
      path.join(service, "src", entry + ".ts"),
      '#!/usr/bin/env node\nexport * from "./adapters/fixture.js";\n'
    );
  for (const file of [
    "p02-host-worker.mjs",
    "p02-osv-worker.mjs",
    "p02-scratch-launcher.mjs",
    "ordinary-application-tests-bridge.py",
    "ordinary-application-tests-guest.py",
  ])
    writeFileSync(path.join(service, "src", file), "# fixture asset\n");
  return {
    root,
    service,
    orchestration,
    build: (script = "scripts/build.mjs") =>
      spawnSync("bun", [script], { cwd: service, encoding: "utf8" }),
    execute: (body) =>
      spawnSync(process.execPath, ["--input-type=module", "--eval", body], { encoding: "utf8" }),
  };
}

test("actual contracts preserve wildcard/named external surface and owner error identity in every build group", (t) => {
  const fixture = brokerFixture();
  try {
    const built = fixture.build();
    assert.equal(built.status, 0, built.stderr);
    for (const entry of entries) {
      const output = readFileSync(path.join(fixture.service, "dist", entry + ".js"), "utf8");
      assert.match(output, /\.\.\/\.\.\/orchestration\/dist\/sca\/broker-contracts.js/u);
      assert.doesNotMatch(output, /class ScaBrokerContractError|ORCHESTRATION_BUILD_STALE/u);
    }
    const check = fixture.execute(`
      import assert from "node:assert/strict";
      const owner = await import(${JSON.stringify(brokerOwner.href)});
      const service = ${JSON.stringify(pathToFileURL(fixture.service + "/").href)};
      const names = Object.keys(owner).sort();
      for (const name of ${JSON.stringify(entries)}) {
        const entry = await import(new URL("dist/" + name + ".js", service));
        assert.deepEqual(Object.keys(entry).sort(), [...names, "SCA_SERVICE_BROKER_MANIFEST_SHA256", "wildcard", "namedError", "namedValidate", "externalWildcard"].sort());
        assert.deepEqual(Object.keys(entry.wildcard).sort(), [...names, "SCA_SERVICE_BROKER_MANIFEST_SHA256"].sort());
        assert.deepEqual(Object.keys(entry.externalWildcard).sort(), names);
        for (const key of names) {
          assert.equal(entry[key], owner[key], name + ": named " + key);
          assert.equal(entry.wildcard[key], owner[key], name + ": wildcard " + key);
          assert.equal(entry.externalWildcard[key], owner[key], name + ": external " + key);
        }
        assert.equal(entry.namedError, owner.ScaBrokerContractError);
        assert.equal(entry.namedValidate, owner.validateScaBrokerExecuteRequestV1);
        assert.equal(entry.SCA_SERVICE_BROKER_MANIFEST_SHA256, owner.SCA_BROKER_SCHEMA_MANIFEST_SHA256);
        for (const validate of [entry.validateScaBrokerExecuteRequestV1, entry.wildcard.validateScaBrokerExecuteRequestV1, entry.namedValidate]) {
          assert.throws(() => validate({}), error => error instanceof owner.ScaBrokerContractError && error instanceof entry.ScaBrokerContractError && error instanceof entry.namedError);
        }
      }
      console.log(JSON.stringify({entries: ${entries.length}, runtimeExports: names.length, identity: "all values and thrown errors"}));
    `);
    assert.equal(check.status, 0, check.stderr);
    t.diagnostic(check.stdout.trim());
    // A pin failure must still be evaluated by the bundled consumer on import.
    const wrongPin = "0".repeat(64);
    const wrong = contractsSource.replace(
      /"[a-f0-9]{64}" as const/u,
      JSON.stringify(wrongPin) + " as const"
    );
    assert.notEqual(wrong, contractsSource);
    writeFileSync(path.join(fixture.service, "src/contracts.ts"), wrong);
    const rebuilt = fixture.build();
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    const refused = fixture.execute(`
      import assert from "node:assert/strict";
      await assert.rejects(import(${JSON.stringify(pathToFileURL(path.join(fixture.service, "dist/index.js")).href)}), /SCA broker manifest digest does not match the current contract/);
    `);
    assert.equal(refused.status, 0, refused.stderr);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("actual contracts retain every compiled broker type/value symbol and strict declaration surface", (t) => {
  const facade = fileURLToPath(new URL("../src/contracts.ts", import.meta.url));
  const declaration = fileURLToPath(
    new URL("../../orchestration/dist/sca/broker-contracts.d.ts", import.meta.url)
  );
  const program = ts.createProgram([facade, declaration], {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ["node"],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (file) => file,
      getNewLine: () => "\n",
    })
  );
  const checker = program.getTypeChecker();
  const exportsOf = (file) => {
    const source = program.getSourceFile(file);
    assert.ok(source);
    const symbol = checker.getSymbolAtLocation(source);
    assert.ok(symbol);
    return new Map(checker.getExportsOfModule(symbol).map((entry) => [entry.name, entry]));
  };
  const owner = exportsOf(declaration);
  const consumer = exportsOf(facade);
  assert.deepEqual(
    [...consumer.keys()].sort(),
    [...owner.keys(), "SCA_SERVICE_BROKER_MANIFEST_SHA256"].sort()
  );
  const target = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  for (const [name, symbol] of owner) {
    assert.ok(consumer.has(name), name);
    assert.equal(
      target(consumer.get(name)),
      target(symbol),
      name + " must retain its declaration owner"
    );
  }
  const pin = consumer.get("SCA_SERVICE_BROKER_MANIFEST_SHA256");
  assert.ok(pin);
  const pinType = checker.getTypeOfSymbolAtLocation(pin, program.getSourceFile(facade));
  assert.ok(pinType.isStringLiteral(), "the service digest must retain its literal type");
  t.diagnostic(
    JSON.stringify({ brokerSymbols: owner.size, strictDeclarationDiagnostics: diagnostics.length })
  );
});

test("refused staging/publication and rename rollback preserve the previous distribution", () => {
  const fixture = brokerFixture();
  try {
    const built = fixture.build();
    assert.equal(built.status, 0, built.stderr);
    const destination = path.join(fixture.service, "dist");
    const stage = path.join(fixture.service, "build");
    const before = snapshot(destination);
    mkdirSync(stage);
    writeFileSync(path.join(stage, "owner"), "not this invocation\n");
    const refusedStage = fixture.build();
    assert.notEqual(refusedStage.status, 0);
    assert.match(refusedStage.stderr, /EEXIST/u);
    assert.equal(readFileSync(path.join(stage, "owner"), "utf8"), "not this invocation\n");
    assert.deepEqual(snapshot(destination), before);
    rmSync(stage, { recursive: true }); // Only this test's own sentinel/staging.
    for (const mode of ["publication", "publication-and-rollback"]) {
      // Bun's named builtin import needs mock.module; mutating the fs namespace is not an oracle.
      writeFileSync(
        path.join(fixture.service, "scripts/refuse-publication.mjs"),
        `
        import * as fs from "node:fs";
        import { mock } from "bun:test";
        const rename = fs.renameSync;
        mock.module("node:fs", () => ({ ...fs, renameSync(from, to) {
          if (to === ${JSON.stringify(destination)} && (from === ${JSON.stringify(stage)} || ${JSON.stringify(mode)} === "publication-and-rollback"))
            throw new Error("fixture refused " + (from === ${JSON.stringify(stage)} ? "publication" : "rollback"));
          return rename(from, to);
        }}));
        try { await import("./build.mjs"); }
        catch (error) {
          console.error(JSON.stringify({ message: error.message, errors: error.errors?.map(e => e.message) }));
          process.exitCode = 1;
        }
      `
      );
      const refused = fixture.build("scripts/refuse-publication.mjs");
      assert.notEqual(refused.status, 0);
      assert.equal(readdirSync(fixture.service).includes("build"), false);
      if (mode === "publication") {
        assert.match(refused.stderr, /fixture refused publication/u);
        assert.deepEqual(snapshot(destination), before);
        assert.deepEqual(readdirSync(path.join(fixture.service, "out")), []);
      } else {
        const failure = JSON.parse(refused.stderr.trim());
        const prefix = "SCA publication failed; previous build preserved at ";
        assert.ok(failure.message.startsWith(prefix));
        assert.deepEqual(failure.errors, [
          "fixture refused publication",
          "fixture refused rollback",
        ]);
        const retained = failure.message.slice(prefix.length);
        assert.equal(path.dirname(path.dirname(retained)), path.join(fixture.service, "out"));
        assert.deepEqual(snapshot(retained), before);
        assert.equal(readdirSync(fixture.service).includes("dist"), false);
      }
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
