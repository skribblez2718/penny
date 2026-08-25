import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TMP_DIR = join(import.meta.dirname, "__tmp_dotenv_test__");

function readDotEnvFile(path: string): Record<string, string> {
  const envContent = readFileSync(path, "utf8");
  const env: Record<string, string> = {};
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function getEnvVar(key: string, dotenv: Record<string, string>): string | undefined {
  const processValue = process.env[key];
  if (processValue !== undefined && processValue !== "") return processValue;
  return dotenv[key];
}

describe("compaction .env fallback loader", () => {
  const originalProjectRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    if (originalProjectRoot !== undefined) {
      process.env.PROJECT_ROOT = originalProjectRoot;
    } else {
      delete process.env.PROJECT_ROOT;
    }
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("reads simple KEY=VALUE pairs from .env file", () => {
    const envPath = join(TMP_DIR, ".env");
    writeFileSync(
      envPath,
      [
        "PI_OBSERVABILITY_API_KEY=test-key-123",
        "PI_OBSERVABILITY_REST_URL=http://localhost:9999",
      ].join("\n")
    );
    process.env.PROJECT_ROOT = TMP_DIR;

    delete process.env.PI_OBSERVABILITY_API_KEY;
    delete process.env.PI_OBSERVABILITY_REST_URL;

    const env = readDotEnvFile(envPath);

    expect(env["PI_OBSERVABILITY_API_KEY"]).toBe("test-key-123");
    expect(env["PI_OBSERVABILITY_REST_URL"]).toBe("http://localhost:9999");
  });

  it("handles quoted values in .env", () => {
    const envPath = join(TMP_DIR, ".env");
    writeFileSync(envPath, 'QUOTED_KEY="value with spaces"');
    process.env.PROJECT_ROOT = TMP_DIR;

    const env = readDotEnvFile(envPath);

    expect(env["QUOTED_KEY"]).toBe("value with spaces");
  });

  it("skips comments and blank lines", () => {
    const envPath = join(TMP_DIR, ".env");
    writeFileSync(
      envPath,
      ["# This is a comment", "", "  KEY1=val1", "  # Another comment", "KEY2=val2"].join("\n")
    );
    process.env.PROJECT_ROOT = TMP_DIR;

    const env = readDotEnvFile(envPath);

    expect(env).toEqual({ KEY1: "val1", KEY2: "val2" });
  });

  it("prefers process.env over .env file values", () => {
    writeFileSync(join(TMP_DIR, ".env"), "TEST_PREFERS_ENV=from_dotenv");
    process.env.PROJECT_ROOT = TMP_DIR;
    process.env.TEST_PREFERS_ENV = "from_process_env";

    expect(getEnvVar("TEST_PREFERS_ENV", { TEST_PREFERS_ENV: "from_dotenv" })).toBe(
      "from_process_env"
    );

    delete process.env.TEST_PREFERS_ENV;
  });

  it("falls back to .env when process.env is empty string", () => {
    writeFileSync(join(TMP_DIR, ".env"), "TEST_FALLBACK_KEY=from_dotenv");
    process.env.PROJECT_ROOT = TMP_DIR;
    process.env.TEST_FALLBACK_KEY = "";

    expect(getEnvVar("TEST_FALLBACK_KEY", { TEST_FALLBACK_KEY: "from_dotenv" })).toBe(
      "from_dotenv"
    );

    delete process.env.TEST_FALLBACK_KEY;
  });
});
