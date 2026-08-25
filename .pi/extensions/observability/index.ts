import { registerTool } from "../../lib/pi-tool-registration.js";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI, SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  SessionManager,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { resolvePennyProjectState } from "@penny/orchestration/source";

import { createLogger, setSessionId, type ErrorCode } from "../../lib/logger/logger.js";

const logger = createLogger("observability");
const HISTORY_CUSTOM_TYPE = "penny.observability.agent-lifecycle";
const SUBAGENT_CUSTOM_TYPE = "penny.subagent.session";

const QueryLogsParamsSchema = Type.Object({
  level: Type.Optional(Type.String()),
  component: Type.Optional(Type.String()),
  session_id: Type.Optional(Type.String()),
  from_ts: Type.Optional(Type.Number()),
  to_ts: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  offset: Type.Optional(Type.Number({ minimum: 0 })),
});

export type QueryLogsParams = Static<typeof QueryLogsParamsSchema>;

const QueryHistoryParamsSchema = Type.Object({
  session_id: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  offset: Type.Optional(Type.Number({ minimum: 0 })),
});

export type QueryHistoryParams = Static<typeof QueryHistoryParamsSchema>;

interface SessionProjection {
  readonly id: string;
  readonly cwd: string;
  readonly name?: string;
  readonly created: string;
  readonly modified: string;
  readonly message_count: number;
  readonly first_message: string;
  readonly storage: "pi" | "subagent";
}

function restBaseUrl(): string {
  const configured = process.env.PI_OBSERVABILITY_REST_URL?.trim();
  if (!configured) return "http://127.0.0.1:8765";
  const parsed = new URL(configured);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PI_OBSERVABILITY_REST_URL must be HTTP(S)");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function apiKey(): string {
  return process.env.PI_OBSERVABILITY_API_KEY?.trim() ?? "";
}

async function observabilityFetch(
  pathname: string,
  options: { readonly method?: "GET" | "POST"; readonly body?: unknown } = {}
): Promise<unknown> {
  const base = restBaseUrl();
  const headers: Record<string, string> = { accept: "application/json" };
  const key = apiKey();
  if (key) headers.authorization = `Bearer ${key}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${base}${pathname}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`observability service unavailable at ${base}: ${message}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`observability service returned ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

async function serviceAlive(): Promise<boolean> {
  try {
    const response = await fetch(`${restBaseUrl()}/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

function startService(): void {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const entry = path.join(projectRoot, "apps", "observability", "dist", "server.js");
  if (!existsSync(entry)) {
    logger.warn(
      "TypeScript observability service is not built",
      { entry },
      Object.assign(new Error("observability build missing"), {
        code: "OBSERVABILITY_SERVER_SPAWN_FAILED" as ErrorCode,
      })
    );
    return;
  }
  const child = spawn(process.execPath, [entry], {
    cwd: projectRoot,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.once("error", (error) => {
    logger.warn("TypeScript observability service failed to start", { error: error.message });
  });
  child.unref();
}

async function waitForService(): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await serviceAlive()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function sessionProjection(info: SessionInfo, storage: "pi" | "subagent"): SessionProjection {
  return {
    id: info.id,
    cwd: info.cwd,
    ...(info.name ? { name: info.name } : {}),
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    message_count: info.messageCount,
    first_message: info.firstMessage,
    storage,
  };
}

async function subagentSessions(cwd: string): Promise<SessionInfo[]> {
  let root: string;
  try {
    root = resolvePennyProjectState(cwd).paths.subagentSessions;
  } catch {
    return [];
  }
  const sessions: SessionInfo[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    const stat = lstatSync(candidate);
    if (!entry.isDirectory() || stat.isSymbolicLink()) continue;
    sessions.push(...(await SessionManager.list(cwd, candidate)));
  }
  return sessions;
}

async function allSessions(
  cwd: string
): Promise<Array<{ readonly info: SessionInfo; readonly storage: "pi" | "subagent" }>> {
  const [main, subagents] = await Promise.all([SessionManager.listAll(), subagentSessions(cwd)]);
  const seen = new Set<string>();
  return [
    ...main.map((info) => ({ info, storage: "pi" as const })),
    ...subagents.map((info) => ({ info, storage: "subagent" as const })),
  ].filter(({ info }) => {
    if (seen.has(info.path)) return false;
    seen.add(info.path);
    return true;
  });
}

function boundedToolText(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  const bounded = truncateHead(serialized, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!bounded.truncated) return bounded.content;
  return `${bounded.content}\n\n[History page truncated to ${DEFAULT_MAX_BYTES} bytes/${DEFAULT_MAX_LINES} lines. Reduce limit or increase offset.]`;
}

function parentMetadataAlreadyPresent(entries: readonly SessionEntry[]): boolean {
  const invocationId = process.env.PENNY_SUBAGENT_INVOCATION_ID;
  return entries.some(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === SUBAGENT_CUSTOM_TYPE &&
      typeof entry.data === "object" &&
      entry.data !== null &&
      (entry.data as { invocation_id?: unknown }).invocation_id === invocationId
  );
}

export default function observabilityExtension(pi: ExtensionAPI): void {
  let currentCwd = process.cwd();
  let currentSessionId = "";
  let serviceStarted = false;

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd;
    currentSessionId = ctx.sessionManager.getSessionId();
    setSessionId(currentSessionId);

    const parentSessionId = process.env.PENNY_SUBAGENT_PARENT_SESSION_ID;
    const projectId = process.env.PENNY_SUBAGENT_PROJECT_ID;
    const agentName = process.env.PENNY_SUBAGENT_AGENT_NAME;
    const invocationId = process.env.PENNY_SUBAGENT_INVOCATION_ID;
    if (
      parentSessionId &&
      projectId &&
      agentName &&
      invocationId &&
      !parentMetadataAlreadyPresent(ctx.sessionManager.getEntries())
    ) {
      pi.appendEntry(SUBAGENT_CUSTOM_TYPE, {
        schema_version: 1,
        project_id: projectId,
        agent_name: agentName,
        parent_session_id: parentSessionId,
        invocation_id: invocationId,
      });
    }

    if (
      process.env.PI_OBSERVABILITY_ENABLED !== "false" &&
      process.env.PI_OBSERVABILITY_AUTO_START !== "false" &&
      !serviceStarted &&
      !(await serviceAlive())
    ) {
      serviceStarted = true;
      startService();
      if (!(await waitForService())) {
        logger.warn("TypeScript observability service did not become ready");
      }
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    pi.appendEntry(HISTORY_CUSTOM_TYPE, {
      schema_version: 1,
      phase: "start",
      model: ctx.model?.id,
      provider: ctx.model?.provider,
    });
  });

  pi.on("agent_end", async (event) => {
    pi.appendEntry(HISTORY_CUSTOM_TYPE, {
      schema_version: 1,
      phase: "end",
      message_count: event.messages?.length ?? 0,
    });
  });

  pi.on(
    "session_compact",
    async (event: {
      readonly compactionEntry?: {
        readonly summary?: string;
        readonly timestamp?: string;
        readonly details?: unknown;
      };
    }) => {
      const entry = event.compactionEntry;
      if (!entry?.summary) return;
      try {
        await observabilityFetch("/compactions", {
          method: "POST",
          body: {
            session_id: currentSessionId || "unknown",
            timestamp: entry.timestamp,
            summary: entry.summary,
            details: entry.details,
          },
        });
      } catch {
        // Compaction persistence in Pi JSONL remains authoritative.
      }
    }
  );

  registerTool(pi, {
    name: "observability_query_logs",
    label: "Query Observability Logs",
    description:
      "Query bounded structured operational logs from Penny's canonical TypeScript observability service. This surface contains no conversation transcript; use observability_query_history for Pi session history.",
    promptSnippet: "Query bounded structured operational logs",
    parameters: QueryLogsParamsSchema,
    async execute(_toolCallId, params) {
      try {
        const query = new URLSearchParams();
        if (params.level) query.set("level", params.level);
        if (params.component) query.set("component", params.component);
        if (params.session_id) query.set("session_id", params.session_id);
        if (params.from_ts !== undefined) query.set("from_ts", String(params.from_ts));
        if (params.to_ts !== undefined) query.set("to_ts", String(params.to_ts));
        if (params.limit !== undefined) query.set("limit", String(params.limit));
        if (params.offset !== undefined) query.set("offset", String(params.offset));
        const data = await observabilityFetch(`/logs?${query.toString()}`);
        return {
          content: [{ type: "text" as const, text: boundedToolText(data) }],
          details: undefined,
        };
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          code: "OBSERVABILITY_QUERY_LOGS_FAILED" as ErrorCode,
        });
      }
    },
  });

  registerTool(pi, {
    name: "observability_query_history",
    label: "Query Pi Session History",
    description:
      "Read bounded conversation history directly from Pi's canonical JSONL sessions, including catalog-bound subagent sessions. It remains available while the observability service is stopped and preserves complete entry bodies within the stated output limit.",
    promptSnippet: "Read bounded Pi JSONL session history without the observability service",
    parameters: QueryHistoryParamsSchema,
    async execute(_toolCallId, params) {
      try {
        const limit = params.limit ?? 50;
        const offset = params.offset ?? 0;
        const sessions = await allSessions(currentCwd);
        sessions.sort(
          (left, right) => right.info.modified.getTime() - left.info.modified.getTime()
        );
        if (!params.session_id) {
          const page = sessions
            .slice(offset, offset + limit)
            .map(({ info, storage }) => sessionProjection(info, storage));
          return {
            content: [
              {
                type: "text" as const,
                text: boundedToolText({ sessions: page, limit, offset, total: sessions.length }),
              },
            ],
            details: undefined,
          };
        }
        const match = sessions.find(({ info }) => info.id === params.session_id);
        if (!match) throw new Error("session not found");
        const manager = SessionManager.open(match.info.path);
        const entries = manager.getEntries();
        const page = entries.slice(offset, offset + limit);
        return {
          content: [
            {
              type: "text" as const,
              text: boundedToolText({
                session: sessionProjection(match.info, match.storage),
                entries: page,
                limit,
                offset,
                total: entries.length,
              }),
            },
          ],
          details: undefined,
        };
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          code: "OBSERVABILITY_QUERY_HISTORY_FAILED" as ErrorCode,
        });
      }
    },
  });

  pi.registerCommand("observability-status", {
    description: "Check the canonical TypeScript observability service",
    handler: async (_arguments, ctx) => {
      ctx.ui.notify(
        (await serviceAlive())
          ? "Observability: canonical TypeScript service is healthy"
          : "Observability: service unavailable; direct Pi history remains available",
        "info"
      );
    },
  });
}
