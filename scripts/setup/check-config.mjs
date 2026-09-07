#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { constants as fsConstants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const MAX_ENV_BYTES = 64 * 1024;
const MAX_HUB_CONFIG_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 16 * 1024;
const MEMORY_MODES = new Set(["hub", "disabled"]);
const STATE_MODES = new Set(["existing", "fresh"]);
const REQUIRED_HUB_ENV = [
  "PENNY_MEMORY_MCP_ENDPOINT",
  "PENNY_MEMORY_PALACE_ID",
  "PENNY_MEMORY_DATA_ROOT_ID",
  "PENNY_MEMORY_PRINCIPAL_ID",
  "PENNY_MEMORY_TRUST_MODE",
  "PENNY_MEMORY_OWNER_ID",
  "PENNY_MEMORY_BACKUP_POLICY_REF",
  "PENNY_MEMORY_MIGRATION_POLICY_REF",
  "PENNY_MEMORY_RETENTION_POLICY_REF",
  "PENNY_MEMORY_UNINSTALL_DISPOSITION",
];

function isControlCharacter(character) {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
}

function boundedMessage(value) {
  return Array.from(String(value))
    .map((character) => (isControlCharacter(character) ? " " : character))
    .join("")
    .slice(0, 1024);
}

function validateMemoryToken(token, label) {
  if (
    Buffer.byteLength(token, "utf8") < 32 ||
    Buffer.byteLength(token, "utf8") > MAX_SECRET_BYTES ||
    Array.from(token).some(isControlCharacter)
  ) {
    throw new Error(`${label} must be a control-free secret of 32-${MAX_SECRET_BYTES} UTF-8 bytes`);
  }
}

function setupFailure(status, code, message, extra = {}) {
  return {
    schema_version: 1,
    operation: "setup_config_check",
    status,
    memory_mode: extra.memory_mode ?? null,
    state_mode: extra.state_mode ?? null,
    env_file: extra.env_file ?? "unknown",
    error: { code, message: boundedMessage(message) },
  };
}

function readBoundedRegularFile(filePath, maximumBytes, label, { ownerOnly = false } = {}) {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = openSync(filePath, fsConstants.O_RDONLY | noFollow);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`${label} must be a regular file`);
    if (stats.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    if (ownerOnly && typeof process.geteuid === "function") {
      if (stats.uid !== process.geteuid())
        throw new Error(`${label} must be owned by the current user`);
      if ((stats.mode & 0o077) !== 0)
        throw new Error(`${label} must not grant group or other access`);
    }
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") throw new Error(`${label} is absent`);
      if (error.code === "ELOOP") throw new Error(`${label} must not be a symbolic link`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function parseEnvFile(content, projectRoot) {
  const values = {};
  for (const [index, sourceLine] of content.split(/\r?\n/u).entries()) {
    const line = sourceLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match === null) throw new Error(`.env line ${index + 1} is not KEY=value`);
    const key = match[1];
    if (Object.hasOwn(values, key)) throw new Error(`.env line ${index + 1} duplicates ${key}`);
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value
      .replaceAll("${HOME}", homedir())
      .replaceAll("${PWD}", projectRoot)
      .replaceAll("${PROJECT_ROOT}", projectRoot);
    values[key] = value;
  }
  return values;
}

export function loadRuntimeEnvironment(projectRoot, sourceEnvironment = process.env) {
  const envPath = path.join(projectRoot, ".env");
  let fileValues = {};
  let envFile = "absent";
  try {
    const content = readBoundedRegularFile(envPath, MAX_ENV_BYTES, ".env");
    fileValues = parseEnvFile(content, projectRoot);
    envFile = "present";
  } catch (error) {
    if (
      (error && typeof error === "object" && "code" in error && error.code === "ENOENT") ||
      (error instanceof Error && error.message === ".env is absent")
    ) {
      envFile = "absent";
    } else {
      throw error;
    }
  }
  const environment = { ...fileValues };
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  environment.PROJECT_ROOT ??= projectRoot;
  return { environment, envFile };
}

function requiredString(record, name) {
  const value = record[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required in hub mode`);
  }
  return value.trim();
}

function loopbackHttpUrl(raw, label, allowedPath) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid loopback HTTP URL`);
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    !["127.0.0.1", "localhost", "[::1]"].includes(
      parsed.hostname === "::1" ? "[::1]" : parsed.hostname
    ) ||
    parsed.port.length === 0 ||
    !allowedPath(parsed.pathname)
  ) {
    throw new Error(`${label} must be a loopback HTTP URL with an explicit port`);
  }
  return parsed;
}

function loadHubDocument(configPath) {
  if (!path.isAbsolute(configPath)) throw new Error("MEMORY_HUB_CONFIG must be an absolute path");
  const content = readBoundedRegularFile(configPath, MAX_HUB_CONFIG_BYTES, "memory hub config", {
    ownerOnly: true,
  });
  const parsed = JSON.parse(content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("memory hub config must contain a JSON object");
  }
  return parsed;
}

function validateMemoryConfiguration(environment, configPath) {
  for (const name of REQUIRED_HUB_ENV) requiredString(environment, name);
  if (requiredString(environment, "PENNY_MEMORY_UNINSTALL_DISPOSITION") !== "preserve") {
    throw new Error("PENNY_MEMORY_UNINSTALL_DISPOSITION must be preserve");
  }
  const trustMode = requiredString(environment, "PENNY_MEMORY_TRUST_MODE");
  if (trustMode === "isolated") {
    requiredString(environment, "PENNY_MEMORY_ISOLATION_BOUNDARY_ID");
  } else if (trustMode === "shared-trust-domain") {
    requiredString(environment, "PENNY_MEMORY_TRUST_DOMAIN_ID");
    if (requiredString(environment, "PENNY_MEMORY_WHOLE_PALACE_TRUST_ACK") !== "whole-palace") {
      throw new Error("shared-trust-domain requires whole-palace acknowledgement");
    }
  } else {
    throw new Error("PENNY_MEMORY_TRUST_MODE must be isolated or shared-trust-domain");
  }

  const tokenFile = environment.PENNY_MEMORY_MCP_TOKEN_FILE?.trim();
  const tokenEnvironment = environment.PENNY_MEMORY_MCP_TOKEN_ENV?.trim();
  if ((!tokenFile && !tokenEnvironment) || (tokenFile && tokenEnvironment)) {
    throw new Error(
      "exactly one of PENNY_MEMORY_MCP_TOKEN_FILE or PENNY_MEMORY_MCP_TOKEN_ENV is required"
    );
  }
  if (tokenFile && !path.isAbsolute(tokenFile)) {
    throw new Error("PENNY_MEMORY_MCP_TOKEN_FILE must be an absolute path");
  }
  if (tokenFile) {
    const token = readBoundedRegularFile(tokenFile, MAX_SECRET_BYTES, "memory token file", {
      ownerOnly: true,
    }).trim();
    validateMemoryToken(token, "memory token file");
  }
  if (tokenEnvironment && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnvironment)) {
    throw new Error("PENNY_MEMORY_MCP_TOKEN_ENV must name a valid environment variable");
  }
  if (tokenEnvironment) {
    const token = environment[tokenEnvironment]?.trim();
    if (!token) {
      throw new Error(`the environment variable named by PENNY_MEMORY_MCP_TOKEN_ENV is absent`);
    }
    validateMemoryToken(token, "memory token environment value");
  }

  const hub = loadHubDocument(configPath);
  if (hub.schema_version !== 1) throw new Error("memory hub config schema_version must be 1");
  const hubEndpoint = loopbackHttpUrl(
    requiredString(hub, "endpoint"),
    "memory hub config endpoint",
    (pathname) => pathname === "/"
  );
  const runtimeEndpoint = loopbackHttpUrl(
    requiredString(environment, "PENNY_MEMORY_MCP_ENDPOINT"),
    "PENNY_MEMORY_MCP_ENDPOINT",
    (pathname) => pathname === "/mcp" || pathname === "/mcp/"
  );
  if (runtimeEndpoint.origin !== hubEndpoint.origin) {
    throw new Error("runtime memory endpoint does not match the supplied hub config endpoint");
  }
  if (requiredString(environment, "PENNY_MEMORY_PALACE_ID") !== requiredString(hub, "palace_id")) {
    throw new Error("runtime palace ID does not match the supplied hub config palace ID");
  }
}

export function resolveRuntimeMemoryToken(environment) {
  const tokenFile = environment.PENNY_MEMORY_MCP_TOKEN_FILE?.trim();
  if (tokenFile) {
    if (!path.isAbsolute(tokenFile)) throw new Error("memory token file must be absolute");
    const token = readBoundedRegularFile(tokenFile, MAX_SECRET_BYTES, "memory token file", {
      ownerOnly: true,
    }).trim();
    validateMemoryToken(token, "memory token file");
    return token;
  }
  const tokenEnvironment = environment.PENNY_MEMORY_MCP_TOKEN_ENV?.trim();
  if (!tokenEnvironment || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnvironment)) {
    throw new Error("memory token environment reference is invalid");
  }
  const token = environment[tokenEnvironment]?.trim();
  if (!token) throw new Error("memory token environment value is absent");
  validateMemoryToken(token, "memory token environment value");
  return token;
}

export function memoryStatusUrl(environment) {
  const endpoint = loopbackHttpUrl(
    requiredString(environment, "PENNY_MEMORY_MCP_ENDPOINT"),
    "PENNY_MEMORY_MCP_ENDPOINT",
    (pathname) => pathname === "/mcp" || pathname === "/mcp/"
  );
  return `${endpoint.origin}/statusz`;
}

export function checkSetupConfiguration({
  projectRoot,
  memoryMode,
  stateMode,
  memoryHubConfig,
  sourceEnvironment = process.env,
  requireMemory = true,
}) {
  if (!path.isAbsolute(projectRoot)) {
    return setupFailure("failed", "PROJECT_ROOT_INVALID", "project root must be absolute");
  }
  let loaded;
  try {
    loaded = loadRuntimeEnvironment(projectRoot, sourceEnvironment);
  } catch (error) {
    return setupFailure("failed", "ENV_INVALID", error instanceof Error ? error.message : error);
  }
  const context = { memory_mode: memoryMode, state_mode: stateMode, env_file: loaded.envFile };
  if (!STATE_MODES.has(stateMode)) {
    return setupFailure(
      "failed",
      "STATE_MODE_INVALID",
      "STATE_MODE must be existing or fresh",
      context
    );
  }
  if (!MEMORY_MODES.has(memoryMode)) {
    return setupFailure(
      "failed",
      "MEMORY_MODE_INVALID",
      "MEMORY_MODE must be hub or disabled",
      context
    );
  }
  if (!requireMemory) {
    return {
      schema_version: 1,
      operation: "setup_config_check",
      status: "ready",
      memory_mode: memoryMode,
      state_mode: stateMode,
      env_file: loaded.envFile,
      degraded: false,
      environment: loaded.environment,
    };
  }
  const runtimeMode = loaded.environment.PENNY_MEMORY_MODE?.trim() || "hub";
  if (runtimeMode !== memoryMode) {
    return setupFailure(
      "action_required",
      "MEMORY_MODE_MISMATCH",
      "setup memory mode must match PENNY_MEMORY_MODE in .env or the exported environment",
      context
    );
  }
  if (memoryMode === "disabled") {
    return {
      schema_version: 1,
      operation: "setup_config_check",
      status: "ready",
      memory_mode: memoryMode,
      state_mode: stateMode,
      env_file: loaded.envFile,
      degraded: true,
      environment: loaded.environment,
    };
  }
  if (!memoryHubConfig) {
    return setupFailure(
      "action_required",
      "MEMORY_HUB_CONFIG_REQUIRED",
      "hub memory is enabled by default; supply MEMORY_HUB_CONFIG as an absolute caller-owned path",
      context
    );
  }
  try {
    validateMemoryConfiguration(loaded.environment, memoryHubConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required|absent|ENOENT|no such file/iu.test(message)
      ? "action_required"
      : "failed";
    return setupFailure(status, "MEMORY_CONFIG_INVALID", message, context);
  }
  return {
    schema_version: 1,
    operation: "setup_config_check",
    status: "ready",
    memory_mode: memoryMode,
    state_mode: stateMode,
    env_file: loaded.envFile,
    degraded: false,
    environment: loaded.environment,
  };
}

function publicResult(result) {
  const safe = { ...result };
  delete safe.environment;
  return safe;
}

function main() {
  const projectRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const result = checkSetupConfiguration({
    projectRoot,
    memoryMode: process.env.PENNY_SETUP_MEMORY_MODE || "hub",
    stateMode: process.env.PENNY_SETUP_STATE_MODE || "existing",
    memoryHubConfig: process.env.PENNY_SETUP_MEMORY_HUB_CONFIG || "",
  });
  process.stdout.write(`${JSON.stringify(publicResult(result))}\n`);
  if (result.status !== "ready") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
