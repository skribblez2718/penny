import { Type, type TSchema } from "@sinclair/typebox";
import {
  PLATFORM_MEMORY_CAPABILITY_OPERATIONS,
  type PlatformMemoryCapability,
} from "platform-memory";

import type { MemoryAdapter } from "./adapter.js";
import { CANONICAL_KG_PREDICATES, KG_PREDICATE_SCHEMA_VERSION } from "./kg-policy.js";
import { assessReleaseHeadroom } from "../lib/tool-result-budget.js";
import type { MemoryCallContext, MemoryOperation, MemoryTelemetry } from "./types.js";

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

interface ToolDefinition {
  operation: MemoryOperation;
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
}

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

const definitions: readonly ToolDefinition[] = [
  {
    operation: "smart_search",
    name: "memory_smart_search",
    label: "Memory: smart search",
    description:
      "Recall bounded summary/metadata candidates. Request verbatim content only when needed; every result has a hard final-envelope budget and explicit continuation.",
    parameters: Type.Object(SearchProperties, { additionalProperties: false }),
  },
  {
    operation: "search",
    name: "memory_search",
    label: "Memory: search",
    description:
      "Compatibility recall search. Defaults to bounded summary/metadata candidates; include_full or verbatim remains hard-bounded.",
    parameters: Type.Object(SearchProperties, { additionalProperties: false }),
  },
  {
    operation: "get_drawer",
    name: "memory_get_drawer",
    label: "Memory: exact drawer",
    description:
      "Read one drawer exactly by ID. Large UTF-8 content is returned in digest-bound byte ranges that reassemble exactly.",
    parameters: Type.Object(
      {
        drawer_id: Type.String({ minLength: 1, maxLength: 1024 }),
        cursor: CursorSchema,
      },
      { additionalProperties: false }
    ),
  },
  {
    operation: "list_drawers",
    name: "memory_list_drawers",
    label: "Memory: list drawers",
    description:
      "Bounded drawer candidate listing with filters and upstream pagination. This is not an unrestricted export surface.",
    parameters: Type.Object(
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
  },
  {
    operation: "get_taxonomy",
    name: "memory_get_taxonomy",
    label: "Memory: taxonomy",
    description: "Return the bounded memory taxonomy. Oversized taxonomies use exact continuation.",
    parameters: Type.Object({ cursor: CursorSchema }, { additionalProperties: false }),
  },
  {
    operation: "check_duplicate",
    name: "memory_check_duplicate",
    label: "Memory: duplicate check",
    description: "Check whether proposed durable content already exists before curation.",
    parameters: Type.Object(
      {
        content: Type.String({ minLength: 1, maxLength: 4_194_304 }),
        threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.9 })),
        cursor: CursorSchema,
      },
      { additionalProperties: false }
    ),
  },
  {
    operation: "add_drawer",
    name: "memory_add_drawer",
    label: "Memory: add drawer",
    description: "Curate one durable verbatim memory. This is not workflow-state transport.",
    parameters: Type.Object(
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
  },
  {
    operation: "diary_read",
    name: "memory_diary_read",
    label: "Memory: diary read",
    description: "Read bounded primary Penny diary continuity when it is relevant.",
    parameters: Type.Object(
      {
        agent_name: Type.Literal("penny"),
        last_n: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
        wing: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        cursor: CursorSchema,
      },
      { additionalProperties: false }
    ),
  },
  {
    operation: "diary_write",
    name: "memory_diary_write",
    label: "Memory: diary write",
    description: "Write one bounded primary Penny diary entry.",
    parameters: Type.Object(
      {
        agent_name: Type.Literal("penny"),
        entry: Type.String({ minLength: 1, maxLength: 4096 }),
        topic: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        wing: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        cursor: CursorSchema,
      },
      { additionalProperties: false }
    ),
  },
  {
    operation: "kg_query",
    name: "memory_kg_query",
    label: "Memory: KG query",
    description: "Query bounded temporal facts for one entity.",
    parameters: Type.Object(
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
  },
  {
    operation: "kg_timeline",
    name: "memory_kg_timeline",
    label: "Memory: KG timeline",
    description: "Read a bounded chronological fact timeline with exact continuation.",
    parameters: Type.Object(
      {
        entity: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        cursor: CursorSchema,
      },
      { additionalProperties: false }
    ),
  },
  {
    operation: "kg_stats",
    name: "memory_kg_stats",
    label: "Memory: KG stats",
    description: "Read bounded knowledge-graph statistics.",
    parameters: Type.Object({ cursor: CursorSchema }, { additionalProperties: false }),
  },
  {
    operation: "kg_add",
    name: "memory_kg_add",
    label: "Memory: KG add",
    description: `Add one justified temporal fact using canonical predicate schema v${KG_PREDICATE_SCHEMA_VERSION}.`,
    parameters: Type.Object(
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
  },
  {
    operation: "kg_invalidate",
    name: "memory_kg_invalidate",
    label: "Memory: KG invalidate",
    description: `End one canonical temporal fact under predicate schema v${KG_PREDICATE_SCHEMA_VERSION}.`,
    parameters: Type.Object(
      {
        subject: Type.String({ minLength: 1, maxLength: 512 }),
        predicate: PredicateSchema,
        object: Type.String({ minLength: 1, maxLength: 512 }),
        ended: DateSchema,
        cursor: CursorSchema,
      },
      { additionalProperties: false }
    ),
  },
  {
    operation: "kg_supersede",
    name: "memory_kg_supersede",
    label: "Memory: KG supersede",
    description: `Atomically replace one canonical temporal fact under predicate schema v${KG_PREDICATE_SCHEMA_VERSION}.`,
    parameters: Type.Object(
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
  },
];

const WRITE_OPERATIONS = new Set<MemoryOperation>([
  "add_drawer",
  "diary_write",
  "kg_add",
  "kg_invalidate",
  "kg_supersede",
]);

export function createPrimaryMemoryTools(options: {
  adapter: MemoryAdapter;
  callerId: () => string;
  writeEnabled?: boolean;
  telemetry?: MemoryTelemetry;
}) {
  return definitions
    .filter(
      (definition) => options.writeEnabled === true || !WRITE_OPERATIONS.has(definition.operation)
    )
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

export function primaryMemoryToolNames(options: { writeEnabled?: boolean } = {}): string[] {
  return definitions
    .filter(
      (definition) => options.writeEnabled === true || !WRITE_OPERATIONS.has(definition.operation)
    )
    .map((definition) => definition.name);
}
