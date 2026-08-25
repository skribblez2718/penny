import { registerTool } from "../../lib/pi-tool-registration.js";
import { createHash } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { createLogger, setSessionId } from "../../lib/logger/logger.js";
import { MemoryAdapter } from "./adapter.js";
import { loadMemoryRuntimeConfig, loadWorkerReadConfig, resolveMemoryActor } from "./config.js";
import { MemoryLogstreamAdapter } from "./logstream-adapter.js";
import { MemoryLogstreamClient } from "./logstream-client.js";
import { createPrimaryLogstreamTools } from "./logstream-tools.js";
import { createPrimaryMemoryTools, createUnavailableMemoryTools } from "./tools.js";
import type { MemoryAdapterDependencies, MemoryTelemetry } from "./types.js";

const logger = createLogger("memory");
const AUTO_DIARY_MAX_BYTES = 2_048;

interface SessionEntryProjection {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function hasPhase(value: unknown, phase: string): boolean {
  return isUnknownRecord(value) && value.phase === phase;
}

function errorCodeFrom(value: unknown, fallback: string): string {
  return typeof value === "object" && value !== null && "code" in value
    ? String(value.code)
    : fallback;
}
export interface MemoryExtensionOptions extends MemoryAdapterDependencies {
  env?: Readonly<Record<string, string | undefined>>;
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

/** Build a bounded, content-free diary summary directly from canonical Pi JSONL entries. */
export function buildDiaryFromSessionEntries(
  currentSessionId: string,
  reason: string,
  entries: readonly SessionEntryProjection[]
): string | null {
  const today = new Date().toISOString().split("T")[0];
  const boundedEntries = entries.slice(-5_000);
  const agentCount = boundedEntries.filter(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "penny.observability.agent-lifecycle" &&
      hasPhase(entry.data, "start")
  ).length;
  const toolCounts = new Map<string, number>();
  for (const entry of boundedEntries) {
    const role = stringProperty(entry.message, "role");
    const rawName =
      entry.type === "message" && role === "toolResult"
        ? stringProperty(entry.message, "toolName")
        : undefined;
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
        const errorCode = errorCodeFrom(error, "MEMPALACE_CONFIG_INVALID");
        logger.warn("Memory worker-read unavailable: invalid configuration", { errorCode });
        for (const tool of createUnavailableMemoryTools({
          writeEnabled: false,
          code: errorCode,
        })) {
          registerTool(pi, tool);
        }
        return;
      }
      if (workerConfig.mode === "disabled") {
        for (const tool of createUnavailableMemoryTools({ writeEnabled: false })) {
          registerTool(pi, tool);
        }
        return;
      }

      const workerAdapter = new MemoryAdapter(workerConfig, options);
      const workerTelemetry: MemoryTelemetry = {
        info(event, context) {
          logger.info(event, context);
        },
        warn(event, context) {
          logger.warn(event, context);
        },
      };

      for (const tool of createPrimaryMemoryTools({
        adapter: workerAdapter,
        callerId: () => "worker-read",
        writeEnabled: false,
        telemetry: workerTelemetry,
      })) {
        registerTool(pi, tool);
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
        errorCode: errorCodeFrom(error, "MEMPALACE_CONFIG_INVALID"),
      });
      return;
    }
    if (config.mode === "disabled") return;

    const adapter = new MemoryAdapter(config, options);

    let currentSessionId = "";
    const diarySessions = new Set<string>();
    const telemetry: MemoryTelemetry = {
      info(event, context) {
        logger.info(event, context);
      },
      warn(event, context) {
        logger.warn(event, context);
      },
    };

    const callerId = () => `primary:${currentSessionId || "unbound"}`;
    for (const tool of createPrimaryMemoryTools({
      adapter,
      callerId,
      writeEnabled: config.writeEnabled,
      telemetry,
    })) {
      registerTool(pi, tool);
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
        registerTool(pi, tool);
      }
    }

    pi.on("session_start", async (_event: SessionStartEvent, context: ExtensionContext) => {
      currentSessionId = context.sessionManager.getSessionId();
      setSessionId(currentSessionId);
    });

    pi.on("session_shutdown", async (event: SessionShutdownEvent, context: ExtensionContext) => {
      if (!config.writeEnabled) return;
      const session = currentSessionId;
      if (!session || diarySessions.has(session)) return;
      diarySessions.add(session);
      try {
        const entry = buildDiaryFromSessionEntries(
          session,
          event?.reason || "unknown",
          context.sessionManager.getEntries()
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
          errorCode: errorCodeFrom(error, "MEMPALACE_UNAVAILABLE"),
        });
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
