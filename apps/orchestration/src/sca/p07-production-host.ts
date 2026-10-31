import { lstatSync, realpathSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import path from "node:path";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import type {
  HostOperationAdapterV1,
  HostOperationDeclarationV1,
} from "../host-operations/contracts.js";
import type { HostOperationUseValidatorV1 } from "../host-operations/owner.js";
import {
  validateScaBrokerCancelResultV1,
  validateScaBrokerExecuteAcceptedResult,
  validateScaBrokerPollResult,
  type ScaBrokerCancelRequestV1,
  type ScaBrokerExecuteRequestV1,
  type ScaBrokerPollRequestV1,
} from "./broker-contracts.js";
import { admitScaP07ExecutionPlan, type ScaP07CurrentAuthorityScopeV1 } from "./p07-admission.js";
import {
  validateScaP07AdmissionV1,
  validateScaP07HostRequestV1,
  type ScaP07AdmissionV1,
} from "./p07-contracts.js";
import {
  SCA_P07_OPERATION_KIND,
  createScaP07HostAdapter,
  createScaP07HostDeclaration,
  type ScaP07BrokerClientV1,
} from "./p07-operation.js";

const PROTOCOL = "penny.sca-service-ipc.v1" as const;
const MAX_SOCKET_PATH_BYTES = 107;
const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 512;

type Action = "execute" | "poll" | "cancel";

export interface ScaP07UnixBrokerClientConfigV1 {
  readonly socket_path: string;
  readonly authentication_token: string;
  readonly response_inactivity_ms: number;
  readonly max_response_bytes: number;
}

export interface ScaP07ProductionHostCompositionV1 {
  readonly operation_kind: typeof SCA_P07_OPERATION_KIND;
  readonly declaration: HostOperationDeclarationV1;
  readonly adapter: HostOperationAdapterV1;
  /** Pass directly as OrchestrationService.hostOperationAdapters. */
  readonly adapters: ReadonlyMap<string, HostOperationAdapterV1>;
  /** Pass directly as OrchestrationService.hostOperationUseValidator. */
  readonly use_validator: HostOperationUseValidatorV1;
  readonly backend_key_sha256: string;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`P07 ${name} is outside the production bound`);
  return value;
}

function validateConfig(input: ScaP07UnixBrokerClientConfigV1): ScaP07UnixBrokerClientConfigV1 {
  if (
    process.platform !== "linux" ||
    !path.isAbsolute(input.socket_path) ||
    path.normalize(input.socket_path) !== input.socket_path ||
    Buffer.byteLength(input.socket_path) > MAX_SOCKET_PATH_BYTES ||
    /[\0\r\n]/u.test(input.socket_path) ||
    path.dirname(input.socket_path) === path.parse(input.socket_path).root
  )
    throw new Error("P07 broker socket path is not a bounded absolute Linux path");
  const tokenBytes = Buffer.byteLength(input.authentication_token);
  if (
    tokenBytes < MIN_TOKEN_BYTES ||
    tokenBytes > MAX_TOKEN_BYTES ||
    /[\0\r\n]/u.test(input.authentication_token)
  )
    throw new Error("P07 broker authentication token is invalid");
  boundedInteger(input.response_inactivity_ms, "response inactivity", 1, 300_000);
  boundedInteger(input.max_response_bytes, "maximum response bytes", 1, 16_777_216);
  return Object.freeze({ ...input });
}

function assertPrivateSocket(socketPath: string): void {
  const parent = path.dirname(socketPath);
  const parentStat = lstatSync(parent);
  const socketStat = lstatSync(socketPath);
  const uid = process.getuid?.();
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent ||
    (parentStat.mode & 0o777) !== 0o700 ||
    (uid !== undefined && parentStat.uid !== uid) ||
    !socketStat.isSocket() ||
    socketStat.isSymbolicLink() ||
    (uid !== undefined && socketStat.uid !== uid)
  )
    throw new Error("P07 broker socket is not inside an owner-only endpoint");
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function deadlineFor(action: Action, request: unknown): number {
  const requestRecord = record(request);
  if (requestRecord === null) throw new Error("P07 broker request invalid");
  const deadline = requestRecord.deadline_at;
  if (typeof deadline !== "string") throw new Error("P07 broker request deadline missing");
  const remaining = Date.parse(deadline) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new Error(`P07 broker ${action} deadline expired`);
  return remaining;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((entry, index) => entry === wanted[index]);
}

function parseEnvelope(text: string, action: Action): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("P07 broker returned invalid JSON");
  }
  const envelope = record(value);
  if (envelope === null) throw new Error("P07 broker returned an invalid envelope");
  if (envelope.protocol !== PROTOCOL) throw new Error("P07 broker protocol drift");
  if (envelope.ok === false) {
    if (
      !exactKeys(envelope, ["protocol", "ok", "action", "error"]) ||
      (envelope.action !== action && envelope.action !== null)
    )
      throw new Error("P07 broker returned an invalid error envelope");
    const error = record(envelope.error);
    const code = error?.code;
    throw new Error(
      `P07 broker rejected ${action}: ${typeof code === "string" ? code : "unknown"}`
    );
  }
  if (
    envelope.ok !== true ||
    envelope.action !== action ||
    !exactKeys(envelope, ["protocol", "ok", "action", "result"])
  )
    throw new Error("P07 broker returned an invalid success envelope");
  return envelope.result;
}

async function call(
  config: ScaP07UnixBrokerClientConfigV1,
  action: Action,
  request: unknown,
  signal: AbortSignal
): Promise<unknown> {
  signal.throwIfAborted();
  assertPrivateSocket(config.socket_path);
  const frame = `${JSON.stringify({
    protocol: PROTOCOL,
    action,
    token: config.authentication_token,
    request,
  })}\n`;
  if (Buffer.byteLength(frame) > 262_144) throw new Error("P07 broker request frame exceeds bound");
  const absoluteTimeoutMs = deadlineFor(action, request);
  const text = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let received = 0;
    let newline = false;
    const chunks: Buffer[] = [];
    const socket: Socket = createConnection({ path: config.socket_path, allowHalfOpen: true });
    let inactivity: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(absolute);
      clearTimeout(inactivity);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(new Error("P07 broker call cancelled"));
    const renew = () => {
      clearTimeout(inactivity);
      inactivity = setTimeout(
        () => fail(new Error("P07 broker response became inactive")),
        config.response_inactivity_ms
      );
    };
    const absolute = setTimeout(
      () => fail(new Error("P07 broker request deadline expired")),
      Math.max(1, Math.ceil(absoluteTimeoutMs))
    );
    renew();
    signal.addEventListener("abort", onAbort, { once: true });
    socket.on("connect", () => socket.end(frame, "utf8"));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (chunk.byteLength > 0) renew();
      received += chunk.byteLength;
      if (received > config.max_response_bytes) {
        fail(new Error("P07 broker response exceeds bound"));
        return;
      }
      if (newline) {
        fail(new Error("P07 broker returned multiple frames"));
        return;
      }
      const index = chunk.indexOf(0x0a);
      if (index === -1) {
        chunks.push(chunk);
        return;
      }
      if (index !== chunk.byteLength - 1) {
        fail(new Error("P07 broker response frame is malformed"));
        return;
      }
      chunks.push(chunk.subarray(0, index));
      newline = true;
    });
    socket.on("end", () => {
      if (!newline) {
        fail(new Error("P07 broker response ended without a frame"));
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("close", () => {
      if (!settled && !newline) fail(new Error("P07 broker socket closed"));
    });
    socket.on("error", fail);
  });
  return parseEnvelope(text, action);
}

export function createScaP07UnixBrokerClientV1(
  input: ScaP07UnixBrokerClientConfigV1
): ScaP07BrokerClientV1 {
  const config = validateConfig(input);
  return Object.freeze({
    async execute(request: ScaBrokerExecuteRequestV1, signal: AbortSignal) {
      return validateScaBrokerExecuteAcceptedResult(
        await call(config, "execute", request, signal),
        request
      );
    },
    async poll(
      request: ScaBrokerPollRequestV1,
      executeRequest: ScaBrokerExecuteRequestV1,
      signal: AbortSignal
    ) {
      return validateScaBrokerPollResult(
        await call(config, "poll", request, signal),
        request,
        executeRequest
      );
    },
    async cancel(
      request: ScaBrokerCancelRequestV1,
      executeRequest: ScaBrokerExecuteRequestV1,
      signal: AbortSignal
    ) {
      return validateScaBrokerCancelResultV1(
        await call(config, "cancel", request, signal),
        request,
        executeRequest
      );
    },
  });
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function exactCurrentRef(store: ArtifactHostStore, ref: ArtifactRef): Uint8Array {
  if (!same(store.refById(ref.artifact_id), ref))
    throw new Error("P07 admission ref is not current");
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest)
    throw new Error("P07 admission bytes drifted");
  return bytes;
}

function decodeCanonical(bytes: Uint8Array, label: string): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`P07 ${label} is not canonical JSON`);
  return value;
}

export function createScaP07ProductionHostCompositionV1(input: {
  readonly store: ArtifactHostStore;
  readonly resolve_current_authority_ref: (scope: ScaP07CurrentAuthorityScopeV1) => ArtifactRef;
  readonly socket: ScaP07UnixBrokerClientConfigV1;
  readonly backend_binding_id: string;
  readonly lease_profile_id: string;
  readonly lease_duration_ms: number;
  readonly lease_renew_after_ms: number;
  readonly queue_inactivity_ms: number;
  readonly operation_inactivity_ms: number;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
  readonly now?: () => Date;
}): ScaP07ProductionHostCompositionV1 {
  const socket = validateConfig(input.socket);
  const backendKey = sha256(
    canonicalJson({
      protocol: PROTOCOL,
      socket_path: socket.socket_path,
      authentication_token_sha256: sha256(socket.authentication_token),
    })
  );
  const declaration = createScaP07HostDeclaration(input);
  const currentAdmission = (admission: ScaP07AdmissionV1, admissionRef: ArtifactRef): void => {
    exactCurrentRef(input.store, admissionRef);
    const current = admitScaP07ExecutionPlan({
      store: input.store,
      transition_ref: admission.transition_ref,
      authority_ref: admission.authority_ref,
      resolve_current_authority_ref: input.resolve_current_authority_ref,
      plan_ref: admission.plan_ref,
    });
    if (!same(current, admission)) throw new Error("P07 admission is no longer current");
  };
  const useValidator: HostOperationUseValidatorV1 = {
    validateUse({ directive, declaration: activeDeclaration, request_bytes }) {
      if (
        directive.operation_kind !== SCA_P07_OPERATION_KIND ||
        !same(activeDeclaration, declaration)
      )
        throw new Error("P07 use-time declaration drift");
      const request = validateScaP07HostRequestV1(decodeCanonical(request_bytes, "host request"));
      const admissionBytes = exactCurrentRef(input.store, request.admission_ref);
      const admission = validateScaP07AdmissionV1(decodeCanonical(admissionBytes, "admission"));
      if (!same(admission.plan_ref, request.plan_ref)) {
        throw new Error("P07 use-time plan binding drift");
      }
      currentAdmission(admission, request.admission_ref);
    },
  };
  const adapter = createScaP07HostAdapter({
    client: createScaP07UnixBrokerClientV1(socket),
    backend_key_sha256: backendKey,
    assertCurrentAdmission(admitted) {
      currentAdmission(admitted.admission, admitted.admission_ref);
    },
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return Object.freeze({
    operation_kind: SCA_P07_OPERATION_KIND,
    declaration,
    adapter,
    adapters: new Map([[adapter.adapter_id, adapter]]),
    use_validator: useValidator,
    backend_key_sha256: backendKey,
  });
}
