/**
 * Playwright Extension for Penny
 *
 * Provides browser automation tools as native Pi tools.
 * ~50 tools across 10+ capability domains, all using
 * the `playwright` npm package and @sinclair/typebox schemas.
 *
 * Architecture:
 *   index.ts (entry) → BrowserManager (browser.ts) → tools/ (tool modules)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

// ============================================================================
// Tool Registration Framework
//
// Each tool module exports a function that registers its tools on the pi API.
// The index.ts calls these conditionally based on capability toggles.
// ============================================================================

// Tool modules are imported lazily in their respective phases.
// For now, this is a skeleton — modules will be added as phases progress.

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function playwrightExtension(pi: ExtensionAPI) {
  // --------------------------------------
  // Session Start
  // --------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
    config = loadConfig(ctx.cwd);

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

    // --------------------------------------
    // Register tools based on capability gates
    // --------------------------------------
    // Core tools: always available (snapshot, screenshot, close, resize)
    registerCoreTools(pi, config);

    // Navigation tools: always available (navigate, goBack, goForward, reload)
    registerNavigationTools(pi, config);

    // Click tools: click, double-click, hover, drag
    registerClickTools(pi, config);

    // Tab management: newPage, closePage, switchTab, listTabs
    registerTabsTools(pi, config);

    // Evaluate & wait: evaluate, waitFor
    registerEvaluateTools(pi, config);

    // Input tools: type, fill, selectOption, check, uncheck, pressKey
    registerInputTools(pi, config);

    // Dialogs, console & network
    registerDialogNetworkTools(pi, config);

    // Storage: localStorage, sessionStorage, cookies
    registerStorageTools(pi, config);

    // PDF export + run_code_unsafe
    registerPdfTools(pi, config);

    // Testing assertions
    registerTestingTools(pi, config);

    // Route intercept, form fill, file upload/drop
    registerRouteFormFileTools(pi, config);

    // Vision (mouse control) + DevTools (highlight, tracing)
    registerVisionDevtoolsTools(pi, config);

    // Proxy info & reachability (always available — just reports config state)
    registerProxyTools(pi, config);
  });

  // --------------------------------------
  // Session Shutdown — browser cleanup
  // --------------------------------------
  pi.on("session_shutdown", async () => {
    logger.info("Playwright extension shutting down", { sessionId });
    await BrowserManager.getBrowser().cleanup();
  });
}
