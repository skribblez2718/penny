#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  analyzeTypeScriptGuard,
  MANDATORY_COMPILER_OPTIONS,
  MANDATORY_ESLINT_RULES,
} from "./typescript-guard.mjs";
import {
  TYPE_AWARE_LINT_TARGETS,
  runTypeScriptLintFiles,
  validateTypeAwareTargets,
} from "./typescript-lint.mjs";
import { collectTypeScriptTestTargets, runTypeScriptTests } from "./typescript-tests.mjs";

const SCOPED_ROOTS = [
  ".pi/extensions",
  ".pi/lib",
  "apps/observability",
  "apps/orchestration",
  "apps/platform-memory",
];
const EXPECTED_DETECTOR_CODES = new Set([
  "ROOT_MISSING",
  "ESLINT_CONFIG_ERROR",
  "ESLINT_OMITTED",
  "ESLINT_RULE_DOWNGRADE",
  "TSC_CONFIG_ERROR",
  "TSC_OPTION_DOWNGRADE",
  "TSC_OMITTED",
  "TSC_DECLARATION_SKIPPED",
  "TEST_RUNNER_UNMAPPED",
  "SYNTAX_ERROR",
  "EXPLICIT_ANY",
  "POSTFIX_NON_NULL",
  "DEFINITE_ASSIGNMENT",
  "UNSAFE_ASSERTION",
  "DOUBLE_ASSERTION",
  "UNSUPPORTED_PI_IMPORT",
  "UNSUPPORTED_PI_AMBIENT",
  "RAW_PI_REGISTER_TOOL",
  "TEST_HOST_EXCEPTION_INVALID",
  "PKG_MANIFEST_MISSING",
  "PKG_MANIFEST_INVALID",
  "PKG_TYPEBOX_IMPORT",
  "PKG_UNSUPPORTED_PI_PACKAGE",
  "PKG_PEER_DEPENDENCY",
  "PKG_DEPENDENCY_PLACEMENT",
  "PKG_ROOT_PIN",
  "PKG_TYPECHECK_SCRIPT",
  "PKG_TEST_ALL",
  "PKG_TSCONFIG",
  "PKG_PACKAGE_LOCK",
  "EXT_CONSOLE",
  "EXT_MODULE_ENV",
  "TS_NOCHECK",
  "TS_IGNORE",
  "TS_EXPECT_ERROR_INVALID",
  "ESLINT_CONTRACT_SUPPRESSION",
  "ESLINT_BROAD_SUPPRESSION",
  "ESLINT_UNUSED_SUPPRESSION",
]);

const projectRoot = process.cwd();
const temporaryParent = mkdtempSync(path.join(tmpdir(), "penny-typescript-guard-"));
const baseFixture = path.join(temporaryParent, "positive-base");
const coveredCodes = new Set();
let passed = 0;
let failed = 0;
let cleanupChecks = 0;

function write(root, relative, content) {
  const destination = path.join(root, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function writeJson(root, relative, value) {
  write(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}

function updateJson(root, relative, update) {
  const value = readJson(root, relative);
  update(value);
  writeJson(root, relative, value);
}

function strictTsconfig() {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: ["node"],
    },
    include: ["**/*.ts", "**/*.tsx", "**/*.d.ts"],
    exclude: ["node_modules", "dist"],
  };
}

function buildPositiveFixture(root) {
  mkdirSync(root, { recursive: true });
  symlinkSync(path.join(projectRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  const rules = Object.fromEntries(MANDATORY_ESLINT_RULES.map((rule) => [rule, "error"]));
  write(
    root,
    "eslint.config.mjs",
    `import tseslint from "typescript-eslint";\n\nexport default [\n  { ignores: ["node_modules/**", "**/dist/**"] },\n  {\n    files: ["**/*.ts", "**/*.tsx"],\n    languageOptions: {\n      parser: tseslint.parser,\n      parserOptions: { project: true, tsconfigRootDir: import.meta.dirname },\n    },\n    plugins: { "@typescript-eslint": tseslint.plugin },\n    rules: ${JSON.stringify(rules, null, 6)},\n  },\n];\n`
  );
  writeJson(root, "package.json", {
    name: "guard-fixture",
    private: true,
    type: "module",
    scripts: {
      typecheck:
        "tsc -p .pi/lib/tsconfig.json && tsc -p apps/observability/tsconfig.json && tsc -p apps/orchestration/tsconfig.json && tsc -p apps/platform-memory/tsconfig.json",
    },
    devDependencies: {
      "@earendil-works/pi-agent-core": "0.84.2",
      "@earendil-works/pi-ai": "0.84.2",
      "@earendil-works/pi-coding-agent": "0.84.2",
      "@earendil-works/pi-tui": "0.84.2",
      typebox: "1.3.7",
      typescript: "6.0.3",
    },
  });

  writeJson(root, ".pi/extensions/demo/package.json", {
    name: "@fixture/demo",
    private: true,
    type: "module",
    scripts: {
      typecheck: "tsc --noEmit",
      "test:unit": "vitest run --config tests/vitest.config.ts",
      "test:all": "bun run typecheck && bun run test:unit",
    },
    peerDependencies: {
      "@earendil-works/pi-coding-agent": "*",
      typebox: "*",
    },
  });
  writeJson(root, ".pi/extensions/demo/tsconfig.json", strictTsconfig());
  write(
    root,
    ".pi/extensions/demo/index.ts",
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nimport { Type } from "typebox";\n\nexport default function setup(_pi: ExtensionAPI) {\n  return Type.Object({ value: Type.String() });\n}\n`
  );
  write(
    root,
    ".pi/extensions/demo/tests/unit/example.test.ts",
    "export const runnerProof = true;\n"
  );
  write(
    root,
    ".pi/extensions/demo/tests/vitest.config.ts",
    `export default { test: { include: ["tests/unit/**/*.test.ts"] } };\n`
  );

  writeJson(root, ".pi/lib/tsconfig.json", strictTsconfig());
  write(
    root,
    ".pi/lib/pi-tool-registration.ts",
    `interface PiApi { registerTool(definition: unknown): void }\nexport function register(pi: PiApi): void { pi.registerTool({}); }\n`
  );
  write(root, ".pi/lib/owned.d.ts", "export interface OwnedDeclaration { value: string }\n");
  write(root, ".pi/lib/fresh-untracked.ts", "export const discoveredFromDisk = true;\n");

  for (const application of ["observability", "orchestration", "platform-memory"]) {
    writeJson(root, `apps/${application}/tsconfig.json`, strictTsconfig());
    write(
      root,
      `apps/${application}/src/index.ts`,
      `export const ${application.replace("-", "_")} = true;\n`
    );
  }
}

function buildTypeAwareTargetFixture(root) {
  for (const target of TYPE_AWARE_LINT_TARGETS) {
    writeJson(root, target.project, strictTsconfig());
    const sample =
      target.exactFiles[0] ??
      `${target.prefixes[0]}/__ts420_${target.id.replace(/[^a-z0-9]+/giu, "_")}.ts`;
    write(root, sample, `export const target_${target.id.replace(/[^a-z0-9]+/giu, "_")} = true;\n`);
  }
}

function runnerPackage(root, relative, scripts) {
  writeJson(root, `${relative}/package.json`, {
    name: `@fixture/${relative.replace(/[^a-z0-9]+/giu, "-")}`,
    private: true,
    type: "module",
    scripts,
  });
}

function runnerConfig(root, relative, include) {
  write(root, relative, `export default { test: { include: [${JSON.stringify(include)}] } };\n`);
}

function passingTest(root, relative, label) {
  write(
    root,
    relative,
    `import { expect, it } from "vitest";\nit(${JSON.stringify(label)}, () => expect(true).toBe(true));\n`
  );
}

function buildRunnerFixture(root) {
  mkdirSync(root, { recursive: true });
  symlinkSync(path.join(projectRoot, "node_modules"), path.join(root, "node_modules"), "dir");

  runnerPackage(root, ".pi/extensions/demo", {
    "test:unit": "vitest run --config tests/vitest.config.ts",
    "test:all": "bun run test:unit",
  });
  runnerConfig(root, ".pi/extensions/demo/tests/vitest.config.ts", "tests/unit/**/*.test.ts");
  passingTest(
    root,
    ".pi/extensions/demo/tests/unit/passing.test.ts",
    "extension unit layout passes"
  );

  runnerPackage(root, "apps/observability", {
    "test:unit": "vitest run --config vitest.config.ts",
    "test:all": "bun run test:unit",
  });
  runnerConfig(root, "apps/observability/vitest.config.ts", "tests/**/*.test.ts");
  passingTest(root, "apps/observability/tests/passing.test.ts", "application layout passes");

  runnerPackage(root, "apps/orchestration", {
    "test:unit": "vitest run --config vitest.config.ts",
    "test:kb-model-smoke": "vitest run --config vitest.kb-model-smoke.config.ts",
    "test:kb-model-smoke:aggregate": "vitest run --config vitest.kb-model-smoke.config.ts",
    "test:all": "bun run test:unit && bun run test:kb-model-smoke:aggregate",
  });
  runnerConfig(root, "apps/orchestration/vitest.config.ts", "tests/**/*.test.ts");
  runnerConfig(root, "apps/orchestration/vitest.kb-model-smoke.config.ts", "smoke/**/*.test.ts");
  passingTest(root, "apps/orchestration/tests/passing.test.ts", "orchestration layout passes");
  passingTest(root, "apps/orchestration/smoke/passing.test.ts", "gated smoke layout passes");

  runnerPackage(root, "apps/platform-memory", {
    "test:unit": "vitest run --config tests/vitest.config.ts",
    "test:all": "bun run test:unit",
  });
  runnerConfig(root, "apps/platform-memory/tests/vitest.config.ts", "tests/unit/**/*.test.ts");
  passingTest(
    root,
    "apps/platform-memory/tests/unit/passing.test.ts",
    "platform application layout passes"
  );
}

function runFocusedVitest(config, testFile, cwdRelative) {
  const absoluteConfig = path.join(projectRoot, config);
  const cwd = path.join(projectRoot, cwdRelative);
  const relativeConfig = path.relative(cwd, absoluteConfig);
  const relativeTest = path.relative(cwd, path.join(projectRoot, testFile));
  const result = spawnSync(
    process.execPath,
    [
      path.join(projectRoot, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      relativeConfig,
      relativeTest,
    ],
    { cwd, encoding: "utf8", env: process.env }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // Vitest renders ANSI spans around count values in some clean CI terminals.
  // Match its semantic summary, not terminal decoration.
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
  const plainOutput = output.replace(ansiEscape, "");
  assert.equal(result.status, 0, output);
  assert.match(plainOutput, /Tests\s+\d+ passed/u, output);
  return output;
}

function guardOptions(root, baselinePath, testHostExceptions = []) {
  return {
    projectRoot: root,
    roots: SCOPED_ROOTS,
    extensionRoot: ".pi/extensions",
    toolAdapter: ".pi/lib/pi-tool-registration.ts",
    baselinePath,
    testHostExceptions,
  };
}

function recordPass(name) {
  passed += 1;
  process.stdout.write(`ok ${passed + failed} - ${name}\n`);
}

function recordFailure(name, error) {
  failed += 1;
  process.stderr.write(`not ok ${passed + failed} - ${name}\n`);
  process.stderr.write(`  ${error instanceof Error ? error.stack : String(error)}\n`);
}

async function test(name, operation) {
  try {
    await operation();
    recordPass(name);
  } catch (error) {
    recordFailure(name, error);
  }
}

function cloneFixture(name) {
  const destination = path.join(temporaryParent, name.replace(/[^a-z0-9-]+/giu, "-").toLowerCase());
  cpSync(baseFixture, destination, { recursive: true });
  return destination;
}

async function withNegativeFixture(name, mutate, expected) {
  const fixture = cloneFixture(name);
  try {
    await mutate(fixture);
    const report = await analyzeTypeScriptGuard(guardOptions(fixture));
    const expectedCodes = Array.isArray(expected) ? expected : [expected];
    const actualCodes = new Set(report.violations.map((violation) => violation.code));
    for (const code of expectedCodes) {
      assert(
        actualCodes.has(code),
        `expected ${code}; actual codes: ${[...actualCodes].sort().join(", ")}`
      );
      coveredCodes.add(code);
    }
    assert.equal(report.evaluation.exitPass, false, "unbaselined debt must fail");
    return report;
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    assert.equal(existsSync(fixture), false, `fixture cleanup failed: ${fixture}`);
    cleanupChecks += 1;
  }
}

try {
  buildPositiveFixture(baseFixture);

  await test("positive fixture discovers exactly the caller-supplied roots and certifies direct no-baseline compliance", async () => {
    write(baseFixture, "outside-scope/not-owned.ts", "export const outside: any = 1;\n");
    const report = await analyzeTypeScriptGuard(guardOptions(baseFixture));
    assert.deepEqual(report.violations, []);
    assert.equal(report.summary.files, 9);
    assert(report.files.some((file) => file.path === ".pi/lib/fresh-untracked.ts"));
    assert(!report.files.some((file) => file.path.includes("outside-scope")));
    assert.equal(report.evaluation.exitPass, true);
    assert.equal(report.evaluation.fullCompliance, true);
    assert.equal(report.evaluation.status, "FULL_COMPLIANCE");
  });

  await test("typescript-lint target discovery rejects a newly uncovered scoped file", () => {
    const fixture = path.join(temporaryParent, "type-aware-targets");
    try {
      buildTypeAwareTargetFixture(fixture);
      const positive = validateTypeAwareTargets(fixture);
      assert.equal(positive.files.length, TYPE_AWARE_LINT_TARGETS.length);
      assert.equal(positive.byTarget.size, TYPE_AWARE_LINT_TARGETS.length);

      write(fixture, "apps/orchestration/unassigned.ts", "export const unassigned = true;\n");
      assert.throws(
        () => validateTypeAwareTargets(fixture),
        /apps\/orchestration\/unassigned\.ts must map to exactly one type-aware lint target; matched none/u
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      assert.equal(existsSync(fixture), false);
      cleanupChecks += 1;
    }
  });

  await test("typescript-lint rejects unsafe-any flow without explicit any syntax", () => {
    const fixture = cloneFixture("unsafe-any-flow");
    try {
      write(
        fixture,
        ".pi/lib/fresh-untracked.ts",
        'export const unsafeText: string = JSON.parse("{\\"value\\":1}");\n'
      );
      const source = readFileSync(path.join(fixture, ".pi/lib/fresh-untracked.ts"), "utf8");
      assert(!/:\s*any\b/u.test(source), "fixture must not contain explicit any syntax");
      assert.throws(
        () =>
          runTypeScriptLintFiles(fixture, "unsafe-any-flow", [".pi/lib/fresh-untracked.ts"], {
            captureOutput: true,
            quiet: true,
          }),
        (error) => {
          assert(error instanceof Error);
          assert.match(error.message, /@typescript-eslint\/no-unsafe-assignment/u);
          assert.match(error.message, /Unsafe assignment of an `any` value/u);
          return true;
        }
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      assert.equal(existsSync(fixture), false);
      cleanupChecks += 1;
    }
  });

  await test("missing configured root detector", () =>
    withNegativeFixture(
      "root-missing",
      (fixture) =>
        rmSync(path.join(fixture, "apps/platform-memory"), { recursive: true, force: true }),
      "ROOT_MISSING"
    ));
  await test("ESLint configuration error detector", () =>
    withNegativeFixture(
      "eslint-config-error",
      (fixture) => write(fixture, "eslint.config.mjs", "export default [;\n"),
      "ESLINT_CONFIG_ERROR"
    ));
  await test("effective ESLint omission detector", () =>
    withNegativeFixture(
      "eslint-omitted",
      (fixture) => {
        const config = readFileSync(path.join(fixture, "eslint.config.mjs"), "utf8");
        write(
          fixture,
          "eslint.config.mjs",
          config.replace(
            'ignores: ["node_modules/**", "**/dist/**"]',
            'ignores: ["node_modules/**", "**/dist/**", ".pi/lib/fresh-untracked.ts"]'
          )
        );
      },
      "ESLINT_OMITTED"
    ));
  await test("effective mandatory ESLint rule downgrade detector", () =>
    withNegativeFixture(
      "eslint-rule-downgrade",
      (fixture) => {
        const config = readFileSync(path.join(fixture, "eslint.config.mjs"), "utf8");
        write(
          fixture,
          "eslint.config.mjs",
          config.replace(
            '"@typescript-eslint/no-explicit-any": "error"',
            '"@typescript-eslint/no-explicit-any": "off"'
          )
        );
      },
      "ESLINT_RULE_DOWNGRADE"
    ));
  await test("later per-file ESLint override cannot downgrade a contract rule to warning", () =>
    withNegativeFixture(
      "eslint-later-override",
      (fixture) => {
        const config = readFileSync(path.join(fixture, "eslint.config.mjs"), "utf8");
        write(
          fixture,
          "eslint.config.mjs",
          config.replace(
            /\];\s*$/u,
            '  { files: [".pi/lib/fresh-untracked.ts"], rules: { "@typescript-eslint/no-unsafe-assignment": "warn" } },\n];\n'
          )
        );
      },
      "ESLINT_RULE_DOWNGRADE"
    ));
  await test("TypeScript config parse detector", () =>
    withNegativeFixture(
      "tsconfig-error",
      (fixture) => write(fixture, ".pi/lib/tsconfig.json", "{ invalid json\n"),
      "TSC_CONFIG_ERROR"
    ));
  await test("effective CLI strict-option downgrade and extension config detectors", () =>
    withNegativeFixture(
      "ts-option-downgrade",
      (fixture) => {
        updateJson(fixture, ".pi/extensions/demo/package.json", (manifest) => {
          manifest.scripts.typecheck = "tsc --noEmit --strictNullChecks false";
        });
      },
      ["TSC_OPTION_DOWNGRADE", "PKG_TSCONFIG"]
    ));
  await test("every inherited/child mandatory compiler-option downgrade fails", async () => {
    for (const option of MANDATORY_COMPILER_OPTIONS) {
      const report = await withNegativeFixture(
        `compiler-child-downgrade-${option}`,
        (fixture) => {
          writeJson(fixture, ".pi/lib/tsconfig.base.json", strictTsconfig());
          writeJson(fixture, ".pi/lib/tsconfig.json", {
            extends: "./tsconfig.base.json",
            compilerOptions: { [option]: false },
          });
        },
        "TSC_OPTION_DOWNGRADE"
      );
      assert(
        report.violations.some(
          (violation) =>
            violation.code === "TSC_OPTION_DOWNGRADE" &&
            violation.path === ".pi/lib/tsconfig.json" &&
            violation.detail.includes(`option ${option} is not true`)
        ),
        `missing exact ${option} downgrade evidence`
      );
    }
  });
  await test("actual strict-program omission detector", () =>
    withNegativeFixture(
      "ts-omitted",
      (fixture) => {
        write(fixture, ".pi/lib/excluded/new.ts", "export const omitted = true;\n");
        updateJson(fixture, ".pi/lib/tsconfig.json", (config) => config.exclude.push("excluded"));
      },
      "TSC_OMITTED"
    ));
  await test("new scoped TypeScript file cannot be omitted from both lint and strict projects", async () => {
    const report = await withNegativeFixture(
      "doubly-uncovered-typescript",
      (fixture) => {
        write(fixture, ".pi/lib/uncovered/new.ts", "export const uncovered = true;\n");
        updateJson(fixture, ".pi/lib/tsconfig.json", (config) => config.exclude.push("uncovered"));
        const eslintConfig = readFileSync(path.join(fixture, "eslint.config.mjs"), "utf8");
        write(
          fixture,
          "eslint.config.mjs",
          eslintConfig.replace(
            'ignores: ["node_modules/**", "**/dist/**"]',
            'ignores: ["node_modules/**", "**/dist/**", ".pi/lib/uncovered/**"]'
          )
        );
      },
      ["ESLINT_OMITTED", "TSC_OMITTED"]
    );
    for (const code of ["ESLINT_OMITTED", "TSC_OMITTED"]) {
      assert(
        report.violations.some(
          (violation) => violation.code === code && violation.path === ".pi/lib/uncovered/new.ts"
        ),
        `${code} did not identify the generated path`
      );
    }
  });
  await test("owned declaration skipLibCheck detector", () =>
    withNegativeFixture(
      "declaration-skipped",
      (fixture) => {
        updateJson(fixture, ".pi/lib/tsconfig.json", (config) => {
          config.compilerOptions.skipLibCheck = true;
        });
      },
      "TSC_DECLARATION_SKIPPED"
    ));
  await test("test runner mapping detector", () =>
    withNegativeFixture(
      "runner-unmapped",
      (fixture) =>
        write(
          fixture,
          ".pi/extensions/demo/tests/other/unmapped.test.ts",
          "export const unmapped = true;\n"
        ),
      "TEST_RUNNER_UNMAPPED"
    ));
  await test("TypeScript syntax debt detector", () =>
    withNegativeFixture(
      "syntax-error",
      (fixture) => write(fixture, ".pi/lib/fresh-untracked.ts", "export const broken = ;\n"),
      "SYNTAX_ERROR"
    ));

  await test("explicit any AST detector", () =>
    withNegativeFixture(
      "explicit-any",
      (fixture) => write(fixture, ".pi/lib/fresh-untracked.ts", "export const debt: any = 1;\n"),
      "EXPLICIT_ANY"
    ));
  await test("postfix non-null AST detector", () =>
    withNegativeFixture(
      "postfix-non-null",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/fresh-untracked.ts",
          "declare const value: string | undefined;\nexport const debt = value!;\n"
        ),
      "POSTFIX_NON_NULL"
    ));
  await test("definite-assignment AST detector", () =>
    withNegativeFixture(
      "definite-assignment",
      (fixture) =>
        write(fixture, ".pi/lib/fresh-untracked.ts", "export class Debt { value!: string }\n"),
      "DEFINITE_ASSIGNMENT"
    ));
  await test("unsafe single assertion AST/type detector", () =>
    withNegativeFixture(
      "unsafe-assertion",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/fresh-untracked.ts",
          "declare const value: unknown;\nexport const debt = value as { ok: true };\n"
        ),
      "UNSAFE_ASSERTION"
    ));
  await test("double assertion detector includes as unknown as", () =>
    withNegativeFixture(
      "double-assertion",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/fresh-untracked.ts",
          "declare const value: string;\nexport const debt = value as unknown as { ok: true };\n"
        ),
      "DOUBLE_ASSERTION"
    ));

  await test("direct JSON/HTTP casts and every representative boundary source class fail", async () => {
    const cases = [
      {
        name: "json",
        source: 'export const boundaryDebt = JSON.parse("{\\"ok\\":true}") as { ok: true };\n',
      },
      {
        name: "http",
        source:
          "export async function boundaryDebt(response: { json(): Promise<unknown> }) { return (await response.json()) as { ok: true }; }\n",
      },
      {
        name: "filesystem",
        source:
          'declare function readFileSync(name: string, encoding: "utf8"): string;\nexport const boundaryDebt = readFileSync("fixture.json", "utf8") as { ok: true };\n',
      },
      {
        name: "database",
        source:
          "declare const statement: { get(): unknown };\nexport const boundaryDebt = statement.get() as { id: string };\n",
      },
      {
        name: "environment",
        source: "export const boundaryDebt = process.env.REQUIRED_VALUE as string;\n",
      },
      {
        name: "process",
        source: "export const boundaryDebt = JSON.parse(process.argv[2]) as { command: string };\n",
      },
      {
        name: "dynamic-import",
        source:
          'export async function boundaryDebt() { return (await import("./owned.js")) as { activate(): void }; }\n',
      },
      {
        name: "host-plugin",
        source:
          "declare const host: { plugin: unknown };\nexport const boundaryDebt = host.plugin as { activate(): void };\n",
      },
    ];

    for (const boundary of cases) {
      const report = await withNegativeFixture(
        `boundary-${boundary.name}`,
        (fixture) => write(fixture, ".pi/lib/fresh-untracked.ts", boundary.source),
        "UNSAFE_ASSERTION"
      );
      const findings = report.violations.filter(
        (violation) =>
          violation.code === "UNSAFE_ASSERTION" && violation.path === ".pi/lib/fresh-untracked.ts"
      );
      assert.equal(findings.length, 1, `${boundary.name} must fail at its direct boundary cast`);
      assert.match(findings[0].snippet, /\sas\s/u, `${boundary.name} finding must name the cast`);
    }
  });

  await test("exact test-host registry requires matching local documentation and a focused test", async () => {
    const fixture = cloneFixture("exact-test-host-exception");
    const rationale =
      "The fixture intentionally exposes only the host member exercised by this focused test.";
    const removalCondition = "Remove when the fixture accepts a narrowed host contract.";
    const focusedTest =
      ".pi/extensions/demo/tests/unit/example.test.ts#rejects unavailable host members";
    const source = [
      "declare const partialHost: { on(): void };",
      `// Test-host exception rule: UNSAFE_ASSERTION`,
      `// Rationale: ${rationale}`,
      `// Removal condition: ${removalCondition}`,
      `// Focused test: ${focusedTest}`,
      "// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The guarded fixture intentionally exposes only the exercised host member.",
      "export const host = partialHost as { on(): void; registerTool(): void };",
      "",
    ].join("\n");
    try {
      write(fixture, ".pi/lib/tests/fixtures/partial-host.ts", source);
      write(
        fixture,
        ".pi/extensions/demo/tests/unit/example.test.ts",
        'import { it } from "vitest";\nit("rejects unavailable host members", () => {});\n'
      );
      const unregistered = await analyzeTypeScriptGuard(guardOptions(fixture));
      const finding = unregistered.violations.find(
        (violation) =>
          violation.code === "UNSAFE_ASSERTION" &&
          violation.path === ".pi/lib/tests/fixtures/partial-host.ts"
      );
      assert(finding?.site, "expected an exact unsafe-assertion site");
      const exception = {
        path: finding.path,
        site: finding.site,
        rule: finding.code,
        eslintRule: "@typescript-eslint/no-unsafe-type-assertion",
        suppressionLine: finding.line - 1,
        rationale,
        removalCondition,
        focusedTest,
      };

      const accepted = await analyzeTypeScriptGuard(guardOptions(fixture, undefined, [exception]));
      assert(!accepted.violations.some((violation) => violation.code === "UNSAFE_ASSERTION"));
      assert(
        !accepted.violations.some((violation) => violation.code === "ESLINT_CONTRACT_SUPPRESSION")
      );
      assert.equal(accepted.testHostExceptions.registered.length, 1);
      assert.equal(accepted.testHostExceptions.accepted.length, 1);

      write(
        fixture,
        ".pi/lib/tests/fixtures/partial-host.ts",
        source.replace(`Rationale: ${rationale}`, "Rationale: stale local explanation")
      );
      const undocumented = await analyzeTypeScriptGuard(
        guardOptions(fixture, undefined, [exception])
      );
      assert(undocumented.violations.some((violation) => violation.code === "UNSAFE_ASSERTION"));
      assert(
        undocumented.violations.some(
          (violation) => violation.code === "TEST_HOST_EXCEPTION_INVALID"
        )
      );
      assert.equal(undocumented.testHostExceptions.accepted.length, 0);
      coveredCodes.add("TEST_HOST_EXCEPTION_INVALID");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      assert.equal(existsSync(fixture), false);
      cleanupChecks += 1;
    }
  });

  await test("unsupported @mariozechner import detector", () =>
    withNegativeFixture(
      "unsupported-pi-import",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/fresh-untracked.ts",
          'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";\nexport type Debt = ExtensionAPI;\n'
        ),
      "UNSUPPORTED_PI_IMPORT"
    ));
  await test("unsupported @mariozechner ambient declaration detector", () =>
    withNegativeFixture(
      "unsupported-pi-ambient",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/mario.d.ts",
          'declare module "@mariozechner/pi-coding-agent" { export interface OldApi {} }\n'
        ),
      "UNSUPPORTED_PI_AMBIENT"
    ));
  await test("unregistered raw pi.registerTool call fails outside the exact adapter", () =>
    withNegativeFixture(
      "raw-register-tool",
      (fixture) =>
        write(
          fixture,
          ".pi/extensions/demo/raw.ts",
          "declare const pi: { registerTool(value: unknown): void };\npi.registerTool({});\n"
        ),
      "RAW_PI_REGISTER_TOOL"
    ));
  await test("raw registration detector ignores arbitrary test-fake method names", async () => {
    const fixture = cloneFixture("fake-register-tool");
    try {
      write(
        fixture,
        ".pi/lib/fresh-untracked.ts",
        "const fake = { registerTool(_value: unknown): void {} };\nfake.registerTool({});\nconst api = fake;\napi.registerTool({});\n"
      );
      const report = await analyzeTypeScriptGuard(guardOptions(fixture));
      assert(!report.violations.some((violation) => violation.code === "RAW_PI_REGISTER_TOOL"));
      assert.equal(report.evaluation.exitPass, true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      assert.equal(existsSync(fixture), false);
      cleanupChecks += 1;
    }
  });

  await test("missing extension package manifest detector", () =>
    withNegativeFixture(
      "manifest-missing",
      (fixture) => rmSync(path.join(fixture, ".pi/extensions/demo/package.json")),
      "PKG_MANIFEST_MISSING"
    ));
  await test("invalid extension package manifest detector", () =>
    withNegativeFixture(
      "manifest-invalid",
      (fixture) => write(fixture, ".pi/extensions/demo/package.json", "{ nope\n"),
      "PKG_MANIFEST_INVALID"
    ));
  await test("unsupported TypeBox package detector", () =>
    withNegativeFixture(
      "typebox-import",
      (fixture) => {
        const source = readFileSync(path.join(fixture, ".pi/extensions/demo/index.ts"), "utf8");
        write(
          fixture,
          ".pi/extensions/demo/index.ts",
          source.replace('from "typebox"', 'from "@sinclair/typebox"')
        );
      },
      "PKG_TYPEBOX_IMPORT"
    ));
  await test("unsupported @earendil-works package detector", () =>
    withNegativeFixture(
      "unsupported-earendil",
      (fixture) =>
        write(
          fixture,
          ".pi/extensions/demo/unsupported.ts",
          'import "@earendil-works/not-a-pi-api";\n'
        ),
      "PKG_UNSUPPORTED_PI_PACKAGE"
    ));
  await test("missing/wrong extension peer dependency detector", () =>
    withNegativeFixture(
      "peer-dependency",
      (fixture) => {
        updateJson(fixture, ".pi/extensions/demo/package.json", (manifest) => {
          manifest.peerDependencies.typebox = "^1.0.0";
        });
      },
      "PKG_PEER_DEPENDENCY"
    ));
  await test("missing extension peer dependency detector", () =>
    withNegativeFixture(
      "peer-dependency-missing",
      (fixture) => {
        updateJson(fixture, ".pi/extensions/demo/package.json", (manifest) => {
          delete manifest.peerDependencies["@earendil-works/pi-coding-agent"];
        });
      },
      "PKG_PEER_DEPENDENCY"
    ));
  await test("extension dependency placement detector", () =>
    withNegativeFixture(
      "dependency-placement",
      (fixture) => {
        updateJson(fixture, ".pi/extensions/demo/package.json", (manifest) => {
          manifest.dependencies = { typebox: "1.3.7" };
        });
      },
      "PKG_DEPENDENCY_PLACEMENT"
    ));
  await test("root compiler/SDK exact-pin detector", () =>
    withNegativeFixture(
      "root-pin",
      (fixture) => {
        updateJson(fixture, "package.json", (manifest) => {
          manifest.devDependencies.typescript = "^6.0.3";
        });
      },
      "PKG_ROOT_PIN"
    ));
  await test("extension typecheck script detector", () =>
    withNegativeFixture(
      "typecheck-script",
      (fixture) => {
        updateJson(fixture, ".pi/extensions/demo/package.json", (manifest) => {
          manifest.scripts.typecheck = "echo skipped";
        });
      },
      "PKG_TYPECHECK_SCRIPT"
    ));
  await test("typecheck-before-tests test:all detector", () =>
    withNegativeFixture(
      "test-all-order",
      (fixture) => {
        updateJson(fixture, ".pi/extensions/demo/package.json", (manifest) => {
          manifest.scripts["test:all"] = "bun run test:unit && bun run typecheck";
        });
      },
      "PKG_TEST_ALL"
    ));
  await test("test:all missing typecheck detector", () =>
    withNegativeFixture(
      "test-all-missing-typecheck",
      (fixture) => {
        updateJson(fixture, ".pi/extensions/demo/package.json", (manifest) => {
          manifest.scripts["test:all"] = "bun run test:unit";
        });
      },
      "PKG_TEST_ALL"
    ));
  await test("strict/noEmit extension tsconfig detector", () =>
    withNegativeFixture(
      "extension-tsconfig",
      (fixture) => {
        updateJson(fixture, ".pi/extensions/demo/package.json", (manifest) => {
          manifest.scripts.typecheck = "tsc";
        });
        updateJson(fixture, ".pi/extensions/demo/tsconfig.json", (config) => {
          config.compilerOptions.noEmit = false;
        });
      },
      "PKG_TSCONFIG"
    ));
  await test("non-strict extension tsconfig detector", () =>
    withNegativeFixture(
      "extension-tsconfig-non-strict",
      (fixture) => {
        updateJson(fixture, ".pi/extensions/demo/tsconfig.json", (config) => {
          config.compilerOptions.strict = false;
        });
      },
      ["TSC_OPTION_DOWNGRADE", "PKG_TSCONFIG"]
    ));
  await test("extension package-lock detector", () =>
    withNegativeFixture(
      "package-lock",
      (fixture) => write(fixture, ".pi/extensions/demo/package-lock.json", "{}\n"),
      "PKG_PACKAGE_LOCK"
    ));

  await test("extension runtime console.log/warn/error detector", async () => {
    const report = await withNegativeFixture(
      "extension-console",
      (fixture) =>
        write(
          fixture,
          ".pi/extensions/demo/console.ts",
          "console.log();\nconsole.warn();\nconsole.error();\n"
        ),
      "EXT_CONSOLE"
    );
    const findings = report.violations.filter((violation) => violation.code === "EXT_CONSOLE");
    assert.equal(findings.length, 3);
    assert.deepEqual(
      new Set(findings.map((finding) => finding.detail.match(/console\.(log|warn|error)/u)?.[1])),
      new Set(["log", "warn", "error"])
    );
  });
  await test("module-scope process.env detector allows factory/callback reads", async () => {
    const report = await withNegativeFixture(
      "module-env",
      (fixture) =>
        write(
          fixture,
          ".pi/extensions/demo/env.ts",
          "const moduleValue = process.env.MODULE_VALUE;\nexport function factory() { return () => process.env.RUNTIME_VALUE; }\nexport { moduleValue };\n"
        ),
      "EXT_MODULE_ENV"
    );
    assert.equal(
      report.violations.filter((violation) => violation.code === "EXT_MODULE_ENV").length,
      1
    );
  });

  await test("@ts-nocheck detector", () =>
    withNegativeFixture(
      "ts-nocheck",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/fresh-untracked.ts",
          "// @ts-nocheck migration bypass\nexport const debt = true;\n"
        ),
      "TS_NOCHECK"
    ));
  await test("@ts-ignore detector", () =>
    withNegativeFixture(
      "ts-ignore",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/fresh-untracked.ts",
          "// @ts-ignore migration bypass\nexport const debt = true;\n"
        ),
      "TS_IGNORE"
    ));
  await test("contract-rule suppression detector", () =>
    withNegativeFixture(
      "contract-suppression",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/fresh-untracked.ts",
          "// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const debt: any = 1;\n"
        ),
      "ESLINT_CONTRACT_SUPPRESSION"
    ));
  await test("used inline disable of a mandatory unsafe-flow rule is rejected", async () => {
    const report = await withNegativeFixture(
      "used-unsafe-flow-suppression",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/fresh-untracked.ts",
          '// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- prohibited contract bypass\nexport const debt: string = JSON.parse("{\\"ok\\":true}");\n'
        ),
      "ESLINT_CONTRACT_SUPPRESSION"
    );
    assert(
      !report.violations.some(
        (violation) =>
          violation.code === "ESLINT_UNUSED_SUPPRESSION" &&
          violation.path === ".pi/lib/fresh-untracked.ts"
      ),
      "fixture must exercise a used suppression, not the unused-disable detector"
    );
  });
  await test("broad ESLint suppression detector", () =>
    withNegativeFixture(
      "broad-suppression",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/fresh-untracked.ts",
          "/* eslint-disable */\nexport const debt = true;\n"
        ),
      "ESLINT_BROAD_SUPPRESSION"
    ));
  await test("unused ESLint disable detector uses ESLint's actual directive analysis", () =>
    withNegativeFixture(
      "unused-suppression",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/fresh-untracked.ts",
          '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const clean: string = "ok";\n'
        ),
      "ESLINT_UNUSED_SUPPRESSION"
    ));
  await test("invalid @ts-expect-error without an allowed purpose fails", () =>
    withNegativeFixture(
      "expect-error-invalid-purpose",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/fresh-untracked.ts",
          "// @ts-expect-error migration bypass\nexport const expected: string = 1;\n"
        ),
      "TS_EXPECT_ERROR_INVALID"
    ));
  await test("unused @ts-expect-error fails even in a described negative compile fixture", () =>
    withNegativeFixture(
      "expect-error-unused",
      (fixture) =>
        write(
          fixture,
          ".pi/lib/tests/fixtures/unused.negative.ts",
          '// @ts-expect-error -- negative compile contract: a real mismatch must remain below\nexport const clean: string = "already valid";\n'
        ),
      "TS_EXPECT_ERROR_INVALID"
    ));
  await test("used, described @ts-expect-error is limited to an exact negative compile fixture", async () => {
    const fixture = cloneFixture("expect-error-valid-negative-contract");
    try {
      write(
        fixture,
        ".pi/lib/tests/type-contract-fixtures/example.negative.ts",
        "// @ts-expect-error -- negative compile contract: number must not satisfy string\nexport const expected: string = 1;\n"
      );
      const report = await analyzeTypeScriptGuard(guardOptions(fixture));
      assert(
        !report.violations.some(
          (violation) =>
            violation.code === "TS_EXPECT_ERROR_INVALID" &&
            violation.path === ".pi/lib/tests/type-contract-fixtures/example.negative.ts"
        )
      );
      const file = report.files.find(
        (entry) => entry.path === ".pi/lib/tests/type-contract-fixtures/example.negative.ts"
      );
      assert(
        file?.directives.some(
          (directive) =>
            directive.kind === "@ts-expect-error" &&
            directive.description.includes("negative compile contract")
        )
      );
      assert.equal(report.evaluation.exitPass, true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      assert.equal(existsSync(fixture), false);
      cleanupChecks += 1;
    }
  });

  await test("typescript-tests rejects an invalid aggregate runner configuration", () => {
    const fixture = path.join(temporaryParent, "runner-invalid-config");
    try {
      buildRunnerFixture(fixture);
      const targets = collectTypeScriptTestTargets(fixture);
      assert.equal(targets.length, 5);
      assert.equal(targets.filter((target) => target.gatedLiveModel).length, 1);

      updateJson(fixture, ".pi/extensions/demo/package.json", (manifest) => {
        manifest.scripts["test:unit"] = "vitest run --config tests/missing.config.ts";
      });
      assert.throws(
        () => collectTypeScriptTestTargets(fixture),
        /references missing \.pi\/extensions\/demo\/tests\/missing\.config\.ts/u
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      assert.equal(existsSync(fixture), false);
      cleanupChecks += 1;
    }
  });

  await test("aggregate runner executes newly discovered failing tests in every supported layout", () => {
    const fixture = path.join(temporaryParent, "runner-generated-negatives");
    const negatives = [
      [
        ".pi/extensions/demo/tests/unit/generated-negative.test.ts",
        "TS420_EXTENSION_RUNNER_FAILURE",
      ],
      ["apps/observability/tests/generated-negative.test.ts", "TS420_APPLICATION_RUNNER_FAILURE"],
      ["apps/orchestration/tests/generated-negative.test.ts", "TS420_ORCHESTRATION_RUNNER_FAILURE"],
      ["apps/orchestration/smoke/generated-negative.test.ts", "TS420_SMOKE_RUNNER_FAILURE"],
      [
        "apps/platform-memory/tests/unit/generated-negative.test.ts",
        "TS420_PLATFORM_RUNNER_FAILURE",
      ],
    ];
    try {
      buildRunnerFixture(fixture);
      for (const [relative, sentinel] of negatives) {
        write(
          fixture,
          relative,
          `import { it } from "vitest";\nit(${JSON.stringify(sentinel)}, () => { throw new Error(${JSON.stringify(sentinel)}); });\n`
        );
      }

      assert.throws(
        () => runTypeScriptTests(fixture, { captureOutput: true, quiet: true }),
        (error) => {
          assert(error instanceof Error);
          assert.match(error.message, /5 TypeScript test runner\(s\) failed/u);
          for (const [, sentinel] of negatives)
            assert.match(error.message, new RegExp(sentinel, "u"));
          return true;
        }
      );

      for (const [relative] of negatives) rmSync(path.join(fixture, relative), { force: true });
      const targets = runTypeScriptTests(fixture, { captureOutput: true, quiet: true });
      assert.equal(targets.length, 5);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      assert.equal(existsSync(fixture), false);
      cleanupChecks += 1;
    }
  });

  await test("actual memory operation/schema/parameter mismatches fail generated compilation", () => {
    const fixture = path.join(temporaryParent, "memory-operation-schema-negative");
    const sourcePath = path.join(fixture, "tool-schema-correlation.negative.ts");
    const extensionRoot = path.join(projectRoot, ".pi/extensions/memory");
    try {
      mkdirSync(fixture, { recursive: true });
      const template = readFileSync(
        path.join(extensionRoot, "tests/type-contract-fixtures/tool-schema-correlation.negative"),
        "utf8"
      );
      writeFileSync(
        sourcePath,
        template
          .replace(
            "__LOGSTREAM_TOOLS__",
            path.join(extensionRoot, "logstream-tools.js").replaceAll("\\", "/")
          )
          .replace("__MEMORY_TOOLS__", path.join(extensionRoot, "tools.js").replaceAll("\\", "/"))
      );
      const compiler = path.join(projectRoot, "node_modules/.bin/tsc");
      const result = spawnSync(
        compiler,
        [
          "--ignoreConfig",
          "--pretty",
          "false",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--types",
          "node",
          "--isolatedModules",
          sourcePath,
        ],
        { cwd: projectRoot, encoding: "utf8" }
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.equal(result.status, 2, output);
      assert.match(output, /operation: "search"/u);
      assert.match(output, /operation: "logstream_append"/u);
      assert.match(output, /'drawer_id' does not exist/u);
      assert.match(output, /missing the following properties/u);
      assert.equal((output.match(/error TS(?:2322|2769):/gu) ?? []).length, 4, output);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      assert.equal(existsSync(fixture), false);
      cleanupChecks += 1;
    }
  });

  await test("existing boundary-input and missing-value oracle negatives remain executable", () => {
    const suites = [
      [".pi/lib/tests/vitest.config.ts", ".pi/lib/tests/test-narrowers.test.ts", "."],
      ["apps/orchestration/vitest.config.ts", "apps/orchestration/tests/contracts.test.ts", "."],
      [
        ".pi/extensions/search/tests/vitest.config.ts",
        ".pi/extensions/search/tests/unit/client.test.ts",
        ".pi/extensions/search",
      ],
      [
        "apps/platform-memory/tests/vitest.config.ts",
        "apps/platform-memory/tests/unit/client.test.ts",
        "apps/platform-memory",
      ],
    ];
    for (const [config, testFile, cwdRelative] of suites) {
      runFocusedVitest(config, testFile, cwdRelative);
    }
  });

  await test("external baseline permits only unchanged/decreased debt and never claims baseline debt as compliance", async () => {
    const fixture = cloneFixture("baseline-ratchet");
    const baselinePath = path.join(temporaryParent, "external-baseline.json");
    try {
      write(fixture, ".pi/lib/fresh-untracked.ts", "export const first: any = 1;\n");
      const initial = await analyzeTypeScriptGuard(guardOptions(fixture));
      writeFileSync(baselinePath, `${JSON.stringify(initial, null, 2)}\n`);

      const unchanged = await analyzeTypeScriptGuard(guardOptions(fixture, baselinePath));
      assert.equal(unchanged.evaluation.exitPass, true);
      assert.equal(unchanged.evaluation.fullCompliance, false);
      assert.equal(unchanged.evaluation.status, "BASELINE_AWARE_PASS_WITH_DEBT");
      assert(unchanged.evaluation.acceptedDebt > 0);

      write(
        fixture,
        ".pi/lib/fresh-untracked.ts",
        "export const first: any = 1;\nexport const second: any = 2;\n"
      );
      const increased = await analyzeTypeScriptGuard(guardOptions(fixture, baselinePath));
      assert.equal(increased.evaluation.exitPass, false);
      assert.equal(increased.evaluation.status, "BASELINE_REGRESSION");
      assert(increased.evaluation.increases.length > 0);

      write(fixture, ".pi/lib/fresh-untracked.ts", "export const fixed = true;\n");
      const resolved = await analyzeTypeScriptGuard(guardOptions(fixture, baselinePath));
      assert.equal(resolved.evaluation.exitPass, true);
      assert.equal(resolved.evaluation.fullCompliance, true);
      assert.equal(resolved.evaluation.status, "FULL_COMPLIANCE");
      assert(resolved.evaluation.resolvedDebt > 0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(baselinePath, { force: true });
      assert.equal(existsSync(fixture), false);
      assert.equal(existsSync(baselinePath), false);
      cleanupChecks += 2;
    }
  });

  await test("tracked/in-repository baseline paths are rejected", async () => {
    const fixture = cloneFixture("tracked-baseline-rejected");
    try {
      const report = await analyzeTypeScriptGuard(guardOptions(fixture));
      const baselinePath = path.join(fixture, "baseline.json");
      writeFileSync(baselinePath, `${JSON.stringify(report)}\n`);
      await assert.rejects(
        analyzeTypeScriptGuard(guardOptions(fixture, baselinePath)),
        /baseline must be outside the repository or ignored by Git/u
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      assert.equal(existsSync(fixture), false);
      cleanupChecks += 1;
    }
  });

  await test("self-test detector coverage is exhaustive", () => {
    assert.deepEqual(
      new Set([...coveredCodes].sort()),
      new Set([...EXPECTED_DETECTOR_CODES].sort()),
      `missing detector coverage: ${[...EXPECTED_DETECTOR_CODES].filter((code) => !coveredCodes.has(code)).join(", ")}`
    );
  });
} finally {
  rmSync(temporaryParent, { recursive: true, force: true });
  const cleaned = !existsSync(temporaryParent);
  process.stdout.write(
    `coverage ${coveredCodes.size}/${EXPECTED_DETECTOR_CODES.size} detector codes; cleanup checks ${cleanupChecks}; temporary root removed=${cleaned}\n`
  );
  if (!cleaned) failed += 1;
}

if (failed > 0) {
  process.stderr.write(`${failed} self-test(s) failed; ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} self-tests passed\n`);
}
