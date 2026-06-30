import type { Client } from "@caido/sdk-client";
import { decodeRaw, formatHttpRaw } from "../output.js";
import { CREATE_REPLAY_SESSION_RAW } from "../graphql.js";
import type { OutputOpts } from "../types.js";

export interface CaidoSendParams {
  mode: "raw" | "replay";
  raw_request?: string;
  host?: string;
  port?: number;
  is_tls?: boolean;
  request_id?: string;
  max_body_lines?: number;
  max_body_chars?: number;
  no_request?: boolean;
  headers_only?: boolean;
}

export async function caidoSendImpl(params: CaidoSendParams, client: Client): Promise<unknown> {
  const opts: OutputOpts = {
    maxBodyLines: params.max_body_lines ?? 200,
    maxBodyChars: params.max_body_chars ?? 5000,
    noRequest: params.no_request ?? false,
    headersOnly: params.headers_only ?? false,
  };

  if (params.mode === "raw") {
    if (!params.raw_request || !params.host || !params.port) {
      throw new Error("raw_request, host, and port are required for raw mode");
    }

    const createResult = await client.graphql.mutation(CREATE_REPLAY_SESSION_RAW, {
      input: {
        requestSource: {
          raw: {
            connectionInfo: { host: params.host, port: params.port, isTLS: params.is_tls ?? false },
            raw: Buffer.from(params.raw_request).toString("base64"),
          },
        },
      },
    });
    const session = (createResult as any).createReplaySession.session;

    const result = await client.replay.send(session.id, {
      raw: params.raw_request,
      connection: { host: params.host, port: params.port, isTLS: params.is_tls ?? false },
    });

    return formatSendResult(result, opts);
  }

  // replay mode
  if (!params.request_id) throw new Error("request_id is required for replay mode");

  const original = await client.request.get(params.request_id, { raw: true });
  if (!original) throw new Error(`Request ${params.request_id} not found`);

  const raw = decodeRaw(original.request.raw);
  if (!raw) throw new Error("No raw data for this request");

  const session = await client.replay.sessions.create({
    requestSource: { id: params.request_id },
  });

  const result = await client.replay.send(session.id, {
    raw,
    connection: {
      host: original.request.host,
      port: original.request.port,
      isTLS: original.request.isTls,
    },
  });

  return formatSendResult(result, opts);
}

function formatSendResult(result: any, opts: OutputOpts): Record<string, unknown> {
  const output: Record<string, unknown> = {
    sessionId: (result as any).sessionId,
    status: result.status,
    error: result.error,
  };

  if (result.entry?.response) {
    output.response = {
      statusCode: result.entry.response.statusCode,
      roundtrip: result.entry.response.roundtripTime,
      length: result.entry.response.length,
    };
    if (result.entry.response.raw) {
      (output.response as any).raw = formatHttpRaw(decodeRaw(result.entry.response.raw), opts);
    }
  }

  return output;
}
