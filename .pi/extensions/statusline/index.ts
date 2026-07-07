/**
 * Pi Status Line Extension
 * Adapted from CAII statusline-command.sh for Pi coding agent
 *
 * Displays: Model, directory, skills, extensions, prompts, context bar
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

// ============================================================================
// ANSI-AWARE TEXT WRAPPING
// ============================================================================

// Matches SGR color escape sequences (ESC[…m) so they can be stripped when
// measuring visible width. The \x1b control char is intentional here.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleWidth(str: string): number {
  return str.replace(ANSI_RE, "").length;
}
import { readdir, stat } from "fs/promises";
import { join } from "path";

// ============================================================================
// CONFIGURATION
// ============================================================================

const DA_NAME = process.env.DA_NAME || "Penny";

// ============================================================================
// ICONS
// ============================================================================

const ICONS = {
  brain: "🧠",
  folder: "📁",
  target: "🎯",
  plug: "🔌",
  chart: "📊",
  robot: "🤖",
  prompt: "📝",
};

// ============================================================================
// SKILLS & EXTENSIONS DISCOVERY
// ============================================================================

async function scanDirectory(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const names: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subPath = join(dir, entry.name);
        try {
          const indexTs = join(subPath, "index.ts");
          const indexJs = join(subPath, "index.js");
          const skillMd = join(subPath, "SKILL.md");

          // Check for index.ts, index.js, or SKILL.md (uppercase - case-sensitive on Linux)
          const hasIndexTs = await stat(indexTs).catch(() => null);
          const hasIndexJs = await stat(indexJs).catch(() => null);
          const hasSkillMd = await stat(skillMd).catch(() => null);

          if (hasIndexTs || hasIndexJs || hasSkillMd) {
            names.push(entry.name);
          } else {
            const files = await readdir(subPath).catch(() => []);
            const hasTs = files.some((f) => f.endsWith(".ts"));
            if (hasTs) {
              names.push(entry.name);
            }
          }
        } catch {
          // Skip invalid entries
        }
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        names.push(entry.name.replace(/\.ts$/, ""));
      }
    }

    return names;
  } catch {
    return [];
  }
}

async function getSkills(): Promise<string[]> {
  const cwd = process.cwd();

  const skillDirs = [join(cwd, ".pi/skills")];

  const skillSets = await Promise.all(skillDirs.map(scanDirectory));
  const allSkills = [...new Set(skillSets.flat())];
  return allSkills.sort();
}

async function getAgents(): Promise<string[]> {
  const cwd = process.cwd();
  const agentsDir = join(cwd, ".pi/agents");

  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.replace(/\.md$/, ""));
    return names.sort();
  } catch {
    return [];
  }
}

async function getExtensions(): Promise<string[]> {
  const cwd = process.cwd();

  const extDirs = [join(cwd, ".pi/extensions")];

  const extSets = await Promise.all(extDirs.map(scanDirectory));
  const allExts = [...new Set(extSets.flat())];
  return allExts.sort();
}

async function getPrompts(): Promise<string[]> {
  const cwd = process.cwd();
  const promptsDir = join(cwd, ".pi/prompts");

  try {
    const entries = await readdir(promptsDir, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.replace(/\.md$/, ""));
    return names.sort();
  } catch {
    return [];
  }
}

// ============================================================================
// CONTEXT BAR RENDERING
// ============================================================================

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

const EMPTY_BUCKET = "\x1b[38;2;75;82;95m";

function renderContextBar(pct: number, width: number = 16): string {
  const filled = Math.round((pct / 100) * width);
  const buckets: string[] = [];

  for (let i = 0; i < width; i++) {
    if (i < filled) {
      const color = getContextBarColor((i / width) * 100);
      buckets.push(`${color}█\x1b[0m`);
    } else {
      buckets.push(`${EMPTY_BUCKET}░\x1b[0m`);
    }
  }

  return buckets.join(" ");
}

function getPctColor(pct: number): string {
  if (pct <= 33) return "\x1b[38;2;152;195;121m";
  if (pct <= 66) return "\x1b[38;2;229;192;123m";
  return "\x1b[38;2;224;108;117m";
}

// ============================================================================
// THEME COLORS (Atom One Dark)
// ============================================================================

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

// ============================================================================
// STATUS LINE FORMATTING
// ============================================================================

function formatLine1(
  modelName: string,
  dirName: string,
  skillsCount: number,
  extensionsCount: number,
  promptsCount: number
): string {
  return `${COLORS.purple}${DA_NAME}${COLORS.reset} here, running on ${COLORS.orange}${ICONS.brain} ${modelName}${COLORS.reset} in ${COLORS.cyan}${ICONS.folder} ${dirName}${COLORS.reset}, wielding: ${COLORS.white}${ICONS.target} ${skillsCount}${COLORS.reset} ${COLORS.darkBlue}Skills${COLORS.reset}, ${COLORS.white}${ICONS.plug} ${extensionsCount}${COLORS.reset} ${COLORS.darkBlue}Extensions${COLORS.reset}, and ${COLORS.white}${ICONS.prompt} ${promptsCount}${COLORS.reset} ${COLORS.darkBlue}Prompts${COLORS.reset}`;
}

function formatItemList(items: string[], icon: string, label: string, width: number): string[] {
  const prefix = `${COLORS.darkBlue}${icon} ${label}${COLORS.reset}${COLORS.gray}:${COLORS.reset} `;

  if (items.length === 0) {
    return [`${prefix}${COLORS.dimGray}None${COLORS.reset}`];
  }

  const prefixWidth = visibleWidth(prefix);
  const lines: string[] = [];
  let currentLine = prefix;

  for (let i = 0; i < items.length; i++) {
    const itemStr = `${COLORS.white}${items[i]}${COLORS.reset}`;
    const sep = i < items.length - 1 ? `${COLORS.gray},${COLORS.reset} ` : "";
    const candidate = currentLine + itemStr + sep;

    if (visibleWidth(candidate) <= width) {
      currentLine = candidate;
    } else {
      // Push current line and start a new one with indentation
      lines.push(currentLine);
      const indent = " ".repeat(prefixWidth);
      currentLine = indent + itemStr + sep;
    }
  }

  if (currentLine !== prefix) {
    lines.push(currentLine);
  }

  return lines;
}

// ============================================================================
// PI SDK BOUNDARY SHAPES
// ============================================================================
// The Pi SDK exposes its extension surface as `any` (see pi-types.d.ts), so we
// describe the exact shapes this extension relies on. These are structural
// contracts against the untyped runtime, not casts to `any`.

interface ModelInfo {
  id?: string;
  contextWindow?: number;
}

interface ContextUsage {
  tokens?: number;
}

/** The live TUI handle passed to a footer factory. */
interface TuiHandle {
  requestRender(): void;
}

/** Footer state; notifies when the active conversation branch changes. */
interface FooterData {
  /** Registers a listener and returns its unsubscribe function. */
  onBranchChange(callback: () => void): () => void;
}

/** The renderer object a footer factory must return. */
interface FooterRenderer {
  dispose(): void;
  invalidate(): void;
  render(width: number): string[];
}

type FooterFactory = (tui: TuiHandle, theme: Theme, footerData: FooterData) => FooterRenderer;

interface FooterUI {
  setFooter(factory: FooterFactory): void;
}

/** Context passed to a `session_start` handler. */
interface SessionStartContext {
  hasUI: boolean;
  ui: FooterUI;
  model?: ModelInfo;
  getContextUsage(): ContextUsage | undefined;
}

// ============================================================================
// EXTENSION FACTORY
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Cache skills, agents, extensions, and prompts (populated async)
  let cachedSkills: string[] = [];
  let cachedAgents: string[] = [];
  let cachedExtensions: string[] = [];
  let cachedPrompts: string[] = [];

  // Get current working directory name
  const cwd = process.cwd();
  const dirName = cwd.split("/").pop() || cwd;

  pi.on("session_start", async (_event: unknown, ctx: SessionStartContext) => {
    if (!ctx.hasUI) return;

    // Load cache asynchronously
    cachedSkills = await getSkills();
    cachedAgents = await getAgents();
    cachedExtensions = await getExtensions();
    cachedPrompts = await getPrompts();
  });

  // Custom footer with context bar and item lists
  pi.on("session_start", async (_event: unknown, ctx: SessionStartContext) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui: TuiHandle, theme: Theme, footerData: FooterData): FooterRenderer => {
      // Subscribe to branch changes to trigger re-render when new messages arrive
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},

        render(width: number) {
          const lines: string[] = [];

          // Line 1: Main status line (DA name, model, directory, skills/extensions/prompts count)
          const modelId = ctx.model?.id || "unknown";
          lines.push(
            formatLine1(
              modelId,
              dirName,
              cachedSkills.length,
              cachedExtensions.length,
              cachedPrompts.length
            )
          );

          // Line 2: Skills list (wraps intelligently)
          lines.push(...formatItemList(cachedSkills, ICONS.target, "Skills", width));

          // Line 3: Agents list (wraps intelligently)
          lines.push(...formatItemList(cachedAgents, ICONS.robot, "Agents", width));

          // Line 4: Extensions list (wraps intelligently)
          lines.push(...formatItemList(cachedExtensions, ICONS.plug, "Extensions", width));

          // Line 5: Prompts list (wraps intelligently)
          lines.push(...formatItemList(cachedPrompts, ICONS.prompt, "Prompts", width));

          // Separator - scale to terminal width
          const separatorDots = Math.max(1, Math.floor((width - 2) / 2));
          lines.push(`${COLORS.gray}${"· ".repeat(separatorDots).trimEnd()}${COLORS.reset}`);

          // Use ctx.getContextUsage() for accurate context tracking
          const contextUsage = ctx.getContextUsage();
          const contextMax = ctx.model?.contextWindow || 200000;
          const contextUsed = contextUsage?.tokens || 0;

          // Calculate context percentage
          const contextPct = Math.min(100, Math.round((contextUsed / contextMax) * 100));
          const contextUsedK = Math.round(contextUsed / 1000);
          const contextMaxK = Math.round(contextMax / 1000);

          // Context bar line
          // Scale bar width based on available terminal width
          const barWidth = Math.min(12, Math.max(4, width - 40));
          const barStr = renderContextBar(contextPct, barWidth);
          const pctColor = getPctColor(contextPct);
          lines.push(
            `${COLORS.blue}${ICONS.chart} Context${COLORS.reset}${COLORS.gray}:${COLORS.reset} ${barStr} ${pctColor}${contextPct}%${COLORS.reset} ${COLORS.gray}(${contextUsedK}K/${contextMaxK}K)${COLORS.reset}`
          );

          // Truncate all lines to terminal width to prevent crash
          return lines.map((l) => truncateToWidth(theme.fg("text", l), width));
        },
      };
    });
  });
}
