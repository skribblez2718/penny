import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  PI_PACKAGES,
  compareVersions,
  parseArguments,
  parseExactVersion,
  pinsMatchVersion,
  readPinnedVersions,
  resolveGlobalPiExecutable,
  runPiUpdate,
  updatePinnedFiles,
} from "../../update-pi-sdk.mjs";

const OLD_VERSION = "0.84.4";
const NEW_VERSION = "0.85.0";
const temporaryDirectories = [];

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeInstalledPackages(projectRoot, version) {
  for (const packageName of PI_PACKAGES) {
    const packageRoot = path.join(projectRoot, "node_modules", ...packageName.split("/"));
    const manifest = { name: packageName, version };
    if (packageName === "@earendil-works/pi-coding-agent") {
      manifest.bin = { pi: "dist/bundle/cli.js" };
      const cliPath = path.join(packageRoot, "dist", "bundle", "cli.js");
      mkdirSync(path.dirname(cliPath), { recursive: true });
      writeFileSync(cliPath, "#!/usr/bin/env node\n", "utf8");
    }
    writeJson(path.join(packageRoot, "package.json"), manifest);
  }
}

function createFixture(version = OLD_VERSION) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-pi-update-"));
  temporaryDirectories.push(projectRoot);
  writeJson(path.join(projectRoot, "package.json"), {
    name: "penny",
    devDependencies: Object.fromEntries(PI_PACKAGES.map((name) => [name, version])),
  });
  writeJson(path.join(projectRoot, "apps", "orchestration", "package.json"), {
    dependencies: { "@earendil-works/pi-coding-agent": version },
  });
  writeFileSync(
    path.join(projectRoot, "README.md"),
    `# Penny\n\n- **Pi ${version}** — the currently supported agent runtime\n`,
    "utf8"
  );
  writeFileSync(path.join(projectRoot, "bun.lock"), `lock:${version}\n`, "utf8");
  writeInstalledPackages(projectRoot, version);
  return projectRoot;
}

function pinnedCodingAgentVersion(projectRoot) {
  return readPinnedVersions(projectRoot).root["@earendil-works/pi-coding-agent"];
}

function createFakeRunner(projectRoot, options = {}) {
  const state = {
    globalVersion: options.globalVersion ?? OLD_VERSION,
    candidateVersion: options.candidateVersion ?? NEW_VERSION,
    latestVersion: options.latestVersion ?? options.candidateVersion ?? NEW_VERSION,
    latestQueries: 0,
    releaseVersion:
      options.releaseVersion ?? options.latestVersion ?? options.candidateVersion ?? NEW_VERSION,
    releaseQueries: 0,
    calls: [],
  };
  const runner = ({ command, args }) => {
    state.calls.push({ command, args: [...args] });
    if (command === "pi" && args.length === 1 && args[0] === "--version") {
      if (options.failPostUpdateVersion && state.updateAttempted) {
        throw new Error("global version unreadable");
      }
      return { stdout: `${state.globalVersion}\n`, stderr: "" };
    }
    if (command === process.execPath && args[0] === "--input-type=module") {
      state.releaseQueries += 1;
      const releaseVersion =
        state.releaseQueries > 1 && options.releaseVersionAfterValidation
          ? options.releaseVersionAfterValidation
          : state.releaseVersion;
      return {
        stdout: `${JSON.stringify({
          version: releaseVersion,
          packageName: options.releasePackageName ?? PI_PACKAGES[2],
        })}\n`,
        stderr: "",
      };
    }
    if (command === "bun" && args[0] === "pm" && args[1] === "view") {
      const requested = args[2];
      if (options.unavailablePackage && requested.startsWith(`${options.unavailablePackage}@`)) {
        throw new Error("package unavailable");
      }
      if (requested === PI_PACKAGES[2]) {
        state.latestQueries += 1;
        const latestVersion =
          state.latestQueries > 1 && options.latestVersionAfterValidation
            ? options.latestVersionAfterValidation
            : state.latestVersion;
        return { stdout: `${JSON.stringify(latestVersion)}\n`, stderr: "" };
      }
      return { stdout: `${JSON.stringify(state.candidateVersion)}\n`, stderr: "" };
    }
    if (command === "bun" && args[0] === "install") {
      const version = pinnedCodingAgentVersion(projectRoot);
      writeInstalledPackages(projectRoot, version);
      if (!args.includes("--frozen-lockfile")) {
        writeFileSync(path.join(projectRoot, "bun.lock"), `lock:${version}\n`, "utf8");
      }
      return { stdout: "", stderr: "" };
    }
    if (
      command === "bun" &&
      args[0] === "run" &&
      args[1] === options.failCandidateCommand &&
      pinnedCodingAgentVersion(projectRoot) === state.candidateVersion
    ) {
      throw new Error("candidate compatibility failure");
    }
    if (command === "pi" && args[0] === "update") {
      state.updateAttempted = true;
      if (options.failGlobalUpdate) throw new Error("global update failure");
      state.globalVersion = options.globalUpdatedVersion ?? state.latestVersion;
      if (options.failGlobalUpdateAfterMutation) throw new Error("late global update failure");
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { runner, state };
}

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("semantic version comparison rejects downgrades and orders prereleases", () => {
  assert.equal(compareVersions("0.85.0", "0.84.4"), 1);
  assert.equal(compareVersions("0.85.0-beta.2", "0.85.0-beta.1"), 1);
  assert.equal(compareVersions("0.85.0-beta.1", "0.85.0"), -1);
  assert.equal(compareVersions("0.85.0-alpha-beta", "0.85.0-alpha-alpha"), 1);
  assert.equal(compareVersions("1.0.0-Z", "1.0.0-a"), -1);
  assert.equal(
    compareVersions("1.0.0-999999999999999999999999", "1.0.0-1000000000000000000000000"),
    -1
  );
  assert.equal(compareVersions("0.85.0", "0.85.0"), 0);
  assert.throws(() => parseExactVersion("latest"), /exact semantic version/u);
  assert.throws(() => parseExactVersion("01.2.3"), /exact semantic version/u);
  assert.throws(() => parseExactVersion("1.2.3-beta.01"), /exact semantic version/u);
});

test("global Pi resolution skips Bun's project-local node_modules binary", () => {
  const projectRoot = createFixture();
  const executableName = process.platform === "win32" ? "pi.cmd" : "pi";
  const localExecutable = path.join(projectRoot, "node_modules", ".bin", executableName);
  const globalExecutable = path.join(projectRoot, "fake-global-bin", executableName);
  mkdirSync(path.dirname(localExecutable), { recursive: true });
  mkdirSync(path.dirname(globalExecutable), { recursive: true });
  writeFileSync(localExecutable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  writeFileSync(globalExecutable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  chmodSync(localExecutable, 0o755);
  chmodSync(globalExecutable, 0o755);

  assert.equal(
    resolveGlobalPiExecutable(projectRoot, {
      PATH: [path.dirname(localExecutable), path.dirname(globalExecutable)].join(path.delimiter),
    }),
    globalExecutable
  );
});

test("argument parsing accepts one exact target and rejects command syntax", () => {
  assert.deepEqual(parseArguments(["--target", NEW_VERSION]), {
    help: false,
    targetVersion: NEW_VERSION,
  });
  assert.throws(
    () => parseArguments(["--target", "0.85.0;touch-pwned"]),
    /exact semantic version/u
  );
  assert.throws(() => parseArguments(["--unknown"]), /unknown argument/u);
});

test("pin updates preserve the manifests while changing all five declarations and README", () => {
  const projectRoot = createFixture();

  updatePinnedFiles(projectRoot, NEW_VERSION);

  const pins = readPinnedVersions(projectRoot);
  assert.equal(pinsMatchVersion(pins, NEW_VERSION), true);
  assert.match(readFileSync(path.join(projectRoot, "README.md"), "utf8"), /\*\*Pi 0\.85\.0\*\*/u);
});

test("a non-latest explicit target fails before compatibility or mutation", () => {
  const projectRoot = createFixture();
  const originalManifest = readFileSync(path.join(projectRoot, "package.json"));
  const { runner, state } = createFakeRunner(projectRoot, { latestVersion: NEW_VERSION });

  assert.throws(
    () =>
      runPiUpdate({
        projectRoot,
        globalPiExecutable: "pi",
        targetVersion: OLD_VERSION,
        runCommand: runner,
        log: () => {},
        acquireLock: false,
      }),
    /not the latest published Pi version/u
  );

  assert.deepEqual(readFileSync(path.join(projectRoot, "package.json")), originalManifest);
  assert.equal(
    state.calls.some((call) => call.command === "pi" && call.args[0] === "update"),
    false
  );
  assert.equal(
    state.calls.some((call) => call.command === "bun" && call.args[0] === "run"),
    false
  );
});

test("release-source disagreement fails before compatibility or mutation", () => {
  const projectRoot = createFixture();
  const { runner, state } = createFakeRunner(projectRoot, {
    latestVersion: NEW_VERSION,
    releaseVersion: OLD_VERSION,
  });

  assert.throws(
    () =>
      runPiUpdate({
        projectRoot,
        globalPiExecutable: "pi",
        runCommand: runner,
        log: () => {},
        acquireLock: false,
      }),
    /release sources disagree/u
  );

  assert.equal(
    state.calls.some((call) => call.command === "bun" && call.args[0] === "run"),
    false
  );
  assert.equal(pinsMatchVersion(readPinnedVersions(projectRoot), OLD_VERSION), true);
});

test("a Pi package-name migration fails before compatibility or mutation", () => {
  const projectRoot = createFixture();
  const { runner, state } = createFakeRunner(projectRoot, {
    releasePackageName: "@example/pi-renamed",
  });

  assert.throws(
    () =>
      runPiUpdate({
        projectRoot,
        globalPiExecutable: "pi",
        runCommand: runner,
        log: () => {},
        acquireLock: false,
      }),
    /unsupported package/u
  );

  assert.equal(
    state.calls.some((call) => call.command === "bun" && call.args[0] === "run"),
    false
  );
  assert.equal(pinsMatchVersion(readPinnedVersions(projectRoot), OLD_VERSION), true);
});

test("an already aligned installation exits without compatibility or install work", () => {
  const projectRoot = createFixture();
  const { runner, state } = createFakeRunner(projectRoot, {
    globalVersion: OLD_VERSION,
    candidateVersion: OLD_VERSION,
  });

  const result = runPiUpdate({
    projectRoot,
    globalPiExecutable: "pi",
    runCommand: runner,
    log: () => {},
    acquireLock: false,
  });

  assert.deepEqual(result, { status: "already_aligned", version: OLD_VERSION });
  assert.equal(
    state.calls.some((call) => call.args[0] === "install"),
    false
  );
  assert.equal(
    state.calls.some((call) => call.args[0] === "run"),
    false
  );
});

test("an update-required clean checkout restores the frozen baseline before checks", () => {
  const projectRoot = createFixture();
  rmSync(path.join(projectRoot, "node_modules"), { recursive: true, force: true });
  const { runner, state } = createFakeRunner(projectRoot);

  const result = runPiUpdate({
    projectRoot,
    globalPiExecutable: "pi",
    runCommand: runner,
    log: () => {},
    acquireLock: false,
  });

  assert.deepEqual(result, { status: "updated", version: NEW_VERSION });
  const frozenInstallIndex = state.calls.findIndex(
    (call) => call.command === "bun" && call.args.join(" ") === "install --frozen-lockfile"
  );
  const firstCheckIndex = state.calls.findIndex(
    (call) => call.command === "bun" && call.args[0] === "run"
  );
  assert.ok(frozenInstallIndex >= 0 && frozenInstallIndex < firstCheckIndex);
});

test("a successful update validates locally before updating global Pi", () => {
  const projectRoot = createFixture();
  const { runner, state } = createFakeRunner(projectRoot);

  const result = runPiUpdate({
    projectRoot,
    globalPiExecutable: "pi",
    runCommand: runner,
    log: () => {},
    acquireLock: false,
  });

  assert.deepEqual(result, { status: "updated", version: NEW_VERSION });
  assert.equal(state.globalVersion, NEW_VERSION);
  assert.equal(pinsMatchVersion(readPinnedVersions(projectRoot), NEW_VERSION), true);
  assert.equal(readFileSync(path.join(projectRoot, "bun.lock"), "utf8"), `lock:${NEW_VERSION}\n`);
  assert.equal(
    state.calls.some(
      (call) => call.command === "bun" && call.args.join(" ") === "run test:pi-compat"
    ),
    true
  );
  assert.equal(
    state.calls.some(
      (call) => call.command === "bun" && call.args.join(" ") === "run test:typescript"
    ),
    false
  );
  const updateIndex = state.calls.findIndex(
    (call) => call.command === "pi" && call.args[0] === "update"
  );
  const candidateTestIndex = state.calls.findLastIndex(
    (call) => call.command === "bun" && call.args[0] === "run"
  );
  assert.ok(
    updateIndex > candidateTestIndex,
    "global update must follow candidate compatibility checks"
  );
});

test("candidate failure restores exact project files and does not update global Pi", () => {
  const projectRoot = createFixture();
  const snapshot = new Map(
    ["package.json", "apps/orchestration/package.json", "README.md", "bun.lock"].map((file) => [
      file,
      readFileSync(path.join(projectRoot, file)),
    ])
  );
  const { runner, state } = createFakeRunner(projectRoot, { failCandidateCommand: "typecheck" });

  assert.throws(
    () =>
      runPiUpdate({
        projectRoot,
        globalPiExecutable: "pi",
        runCommand: runner,
        log: () => {},
        acquireLock: false,
      }),
    /global Pi was not updated/u
  );

  assert.equal(state.globalVersion, OLD_VERSION);
  for (const [file, content] of snapshot) {
    assert.deepEqual(readFileSync(path.join(projectRoot, file)), content);
  }
  assert.equal(pinsMatchVersion(readPinnedVersions(projectRoot), OLD_VERSION), true);
  const candidateInstallIndex = state.calls.findIndex(
    (call) => call.command === "bun" && call.args.join(" ") === "install"
  );
  const rollbackInstallIndex = state.calls.findLastIndex(
    (call) => call.command === "bun" && call.args.join(" ") === "install --frozen-lockfile"
  );
  const rollbackBuildIndex = state.calls.findLastIndex(
    (call) => call.command === "bun" && call.args.join(" ") === "run build:orchestration"
  );
  assert.ok(
    candidateInstallIndex < rollbackInstallIndex && rollbackInstallIndex < rollbackBuildIndex,
    "rollback must restore the frozen graph before rebuilding orchestration"
  );
});

test("a newer release appearing during validation restores local state before global update", () => {
  const projectRoot = createFixture();
  const { runner, state } = createFakeRunner(projectRoot, {
    latestVersionAfterValidation: "0.86.0",
  });

  assert.throws(
    () =>
      runPiUpdate({
        projectRoot,
        globalPiExecutable: "pi",
        runCommand: runner,
        log: () => {},
        acquireLock: false,
      }),
    /no longer the latest release/u
  );

  assert.equal(state.globalVersion, OLD_VERSION);
  assert.equal(pinsMatchVersion(readPinnedVersions(projectRoot), OLD_VERSION), true);
  assert.equal(
    state.calls.some((call) => call.command === "pi" && call.args[0] === "update"),
    false
  );
});

test("global update failure restores local state when global Pi remains unchanged", () => {
  const projectRoot = createFixture();
  const { runner, state } = createFakeRunner(projectRoot, { failGlobalUpdate: true });

  assert.throws(
    () =>
      runPiUpdate({
        projectRoot,
        globalPiExecutable: "pi",
        runCommand: runner,
        log: () => {},
        acquireLock: false,
      }),
    /restored the matching project-local SDK/u
  );

  assert.equal(state.globalVersion, OLD_VERSION);
  assert.equal(pinsMatchVersion(readPinnedVersions(projectRoot), OLD_VERSION), true);
  assert.equal(readFileSync(path.join(projectRoot, "bun.lock"), "utf8"), `lock:${OLD_VERSION}\n`);
});

test("a late global updater error fails closed while retaining aligned candidate pins", () => {
  const projectRoot = createFixture();
  const { runner, state } = createFakeRunner(projectRoot, {
    failGlobalUpdateAfterMutation: true,
  });

  assert.throws(
    () =>
      runPiUpdate({
        projectRoot,
        globalPiExecutable: "pi",
        runCommand: runner,
        log: () => {},
        acquireLock: false,
      }),
    /updater returned an error/u
  );

  assert.equal(state.globalVersion, NEW_VERSION);
  assert.equal(pinsMatchVersion(readPinnedVersions(projectRoot), NEW_VERSION), true);
});

test("an unexpected global version fails closed without claiming the candidate", () => {
  const projectRoot = createFixture();
  const unexpectedVersion = "0.86.0";
  const { runner, state } = createFakeRunner(projectRoot, {
    globalUpdatedVersion: unexpectedVersion,
  });

  assert.throws(
    () =>
      runPiUpdate({
        projectRoot,
        globalPiExecutable: "pi",
        runCommand: runner,
        log: () => {},
        acquireLock: false,
      }),
    /not validated candidate/u
  );

  assert.equal(state.globalVersion, unexpectedVersion);
  assert.equal(pinsMatchVersion(readPinnedVersions(projectRoot), NEW_VERSION), true);
});

test("an unreadable global version after update fails closed and retains recovery state", () => {
  const projectRoot = createFixture();
  const { runner } = createFakeRunner(projectRoot, { failPostUpdateVersion: true });

  assert.throws(
    () =>
      runPiUpdate({
        projectRoot,
        globalPiExecutable: "pi",
        runCommand: runner,
        log: () => {},
        acquireLock: false,
      }),
    /installed version unreadable/u
  );

  assert.equal(pinsMatchVersion(readPinnedVersions(projectRoot), NEW_VERSION), true);
});

test("missing coordinated package release aborts before manifest mutation", () => {
  const projectRoot = createFixture();
  const originalManifest = readFileSync(path.join(projectRoot, "package.json"));
  const { runner, state } = createFakeRunner(projectRoot, {
    unavailablePackage: "@earendil-works/pi-tui",
  });

  assert.throws(
    () =>
      runPiUpdate({
        projectRoot,
        globalPiExecutable: "pi",
        runCommand: runner,
        log: () => {},
        acquireLock: false,
      }),
    /package unavailable/u
  );

  assert.equal(state.globalVersion, OLD_VERSION);
  assert.deepEqual(readFileSync(path.join(projectRoot, "package.json")), originalManifest);
});
