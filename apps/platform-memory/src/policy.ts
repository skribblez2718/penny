import {
  PlatformMemoryError,
  type PlatformMemoryCapability,
  type PlatformMemoryOperation,
  type ValidatedPlatformMemoryConfigV1,
} from "./types.js";

const MAX_QUERY_CHARACTERS = 4_096;
const MAX_CONTENT_CHARACTERS = 4_194_304;
const MAX_IDENTIFIER_CHARACTERS = 4_096;
const MAX_SEARCH_RESULTS = 20;
const MAX_LIST_RESULTS = 100;
const MAX_DIARY_RESULTS = 50;

export const PLATFORM_MEMORY_CAPABILITY_OPERATIONS: Readonly<
  Record<PlatformMemoryCapability, readonly PlatformMemoryOperation[]>
> = Object.freeze({
  "recall-read": ["search", "smart_search", "get_drawer", "list_drawers", "get_taxonomy"],
  "curated-write": ["check_duplicate", "add_drawer"],
  "kg-read": ["kg_query", "kg_timeline", "kg_stats"],
  "kg-write": ["kg_add", "kg_invalidate", "kg_supersede"],
  "primary-diary": ["diary_read", "diary_write"],
});

export const PLATFORM_MEMORY_OPERATIONS: readonly PlatformMemoryOperation[] = Object.freeze(
  Object.values(PLATFORM_MEMORY_CAPABILITY_OPERATIONS).flat()
);

export const FORBIDDEN_PLATFORM_MEMORY_OPERATION_NAMES = Object.freeze([
  "delete",
  "bulk-delete",
  "export",
  "backup",
  "repair",
  "migrate",
  "admin",
  "logstream-read",
  "logstream-write",
  "event-broadcast",
]);

export const SAFE_PLATFORM_MEMORY_READ_OPERATIONS = new Set<PlatformMemoryOperation>([
  "search",
  "smart_search",
  "get_drawer",
  "list_drawers",
  "get_taxonomy",
  "check_duplicate",
  "diary_read",
  "kg_query",
  "kg_timeline",
  "kg_stats",
]);

const OPERATION_CAPABILITY = new Map<PlatformMemoryOperation, PlatformMemoryCapability>(
  Object.entries(PLATFORM_MEMORY_CAPABILITY_OPERATIONS).flatMap(([capability, operations]) =>
    operations.map((operation) => [operation, capability as PlatformMemoryCapability])
  )
);

function invalidRequest(message: string): never {
  throw new PlatformMemoryError("MEMORY_INVALID_REQUEST", message);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidRequest("memory operation input must be an object");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  operation: PlatformMemoryOperation
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) {
    invalidRequest(`${operation} input contains unsupported fields`);
  }
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
  maximum = MAX_IDENTIFIER_CHARACTERS
): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    invalidRequest(`${key} must be a bounded non-empty string`);
  }
  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  maximum = MAX_IDENTIFIER_CHARACTERS
): void {
  if (input[key] !== undefined) requiredString(input, key, maximum);
}

function optionalBoolean(input: Record<string, unknown>, key: string): void {
  if (input[key] !== undefined && typeof input[key] !== "boolean") {
    invalidRequest(`${key} must be a boolean`);
  }
}

function optionalNumber(
  input: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): void {
  const value = input[key];
  if (value !== undefined && (typeof value !== "number" || value < minimum || value > maximum)) {
    invalidRequest(`${key} must be between ${minimum} and ${maximum}`);
  }
}

function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): void {
  const value = input[key];
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
  ) {
    invalidRequest(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
}

function validateSearch(input: Record<string, unknown>, operation: PlatformMemoryOperation): void {
  assertExactKeys(
    input,
    ["query", "context", "limit", "wing", "room", "source_file", "since", "before", "max_distance"],
    operation
  );
  requiredString(input, "query", MAX_QUERY_CHARACTERS);
  optionalString(input, "context", MAX_QUERY_CHARACTERS);
  optionalInteger(input, "limit", 1, MAX_SEARCH_RESULTS);
  for (const key of ["wing", "room", "source_file", "since", "before"]) {
    optionalString(input, key);
  }
  optionalNumber(input, "max_distance", 0, 2);
}

function validateKnowledgeGraphInput(
  input: Record<string, unknown>,
  operation: PlatformMemoryOperation
): void {
  if (operation === "kg_query") {
    assertExactKeys(input, ["entity", "as_of", "direction"], operation);
    requiredString(input, "entity");
    optionalString(input, "as_of");
    if (
      input.direction !== undefined &&
      input.direction !== "incoming" &&
      input.direction !== "outgoing" &&
      input.direction !== "both"
    ) {
      invalidRequest("direction must be incoming, outgoing, or both");
    }
    return;
  }
  if (operation === "kg_timeline") {
    assertExactKeys(input, ["entity"], operation);
    optionalString(input, "entity");
    return;
  }
  if (operation === "kg_stats") {
    assertExactKeys(input, [], operation);
    return;
  }
  if (operation === "kg_supersede") {
    assertExactKeys(input, ["subject", "predicate", "old_object", "new_object", "at"], operation);
    for (const key of ["subject", "predicate", "old_object", "new_object"]) {
      requiredString(input, key);
    }
    optionalString(input, "at");
    return;
  }
  const keys =
    operation === "kg_add"
      ? [
          "subject",
          "predicate",
          "object",
          "valid_from",
          "valid_to",
          "source_closet",
          "source_file",
          "source_drawer_id",
        ]
      : ["subject", "predicate", "object", "ended"];
  assertExactKeys(input, keys, operation);
  for (const key of ["subject", "predicate", "object"]) requiredString(input, key);
  for (const key of keys.slice(3)) optionalString(input, key);
}

export function assertPlatformMemoryOperationAllowed(
  config: ValidatedPlatformMemoryConfigV1,
  operation: unknown
): asserts operation is PlatformMemoryOperation {
  if (config.mode === "none") {
    throw new PlatformMemoryError("MEMORY_DISABLED", "memory mode is none");
  }
  if (
    typeof operation !== "string" ||
    !OPERATION_CAPABILITY.has(operation as PlatformMemoryOperation)
  ) {
    throw new PlatformMemoryError(
      "MEMORY_OPERATION_FORBIDDEN",
      "operation is outside the platform-memory contract"
    );
  }
  const capability = OPERATION_CAPABILITY.get(operation as PlatformMemoryOperation);
  if (!capability || !config.capabilities.includes(capability)) {
    throw new PlatformMemoryError(
      "MEMORY_OPERATION_FORBIDDEN",
      "operation is not granted by the configured memory capabilities"
    );
  }
}

export function validatePlatformMemoryOperationInput(
  operation: PlatformMemoryOperation,
  value: unknown
): Record<string, unknown> {
  const input = asRecord(value);
  if (operation === "search" || operation === "smart_search") {
    validateSearch(input, operation);
  } else if (operation === "get_drawer") {
    assertExactKeys(input, ["drawer_id"], operation);
    requiredString(input, "drawer_id");
  } else if (operation === "list_drawers") {
    assertExactKeys(
      input,
      ["wing", "room", "since", "before", "limit", "offset", "include_full"],
      operation
    );
    for (const key of ["wing", "room", "since", "before"]) optionalString(input, key);
    optionalInteger(input, "limit", 1, MAX_LIST_RESULTS);
    optionalInteger(input, "offset", 0, Number.MAX_SAFE_INTEGER);
    optionalBoolean(input, "include_full");
  } else if (operation === "get_taxonomy") {
    assertExactKeys(input, [], operation);
  } else if (operation === "check_duplicate") {
    assertExactKeys(input, ["content", "threshold"], operation);
    requiredString(input, "content", MAX_CONTENT_CHARACTERS);
    optionalNumber(input, "threshold", 0, 1);
  } else if (operation === "add_drawer") {
    assertExactKeys(input, ["wing", "room", "content", "source_file", "added_by"], operation);
    requiredString(input, "wing");
    requiredString(input, "room");
    requiredString(input, "content", MAX_CONTENT_CHARACTERS);
    optionalString(input, "source_file");
    optionalString(input, "added_by");
  } else if (operation === "diary_read") {
    assertExactKeys(input, ["last_n", "wing"], operation);
    optionalInteger(input, "last_n", 1, MAX_DIARY_RESULTS);
    optionalString(input, "wing");
  } else if (operation === "diary_write") {
    assertExactKeys(input, ["entry", "topic", "wing"], operation);
    requiredString(input, "entry", MAX_QUERY_CHARACTERS);
    optionalString(input, "topic");
    optionalString(input, "wing");
  } else {
    validateKnowledgeGraphInput(input, operation);
  }
  return { ...input };
}

export function allowedPlatformMemoryOperations(
  config: ValidatedPlatformMemoryConfigV1
): readonly PlatformMemoryOperation[] {
  if (config.mode === "none") return [];
  return PLATFORM_MEMORY_OPERATIONS.filter((operation) => {
    const capability = OPERATION_CAPABILITY.get(operation);
    return capability !== undefined && config.capabilities.includes(capability);
  });
}
