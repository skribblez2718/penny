#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const LIVE_MODEL_CONFIG_GATES = new Map([
  ["apps/orchestration/vitest.ordinary-skills-live.config.ts", "test:ordinary-skills-live:aggregate"],
  ["apps/orchestration/vitest.kb-model-smoke.config.ts", "test:kb-model-smoke:aggregate"],
  [
    "apps/orchestration/vitest.child-workflow-model-smoke.config.ts",
    "test:child-workflow-model-smoke:aggregate",
  ],
  ["apps/orchestration/vitest.sca-p04-model-smoke.config.ts", "test:sca-p04-model-smoke:aggregate"],
  ["apps/orchestration/vitest.sca-p05-model-smoke.config.ts", "test:sca-p05-model-smoke:aggregate"],
  ["apps/orchestration/vitest.sca-p06-model-smoke.config.ts", "test:sca-p06-model-smoke:aggregate"],
  [
    "apps/orchestration/vitest.sca-ordinary-deepseek.config.ts",
    "test:sca-ordinary-deepseek:aggregate",
  ],
  ["apps/orchestration/vitest.imagegen-live.config.ts", "test:imagegen-live:aggregate"],
  [
    "apps/orchestration/vitest.imagegen-model-smoke.config.ts",
    "test:imagegen-model-smoke:aggregate",
  ],
  [
    "apps/orchestration/vitest.imagegen-recovery-live.config.ts",
    "test:imagegen-recovery-live:aggregate",
  ],
  [
    "apps/orchestration/vitest.imagegen-security-inspection.config.ts",
    "test:imagegen-security-inspection:aggregate",
  ],
  ["apps/orchestration/vitest.imagegen-canary.config.ts", "test:imagegen-canary:aggregate"],
]);

const EXTERNAL_CPU_CONFIG_GATES = new Map([
  ["apps/orchestration/vitest.videogen-media-cpu.config.ts", "test:videogen-media-cpu:aggregate"],
  ["apps/orchestration/vitest.videogen-native-cpu.config.ts", "test:videogen-native-cpu:aggregate"],
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function parseManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${manifestPath} must contain a package object`);
  }
  return parsed;
}

function scriptReferences(script) {
  return [...script.matchAll(/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)/gu)].map(
    (match) => match[1]
  );
}

function reachableScripts(scripts) {
  const reached = new Set();
  const pending = ["test:all"];
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || reached.has(name) || typeof scripts[name] !== "string") continue;
    reached.add(name);
    pending.push(...scriptReferences(scripts[name]));
  }
  return reached;
}

function shellCommandSegments(script) {
  const commands = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < script.length; i += 1) {
    const char = script[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      commands.push(script.slice(start, i));
      if (script[i + 1] === char) i += 1;
      start = i + 1;
    }
  }
  commands.push(script.slice(start));
  return commands;
}

/** Only executed run commands map tests; formatter arguments and quoted prose do not.
 * Recognizes the direct CLI, bunx/npx and the CLI's Node entrypoint used by package scripts. */
export function vitestConfigFromScript(script, packageDirectory) {
  for (const command of shellCommandSegments(script)) {
    const invocation =
      /^\s*(?:vitest|(?:bunx|npx)\s+vitest|node\s+(?:"(?:[^"\r\n]*[/\\])?vitest\.[mc]?js"|'(?:[^'\r\n]*[/\\])?vitest\.[mc]?js'|(?:[^\s'";|&]*[/\\])?vitest\.[mc]?js))\s+run(?=\s|$)/u.exec(
        command
      );
    if (invocation === null) continue;
    const args = command.slice(invocation[0].length);
    const match = args.match(/--config(?:\s+|=)(?:["']([^"']+)["']|([^\s]+))/u);
    const configured = match?.[1] ?? match?.[2] ?? "vitest.config.ts";
    return path.resolve(packageDirectory, configured);
  }
  return undefined;
}

function packageDirectories(projectRoot) {
  const directories = [];
  const extensionRoot = path.join(projectRoot, ".pi/extensions");
  for (const entry of readdirSync(extensionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(extensionRoot, entry.name);
    if (existsSync(path.join(directory, "package.json"))) directories.push(directory);
  }
  for (const relative of [
    "apps/observability",
    "apps/orchestration",
    "apps/platform-memory",
    "apps/sca-service",
  ]) {
    directories.push(path.join(projectRoot, relative));
  }
  return directories;
}

export function collectTypeScriptTestTargets(projectRoot = process.cwd()) {
  const targetsByConfig = new Map();
  for (const directory of packageDirectories(projectRoot)) {
    const manifestPath = path.join(directory, "package.json");
    if (!existsSync(manifestPath)) throw new Error(`missing package manifest: ${manifestPath}`);
    const manifest = parseManifest(manifestPath);
    const scripts = manifest.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      throw new Error(`${toPosix(path.relative(projectRoot, manifestPath))} has no scripts object`);
    }
    const reachable = reachableScripts(scripts);
    for (const name of reachable) {
      const command = scripts[name];
      if (typeof command !== "string") continue;
      const configPath = vitestConfigFromScript(command, directory);
      if (!configPath) continue;
      if (!existsSync(configPath)) {
        throw new Error(
          `${toPosix(path.relative(projectRoot, manifestPath))}#${name} references missing ${toPosix(path.relative(projectRoot, configPath))}`
        );
      }
      const config = toPosix(path.relative(projectRoot, configPath));
      const candidates = targetsByConfig.get(config) ?? [];
      candidates.push({
        config,
        directory,
        package: toPosix(path.relative(projectRoot, directory)) || ".",
        script: name,
      });
      targetsByConfig.set(config, candidates);
    }
  }

  const targets = [];
  for (const [config, candidates] of targetsByConfig) {
    const sorted = [...candidates].sort(
      (left, right) =>
        left.package.localeCompare(right.package) || left.script.localeCompare(right.script)
    );
    const selected = sorted[0];
    if (!selected) throw new Error(`no runner for ${config}`);
    const liveGateScript = LIVE_MODEL_CONFIG_GATES.get(config);
    const externalCpuGateScript = EXTERNAL_CPU_CONFIG_GATES.get(config);
    const gateScript = liveGateScript ?? externalCpuGateScript;
    if (gateScript !== undefined) {
      const manifest = parseManifest(path.join(selected.directory, "package.json"));
      if (typeof manifest.scripts?.[gateScript] !== "string") {
        throw new Error(`${config} has no permanent opt-in gate script`);
      }
      targets.push({
        ...selected,
        script: gateScript,
        gatedLiveModel: liveGateScript !== undefined,
        gatedExternalCpu: externalCpuGateScript !== undefined,
      });
    } else {
      targets.push({ ...selected, gatedLiveModel: false });
    }
  }

  if (targets.length === 0) throw new Error("no runner-mapped TypeScript test suites found");
  return targets.sort((left, right) => left.config.localeCompare(right.config));
}

export function runTypeScriptTests(projectRoot = process.cwd(), options = {}) {
  const targets = collectTypeScriptTestTargets(projectRoot);
  if (options.checkOnly === true) return targets;
  const failures = [];
  for (const target of targets) {
    if (options.quiet !== true) {
      process.stdout.write(
        `\n[typescript-tests] ${target.config} via ${target.package}#${target.script}${target.gatedLiveModel ? " (opt-in live gate)" : target.gatedExternalCpu ? " (opt-in external CPU gate)" : ""}\n`
      );
    }
    const captureOutput = options.captureOutput === true;
    const result = spawnSync("bun", ["run", target.script], {
      cwd: target.directory,
      env: process.env,
      stdio: captureOutput ? "pipe" : "inherit",
      encoding: captureOutput ? "utf8" : undefined,
    });
    if (result.error) {
      failures.push(`${target.package}#${target.script}: ${result.error.message}`);
    } else if (result.status !== 0) {
      const output = captureOutput ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() : "";
      failures.push(
        `${target.package}#${target.script} exited with status ${String(result.status)}${output ? `\n${output}` : ""}`
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} TypeScript test runner(s) failed:\n${failures.join("\n")}`);
  }
  return targets;
}

async function main() {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.some((argument) => argument !== "--check")) {
      throw new Error("usage: typescript-tests.mjs [--check]");
    }
    const targets = runTypeScriptTests(process.cwd(), {
      checkOnly: arguments_.includes("--check"),
    });
    const gated = targets.filter((target) => target.gatedLiveModel).length;
    const externalCpu = targets.filter((target) => target.gatedExternalCpu).length;
    process.stdout.write(
      `[typescript-tests] ${targets.length} runner config(s) covered; gated live-model configs=${gated}; gated external CPU configs=${externalCpu}\n`
    );
  } catch (error) {
    process.stderr.write(
      `[typescript-tests] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
