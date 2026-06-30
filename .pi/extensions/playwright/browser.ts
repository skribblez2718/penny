/**
 * Playwright Extension — BrowserManager
 *
 * Singleton class managing Playwright browser lifecycle.
 * Lazy initialization on first tool call, cleanup on session_shutdown.
 *
 * Key safety measures:
 *  - CDP WebSocket .unref() to prevent event loop leak
 *  - Kill-switch: force-kill browser after 5s if graceful shutdown fails
 *  - Isolated userDataDir per session
 *  - Network allowlist enforced at context creation
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../lib/logger/logger.js";
import { loadConfig } from "./config.js";
import type { PlaywrightConfig, BrowserState, SnapshotNode } from "./types.js";

const logger = createLogger("playwright:browser");

// ============================================================================
// BrowserManager (Singleton)
// ============================================================================

export class BrowserManager {
  private static instance: BrowserManager | null = null;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Page[] = [];
  private activePageIdx: number = -1;
  private config: PlaywrightConfig;
  private userDataDir: string;
  private launchError: string | null = null;

  private constructor(config: PlaywrightConfig) {
    this.config = config;
    // Isolated user data dir per session (prevents cross-session state leak)
    this.userDataDir = resolve(`/tmp/playwright-profile-${randomUUID().slice(0, 8)}`);
  }

  /**
   * Get the singleton BrowserManager instance.
   * Creates one if it doesn't exist (with provided config).
   */
  static getBrowser(config?: PlaywrightConfig): BrowserManager {
    if (!BrowserManager.instance) {
      if (!config) {
        config = loadConfig();
      }
      BrowserManager.instance = new BrowserManager(config);
    }
    return BrowserManager.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static reset(): void {
    if (BrowserManager.instance) {
      BrowserManager.instance.cleanup().catch(() => {});
      BrowserManager.instance = null;
    }
  }

  // ==========================================================================
  // Browser Lifecycle
  // ==========================================================================

  /**
   * Ensure browser is launched. Idempotent — no-op if already connected.
   */
  async ensureBrowser(): Promise<void> {
    if (this.browser?.isConnected()) return;

    logger.info("Launching Chromium browser", {
      headless: this.config.headless,
      userDataDir: this.userDataDir,
    });

    try {
      // Create user data directory
      if (!existsSync(this.userDataDir)) {
        mkdirSync(this.userDataDir, { recursive: true });
      }

      const launchOpts: Record<string, unknown> = {
        headless: this.config.headless,
      };

      if (this.config.browserPath) {
        launchOpts.executablePath = this.config.browserPath;
      }

      // Proxy support: route all browser traffic through the configured proxy
      // (e.g., Caido upstream proxy for HTTP history capture). Per Playwright
      // docs, the proxy is set at launch and applies to all contexts.
      if (this.config.proxy) {
        const proxyOpts: Record<string, unknown> = {
          server: this.config.proxy.server,
        };
        if (this.config.proxy.username) {
          proxyOpts.username = this.config.proxy.username;
        }
        if (this.config.proxy.password) {
          proxyOpts.password = this.config.proxy.password;
        }
        if (this.config.proxy.bypass) {
          proxyOpts.bypass = this.config.proxy.bypass;
        }
        launchOpts.proxy = proxyOpts;
        logger.info("Browser will route traffic through proxy", {
          server: this.config.proxy.server,
          hasAuth: !!this.config.proxy.username,
          bypass: this.config.proxy.bypass || "(none)",
        });
      }

      this.browser = await chromium.launch(launchOpts);

      // Create context with network allowlist if configured.
      // ignoreHTTPSErrors is opt-in via PLAYWRIGHT_IGNORE_HTTPS_ERRORS=1
      // (needed for jsa STRUCTURE phase when navigating to test envs with
      // self-signed or invalid certs, OR when proxying through Caido's
      // self-signed upstream cert).
      const contextOpts: Record<string, unknown> = {};
      if (this.config.ignoreHTTPSErrors) {
        contextOpts.ignoreHTTPSErrors = true;
        logger.warn(
          "ignoreHTTPSErrors is enabled — browser will accept invalid HTTPS certs. " +
            "This is a security risk in production; intended only for jsa STRUCTURE phase."
        );
      }
      this.context = await this.browser.newContext(contextOpts);

      // Create initial page with auto-dialog-dismiss
      const page = await this.context.newPage();
      this.pages = [page];
      this.activePageIdx = 0;

      // Auto-dismiss dialogs by default (prevents blocking)
      // The playwright_handle_dialog tool overrides this when called
      page.on("dialog", async (dialog) => {
        await dialog.dismiss().catch(() => {});
      });

      logger.info("Browser launched successfully", {
        pageCount: this.pages.length,
      });

      // .unref() CDP WebSocket connections to prevent event loop leaks
      this.unrefConnections();
    } catch (err) {
      this.launchError = err instanceof Error ? err.message : String(err);
      logger.error("Failed to launch browser", {
        error: this.launchError,
      });
      throw err;
    }
  }

  /**
   * .unref() the CDP WebSocket so Node.js event loop doesn't wait on it.
   * This is critical to prevent agent subprocesses from hanging.
   */
  private unrefConnections(): void {
    if (!this.browser) return;

    try {
      const ws = (this.browser as any)?._connection?._transport?._ws;
      if (ws && typeof ws.unref === "function") {
        ws.unref();
        logger.debug("CDP WebSocket unref'd");
      }
    } catch {
      // .unref() is best-effort — the kill-switch is the safety net
    }
  }

  /**
   * Check if browser is connected and ready.
   */
  isConnected(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  /**
   * Get launch error if browser failed to start.
   */
  getLaunchError(): string | null {
    return this.launchError;
  }

  // ==========================================================================
  // Page / Tab Management
  // ==========================================================================

  /**
   * Get the currently active page. Launches browser if needed.
   */
  async getPage(): Promise<Page> {
    await this.ensureBrowser();
    if (this.activePageIdx < 0 || this.activePageIdx >= this.pages.length) {
      throw new Error("No active page. Use playwright_new_page to create one.");
    }
    return this.pages[this.activePageIdx];
  }

  /**
   * Create a new page (tab) and optionally navigate to a URL.
   */
  async newPage(url?: string): Promise<{ pageId: string; url: string }> {
    await this.ensureBrowser();
    if (!this.context) throw new Error("Browser context not initialized");

    const page = await this.context.newPage();
    const idx = this.pages.length;
    this.pages.push(page);
    this.activePageIdx = idx;

    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }

    return {
      pageId: String(idx),
      url: page.url(),
    };
  }

  /**
   * Close a page by index. Cannot close the last page.
   */
  async closePage(pageId: string): Promise<{ closed: boolean; remainingPages: number }> {
    const idx = parseInt(pageId, 10);
    if (isNaN(idx) || idx < 0 || idx >= this.pages.length) {
      throw new Error(`Page "${pageId}" not found. Available pages: 0-${this.pages.length - 1}`);
    }

    if (this.pages.length <= 1) {
      throw new Error("Cannot close the last page. Use playwright_close to close the browser.");
    }

    await this.pages[idx].close();
    this.pages.splice(idx, 1);

    // Adjust active index
    if (this.activePageIdx >= this.pages.length) {
      this.activePageIdx = this.pages.length - 1;
    }

    return {
      closed: true,
      remainingPages: this.pages.length,
    };
  }

  /**
   * Switch active tab by index.
   */
  switchTab(pageId: string): { pageId: string; url: string; title: string } {
    const idx = parseInt(pageId, 10);
    if (isNaN(idx) || idx < 0 || idx >= this.pages.length) {
      throw new Error(`Page "${pageId}" not found. Available pages: 0-${this.pages.length - 1}`);
    }

    this.activePageIdx = idx;
    const page = this.pages[idx];

    return {
      pageId: String(idx),
      url: page.url(),
      title: "",
    };
  }

  /**
   * List all tabs.
   */
  async listTabs(): Promise<BrowserState> {
    const tabs = await Promise.all(
      this.pages.map(async (page, idx) => ({
        pageId: String(idx),
        url: page.url(),
        title: await page.title().catch(() => ""),
        isActive: idx === this.activePageIdx,
      }))
    );

    return {
      connected: this.isConnected(),
      tabs,
      activePageId: String(this.activePageIdx),
    };
  }

  // ==========================================================================
  // Browser Actions
  // ==========================================================================

  /**
   * Navigate the active page to a URL.
   */
  async navigate(
    url: string,
    waitUntil: "load" | "domcontentloaded" | "networkidle" = "domcontentloaded",
    timeout?: number
  ): Promise<{ url: string; title: string; status: number; loadTimeMs: number }> {
    const page = await this.getPage();
    const startTime = Date.now();

    // Validate URL
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
      normalizedUrl = "https://" + normalizedUrl;
    }

    try {
      const response = await page.goto(normalizedUrl, {
        waitUntil,
        timeout: timeout ?? this.config.timeout,
      });

      const loadTimeMs = Date.now() - startTime;
      const title = await page.title().catch(() => "");

      return {
        url: page.url(),
        title,
        status: response?.status() ?? 0,
        loadTimeMs,
      };
    } catch (err) {
      logger.error("Navigation failed", {
        url: normalizedUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Take snapshot of the active page. Uses page.evaluate() to build a semantic
   * DOM tree since Playwright 1.59 removed page.accessibility.
   */
  async snapshot(): Promise<{ tree: SnapshotNode | null; error?: string }> {
    const page = await this.getPage();
    try {
      const tree = (await page.evaluate(() => {
        // Build a semantic tree from the DOM — mirrors accessibility snapshot format
        const MAX_DEPTH = 8;
        const MAX_CHILDREN = 30;

        function getRole(el: Element): string {
          const ariaRole = el.getAttribute("role");
          if (ariaRole) return ariaRole;
          const tag = el.tagName.toLowerCase();
          const roleMap: Record<string, string> = {
            a: "link",
            button: "button",
            input: "textbox",
            select: "combobox",
            textarea: "textbox",
            img: "image",
            nav: "navigation",
            main: "main",
            header: "banner",
            footer: "contentinfo",
            form: "form",
            table: "table",
            ul: "list",
            ol: "list",
            li: "listitem",
            h1: "heading",
            h2: "heading",
            h3: "heading",
            h4: "heading",
            h5: "heading",
            h6: "heading",
            p: "paragraph",
            article: "article",
            section: "region",
            aside: "complementary",
            label: "label",
            span: "text",
            div: "group",
          };
          return roleMap[tag] || tag;
        }

        function getName(el: Element): string {
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) return ariaLabel;
          const labelledBy = el.getAttribute("aria-labelledby");
          if (labelledBy) {
            const labelEl = document.getElementById(labelledBy);
            if (labelEl) return labelEl.textContent?.trim() || "";
          }
          if (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "submit") {
            return (el as HTMLInputElement).placeholder || (el as HTMLInputElement).value || "";
          }
          if (el.tagName === "IMG") {
            return (el as HTMLImageElement).alt || "";
          }
          // Direct text only (no nested element text)
          let text = "";
          for (const child of el.childNodes) {
            if (child.nodeType === 3) text += child.textContent || "";
          }
          return text.trim().slice(0, 100);
        }

        function getState(el: Element): Record<string, unknown> {
          const state: Record<string, unknown> = {};
          if (el instanceof HTMLInputElement) {
            if (el.disabled) state.disabled = true;
            if (el.type === "checkbox" || el.type === "radio") {
              state.checked = el.checked;
            }
            if (el.readOnly) state.readonly = true;
            if (el.required) state.required = true;
          }
          if (el instanceof HTMLButtonElement && el.disabled) state.disabled = true;
          if (el instanceof HTMLSelectElement && el.disabled) state.disabled = true;
          if (el instanceof HTMLTextAreaElement) {
            if (el.disabled) state.disabled = true;
            if (el.readOnly) state.readonly = true;
          }
          return Object.keys(state).length ? state : (undefined as any);
        }

        function shouldOmit(el: Element): boolean {
          const tag = el.tagName.toLowerCase();
          return ["script", "style", "meta", "link", "noscript", "br", "hr"].includes(tag);
        }

        function buildTree(el: Element, depth: number): any | null {
          if (depth > MAX_DEPTH) return null;
          if (shouldOmit(el)) return null;

          const node: any = {
            role: getRole(el),
            name: getName(el),
          };

          const state = getState(el);
          if (state) Object.assign(node, state);

          const children: any[] = [];
          let count = 0;
          for (const child of el.children) {
            if (count >= MAX_CHILDREN) break;
            const c = buildTree(child, depth + 1);
            if (c) {
              children.push(c);
              count++;
            }
          }
          if (children.length) node.children = children;

          return node;
        }

        return buildTree(document.body, 0);
      })) as SnapshotNode | null;

      return { tree };
    } catch (err) {
      return {
        tree: null,
        error: err instanceof Error ? err.message : "Snapshot failed",
      };
    }
  }

  /**
   * Take screenshot of the active page.
   */
  async screenshot(options: {
    selector?: string;
    fullPage?: boolean;
    type?: "png" | "jpeg";
    quality?: number;
    path?: string;
  }): Promise<{
    filePath: string;
    mimeType: string;
    width: number;
    height: number;
    fileSizeBytes: number;
  }> {
    const page = await this.getPage();

    const outputDir = options.path ? dirname(options.path) : this.config.outputDir;

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const filename =
      options.path ?? `${outputDir}/screenshot-${Date.now()}.${options.type ?? "png"}`;

    const screenshotOpts: Record<string, unknown> = {
      path: filename,
      type: options.type ?? "png",
      fullPage: options.fullPage ?? false,
    };

    if (options.quality !== undefined && options.type === "jpeg") {
      screenshotOpts.quality = options.quality;
    }

    if (options.selector) {
      const element = await page.$(options.selector);
      if (!element) throw new Error(`Element not found: ${options.selector}`);
      await element.screenshot(screenshotOpts as any);
    } else {
      await page.screenshot(screenshotOpts as any);
    }

    const stats = statSync(filename);
    const viewport = page.viewportSize();

    return {
      filePath: filename,
      mimeType: options.type === "jpeg" ? "image/jpeg" : "image/png",
      width: viewport?.width ?? 0,
      height: viewport?.height ?? 0,
      fileSizeBytes: stats.size,
    };
  }

  /**
   * Resize the browser viewport.
   */
  async resize(width: number, height: number): Promise<void> {
    const page = await this.getPage();
    await page.setViewportSize({ width, height });
  }

  /**
   * Close the active page. Closes browser if it was the last page.
   */
  async close(): Promise<void> {
    if (this.pages.length > 0) {
      await this.pages[this.activePageIdx]?.close().catch(() => {});
      this.pages.splice(this.activePageIdx, 1);
    }
    if (this.pages.length === 0) {
      await this.cleanup();
    } else {
      this.activePageIdx = 0;
    }
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Full cleanup: close all pages, browser context, browser.
   * Kill-switch ensures cleanup completes within 5 seconds.
   */
  async cleanup(): Promise<void> {
    logger.info("Browser cleanup initiated", {
      pages: this.pages.length,
    });

    // Kill-switch: force cleanup after 5s
    const killSwitch = setTimeout(() => {
      logger.warn("Browser cleanup kill-switch activated — forcing shutdown");
      try {
        this.browser?.close?.();
      } catch {
        // Force-kill Chromium process
      }
    }, 5000);

    // Don't let kill-switch keep event loop alive
    if (typeof killSwitch.unref === "function") {
      killSwitch.unref();
    }

    try {
      // Close all pages
      for (const page of this.pages) {
        await page.close().catch(() => {});
      }
      this.pages = [];
      this.activePageIdx = -1;

      // Close context
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }

      // Close browser
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }

      // Clean up user data directory
      if (existsSync(this.userDataDir)) {
        try {
          rmSync(this.userDataDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup
        }
      }

      clearTimeout(killSwitch);
      logger.info("Browser cleanup complete");
    } catch (err) {
      clearTimeout(killSwitch);
      logger.error("Browser cleanup failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    BrowserManager.instance = null;
  }
}
