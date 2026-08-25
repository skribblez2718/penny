#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import {
  assertOwnerDirectory,
  pennyStatePaths,
  resolvePennyStateRoot,
} from "@penny/orchestration/source";

import { ObservabilityDatabase, type LogQuery } from "./database.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface ObservabilityServerOptions {
  readonly databasePath?: string;
  readonly host?: string;
  readonly port?: number;
  readonly apiKey?: string;
  readonly maxRows?: number;
}

function authorizationMatches(request: IncomingMessage, apiKey: string): boolean {
  if (!apiKey) return true;
  const supplied = request.headers.authorization;
  if (typeof supplied !== "string" || !supplied.startsWith("Bearer ")) return false;
  const actual = Buffer.from(supplied.slice(7), "utf8");
  const expected = Buffer.from(apiKey, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function requestChunk(value: unknown): Buffer<ArrayBufferLike> {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("request body contained a non-byte chunk");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer<ArrayBufferLike>[] = [];
  let size = 0;
  for await (const value of request) {
    const bytes = requestChunk(value);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("request body is too large");
    chunks.push(bytes);
  }
  if (size === 0) throw new Error("request body is empty");
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return value;
}

function integerParameter(
  url: URL,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function optionalTimestamp(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

function configuredMaxRows(): number {
  const value = Number(process.env.PI_OBSERVABILITY_MAX_ROWS ?? "100000");
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    throw new Error("PI_OBSERVABILITY_MAX_ROWS is invalid");
  }
  return value;
}

export function createObservabilityServer(options: ObservabilityServerOptions = {}): {
  readonly server: Server;
  readonly database: ObservabilityDatabase;
} {
  const state = pennyStatePaths(resolvePennyStateRoot());
  const databasePath = options.databasePath ?? state.observability.database;
  const databaseDirectory = path.dirname(databasePath);
  assertOwnerDirectory(databaseDirectory, "Penny observability directory");
  const database = new ObservabilityDatabase({
    databasePath,
    maxRows: options.maxRows ?? configuredMaxRows(),
  });
  const apiKey = options.apiKey ?? process.env.PI_OBSERVABILITY_API_KEY ?? "";

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "penny-observability",
          schema_version: 1,
          counts: database.counts(),
        });
        return;
      }
      if (!authorizationMatches(request, apiKey)) {
        // Authentication failures are intentionally not persisted.
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (method === "POST" && url.pathname === "/logs") {
        const payload: unknown = await readJson(request);
        const id = database.insertLog(payload);
        sendJson(response, 201, { id });
        return;
      }
      if (method === "GET" && url.pathname === "/logs") {
        const query: LogQuery = {
          limit: integerParameter(url, "limit", 50, 1, 500),
          offset: integerParameter(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
          ...(url.searchParams.get("level")
            ? { level: url.searchParams.get("level") ?? undefined }
            : {}),
          ...(url.searchParams.get("component")
            ? { component: url.searchParams.get("component") ?? undefined }
            : {}),
          ...(url.searchParams.get("session_id")
            ? { sessionId: url.searchParams.get("session_id") ?? undefined }
            : {}),
          ...(optionalTimestamp(url, "from_ts") === undefined
            ? {}
            : { fromTimestamp: optionalTimestamp(url, "from_ts") }),
          ...(optionalTimestamp(url, "to_ts") === undefined
            ? {}
            : { toTimestamp: optionalTimestamp(url, "to_ts") }),
        };
        sendJson(response, 200, {
          logs: database.queryLogs(query),
          limit: query.limit,
          offset: query.offset,
        });
        return;
      }
      if (method === "POST" && url.pathname === "/compactions") {
        const payload: unknown = await readJson(request);
        const id = database.insertCompaction(payload);
        sendJson(response, 201, { id });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "invalid request",
      });
    }
  });
  server.on("close", () => database.close());
  return { server, database };
}

export async function main(): Promise<void> {
  const host = process.env.PI_OBSERVABILITY_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("observability must bind to loopback");
  }
  const port = Number(process.env.PI_OBSERVABILITY_PORT ?? "8765");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PI_OBSERVABILITY_PORT is invalid");
  }
  const { server } = createObservabilityServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  process.stdout.write(`penny-observability listening on http://${host}:${port}\n`);

  const close = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
