import {
  PlatformMemoryClientV1,
  PlatformMemoryError,
  SAFE_PLATFORM_MEMORY_READ_OPERATIONS,
  type PlatformMemoryErrorCode,
} from "platform-memory";

import {
  MemoryError,
  type McpCallResult,
  type MemoryClientDependencies,
  type MemoryErrorCode,
  type MemoryOperation,
  type MemoryRuntimeConfig,
} from "./types.js";

const ERROR_CODE_MAP: Readonly<Record<PlatformMemoryErrorCode, MemoryErrorCode>> = Object.freeze({
  MEMORY_DISABLED: "MEMPALACE_INVALID",
  MEMORY_OPERATION_FORBIDDEN: "MEMPALACE_INVALID",
  MEMORY_CONFIG_INVALID: "MEMPALACE_INVALID",
  MEMORY_INVALID_REQUEST: "MEMPALACE_INVALID",
  MEMORY_UNAVAILABLE: "MEMPALACE_UNAVAILABLE",
  MEMORY_UNAUTHORIZED: "MEMPALACE_UNAUTHORIZED",
  MEMORY_TIMEOUT: "MEMPALACE_TIMEOUT",
  MEMORY_CANCELLED: "MEMPALACE_CANCELLED",
  MEMORY_CONFLICT: "MEMPALACE_CONFLICT",
  MEMORY_INTEGRITY: "MEMPALACE_INTEGRITY",
});

export class MemoryMcpClient {
  private readonly client: PlatformMemoryClientV1;

  constructor(config: MemoryRuntimeConfig, dependencies: MemoryClientDependencies = {}) {
    this.client = new PlatformMemoryClientV1(config.platformConfig, {
      ...dependencies,
      credentialResolver: () => config.bearerToken,
    });
  }

  async call(
    operation: MemoryOperation,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<McpCallResult> {
    try {
      const result = await this.client.invoke(operation, arguments_, signal);
      return {
        requestId: result.requestId,
        payload: result.data,
        attempts: result.attempts,
      };
    } catch (error) {
      if (error instanceof PlatformMemoryError) {
        throw new MemoryError(
          ERROR_CODE_MAP[error.code],
          error.message,
          error.retryable,
          error.requestId
        );
      }
      throw new MemoryError("MEMPALACE_UNAVAILABLE", "Memory hub is unavailable", true);
    }
  }
}

export const SAFE_READ_TOOLS = SAFE_PLATFORM_MEMORY_READ_OPERATIONS;
