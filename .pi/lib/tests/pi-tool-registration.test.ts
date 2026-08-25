import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  type ProjectToolDefinition,
  type ProjectToolResult,
  registerTool,
} from "../pi-tool-registration.js";
import { createTestExtensionApi, isRecord } from "./test-narrowers.js";

const ContractParamsSchema = Type.Object({
  name: Type.String(),
  attempts: Type.Integer(),
  tag: Type.Optional(Type.String()),
});

type ContractParams = Static<typeof ContractParamsSchema>;

interface ContractDetails {
  status: "running" | "done";
  attempts: number;
}

type ContractExecute = ProjectToolDefinition<
  typeof ContractParamsSchema,
  ContractDetails
>["execute"];
type ContractExecuteArguments = Parameters<ContractExecute>;
type ContractRenderResult = NonNullable<
  ProjectToolDefinition<typeof ContractParamsSchema, ContractDetails>["renderResult"]
>;

type CapturedRawResult<TDetails> = AgentToolResult<TDetails | undefined> &
  Pick<ProjectToolResult<TDetails>, "isError">;

interface CapturedRawTool<TParams extends TSchema, TDetails> {
  parameters: TParams;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails | undefined> | undefined,
    context: unknown
  ): Promise<CapturedRawResult<TDetails>>;
}

function isCapturedRawTool<TParams extends TSchema, TDetails>(
  value: unknown,
  parameters: TParams
): value is CapturedRawTool<TParams, TDetails> {
  return isRecord(value) && value.parameters === parameters && typeof value.execute === "function";
}

function createRegistrationHost<TParams extends TSchema, TDetails>(
  parameters: TParams
): {
  pi: ExtensionAPI;
  registeredTool(): CapturedRawTool<TParams, TDetails>;
} {
  let registered: CapturedRawTool<TParams, TDetails> | undefined;
  const pi = createTestExtensionApi({
    onRegisterTool(tool) {
      if (!isCapturedRawTool<TParams, TDetails>(tool, parameters)) {
        throw new Error("adapter registered an invalid Pi tool");
      }
      registered = tool;
    },
  });

  return {
    pi,
    registeredTool() {
      if (registered === undefined) throw new Error("adapter did not register a Pi tool");
      return registered;
    },
  };
}

describe("Pi tool registration adapter contract", () => {
  it("derives execute parameters and preserves callback, context, and details types", () => {
    expectTypeOf<ContractExecuteArguments[1]>().toEqualTypeOf<ContractParams>();
    expectTypeOf<ContractExecuteArguments[3]>().toEqualTypeOf<
      AgentToolUpdateCallback<ContractDetails | undefined> | undefined
    >();
    expectTypeOf<ContractExecuteArguments[4]>().toEqualTypeOf<ExtensionContext>();
    expectTypeOf<Awaited<ReturnType<ContractExecute>>>().toEqualTypeOf<
      ProjectToolResult<ContractDetails>
    >();
    expectTypeOf<Parameters<ContractRenderResult>[0]>().toEqualTypeOf<
      AgentToolResult<ContractDetails | undefined>
    >();
  });

  it("forwards parameters, context, update callback, and details without erasure", async () => {
    const host = createRegistrationHost<typeof ContractParamsSchema, ContractDetails>(
      ContractParamsSchema
    );
    const contextMarker = { source: "adapter-contract-test" };
    const abortController = new AbortController();
    const updates: Array<AgentToolResult<ContractDetails | undefined>> = [];
    const onUpdate: AgentToolUpdateCallback<ContractDetails | undefined> = (update) => {
      updates.push(update);
    };
    let observedContext: unknown;
    let observedUpdate: AgentToolUpdateCallback<ContractDetails | undefined> | undefined;
    let observedSignal: AbortSignal | undefined;

    registerTool<typeof ContractParamsSchema, ContractDetails>(host.pi, {
      name: "typed_contract",
      label: "Typed Contract",
      description: "Exercise the shared registration contract",
      parameters: ContractParamsSchema,
      async execute(_toolCallId, params, signal, update, context) {
        observedContext = context;
        observedUpdate = update;
        observedSignal = signal;
        update?.({
          content: [{ type: "text", text: `Running ${params.name}` }],
          details: { status: "running", attempts: params.attempts },
        });
        return {
          content: [{ type: "text", text: `Done ${params.name}` }],
          details: { status: "done", attempts: params.attempts },
        };
      },
    });

    const registered = host.registeredTool();
    const params = { name: "Ada", attempts: 2, tag: "typed" } satisfies ContractParams;
    const result = await registered.execute(
      "call-1",
      params,
      abortController.signal,
      onUpdate,
      contextMarker
    );

    expect(registered.parameters).toBe(ContractParamsSchema);
    expect(observedContext).toBe(contextMarker);
    expect(observedUpdate).toBe(onUpdate);
    expect(observedSignal).toBe(abortController.signal);
    expect(updates).toEqual([
      {
        content: [{ type: "text", text: "Running Ada" }],
        details: { status: "running", attempts: 2 },
      },
    ]);
    expect(result).toEqual({
      content: [{ type: "text", text: "Done Ada" }],
      details: { status: "done", attempts: 2 },
    });
  });

  it("normalizes omitted details once at the raw Pi boundary for text-only results", async () => {
    const TextOnlyParamsSchema = Type.Object({
      outcome: Type.Union([Type.Literal("success"), Type.Literal("error")]),
    });
    type TextOnlyParams = Static<typeof TextOnlyParamsSchema>;
    type Outcome = TextOnlyParams["outcome"];

    const host = createRegistrationHost<typeof TextOnlyParamsSchema, never>(TextOnlyParamsSchema);
    const detailsReads: Record<Outcome, number> = { success: 0, error: 0 };
    const projectResults = new Map<Outcome, ProjectToolResult<never>>();

    registerTool<typeof TextOnlyParamsSchema, never>(host.pi, {
      name: "text_only",
      label: "Text Only",
      description: "Preserve legacy text-only success and error results",
      parameters: TextOnlyParamsSchema,
      async execute(_toolCallId, params) {
        const source: ProjectToolResult<never> =
          params.outcome === "success"
            ? { content: [{ type: "text", text: "ok" }] }
            : { content: [{ type: "text", text: "error" }], isError: true };
        projectResults.set(params.outcome, source);

        return new Proxy(source, {
          get(target, property) {
            if (property === "details") {
              detailsReads[params.outcome] += 1;
              return undefined;
            }
            if (property === "content") return target.content;
            if (property === "isError") return target.isError;
            if (property === "usage") return target.usage;
            if (property === "addedToolNames") return target.addedToolNames;
            if (property === "terminate") return target.terminate;
            return undefined;
          },
        });
      },
    });

    const registered = host.registeredTool();
    for (const outcome of ["success", "error"] as const) {
      const result = await registered.execute(
        `call-${outcome}`,
        { outcome },
        undefined,
        undefined,
        { source: "raw-pi-boundary" }
      );
      const projectResult = projectResults.get(outcome);
      if (projectResult === undefined) throw new Error(`missing ${outcome} project result`);

      expect(Object.hasOwn(projectResult, "details")).toBe(false);
      expect(Object.hasOwn(result, "details")).toBe(true);
      expect(detailsReads[outcome]).toBe(1);
      expect(result.details).toBeUndefined();
      expect(result.content).toEqual(projectResult.content);
      expect(result.isError).toBe(outcome === "error" ? true : undefined);
    }
  });
});
