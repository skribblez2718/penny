import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryMcpClient } from "../../index.js";
import { MemoryLogstreamClient } from "../../logstream-client.js";
import { isRecord, parseJson, requireDefined } from "../../../../lib/tests/test-narrowers.js";
import { TEST_TOKEN, testConfig } from "../fixtures.js";

interface McpRequestBody {
  jsonrpc: "2.0";
  id: unknown;
  method: "tools/call";
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

function parseMcpRequestBody(text: string): McpRequestBody {
  const value = parseJson(text);
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    value.method !== "tools/call" ||
    !isRecord(value.params) ||
    typeof value.params.name !== "string" ||
    !isRecord(value.params.arguments)
  ) {
    throw new Error("fixture server received an invalid MCP request body");
  }
  return {
    jsonrpc: value.jsonrpc,
    id: value.id,
    method: value.method,
    params: { name: value.params.name, arguments: value.params.arguments },
  };
}

interface SeenRequest {
  authorization?: string;
  path?: string;
  body?: McpRequestBody;
}

let closeServer: (() => Promise<void>) | undefined;
let endpoint = "";
let seen: SeenRequest[] = [];

beforeEach(async () => {
  seen = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // The local fixture server accepts only the MCP request emitted by the client under test.
      const body = parseMcpRequestBody(Buffer.concat(chunks).toString("utf8"));
      seen.push({
        authorization: request.headers.authorization,
        path: request.url,
        body,
      });
      const toolPayload =
        body.params.name === "mempalace_event_list"
          ? { events: [], count: 0 }
          : {
              query: body.params.arguments.query,
              filters: {},
              total_before_filter: 1,
              results: [
                {
                  drawer_id: "fixture-drawer",
                  text: "fixture content",
                  wing: "fixture",
                  room: "isolated",
                  similarity: 1,
                },
              ],
            };
      const payload = {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(toolPayload) }],
        },
      };
      const encoded = Buffer.from(JSON.stringify(payload));
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": encoded.length,
      });
      response.end(encoded);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  endpoint = `http://127.0.0.1:${address.port}/mcp`;
  closeServer = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
});

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("hermetic HTTP-only MemPalace adapter integration", () => {
  it("posts one authenticated tools/call to /mcp without any palace or Python process", async () => {
    const client = new MemoryMcpClient(testConfig({ endpoint }));
    const result = await client.call("search", { query: "fixture", limit: 1 });

    expect(result.payload.results).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const request = requireDefined(seen[0], "memory search request was not received");
    expect(request.path).toBe("/mcp");
    expect(request.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(request.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "mempalace_search",
        arguments: { query: "fixture", limit: 1 },
      },
    });
    const body = requireDefined(request.body, "memory search request body was absent");
    expect(String(body.id)).toMatch(/^platform-memory-/);
  });

  it("posts the local advisory list surface through the same authenticated HTTP hub", async () => {
    const config = testConfig({
      endpoint,
      logstream: {
        mode: "primary-advisory",
        stream: "project/advisory",
        rooms: ["status"],
      },
    });
    const client = new MemoryLogstreamClient(config);
    const result = await client.call("list", {
      stream: "project/advisory",
      room: "status",
      from_agent: "test-primary",
      to_agent: "test-primary",
      limit: 1,
      preview: false,
    });

    expect(result.payload).toEqual({ events: [], count: 0 });
    expect(seen).toHaveLength(1);
    const request = requireDefined(seen[0], "advisory list request was not received");
    expect(request.path).toBe("/mcp");
    expect(request.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(request.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "mempalace_event_list",
        arguments: {
          stream: "project/advisory",
          room: "status",
          from_agent: "test-primary",
          to_agent: "test-primary",
          limit: 1,
          preview: false,
        },
      },
    });
    const body = requireDefined(request.body, "advisory list request body was absent");
    expect(String(body.id)).toMatch(/^penny-memory-logstream-/);
  });
});
