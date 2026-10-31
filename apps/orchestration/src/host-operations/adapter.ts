/**
 * Host adapters are trusted, injected code. Their authority remains registration-bound and their
 * runtime context exposes only exact artifacts, a fenced submission journal, cancellation, and
 * bounded persistence/progress capabilities.
 */
export type {
  HostOperationAdapterTerminalV1,
  HostOperationAdapterV1,
  HostOperationArtifactWriteV1,
  HostOperationExecutionContextV1,
  HostOperationExactInputV1,
  HostOperationFetchedV1,
  HostOperationPersistedOutputV1,
  HostOperationPersistenceInputV1,
  HostOperationRemoteCancellationResultV1,
  HostOperationRequestBindingV1,
  HostOperationRequestInspectionV1,
} from "./contracts.js";
