#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKER_PATH = fileURLToPath(import.meta.url);
const PROTOCOL_VERSION = 1;
// One owned source file per worker; never accumulate type-aware projects in the guard.
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const AUDIT_TIMEOUT_MS = 120_000;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function validateFilePath(projectRoot, filePath) {
  if (!path.isAbsolute(filePath))
    throw new Error("suppression audit requires an absolute file path");
  const relative = path.relative(projectRoot, filePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("suppression audit file must be within the configured project root");
  }
}

function validateResponse(value, filePath) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["version", "filePath", "messages"]) ||
    value.version !== PROTOCOL_VERSION ||
    value.filePath !== filePath ||
    !Array.isArray(value.messages)
  ) {
    throw new Error("suppression audit worker returned an invalid or mismatched response");
  }
  for (const message of value.messages) {
    if (
      !isRecord(message) ||
      !exactKeys(message, ["message", "line", "column"]) ||
      typeof message.message !== "string" ||
      !message.message.includes("Unused eslint-disable directive") ||
      !Number.isSafeInteger(message.line) ||
      message.line < 1 ||
      !Number.isSafeInteger(message.column) ||
      message.column < 1
    ) {
      throw new Error("suppression audit worker returned an invalid diagnostic");
    }
  }
  return value.messages;
}

/** Audit one file in a fresh process so typescript-eslint's project caches die on exit. */
export function runEslintSuppressionAudit(projectRoot, filePath, text, options = {}) {
  validateFilePath(projectRoot, filePath);
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error(`suppression audit source exceeds the ${MAX_SOURCE_BYTES}-byte envelope`);
  }
  const timeout = options.timeoutMs ?? AUDIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error("suppression audit timeout must be a positive integer");
  }
  const run = options.run ?? spawnSync;
  const result = run(process.execPath, [WORKER_PATH, filePath], {
    cwd: projectRoot,
    input: text,
    encoding: "utf8",
    maxBuffer: MAX_RESPONSE_BYTES,
    timeout,
    killSignal: "SIGKILL",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    const detail =
      result.error.code === "ETIMEDOUT" ? `timed out after ${timeout} ms` : result.error.message;
    throw new Error(`suppression audit worker ${detail}`, { cause: result.error });
  }
  if (result.signal) {
    throw new Error(`suppression audit worker terminated by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `suppression audit worker exited with status ${String(result.status)}${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ""}`
    );
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("suppression audit worker returned invalid JSON", { cause: error });
  }
  return validateResponse(response, filePath);
}

async function readSource() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_SOURCE_BYTES) {
      throw new Error(`suppression audit source exceeds the ${MAX_SOURCE_BYTES}-byte envelope`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    if (process.argv.length !== 3)
      throw new Error("suppression audit worker requires one file path");
    const filePath = process.argv[2];
    const projectRoot = process.cwd();
    validateFilePath(projectRoot, filePath);
    const text = await readSource();
    // Lazy import: the supervisor never creates a type-aware ESLint parser service.
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({
      cwd: projectRoot,
      errorOnUnmatchedPattern: false,
      overrideConfig: { linterOptions: { reportUnusedDisableDirectives: "error" } },
    });
    const results = await eslint.lintText(text, { filePath, warnIgnored: false });
    if (results.length !== 1 || results[0].filePath !== filePath) {
      throw new Error("ESLint did not return exactly one result for the requested file");
    }
    const fatal = results[0].messages.find((message) => message.fatal);
    if (fatal) throw new Error(`ESLint could not parse the file: ${fatal.message}`);
    const messages = results[0].messages
      .filter(
        (message) =>
          message.ruleId === null && message.message.includes("Unused eslint-disable directive")
      )
      .map(({ message, line, column }) => ({ message, line, column }));
    const response = { version: PROTOCOL_VERSION, filePath, messages };
    validateResponse(response, filePath);
    const output = JSON.stringify(response);
    if (Buffer.byteLength(output, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("suppression audit diagnostics exceed the worker response envelope");
    }
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(
      `suppression audit error: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
