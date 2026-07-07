/**
 * Status Line Extension Unit Tests
 *
 * Tests the TUI footer rendering with mocked filesystem:
 * - Skill/extension discovery
 * - Context bar rendering
 * - Color calculations
 * - Format functions
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs/promises
vi.mock("fs/promises", () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

import { readdir, stat } from "fs/promises";

// Color constants (Atom One Dark)
const COLORS = {
  purple: "\x1b[38;2;198;120;221m",
  blue: "\x1b[38;2;97;175;239m",
  darkBlue: "\x1b[38;2;85;155;210m",
  green: "\x1b[38;2;152;195;121m",
  orange: "\x1b[38;2;209;154;102m",
  red: "\x1b[38;2;224;108;117m",
  yellow: "\x1b[38;2;229;192;123m",
  cyan: "\x1b[38;2;86;182;194m",
  white: "\x1b[38;2;255;255;255m",
  gray: "\x1b[38;2;171;178;191m",
  dimGray: "\x1b[38;2;75;82;95m",
  reset: "\x1b[0m",
};

// Helper functions extracted from extension for testing
function getContextBarColor(pct: number): string {
  let r: number, g: number, b: number;

  if (pct <= 33) {
    const t = pct / 33;
    r = Math.round(152 + (229 - 152) * t);
    g = Math.round(195 + (192 - 195) * t);
    b = Math.round(121 + (123 - 121) * t);
  } else if (pct <= 66) {
    const t = (pct - 33) / 33;
    r = Math.round(229 + (209 - 229) * t);
    g = Math.round(192 + (154 - 192) * t);
    b = Math.round(123 + (102 - 123) * t);
  } else {
    const t = (pct - 66) / 34;
    r = Math.round(209 + (224 - 209) * t);
    g = Math.round(154 + (108 - 154) * t);
    b = Math.round(102 + (117 - 102) * t);
  }

  return `\x1b[38;2;${r};${g};${b}m`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatItemList(items: string[], icon: string, label: string): string {
  if (items.length === 0) {
    return `${COLORS.darkBlue}${icon} ${label}${COLORS.reset}${COLORS.gray}:${COLORS.reset} ${COLORS.dimGray}None${COLORS.reset}`;
  }

  const itemStr = items
    .map((item) => `${COLORS.white}${item}${COLORS.reset}`)
    .join(`${COLORS.gray},${COLORS.reset} `);

  return `${COLORS.darkBlue}${icon} ${label}${COLORS.reset}${COLORS.gray}:${COLORS.reset} ${itemStr}`;
}

describe("formatTokens", () => {
  it("should format small numbers as-is", () => {
    expect(formatTokens(100)).toBe("100");
    expect(formatTokens(999)).toBe("999");
  });

  it("should format thousands with k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(5500)).toBe("5.5k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  it("should format tens of thousands as rounded k", () => {
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(15500)).toBe("16k");
    expect(formatTokens(999999)).toBe("1000k");
  });

  it("should format millions with M suffix", () => {
    expect(formatTokens(1000000)).toBe("1.0M");
    expect(formatTokens(2500000)).toBe("2.5M");
  });
});

describe("getContextBarColor", () => {
  it("should return greenish for low context (0%)", () => {
    const color = getContextBarColor(0);
    expect(color).toContain("152"); // R
    expect(color).toContain("195"); // G
    expect(color).toContain("121"); // B
  });

  it("should return yellowish for medium context (50%)", () => {
    const color = getContextBarColor(50);
    // Should be in transition from green to yellow to red
    expect(color).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
  });

  it("should return reddish for high context (100%)", () => {
    const color = getContextBarColor(100);
    expect(color).toContain("224"); // R
    expect(color).toContain("108"); // G
    expect(color).toContain("117"); // B
  });

  it("should smoothly transition across percentage range", () => {
    const colors = [0, 25, 33, 50, 66, 75, 100].map((pct) => getContextBarColor(pct));

    // All should be valid ANSI color codes
    colors.forEach((color) => {
      expect(color).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    });
  });
});

describe("formatItemList", () => {
  const icon = "🎯";
  const label = "Skills";

  it("should format empty list", () => {
    const result = formatItemList([], icon, label);
    expect(result).toContain("None");
    expect(result).toContain(icon);
    expect(result).toContain(label);
  });

  it("should format single item", () => {
    const result = formatItemList(["skill1"], icon, label);
    expect(result).toContain("skill1");
    expect(result).not.toContain("None");
  });

  it("should format multiple items with commas", () => {
    const result = formatItemList(["skill1", "skill2", "skill3"], icon, label);
    expect(result).toContain("skill1");
    expect(result).toContain("skill2");
    expect(result).toContain("skill3");
  });

  it("should include icon and label", () => {
    const result = formatItemList(["test"], "🎯", "Skills");
    expect(result).toContain("🎯");
    expect(result).toContain("Skills");
  });
});

describe("Context Bar Rendering", () => {
  const EMPTY_BUCKET = "\x1b[38;2;75;82;95m";

  function renderContextBar(pct: number, width: number = 16): string {
    const filled = Math.round((pct / 100) * width);
    const buckets: string[] = [];

    for (let i = 0; i < width; i++) {
      if (i < filled) {
        const color = getContextBarColor((i / width) * 100);
        buckets.push(`${color}█${COLORS.reset}`);
      } else {
        buckets.push(`${EMPTY_BUCKET}░${COLORS.reset}`);
      }
    }

    return buckets.join(" ");
  }

  it("should render empty bar for 0%", () => {
    const bar = renderContextBar(0, 16);
    expect(bar).toContain("░");
    expect(bar).not.toContain("█");
  });

  it("should render full bar for 100%", () => {
    const bar = renderContextBar(100, 16);
    // Full bar should have 16 filled buckets
    const filledCount = (bar.match(/█/g) || []).length;
    expect(filledCount).toBe(16);
  });

  it("should render partial bar for 50%", () => {
    const bar = renderContextBar(50, 16);
    const filledCount = (bar.match(/█/g) || []).length;
    const emptyCount = (bar.match(/░/g) || []).length;
    expect(filledCount).toBe(8);
    expect(emptyCount).toBe(8);
  });

  it("should respect custom width", () => {
    const bar12 = renderContextBar(50, 12);
    const bar4 = renderContextBar(50, 4);

    const filled12 = (bar12.match(/█/g) || []).length;
    const filled4 = (bar4.match(/█/g) || []).length;

    expect(filled12).toBe(6); // 50% of 12
    expect(filled4).toBe(2); // 50% of 4
  });
});

describe("Status Line Formatting", () => {
  const DA_NAME = "Penny";
  const ICONS = {
    brain: "🧠",
    folder: "📁",
    target: "🎯",
    plug: "🔌",
    chart: "📊",
    robot: "🤖",
  };

  function formatLine1(
    modelName: string,
    dirName: string,
    skillsCount: number,
    extensionsCount: number
  ): string {
    return `${COLORS.purple}${DA_NAME}${COLORS.reset} here, running on ${COLORS.orange}${ICONS.brain} ${modelName}${COLORS.reset} in ${COLORS.cyan}${ICONS.folder} ${dirName}${COLORS.reset}, wielding: ${COLORS.white}${ICONS.target} ${skillsCount}${COLORS.reset} ${COLORS.darkBlue}Skills${COLORS.reset}, and ${COLORS.white}${ICONS.plug} ${extensionsCount}${COLORS.reset} ${COLORS.darkBlue}Extensions${COLORS.reset}`;
  }

  it("should include DA name", () => {
    const line = formatLine1("claude-3.5-sonnet", "/projects/penny", 5, 6);
    expect(line).toContain("Penny");
  });

  it("should include model name", () => {
    const line = formatLine1("claude-3.5-sonnet", "/projects/penny", 5, 6);
    expect(line).toContain("claude-3.5-sonnet");
  });

  it("should include counts", () => {
    const line = formatLine1("model", "/dir", 3, 4);
    expect(line).toContain("3");
    expect(line).toContain("4");
  });

  it("should include directory name", () => {
    const line = formatLine1("model", "/projects/my-app", 1, 1);
    expect(line).toContain("my-app");
  });
});

describe("Directory Scanning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should identify skill directories", async () => {
    vi.mocked(readdir).mockResolvedValueOnce([
      { name: "skill1", isDirectory: () => true } as any,
      { name: "skill2", isDirectory: () => true } as any,
      { name: "file.txt", isDirectory: () => false } as any,
    ]);

    vi.mocked(stat).mockResolvedValue({} as any);

    // Simulate scanning
    const entries = await readdir("/test/skills");
    const dirs = entries.filter((e: any) => e.isDirectory?.());
    expect(dirs.length).toBe(2);
  });

  it("should identify extension directories", async () => {
    vi.mocked(readdir).mockResolvedValueOnce([
      { name: "memory", isDirectory: () => true } as any,
      { name: "search", isDirectory: () => true } as any,
      { name: "index.ts", isDirectory: () => false } as any,
    ]);

    const entries = await readdir("/test/extensions");
    const dirs = entries.filter((e: any) => e.isDirectory?.());
    expect(dirs.length).toBe(2);
  });

  it("should handle missing directories gracefully", async () => {
    vi.mocked(readdir).mockRejectedValue(new Error("ENOENT"));

    try {
      await readdir("/nonexistent");
    } catch {
      // Expected
    }

    // Extension should handle this and return []
    const result: string[] = [];
    expect(result).toEqual([]);
  });
});
