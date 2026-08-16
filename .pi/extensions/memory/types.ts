import type { PlatformMemoryConfigV1, PlatformMemoryOperation } from "platform-memory";

import type { TextToolResult, ToolResultBudget } from "../lib/tool-result-budget.js";

export const MEMORY_SCHEMA_VERSION = 1 as const;

export type LogstreamOperation =
  | "logstream_append"
  | "logstream_list"
  | "logstream_wait"
  | "logstream_ack";
export type MemoryOperation = PlatformMemoryOperation;
export type MemoryResultOperation = MemoryOperation | LogstreamOperation;
export type MemoryLogstreamConfig =
  | { mode: "disabled"; stream: null; rooms: readonly [] }
  | { mode: "primary-advisory"; stream: string; rooms: readonly string[] };

export type MemoryErrorCode =
  | "MEMPALACE_UNAVAILABLE"
  | "MEMPALACE_UNAUTHORIZED"
  | "MEMPALACE_TIMEOUT"
  | "MEMPALACE_CANCELLED"
  | "MEMPALACE_CONFLICT"
  | "MEMPALACE_INVALID"
  | "MEMPALACE_INTEGRITY"
  | "MEMPALACE_CURSOR_INVALID"
  | "MEMPALACE_CURSOR_EXPIRED"
  | "MEMPALACE_CURSOR_STALE"
  | "MEMPALACE_RESULT_BUDGET_EXCEEDED";

export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    readonly retryable = false,
    readonly requestId?: string
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export interface MemoryRuntimeConfig {
  mode: "hub" | "disabled";
  writeEnabled: boolean;
  logstream: MemoryLogstreamConfig;
  platformConfig: PlatformMemoryConfigV1;
  bearerToken: string;
  cursorKey: Buffer;
  cursorTtlMs: number;
  sourceCacheMaxBytes: number;
  sourceCacheMaxEntries: number;
  budget: ToolResultBudget;
}

export interface MemoryClientDependencies {
  fetch?: typeof fetch;
  randomId?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface MemoryAdapterDependencies extends MemoryClientDependencies {
  now?: () => number;
}

export interface MemoryExecution {
  result: TextToolResult;
  code: "OK" | MemoryErrorCode;
  requestId?: string;
  serializedBytes: number;
  estimatedTokens: number;
  truncated: boolean;
  page: number;
}

export interface McpCallResult {
  requestId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface MemoryCallContext {
  callerId: string;
  signal?: AbortSignal;
}

export interface MemoryTelemetry {
  info(event: string, context: Record<string, unknown>): void;
  warn(event: string, context: Record<string, unknown>): void;
}
