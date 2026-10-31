import type {
  ScaBrokerCapabilityRequestV1,
  ScaBrokerCapabilityResultV1,
  ScaBrokerExecuteRequestV1,
  ScaBrokerOperationKind,
  ScaBrokerReceiptV1,
} from "./contracts.js";

export interface ScaJobExecutionContext {
  readonly signal: AbortSignal;
  /** Records one broker-observed unit of server work; no target payload or timestamp is accepted. */
  reportWorkMilestone(): void;
  /** Records cumulative output only after the broker owns or has persisted it. */
  reportPersistedOutput(cumulativeBytes: number, cumulativeResultItems: number): void;
  /** Internal containment evidence only; absence of proof must not mint a durable terminal. */
  reportContainmentUnverified?(): void;
}

export interface ScaAdapterTerminalResult {
  readonly terminal_status: ScaBrokerReceiptV1["terminal_status"];
  readonly partial: boolean;
  readonly truncated: boolean;
  readonly output_refs: ScaBrokerReceiptV1["output_refs"];
  readonly result_item_count: number;
  readonly failure: ScaBrokerReceiptV1["failure"];
}

export interface ScaOperationAdapter {
  readonly capability: (
    request: ScaBrokerCapabilityRequestV1
  ) => Promise<ScaBrokerCapabilityResultV1>;
  readonly run: (
    request: ScaBrokerExecuteRequestV1,
    context: ScaJobExecutionContext
  ) => Promise<ScaAdapterTerminalResult>;
}

export type ScaAdapterRegistry = Readonly<
  Record<ScaBrokerOperationKind, ScaOperationAdapter | null>
>;

export const SCA_OPERATION_KINDS = Object.freeze([
  "source_query",
  "graph_query",
  "application_test",
] as const satisfies readonly ScaBrokerOperationKind[]);

/** No provider adapter is compiled into Penny. Null is the explicit capability state. */
export const SCA_ADAPTER_REGISTRY: ScaAdapterRegistry = Object.freeze({
  source_query: null,
  graph_query: null,
  application_test: null,
});

export function isScaOperationKind(value: unknown): value is ScaBrokerOperationKind {
  return typeof value === "string" && (SCA_OPERATION_KINDS as readonly string[]).includes(value);
}
