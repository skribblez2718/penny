#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const TYPESCRIPT_SCOPED_ROOTS = Object.freeze([
  ".pi/extensions",
  ".pi/lib",
  "apps/observability",
  "apps/orchestration",
  "apps/platform-memory",
]);

const extensionTargets = [
  "artifacts",
  "enhance",
  "environment",
  "lib",
  "memory",
  "observability",
  "playwright",
  "powerpoint",
  "questionnaire",
  "search",
  "skill",
  "statusline",
  "subagent",
  "word",
  "youtube",
].map((name) => ({
  id: `extension:${name}`,
  scopeRoot: ".pi/extensions",
  project: `.pi/extensions/${name}/tsconfig.json`,
  prefixes: [`.pi/extensions/${name}`],
  exactFiles: [],
  excludedPrefixes: [],
}));

export const TYPE_AWARE_LINT_TARGETS = Object.freeze([
  ...extensionTargets,
  Object.freeze({
    id: "extension:compaction-source",
    scopeRoot: ".pi/extensions",
    project: ".pi/extensions/compaction/tsconfig.json",
    prefixes: [".pi/extensions/compaction"],
    exactFiles: [],
    excludedPrefixes: [".pi/extensions/compaction/tests"],
  }),
  Object.freeze({
    id: "extension:compaction-tests",
    scopeRoot: ".pi/extensions",
    project: ".pi/extensions/compaction/tsconfig.test.json",
    prefixes: [".pi/extensions/compaction/tests"],
    exactFiles: [],
    excludedPrefixes: [],
  }),
  Object.freeze({
    id: "shared-lib",
    scopeRoot: ".pi/lib",
    project: ".pi/lib/tsconfig.json",
    prefixes: [".pi/lib"],
    exactFiles: [],
    excludedPrefixes: [],
  }),
  Object.freeze({
    id: "observability",
    scopeRoot: "apps/observability",
    project: "apps/observability/tsconfig.json",
    prefixes: ["apps/observability"],
    exactFiles: [],
    excludedPrefixes: [],
  }),
  Object.freeze({
    id: "orchestration-source",
    scopeRoot: "apps/orchestration",
    project: "apps/orchestration/tsconfig.typecheck.json",
    prefixes: ["apps/orchestration/src"],
    exactFiles: [],
    excludedPrefixes: [],
  }),
  Object.freeze({
    id: "orchestration-tests",
    scopeRoot: "apps/orchestration",
    project: "apps/orchestration/tsconfig.test.json",
    prefixes: ["apps/orchestration/tests"],
    exactFiles: ["apps/orchestration/vitest.config.ts"],
    excludedPrefixes: [],
  }),
  Object.freeze({
    id: "orchestration-kb-model-smoke",
    scopeRoot: "apps/orchestration",
    project: "apps/orchestration/tsconfig.kb-model-smoke.json",
    prefixes: ["apps/orchestration/smoke"],
    exactFiles: ["apps/orchestration/vitest.kb-model-smoke.config.ts"],
    excludedPrefixes: [],
  }),
  Object.freeze({
    id: "platform-memory",
    scopeRoot: "apps/platform-memory",
    project: "apps/platform-memory/tsconfig.json",
    prefixes: ["apps/platform-memory"],
    exactFiles: [],
    excludedPrefixes: [],
  }),
]);

const GENERATED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  ".mempalace",
  ".mypy_cache",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const IGNORED_STAGING_ROOTS = new Set(["ideas", "plans", "research"]);
const TYPESCRIPT_PATTERN = /(?:\.d)?\.tsx?$/u;
const JAVASCRIPT_PATTERN = /\.(?:c|m)?js$/u;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isWithin(relative, prefix) {
  return relative === prefix || relative.startsWith(`${prefix}/`);
}

function targetMatches(target, relative) {
  if (target.excludedPrefixes.some((prefix) => isWithin(relative, prefix))) return false;
  return (
    target.exactFiles.includes(relative) ||
    target.prefixes.some((prefix) => isWithin(relative, prefix))
  );
}

function discoverFiles(projectRoot, roots, pattern) {
  const files = [];
  function visit(directory, topLevel = false) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (GENERATED_DIRECTORY_NAMES.has(entry.name)) continue;
        if (topLevel && IGNORED_STAGING_ROOTS.has(entry.name)) continue;
        visit(absolute);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        files.push(absolute);
      }
    }
  }

  for (const root of roots) {
    const absolute = path.resolve(projectRoot, root);
    if (!existsSync(absolute) || !lstatSync(absolute).isDirectory()) {
      throw new Error(`configured lint root is missing: ${root}`);
    }
    visit(absolute, root === ".");
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export function validateTypeAwareTargets(projectRoot = process.cwd()) {
  const configuredRoots = new Set(TYPE_AWARE_LINT_TARGETS.map((target) => target.scopeRoot));
  const missingConfiguredRoots = TYPESCRIPT_SCOPED_ROOTS.filter(
    (root) => !configuredRoots.has(root)
  );
  const unexpectedConfiguredRoots = [...configuredRoots].filter(
    (root) => !TYPESCRIPT_SCOPED_ROOTS.includes(root)
  );
  if (missingConfiguredRoots.length > 0 || unexpectedConfiguredRoots.length > 0) {
    throw new Error(
      `lint target root mismatch; missing=${missingConfiguredRoots.join(",") || "none"}; unexpected=${unexpectedConfiguredRoots.join(",") || "none"}`
    );
  }

  for (const target of TYPE_AWARE_LINT_TARGETS) {
    if (!existsSync(path.resolve(projectRoot, target.project))) {
      throw new Error(`lint target ${target.id} references missing project ${target.project}`);
    }
  }

  const files = discoverFiles(projectRoot, TYPESCRIPT_SCOPED_ROOTS, TYPESCRIPT_PATTERN);
  const byTarget = new Map(TYPE_AWARE_LINT_TARGETS.map((target) => [target.id, []]));
  for (const absolute of files) {
    const relative = toPosix(path.relative(projectRoot, absolute));
    const matches = TYPE_AWARE_LINT_TARGETS.filter((target) => targetMatches(target, relative));
    if (matches.length !== 1) {
      throw new Error(
        `${relative} must map to exactly one type-aware lint target; matched ${matches.map((target) => target.id).join(", ") || "none"}`
      );
    }
    byTarget.get(matches[0].id)?.push(relative);
  }

  for (const target of TYPE_AWARE_LINT_TARGETS) {
    if ((byTarget.get(target.id) ?? []).length === 0) {
      throw new Error(`type-aware lint target has no inventory files: ${target.id}`);
    }
  }
  return { files, byTarget };
}

export function runTypeScriptLintFiles(projectRoot, label, relativeFiles, options = {}) {
  const eslintBin = path.resolve(projectRoot, "node_modules/eslint/bin/eslint.js");
  if (!existsSync(eslintBin)) throw new Error(`ESLint is not installed at ${eslintBin}`);
  if (options.quiet !== true) {
    process.stdout.write(`\n[typescript-lint] ${label}: ${relativeFiles.length} file(s)\n`);
  }
  const captureOutput = options.captureOutput === true;
  const result = spawnSync(
    process.execPath,
    [
      eslintBin,
      "--max-warnings=0",
      "--report-unused-disable-directives",
      ...(options.fix === true ? ["--fix"] : []),
      ...relativeFiles,
    ],
    {
      cwd: projectRoot,
      stdio: captureOutput ? "pipe" : "inherit",
      encoding: captureOutput ? "utf8" : undefined,
      env: process.env,
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = captureOutput ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() : "";
    throw new Error(
      `${label} ESLint child exited with status ${String(result.status)}${output ? `\n${output}` : ""}`
    );
  }
  return result;
}

export function runSerialTypeScriptLint(projectRoot = process.cwd(), options = {}) {
  const { files, byTarget } = validateTypeAwareTargets(projectRoot);
  if (options.checkOnly === true) return { typeScriptFiles: files.length, targets: byTarget.size };

  for (const target of TYPE_AWARE_LINT_TARGETS) {
    runTypeScriptLintFiles(projectRoot, target.id, byTarget.get(target.id) ?? [], options);
  }

  const javascriptFiles = discoverFiles(projectRoot, ["."], JAVASCRIPT_PATTERN).map((absolute) =>
    toPosix(path.relative(projectRoot, absolute))
  );
  if (javascriptFiles.length > 0) {
    runTypeScriptLintFiles(projectRoot, "javascript", javascriptFiles, options);
  }
  return {
    typeScriptFiles: files.length,
    javascriptFiles: javascriptFiles.length,
    targets: byTarget.size,
  };
}

async function main() {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.some((argument) => !["--check", "--fix"].includes(argument))) {
      throw new Error("usage: typescript-lint.mjs [--check] [--fix]");
    }
    if (arguments_.includes("--check") && arguments_.includes("--fix")) {
      throw new Error("--check and --fix are mutually exclusive");
    }
    const result = runSerialTypeScriptLint(process.cwd(), {
      checkOnly: arguments_.includes("--check"),
      fix: arguments_.includes("--fix"),
    });
    process.stdout.write(
      `[typescript-lint] covered ${result.typeScriptFiles} TypeScript file(s) across ${result.targets} sequential target(s)${result.javascriptFiles === undefined ? " (check only)" : `; ${result.javascriptFiles} JavaScript file(s)`}\n`
    );
  } catch (error) {
    process.stderr.write(
      `[typescript-lint] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
