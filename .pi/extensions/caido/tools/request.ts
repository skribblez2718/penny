import type { Client } from "@caido/sdk-client";
import { decodeRaw, formatHttpRaw, rawToCurl } from "../output.js";
import type { OutputOpts } from "../types.js";

export interface CaidoRequestParams {
  request_id: string;
  mode?: "full" | "response" | "curl";
  max_body_lines?: number;
  max_body_chars?: number;
  no_request?: boolean;
  headers_only?: boolean;
}

export async function caidoRequestImpl(
  params: CaidoRequestParams,
  client: Client
): Promise<unknown> {
  const opts: OutputOpts = {
    maxBodyLines: params.max_body_lines ?? 200,
    maxBodyChars: params.max_body_chars ?? 5000,
    noRequest: params.no_request ?? false,
    headersOnly: params.headers_only ?? false,
  };

  const mode = params.mode || "full";

  if (mode === "curl") {
    const result = await client.request.get(params.request_id, { raw: true });
    if (!result) throw new Error(`Request ${params.request_id} not found`);
    const raw = decodeRaw(result.request.raw);
    const curl = rawToCurl(raw, result.request.host, result.request.port, result.request.isTls);
    return { id: result.request.id, curl };
  }

  if (mode === "response") {
    const result = await client.request.get(params.request_id, {
      requestRaw: false,
      responseRaw: true,
    });
    if (!result) throw new Error(`Request ${params.request_id} not found`);
    if (!result.response) return { error: "No response for this request" };
    const output: Record<string, unknown> = {
      statusCode: result.response.statusCode,
      roundtrip: result.response.roundtripTime,
      length: result.response.length,
    };
    if (result.response.raw) {
      output.raw = formatHttpRaw(decodeRaw(result.response.raw), opts);
    }
    return output;
  }

  // mode === "full"
  const result = await client.request.get(params.request_id, { raw: true });
  if (!result) throw new Error(`Request ${params.request_id} not found`);

  const output: Record<string, unknown> = {
    id: result.request.id,
    method: result.request.method,
    host: result.request.host,
    path: result.request.path,
    port: result.request.port,
    isTls: result.request.isTls,
    createdAt: result.request.createdAt,
  };

  if (!opts.noRequest && result.request.raw) {
    output.raw = formatHttpRaw(decodeRaw(result.request.raw), opts);
  }

  if (result.response) {
    const response: Record<string, unknown> = {
      statusCode: result.response.statusCode,
      roundtrip: result.response.roundtripTime,
      length: result.response.length,
    };
    if (result.response.raw) {
      response.raw = formatHttpRaw(decodeRaw(result.response.raw), opts);
    }
    output.response = response;
  }

  return output;
}
