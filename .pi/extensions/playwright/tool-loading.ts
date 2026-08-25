import { registerTool } from "../../lib/pi-tool-registration.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { PlaywrightConfig } from "./types.js";

export const PLAYWRIGHT_LOADER_TOOL = "playwright_load_tools";

export const PLAYWRIGHT_CORE_TOOLS = Object.freeze([
  "playwright_navigate",
  "playwright_navigate_back",
  "playwright_navigate_forward",
  "playwright_reload",
  "playwright_get_current_url",
  "playwright_get_title",
  "playwright_snapshot",
  "playwright_screenshot",
  "playwright_close",
  "playwright_resize",
  "playwright_new_page",
  "playwright_close_page",
  "playwright_switch_tab",
  "playwright_list_tabs",
  "playwright_wait_for",
]);

export const PLAYWRIGHT_TOOL_GROUPS = Object.freeze({
  interact: Object.freeze([
    "playwright_click",
    "playwright_double_click",
    "playwright_hover",
    "playwright_drag",
    "playwright_type",
    "playwright_fill",
    "playwright_select_option",
    "playwright_check",
    "playwright_uncheck",
    "playwright_press_key",
    "playwright_handle_dialog",
    "playwright_fill_form",
  ]),
  diagnose: Object.freeze([
    "playwright_evaluate",
    "playwright_console_messages",
    "playwright_network_requests",
    "playwright_network_request",
    "playwright_verify_element_visible",
    "playwright_verify_text_visible",
    "playwright_verify_value",
  ]),
  storage: Object.freeze([
    "playwright_local_storage",
    "playwright_session_storage",
    "playwright_cookies",
  ]),
  network: Object.freeze([
    "playwright_route",
    "playwright_unroute",
    "playwright_get_proxy_info",
    "playwright_check_proxy_reachable",
    "playwright_set_proxy",
  ]),
  files: Object.freeze(["playwright_pdf", "playwright_file_upload", "playwright_drop"]),
  vision: Object.freeze([
    "playwright_mouse_move_xy",
    "playwright_mouse_click_xy",
    "playwright_mouse_drag_xy",
    "playwright_mouse_wheel",
  ]),
  devtools: Object.freeze([
    "playwright_highlight",
    "playwright_hide_highlight",
    "playwright_start_tracing",
    "playwright_stop_tracing",
  ]),
  unsafe: Object.freeze(["playwright_run_code_unsafe"]),
});

export type PlaywrightToolGroup = keyof typeof PLAYWRIGHT_TOOL_GROUPS;

const GROUP_NAMES: readonly PlaywrightToolGroup[] = Object.freeze([
  "interact",
  "diagnose",
  "storage",
  "network",
  "files",
  "vision",
  "devtools",
  "unsafe",
]);
const GroupSchema = Type.Union([
  Type.Literal("interact"),
  Type.Literal("diagnose"),
  Type.Literal("storage"),
  Type.Literal("network"),
  Type.Literal("files"),
  Type.Literal("vision"),
  Type.Literal("devtools"),
  Type.Literal("unsafe"),
  Type.Literal("all"),
]);
export type PlaywrightToolSelection = Static<typeof GroupSchema>;

const LoadToolsParamsSchema = Type.Object({
  groups: Type.Array(GroupSchema, {
    minItems: 1,
    uniqueItems: true,
    description:
      "Capability groups to enable: interact, diagnose, storage, network, files, vision, devtools, unsafe, or all",
  }),
});

export type LoadToolsParams = Static<typeof LoadToolsParamsSchema>;

export function toolsForGroups(groups: readonly PlaywrightToolSelection[]): string[] {
  const selected = groups.includes("all") ? GROUP_NAMES : groups;
  return [
    ...new Set(
      selected.flatMap((group) => (group === "all" ? [] : [...PLAYWRIGHT_TOOL_GROUPS[group]]))
    ),
  ];
}

export function configuredPrimaryGroups(config: PlaywrightConfig): PlaywrightToolGroup[] {
  return [
    ...(config.enableNetwork ? (["network"] as const) : []),
    ...(config.enableStorage ? (["storage"] as const) : []),
    ...(config.enableVision ? (["vision"] as const) : []),
    ...(config.enableDevtools ? (["devtools"] as const) : []),
  ];
}

export function initialPrimaryToolNames(
  activeNames: readonly string[],
  configuredGroups: readonly PlaywrightToolGroup[] = []
): string[] {
  const keep = new Set([
    ...PLAYWRIGHT_CORE_TOOLS,
    PLAYWRIGHT_LOADER_TOOL,
    ...toolsForGroups(configuredGroups),
  ]);
  return activeNames.filter((name) => !name.startsWith("playwright_") || keep.has(name));
}

export function isUnmarkedPrimaryRuntime(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return env.PENNY_RUNTIME_ROLE === undefined;
}

export function registerPlaywrightToolLoader(pi: ExtensionAPI): void {
  registerTool(pi, {
    name: PLAYWRIGHT_LOADER_TOOL,
    label: "Load Playwright Tools",
    description:
      "Enable additional Playwright tool definitions by capability group while keeping core navigation, tabs, snapshots, screenshots, and waits active. Use when the core browser tools cannot perform the task. Load the narrowest relevant group; do not load all or the unsafe group by default. Groups: interact (page actions/forms), diagnose (evaluation, console, request inspection, assertions), storage, network (routes/proxy), files (PDF/upload/drop), vision (coordinate actions), devtools (highlights/tracing), unsafe (full Node.js execution).",
    promptSnippet: "Load additional Playwright capability groups only when needed",
    parameters: LoadToolsParamsSchema,
    async execute(_toolCallId, params) {
      const active = pi.getActiveTools();
      const requested = toolsForGroups(params.groups);
      const added = requested.filter((name) => !active.includes(name));
      pi.setActiveTools([...new Set([...active, ...added])]);
      const text =
        added.length > 0
          ? `Loaded Playwright tools: ${added.join(", ")}`
          : `Requested Playwright groups already active: ${params.groups.join(", ")}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { groups: params.groups, added },
      };
    },
  });
}
