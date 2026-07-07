import type { Client } from "@caido/sdk-client";
import { decodeRaw, formatHttpRaw } from "../output.js";
import {
  parseRawHttp,
  modifyRequestLine,
  modifyHeaders,
  applyReplacements,
  buildModifiedRaw,
} from "./edit-helpers.js";
import type { OutputOpts } from "../types.js";

export interface CaidoEditParams {
  request_id: string;
  method?: string;
  path?: string;
  set_headers?: string[];
  remove_headers?: string[];
  body?: string;
  replacements?: string[];
  max_body_lines?: number;
  max_body_chars?: number;
  no_request?: boolean;
  headers_only?: boolean;
}

export async function caidoEditImpl(params: CaidoEditParams, client: Client): Promise<unknown> {
  const opts: OutputOpts = {
    maxBodyLines: params.max_body_lines ?? 200,
    maxBodyChars: params.max_body_chars ?? 5000,
    noRequest: params.no_request ?? false,
    headersOnly: params.headers_only ?? false,
  };

  const original = await client.request.get(params.request_id, { raw: true });
  if (!original) throw new Error(`Request ${params.request_id} not found`);

  let raw = decodeRaw(original.request.raw);
  if (!raw) throw new Error("No raw data for this request");

  // Apply simple string replacements
  if (params.replacements?.length) {
    raw = applyReplacements(raw, params.replacements);
  }

  const { requestLine, headers, body, lineEnd } = parseRawHttp(raw);

  const newRequestLine = modifyRequestLine(requestLine, params.method, params.path);
  const newHeaders = modifyHeaders(headers, params.remove_headers || [], params.set_headers || []);
  const newBody = params.body !== undefined ? params.body : body;

  const modifiedRaw = buildModifiedRaw(newRequestLine, newHeaders, newBody, lineEnd);

  // Create session and replay
  const session = await client.replay.sessions.create({
    requestSource: { id: params.request_id },
  });

  const result = await client.replay.send(session.id, {
    raw: modifiedRaw,
    connection: {
      host: original.request.host,
      port: original.request.port,
      isTLS: original.request.isTls,
    },
  });

  const output: Record<string, unknown> = {
    sessionId: session.id,
    status: result.status,
    error: result.error,
  };

  if (!opts.noRequest) {
    output.modifiedRequest = formatHttpRaw(modifiedRaw, opts);
  }

  if (result.entry?.response) {
    const response: Record<string, unknown> = {
      statusCode: result.entry.response.statusCode,
      roundtrip: result.entry.response.roundtripTime,
      length: result.entry.response.length,
    };
    if (result.entry.response.raw) {
      response.raw = formatHttpRaw(decodeRaw(result.entry.response.raw), opts);
    }
    output.response = response;
  }

  return output;
}
