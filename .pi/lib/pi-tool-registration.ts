import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

/**
 * A project-local adapter for Pi tool results.
 *
 * Pi's SDK requires every `AgentToolResult` to carry a `details` key. Penny's
 * established tool contracts allow text-only results, especially on errors.
 * Keep that compatibility at one explicit boundary: tool implementations may
 * omit `details`, and this adapter supplies `undefined` before Pi receives the
 * result. Parameter types remain derived from each TypeBox schema.
 */
export type ProjectToolResult<TDetails = unknown> = Omit<AgentToolResult<TDetails>, "details"> & {
  details?: TDetails;
  /** Legacy Penny error marker preserved for existing text-only result contracts. */
  isError?: boolean;
};

export type ProjectToolDefinition<
  TParams extends TSchema,
  TDetails = unknown,
  TState = unknown,
> = Omit<ToolDefinition<TParams, NoInfer<TDetails> | undefined, TState>, "execute"> & {
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<NoInfer<TDetails> | undefined> | undefined,
    ctx: ExtensionContext
  ): Promise<ProjectToolResult<NoInfer<TDetails>>>;
};

/**
 * Register a TypeBox-schema-derived Penny tool with Pi.
 *
 * This is intentionally the only compatibility layer for optional `details`.
 * It must not be used to erase parameter, context, or update callback types.
 */
export function registerTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
  pi: ExtensionAPI,
  tool: ProjectToolDefinition<TParams, TDetails, TState>
): void {
  const { execute, ...definition } = tool;
  pi.registerTool<TParams, TDetails | undefined, TState>({
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await execute(toolCallId, params, signal, onUpdate, ctx);
      return { ...result, details: result.details };
    },
  });
}
