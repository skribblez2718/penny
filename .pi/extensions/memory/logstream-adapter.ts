import type { MemoryAdapter } from "./adapter.js";
import { MemoryLogstreamClient } from "./logstream-client.js";
import {
  MemoryError,
  type LogstreamOperation,
  type MemoryCallContext,
  type MemoryExecution,
  type MemoryRuntimeConfig,
} from "./types.js";

export const SAFE_ADVISORY_EVENT_TYPES = Object.freeze([
  "advisory.note",
  "advisory.status",
  "advisory.question",
  "advisory.reply",
] as const);
export const UPSTREAM_LOGSTREAM_STATUSES = Object.freeze([
  "open",
  "claimed",
  "ready",
  "applied",
  "blocked",
  "failed",
  "superseded",
] as const);
export const LOGSTREAM_MODEL_MAX_BODY_BYTES = 8_192;
export const LOGSTREAM_MODEL_MAX_BODY_CHARACTERS = 8_192;
export const LOGSTREAM_MODEL_MAX_LIST_LIMIT = 20;
export const LOGSTREAM_MODEL_MAX_WAIT_TIMEOUT_MS = 5_000;

export type AdvisoryEventType = (typeof SAFE_ADVISORY_EVENT_TYPES)[number];
export type AdvisoryEventStatus = (typeof UPSTREAM_LOGSTREAM_STATUSES)[number];

interface AdvisoryEvent {
  event_id: string;
  type: AdvisoryEventType | "event.ack";
  room: string;
  correlation_id: string;
  status: AdvisoryEventStatus | null;
  body: string;
  created_at: string;
  ack_of?: string;
}

const SAFE_TYPE_SET = new Set<string>(SAFE_ADVISORY_EVENT_TYPES);
const STATUS_SET = new Set<string>(UPSTREAM_LOGSTREAM_STATUSES);

function isAdvisoryEventType(value: unknown): value is AdvisoryEventType {
  return typeof value === "string" && SAFE_TYPE_SET.has(value);
}

function isAdvisoryEventStatus(value: unknown): value is AdvisoryEventStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

function isPermittedEventType(
  value: unknown,
  allowAck: boolean
): value is AdvisoryEventType | "event.ack" {
  return isAdvisoryEventType(value) || (allowAck && value === "event.ack");
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 1;
}
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const EVENT_KEYS = new Set([
  "id",
  "seq",
  "origin_replica",
  "origin_seq",
  "hlc",
  "type",
  "stream",
  "room",
  "from_agent",
  "to_agent",
  "correlation_id",
  "branch",
  "base_commit",
  "status",
  "artifact_ids",
  "body",
  "created_at",
  "metadata",
]);

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isUnknownRecord(value) ? value : undefined;
}

function invalid(message: string): never {
  throw new MemoryError("MEMPALACE_INVALID", message);
}

function integrity(message: string): never {
  throw new MemoryError("MEMPALACE_INTEGRITY", message);
}

function assertExactInputKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  operation: LogstreamOperation
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) {
    invalid(`${operation} input contains unsupported fields`);
  }
}

function requireIdentifier(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximumCharacters: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumCharacters ||
    !pattern.test(value)
  ) {
    invalid(`${label} must be a bounded safe identifier`);
  }
  return value;
}

function optionalStatus(value: unknown): AdvisoryEventStatus | undefined {
  if (value === undefined) return undefined;
  if (!isAdvisoryEventStatus(value)) {
    invalid("status must be an upstream logstream status");
  }
  return value;
}

function optionalType(value: unknown): AdvisoryEventType | undefined {
  if (value === undefined) return undefined;
  if (!isAdvisoryEventType(value)) {
    invalid("type must be a safe advisory event type");
  }
  return value;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireBody(value: unknown): string {
  const body = value === undefined ? "" : value;
  if (
    typeof body !== "string" ||
    body.length > LOGSTREAM_MODEL_MAX_BODY_CHARACTERS ||
    Buffer.byteLength(body, "utf8") > LOGSTREAM_MODEL_MAX_BODY_BYTES ||
    body.includes("\0") ||
    hasLoneSurrogate(body)
  ) {
    invalid("body exceeds the advisory model bound or contains a null byte");
  }
  return body;
}

function boundedInteger(
  value: unknown,
  label: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return defaultValue;
  if (!isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function assertPayloadKeys(
  payload: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const expectedSet = new Set(expected);
  if (
    Object.keys(payload).length !== expected.length ||
    Object.keys(payload).some((key) => !expectedSet.has(key))
  ) {
    integrity(`Memory hub returned an unexpected ${label} payload shape`);
  }
}

export class MemoryLogstreamAdapter {
  private readonly principalId: string;
  private readonly stream: string;
  private readonly rooms: ReadonlySet<string>;

  constructor(
    private readonly config: MemoryRuntimeConfig,
    private readonly resultAdapter: MemoryAdapter,
    private readonly client: MemoryLogstreamClient
  ) {
    if (
      config.mode !== "hub" ||
      config.logstream.mode !== "primary-advisory" ||
      config.platformConfig.mode === "none"
    ) {
      throw new MemoryError(
        "MEMPALACE_INVALID",
        "Primary advisory logstream adapter requires enabled hub configuration"
      );
    }
    this.principalId = config.platformConfig.principalId;
    this.stream = config.logstream.stream;
    this.rooms = new Set(config.logstream.rooms);
  }

  execute(
    operation: LogstreamOperation,
    params: Record<string, unknown>,
    context: MemoryCallContext
  ): Promise<MemoryExecution> {
    return this.resultAdapter.executeStructured(operation, params, context, async () => {
      if (
        (operation === "logstream_append" || operation === "logstream_ack") &&
        !this.config.writeEnabled
      ) {
        invalid("Advisory logstream writes are disabled during read-only qualification");
      }
      if (operation === "logstream_append") return this.append(params, context.signal);
      if (operation === "logstream_list") return this.list(params, context.signal);
      if (operation === "logstream_wait") return this.wait(params, context.signal);
      return this.ack(params, context.signal);
    });
  }

  private room(value: unknown): string {
    if (typeof value !== "string" || !this.rooms.has(value)) {
      invalid("room is not in PENNY_MEMORY_LOGSTREAM_ROOMS");
    }
    return value;
  }

  private correlation(value: unknown): string {
    return requireIdentifier(value, "correlation_id", CORRELATION_PATTERN, 128);
  }

  private optionalCorrelation(value: unknown): string | undefined {
    return value === undefined ? undefined : this.correlation(value);
  }

  private eventId(value: unknown, label = "event_id"): string {
    return requireIdentifier(value, label, EVENT_ID_PATTERN, 256);
  }

  private validateEvent(
    value: unknown,
    options: {
      room?: string;
      correlation?: string;
      type?: AdvisoryEventType;
      status?: AdvisoryEventStatus;
      sinceEventId?: string;
      allowAck: boolean;
      expectedAckOf?: string;
    }
  ): { event: AdvisoryEvent; seq: number } {
    const event = asRecord(value);
    if (!event || Object.keys(event).some((key) => !EVENT_KEYS.has(key))) {
      integrity("Memory hub returned an unexpected advisory event shape");
    }
    const eventId = this.eventIdFromResponse(event.id);
    if (options.sinceEventId !== undefined && eventId === options.sinceEventId) {
      integrity("Memory hub returned the excluded advisory anchor event");
    }
    const type = event.type;
    if (!isPermittedEventType(type, options.allowAck)) {
      integrity("Memory hub returned a non-advisory event type");
    }
    if (options.type !== undefined && type !== options.type) {
      integrity("Memory hub returned an event outside the requested advisory type");
    }
    if (
      event.stream !== this.stream ||
      event.from_agent !== this.principalId ||
      event.to_agent !== this.principalId
    ) {
      integrity("Memory hub returned an event outside the configured stream/principal scope");
    }
    if (typeof event.room !== "string" || !this.rooms.has(event.room)) {
      integrity("Memory hub returned an event outside the configured room allowlist");
    }
    if (options.room !== undefined && event.room !== options.room) {
      integrity("Memory hub returned an event outside the requested room");
    }
    if (
      typeof event.correlation_id !== "string" ||
      !CORRELATION_PATTERN.test(event.correlation_id) ||
      event.correlation_id.length > 128
    ) {
      integrity("Memory hub returned an invalid advisory correlation");
    }
    if (options.correlation !== undefined && event.correlation_id !== options.correlation) {
      integrity("Memory hub returned an event outside the supplied correlation");
    }
    if (event.branch != null || event.base_commit != null) {
      integrity("Memory hub returned forbidden workflow-routing fields");
    }
    if (!Array.isArray(event.artifact_ids) || event.artifact_ids.length !== 0) {
      integrity("Memory hub returned a forbidden advisory artifact reference");
    }
    const status = event.status;
    if (status !== null && !isAdvisoryEventStatus(status)) {
      integrity("Memory hub returned an invalid advisory status");
    }
    if (options.status !== undefined && status !== options.status) {
      integrity("Memory hub returned an event outside the requested advisory status");
    }
    if (
      typeof event.body !== "string" ||
      event.body.length > LOGSTREAM_MODEL_MAX_BODY_CHARACTERS ||
      Buffer.byteLength(event.body, "utf8") > LOGSTREAM_MODEL_MAX_BODY_BYTES ||
      event.body.includes("\0") ||
      hasLoneSurrogate(event.body)
    ) {
      integrity("Memory hub returned an advisory body outside the model bound");
    }
    if (typeof event.created_at !== "string" || !UTC_TIMESTAMP_PATTERN.test(event.created_at)) {
      integrity("Memory hub returned an invalid advisory event timestamp");
    }
    if (
      !isPositiveSafeInteger(event.seq) ||
      typeof event.origin_replica !== "string" ||
      event.origin_replica.length === 0 ||
      event.origin_replica.length > 256 ||
      !isPositiveSafeInteger(event.origin_seq) ||
      typeof event.hlc !== "string" ||
      event.hlc.length === 0 ||
      event.hlc.length > 512
    ) {
      integrity("Memory hub returned invalid advisory event provenance");
    }

    const metadata = asRecord(event.metadata);
    if (!metadata) integrity("Memory hub returned invalid advisory event metadata");
    let ackOf: string | undefined;
    if (type === "event.ack") {
      if (Object.keys(metadata).length !== 1 || typeof metadata.ack_of !== "string") {
        integrity("Memory hub returned invalid advisory acknowledgement metadata");
      }
      ackOf = this.eventIdFromResponse(metadata.ack_of);
      if (options.expectedAckOf !== undefined && ackOf !== options.expectedAckOf) {
        integrity("Memory hub acknowledgement does not prove the requested target");
      }
    } else if (Object.keys(metadata).length !== 0) {
      integrity("Memory hub returned forbidden advisory metadata");
    }

    return {
      event: {
        event_id: eventId,
        type,
        room: event.room,
        correlation_id: event.correlation_id,
        status,
        body: event.body,
        created_at: event.created_at,
        ...(ackOf === undefined ? {} : { ack_of: ackOf }),
      },
      seq: event.seq,
    };
  }

  private eventIdFromResponse(value: unknown): string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 256 ||
      !EVENT_ID_PATTERN.test(value)
    ) {
      integrity("Memory hub returned an invalid advisory event id");
    }
    return value;
  }

  private validateEventList(
    payload: Record<string, unknown>,
    options: {
      room?: string;
      correlation?: string;
      type?: AdvisoryEventType;
      status?: AdvisoryEventStatus;
      sinceEventId?: string;
      limit: number;
      wait: boolean;
    }
  ): { events: AdvisoryEvent[]; count: number; timed_out?: boolean } {
    assertPayloadKeys(
      payload,
      options.wait ? ["timed_out", "events", "count"] : ["events", "count"],
      options.wait ? "advisory wait" : "advisory list"
    );
    if (!Array.isArray(payload.events) || !Number.isSafeInteger(payload.count)) {
      integrity("Memory hub returned an invalid advisory event list");
    }
    if (payload.count !== payload.events.length || payload.events.length > options.limit) {
      integrity("Memory hub returned an advisory event count outside the requested bound");
    }
    const eventIds = new Set<string>();
    let previousSeq = 0;
    const events = payload.events.map((value) => {
      const validated = this.validateEvent(value, {
        room: options.room,
        correlation: options.correlation,
        type: options.type,
        status: options.status,
        sinceEventId: options.sinceEventId,
        allowAck: true,
      });
      if (eventIds.has(validated.event.event_id)) {
        integrity("Memory hub returned duplicate advisory event ids");
      }
      if (validated.seq <= previousSeq) {
        integrity("Memory hub returned advisory events outside strict sequence order");
      }
      eventIds.add(validated.event.event_id);
      previousSeq = validated.seq;
      return validated.event;
    });
    if (!options.wait) return { events, count: events.length };
    if (typeof payload.timed_out !== "boolean") {
      integrity("Memory hub returned an invalid advisory wait timeout flag");
    }
    if ((payload.timed_out && events.length !== 0) || (!payload.timed_out && events.length === 0)) {
      integrity("Memory hub returned an inconsistent advisory wait result");
    }
    return { timed_out: payload.timed_out, events, count: events.length };
  }

  private async append(
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ payload: Record<string, unknown>; requestId: string }> {
    assertExactInputKeys(
      params,
      ["type", "room", "correlation_id", "status", "body", "cursor"],
      "logstream_append"
    );
    const type = optionalType(params.type);
    if (!type) invalid("type is required");
    const room = this.room(params.room);
    const correlation = this.correlation(params.correlation_id);
    const status = optionalStatus(params.status);
    const body = requireBody(params.body);
    const result = await this.client.call(
      "append",
      {
        type,
        stream: this.stream,
        room,
        from_agent: this.principalId,
        to_agent: this.principalId,
        correlation_id: correlation,
        ...(status === undefined ? {} : { status }),
        body,
      },
      signal
    );
    assertPayloadKeys(result.payload, ["success", "event"], "advisory append");
    const event = this.validateEvent(result.payload.event, {
      room,
      correlation,
      allowAck: false,
    }).event;
    if (event.type !== type || event.status !== (status ?? null) || event.body !== body) {
      integrity("Memory hub append response does not match the advisory request");
    }
    return { payload: { event }, requestId: result.requestId };
  }

  private async list(
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ payload: Record<string, unknown>; requestId: string }> {
    assertExactInputKeys(
      params,
      ["room", "type", "correlation_id", "status", "since_event_id", "limit", "cursor"],
      "logstream_list"
    );
    const room = this.room(params.room);
    const type = optionalType(params.type);
    const correlation = this.optionalCorrelation(params.correlation_id);
    const status = optionalStatus(params.status);
    const sinceEventId =
      params.since_event_id === undefined
        ? undefined
        : this.eventId(params.since_event_id, "since_event_id");
    const limit = boundedInteger(params.limit, "limit", 10, 1, LOGSTREAM_MODEL_MAX_LIST_LIMIT);
    const result = await this.client.call(
      "list",
      {
        stream: this.stream,
        room,
        from_agent: this.principalId,
        to_agent: this.principalId,
        ...(type === undefined ? {} : { type }),
        ...(correlation === undefined ? {} : { correlation_id: correlation }),
        ...(status === undefined ? {} : { status }),
        ...(sinceEventId === undefined ? {} : { since_event_id: sinceEventId }),
        limit,
        preview: false,
      },
      signal,
      { allowReadRetry: true }
    );
    const payload = this.validateEventList(result.payload, {
      room,
      correlation,
      type,
      status,
      sinceEventId,
      limit,
      wait: false,
    });
    return { payload, requestId: result.requestId };
  }

  private async wait(
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ payload: Record<string, unknown>; requestId: string }> {
    assertExactInputKeys(
      params,
      [
        "room",
        "type",
        "correlation_id",
        "status",
        "since_event_id",
        "timeout_ms",
        "limit",
        "cursor",
      ],
      "logstream_wait"
    );
    const room = this.room(params.room);
    const type = optionalType(params.type);
    const correlation = this.optionalCorrelation(params.correlation_id);
    const status = optionalStatus(params.status);
    const sinceEventId =
      params.since_event_id === undefined
        ? undefined
        : this.eventId(params.since_event_id, "since_event_id");
    const timeoutMs = boundedInteger(
      params.timeout_ms,
      "timeout_ms",
      1_000,
      0,
      LOGSTREAM_MODEL_MAX_WAIT_TIMEOUT_MS
    );
    const limit = boundedInteger(params.limit, "limit", 10, 1, LOGSTREAM_MODEL_MAX_LIST_LIMIT);
    const result = await this.client.call(
      "wait",
      {
        stream: this.stream,
        room,
        from_agent: this.principalId,
        to_agent: this.principalId,
        ...(type === undefined ? {} : { type }),
        ...(correlation === undefined ? {} : { correlation_id: correlation }),
        ...(status === undefined ? {} : { status }),
        ...(sinceEventId === undefined ? {} : { since_event_id: sinceEventId }),
        timeout_ms: timeoutMs,
        limit,
      },
      signal
    );
    const payload = this.validateEventList(result.payload, {
      room,
      correlation,
      type,
      status,
      sinceEventId,
      limit,
      wait: true,
    });
    return { payload, requestId: result.requestId };
  }

  private async ack(
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ payload: Record<string, unknown>; requestId: string }> {
    assertExactInputKeys(
      params,
      ["event_id", "correlation_id", "status", "body", "cursor"],
      "logstream_ack"
    );
    const eventId = this.eventId(params.event_id);
    const correlation = this.correlation(params.correlation_id);
    const status = optionalStatus(params.status);
    const body = requireBody(params.body);

    const proofResult = await this.client.call(
      "list",
      {
        stream: this.stream,
        from_agent: this.principalId,
        to_agent: this.principalId,
        correlation_id: correlation,
        limit: LOGSTREAM_MODEL_MAX_LIST_LIMIT,
        preview: false,
      },
      signal,
      { allowReadRetry: true }
    );
    const proof = this.validateEventList(proofResult.payload, {
      correlation,
      limit: LOGSTREAM_MODEL_MAX_LIST_LIMIT,
      wait: false,
    });
    const target = proof.events.find((event) => event.event_id === eventId);
    if (!target || !isAdvisoryEventType(target.type)) {
      invalid(
        "Ack target scope could not be proved within the bounded configured stream/principal/correlation read"
      );
    }

    const result = await this.client.call(
      "ack",
      {
        event_id: eventId,
        from_agent: this.principalId,
        ...(status === undefined ? {} : { status }),
        body,
      },
      signal
    );
    assertPayloadKeys(result.payload, ["success", "event"], "advisory acknowledgement");
    const event = this.validateEvent(result.payload.event, {
      room: target.room,
      correlation,
      allowAck: true,
      expectedAckOf: eventId,
    }).event;
    if (event.type !== "event.ack" || event.status !== (status ?? null) || event.body !== body) {
      integrity("Memory hub acknowledgement response does not match the advisory request");
    }
    return { payload: { event }, requestId: result.requestId };
  }
}
