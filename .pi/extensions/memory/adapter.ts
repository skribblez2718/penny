import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { PLATFORM_MEMORY_OPERATIONS } from "platform-memory";

import {
  ToolResultBudgetError,
  createTextToolResult,
  enforceToolResultBudget,
  fitUtf8ToolResult,
  measureToolResult,
  type TextToolResult,
} from "../lib/tool-result-budget.js";
import { assertCanonicalKgPredicate } from "./kg-policy.js";
import { MemoryMcpClient } from "./mcp-client.js";
import {
  MEMORY_SCHEMA_VERSION,
  MemoryError,
  type MemoryAdapterDependencies,
  type MemoryCallContext,
  type MemoryErrorCode,
  type MemoryExecution,
  type MemoryOperation,
  type MemoryRuntimeConfig,
} from "./types.js";

const CURSOR_VERSION = 1 as const;
const CURSOR_MAX_CHARACTERS = 4_096;
const SUMMARY_MAX_CODE_POINTS = 320;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MEMORY_OPERATION_SET = new Set<string>(PLATFORM_MEMORY_OPERATIONS);
const MEMORY_WRITE_OPERATIONS = new Set<MemoryOperation>([
  "add_drawer",
  "diary_write",
  "kg_add",
  "kg_invalidate",
  "kg_supersede",
]);

interface CursorPayload {
  v: 1;
  op: MemoryOperation;
  caller: string;
  query: string;
  filter: string;
  digest: string;
  revision: string;
  kind: "content" | "json";
  cache: string | null;
  start: number;
  end: number;
  next: number;
  page: number;
  exp: number;
}

interface ContinuationSource {
  kind: "content" | "json";
  buffer: Buffer;
  metadata: Record<string, unknown>;
  digest: string;
  revision: string;
}

interface SourceCacheEntry extends ContinuationSource {
  id: string;
  operation: MemoryOperation;
  queryHash: string;
  filterHash: string;
  expiresAt: number;
  insertedAt: number;
}

class BoundedSourceCache {
  private readonly entries = new Map<string, SourceCacheEntry>();
  private totalBytes = 0;
  private serial = 0;

  constructor(
    private readonly maximumBytes: number,
    private readonly maximumEntries: number,
    private readonly now: () => number
  ) {}

  add(
    source: ContinuationSource,
    operation: MemoryOperation,
    queryHash: string,
    filterHash: string,
    expiresAt: number
  ): SourceCacheEntry {
    if (source.buffer.length > this.maximumBytes) {
      throw new MemoryError(
        "MEMPALACE_RESULT_BUDGET_EXCEEDED",
        "Memory source is too large for bounded continuation cache"
      );
    }
    this.prune();
    while (
      this.entries.size >= this.maximumEntries ||
      this.totalBytes + source.buffer.length > this.maximumBytes
    ) {
      const oldest = this.entries.values().next().value as SourceCacheEntry | undefined;
      if (!oldest) break;
      this.delete(oldest.id);
    }
    const id = createHash("sha256")
      .update(`${source.digest}:${this.now()}:${this.serial++}`)
      .digest("hex")
      .slice(0, 32);
    const entry: SourceCacheEntry = {
      ...source,
      id,
      operation,
      queryHash,
      filterHash,
      expiresAt,
      insertedAt: this.now(),
    };
    this.entries.set(id, entry);
    this.totalBytes += source.buffer.length;
    return entry;
  }

  get(id: string): SourceCacheEntry | undefined {
    this.prune();
    return this.entries.get(id);
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private prune(): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.expiresAt <= now) this.delete(entry.id);
    }
  }

  private delete(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.totalBytes -= entry.buffer.length;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalize(record[key])])
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function splitBindings(
  operation: MemoryOperation,
  params: Record<string, unknown>
): { queryHash: string; filterHash: string } {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([key, value]) => key !== "cursor" && value !== undefined)
  );
  const queryKeys: Readonly<Record<MemoryOperation, readonly string[]>> = {
    search: ["query", "context"],
    smart_search: ["query", "context"],
    get_drawer: ["drawer_id"],
    list_drawers: [],
    get_taxonomy: [],
    check_duplicate: ["content"],
    add_drawer: ["content"],
    diary_read: ["agent_name"],
    diary_write: ["agent_name", "entry"],
    kg_query: ["entity"],
    kg_add: ["subject", "predicate", "object"],
    kg_invalidate: ["subject", "predicate", "object"],
    kg_supersede: ["subject", "predicate", "old_object", "new_object"],
    kg_timeline: ["entity"],
    kg_stats: [],
  };
  const queryKeySet = new Set(queryKeys[operation]);
  const query = Object.fromEntries(Object.entries(clean).filter(([key]) => queryKeySet.has(key)));
  const filters = Object.fromEntries(
    Object.entries(clean).filter(([key]) => !queryKeySet.has(key))
  );
  return { queryHash: sha256(canonicalJson(query)), filterHash: sha256(canonicalJson(filters)) };
}

function prepareUpstreamArguments(
  operation: MemoryOperation,
  params: Record<string, unknown>
): Record<string, unknown> {
  if (operation === "kg_add" || operation === "kg_invalidate" || operation === "kg_supersede") {
    assertCanonicalKgPredicate(params.predicate);
  }
  if (
    (operation === "diary_read" || operation === "diary_write") &&
    params.agent_name !== "penny"
  ) {
    throw new MemoryError("MEMPALACE_INVALID", "Primary diary operations are restricted to penny");
  }

  const arguments_ = Object.fromEntries(
    Object.entries(params).filter(
      ([key, value]) =>
        key !== "cursor" &&
        key !== "include_full" &&
        key !== "verbatim" &&
        key !== "min_similarity" &&
        !((operation === "diary_read" || operation === "diary_write") && key === "agent_name") &&
        value !== undefined
    )
  );
  if (
    (operation === "search" || operation === "smart_search") &&
    typeof params.min_similarity === "number"
  ) {
    arguments_.max_distance = Math.max(0, Math.min(2, 1 - params.min_similarity));
  }
  return arguments_;
}

function contentFromItem(item: Record<string, unknown>): string {
  for (const key of ["content", "text", "document", "body"]) {
    if (typeof item[key] === "string") return item[key] as string;
  }
  return "";
}

function copyPrimitive(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  targetKey: string,
  sourceKeys: readonly string[]
): void {
  for (const key of sourceKeys) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      target[targetKey] = value;
      return;
    }
  }
}

function summarizeItem(
  item: Record<string, unknown>,
  includeFull: boolean
): Record<string, unknown> {
  const content = contentFromItem(item);
  const codePoints = Array.from(content);
  const summary = codePoints.slice(0, SUMMARY_MAX_CODE_POINTS).join("");
  const normalized: Record<string, unknown> = {};
  copyPrimitive(normalized, item, "drawer_id", ["drawer_id", "id"]);
  copyPrimitive(normalized, item, "wing", ["wing"]);
  copyPrimitive(normalized, item, "room", ["room"]);
  copyPrimitive(normalized, item, "source_file", ["source_file"]);
  copyPrimitive(normalized, item, "created_at", ["created_at", "filed_at", "timestamp"]);
  copyPrimitive(normalized, item, "similarity", ["similarity"]);
  copyPrimitive(normalized, item, "distance", ["distance"]);
  copyPrimitive(normalized, item, "matched_via", ["matched_via"]);
  normalized.content_bytes = Buffer.byteLength(content, "utf8");
  if (includeFull) {
    normalized.content = content;
  } else {
    normalized.summary = summary;
    normalized.summary_truncated = codePoints.length > SUMMARY_MAX_CODE_POINTS;
    normalized.summary_bytes = Buffer.byteLength(summary, "utf8");
  }
  return normalized;
}

function normalizeSearch(
  payload: Record<string, unknown>,
  includeFull: boolean
): Record<string, unknown> {
  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  const results = rawResults
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((item) => summarizeItem(item, includeFull));
  return {
    mode: includeFull ? "verbatim" : "summary",
    query: typeof payload.query === "string" ? payload.query : "",
    filters: asRecord(payload.filters) ?? {},
    results,
    count: results.length,
    total_before_filter:
      typeof payload.total_before_filter === "number"
        ? payload.total_before_filter
        : results.length,
    date_filter_pool_truncated: payload.date_filter_pool_truncated === true,
  };
}

function normalizeList(
  payload: Record<string, unknown>,
  includeFull: boolean
): Record<string, unknown> {
  const rawDrawers = Array.isArray(payload.drawers) ? payload.drawers : [];
  const drawers = rawDrawers
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((item) => summarizeItem(item, includeFull));
  return {
    mode: includeFull ? "verbatim" : "summary",
    drawers,
    total: typeof payload.total === "number" ? payload.total : drawers.length,
    count: drawers.length,
    offset: typeof payload.offset === "number" ? payload.offset : 0,
    limit: typeof payload.limit === "number" ? payload.limit : drawers.length,
  };
}

function normalizePayload(
  operation: MemoryOperation,
  payload: Record<string, unknown>,
  params: Record<string, unknown>
): Record<string, unknown> {
  if (typeof payload.error === "string" && payload.success !== false) {
    throw new MemoryError("MEMPALACE_INVALID", "Memory hub rejected the operation payload");
  }
  const includeFull = params.include_full === true || params.verbatim === true;
  if (operation === "search" || operation === "smart_search") {
    return normalizeSearch(payload, includeFull);
  }
  if (operation === "list_drawers") return normalizeList(payload, includeFull);
  return payload;
}

function sourceRevision(data: Record<string, unknown>, digest: string): string {
  const upstreamRevision =
    data.source_revision ?? data.revision ?? data.updated_at ?? data.version ?? null;
  return sha256(canonicalJson({ upstream_revision: upstreamRevision, digest }));
}

function exactDrawerSource(payload: Record<string, unknown>): ContinuationSource {
  if (typeof payload.content !== "string") {
    throw new MemoryError("MEMPALACE_INTEGRITY", "Exact drawer response has no UTF-8 content");
  }
  const content = Buffer.from(payload.content, "utf8");
  const fullMetadata = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== "content")
  );
  const nestedMetadata = asRecord(payload.metadata) ?? {};
  const metadata: Record<string, unknown> = {};
  copyPrimitive(metadata, payload, "drawer_id", ["drawer_id", "id"]);
  copyPrimitive(metadata, payload, "wing", ["wing"]);
  copyPrimitive(metadata, payload, "room", ["room"]);
  copyPrimitive(metadata, payload, "chunks", ["chunks"]);
  for (const key of [
    "source_file",
    "filed_at",
    "authored_at",
    "added_by",
    "agent",
    "topic",
    "date",
  ]) {
    copyPrimitive(metadata, nestedMetadata, key, [key]);
  }
  if (Array.isArray(payload.chunk_ids)) {
    metadata.chunk_ids_count = payload.chunk_ids.length;
    metadata.chunk_ids_digest = sha256(canonicalJson(payload.chunk_ids));
  }
  const sourceMetadataDigest = sha256(canonicalJson(fullMetadata));
  metadata.source_metadata_digest = sourceMetadataDigest;
  metadata.metadata_reduced = canonicalJson(metadata) !== canonicalJson(fullMetadata);
  const digest = sha256(content);
  return {
    kind: "content",
    buffer: content,
    metadata,
    digest,
    revision: sha256(canonicalJson({ source_metadata_digest: sourceMetadataDigest, digest })),
  };
}

function jsonSource(data: Record<string, unknown>): ContinuationSource {
  const buffer = Buffer.from(JSON.stringify(data), "utf8");
  const digest = sha256(buffer);
  return {
    kind: "json",
    buffer,
    metadata: {},
    digest,
    revision: sourceRevision(data, digest),
  };
}

function encodeCursor(payload: CursorPayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function parseCursorPayload(value: unknown): CursorPayload {
  const record = asRecord(value);
  const keys = record ? Object.keys(record).sort() : [];
  const expected = [
    "cache",
    "caller",
    "digest",
    "end",
    "exp",
    "filter",
    "kind",
    "next",
    "op",
    "page",
    "query",
    "revision",
    "start",
    "v",
  ].sort();
  if (
    !record ||
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new MemoryError("MEMPALACE_CURSOR_INVALID", "Memory continuation cursor is invalid");
  }
  if (
    record.v !== CURSOR_VERSION ||
    !MEMORY_OPERATION_SET.has(String(record.op)) ||
    typeof record.caller !== "string" ||
    typeof record.query !== "string" ||
    !DIGEST_PATTERN.test(record.query) ||
    typeof record.filter !== "string" ||
    !DIGEST_PATTERN.test(record.filter) ||
    typeof record.digest !== "string" ||
    !DIGEST_PATTERN.test(record.digest) ||
    typeof record.revision !== "string" ||
    !DIGEST_PATTERN.test(record.revision) ||
    (record.kind !== "content" && record.kind !== "json") ||
    (record.cache !== null && typeof record.cache !== "string") ||
    !Number.isSafeInteger(record.start) ||
    !Number.isSafeInteger(record.end) ||
    !Number.isSafeInteger(record.next) ||
    !Number.isSafeInteger(record.page) ||
    !Number.isSafeInteger(record.exp)
  ) {
    throw new MemoryError("MEMPALACE_CURSOR_INVALID", "Memory continuation cursor is invalid");
  }
  return record as unknown as CursorPayload;
}

function decodeCursor(cursor: string, key: Buffer): CursorPayload {
  if (cursor.length === 0 || cursor.length > CURSOR_MAX_CHARACTERS) {
    throw new MemoryError("MEMPALACE_CURSOR_INVALID", "Memory continuation cursor is invalid");
  }
  const [body, suppliedSignature, extra] = cursor.split(".");
  if (
    !body ||
    !suppliedSignature ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/.test(body) ||
    !/^[A-Za-z0-9_-]+$/.test(suppliedSignature)
  ) {
    throw new MemoryError("MEMPALACE_CURSOR_INVALID", "Memory continuation cursor is invalid");
  }
  const expected = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new MemoryError("MEMPALACE_CURSOR_INVALID", "Memory continuation cursor is invalid");
  }
  try {
    return parseCursorPayload(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError("MEMPALACE_CURSOR_INVALID", "Memory continuation cursor is invalid");
  }
}

function errorResult(
  code: MemoryErrorCode,
  message: string,
  config: MemoryRuntimeConfig,
  requestId?: string,
  retryable = false
): MemoryExecution {
  let result = createTextToolResult(
    {
      schema_version: MEMORY_SCHEMA_VERSION,
      ok: false,
      type: "memory_error",
      error: { code, message, retryable },
      request_id: requestId ?? null,
    },
    { isError: true }
  );
  try {
    enforceToolResultBudget(result, config.budget);
  } catch {
    result = createTextToolResult(
      { ok: false, error: { code: "MEMPALACE_RESULT_BUDGET_EXCEEDED" } },
      { isError: true }
    );
    enforceToolResultBudget(result, config.budget);
    code = "MEMPALACE_RESULT_BUDGET_EXCEEDED";
  }
  const measurement = measureToolResult(result);
  return {
    result,
    code,
    requestId,
    serializedBytes: measurement.bytes,
    estimatedTokens: measurement.estimatedTokens,
    truncated: false,
    page: 1,
  };
}

function memoryErrorFromUnknown(error: unknown): MemoryError {
  if (error instanceof MemoryError) return error;
  if (error instanceof ToolResultBudgetError) {
    return new MemoryError(
      "MEMPALACE_RESULT_BUDGET_EXCEEDED",
      "Memory result cannot fit the configured result budget"
    );
  }
  return new MemoryError("MEMPALACE_UNAVAILABLE", "Memory operation failed");
}

export class MemoryAdapter {
  private readonly client: MemoryMcpClient;
  private readonly now: () => number;
  private readonly cache: BoundedSourceCache;

  constructor(
    private readonly config: MemoryRuntimeConfig,
    dependencies: MemoryAdapterDependencies = {}
  ) {
    this.client = new MemoryMcpClient(config, dependencies);
    this.now = dependencies.now ?? Date.now;
    this.cache = new BoundedSourceCache(
      config.sourceCacheMaxBytes,
      config.sourceCacheMaxEntries,
      this.now
    );
  }

  async invokeRaw(
    operation: MemoryOperation,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ payload: Record<string, unknown>; requestId: string }> {
    if (MEMORY_WRITE_OPERATIONS.has(operation) && !this.config.writeEnabled) {
      throw new MemoryError(
        "MEMPALACE_INVALID",
        "Memory writes are disabled during read-only qualification"
      );
    }
    const arguments_ = prepareUpstreamArguments(operation, params);
    const response = await this.client.call(operation, arguments_, signal);
    return { payload: response.payload, requestId: response.requestId };
  }

  clearContinuationCacheForTests(): void {
    this.cache.clear();
  }

  async execute(
    operation: MemoryOperation,
    params: Record<string, unknown>,
    context: MemoryCallContext
  ): Promise<MemoryExecution> {
    let requestId: string | undefined;
    try {
      if (MEMORY_WRITE_OPERATIONS.has(operation) && !this.config.writeEnabled) {
        throw new MemoryError(
          "MEMPALACE_INVALID",
          "Memory writes are disabled during read-only qualification"
        );
      }
      if (context.signal?.aborted) {
        throw new MemoryError("MEMPALACE_CANCELLED", "Memory request was cancelled");
      }
      const bindings = splitBindings(operation, params);
      const rawCursor = params.cursor;
      if (rawCursor !== undefined && typeof rawCursor !== "string") {
        throw new MemoryError("MEMPALACE_CURSOR_INVALID", "Memory continuation cursor is invalid");
      }

      let source: ContinuationSource;
      let start = 0;
      let end: number;
      let page = 1;
      let expiresAt = this.now() + this.config.cursorTtlMs;
      let cacheId: string | null = null;

      if (rawCursor) {
        const cursor = decodeCursor(rawCursor, this.config.cursorKey);
        if (cursor.exp <= this.now()) {
          throw new MemoryError(
            "MEMPALACE_CURSOR_EXPIRED",
            "Memory continuation cursor has expired"
          );
        }
        if (
          cursor.op !== operation ||
          cursor.caller !== context.callerId ||
          cursor.query !== bindings.queryHash ||
          cursor.filter !== bindings.filterHash
        ) {
          throw new MemoryError("MEMPALACE_CURSOR_INVALID", "Memory cursor binding is invalid");
        }
        expiresAt = cursor.exp;
        cacheId = cursor.cache;
        if (cacheId) {
          const cached = this.cache.get(cacheId);
          if (
            !cached ||
            cached.operation !== operation ||
            cached.queryHash !== bindings.queryHash ||
            cached.filterHash !== bindings.filterHash
          ) {
            throw new MemoryError("MEMPALACE_CURSOR_STALE", "Memory continuation source is stale");
          }
          source = cached;
        } else {
          const response = await this.invokeRaw(operation, params, context.signal);
          requestId = response.requestId;
          const normalized = normalizePayload(operation, response.payload, params);
          source =
            operation === "get_drawer" ? exactDrawerSource(normalized) : jsonSource(normalized);
        }
        if (
          source.kind !== cursor.kind ||
          source.digest !== cursor.digest ||
          source.revision !== cursor.revision
        ) {
          throw new MemoryError("MEMPALACE_CURSOR_STALE", "Memory continuation source is stale");
        }
        if (
          cursor.start < 0 ||
          cursor.end !== source.buffer.length ||
          cursor.next < cursor.start ||
          cursor.next >= cursor.end ||
          cursor.page < 2
        ) {
          throw new MemoryError("MEMPALACE_CURSOR_INVALID", "Memory cursor range is invalid");
        }
        start = cursor.next;
        end = cursor.end;
        page = cursor.page;
      } else {
        const response = await this.invokeRaw(operation, params, context.signal);
        requestId = response.requestId;
        const normalized = normalizePayload(operation, response.payload, params);
        source =
          operation === "get_drawer" ? exactDrawerSource(normalized) : jsonSource(normalized);
        end = source.buffer.length;
      }

      const execution = this.renderSource({
        operation,
        source,
        callerId: context.callerId,
        bindings,
        start,
        end,
        page,
        expiresAt,
        cacheId,
        requestId,
      });
      return execution;
    } catch (error) {
      const typed = memoryErrorFromUnknown(error);
      return errorResult(
        typed.code,
        typed.message,
        this.config,
        typed.requestId ?? requestId,
        typed.retryable
      );
    }
  }

  private renderSource(options: {
    operation: MemoryOperation;
    source: ContinuationSource;
    callerId: string;
    bindings: { queryHash: string; filterHash: string };
    start: number;
    end: number;
    page: number;
    expiresAt: number;
    cacheId: string | null;
    requestId?: string;
  }): MemoryExecution {
    const { operation, source, callerId, bindings, start, end, page, expiresAt, requestId } =
      options;
    let cacheId = options.cacheId;

    const makeCursor = (next: number): string => {
      if (!cacheId && operation !== "list_drawers") {
        cacheId = this.cache.add(
          source,
          operation,
          bindings.queryHash,
          bindings.filterHash,
          expiresAt
        ).id;
      }
      return encodeCursor(
        {
          v: CURSOR_VERSION,
          op: operation,
          caller: callerId,
          query: bindings.queryHash,
          filter: bindings.filterHash,
          digest: source.digest,
          revision: source.revision,
          kind: source.kind,
          cache: cacheId,
          start: 0,
          end,
          next,
          page: page + 1,
          exp: expiresAt,
        },
        this.config.cursorKey
      );
    };

    const sourceDescriptor = {
      digest: source.digest,
      revision: source.revision,
      total_bytes: source.buffer.length,
      media_type:
        source.kind === "content" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    };

    const buildExact = (returnedEnd: number, text: string, truncated: boolean): TextToolResult =>
      createTextToolResult({
        schema_version: MEMORY_SCHEMA_VERSION,
        ok: true,
        type: "memory_exact",
        operation,
        source: sourceDescriptor,
        source_digest: source.digest,
        source_revision: source.revision,
        total_bytes: source.buffer.length,
        metadata: source.metadata,
        content_range: { start, end: returnedEnd },
        returned_range: { start, end: returnedEnd },
        returned_bytes: returnedEnd - start,
        content: text,
        truncated,
        continuation: truncated
          ? {
              cursor: makeCursor(returnedEnd),
              next_range: { start: returnedEnd, end },
              expires_at: new Date(expiresAt).toISOString(),
              page: page + 1,
            }
          : null,
        request_id: requestId ?? null,
      });

    const buildJsonPage = (returnedEnd: number, text: string, truncated: boolean): TextToolResult =>
      createTextToolResult({
        schema_version: MEMORY_SCHEMA_VERSION,
        ok: true,
        type: "memory_continuation",
        operation,
        source: sourceDescriptor,
        source_digest: source.digest,
        source_revision: source.revision,
        total_bytes: source.buffer.length,
        content_range: { start, end: returnedEnd },
        item_range: null,
        returned_bytes: returnedEnd - start,
        fragment: text,
        truncated,
        continuation: truncated
          ? {
              cursor: makeCursor(returnedEnd),
              next_range: { start: returnedEnd, end },
              expires_at: new Date(expiresAt).toISOString(),
              page: page + 1,
            }
          : null,
        request_id: requestId ?? null,
      });

    if (source.kind === "content") {
      const fitted = fitUtf8ToolResult({
        source: source.buffer,
        start,
        end,
        budget: this.config.budget,
        build: buildExact,
      });
      return {
        result: fitted.result,
        code: "OK",
        requestId,
        serializedBytes: fitted.measurement.bytes,
        estimatedTokens: fitted.measurement.estimatedTokens,
        truncated: fitted.truncated,
        page,
      };
    }

    if (start === 0 && page === 1) {
      const complete = createTextToolResult({
        schema_version: MEMORY_SCHEMA_VERSION,
        ok: true,
        type: "memory_result",
        operation,
        source: sourceDescriptor,
        source_digest: source.digest,
        source_revision: source.revision,
        total_bytes: source.buffer.length,
        data: JSON.parse(source.buffer.toString("utf8")),
        truncated: false,
        continuation: null,
        request_id: requestId ?? null,
      });
      try {
        const measurement = enforceToolResultBudget(complete, this.config.budget);
        return {
          result: complete,
          code: "OK",
          requestId,
          serializedBytes: measurement.bytes,
          estimatedTokens: measurement.estimatedTokens,
          truncated: false,
          page,
        };
      } catch (error) {
        if (!(error instanceof ToolResultBudgetError)) throw error;
      }
    }

    const fitted = fitUtf8ToolResult({
      source: source.buffer,
      start,
      end,
      budget: this.config.budget,
      build: buildJsonPage,
    });
    return {
      result: fitted.result,
      code: "OK",
      requestId,
      serializedBytes: fitted.measurement.bytes,
      estimatedTokens: fitted.measurement.estimatedTokens,
      truncated: fitted.truncated,
      page,
    };
  }
}

export { canonicalJson, decodeCursor, normalizePayload };
