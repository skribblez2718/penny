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
import type { PlaywrightConfig, ProxyConfig, CapabilityMap } from "./types.js";

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
  if (process.env[key] !== undefined) return process.env[key]!;
  if (dotEnv[key] !== undefined) return dotEnv[key]!;
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
    // When PLAYWRIGHT_PROXY_SERVER is unset, config.proxy is undefined and
    // the browser launches without a proxy (existing behavior).
    //
    // Auto-derivation: if PLAYWRIGHT_PROXY_SERVER is unset but CAIDO_URL is
    // set, derive the proxy from Caido's URL. This makes Caido integration
    // "just work" when both extensions are configured. The explicit
    // PLAYWRIGHT_PROXY_* env vars always take precedence.
    proxy: (() => {
      const explicitServer = getEnvVar("PLAYWRIGHT_PROXY_SERVER", dotEnv, "").trim();
      const server = explicitServer || getEnvVar("CAIDO_URL", dotEnv, "").trim();
      if (!server) return undefined;
      const username = getEnvVar("PLAYWRIGHT_PROXY_USERNAME", dotEnv, "").trim();
      const password = getEnvVar("PLAYWRIGHT_PROXY_PASSWORD", dotEnv, "").trim();
      const bypass = getEnvVar("PLAYWRIGHT_PROXY_BYPASS", dotEnv, "").trim();
      const proxy: ProxyConfig = { server };
      if (username) proxy.username = username;
      if (password) proxy.password = password;
      if (bypass) proxy.bypass = bypass;
      logger.info("Playwright proxy configured", {
        source: explicitServer ? "PLAYWRIGHT_PROXY_SERVER" : "CAIDO_URL (auto-derived)",
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

// ============================================================================
// Capability Map
//
// Maps each capability domain to the list of tool names it gates.
// Used by index.ts to conditionally register tools.
// ============================================================================

export const CAPABILITY_MAP: CapabilityMap = {
  core: [
    "playwright_navigate",
    "playwright_snapshot",
    "playwright_click",
    "playwright_type",
    "playwright_evaluate",
    "playwright_close",
    "playwright_resize",
    "playwright_screenshot",
    "playwright_drag",
    "playwright_hover",
    "playwright_select_option",
    "playwright_fill_form",
    "playwright_file_upload",
    "playwright_drop",
    "playwright_handle_dialog",
    "playwright_wait_for",
    "playwright_console_messages",
    "playwright_network_requests",
    "playwright_network_request",
  ],
  "core-navigation": [
    "playwright_navigate_back",
    "playwright_navigate_forward",
    "playwright_reload",
    "playwright_get_current_url",
    "playwright_get_title",
  ],
  "core-tabs": [
    "playwright_new_page",
    "playwright_close_page",
    "playwright_switch_tab",
    "playwright_list_tabs",
  ],
  "core-input": [
    "playwright_press_key",
    "playwright_press_sequentially",
    "playwright_keydown",
    "playwright_keyup",
    "playwright_check",
    "playwright_uncheck",
    "playwright_fill",
    "playwright_select_option",
    "playwright_upload_file",
  ],
  network: [
    "playwright_intercept",
    "playwright_route",
    "playwright_route_list",
    "playwright_unroute",
    "playwright_network_state_set",
    "playwright_get_proxy_info",
    "playwright_check_proxy_reachable",
  ],
  storage: [
    "playwright_local_storage",
    "playwright_session_storage",
    "playwright_cookies",
    "playwright_storage_state",
    "playwright_set_storage_state",
  ],
  pdf: ["playwright_pdf"],
  testing: [
    "playwright_verify_element_visible",
    "playwright_verify_text_visible",
    "playwright_verify_list_visible",
    "playwright_verify_value",
    "playwright_generate_locator",
  ],
  vision: [
    "playwright_mouse_move_xy",
    "playwright_mouse_click_xy",
    "playwright_mouse_drag_xy",
    "playwright_mouse_down",
    "playwright_mouse_up",
    "playwright_mouse_wheel",
    "playwright_accessibility_snapshot",
  ],
  devtools: [
    "playwright_console",
    "playwright_network_log",
    "playwright_performance",
    "playwright_highlight",
    "playwright_hide_highlight",
    "playwright_start_tracing",
    "playwright_stop_tracing",
    "playwright_start_video",
    "playwright_stop_video",
    "playwright_video_chapter",
  ],
};

/**
 * Check if a capability domain is enabled according to config.
 */
export function isCapabilityEnabled(domain: string, config: PlaywrightConfig): boolean {
  switch (domain) {
    case "core":
    case "core-navigation":
    case "core-tabs":
    case "core-input":
      return true; // Always enabled
    case "network":
      return config.enableNetwork;
    case "storage":
      return config.enableStorage;
    case "pdf":
      return true; // Lightweight, always on
    case "testing":
      return true; // Always on
    case "vision":
      return config.enableVision;
    case "devtools":
      return config.enableDevtools;
    default:
      return false;
  }
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
