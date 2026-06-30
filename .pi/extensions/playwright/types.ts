/**
 * Playwright Extension — Shared Types
 *
 * Core TypeBox schemas, interfaces, and types shared across all tool modules.
 */

import { Type, type Static } from "@sinclair/typebox";

// ============================================================================
// Browser State
// ============================================================================

export interface BrowserTab {
  pageId: string;
  url: string;
  title: string;
  isActive: boolean;
}

export interface BrowserState {
  connected: boolean;
  tabs: BrowserTab[];
  activePageId: string | null;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * HTTP/SOCKS proxy configuration for Playwright browser traffic.
 * Use this to route browser requests through a proxy like Caido for capture.
 *
 * Set via env vars:
 *   PLAYWRIGHT_PROXY_SERVER=http://127.0.0.1:8080
 *   PLAYWRIGHT_PROXY_USERNAME=user
 *   PLAYWRIGHT_PROXY_PASSWORD=pass
 *   PLAYWRIGHT_PROXY_BYPASS=localhost,127.0.0.1
 */
export interface ProxyConfig {
  /** Proxy server URL. HTTP and SOCKS proxies are supported. */
  server: string;
  /** Optional username for HTTP proxy auth. */
  username?: string;
  /** Optional password for HTTP proxy auth. */
  password?: string;
  /** Comma-separated domains to bypass the proxy. */
  bypass?: string;
}

export interface PlaywrightConfig {
  headless: boolean;
  timeout: number;
  browserPath?: string;
  networkAllowlist: string[];
  downloadDir: string;
  outputDir: string;
  enableVision: boolean;
  enableDevtools: boolean;
  enableNetwork: boolean;
  enableStorage: boolean;
  allowUnsafe: boolean;
  /** Optional proxy for all browser traffic (e.g., route through Caido). */
  proxy?: ProxyConfig;
  /**
   * Ignore HTTPS certificate errors. Useful for security testing where
   * targets may have self-signed/expired certs. Defaults to false for
   * production safety. Set to true via PLAYWRIGHT_IGNORE_HTTPS_ERRORS=1
   * for jsa STRUCTURE phase (which often navigates to test environments
   * with non-public certs). Cannot be enabled by accident — explicit opt-in.
   */
  ignoreHTTPSErrors: boolean;
}

// ============================================================================
// Common Parameter Schemas (reusable across tools)
// ============================================================================

export const UrlSchema = Type.String({
  description: "URL to navigate to (e.g., https://example.com/page)",
});

export const SelectorSchema = Type.String({
  description: "CSS selector, text selector, or ARIA locator for the target element",
});

export const TimeoutSchema = Type.Optional(
  Type.Number({
    description: "Maximum time to wait in milliseconds",
    minimum: 0,
    maximum: 120000,
  })
);

export const WaitUntilSchema = Type.Optional(
  Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")])
);

export const CoordinatesSchema = Type.Object({
  x: Type.Number({ description: "X coordinate in pixels" }),
  y: Type.Number({ description: "Y coordinate in pixels" }),
});

export const ViewportSizeSchema = Type.Object({
  width: Type.Number({ description: "Width in pixels", minimum: 1 }),
  height: Type.Number({ description: "Height in pixels", minimum: 1 }),
});

// ============================================================================
// Snapshot Types
// ============================================================================

export interface SnapshotNode {
  role: string;
  name?: string;
  children?: SnapshotNode[];
  value?: string | number;
  description?: string;
  keyshortcuts?: string;
  roledescription?: string;
  valuetext?: string;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  modal?: boolean;
  multiline?: boolean;
  multiselectable?: boolean;
  readonly?: boolean;
  required?: boolean;
  selected?: boolean;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  level?: number;
  valuemin?: number;
  valuemax?: number;
  autocomplete?: string;
  haspopup?: string;
  invalid?: string;
  orientation?: string;
}

// ============================================================================
// Tool Result Types
// ============================================================================

export interface ToolResult<T = unknown> {
  content: Array<{ type: "text"; text: string }>;
  details?: T;
  isError?: boolean;
}

export interface NavigateResult {
  url: string;
  title: string;
  status: number;
  loadTimeMs: number;
}

export interface ScreenshotResult {
  filePath: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  fileSizeBytes: number;
}

export interface ClickResult {
  clicked: boolean;
  selector: string;
  elementTag: string;
  elementText?: string;
}

export interface TextContentResult {
  text: string;
  selector: string;
  length: number;
  truncated: boolean;
}

export interface EvaluateResult {
  result: unknown;
  type: string;
  serializable: boolean;
}

export interface TabResult {
  pageId: string;
  url: string;
  title: string;
}

export interface TabListResult {
  tabs: TabResult[];
  activePageId: string;
}

// ============================================================================
// Capability Types
// ============================================================================

export type CapabilityDomain =
  | "core"
  | "core-navigation"
  | "core-tabs"
  | "core-input"
  | "network"
  | "pdf"
  | "storage"
  | "testing"
  | "vision"
  | "devtools";

export interface CapabilityMap {
  [domain: string]: string[]; // domain -> list of tool names
}

// ============================================================================
// Tool Registration Helper
// ============================================================================

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: ReturnType<typeof Type.Object>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: unknown
  ) => Promise<ToolResult>;
}
