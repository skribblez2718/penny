import http from "node:http";

import { canonicalJson, sha256 } from "../canonical-json.js";
import type { JsonValue } from "../contracts.js";

export type ComfyGraphV1 = Readonly<Record<string, JsonValue>>;

export type ComfyClientErrorCode =
  | "BACKEND_CONNECTION_FAILED"
  | "BACKEND_TIMEOUT"
  | "BACKEND_CANCELLED"
  | "BACKEND_REDIRECT_REFUSED"
  | "BACKEND_HTTP_STATUS"
  | "BACKEND_CONTENT_ENCODING_REFUSED"
  | "BACKEND_RESPONSE_TOO_LARGE"
  | "BACKEND_REQUEST_TOO_LARGE"
  | "BACKEND_CONTENT_TYPE_INVALID"
  | "BACKEND_JSON_INVALID"
  | "BACKEND_RESPONSE_INVALID"
  | "BACKEND_PROMPT_ID_INVALID";

export class ComfyClientError extends Error {
  constructor(
    readonly code: ComfyClientErrorCode,
    message: string,
    readonly submission_disposition: "not_submission" | "proven_not_accepted" | "unknown"
  ) {
    super(message);
    this.name = "ComfyClientError";
  }
}

export interface ComfyClientLimitsV1 {
  readonly max_request_bytes: number;
  readonly max_readiness_bytes: number;
  readonly max_inventory_bytes: number;
  readonly max_history_bytes: number;
  readonly max_image_bytes: number;
  readonly max_upload_bytes?: number;
  readonly max_video_bytes?: number;
  readonly connect_timeout_ms: number;
  readonly read_timeout_ms: number;
}

export interface ComfyEndpointV1 {
  readonly scheme: "http";
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
}

export interface ComfyInventoryV1 {
  readonly object_info: Readonly<Record<string, unknown>>;
  readonly sha256: string;
  readonly class_types: ReadonlySet<string>;
  readonly scalar_strings: ReadonlySet<string>;
}

export interface ComfyMediaDescriptorV1 {
  readonly filename: string;
  readonly subfolder: string;
  readonly type: "input" | "output" | "temp";
}

export type ComfyImageDescriptorV1 = Omit<ComfyMediaDescriptorV1, "type"> & {
  readonly type: "output" | "temp";
};

export type ComfyMediaHistoryV1 =
  | { readonly state: "pending" }
  | { readonly state: "failed"; readonly reason_code: string }
  | { readonly state: "completed"; readonly media: ComfyImageDescriptorV1 };

export type ComfyHistoryV1 =
  | { readonly state: "pending" }
  | { readonly state: "failed"; readonly reason_code: string }
  | { readonly state: "completed"; readonly image: ComfyImageDescriptorV1 };

interface HttpResponseV1 {
  readonly status: number;
  readonly content_type: string | null;
  readonly bytes: Buffer;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new ComfyClientError(
      "BACKEND_RESPONSE_INVALID",
      `${label} is not an object`,
      "not_submission"
    );
  }
  return value;
}

function jsonComplexity(value: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > 100_000 || current.depth > 64) {
      throw new ComfyClientError(
        "BACKEND_JSON_INVALID",
        "backend JSON exceeds structural limits",
        "not_submission"
      );
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function parseJson(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ComfyClientError(
      "BACKEND_JSON_INVALID",
      `${label} is not valid JSON`,
      "not_submission"
    );
  }
  jsonComplexity(value);
  return unknownRecord(value, label);
}

function exactContentType(value: string | undefined): string | null {
  if (value === undefined) return null;
  const first = value.split(";", 1)[0];
  return first === undefined ? null : first.trim().toLowerCase();
}

function safeMediaDescriptor(
  value: unknown,
  allowedTypes: ReadonlySet<ComfyMediaDescriptorV1["type"]>,
  label = "backend media descriptor"
): ComfyMediaDescriptorV1 {
  const object = unknownRecord(value, label);
  const keys = Object.keys(object).sort();
  if (canonicalJson(keys) !== canonicalJson(["filename", "subfolder", "type"])) {
    throw new ComfyClientError(
      "BACKEND_RESPONSE_INVALID",
      `${label} has unexpected fields`,
      "not_submission"
    );
  }
  const filename = object["filename"];
  const subfolder = object["subfolder"];
  const type = object["type"];
  if (
    typeof filename !== "string" ||
    filename.length < 1 ||
    filename.length > 255 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    typeof subfolder !== "string" ||
    subfolder.length > 1_024 ||
    subfolder.startsWith("/") ||
    subfolder.includes("\\") ||
    subfolder.includes("\0") ||
    subfolder.split("/").some((part) => part === "." || part === "..") ||
    (type !== "input" && type !== "output" && type !== "temp") ||
    !allowedTypes.has(type)
  ) {
    throw new ComfyClientError("BACKEND_RESPONSE_INVALID", `${label} is unsafe`, "not_submission");
  }
  return { filename, subfolder, type };
}

function safeImageDescriptor(value: unknown): ComfyImageDescriptorV1 {
  const descriptor = safeMediaDescriptor(value, new Set(["output", "temp"]));
  if (descriptor.type === "input") {
    throw new ComfyClientError(
      "BACKEND_RESPONSE_INVALID",
      "backend image descriptor uses an input locator",
      "not_submission"
    );
  }
  return {
    filename: descriptor.filename,
    subfolder: descriptor.subfolder,
    type: descriptor.type,
  };
}

function scalarStrings(value: unknown): ReadonlySet<string> {
  const output = new Set<string>();
  JSON.stringify(value, (_key: string, current: unknown) => {
    if (typeof current === "string") output.add(current);
    return current;
  });
  return output;
}

function abortError(): ComfyClientError {
  return new ComfyClientError("BACKEND_CANCELLED", "backend request cancelled", "not_submission");
}

export interface ComfySocketMeter {
  beginSocket(): (bytesWritten: number, bytesRead: number) => void;
}

export type ComfyActivitySink = (activityClass: string, observedUnits?: number) => void;

/** Bounded direct Node HTTP client. It has no proxy, redirect, credential, or decompression path. */
export class ComfyHttpClient {
  constructor(
    private readonly endpoint: ComfyEndpointV1,
    private readonly limits: ComfyClientLimitsV1,
    private readonly wireMeter?: ComfySocketMeter
  ) {
    if (
      endpoint.scheme !== "http" ||
      (endpoint.host !== "127.0.0.1" && endpoint.host !== "::1") ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65_535
    ) {
      throw new Error("Comfy HTTP endpoint is not a registered literal loopback destination");
    }
    for (const [name, value] of Object.entries(limits)) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new Error(`Comfy HTTP limit '${name}' is invalid`);
      }
    }
  }

  async ready(input: {
    readonly signal: AbortSignal;
    readonly report_activity?: ComfyActivitySink;
  }): Promise<string> {
    const response = await this.request({
      method: "GET",
      path: "/system_stats",
      max_response_bytes: this.limits.max_readiness_bytes,
      signal: input.signal,
      ...(input.report_activity === undefined ? {} : { report_activity: input.report_activity }),
      submission: false,
    });
    this.requireSuccessJson(response, "backend readiness");
    const parsed = parseJson(response.bytes, "backend readiness response");
    return sha256(canonicalJson(parsed));
  }

  async inventory(input: {
    readonly signal: AbortSignal;
    readonly report_activity?: ComfyActivitySink;
  }): Promise<ComfyInventoryV1> {
    const response = await this.request({
      method: "GET",
      path: "/object_info",
      max_response_bytes: this.limits.max_inventory_bytes,
      signal: input.signal,
      ...(input.report_activity === undefined ? {} : { report_activity: input.report_activity }),
      submission: false,
    });
    this.requireSuccessJson(response, "backend inventory");
    const parsed = parseJson(response.bytes, "backend inventory response");
    const canonical = canonicalJson(parsed);
    return {
      object_info: parsed,
      sha256: sha256(canonical),
      class_types: new Set(Object.keys(parsed)),
      scalar_strings: scalarStrings(parsed),
    };
  }

  async submit(input: {
    readonly graph: ComfyGraphV1;
    readonly client_id: string;
    readonly signal: AbortSignal;
    readonly report_activity?: ComfyActivitySink;
  }): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.client_id)) {
      throw new Error("Comfy submission client ID is invalid");
    }
    const body = Buffer.from(
      canonicalJson({ prompt: input.graph, client_id: input.client_id }),
      "utf8"
    );
    if (body.byteLength > this.limits.max_request_bytes) {
      throw new ComfyClientError(
        "BACKEND_RESPONSE_TOO_LARGE",
        "backend submission request exceeds its byte limit",
        "proven_not_accepted"
      );
    }
    const response = await this.request({
      method: "POST",
      path: "/prompt",
      body,
      max_response_bytes: this.limits.max_history_bytes,
      signal: input.signal,
      ...(input.report_activity === undefined ? {} : { report_activity: input.report_activity }),
      submission: true,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ComfyClientError(
        "BACKEND_HTTP_STATUS",
        "backend submission returned a non-success status",
        response.status === 400 || response.status === 422 ? "proven_not_accepted" : "unknown"
      );
    }
    if (response.content_type !== "application/json") {
      throw new ComfyClientError(
        "BACKEND_CONTENT_TYPE_INVALID",
        "backend submission returned a non-JSON response",
        "unknown"
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJson(response.bytes, "backend submission response");
    } catch (error) {
      if (error instanceof ComfyClientError) {
        throw new ComfyClientError(error.code, error.message, "unknown");
      }
      throw error;
    }
    const allowed = new Set(["prompt_id", "number", "node_errors"]);
    if (Object.keys(parsed).some((key) => !allowed.has(key))) {
      throw new ComfyClientError(
        "BACKEND_RESPONSE_INVALID",
        "backend submission response has unexpected fields",
        "unknown"
      );
    }
    const promptId = parsed["prompt_id"];
    if (typeof promptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(promptId)) {
      throw new ComfyClientError(
        "BACKEND_PROMPT_ID_INVALID",
        "backend submission response has an invalid prompt ID",
        "unknown"
      );
    }
    return promptId;
  }

  async uploadImage(input: {
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly subfolder: string;
    readonly signal: AbortSignal;
    readonly report_activity?: ComfyActivitySink;
  }): Promise<ComfyMediaDescriptorV1> {
    const expected = safeMediaDescriptor(
      { filename: input.filename, subfolder: input.subfolder, type: "input" },
      new Set(["input"]),
      "requested upload descriptor"
    );
    const maxUploadBytes = this.limits.max_upload_bytes ?? this.limits.max_image_bytes;
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > maxUploadBytes) {
      throw new ComfyClientError(
        "BACKEND_REQUEST_TOO_LARGE",
        "backend upload exceeds its byte limit",
        "proven_not_accepted"
      );
    }
    let boundary = `penny-${sha256(input.bytes).slice(0, 32)}`;
    let suffix = 0;
    while (Buffer.from(input.bytes).includes(Buffer.from(boundary))) {
      suffix += 1;
      boundary = `penny-${sha256(`${sha256(input.bytes)}:${suffix}`).slice(0, 32)}`;
    }
    const parts = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${expected.filename}"\r\nContent-Type: image/png\r\n\r\n`,
        "utf8"
      ),
      Buffer.from(input.bytes),
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput`,
        "utf8"
      ),
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="subfolder"\r\n\r\n${expected.subfolder}`,
        "utf8"
      ),
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\nfalse`,
        "utf8"
      ),
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ];
    const body = Buffer.concat(parts);
    if (body.byteLength > maxUploadBytes + 65_536) {
      throw new ComfyClientError(
        "BACKEND_REQUEST_TOO_LARGE",
        "backend multipart upload exceeds its byte limit",
        "proven_not_accepted"
      );
    }
    const response = await this.request({
      method: "POST",
      path: "/upload/image",
      body,
      content_type: `multipart/form-data; boundary=${boundary}`,
      accept: "application/json",
      max_response_bytes: this.limits.max_request_bytes,
      signal: input.signal,
      ...(input.report_activity === undefined ? {} : { report_activity: input.report_activity }),
      submission: true,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ComfyClientError(
        "BACKEND_HTTP_STATUS",
        "backend upload returned a non-success status",
        response.status === 400 || response.status === 413 || response.status === 422
          ? "proven_not_accepted"
          : "unknown"
      );
    }
    if (response.content_type !== "application/json") {
      throw new ComfyClientError(
        "BACKEND_CONTENT_TYPE_INVALID",
        "backend upload returned a non-JSON response",
        "unknown"
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJson(response.bytes, "backend upload response");
    } catch (error) {
      if (error instanceof ComfyClientError) {
        throw new ComfyClientError(error.code, error.message, "unknown");
      }
      throw error;
    }
    const keys = Object.keys(parsed).sort();
    if (canonicalJson(keys) !== canonicalJson(["name", "subfolder", "type"])) {
      throw new ComfyClientError(
        "BACKEND_RESPONSE_INVALID",
        "backend upload response has unexpected fields",
        "unknown"
      );
    }
    let descriptor: ComfyMediaDescriptorV1;
    try {
      descriptor = safeMediaDescriptor(
        { filename: parsed["name"], subfolder: parsed["subfolder"], type: parsed["type"] },
        new Set(["input"]),
        "backend upload descriptor"
      );
    } catch (error) {
      if (error instanceof ComfyClientError) {
        throw new ComfyClientError(error.code, error.message, "unknown");
      }
      throw error;
    }
    if (
      descriptor.filename !== expected.filename ||
      descriptor.subfolder !== expected.subfolder ||
      descriptor.type !== "input"
    ) {
      throw new ComfyClientError(
        "BACKEND_RESPONSE_INVALID",
        "backend upload response does not match the requested immutable locator",
        "unknown"
      );
    }
    return descriptor;
  }

  async historyMedia(input: {
    readonly prompt_id: string;
    readonly output_node_id: string;
    readonly signal: AbortSignal;
    readonly report_activity?: ComfyActivitySink;
  }): Promise<ComfyMediaHistoryV1> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.prompt_id)) {
      throw new ComfyClientError(
        "BACKEND_PROMPT_ID_INVALID",
        "backend history prompt ID is invalid",
        "not_submission"
      );
    }
    const response = await this.request({
      method: "GET",
      path: `/history/${encodeURIComponent(input.prompt_id)}`,
      max_response_bytes: this.limits.max_history_bytes,
      signal: input.signal,
      ...(input.report_activity === undefined ? {} : { report_activity: input.report_activity }),
      submission: false,
    });
    this.requireSuccessJson(response, "backend history");
    const parsed = parseJson(response.bytes, "backend history response");
    const historyKeys = Object.keys(parsed);
    if (
      historyKeys.length > 1 ||
      (historyKeys.length === 1 && historyKeys[0] !== input.prompt_id)
    ) {
      throw new ComfyClientError(
        "BACKEND_RESPONSE_INVALID",
        "backend history response is not scoped to the exact prompt ID",
        "not_submission"
      );
    }
    const entryValue = parsed[input.prompt_id];
    if (entryValue === undefined) return { state: "pending" };
    const entry = unknownRecord(entryValue, "backend history entry");
    const status = unknownRecord(entry["status"], "backend history status");
    const completed = status["completed"];
    const statusText = status["status_str"];
    if (
      typeof completed !== "boolean" ||
      typeof statusText !== "string" ||
      statusText.length > 64
    ) {
      throw new ComfyClientError(
        "BACKEND_RESPONSE_INVALID",
        "backend history status is malformed",
        "not_submission"
      );
    }
    if (!completed) return { state: "pending" };
    if (statusText !== "success")
      return { state: "failed", reason_code: "remote_execution_failed" };
    const outputs = unknownRecord(entry["outputs"], "backend history outputs");
    const media: Array<{ readonly node_id: string; readonly descriptor: ComfyImageDescriptorV1 }> =
      [];
    for (const [nodeId, outputValue] of Object.entries(outputs)) {
      const output = unknownRecord(outputValue, "backend node output");
      const mediaValues = output["images"];
      if (mediaValues === undefined) continue;
      if (!Array.isArray(mediaValues)) {
        throw new ComfyClientError(
          "BACKEND_RESPONSE_INVALID",
          "backend media output is not an array",
          "not_submission"
        );
      }
      for (const descriptor of mediaValues)
        media.push({ node_id: nodeId, descriptor: safeImageDescriptor(descriptor) });
    }
    if (media.length !== 1 || media[0]?.node_id !== input.output_node_id) {
      return { state: "failed", reason_code: "terminal_output_cardinality_invalid" };
    }
    return { state: "completed", media: media[0].descriptor };
  }

  async history(input: {
    readonly prompt_id: string;
    readonly output_node_id: string;
    readonly signal: AbortSignal;
    readonly report_activity?: ComfyActivitySink;
  }): Promise<ComfyHistoryV1> {
    const result = await this.historyMedia(input);
    return result.state === "completed" ? { state: "completed", image: result.media } : result;
  }

  async fetchMedia(input: {
    readonly media: ComfyMediaDescriptorV1;
    readonly max_bytes: number;
    readonly accept: string;
    readonly signal: AbortSignal;
    readonly report_activity?: ComfyActivitySink;
  }): Promise<{
    readonly status: number;
    readonly media_type: string | null;
    readonly bytes: Buffer;
  }> {
    const configuredMax = Math.max(
      this.limits.max_image_bytes,
      this.limits.max_upload_bytes ?? 0,
      this.limits.max_video_bytes ?? 0
    );
    if (
      !Number.isSafeInteger(input.max_bytes) ||
      input.max_bytes < 1 ||
      input.max_bytes > configuredMax ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:,\s*[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)*$/iu.test(
        input.accept
      )
    ) {
      throw new Error("Comfy media fetch policy is invalid");
    }
    const media = safeMediaDescriptor(input.media, new Set(["input", "output", "temp"]));
    const query = new URLSearchParams({
      filename: media.filename,
      subfolder: media.subfolder,
      type: media.type,
    });
    const response = await this.request({
      method: "GET",
      path: `/view?${query.toString()}`,
      accept: input.accept,
      max_response_bytes: input.max_bytes,
      signal: input.signal,
      ...(input.report_activity === undefined ? {} : { report_activity: input.report_activity }),
      submission: false,
    });
    return { status: response.status, media_type: response.content_type, bytes: response.bytes };
  }

  async fetchImage(input: {
    readonly image: ComfyImageDescriptorV1;
    readonly signal: AbortSignal;
    readonly report_activity?: ComfyActivitySink;
  }): Promise<{
    readonly status: number;
    readonly media_type: string | null;
    readonly bytes: Buffer;
  }> {
    return await this.fetchMedia({
      media: input.image,
      max_bytes: this.limits.max_image_bytes,
      accept: "image/png",
      signal: input.signal,
      ...(input.report_activity === undefined ? {} : { report_activity: input.report_activity }),
    });
  }

  async interrupt(input: {
    readonly prompt_id: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.prompt_id)) {
      throw new ComfyClientError(
        "BACKEND_PROMPT_ID_INVALID",
        "backend interrupt prompt ID is invalid",
        "not_submission"
      );
    }
    const body = Buffer.from(canonicalJson({ prompt_id: input.prompt_id }), "utf8");
    const response = await this.request({
      method: "POST",
      path: "/interrupt",
      body,
      content_type: "application/json",
      accept: "application/json",
      max_response_bytes: this.limits.max_request_bytes,
      signal: input.signal,
      submission: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ComfyClientError(
        "BACKEND_HTTP_STATUS",
        "backend interrupt returned a non-success status",
        "not_submission"
      );
    }
  }

  private requireSuccessJson(response: HttpResponseV1, label: string): void {
    if (response.status < 200 || response.status >= 300) {
      throw new ComfyClientError(
        "BACKEND_HTTP_STATUS",
        `${label} returned a non-success status`,
        "not_submission"
      );
    }
    if (response.content_type !== "application/json") {
      throw new ComfyClientError(
        "BACKEND_CONTENT_TYPE_INVALID",
        `${label} returned a non-JSON response`,
        "not_submission"
      );
    }
  }

  private async request(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: Buffer;
    readonly content_type?: string;
    readonly accept?: string;
    readonly max_response_bytes: number;
    readonly signal: AbortSignal;
    readonly report_activity?: ComfyActivitySink;
    readonly submission: boolean;
  }): Promise<HttpResponseV1> {
    if (!input.path.startsWith("/") || input.path.startsWith("//") || input.path.includes("#")) {
      throw new Error("Comfy HTTP client received a non-canonical path");
    }
    if (input.signal.aborted) throw abortError();
    let socketDone: Promise<void> = Promise.resolve();
    try {
      return await new Promise<HttpResponseV1>((resolve, reject) => {
        const headers: Record<string, string | number> = {
          Accept:
            input.accept ?? (input.path.startsWith("/view?") ? "image/png" : "application/json"),
          "Accept-Encoding": "identity",
          Connection: "close",
        };
        if (input.body !== undefined) {
          headers["Content-Type"] = input.content_type ?? "application/json";
          headers["Content-Length"] = input.body.byteLength;
        }
        const request = http.request(
          {
            protocol: "http:",
            hostname: this.endpoint.host,
            port: this.endpoint.port,
            method: input.method,
            path: input.path,
            headers,
            agent: false,
            auth: undefined,
            signal: input.signal,
            // Node's socket timeout is an inactivity timeout. It is not an elapsed request limit.
            timeout: this.limits.connect_timeout_ms,
          },
          (response) => {
            input.report_activity?.("http_response_headers", 1);
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              response.destroy();
              reject(
                new ComfyClientError(
                  "BACKEND_REDIRECT_REFUSED",
                  "backend redirect was refused",
                  input.submission ? "unknown" : "not_submission"
                )
              );
              return;
            }
            const contentEncoding = response.headers["content-encoding"];
            if (contentEncoding !== undefined && contentEncoding.toLowerCase() !== "identity") {
              response.destroy();
              reject(
                new ComfyClientError(
                  "BACKEND_CONTENT_ENCODING_REFUSED",
                  "backend response content encoding was refused",
                  input.submission ? "unknown" : "not_submission"
                )
              );
              return;
            }
            const length = response.headers["content-length"];
            if (typeof length === "string" && /^[0-9]+$/u.test(length)) {
              const declared = Number(length);
              if (!Number.isSafeInteger(declared) || declared > input.max_response_bytes) {
                response.destroy();
                reject(
                  new ComfyClientError(
                    "BACKEND_RESPONSE_TOO_LARGE",
                    "backend response exceeds its byte limit",
                    input.submission ? "unknown" : "not_submission"
                  )
                );
                return;
              }
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            // IncomingMessage resets this timeout whenever bytes arrive, so productive streaming can
            // continue indefinitely while a silent response is contained.
            response.setTimeout(this.limits.read_timeout_ms, () => {
              response.destroy(new Error("backend response stalled"));
            });
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.byteLength;
              if (bytes > input.max_response_bytes) {
                reject(
                  new ComfyClientError(
                    "BACKEND_RESPONSE_TOO_LARGE",
                    "backend response exceeds its byte limit",
                    input.submission ? "unknown" : "not_submission"
                  )
                );
                response.destroy();
                return;
              }
              chunks.push(Buffer.from(chunk));
              input.report_activity?.(
                "http_response_bytes",
                Math.max(1, Math.min(chunk.byteLength, 16_777_216))
              );
            });
            response.on("error", (error) => {
              const timedOut = error.message.includes("stalled");
              reject(
                new ComfyClientError(
                  timedOut ? "BACKEND_TIMEOUT" : "BACKEND_CONNECTION_FAILED",
                  timedOut
                    ? "backend response became inactive"
                    : "backend response connection failed",
                  input.submission ? "unknown" : "not_submission"
                )
              );
            });
            response.on("end", () => {
              if (bytes > input.max_response_bytes) {
                reject(
                  new ComfyClientError(
                    "BACKEND_RESPONSE_TOO_LARGE",
                    "backend response exceeds its byte limit",
                    input.submission ? "unknown" : "not_submission"
                  )
                );
                return;
              }
              input.report_activity?.("http_response_completed", 1);
              // Force one-use teardown if a peer ignores Connection: close.
              // Final wire metering waits for this actual socket close.
              request.destroy();
              resolve({
                status,
                content_type: exactContentType(response.headers["content-type"]),
                bytes: Buffer.concat(chunks, bytes),
              });
            });
          }
        );
        request.on("socket", (socket) => {
          let finish: ReturnType<ComfySocketMeter["beginSocket"]> | undefined;
          try {
            finish = this.wireMeter?.beginSocket();
          } catch {
            request.destroy(new Error("backend wire meter unavailable"));
            return;
          }
          // agent:false above forbids reuse: these are this exact request's real
          // HTTP/TCP-stream bytes, including framing/headers, not JSON estimates.
          socketDone = new Promise<void>((done, fail) => {
            socket.once("close", () => {
              try {
                finish?.(socket.bytesWritten, socket.bytesRead);
                done();
              } catch (error) {
                // A revoked fence or failed final counter is an operation failure,
                // not an uncaught event-listener exception or a successful read.
                fail(error);
              }
            });
          });
        });
        request.on("timeout", () => request.destroy(new Error("backend connection inactive")));
        request.on("error", (error) => {
          if (input.signal.aborted) {
            reject(abortError());
            return;
          }
          const message = error.message.includes("limit")
            ? "backend response exceeds its byte limit"
            : error.message.includes("stalled") ||
                error.message.includes("timed out") ||
                error.message.includes("inactive")
              ? "backend request became inactive"
              : "backend connection failed";
          const code: ComfyClientErrorCode = error.message.includes("limit")
            ? "BACKEND_RESPONSE_TOO_LARGE"
            : error.message.includes("stalled") ||
                error.message.includes("timed out") ||
                error.message.includes("inactive")
              ? "BACKEND_TIMEOUT"
              : "BACKEND_CONNECTION_FAILED";
          reject(
            new ComfyClientError(code, message, input.submission ? "unknown" : "not_submission")
          );
        });
        if (input.body !== undefined) request.end(input.body);
        else request.end();
      });
    } finally {
      await socketDone;
    }
  }
}
