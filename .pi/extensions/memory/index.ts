import { createHash } from "node:crypto";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { WebSocket } from "ws";

import { createLogger, setSessionId } from "../../lib/logger/logger.js";
import { MemoryAdapter } from "./adapter.js";
import { loadMemoryRuntimeConfig, loadWorkerReadConfig, resolveMemoryActor } from "./config.js";
import { MemoryLogstreamAdapter } from "./logstream-adapter.js";
import { MemoryLogstreamClient } from "./logstream-client.js";
import { createPrimaryLogstreamTools } from "./logstream-tools.js";
import { createPrimaryMemoryTools } from "./tools.js";
import type { MemoryAdapterDependencies, MemoryTelemetry } from "./types.js";

const logger = createLogger("memory");
const AUTO_DIARY_MAX_BYTES = 2_048;
const OBSERVABILITY_TIMEOUT_MS = 5_000;

interface SessionStartContext {
  sessionManager: { getSessionId(): string };
}
interface SessionShutdownEvent {
  reason?: string;
}
interface ObservabilityEntry {
  data?: { toolName?: string };
}
interface ObservabilityEntriesResponse {
  items: ObservabilityEntry[];
  total?: number;
}

export interface MemoryExtensionOptions extends MemoryAdapterDependencies {
  env?: Readonly<Record<string, string | undefined>>;
}

function isEntriesResponse(value: unknown): value is ObservabilityEntriesResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

function boundedLabel(value: string, maximum = 64): string {
  return Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? -1;
      return codePoint < 32 || codePoint === 127 || character === "|" ? "_" : character;
    })
    .slice(0, maximum)
    .join("");
}

export async function observabilityRestFetch(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OBSERVABILITY_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Build a bounded, content-free operational diary summary from observability metadata. */
export async function buildDiaryFromObservability(
  currentSessionId: string,
  reason: string,
  observabilityUrl: string,
  observabilityApiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const today = new Date().toISOString().split("T")[0];
  const restBase = observabilityUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
  const encodedSession = encodeURIComponent(currentSessionId);
  const agentsUrl = `${restBase}/sessions/${encodedSession}/entries?event_type=agent_start&limit=500`;
  const toolsUrl = `${restBase}/sessions/${encodedSession}/entries?event_type=tool_execution_start&limit=500`;
  const [agentsResponse, toolsResponse] = await Promise.all([
    observabilityRestFetch(agentsUrl, observabilityApiKey, fetchImpl),
    observabilityRestFetch(toolsUrl, observabilityApiKey, fetchImpl),
  ]);
  if (!isEntriesResponse(agentsResponse) || !isEntriesResponse(toolsResponse)) return null;

  const agentCount =
    typeof agentsResponse.total === "number" ? agentsResponse.total : agentsResponse.items.length;
  const toolCounts = new Map<string, number>();
  for (const item of toolsResponse.items.slice(0, 500)) {
    const rawName = item.data?.toolName;
    if (typeof rawName !== "string" || rawName.length === 0) continue;
    const name = boundedLabel(rawName);
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
  }
  const tools = [...toolCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([name, count]) => `${name}(${count})`)
    .join("+");
  const sessionDigest = createHash("sha256")
    .update(currentSessionId, "utf8")
    .digest("hex")
    .slice(0, 12);
  const entry =
    `SESSION:${today}|session-end|Session:${sessionDigest}. Agents:${agentCount}. ` +
    `Tools:${tools || "none"}. Reason:${boundedLabel(reason)}|★★`;
  if (Buffer.byteLength(entry, "utf8") > AUTO_DIARY_MAX_BYTES) return null;
  return entry;
}

function createObservability(options: { enabled: boolean; url: string; apiKey: string }): {
  connect(): void;
  emit(event: string, data: Record<string, unknown>): void;
  close(): void;
} {
  let socket: WebSocket | null = null;
  let connected = false;
  let closed = false;

  const connect = () => {
    if (!options.enabled || closed) return;
    try {
      const url = new URL(options.url);
      if (options.apiKey) url.searchParams.set("apiKey", options.apiKey);
      socket = new WebSocket(url.toString());
      socket.on("open", () => {
        connected = true;
        const underlying = (socket as unknown as { _socket?: { unref?: () => void } })._socket;
        underlying?.unref?.();
      });
      socket.on("close", () => {
        connected = false;
        if (!closed) {
          const timer = setTimeout(connect, 5_000);
          timer.unref();
        }
      });
      socket.on("error", () => {
        connected = false;
      });
    } catch {
      logger.debug("Memory observability connection failed", { enabled: options.enabled });
    }
  };

  return {
    connect,
    emit(event, data) {
      if (!connected || !socket) return;
      try {
        socket.send(JSON.stringify({ event: `memory_${event}`, timestamp: Date.now(), data }));
      } catch {
        logger.debug("Memory observability emit failed", { event });
      }
    },
    close() {
      closed = true;
      socket?.close();
      socket = null;
      connected = false;
    },
  };
}

export function createMemoryExtension(options: MemoryExtensionOptions = {}) {
  return function memoryExtension(pi: ExtensionAPI): void {
    const env = options.env ?? process.env;

    // Runtime markers are deny-only. Resolve role before any config, network,
    // tool registration, or shutdown hook so workers cannot turn a marker into
    // a grant and do not contact the memory plane at all.
    const actor = resolveMemoryActor(env);
    if (actor === "denied") return;

    // ---- Worker-read branch: read-only memory tools for spawned agents ----
    //
    // The execution owner (agent-runner) sets PENNY_RUNTIME_ROLE=worker-read
    // and passes through a minimal set of read-only memory env vars. The
    // memory extension registers only read tools (writeEnabled=false filters
    // out all write operations). No auto-diary, no logstream, no KG mutation.
    if (actor === "worker-read") {
      let workerConfig;
      try {
        workerConfig = loadWorkerReadConfig(env);
      } catch (error) {
        logger.warn("Memory worker-read disabled: invalid configuration", {
          errorCode:
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code: unknown }).code)
              : "MEMPALACE_CONFIG_INVALID",
        });
        return;
      }
      if (workerConfig.mode === "disabled") return;

      const workerAdapter = new MemoryAdapter(workerConfig, options);
      const workerTelemetry: MemoryTelemetry = {
        info(event, context) { logger.info(event, context); },
        warn(event, context) { logger.warn(event, context); },
      };

      for (const tool of createPrimaryMemoryTools({
        adapter: workerAdapter,
        callerId: () => "worker-read",
        writeEnabled: false,
        telemetry: workerTelemetry,
      })) {
        pi.registerTool(tool);
      }

      // No session_shutdown auto-diary hook for workers.
      // No logstream tools for workers.
      return;
    }

    // ---- Primary branch: full memory tools for the main Penny session ----

    let config;
    try {
      config = loadMemoryRuntimeConfig(env);
    } catch (error) {
      // Durable recall is optional and authority-neutral. Missing or invalid hub
      // configuration must fail closed by exposing no memory tools; it must not
      // prevent Pi, workers, or memory-absent workflows from starting.
      logger.warn("Memory extension disabled: invalid hub configuration", {
        errorCode:
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : "MEMPALACE_CONFIG_INVALID",
      });
      return;
    }
    if (config.mode === "disabled") return;

    const adapter = new MemoryAdapter(config, options);
    const observabilityUrl = env.PI_OBSERVABILITY_URL || "ws://localhost:8765/ws";
    const observabilityApiKey = env.PI_OBSERVABILITY_API_KEY || "";
    const observability = createObservability({
      enabled: env.PI_OBSERVABILITY_ENABLED !== "false",
      url: observabilityUrl,
      apiKey: observabilityApiKey,
    });
    observability.connect();

    let currentSessionId = "";
    const diarySessions = new Set<string>();
    const telemetry: MemoryTelemetry = {
      info(event, context) {
        logger.info(event, context);
        observability.emit(event, context);
      },
      warn(event, context) {
        logger.warn(event, context);
        observability.emit(event, context);
      },
    };

    const callerId = () => `primary:${currentSessionId || "unbound"}`;
    for (const tool of createPrimaryMemoryTools({
      adapter,
      callerId,
      writeEnabled: config.writeEnabled,
      telemetry,
    })) {
      pi.registerTool(tool);
    }

    if (config.logstream.mode === "primary-advisory") {
      const logstreamClient = new MemoryLogstreamClient(config, options);
      const logstreamAdapter = new MemoryLogstreamAdapter(config, adapter, logstreamClient);
      for (const tool of createPrimaryLogstreamTools({
        adapter: logstreamAdapter,
        callerId,
        rooms: config.logstream.rooms,
        writeEnabled: config.writeEnabled,
        telemetry,
      })) {
        pi.registerTool(tool);
      }
    }

    pi.on("session_start", async (_event: unknown, context: SessionStartContext) => {
      currentSessionId = context.sessionManager.getSessionId();
      setSessionId(currentSessionId);
    });

    pi.on("session_shutdown", async (event: SessionShutdownEvent) => {
      observability.emit("session_end", { reason: boundedLabel(event?.reason || "unknown") });
      if (!config.writeEnabled) {
        observability.close();
        return;
      }
      const session = currentSessionId;
      if (!session || diarySessions.has(session)) {
        observability.close();
        return;
      }
      diarySessions.add(session);
      try {
        const entry = await buildDiaryFromObservability(
          session,
          event?.reason || "unknown",
          observabilityUrl,
          observabilityApiKey,
          options.fetch ?? fetch
        );
        if (!entry) {
          logger.warn("Primary auto-diary skipped", {
            sessionId: session,
            reason: "bounded observability metadata unavailable",
          });
          diarySessions.delete(session);
          return;
        }

        const duplicate = await adapter.invokeRaw("check_duplicate", {
          content: entry,
          threshold: 0.99,
        });
        if (duplicate.payload.is_duplicate === true) {
          logger.info("Primary auto-diary duplicate suppressed", { sessionId: session });
          return;
        }
        const written = await adapter.invokeRaw("diary_write", {
          agent_name: "penny",
          entry,
          topic: "session-end",
        });
        if (written.payload.success === false || typeof written.payload.error === "string") {
          throw new Error("hub refused auto-diary write");
        }
        logger.info("Primary auto-diary written", {
          sessionId: session,
          entryBytes: Buffer.byteLength(entry, "utf8"),
          requestId: written.requestId,
        });
      } catch (error) {
        diarySessions.delete(session);
        logger.warn("Primary auto-diary failed", {
          sessionId: session,
          errorCode:
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code: unknown }).code)
              : "MEMPALACE_UNAVAILABLE",
        });
      } finally {
        observability.close();
      }
    });
  };
}

export default createMemoryExtension();

export { MemoryAdapter } from "./adapter.js";
export { loadMemoryRuntimeConfig, loadWorkerReadConfig, resolveMemoryActor } from "./config.js";
export { CANONICAL_KG_PREDICATES, KG_PREDICATE_SCHEMA_VERSION } from "./kg-policy.js";
export {
  LOGSTREAM_MODEL_MAX_BODY_BYTES,
  LOGSTREAM_MODEL_MAX_BODY_CHARACTERS,
  LOGSTREAM_MODEL_MAX_LIST_LIMIT,
  LOGSTREAM_MODEL_MAX_WAIT_TIMEOUT_MS,
  SAFE_ADVISORY_EVENT_TYPES,
  UPSTREAM_LOGSTREAM_STATUSES,
} from "./logstream-adapter.js";
export { createPrimaryLogstreamTools, primaryLogstreamToolNames } from "./logstream-tools.js";
export { MemoryMcpClient, SAFE_READ_TOOLS } from "./mcp-client.js";
export {
  FORBIDDEN_MODEL_MEMORY_TOOLS,
  PRIMARY_MEMORY_TOOL_BUNDLES,
  primaryMemoryToolNames,
} from "./tools.js";
export { MemoryError } from "./types.js";
export type {
  LogstreamOperation,
  MemoryErrorCode,
  MemoryExecution,
  MemoryLogstreamConfig,
  MemoryOperation,
  MemoryResultOperation,
  MemoryRuntimeConfig,
} from "./types.js";
