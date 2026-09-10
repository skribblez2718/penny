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
  /** An explicit project-level failure marker translated at registration time. */
  isError?: boolean;
};

interface RegistrationState {
  readonly failedToolCallIds: Set<string>;
}

const registrationStates = new WeakMap<ExtensionAPI, RegistrationState>();

/**
 * Pi 0.85 treats a resolved tool execution as successful even when the returned
 * object carries an unknown `isError` property. Its supported `tool_result`
 * middleware can authoritatively replace the error flag without replacing the
 * result content or details, so install one bridge per extension API.
 */
function registrationState(pi: ExtensionAPI): RegistrationState {
  const existing = registrationStates.get(pi);
  if (existing !== undefined) return existing;

  const state: RegistrationState = { failedToolCallIds: new Set<string>() };
  registrationStates.set(pi, state);
  pi.on("tool_result", (event) => {
    if (!state.failedToolCallIds.delete(event.toolCallId)) return undefined;
    return { isError: true };
  });
  return state;
}

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
  const state = registrationState(pi);
  const { execute, ...definition } = tool;
  pi.registerTool<TParams, TDetails | undefined, TState>({
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await execute(toolCallId, params, signal, onUpdate, ctx);
      if (result.isError === true) state.failedToolCallIds.add(toolCallId);
      return { ...result, details: result.details };
    },
  });
}
