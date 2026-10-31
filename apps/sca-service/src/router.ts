import { createHash, timingSafeEqual } from "node:crypto";

import { isScaOperationKind, SCA_ADAPTER_REGISTRY, type ScaAdapterRegistry } from "./adapters.js";
import { validateScaAuthenticationToken } from "./config.js";
import {
  ScaBrokerContractError,
  validateScaBrokerCancelRequestV1,
  validateScaBrokerCapabilityRequestV1,
  validateScaBrokerCapabilityResultV1,
  validateScaBrokerExecuteRequestV1,
  validateScaBrokerPollRequestV1,
  validateScaBrokerTypedErrorV1,
  type ScaBrokerCancelResultV1,
  type ScaBrokerCapabilityResultV1,
  type ScaBrokerExecuteAcceptedResultV2,
  type ScaBrokerPollResultV2,
  type ScaBrokerTypedErrorV1,
} from "./contracts.js";
import { ScaJobOwner, ScaJobOwnerError } from "./jobs.js";
import { ScaJobStoreError, type ScaJobStore } from "./job-store.js";

export const SCA_SERVICE_IPC_PROTOCOL = "penny.sca-service-ipc.v1" as const;

export type ScaServiceAction = "capability" | "execute" | "poll" | "cancel";

export interface ScaServiceRequestFrameV1 {
  readonly protocol: typeof SCA_SERVICE_IPC_PROTOCOL;
  readonly action: ScaServiceAction;
  readonly token: string;
  readonly request: unknown;
}

export type ScaServiceSuccessResponseV1 =
  | {
      readonly protocol: typeof SCA_SERVICE_IPC_PROTOCOL;
      readonly ok: true;
      readonly action: "capability";
      readonly result: ScaBrokerCapabilityResultV1;
    }
  | {
      readonly protocol: typeof SCA_SERVICE_IPC_PROTOCOL;
      readonly ok: true;
      readonly action: "execute";
      readonly result: ScaBrokerExecuteAcceptedResultV2;
    }
  | {
      readonly protocol: typeof SCA_SERVICE_IPC_PROTOCOL;
      readonly ok: true;
      readonly action: "poll";
      readonly result: ScaBrokerPollResultV2;
    }
  | {
      readonly protocol: typeof SCA_SERVICE_IPC_PROTOCOL;
      readonly ok: true;
      readonly action: "cancel";
      readonly result: ScaBrokerCancelResultV1;
    };

export interface ScaServiceErrorResponseV1 {
  readonly protocol: typeof SCA_SERVICE_IPC_PROTOCOL;
  readonly ok: false;
  readonly action: ScaServiceAction | null;
  readonly error: ScaBrokerTypedErrorV1;
}

export type ScaServiceResponseV1 = ScaServiceSuccessResponseV1 | ScaServiceErrorResponseV1;

export interface ScaRouter {
  route(frame: unknown): Promise<ScaServiceResponseV1>;
  shutdown(cleanupTimeoutMs: number): Promise<void>;
}

export interface ScaRouterOptions {
  readonly authenticationToken: string;
  readonly now?: () => Date;
  readonly adapters?: ScaAdapterRegistry;
  readonly maxRetainedJobs?: number;
  readonly jobStore?: ScaJobStore;
}

const REQUEST_FRAME_KEYS = new Set(["protocol", "action", "token", "request"]);
const ACTIONS = new Set<ScaServiceAction>(["capability", "execute", "poll", "cancel"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is ScaServiceAction {
  return typeof value === "string" && [...ACTIONS].some((action) => action === value);
}

function hasExactFrameKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === REQUEST_FRAME_KEYS.size && keys.every((key) => REQUEST_FRAME_KEYS.has(key))
  );
}

function digestToken(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function typedError(code: ScaBrokerTypedErrorV1["code"], message: string): ScaBrokerTypedErrorV1 {
  return validateScaBrokerTypedErrorV1({ code, message });
}

export function createScaServiceErrorResponse(
  action: ScaServiceAction | null,
  code: ScaBrokerTypedErrorV1["code"],
  message: string
): ScaServiceErrorResponseV1 {
  return {
    protocol: SCA_SERVICE_IPC_PROTOCOL,
    ok: false,
    action,
    error: typedError(code, message),
  };
}

function invalidRequest(action: ScaServiceAction | null): ScaServiceErrorResponseV1 {
  return createScaServiceErrorResponse(action, "invalid_request", "request failed validation");
}

function unsupportedOperation(action: ScaServiceAction | null): ScaServiceErrorResponseV1 {
  return createScaServiceErrorResponse(action, "unsupported_operation", "operation is unsupported");
}

function unavailable(action: ScaServiceAction): ScaServiceErrorResponseV1 {
  return createScaServiceErrorResponse(action, "service_unavailable", "SCA adapter is unavailable");
}

function requestWindowError(
  action: ScaServiceAction,
  requestedAt: string,
  deadlineAt: string,
  now: Date
): ScaServiceErrorResponseV1 | null {
  const nowMs = now.getTime();
  const requestedMs = Date.parse(requestedAt);
  const deadlineMs = Date.parse(deadlineAt);
  if (nowMs < requestedMs) return invalidRequest(action);
  if (nowMs > deadlineMs) {
    return createScaServiceErrorResponse(action, "timeout", "request deadline has expired");
  }
  return null;
}

function requestHasUnknownOperation(request: unknown): boolean {
  if (!isRecord(request)) return false;
  return typeof request.operation === "string" && !isScaOperationKind(request.operation);
}

function jobError(action: ScaServiceAction, error: unknown): ScaServiceErrorResponseV1 {
  if (error instanceof ScaJobOwnerError || error instanceof ScaJobStoreError) {
    return createScaServiceErrorResponse(action, error.code, error.message);
  }
  if (error instanceof ScaBrokerContractError) {
    return createScaServiceErrorResponse(action, error.code, "broker contract validation failed");
  }
  return createScaServiceErrorResponse(action, "failed", "SCA job processing failed");
}

export function createScaRouter(options: ScaRouterOptions): ScaRouter {
  const expectedTokenDigest = digestToken(
    validateScaAuthenticationToken(options.authenticationToken)
  );
  const now = options.now ?? (() => new Date());
  const adapters = options.adapters ?? SCA_ADAPTER_REGISTRY;
  const jobs = new ScaJobOwner({
    adapters,
    now,
    ...(options.jobStore === undefined ? {} : { jobStore: options.jobStore }),
    ...(options.maxRetainedJobs === undefined ? {} : { maxRetainedJobs: options.maxRetainedJobs }),
  });

  return Object.freeze({
    async route(frame: unknown): Promise<ScaServiceResponseV1> {
      if (!isRecord(frame)) return invalidRequest(null);
      if (
        typeof frame.token !== "string" ||
        !timingSafeEqual(digestToken(frame.token), expectedTokenDigest)
      ) {
        return createScaServiceErrorResponse(null, "unauthorized", "authorization failed");
      }
      if (!hasExactFrameKeys(frame) || frame.protocol !== SCA_SERVICE_IPC_PROTOCOL) {
        return invalidRequest(isAction(frame.action) ? frame.action : null);
      }
      if (!isAction(frame.action)) {
        return typeof frame.action === "string" ? unsupportedOperation(null) : invalidRequest(null);
      }
      if (requestHasUnknownOperation(frame.request)) return unsupportedOperation(frame.action);

      const observedAt = now();
      if (!Number.isFinite(observedAt.getTime())) throw new Error("SCA router clock is invalid");

      switch (frame.action) {
        case "capability": {
          let request;
          try {
            request = validateScaBrokerCapabilityRequestV1(frame.request);
          } catch {
            return invalidRequest("capability");
          }
          const windowError = requestWindowError(
            "capability",
            request.requested_at,
            request.deadline_at,
            observedAt
          );
          if (windowError) return windowError;
          const adapter = adapters[request.operation];
          if (adapter === null) {
            const result = validateScaBrokerCapabilityResultV1(
              {
                schema_id: "penny.sca-broker-capability-result.v1",
                schema_version: 1,
                request_id: request.request_id,
                tenant_id: request.tenant_id,
                project_id: request.project_id,
                run_id: request.run_id,
                tool_name: request.tool_name,
                operation: request.operation,
                status: "unavailable",
                limits: null,
                observed_at: observedAt.toISOString(),
                error: typedError("service_unavailable", "SCA adapter is unavailable"),
              },
              request
            );
            return {
              protocol: SCA_SERVICE_IPC_PROTOCOL,
              ok: true,
              action: "capability",
              result,
            };
          }
          try {
            const result = validateScaBrokerCapabilityResultV1(
              await adapter.capability(request),
              request
            );
            return {
              protocol: SCA_SERVICE_IPC_PROTOCOL,
              ok: true,
              action: "capability",
              result,
            };
          } catch (error) {
            return jobError("capability", error);
          }
        }
        case "execute": {
          let request;
          try {
            request = validateScaBrokerExecuteRequestV1(frame.request);
          } catch {
            return invalidRequest("execute");
          }
          const windowError = requestWindowError(
            "execute",
            request.submitted_at,
            request.deadline_at,
            observedAt
          );
          if (windowError) return windowError;
          if (options.jobStore === undefined && adapters[request.operation] === null)
            return unavailable("execute");
          try {
            return {
              protocol: SCA_SERVICE_IPC_PROTOCOL,
              ok: true,
              action: "execute",
              result: jobs.execute(request),
            };
          } catch (error) {
            return jobError("execute", error);
          }
        }
        case "poll": {
          let request;
          try {
            request = validateScaBrokerPollRequestV1(frame.request);
          } catch {
            return invalidRequest("poll");
          }
          const windowError = requestWindowError(
            "poll",
            request.requested_at,
            request.deadline_at,
            observedAt
          );
          if (windowError) return windowError;
          if (options.jobStore === undefined && adapters[request.operation] === null)
            return unavailable("poll");
          try {
            return {
              protocol: SCA_SERVICE_IPC_PROTOCOL,
              ok: true,
              action: "poll",
              result: jobs.poll(request),
            };
          } catch (error) {
            return jobError("poll", error);
          }
        }
        case "cancel": {
          let request;
          try {
            request = validateScaBrokerCancelRequestV1(frame.request);
          } catch {
            return invalidRequest("cancel");
          }
          const windowError = requestWindowError(
            "cancel",
            request.requested_at,
            request.deadline_at,
            observedAt
          );
          if (windowError) return windowError;
          if (options.jobStore === undefined && adapters[request.operation] === null)
            return unavailable("cancel");
          try {
            return {
              protocol: SCA_SERVICE_IPC_PROTOCOL,
              ok: true,
              action: "cancel",
              result: jobs.cancel(request),
            };
          } catch (error) {
            return jobError("cancel", error);
          }
        }
      }
    },
    async shutdown(cleanupTimeoutMs: number): Promise<void> {
      await jobs.shutdown(cleanupTimeoutMs);
    },
  });
}
