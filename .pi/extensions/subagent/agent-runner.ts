/**
 * Shared Agent Runner
 *
 * Core logic for spawning and managing agent processes.
 * Extracted from the subagent extension for reuse by other extensions
 * (e.g., the skill extension) that need direct agent invocation
 * without going through the tool API.
 *
 * The pi framework's ExtensionContext does not provide a way for
 * one extension to call another extension's registered tool
 * (there is no ctx.tools or ctx.callTool). Extensions that need
 * agent invocation must use this shared module directly.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  ensureOwnerDirectory,
  PennyStateResolutionError,
  resolvePennyRuntimeState,
} from "@penny/orchestration/source";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { captureToolResultForExecutionOwner } from "./execution-owner-capture.js";
import type { ArtifactRef } from "../artifacts/owner-client.js";
import { createLogger, getSessionId } from "../../lib/logger/logger.js";

const logger = createLogger("agent-runner");
const MEMORY_ENVIRONMENT_PREFIXES = ["PENNY_MEMORY_", "MEMPALACE_"] as const;
const LEGACY_MEMORY_ENVIRONMENT_SELECTORS = ["PI_MEMORY_BRIDGE", "MEMPAL_PALACE_PATH"] as const;
const RETIRED_STATE_ENVIRONMENT_SELECTORS = [
  "PENNY_ARTIFACT_ROOT",
  "PENNY_ARTIFACT_GRANT_ROOT",
  "PENNY_SKILL_CHAIN_STATE_ROOT",
  "PENNY_ORCH_DB",
  "PENNY_ORCH_V2_DB",
  "PI_OBSERVABILITY_URL",
  "PI_OBSERVABILITY_DATA_DIR",
] as const;

// Re-export agent discovery for convenience
export { type AgentConfig, type AgentScope, discoverAgents };

/**
 * Environment variables to pass through for worker-read memory access.
 * Only the minimal set needed for authenticated read-only hub access.
 * Write credentials, custody fields, and logstream config are NOT passed.
 */
const WORKER_READ_MEMORY_ENV_VARS = [
  "PENNY_MEMORY_MCP_ENDPOINT",
  "PENNY_MEMORY_MCP_TOKEN_FILE",
  "PENNY_MEMORY_PALACE_ID",
  "PENNY_MEMORY_PRINCIPAL_ID",
  "PENNY_MEMORY_TRUST_MODE",
  "PENNY_MEMORY_ISOLATION_BOUNDARY_ID",
  "PENNY_MEMORY_DATA_ROOT_ID",
  "PENNY_MEMORY_MAX_RESPONSE_BYTES",
  "PENNY_MEMORY_REQUEST_TIMEOUT_MS",
] as const;

/**
 * Read-only memory tools declared in agent frontmatter via the `memory.read`
 * tool profile. These are NOT injected by this ordinary direct/parallel/chain
 * runner — its frontmatter `tools:` field is the exact control plane. The
 * TypeScript orchestration registration-subset seam is separate and never
 * enters this module. This constant is exported for reference/tests only.
 */
export const WORKER_READ_MEMORY_TOOLS = [
  "memory_search",
  "memory_smart_search",
  "memory_get_drawer",
  "memory_list_drawers",
  "memory_get_taxonomy",
  "memory_check_duplicate",
  "memory_kg_query",
  "memory_kg_timeline",
  "memory_kg_stats",
  "memory_diary_read",
] as const;

/**
 * Build the execution-owner-controlled environment for a spawned worker.
 *
 * Every agent process (direct `subagent(...)` or skill-invoked) is spawned
 * with this environment — never the raw `process.env`. Owner-only signing
 * secrets, memory-plane configuration/credentials, and legacy memory
 * selectors are removed before any inherited role claim is overwritten. The
 * role marker classifies this child for lifecycle policy; it is not an
 * authorization grant, a tool grant, or a sandbox boundary.
 *
 * When ``memoryReadAccess`` is true, a minimal set of read-only memory env
 * vars is re-added after stripping, and the role is set to ``worker-read``
 * so the memory extension registers only read tools. The child cannot
 * escalate its own role — the parent overwrites PENNY_RUNTIME_ROLE.
 */
export function isolatedAgentEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: { memoryReadAccess?: boolean } = {}
): NodeJS.ProcessEnv {
  const selectedMemoryCredential = environment.PENNY_MEMORY_MCP_TOKEN_ENV?.trim();
  const isolated: NodeJS.ProcessEnv = { ...environment };
  for (const name of Object.keys(isolated)) {
    if (MEMORY_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      delete isolated[name];
    }
  }
  for (const name of LEGACY_MEMORY_ENVIRONMENT_SELECTORS) delete isolated[name];
  for (const name of RETIRED_STATE_ENVIRONMENT_SELECTORS) delete isolated[name];
  if (selectedMemoryCredential) delete isolated[selectedMemoryCredential];
  delete isolated.PENNY_RECEIPT_HMAC_KEY;
  delete isolated.PENNY_APPROVAL_HMAC_KEY;

  if (options.memoryReadAccess) {
    // Re-add only the minimal read-only memory config
    for (const name of WORKER_READ_MEMORY_ENV_VARS) {
      if (environment[name]) isolated[name] = environment[name];
    }
    // Never pass the token env var (only the token file path)
    delete isolated.PENNY_MEMORY_MCP_TOKEN_ENV;
    // Never pass write-related config
    delete isolated.PENNY_MEMORY_WRITE_MODE;
    delete isolated.PENNY_MEMORY_LOGSTREAM_MODE;
    delete isolated.PENNY_MEMORY_LOGSTREAM_STREAM;
    delete isolated.PENNY_MEMORY_LOGSTREAM_ROOMS;
    isolated.PENNY_RUNTIME_ROLE = "worker-read";
  } else {
    isolated.PENNY_RUNTIME_ROLE = "worker";
  }
  return isolated;
}

function ownerSuppliedAgentEnvironment(
  ownerEnvironment?: NodeJS.ProcessEnv,
  options: { memoryReadAccess?: boolean } = {}
): NodeJS.ProcessEnv {
  const selectedMemoryCredentials = [
    process.env.PENNY_MEMORY_MCP_TOKEN_ENV?.trim(),
    ownerEnvironment?.PENNY_MEMORY_MCP_TOKEN_ENV?.trim(),
  ].filter((name): name is string => Boolean(name));
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(ownerEnvironment ?? {})) {
    if (value === undefined) delete merged[name];
    else merged[name] = value;
  }
  const isolated = isolatedAgentEnvironment(merged, options);
  for (const name of selectedMemoryCredentials) delete isolated[name];
  return isolated;
}

export const SUBAGENT_SESSION_RETENTION_DAYS = 30;
export const SUBAGENT_SESSION_MAX_FILES_PER_AGENT = 500;
const SUBAGENT_SESSION_CAP_MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;

function hardenDurableSubagentSessions(directory: string): void {
  const uid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  let changed = false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(directory, entry.name);
    const stat = fs.lstatSync(file);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (uid !== undefined && stat.uid !== uid)
    ) {
      continue;
    }
    if ((stat.mode & 0o777) !== 0o600) {
      fs.chmodSync(file, 0o600);
      changed = true;
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  if (changed) {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

/**
 * Delete only completed, owner-controlled Pi JSONL session files according to
 * the bounded target-state retention policy. Symlinks, hard links, foreign
 * files, and recently active sessions are never removed.
 */
export function pruneDurableSubagentSessions(
  directory: string,
  options: {
    readonly now?: number;
    readonly retentionDays?: number;
    readonly maxFiles?: number;
  } = {}
): readonly string[] {
  const now = options.now ?? Date.now();
  const retentionDays = options.retentionDays ?? SUBAGENT_SESSION_RETENTION_DAYS;
  const maxFiles = options.maxFiles ?? SUBAGENT_SESSION_MAX_FILES_PER_AGENT;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new Error("subagent retentionDays must be a positive integer");
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error("subagent maxFiles must be a positive integer");
  }
  const uid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  const candidates = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      const stat = fs.lstatSync(file);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (uid !== undefined && stat.uid !== uid) ||
        (stat.mode & 0o022) !== 0
      ) {
        return [];
      }
      return [{ file, modified: stat.mtimeMs }];
    })
    .sort((left, right) => left.modified - right.modified);
  const retentionCutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const capCutoff = now - SUBAGENT_SESSION_CAP_MINIMUM_AGE_MS;
  const selected = new Set(
    candidates.filter((candidate) => candidate.modified < retentionCutoff).map(({ file }) => file)
  );
  const remaining = candidates.filter(({ file }) => !selected.has(file));
  const excess = Math.max(0, remaining.length - maxFiles);
  for (const candidate of remaining
    .filter(({ modified }) => modified < capCutoff)
    .slice(0, excess)) {
    selected.add(candidate.file);
  }
  const removed: string[] = [];
  for (const file of selected) {
    fs.unlinkSync(file);
    removed.push(file);
  }
  if (removed.length > 0) {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return removed;
}

// ============================================================
// Provider resolution
// ============================================================

// Pi's `--model <id>` flag, without `--provider`, performs cross-provider id
// resolution and may select a provider that has no API key configured (e.g.
// amazon-bedrock / github-copilot), crashing the spawned agent at startup.
// Custom providers declared in ~/.pi/agent/models.json (such as a LiteLLM
// proxy) require the matching `--provider`. We resolve the user's configured
// default provider once and reuse it for every dispatched agent.
let _defaultProviderCache: string | null | undefined; // undefined = not yet resolved
function resolveDefaultProvider(): string | undefined {
  if (_defaultProviderCache !== undefined) return _defaultProviderCache ?? undefined;
  // Explicit env override wins.
  const envProvider = process.env.PI_DEFAULT_PROVIDER || process.env.PI_PROVIDER;
  if (envProvider) {
    _defaultProviderCache = envProvider;
    return envProvider;
  }
  // Fall back to Pi's settings.json `defaultProvider`. Note: PI_DIRECTORY points
  // at the PROJECT .pi resources dir, whose settings.json typically has no
  // provider config — the authoritative defaultProvider lives in the global
  // agent config (~/.pi/agent/settings.json). Check candidates in order and use
  // the first one that actually declares a defaultProvider.
  const candidates = [
    process.env.PI_DIRECTORY ? path.join(process.env.PI_DIRECTORY, "settings.json") : null,
    path.join(os.homedir(), ".pi", "agent", "settings.json"),
  ].filter((p): p is string => Boolean(p));
  for (const settingsPath of candidates) {
    try {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      const settings: unknown = JSON.parse(raw);
      if (
        isRecord(settings) &&
        typeof settings.defaultProvider === "string" &&
        settings.defaultProvider
      ) {
        _defaultProviderCache = settings.defaultProvider;
        return settings.defaultProvider;
      }
    } catch {
      // try next candidate
    }
  }
  _defaultProviderCache = null;
  return undefined;
}

// Map a model id to the provider that DECLARES it, by reading the model catalog
// (models.json). This is what makes a MIXED Claude+Ollama fleet work: an agent
// pinned to an Ollama-provider model (e.g. `glm-5.2:cloud`) must be dispatched
// with `--provider ollama`, NOT the global `defaultProvider` (which is
// `anthropic` for Penny herself). Without this, `pi --model glm-5.2:cloud`
// resolves against the default provider (anthropic) and 404s
// (`not_found_error`), taking down every agent-backed skill.
//
// Candidates mirror resolveDefaultProvider's search order (project .pi first,
// then the global agent config). The first declaration of an id wins.
let _modelProviderMapCache: Map<string, string> | undefined;
function loadModelProviderMap(): Map<string, string> {
  if (_modelProviderMapCache) return _modelProviderMapCache;
  const map = new Map<string, string>();
  const candidates = [
    process.env.PI_DIRECTORY ? path.join(process.env.PI_DIRECTORY, "models.json") : null,
    path.join(os.homedir(), ".pi", "agent", "models.json"),
  ].filter((p): p is string => Boolean(p));
  for (const modelsPath of candidates) {
    try {
      const raw = fs.readFileSync(modelsPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.providers)) continue;
      for (const [providerName, providerCfg] of Object.entries(parsed.providers)) {
        if (!isRecord(providerCfg) || !Array.isArray(providerCfg.models)) continue;
        for (const model of providerCfg.models) {
          if (isRecord(model) && typeof model.id === "string" && model.id && !map.has(model.id)) {
            map.set(model.id, providerName);
          }
        }
      }
    } catch {
      // missing/malformed catalog at this candidate — skip it
    }
  }
  _modelProviderMapCache = map;
  return map;
}

/**
 * Resolve the provider that serves `modelId`, or undefined when the model is not
 * declared in any catalog (in which case the caller falls back to the global
 * default provider). Exported for unit testing.
 */
export function resolveProviderForModel(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  return loadModelProviderMap().get(modelId);
}

// ============================================================
// Constants
// ============================================================

export const MAX_PARALLEL_TASKS = 25;
export const MAX_CONCURRENCY = 25;

// ============================================================
// Types
// ============================================================

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface ObservedPiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

type ObservedPiAssistantMessage = Record<string, unknown> & {
  role: "assistant";
  content: Record<string, unknown>[];
  usage?: ObservedPiUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
};

type ObservedPiToolResultMessage = Record<string, unknown> & {
  role: "toolResult";
  content: Record<string, unknown>[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

type ObservedPiUserMessage = Record<string, unknown> & {
  role: "user";
  content: string | Record<string, unknown>[];
};

/** The validated Pi JSON-message subset consumed and surfaced by this runner. */
export type ObservedPiMessage =
  | ObservedPiAssistantMessage
  | ObservedPiToolResultMessage
  | ObservedPiUserMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isObservedPiUsage(value: unknown): value is ObservedPiUsage {
  if (!isRecord(value)) return false;
  if (
    !isOptionalNumber(value.input) ||
    !isOptionalNumber(value.output) ||
    !isOptionalNumber(value.cacheRead) ||
    !isOptionalNumber(value.cacheWrite) ||
    !isOptionalNumber(value.totalTokens)
  ) {
    return false;
  }
  if (value.cost === undefined) return true;
  return isRecord(value.cost) && isOptionalNumber(value.cost.total);
}

function hasRecordContent(value: Record<string, unknown>): boolean {
  return Array.isArray(value.content) && value.content.every(isRecord);
}

function isObservedPiAssistantMessage(
  value: Record<string, unknown>
): value is ObservedPiAssistantMessage {
  return (
    value.role === "assistant" &&
    hasRecordContent(value) &&
    (value.usage === undefined || isObservedPiUsage(value.usage)) &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.stopReason === undefined || typeof value.stopReason === "string") &&
    (value.errorMessage === undefined || typeof value.errorMessage === "string")
  );
}

function isObservedPiToolResultMessage(
  value: Record<string, unknown>
): value is ObservedPiToolResultMessage {
  return (
    value.role === "toolResult" &&
    hasRecordContent(value) &&
    (value.toolCallId === undefined || typeof value.toolCallId === "string") &&
    (value.toolName === undefined || typeof value.toolName === "string") &&
    (value.isError === undefined || typeof value.isError === "boolean")
  );
}

function isObservedPiUserMessage(value: Record<string, unknown>): value is ObservedPiUserMessage {
  return (
    value.role === "user" &&
    (typeof value.content === "string" ||
      (Array.isArray(value.content) && value.content.every(isRecord)))
  );
}

/** Validate one message from Pi's JSON event stream without rewriting its payload. */
export function adaptPiJsonMessage(value: unknown): ObservedPiMessage | undefined {
  if (!isRecord(value)) return undefined;
  return isObservedPiAssistantMessage(value) ||
    isObservedPiToolResultMessage(value) ||
    isObservedPiUserMessage(value)
    ? value
    : undefined;
}

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: ObservedPiMessage[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  /** Exact execution-owner output ref when this invocation is artifact-captured. */
  outputArtifactRef?: ArtifactRef;
}

export function createPendingSingleResult(agent: string, task: string): SingleResult {
  return {
    agent,
    agentSource: "unknown",
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };
}

export interface SubagentCatalogDriftError {
  code: "SUBAGENT_RELOAD_REQUIRED";
  kind: "catalog_drift";
  retryable: true;
  registeredCatalogDigest: string;
  executionCatalogDigest: string;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  /** Owner-generated run identity for direct chain artifacts. */
  artifactRunId?: string;
  /** Exact output refs in completed step order. */
  outputArtifactRefs?: ArtifactRef[];
  /** Exact final output ref; authoritative over any preview. */
  finalOutputArtifactRef?: ArtifactRef;
  error?: SubagentCatalogDriftError;
}

// ============================================================
// Progress Emitter
// ============================================================

import { EventEmitter } from "node:events";

export interface ProgressEvent {
  type: "tool_result" | "message_end" | "agent_start";
  timestamp: number;
  detail?: string;
}

export class ProgressEmitter extends EventEmitter {
  markProgress(event: ProgressEvent): void {
    this.emit("progress", event);
  }
}

// ============================================================
// Utility functions
// ============================================================

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 1000000) {
    const k = count / 1000;
    const rounded = Math.round(k * 10) / 10;
    return rounded % 1 === 0 ? `${rounded.toFixed(0)}k` : `${rounded.toFixed(1)}k`;
  }
  const m = count / 1000000;
  const roundedM = Math.round(m * 10) / 10;
  return roundedM % 1 === 0 ? `${roundedM.toFixed(0)}M` : `${roundedM.toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

/**
 * Return the canonical finalized assistant output.
 *
 * The byte sequence is UTF-8 of every `text` part in the final assistant
 * message, concatenated in content-array order with no inserted separator.
 * Thinking/reasoning and tool-call parts are excluded. A final assistant
 * message with no text is canonically empty; an earlier turn is never reused
 * as a substitute for an incomplete final turn.
 */
export function getFinalOutput(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = adaptPiJsonMessage(messages[i]);
    if (message?.role === "assistant") {
      return message.content
        .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
        .join("");
    }
  }
  return "";
}

// ============================================================
// Pi invocation
// ============================================================

export interface PiInvocation {
  command: string;
  args: string[];
}

/**
 * Canonical filename of pi's CLI entry point.
 * Used to verify that process.argv[1] actually points to pi, not some
 * other Node script that happened to import this module.
 */
const PI_CLI_BASENAME = "cli.js";

export function getPiInvocation(args: string[]): PiInvocation {
  const currentScript = process.argv[1];

  // Only re-use execPath + argv[1] when argv[1] is pi's actual entry point.
  // If argv[1] points to any other script (e.g. a test file, a standalone
  // tool), spawning `node <that-script>` would re-execute it recursively,
  // creating a fork bomb.
  if (
    currentScript &&
    fs.existsSync(currentScript) &&
    path.basename(currentScript) === PI_CLI_BASENAME
  ) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

// ============================================================
// Skill context resolution
// ============================================================

/**
 * Resolve skillContext: if it's a file path that exists, read it;
 * otherwise use as inline content.
 */
export function resolveSkillContext(
  skillContext: string | undefined,
  cwd: string
): string | undefined {
  if (!skillContext || !skillContext.trim()) return undefined;
  const resolvedPath = path.resolve(cwd, skillContext);
  if (fs.existsSync(resolvedPath)) {
    try {
      return fs.readFileSync(resolvedPath, "utf-8");
    } catch {
      // Fall through to inline content
    }
  }
  return skillContext;
}

// ============================================================
// Prompt temp file management
// ============================================================

export async function writePromptToTempFile(
  agentName: string,
  prompt: string
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

// ============================================================
// Agent base system prompt (SYSTEM.md) resolution
// ============================================================
//
// Anthropic OAuth (subscription) tokens are billed against plan limits only
// when the request resembles first-party Claude Code. Pi's DEFAULT system
// prompt ("...operating inside pi, a coding agent harness") is classified as a
// third-party app and rejected with a 400 invalid_request "...draw from your
// extra usage, not your plan limits" error in multi-turn tool loops. Penny's
// .pi/SYSTEM.md is not. Agents used to receive SYSTEM.md only when their spawn
// cwd happened to be a trusted project (pi's auto-discovery of SYSTEM.md is
// gated by isProjectTrusted(), keyed on cwd); any agent whose cwd was not the
// trusted project root silently fell back to the default prompt and failed.
// We now resolve SYSTEM.md deterministically from the project .pi directory
// and pass it explicitly via --system-prompt, independent of the agent cwd.

function formatFrameDate(date: Date): string {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** Substitute ${VAR} placeholders from process.env (+ CURRENT_DATE), mirroring
 * the environment extension so agents never see raw ${...} tokens. */
function substituteFrameEnvVars(content: string): string {
  const currentDate = formatFrameDate(new Date());
  return content.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (name === "CURRENT_DATE") return currentDate;
    return process.env[name] ?? "";
  });
}

/** Resolve the project SYSTEM.md path from env, independent of the agent cwd. */
function resolveSystemPromptPath(defaultCwd: string): string | null {
  const candidates = [
    process.env.PI_DIRECTORY ? path.join(process.env.PI_DIRECTORY, "SYSTEM.md") : null,
    process.env.PROJECT_ROOT ? path.join(process.env.PROJECT_ROOT, ".pi", "SYSTEM.md") : null,
    path.join(defaultCwd, ".pi", "SYSTEM.md"),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Build the per-agent base system prompt from SYSTEM.md with two invoke-time
 * transforms:
 *  - `${VAR}` env substitution (mirrors the environment extension)
 *  - the persona name "Penny" -> the agent's display name (e.g. "Echo")
 *  - strips the Penny-only "# On-Demand Protocols" section (keeps the
 *    </system_context> tag balanced)
 *
 * Returns null when SYSTEM.md cannot be found/read, in which case the caller
 * omits --system-prompt and preserves prior behavior (pi default prompt).
 */
export function buildAgentBaseSystemPrompt(agentName: string, defaultCwd: string): string | null {
  const sysPath = resolveSystemPromptPath(defaultCwd);
  if (!sysPath) {
    logger.warn("SYSTEM.md not found; agent will use pi default prompt", { agent: agentName });
    return null;
  }
  let content: string;
  try {
    content = fs.readFileSync(sysPath, "utf-8");
  } catch (err) {
    logger.warn("Failed to read SYSTEM.md for agent base prompt", {
      agent: agentName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  content = substituteFrameEnvVars(content);
  // Personalize: "Penny" -> capitalized agent name (e.g. echo -> Echo).
  const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);
  content = content.replace(/\bPenny\b/g, displayName);
  // Strip the "# On-Demand Protocols" section (Penny-orchestrator-only guidance),
  // preserving the closing </system_context> tag.
  content = content.replace(/\n#\s*On-Demand Protocols[\s\S]*?(?=\n<\/system_context>|$)/, "");
  return content;
}

// ============================================================
// Agent extension set resolution
// ============================================================
//
// Agents need Penny's project extensions (memory, observability, search, ...)
// so their allowlisted tools (memory_smart_search, web_search, ...) actually
// exist. Pi auto-discovers project extensions from the process cwd, but only
// when the project is trusted (isProjectTrusted(), keyed on cwd). An agent
// spawned with a cwd OUTSIDE the trusted Penny project — e.g. an sca/jsa target
// directory passed as project_root — therefore loaded NO project extensions and
// its memory_* tools silently did not exist.
//
// We instead force-load every extension under <PI_DIRECTORY>/extensions via
// explicit -e (which bypasses both cwd-discovery and trust gating) and pass
// --no-extensions to disable cwd-based discovery. The agent's extension set is
// then deterministic and identical to a trusted penny-root run regardless of
// its working dir, while its cwd stays on the target so file tools operate
// there. The agent's --tools allowlist still governs which of these
// extensions' tools are actually exposed.

/** Resolve Penny's extensions directory from env, independent of the agent cwd. */
function resolveExtensionsDir(defaultCwd: string): string | null {
  const candidates = [
    process.env.PI_DIRECTORY ? path.join(process.env.PI_DIRECTORY, "extensions") : null,
    process.env.PROJECT_ROOT ? path.join(process.env.PROJECT_ROOT, ".pi", "extensions") : null,
    path.join(defaultCwd, ".pi", "extensions"),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Build the `--no-extensions -e <path> ...` args that force-load Penny's whole
 * extension set for an agent subprocess, independent of the agent's cwd/trust.
 *
 * Enumerates `<extensionsDir>/*\/index.ts` (subdir extensions) and top-level
 * `<extensionsDir>/*.ts` (single-file extensions). Falls back to loading only
 * the compaction extension with cwd-based discovery LEFT ON (prior behavior)
 * when the extensions directory cannot be resolved/enumerated — so a
 * misconfigured env never leaves an agent with zero extensions on a trusted
 * penny-root run. Exported for unit testing.
 */
export function resolveAgentExtensionArgs(defaultCwd: string): string[] {
  const extDir = resolveExtensionsDir(defaultCwd);
  const compactionFallback = (): string[] => [
    "-e",
    extDir
      ? path.join(extDir, "compaction", "index.ts")
      : path.resolve(defaultCwd, ".pi/extensions/compaction/index.ts"),
  ];
  if (!extDir) return compactionFallback();

  const entries: string[] = [];
  try {
    for (const name of fs.readdirSync(extDir).sort()) {
      const dirIndex = path.join(extDir, name, "index.ts");
      const singleFile = path.join(extDir, name);
      try {
        if (fs.existsSync(dirIndex)) {
          entries.push(dirIndex);
        } else if (name.endsWith(".ts") && fs.statSync(singleFile).isFile()) {
          entries.push(singleFile);
        }
      } catch {
        // skip unreadable entry
      }
    }
  } catch (err) {
    logger.warn("Failed to enumerate agent extensions; loading compaction only", {
      dir: extDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return compactionFallback();
  }

  if (entries.length === 0) return compactionFallback();

  // --no-extensions disables cwd-based (trust-gated) discovery; the explicit -e
  // paths still load, so the agent gets exactly this deterministic set.
  const args = ["--no-extensions"];
  for (const entry of entries) args.push("-e", entry);
  return args;
}

// ============================================================
// Concurrency-limited mapping
// ============================================================

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: Array<{ value: TOut } | undefined> = Array.from(
    { length: items.length },
    () => undefined
  );
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = { value: await fn(items[current], current) };
    }
  });
  await Promise.all(workers);
  return Array.from({ length: items.length }, (_unused, index) => {
    const entry = results[index];
    if (entry === undefined) throw new Error(`concurrent mapper omitted result ${index}`);
    return entry.value;
  });
}

// ============================================================
// Single agent execution
// ============================================================

export type OnUpdateCallback = (partial: {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
}) => void;

/**
 * Split a model override into an optional provider + model. A `provider/model`
 * composite (e.g. `ollama/glm`) lets a caller route an agent to a DIFFERENT
 * provider than its frontmatter pins; the FIRST "/" separates provider from
 * model (so a vendor-style model id like `anthropic/claude-x` survives intact
 * as the model half). A bare string (no "/", or an empty half) is returned as a
 * model-only override, preserving legacy behavior. Exported for unit testing.
 */
export function parseModelOverride(modelOverride: string | undefined): {
  model?: string;
  provider?: string;
} {
  if (!modelOverride) return {};
  const i = modelOverride.indexOf("/");
  if (i > 0) {
    const provider = modelOverride.slice(0, i).trim();
    const model = modelOverride.slice(i + 1).trim();
    if (provider && model) return { provider, model };
  }
  return { model: modelOverride };
}

/**
 * Run a single agent in an isolated pi process.
 *
 * This is the core function for agent invocation. It spawns a pi subprocess
 * with the agent's system prompt, optional skill context, and task description.
 */
export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  skillContextContent: string | undefined = undefined,
  progressEmitter?: ProgressEmitter,
  modelOverride?: string,
  ownerEnvironment?: NodeJS.ProcessEnv
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  let tmpBaseDir: string | null = null;
  let tmpBasePath: string | null = null;
  let sessionState: ReturnType<typeof resolvePennyRuntimeState>;
  try {
    sessionState = resolvePennyRuntimeState(defaultCwd, {
      env: ownerEnvironment ?? process.env,
    });
  } catch (error) {
    const code = error instanceof PennyStateResolutionError ? error.code : "STATE_CUSTODY_INVALID";
    const message = error instanceof Error ? error.message : String(error);
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      exitCode: 1,
      messages: [],
      stderr: `${code}: subagent state preflight failed before spawn. ${message}`,
      errorMessage: `${code}: subagent state preflight failed before spawn. ${message}`,
      stopReason: "error",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }
  const sessionAgentName = agentName.replace(/[^A-Za-z0-9._-]+/gu, "_");
  const durableSessionDir = path.join(
    sessionState.paths.subagentSessions,
    sessionAgentName || "unknown-agent"
  );
  ensureOwnerDirectory(durableSessionDir, "Penny subagent session directory");

  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--session-dir",
    durableSessionDir,
    "--no-themes",
    "--no-skills",
    "--no-prompt-templates",
    // Force-load Penny's full extension set independent of the agent cwd/trust
    // so memory/observability/tool-providing extensions are always available.
    ...resolveAgentExtensionArgs(defaultCwd),
  ];
  // A model override may be a `provider/model` composite (e.g. `ollama/glm`) so
  // a skill can route an agent to a DIFFERENT provider than its frontmatter
  // pins. The explicit provider from the composite then WINS over
  // `agent.provider`; a bare override (no "/") keeps the legacy model-only
  // meaning.
  const { model: overrideModel, provider: overrideProvider } = parseModelOverride(modelOverride);
  const model = overrideModel || agent.model;
  if (model) args.push("--model", model);
  // Pass --provider so custom-provider models (e.g. Ollama :cloud models or a
  // LiteLLM proxy defined in ~/.pi/agent/models.json) resolve correctly. Without
  // it, `pi --model <id>` does cross-provider id resolution and can pick a
  // provider that does not serve the model (crash / 404 not_found at startup).
  // Precedence: explicit `provider/model` override → agent frontmatter
  // `provider:` → the provider that DECLARES this model in models.json (so an
  // Ollama-model agent gets --provider ollama even when the global
  // defaultProvider is anthropic) → Pi's configured default.
  const provider =
    overrideProvider ||
    agent.provider ||
    resolveProviderForModel(model) ||
    resolveDefaultProvider();
  if (provider) args.push("--provider", provider);
  // Per-agent thinking/effort level (frontmatter `thinking:`), e.g. xhigh. The
  // spawned pi subprocess accepts `--thinking <off|minimal|low|medium|high|xhigh>`.
  if (agent.thinking) args.push("--thinking", agent.thinking);
  // This ordinary direct/parallel/chain runner always passes the exact YAML list:
  // no registration subset, additions, removals, trust filtering, or conditionals.
  args.push("--tools", agent.tools.join(","));

  // Select the worker-read memory actor whenever the YAML surface declares a
  // memory tool. Missing backing configuration remains a tool-call error; it
  // must never make a declared tool disappear.
  const memoryReadAccess = agent.tools.some((tool) => tool.startsWith("memory_"));
  const workerEnvironment = ownerSuppliedAgentEnvironment(ownerEnvironment, { memoryReadAccess });
  const parentSessionId = ownerEnvironment?.PENNY_SUBAGENT_PARENT_SESSION_ID ?? getSessionId();
  if (parentSessionId) workerEnvironment.PENNY_SUBAGENT_PARENT_SESSION_ID = parentSessionId;
  workerEnvironment.PENNY_SUBAGENT_PROJECT_ID = sessionState.projectId;
  workerEnvironment.PENNY_SUBAGENT_AGENT_NAME = agentName;
  workerEnvironment.PENNY_SUBAGENT_INVOCATION_ID = randomUUID();

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: modelOverride || agent.model,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  try {
    // Base system prompt = project SYSTEM.md (transformed per-agent), passed
    // explicitly so every agent inherits Penny's frame regardless of spawn
    // cwd/trust. This also prevents the Anthropic OAuth 400 "extra usage"
    // rejection that pi's DEFAULT prompt triggers in multi-turn tool loops.
    const baseSystemPrompt = buildAgentBaseSystemPrompt(agent.name, defaultCwd);
    if (baseSystemPrompt && baseSystemPrompt.trim()) {
      const baseTmp = await writePromptToTempFile(`${agent.name}-base`, baseSystemPrompt);
      tmpBaseDir = baseTmp.dir;
      tmpBasePath = baseTmp.filePath;
      args.push("--system-prompt", tmpBasePath);
    }

    // Combine agent body with optional skill context
    let combinedPrompt = agent.systemPrompt;
    if (skillContextContent && skillContextContent.trim()) {
      const boundaryMarker = "<agent_boundary>";
      const boundaryIdx = combinedPrompt.indexOf(boundaryMarker);
      if (boundaryIdx !== -1) {
        combinedPrompt =
          combinedPrompt.substring(0, boundaryIdx) +
          `\n<skill_context>\n${skillContextContent}\n</skill_context>\n\n` +
          combinedPrompt.substring(boundaryIdx);
      } else {
        combinedPrompt += `\n\n<skill_context>\n${skillContextContent}\n</skill_context>`;
      }
    }

    if (combinedPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, combinedPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${task}`);
    let wasAborted = false;

    let buffer = "";
    let eventCount = 0;
    let lastEventType = "";
    let hasMessageEnd = false;
    let _hasAgentEnd = false;
    // _hasAgentEnd tracked for diagnostics; prefix _ per lint convention.
    // Preserve tracking for future use (e.g., detecting agent_end without process exit).

    const exitCode = await new Promise<number>((resolve) => {
      let resolved = false;

      const resolveOnce = (code: number) => {
        if (resolved) return;
        resolved = true;
        resolve(code);
      };

      const invocation = getPiInvocation(args);
      // stdin = "ignore" so Pi reads /dev/null (immediate EOF).
      // Using "pipe" would keep a writable stream handle in the parent's
      // event loop, preventing Pi's process from exiting cleanly.
      //
      // Pi's print mode exits when the event loop drains. Extensions must not
      // leave referenced sockets, subprocesses, or timers behind.
      //
      // No hard timeout — Pi has internal safety (context limits, cost limits).
      // The abort signal handles user-initiated cancellation.
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        env: workerEnvironment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(parsed)) return;
        const event = parsed;
        const eventMessage = adaptPiJsonMessage(event.message);

        eventCount++;
        lastEventType = typeof event.type === "string" && event.type ? event.type : "unknown";

        // Emit progress events for heartbeat tracking
        if (progressEmitter) {
          if (event.type === "agent_start") {
            progressEmitter.markProgress({ type: "agent_start", timestamp: Date.now() });
          } else if (event.type === "message_end" && eventMessage?.role === "assistant") {
            if (eventMessage.stopReason) {
              progressEmitter.markProgress({ type: "message_end", timestamp: Date.now() });
            }
          } else if (event.type === "tool_result_end" && eventMessage) {
            progressEmitter.markProgress({
              type: "tool_result",
              timestamp: Date.now(),
              detail: eventMessage.role === "toolResult" ? eventMessage.toolName : undefined,
            });
          } else if (event.type === "message" && eventMessage?.role === "toolResult") {
            progressEmitter.markProgress({
              type: "tool_result",
              timestamp: Date.now(),
              detail: eventMessage.toolName,
            });
          }
        }

        if (event.type === "agent_end") {
          _hasAgentEnd = true;
          // Pi's print mode sets process.exitCode and returns from main(). The
          // process exits only after extension-owned event-loop handles drain.
        }

        if (event.type === "message_end" && eventMessage) {
          hasMessageEnd = true;
          currentResult.messages.push(eventMessage);

          if (eventMessage.role === "assistant") {
            currentResult.usage.turns++;
            const usage = eventMessage.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && eventMessage.model) {
              currentResult.model = eventMessage.model;
            }
            if (eventMessage.stopReason) currentResult.stopReason = eventMessage.stopReason;
            if (eventMessage.errorMessage) currentResult.errorMessage = eventMessage.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && eventMessage) {
          const captured = captureToolResultForExecutionOwner(eventMessage);
          const capturedMessage = adaptPiJsonMessage(captured);
          if (capturedMessage) {
            currentResult.messages.push(capturedMessage);
            emitUpdate();
          }
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolveOnce(code ?? 0);
      });

      proc.on("error", (err) => {
        logger.error(
          "Agent spawn failed",
          { agent: agentName, error: err.message },
          Object.assign(err, { code: "AGENT_SPAWN_ERROR" as const })
        );
        resolveOnce(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Agent was aborted");

    if (!hasMessageEnd && eventCount > 0) {
      logger.warn(
        "Agent completed without message_end",
        { agent: agentName, events: eventCount, lastType: lastEventType, exitCode },
        Object.assign(new Error("Completed without message_end"), {
          code: "AGENT_INCOMPLETE" as const,
        })
      );
      // Agent process exited cleanly (exitCode 0) but never emitted message_end.
      // This happens when Pi's SSE stream is killed mid-generation (e.g., 5-min
      // body timeout in undici before 0.70.3) or when the agent crashes without
      // emitting its final message. We must propagate this as an error so the
      // skill extension does NOT treat it as success.
      currentResult.errorMessage =
        currentResult.errorMessage ||
        `Agent '${agentName}' completed without emitting message_end. ` +
          `The agent may have been killed by a timeout or crashed. ` +
          `Events received: ${eventCount}, last event: ${lastEventType}, exit code: ${exitCode}. ` +
          `Check Pi logs for SSE timeout or process errors. ` +
          `Common cause: Pi version < 0.70.3 had a 5-minute SSE body timeout.`;
      currentResult.stopReason = currentResult.stopReason || "incomplete";
      if (currentResult.exitCode === 0) {
        // Process exited cleanly but without a message — treat as failure
        currentResult.exitCode = 1;
      }
    }
    if (currentResult.exitCode !== 0) {
      logger.warn("Agent process exited with non-zero code", {
        agent: agentName,
        exitCode: currentResult.exitCode,
      });
    } else {
      logger.info("Agent completed", {
        agent: agentName,
        events: eventCount,
        exitCode: currentResult.exitCode,
      });
    }

    return currentResult;
  } finally {
    try {
      hardenDurableSubagentSessions(durableSessionDir);
      const removed = pruneDurableSubagentSessions(durableSessionDir);
      if (removed.length > 0) {
        logger.info("Pruned durable subagent sessions", {
          agent: agentName,
          count: removed.length,
        });
      }
    } catch (error) {
      logger.warn("Durable subagent session retention failed closed", {
        agent: agentName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
    if (tmpBasePath)
      try {
        fs.unlinkSync(tmpBasePath);
      } catch {
        /* ignore */
      }
    if (tmpBaseDir)
      try {
        fs.rmdirSync(tmpBaseDir);
      } catch {
        /* ignore */
      }
  }
}

/**
 * Run multiple agents in parallel with concurrency limiting.
 *
 * @param defaultCwd - Default working directory
 * @param agents - Discovered agent configs
 * @param tasks - Array of task specifications
 * @param signal - Abort signal
 * @param makeDetails - Factory for creating SubagentDetails
 * @returns Array of results, one per task
 */
export async function runAgentsParallel(
  defaultCwd: string,
  agents: AgentConfig[],
  tasks: Array<{
    agent: string;
    task: string;
    cwd?: string;
    skillContext?: string;
  }>,
  signal: AbortSignal | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails
): Promise<SingleResult[]> {
  if (tasks.length > MAX_PARALLEL_TASKS) {
    throw new Error(`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
  }

  const allResults = tasks.map((task) => createPendingSingleResult(task.agent, task.task));

  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
    const result = await runSingleAgent(
      defaultCwd,
      agents,
      t.agent,
      t.task,
      t.cwd,
      undefined,
      signal,
      undefined, // No streaming updates for parallel - the caller handles aggregation
      makeDetails,
      resolveSkillContext(t.skillContext, defaultCwd)
    );
    allResults[index] = result;
    return result;
  });

  return results;
}
