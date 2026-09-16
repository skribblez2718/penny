import type {
  ScaBrokerCancelRequestV1,
  ScaBrokerCancelResultV1,
  ScaBrokerCapabilityRequestV1,
  ScaBrokerCapabilityResultV1,
  ScaBrokerExecuteAcceptedResultV1,
  ScaBrokerExecuteRequestV1,
  ScaBrokerPollRequestV1,
  ScaBrokerPollResultV1,
  ScaBrokerOperationKind,
} from "./contracts.js";

export interface ScaOperationAdapter {
  readonly capability: (
    request: ScaBrokerCapabilityRequestV1
  ) => Promise<ScaBrokerCapabilityResultV1>;
  readonly execute: (
    request: ScaBrokerExecuteRequestV1
  ) => Promise<ScaBrokerExecuteAcceptedResultV1>;
  readonly poll: (request: ScaBrokerPollRequestV1) => Promise<ScaBrokerPollResultV1>;
  readonly cancel: (request: ScaBrokerCancelRequestV1) => Promise<ScaBrokerCancelResultV1>;
}

export type ScaAdapterRegistry = Readonly<
  Record<ScaBrokerOperationKind, ScaOperationAdapter | null>
>;

export const SCA_OPERATION_KINDS = Object.freeze([
  "source_query",
  "graph_query",
  "application_test",
] as const satisfies readonly ScaBrokerOperationKind[]);

/** S-03-T2 has no provider adapter. Null entries are an explicit, truthful capability state. */
export const SCA_ADAPTER_REGISTRY: ScaAdapterRegistry = Object.freeze({
  source_query: null,
  graph_query: null,
  application_test: null,
});

export function isScaOperationKind(value: unknown): value is ScaBrokerOperationKind {
  return typeof value === "string" && (SCA_OPERATION_KINDS as readonly string[]).includes(value);
}
