import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  PI_PACKAGES,
  PI_UPDATE_ERROR_CODES,
  compareVersions,
  createCommandRunner,
  formatPiUpdateFailure,
  parseArguments,
  parseExactVersion,
  pinsMatchVersion,
  readPinnedVersions,
  resolveGlobalPiExecutable,
  runCandidateConsumerPreflight,
  runPiUpdate,
  updatePinnedFiles,
} from "../../update-pi-sdk.mjs";

const OLD_VERSION = "0.84.4";
const NEW_VERSION = "0.85.0";
const OLD_TYPEBOX_VERSION = "1.2.0";
const NEW_TYPEBOX_VERSION = "1.3.0";
const temporaryDirectories = [];

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeInstalledPackages(projectRoot, version, typeboxVersion) {
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
  writeJson(path.join(projectRoot, "node_modules", "typebox", "package.json"), {
    name: "typebox",
    version: typeboxVersion,
  });
}

function createFixture(version = OLD_VERSION, typeboxVersion = OLD_TYPEBOX_VERSION) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-pi-update-"));
  temporaryDirectories.push(projectRoot);
  writeJson(path.join(projectRoot, "package.json"), {
    name: "penny",
    devDependencies: {
      ...Object.fromEntries(PI_PACKAGES.map((name) => [name, version])),
      typebox: typeboxVersion,
    },
  });
  writeJson(path.join(projectRoot, "apps", "orchestration", "package.json"), {
    dependencies: {
      "@earendil-works/pi-coding-agent": version,
      typebox: typeboxVersion,
    },
  });
  writeJson(path.join(projectRoot, "apps", "sca-service", "package.json"), {
    dependencies: { typebox: typeboxVersion },
  });
  writeFileSync(path.join(projectRoot, "bun.lock"), `lock:${version}:${typeboxVersion}\n`, "utf8");
  writeInstalledPackages(projectRoot, version, typeboxVersion);
  return projectRoot;
}

function pinnedCodingAgentVersion(projectRoot) {
  return readPinnedVersions(projectRoot).root["@earendil-works/pi-coding-agent"];
}

function pinnedTypeboxVersions(projectRoot) {
  const manifests = [
    ["package.json", "devDependencies"],
    ["apps/orchestration/package.json", "dependencies"],
    ["apps/sca-service/package.json", "dependencies"],
  ];
  return manifests.map(([relativePath, field]) => {
    const manifest = JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8"));
    return manifest[field].typebox;
  });
}

function createChildRequest(source) {
  const cwd = mkdtempSync(path.join(tmpdir(), "penny-pi-command-"));
  temporaryDirectories.push(cwd);
  const scriptPath = path.join(cwd, "child.mjs");
  writeFileSync(scriptPath, source, "utf8");
  return { command: process.execPath, args: [scriptPath], cwd, capture: true };
}

function createFakeRunner(projectRoot, options = {}) {
  const state = {
    globalVersion: options.globalVersion ?? OLD_VERSION,
    candidateVersion: options.candidateVersion ?? NEW_VERSION,
    candidateTypeboxVersion: options.candidateTypeboxVersion ?? NEW_TYPEBOX_VERSION,
    latestVersion: options.latestVersion ?? options.candidateVersion ?? NEW_VERSION,
    latestQueries: 0,
    releaseVersion:
      options.releaseVersion ?? options.latestVersion ?? options.candidateVersion ?? NEW_VERSION,
    releaseQueries: 0,
    calls: [],
  };
  const runner = ({ command, args, cwd, extraEnvironment = {} }) => {
    state.calls.push({
      command,
      args: [...args],
      cwd,
      extraEnvironment: { ...extraEnvironment },
      graphVersion: pinnedCodingAgentVersion(projectRoot),
    });
    if (command === "pi" && args.length === 1 && args[0] === "--version") {
      if (options.failPostUpdateVersion && state.updateAttempted) {
        throw new Error("global version unreadable");
      }
      return { stdout: `${state.globalVersion}\n`, stderr: "" };
    }
    if (
      command === process.execPath &&
      args[0] === "--input-type=module" &&
      args[2]?.includes("pi.dev/api/latest-version")
    ) {
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
    if (
      command === process.execPath &&
      args[0] === "--input-type=module" &&
      args[2]?.includes("await import(")
    ) {
      if (options.failCandidatePackageImport) {
        throw new Error("clean-consumer package import failed");
      }
      return { stdout: "", stderr: "" };
    }
    if (command === "bun" && args[0] === "pm" && args[1] === "view") {
      const requested = args[2];
      const property = args[3];
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
      if (
        requested === `${PI_PACKAGES[2]}@${state.candidateVersion}` &&
        property === "dependencies.typebox"
      ) {
        return { stdout: `${JSON.stringify(state.candidateTypeboxVersion)}\n`, stderr: "" };
      }
      if (requested.startsWith("typebox@")) {
        return { stdout: `${JSON.stringify(state.candidateTypeboxVersion)}\n`, stderr: "" };
      }
      return { stdout: `${JSON.stringify(state.candidateVersion)}\n`, stderr: "" };
    }
    if (command === "bun" && args[0] === "install") {
      const installRoot = cwd ?? projectRoot;
      const isProjectInstall = installRoot === projectRoot;
      if (!isProjectInstall && options.failCandidateConsumerInstall) {
        throw new Error("candidate package resolution failed");
      }
      const version = isProjectInstall
        ? pinnedCodingAgentVersion(projectRoot)
        : state.candidateVersion;
      const typeboxVersion = isProjectInstall
        ? pinnedTypeboxVersions(projectRoot)[0]
        : state.candidateTypeboxVersion;
      writeInstalledPackages(installRoot, version, typeboxVersion);
      if (isProjectInstall && !args.includes("--frozen-lockfile")) {
        writeFileSync(
          path.join(projectRoot, "bun.lock"),
          `lock:${version}:${typeboxVersion}\n`,
          "utf8"
        );
      }
      return { stdout: "", stderr: "" };
    }
    if (command === "bun" && args[0] === "run" && args[1] === options.failBaselineCommand) {
      throw new Error("baseline compatibility failure");
    }
    if (
      command === "bun" &&
      args[0] === "run" &&
      args[1] === options.failCandidateCommand &&
      pinnedCodingAgentVersion(projectRoot) === state.candidateVersion
    ) {
      throw new Error("candidate compatibility failure");
    }
    if (
      options.failCandidateExtensionLoad &&
      command === process.execPath &&
      typeof args[0] === "string" &&
      args[0].startsWith(projectRoot) &&
      args[0].endsWith(path.join("dist", "bundle", "cli.js")) &&
      pinnedCodingAgentVersion(projectRoot) === state.candidateVersion
    ) {
      throw new Error("candidate extension load failed");
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

test("command runner preserves captured output on success", () => {
  const request = createChildRequest(
    'process.stdout.write("child stdout\\n"); process.stderr.write("child stderr\\n");'
  );

  assert.deepEqual(createCommandRunner()(request), {
    stdout: "child stdout\n",
    stderr: "child stderr\n",
  });
});

for (const scenario of [
  {
    name: "stderr preferred over stdout",
    source:
      'process.stdout.write("unused stdout\\n"); process.stderr.write("child stderr diagnostic\\n"); process.exitCode = 7;',
    detail: "child stderr diagnostic",
  },
  {
    name: "stdout fallback",
    source: 'process.stdout.write("child stdout diagnostic\\n"); process.exitCode = 7;',
    detail: "child stdout diagnostic",
  },
]) {
  test(`command runner reports a nonzero exit with ${scenario.name}`, () => {
    const request = createChildRequest(scenario.source);

    assert.throws(
      () => createCommandRunner()(request),
      (error) => {
        assert.equal(error.name, "PiUpdateError");
        assert.equal(error.code, PI_UPDATE_ERROR_CODES.PI_UPDATE_FAILED);
        assert.ok(error.message.endsWith(`exited with status 7: ${scenario.detail}`));
        assert.doesNotMatch(error.message, /unused stdout|signal|timed out|failed to run/u);
        return true;
      }
    );
  });
}

for (const [signal, capture] of [
  ["SIGTERM", true],
  ["SIGKILL", false],
]) {
  test(
    `command runner reports the actual ${signal} signal with capture=${capture}`,
    { skip: process.platform === "win32" ? "POSIX signal termination is not portable" : false },
    () => {
      const diagnostic = capture ? "child signal diagnostic" : "";
      const request = createChildRequest(
        `import { writeSync } from "node:fs";
writeSync(2, ${JSON.stringify(diagnostic)});
process.kill(process.pid, ${JSON.stringify(signal)});`
      );

      assert.throws(
        () => createCommandRunner()({ ...request, capture }),
        (error) => {
          assert.equal(error.name, "PiUpdateError");
          assert.ok(
            error.message.endsWith(
              `terminated by signal ${signal}${capture ? `: ${diagnostic}` : ""}`
            )
          );
          assert.doesNotMatch(
            error.message,
            /status null|timed out|failed to run|OOM|out of memory/iu
          );
          return true;
        }
      );
    }
  );
}

test("command runner distinguishes a timeout from a child signal or exit status", () => {
  const request = createChildRequest("setInterval(() => {}, 1000);");

  assert.throws(
    () => createCommandRunner()({ ...request, timeoutMs: 100 }),
    (error) => {
      assert.equal(error.name, "PiUpdateError");
      assert.equal(error.cause.code, "ETIMEDOUT");
      assert.match(error.message, /timed out after 100 ms/u);
      if (process.platform !== "win32") assert.match(error.message, /signal SIGTERM/u);
      assert.doesNotMatch(error.message, /status null|exited with status|failed to run/u);
      return true;
    }
  );
});

test("command runner distinguishes a spawn failure from a child exit", () => {
  const request = createChildRequest("");
  const command = path.join(request.cwd, "missing-executable");

  assert.throws(
    () => createCommandRunner()({ ...request, command, args: [] }),
    (error) => {
      assert.equal(error.name, "PiUpdateError");
      assert.equal(error.cause.code, "ENOENT");
      assert.match(error.message, /failed to run .*ENOENT/u);
      assert.doesNotMatch(error.message, /status null|exited with status|signal|timed out/u);
      return true;
    }
  );
});

test(
  "command runner reports a non-executable child as a spawn failure",
  { skip: process.platform === "win32" ? "POSIX executable permissions are not portable" : false },
  () => {
    const request = createChildRequest("");
    chmodSync(request.args[0], 0o644);

    assert.throws(
      () => createCommandRunner()({ ...request, command: request.args[0], args: [] }),
      (error) => {
        assert.equal(error.name, "PiUpdateError");
        assert.equal(error.cause.code, "EACCES");
        assert.match(error.message, /failed to run .*EACCES/u);
        assert.doesNotMatch(error.message, /status null|exited with status|signal|timed out/u);
        return true;
      }
    );
  }
);

test("clean-consumer preflight catches an undeclared runtime dependency", () => {
  const realRunner = createCommandRunner();
  let consumerRoot;
  const runner = (request) => {
    if (request.command === "bun" && request.args[0] === "install") {
      consumerRoot = request.cwd;
      const consumerManifest = JSON.parse(
        readFileSync(path.join(request.cwd, "package.json"), "utf8")
      );
      assert.deepEqual(consumerManifest.dependencies, {
        "@earendil-works/pi-coding-agent": NEW_VERSION,
      });
      const packageRoot = path.join(
        request.cwd,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent"
      );
      writeJson(path.join(packageRoot, "package.json"), {
        name: "@earendil-works/pi-coding-agent",
        version: NEW_VERSION,
        type: "module",
        exports: { ".": "./dist/index.js" },
        bin: { pi: "dist/bundle/cli.js" },
      });
      mkdirSync(path.join(packageRoot, "dist", "bundle"), { recursive: true });
      writeFileSync(
        path.join(packageRoot, "dist", "index.js"),
        'import "@example/missing-runtime-dependency";\nexport const loaded = true;\n',
        "utf8"
      );
      writeFileSync(
        path.join(packageRoot, "dist", "bundle", "cli.js"),
        "#!/usr/bin/env node\n",
        "utf8"
      );
      return { stdout: "", stderr: "" };
    }
    return realRunner(request);
  };

  assert.throws(
    () => runCandidateConsumerPreflight(runner, NEW_VERSION),
    (error) => {
      assert.equal(error.code, PI_UPDATE_ERROR_CODES.CANDIDATE_PACKAGE_INVALID);
      assert.equal(error.phase, "candidate_sdk_import");
      const formatted = formatPiUpdateFailure(error);
      assert.match(formatted, /\[CANDIDATE_PACKAGE_INVALID\] \(candidate_sdk_import\)/u);
      assert.match(formatted, /missing-runtime-dependency/u);
      return true;
    }
  );

  assert.equal(typeof consumerRoot, "string");
  assert.equal(existsSync(consumerRoot), false, "clean-consumer scratch state must be removed");
});

test("pin updates coordinate Pi and TypeBox declarations without requiring a README", () => {
  const projectRoot = createFixture();

  updatePinnedFiles(projectRoot, NEW_VERSION, NEW_TYPEBOX_VERSION);

  const pins = readPinnedVersions(projectRoot);
  assert.equal(pinsMatchVersion(pins, NEW_VERSION), true);
  assert.deepEqual(pinnedTypeboxVersions(projectRoot), [
    NEW_TYPEBOX_VERSION,
    NEW_TYPEBOX_VERSION,
    NEW_TYPEBOX_VERSION,
  ]);
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

test("a broken clean-consumer package fails before Penny project mutation", () => {
  const projectRoot = createFixture();
  const snapshot = new Map(
    [
      "package.json",
      "apps/orchestration/package.json",
      "apps/sca-service/package.json",
      "bun.lock",
    ].map((file) => [file, readFileSync(path.join(projectRoot, file))])
  );
  const { runner, state } = createFakeRunner(projectRoot, {
    failCandidatePackageImport: true,
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
    (error) => {
      assert.equal(error.code, PI_UPDATE_ERROR_CODES.CANDIDATE_PACKAGE_INVALID);
      assert.equal(error.phase, "candidate_sdk_import");
      return true;
    }
  );

  for (const [file, content] of snapshot) {
    assert.deepEqual(readFileSync(path.join(projectRoot, file)), content);
  }
  assert.equal(
    state.calls.some(
      (call) => call.cwd === projectRoot && call.command === "bun" && call.args[0] === "install"
    ),
    false
  );
  assert.equal(
    state.calls.some(
      (call) => call.cwd === projectRoot && call.command === "bun" && call.args[0] === "run"
    ),
    false
  );
  assert.equal(
    state.calls.some((call) => call.command === "pi" && call.args[0] === "update"),
    false
  );
});

test("a clean-consumer install failure is classified before Penny project mutation", () => {
  const projectRoot = createFixture();
  const { runner, state } = createFakeRunner(projectRoot, {
    failCandidateConsumerInstall: true,
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
    (error) => {
      assert.equal(error.code, PI_UPDATE_ERROR_CODES.CANDIDATE_INSTALL_FAILED);
      assert.equal(error.phase, "candidate_consumer_install");
      assert.match(formatPiUpdateFailure(error), /candidate package resolution failed/u);
      return true;
    }
  );

  assert.equal(pinsMatchVersion(readPinnedVersions(projectRoot), OLD_VERSION), true);
  assert.equal(
    state.calls.some(
      (call) => call.cwd === projectRoot && call.command === "bun" && call.args[0] === "install"
    ),
    false
  );
  assert.equal(
    state.calls.some(
      (call) => call.cwd === projectRoot && call.command === "bun" && call.args[0] === "run"
    ),
    false
  );
  assert.equal(
    state.calls.some((call) => call.command === "pi" && call.args[0] === "update"),
    false
  );
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
  const preflightInstallIndex = state.calls.findIndex(
    (call) =>
      call.command === "bun" &&
      call.cwd !== projectRoot &&
      call.args.join(" ") === "install --production --ignore-scripts"
  );
  const frozenInstallIndex = state.calls.findIndex(
    (call) =>
      call.command === "bun" &&
      call.cwd === projectRoot &&
      call.args.join(" ") === "install --frozen-lockfile"
  );
  const firstCheckIndex = state.calls.findIndex(
    (call) => call.command === "bun" && call.cwd === projectRoot && call.args[0] === "run"
  );
  assert.ok(
    preflightInstallIndex >= 0 && preflightInstallIndex < frozenInstallIndex,
    "clean-consumer preflight must run before touching Penny's dependency graph"
  );
  assert.ok(frozenInstallIndex < firstCheckIndex);
});

for (const failedCommand of ["typescript:architecture", "typecheck:all", "test:pi-compat"]) {
  test(`baseline ${failedCommand} failure stops before candidate staging or global update`, () => {
    const projectRoot = createFixture();
    const snapshot = new Map(
      [
        "package.json",
        "apps/orchestration/package.json",
        "apps/sca-service/package.json",
        "bun.lock",
      ].map((file) => [file, readFileSync(path.join(projectRoot, file))])
    );
    const { runner, state } = createFakeRunner(projectRoot, {
      failBaselineCommand: failedCommand,
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
      (error) => {
        assert.equal(error.code, PI_UPDATE_ERROR_CODES.BASELINE_FAILED);
        assert.equal(error.phase, "baseline_compatibility");
        assert.match(formatPiUpdateFailure(error), /baseline compatibility failure/u);
        return true;
      }
    );

    for (const [file, content] of snapshot) {
      assert.deepEqual(readFileSync(path.join(projectRoot, file)), content);
    }
    assert.equal(state.globalVersion, OLD_VERSION);
    assert.ok(state.calls.every((call) => call.graphVersion === OLD_VERSION));
    assert.deepEqual(
      state.calls
        .filter(
          (call) => call.cwd === projectRoot && call.command === "bun" && call.args[0] === "install"
        )
        .map((call) => call.args),
      [["install", "--frozen-lockfile"]],
      "baseline failure must not install a staged candidate or trigger rollback"
    );
    assert.equal(
      state.calls.some((call) => call.command === "pi" && call.args[0] === "update"),
      false
    );
  });
}

test("a successful update runs compatibility checks once per graph before updating global Pi", () => {
  const environmentBefore = { ...process.env };
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
  assert.equal(
    readFileSync(path.join(projectRoot, "bun.lock"), "utf8"),
    `lock:${NEW_VERSION}:${NEW_TYPEBOX_VERSION}\n`
  );
  assert.deepEqual(pinnedTypeboxVersions(projectRoot), [
    NEW_TYPEBOX_VERSION,
    NEW_TYPEBOX_VERSION,
    NEW_TYPEBOX_VERSION,
  ]);
  const localCli = path.join(
    projectRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js"
  );
  const compatibilityCalls = state.calls.filter(
    (call) =>
      call.cwd === projectRoot &&
      ((call.command === "bun" && call.args[0] === "run") ||
        (call.command === process.execPath && call.args[0] === localCli))
  );
  assert.deepEqual(
    compatibilityCalls.map((call) => [call.graphVersion, call.command, ...call.args]),
    [OLD_VERSION, NEW_VERSION].flatMap((version) => [
      [version, "bun", "run", "typescript:architecture"],
      [version, "bun", "run", "typecheck:all"],
      [version, "bun", "run", "test:pi-compat"],
      [version, process.execPath, localCli, "--approve", "--no-session", "--list-models"],
    ])
  );
  const expectedEnvironment = {
    PI_OFFLINE: "1",
    PROJECT_ROOT: projectRoot,
    PENNY_SKILLS_DIR: path.join(projectRoot, ".pi", "skills"),
  };
  for (const call of compatibilityCalls) {
    assert.deepEqual(call.extraEnvironment, expectedEnvironment);
  }
  const globalSmokeCalls = state.calls.filter(
    (call) => call.command === "pi" && call.args[0] === "--approve"
  );
  assert.deepEqual(
    globalSmokeCalls.map((call) => [call.cwd, call.args, call.extraEnvironment]),
    [[projectRoot, ["--approve", "--no-session", "--list-models"], expectedEnvironment]]
  );
  const consumerCalls = state.calls.filter((call) => call.cwd !== projectRoot);
  assert.equal(consumerCalls.length, 3);
  assert.deepEqual(
    consumerCalls.map((call) => call.extraEnvironment),
    [{}, { PI_OFFLINE: "1" }, { PI_OFFLINE: "1" }],
    "clean-consumer install, import and CLI must not receive checkout roots"
  );
  for (const call of state.calls.filter(
    (call) =>
      call.cwd === projectRoot &&
      !compatibilityCalls.includes(call) &&
      !globalSmokeCalls.includes(call)
  )) {
    assert.deepEqual(
      call.extraEnvironment,
      call.command === "bun" && call.args[0] === "install" ? { PI_OFFLINE: "1" } : {},
      "installs, registry/release discovery and global update/version checks must stay independent"
    );
  }
  assert.ok(
    isDeepStrictEqual({ ...process.env }, environmentBefore),
    "updater must not mutate process.env"
  );
  const updateIndex = state.calls.findIndex(
    (call) => call.command === "pi" && call.args[0] === "update"
  );
  const candidateSmokeIndex = state.calls.findLastIndex(
    (call) => call.command === process.execPath && call.args[0] === localCli
  );
  assert.ok(
    updateIndex > candidateSmokeIndex,
    "global update must follow candidate compatibility checks and extension loading"
  );
});

test("checkout validation overrides hostile inherited roots in a real local child", () => {
  const environmentBefore = { ...process.env };
  const projectRoot = createFixture();
  const { runner, state } = createFakeRunner(projectRoot);
  runPiUpdate({
    projectRoot,
    globalPiExecutable: "pi",
    runCommand: runner,
    log: () => {},
    acquireLock: false,
  });
  const validationCall = state.calls.find(
    (call) => call.command === "bun" && call.args.join(" ") === "run test:pi-compat"
  );
  assert.ok(validationCall);
  const request = createChildRequest(`process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  PI_OFFLINE: process.env.PI_OFFLINE,
  PROJECT_ROOT: process.env.PROJECT_ROOT,
  PENNY_SKILLS_DIR: process.env.PENNY_SKILLS_DIR,
  inherited: process.env.CHECKOUT_ROOT_PROBE,
}));`);
  const inheritedEnvironment = Object.freeze({
    ...process.env,
    PI_OFFLINE: "0",
    PROJECT_ROOT: path.join(request.cwd, "wrong-project"),
    PENNY_SKILLS_DIR: path.join(request.cwd, "wrong-skills"),
    CHECKOUT_ROOT_PROBE: "preserved",
  });
  const extraEnvironment = Object.freeze({ ...validationCall.extraEnvironment });
  const cwd = path.join(projectRoot, "apps", "orchestration");
  const result = createCommandRunner(inheritedEnvironment)({ ...request, cwd, extraEnvironment });

  assert.deepEqual(JSON.parse(result.stdout), {
    cwd,
    PI_OFFLINE: "1",
    PROJECT_ROOT: projectRoot,
    PENNY_SKILLS_DIR: path.join(projectRoot, ".pi", "skills"),
    inherited: "preserved",
  });
  assert.ok(
    isDeepStrictEqual({ ...process.env }, environmentBefore),
    "updater must not mutate process.env"
  );
});

test("candidate failure restores exact project files and does not update global Pi", () => {
  const environmentBefore = { ...process.env };
  const projectRoot = createFixture();
  const snapshot = new Map(
    [
      "package.json",
      "apps/orchestration/package.json",
      "apps/sca-service/package.json",
      "bun.lock",
    ].map((file) => [file, readFileSync(path.join(projectRoot, file))])
  );
  const { runner, state } = createFakeRunner(projectRoot, {
    failCandidateCommand: "typecheck:all",
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
    (error) => {
      assert.equal(error.code, PI_UPDATE_ERROR_CODES.PENNY_TYPE_COMPATIBILITY_FAILED);
      assert.equal(error.phase, "typecheck");
      assert.match(error.message, /bun run typecheck:all/u);
      assert.match(error.message, /global Pi was not updated/u);
      return true;
    }
  );

  assert.equal(state.globalVersion, OLD_VERSION);
  for (const [file, content] of snapshot) {
    assert.deepEqual(readFileSync(path.join(projectRoot, file)), content);
  }
  assert.equal(pinsMatchVersion(readPinnedVersions(projectRoot), OLD_VERSION), true);
  assert.equal(
    state.calls.some((call) => call.command === "pi" && call.args[0] === "update"),
    false
  );
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
  assert.deepEqual(state.calls[rollbackBuildIndex].extraEnvironment, {
    PI_OFFLINE: "1",
    PROJECT_ROOT: projectRoot,
    PENNY_SKILLS_DIR: path.join(projectRoot, ".pi", "skills"),
  });
  assert.ok(
    isDeepStrictEqual({ ...process.env }, environmentBefore),
    "updater must not mutate process.env"
  );
});

for (const scenario of [
  {
    name: "candidate architecture failure",
    options: { failCandidateCommand: "typescript:architecture" },
    code: PI_UPDATE_ERROR_CODES.PENNY_ARCHITECTURE_FAILED,
    phase: "typescript:architecture",
  },
  {
    name: "candidate runtime-test failure",
    options: { failCandidateCommand: "test:pi-compat" },
    code: PI_UPDATE_ERROR_CODES.PENNY_RUNTIME_COMPATIBILITY_FAILED,
    phase: "test:pi-compat",
  },
  {
    name: "candidate extension-load failure",
    options: { failCandidateExtensionLoad: true },
    code: PI_UPDATE_ERROR_CODES.PENNY_EXTENSION_LOAD_FAILED,
    phase: "extension_load_smoke",
  },
]) {
  test(`${scenario.name} restores exact project files and skips global update`, () => {
    const projectRoot = createFixture();
    const snapshot = new Map(
      [
        "package.json",
        "apps/orchestration/package.json",
        "apps/sca-service/package.json",
        "bun.lock",
      ].map((file) => [file, readFileSync(path.join(projectRoot, file))])
    );
    const { runner, state } = createFakeRunner(projectRoot, scenario.options);

    assert.throws(
      () =>
        runPiUpdate({
          projectRoot,
          globalPiExecutable: "pi",
          runCommand: runner,
          log: () => {},
          acquireLock: false,
        }),
      (error) => {
        assert.equal(error.code, scenario.code);
        assert.equal(error.phase, scenario.phase);
        return true;
      }
    );

    for (const [file, content] of snapshot) {
      assert.deepEqual(readFileSync(path.join(projectRoot, file)), content);
    }
    assert.equal(state.globalVersion, OLD_VERSION);
    assert.equal(
      state.calls.some((call) => call.command === "pi" && call.args[0] === "update"),
      false
    );
  });
}

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
  assert.equal(
    readFileSync(path.join(projectRoot, "bun.lock"), "utf8"),
    `lock:${OLD_VERSION}:${OLD_TYPEBOX_VERSION}\n`
  );
  assert.deepEqual(pinnedTypeboxVersions(projectRoot), [
    OLD_TYPEBOX_VERSION,
    OLD_TYPEBOX_VERSION,
    OLD_TYPEBOX_VERSION,
  ]);
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

for (const unavailablePackage of ["@earendil-works/pi-tui", "typebox"]) {
  test(`missing coordinated ${unavailablePackage} release aborts before manifest mutation`, () => {
    const projectRoot = createFixture();
    const originalManifest = readFileSync(path.join(projectRoot, "package.json"));
    const { runner, state } = createFakeRunner(projectRoot, { unavailablePackage });

    assert.throws(
      () =>
        runPiUpdate({
          projectRoot,
          globalPiExecutable: "pi",
          runCommand: runner,
          log: () => {},
          acquireLock: false,
        }),
      (error) => {
        assert.equal(error.code, PI_UPDATE_ERROR_CODES.CANDIDATE_RELEASE_UNAVAILABLE);
        assert.equal(error.phase, "candidate_release_metadata");
        assert.match(formatPiUpdateFailure(error), /package unavailable/u);
        return true;
      }
    );

    assert.equal(state.globalVersion, OLD_VERSION);
    assert.deepEqual(readFileSync(path.join(projectRoot, "package.json")), originalManifest);
  });
}
