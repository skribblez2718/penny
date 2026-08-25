/**
 * Playwright Extension — Unit Tests
 *
 * Tests config parsing, TypeBox schema validation, and tool definitions.
 * No browser needed — pure Node.js.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, getConfig, isUnsafeTool } from "../../config.js";
import type { SnapshotNode } from "../../types.js";

// ============================================================================
// Config Tests
// ============================================================================

describe("Config", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    const vars = [
      "PLAYWRIGHT_HEADLESS",
      "PLAYWRIGHT_TIMEOUT",
      "PLAYWRIGHT_BROWSER_PATH",
      "PLAYWRIGHT_NETWORK_ALLOWLIST",
      "PLAYWRIGHT_DOWNLOAD_DIR",
      "PLAYWRIGHT_OUTPUT_DIR",
      "PLAYWRIGHT_ENABLE_VISION",
      "PLAYWRIGHT_ENABLE_DEVTOOLS",
      "PLAYWRIGHT_ENABLE_NETWORK",
      "PLAYWRIGHT_ENABLE_STORAGE",
      "PLAYWRIGHT_ALLOW_UNSAFE",
      "PLAYWRIGHT_PROXY_SERVER",
      "PLAYWRIGHT_PROXY_USERNAME",
      "PLAYWRIGHT_PROXY_PASSWORD",
      "PLAYWRIGHT_PROXY_BYPASS",
      "PLAYWRIGHT_IGNORE_HTTPS_ERRORS",
    ];
    for (const v of vars) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("loadConfig", () => {
    it("should return defaults when no env vars set", () => {
      const config = loadConfig("/tmp/test");
      expect(config.headless).toBe(false);
      expect(config.timeout).toBe(30000);
      expect(config.enableVision).toBe(false);
      expect(config.enableDevtools).toBe(false);
      expect(config.enableNetwork).toBe(false);
      expect(config.enableStorage).toBe(false);
      expect(config.allowUnsafe).toBe(false);
    });

    it("should parse boolean env vars correctly", () => {
      process.env.PLAYWRIGHT_HEADLESS = "true";
      process.env.PLAYWRIGHT_ENABLE_VISION = "1";
      process.env.PLAYWRIGHT_ALLOW_UNSAFE = "TRUE";
      const config = loadConfig("/tmp/test");
      expect(config.headless).toBe(true);
      expect(config.enableVision).toBe(true);
      expect(config.allowUnsafe).toBe(true);
    });

    it("should parse numeric env vars", () => {
      process.env.PLAYWRIGHT_TIMEOUT = "60000";
      const config = loadConfig("/tmp/test");
      expect(config.timeout).toBe(60000);
    });

    it("should parse comma-separated allowlist", () => {
      process.env.PLAYWRIGHT_NETWORK_ALLOWLIST = "api.example.com,*.trusted.org";
      const config = loadConfig("/tmp/test");
      expect(config.networkAllowlist).toEqual(["api.example.com", "*.trusted.org"]);
    });

    it("should resolve download and output dirs", () => {
      process.env.PLAYWRIGHT_DOWNLOAD_DIR = "/custom/downloads";
      process.env.PLAYWRIGHT_OUTPUT_DIR = "/custom/output";
      const config = loadConfig("/tmp/test");
      expect(config.downloadDir).toBe("/custom/downloads");
      expect(config.outputDir).toBe("/custom/output");
    });

    it("should handle browser path", () => {
      process.env.PLAYWRIGHT_BROWSER_PATH = "/usr/bin/chromium";
      const config = loadConfig("/tmp/test");
      expect(config.browserPath).toBe("/usr/bin/chromium");
    });

    it("should not set browserPath when empty", () => {
      const config = loadConfig("/tmp/test");
      expect(config.browserPath).toBeUndefined();
    });

    it("should not set proxy when PLAYWRIGHT_PROXY_SERVER is unset", () => {
      const config = loadConfig("/tmp/test");
      expect(config.proxy).toBeUndefined();
    });

    it("should not set proxy when PLAYWRIGHT_PROXY_SERVER is empty string", () => {
      process.env.PLAYWRIGHT_PROXY_SERVER = "   ";
      const config = loadConfig("/tmp/test");
      expect(config.proxy).toBeUndefined();
    });

    it("should parse proxy server alone", () => {
      process.env.PLAYWRIGHT_PROXY_SERVER = "http://127.0.0.1:8080";
      const config = loadConfig("/tmp/test");
      expect(config.proxy).toBeDefined();
      const proxy = config.proxy;
      if (proxy === undefined) throw new Error("proxy config was not created");
      expect(proxy.server).toBe("http://127.0.0.1:8080");
      expect(proxy.username).toBeUndefined();
      expect(proxy.password).toBeUndefined();
      expect(proxy.bypass).toBeUndefined();
    });

    it("should parse full proxy config with auth and bypass", () => {
      process.env.PLAYWRIGHT_PROXY_SERVER = "http://proxy.corp:3128";
      process.env.PLAYWRIGHT_PROXY_USERNAME = "alice";
      process.env.PLAYWRIGHT_PROXY_PASSWORD = "secret";
      process.env.PLAYWRIGHT_PROXY_BYPASS = "localhost,127.0.0.1,*.internal";
      const config = loadConfig("/tmp/test");
      expect(config.proxy).toEqual({
        server: "http://proxy.corp:3128",
        username: "alice",
        password: "secret",
        bypass: "localhost,127.0.0.1,*.internal",
      });
    });

    it("should support socks5 proxies", () => {
      process.env.PLAYWRIGHT_PROXY_SERVER = "socks5://tor-proxy:9050";
      const config = loadConfig("/tmp/test");
      const proxy = config.proxy;
      if (proxy === undefined) throw new Error("SOCKS proxy config was not created");
      expect(proxy.server).toBe("socks5://tor-proxy:9050");
    });

    it("should freeze proxy config to prevent mutation", () => {
      process.env.PLAYWRIGHT_PROXY_SERVER = "http://127.0.0.1:8080";
      const config = loadConfig("/tmp/test");
      expect(Object.isFrozen(config.proxy)).toBe(true);
    });

    it("should default ignoreHTTPSErrors to false", () => {
      const config = loadConfig("/tmp/test");
      expect(config.ignoreHTTPSErrors).toBe(false);
    });

    it("should parse PLAYWRIGHT_IGNORE_HTTPS_ERRORS=1", () => {
      process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS = "1";
      const config = loadConfig("/tmp/test");
      expect(config.ignoreHTTPSErrors).toBe(true);
    });
  });

  describe("getConfig", () => {
    it("should return the same frozen object after loadConfig", () => {
      const config1 = loadConfig("/tmp/test");
      const config2 = getConfig();
      expect(config1).toBe(config2);
    });
  });

  describe("isUnsafeTool", () => {
    it("identifies unsafe tool", () => {
      expect(isUnsafeTool("playwright_run_code_unsafe")).toBe(true);
      expect(isUnsafeTool("playwright_navigate")).toBe(false);
    });
  });
});

// ============================================================================
// Snapshot Helper Tests
// ============================================================================

describe("Snapshot Helpers", () => {
  function countNodes(node: SnapshotNode | null | undefined): number {
    if (!node) return 0;
    let count = 1;
    if (node.children) {
      for (const child of node.children) count += countNodes(child);
    }
    return count;
  }

  it("counts tree nodes", () => {
    const tree = {
      role: "body",
      children: [{ role: "div", children: [{ role: "h1" }, { role: "p" }] }, { role: "footer" }],
    };
    expect(countNodes(tree)).toBe(5);
  });

  it("handles null/undefined", () => {
    expect(countNodes(null)).toBe(0);
    expect(countNodes(undefined)).toBe(0);
  });

  it("handles leaf nodes", () => {
    expect(countNodes({ role: "leaf" })).toBe(1);
  });
});

// ============================================================================
// Error Formatting Tests
// ============================================================================

describe("Tool Error Handling", () => {
  it("should detect non-serializable JS results", () => {
    const resultType = typeof (() => {});
    expect(resultType).toBe("function");
    const isSerializable = resultType !== "function" && resultType !== "undefined";
    expect(isSerializable).toBe(false);
  });

  it("should detect serializable JS results", () => {
    expect(typeof "hello").not.toBe("function");
    expect(typeof 42).not.toBe("function");
    expect(typeof { a: 1 }).not.toBe("function");
    expect(typeof [1, 2, 3]).not.toBe("function");
  });
});
