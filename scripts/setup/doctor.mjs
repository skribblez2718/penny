#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import {
  checkSetupConfiguration,
  memoryStatusUrl,
  resolveRuntimeMemoryToken,
} from "./check-config.mjs";
import { runPreflight } from "./preflight.mjs";

const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

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
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .slice(0, 2_048);
}

function component(componentName, status, detail) {
  return { component: componentName, status, detail: cleanMessage(detail) };
}

function parseLastJson(text) {
  const lines = String(text)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Keep looking for the final machine-readable line.
    }
  }
  return null;
}

function run(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    shell: false,
  });
}

function stateError(completed) {
  const parsed = parseLastJson(completed.stderr) ?? parseLastJson(completed.stdout);
  const message = parsed?.message ?? parsed?.error ?? completed.stderr ?? completed.stdout;
  const detail = cleanMessage(message || "canonical state status failed");
  const actionRequired = /STATE_UNINITIALIZED|PROJECT_UNREGISTERED/iu.test(detail);
  const disposition = actionRequired
    ? `${detail}; use STATE_MODE=fresh only for an empty target, otherwise use penny-state migrate plan/apply/verify/finalize`
    : detail;
  return { status: actionRequired ? "action_required" : "failed", detail: disposition };
}

function stateReadiness({ projectRoot, environment, stateMode, allowFreshInit }) {
  const stateCli = path.join(projectRoot, "apps", "orchestration", "dist", "state-cli.js");
  try {
    accessSync(stateCli, fsConstants.R_OK);
  } catch {
    return {
      status: "failed",
      components: [component("canonical_state", "failed", "orchestration state CLI is not built")],
    };
  }
  const args = [stateCli, "status", `--project-root=${projectRoot}`];
  let completed = run(process.execPath, args, { cwd: projectRoot, env: environment });
  if (completed.status !== 0 && stateMode === "fresh") {
    const initial = stateError(completed);
    if (!allowFreshInit) {
      return {
        status: "action_required",
        components: [
          component(
            "canonical_state",
            "action_required",
            "STATE_MODE=fresh is accepted only by make setup; doctor is read-only"
          ),
        ],
      };
    }
    if (initial.status !== "action_required") {
      return {
        status: initial.status,
        components: [component("canonical_state", initial.status, initial.detail)],
      };
    }
    completed = run(process.execPath, [stateCli, "init", `--project-root=${projectRoot}`], {
      cwd: projectRoot,
      env: environment,
    });
    if (completed.status !== 0) {
      const failed = stateError(completed);
      return {
        status: failed.status,
        components: [component("canonical_state", failed.status, failed.detail)],
      };
    }
    completed = run(process.execPath, args, { cwd: projectRoot, env: environment });
  }
  if (completed.status !== 0) {
    const failed = stateError(completed);
    return {
      status: failed.status,
      components: [component("canonical_state", failed.status, failed.detail)],
    };
  }
  const state = parseLastJson(completed.stdout);
  if (
    state === null ||
    state.schema_version !== 1 ||
    state.action !== "status" ||
    typeof state.project_id !== "string"
  ) {
    return {
      status: "failed",
      components: [
        component("canonical_state", "failed", "state status returned an invalid result"),
      ],
    };
  }
  const disposition = stateMode === "fresh" ? "fresh-explicit" : "existing";
  return {
    status: "ready",
    components: [
      component("canonical_state", "ready", disposition),
      component("checkpoints", "ready", "verified create-never"),
      component("artifacts", "ready", "verified create-never"),
      component("receipt_authority", "ready", "verified create-never"),
    ],
  };
}

async function boundedResponseText(response, maximumBytes) {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("HTTP response exceeds the setup doctor limit");
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function boundedJson(response) {
  return JSON.parse(await boundedResponseText(response, MAX_CHILD_OUTPUT_BYTES));
}

async function authenticatedMemoryStatus(environment) {
  const token = resolveRuntimeMemoryToken(environment);
  const response = await globalThis.fetch(memoryStatusUrl(environment), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await boundedResponseText(response, MAX_CHILD_OUTPUT_BYTES);
  if (!response.ok) throw new Error(`runtime memory status returned HTTP ${response.status}`);
  const parsed = JSON.parse(payload);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("runtime memory status did not return an object");
  }
}

async function memoryReadiness({ projectRoot, environment, memoryMode, memoryHubConfig }) {
  if (memoryMode === "disabled") {
    return {
      status: "ready",
      components: [component("memory", "disabled_explicit", "degraded profile")],
    };
  }
  const python = path.join(projectRoot, ".venv", "bin", "python");
  try {
    accessSync(python, fsConstants.X_OK);
  } catch {
    return {
      status: "failed",
      components: [component("memory", "failed", "core memory Python environment is absent")],
    };
  }
  const completed = run(
    python,
    ["-m", "scripts.system.memory.hub_service", "status", "--config", memoryHubConfig],
    { cwd: projectRoot, env: environment }
  );
  const status = parseLastJson(completed.stdout) ?? parseLastJson(completed.stderr);
  if (
    completed.status !== 0 ||
    status === null ||
    status.supervised !== true ||
    status.running !== true ||
    status.healthy !== true ||
    status.upstream === null ||
    typeof status.upstream !== "object" ||
    Array.isArray(status.upstream) ||
    status.error !== null
  ) {
    const recognizedStatus = status?.schema_version === 1 && status?.operation === "status";
    return {
      status: recognizedStatus ? "action_required" : "failed",
      components: [
        component(
          "memory",
          recognizedStatus ? "action_required" : "failed",
          recognizedStatus
            ? (status.error ?? status.pid_error ?? "supervised authenticated hub is not ready")
            : "hub status command failed"
        ),
      ],
    };
  }
  try {
    await authenticatedMemoryStatus(environment);
  } catch (error) {
    return {
      status: "action_required",
      components: [
        component(
          "memory",
          "action_required",
          error instanceof Error ? error.message : "runtime credential status failed"
        ),
      ],
    };
  }
  const writeMode = environment.PENNY_MEMORY_WRITE_MODE?.trim() || "disabled";
  return {
    status: "ready",
    components: [
      component("memory", "ready", "hub supervised, healthy, authenticated, and read-ready"),
      component(
        "memory_writes",
        writeMode === "enabled" ? "enabled_external" : "disabled_policy",
        writeMode === "enabled"
          ? "enabled outside setup; write qualification was not rerun"
          : "separate write qualification required"
      ),
    ],
  };
}

async function observabilityReadiness({ projectRoot, environment }) {
  if (environment.PI_OBSERVABILITY_ENABLED?.trim() === "false") {
    return {
      status: "ready",
      components: [component("observability", "disabled_explicit", "configured policy")],
    };
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "penny-observability-doctor-"));
  const stateRoot = path.join(scratch, "state");
  let server;
  try {
    const orchestrationUrl = pathToFileURL(
      path.join(projectRoot, "apps", "orchestration", "dist", "index.js")
    ).href;
    const observabilityUrl = pathToFileURL(
      path.join(projectRoot, "apps", "observability", "dist", "server.js")
    ).href;
    const orchestration = await import(orchestrationUrl);
    const observation = await import(observabilityUrl);
    const scratchEnvironment = { ...environment, PENNY_STATE_ROOT: stateRoot };
    const resolved = orchestration.initializePennyState(projectRoot, { env: scratchEnvironment });
    const apiKey = "penny-observability-doctor";
    const created = observation.createObservabilityServer({
      databasePath: resolved.state.observability.database,
      host: "127.0.0.1",
      port: 0,
      apiKey,
      maxRows: 10,
    });
    server = created.server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("ephemeral bind failed");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await globalThis.fetch(`${base}/health`, {
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const healthPayload = await boundedJson(health);
    if (
      health.status !== 200 ||
      healthPayload?.ok !== true ||
      healthPayload?.service !== "penny-observability" ||
      healthPayload?.schema_version !== 1
    ) {
      throw new Error("observability health identity check failed");
    }
    const unauthorized = await globalThis.fetch(`${base}/logs?limit=1`, {
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (unauthorized.status !== 401) throw new Error("observability auth refusal check failed");
    await boundedResponseText(unauthorized, MAX_CHILD_OUTPUT_BYTES);
    const authorized = await globalThis.fetch(`${base}/logs?limit=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const authorizedPayload = await boundedJson(authorized);
    if (authorized.status !== 200 || !Array.isArray(authorizedPayload?.logs)) {
      throw new Error("observability authenticated query check failed");
    }
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
    return {
      status: "ready",
      components: [
        component("observability", "ready", "built service startable; health and auth checked"),
      ],
    };
  } catch (error) {
    if (server) await new Promise((resolve) => server.close(resolve));
    return {
      status: "failed",
      components: [
        component(
          "observability",
          "failed",
          error instanceof Error ? error.message : "observability smoke failed"
        ),
      ],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function extensionReadiness({ projectRoot, memoryMode }) {
  const agentDir = mkdtempSync(path.join(tmpdir(), "penny-extension-doctor-"));
  try {
    const extensionRoot = realpathSync(path.join(projectRoot, ".pi", "extensions"));
    const expected = readdirSync(extensionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(extensionRoot, entry.name, "index.ts"))
      .filter((candidate) => {
        try {
          accessSync(candidate, fsConstants.R_OK);
          return true;
        } catch {
          return false;
        }
      })
      .map((candidate) => realpathSync(candidate));
    const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
    const loader = new DefaultResourceLoader({
      cwd: projectRoot,
      agentDir,
      additionalExtensionPaths: expected,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    const actual = new Map(
      loaded.extensions.map((extension) => [realpathSync(extension.resolvedPath), extension])
    );
    const projectErrors = loaded.errors.filter((error) => {
      if (typeof error.path !== "string") return false;
      try {
        return realpathSync(error.path).startsWith(`${extensionRoot}${path.sep}`);
      } catch {
        return path.resolve(error.path).startsWith(`${extensionRoot}${path.sep}`);
      }
    });
    const missing = expected.filter((candidate) => !actual.has(candidate));
    const memoryPath = realpathSync(path.join(extensionRoot, "memory", "index.ts"));
    const memory = actual.get(memoryPath);
    if (
      missing.length > 0 ||
      projectErrors.length > 0 ||
      !memory ||
      (memoryMode === "hub" && memory.tools.size === 0)
    ) {
      throw new Error(
        `extension load failed (${missing.length} missing, ${projectErrors.length} errors, memory tools ${memory?.tools.size ?? 0})`
      );
    }
    return {
      status: "ready",
      components: [
        component(
          "extensions",
          "ready",
          `${expected.length} project extensions loaded provider-free`
        ),
      ],
    };
  } catch (error) {
    return {
      status: "failed",
      components: [
        component(
          "extensions",
          "failed",
          error instanceof Error ? error.message : "extension load failed"
        ),
      ],
    };
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function overallStatus(results) {
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.some((result) => result.status === "action_required")) return "action_required";
  return "ready";
}

function publicConfigResult(result) {
  const safe = { ...result };
  delete safe.environment;
  return safe;
}

async function main() {
  const projectRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const memoryMode = process.env.PENNY_SETUP_MEMORY_MODE || "hub";
  const stateMode = process.env.PENNY_SETUP_STATE_MODE || "existing";
  const memoryHubConfig = process.env.PENNY_SETUP_MEMORY_HUB_CONFIG || "";
  const selected = process.env.PENNY_SETUP_DOCTOR_COMPONENT || "all";
  const allowFreshInit = process.env.PENNY_SETUP_ALLOW_FRESH_INIT === "1";
  if (!new Set(["all", "state", "memory"]).has(selected)) {
    process.stderr.write("PENNY_SETUP_DOCTOR_COMPONENT must be all, state, or memory\n");
    process.exitCode = 2;
    return;
  }

  const config = checkSetupConfiguration({
    projectRoot,
    memoryMode,
    stateMode,
    memoryHubConfig,
    requireMemory: selected !== "state",
  });
  const results = [];
  if (config.status !== "ready") {
    const output = {
      schema_version: 1,
      operation: "penny_setup_doctor",
      status: config.status,
      profile: memoryMode === "disabled" ? "degraded-no-memory" : "core",
      config: publicConfigResult(config),
      components: [],
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 1;
    return;
  }

  const environment = config.environment;
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string" && !process.env[key]) process.env[key] = value;
  }

  const preflightProfile =
    selected === "state"
      ? "node"
      : selected === "memory"
        ? "python"
        : memoryMode === "hub"
          ? "core"
          : "javascript";
  const preflight = runPreflight({ projectRoot, profile: preflightProfile });
  if (preflight.status === "ready") {
    results.push({
      status: "ready",
      components: preflight.checks.map((check) =>
        component(check.component, "ready", check.version)
      ),
    });
  } else {
    results.push({
      status: "failed",
      components: [
        component("preflight", "failed", preflight.error?.message ?? "preflight failed"),
      ],
    });
  }

  if ((selected === "all" || selected === "memory") && overallStatus(results) === "ready") {
    results.push(await memoryReadiness({ projectRoot, environment, memoryMode, memoryHubConfig }));
  }
  if ((selected === "all" || selected === "state") && overallStatus(results) === "ready") {
    results.push(stateReadiness({ projectRoot, environment, stateMode, allowFreshInit }));
  }
  if (selected === "all" && overallStatus(results) === "ready") {
    results.push(await observabilityReadiness({ projectRoot, environment }));
  }
  if (selected === "all" && overallStatus(results) === "ready") {
    results.push(await extensionReadiness({ projectRoot, memoryMode }));
  }

  const status = overallStatus(results);
  const components = results.flatMap((result) => result.components);
  for (const item of components) {
    process.stdout.write(`${item.component.padEnd(20)} ${item.status.padEnd(18)} ${item.detail}\n`);
  }
  process.stdout.write(
    `${"browser".padEnd(20)} ${"not_requested".padEnd(18)} optional; not counted\n`
  );
  const output = {
    schema_version: 1,
    operation: "penny_setup_doctor",
    status,
    profile: memoryMode === "disabled" ? "degraded-no-memory" : "core",
    config: publicConfigResult(config),
    components,
    browser: { status: "not_requested", required: false },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (status !== "ready") process.exitCode = 1;
}

void main();
