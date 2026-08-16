import { Type, type TSchema } from "@sinclair/typebox";

import { assessReleaseHeadroom } from "../lib/tool-result-budget.js";
import type { MemoryLogstreamAdapter } from "./logstream-adapter.js";
import {
  LOGSTREAM_MODEL_MAX_BODY_CHARACTERS,
  LOGSTREAM_MODEL_MAX_LIST_LIMIT,
  LOGSTREAM_MODEL_MAX_WAIT_TIMEOUT_MS,
  SAFE_ADVISORY_EVENT_TYPES,
  UPSTREAM_LOGSTREAM_STATUSES,
} from "./logstream-adapter.js";
import type { LogstreamOperation, MemoryCallContext, MemoryTelemetry } from "./types.js";

const CorrelationSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
  description: "Bounded advisory conversation correlation",
});
const EventIdSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
  description: "Advisory event id returned by this surface",
});
const CursorSchema = Type.Optional(
  Type.String({ minLength: 1, maxLength: 4096, description: "Opaque continuation cursor" })
);
const TypeSchema = Type.String({
  enum: [...SAFE_ADVISORY_EVENT_TYPES],
  description: "Fixed advisory-only event type",
});
const OptionalTypeSchema = Type.Optional(TypeSchema);
const OptionalStatusSchema = Type.Optional(
  Type.String({
    enum: [...UPSTREAM_LOGSTREAM_STATUSES],
    description: "One upstream MemPalace event status",
  })
);
const OptionalBodySchema = Type.Optional(
  Type.String({
    maxLength: LOGSTREAM_MODEL_MAX_BODY_CHARACTERS,
    description:
      "Bounded free-form advisory text; by policy it is never consumed as artifact handoff, workflow state, a persistence receipt, or recovery input",
  })
);

interface LogstreamToolDefinition {
  operation: LogstreamOperation;
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  write: boolean;
}

function definitions(rooms: readonly string[]): readonly LogstreamToolDefinition[] {
  const roomSchema = Type.String({
    enum: [...rooms],
    description: "Configured advisory room allowlist entry",
  });
  const readProperties = {
    room: roomSchema,
    type: OptionalTypeSchema,
    correlation_id: Type.Optional(CorrelationSchema),
    status: OptionalStatusSchema,
    since_event_id: Type.Optional(EventIdSchema),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: LOGSTREAM_MODEL_MAX_LIST_LIMIT, default: 10 })
    ),
    cursor: CursorSchema,
  };

  return [
    {
      operation: "logstream_append",
      name: "memory_logstream_append",
      label: "Memory: advisory log append",
      description:
        "Append one self-addressed advisory event in the pinned stream and principal. Its free-form body is non-authoritative advice by policy; no artifact/patch endpoint or reference is exposed.",
      parameters: Type.Object(
        {
          type: TypeSchema,
          room: roomSchema,
          correlation_id: CorrelationSchema,
          status: OptionalStatusSchema,
          body: OptionalBodySchema,
          cursor: CursorSchema,
        },
        { additionalProperties: false }
      ),
      write: true,
    },
    {
      operation: "logstream_list",
      name: "memory_logstream_list",
      label: "Memory: advisory log list",
      description:
        "List a bounded set of strictly self-addressed, non-broadcast advisory events from one configured room. Oversized results use typed exact continuation.",
      parameters: Type.Object(readProperties, { additionalProperties: false }),
      write: false,
    },
    {
      operation: "logstream_wait",
      name: "memory_logstream_wait",
      label: "Memory: advisory log wait",
      description:
        "Wait briefly for bounded, strictly self-addressed advisory events in one configured room. Broadcasts are rejected; this is polling only, not a live stream or workflow checkpointer.",
      parameters: Type.Object(
        {
          ...readProperties,
          timeout_ms: Type.Optional(
            Type.Integer({
              minimum: 0,
              maximum: LOGSTREAM_MODEL_MAX_WAIT_TIMEOUT_MS,
              default: 1000,
            })
          ),
        },
        { additionalProperties: false }
      ),
      write: false,
    },
    {
      operation: "logstream_ack",
      name: "memory_logstream_ack",
      label: "Memory: advisory log acknowledge",
      description:
        "Append one acknowledgement only after a bounded read proves the target belongs to the pinned stream, principal, and supplied correlation.",
      parameters: Type.Object(
        {
          event_id: EventIdSchema,
          correlation_id: CorrelationSchema,
          status: OptionalStatusSchema,
          body: OptionalBodySchema,
          cursor: CursorSchema,
        },
        { additionalProperties: false }
      ),
      write: true,
    },
  ];
}

export function createPrimaryLogstreamTools(options: {
  adapter: MemoryLogstreamAdapter;
  callerId: () => string;
  rooms: readonly string[];
  writeEnabled: boolean;
  telemetry?: MemoryTelemetry;
}) {
  return definitions(options.rooms)
    .filter((definition) => options.writeEnabled || !definition.write)
    .map((definition) => ({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
        const startedAt = Date.now();
        const context: MemoryCallContext = { callerId: options.callerId(), signal };
        const execution = await options.adapter.execute(definition.operation, params, context);
        const sessionCorrelationKey = context.callerId.startsWith("primary:")
          ? `session:${context.callerId.slice("primary:".length)}`
          : `caller:${context.callerId}`;
        const metadata = {
          tool: definition.name,
          operation: definition.operation,
          requestId: execution.requestId,
          code: execution.code,
          serializedBytes: execution.serializedBytes,
          estimatedTokens: execution.estimatedTokens,
          releaseHeadroom: assessReleaseHeadroom(execution.estimatedTokens),
          truncated: execution.truncated,
          page: execution.page,
          compactionCorrelation: {
            status: "not_evaluated",
            keys: [sessionCorrelationKey],
          },
          durationMs: Date.now() - startedAt,
        };
        if (execution.code === "OK") options.telemetry?.info("memory_tool_result", metadata);
        else options.telemetry?.warn("memory_tool_error", metadata);
        return execution.result;
      },
    }));
}

export function primaryLogstreamToolNames(options: { writeEnabled?: boolean } = {}): string[] {
  return definitions(["configured-room"])
    .filter((definition) => options.writeEnabled === true || !definition.write)
    .map((definition) => definition.name);
}
