import { Type, type Static } from "typebox";
import {
  PLATFORM_MEMORY_CAPABILITY_OPERATIONS,
  type PlatformMemoryCapability,
} from "platform-memory";

import type { MemoryAdapter } from "./adapter.js";
import { CANONICAL_KG_PREDICATES, KG_PREDICATE_SCHEMA_VERSION } from "./kg-policy.js";
import {
  assessReleaseHeadroom,
  createTextToolResult,
  type TextToolResult,
} from "../lib/tool-result-budget.js";
import {
  MEMORY_SCHEMA_VERSION,
  type MemoryCallContext,
  type MemoryOperation,
  type MemoryTelemetry,
} from "./types.js";

const CursorSchema = Type.Optional(
  Type.String({ minLength: 1, maxLength: 4096, description: "Opaque continuation cursor" })
);
const DateSchema = Type.Optional(
  Type.String({
    minLength: 10,
    maxLength: 30,
    description: "ISO date or canonical UTC datetime",
  })
);
const PredicateSchema = Type.String({
  enum: [...CANONICAL_KG_PREDICATES],
  description: `Canonical KG predicate schema v${KG_PREDICATE_SCHEMA_VERSION}`,
});

const TOOL_NAME_BY_OPERATION: Readonly<Record<MemoryOperation, string>> = Object.freeze({
  search: "memory_search",
  smart_search: "memory_smart_search",
  get_drawer: "memory_get_drawer",
  list_drawers: "memory_list_drawers",
  get_taxonomy: "memory_get_taxonomy",
  check_duplicate: "memory_check_duplicate",
  add_drawer: "memory_add_drawer",
  diary_read: "memory_diary_read",
  diary_write: "memory_diary_write",
  kg_query: "memory_kg_query",
  kg_add: "memory_kg_add",
  kg_invalidate: "memory_kg_invalidate",
  kg_supersede: "memory_kg_supersede",
  kg_timeline: "memory_kg_timeline",
  kg_stats: "memory_kg_stats",
});

function toolNamesFor(capability: PlatformMemoryCapability): readonly string[] {
  return PLATFORM_MEMORY_CAPABILITY_OPERATIONS[capability].map(
    (operation) => TOOL_NAME_BY_OPERATION[operation]
  );
}

export const PRIMARY_MEMORY_TOOL_BUNDLES = Object.freeze({
  "memory-recall-read": toolNamesFor("recall-read"),
  "memory-curated-write": toolNamesFor("curated-write"),
  "memory-diary": toolNamesFor("primary-diary"),
  "memory-kg-read": toolNamesFor("kg-read"),
  "memory-kg-write": toolNamesFor("kg-write"),
});

export const FORBIDDEN_MODEL_MEMORY_TOOLS = Object.freeze([
  "memory_delete_drawer",
  "memory_delete_drawers_by_room",
  "memory_export",
  "memory_backup",
  "memory_repair",
  "memory_migrate",
  "memory_admin",
]);

const SearchProperties = {
  query: Type.String({
    minLength: 1,
    maxLength: 250,
    description: "Natural-language recall query",
  }),
  context: Type.Optional(
    Type.String({ maxLength: 4096, description: "Optional retrieval context" })
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 3 })),
  wing: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  room: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  source_file: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  since: DateSchema,
  before: DateSchema,
  min_similarity: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.25 })),
  include_full: Type.Optional(
    Type.Boolean({
      description: "Return verbatim candidates; oversized results continue explicitly",
    })
  ),
  verbatim: Type.Optional(Type.Boolean({ description: "Compatibility alias for include_full" })),
  cursor: CursorSchema,
};

const MEMORY_PARAMETER_SCHEMAS = {
  smart_search: Type.Object(SearchProperties, { additionalProperties: false }),
  search: Type.Object(SearchProperties, { additionalProperties: false }),
  get_drawer: Type.Object(
    {
      drawer_id: Type.String({ minLength: 1, maxLength: 1024 }),
      cursor: CursorSchema,
    },
    { additionalProperties: false }
  ),
  list_drawers: Type.Object(
    {
      wing: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      room: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      since: DateSchema,
      before: DateSchema,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
      include_full: Type.Optional(Type.Boolean()),
      cursor: CursorSchema,
    },
    { additionalProperties: false }
  ),
  get_taxonomy: Type.Object({ cursor: CursorSchema }, { additionalProperties: false }),
  check_duplicate: Type.Object(
    {
      content: Type.String({ minLength: 1, maxLength: 4_194_304 }),
      threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.9 })),
      cursor: CursorSchema,
    },
    { additionalProperties: false }
  ),
  add_drawer: Type.Object(
    {
      wing: Type.String({ minLength: 1, maxLength: 256 }),
      room: Type.String({ minLength: 1, maxLength: 256 }),
      content: Type.String({ minLength: 1, maxLength: 4_194_304 }),
      source_file: Type.Optional(Type.String({ maxLength: 4096 })),
      added_by: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      cursor: CursorSchema,
    },
    { additionalProperties: false }
  ),
  diary_read: Type.Object(
    {
      agent_name: Type.Literal("penny"),
      last_n: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
      wing: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      cursor: CursorSchema,
    },
    { additionalProperties: false }
  ),
  diary_write: Type.Object(
    {
      agent_name: Type.Literal("penny"),
      entry: Type.String({ minLength: 1, maxLength: 4096 }),
      topic: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      wing: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      cursor: CursorSchema,
    },
    { additionalProperties: false }
  ),
  kg_query: Type.Object(
    {
      entity: Type.String({ minLength: 1, maxLength: 512 }),
      as_of: DateSchema,
      direction: Type.Optional(
        Type.Union([Type.Literal("outgoing"), Type.Literal("incoming"), Type.Literal("both")])
      ),
      cursor: CursorSchema,
    },
    { additionalProperties: false }
  ),
  kg_timeline: Type.Object(
    {
      entity: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      cursor: CursorSchema,
    },
    { additionalProperties: false }
  ),
  kg_stats: Type.Object({ cursor: CursorSchema }, { additionalProperties: false }),
  kg_add: Type.Object(
    {
      subject: Type.String({ minLength: 1, maxLength: 512 }),
      predicate: PredicateSchema,
      object: Type.String({ minLength: 1, maxLength: 512 }),
      valid_from: DateSchema,
      valid_to: DateSchema,
      source_closet: Type.Optional(Type.String({ maxLength: 1024 })),
      source_file: Type.Optional(Type.String({ maxLength: 4096 })),
      source_drawer_id: Type.Optional(Type.String({ maxLength: 1024 })),
      cursor: CursorSchema,
    },
    { additionalProperties: false }
  ),
  kg_invalidate: Type.Object(
    {
      subject: Type.String({ minLength: 1, maxLength: 512 }),
      predicate: PredicateSchema,
      object: Type.String({ minLength: 1, maxLength: 512 }),
      ended: DateSchema,
      cursor: CursorSchema,
    },
    { additionalProperties: false }
  ),
  kg_supersede: Type.Object(
    {
      subject: Type.String({ minLength: 1, maxLength: 512 }),
      predicate: PredicateSchema,
      old_object: Type.String({ minLength: 1, maxLength: 512 }),
      new_object: Type.String({ minLength: 1, maxLength: 512 }),
      at: DateSchema,
      cursor: CursorSchema,
    },
    { additionalProperties: false }
  ),
};

type MemoryParameterSchemaByOperation = typeof MEMORY_PARAMETER_SCHEMAS;
type MemoryParameterSchema = MemoryParameterSchemaByOperation[MemoryOperation];

export type MemoryOperationSchemaPair = {
  [Operation in MemoryOperation]: {
    operation: Operation;
    parameters: MemoryParameterSchemaByOperation[Operation];
  };
}[MemoryOperation];

/**
 * Uncallable common shape for heterogeneous registration arrays. The
 * schema-specific Static overload below remains the only callable callback.
 */
interface MemoryToolRegistrationShape {
  name: string;
  label: string;
  description: string;
  parameters: MemoryParameterSchema;
  execute(toolCallId: string, params: never, signal?: AbortSignal): Promise<TextToolResult>;
}

type CorrelatedMemoryTool<
  Name extends string,
  Parameters extends MemoryParameterSchema,
> = MemoryToolRegistrationShape & {
  name: Name;
  execute(
    toolCallId: string,
    params: Static<Parameters>,
    signal?: AbortSignal
  ): Promise<TextToolResult>;
};

interface PrimaryMemoryToolOptions {
  adapter: MemoryAdapter;
  callerId: () => string;
  writeEnabled?: boolean;
  telemetry?: MemoryTelemetry;
}

interface UnavailableMemoryToolOptions {
  writeEnabled?: boolean;
  code?: string;
  message?: string;
}

function defineMemoryTool<
  const Operation extends MemoryOperation,
  const Name extends string,
  const Parameters extends MemoryParameterSchemaByOperation[NoInfer<Operation>],
>(definition: {
  operation: Operation;
  name: Name;
  label: string;
  description: string;
  parameters: Parameters;
}) {
  return {
    ...definition,
    create(options: PrimaryMemoryToolOptions): CorrelatedMemoryTool<Name, Parameters> {
      return {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters,
        async execute(_toolCallId: string, params: Static<Parameters>, signal?: AbortSignal) {
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
      };
    },
    createUnavailable(
      options: UnavailableMemoryToolOptions
    ): CorrelatedMemoryTool<Name, Parameters> {
      return {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters,
        async execute(_toolCallId: string, _params: Static<Parameters>, _signal?: AbortSignal) {
          return createTextToolResult(
            {
              schema_version: MEMORY_SCHEMA_VERSION,
              ok: false,
              type: "memory_error",
              error: {
                code: options.code ?? "MEMPALACE_UNAVAILABLE",
                message: options.message ?? "Memory service is unavailable or not configured",
                retryable: true,
              },
            },
            { isError: true }
          );
        },
      };
    },
  };
}

const definitions = [
  defineMemoryTool({
    operation: "smart_search",
    name: "memory_smart_search",
    label: "Memory: smart search",
    description:
      "Recall bounded summary/metadata candidates. Request verbatim content only when needed; every result has a hard final-envelope budget and explicit continuation.",
    parameters: MEMORY_PARAMETER_SCHEMAS.smart_search,
  }),
  defineMemoryTool({
    operation: "search",
    name: "memory_search",
    label: "Memory: search",
    description:
      "Compatibility recall search. Defaults to bounded summary/metadata candidates; include_full or verbatim remains hard-bounded.",
    parameters: MEMORY_PARAMETER_SCHEMAS.search,
  }),
  defineMemoryTool({
    operation: "get_drawer",
    name: "memory_get_drawer",
    label: "Memory: exact drawer",
    description:
      "Read one drawer exactly by ID. Large UTF-8 content is returned in digest-bound byte ranges that reassemble exactly.",
    parameters: MEMORY_PARAMETER_SCHEMAS.get_drawer,
  }),
  defineMemoryTool({
    operation: "list_drawers",
    name: "memory_list_drawers",
    label: "Memory: list drawers",
    description:
      "Bounded drawer candidate listing with filters and upstream pagination. This is not an unrestricted export surface.",
    parameters: MEMORY_PARAMETER_SCHEMAS.list_drawers,
  }),
  defineMemoryTool({
    operation: "get_taxonomy",
    name: "memory_get_taxonomy",
    label: "Memory: taxonomy",
    description: "Return the bounded memory taxonomy. Oversized taxonomies use exact continuation.",
    parameters: MEMORY_PARAMETER_SCHEMAS.get_taxonomy,
  }),
  defineMemoryTool({
    operation: "check_duplicate",
    name: "memory_check_duplicate",
    label: "Memory: duplicate check",
    description: "Check whether proposed durable content already exists before curation.",
    parameters: MEMORY_PARAMETER_SCHEMAS.check_duplicate,
  }),
  defineMemoryTool({
    operation: "add_drawer",
    name: "memory_add_drawer",
    label: "Memory: add drawer",
    description:
      "Curate one durable verbatim memory after checking for duplication. Use only for reusable cross-session content worth preserving; do not use for workflow state, transient progress, or speculative notes.",
    parameters: MEMORY_PARAMETER_SCHEMAS.add_drawer,
  }),
  defineMemoryTool({
    operation: "diary_read",
    name: "memory_diary_read",
    label: "Memory: diary read",
    description: "Read bounded primary Penny diary continuity when it is relevant.",
    parameters: MEMORY_PARAMETER_SCHEMAS.diary_read,
  }),
  defineMemoryTool({
    operation: "diary_write",
    name: "memory_diary_write",
    label: "Memory: diary write",
    description:
      "Write one bounded primary Penny diary entry. Use for durable first-person continuity when a diary entry is materially warranted; do not use for routine logs, workflow handoff, or duplicate content.",
    parameters: MEMORY_PARAMETER_SCHEMAS.diary_write,
  }),
  defineMemoryTool({
    operation: "kg_query",
    name: "memory_kg_query",
    label: "Memory: KG query",
    description: "Query bounded temporal facts for one entity.",
    parameters: MEMORY_PARAMETER_SCHEMAS.kg_query,
  }),
  defineMemoryTool({
    operation: "kg_timeline",
    name: "memory_kg_timeline",
    label: "Memory: KG timeline",
    description: "Read a bounded chronological fact timeline with exact continuation.",
    parameters: MEMORY_PARAMETER_SCHEMAS.kg_timeline,
  }),
  defineMemoryTool({
    operation: "kg_stats",
    name: "memory_kg_stats",
    label: "Memory: KG stats",
    description: "Read bounded knowledge-graph statistics.",
    parameters: MEMORY_PARAMETER_SCHEMAS.kg_stats,
  }),
  defineMemoryTool({
    operation: "kg_add",
    name: "memory_kg_add",
    label: "Memory: KG add",
    description: `Add one justified temporal fact using canonical predicate schema v${KG_PREDICATE_SCHEMA_VERSION}. Use for durable relationships whose source is available; do not use for transient, speculative, or unsupported claims.`,
    parameters: MEMORY_PARAMETER_SCHEMAS.kg_add,
  }),
  defineMemoryTool({
    operation: "kg_invalidate",
    name: "memory_kg_invalidate",
    label: "Memory: KG invalidate",
    description: `End one canonical temporal fact under predicate schema v${KG_PREDICATE_SCHEMA_VERSION}. Use when an existing fact stopped being valid without a direct replacement; do not use to delete history.`,
    parameters: MEMORY_PARAMETER_SCHEMAS.kg_invalidate,
  }),
  defineMemoryTool({
    operation: "kg_supersede",
    name: "memory_kg_supersede",
    label: "Memory: KG supersede",
    description: `Atomically replace one canonical temporal fact under predicate schema v${KG_PREDICATE_SCHEMA_VERSION}. Use when a current fact is superseded by a justified replacement; do not use when the old fact merely ended.`,
    parameters: MEMORY_PARAMETER_SCHEMAS.kg_supersede,
  }),
];

const WRITE_OPERATIONS = new Set<MemoryOperation>([
  "add_drawer",
  "diary_write",
  "kg_add",
  "kg_invalidate",
  "kg_supersede",
]);

export function createPrimaryMemoryTools(options: PrimaryMemoryToolOptions) {
  return definitions
    .filter(
      (definition) => options.writeEnabled === true || !WRITE_OPERATIONS.has(definition.operation)
    )
    .map((definition) => definition.create(options));
}

/**
 * Keep declared memory tools registered when the backing service is unavailable.
 * Availability is an execution outcome, never a reason to mutate an agent's
 * model-visible YAML surface.
 */
export function createUnavailableMemoryTools(options: UnavailableMemoryToolOptions = {}) {
  return definitions
    .filter(
      (definition) => options.writeEnabled === true || !WRITE_OPERATIONS.has(definition.operation)
    )
    .map((definition) => definition.createUnavailable(options));
}

export function primaryMemoryToolNames(options: { writeEnabled?: boolean } = {}): string[] {
  return definitions
    .filter(
      (definition) => options.writeEnabled === true || !WRITE_OPERATIONS.has(definition.operation)
    )
    .map((definition) => definition.name);
}
