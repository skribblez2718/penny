#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { captureBuildInputs, fileDigests, treeFiles } from "./build-inputs.mjs";
import { checkShippingImports } from "./shipping-imports.mjs";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultPackageRoot = path.resolve(path.dirname(scriptPath), "..");
const compilerPath = createRequire(import.meta.url).resolve("typescript/bin/tsc");

function inspect(candidate) {
  try {
    return lstatSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertDirectory(candidate) {
  const stats = inspect(candidate);
  if (stats !== undefined && (!stats.isDirectory() || stats.isSymbolicLink())) {
    throw new Error(`Build directory must be a real directory: ${candidate}`);
  }
}

function assertRegularFile(candidate) {
  const stats = inspect(candidate);
  if (stats === undefined || !stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`Build output must be a regular, single-link file: ${candidate}`);
  }
}

function validateTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) validateTree(candidate);
    else assertRegularFile(candidate);
  }
}

function packageOutputs(packageRoot) {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const outputs = [
    manifest.main,
    manifest.types,
    ...Object.values(manifest.bin ?? {}),
    ...Object.values(manifest.exports ?? {}).flatMap((target) =>
      typeof target === "string" ? [target] : Object.values(target)
    ),
  ];
  return outputs.map((output) => {
    if (
      typeof output !== "string" ||
      !/^\.\/dist\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:js|d\.ts)$/u.test(output)
    ) {
      throw new Error("Package entry points must name regular files inside ./dist/");
    }
    return output.slice("./dist/".length);
  });
}

/** Wait for child exit, including after cancellation, before cleaning its staging directory. */
export function runBuildStep(command, args, { cwd, signal }) {
  return new Promise((resolve, reject) => {
    let failure;
    const child = spawn(command, args, { cwd, signal, stdio: "inherit", shell: false });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code, childSignal) => {
      if (failure !== undefined) reject(failure);
      else if (code !== 0) {
        reject(new Error(`Build step failed: ${path.basename(command)} (${childSignal ?? code})`));
      } else resolve();
    });
  });
}

function publish(stage, destination, packageRoot, move) {
  // Keep the existing real-directory package layout. These are two synchronous renames,
  // not an atomic directory exchange; rollback covers ordinary publication failures.
  const previousRoot = path.join(packageRoot, "out");
  assertDirectory(previousRoot);
  mkdirSync(previousRoot, { recursive: true, mode: 0o700 });
  const previous = mkdtempSync(path.join(previousRoot, "previous-"));
  const backup = path.join(previous, "dist");
  let movedPrevious = false;
  let preserveBackup = false;
  try {
    assertDirectory(destination);
    const current = inspect(destination);
    chmodSync(stage, current === undefined ? 0o777 & ~process.umask() : current.mode & 0o777);
    if (current !== undefined) {
      move(destination, backup);
      movedPrevious = true;
    }
    try {
      move(stage, destination);
    } catch (error) {
      if (movedPrevious) {
        try {
          move(backup, destination);
        } catch (rollbackError) {
          preserveBackup = true;
          throw new AggregateError(
            [error, rollbackError],
            `Build publication and rollback failed; previous output is preserved at ${backup}`
          );
        }
      }
      throw error;
    }
  } finally {
    if (!preserveBackup) rmSync(previous, { recursive: true, force: true });
  }
}

/** Every build phase finishes in a fresh sibling directory before live output is replaced. */
export async function buildOrchestration({
  packageRoot = defaultPackageRoot,
  runCommand = runBuildStep,
  move = renameSync,
  signal,
} = {}) {
  packageRoot = realpathSync(packageRoot);
  const destination = path.join(packageRoot, "dist");
  const lock = path.join(packageRoot, ".build-lock");
  signal?.throwIfAborted();
  assertDirectory(destination);
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Orchestration build is locked at ${lock}; another build may be active. ` +
          "For an interrupted build, inspect owner.json and retained output before removing the lock."
      );
    }
    throw error;
  }

  let stage;
  try {
    writeFileSync(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + "\n",
      { flag: "wx", mode: 0o600 }
    );
    // Same depth as dist keeps emitted source maps valid. Existing build output is
    // never reused or deleted; mkdir must succeed before this invocation owns it.
    const candidate = path.join(packageRoot, "build");
    mkdirSync(candidate, { mode: 0o700 });
    stage = candidate;
    const options = { cwd: packageRoot, signal };
    checkShippingImports(path.resolve(packageRoot, "../.."));
    const inputs = captureBuildInputs(packageRoot);
    await runCommand(
      process.execPath,
      [compilerPath, "-p", "tsconfig.json", "--outDir", stage],
      options
    );
    await runCommand(
      "bun",
      [
        "build",
        "../../.pi/extensions/artifacts/index.ts",
        "--outfile",
        path.join(stage, "artifact-worker.js"),
        "--target",
        "node",
        "--format",
        "esm",
        "--packages",
        "external",
        `--metafile=${path.join(stage, "artifact-worker.meta.json")}`,
      ],
      options
    );
    const voicePeer = path.join(packageRoot, "src/videogen/voice-private-peer.py");
    assertRegularFile(voicePeer);
    mkdirSync(path.join(stage, "videogen"), { recursive: true });
    copyFileSync(voicePeer, path.join(stage, "videogen/voice-private-peer.py"));
    validateTree(stage);
    for (const output of [
      ...packageOutputs(packageRoot),
      "artifact-worker.js",
      "videogen/voice-private-peer.py",
    ]) {
      assertRegularFile(path.join(stage, output));
    }
    const metadata = JSON.parse(
      readFileSync(path.join(stage, "artifact-worker.meta.json"), "utf8")
    );
    for (const input of Object.keys(metadata.inputs)) {
      const workspacePath = path
        .relative(path.resolve(packageRoot, "../.."), path.resolve(packageRoot, input))
        .split(path.sep)
        .join("/");
      if (!inputs.helper_inputs.includes(workspacePath))
        throw new Error(`Unrecorded helper input: ${workspacePath}`);
    }
    rmSync(path.join(stage, "artifact-worker.meta.json"));
    const tools = {
      node: process.version,
      bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
      typescript: JSON.parse(
        readFileSync(createRequire(import.meta.url).resolve("typescript/package.json"), "utf8")
      ).version,
    };
    const generation = createHash("sha256").update(JSON.stringify({ inputs, tools })).digest("hex");
    // A rebuilt module must not reuse a cached shipping guard from the prior generation.
    // All compiled entry paths (not just the root barrel) fail closed before use.
    for (const file of treeFiles(stage).filter(
      (name) => name.endsWith(".js") && !["shipping.js", "build-provenance.js"].includes(name)
    )) {
      const check =
        path.posix.relative(path.posix.dirname(file), "shipping.js") + "?generation=" + generation;
      const injected = `import ${JSON.stringify(check.startsWith(".") ? check : "./" + check)};\n`;
      const target = path.join(stage, file);
      const content = readFileSync(target, "utf8");
      const firstLine = content.startsWith("#!") ? content.indexOf("\n") + 1 : 0;
      writeFileSync(target, content.slice(0, firstLine) + injected + content.slice(firstLine));
      const mapPath = target + ".map";
      if (inspect(mapPath) !== undefined) {
        const map = JSON.parse(readFileSync(mapPath, "utf8"));
        const mappings = map.mappings.split(";");
        mappings.splice(firstLine === 0 ? 0 : 1, 0, "");
        writeFileSync(mapPath, JSON.stringify({ ...map, mappings: mappings.join(";") }));
      }
    }
    if (JSON.stringify(captureBuildInputs(packageRoot)) !== JSON.stringify(inputs))
      throw new Error("Build inputs changed during compilation; refusing publication");
    writeFileSync(
      path.join(stage, "build-provenance.json"),
      JSON.stringify({
        schema_version: 1,
        ...inputs,
        outputs: fileDigests(stage, treeFiles(stage)),
        tools,
      }) + "\n",
      { flag: "wx" }
    );
    await runCommand(
      process.execPath,
      ["--check", path.join(stage, "artifact-worker.js")],
      options
    );
    await runCommand(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { pathToFileURL } from "node:url"; ' +
          "const api = await import(pathToFileURL(process.argv[1]).href); " +
          'if (typeof api.OrchestrationService !== "function") throw new Error("Missing orchestration export");',
        path.join(stage, "index.js"),
      ],
      options
    );
    signal?.throwIfAborted();
    if (JSON.stringify(captureBuildInputs(packageRoot)) !== JSON.stringify(inputs))
      throw new Error("Build inputs changed during validation; refusing publication");
    publish(stage, destination, packageRoot, move);
  } finally {
    try {
      if (stage !== undefined) rmSync(stage, { recursive: true, force: true });
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) {
  const controller = new globalThis.AbortController();
  let interrupted;
  const handlers = new Map(
    ["SIGINT", "SIGTERM"].map((name) => [
      name,
      () => {
        interrupted ??= name;
        controller.abort();
      },
    ])
  );
  for (const [name, handler] of handlers) process.on(name, handler);
  try {
    await buildOrchestration({ signal: controller.signal });
    process.stdout.write("Orchestration build validated and published.\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
  }
}
