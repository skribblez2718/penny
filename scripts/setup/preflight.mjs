#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

function parseVersion(value, label) {
  const match = /(?:^|[^0-9])(\d+)\.(\d+)(?:\.(\d+))?/u.exec(value);
  if (match === null) throw new Error(`${label} did not report a semantic version`);
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")];
}

function cleanMessage(value) {
  return Array.from(String(value))
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined &&
        (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
        ? " "
        : character;
    })
    .join("")
    .slice(0, 1024);
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function commandVersion(command, arguments_, label) {
  const completed = spawnSync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
  });
  if (completed.error) {
    throw new Error(`${label} is unavailable`);
  }
  if (completed.status !== 0) {
    throw new Error(`${label} version check failed`);
  }
  return `${completed.stdout ?? ""}\n${completed.stderr ?? ""}`.trim();
}

function packageMetadata(projectRoot) {
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const piVersion =
    manifest.devDependencies?.["@earendil-works/pi-coding-agent"] ??
    manifest.dependencies?.["@earendil-works/pi-coding-agent"];
  const nodeRange = manifest.engines?.node;
  if (typeof piVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(piVersion)) {
    throw new Error("package.json must pin an exact Pi coding-agent version");
  }
  if (typeof nodeRange !== "string") throw new Error("package.json engines.node is required");
  const minimumNode = parseVersion(nodeRange, "Node engine range");
  return { piVersion, minimumNode };
}

export function runPreflight({ projectRoot, profile }) {
  const checks = [];
  try {
    const metadata = packageMetadata(projectRoot);
    const nodeVersion = parseVersion(process.version, "Node");
    if (compareVersion(nodeVersion, metadata.minimumNode) < 0) {
      throw new Error(`Node ${metadata.minimumNode.join(".")} or newer is required`);
    }
    checks.push({ component: "node", status: "ready", version: nodeVersion.join(".") });
    const sqliteVersion = parseVersion(process.versions.sqlite ?? "", "bundled SQLite");
    if (compareVersion(sqliteVersion, [3, 51, 3]) < 0) {
      throw new Error("SQLite 3.51.3 or newer is required; use .nvmrc and restart Pi");
    }
    checks.push({ component: "sqlite", status: "ready", version: sqliteVersion.join(".") });

    if (profile === "core" || profile === "javascript") {
      const bunText = commandVersion("bun", ["--version"], "Bun");
      const bunVersion = parseVersion(bunText, "Bun");
      if (compareVersion(bunVersion, [1, 0, 0]) < 0) {
        throw new Error("Bun 1.0.0 or newer is required");
      }
      checks.push({ component: "bun", status: "ready", version: bunVersion.join(".") });

      const piText = commandVersion("pi", ["--version"], "Pi");
      const piVersion = parseVersion(piText, "Pi").join(".");
      if (piVersion !== metadata.piVersion) {
        throw new Error(`Pi ${metadata.piVersion} is required; found ${piVersion}`);
      }
      checks.push({ component: "pi", status: "ready", version: piVersion });
    }

    if (profile === "core" || profile === "python") {
      const pythonText = commandVersion("python3", ["--version"], "Python");
      const pythonVersion = parseVersion(pythonText, "Python");
      if (compareVersion(pythonVersion, [3, 12, 0]) < 0) {
        throw new Error("Python 3.12.0 or newer is required for core memory");
      }
      checks.push({ component: "python", status: "ready", version: pythonVersion.join(".") });

      const uvText = commandVersion("uv", ["--version"], "uv");
      checks.push({
        component: "uv",
        status: "ready",
        version: parseVersion(uvText, "uv").join("."),
      });
    }

    return {
      schema_version: 1,
      operation: "setup_preflight",
      status: "ready",
      profile,
      checks,
    };
  } catch (error) {
    return {
      schema_version: 1,
      operation: "setup_preflight",
      status: "failed",
      profile,
      checks,
      error: {
        code: "PREREQUISITE_INVALID",
        message: cleanMessage(error instanceof Error ? error.message : error),
      },
    };
  }
}

function main() {
  const projectRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const profile = process.argv[2] ?? "core";
  if (!new Set(["core", "javascript", "python", "node"]).has(profile)) {
    process.stderr.write("usage: preflight.mjs [core|javascript|python|node]\n");
    process.exitCode = 2;
    return;
  }
  const result = runPreflight({ projectRoot, profile });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "ready") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
