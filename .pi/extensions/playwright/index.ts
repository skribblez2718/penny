/**
 * Playwright Extension for Penny
 *
 * Provides browser automation tools as native Pi tools.
 * ~50 tools across 10+ capability domains, all using
 * the `playwright` npm package and typebox schemas.
 *
 * Architecture:
 *   index.ts (entry) → BrowserManager (browser.ts) → tools/ (tool modules)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../lib/logger/logger.js";
import { loadConfig } from "./config.js";
import { BrowserManager } from "./browser.js";
import { registerNavigationTools } from "./tools/navigate.js";
import { registerCoreTools } from "./tools/core.js";
import { registerClickTools } from "./tools/click.js";
import { registerTabsTools } from "./tools/tabs.js";
import { registerEvaluateTools } from "./tools/evaluate.js";
import { registerInputTools } from "./tools/input.js";
import { registerDialogNetworkTools } from "./tools/dialogs.js";
import { registerStorageTools } from "./tools/storage.js";
import { registerPdfTools } from "./tools/pdf.js";
import { registerTestingTools } from "./tools/testing.js";
import { registerRouteFormFileTools } from "./tools/routes.js";
import { registerVisionDevtoolsTools } from "./tools/vision.js";
import { registerProxyTools } from "./tools/proxy.js";
import {
  configuredPrimaryGroups,
  initialPrimaryToolNames,
  isUnmarkedPrimaryRuntime,
  PLAYWRIGHT_LOADER_TOOL,
  registerPlaywrightToolLoader,
} from "./tool-loading.js";
import type { PlaywrightConfig } from "./types.js";

// ============================================================================
// Logger
// ============================================================================

const logger = createLogger("playwright");

// ============================================================================
// State
// ============================================================================

let config: PlaywrightConfig;
let sessionId: string = "";

interface SessionStartContext {
  cwd: string;
  sessionManager?: { getSessionId?: () => string };
}

// ============================================================================
// Tool Registration Framework
//
// Each tool module exports a function that registers its tools on the Pi API.
// The primary runtime narrows the active set after the complete catalog exists.
// ============================================================================

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function playwrightExtension(pi: ExtensionAPI) {
  // Register the complete provider catalog during extension load so Pi can
  // apply a catalog agent's exact YAML allowlist before session_start. Tool
  // registrars retain this holder, so it must keep a stable, mutable identity;
  // loadConfig itself intentionally returns immutable snapshots.
  config = { ...loadConfig(process.cwd()) };
  registerCoreTools(pi, config);
  registerNavigationTools(pi, config);
  registerClickTools(pi, config);
  registerTabsTools(pi, config);
  registerEvaluateTools(pi, config);
  registerInputTools(pi, config);
  registerDialogNetworkTools(pi, config);
  registerStorageTools(pi, config);
  registerPdfTools(pi, config);
  registerTestingTools(pi, config);
  registerRouteFormFileTools(pi, config);
  registerVisionDevtoolsTools(pi, config);
  registerProxyTools(pi, config);
  registerPlaywrightToolLoader(pi);

  // --------------------------------------
  // Session Start
  // --------------------------------------
  pi.on("session_start", async (_event: unknown, ctx: SessionStartContext) => {
    sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
    Object.assign(config, loadConfig(ctx.cwd));

    logger.info("Playwright extension initialized", {
      sessionId,
      headless: config.headless,
      capabilities: {
        vision: config.enableVision,
        devtools: config.enableDevtools,
        network: config.enableNetwork,
        storage: config.enableStorage,
      },
    });

    // The unmarked primary runtime keeps a useful browser core active and loads
    // broader capability groups additively on demand. Spawned workers retain
    // their explicit --tools allowlists and are never broadened by this policy.
    if (
      isUnmarkedPrimaryRuntime(process.env) &&
      pi.getActiveTools().includes(PLAYWRIGHT_LOADER_TOOL)
    ) {
      pi.setActiveTools(
        initialPrimaryToolNames(pi.getActiveTools(), configuredPrimaryGroups(config))
      );
    }
  });

  // --------------------------------------
  // Session Shutdown — browser cleanup
  // --------------------------------------
  pi.on("session_shutdown", async () => {
    logger.info("Playwright extension shutting down", { sessionId });
    await BrowserManager.getBrowser().cleanup();
  });
}
