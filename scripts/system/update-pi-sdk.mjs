#!/usr/bin/env node

import console from "node:console";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PI_PACKAGES = Object.freeze([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);

const CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const ROOT_MANIFEST = "package.json";
const ORCHESTRATION_MANIFEST = "apps/orchestration/package.json";
const LOCKFILE = "bun.lock";
const README = "README.md";
const SNAPSHOT_FILES = Object.freeze([ROOT_MANIFEST, ORCHESTRATION_MANIFEST, LOCKFILE, README]);
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const PI_LATEST_RELEASE_URL = "https://pi.dev/api/latest-version";
const REGISTRY_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 600_000;
const CHECK_TIMEOUT_MS = 1_200_000;
const GLOBAL_UPDATE_TIMEOUT_MS = 600_000;
const MAX_CAPTURE_BYTES = 1_048_576;

const COMPATIBILITY_COMMANDS = Object.freeze([
  Object.freeze({ command: "bun", args: ["run", "typescript:architecture"] }),
  Object.freeze({ command: "bun", args: ["run", "typecheck"] }),
  Object.freeze({ command: "bun", args: ["run", "test:pi-compat"] }),
]);

export class PiUpdateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PiUpdateError";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseExactVersion(value, label = "version") {
  const match = typeof value === "string" ? VERSION_PATTERN.exec(value) : null;
  const invalidNumericPrerelease = match?.[4]
    ?.split(".")
    .some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"));
  if (!match || invalidNumericPrerelease) {
    throw new PiUpdateError(
      `${label} must be an exact semantic version; found ${JSON.stringify(value)}`
    );
  }
  return value;
}

function parsePrerelease(value) {
  const withoutBuild = value.split("+", 1)[0];
  const separator = withoutBuild.indexOf("-");
  const main = separator < 0 ? withoutBuild : withoutBuild.slice(0, separator);
  const prerelease = separator < 0 ? [] : withoutBuild.slice(separator + 1).split(".");
  const numbers = main.split(".").map((part) => BigInt(part));
  return { numbers, prerelease };
}

function compareBigInts(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareVersions(left, right) {
  const leftVersion = parsePrerelease(parseExactVersion(left, "left version"));
  const rightVersion = parsePrerelease(parseExactVersion(right, "right version"));
  for (let index = 0; index < 3; index += 1) {
    const difference = compareBigInts(leftVersion.numbers[index], rightVersion.numbers[index]);
    if (difference !== 0) return difference;
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) return 0;
  if (leftVersion.prerelease.length === 0) return 1;
  if (rightVersion.prerelease.length === 0) return -1;
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/u.test(leftPart) ? BigInt(leftPart) : undefined;
    const rightNumber = /^\d+$/u.test(rightPart) ? BigInt(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined)
      return compareBigInts(leftNumber, rightNumber);
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function parseJsonFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new PiUpdateError(`could not parse ${filePath}`, { cause: error });
  }
  if (!isRecord(parsed)) throw new PiUpdateError(`${filePath} must contain a JSON object`);
  return parsed;
}

function stringField(record, field, label) {
  const value = record[field];
  if (typeof value !== "string") {
    throw new PiUpdateError(`${label}.${field} must be a string; found ${JSON.stringify(value)}`);
  }
  return value;
}

export function readPinnedVersions(projectRoot) {
  const rootManifest = parseJsonFile(path.join(projectRoot, ROOT_MANIFEST));
  const orchestrationManifest = parseJsonFile(path.join(projectRoot, ORCHESTRATION_MANIFEST));
  const developmentDependencies = rootManifest.devDependencies;
  const orchestrationDependencies = orchestrationManifest.dependencies;
  if (!isRecord(developmentDependencies)) {
    throw new PiUpdateError(`${ROOT_MANIFEST}.devDependencies must be an object`);
  }
  if (!isRecord(orchestrationDependencies)) {
    throw new PiUpdateError(`${ORCHESTRATION_MANIFEST}.dependencies must be an object`);
  }
  const root = {};
  for (const packageName of PI_PACKAGES) {
    root[packageName] = parseExactVersion(
      stringField(developmentDependencies, packageName, `${ROOT_MANIFEST}.devDependencies`),
      `${ROOT_MANIFEST} ${packageName}`
    );
  }
  const orchestration = parseExactVersion(
    stringField(
      orchestrationDependencies,
      CODING_AGENT_PACKAGE,
      `${ORCHESTRATION_MANIFEST}.dependencies`
    ),
    `${ORCHESTRATION_MANIFEST} ${CODING_AGENT_PACKAGE}`
  );
  return { root, orchestration };
}

export function pinsMatchVersion(pins, version) {
  return (
    PI_PACKAGES.every((packageName) => pins.root[packageName] === version) &&
    pins.orchestration === version
  );
}

function atomicWrite(filePath, content) {
  const mode = statSync(filePath).mode;
  const temporaryPath = `${filePath}.pi-update.${process.pid}.${Date.now()}`;
  try {
    const descriptor = openSync(temporaryPath, "wx", mode);
    try {
      writeFileSync(descriptor, content);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function writeJsonFile(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceReadmeVersion(content, oldVersion, newVersion) {
  const oldMarker = `**Pi ${oldVersion}**`;
  const occurrences = content.split(oldMarker).length - 1;
  if (occurrences !== 1) {
    throw new PiUpdateError(
      `${README} must contain exactly one ${JSON.stringify(oldMarker)} marker; found ${occurrences}`
    );
  }
  return content.replace(oldMarker, `**Pi ${newVersion}**`);
}

export function updatePinnedFiles(projectRoot, candidateVersion) {
  const candidate = parseExactVersion(candidateVersion, "candidate version");
  const pins = readPinnedVersions(projectRoot);
  const currentVersion = pins.root[CODING_AGENT_PACKAGE];
  const rootPath = path.join(projectRoot, ROOT_MANIFEST);
  const orchestrationPath = path.join(projectRoot, ORCHESTRATION_MANIFEST);
  const readmePath = path.join(projectRoot, README);
  const rootManifest = parseJsonFile(rootPath);
  const orchestrationManifest = parseJsonFile(orchestrationPath);
  const developmentDependencies = rootManifest.devDependencies;
  const orchestrationDependencies = orchestrationManifest.dependencies;
  if (!isRecord(developmentDependencies) || !isRecord(orchestrationDependencies)) {
    throw new PiUpdateError("Pi dependency objects disappeared while preparing the update");
  }
  for (const packageName of PI_PACKAGES) developmentDependencies[packageName] = candidate;
  orchestrationDependencies[CODING_AGENT_PACKAGE] = candidate;
  const readme = replaceReadmeVersion(readFileSync(readmePath, "utf8"), currentVersion, candidate);
  writeJsonFile(rootPath, rootManifest);
  writeJsonFile(orchestrationPath, orchestrationManifest);
  atomicWrite(readmePath, readme);
}

function captureSnapshots(projectRoot) {
  return new Map(
    SNAPSHOT_FILES.map((relativePath) => {
      const absolutePath = path.join(projectRoot, relativePath);
      if (!existsSync(absolutePath))
        throw new PiUpdateError(`required file is missing: ${relativePath}`);
      return [absolutePath, readFileSync(absolutePath)];
    })
  );
}

function restoreSnapshots(snapshots) {
  for (const [filePath, content] of snapshots) atomicWrite(filePath, content);
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

export function createCommandRunner(environment = process.env) {
  return ({ command, args, cwd, capture = false, timeoutMs, extraEnvironment = {} }) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      env: { ...environment, ...extraEnvironment },
      maxBuffer: MAX_CAPTURE_BYTES,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (result.error) {
      throw new PiUpdateError(
        `failed to run ${formatCommand(command, args)}: ${result.error.message}`,
        {
          cause: result.error,
        }
      );
    }
    if (result.status !== 0) {
      const detail = capture ? (result.stderr || result.stdout).trim() : "";
      throw new PiUpdateError(
        `${formatCommand(command, args)} exited with status ${String(result.status)}${detail ? `: ${detail}` : ""}`
      );
    }
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

function isPathWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function isNodeModulesBin(directory) {
  return (
    path.basename(directory).toLowerCase() === ".bin" &&
    path.basename(path.dirname(directory)).toLowerCase() === "node_modules"
  );
}

export function resolveGlobalPiExecutable(projectRoot, environment = process.env) {
  const pathValue = environment.PATH ?? environment.Path ?? environment.path;
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    throw new PiUpdateError("PATH is empty; cannot locate the global Pi executable");
  }
  const localNodeModules = path.resolve(projectRoot, "node_modules");
  const executableNames =
    process.platform === "win32" ? ["pi.exe", "pi.cmd", "pi.bat", "pi"] : ["pi"];
  for (const rawDirectory of pathValue.split(path.delimiter)) {
    if (rawDirectory.length === 0) continue;
    const directory = path.resolve(projectRoot, rawDirectory);
    if (isNodeModulesBin(directory)) continue;
    for (const executableName of executableNames) {
      const candidate = path.join(directory, executableName);
      try {
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        const canonicalCandidate = realpathSync(candidate);
        if (isPathWithin(localNodeModules, canonicalCandidate)) continue;
        return candidate;
      } catch {
        // Continue to the next PATH candidate.
      }
    }
  }
  throw new PiUpdateError(
    "could not find a global Pi executable outside project-local node_modules/.bin on PATH"
  );
}

function capturedVersion(runCommand, command, args, cwd, label) {
  const result = runCommand({
    command,
    args,
    cwd,
    capture: true,
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  return parseExactVersion(result.stdout.trim(), label);
}

function registryVersion(runCommand, packageSpecifier, cwd) {
  const result = runCommand({
    command: "bun",
    args: ["pm", "view", packageSpecifier, "version", "--json"],
    cwd,
    capture: true,
    timeoutMs: REGISTRY_TIMEOUT_MS,
  });
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new PiUpdateError(`registry returned invalid JSON for ${packageSpecifier}`, {
      cause: error,
    });
  }
  return parseExactVersion(value, `registry version for ${packageSpecifier}`);
}

function piLatestRelease(runCommand, projectRoot) {
  const script = `
const response = await fetch(${JSON.stringify(PI_LATEST_RELEASE_URL)}, {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(\`Pi release API returned HTTP \${response.status}\`);
process.stdout.write(JSON.stringify(await response.json()));
`;
  const result = runCommand({
    command: process.execPath,
    args: ["--input-type=module", "--eval", script],
    cwd: projectRoot,
    capture: true,
    timeoutMs: REGISTRY_TIMEOUT_MS,
  });
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new PiUpdateError("Pi release API returned invalid JSON", { cause: error });
  }
  if (!isRecord(value)) throw new PiUpdateError("Pi release API must return a JSON object");
  const version = parseExactVersion(value.version, "Pi release API version");
  const packageName = value.packageName ?? CODING_AGENT_PACKAGE;
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new PiUpdateError("Pi release API packageName must be a non-empty string");
  }
  return { version, packageName };
}

function discoverCandidateVersion(runCommand, projectRoot, requestedVersion) {
  const registryLatestVersion = registryVersion(runCommand, CODING_AGENT_PACKAGE, projectRoot);
  const release = piLatestRelease(runCommand, projectRoot);
  if (release.packageName !== CODING_AGENT_PACKAGE) {
    throw new PiUpdateError(
      `Pi's latest release uses unsupported package ${release.packageName}; expected ${CODING_AGENT_PACKAGE}`
    );
  }
  if (release.version !== registryLatestVersion) {
    throw new PiUpdateError(
      `Pi release sources disagree: registry=${registryLatestVersion}, updater=${release.version}`
    );
  }
  if (requestedVersion === undefined) return release.version;
  const requested = parseExactVersion(requestedVersion, "--target");
  if (requested !== release.version) {
    throw new PiUpdateError(
      `--target ${requested} is not the latest published Pi version (${release.version}); Pi's self-updater cannot install an older exact version`
    );
  }
  return requested;
}

function verifyCandidatePackageFamily(runCommand, projectRoot, candidateVersion) {
  for (const packageName of PI_PACKAGES) {
    const packageSpecifier = `${packageName}@${candidateVersion}`;
    const publishedVersion = registryVersion(runCommand, packageSpecifier, projectRoot);
    if (publishedVersion !== candidateVersion) {
      throw new PiUpdateError(
        `${packageSpecifier} resolved to ${publishedVersion}; refusing an incoherent Pi SDK update`
      );
    }
  }
}

function installedPackageVersion(projectRoot, packageName) {
  const manifestPath = path.join(
    projectRoot,
    "node_modules",
    ...packageName.split("/"),
    "package.json"
  );
  const manifest = parseJsonFile(manifestPath);
  return parseExactVersion(stringField(manifest, "version", manifestPath), manifestPath);
}

function verifyInstalledVersions(projectRoot, candidateVersion) {
  for (const packageName of PI_PACKAGES) {
    const installedVersion = installedPackageVersion(projectRoot, packageName);
    if (installedVersion !== candidateVersion) {
      throw new PiUpdateError(
        `${packageName} installed as ${installedVersion}; expected ${candidateVersion}`
      );
    }
  }
}

function localPiCli(projectRoot) {
  const packageRoot = path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = parseJsonFile(manifestPath);
  const bin = manifest.bin;
  const relativeCli =
    typeof bin === "string"
      ? bin
      : isRecord(bin)
        ? stringField(bin, "pi", `${manifestPath}.bin`)
        : undefined;
  if (relativeCli === undefined) throw new PiUpdateError(`${manifestPath} does not declare bin.pi`);
  const cliPath = path.resolve(packageRoot, relativeCli);
  const relative = path.relative(packageRoot, cliPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(cliPath)) {
    throw new PiUpdateError(`${manifestPath} declares an invalid bin.pi path`);
  }
  return cliPath;
}

function runLocalPiSmoke(runCommand, projectRoot) {
  runCommand({
    command: process.execPath,
    args: [localPiCli(projectRoot), "--approve", "--no-session", "--list-models"],
    cwd: projectRoot,
    timeoutMs: CHECK_TIMEOUT_MS,
    extraEnvironment: { PI_OFFLINE: "1" },
  });
}

function runCompatibilityGate(runCommand, projectRoot, label, log) {
  log(`\n==> ${label}`);
  const offlineEnvironment = { PI_OFFLINE: "1" };
  for (const item of COMPATIBILITY_COMMANDS) {
    log(`--> ${formatCommand(item.command, item.args)}`);
    runCommand({
      ...item,
      cwd: projectRoot,
      timeoutMs: CHECK_TIMEOUT_MS,
      extraEnvironment: offlineEnvironment,
    });
  }
  log("--> local candidate Pi extension-load smoke");
  runLocalPiSmoke(runCommand, projectRoot);
}

function installProject(runCommand, projectRoot, frozen) {
  runCommand({
    command: "bun",
    args: frozen ? ["install", "--frozen-lockfile"] : ["install"],
    cwd: projectRoot,
    timeoutMs: INSTALL_TIMEOUT_MS,
    extraEnvironment: { PI_OFFLINE: "1" },
  });
}

function acquireExclusiveLock(lockPath, displayPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    throw new PiUpdateError(
      `another Pi update may be active; remove ${displayPath} only after confirming it is stale`,
      { cause: error }
    );
  }
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), token })}\n`
    );
  } catch (error) {
    rmSync(lockPath, { force: true });
    throw error;
  } finally {
    closeSync(descriptor);
  }
  return () => {
    try {
      const value = JSON.parse(readFileSync(lockPath, "utf8"));
      if (isRecord(value) && value.token === token) rmSync(lockPath, { force: true });
    } catch {
      // Never remove a lock that no longer proves this process owns it.
    }
  };
}

function acquireUpdateLocks(projectRoot, globalPiExecutable) {
  const globalKey = createHash("sha256")
    .update(path.resolve(globalPiExecutable))
    .digest("hex")
    .slice(0, 24);
  const globalLockPath = path.join(homedir(), ".penny", "locks", `pi-update-${globalKey}.lock`);
  const releaseGlobalLock = acquireExclusiveLock(globalLockPath, globalLockPath);
  try {
    const projectLockPath = path.join(projectRoot, ".penny", "pi-update.lock");
    const releaseProjectLock = acquireExclusiveLock(
      projectLockPath,
      path.relative(projectRoot, projectLockPath)
    );
    return () => {
      releaseProjectLock();
      releaseGlobalLock();
    };
  } catch (error) {
    releaseGlobalLock();
    throw error;
  }
}

function rollbackLocalState(runCommand, projectRoot, snapshots, log) {
  log("\n==> Restoring previous project-local Pi dependency state");
  restoreSnapshots(snapshots);
  installProject(runCommand, projectRoot, true);
  runCommand({
    command: "bun",
    args: ["run", "build:orchestration"],
    cwd: projectRoot,
    timeoutMs: CHECK_TIMEOUT_MS,
    extraEnvironment: { PI_OFFLINE: "1" },
  });
}

export function runPiUpdate(options = {}) {
  const projectRoot = path.resolve(
    options.projectRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../..")
  );
  const runCommand = options.runCommand ?? createCommandRunner();
  const log = options.log ?? ((message) => console.log(message));
  const globalPiExecutable =
    options.globalPiExecutable ?? resolveGlobalPiExecutable(projectRoot, process.env);
  const releaseLock =
    options.acquireLock === false ? () => {} : acquireUpdateLocks(projectRoot, globalPiExecutable);
  try {
    const pins = readPinnedVersions(projectRoot);
    const originalGlobalVersion = capturedVersion(
      runCommand,
      globalPiExecutable,
      ["--version"],
      projectRoot,
      "installed global Pi version"
    );
    const candidateVersion = discoverCandidateVersion(
      runCommand,
      projectRoot,
      options.targetVersion
    );
    if (compareVersions(candidateVersion, originalGlobalVersion) < 0) {
      throw new PiUpdateError(
        `refusing to downgrade global Pi from ${originalGlobalVersion} to ${candidateVersion}`
      );
    }
    if (
      candidateVersion === originalGlobalVersion &&
      pinsMatchVersion(pins, originalGlobalVersion)
    ) {
      log(`Pi and Penny SDK pins are already aligned at ${originalGlobalVersion}.`);
      return { status: "already_aligned", version: originalGlobalVersion };
    }

    log("\n==> Restoring the frozen baseline dependency graph");
    installProject(runCommand, projectRoot, true);
    runCompatibilityGate(
      runCommand,
      projectRoot,
      `Baseline compatibility (${pins.root[CODING_AGENT_PACKAGE]})`,
      log
    );
    verifyCandidatePackageFamily(runCommand, projectRoot, candidateVersion);
    const snapshots = captureSnapshots(projectRoot);
    let candidateInstalled = false;
    try {
      log(`\n==> Staging Penny SDK ${candidateVersion}`);
      updatePinnedFiles(projectRoot, candidateVersion);
      installProject(runCommand, projectRoot, false);
      candidateInstalled = true;
      verifyInstalledVersions(projectRoot, candidateVersion);
      runCompatibilityGate(
        runCommand,
        projectRoot,
        `Candidate compatibility (${candidateVersion})`,
        log
      );
    } catch (error) {
      try {
        rollbackLocalState(runCommand, projectRoot, snapshots, log);
      } catch (rollbackError) {
        throw new PiUpdateError("candidate validation failed and local rollback also failed", {
          cause: new AggregateError([error, rollbackError]),
        });
      }
      throw new PiUpdateError(
        "candidate Pi SDK failed compatibility validation; global Pi was not updated",
        {
          cause: error,
        }
      );
    }

    if (!candidateInstalled) throw new PiUpdateError("candidate installation did not complete");
    try {
      discoverCandidateVersion(runCommand, projectRoot, candidateVersion);
    } catch (error) {
      try {
        rollbackLocalState(runCommand, projectRoot, snapshots, log);
      } catch (rollbackError) {
        throw new PiUpdateError("latest-version recheck failed and local rollback also failed", {
          cause: new AggregateError([error, rollbackError]),
        });
      }
      throw new PiUpdateError(
        "validated candidate is no longer the latest release; global Pi was not updated",
        { cause: error }
      );
    }
    log(`\n==> Updating global Pi ${originalGlobalVersion} -> ${candidateVersion}`);
    let globalUpdateError;
    try {
      runCommand({
        command: globalPiExecutable,
        args: ["update", "--self"],
        cwd: projectRoot,
        timeoutMs: GLOBAL_UPDATE_TIMEOUT_MS,
      });
    } catch (error) {
      globalUpdateError = error;
    }

    let installedGlobalVersion;
    try {
      installedGlobalVersion = capturedVersion(
        runCommand,
        globalPiExecutable,
        ["--version"],
        projectRoot,
        "updated global Pi version"
      );
    } catch (versionError) {
      throw new PiUpdateError(
        "global Pi update left the installed version unreadable; candidate local files were retained for recovery",
        { cause: new AggregateError([globalUpdateError, versionError].filter(Boolean)) }
      );
    }

    if (
      installedGlobalVersion === originalGlobalVersion &&
      installedGlobalVersion !== candidateVersion
    ) {
      try {
        rollbackLocalState(runCommand, projectRoot, snapshots, log);
      } catch (rollbackError) {
        throw new PiUpdateError("global Pi did not update and local rollback failed", {
          cause: new AggregateError([globalUpdateError, rollbackError].filter(Boolean)),
        });
      }
      throw new PiUpdateError(
        `global Pi remained at ${installedGlobalVersion}; restored the matching project-local SDK`,
        { cause: globalUpdateError }
      );
    }
    if (installedGlobalVersion !== candidateVersion) {
      throw new PiUpdateError(
        `global Pi is ${installedGlobalVersion}, not validated candidate ${candidateVersion}; candidate local files were retained because automatic rollback would not restore alignment`,
        { cause: globalUpdateError }
      );
    }
    if (globalUpdateError) {
      throw new PiUpdateError(
        `global Pi reports ${candidateVersion}, but its updater returned an error; local files remain aligned for inspection`,
        { cause: globalUpdateError }
      );
    }

    log("\n==> Verifying the updated global Pi can load Penny");
    runCommand({
      command: globalPiExecutable,
      args: ["--approve", "--no-session", "--list-models"],
      cwd: projectRoot,
      timeoutMs: CHECK_TIMEOUT_MS,
      extraEnvironment: { PI_OFFLINE: "1" },
    });
    log(`\nPi and Penny SDK pins are aligned and validated at ${candidateVersion}.`);
    return { status: "updated", version: candidateVersion };
  } finally {
    releaseLock();
  }
}

export function parseArguments(argv) {
  let targetVersion;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      if (targetVersion !== undefined || argv[index + 1] === undefined) {
        throw new PiUpdateError("--target requires exactly one version");
      }
      targetVersion = parseExactVersion(argv[index + 1], "--target");
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      return { help: true };
    } else {
      throw new PiUpdateError(`unknown argument: ${argument}`);
    }
  }
  return { help: false, targetVersion };
}

function printHelp() {
  console.log(
    `Usage: bun run pi:update [--target VERSION]\n\nStages and validates the latest Pi SDK locally before updating global Pi.\n--target asserts the expected latest exact version; non-latest targets are rejected.`
  );
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const argumentsResult = parseArguments(process.argv.slice(2));
    if (argumentsResult.help) printHelp();
    else runPiUpdate({ targetVersion: argumentsResult.targetVersion });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Pi update failed: ${message}`);
    process.exitCode = 1;
  }
}
