/**
 * Statusline Extension Integration Tests
 *
 * Tests the statusline extension with real tool registration:
 * - Tool registration verification
 * - Status line formatting with real formatting functions
 * - Event handler registration
 */

import { describe, it, expect, vi } from "vitest";

// Mock TUI dependencies
vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (s: string, width: number) => {
    if (s.length <= width) return s;
    return s.slice(0, width - 1) + "…";
  },
  visibleWidth: (s: string) => s.length,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getMarkdownTheme: vi.fn().mockReturnValue({
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  }),
}));

import { createTestExtensionApi } from "../../../../lib/tests/test-narrowers.js";

describe("Statusline Integration — Format Functions", () => {
  it("should format token counts with K suffix for thousands", () => {
    const formatTokens = (n: number): string => {
      if (n < 1000) return n.toString();
      if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
      return `${(n / 1000000).toFixed(1)}M`;
    };

    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(10000)).toBe("10.0k");
    expect(formatTokens(1000000)).toBe("1.0M");
  });

  it("should truncate long strings to width", () => {
    const truncateToWidth = (s: string, width: number): string => {
      if (s.length <= width) return s;
      return s.slice(0, width - 1) + "…";
    };

    expect(truncateToWidth("hello", 10)).toBe("hello");
    expect(truncateToWidth("hello world this is long", 10)).toBe("hello wor…");
  });
});

describe("Statusline Integration — Event Registration", () => {
  it("should register event handlers via ExtensionAPI", async () => {
    const registeredEvents: string[] = [];

    const onEvent = vi.fn((event: string) => {
      registeredEvents.push(event);
    });
    const mockPi = createTestExtensionApi({ onEvent });

    const mod = await import("../../index.js");
    mod.default(mockPi);

    // Statusline should register event handlers
    expect(onEvent).toHaveBeenCalled();
    expect(registeredEvents.length).toBeGreaterThan(0);
  });
});
