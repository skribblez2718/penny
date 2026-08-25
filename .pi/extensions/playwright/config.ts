/**
 * Playwright Extension — Configuration
 *
 * Parses environment variables with .env fallback (Pi doesn't load .env natively).
 * Returns a frozen PlaywrightConfig object used by BrowserManager and all tools.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../../lib/logger/logger.js";

const logger = createLogger("playwright:config");
import type { PlaywrightConfig, ProxyConfig } from "./types.js";

// ============================================================================
// .env Fallback Parser
//
// Pi doesn't load .env files, but the Python server does — this creates an
// asymmetry. We replicate the observability extension's pattern: read .env
// manually and fall back to process.env.
// ============================================================================

function findEnvFile(cwd: string): string | null {
  const paths = [join(cwd, ".env"), join(homedir(), ".pi", ".env")];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function readDotEnv(cwd: string): Record<string, string> {
  const envPath = findEnvFile(cwd);
  if (!envPath) return {};
  try {
    const content = readFileSync(envPath, "utf-8");
    return parseEnvContent(content);
  } catch {
    return {};
  }
}

/**
 * Get env var: process.env first, then .env fallback, then default.
 */
function getEnvVar(key: string, dotEnv: Record<string, string>, defaultValue: string): string {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined) return fromProcess;
  const fromDotEnv = dotEnv[key];
  if (fromDotEnv !== undefined) return fromDotEnv;
  return defaultValue;
}

function getEnvBool(key: string, dotEnv: Record<string, string>, defaultValue: boolean): boolean {
  const val = getEnvVar(key, dotEnv, defaultValue ? "true" : "false");
  return val.toLowerCase() === "true" || val === "1";
}

function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ============================================================================
// Config Factory
// ============================================================================

let cachedConfig: PlaywrightConfig | null = null;

export function loadConfig(cwd?: string): PlaywrightConfig {
  const dir = cwd ?? process.cwd();
  const dotEnv = readDotEnv(dir);

  const config: PlaywrightConfig = Object.freeze({
    headless: getEnvBool("PLAYWRIGHT_HEADLESS", dotEnv, false),
    timeout: parseInt(getEnvVar("PLAYWRIGHT_TIMEOUT", dotEnv, "30000"), 10),
    browserPath: getEnvVar("PLAYWRIGHT_BROWSER_PATH", dotEnv, "") || undefined,
    networkAllowlist: parseCommaList(getEnvVar("PLAYWRIGHT_NETWORK_ALLOWLIST", dotEnv, "")),
    downloadDir: resolve(getEnvVar("PLAYWRIGHT_DOWNLOAD_DIR", dotEnv, "/tmp/playwright-downloads")),
    outputDir: resolve(getEnvVar("PLAYWRIGHT_OUTPUT_DIR", dotEnv, "/tmp/playwright-output")),
    enableVision: getEnvBool("PLAYWRIGHT_ENABLE_VISION", dotEnv, false),
    enableDevtools: getEnvBool("PLAYWRIGHT_ENABLE_DEVTOOLS", dotEnv, false),
    enableNetwork: getEnvBool("PLAYWRIGHT_ENABLE_NETWORK", dotEnv, false),
    enableStorage: getEnvBool("PLAYWRIGHT_ENABLE_STORAGE", dotEnv, false),
    allowUnsafe: getEnvBool("PLAYWRIGHT_ALLOW_UNSAFE", dotEnv, false),
    // Ignore HTTPS errors (self-signed certs, expired certs, etc.).
    // Explicit opt-in only — defaults to false for production safety.
    // Set PLAYWRIGHT_IGNORE_HTTPS_ERRORS=1 for security testing.
    ignoreHTTPSErrors: getEnvBool("PLAYWRIGHT_IGNORE_HTTPS_ERRORS", dotEnv, false),
    // Default is DIRECT (no proxy). Configure PLAYWRIGHT_PROXY_SERVER explicitly,
    // or toggle at runtime with playwright_set_proxy (action: "custom" | "off").
    proxy: (() => {
      const server = getEnvVar("PLAYWRIGHT_PROXY_SERVER", dotEnv, "").trim();
      if (!server) return undefined;
      const username = getEnvVar("PLAYWRIGHT_PROXY_USERNAME", dotEnv, "").trim();
      const password = getEnvVar("PLAYWRIGHT_PROXY_PASSWORD", dotEnv, "").trim();
      const bypass = getEnvVar("PLAYWRIGHT_PROXY_BYPASS", dotEnv, "").trim();
      const proxy: ProxyConfig = { server };
      if (username) proxy.username = username;
      if (password) proxy.password = password;
      if (bypass) proxy.bypass = bypass;
      logger.info("Playwright proxy configured", {
        source: "PLAYWRIGHT_PROXY_SERVER",
        server,
        hasAuth: !!username,
        bypass: bypass || "(none)",
      });
      return Object.freeze(proxy);
    })(),
  });

  cachedConfig = config;
  return config;
}

export function getConfig(): PlaywrightConfig {
  if (!cachedConfig) return loadConfig();
  return cachedConfig;
}

/**
 * Check if a specific tool is unsafe and requires explicit opt-in.
 */
export function isUnsafeTool(toolName: string): boolean {
  return toolName === "playwright_run_code_unsafe";
}

export function isUnsafeEnabled(config: PlaywrightConfig): boolean {
  return config.allowUnsafe;
}
