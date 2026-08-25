/**
 * Agent discovery and configuration
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  /** Exact, non-empty model-visible surface declared by YAML frontmatter. */
  tools: string[];
  model?: string;
  provider?: string;
  thinking?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

export interface AgentCatalogSnapshot {
  digest: string;
  agentNames: string[];
}

export const MODEL_VISIBLE_AGENT_LIMIT = 24;
export const MODEL_VISIBLE_AGENT_NAME_LIMIT = 80;
// Raised 512 -> 1024. normalizeCatalogText truncates SILENTLY, and truncation removes
// the tail -- exactly where the anti-cases that disambiguate routing live. The ceiling
// bounds absurdity, not authorship; the authoring budget (400 soft / 600 warn) is
// enforced by scripts/system/checks/check_capability_registry.py, which fails the build
// above 1024 so truncation can never again be silent.
export const MODEL_VISIBLE_AGENT_DESCRIPTION_LIMIT = 1024;
export const MODEL_VISIBLE_AGENT_CATALOG_LIMIT = 16_000;

function normalizeCatalogText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

/**
 * Build a bounded catalog for the provider-visible tool description.
 *
 * Pi omits tool prompt snippets/guidelines when a custom system prompt is in
 * use, but provider tool descriptions remain model-visible. Keep the same
 * trusted .pi/agents frontmatter as the source of truth while bounding its
 * contribution to every model request.
 */
export function formatModelVisibleAgentCatalog(agents: AgentConfig[]): string {
  if (agents.length === 0) return "Available agents: none discovered.";

  const prefix = "Available agents (name: description): ";
  const entries: string[] = [];
  const candidates = agents.slice(0, MODEL_VISIBLE_AGENT_LIMIT);

  for (const agent of candidates) {
    const name = normalizeCatalogText(agent.name, MODEL_VISIBLE_AGENT_NAME_LIMIT);
    const description = normalizeCatalogText(
      agent.description,
      MODEL_VISIBLE_AGENT_DESCRIPTION_LIMIT
    );
    const entry = `${name}: ${description}`;
    const candidate = `${prefix}${[...entries, entry].join(" | ")}`;
    if (candidate.length > MODEL_VISIBLE_AGENT_CATALOG_LIMIT) break;
    entries.push(entry);
  }

  const remaining = agents.length - entries.length;
  const suffix =
    remaining > 0
      ? ` | ${remaining} additional agent${remaining === 1 ? " is" : "s are"} available by name in the tool schema.`
      : ".";
  return `${prefix}${entries.join(" | ")}${suffix}`;
}

function parseExactToolList(value: unknown, filePath: string): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  if (raw.length === 0 || raw.some((item) => typeof item !== "string")) {
    throw new Error(`agent definition '${filePath}' requires a non-empty tools: list`);
  }
  const tools = raw.map((item) => String(item).trim());
  if (tools.some((tool) => tool.length === 0)) {
    throw new Error(`agent definition '${filePath}' contains an empty tools: entry`);
  }
  const duplicate = tools.find((tool, index) => tools.indexOf(tool) !== index);
  if (duplicate !== undefined) {
    throw new Error(`agent definition '${filePath}' contains duplicate tool '${duplicate}'`);
  }
  return tools;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) {
    return agents;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
      throw new Error(`agent definition '${filePath}' requires string name and description fields`);
    }
    if (frontmatter.name !== entry.name.replace(/\.md$/u, "")) {
      throw new Error(`agent definition '${filePath}' name must match its filename`);
    }
    const tools = parseExactToolList(frontmatter.tools, filePath);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools,
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      provider: typeof frontmatter.provider === "string" ? frontmatter.provider : undefined,
      thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * Capture the exact catalog state used for tool registration.
 *
 * The digest includes provider-visible metadata and execution-affecting agent
 * configuration. If any of it changes after registration, execution must wait
 * for Pi to reload and re-register the tool rather than using stale schema.
 */
export function snapshotAgentCatalog(discovery: AgentDiscoveryResult): AgentCatalogSnapshot {
  const agents = discovery.agents
    .map((agent) => ({
      name: agent.name,
      description: agent.description,
      tools: agent.tools,
      model: agent.model ?? null,
      provider: agent.provider ?? null,
      thinking: agent.thinking ?? null,
      systemPrompt: agent.systemPrompt,
      source: agent.source,
      filePath: path.resolve(agent.filePath),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath));
  const canonical = JSON.stringify({
    projectAgentsDir: discovery.projectAgentsDir ? path.resolve(discovery.projectAgentsDir) : null,
    agents,
  });
  return {
    digest: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    agentNames: agents.map((agent) => agent.name),
  };
}

export function discoverAgents(cwd: string, _scope: AgentScope): AgentDiscoveryResult {
  // Primary: walk up from cwd looking for .pi/agents/
  let projectAgentsDir = findNearestProjectAgentsDir(cwd);

  // Fallback: use PI_DIRECTORY env var if upward walk failed
  // PI_DIRECTORY is set in .env by the environment extension and points to
  // the canonical .pi directory (e.g., /path/to/project/.pi).
  // The subagent extension appends /agents automatically.
  // This ensures agents are always discoverable regardless of what
  // cwd or project_root is set to — prevents silent failures when
  // Penny or a skill passes a different project_root.
  if (!projectAgentsDir) {
    const piDirectory = process.env.PI_DIRECTORY;
    if (piDirectory) {
      const agentsDir = piDirectory.endsWith("/")
        ? `${piDirectory}agents`
        : `${piDirectory}/agents`;
      if (isDirectory(agentsDir)) {
        projectAgentsDir = agentsDir;
      }
    }
  }

  const projectAgents = !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>();

  // All scopes resolve to project agents (user agents were never in ~/.pi/agent/agents/)
  for (const agent of projectAgents) agentMap.set(agent.name, agent);

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(
  agents: AgentConfig[],
  maxItems: number
): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
    remaining,
  };
}
